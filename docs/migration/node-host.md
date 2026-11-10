# Flowlet Node Host（Docker 优先）实现契约

> 目标：用 Node/TS 重写 **headless / Docker Host**，作为 Rust `headless` 二进制的**行为等价替代**。
> 桌面端（Electron）已在 2026-11-10 起基于同一 `flowlet-core` 开工：桌面独有命令注册在
> `packages/flowlet-core/src/desktop/`（见该目录 README），Electron 宿主在
> `packages/flowlet-desktop/`，施工状态见 `docs/electron-migration-plan.md` 与
> `docs/desktop-electron.md`。
> 工作分支：`migrate/electron`；工作树：`.worktrees/electron`。

## 1. 运行形态（必须与 Rust headless 完全一致）

| 项 | 契约 |
| --- | --- |
| 模型入口监听 | `FLOWLET_BIND_ADDR`，默认 `127.0.0.1:18640` |
| Web 管理监听 | `FLOWLET_WEB_ADDR`，默认 `127.0.0.1:8080` |
| 数据库 | `FLOWLET_DB_PATH`，默认 `flowlet-data/flowlet.sqlite`（Docker 内 `/data/flowlet.sqlite`） |
| 配置 | `FLOWLET_CONFIG_PATH`，默认 `<db 目录>/config.json`；不存在时写入内置默认配置 |
| 渠道模板 | 外部 `config.json` 缺失的渠道由镜像内置 `config.json` 补齐（`loadChannelsConfig` → `mergeBuiltinConfig`，与 Rust `merge_builtin_config` 一致）；**Web 命令层必须复用同一份已合并的 `channels_config`**（`startHost` 经 `channelsConfigToJson` 传给 `createWebHost`）。若 Web 命令层直接读原始 `config.json`，数据卷里早于当前版本的配置会让 `fetch_channel_models` 报「渠道 X 缺少运行时模板」、`query_balance` 拼出空 Base URL（`Invalid URL`）。回归测试：`web/__tests__/channels-config.test.ts` |
| 静态界面 | `FLOWLET_STATIC_DIR`，默认 `dist-web`；缺 `index.html` 直接启动失败 |
| 目录 | `FLOWLET_CATALOG_DIR`，默认数据目录（models-cn.json / models-dev.json） |
| 凭据 | `FLOWLET_ADMIN_TOKEN`（≥24 字符，缺失启动失败）；`FLOWLET_CLIENT_TOKEN`（缺失/空/等于 `flowlet-local-token` 时生成 UUID 并持久化到 `app_meta.proxy_bind_config`）；两者相同启动失败 |
| 对外地址 | `FLOWLET_PUBLIC_PROXY_URL`（仅展示用） |
| 设备身份 | `<db 目录>/flowlet-device.json`，重启后 device_id 不变 |
| 启动顺序 | 打开 DB/配置 → 初始化 presets → 持久化 bind config → **自动 start_proxy** → 校验静态目录 → 启动 Web 服务 → 起后台任务 |
| 退出 | SIGTERM/SIGINT → 优雅关闭：stop_proxy → 关闭 listener → 关闭 DB |
| 后台任务 | 余额同步（30s 后首次，每 5min）、存储清理（15min 后首次，每 15min）、目录同步（1h 后首次，每 1h）；已实现于 `host/scheduler.ts`（见 `docker-node.md` 的差异说明） |
| 健康检查 | `GET /health` → 200 `{"status":"ok"}`（不经鉴权） |

## 2. Web Host 命令契约（Node Host 共 66 条：Rust 等价命令 + Node 专有命令）

权威实现：`src-tauri/src/core/web/commands.rs` + `mod.rs`。
- 鉴权：`Authorization: Bearer <admin_token>`，HMAC-SHA256 常量时间比较；失败 401 `{"code":"unauthorized","message":"管理凭据无效，请重新登录"}`；所有 API 响应 `Cache-Control: no-store`。
- 请求体上限 4 MiB；`POST /api/commands/{command}`，参数是 JSON 对象，参数名 **camelCase**。
- 错误：`(status, code, message)` → `{"code":..., "message":...}`；未知命令 501 `unsupported_in_web`。
- 静态资源：SPA fallback 到 `index.html`；`/api/{*path}` 非命令路由必须 404，不能回退成功页面。

命令清单（`web/commands.ts` 的 66 个 `case`）：`ipc_ping`、`list_channel_presets`、`list_channel_accounts`、`list_route_candidates`、`list_virtual_models`、`list_channel_models`、`save_channel_accounts`、`save_route_candidates`、`save_virtual_models`、`proxy_status`、`start_proxy`、`stop_proxy`、`get_proxy_bind_config`、`web_connection_info`、`set_proxy_bind_config`、`list_custom_scrape_channels`、`cleanup_old_logs`、`latest_balance_snapshots`、`save_balance_snapshot`、`query_balance`、`list_request_logs`、`list_known_devices`、`device_daily_usage`、`device_hourly_usage`、`list_request_log_clients`、`list_request_log_models`、`list_request_log_channel_accounts`、`get_request_log_detail`、`list_agent_sessions`、`list_agent_session_children`、`account_routing_scores`、`usage_summary`、`usage_today_tokens`、`get_log_capture_config`、`set_log_capture_config`、`read_app_meta`、`write_app_meta`、`get_models_cn_catalog`、`get_models_dev_provider_catalog`、`get_models_cn_currencies`、`get_upstream_proxy_config`、`set_upstream_proxy_config`、`list_credential_providers`、
`list_service_credentials`、`save_service_credential`、`test_service_credential`、
`delete_service_credential`、`export_service_credentials`
（另含 `web_connection_info`）、`test_connection` / `fetch_channel_models` /
`sync_models_cn_catalog` / `sync_models_dev_catalog`（依赖真实上游网络，对拍时跳过）。

Node 专有（Rust headless 未实现，不参与对拍，由 Node 侧单测覆盖）：

- CLI 浏览器授权：`create_cli_auth_code` / `list_cli_auth_tokens` / `revoke_cli_auth_token`；
- 原始 token 查看：`reveal_service_credential`（管理鉴权；CLI token 403）；
- AI 生成环境前缀：`POST /api/ai/env-prefix`（SSE，非命令）。管理鉴权 + CSRF；服务端流式调本机模型入口，逐条下发 `start` / `progress`（tokens、elapsedMs）/ `done`（segment、completionTokens、tokPerSec）/ `error` 事件；每次点击计一次模型调用；
- 千问平台登录：`qwen_platform_status` / `qwen_platform_login_start` / `qwen_platform_login_poll` /
  `qwen_platform_logout` / `qwen_platform_sync`；
- 数据完整性检查：`repair_agent_sessions` / `repair_captured_usage` / `repair_unknown_usage` /
  `repair_usage_costs`（对应桌面端「设置 → 数据维护 → 数据完整性检查」；Rust headless 无这四条，
  Node Host 不含 Agent 原生 transcript 回退）。

### 2.1 CLI 浏览器授权（`flowlet login`，Node Host 新增）

生产 Docker 实例已切 OIDC-only（`token_login=false`），静态管理 Bearer 被拒，因此 Node Host
比 Rust `headless` 多出一套**独立于管理鉴权面**的 CLI 授权：

- 公开路由：`GET /api/auth/cli/start`（最小授权页，内联 JS/CSS，先读 `/api/session` 决定
  展示「登录管理台」/「token 模式请用 --token」/「授权按钮」）、`POST /api/auth/cli/exchange`
  （`{code, codeVerifier}` → `{token, expiresAt}`）。
- 受管理鉴权保护：`create_cli_auth_code`（Cookie 会话必须过 CSRF；token 模式仍可用 Bearer）、
  `list_cli_auth_tokens`、`revoke_cli_auth_token`。
- token 形式 `flwcli_<43 字符 base64url>`，服务端只存 SHA-256，作用域固定
  `credentials:read`（仅放行 `export_service_credentials`，其它命令 403），TTL 30 天；过期行在
  签发时惰性清理，`last_used_at` 在使用时更新。
- 授权码只存进程内存（Map），120 秒有效、一次性；回调地址只允许 loopback。
- SQLite 新增 `cli_auth_tokens` 表（`CREATE TABLE IF NOT EXISTS`，见 `storage/schema.ts`），
  兼容已有库。
- **Rust Host 暂不实现**这套能力（桌面 Tauri 也没有对应 command）：`flowlet login` 只对
  Node Host 可用；token 模式实例的 `flowlet pull --token=…` 路径不受影响。前端「已授权的 CLI」
  段在缺少 `list_cli_auth_tokens` 时只展示说明文案，不报错。

## 3. 代理契约（模型入口）

权威实现与逐段拆解：`docs/migration/proxy-core.md`（1227 行）。
- 入站：`/v1/chat/completions`、`/anthropic/v1/messages`（含 `/v1/messages`）、`/v1/responses`、`/v1/models`、Anthropic Files API。
- 模型名按 `model-catalog.json` 归一到规范 ID 再匹配路由；候选过滤：协议、图片输入模态、anthropic-beta files-api pin。
- 响应 **零改写**（受控例外：Anthropic thinking/tool_use 补字段、DeepSeek reasoning_content / anthropic thinking 回填，见 AGENTS.md §5）。
- 流式：SSE 透传 + 背压；日志旁路失败不得影响主链路（流式首条日志 await 例外）。
- 请求日志/用量：写 `request_logs` + `usage_records`（+ `.flcap` 外置捕获帧可选，MVP 可先只落库不做外置帧）。
- 鉴权：模型入口校验 client token（`FLOWLET_CLIENT_TOKEN` / bind config）。
- 系统代理：Rust `reqwest` 默认走系统代理，Node 默认不走 → 必须实现 `use_upstream_proxy` + 全局 upstream proxy 语义（R6 风险）。

## 4. 代码布局与所有权（并行开发约定）

```
packages/flowlet-core/src/
  index.ts          [Lead] 启动/关闭编排（env → services → proxy → web → 后台任务）
  host/scheduler.ts [Lead] 周期维护：余额同步(5m) / 存储清理(15m) / 目录同步(1h)
  types.ts          [Lead] 共享类型、HostOptions、CommandError
  config/           [storage] config.json 读取/默认值合并/渠道预设初始化/RuntimeConfig 快照
  catalog/          [storage] model-catalog.json + models-cn/dev 目录读取与归一
  storage/          [storage] SQLite 打开/建表/迁移 + 全部读写方法；capture-store.ts（.flcap 帧）、
                    prices.ts（目录派生价格表）、secret-box.ts（ChaCha20-Poly1305）、
                    credentials.ts（service_credentials 表 CRUD）
  web/              [web] HTTP 服务、鉴权（token + OIDC SSO，auth.ts）、CLI 授权
                    （cli-auth.ts / env-prefix.ts）、静态资源、66 命令 dispatch；
                    gitlab.ts / dockhand.ts / credentials.ts（服务凭据）
  proxy/            [proxy] 模型入口、路由、转发、SSE、日志/用量落库
scripts/
  web-parity.mjs    [web] Rust headless ↔ Node host 双实现对拍
  e2e-node-host.mjs [docker] 端到端冒烟（mock 上游 + 命令面 + 流式）；web-parity 另含 mock GitLab 凭据对拍
Dockerfile          [docker] Node 运行时镜像（替换 Rust 构建阶段）
docker-compose.yml  [docker] 保持 20134/20135/数据卷/环境变量不变
```

**规则**
1. 只改自己所有权下的文件；需要别人的接口变更 → `send_message` 给 lead 转达，不要跨目录改。
2. 类型是事实契约：Rust 输出什么字段就返回什么字段；`snake_case`/`camelCase` 混用必须逐类型确认。
3. 不新增运行时依赖（除 `undici`）；不用原生模块；Node 26 直接跑 `.ts`（类型剥离），提交前 `npm run node:typecheck`。
4. 每个模块先做到「能跑通当前生产数据副本」，再补边界；**不允许为了通过验收伪造数据**。

## 5. Storage 方法契约

`SqliteStorage` 必须实现（供 web/proxy 调用，命名固定）：

```
open(dbPath): SqliteStorage            // schema 幂等建表 + 122 补列 + 索引
close()
// app_meta
getAppMeta(key) / setAppMeta(key, value)
// 渠道/账号/路由/模型
listChannelPresets() / initializeChannelPresets(config)
listChannelAccounts() / saveChannelAccounts(accounts)
listRouteCandidates() / saveRouteCandidates(routes)
listVirtualModels() / saveVirtualModels(models)
listChannelModels()
// 余额
latestBalanceSnapshots() / saveBalanceSnapshot(snapshot)
// 请求日志/用量
listRequestLogsPage(filter) / listRequestLogsByRequestId(requestId)
listRequestLogClients() / listRequestLogModels() / cleanupOldLogs(opts)
insertRequestLog(row) / insertUsageRecord(row)
updateRequestLogTiming(requestId, patch)   // = Rust storage_usage::update_request_log_timing
                                           // WHERE request_id=? AND is_last_attempt=1 AND is_stream=1
// 设备
listKnownDevices() / deviceDailyUsage(currentDeviceId, deviceId) / deviceHourlyUsage(...)
// 会话
listObservedAgentSessionsPage(filter) / listObservedAgentSessionChildren(agentType, parentId)
upsertAgentSessionMetadata(row)          // 会话标题/项目路径观测元数据（docs/agent-session-metadata.md）
// 统计
accountRoutingScores() / usageSummaryRange(startAt,endAt,groupBy,currentDeviceId) / usageTodaySummary()
```

运行时快照（`RuntimeConfigStore.snapshot()`）形状：`{ channels, accounts, routes, rules, virtual_models }`，
与 Rust `runtime_config.rs` 一致；`save_*` 成功后必须刷新（web 负责调用 `update(mutate)`）。

**仅 Node Host 写入的表**：`agent_session_metadata`（`agent_type`, `session_id`, `title`,
`project_path`, `source`, `updated_at`，复合主键）由代理侧从请求体派生会话标题/项目路径
（[docs/agent-session-metadata.md](../agent-session-metadata.md)），用于 Docker 会话管理展示。
它只增不改，旧 Rust 镜像读到未知表会忽略；回滚安全。桌面 Rust Host 不写该表——桌面端仍以本机
原生会话的标题/cwd 为准（`merge_agent_session_catalog` 原生值优先）。

## 6. 验收（Docker 版本可替换 Rust 的判定）

1. `npm run node:typecheck` 通过。
2. 同一份数据副本：Node host 与 Rust `headless` 对全部等价命令逐条 `diff`（忽略时间戳/排序/UUID 等无关字段）差异清零 → `scripts/web-parity.mjs`（当前 68 步，含 SSO 与服务凭据 mock GitLab）。Node 专有的 CLI 授权命令（§2.1）Rust 未实现，不参与对拍，由 Node 侧单测与 `e2e-node-host.mjs` 覆盖。Rust oracle 默认不构建（`legacy-server` feature 关闭），对拍前先 `cargo build --release --manifest-path src-tauri/Cargo.toml --no-default-features --features legacy-server --bin headless`。
3. Web UI 在 Node host 上打开，概览/模型服务/请求日志/用量页面数据与 Rust 版一致。
4. 模型入口：mock 上游 + 真实上游各验证一次 `/v1/chat/completions` 流式、`/anthropic/v1/messages` 流式、`/v1/responses`；请求日志与用量落库字段与 Rust 一致。
5. Docker 镜像可按现有部署契约构建并跑通 `/health` + 管理 API + 流式冒烟。
6. CLI 授权（Node 专有）：`flowlet login --server=<origin>` 走完 loopback + PKCE 回调，
   `auth.json` 落盘（0700/0600、原子写）；`flowlet pull --server=<origin>` 不带 `--token` 即同步
   成功；CLI token 调其它命令返回 403；`list_cli_auth_tokens` / `revoke_cli_auth_token` 在 UI
   可列出与撤销，撤销后 `pull` 返回 401；`ALLOW_TOKEN_LOGIN=0` 时静态 Bearer 仍被拒。
