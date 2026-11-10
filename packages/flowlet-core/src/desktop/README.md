# 桌面（Electron）命令层

本目录是 Rust/Tauri 桌面端 142 条命令的 Node/TS 等价实现。**Web Host 已实现的 66 条命令不在这里重复**，
它们继续由 `../web/commands.ts` 的 dispatch 处理；桌面命令是 Web 命令面的**超集**。

## 目录与负责人

| 文件 | 负责命令（权威行为见 `src-tauri/src/commands/*.rs`） | 负责人 |
| --- | --- | --- |
| `agent.ts` | Agent 环境/运行时/Codex/Antigravity/全局配置（17 条） | desktop-agent |
| `maintenance.ts` | 设置、配置导入导出、存储维护、自启、路由规则（22 条） | desktop-maintenance |
| `account-workspace.ts` | 账号工作区 S3 同步（5 条） | desktop-maintenance |
| `observability.ts` | Agent 原生会话、后台任务、目录同步预览（17 条） | desktop-observability |
| `device.ts` | 跨设备同步 S3/LAN（23 条） | desktop-device |
| `scrape.ts` | 控制台抓取（CDP）与余额/目录同步（10 条） | desktop-scrape |
| `commands.ts` | 注册表与 dispatch（只由 Lead 修改） | lead |
| `types.ts` | `DesktopContext` / `DesktopHandler` 契约（只由 Lead 修改） | lead |

新增命令 = 在自己领域文件里往 `handlers` 加一个 `DesktopHandler`；**不要**改 `commands.ts` 的合并顺序。

## 命令实现约定

1. **参数读取复用 `../web/errors.ts` 的 `argString/argInteger/argObject/argBytes/...`**，错误用
   `CommandError.badRequest/notImplemented`（`../types.ts`），错误文案与 Rust `Err(String)` 对齐。
2. **返回字段风格必须与 Rust 逐字段一致**（snake_case / camelCase 混用，不要「顺手统一」）。
3. **不直接 sqlite**：需要新查询时在自己的领域文件旁新增 `../storage/<domain>.ts` 导出纯函数
   （签名 `(db: DatabaseSync, ...) => ...`），通过 `ctx.storage.withDatabase((db) => ...)` 调用；
   不要改 `../storage/index.ts` 的方法列表（避免与其它领域冲突，由 Lead 统一收口）。
4. **平台能力只走 `ctx.desktop.host.invoke(channel, payload)`**，命令层禁止 import electron。
5. **同步命令可以同步实现**（handler 返回非 Promise 也允许），但保持签名 `Promise<unknown>` 更简单。

## Host channel 契约

Electron 主进程（`packages/flowlet-desktop/`）实现下列 channel；命令层按此调用，新增 channel 必须两端同时落地
并在本表登记。

| channel | payload | 返回 | 说明 |
| --- | --- | --- | --- |
| `platform.appInfo` | `{}` | `{ version, dataDir, portable, platform, arch }` | 版本/数据目录/便携标记 |
| `platform.openExternal` | `{ url }` | `null` | 仅允许 http/https |
| `platform.logFromFrontend` | `{ level, message, detail? }` | `null` | 写入主进程日志（`get_app_diagnostics` 可见） |
| `platform.diagnostics` | `{}` | `JsonRow` | 版本、路径、日志尾部、环境信息 |
| `platform.notify` | `{ title, body }` | `null` | 原生通知（可用性由宿主决定） |
| `platform.trayTooltip` | `{ text }` | `null` | 托盘提示（代理状态） |
| `platform.autostart.get` | `{}` | `{ enabled: boolean }` | 开机自启状态 |
| `platform.autostart.set` | `{ enabled }` | `null` | 写系统自启项 |
| `platform.relaunch` | `{}` | `null` | 请求重启应用（不保证立即返回） |
| `platform.quit` | `{}` | `null` | 退出应用（停止代理） |
| `keyring.get` | `{ service, username }` | `{ secret: string \| null }` | OS 凭据库读取 |
| `keyring.set` | `{ service, username, secret }` | `null` | OS 凭据库写入 |
| `keyring.delete` | `{ service, username }` | `null` | OS 凭据库删除 |
| `agentRuntime.start` | `{ agentType, cwd? }` | `{ running, pid?, url? }` | 托管 Agent 运行时（DSH Web 等） |
| `agentRuntime.stop` | `{ agentType }` | `null` | 停止托管运行时 |
| `agentRuntime.status` | `{}` | `{ running, pid?, url?, external? }` | 运行时状态 |
| `scrape.openConsole` | `{ accountId, url, partition? }` | `{ opened: boolean }` | 打开 per-account 隐藏抓取窗口 |
| `scrape.closeConsole` | `{ accountId }` | `null` | 关闭抓取窗口（登录态保留在 partition） |
| `scrape.runPlan` | `{ accountId, plan, timeoutMs? }` | `{ result }` | 执行抓取脚本计划（CDP 导航/取数） |
| `scrape.cancel` | `{ accountId }` | `null` | 取消进行中的抓取 |
| `scrape.probeLogin` | `{ accountId }` | `{ loggedIn, url }` | 探测登录态 |
| `power.preventSuspend` | `{ enabled }` | `null` | 代理由此持有电源抑制 |

## 数据目录

桌面版必须打开与 Rust/Tauri 版本**同一个**数据库路径（便携版在 exe 旁 `data/`，安装版在系统数据目录），
否则用户升级后会丢失账号/日志。解析规则见 `src-tauri/src/core/portable.rs` 与 `src-tauri/src/lib.rs`，
Electron 主进程负责解析并通过 `DesktopRuntime.dataDir` 传入。