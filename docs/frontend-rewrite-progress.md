# Flowlet 前端重构进度（Progress）

本文档记录前端重构的历史迭代；当前正式前端位于 `src`。
每轮开始前必须重读本文件、`AGENTS.md`、`docs/frontend-rewrite.md`、`docs/config.md`、`docs/architecture.md`、`git status` 和当前分支最新代码。

---

## 当前状态

- 当前阶段：阶段 E 已完成，重构前端已正式化为 `src`
- 已完成切片：桌面壳、代理生命周期、概览页、渠道账号、开放模型、客户端访问信息、AI Agent 接入、请求日志及详情、用量成本、设置、多语言和主题
- 正式入口：**仅加载 src**；`ui.version`、legacy fallback 和旧 Mantine 前端已删除
- 构建入口：`npm run dev`、`npm run build`、`npm test`

> 下方阶段 0 调用链、旧目录名 `src-new` 和迁移矩阵属于历史记录，用于解释迁移来源；“读取方（旧）”和旧 `refreshAll` 不代表当前实现规范。

---

## 一、Tauri Command 真实调用链盘点（阶段 0 产出）

以下 Rust command 全部在 `src-tauri/src/commands.rs` 中定义，并于 `src-tauri/src/lib.rs` 的 `invoke_handler!` 中注册。
前端通过 `src/services/flowletApi.ts` 的 `runCommand(name, args)`（封装 `invoke` + 15s 超时）调用。
**页面和组件禁止直接拼写 command 名称；新前端须通过各领域 adapter 暴露。**

### 1.1 Command → 数据 → 旧前端调用方对照

| Rust Command | 返回类型 | 读取方（旧） | 写入方（旧） | Mutation 后需失效的领域 | 隐私/安全 |
|---|---|---|---|---|---|
| `start_proxy` | `Result<(), String>` | `proxyActions.startProxy`、App 初始化自动启动 | — | proxy status | 幂等 |
| `stop_proxy` | `Result<(), String>` | `proxyActions.stopProxy`, `restartProxy` | — | proxy status | — |
| `proxy_status` | `ProxyStatus` | `useFlowletData.refreshStatus`、`refreshAll` | setStatus | 自身 | 无敏感数据 |
| `test_connection` | `Result<(), String>` | `channelActions.testConnection` | — | 无（不读写已保存账号） | 传入明文 API Key 给上游鉴权校验，不落库 |
| `get_proxy_bind_config` | `ProxyBindConfig` | `refreshAll` | setProxyBindConfig | 自身 | 含 `default_client_token` |
| `set_proxy_bind_config` | `Result<(), String>` | `configActions.saveProxyBindConfig`, `setDefaultClientToken` | — | proxy status（含 allow_lan 重启代理） | 含 token |
| `list_channel_presets` | `Vec<ChannelPreset>` | `refreshAll` | setChannels | 自身 | 无敏感数据 |
| `save_channel_presets` | `Result<(), String>` | 未直接使用（预留） | — | presets | — |
| `list_channel_accounts` | `Vec<ChannelAccount>` | `refreshAll` | setAccounts | 自身 | **含明文 api_key** |
| `save_channel_accounts` | `Vec<ChannelAccount>` | `channelActions.saveAccounts`, `quickSetup` | setAccounts | accounts、routes、models、balance | **含明文 api_key** |
| `list_route_candidates` | `Vec<RouteCandidate>` | `refreshAll` | setRoutes | 自身 | 无敏感数据 |
| `save_route_candidates` | `Result<(), String>` | `routeActions.saveRouteCandidates`, `channelActions.*` | — | routes、configurationStatus | — |
| `list_channel_models` | `Vec<ChannelModel>` | `refreshAll`, `refreshChannelModels` | setChannelModels | 自身 | — |
| `list_virtual_models` | `Vec<VirtualModel>` | `refreshAll` | setVirtualModels | 自身 | — |
| `save_virtual_models` | `Result<(), String>` | 未显式调用 | — | virtualModels | — |
| `analyze_usage` | `Result<usize, String>` | `usageActions.analyzeUsage` | — | usage | — |
| `usage_summary` | `Vec<UsageSummaryRow>` | `refreshAll`, `usageActions.refreshUsage` | setUsageRows | 自身 | 成本数值 |
| `list_request_logs` | `LogsPageResult` | `refreshAll`, `usageActions.refreshLogs` | setRequestLogs、logMeta | 自身 | **捕获 req/res headers+body（含敏感）受 log_capture 控制** |
| `list_request_log_clients` | `Vec<LogFilterClient>` | `refreshAll` | setLogClients | 自身 | — |
| `get_request_log_detail` | `Vec<RequestLogRow>` | `usageActions.fetchLogDetail` | setLogDetail | 自身 | **含敏感 header/body** |
| `get_log_capture_config` | `LogCaptureConfig` | 未显式调用 | — | 自身 | — |
| `set_log_capture_config` | `Result<(), String>` | 未调用 | — | 自身 | — |
| `query_balance` | `BalanceQueryResult` | `channelActions.queryBalance` | — | balanceSnapshots、accounts（credential_status） | — |
| `sync_models` | `ModelSyncResult` | `channelActions.syncModels` | — | channelModels、routes | — |
| `save_balance_snapshot` | `Result<(), String>` | `channelActions.addBalanceSnapshot` | — | balanceSnapshots | — |
| `list_balance_snapshots` | `Vec<AccountBalanceSnapshot>` | 未显式调用 | — | 自身 | — |
| `latest_balance_snapshots` | `Vec<AccountBalanceSnapshot>` | `refreshAll` | setBalanceSnapshots | 自身 | — |
| `account_stats` | `Vec<AccountStatsRow>` | `refreshAll` | setAccountStats | 自身 | — |
| `is_autostart_enabled` | `bool` | `refreshAll`, `configActions.toggleAutostart` | setAutostartEnabled | 自身 | — |
| `enable_autostart` / `disable_autostart` | `Result<(), String>` | `configActions.toggleAutostart` | — | autostart | — |
| `list_route_rules` | `Vec<RouteRule>` | `refreshAll` | setRouteRules | 自身 | — |
| `save_route_rules` | `Result<(), String>` | `routeActions.saveRouteRules` | — | routeRules | — |
| `account_routing_scores` | `Vec<(String,String,f64,f64,f64)>` | `refreshAll` | setRoutingScores | 自身 | 高级能力 |
| `export_config` | `String(JSON)` | `configActions.exportConfig` | — | 无（导出） | 导出完整配置（含 api_key） |
| `import_config` | `Result<(), String>` | `configActions.importConfig` | refreshAll 重载 | 全领域 | 含 api_key |
| `db_stats` | `(i64,i64,i64)` | `refreshAll` | setDbStats | 自身 | — |
| `read_app_meta` | `Option<String>` | `refreshAll`（`model_exposure_mode`）、旧代码 | — | 自身 | — |
| `write_app_meta` | `Result<(), String>` | `configActions.changeExposureMode` | — | exposureMode | — |
| `cleanup_old_logs` | `(usize,usize)` | `configActions.cleanupLogs` | refreshAll | logs、usage | — |
| `read_config` | `String` | 正式 UI 入口不再调用；旧配置能力保留 | — | 无 | 原始 JSON |
| `write_config` | `Result<(), String>` | 未显式调用 | — | 无 | 完整 JSON 覆盖 |
| `ipc_ping` | `Value` | 调试 | — | — | — |
| `log_from_frontend` | `()` | `flowletApi.logToRust`（非高频路径） | — | — | 日志落盘 |

### 1.2 重要缺口与异常（盘点结论）

1. **`save_clients` / `list_clients` command 不存在。**
   - `src/app/actions/clientActions.ts` 调用了 `runCommand("save_clients")` / `runCommand("list_clients")`。
   - 但 `src-tauri/src/commands.rs` **没有定义** 这两个 command，`lib.rs` 的 `invoke_handler!` **没有注册**。
   - Rust `ClientConfig` 类型在 `config.rs` 中存在，**但没有** 对应的 command，也未见 `clients` 表读写（需实现层再确认）。
   - 评估：旧版「客户端 Token 管理」页面在实际上**可能从未真正持久化**（调用会 invoke 失败被 `.catch` 吞掉）。迁移到 `src-new` 时，客户端 token 当前依赖 `ProxyBindConfig.default_client_token`（持久化于 `app_meta`）作为主真实来源。是否新增 `clients` 表与 command，属于「需用户确认的范围变更」，本轮**标记阻塞，不自行实现**。

2. **`db_stats` 返回三元组**：`(log_count, usage_count, db_file_bytes)` 的语义由 storage 层决定，新前端须 typed adapter 明确命名，避免位置参数。

3. **`account_routing_scores` 返回 5 元组**：`(account_id, channel_id, success_rate, fallback_rate, score)`，属高级路由，延后迁移并 typed 化。

4. **命令返回单位不一致**：有的返回领域数组，有的返回 `{rows,total,page,pageSize}` 包装，有的返回裸值。新前端 adapter 全部归一为领域类型，禁止页面解析元组/裸字符串。

### 1.3 旧数据错误吞没问题（迁移时必须修正）

- `useFlowletData.refreshAll` 对所有 list 命令使用 `.catch(() => [])`，错误被静默吞为空数组，UI 无法区分「空」和「出错」。
- 新前端：**禁止**把 command 失败默认转为空数组；loading/error/empty/ready 必须明确区分。

---

## 二、旧页面 → 领域 → 新页面迁移矩阵

| 旧页面 | 主要 Tauri Commands | 核心 Domains | 新页面目标 | 迁移状态 |
|---|---|---|---|---|
| `OverviewPage` | `proxy_status`, `get_proxy_bind_config`, `list_channel_accounts`, `list_channel_presets`, `usage_summary`(仅展示状态，不展示统计值) | proxy、channel、account | `pages/overview/OverviewPage` | 已迁移 |
| `ChannelsPage` | `list_channel_presets`, `list_channel_accounts`, `save_channel_accounts`, `test_connection`, `sync_models`, `query_balance`, `latest_balance_snapshots` | channel、account、model、usage | `features/channel-accounts/AccountManagementSideSheet`（概览内） | 已迁移（Iteration 9 校正） |
| `RoutesPage` / 模型服务 | `list_route_candidates`, `save_route_candidates`, `list_channel_models`, `list_virtual_models`, `list_channel_accounts`, `list_channel_presets`, `read_app_meta`, `write_app_meta` | model、channel | `pages/models/*` | 已迁移 |
| `ClientsPage` | `get_proxy_bind_config`, `set_proxy_bind_config`(default_client_token) | client、settings | 合并到概览客户端访问信息与接入详情 | 已迁移（不新增独立客户端页） |
| `ClaudeCodePage` / 代理接入 | `get_proxy_bind_config`, `list_virtual_models` | client、model | 合并到概览 AI Agent 接入 | 已迁移 |
| `LogsPage` | `list_request_logs`, `list_request_log_clients`, `list_request_log_models`, `get_request_log_detail` | request-log、usage | `pages/request-logs/*` | 已迁移 |
| `UsagePage` | `usage_summary`, `analyze_usage` | usage | `pages/usage/*` | 待迁移（阶段 7） |
| `StatsPage` | `account_stats`, `list_route_rules`, `save_route_rules`, `account_routing_scores`, `cleanup_old_logs`, `is_autostart_enabled`, `enable/disable_autostart`, `export_config`, `import_config` | settings、usage | `pages/settings/*` | 待迁移（阶段 8） |

### 2.1 Features → 新归属

| 旧 Feature | 职责 | 新 Feature 目标 |
|---|---|---|
| `ProxyStatusCard` | 代理状态+启动/重启/测试 | `features/proxy-lifecycle/*` |
| `AccountEditorDrawer` / `AccountManagementDrawer` / `ChannelAccountOnboarding` / `ChannelAccountsPanel` / `LongCatPackImportDialog` | 账号增删改、连接测试、余额、模型同步、LongCat 包导入 | `features/account-editor/*`, `features/channel-account-onboarding/*` |
| `ApiAccessDrawer` / `ClientAccessCard` / `ClientTokenRow` | 客户端接入信息 | `features/agent-access/*` 或 `features/client-access/*` |
| `AgentAccessCard` | Agent 接入卡片 | `features/agent-access/*` |
| `ExposedModelsCard` / `ModelServicesPanel` / `ModelSyncPanel` | 开放模型、同步 | `features/model-exposure/*`, `features/model-sync/*` |
| `RouteCandidatesPanel` / `RouteRulesPanel` | 高级路由 | `features/advanced-routing/*`（延后） |
| `Sidebar` / `ProxyTopbar` / `WindowControls` | 导航与布局 | `app/shell/*` |

### 2.2 代理自动启动 / 生命周期（现有实现要点）

- 位置：`src/app/App.tsx` 初始化 effect。
- 当前逻辑：前端初始化后调用 `proxy_status`，若未运行则调用 `start_proxy`。
- 问题：存在 StrictMode/重连触发多次的可能；旧版依靠 `refreshTokenTokenRef` 防止 refreshAll race，但未单独对自动启动做幂等保护（依赖 `start_proxy` 在 Rust 侧幂等）。
- 产品规则（已实现于 Rust，新前端沿用）：
  - 无账号/无模型/无路由仍可启动代理
  - 启动失败后展示「重新启动」+ 错误原因，不无限重试
  - 运行中展示「重启服务」，未运行展示「启动服务」
  - 不常驻停止按钮于概览主入口

### 2.3 隐私与敏感数据清单

- `ChannelAccount.api_key`：明文，仅在账号编辑页管理，概览/列表/日志不得展示完整或脱敏 key。
- `get_proxy_bind_config` 返回 `default_client_token`：仅用于客户端接入页复制，不作为统计/概览展示。
- 日志 `req_headers_json` / `req_body_b64` / `res_*`：受 `log_capture` 布尔值与 `max_body_bytes`、`redact_sensitive_headers` 控制；日志页须遵守。
- `export_config` / `import_config`：流转完整配置（含 api_key）；导入/导出为设置页高级能力。

---

## 三、新前端领域划分（domains/）

| Domain | 主要类型 | 主要 Queries | 主要 Mutations |
|---|---|---|---|
| `proxy` | `ProxyStatus`, `ProxyBindConfig` | `status()`, `bindConfig()` | `start()`, `stop()`, `restart()`, `setBindConfig()` |
| `channel` | `ChannelPreset` | `presets()` | `savePresets()` |
| `account` | `ChannelAccount` | `accounts()` | `saveAccounts()`, `testConnection()`, `syncModels()`, `queryBalance()`, `syncBalance()` |
| `model` | `ChannelModel`, `VirtualModel`, `ModelExposureMode` | `channelModels()`, `virtualModels()`, `exposureMode()` | `saveVirtualModels()`, `setExposureMode()`, `syncModels()` |
| `route` | `RouteCandidate`, `RouteRule` | `candidates()`, `rules()` | `saveCandidates()`, `saveRules()` |
| `client` | `ClientConfig`, `default_client_token`(来自 bindConfig) | — | 待确认 |
| `request-log` | `RequestLogRow`, `LogsFilter`, `LogFilterClient`, `LogsPageResult`, `LogMeta` | `logs(filter)`, `logClients()`, `logDetail(id)` | `clearDetail()` |
| `usage` | `UsageSummaryRow`, `AccountStatsRow`, `AccountBalanceSnapshot` | `usageSummary()`, `balanceSnapshots()`, `accountStats()`, `latestBalanceSnapshots()` | `analyzeUsage()`, `saveBalanceSnapshot()` |
| `settings` | 自 `config.json` + app_meta | `autostart()`, `logCapture()`, `dbStats()`, `appMeta(key)`, `configRaw()` | `setAutostart()`, `setLogCapture()`, `setAppMeta()`, `cleanupLogs()`, `exportConfig()`, `importConfig()` |

---

## 四、迭代 Loop 记录

> 格式见「十八、进度汇报格式」。后续轮次追加到本节末尾。

### Iteration 1（阶段 0 + 阶段 1 开始）

目标：
- 建立 `docs/frontend-rewrite-progress.md`
- 完成旧页面到 Tauri command 的迁移矩阵（含异常与缺口）
- 拆分 `src-new/styles/index.css`
- 加固 tauri typed client + AppError 映射
- 运行 `npm run check` 与 `npm run build:new`
- 更新 progress，自动进入下一轮

本轮变更：
- 新增 `docs/frontend-rewrite-progress.md`（迁移矩阵、领域划分、阻塞项、队列）。
- `src-new/styles/index.css` 拆为 `styles/reset.css` + `styles/tokens.css`（全局只放重置/token）。
- 新增 `app/shell/AppShell.module.css`、`pages/rewrite-placeholder/RewritePlaceholderPage.module.css`，AppShell/Placeholder 改用 CSS Module。
- 重写 `platform/tauri/client.ts`：typed invoke + 超时 + `InvokeError` + `toAppError` 映射，拒绝吞并。
- 新增 `shared/errors/codes.ts`（ErrorCode 字典）、`shared/errors/async-state.ts`（AsyncState 四态）。
- 新增 `shared/constants/proxy.rs` 风格常量（端口/地址/token 默认值）。
- 新增 `shared/query-keys.ts`：集中 Query Key 工厂（按领域）。
- 新增 `domains/proxy/{types,commands}.ts`：代理领域类型 + command adapter（status/start/stop/restart/bindConfig）。
- 新增 `features/proxy-lifecycle/{useProxyStatus,useProxyActions,useProxyAutoStart,ProxyStatusCard}.{ts/tsx}` + CSS Module：查询、mutation、StrictMode 单次自动启动守卫、状态卡片（启动/重启/失败+原因）。
- 新增 `pages/overview/OverviewPage.tsx` + CSS Module（无账号：代理状态 + 三步引导；隐藏模型/客户端/Agent 区）。
- `app/router.tsx` 改为渲染 `OverviewPage`，移除 `RewritePlaceholderPage` 路由；`app/shell/AppShell.tsx` 增加 `NavLink` 导航；新增 `Nav.module.css`。
- `app/providers.tsx` 包裹 `ErrorBoundary`（`shared/errors/ErrorBoundary.tsx`）。
- 新增测试基座：`src-new/vitest.config.ts`、`shared/testing/setup.ts`、`npm run test:new` 脚本；新增 `platform/tauri/client.test.ts`（4 个用例）。

调用链：（见本文档第一、二节）；旧前端真实调用链已逐项核实，确认 `save_clients`/`list_clients` 无 Rust 实现。

检查结果：
- `npm run check`（tsc --noEmit，覆盖 src + src-new）：通过，0 错误。
- `npm run test:new` vitest：1 文件 / 4 测试通过。
- `npm run build:new` vite --mode next：通过。
- `npm run build`（legacy）: 通过。
- 两套构建产物均正常；唯一输出为已知 lottie-web direct eval 警告（依赖侧已知问题）。

文件体积（src-new 业务文件，行数）：
client.ts 110、ErrorBoundary 40、domain/proxy/commands 75、ProxyStatusCard 140、OverviewPage 85、async-state / query-keys / codes 均 <60；CSS Module 均 <60。无 TSX/CSS Module 超阈。

数据结构影响：无（不改 SQLite/schema、不改 config.json 语义、不改 Rust、不改旧前端）。

配置与重启影响：无（仅新增 `test:new` 脚本与测试依赖）。

已知问题：
- `save_clients` / `list_clients` command 与 clients 表缺失（旧前端客户端页从未真正持久化）→ 阻塞 B1，待用户确认是否新增 Rust 能力或移除独立客户端页。
- 旧前端 refreshAll 全量刷新 + 错误吞没，已以 TanStack Query + 精准 invalidation + 明确 error 替代。
- 已知 cargo test 曾因 `proxy_tests.rs` 与结构不同步无法编译，本轮未跑 cargo（未改 Rust），待下一轮前重新验证 cargo check/test。
- Semi lottie-web direct eval 构建警告（依赖侧，已知）。
- 代理自动启动依赖前端单守卫 ref；与 Rust 幂等 start_proxy 形成双层防重，符合 AGENTS.md §3。

下一轮：（见 Iteration 2 汇报后更新）

---

### Iteration 2（阶段 4：渠道与账号闭环）

目标：
- `domains/channel` + `domains/account` 类型与 command adapter（Rust 契约 typed）。
- `features/channel-accounts`：useChannelPresets / useAccounts / useAccountActions + AccountList + AccountEditorDrawer + AccountOnboarding。
- `pages/channels/ChannelsPage`：加载/错误/空/就绪四态、渠道分组账号、创建/编辑/删除、连接测试、持久化。
- 概览页新增 LongCat/DeepSeek 添加入口与管理入口；壳导航增加「渠道账号」。
- 渠道契约测试。

本轮变更：
- 新增 `domains/channel/{types,commands}.ts`、`domains/account/{types,commands}.ts`。
- 新增 `features/channel-accounts/{useChannelPresets,useAccounts,useAccountActions,index}.ts`、`AccountList.tsx`、`AccountEditorDrawer.tsx` + `.module.css`、`AccountOnboarding.tsx`。
- 新增 `pages/channels/ChannelsPage.tsx` + `.module.css`、`pages/overview/OverviewPage` 添加入口按钮。
- `app/router.tsx` 增加 `/channels` 路由；`app/shell/AppShell.tsx` 增加导航项。
- 新增 `domains/account/commands.test.ts`（5 契约用例）。

调用链（真实）：
- Channel 模板 `list_channel_presets` → `channelCommands.listPresets` → `useChannelPresets` → 页面分组/选项。
- 账号列表 `list_channel_accounts` → `useAccounts`；草稿在页面本地增删改；保存 `save_channel_accounts` → `useAccountActions.saveAll` → `refetchQueries(account.list)` 以 Rust 归一化结果为真源。
- 连接测试 `test_connection`（新建未保存账号也能测，不落库），`sync_models`、`query_balance` adapter 已就绪（页面尚未全部接入，按钮已可触发测试）。
- API Key 仅在 `AccountEditorDrawer` 内编辑，mode=password；编辑回显用占位符、不落 api_key 回列表/概览（隐私）。

检查结果：
- `npm run check`：通过。
- `npm run test:new`：2 文件 / 9 测试通过（含契约测试）。
- `npm run build:new`：通过。
- `npm run build`（legacy 回归）：通过。

文件体积：commands 45/75 行、AccountList 110、AccountEditorDrawer 170（含 Field 辅助）、ChannelsPage 125、页面 CSS <55；无超阈。

数据结构影响：无（未改 Rust / schema / config.json / 旧前端）。

配置与重启影响：无。

已知问题：
- 账号页「测试连接」目前仅对当前行即时提示；模型同步/余额同步按钮已保留 action 待后续 UI 接入。
- 「保存」兜底：页面级草稿语义（dirty）确保仅显式点击才落盘；与产品规则「不创建隐式默认账号」一致。
- `AccountList` 使用 Semi `Table` 默认分页关闭（数据量小），后续若膨胀再做虚拟滚动。

下一轮：阶段 5 — 开放模型（渠道模型同步、virtual_model_id、开放/关闭、默认开放模型、配置状态 ready/no_models/unconfigured）。

---

### Iteration 3（壳层与概览信息架构校正）

目标：
- 保持旧版主导航、概览布局与模块划分，不因 clean-room 重写改变产品信息架构。
- 恢复无系统边框窗口的拖拽区域和最小化/最大化/关闭按钮组。
- 概览页接入真实账号、路由和代理绑定查询，恢复账号、开放模型、客户端访问、Agent 接入四个模块。

本轮变更：
- 主导航恢复为「概览、模型服务、请求日志、用量成本、高级设置」；渠道账号管理保留为概览内抽屉，不占用主导航或独立路由。
- 删除无业务意义的「Flowlet 前端重构」顶栏，壳层恢复为旧版 168px 侧栏和桌面布局。
- 新增 typed window adapter 和 `WindowControls`，恢复拖动、最小化、禁用态最大化、关闭交互。
- 概览使用真实 accounts/routes/bind config query；无账号继续展示接入引导，有账号展示旧版四模块布局，API Key 不进入概览。
- 未迁移的主菜单页面保留明确占位路由，避免菜单缺失或伪装成已迁移。
- 同步 `docs/frontend-rewrite.md` 与 `docs/config.md`：当前重构分支默认 `next`，异常回退仍为 `legacy`。

检查结果：
- `bun run check`：通过。
- `bun run test:new`：3 个测试文件 / 12 个测试通过。
- `bun run build:new`：通过；仅有已知 lottie-web direct eval 与大 chunk 警告。
- `bun run build`：通过；警告与新版构建一致。
- 本地浏览器视觉检查受运行环境 localhost 隔离限制，未完成；需以 Tauri dev 烟雾测试补验窗口拖拽和原生按钮调用。

数据结构影响：无；未修改 Rust、SQLite schema 或 Tauri command。

配置与重启影响：文档与仓库现状对齐，`ui.version = next` 仍需重启应用生效。

下一轮：阶段 5 — 开放模型完整闭环。

---

### Iteration 4（概览：代理服务状态功能对齐）

目标：
- 将新版概览的代理服务状态模块做到与旧版功能、字段和布局层级一致。

本轮变更：
- 启动/重启主操作恢复到概览标题区；状态卡不再混入操作按钮。
- 恢复 `starting / running / stopped / failed` 标签和对应提示。
- 恢复监听地址、端口、运行时长、启动时间 Tooltip 与心跳信号图形。
- 配置提示继续独立区分 `unconfigured / no_models / ready`，并要求开放模型绑定可用账号后才进入 ready。
- 修复自动启动完成后未主动刷新真实代理状态、StrictMode effect 清理后可能丢失启动错误的问题。
- 修复手动启动/重启失败没有进入 failed 展示的问题。
- 代理状态恢复每 3 秒轮询，与旧版行为一致。

检查结果：
- `bun run check`：通过。
- `bun run test:new`：5 个测试文件 / 18 个测试通过。
- `bun run build:new`：通过；仅有已知 lottie-web direct eval 与大 chunk 警告。
- `bun run build`：通过；警告与新版构建一致。

数据结构影响：无；未修改 Rust、SQLite schema、config.json 或 Tauri command。

配置与重启影响：无；代理状态和配置状态仍为独立查询与前端派生状态。

下一轮：继续按旧版逐模块对齐概览页。

---

### Iteration 5（概览五个子模块组件化）

目标：
- 确保概览页五个业务子模块均为职责独立、可单独迁移和测试的组件。

本轮变更：
- 保留独立的 `ProxyStatusCard`。
- 拆出 `OverviewChannelAccountsCard`、`OverviewExposedModelsCard`、`OverviewClientAccessCard`、`OverviewAgentAccessCard`。
- 新增无业务依赖的共享 `OverviewModuleCard`，只统一卡片标题和操作区。
- `OverviewSections` 降为纯页面布局组合，不再包含任一业务模块的内部实现。
- 每个业务模块的样式迁回对应 feature 目录，页面 CSS 只保留两行网格布局。

检查结果：
- `bun run check`：通过。
- `bun run test:new`：6 个测试文件 / 19 个测试通过。
- `bun run build:new`：通过；仅有已知 lottie-web direct eval 与大 chunk 警告。
- `bun run build`：通过；警告与新版构建一致。

数据结构影响：无；仅调整新前端组件边界。

下一轮：继续逐一对齐概览业务模块的旧版功能。

---

### Iteration 6（概览：客户端访问信息功能对齐）

目标：
- 恢复旧版概览中客户端访问信息模块的字段、复制行为和完整 API 接入详情。

本轮变更：
- 恢复 OpenAI Base URL、Anthropic Base URL、健康检查地址和默认客户端 Token 四项信息。
- 每一项均可点击复制；默认客户端 Token 按旧版复制为 `Bearer <token>`。
- “查看接入详情”恢复为当前页面的 API 详情侧栏，不再错误跳转到 Agent 接入页。
- 详情侧栏包含服务状态、OpenAI-compatible、Anthropic-compatible、鉴权 Header 与安全提示。
- 模块直接使用 `get_proxy_bind_config` 查询结果和真实代理运行状态，不引入硬编码业务数据。
- 为共享卡片操作入口补充明确的可访问名称，并新增客户端模块交互测试。

检查结果：
- `bun run check`：通过。
- `bun run test:new`：7 个测试文件 / 21 个测试通过。
- `bun run build:new`：通过；仅有已知 lottie-web direct eval 与大 chunk 警告。
- `bun run build`：通过；警告与新版构建一致。

数据结构影响：无；未修改 Rust、SQLite schema、config.json 或 Tauri command。

配置与重启影响：无；端口、监听地址和默认 Client Token 继续读取现有代理绑定配置。页面刷新查询即可反映配置，实际代理监听配置是否生效仍遵循既有运行时行为。

下一轮：继续逐一对齐概览业务模块的旧版功能。

---

### Iteration 7（概览：AI Agent 接入功能对齐）

目标：
- 恢复旧版概览的 AI Agent 两卡布局，并提供符合当前产品规则的完整接入说明。

本轮变更：
- 恢复 Claude Code CLI 与 OpenCode CLI 两个概览入口及命令行接入说明。
- 点击 Agent 卡片打开独立接入侧栏，不再只复制一个 Base URL。
- Claude Code 使用 Anthropic-compatible 地址，OpenCode 使用 OpenAI-compatible 地址。
- Base URL 与默认 Client Token 均来自概览页当前真实代理绑定配置。
- 支持逐项复制 Base URL、Client Token，以及一键复制完整环境变量配置。
- 未配置默认 Client Token 时展示占位值和明确引导，不伪造可用 Token。
- 所有复制操作继续使用已修复的 Semi Toast 提供成功或失败反馈。

检查结果：
- `bun run check`：通过。
- `bun run test:new`：8 个测试文件 / 23 个测试通过。
- `bun run build:new`：通过；仅有已知 lottie-web direct eval 与大 chunk 警告。
- `bun run build`：通过；警告与新版构建一致。

数据结构影响：无；未修改 Rust、SQLite schema、config.json 或 Tauri command。

配置与重启影响：无；接入信息随现有代理绑定配置查询结果刷新。Agent 环境变量修改后需重启对应 Agent 进程，不要求重启 Flowlet。

下一轮：继续逐一对齐概览业务模块或迁移独立 Agent 接入页。

---

### Iteration 8（概览：渠道账号功能对齐）

目标：
- 恢复旧版概览中渠道账号模块的账号统计、资源信息、品牌识别与操作入口。

本轮变更：
- 标题恢复“共 N 个账号”，并恢复“新增账号”“查看全部”两个操作入口。
- 使用 `@lobehub/icons` 的 LongCat、DeepSeek 品牌 SVG Logo。
- 新增 `latest_balance_snapshots` typed command 与 TanStack Query Hook，复用现有 Rust command 读取真实余额快照。
- LongCat 账号展示资源包剩余 Token 和有效期，按旧版规则格式化万/亿单位。
- 按量付费账号展示余额与币种；无快照时展示 `-`，不伪造资源数据。
- 恢复启用、停用、未配置、鉴权无效四类账号状态。
- 点击账号行或更多按钮直接进入对应账号编辑弹窗；新增入口自动打开新增弹窗；查看全部打开概览内账号管理抽屉。

检查结果：
- `bun run check`：通过。
- `bun run test:new`：9 个测试文件 / 25 个测试通过。
- `bun run build:new`：通过；仅有已知 lottie-web direct eval 与大 chunk 警告。
- `bun run build`：通过；警告与新版构建一致。

数据结构影响：无；仅在新前端补充现有 `AccountBalanceSnapshot` 的 TypeScript 类型，未修改 Rust、SQLite schema、config.json 或 Tauri command。

配置与重启影响：无；余额快照和账号列表均通过现有 command 查询，账号保存后的代理配置仍按既有逻辑热更新。

下一轮：继续逐一对齐概览开放模型模块。

---

### Iteration 9（渠道账号管理信息架构校正）

目标：
- 按旧版恢复“概览卡片 → 账号管理抽屉 → 账号编辑弹窗”的管理链路，取消独立渠道账号页面。

本轮变更：
- 移除新版 `/channels` 路由和 `pages/channels` 页面文件。
- 删除仅服务于独立页面的 `AccountList`、`AccountOnboarding`。
- 新增 `AccountManagementSideSheet`，支持搜索、资源摘要、启停、编辑、删除和新增账号。
- 概览卡片的新增、查看全部、账号行和更多按钮全部改为当前概览页内的抽屉状态。
- 无账号引导中的 LongCat、DeepSeek 添加入口直接打开对应渠道的新增账号弹窗。
- 修复编辑账号时“API Key 留空则不修改”实际可能清空旧 Key 的问题；前端保存编排会保留原密钥。
- 账号保存继续调用现有 `save_channel_accounts`，成功后刷新账号查询，代理配置按既有逻辑热更新。

检查结果：
- `bun run check`：通过。
- `bun run test:new`：10 个测试文件 / 26 个测试通过。
- `bun run build:new`：通过；仅有已知 lottie-web direct eval 警告。
- `bun run build`：通过；警告与新版构建一致。

数据结构影响：无；未修改 Rust、SQLite schema、config.json 或 Tauri command。

配置与重启影响：无；账号修改支持现有热更新，不需要重启 Flowlet。

---

### Iteration 10（账号编辑 UI/UX 与资源配置恢复）

目标：
- 恢复老版宽侧边账号编辑流程，移除账号管理抽屉上叠加窄 Modal 的错误交互。

本轮变更：
- “新增/编辑账号”改为独立右侧 `SideSheet`；进入编辑时账号列表抽屉暂时退出，关闭后按入口返回列表或概览。
- 恢复渠道卡片选择、账号名称计数、API Key 控制台入口、启用状态说明、资源模式、资源信息、高级设置和固定底栏。
- LongCat 等手动维护渠道支持 Token 资源包与按量付费信息；DeepSeek 等支持余额查询的渠道展示自动同步状态与刷新入口。
- 测试连接、保存账号和保存资源快照均接入现有 Tauri command；账号与资源保存使用一次完整的成功/失败反馈。
- 编辑账号继续支持 API Key 留空时保留原密钥。

数据结构影响：无；复用现有 `AccountBalanceSnapshot`、`save_balance_snapshot` 与 `query_balance`，未修改 Rust、SQLite schema 或 `config.json`。

配置与重启影响：账号与手动资源信息保存后立即刷新查询；代理账号配置继续热更新，不需要重启 Flowlet。

---

### Iteration 11（概览开放模型模块）

目标：
- 按老版恢复概览“开放模型”卡片的状态总览与快速启停能力。

本轮变更：
- 卡片标题展示真实已开放模型数量，不再只展示模型名代码标签。
- 按 `virtual_model_id` 聚合多账号、多协议候选路由，避免同一个对外模型重复展示。
- 每行恢复渠道品牌、对外模型名、可用账号数量、异常/不可用状态和启停开关。
- 模型开关一次更新该模型下的全部候选路由，并调用现有 `save_route_candidates` 立即保存。
- 保存采用乐观更新；失败时回滚模型列表并展示错误提示，成功后重新校验查询结果。
- “模型服务”继续作为 Semi Typography 链接入口，概览卡片不承载完整模型管理页面。

数据结构影响：无；复用现有 `RouteCandidate`、`ChannelAccount` 和 `ChannelPreset`，未修改 Rust、SQLite schema 或 `config.json`。

配置与重启影响：模型启停通过既有共享运行时配置热更新，无需重启代理或 Flowlet。

---

### Iteration 12（概览固定视口布局）

目标：
- 恢复老版概览页固定在应用可视区内、页面本身不出现纵向滚动条的布局。

本轮变更：
- 概览根容器占满 AppShell 内容区，使用 `auto auto minmax(0, 1fr)` 分配标题、代理状态与业务模块剩余空间。
- 页面模块间距由错误的 24px 恢复为老版 12px。
- 概览业务区使用“账号/模型行占据剩余高度，客户端/Agent 行按内容高度”的两行网格。
- `OverviewModuleCard` 增加统一的可收缩内容层，避免 Semi Card 内容按固有高度撑破网格。
- 账号和模型数量超出可用空间时，仅对应卡片列表内部滚动；应用概览主页面保持无滚动条。
- 小窗口单列断点继续回退为自然高度，避免窄窗口内容被裁切。

数据结构影响：无；纯前端布局调整。

配置与重启影响：无；前端热更新即可生效。

---

### Iteration 13（账号弹层闪烁修复）

目标：
- 消除概览“新增账号、编辑账号、查看全部”打开弹层时出现的错误中间帧与 WebView motion 闪烁。

本轮变更：
- 移除 `useEffect` 驱动的“请求 → 编辑器”二次状态切换，点击当次同步确定列表、新增或编辑弹层。
- 新增/编辑请求不再先渲染一帧账号管理 SideSheet。
- 账号编辑草稿改为组件挂载时同步初始化，不再先显示空内容或上一次账号数据。
- 不同账号编辑器使用稳定业务 key 独立挂载，避免复用旧表单状态。
- 账号相关 SideSheet 关闭 Semi motion，避免桌面 WebView 在遮罩与内容同帧挂载时闪烁；遮罩、Esc 和关闭按钮行为保持不变。
- 弹层按当前类型条件挂载，隐藏弹层不再残留 Portal DOM。

数据结构影响：无；纯前端状态与弹层生命周期调整。

配置与重启影响：无；前端热更新即可生效。

---

### Iteration 14（已配置 API Key 查看）

目标：
- 支持在账号编辑抽屉中查看当前真实配置的 API Key。

本轮变更：
- 编辑账号时不再主动清空 `list_channel_accounts` 返回的 API Key。
- API Key 默认继续以 Semi 密码框隐藏，用户点击眼睛按钮后才显示明文。
- 新增账号仍显示空密码框；概览卡片、账号管理列表、日志和错误提示仍不展示密钥。
- 保存、测试连接与“清空时保留原密钥”的既有保护逻辑保持不变。

数据结构影响：无；复用现有 `list_channel_accounts` 返回值，没有新增 Rust command 或 SQLite 字段。

配置与重启影响：无；纯前端编辑器行为调整。

---

### Iteration 15（LongCat 多资源包管理）

目标：
- 恢复老版 LongCat 多资源包查看、手动维护和 JSON 批量导入能力。

本轮变更：
- 账号编辑器不再把 Token 资源包降级为单个汇总包，恢复独立“管理资源包”入口。
- 新增 Semi 资源包管理弹窗，支持多个资源包新增、编辑、删除及完整列表保存。
- 支持导入 LongCat `/api/pay/quota/metering/token-packs/summary` 响应，合并 `currentLot` 与 `otherLots`，相同 `lotId` 自动覆盖。
- 资源包按最早到期时间排列，并按 ACTIVE 资源包计算总量、已消耗、剩余和最早到期汇总。
- 完整资源包数组继续写入现有余额快照 `token_packs` 字段，概览和账号列表继续读取现有汇总字段。
- 资源包 Modal 位于账号 SideSheet 上层并关闭 motion，避免层级错误和弹窗闪烁。

数据结构影响：无；复用现有 `AccountBalanceSnapshot.token_packs` JSON 字段及汇总字段。

配置与重启影响：保存快照后查询缓存自动刷新；无需重启代理或应用。

---

### Iteration 16（请求日志页面重构）

目标：
- 基于现有日志 command 完整重构请求日志列表、筛选、诊断详情和清理流程。

本轮变更：
- 新增请求日志领域 command 适配，覆盖分页列表、客户端筛选项、按请求 ID 加载详情和日志清理。
- 页面支持成功/失败、客户端、渠道和路径/请求 ID/错误信息服务端筛选，支持 10/25/50/100 条分页。
- 支持手动刷新和每 5 秒自动刷新；刷新保持当前筛选和页码。
- 列表仅加载最终尝试的轻量字段，集中展示请求路径、客户端、路由账号、模型映射、TTFB、总耗时和切换次数。
- 请求详情按需加载完整尝试链路，并按“概览 / 请求 / 响应”拆分 Headers 与 Body。
- 支持在多次尝试间切换，查看每次尝试对应的捕获内容和错误原因。
- Authorization、API Key、Cookie、Token、密码等敏感字段在前端渲染前统一遮蔽，错误文本中的凭据模式同样遮蔽。
- 日志清理提供保留 7/30/90 天或清理全部的二次确认，并同步失效日志与用量查询缓存。

数据结构影响：无；复用现有 `request_logs`、`usage_records` 和已注册 Tauri command。

配置与重启影响：无；日志筛选、详情和清理均实时生效，不需要重启代理。

---

### Iteration 17（全局视觉 tokens 与 1200×720 概览改版）

目标：
- 以 1200×720 设计稿为基准统一新前端视觉语言，并在固定窗口高度内完整呈现概览页。

本轮变更：
- 从参考稿提取冷灰背景、半透明 surface、低对比描边、双层卡片阴影、圆角、主色和成功色，统一沉淀到 `tokens.css` 并覆盖 Semi 语义变量。
- 应用壳层调整为 188px 侧栏、40px 顶部拖拽区和紧凑内容边距；现有五个菜单枚举、路由与功能保持不变。
- 删除侧栏左下重复的“服务运行中”模块，代理状态集中由概览页顶部服务卡展示。
- 顶部服务卡整合服务状态、监听地址、运行时长和启动/重启动作，保持现有代理生命周期调用链不变。
- 四个概览业务模块改为 2×2 固定高度网格，并统一数量 chip、链接操作、内嵌列表、复制字段和 Agent 支持状态样式。
- 针对 1200×720 压缩卡片内边距、列表行高与模块间距，概览页外层禁止滚动；超出模块容量的数据在模块内部滚动。

数据结构影响：无；仅调整 React 展示结构、可访问性属性和样式 tokens。

配置与重启影响：无；前端热更新即可生效，不需要重启代理。桌面窗口控件继续调用现有 Tauri window API。

---

### Iteration 18（概览、账号抽屉与日志加载体验修正）

目标：
- 修正概览数据语义和紧凑布局，统一 API 详情复制体验，并消除抽屉与日志页面的过渡冲突。

本轮变更：
- 开放模型的“可用账号”仅由账号启用、密钥与凭据健康状态决定，不再跟随模型对外开放开关变化。
- 抽取客户端访问复制字段组件，概览与 API 接入详情共享相同的地址展示、复制图标、整块点击和 Toast 反馈。
- 编辑账号时完全隐藏不可更改的渠道选择；新增与编辑账号的账号名称、API Key 改为一行两列。
- 对齐概览渠道账号头部的新增、管理链接，并提高账号管理、账号编辑及删除确认弹层层级，避免与窗口控件重叠。
- 请求日志取消路由级加载占位，页面直接挂载；数据加载继续由表格自身的局部 Loading 承担。

数据结构影响：无；仅调整前端派生数据、组件复用、布局和加载边界。

配置与重启影响：无；全部为前端热更新，不需要重启代理。

---

## 五、范围阻塞（必须由用户决定，Loop 不得自行推进）

| # | 阻塞项 | 类型 | 状态 |
|---|---|---|---|
| B1 | 是否新增 SQLite `clients` 表 + `list_clients`/`save_clients` Rust command，支撑完整的客户端 Token 管理（独立于 `default_client_token`） | 新增 Rust 能力 / schema | 待确认 |
| B2 | 删除旧前端、Mantine 与双版本入口 | 清理决策 | 已完成 |
| B3 | `save_balance_snapshot` 手动快照入口的 UI 是否保留 | 产品范围 | 已确认保留，并并入账号编辑抽屉 |

---

## 六、重构完成清单

1. ~~调用链盘点和迁移矩阵~~ ✅
2. ~~拆分 `src-new/styles/index.css`~~ ✅
3. ~~Tauri typed client 和 AppError~~ ✅
4. ~~Query key、Error Boundary、测试基座~~ ✅
5. ~~代理状态查询~~ ✅
6. ~~代理自动启动与 StrictMode 防重~~ ✅
7. ~~新版概览页~~ ✅
8. ~~渠道列表~~ ✅
9. ~~账号创建和编辑~~ ✅
10. ~~账号删除、连接测试、余额同步~~ ✅
11. ~~渠道模型同步~~ ✅
12. ~~开放模型~~ ✅
13. ~~配置状态 unconfigured / no_models / ready~~ ✅
14. ~~客户端访问配置~~ ✅
15. ~~Agent 接入~~ ✅
16. ~~请求日志列表和筛选~~ ✅
17. ~~请求日志详情~~ ✅
18. ~~用量与成本~~ ✅
19. ~~设置~~ ✅
20. 高级路由不进入普通用户界面，底层能力保留
21. ~~正式入口切换~~ ✅
22. ~~删除旧前端和 Mantine~~ ✅
23. ~~`src-new` 正式化为 `src`~~ ✅
