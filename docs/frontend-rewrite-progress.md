# Flowlet 前端重构进度（Progress）

本文档是 `src-new` 重构的唯一迭代状态源。每轮结束按「十八、进度汇报格式」记录。
每轮开始前必须重读本文件、`AGENTS.md`、`docs/frontend-rewrite.md`、`docs/config.md`、`docs/architecture.md`、`git status` 和当前分支最新代码。

---

## 当前状态

- 当前阶段：阶段 4 渠道与账号闭环已完成；下一轮进入阶段 5（开放模型）
- 已完成切片：调用链矩阵、CSS 拆分、typed client + AppError、query-key 工厂、ErrorBoundary、测试基座、代理领域 + 自动启动 + 概览页、渠道账号领域 + 渠道列表/账号编辑/删除/连接测试页
- 分支：`refactor/channel-account-model`
- 基座提交：`5975a00`
- `ui.version` 默认值：**legacy**（禁止未经用户确认改为 next）
- 旧前端保持可运行；新前端独立构建；双前端共用同一 Rust 后端与 SQLite

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
| `read_config` | `String` | bootstrap 仅读 `ui.version` | — | 无 | 原始 JSON |
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
| `OverviewPage` | `proxy_status`, `get_proxy_bind_config`, `list_channel_accounts`, `list_channel_presets`, `usage_summary`(仅展示状态，不展示统计值) | proxy、channel、account | `pages/overview/OverviewPage` | 待迁移（阶段 2/3） |
| `ChannelsPage` | `list_channel_presets`, `list_channel_accounts`, `save_channel_accounts`, `test_connection`, `sync_models`, `query_balance`, `latest_balance_snapshots` | channel、account、model、usage | `pages/channels/*` | 待迁移（阶段 4） |
| `RoutesPage` / 模型服务 | `list_route_candidates`, `save_route_candidates`, `list_channel_models`, `list_virtual_models`, `list_channel_accounts`, `list_channel_presets`, `read_app_meta`, `write_app_meta` | model、channel | `pages/models/*` | 待迁移（阶段 5） |
| `ClientsPage` | `list_clients`/`save_clients`(不存在), `get_proxy_bind_config`, `set_proxy_bind_config`(default_client_token) | client、settings | `pages/clients/*` 或合并 settings | 待迁移（阶段 6，**存疑/待确认**） |
| `ClaudeCodePage` / 代理接入 | `get_proxy_bind_config`, `list_virtual_models` | client、model | `pages/agents/*` | 待迁移（阶段 6） |
| `LogsPage` | `list_request_logs`, `list_request_log_clients`, `get_request_log_detail` | request-log、usage | `pages/logs/*` | 待迁移（阶段 7） |
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

## 五、范围阻塞（必须由用户决定，Loop 不得自行推进）

| # | 阻塞项 | 类型 | 状态 |
|---|---|---|---|
| B1 | 是否新增 SQLite `clients` 表 + `list_clients`/`save_clients` Rust command，支撑完整的客户端 Token 管理（独立于 `default_client_token`） | 新增 Rust 能力 / schema | 待确认 |
| B2 | 何时把 `ui.version` 默认值从 `legacy` 改为 `next`；何时删除旧 `src/` 与 Mantine | 切换决策 | 待用户批准 |
| B3 | `save_balance_snapshot` 手动快照入口的 UI 是否保留（当前由 `BalanceSnapshotEditor` 提供） | 产品范围 | 待确认 |

---

## 六、Loop 优先队列（与文档第十四节一致）

1. ~~调用链盘点和迁移矩阵~~ ✅
2. 拆分 `src-new/styles/index.css` ← 当前
3. Tauri typed client 和 AppError
4. Query key、Error Boundary、测试基座
5. 代理状态查询
6. 代理自动启动与 StrictMode 防重
7. 新版概览页
8. 渠道列表
9. 账号创建和编辑
10. 账号删除、连接测试、余额同步
11. 渠道模型同步
12. 开放模型
13. 配置状态 unconfigured / no_models / ready
14. 客户端访问配置
15. Agent 接入
16. 请求日志列表和筛选
17. 请求日志详情
18. 用量与成本
19. 设置
20. 高级路由
21. 新旧行为验收矩阵
22. Tauri、NSIS、便携版完整验收
23. 等待用户批准切换默认版本
