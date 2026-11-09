# Flowlet Tauri(Rust) → Electron(Node/TS) 迁移：命令面与 SQLite Schema 清点

> **性质**：只读勘察结论，作为重写排期与任务拆分的输入。
> **基线**：仓库当前工作区（`src-tauri/src/lib.rs` 中 `invoke_handler` 注册表为命令权威来源）。
> **范围**：`src-tauri/src/commands/*.rs`（约 5,049 行）、`src-tauri/src/mobile_commands.rs`、`src-tauri/src/lib.rs`、`src-tauri/src/core/storage*.rs`、`src-tauri/src/core/request_capture.rs`；不含代理转发协议细节、不含 `src-tauri/src/core/web/*` 的 HTTP 路由实现（仅在 §5.3 标注其命令白名单规模）。
> **方法**：静态解析 + 逐文件通读 + `grep` 统计；未运行 `cargo`/`npm` 构建，未修改 `src-tauri/` 与 `src/`。

## 0. 结论摘要

| 指标 | 数值 | 说明 |
|---|---|---|
| 桌面端 Tauri 命令 | **141** | `invoke_handler` 注册 141 条，定义于 `commands/` 9 个文件，全部经 `commands/mod.rs` 重导出 |
| 移动端 Tauri 命令 | **17** | `mobile_commands.rs`，`#[cfg(mobile)]` 独立注册，与桌面无编译重叠 |
| 命令注册总数 | **158** | 141 + 17（`generate_handler!` 两个列表） |
| 迁移难度 | A **34** / B **85** / C **15** / D **7** | A 纯逻辑/网络/文件、B SQLite、C 平台能力、D Tauri 专有 IPC（webview/事件/注入回调） |
| SQLite 表 | **25** | 全部在 `core/storage.rs::migrate()` 中 `CREATE TABLE IF NOT EXISTS` |
| 显式索引 | **19** | 含 1 个 UNIQUE；另有 122 个列由幂等 `ALTER TABLE ... ADD COLUMN` 补齐 |
| schema 版本机制 | **无 `PRAGMA user_version`** | 以 `app_meta.schema_version='2026.08.02'` + 幂等补列 + 一次性数据迁移标记实现 |
| 前端零字符串引用的命令 | **22** | 见 §3.10；其中 20 条纯零引用，另 2 条（`handle_scrape_interceptor_ready`/`handle_intercepted_response`）由注入页面 JS 调用 |
| 建议批次 | **10 批（桌面） + M1（移动端）** | 每批 7~18 条命令，排序见 §8 |
| 最大迁移风险 | 抓取控制台（D）与 Tauri webview IPC | 页面内注入 JS 直接调 `__TAURI_INTERNALS__.invoke`，Electron 需重做桥接模型 |

**三条必须写入架构决策的硬约束**

1. **SQLite schema 必须逐列兼容**：用户数据库是唯一需要无损继承的状态。Node 侧必须沿用同表名、同列名、同类型、同 JSON 列编码（serde JSON 字符串）与同 `app_meta` 键；否则无法直接打开旧库。
2. **前端调用契约必须保持稳定**：`invoke` 命令名、参数名（Tauri 默认把 Rust `snake_case` 参数映射为 JS `camelCase`）、返回字段命名风格（**snake_case 与 camelCase 混用**，见 §5.2）都不能变，前端 `src/domains/**` 因此几乎无需改动。
3. **代理进程生命周期属于 Node 主进程**：`start_proxy` 幂等、`stop_proxy` 幂等、关窗只隐藏、仅托盘「退出」停止代理 —— 这些是产品契约，不能因为换运行时退化。

## 1. 命令注册与分层事实

- 权威注册表：`src-tauri/src/lib.rs` 的 `generate_handler![...]`（桌面 800–942 行，移动 1036–1054 行）。
- `src-tauri/src/commands/mod.rs` 只做 9 个子模块 `pub(super) use ...::*` 重导出，因此注册路径统一为 `commands::<name>`；命令实现拆到 `account_workspace / agent / channels / device_sync / maintenance / observability / proxy / scrape / usage`。
- 桌面与移动是**两套独立状态**：桌面 `AppState`（持有 `FlowletServices`、抓取 webview map、托盘、LAN 状态、退出标记）vs 移动 `MobileAppState`（仅 `Storage + JobRuntime`）。移动端复用 `Storage` 与 `core/device_sync`、`core/lan_sync`。
- 另有一条**非 Tauri 宿主**：`src-tauri/src/bin/headless.rs`（axum Web Host），不经 `invoke_handler`，而是走 `core/web/commands.rs` 的**显式命令白名单（46 条命令，另有 host 专用 `web_connection_info` 与拒绝回退 `unsupported_in_web`）**。Node 迁移若同时覆盖 headless/Docker 形态，需要把该白名单一并实现为 HTTP 管理 API。
- 前端边界：`src/platform/tauri/client.ts::invokeCommand` 统一加超时与错误归一，`src/domains/*/commands.ts` 是唯一拼写命令名的位置（共 158 处 `invokeCommand` 调用）；Web Host 模式下自动改走 `src/platform/web/client.ts`。

## 2. 领域分布与热度

热度口径：`src/domains` 命令字面量引用数只能反映封装点（大多为 1），因此另取「该 domain 模块被 `src` 其余文件引用数」作为高频判据（`grep -rl domains/<m>`，已排除模块自身）。

| 实现文件 | 命令数 | 领域职责 | A | B | C | D | 对应前端 domain（外部引用文件数） |
|---|---|---|---|---|---|---|---|
| `channels.rs` | 9 | 渠道 / 账号 / 路由 / 模型配置 | 0 | 9 | 0 | 0 | channel (27) / model (27) |
| `proxy.rs` | 6 | 代理生命周期 | 3 | 1 | 2 | 0 | proxy (15) |
| `usage.rs` | 8 | 用量与费用 | 0 | 8 | 0 | 0 | usage (16) / data-repair (2) |
| `observability.rs` | 22 | 请求日志 / Agent 会话 / 后台任务 | 6 | 16 | 0 | 0 | request-log (7) / agent-session (11) / background-task (5) |
| `device_sync.rs` | 26 | 设备用量与跨设备同步 | 3 | 22 | 1 | 0 | device-sync (18) |
| `maintenance.rs` | 24 | 配置 / 元数据 / 存储维护 / 自启动 / 诊断 | 8 | 13 | 3 | 0 | settings (14) |
| `scrape.rs` | 24 | 模型目录 / 余额 / 预设同步 / 控制台抓取 | 6 | 11 | 0 | 7 | channel (27) / model (27) / cost-ledger (0) |
| `agent.rs` | 17 | Agent 接入 / 环境 / 全局配置 / Codex / Antigravity | 8 | 0 | 9 | 0 | agent (34) |
| `account_workspace.rs` | 5 | 账号工作区（S3 工作区同步） | 0 | 5 | 0 | 0 | account-workspace (2) |
| **合计** | **141** | — | **34** | **85** | **15** | **7** | — |

**领域迁移顺序建议（依赖方向）**

1. `proxy.rs` + `channels.rs` + `usage.rs` + `maintenance.rs`：产品核心闭环（服务能起、模型能配、用量能看、设置能存），也是其他领域的前置读取方。
2. `observability.rs`：日志/会话/任务，读为主，依赖 1 的表结构。
3. `device_sync.rs`：跨设备聚合，依赖 usage 聚合语义与 `known_devices` 表。
4. `scrape.rs`：模型目录/余额（可先行），控制台抓取（D，最后且可砍）。
5. `agent.rs`：Agent 接入读写本机文件，独立性强，但子进程/OAuth 属 C 类，跟随平台层批次。
6. `account_workspace.rs`：S3 工作区，低频，最后。

## 3. 桌面端命令清单（141）

> 「参数（JS 侧）」已按 Tauri 默认规则把 Rust `snake_case` 形参转为前端必须传的 `camelCase` 键名；`tauri::State`/`AppHandle`/`WebviewWindow` 注入参数不出现于 JS 调用。所有命令均无 `#[tauri::command(rename_all = ...)]` 覆盖。
> 返回类型为 Rust 声明；字段命名风格见 §5.2。错误统一为 `Result<T, String>`（`ipc_ping`/`get_app_version`/`get_app_data_dir`/`get_app_diagnostics`/`log_from_frontend` 例外，直接返回 JSON/字符串/void）。

### 3.1 `channels.rs` — 渠道 / 账号 / 路由 / 模型配置（9 条）

| # | 命令 | 参数（JS camelCase） | 返回类型 | 难度 | 热度 | 备注 |
|---|---|---|---|---|---|---|
| 1 | `list_channel_presets` | — | `Vec<ChannelPreset>` | B | 中 | 读运行时快照（DB 派生）；字段 snake_case。 |
| 2 | `save_channel_presets` | presets: ChannelPreset[] | `()` | B | 低 | 全量替换 channel_presets（DELETE+INSERT），前端当前未引用。 |
| 3 | `list_channel_accounts` | — | `Vec<ChannelAccount>` | B | 高 | 运行时快照；含 workspace 链接左连接，字段 snake_case。 |
| 4 | `save_channel_accounts` | accounts: ChannelAccount[] | `Vec<ChannelAccount>` | B | 高 | 全量替换 + 回读规范化结果 + 发布运行时 revision；S3 工作区开启时先 push。 |
| 5 | `list_route_candidates` | — | `Vec<RouteCandidate>` | B | 高 | 路由候选（模型服务页核心）。 |
| 6 | `save_route_candidates` | routes: RouteCandidate[] | `()` | B | 高 | 全量替换 virtual_model_routes。 |
| 7 | `list_channel_models` | — | `Vec<ChannelModel>` | B | 中 | 读 channel_models 目录（/models 拉取缓存）。 |
| 8 | `list_virtual_models` | — | `Vec<VirtualModel>` | B | 低 | 运行时快照；虚拟模型层已弱化。 |
| 9 | `save_virtual_models` | models: VirtualModel[] | `()` | B | 低 | 全量替换；前端当前未引用。 |

### 3.2 `proxy.rs` — 代理生命周期（6 条）

| # | 命令 | 参数（JS camelCase） | 返回类型 | 难度 | 热度 | 备注 |
|---|---|---|---|---|---|---|
| 1 | `start_proxy` | — | `()` | C | 高 | 代理监听生命周期 + 托盘 tooltip；Rust 侧幂等，Node 侧需等价保证。 |
| 2 | `stop_proxy` | — | `()` | C | 高 | 停止监听 + 托盘 tooltip。 |
| 3 | `proxy_status` | — | `ProxyStatus` | A | 高 | 纯内存状态；未运行时补 bind_addr。 |
| 4 | `test_connection` | channelId: string, apiKey: string, baseUrlOverride?: string, useUpstreamProxy?: boolean | `()` | A | 高 | 直接传连接参数（新账号未保存也可测），不读写账号表。 |
| 5 | `get_proxy_bind_config` | — | `ProxyBindConfig` | A | 高 | 内存 bind 配置（启动时从 app_meta 加载）。 |
| 6 | `set_proxy_bind_config` | config: ProxyBindConfig | `()` | B | 中 | 写 app_meta.proxy_bind_config + 更新运行时；结构 snake_case。 |

### 3.3 `usage.rs` — 用量与费用（8 条）

| # | 命令 | 参数（JS camelCase） | 返回类型 | 难度 | 热度 | 备注 |
|---|---|---|---|---|---|---|
| 1 | `analyze_usage` | — | `usize` | B | 低 | 一次性重解析捕获 + 未知用量 + 重算费用；前端未引用。 |
| 2 | `repair_agent_sessions` | timeRange: string | `AgentSessionRepairResult` | B | 低 | 按 ua_rules 重识别历史日志归属。 |
| 3 | `repair_captured_usage` | timeRange: string | `usize` | B | 中 | 重解析捕获文件 + 原生会话回填（spawn_blocking）。 |
| 4 | `repair_unknown_usage` | timeRange: string | `usize` | B | 中 | 补齐 usage_status=unknown 的用量行。 |
| 5 | `repair_usage_costs` | timeRange: string | `usize` | B | 中 | 按分时价格重算费用及分类列。 |
| 6 | `usage_summary` | startAt?: string, endAt?: string, groupBy: 'hour'（或 'day'） | `Vec<UsageSummaryRow>` | B | 高 | 校验时间/粒度后聚合；字段 snake_case。 |
| 7 | `agent_native_usage_summary` | — | `Vec<AgentNativeUsageSummaryRow>` | B | 中 | Agent 原生用量逐事件聚合（camelCase）。 |
| 8 | `usage_today_tokens` | — | `UsageTodaySummary` | B | 高 | 概览页今日 Token 单条聚合；字段 snake_case。 |

### 3.4 `observability.rs` — 请求日志 / Agent 会话 / 后台任务（22 条）

| # | 命令 | 参数（JS camelCase） | 返回类型 | 难度 | 热度 | 备注 |
|---|---|---|---|---|---|---|
| 1 | `list_request_logs` | filter: LogsFilter | `LogsPageResult` | B | 高 | 日志分页（snake_case 入参结构，camelCase 出参结果）。 |
| 2 | `list_agent_sessions` | filter: AgentSessionsFilter | `AgentSessionsPageResult` | B | 高 | 会话列表；合并 OpenCode 实时待确认权限后再过滤分页。 |
| 3 | `list_agent_session_children` | agentType: string, parentSessionId: string | `Vec<AgentSessionRow>` | B | 中 | 子会话。 |
| 4 | `list_opencode_session_permissions` | sessionId: string | `OpenCodePermissionReport` | A | 中 | 连本机 OpenCode 服务实时查询（网络，无 DB）。 |
| 5 | `reply_opencode_permission` | permissionId: string, decision: OpenCodePermissionDecision | `()` | A | 中 | 回复权限决策（decision 取 snake_case 枚举）。 |
| 6 | `get_agent_session_native_summary` | agentType: string, sessionId: string | `AgentSessionNativeSummary` | A | 中 | 解析 Agent 原生会话文件 + 目录价格估算费用。 |
| 7 | `get_agent_session_last_interaction` | agentType: string, sessionId: string | `Option<AgentSessionTimeline>` | A | 中 | 只返回最后一轮交互。 |
| 8 | `get_agent_session_timeline` | agentType: string, sessionId: string, startedAt?: string, endedAt?: string | `AgentSessionTimeline` | A | 高 | 完整原生会话时间线（可切片）；camelCase。 |
| 9 | `get_agent_session_flowlet_usage` | agentType: string, sessionId: string | `Option<AgentSessionFlowletUsage>` | B | 中 | 单会话 Flowlet 观测用量/费用（camelCase）。 |
| 10 | `sync_agent_data` | force: boolean, triggerSource: string | `AgentDataSyncResult` | B | 中 | 扫描 Agent 原生数据源并写快照；有 job 租约去重。 |
| 11 | `list_background_jobs` | filter: BackgroundJobsFilter | `BackgroundJobsPage` | B | 中 | 后台任务分页。 |
| 12 | `get_background_job_detail` | jobId: string | `BackgroundJobDetail` | B | 中 | 任务详情 + 事件流。 |
| 13 | `get_agent_sync_status` | — | `AgentSyncStatusReport` | B | 中 | 同步运行态 + 各数据源状态。 |
| 14 | `cancel_background_job` | jobId: string | `bool` | B | 低 | DB 标记 + 进程内取消。 |
| 15 | `cleanup_background_jobs` | keepDays: u32 | `CleanupBackgroundJobsResult` | B | 低 | 清理历史任务。 |
| 16 | `probe_cost_ledger_sources` | — | `CostLedgerSourceProbeResult` | B | 低 | 探测成本账本数据源可用性。 |
| 17 | `list_agent_session_clients` | — | `Vec<LogFilterClient>` | B | 中 | 会话客户端筛选项。 |
| 18 | `list_request_log_clients` | — | `Vec<LogFilterClient>` | B | 中 | 日志客户端筛选项。 |
| 19 | `list_request_log_models` | — | `RequestLogModelOptions` | B | 中 | 日志模型筛选项（camelCase）。 |
| 20 | `get_request_log_detail` | requestId: string | `Vec<RequestLogRow>` | B | 高 | 按 request_id 取全部 attempt。 |
| 21 | `get_log_capture_config` | — | `LogCaptureConfig` | A | 中 | 进程内捕获配置副本。 |
| 22 | `set_log_capture_config` | config: LogCaptureConfig | `()` | B | 中 | 写 app_meta.log_capture_config + 更新进程内。 |

### 3.5 `device_sync.rs` — 设备用量与跨设备同步（26 条）

| # | 命令 | 参数（JS camelCase） | 返回类型 | 难度 | 热度 | 备注 |
|---|---|---|---|---|---|---|
| 1 | `device_usage_snapshot` | — | `DeviceUsageSnapshot` | B | 中 | 生成本机设备用量快照（聚合 + 身份）。 |
| 2 | `list_known_devices` | — | `Vec<KnownDevice>` | B | 高 | 设备目录（本机 + 已导入）。 |
| 3 | `list_shared_devices` | — | `Vec<KnownDevice>` | B | 高 | 仅已导入的共享设备。 |
| 4 | `device_daily_usage` | deviceId?: string | `Vec<DailyUsageTotal>` | B | 高 | 本机日用量（含近实时合并）。 |
| 5 | `device_hourly_usage` | deviceId?: string | `Vec<HourlyUsageTotal>` | B | 高 | 本机小时用量。 |
| 6 | `shared_device_daily_usage` | deviceId?: string | `Vec<DailyUsageTotal>` | B | 高 | 共享设备日用量（DB 快照）。 |
| 7 | `shared_device_hourly_usage` | deviceId?: string | `Vec<HourlyUsageTotal>` | B | 中 | 共享设备小时用量。 |
| 8 | `list_shared_device_sessions` | deviceId?: string | `Vec<SharedAgentSession>` | B | 中 | 共享设备 Agent 会话快照。 |
| 9 | `refresh_shared_device` | deviceId: string | `DeviceRefreshResult` | B | 中 | 先 LAN 直连，失败回退该设备 S3 对象。 |
| 10 | `rename_current_device` | displayName: string | `()` | A | 中 | 写设备身份文件（非 DB）。 |
| 11 | `get_s3_sync_settings` | — | `S3SyncSettings` | B | 中 | 读 app_meta 中 S3 配置（脱敏视图，camelCase）。 |
| 12 | `export_s3_connection_config` | — | `S3SyncConfigInput` | B | 低 | 导出完整连接配置（含密钥，camelCase）。 |
| 13 | `save_s3_sync_config` | config: S3SyncConfigInput | `S3SyncSettings` | B | 中 | 校验并写 app_meta。 |
| 14 | `test_s3_sync_connection` | config: S3SyncConfigInput | `S3ConnectionTestResult` | A | 中 | 只做网络探测，不落库。 |
| 15 | `test_s3_read_connection` | config: S3SyncConfigInput | `S3ConnectionTestResult` | A | 中 | 只做读权限探测。 |
| 16 | `sync_device_usage_s3` | — | `S3DeviceSyncResult` | B | 中 | 发布本机快照并拉取远端（S3 + background_jobs）。 |
| 17 | `recover_current_device_sync` | — | `S3ConnectionTestResult` | B | 低 | 修复当前设备远端同步状态。 |
| 18 | `refresh_shared_device_usage_s3` | — | `S3DevicePullResult` | B | 中 | 强制 S3 pull。 |
| 19 | `list_remote_opencode_permissions` | deviceId: string, sessionId: string | `OpenCodePermissionReport` | B | 中 | 经 LAN 向远端设备查询权限（网络 + 已知设备）。 |
| 20 | `reply_remote_opencode_permission` | deviceId: string, permissionId: string, decision: OpenCodePermissionDecision | `()` | B | 中 | 经 LAN 转发权限决策。 |
| 21 | `refresh_shared_device_usage_lan` | deviceId?: string | `LanRefreshResult` | B | 中 | LAN 直连刷新已知 peers。 |
| 22 | `lan_server_status` | — | `LanServerReport` | C | 中 | 读取进程内 LAN 服务状态与最近入站事件。 |
| 23 | `probe_lan_peers` | deviceId?: string | `Vec<LanPeerProbe>` | B | 中 | UDP/TCP 探测 + 写 app_meta 缓存。 |
| 24 | `export_device_usage_bundle` | path: string | `()` | B | 低 | 生成 4MB 上限的用量 bundle 文件（原子替换）。 |
| 25 | `preview_device_usage_import` | path: string | `DeviceUsageImportPreview` | B | 低 | 读 bundle 预览导入差异。 |
| 26 | `import_device_usage_bundle` | path: string | `DeviceUsageImportResult` | B | 低 | 导入设备/日/小时/会话/资源/breakdown。 |

### 3.6 `maintenance.rs` — 配置 / 元数据 / 存储维护 / 自启动 / 诊断（24 条）

| # | 命令 | 参数（JS camelCase） | 返回类型 | 难度 | 热度 | 备注 |
|---|---|---|---|---|---|---|
| 1 | `read_app_meta` | key: string | `Option<String>` | B | 中 | app_meta 键值读。 |
| 2 | `write_app_meta` | key: string, value: string | `()` | B | 中 | app_meta 键值写（设置页）。 |
| 3 | `db_stats` | — | `(i64,i64,i64)` | B | 低 | 返回 (日志数, 用量行数, DB 字节)；元组序列化为 JSON 数组。 |
| 4 | `storage_usage_summary` | scanId: string | `StorageUsageSummary` | B | 中 | 存储占用扫描；经 AppHandle emit('storage-usage-progress') 推进度。 |
| 5 | `compact_database` | — | `DatabaseCompactionResult` | B | 中 | VACUUM + auto_vacuum=INCREMENTAL；要求代理已停止。 |
| 6 | `read_config` | — | `String` | A | 高 | 读 config.json 原文（缺失报错）。 |
| 7 | `write_config` | content: string | `()` | A | 高 | 校验顶层为对象/数组后写 config.json；不触发运行时热加载。 |
| 8 | `get_upstream_proxy_config` | — | `UpstreamProxyConfig` | A | 中 | 进程内全局上游代理配置；字段 snake_case。 |
| 9 | `set_upstream_proxy_config` | config: UpstreamProxyConfig | `()` | B | 中 | 写 app_meta + 尽力同步 config.json + 更新进程内全局。 |
| 10 | `ipc_ping` | — | `serde_json::Value` | A | 低 | 返回 {ok,pid,exe}；联调探针。 |
| 11 | `log_from_frontend` | level: string, message: string | `void` | A | 低 | 前端日志转 tracing。 |
| 12 | `cleanup_old_logs` | keepDays: i64 | `(usize,usize)` | B | 中 | 按天清理日志/用量，返回两表清理行数（元组）。 |
| 13 | `cleanup_expired_body_data` | retentionDays: i64 | `usize` | B | 中 | 清理过期请求/响应 Body。 |
| 14 | `prune_oldest_body_data` | targetBytes: i64, pruneRatio: f64 | `usize` | B | 低 | 按体积裁剪最老 Body；前端未引用（定时任务调用）。 |
| 15 | `get_total_body_size_bytes` | — | `i64` | B | 低 | Body 总占用。 |
| 16 | `export_config` | — | `String` | B | 低 | 导出 ConfigBundle JSON（渠道/账号/路由/规则/价格/虚拟模型）。 |
| 17 | `import_config` | json: string | `()` | B | 低 | 覆盖导入并刷新运行时快照；前端未引用。 |
| 18 | `account_routing_scores` | — | `Vec<(String,String,f64,f64,f64)>` | B | 低 | 账号路由评分；元组数组（Web Host 白名单内）。 |
| 19 | `is_autostart_enabled` | — | `bool` | C | 中 | tauri-plugin-autostart（注册表 / LaunchAgent）。 |
| 20 | `enable_autostart` | — | `()` | C | 中 | 注册开机自启（带 --hidden）。 |
| 21 | `disable_autostart` | — | `()` | C | 中 | 取消开机自启。 |
| 22 | `get_app_version` | — | `String` | A | 高 | 编译期 CARGO_PKG_VERSION。 |
| 23 | `get_app_data_dir` | — | `String` | A | 中 | exe 同级目录（便携/安装统一）。 |
| 24 | `get_app_diagnostics` | — | `serde_json::Value` | A | 中 | {os,database,proxy} 诊断摘要。 |

### 3.7 `scrape.rs` — 模型目录 / 余额 / 预设同步 / 控制台抓取（24 条）

| # | 命令 | 参数（JS camelCase） | 返回类型 | 难度 | 热度 | 备注 |
|---|---|---|---|---|---|---|
| 1 | `sync_models_cn_catalog` | sourceUrl: string, triggerSource: string | `CatalogSyncResult` | B | 高 | 拉 models-cn 并写文件 + background_jobs。 |
| 2 | `sync_models_dev_catalog` | sourceUrl: string, triggerSource: string | `CatalogSyncResult` | B | 中 | 拉 models.dev provider 目录。 |
| 3 | `get_models_cn_catalog` | — | `Option<String>` | A | 高 | 读本地 models-cn.json 原文。 |
| 4 | `get_models_dev_provider_catalog` | providerId: string | `Option<String>` | A | 中 | 从本地 models.dev 抽取单 provider 子集（避免整包过 IPC）。 |
| 5 | `get_models_cn_currencies` | — | `Vec<(String,String)>` | A | 中 | model id → currency 映射（元组数组）。 |
| 6 | `preview_sync_channel_presets` | — | `PresetSyncPreview` | B | 中 | 对比 config.json 与 DB 预设差异 + 追加暴露模型预览。 |
| 7 | `apply_sync_channel_presets` | — | `()` | B | 中 | 按 config.json 同步预设并补默认路由。 |
| 8 | `query_balance` | accountId: string | `BalanceQueryResult` | A | 高 | 按渠道能力查询官方余额（网络；snake_case 结果）。 |
| 9 | `fetch_channel_models` | channelId: string, apiKey: string, baseUrlOverride?: string, useUpstreamProxy?: boolean | `ModelSyncResult` | B | 高 | 用连接参数拉 /models，成功后替换 channel_models 目录。 |
| 10 | `save_balance_snapshot` | snapshot: AccountBalanceSnapshot | `()` | B | 中 | 写余额快照（token_packs/raw 为 JSON 文本）。 |
| 11 | `list_balance_snapshots` | accountId: string | `Vec<AccountBalanceSnapshot>` | B | 低 | 单账号历史快照。 |
| 12 | `latest_balance_snapshots` | — | `Vec<AccountBalanceSnapshot>` | B | 高 | 每账号最新快照。 |
| 13 | `account_stats` | — | `Vec<AccountStatsRow>` | B | 低 | 账号维度统计；前端未引用。 |
| 14 | `list_route_rules` | — | `Vec<RouteRule>` | B | 低 | 运行时快照中的高级规则；前端未引用。 |
| 15 | `save_route_rules` | rules: RouteRule[] | `()` | B | 低 | 全量替换 route_rules。 |
| 16 | `open_scrape_console` | accountId: string | `()` | D | 中 | 创建 per-account 隐藏 WebviewWindow（独立 data_directory）+ 注入拦截器。 |
| 17 | `close_scrape_console` | accountId: string | `()` | D | 中 | 关闭抓取 webview。 |
| 18 | `handle_scrape_interceptor_ready` | channelId: string, documentId: string, pageUrl: string | `()` | D | 中 | 由注入页面 JS 经 __TAURI_INTERNALS__.invoke 回调；带 WebviewWindow 参数。 |
| 19 | `handle_intercepted_response` | channelId: string, url: string, body: string | `()` | D | 中 | 页面 JS 回传拦截响应 → AppState.scrape_pending。 |
| 20 | `probe_scrape_login` | accountId: string, interactive?: boolean | `ScrapeLoginStatus` | D | 中 | 驱动 webview 导航/拦截判定登录态（含交互式登录窗口）。 |
| 21 | `scrape_balance` | accountId: string, interactive?: boolean | `ScrapeBalanceResult` | D | 中 | 单账号控制台抓取余额/资源包。 |
| 22 | `sync_scrape_balances` | triggerSource: string | `ScrapeBalanceSyncResult` | D | 中 | 批量抓取（后台/手动），跳过交互中账号。 |
| 23 | `list_custom_scrape_channels` | — | `Vec<CustomScrapeChannelInfo>` | A | 中 | 扫描自定义渠道抓取目录（camelCase）。 |
| 24 | `reload_custom_scrape_registry` | — | `Vec<CustomScrapeChannelInfo>` | A | 低 | 重新加载 registry 文件。 |

### 3.8 `agent.rs` — Agent 接入 / 环境 / 全局配置 / Codex / Antigravity（17 条）

| # | 命令 | 参数（JS camelCase） | 返回类型 | 难度 | 热度 | 备注 |
|---|---|---|---|---|---|---|
| 1 | `list_agent_capabilities` | — | `AgentCapabilitiesReport` | A | 高 | 由 plugin-registry.json + 编译期 Bundle 双重校验后输出（camelCase）。 |
| 2 | `detect_agent_environment` | agentId: string | `AgentEnvironmentReport` | C | 高 | 探测安装/版本/运行态：PATH 扫描 + 子进程 + 本机进程。 |
| 3 | `start_agent_runtime` | agentId: string | `AgentEnvironmentReport` | C | 高 | 由 Flowlet 启动 Agent Web Runtime 子进程。 |
| 4 | `stop_agent_runtime` | agentId: string | `AgentEnvironmentReport` | C | 中 | 停止受管子进程。 |
| 5 | `check_agent_latest_versions` | — | `AgentLatestVersionsReport` | A | 中 | npm registry HTTP 查询。 |
| 6 | `query_codex_accounts` | — | `CodexAccountsReport` | C | 高 | 发现 Codex 账号：启动 `codex app-server` 子进程读 RPC。 |
| 7 | `list_cached_codex_accounts` | — | `CodexAccountsReport` | A | 中 | 只读托管目录缓存（不启动进程）。 |
| 8 | `sync_codex_accounts` | triggerSource: string | `CodexAccountSyncResult` | C | 中 | 子进程同步 + 写 DB + background_jobs 租约。 |
| 9 | `authorize_codex_account` | — | `CodexAccountReport` | C | 中 | OAuth：opener 打开授权页 + 本机回环回调 + app-server。 |
| 10 | `query_codex_account` | accountId: string | `CodexAccountReport` | C | 中 | 刷新单账号用量（子进程）。 |
| 11 | `delete_codex_account` | accountId: string | `CodexAccountDeletionResult` | A | 低 | 删除托管凭据副本与快照（文件）。 |
| 12 | `inspect_agent_global_config` | agentId: string | `AgentGlobalConfigReport` | A | 高 | 读取/对比 Agent 全局配置（文件解析，报告 snake_case）。 |
| 13 | `apply_agent_global_config` | agentId: string, options?: AgentGlobalConfigOptions | `AgentGlobalConfigReport` | A | 高 | 原子写入 + 备份；含 Codex model-catalog 动态生成、DSH Profile/MCP；options 为 camelCase。 |
| 14 | `restore_agent_global_config` | agentId: string | `AgentGlobalConfigReport` | A | 中 | 按备份完整还原。 |
| 15 | `query_antigravity_accounts` | — | `AntigravityAccountsReport` | C | 中 | 发现本机 Antigravity language server：进程/端口探测 + 本地 HTTP。 |
| 16 | `authorize_antigravity_account` | — | `AntigravityAccountReport` | C | 低 | Google OAuth（打开浏览器 + 回调 + 托管凭据）。 |
| 17 | `delete_antigravity_account` | accountId: string | `()` | A | 低 | 删除托管 OAuth 账号文件。 |

### 3.9 `account_workspace.rs` — 账号工作区（S3 工作区同步）（5 条）

| # | 命令 | 参数（JS camelCase） | 返回类型 | 难度 | 热度 | 备注 |
|---|---|---|---|---|---|---|
| 1 | `get_account_workspace_status` | — | `AccountWorkspaceStatus` | B | 低 | 读 app_meta 工作区状态。 |
| 2 | `initialize_account_workspace` | — | `AccountWorkspaceSyncResult` | B | 低 | 首次创建工作区（S3 网络 + storage）。 |
| 3 | `sync_account_workspace` | — | `AccountWorkspaceSyncResult` | B | 低 | 双向同步（S3 + background_jobs）。 |
| 4 | `export_desktop_account_workspace` | — | `DesktopAccountWorkspacePackage` | B | 低 | 导出本机工作区包。 |
| 5 | `import_desktop_account_workspace` | package: DesktopAccountWorkspacePackage | `AccountWorkspaceSyncResult` | B | 低 | 导入后立即同步；package 为 camelCase 结构。 |

### 3.10 前端零引用的命令（22 条 = 20 条纯零引用 + 2 条注入 JS 回调）

`src/` 全量字符串计数为 0 的 20 条：`save_channel_presets`、`save_virtual_models`、`list_virtual_models`、`list_route_rules`、`save_route_rules`、`list_balance_snapshots`、`analyze_usage`、`account_stats`、`account_routing_scores`、`export_config`、`import_config`、`db_stats`、`list_background_jobs`、`get_background_job_detail`、`cancel_background_job`、`cleanup_background_jobs`、`prune_oldest_body_data`、`get_total_body_size_bytes`、`ipc_ping`、`log_from_frontend`。

另外 `handle_scrape_interceptor_ready` / `handle_intercepted_response` 在 `src/` 中同样为 0，但它们由 `core/scrape_console.rs` 注入页面的 JS 通过 `globalThis.__TAURI_INTERNALS__.invoke('handle_scrape_interceptor_ready', ...)` 直接调用（见 `core/scrape_console.rs:246`），**不是死代码**；`ipc_ping`/`account_routing_scores`/`list_virtual_models`/`save_virtual_models` 仍在 Web Host 白名单内。

剔除建议：`save_channel_presets`、`save_route_rules`、`list_route_rules`、`analyze_usage`、`account_stats`、`db_stats`、`export_config`/`import_config`、`prune_oldest_body_data`、`get_total_body_size_bytes`、`log_from_frontend` 在「v1 桌面迁移」可判定为内部/维护能力，优先由定时任务与设置页直连替代，不必 1:1 移植。

## 4. 移动端命令（`mobile_commands.rs`，17 条）

计数：A **1** / B **16** / C **0** / D **0**。移动端与桌面端**语义重叠但不共享实现**：同名命令（如 `list_shared_devices`、`refresh_shared_device`、`probe_lan_peers`）在两侧各有实现，桌面走 `AppState`，移动走 `MobileAppState`。

| # | 命令 | 参数（JS camelCase） | 返回类型 | 难度 | 备注 |
|---|---|---|---|---|---|
| 1 | `list_shared_devices` | — | `Vec<KnownDevice>` | B | 仅已导入共享设备目录。 |
| 2 | `list_shared_account_resources` | — | `Vec<SyncedAccountResource>` | B | 设备发布的账号资源观测。 |
| 3 | `list_shared_device_agents` | deviceId: string | `Vec<SyncedAgentProfile>` | B | 指定设备的 Agent 资料。 |
| 4 | `shared_device_daily_usage` | deviceId?: string | `Vec<DailyUsageTotal>` | B | 共享设备日用量。 |
| 5 | `shared_device_hourly_usage` | deviceId?: string | `Vec<HourlyUsageTotal>` | B | 共享设备小时用量。 |
| 6 | `list_shared_device_sessions` | deviceId?: string | `Vec<SharedAgentSession>` | B | 共享设备会话快照。 |
| 7 | `get_s3_sync_settings` | — | `S3SyncSettings` | B | 读 S3 配置（脱敏视图）。 |
| 8 | `save_s3_sync_config` | config: S3SyncConfigInput | `S3SyncSettings` | B | 保存 S3 配置。 |
| 9 | `test_s3_read_connection` | config: S3SyncConfigInput | `S3ConnectionTestResult` | A | 只做读权限探测（无 DB）。 |
| 10 | `refresh_shared_device_usage_s3` | — | `S3DevicePullResult` | B | 手动刷新：LAN 优先的 pull。 |
| 11 | `list_cached_lan_probes` | — | `Vec<LanPeerProbe>` | B | 读 app_meta 中 LAN 探测缓存。 |
| 12 | `list_remote_opencode_permissions` | deviceId: string, sessionId: string | `OpenCodePermissionReport` | B | 远端设备权限查询。 |
| 13 | `reply_remote_opencode_permission` | deviceId: string, permissionId: string, decision: OpenCodePermissionDecision | `()` | B | 远端权限决策。 |
| 14 | `refresh_shared_device_usage_lan` | deviceId?: string | `LanRefreshResult` | B | LAN 直连刷新。 |
| 15 | `refresh_shared_device` | deviceId: string | `DeviceRefreshResult` | B | LAN 优先、S3 回退刷新单设备。 |
| 16 | `refresh_shared_device_session_lan` | deviceId: string, agentType: string, sessionId: string | `SyncedAgentSession` | B | 直连拉取单会话并 upsert。 |
| 17 | `probe_lan_peers` | deviceId?: string | `Vec<LanPeerProbe>` | B | LAN peer 探测。 |

**决策项**：Electron 不覆盖 iOS/Android。移动端命令**不进入本次迁移范围**，建议保留 Tauri 移动壳或后续独立立项；本次只需保证共享层（`Storage` schema、`device_sync`/`lan_sync` 协议）不被破坏。

## 5. 前端调用契约（迁移必读）

### 5.1 参数命名：一律 camelCase

所有 141 条桌面命令的形参都是 Rust `snake_case`，且没有任何命令使用 `#[tauri::command(rename_all = "snake_case")]`。Tauri v2 默认把命令参数名转为 **camelCase** 传给 Rust，因此前端现在的调用形如：

```ts
invokeCommand("save_s3_sync_config", { config })
invokeCommand("usage_summary", { startAt, endAt, groupBy })
invokeCommand("test_connection", { channelId, apiKey, baseUrlOverride, useUpstreamProxy })
invokeCommand("repair_captured_usage", { timeRange: "all" })
```

Node/Electron 侧 IPC 适配层**必须保持同名同键**（camelCase）才能让 `src/domains/**` 零改动迁移；这也是最小化前端回归的抓手。

### 5.2 返回字段：snake_case 与 camelCase 混用（最容易踩坑）

Rust 结构体的 serde 属性决定 IPC JSON 字段风格。核心配置类型全部 **snake_case**（无 `rename_all`），而较新的观测/同步类型用 **camelCase**。TS 类型定义必须逐一对照，不能全局假定。

| 风格 | 典型类型（均为命令返回/入参） |
|---|---|
| `snake_case`（serde 默认） | `ChannelPreset`、`ChannelAccount`、`ChannelModel`、`VirtualModel`、`RouteCandidate`、`RouteRule`、`AccountBalanceSnapshot`、`RequestLogRow`、`LogsFilter`(入参)、`UsageSummaryRow`、`UsageTodaySummary`、`AccountStatsRow`、`ProxyBindConfig`、`LogCaptureConfig`、`AgentSessionsFilter`(入参)、`BackgroundJobsFilter`(入参)、`AgentGlobalConfigReport`、`AgentEnvironmentReport`、`AgentLatestVersionsReport`、`CodexAccountReport(s)`、`AntigravityAccountReport(s)`、`BalanceQueryResult`、`ModelSyncResult`、`UpstreamProxyConfig`（显式 `rename_all="snake_case"`） |
| `camelCase` | `LogsPageResult`、`RequestLogModelOptions`、`AgentSessionsPageResult`、`AgentSessionRow`、`AgentSessionTimeline`（及其事件/用量嵌套）、`AgentNativeUsageSummaryRow`、`StorageUsageSummary`、`DatabaseCompactionResult`、`BackgroundJobsPage`/`Row`/`Detail`、`CatalogSyncResult`、`AgentDataSyncResult`、`AgentSyncStatusReport`、`CleanupBackgroundJobsResult`、`S3SyncConfigInput`/`Settings`/`ConnectionTestResult`/`DeviceSyncResult`/`DevicePullResult`、`DeviceRefreshResult`、`LanServerReport`/`LanPeerProbe`/`LanRefreshResult`、`CostLedgerSourceProbeResult`、`CustomScrapeChannelInfo`、`CodexAccountSyncResult`/`CodexAccountDeletionResult`、`AgentCapabilitiesReport`、`AccountWorkspaceStatus`/`DesktopAccountWorkspacePackage`/`AccountWorkspaceSyncResult`、`DeviceUsageSnapshot`/`DailyUsageTotal`/`HourlyUsageTotal`/`KnownDevice`/`SharedAgentSession`/`SyncedAccountResource`/`SyncedAgentProfile`/`SyncedAgentSession`/`DeviceUsageImportPreview`/`DeviceUsageImportResult`、`OpenCodePermissionReport`、`AgentGlobalConfigOptions`(入参) |

还有两类特例：

- **元组直接返回**：`db_stats` → `[logs, usage, fileBytes]`；`cleanup_old_logs` → `[logs, usage]`；`account_routing_scores` → `[[channelId, accountId, ...5 元组]]`；`get_models_cn_currencies` → `[[modelId, currency]]`。Node 侧返回数组即可，不要包成对象。
- **枚举值**：`ProtocolType` 无 `rename_all`（Rust 变体序列化为 `OpenAi`/`Anthropic`/`Responses` 的原样字符串）；`RequestType`/`AuthStrategy`/`ScrapeProbeState`/`OpenCodePermissionDecision` 为 `snake_case`（如 `openai`、`bearer`、`login_required`）。已发布路由里存的是 `openai`/`anthropic`/`responses` 小写值，Node 侧写入前必须用同一套归一逻辑。

### 5.2b 返回类型定义位置（全部 `derive(Serialize)`，无一处返回裸 `serde_json::Value` 以外的自定义序列化）

| 定义文件 | 类型 | 命名风格 |
|---|---|---|
| `core/config.rs` | `ChannelPreset`、`ChannelAccount`、`ChannelModel`、`VirtualModel`、`RouteCandidate`、`RouteRule`、`AccountBalanceSnapshot`、`RequestLogRow`、`LogsFilter`、`LogsPageResult`、`RequestLogModelOptions`、`LogFilterClient`、`UsageSummaryRow`、`UsageTodaySummary`、`AccountStatsRow`、`AgentSessionsFilter`、`AgentSessionRow`、`AgentSessionsPageResult`、`AgentSessionTimeline`、`AgentSessionNativeSummary`、`AgentSessionFlowletUsage`、`AgentSessionRepairResult`、`ProxyBindConfig`、`LogCaptureConfig` | 混用：配置/行结构 snake_case，PageResult/Timeline 等 camelCase |
| `core/proxy.rs` | `ProxyStatus` | 默认 snake_case |
| `core/storage_stats.rs` / `core/storage_maintenance.rs` | `StorageUsageSummary` / `DatabaseCompactionResult` | camelCase |
| `core/storage_tasks.rs` | `BackgroundJobsFilter`(snake) / `BackgroundJobsPage`、`BackgroundJobRow`、`BackgroundJobDetail`、`CatalogSyncResult`、`AgentDataSyncResult`、`AgentSyncStatusReport`、`CleanupBackgroundJobsResult`（均 camelCase） | 混用 |
| `core/device_identity.rs` | `KnownDevice`、`DailyUsageTotal`、`HourlyUsageTotal`、`DeviceUsageSnapshot`、`DeviceUsageImportPreview/Result`、`SharedAgentSession`、`SyncedAccountResource/Profile/Session` | camelCase |
| `core/device_sync.rs` | `S3SyncConfigInput`、`S3SyncSettings`、`S3ConnectionTestResult`、`S3DeviceSyncResult`、`S3DevicePullResult`、`DeviceRefreshResult` | camelCase |
| `core/lan_sync.rs` | `LanServerReport`、`LanPeerProbe`、`LanRefreshResult` | camelCase |
| `core/codex_account.rs` / `core/antigravity_account.rs` | `CodexAccountsReport`、`CodexAccountReport`（snake）/ `CodexAccountSyncResult`、`CodexAccountDeletionResult`（camelCase）/ `AntigravityAccount(s)Report`（snake） | 混用 |
| `core/agent_*.rs` | `AgentCapabilitiesReport`（camel）、`AgentEnvironmentReport`/`AgentLatestVersionsReport`（snake）、`AgentGlobalConfigReport`（snake）/`AgentGlobalConfigOptions`（camel 入参）、`OpenCodePermissionReport`（camel）/`OpenCodePermissionDecision`（snake 枚举） | 混用 |
| `core/account_workspace_sync.rs` | `AccountWorkspaceStatus`、`AccountWorkspaceSyncResult`、`DesktopAccountWorkspacePackage` | camelCase |
| `core/presets.rs` / `core/upstream_proxy.rs` / `core/cost_ledger_source_probe.rs` / `core/custom_scrape.rs` | `BalanceQueryResult`、`ModelSyncResult`（snake）/ `UpstreamProxyConfig`（显式 snake_case）/ `CostLedgerSourceProbeResult`、`CustomScrapeChannelInfo`（camel） | 混用 |

> 迁移时不要按文件推断命名风格（同一文件内也可能混用），以结构体上的 `#[serde(rename_all = ...)]` 为准；本表与 §5.2 均来自逐结构体属性核对。

### 5.3 事件、注入回调与 Web Host 白名单

**Rust → 前端事件（3 个，Electron 需等价 `webContents.send` + preload 转发）**

| 事件 | 发送位置 | 载荷 | 前端监听 |
|---|---|---|---|
| `agent-source-changed` | `core/agent_source_watcher.rs`（notify 文件监听，750ms 去抖） | `{ agentType }` | `src/features/background-tasks/AgentDataAutoSync.tsx` |
| `storage-usage-progress` | `commands/maintenance.rs::storage_usage_summary` | `{ scanId, summary }` | `src/features/settings/useStorageUsage.ts` |
| `mobile-device-sync-updated` | `lib.rs::run_mobile`（移动端定时任务） | `{ completedAt, s3ImportedDevices, s3FailedObjects, s3Error, lanProbeCount }` | `src/features/device-sync/useMobileDeviceSync.ts` |

**页面注入 JS → 命令（D 类，Tauri 专有）**：`core/scrape_console.rs` 向抓取用 WebviewWindow 注入脚本，脚本内 `globalThis.__TAURI_INTERNALS__.invoke('handle_scrape_interceptor_ready' | 'handle_intercepted_response', ...)` 直接回调 Rust。Electron 等价物只能是 `webContents.executeJavaScript` + `ipcRenderer`/`contextBridge` 或 `session.webRequest`/`debugger` 网络拦截，**不能靠 1:1 命令移植**。

**Web Host（headless / Docker）命令白名单**：`core/web/commands.rs::dispatch` 显式放行 46 条命令（`list_channel_presets`、`save_channel_accounts`、`start_proxy`、`list_request_logs`、`usage_summary`…），另有 `web_connection_info` 与拒绝回退 `unsupported_in_web`；管理凭据（`FLOWLET_ADMIN_TOKEN`）与模型调用凭据（client token）分离鉴权。若 Electron 版仍要出 Docker Host，这 46 条需要一组 HTTP 路由而非 IPC。

## 6. SQLite 现状（Node 必须逐列兼容）

### 6.1 连接与文件位置

| 项 | 现状 | Node 侧要求 |
|---|---|---|
| 桌面 DB 路径 | `<exe 目录>/flowlet.sqlite`（`lib.rs::app_database_path`；旧版从 cwd 复制 `flowlet.sqlite` + `-wal`/`-shm`） | Electron `app.getPath` 旁的便携语义需显式实现；便携版 = exe 同目录 |
| Headless DB 路径 | `FLOWLET_DB_PATH`，默认 `flowlet-data/flowlet.sqlite` | 保持同名 env |
| 移动 DB 路径 | `app_data_dir/flowlet-mobile.sqlite` | 不在本次范围 |
| 连接模型 | 单连接 `Arc<Mutex<Connection>>`，全进程串行 | Node 用 `better-sqlite3`（同步）最接近；不要改成连接池 |
| PRAGMA | `journal_mode=WAL`、`foreign_keys=ON`、新库 `auto_vacuum=INCREMENTAL`；导入时临时 `journal_mode=DELETE` + `wal_checkpoint(TRUNCATE)` | 必须一致，否则并发/清理行为改变 |
| 备份/导入 | `VACUUM INTO` 不保证使用；实际用 `rusqlite::backup` 到目标路径 + `PRAGMA quick_check` 后 rename 替换 | Node 需 `db.backup()` 或同语义替换流程 |

### 6.2 表清单（25 张）

| # | 表 | 用途 | 关键列（JSON 列已标注） | 主键/约束 |
|---|---|---|---|---|
| 1 | `channel_presets` | 渠道模板 / 能力声明 | supported_protocols(JSON 数组)、openai/anthropic base url + auth、default/small model、timeout、supports_* 标志、enabled、platform_url | id TEXT PK |
| 2 | `channel_accounts` | 渠道账号（API Key 与资源模式） | api_key、management_key、priority、resource_mode、resource_sync_mode、base_url_override、anthropic_base_url_override、last_used_at/error、credential_status、synced_models(JSON)、models_synced_at、exposed_models(JSON)、use_upstream_proxy | id TEXT PK |
| 3 | `channel_account_workspace_links` | 本机账号 ↔ 云端 workspace 账号映射 | local_account_id PK、workspace_account_id（UNIQUE）、linked_at/updated_at | local_account_id PK；workspace_account_id UNIQUE |
| 4 | `channel_account_workspace_defaults` | workspace 账号默认 Base URL | workspace_account_id PK、openai_base_url、anthropic_base_url、updated_at | workspace_account_id PK |
| 5 | `channel_models` | 上游 /models 拉取目录 | model、display_name、supported_protocols(JSON)、context_window、max_output_tokens、pricing_json(JSON)、supports_stream、source、synced_at | id TEXT PK |
| 6 | `virtual_models` | 虚拟模型层（已弱化） | name UNIQUE、protocol_type、routing_strategy、enabled；历史聚合行已由迁移删除 | id TEXT PK；name UNIQUE |
| 7 | `virtual_model_routes` | 路由候选（模型 ↔ 渠道/账号/上游名/协议/优先级） | virtual_model_id、channel_id、account_id、upstream_model、client_protocol、priority、enabled | id TEXT PK |
| 8 | `route_rules` | 高级路由规则 | match_client_id/match_model/match_protocol → target_channel_id/target_account_id/target_upstream_model | id TEXT PK |
| 9 | `account_balance_snapshots` | 账号余额 / 资源包快照 | balance、currency、token_pack_*、token_packs(JSON)、raw_scraped_json(原始 payload)、source、synced_at | id TEXT PK |
| 10 | `request_logs` | 请求尝试日志（含捕获详情） | request_id、agent/session、client/channel/account 名称、协议、virtual/public/upstream model、status、latency/ttfb/ttft/duration、attempt_seq、is_last_attempt、req/res_headers_json(JSON)、req/res_body_b64(base64 TEXT)、清理标记 | id TEXT PK；FK 由 capture_refs 反向引用 |
| 11 | `usage_records` | Token 用量与费用（按 attempt 行） | input/cached/uncached/cache_write/output/total tokens、usage_status、usage_source、estimated_cost + 分类费用列、analyzed_at | id TEXT PK |
| 12 | `request_capture_refs` | 外部捕获帧指针（与 request_logs 1:1） | storage_key、offset、length、checksum、format_version、state(默认 pending)、failure_reason、req/res_body_bytes、finalized_at；FK→request_logs ON DELETE CASCADE | request_log_id PK；FK request_logs CASCADE |
| 13 | `app_meta` | 键值元数据（schema 版本 / JSON 配置 / 修复标记） | key PK、value TEXT、updated_at | key PK |
| 14 | `known_devices` | 设备目录（本机 + 导入） | device_id PK、device_created_at、display_name、platform、app_version、timezone_offset_minutes、first/last_seen_at | device_id PK |
| 15 | `device_daily_usage` | 设备日聚合（导入快照） | PK(device_id, usage_date)、request_count、known/input/cached/uncached/measured/output tokens、unknown_count、estimated_cost、native_* 列 | PK(device_id, usage_date)；FK known_devices CASCADE |
| 16 | `device_hourly_usage` | 设备小时聚合（导入快照） | PK(device_id, usage_hour)、同上 + native_event_count/native_* 明细 | PK(device_id, usage_hour)；FK known_devices CASCADE |
| 17 | `device_agent_sessions` | 设备 Agent 会话快照 | PK(device_id, agent_type, session_id)、runtime_status、activity_at、session_json(JSON)、snapshot_generated_at | PK(device_id, agent_type, session_id)；FK CASCADE |
| 18 | `device_agent_profiles` | 设备 Agent 资料快照 | PK(device_id, agent_id)、profile_json(JSON) | PK(device_id, agent_id)；FK CASCADE |
| 19 | `device_account_resources` | 设备账号资源观测 | PK(device_id, account_id)、resource_json(JSON)、observed_at | PK(device_id, account_id)；FK CASCADE |
| 20 | `device_usage_breakdowns` | 跨设备维度用量聚合 | PK(device_id, breakdown_date, client_id, channel_id, account_id, upstream_model)、各 token 列、estimated_cost_currency、native_event_count、elapsed/generation 指标 | PK(device_id, breakdown_date, client_id, channel_id, account_id, upstream_model) |
| 21 | `agent_session_snapshots` | 本机 Agent 会话快照（增量扫描游标） | PK(agent_type, session_id)、fingerprint、summary_json(JSON)、session_json(JSON)、source_offset、parser_version、usage_ids_json(JSON)、cursor_guard、synced_at | PK(agent_type, session_id) |
| 22 | `agent_usage_events` | Agent 原生逐事件用量账本 | PK(agent_type, session_id, event_id)、event_time、model、input/cached/cache_write/output/reasoning/total tokens | PK(agent_type, session_id, event_id) |
| 23 | `agent_source_sync_state` | Agent 数据源同步状态 | agent_type PK、last_checked/synced_at、status、last_error、scanned/changed/failed_count | agent_type PK |
| 24 | `background_jobs` | 后台任务主表 | job_type、title、trigger_source、status、stage、progress_current/total、summary_json(JSON)、error_message、时间戳 | id TEXT PK |
| 25 | `background_job_events` | 后台任务事件流 | job_id、sequence、level、stage、message、detail_json(JSON) | id TEXT PK |

**迁移中被删除的表（旧库升级时会遇到）**：`projects`、`project_tasks`、`recurring_tasks`、`recurring_task_runs`、`device_projects`（项目管理能力 2026-10 移除，`drop_project_management_schema` 先关外键再按子→父顺序 DROP）；`request_logs.stream_summary` 列被 `ALTER TABLE ... DROP COLUMN` 删除（要求 SQLite ≥ 3.35）。Node 侧若只建新库不需要处理，**但复用旧库时必须先跑同一套清理逻辑**，否则 UI 与查询会看到孤儿数据。

### 6.3 索引（19 个）

| # | 索引 | 类型 | 定义 |
|---|---|---|---|
| 1 | `idx_channel_account_workspace_links_workspace` | UNIQUE | `channel_account_workspace_links(workspace_account_id)` |
| 2 | `idx_request_logs_created_at` | 普通 | `request_logs(created_at DESC)` |
| 3 | `idx_request_logs_request_id` | 普通 | `request_logs(request_id)` |
| 4 | `idx_request_logs_is_last_attempt` | 普通 | `request_logs(is_last_attempt)` |
| 5 | `idx_request_logs_usage_summary` | 普通 | `request_logs(request_id, is_last_attempt, created_at)` |
| 6 | `idx_request_logs_page` | 普通 | `request_logs(is_last_attempt, created_at DESC)` |
| 7 | `idx_request_logs_client` | 普通 | `request_logs(client_id)` |
| 8 | `idx_request_logs_account` | 普通 | `request_logs(account_id, created_at)` |
| 9 | `idx_request_logs_agent_session` | 普通 | `request_logs(agent_type, agent_session_id, created_at DESC)` |
| 10 | `idx_request_logs_session_cover` | 覆盖索引 | `request_logs(is_last_attempt, agent_type, agent_session_id, created_at DESC, request_id, parent_agent_session_id, client_id, client_name, status, error_message)` |
| 11 | `idx_usage_records_request_id` | 普通 | `usage_records(request_id)` |
| 12 | `idx_usage_records_created_at` | 普通 | `usage_records(created_at)` |
| 13 | `idx_usage_channel_upstream_model` | 普通 | `usage_records(channel_id, upstream_model)` |
| 14 | `idx_request_capture_refs_state` | 普通 | `request_capture_refs(state, updated_at)` |
| 15 | `idx_device_agent_sessions_activity` | 普通 | `device_agent_sessions(device_id, activity_at DESC)` |
| 16 | `idx_device_account_resources_latest` | 普通 | `device_account_resources(account_id, observed_at DESC)` |
| 17 | `idx_agent_usage_events_time` | 普通 | `agent_usage_events(event_time)` |
| 18 | `idx_background_jobs_created_at` | 普通 | `background_jobs(created_at DESC)` |
| 19 | `idx_background_job_events_job` | 普通 | `background_job_events(job_id, sequence)` |

这些索引是 `list_request_logs` / `account_stats` / `usage_summary` / `recalculate_usage_costs` / `cleanup_old_logs` 的性能前提（2026-07-04 专项）。Node 侧建库脚本必须原样复制，**少一个就可能让 43k+ 行日志表的页面查询从毫秒级退化到秒级**。

### 6.4 版本与迁移策略（**没有 `PRAGMA user_version`**）

现状是「幂等 DDL + 开关式数据迁移」，启动时每次执行，靠结构探测避免重复：

1. `CREATE TABLE IF NOT EXISTS` / `CREATE [UNIQUE] INDEX IF NOT EXISTS` 全量执行。
2. `add_column_if_missing(table, column, definition)`：先查 `pragma_table_info`，缺列才 `ALTER TABLE ADD COLUMN`（共 122 列，分布见 §6.5）。
3. 结构重引用列重建：`normalize_legacy_virtual_model_routes_schema` 在旧库检测到 `provider_name`/`provider_id` 时，`RENAME → CREATE → INSERT…SELECT → DROP` 重建 `virtual_model_routes`。
4. 一次性数据迁移与修复：
   - `app_meta.schema_version = '2026.08.02'`（每次启动 UPSERT，仅作标记/排查用，**不用于分支判断**）。
   - `model_ownership_cost_repair_v1`、`time_schedule_cost_repair_v1`：值为 `'done'` 时跳过历史费用重算。
   - `migrate_legacy_aggregate_routes` / `remove_legacy_aggregate_virtual_models`：把 `flowlet-pro`/`flowlet-flash` 路由按 `upstream_model` 归一并去重重排，删除旧聚合虚拟模型行（幂等）。
   - 启动时清理：90 天前完成的 `background_job_events`/`background_jobs`；把 `queued/running` 任务改为 `interrupted`（应用重启）。
   - 数据归一：LongCat → `resource_mode='hybrid'`；Qwen Token Plan/按量 → `resource_sync_mode='auto'`；Z.AI → `auto`；`openai-api` 的 `auto` → `manual`；`anthropic_base_url_override` 首次补列时从 `base_url_override` 复制。
   - `usage_status`/`usage_source` 首次补列时按 token 列推断 / 标记 `legacy`。

**Node 侧硬要求**：

- 必须保留上述 `app_meta` 键与 `'done'` 语义，否则每次启动都会重算历史费用（大库上非常慢）。
- `schema_version` 值建议照写 `2026.08.02` 或升级为新版本，但**不要**改为 `PRAGMA user_version` 单一机制后忘记执行列补齐 —— 旧库会缺列而查询失败。
- 迁移必须包在事务内（重建表迁移已是事务）；失败时不能留下半迁移库。
- 启动迁移顺序：建表/索引 → 补列 → 重建表 → 数据归一 → 一次性修复 → 清理过期任务。

### 6.5 通过 `ALTER TABLE ADD COLUMN` 补出的列（122 个）

| 表 | 补列数 | 列 |
|---|---|---|
| `request_logs` | 40 | request_id、agent_type/agent_session_id/parent_agent_session_id、client/channel/account 的 id+name、client/upstream_protocol、virtual/public/upstream_model、request_type/method/path/status/latency_ms/is_stream/error_message/fallback_count/route_reason、created_at、upstream_proxy_used、ttfb_ms/ttft_ms/duration_ms/upstream_url、attempt_seq、req_headers_json、req_body_b64+清理标记、res_headers_json、res_body_b64+清理标记、is_last_attempt |
| `usage_records` | 26 | request_id、client/channel/account id+name、协议、模型、全部 token 列、usage_status、usage_source、estimated_cost + 4 个分类费用列、analyzed_at、created_at |
| `device_hourly_usage` | 13 | input/cached/measured/output/unknown、estimated_cost、native_event_count、native_input/cached_input/cache_write_input/output/reasoning/total tokens |
| `channel_accounts` | 10 | credential_status、management_key、base_url_override、use_upstream_proxy、anthropic_base_url_override、resource_mode、resource_sync_mode、synced_models、models_synced_at、exposed_models |
| `virtual_model_routes` | 9 | virtual_model_id、channel_id、account_id、upstream_model、client_protocol、priority、enabled、created_at、updated_at |
| `channel_presets` | 8 | openai_auth、anthropic_auth、small_model、timeout_seconds、platform_url、supports_scrape_balance、supports_files_api、enabled |
| `agent_session_snapshots` | 5 | session_json、source_offset、parser_version、usage_ids_json、cursor_guard |
| `known_devices` | 4 | display_name、platform、app_version、profile_generated_at |
| `device_usage_breakdowns` | 2 | estimated_cost_currency、native_event_count |
| `account_balance_snapshots` | 2 | token_packs、raw_scraped_json |
| `channel_models` | 1 | pricing_json |
| `background_jobs` | 1 | cancel_requested |
| `device_daily_usage` | 1 | estimated_cost |
| **合计** | **122** | — |

### 6.6 JSON 列清单（存的是 serde 序列化字符串，不是 SQLite JSONB）

| 列 | 内容 | 编码 |
|---|---|---|
| `channel_presets.supported_protocols` | `Vec<ProtocolType>` JSON 数组（值 `openai`/`anthropic`/`responses`） | serde_json::to_string |
| `channel_models.supported_protocols` | 同上 | serde_json::to_string |
| `channel_models.pricing_json` | 上游 `/models` 返回的原始价格对象（任意 JSON） | `serde_json::Value::to_string` |
| `channel_accounts.synced_models` | `Option<Vec<String>>`（最近一次 `/models` 原始 ID） | serde_json |
| `channel_accounts.exposed_models` | `Option<Vec<String>>`（用户勾选的上游原始 ID；`null` 表示未用新流程配置） | serde_json |
| `account_balance_snapshots.token_packs` | `Option<Vec<...>>` 多资源包原始数据 | serde_json |
| `account_balance_snapshots.raw_scraped_json` | 控制台抓取完整 payload（用于调试/重解析） | 原始文本 |
| `request_logs.req_headers_json / res_headers_json` | header 名值对 JSON 文本（脱敏受 config 控制） | serde_json |
| `request_logs.req_body_b64 / res_body_b64` | **base64 字符串**（历史兼容列；新数据优先走外部捕获帧，这两列可能为 NULL） | base64 文本 |
| `device_agent_sessions.session_json` | `SyncedAgentSession` 整体 | serde_json |
| `device_agent_profiles.profile_json` | `SyncedAgentProfile` 整体 | serde_json |
| `device_account_resources.resource_json` | `SyncedAccountResource` 整体 | serde_json |
| `agent_session_snapshots.summary_json` | `AgentSessionNativeSummary` 整体 | serde_json |
| `agent_session_snapshots.session_json` | 会话对象整体 | serde_json |
| `agent_session_snapshots.usage_ids_json` | `Vec<String>` 已归属用量 ID | serde_json |
| `agent_source_sync_state / device_*` | 无 JSON 列（纯标量） | — |
| `background_jobs.summary_json` | 任务摘要（任意 JSON） | serde_json |
| `background_job_events.detail_json` | 事件明细（任意 JSON） | serde_json |
| `app_meta.value` | **多键均为 JSON 文本**：`proxy_bind_config`、`log_capture_config`、`upstream_proxy_config`、`device_sync_s3_config_v1`、`device_sync_s3_status_v1`、`device_sync_s3_current_etag_v1`、`device_sync_s3_remote_etags_v1`、`device_lan_descriptor_v1`、`device_lan_peers_v1`、`mobile_lan_probe_cache_v1`、`account_workspace_etag_v1`、`schema_version`(纯文本)、`model_ownership_cost_repair_v1`/`time_schedule_cost_repair_v1`(纯文本 `done`) | serde_json / 纯文本 |

**风险点**：`exposed_models` 三种状态（`NULL` / `[]` / 非空数组）语义完全不同（NULL=保持旧路由不动；空数组=严格对账到零路由），Node 侧读写时必须用 `Option<Vec<String>>` 等价语义，不能把 `NULL` 读成 `[]`。

### 6.7 请求/响应体：SQLite 之外的外部捕获文件（容易漏掉的一半）

请求详情并非都存在 SQLite。`core/request_capture.rs` 把每次 attempt 的完整记录写成**自定义帧文件**，SQLite 只存指针（`request_capture_refs`）：

| 项 | 值 |
|---|---|
| 根目录 | `<DB 所在目录>/.<DB 文件名>-request-captures`（如 `.flowlet.sqlite-request-captures`） |
| 分段文件 | `<相对目录>/000000.flcap` 递增，单段上限 32 MiB（`DEFAULT_SEGMENT_BYTES`） |
| 帧格式 | magic `FLCAP001` + u16 `format_version=1` + u16 flags + u64 compressed_len + u64 raw_len + sha256(32B) + zstd(level 3) payload；固定头 60 字节 |
| 指针列 | `request_capture_refs.storage_key / frame_offset / frame_length / checksum / format_version / state / req_body_bytes / res_body_bytes` |
| 压缩整理 | 段可重写：新段 `compacted-<uuid>.flcap`，写完后才删旧段（崩溃只留孤儿） |
| 清理 | 清理时先删帧再置 `req_body_cleared_at`/`res_body_cleared_at`；`request_logs` 删除经 FK 级联 |

**Node 侧要求**：要么原样实现该帧格式（zstd + sha256 + 60B 头），要么迁移时一次性把帧解包进新存储；**不能只迁 SQLite**，否则旧请求详情全部不可读。zstd 在 Node 有原生实现（`zstd-napi`/`@mongodb-js/zstd`）。

## 7. 迁移难度分级（A/B/C/D）

| 级别 | 定义 | 数量 | 占比 | 迁移策略 |
|---|---|---|---|---|
| **A** | 纯逻辑 / 纯网络 / 纯文件 IO：不碰 SQLite，不依赖 Tauri 窗口/托盘/webview/事件 | 34 | 24.1% | 直接 TS 重写（`fetch`/`undici`、`node:fs`、`node:path`、`node:crypto`），可先做、可单测 |
| **B** | 依赖 SQLite 查询/写入（含 `app_meta` JSON 读写与后台任务表） | 85 | 60.3% | 跟随统一 `Storage` 数据访问层重写；优先保证 SQL 与 schema 逐字对齐 |
| **C** | 依赖平台能力：托盘、自启动、窗口、子进程、系统凭据、文件监听、本机服务生命周期 | 15 | 10.6% | 用 Electron 主进程能力替换（`Tray`/`auto-launch`/`BrowserWindow`/`child_process`/`safeStorage`/`chokidar`/`http server`），需先定壳 |
| **D** | 依赖 Tauri 专有 IPC：webview 窗口 + 注入 JS + `__TAURI_INTERNALS__.invoke` 回调、`emit` 事件 | 7 | 5.0% | 需重新设计抓取架构（`session.webRequest`/`debugger`/隐藏 `BrowserWindow` + preload bridge），风险最高，建议 v1 砍掉或降级为手动余额 |

> D 类只有 7 条命令，但背后是 `scrape.rs` 约 2,400 行 webview 驱动逻辑（注入脚本、拦截器就绪握手、slot 引擎、交互式登录窗口）。**不要按命令数低估**。

**分级判定依据（可复核）**：命令体内出现 `storage.`/`state.storage` → 至少 B；出现 `AppHandle`/`WebviewWindow`/`tray`/`autostart`/`Command::new`/`notify`/`opener`/`emit(` → C/D；`request_capture`/`jobs` 等进程内运行时单独标注。C/D 判定另读了 `core/agent_environment`、`core/codex_account`、`core/antigravity_account`、`core/scrape_console` 的调用链。

## 8. 批次建议（桌面 10 批，每批 7~18 条）

### 批次 1 — A · 基础通道与状态（16 条；A16/B0/C0/D0）

**排序理由**：建立 Electron IPC 适配层、`app_meta` 读取、config 文件、诊断/版本/能力清单。这批几乎不依赖 DB 与壳，用来先跑通「前端零改动 + Node 后端」的最短链路，验证 invoke 契约与 camelCase 参数。

| 命令 | 文件 | 难度 | 热度 |
|---|---|---|---|
| `proxy_status` | `proxy.rs` | A | 高 |
| `get_proxy_bind_config` | `proxy.rs` | A | 高 |
| `get_log_capture_config` | `observability.rs` | A | 中 |
| `read_config` | `maintenance.rs` | A | 高 |
| `write_config` | `maintenance.rs` | A | 高 |
| `get_upstream_proxy_config` | `maintenance.rs` | A | 中 |
| `ipc_ping` | `maintenance.rs` | A | 低 |
| `log_from_frontend` | `maintenance.rs` | A | 低 |
| `get_app_version` | `maintenance.rs` | A | 高 |
| `get_app_data_dir` | `maintenance.rs` | A | 中 |
| `get_app_diagnostics` | `maintenance.rs` | A | 中 |
| `list_custom_scrape_channels` | `scrape.rs` | A | 中 |
| `reload_custom_scrape_registry` | `scrape.rs` | A | 低 |
| `list_agent_capabilities` | `agent.rs` | A | 高 |
| `check_agent_latest_versions` | `agent.rs` | A | 中 |
| `inspect_agent_global_config` | `agent.rs` | A | 高 |

### 批次 2 — A · 网络探测 / 目录读取 / 原生会话（18 条；A18/B0/C0/D0）

**排序理由**：上游连接测试、S3 探测、模型目录读取、Agent 原生会话解析、Agent 全局配置写入。全部是纯网络/文件，是渠道页与接入抽屉的高频路径。

| 命令 | 文件 | 难度 | 热度 |
|---|---|---|---|
| `test_connection` | `proxy.rs` | A | 高 |
| `list_opencode_session_permissions` | `observability.rs` | A | 中 |
| `reply_opencode_permission` | `observability.rs` | A | 中 |
| `get_agent_session_native_summary` | `observability.rs` | A | 中 |
| `get_agent_session_last_interaction` | `observability.rs` | A | 中 |
| `get_agent_session_timeline` | `observability.rs` | A | 高 |
| `rename_current_device` | `device_sync.rs` | A | 中 |
| `test_s3_sync_connection` | `device_sync.rs` | A | 中 |
| `test_s3_read_connection` | `device_sync.rs` | A | 中 |
| `get_models_cn_catalog` | `scrape.rs` | A | 高 |
| `get_models_dev_provider_catalog` | `scrape.rs` | A | 中 |
| `get_models_cn_currencies` | `scrape.rs` | A | 中 |
| `query_balance` | `scrape.rs` | A | 高 |
| `list_cached_codex_accounts` | `agent.rs` | A | 中 |
| `delete_codex_account` | `agent.rs` | A | 低 |
| `apply_agent_global_config` | `agent.rs` | A | 高 |
| `restore_agent_global_config` | `agent.rs` | A | 中 |
| `delete_antigravity_account` | `agent.rs` | A | 低 |

### 批次 3 — B · 核心配置 CRUD（14 条；A0/B14/C0/D0）

**排序理由**：渠道预设/账号/路由/虚拟模型/路由规则/`app_meta`/bind 配置。**这是整库的读写主干**，必须与旧 schema 列级对齐；`save_channel_accounts` 还带运行时 revision 与 S3 push 语义，是回归重点。

| 命令 | 文件 | 难度 | 热度 |
|---|---|---|---|
| `list_channel_presets` | `channels.rs` | B | 中 |
| `save_channel_presets` | `channels.rs` | B | 低 |
| `list_channel_accounts` | `channels.rs` | B | 高 |
| `save_channel_accounts` | `channels.rs` | B | 高 |
| `list_route_candidates` | `channels.rs` | B | 高 |
| `save_route_candidates` | `channels.rs` | B | 高 |
| `list_channel_models` | `channels.rs` | B | 中 |
| `list_virtual_models` | `channels.rs` | B | 低 |
| `save_virtual_models` | `channels.rs` | B | 低 |
| `set_proxy_bind_config` | `proxy.rs` | B | 中 |
| `read_app_meta` | `maintenance.rs` | B | 中 |
| `write_app_meta` | `maintenance.rs` | B | 中 |
| `list_route_rules` | `scrape.rs` | B | 低 |
| `save_route_rules` | `scrape.rs` | B | 低 |

### 批次 4 — B · 用量与费用（13 条；A0/B13/C0/D0）

**排序理由**：用量聚合、今日 Token、余额快照、修复/重算、日志捕获配置。用量表结构与口径先稳定，后续设备聚合与概览页才有统一数据源。

| 命令 | 文件 | 难度 | 热度 |
|---|---|---|---|
| `analyze_usage` | `usage.rs` | B | 低 |
| `repair_agent_sessions` | `usage.rs` | B | 低 |
| `repair_captured_usage` | `usage.rs` | B | 中 |
| `repair_unknown_usage` | `usage.rs` | B | 中 |
| `repair_usage_costs` | `usage.rs` | B | 中 |
| `usage_summary` | `usage.rs` | B | 高 |
| `agent_native_usage_summary` | `usage.rs` | B | 中 |
| `usage_today_tokens` | `usage.rs` | B | 高 |
| `set_log_capture_config` | `observability.rs` | B | 中 |
| `save_balance_snapshot` | `scrape.rs` | B | 中 |
| `list_balance_snapshots` | `scrape.rs` | B | 低 |
| `latest_balance_snapshots` | `scrape.rs` | B | 高 |
| `account_stats` | `scrape.rs` | B | 低 |

### 批次 5 — B · 请求日志 / 会话 / 后台任务（15 条；A0/B15/C0/D0）

**排序理由**：日志分页与详情、Agent 会话列表/子会话/Flowlet 用量、后台任务与同步状态。依赖第 3、4 批的表与索引。

| 命令 | 文件 | 难度 | 热度 |
|---|---|---|---|
| `list_request_logs` | `observability.rs` | B | 高 |
| `list_agent_sessions` | `observability.rs` | B | 高 |
| `list_agent_session_children` | `observability.rs` | B | 中 |
| `get_agent_session_flowlet_usage` | `observability.rs` | B | 中 |
| `sync_agent_data` | `observability.rs` | B | 中 |
| `list_background_jobs` | `observability.rs` | B | 中 |
| `get_background_job_detail` | `observability.rs` | B | 中 |
| `get_agent_sync_status` | `observability.rs` | B | 中 |
| `cancel_background_job` | `observability.rs` | B | 低 |
| `cleanup_background_jobs` | `observability.rs` | B | 低 |
| `probe_cost_ledger_sources` | `observability.rs` | B | 低 |
| `list_agent_session_clients` | `observability.rs` | B | 中 |
| `list_request_log_clients` | `observability.rs` | B | 中 |
| `list_request_log_models` | `observability.rs` | B | 中 |
| `get_request_log_detail` | `observability.rs` | B | 高 |

### 批次 6 — B · 设备用量与共享设备（14 条；A0/B14/C0/D0）

**排序理由**：设备目录、日/小时聚合、共享会话、bundle 导入导出、远端权限。依赖第 4 批的用量语义与第 5 批的会话结构。

| 命令 | 文件 | 难度 | 热度 |
|---|---|---|---|
| `device_usage_snapshot` | `device_sync.rs` | B | 中 |
| `list_known_devices` | `device_sync.rs` | B | 高 |
| `list_shared_devices` | `device_sync.rs` | B | 高 |
| `device_daily_usage` | `device_sync.rs` | B | 高 |
| `device_hourly_usage` | `device_sync.rs` | B | 高 |
| `shared_device_daily_usage` | `device_sync.rs` | B | 高 |
| `shared_device_hourly_usage` | `device_sync.rs` | B | 中 |
| `list_shared_device_sessions` | `device_sync.rs` | B | 中 |
| `refresh_shared_device` | `device_sync.rs` | B | 中 |
| `list_remote_opencode_permissions` | `device_sync.rs` | B | 中 |
| `reply_remote_opencode_permission` | `device_sync.rs` | B | 中 |
| `export_device_usage_bundle` | `device_sync.rs` | B | 低 |
| `preview_device_usage_import` | `device_sync.rs` | B | 低 |
| `import_device_usage_bundle` | `device_sync.rs` | B | 低 |

### 批次 7 — B · S3/LAN 同步 + 账号工作区（13 条；A0/B13/C0/D0）

**排序理由**：S3 设置/发布/拉取、LAN 探测与刷新、S3 工作区。跨设备同步是设备链路最后一块，放在设备聚合之后。

| 命令 | 文件 | 难度 | 热度 |
|---|---|---|---|
| `get_s3_sync_settings` | `device_sync.rs` | B | 中 |
| `export_s3_connection_config` | `device_sync.rs` | B | 低 |
| `save_s3_sync_config` | `device_sync.rs` | B | 中 |
| `sync_device_usage_s3` | `device_sync.rs` | B | 中 |
| `recover_current_device_sync` | `device_sync.rs` | B | 低 |
| `refresh_shared_device_usage_s3` | `device_sync.rs` | B | 中 |
| `refresh_shared_device_usage_lan` | `device_sync.rs` | B | 中 |
| `probe_lan_peers` | `device_sync.rs` | B | 中 |
| `get_account_workspace_status` | `account_workspace.rs` | B | 低 |
| `initialize_account_workspace` | `account_workspace.rs` | B | 低 |
| `sync_account_workspace` | `account_workspace.rs` | B | 低 |
| `export_desktop_account_workspace` | `account_workspace.rs` | B | 低 |
| `import_desktop_account_workspace` | `account_workspace.rs` | B | 低 |

### 批次 8 — B · 渠道能力同步 / 模型目录 / 存储维护（16 条；A0/B16/C0/D0）

**排序理由**：models-cn/dev 同步、预设对比应用、/models 拉取、配置导入导出、DB 统计/压缩/清理。都是「低频但重」的维护命令，放在 B 类尾部。

| 命令 | 文件 | 难度 | 热度 |
|---|---|---|---|
| `db_stats` | `maintenance.rs` | B | 低 |
| `storage_usage_summary` | `maintenance.rs` | B | 中 |
| `compact_database` | `maintenance.rs` | B | 中 |
| `set_upstream_proxy_config` | `maintenance.rs` | B | 中 |
| `cleanup_old_logs` | `maintenance.rs` | B | 中 |
| `cleanup_expired_body_data` | `maintenance.rs` | B | 中 |
| `prune_oldest_body_data` | `maintenance.rs` | B | 低 |
| `get_total_body_size_bytes` | `maintenance.rs` | B | 低 |
| `export_config` | `maintenance.rs` | B | 低 |
| `import_config` | `maintenance.rs` | B | 低 |
| `account_routing_scores` | `maintenance.rs` | B | 低 |
| `sync_models_cn_catalog` | `scrape.rs` | B | 高 |
| `sync_models_dev_catalog` | `scrape.rs` | B | 中 |
| `preview_sync_channel_presets` | `scrape.rs` | B | 中 |
| `apply_sync_channel_presets` | `scrape.rs` | B | 中 |
| `fetch_channel_models` | `scrape.rs` | B | 高 |

### 批次 9 — C · 平台集成（15 条；A0/B0/C15/D0）

**排序理由**：子进程探测与启动（Agent runtime、Codex app-server、Antigravity）、OAuth 打开浏览器、自启动、托盘联动、代理启停、LAN 服务状态。**必须先定 Electron 主进程壳与托盘/退出流程**。

| 命令 | 文件 | 难度 | 热度 |
|---|---|---|---|
| `start_proxy` | `proxy.rs` | C | 高 |
| `stop_proxy` | `proxy.rs` | C | 高 |
| `lan_server_status` | `device_sync.rs` | C | 中 |
| `is_autostart_enabled` | `maintenance.rs` | C | 中 |
| `enable_autostart` | `maintenance.rs` | C | 中 |
| `disable_autostart` | `maintenance.rs` | C | 中 |
| `detect_agent_environment` | `agent.rs` | C | 高 |
| `start_agent_runtime` | `agent.rs` | C | 高 |
| `stop_agent_runtime` | `agent.rs` | C | 中 |
| `query_codex_accounts` | `agent.rs` | C | 高 |
| `sync_codex_accounts` | `agent.rs` | C | 中 |
| `authorize_codex_account` | `agent.rs` | C | 中 |
| `query_codex_account` | `agent.rs` | C | 中 |
| `query_antigravity_accounts` | `agent.rs` | C | 中 |
| `authorize_antigravity_account` | `agent.rs` | C | 低 |

### 批次 10 — D · 抓取控制台（可延后/可砍）（7 条；A0/B0/C0/D7）

**排序理由**：7 条 webview 抓取命令。建议最后做，或 v1 直接不做「控制台自动抓取余额」，保留官方 API 余额（`query_balance`，已在第 2 批）。

| 命令 | 文件 | 难度 | 热度 |
|---|---|---|---|
| `open_scrape_console` | `scrape.rs` | D | 中 |
| `close_scrape_console` | `scrape.rs` | D | 中 |
| `handle_scrape_interceptor_ready` | `scrape.rs` | D | 中 |
| `handle_intercepted_response` | `scrape.rs` | D | 中 |
| `probe_scrape_login` | `scrape.rs` | D | 中 |
| `scrape_balance` | `scrape.rs` | D | 中 |
| `sync_scrape_balances` | `scrape.rs` | D | 中 |

**批次总量校验**：16+18+14+13+15+14+13+16+15+7 = **141**。

**移动端批次 M1（不在本次范围）**：17 条（A1/B16），语义与桌面重叠，若保留 Tauri 移动端则几乎不需要改；若统一到 Node，需要单独评估移动端运行时（Electron 不支持）。

## 9. 风险与未确认项

| # | 风险 / 未确认项 | 影响 | 建议动作 |
|---|---|---|---|
| 1 | **代理核心不在本清单**：`core/proxy*.rs`（转发、路由、流式捕获、协议例外）比命令面大得多，本文件只覆盖命令边界 | 迁移工作量被低估 | 另立任务清点 `proxy.rs`/`proxy_http.rs`/`proxy_routing.rs`/`proxy_anthropic_compat.rs`；命令层迁移完不等于代理可用 |
| 2 | 返回字段 snake_case/camelCase 混用（§5.2） | TS 类型错误、页面字段 undefined | 迁移前先冻结一份「命令 → 返回结构 → 字段风格」类型快照，作为 Node 实现的契约测试 |
| 3 | D 类抓取控制台依赖 `__TAURI_INTERNALS__` 注入回调 | Electron 无等价物 | v1 砍掉控制台抓取，只保留官方 API 余额；或改用 `session.webRequest` 重写 |
| 4 | 请求体外部捕获帧格式（§6.7） | 旧请求详情不可读 | 迁库脚本必须处理 `.flcap`，或保留只读打开能力 |
| 5 | `AppState` 里的非 DB 运行时状态（抓取 webview map、LAN 状态、agent runtime manager、托盘句柄、退出标记） | 行为差异难发现 | Node 侧定义等价主进程单例并在批次 9 集中回归 |
| 6 | `start_proxy` 幂等 / 关窗隐藏 / 托盘退出 的产品契约 | 运行时可退化为「关窗即退出」 | 写进 Electron 壳的验收标准（AGENTS.md §3） |
| 7 | Web Host 46 条白名单 + 管理/模型双凭据分离 | Docker 形态功能缺失或越权 | 若保留 Docker Host，HTTP 路由与 IPC 双实现，鉴权分离 |
| 8 | 22 条前端零字符串引用命令（含 2 条注入 JS 回调） | 白搬工作量 | 按 §3.10 剔除/后置，需产品确认 |
| 9 | `storage_tests.rs`（4,402 行）中手写的旧 schema 建表 fixture 只抽查未逐条核对 | 迁移后回归覆盖下降 | Node 侧至少等价覆盖 schema 迁移与「旧库升级」fixture |
| 10 | 未确认：Electron 是否继续支持 Windows 便携版（exe 旁 DB/config、WebView 数据目录、AppUserModelID toast） | 路径与通知行为 | 需在壳设计阶段确认并写入迁移验收 |

---

**附：命令计数口径**

- 桌面 141 = `commands/` 下 `#[tauri::command]` 定义数（与 `lib.rs` 注册列表逐一比对无缺漏、无多余）。
- 移动 17 = `mobile_commands.rs` 定义/注册数。
- A/B/C/D 合计 34+85+15+7=141；移动 A1/B16=17。
- 领域分布与批次分布均为脚本生成，已校验恒等（见 §8 末尾）。
