# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 修复

- **Windows 下首次实机跑通 Electron 桌面端**（Rust/Tauri → Electron 本机切换验证时发现）：
  - Agent 会话扫描的 HOME 隔离：`timeline.homeDir()` 在 Windows 上补认显式 `HOME`
    （`os.homedir()` 只读 `USERPROFILE`，node:test 的 HOME 重定向失效，会话扫描会读到开发机
    真实数据）；`platformDataDir/platformConfigDir` 在 HOME 被重定向时不再直读 `APPDATA`；
    `opencode-control` 权限桥、Hermes 数据库候选同样识别 HOME 重定向。observability 测试
    的 `setHomeEnv` / `withDshHome` 补齐 `HERMES_HOME` / `APPDATA` 隔离，
    `sync_agent_data` 用例先释放进程内租约。
  - `RequestCaptureStore.forDatabase(":memory:")` 的临时根目录改读 `TMPDIR/TEMP/TMP`
    （只写死 `/tmp` 会让 Windows 上捕获帧落到盘根目录，测试读不到帧）。
  - Codex app-server 在 Windows 上先判可执行文件存在：不存在的路径交给 powershell 只会得到
    `CommandNotFoundException`，错误原因被吞进子进程 stderr 且文案随系统语言变化。
  - Windows 下 3 条平台相关测试断言修正：POSIX 权限位（`0600/0700`）只在 POSIX 断言；
    优雅退出测试在 Windows 用 SIGINT（control-break）驱动与 Docker/systemd 相同的关闭分支。
  - `scripts/smoke-desktop-pages.mjs`：Electron 二进制优先仓库根 `node_modules`（workspaces
    提升安装）并兼容 `electron.exe`；非 Linux 平台不再强制走 `xvfb-run` / `--ozone-platform=x11`；
    冒烟实例用 `FLOWLET_BIND_ADDR=127.0.0.1:0`，避免与本机正式实例的 18640 冲突。

### 新增

- **桌面端 Electron + Node/TS 重构（第一阶段）**：桌面端不再依赖 Rust/Tauri 承载业务逻辑，
  改为 Electron 宿主（`packages/flowlet-desktop/`）+ 复用 `packages/flowlet-core` 的 Node
  命令面与代理核心，渲染层直接加载现有 React 界面（`vite build --mode desktop` → `dist-desktop`），
  命令通道走本机 `POST /api/commands/{command}`（随机管理 token 经 preload 注入，不落盘）；
  Tauri/Rust 版本保留为回滚路径，Android 工程未改动。
- 桌面命令层（`packages/flowlet-core/src/desktop/`）：在 Web Host 66 条命令之上补齐桌面独有
  命令——Agent 接入 17 条（环境探测/全局配置 inspect→apply→restore/Codex/Antigravity/托管运行时）、
  设置与维护 22 条 + 账号工作区 5 条、观测与会话 19 条（原生会话目录合并、DSH v0–v4 时间线、
  后台任务、成本探测、目录预设同步）、跨设备同步 23 条（S3 SigV4 + LAN HMAC/ChaCha20 信封）；
  覆盖度用 `node scripts/desktop-command-parity.mjs` 追踪：**154/154（100%）**。
- 桌面控制台抓取（CDP）：`open/close_scrape_console`、`probe_scrape_login`、`scrape_balance`、
  `sync_scrape_balances`、拦截回调、外部链接与自定义抓取注册表共 10 条命令，按 `config.json`
  抓取描述符驱动（零渠道硬编码），槽位引擎/extractor 与 Rust 行为对齐；Electron 统一用
  `webContents.debugger`（CDP）替代 WebView2/WebKitGTK 三套实现。**升级后控制台渠道需重新登录
  一次**（旧 WebView 登录态无法迁移，命令层会明确返回 `login_required` 而不是伪造成功）。
- `packages/flowlet-desktop`：单实例、无边框窗口壳（CSS app-region 拖动 + IPC 伪缩放）、托盘
  （关闭隐藏、仅托盘退出停代理）、窗口记忆、开机自启、`safeStorage` 凭据存储并兼容迁移 Rust
  keyring 旧条目、`platform/keyring/agentRuntime/scrape/power` host channel、
  electron-builder 打包（AppImage/deb/nsis/zip/dmg），以及 `desktop:dev/build/dist/smoke` 脚本。
- 前端新增 `desktop` 运行模式（`src/platform/desktop/**`）：命令改走本机 HTTP、窗口能力经 preload
  桥接、`isWebHost`/移动端/demo 语义不变。
- 桌面迁移门禁与验证：新增 `npm run desktop:smoke:pages`（逐路由渲染 + 截图 + console/命令
  错误报告，支持 `--db=<sqlite>` 跑老用户数据库）、`node scripts/desktop-command-parity.mjs
  --check`（154 条命令覆盖门禁）与 `.github/workflows/desktop-electron.yml`（三平台构建 +
  Linux xvfb 冒烟，产物为迁移验证包，不覆盖 Tauri 正式 Release）。
- Windows 通知：`platform.notify` 支持点击回到主窗口；启动时幂等写
  `HKCU\Software\Classes\AppUserModelId\site.snewbie.flowlet`（DisplayName/IconUri），
  与 Rust `notification_registry.rs` 对齐，缓解便携版 toast 被系统丢弃（仍未真机验证）。

- **桌面端新增「主机 / 客户端」双运行模式**：主机模式不变（本机 Node Host + 154 条桌面命令）；
  客户端模式不启动本机 Host，只跑 Client Gateway（同源静态界面 + `/api` 反向代理）连接
  Docker/Web Host，复用 Web 管理台做远程观测与管理（账号/模型/日志/会话/用量/服务凭据），
  本机 Agent 接入、控制台抓取、跨设备同步与开机自启在客户端模式不可用；
  token 经 `safeStorage` 加密保存在 `desktop-config.json`，OIDC 会话 Cookie 存放在独立持久化
  分区并由网关注入（渲染进程拿不到凭据）；托盘「运行模式…」可切换并自动重启；
  新增 `npm run desktop:smoke:client`（真实 Node Host + 客户端模式逐路由冒烟）；
  客户端模式概览显示「远程代理」并按远程公开入口展示模型地址，网关强制
  `accept-encoding: identity` 避免压缩响应转发失真；OIDC 会话解析/Cookie 注入与网关契约
  共 12 条单测。

### 变更

- **Rust 服务端遗留物移出默认构建**：生产 Web Host 已由 Node Host 承载，因此 Rust `core::web`
  命令白名单与 `headless` 二进制改为 Cargo feature `legacy-server`（默认关闭），Rust legacy 凭据
  CLI 改为 `legacy-cred`（默认关闭）；`tower-http` 随之变为可选依赖。桌面构建不再编译这两条
  链路（减少约 3.6k 行 Rust 与非桌面依赖），对拍/回滚需要时按文档显式开启；
  `npm run node:parity` 的 Rust oracle 需先用 `--features legacy-server --bin headless` 构建。

### 新增

- **服务凭据新增 Jenkins provider**：管理台「服务凭据」在 GitLab、Dockhand 之后新增 Jenkins
  （用户名 + API Token 的 HTTP Basic 认证）：服务凭据表新增可空 `username` 列（Rust Host /
  Node Host 均做 `ALTER TABLE` 迁移，GitLab / Dockhand 行为 NULL），保存时实际请求
  `GET {base}/me/api/json` 校验，版本取 `X-Jenkins` 响应头；校验失败不落库；
- `flowlet pull` 为 Jenkins 生成 `{PREFIX}_URL` / `{PREFIX}_USER` / `{PREFIX}_TOKEN`
  （其它 provider 仍为两把键）；CLI 新增 `flowlet jenkins set / status / api / env / clear`，
  支持 `--profile=<alias>` 多实例；
- 同步更新 `docs/credential-cli.md`、`docs/docker.md` 与 Skills 包的 Jenkins 使用说明。

- **服务凭据新增 Beszel provider**：管理台「服务凭据」新增 Beszel（开源服务器监控 Hub，
  PocketBase 底座，默认 8090）。Beszel 没有长期 API Token，因此凭据存「登录邮箱（明文）+
  密码（密文）」，保存时实际请求 `POST {base}/api/collections/users/auth-with-password`
  换短期 token 校验，版本取 `GET /api/beszel/info` 的 `v`，摘要为「{n} 台系统」；
  校验失败不落库。Rust Host / Node Host / CLI / 前端与文档同步实现；
- `flowlet pull` 为 Beszel 生成 `{PREFIX}_URL` / `{PREFIX}_EMAIL` / `{PREFIX}_PASSWORD`；
  CLI 新增 `flowlet beszel set / status / systems / api / env / clear`，支持
  `--profile=<alias>` 多实例（例如 `BESZEL_MON_*`）。

- **服务凭据新增 OCI 镜像仓库（registry）provider**：管理台「服务凭据」在 Beszel 之后新增
  「OCI 镜像仓库」，只按行业通用标准 Docker Registry HTTP API V2 / OCI Distribution 实现：
  保存时请求 `GET {base}/v2/`，401 时按 `WWW-Authenticate` 的 Bearer 质询换 token 后重试，
  版本取 `docker-distribution-api-version` 响应头；用户名 + 密码/token（robot account 同样只是
  普通用户名 + token，不做特判）。不实现任何 Harbor 专属能力：不调用 `/api/v2.0/*`、
  不探测 catalog、不支持 `docker search` 与 ChartMuseum。Rust Host / Node Host / CLI / 前端与
  文档同步实现，校验失败不落库；
- `flowlet pull` 为 registry 生成 `{PREFIX}_HOST` / `{PREFIX}_USER` / `{PREFIX}_TOKEN`
  （`_HOST` 是 host[:port]、无 scheme，可直接用于 `docker login` / `helm registry login`；
  地址键用 `_HOST` 而非 `_REGISTRY`，避免默认前缀产生 `REGISTRY_REGISTRY`）；CLI 新增
  `flowlet registry set / status / env / clear`，支持 `--profile=<alias>` 多实例；
- 同步更新 `docs/credential-cli.md`（新增 §13「OCI 镜像仓库适配（Registry V2）」）与 Skills
  包的 registry 使用说明。

- Web Host / Docker 管理台新增「设置 → 数据维护 → 数据完整性检查」四阶段修复：
  `repair_agent_sessions`（按已存 Header 与最新 UA 规则修复会话/客户端归属）、
  `repair_captured_usage`（从响应捕获帧重解析历史 usage 并按原始请求时间回填）、
  `repair_unknown_usage`（为仍无法解析的请求生成 unknown 占位行，排除 count_tokens 与
  Files API）、`repair_usage_costs`（按原始请求时间的分时价格重算费用五列）。
  Node Host 只移植了捕获体回填路径，不含桌面端的 Agent 原生 transcript 回退
  （`repair_usage_from_native_sessions`）：仅剩 `message_start` 前缀的截断捕获会保留为
  unknown 占位，等待人工审计。

### 修复

- 修复 Responses 客户端回放历史 item 时被上游 400：部分上游返回的 `reasoning` / `message`
  item 带 `"status": null`（或空串、未知取值），客户端（DSH/pi-ai 等）会把它们原样塞回
  下一轮 `input`，校验严格的上游返回 `The parameter `input.status` specified in the request
  are not valid: unknown status: .`；坏 item 一旦进入历史，该会话后续每一轮都会被拒、
  重试无效（2026-11-10 DSH 会话 `session-a07de002` turn 32/33 即此形态）。Rust
  （`proxy_http::normalize_responses_input_items`）与 Node Host
  （`proxy::normalizeResponsesInputItems`）都在转发前把 `input[*].status` 的非法值归一为
  `"completed"`、清掉 `encrypted_content: null`；合法 status、`input` 为字符串、非
  Responses 协议、无需修改的请求保持字节级透传，item 的顺序 / id / type / 内容不变。
- 修复流式响应带 `content-encoding: gzip / deflate / br / zstd` 时用量丢失：代理此前把压缩
  字节直接交给 TTFT 探针与 usage 累加器，解析不到 `usage` 事件，导致请求日志 Token / 费用
  显示 `—`、用量统计不计入（DeepSeek 官方 Anthropic 端点对 SSE 返回 gzip 时必现，历史日志中
  该账号 1,923 条请求全部无 usage）。现在 Rust（`proxy_http::StreamUsageDecoder`）与
  Node Host（`proxy::StreamObservationDecoder`）都在**观测侧**做增量解压：转发的原始压缩字节、
  `content-encoding` 头不变，响应体捕获仍按原逻辑解压；解压失败 / 截断只停用观测解压并按
  `partial` 语义处理，不影响转发、日志与连接。非流式 buffered 解压路径不变。

## [0.2.0] - 2026-11-09

### 管理端 GitLab OIDC SSO

- Web 管理台新增 OIDC 登录模式：浏览器走 GitLab 授权码登录，服务端 HttpOnly 会话 Cookie，
  不再需要把静态管理凭据保存在 `sessionStorage`；
- 登录回调校验 state/nonce/PKCE（按 IdP 能力）、RS256 签名、iss/aud/azp 与有效期，
  并通过 UserInfo 获取 `sub`、`email`、`groups`；
- 准入支持 `ALLOWED_SUBS` / `ALLOWED_GROUPS` / `ALLOWED_EMAILS` / `ALLOWED_DOMAINS`，
  默认 fail-closed；目标 GitLab 实例使用单用户 `sub` 名单；
- 新增 CSRF token + Origin 校验、空闲/绝对会话超时、登录审计日志与 break-glass token 兜底；
- 新增 `FLOWLET_ADMIN_AUTH_MODE`、`FLOWLET_OIDC_*` 环境变量；未配置 OIDC 时保持原有
  `FLOWLET_ADMIN_TOKEN` 行为不变；实现说明见 `docs/admin-sso-design.md` 与 `docs/docker.md`；
- 注意：Antigravity 授权不再内置公共 OAuth client，桌面端新授权需成对设置
  `ANTIGRAVITY_OAUTH_CLIENT_ID` / `ANTIGRAVITY_OAUTH_CLIENT_SECRET`。

## [0.1.2] - 2026-11-09

### 移除

- 移除项目管理能力：删除桌面端项目页 / 项目详情窗口、移动端任务页与任务提交、共享包中的
  项目看板与任务日志演示，以及对应的路由、侧边栏与底部导航入口；
- 移除 Rust 侧项目与任务存储、Agent 任务执行器、项目工作区 S3 同步、LAN / 移动端任务提交，
  以及插件契约中的 `runnerAdapterId` 与 `taskProfile`；Agent 编译期 Adapter 收敛为
  Environment、Global Config、Session 与 Identity 四类；
- 新增一次性迁移：删除 `projects` / `project_tasks` / `recurring_tasks` / `recurring_task_runs` /
  `device_projects` 表，清理任务审核通知 / 项目工作区 ETag 等 `app_meta` 键，并删除
  `background_jobs` 中项目任务、重复任务与项目工作区同步的孤儿记录及事件。

### 移除聚合模型

- 彻底移除聚合模型 `flowlet-pro` / `flowlet-flash`：`/v1/models`、模型服务页、Agent 默认配置与
  文档示例只使用规范模型 ID；
- 路由只接受规范模型身份（`virtual_model_id` 与 `upstream_model` 归一后必须一致），不再存在
  「一个对外模型名对应异构上游混池」的语义；
- Agent 接入改为在接入抽屉中显式选择默认模型：Claude Code 支持主模型 + 快速模型，其余 Agent
  使用单个主模型；未选择时由 Rust 按模型 id 字典序取第一个可用模型，没有可用模型时禁用一键
  接入并提示先开放模型；
- 删除 Codex 静态模型目录快照 `codex-models.json`，改为按所选主模型从 `models-cn.json` 动态
  生成 `~/.codex/model-catalog.flowlet.json`；
- 删除 Claude Code `[1m]` 长上下文、DSH `contextWindow` 与输入模态声明、OpenCode / Pi 输入模态
  声明；DSH 高级配置区只保留精确会话关联与 MCP 服务器。

### 迁移

- 升级时执行一次性、幂等迁移：旧 `flowlet-pro` / `flowlet-flash` 路由按 `upstream_model` 归一
  改写为对应直接模型路由，按 `(virtual_model_id, channel_id, account_id, upstream_model,
  client_protocol)` 去重并重排 priority，同时删除 `virtual_models` 中残留的旧聚合行；无法归一
  的旧行保留原样但不再参与路由，表结构不变；
- 历史请求日志中的 `flowlet-pro` / `flowlet-flash` 原值按原样展示；用量统计保留旧别名过滤，
  避免跨设备或旧快照重复统计。

### Docker / Web Host 会话管理

- 浏览器管理界面新增「会话管理」页，与桌面端共享同一套筛选、分页、Token/费用展示与
  会话详情抽屉；
- 会话目录只来自本实例 `request_logs` 的观测聚合：Web 管理 API 只新增
  `list_agent_sessions`、`list_agent_session_children`、`list_agent_session_clients`、
  `get_agent_session_flowlet_usage` 四个白名单命令，且只读取观测会话，不扫描服务器本机
  Agent 原生会话文件；
- 观测会话的详情保留请求统计与「查看请求日志」入口；原生用量、原生时间线与 OpenCode
  实时权限确认仍只在桌面端提供，Web 页面对应区块明确隐藏而不伪造数据；
- 不新增数据库表或字段，会话仍由请求日志实时聚合。

### 新增渠道与账号

- 新增 ChatGPT API（`openai-api`）渠道：项目 API Key、OpenAI / Responses 协议、模型列表拉取与全局白名单勾选；
- 新增 VibeToken 渠道：OpenAI / Responses 协议与官方余额查询；
- 新增 Antigravity 订阅额度观测：Google OAuth 浏览器授权、离线授权保存、远端套餐/额度/重置时间查询、令牌续期、重新授权与移除；观测报告不参与代理路由；
- 新增官方余额自动同步（DeepSeek / Kimi / OpenRouter / VibeToken 等）、账号工作区同步与余额快照；
- 新增设备用量聚合与读取，为 Web 版「用量统计」提供本机设备身份与日/小时聚合数据。

### 设置与用量

- 设置页重构为可搜索的分类面板，新增「内容捕获与保留策略」「上游代理」「费用展示」独立区块，桌面端与 Web 版共用同一实现；
- 费用展示支持统一货币折算、目标币种、固定汇率与备注；Web 版保存到 SQLite `app_meta`，不写入容器 `config.json`；
- 用量统计与用量洞察支持设备切换、设备维度聚合、Token 明细与未识别 Token 请求明细。

### 运行时与工程

- 后台维护任务抽取为 `host_scheduler`，桌面端与 headless 共用：每 15 分钟执行存储清理，每 1 小时同步 models-cn / models.dev 目录，并写入后台任务日志；
- Cargo 拆分 `desktop` feature 与独立 `headless` bin；无显示服务环境可用 `--no-default-features --bin headless` 构建；
- 新增浏览器管理 Host：显式管理命令白名单、管理凭据与模型调用凭据分离、`/health` 存活检查；
- 浏览器管理界面支持渠道账号、模型服务、请求日志、会话管理、用量统计/洞察与设置，复用桌面端领域命令；
- 新增 Dockerfile、docker-compose、`.env.docker.example` 与 Docker 部署文档。

### 文档

- 新增 `docs/docker.md`（Docker / 浏览器部署）与 `docs/antigravity-account.md`（Antigravity 订阅额度观测）；
- 新增管理端 OIDC SSO 设计文档（目标 GitLab 实例已完成 M0 门禁验证；登录功能尚未实现，不在本版本启用）；
- 新增 Electron 迁移方案与代码勘察文档（方案评审中，不改变当前 Tauri 运行时）。

## [0.1.1] - 2026-09-11

0.1.0 之后的第二个正式公开版本，补齐 Agent 生态、渠道与模型目录，并统一了内置插件契约。

### 新增渠道与模型

- 新增 Z.AI（智谱）渠道，支持 API 按量付费账号与控制台用量抓取；
- 千问新增免费额度账号与 Token Plan 套餐账号，并展示套餐过期、未订阅状态；
- 模型目录扩展：DeepSeek V4.1 Flash、DeepSeek V4 Pro 日期快照与视觉实验模型、
  GLM-5.3 与 GLM-5.3 Flash、Qwen3.8 Flash、NVIDIA Nemotron 3 系列、OpenRouter ox-alpha；
- 模型身份改为规范 ID 与厂商官方 API 名双侧归一匹配；价格支持生效时间与高峰/空闲时段。

### Agent 接入

- 新增 DeepSeek Harness 与 Hermes Agent 接入；DeepSeek Harness 支持精确会话关联、
  模型规格声明、交互确认桥与 MCP 服务器四项可选高级能力（默认关闭、可独立开关与恢复）；
- 新增 Codex 账号观测：订阅用量、套餐、Credits，以及刷新、重新授权和删除；
- OpenCode 与 Pi 可按真实路由声明输入模态；Agent 运行时状态与安装方式（含 npx）探测更完整。

### 代理与运行时

- 支持上游代理配置，并为托管子进程注入代理环境变量；
- Windows 绑定 Job Object，Flowlet 异常退出时回收托管子进程；
- Linux 与 macOS 使用文件锁保证单实例运行；改善 Wayland 兼容、窗口缩放与 Linux 便携版一键更新。

### 会话、任务与用量

- 会话详情合并对话与轨迹视图，会话列表读取增加缓存；远端设备会话与最近交互事件可跨设备合并；
- 后台任务统一为 JobDefinition / JobRuntime，具备并发上限与重试策略；
- Agent 原生用量支持按官方公开价估算等价费用，并支持多币种拆分与分时价格；
- 修复用量洞察页品牌图标：按客户端时 DeepSeek Harness、Hermes Agent 缺少 logo，
  按渠道账号时 Codex Desktop、Codex CLI、Claude Code 原生等 Agent 原生账号全部退化为首字母徽标。

### 工程

- 新增根目录 `plugin-registry.json`，统一声明内置渠道与 Agent 贡献，并补充注册表契约测试；
- 前端依赖方向与 workspaces 统一，安装包自动构建流程完善，Android 版本自动同步到蒲公英。

### 分发说明

- 提供 Windows x64 安装包与便携版、Android arm64 APK，并由 GitHub Actions 构建 Linux x64、macOS Apple Silicon 与 Intel 产物；
- 当前主要开发与完整回归环境为 Windows 11 原生环境（未启用 WSL）；Linux 与 macOS 尚未完成作者真机回归验证；
- Windows 桌面产物尚未签名；macOS DMG 使用 ad-hoc 签名但尚未经过 Apple 公证，
  首次启动可能需要手动放行。

## [0.1.0] - 2026-08-11

Flowlet 的首个正式公开版本。

### 主要功能

- 提供 OpenAI Chat Completions、Anthropic Messages 与无状态 OpenAI Responses 本地代理入口，保持协议与响应原貌；
- 统一管理多个模型渠道与账号，按需开放模型，并支持虚拟模型、多候选路由和失败降级；
- 一键接入 Claude Code、Codex、OpenCode 与 Pi，支持配置检查、备份、写入和恢复；
- 将 Agent 会话、实际请求、路由结果、Token 与费用关联起来，便于定位失败和核对消耗；
- 可把代码修改或分析任务交给本机 Agent 执行，并进行排队、审核、退回续跑和历史追踪；
- 提供按模型、账号、客户端和设备统计的用量与性能洞察；
- 支持自有 S3 多设备同步与局域网直连，并提供实验性 Android 移动辅助端。

### 分发说明

- 提供 Windows x64 安装包与便携版、Android arm64 APK，并由 GitHub Actions 构建 Linux x64、macOS Apple Silicon 与 Intel 产物；
- 当前主要开发与完整回归环境为 Windows 11 原生环境（未启用 WSL）；Linux 与 macOS 尚未完成作者真机回归验证；
- Windows 桌面产物尚未签名；macOS DMG 使用 ad-hoc 签名但尚未经过 Apple 公证，
  首次启动可能需要手动放行。

[0.1.1]: https://github.com/null-object-0000/flowlet/releases/tag/v0.1.1
[0.1.0]: https://github.com/null-object-0000/flowlet/releases/tag/v0.1.0
[0.1.2]: https://github.com/null-object-0000/flowlet/releases/tag/v0.1.2
[0.2.0]: https://github.com/null-object-0000/flowlet/releases/tag/v0.2.0
