# 桌面（Electron）命令层

本目录提供 Electron 本机 Host 的桌面命令。Web 已实现的命令继续由
`../web/commands.ts` 处理，不在这里重复；桌面命令仅在 `ctx.desktop` 存在时可用。
不再依赖旧宿主源码作为行为权威，命令数量以当前注册表为准。

静态注册检查：仓库根运行 `npm run node:commands`（`scripts/check-command-contract.mjs`）。
只检查字面量名称、Node 注册与 Web 权限白名单，不证明参数/返回值或行为 100% 覆盖。
行为仍须相关 Node 测试、`npm run node:e2e` 与 Electron 冒烟。

## 目录与负责人

| 文件 | 负责命令（实现与测试为当前事实源） | 负责人 |
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
   `CommandError.badRequest/notImplemented`（`../types.ts`），保留既有可读错误文案与结构。
2. **返回字段必须保持既有 HTTP 契约兼容**（snake_case / camelCase 混用，不要「顺手统一」）。
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
| `keyring.get` | `{ service, username }` | `{ secret: string \| null }` | safeStorage 密文读取，兼容迁移旧 OS 条目 |
| `keyring.set` | `{ service, username, secret }` | `null` | safeStorage 密文写入 |
| `keyring.delete` | `{ service, username }` | `null` | 删除密文与适用的旧条目 |
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

Electron 数据与随包资源路径由 `packages/flowlet-desktop/src/paths.ts` 解析，再通过
`DesktopRuntime.dataDir` 传入。开发默认 `.flowlet-dev-data/desktop`；便携版有 `portable.tag` 时
优先可执行文件目录；不可写时降级平台应用数据目录。不要假定数据库总在 `data/` 子目录。
升级必须保留现有账号/日志、设备身份与 S3/LAN / 账号工作区契约。

前端命令通过 `src/platform/host` 的 HTTP 边界；窗口、文件对话框与固定事件走受控 preload bridge。
不得开放任意 renderer IPC / host channel，client 模式不开放本机 Agent、抓取、同步或自启。
