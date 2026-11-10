# Flowlet 技术架构迁移方案：Rust / Tauri → Electron + Node/TS

> 状态：**方案评审中**（尚未开始迁移）。本文是决策文档，不是施工记录。
> 依据：本目录下的勘察结论 [`commands-and-schema.md`](./migration/commands-and-schema.md)、
> [`platform-gap-matrix.md`](./migration/platform-gap-matrix.md)、`proxy-core.md`，
> 以及可运行骨架 PoC `poc/electron-host/`。
> 基线：仓库工作区 @ `26fed4c`（2026-11-09）。

---

## 0.0 执行状态（2026-11-09 更新）

**用户决策：先做 Docker/headless 版本，桌面 Electron 端延后。**
因此本文件的 P-阶段被重新排序执行，实际进度如下：

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| P0 | Electron + Node 骨架 PoC（复用 dist-web、真实库副本） | ✅ 已完成（`poc/electron-host/`） |
| **P1′** | **Node Host（Docker 优先）：43 条 Web 命令 + 25 表存储 + 代理核心** | ✅ 已完成（`packages/flowlet-core/`，分支 `migrate/electron`） |
| **P1″** | **后台维护（余额 5m / 清理 15m / 目录 1h）+ Rust 兼容设备身份** | ✅ 已完成（`src/host/scheduler.ts`） |
| **P2′** | **Docker 镜像切换到 Node Host（无 Rust 工具链）+ 端到端冒烟** | ✅ 完成：远端构建 `flowlet:node-20261109-poc`（258MB），容器冒烟 token 20/20 + OIDC 12/12；**尚未替换线上栈（待授权）** |
| **P3′** | **对齐线上新增能力：GitLab OIDC SSO / .flcap 捕获帧 / 目录派生价格表** | ✅ 完成：严格对拍命令 0 / HTTP 0；SSO 单测 22/22；跨语言帧互读/互写/互清通过；价格表 82 条与 Rust 一致 |
| **P4′** | **三方服务凭据（服务凭据页/6 条命令/GitLab CE 10.8.7）同步到 Node Host** | ✅ 完成：secret_box 跨实现加解密通过；6 条命令对拍（mock GitLab）0 差异；单测 101/101；已合并进 `main` 并推送 origin |
| **P5′** | **生产 Docker 切换为 Node Host** | ✅ 完成：`flowlet:docker-20261110-nodehost` 上线，14/14 验证通过，10 分钟真实流量 0 错误；回滚点 `flowlet:docker-20261109-gitlab-sso` |
| **P6′** | **Node 版 `flowlet-cred` CLI（移除最后一个 Rust 运行时依赖）** | ✅ 完成：`packages/flowlet-cred`，20/20 测试；与 Rust legacy CLI 20 步同序列 **0 差异**（输出+文件字节级）；服务器/Agent 侧不再需要 Rust 运行时（桌面端仍为 Rust，按约定延后） |
| P2 | 批次 1–2（A 类命令） | 归入 P1′（Web Host 白名单仅 43 条，已全部实现） |
| P3–P5 | 批次 3–10、代理核心 | 归入 P1′（代理 P0 已实现；thinking/reasoning 等受控例外见 `proxy-core.md`） |
| P6 | Electron 桌面宿主（窗口/托盘/通知/凭据/无边框壳） | ⏸ 延后（用户要求先 Docker） |
| P7 | 控制台抓取（Web Host 不需要） | ⏸ 不适用于 Docker；桌面阶段再评估 |
| P8 | 打包签名/灰度发布 | 部分完成：Docker 镜像构建路径已就绪，桌面安装包延后 |

当前基线证据（本地，`migrate/electron` 分支）：
- `npm run node:typecheck` 0 错误；
- 单元测试 **42/42**（storage 10 + proxy 22 + scheduler 5 ... 见各目录 `__tests__`）；
- 端到端 `scripts/e2e-node-host.mjs` **12/12**（真实库副本 + mock 上游流式 + 日志落库）；
- Rust↔Node 对拍 `scripts/web-parity.mjs` **命令差异 0 / HTTP 差异 0**（58 步命令序列）；
- Docker 镜像：`Dockerfile` 已改为 Node 运行时（无 Rust 阶段），远端 Engine API 构建与容器冒烟见
  `docs/migration/docker-node.md`。

---

## 0. TL;DR

| 问题 | 结论 |
| --- | --- |
| 迁到 Electron + Node/TS 可不可行？ | **可行**，而且比想象中便宜：前端 4.4 万行 TS **零改动复用**，后端 141 个命令契约和 25 张表 schema 都可原样冻结。 |
| 成本多大？ | 后端 8.4 万行 Rust → 约 4.5–6 万行 TS。**总量 175–280 人日**（业务核心 60–90 + 桌面宿主/平台 80–130 + 打包签名灰度 20–30）；单人 + AI 协作约 **8–13 个月**，2–3 人并行约 **4–6 个月**，不含真机采购与灰度观察期。 |
| 最大风险在哪？ | 不是命令，也不是存储：是 **代理转发核心**（SSE、压缩捕获、协议受控例外）与 **平台壳**（无边框窗口、Windows 子进程回收、控制台抓取登录态）。 |
| 迁移期间还能不能正常发版？ | 能。方案设计为 **并行双轨**：Rust 版本继续发版，Node 版本按批次灰度替换，任一阶段可回滚。 |
| 立刻能缓解编译 CPU 吗？ | 能，见 §10：先落地构建 profile + 打包迁到 CI，**不必等迁移完成**。 |

**一句话**：这条路技术上成立，但**不要把它当成"换掉编译慢"的手段**——按实测，Rust 日常增量编译约 7.5s（§2.2），真正烧 CPU 的是全量/发布构建，而那部分用 CI/远端构建一两天就能解决。迁移的真实收益是"消除原生编译环节、统一 TS 技术栈、平台能力收敛"，代价是 **4–6 个月（2–3 人）** 的重写与回归。若目标只是"本机不烧 CPU"，请先看 §10 的过渡期措施。

---

## 1. 为什么这条路成立（三个既有接缝）

Flowlet 现在的架构里已经存在三个现成的"接缝"，让迁移可以增量进行，而不是推倒重来：

1. **命令契约接缝**：前端所有后端调用都收敛在 `src/domains/**/commands.ts` →
   `src/platform/tauri/client.ts::invokeCommand`。`src/domains` 是唯一拼写命令名的地方，
   页面与 feature 不直接 `invoke`。命令数量：**桌面 141 + 移动 17**，参数一律 camelCase。
2. **HTTP 命令接缝**：`src/platform/web/client.ts` 已经把同一批命令映射为
   `POST /api/commands/{command}` + Bearer 管理凭据，Rust 侧由 `src-tauri/src/core/web/`
   提供白名单 dispatch（43 条，含 `web_connection_info`）与静态资源服务。**Electron 窗口可以直接加载 Node 服务提供的
   同一份 `dist-web` 产物**，前端连编译模式都不用改（`isWebHost = import.meta.env.MODE === "web"`）。
3. **数据接缝**：SQLite 25 张表、19 个索引、122 个幂等补列、无 `PRAGMA user_version`。
   Node 只要逐列对齐（同名同类型同 JSON 编码），**用户数据库可以零迁移直接打开**。

PoC 已用这三点跑通（`poc/electron-host/`，截图 `evidence/overview-x11.png`）：
Electron 加载**未修改**的 `dist-web`，真实界面完整渲染；Node 服务读真实 SQLite 副本，
`/health`、`/api/session` 与 8 个真实命令（渠道账号/预设/路由候选/虚拟模型/余额快照/
今日 Token/代理状态/连接信息）全部返回与 Rust 同形的 JSON，前端源码零改动。
详见 `poc/electron-host/README.md`。

---

## 2. 现状基线（实测，2026-11-09 本机 16 核 / 30GB）

### 2.1 体量

| 指标 | 数值 | 来源 |
| --- | --- | --- |
| Rust 代码 | **84,227 行**（core 77,438 / commands 5,074 / bin 202 / 顶层 1,559） | `wc -l` |
| Rust 依赖 | **399 个 crate**（Tauri 2 + axum + rusqlite + reqwest + keyring + webkit2gtk…） | `cargo tree` |
| Tauri 命令 | **141 桌面 + 17 移动** | `lib.rs` `generate_handler!` |
| Web Host 命令白名单 | 43 条（含 `web_connection_info`） | `core/web/commands.rs` |
| SQLite | 25 表 / 19 索引 / 122 补列 / 无 user_version | `core/storage.rs` |
| 前端 | **44,292 行** TS/TSX（React 19 + Semi + TanStack Query） | `wc -l` |
| 构建缓存 | `src-tauri/target` **30 GB**，debug 二进制 **478 MB**，release 二进制 **47 MB** | `du` / `ls` |

### 2.2 构建耗时（实测）

| 场景 | 改前 | 改后（已落地 `[profile.dev]`） | 变化 |
| --- | --- | --- | --- |
| 稳态热重建（改一行 `lib.rs` 后 `cargo build`） | 墙钟 7.5–8.0s / user ~13s | 墙钟 **4.7–6.0s** / user 5.3–6.1s | 墙钟 −25~40%，**CPU 时间 −55%** |
| 冷重建（`cargo clean -p flowlet` 后） | 墙钟 41.6s / user 71.4s | 墙钟 24.7–42.9s / user **42.9s** | **user −39%**，磁盘写入 −65% |
| `cargo build --bins` | 与全量相同 | 与全量相同 | lib 仍按 `staticlib,cdylib,rlib` 三份 codegen，跳过只能靠拆 crate |
| release 增量（改一行后重新出包） | 墙钟 **74.9s** / CPU 508% / user 374.7s | 未变（release 未调） | 这是"打包发布难受"的主体，建议移出本机（§10） |
| `cargo check`（暖态） | — | 2.2s | — |
| debug 二进制 | 478 MB | **127 MB** | −73% |
| `target/` 产物合计 | 3.02 GiB | **884 MiB** | −71% |

> 已落地改动（可一键回滚，见 `build-perf.md`）：`src-tauri/Cargo.toml` 末尾
> `[profile.dev] debug="line-tables-only"` + `[profile.dev.package."*"] debug=0`；
> `.cargo/config.toml` 只加说明注释。`lld/mold` 不可行（无 sudo 且 rustc 1.97 已默认
> rust-lld）。**切换/回滚都会触发一次约 2 分钟的全量依赖重建。**

> 结论：**真正"风扇起飞"的是全量重建与发布打包，不是每次编辑**；而发布构建本就可以
> 完全交给 CI 或远端 builder（§10），与"是否迁移到 Electron"无关。

**结论**：日常"改一行再跑"的稳态增量成本约 7.5s，属于正常范围；真正贵的是
**全量/冷重建、发布构建、以及打包**。也就是说，"Rust 编译占 CPU"的痛感主要来自
发布链路与依赖变更后的重建，而不是每次编辑。

### 2.3 代码分布（迁移工作量来源）

| 领域 | 行数 | 迁移难度 | 说明 |
| --- | --- | --- | --- |
| `core/proxy*` + 捕获/日志/用量 | **11,935**（含测试 5,759；非测试 6,176，另含依赖面约 4–5k） | **最高** | 179 个测试（138+41）是行为回归资产；流式透传与协议受控例外，见 `proxy-core.md` |
| `core/storage*` | ~17,300（含 8,800 行测试） | 高 | 25 表 SQL 与聚合查询逐条移植 |
| `core/agent_*`（环境、全局配置、会话、时间线、adapter） | ~9,000 | 中 | 纯文件/JSON/TOML 解析，但 Agent 种类多 |
| `core/scrape*` + 控制台抓取 | ~5,100 | 高（平台） | 依赖 WebView 注入 + 登录态，Electron 需重做 |
| `core/device_sync`、`lan_sync`、`account_workspace` | ~5,000 | 中 | 加解密、S3、LAN 探测 |
| `commands/*`（141 命令薄适配层） | 5,074 | 低 | 逻辑多在 core，命令层是胶水 |
| `core/*` 其余（config、presets、adapter、web、maintenance…） | ~20,000 | 中 | |

---

## 3. 目标架构

```text
┌──────────────────────── Electron 应用 ────────────────────────┐
│ Renderer（复用现有 src/，React 19 + Semi）                    │
│   platform/electron/client.ts  →  HTTP 本机 API（零页面改动）  │
├───────────────────────────────────────────────────────────────┤
│ Electron main（Node/TS）——Host Shell                          │
│   窗口/无边框壳 · 托盘 · 通知 · 单实例 · 自启 · 窗口记忆       │
│   文件监听 · 子进程托管 · 电源事件 · 凭据（safeStorage/keytar）│
│   CDP 控制台抓取（webContents.debugger）                       │
├───────────────────────────────────────────────────────────────┤
│ flowlet-core（Node/TS，纯业务，无 Electron 依赖）             │
│   services（等价 FlowletServices）· proxy（http.serve）        │
│   routing · capture/logging · usage/cost · storage(SQLite)     │
│   agent adapters（环境/全局配置/会话/时间线）· device/sync     │
│   本地管理 API：POST /api/commands/:command（Bearer）          │
├───────────────────────────────────────────────────────────────┤
│ SQLite（better-sqlite3，单连接 + 重查询 worker）               │
│   schema 与 Rust 版逐列一致 → 用户数据库零迁移                 │
└───────────────────────────────────────────────────────────────┘
        │ 同一份 flowlet-core 同时以纯 Node 进程运行
        ▼
   headless / Docker Host（+ 现有 dist-web 浏览器管理界面）
```

**关键设计选择**

| 选择 | 结论 | 理由 |
| --- | --- | --- |
| 渲染进程 ↔ 后端 | **本机 HTTP（`127.0.0.1` + Bearer）而不是纯 IPC** | 直接复用 `platform/web/client.ts` 与 `dist-web`；桌面/Web/Docker 同一套命令通道；Electron 只多一个"壳"。 |
| 后端语言 | **Node/TS**（不是 Go sidecar） | 与前端同语言、类型可共享、零编译步骤直接消除编译 CPU；Go sidecar 虽编译极快，但引入第二语言+进程边界，收益不抵复杂度。 |
| SQLite | **`node:sqlite` 优先**（Electron 45 内置 Node 24.22 的 `DatabaseSync`，PoC 已实测可用），`better-sqlite3` 仅作回退 | 零原生编译、无 Electron ABI 重编问题；同步 API 最接近 Rust 版"单连接串行"模型；重聚合查询放 `worker_threads`，避免阻塞 HTTP。 |
| 前端 | **不改**（仅新增 `platform/electron` 适配与事件桥） | 4.4 万行前端零回归风险。 |
| 共享契约 | 生成一份"命令 → 参数 → 返回结构 → 字段风格"快照作为契约测试 | Rust 返回字段 `snake_case` / `camelCase` 混用（见 `commands-and-schema.md` §5.2），必须逐条冻结。 |

**刻意不做的事**：不做跨协议转换（与现状一致）、不引入运行时插件注入、不在 Node 里重新
发明代理行为——所有代理行为以 `AGENTS.md` §5 / §9 与 `proxy_tests.rs` 为验收基准。

---

## 4. 三条不变量与质量保障手段

迁移期间最容易出事的不是"写不出来"，而是"写出来了但行为悄悄变了"。用三条不变量 + 三种
验证手段兜住：

**不变量**

1. **SQLite schema 逐列不变** —— 表名/列名/类型/JSON 列编码/索引/PRAGMA 全部一致；
   迁移脚本先跑 Rust 版同一套幂等 DDL 与清理逻辑（含已删除的 `projects` 等历史表）。
2. **命令契约不变** —— 命令名、camelCase 参数名、返回字段风格、错误 shape（`Result<T,String>`
   → `{message}`）、401/501 语义全部不变；前端 `src/domains/**` 不改。
3. **代理行为契约不变** —— `AGENTS.md` §5 的每一条受控例外（Anthropic thinking/tool_use
   补字段、DeepSeek reasoning_content 回填、SSE 64KiB 行、压缩响应捕获解压、Files API 单账号、
   Responses 无状态、错误原样透传、失败降级 attempt、日志旁路失败不影响主链路）逐条对应
   到自动化测试。

**验证手段**

1. **契约快照 + 类型生成**：从 Rust 端导出全部命令的入参/返回 JSON 示例（真实库副本），
   作为 Node 实现的 golden 输入；TS 类型逐条对照（含 `snake_case`/`camelCase` 混用）。
2. **双实现影子对拍**：同一 DB 副本，`cargo run --bin headless` 与 Node server 同时暴露
   `/api/commands/:command`，脚本逐命令 diff（忽略时间戳类字段），差异即回归。
3. **测试移植清单**：`proxy_tests.rs`（5,699 行）与 `storage_tests.rs`（4,402 行）按测试名
   归类为验收场景，Node 侧用 `node:test` / vitest 一条条复刻；**不允许用"看起来一样"代替断言**。

---

## 5. 平台缺口与对策（摘要，详见 `platform-gap-matrix.md`）

**6 个硬缺口**

| # | 硬缺口 | 影响 | 建议 |
| --- | --- | --- | --- |
| HG-1 | **Android 端**（Electron 无移动 target） | 实验性移动辅助端断裂 | 见 §9 决策点 2，不建议在同一轮迁移中消除 |
| HG-2 | 无边框窗口拖动区/缩放/双击最大化 | 需重写壳，Linux GTK 无系统缩放边框 | 用 `-webkit-app-region` + `setMinimumSize`，常规工作量 M |
| HG-3 | Windows toast 点击回调 + 便携版 AUMID | 通知点击行为可能降级 | 评估 `electron-windows-notifications` 原生模块，或降级为"点通知打开主窗口" |
| HG-4 | 跨平台密钥存储（keyring → safeStorage） | **已有用户加密数据必须能继续解密** | 优先保持 keyring 格式（`keytar`）+ ChaCha20Poly1305 参数不变；必要时做一次性重加密迁移 |
| HG-5 | 控制台抓取登录态（WebView2/WebKitGTK → CDP） | 第三方 SSO 反自动化风险，登录态不可迁移 | 建议 PoC 验证 3 条 SSO 链路；v1 可降级为"仅官方 API 余额" |
| HG-6 | Windows 内核级子进程树回收（Job Object） | Flowlet 异常退出时子进程可能残留 | `tree-kill` + 父进程退出钩子，或保留极小原生 helper |

**净收益**：控制台抓取从三套平台链路收敛为统一 CDP；电源抑制跨平台化；不再依赖系统
WebView2/WebKitGTK 运行时。另有两个可降低项：现状 Rust **实际并未发送任何原生通知**
（只做插件初始化与 AUMID 注册），通知能力可整体延后；`config.json` 里 4 处 `interceptor_js`
硬编码 `__TAURI_INTERNALS__.invoke`，可用 preload 兼容 shim 零改配置迁移。

**平台侧（含桌面宿主）改造约 100–150 人日，其中 6 个硬缺口 55–95 人日**（不含业务核心重写）。

---

## 6. 阶段计划

> 每阶段都满足：可独立发布、可独立回滚、有明确验收。批次划分沿用
> `commands-and-schema.md` §8 的 10 批命令。

| 阶段 | 内容 | 交付物 | 验收 | 预估 |
| --- | --- | --- | --- | --- |
| **P0 骨架**（✅ 已完成） | Electron 壳 + Node 命令服务 + 复用 `dist-web` + 真实库副本 | `poc/electron-host/` | **已实测**：真实界面渲染 + 8 个真实命令 200（截图 `poc/electron-host/evidence/overview-x11.png`） | 已完成 |
| **P1 契约冻结 + 对拍设施** | 命令快照、类型、diff 脚本、SQLite 访问层 | `packages/flowlet-core`（storage/contract）、`scripts/contract-diff` | 影子对拍可跑，差异清零 | 4–6 天 |
| **P2 批次 1–2（A 类 34 条）** | 纯逻辑/网络/文件命令 | 前端点开即可用（只读链路） | 概览/设置页除写入外可用 | 6–9 天 |
| **P3 批次 3–5（B 类核心 42 条）** | 配置 CRUD、用量、日志、会话、任务 | 渠道/模型/日志/用量页可用 | 真实库读写无差异，索引查询性能不退 | 12–18 天 |
| **P4 批次 6–8（B 类外围 43 条）** | 设备同步、S3/LAN、目录同步、存储维护 | 全量命令面 | 对拍全绿 | 10–14 天 |
| **P5 代理核心（最大风险）** | Node 代理：入站三协议、路由、SSE 透传、捕获、用量 | `flowlet-core/proxy` | `proxy_tests` 场景全移植通过 + 真实上游冒烟 | 12–18 天 |
| **P6 批次 9（C 类 15 条）+ 桌面宿主** | 窗口壳/托盘/自启/子进程/凭据迁移/电源/单实例 | Electron Host | 与 AGENTS.md §3 生命周期契约一致；3 平台冒烟 | 25–40 天 |
| **P7 批次 10（D 类 7 条）+ 抓取** | 控制台抓取（可裁） | CDP 抓取 | 3 条 SSO 链路 PoC 结论决定范围 | 8–15 天（可裁） |
| **P8 打包/发布/用户迁移** | electron-builder、签名、自动更新、便携版、Docker Host、灰度 | 安装包 + 迁移脚本 | 用户升级数据无损、双版本并行可回滚 | 15–25 天 |

**总计约 150–230 人日**（P1–P8 合计 92–145 人日 + 跨平台真机回归、文档与灰度观察
20–30 人日 + 不可预见缓冲 15–20%）。单人 + AI 协作 ≈ **3–5 个月**；3 人并行 ≈ **6–10 周**
（但一致性风险与联调成本上升）。Android 决策落地另计 0–30 人日。

---

## 7. 工作量构成（按难度）

| 类别 | 数量 | 迁移策略 | 人日估算 |
| --- | --- | --- | --- |
| A 类命令（纯逻辑/网络/文件） | 34 | 直接 TS 重写，可单测 | 6–9 |
| B 类命令（SQLite） | 85 | 跟随统一 storage 层，SQL 逐条对照 | 18–26 |
| C 类命令（平台能力） | 15 | 依赖 Electron 宿主，集中回归 | 7–10 |
| D 类命令（Tauri 专有抓取） | 7 | 重做架构或裁剪 | 3–6（可裁） |
| 代理核心（非命令面） | ~7.3k 非测试行 | 照 `proxy-core.md` 设计重写 + 测试移植 | 12–18 |
| 桌面宿主 / 平台能力（含 6 个硬缺口） | 77 个能力项 | 窗口壳、托盘、自启、凭据迁移、子进程、CDP 抓取、3 平台 | 80–130 |
| 打包/签名/发布/用户迁移/灰度 | — | electron-builder、CI、迁移脚本、观察期 | 20–30 |

**合计 175–280 人日**（口径：1 人日 = 8 小时有效工作，含单元测试，不含真机采购与
上架审核等待）。单人 + AI 协作 ≈ **8–13 个月**；2–3 人并行 ≈ **4–6 个月**。

> **估算置信度 ±40%**：平台侧 77 项能力里 L 级 9 项（含 Android、抓取、无边框壳），
> 任何一项 PoC 失败都会显著改变总量。**建议先做 §9 决策点 1–2 的三个 PoC 再定完整排期**，
> 这三个 PoC 约 5–8 人日。

> 注意：**命令层只占迁移量的一半左右**，`proxy.rs` + `proxy_http.rs` + `proxy_routing.rs` +
> `request_capture.rs`（约 1.3 万行含测试）才是大头，`commands-and-schema.md` §9 已明确
> "命令层迁移完不等于代理可用"；而平台侧（Electron 宿主）与 Rust 侧能力面并不对称——
> Electron 需要重写的窗口/托盘/凭据/抓取/子进程代码，在 Rust 侧大量依赖 Tauri 免费提供的实现。

---

## 8. 风险登记册

| # | 风险 | 概率/影响 | 缓解 |
| --- | --- | --- | --- |
| R1 | 代理流式行为等价性（SSE、背压、取消、压缩捕获） | 中 / **高** | P5 单独成阶段；先 spike；`proxy_tests` 场景全移植；真实上游冒烟 |
| R2 | 用户加密数据不兼容（keyring + ChaCha20Poly1305） | 中 / 高 | 先做 keyring 读写 PoC；保持算法/参数/条目名不变；准备一次性重加密迁移 |
| R3 | 控制台抓取登录态失败 | 高 / 中 | 3 条 SSO 链路 PoC；v1 可降级为官方 API 余额 |
| R4 | SQLite 查询性能退化（缺索引/写法差异） | 中 / 中 | 建库脚本原样复制 19 个索引；4.3 万行日志表做性能对照测试 |
| R5 | 双轨维护成本（Rust + Node 并行期太长） | 中 / 中 | 明确收敛期限；并行期只修 critical bug；每批次完成即切默认 |
| R6 | Electron 体积/内存上升（~200MB 安装包、主进程内存） | 高 / 低 | 可接受：本地工具；量化并写入发布说明 |
| R7 | 打包签名链路重建（NSIS/MSI/AppImage/deb/dmg） | 中 / 中 | electron-builder 逐平台验证；Windows 代码签名与 macOS 公证按现有 CI 结构补齐 |
| R8 | 迁移期间用户数据双写不一致 | 低 / 高 | 不双写：同一时刻只有一个后端进程持有 DB；切换用文件锁 + 版本标记 |
| R9 | **系统代理语义差异**：Rust `reqwest` 默认走系统代理，Node `undici` 默认不走 | 高 / 中 | 这是"等价性"最容易漏的一条：必须显式实现 `system_proxy → agent` 映射并用真实代理环境验证（见 `proxy-core.md` §6 R6） |
| R10 | Electron 主进程被 `better-sqlite3` 原生 ABI 绑死（Electron 升级需重编） | 中 / 中 | 优先 `node:sqlite`（Electron 45 = Node 24.22 已内置 `DatabaseSync`），`better-sqlite3` 仅作回退 |

---

## 9. 需要拍板的决策点

1. **技术栈**：Electron + Node/TS（本文推荐）｜ Electron + Go sidecar ｜ 保留 Rust 只做壳。
   —— 若目标只是"编译不占 CPU"，Go sidecar 编译更快但收益不抵双语言成本；若目标是
   "统一 TS 技术栈、消除原生编译"，Electron + Node 更彻底。
2. **Android 端**（Electron 无移动 target）：① 冻结/放弃（成本最低）② 保留 Tauri Android
   壳长期双维护 ③ 改 Capacitor 只读客户端（复用 Web Host API）。
   —— 建议 ③，因为它把移动端定义为"观测客户端"，与桌面端后端解耦。
3. **是否保留 Tauri 版本作为 LTS**：建议至少并行 1–2 个版本（覆盖一次完整升级周期）后再下线。
4. **发布节奏**：建议先 `portable/beta` 渠道 → 内部使用 → 全量；Docker Host 可更早切换
   （无桌面平台能力依赖，风险最低）。
5. **代理层四个待定行为**（`proxy-core.md` 列出，迁移前必须拍板，否则 Node 实现没有基准）：
   ① 入站请求体是否设上限（现状无上限）；② 系统代理是否按 reqwest 语义默认启用；
   ③ Web Host 是否补 CORS 预检；④ `stop_proxy` 是否强杀长连接的流。

---

## 10. 过渡期措施（不必等迁移完成）

1. **构建 profile 优化**（`build-perf` 正在落地，见 `build-perf.md`）：`[profile.dev]`
   调试信息降级、`[profile.dev.package."*"] debug = 0`，主要收益是全量重建耗时与磁盘占用。
2. **把发布构建移出本机**：仓库已有 `.github/workflows/build-installers.yml` 与 Docker
   远端构建链路；本地只做 debug 迭代，"打包发布"交给 CI/远端 builder，本机 CPU 立刻归零。
3. **不要在本地跑 `cargo build --release` / `tauri build`**：除发布验证外一律走 CI。
4. **不要频繁切分支后重建**：`target` 30GB 的冷重建代价远高于日常编辑。

---

## 11. 回滚与并行发布

- **回滚单位是"批次"**：每批次 Node 实现完成后，通过运行时开关（`FLOWLET_HOST=electron|tauri`）
  选择后端；任一批次出问题只要切回 Tauri 版本。
- **数据回滚**：schema 不变，两个后端可互操作；Node 版不引入新表，避免 downgrade 风险。
  若确需新表，先写"可忽略的扩展表"并标记版本。
- **发布回滚**：Electron 版本先发 beta/portable，保留上一版安装包可回退；数据库由版本标记
  保护，禁止 Node 版做不可逆迁移。

---

## 12. 产出物索引

| 文件 | 内容 |
| --- | --- |
| `docs/migration/commands-and-schema.md` | 141+17 命令清单、难度分级、10 批排期、25 表 schema、19 索引、契约细节 |
| `docs/migration/platform-gap-matrix.md` | Tauri → Electron 能力矩阵、6 硬缺口、工作量 |
| `docs/migration/proxy-core.md` | 代理核心链路拆解、行为契约、Node 方案、spike 验收 |
| `docs/migration/build-perf.md` | 构建提速实测数据与配置 |
| `poc/electron-host/` | 可运行骨架：Electron + Node 命令服务 + 真实库副本 + 截图证据 |