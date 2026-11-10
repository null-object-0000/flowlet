# Flowlet Node Host（Docker 优先）实现契约

> 目标：用 Node/TS 重写 **headless / Docker Host**，作为 Rust `headless` 二进制的**行为等价替代**。
> 桌面端（Electron）**不在本阶段范围**；后续再基于同一 `flowlet-core` 加 Electron 壳。
> 工作分支：`migrate/electron`；工作树：`.worktrees/electron`。

## 1. 运行形态（必须与 Rust headless 完全一致）

| 项 | 契约 |
| --- | --- |
| 模型入口监听 | `FLOWLET_BIND_ADDR`，默认 `127.0.0.1:18640` |
| Web 管理监听 | `FLOWLET_WEB_ADDR`，默认 `127.0.0.1:8080` |
| 数据库 | `FLOWLET_DB_PATH`，默认 `flowlet-data/flowlet.sqlite`（Docker 内 `/data/flowlet.sqlite`） |
| 配置 | `FLOWLET_CONFIG_PATH`，默认 `<db 目录>/config.json`；不存在时写入内置默认配置 |
| 静态界面 | `FLOWLET_STATIC_DIR`，默认 `dist-web`；缺 `index.html` 直接启动失败 |
| 目录 | `FLOWLET_CATALOG_DIR`，默认数据目录（models-cn.json / models-dev.json） |
| 凭据 | `FLOWLET_ADMIN_TOKEN`（≥24 字符，缺失启动失败）；`FLOWLET_CLIENT_TOKEN`（缺失/空/等于 `flowlet-local-token` 时生成 UUID 并持久化到 `app_meta.proxy_bind_config`）；两者相同启动失败 |
| 对外地址 | `FLOWLET_PUBLIC_PROXY_URL`（仅展示用） |
| 设备身份 | `<db 目录>/flowlet-device.json`，重启后 device_id 不变 |
| 启动顺序 | 打开 DB/配置 → 初始化 presets → 持久化 bind config → **自动 start_proxy** → 校验静态目录 → 启动 Web 服务 → 起后台任务 |
| 退出 | SIGTERM/SIGINT → 优雅关闭：stop_proxy → 关闭 listener → 关闭 DB |
| 后台任务 | 余额同步（30s 后首次，每 5min）、存储清理（15min 后首次，每 15min）、目录同步（1h 后首次，每 1h）；已实现于 `host/scheduler.ts`（见 `docker-node.md` 的差异说明） |
| 健康检查 | `GET /health` → 200 `{"status":"ok"}`（不经鉴权） |

## 2. Web Host 命令契约（49 条，必须逐条等价）

权威实现：`src-tauri/src/core/web/commands.rs` + `mod.rs`。
- 鉴权：`Authorization: Bearer <admin_token>`，HMAC-SHA256 常量时间比较；失败 401 `{"code":"unauthorized","message":"管理凭据无效，请重新登录"}`；所有 API 响应 `Cache-Control: no-store`。
- 请求体上限 4 MiB；`POST /api/commands/{command}`，参数是 JSON 对象，参数名 **camelCase**。
- 错误：`(status, code, message)` → `{"code":..., "message":...}`；未知命令 501 `unsupported_in_web`。
- 静态资源：SPA fallback 到 `index.html`；`/api/{*path}` 非命令路由必须 404，不能回退成功页面。

49 条命令（43 条基础 + 6 条服务凭据）：`ipc_ping`、`list_channel_presets`、`list_channel_accounts`、`list_route_candidates`、`list_virtual_models`、`list_channel_models`、`save_channel_accounts`、`save_route_candidates`、`save_virtual_models`、`proxy_status`、`start_proxy`、`stop_proxy`、`get_proxy_bind_config`、`web_connection_info`、`set_proxy_bind_config`、`list_custom_scrape_channels`、`cleanup_old_logs`、`latest_balance_snapshots`、`save_balance_snapshot`、`query_balance`、`list_request_logs`、`list_known_devices`、`device_daily_usage`、`device_hourly_usage`、`list_request_log_clients`、`list_request_log_models`、`get_request_log_detail`、`list_agent_sessions`、`list_agent_session_children`、`account_routing_scores`、`usage_summary`、`usage_today_tokens`、`get_log_capture_config`、`set_log_capture_config`、`read_app_meta`、`write_app_meta`、`get_models_cn_catalog`、`get_models_dev_provider_catalog`、`get_models_cn_currencies`、`get_upstream_proxy_config`、`set_upstream_proxy_config`、`list_credential_providers`、
`list_service_credentials`、`save_service_credential`、`test_service_credential`、
`delete_service_credential`、`export_service_credentials`（另含 `web_connection_info`）。

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
  web/              [web] HTTP 服务、鉴权（token + OIDC SSO，auth.ts）、静态资源、49 命令 dispatch；
                    gitlab.ts / credentials.ts（服务凭据）
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
// 统计
accountRoutingScores() / usageSummaryRange(startAt,endAt,groupBy,currentDeviceId) / usageTodaySummary()
```

运行时快照（`RuntimeConfigStore.snapshot()`）形状：`{ channels, accounts, routes, rules, virtual_models }`，
与 Rust `runtime_config.rs` 一致；`save_*` 成功后必须刷新（web 负责调用 `update(mutate)`）。

## 6. 验收（Docker 版本可替换 Rust 的判定）

1. `npm run node:typecheck` 通过。
2. 同一份数据副本：Node host 与 Rust `headless` 对全部命令逐条 `diff`（忽略时间戳/排序/UUID 等无关字段）差异清零 → `scripts/web-parity.mjs`（当前 68 步，含 SSO 与服务凭据 mock GitLab）。
3. Web UI 在 Node host 上打开，概览/模型服务/请求日志/用量页面数据与 Rust 版一致。
4. 模型入口：mock 上游 + 真实上游各验证一次 `/v1/chat/completions` 流式、`/anthropic/v1/messages` 流式、`/v1/responses`；请求日志与用量落库字段与 Rust 一致。
5. Docker 镜像可按现有部署契约构建并跑通 `/health` + 管理 API + 流式冒烟。
