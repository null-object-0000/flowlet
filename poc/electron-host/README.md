# Electron + Node 迁移骨架 PoC

> 目的：用**可运行的最小骨架**验证 Flowlet 迁移主航道成立——
> **Electron 壳 + Node 命令服务复用现有 `dist-web` 前端，前端零改动**。
> 这是 `docs/electron-migration-plan.md` P0 阶段的证据，不是生产实现。

## 结论（已验证）

| 验证项 | 结果 |
| --- | --- |
| Electron 窗口加载**未修改**的 `dist-web` 构建产物 | ✅ 真实界面完整渲染（见 `evidence/overview-x11.png`，1280×800） |
| 前端通过 `platform/web/client.ts` 的 HTTP 通道调用后端 | ✅ 渲染进程实际发出命令请求，Node 服务全部 200 |
| Node 服务读取**真实 SQLite 副本**并返回同形 JSON | ✅ 8 个真实命令：渠道账号、渠道预设、路由候选、虚拟模型、余额快照、今日 Token、代理状态、连接信息 |
| 管理凭据（Bearer）与 Web Host 一致 | ✅ 未登录 → 401；Seeded token → 200 |
| 未实现命令的失败形态 | ✅ 返回与 Rust 错误同形的 `{code,message}`（HTTP 501） |
| 单实例锁 | ✅ `app.requestSingleInstanceLock()` |
| 前端源码零改动 | ✅ `src/`、`vite.config.ts`、根 `package.json` 均未改 |

`usage_today_tokens` 返回的是库里的真实聚合值（2,408,066,826 tokens），与截图
service-strip 的"今日消耗 24.08 亿 Tokens"一致，说明数据链路是从 SQLite 一路到 UI 的。

## 运行

```bash
cd poc/electron-host
npm install                 # 只有 electron 一个依赖，无原生编译
# 复制真实数据库副本（只读打开；绝不写用户真实库）
mkdir -p data && cp "<Flowlet 数据目录>/flowlet.sqlite" data/
node server.mjs             # 仅后端：http://127.0.0.1:18787
# 或直接开壳：
./node_modules/electron/dist/electron . --no-sandbox --disable-gpu --ozone-platform=x11
```

- 管理凭据默认 `flowlet-poc-admin-token-0123456789`（≥24 字符），可用
  `FLOWLET_ADMIN_TOKEN` 覆盖。
- 截图：`xvfb-run -a -s "-screen 0 1280x800x24" ./capture-x11.sh`
  （本沙箱是 Wayland + 无 GPU：Electron `capturePage` 报 `UnknownVizError`，
  且 Ozone 默认选 Wayland 导致窗口不映射到 Xvfb，故强制 `--ozone-platform=x11` 后用
  ffmpeg 抓帧。）
- 已实现命令清单见 `server.mjs` 的 `HANDLERS`；其余命令返回 501。

## 关键实现点（迁移时的可复用结论）

1. **命令契约**：参数一律 camelCase（与 Tauri 默认一致）；返回字段风格必须逐类型对照
   Rust serde 属性（`snake_case`/`camelCase` 混用），不能全局假定。
2. **SQLite**：本次用 Node 内置 `node:sqlite`（Electron 45 = Node 24.22，`DatabaseSync`
   可用）——**零原生编译**，直接打开 Rust 版同一份库、同一套表；PRAGMA 需与 Rust 对齐
   （`journal_mode=WAL`、`foreign_keys=ON`）。生产建议 node:sqlite 优先、
   `better-sqlite3` 回退，并把重查询放 `worker_threads`。
3. **静态资源**：Node 直接服务仓库现有 `dist-web/`（SPA fallback），Electron 只加载
   `http://127.0.0.1:18787`；桌面/Web/Docker 三种形态共用同一命令通道。
4. **凭据注入**：桌面壳把管理凭据写入渲染进程 `sessionStorage` 后 reload，等价于用户在
   Web Host 登录页输入 Token——不需要改前端，也不需要 IPC 桥。

## 未验证 / 已知限制

- 只实现 8 个只读命令；写入命令、代理转发、后台任务、Agent 接入均未实现。
- 未实现 `start_proxy`，概览页显示"已停止"（截图里的"本地代理：已停止"是真实状态）。
- 未做前端 `platform/electron` 适配：当前走的是 web 模式（`import.meta.env.MODE === "web"`），
  生产版应新增 electron 平台适配与事件桥（3 个 Rust→前端事件）。
- 未验证 Electron 打包、签名、自动更新、托盘、无边框壳（见平台缺口矩阵）。
- 本沙箱是 Wayland + 无 GPU 环境；Windows/macOS 行为未验证。

## 安全说明

- `data/` 是用户数据库副本，已在 `.gitignore` 排除，**不得提交**；本次勘察结束后应删除。
- `evidence/` 整体已在 `.gitignore` 排除，**不入库**，只作本地验证证据：其中
  `command-list_channel_accounts.json` 含真实账号名（手机号 / 邮箱），
  `command-latest_balance_snapshots.json` 含上游抓取原文（含一次性 `secToken`）。
  虽然 `api_key` / `management_key` / `sk-*` 已脱敏为 `[redacted]`，仍不随仓库分发。
