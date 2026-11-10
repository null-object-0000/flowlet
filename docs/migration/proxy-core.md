# Flowlet 代理核心迁移勘察：行为契约、Node 等价实现设计与 Spike 定义

> **性质**：只读勘察结论 + 重写技术设计，是 `task-5` 的唯一产物。
> **基线**：`main` @ `26fed4c`（2026-11-09，`feat: support LongCat-2.5`）。
> **范围**：`src-tauri/src/core/{proxy,proxy_http,proxy_routing,proxy_anthropic_compat,proxy_tests,request_capture,logging,usage,rate_limiter}.rs`，及其装配点 `services.rs`、`bin/headless.rs`、`core/web/*`、`commands/proxy.rs`、`upstream_proxy.rs`、`model_catalog.rs`、`model_input_capabilities.rs`、`agent_identity_adapter*`、`agent_session_identity.rs`、`storage_usage.rs`（捕获/日志/用量段）、`config.rs`（代理相关结构）。
> **方法**：逐段 `read` 关键函数（不只看注释）+ `grep` 统计 + 本地只读探测（Electron/Node 能力、PoC 目录、`config.json` 形状、PoC 数据库行数）。
> **限制**：未运行任何 `cargo` / `npm` 构建，未修改 `src-tauri/` 与 `src/`，未调用任何上游网络。凡"未验证"处均显式标注。
> **产出**：仅本文件。

---

## 0. 结论摘要（先看这一节）

| 指标 | 结论 |
|---|---|
| 任务书指定 9 个文件总行数 | **11,935 行**（其中 `proxy_tests.rs` 5,759 行；非测试代码 6,176 行） |
| 代理相关代码总量（含依赖面） | 直接 9 文件 11,935 + 辅助模块中与代理相关约 4,000–5,000 行 ≈ **1.0–1.1 万行 Rust 行为代码** |
| 测试资产 | **179 个测试**：`proxy_tests.rs` 138 个（76 同步 + 62 个起真实 mock 上游/直接调 `forward_request` 的集成 e2e），其余 41 个是 `proxy_http` / `usage` / `proxy_anthropic_compat` / `request_capture` / `rate_limiter` 的单元测试 |
| 迁移难度 | **最高（本项目第一风险项）**。协议面本身不复杂，难在**大量顺序敏感的状态机与时序契约**（流式生命周期、attempt 记录、凭证状态、捕获一致性） |
| 最难的 3 个等价点 | ① SSE 流完整生命周期（背压/分块空闲超时/终止标记/下游断开/usage partial-complete/日志"先写未完成再回填"）② 捕获一致性（必须捕获"最终上游请求"、缓冲体解压+UTF-8 截断、`.flcap` 60 字节帧 zstd+sha256 与 Rust 双向可读、日志失败不影响主链路）③ 路由候选 + 降级 + 凭证状态机（alias→canonical 精确匹配、协议/图片模态过滤、files pin、分组轮询、四类降级探测、401 标记与临时恢复、skipped 节点不伪造 HTTP 状态） |
| Node 方案一句话 | **入站用 `node:http` 裸服务（不用 fastify/express）；上游用 `undici`（永远不用 `fetch`，需验证其不解压原始字节）；SSE 用 `stream.pipeline` 从上游体直连 `res` 保背压；捕获/日志/用量/`.flcap`/SQLite 全部交给单个 DB `worker_thread`（单连接、串行写）；`.flcap` 用 Node 内置 `zlib.zstd*`（Electron 45 的 Node 24.22 已实测可用）** |
| 一天 spike 是否可行 | **可行**，但只能覆盖"协议主链路 + 一条流式 + 降级/捕获骨架"。验收标准见 §7（A1–A12，全部可脚本化）；真上游不可用（无 Key）→ 用本地 mock 上游 + 回放 `proxy_tests` 场景 + Rust↔Node 对拍 |
| 排期建议（1 名资深 + 1 名测试/对拍） | 协议主链路 6–9 人日；捕获/日志/用量 4–6；受控例外与边界 3–5；179 个测试移植 8–12；性能/长稳 5–8；**合计 26–40 人日**，3 人并行约 3–4 周（含 30% buffer） |
| 需要先拍板的决策 | ① 是否接受 `node:sqlite` 替换 better-sqlite3（详见 §5.9，Electron 45 实测可用，可消除原生 ABI 风险）② 请求体是否继续无上限缓冲（Rust 现状 `usize::MAX`，Node 同样会 OOM）③ 系统代理是否要求与 reqwest 默认行为一致（`reqwest` 默认会用系统代理，而 Node 默认完全不用）④ 服务端 Host 的 CORS 预检在鉴权中间件之后（当前跨域浏览器预检会被 401 拒绝）是否照抄 |

---

## 1. 勘察范围、取证方式与限制

### 1.1 文件与调用面

| 层 | 文件 | 说明 |
|---|---|---|
| 代理核心 | `core/proxy.rs`、`proxy_http.rs`、`proxy_routing.rs`、`proxy_anthropic_compat.rs` | 入口、转发、路由、Anthropic 兼容修复 |
| 捕获/观测 | `request_capture.rs`、`usage.rs`、`rate_limiter.rs`、`logging.rs` | 二进制捕获帧、usage 解析、限流、文件日志 |
| 回归资产 | `proxy_tests.rs` + 上述文件内 `mod tests` | 179 个测试 |
| 依赖面 | `upstream_proxy.rs`（出口代理）、`model_catalog.rs`（别名归一）、`model_input_capabilities.rs`（图片模态）、`agent_identity_adapter*` + `agent_session_identity.rs`（客户端/会话归属）、`storage_usage.rs`（日志/用量/捕获落库）、`config.rs`（结构体） | 不在任务书 9 文件内，但不实现就无法等价 |
| 装配 | `core/services.rs`（`FlowletServices::start_proxy`）、`bin/headless.rs`（Web Host）、`core/web/*`（管理 API 白名单）、`commands/proxy.rs`（Tauri 命令）、`lib.rs` | 进程生命周期所有者 |

### 1.2 取证限制

- 未运行 `cargo test`，因此**无法执行** 179 个测试来实测行为；本文所有契约来自源码逐段阅读（含测试断言本身，测试断言是行为规范的一部分）。
- 未访问真实上游；`config.json` 中的 9 个渠道只有 preset，没有账号/Key（账号在 SQLite）。
- **安全提醒**：`poc/electron-host/data/flowlet.sqlite` 是一份未纳入 git 的本地数据库副本（`git status` 显示 `poc/electron-host/` 整个目录 untracked），其中 14 个 `channel_accounts` 里多个 `api_key` 非空（已见长度 32–164 字符）。请勿把该副本复制进仓库/文档/CI；spike **默认不得**用这些凭据打真实上游，除非用户明确授权并接受消耗额度。

### 1.3 关键环境探测（为 Node 方案提供依据）

在只读前提下探测了本机 PoC 的 Electron（`poc/electron-host/node_modules/electron`，`45.2.3`）：

```json
{"node":"24.22.2","electron":"45.2.3","modules":"150",
 "zstd":"function","sqlite":"function"}
```

结论：
1. **`node:zlib` 的 zstd API 可用**（`zstdCompressSync`），`.flcap` 帧可以零原生依赖地读写。
2. **`node:sqlite` 的 `DatabaseSync` 可用**（无 flag），现成 PoC `poc/electron-host/server.mjs` 已用它只读打开真实库。
3. `poc/electron-host/` 已存在一个"Node 命令宿主 + Electron 壳"的 PoC（`node:http` 静态服务 + 只读 SQLite），但它**不包含模型代理**；代理 spike 应另建目录，可复用其脚手架风格。

---

## 2. 代码规模与模块职责

### 2.1 直接范围（任务书指定的 9 个文件）

| 文件 | 行数 | 测试数 | 职责 | 对外接口（被谁调用） | 关键数据结构 |
|---|---:|---:|---|---|---|
| `core/proxy.rs` | 2,444 | （见下） | 代理生命周期（Controller/Runtime）、axum 路由与中间件、`forward_request` 主流程、attempt 循环、流式包装、日志上下文、usage 入口、`/health`、Files API 转发 | `lib.rs` / `commands/proxy.rs` / `core/services.rs` / `bin/headless.rs` / `core/web` | `ProxySharedConfig`、`ProxyAppState`、`ProxyStatus`、`ProxyError`、`ProxyForwardError`、`RouteLogContext`、`UsageCapture`、`StreamDone`、`TimedStreamState` |
| `core/proxy_http.rs` | 1,482 | 14 | CORS、入口路径识别、`/models` 与 `/v1/models/{id}` 响应构造、URL 拼接、请求头改写/剥离、客户端识别、`log_capture` 解析、模型名提取/改写、`reasoning_content` 回填、header 序列化/脱敏、body 截断/解压 | `proxy.rs`（主要）、`lib.rs`（`extract_log_capture`） | `FilesApiOp`、`ModelEntry`、`CandidateDetail`、`ModelsCnMatch` |
| `core/proxy_routing.rs` | 390 | 0（被 `proxy_tests` 覆盖） | 候选匹配、排序、分组轮询、高级规则、Files 绑定账号、降级判定（状态码/body 文本）、网络错误分类 | `proxy.rs` | `CandidateSelection`、`RouteCandidate` 排序键 |
| `core/proxy_anthropic_compat.rs` | 288 | 6 | Anthropic SSE `content_block_start` 缺失字段修复（thinking/tool_use），按行跨 chunk 状态机 | `proxy.rs::build_response` | `ContentBlockStartCompat` |
| `core/proxy_tests.rs` | 5,759 | 138 | 端到端回归资产（起真实 `axum` mock 上游 + 直接调 `forward_request`；断言客户端响应、上游收到的请求、日志/用量落库、降级链） | `proxy.rs` 的 `#[path] mod proxy_tests` | `SpyUpstream`、`build_test_state`、`test_account`、`test_route` |
| `core/request_capture.rs` | 580 | 3 | 外部捕获帧 `.flcap`（FLCAP001 + zstd + sha256）追加/读取/轮转/重写/删除、按 session 分目录、路径穿越防护 | `storage.rs`（`#[path] mod`）、`storage_usage.rs` | `RequestCaptureRecord`、`RequestCapturePointer`、`RequestCaptureStore`、`RequestCaptureError` |
| `core/logging.rs` | 189 | 2 | 桌面进程文件日志（按天滚动、保留 7 个文件、exe 同级 `logs/`）、panic hook、应急日志、`RUST_LOG` 过滤 | `lib.rs` 启动 | `LOG_INIT`、`PANIC_HOOK_INIT` |
| `core/usage.rs` | 713 | 16 | usage 解析：非流式 JSON、完整 SSE、流式增量累加器、`used`/缓存 token 归一、TTFT 的"首输出 token"判定 | `proxy.rs` | `ResponseUsage`、`StreamUsageAccumulator`、`StreamUsageResult` |
| `core/rate_limiter.rs` | 90 | 2 | 按客户端 token 的令牌桶（默认 600 rpm，秒级补充） | `proxy.rs`、`services.rs` | `RateLimiter`、`Bucket` |
| **合计** | **11,935** | **179**（含其它 5 文件 41 个） | | | |

### 2.2 代理依赖面（不属于 9 文件，但必须一起移植）

| 文件/目录 | 行数 | 与代理的关系 |
|---|---:|---|
| `core/upstream_proxy.rs` | 519 | 上游出口代理：每账号/全局开关、连接池缓存、连接失败仅重试一次、`Matcher::from_system` 探测系统代理、`upstream_proxy_used` 标记 |
| `core/model_catalog.rs` | 361 | `model-catalog.json` 编译期内嵌；`canonical_key` / `find` / `routing_model_id`（入站别名归一） |
| `core/model_input_capabilities.rs` | 367 | 图片请求识别 + 候选按模型目录能力过滤（未知能力按不支持处理） |
| `core/agent_identity_adapter.rs` + `adapters/*` | 75 + 236 | `x-flowlet-client` 标记头优先、UA 规则识别；`builtin_ua_rules` 与用户 `config.json` 规则合并 |
| `core/agent_session_identity.rs` | 354 | `x-flowlet-session`、`x-deepseek-harness-session-id` 提取与门控；历史日志重识别复用 |
| `core/storage_usage.rs`（日志/用量/捕获段） | 4,936（整文件） | `insert_request_log`（SQLite 行 + `.flcap` 帧 + `request_capture_refs` 状态事务）、`update_request_log_timing`、`upsert_usage_record_with_metadata`、body 清理（保留天数/体积/比例） |
| `core/config.rs`（代理相关结构） | 2,100（整文件） | `ProtocolType`、`AuthStrategy`、`ChannelPreset`、`ChannelAccount`、`RouteCandidate`、`RouteRule`、`RequestLogInput`、`UsageRecordInput`、`LogCaptureConfig`、`ProxyBindConfig` |
| `core/runtime_config.rs` | 278 | `RuntimeConfigSnapshot` 原子发布（一次请求只读一个 revision） |
| `core/services.rs` / `bin/headless.rs` / `core/web/*` | 474 / 202 / 455 | 启动顺序、`require_client_auth`、Web Host 命令白名单、`public_proxy_url` |

### 2.3 装配与进程拓扑

```
桌面（Tauri 当前）                                    Node 迁移目标（建议）
┌─────────────────────────────────────┐              ┌──────────────────────────────────────┐
│ 前端 React（auto-start/restart 由前端触发） │              │ 前端 React（契约不变）                  │
│  invoke: start_proxy / stop_proxy / ...│              │  IPC/HTTP: 同名命令（经 typed boundary）│
│ ┌───────────────────────────────────┐ │              │ ┌──────────────────────────────────┐ │
│ │ Tauri 主进程                        │ │              │ │ Electron 主进程（Node）            │ │
│ │  FlowletServices                   │ │              │ │  FlowletServices 等价物           │ │
│ │   ├ ProxyController (状态/绑地址)    │ │              │ │   ├ ProxyController（幂等）        │ │
│ │   ├ RuntimeConfigStore (原子快照)    │ │              │ │   ├ RuntimeConfigStore（原子快照）  │ │
│ │   ├ axum proxy server :18640        │ │              │ │   ├ node:http proxy server :18640  │ │
│ │   └ storage: rusqlite(Mutex) + 捕获  │ │              │ │   └ DB worker(线程): sqlite + flcap │ │
│ └───────────────────────────────────┘ │              │ └──────────────────────────────────┘ │
│  headless/bin 复用同一 services        │              │  headless host 复用同一 proxy 包      │
└─────────────────────────────────────┘              └──────────────────────────────────────┘
```

要点：
- **代理监听与产品状态解耦**：前端负责"是否自动启动/重启"，Rust 负责"能监听、幂等、无账号也能跑"（`AGENTS.md` §3、§4）。Node 侧必须保留同一分工。
- 启动顺序（`bin/headless.rs:90-125`）：先 `services.start_proxy()`，再 `create_web_router` 起管理 API；退出时先 `stop_proxy()`。
- 桌面启动装配在 `core/services.rs:100-134`；`start_with_bind_auth` 在 `proxy.rs:359-463`。

### 2.4 测试资产分布（179）

| 文件 | 数量 | 性质 |
|---|---:|---|
| `proxy_tests.rs` | 138 | 76 个同步单测（纯函数/路由/头/URL/usage）+ 62 个 `#[tokio::test]`（起真实 mock 上游或直接调 `forward_request` 的集成/e2e，含流式时序、降级、Files、渠道原生协议） |
| `proxy_http.rs` | 14 | URL 拼接、header 改写/脱敏、解压、`[1m]`、`context-1m` beta |
| `usage.rs` | 16 | 三种协议 usage 形状、增量解析、截断/partial 判定 |
| `proxy_anthropic_compat.rs` | 6 | 行修复的 chunk 边界/超大行/错误传播 |
| `request_capture.rs` | 3 | 帧写入读取、分段轮转、路径穿越 |
| `rate_limiter.rs` | 2 | 桶与分客户端 |

---

## 3. 请求链路逐段拆解（含函数定位）

以下行号均基于基线 `26fed4c`，格式 `文件:行`。

### 3.0 路由与入口（`proxy.rs:407-416`）

| 入站路径 | handler | 说明 |
|---|---|---|
| `/health` | `health` | 任意方法；`OPTIONS` → CORS 预检 204 |
| `/v1/{*path}`、`/openai/v1/{*path}` | `forward_openai_compatible` | OpenAI 兼容入口；`/v1/responses*`、`/openai/v1/responses*`、`/responses*` 在 `forward_request` 内重标为 Responses |
| `/responses`、`/responses/{*path}` | `forward_openai_compatible` | 裸根路径入口（DeepSeek SDK 风格，base_url 不带 `/v1`） |
| `/anthropic/v1/{*path}` | `forward_anthropic_compatible` | Anthropic 入口；含 Files API 分流 |
| 其它路径 | 无路由 → 404 | — |

入口 handler 只做三件事：`OPTIONS` 预检、调用 `forward_request`、给响应加 CORS；`forward_request` 返回 `Err` 时统一 **502 + 纯文本**错误体（`proxy.rs:513-557`）。

### 3.1 预检 / CORS / health

- `health`（`proxy.rs:500-509`）：`OPTIONS` → `cors_preflight_response`（204）；其余返回 `ok`（无 content-type），加 CORS。
- CORS 头固定：`Access-Control-Allow-Origin: *`、`Allow-Methods: GET,POST,PUT,PATCH,DELETE,OPTIONS`、`Allow-Headers` 回显请求的 `access-control-request-headers` 或默认 `authorization,content-type,x-api-key,anthropic-version,anthropic-beta`、`Expose-Headers: content-type,x-request-id`、`Max-Age: 86400`（`proxy_http.rs:14-50`）。
- **服务端 Host**：桌面模式 CORS 优先；`require_client_auth=true` 时鉴权中间件包住除 `/health` 外的所有路径，因此**跨域预检 OPTIONS 也需要合法 token**（`proxy.rs:433-451`）。这是现状，迁移时需产品确认是保留还是修正。

### 3.2 主机鉴权中间件（仅 Web/Docker Host，`proxy.rs:433-451`）

- 判定：`path == "/health"` 或 `default_client_token` 非空且 `identify_client(headers, token)` 命中。
- 失败：401，body 形如 `{"error":{"message":"Invalid client API key","type":"authentication_error","code":"invalid_api_key"}}`，无 CORS。
- `identify_client`（`proxy_http.rs:754-782`）：依次比对 `Authorization: Bearer <token>`、`x-api-key: <token>`，**精确字符串相等**；命中返回 `("default", "默认客户端")`。

### 3.3 Files API 分流（`proxy.rs:780-794`、`571-749`）

- 在读取 body **之前**判定：`detected_protocol == Anthropic` 且 `files_api_request(method, path)` 命中 → 走 `forward_files_api_request`。
- `files_api_request`（`proxy_http.rs:87-102`）只认 `/anthropic/v1/files…`，四个操作：`POST ""`（upload）、`GET ""`（list）、`GET /{id}`（retrieve）、`DELETE /{id}`（delete）；单段非空 id。
- 完整 Files 流程见 §3.15。

### 3.4 协议重标：Responses（`proxy.rs:811-818`）

- 入站路径经 `ProtocolType::is_responses_path`（`config.rs:213-224`）命中时，`detected_protocol` 从 `OpenAi` 重标为 `Responses`。覆盖 `/v1/responses*`、`/openai/v1/responses*`、`/responses*`。
- **Responses 只支持 POST**（`proxy.rs:820-837`）：非 POST 直接 405，OpenAI 错误信封，`type/code = responses_unsupported_method`，不读上游。
- 入站探测粗分类 `ProtocolType::from_path`（`config.rs:197-211`）仍为 `/v1|/openai` → OpenAi，`/anthropic` → Anthropic。

### 3.5 请求体读取与 `/models`、`/v1/models/{id}`

- 模型路径：`axum::body::to_bytes(body, usize::MAX).await.unwrap_or_default()`（`proxy.rs:799-801`）——**无上限缓冲**，读失败静默变空 body。
- `/models`：在拿 body 之后、读配置快照之后判定 `is_model_list_request(method, path)`（`proxy_http.rs:52-62`），只认 `GET` + 精确路径 `/v1/models`、`/openai/v1/models`、`/anthropic/v1/models`（忽略 query）→ `build_model_list_response`（`proxy_http.rs:437-451`）。
  - 对外模型 = `enabled` 路由 + 协议匹配 + 账号健康（enabled + Key 非空 + `credential_status=healthy`）+ 规范身份一致 + 非退役聚合名；**同一个 `virtual_model_id` 只出现一次**；按名字典序；`owned_by` 取承载渠道 `vendor`，缺失 `flowlet`（`proxy_http.rs:465-524`）。
  - 形状：OpenAI `{object:"list",data:[{id,object:"model",created,owned_by}]}`；Anthropic `{data:[{id,type:"model",display_name,created_at}],has_more:false,first_id,last_id}`（`proxy_http.rs:526-576`）。
  - **注意**：协议过滤用入站探测到的协议；`/v1/models` 永远是 OpenAi，因此 **Responses 协议的路由不会出现在任何 `/models` 列表里**。空列表是合法 200（`{object:"list",data:[]}`）。
- `/v1/models/{id}`（`proxy_http.rs:64-73`，`proxy.rs:870-881`）：`GET /v1/models/{id}` 或 `/openai/v1/models/{id}`，读 `storage.list_channel_models()` + `models-cn.json`，构造 `{id,object,created,owned_by,context_window,max_input_tokens:null,max_output_tokens,specification_source,pricing}`；未开放 → 404 `model_not_found`（`proxy_http.rs:424-435`）。

### 3.6 模型名归一（`proxy.rs:883-888`）

- `extract_model(body, protocol)`（`proxy_http.rs:925-935`）：解析 JSON 顶层 `model`，并防御性剥离 Claude Code `[1m]` 后缀（`strip_long_context_suffix`，`proxy_http.rs:917-923`）。
- `routing_model_id`（`model_catalog.rs:160-165`）：`find` 命中 → 目录规范 ID；未登记原样返回。`find` 内部先 `canonical_key`：去厂商前缀（`rsplit('/')`）+ 小写 + `model-catalog.json` 的 alias 表（`model_catalog.rs:94-112`）。
- 日志三元组：`public_model` = 客户端原始名，`virtual_model` = 归一后的规范 ID，`upstream_model` = 路由候选的 `upstream_model`。
- 路由匹配只做**精确匹配**，不解析别名（`proxy_routing.rs:33-36` 注释与实现）。

### 3.7 客户端身份、会话与限流（`proxy.rs:839-917`）

- `extract_agent_session(headers)`（`proxy.rs:122-124` → `agent_session_identity::from_http_headers`）：按 `AgentIdentityAdapter` registry 顺序尝试；标记头 `x-flowlet-client` 门控特定 adapter；产出 `{agent_type, session_id, parent_session_id}`。
- **Node Host 新增的旁路观测（Rust 无对应实现，非等价项）**：识别出 `(agent_type, session_id)` 后，Node Host 还会从已经读入内存的请求体派生会话标题/项目路径（`proxy/session-derive.ts`）并 upsert 到 SQLite `agent_session_metadata`，供 Docker 会话管理展示；写入失败只 warn，不影响转发。规则与存储契约见 [docs/agent-session-metadata.md](../agent-session-metadata.md)。它不解析/剥离任何新 header，也不改变转发报文与请求日志字段。
- **token 身份**（`proxy.rs:891-892`）：`identify_client` 命中即 `token_client_id="default"`；只用于限流 key 与高级规则 `match_client_id`，**不写日志/用量**。
- **客户端身份**（`proxy.rs:894-899`）：`load_ua_rules(config_path)`（每次请求热读 `config.json`；`proxy_http.rs:891-910`：用户规则优先，按 id 补齐内置规则）→ `identify_client_agent`（`agent_identity_adapter.rs:44-63`）：`x-flowlet-client` 优先（值小写为 id，展示名取 plugin registry），否则 UA 子串匹配；不命中 → `(None, Some("未知"))`。
- **限流**（`proxy.rs:901-917`）：只有识别到 token 时才消费；失败 429 + `Retry-After`，body `{"error":"rate limit exceeded"}`。`RateLimiter`（`rate_limiter.rs`）：每 client 一个桶，容量 = rpm，补充速率 = rpm/60 每秒（整秒粒度），`retry_after` = `ceil(1/refill)`。

### 3.8 路由候选匹配（`proxy.rs:919-942` → `proxy_routing.rs:36-146`）

1. `public_model` 为空或退役聚合名（`flowlet-pro`/`flowlet-flash`）→ 空候选。
2. **高级规则优先**（`find_matching_rule`，`proxy_routing.rs:172-211`）：enabled 规则按 `(priority,id)` 排序，依次匹配 `match_client_id` / `match_model` / `match_protocol`（为 None 表示不限），目标账号必须 enabled；命中则返回**单候选**（`id=rule-{rule.id}`），允许跨规范模型映射。
3. 否则遍历路由行：`enabled` + `virtual_model_id == public_model` + 规范身份一致（`route_identity_is_consistent`，`proxy_routing.rs:29-31`）+ 账号可路由（enabled + Key 非空 + healthy，`proxy_routing.rs:79-87`）；协议不匹配 → `protocol_skipped`，匹配 → `matched`。
4. 排序（`sort_route_candidates`，`proxy_routing.rs:148-170`）：`route.priority` → `channel_id` → `upstream_model` → `account.priority` → `account.created_at`。
5. **分组轮询**（`proxy_routing.rs:112-138`）：按 `(public_model, protocol, channel_id, upstream_model)` 分组（同 priority 连续段），每组用 `round_robin` 游标 `rotate_left(cursor % len)` 后游标 +1。分组与分组之间严格按 priority 顺序 fallback。
6. `scores` 参数当前**不参与**默认路由（`let _ = scores`）；`rank_candidates_by_score` 是 dead code（`#[allow(dead_code)]`）。

### 3.9 降级节点（skipped）与无候选错误（`proxy.rs:936-1120`）

- `skipped_for_protocol` 只在**没有任何匹配候选**时才保留（有匹配时候选属于别的协议，与本请求无关，不展示）。
- 图片请求（`model_input_capabilities::request_uses_image`，`model_input_capabilities.rs:201-232`）时，只在**有匹配候选**时做能力分区（`partition_image_capable_candidates`，`model_input_capabilities.rs:235-256`），未知能力按不支持。
- 两类 skipped 分别调用 `record_skipped_route_logs`（`proxy.rs:2049-2114`）落**非终态"已跳过"**日志：`status=NULL`、`upstream_url=NULL`、`req/res` 捕获=NULL、`latency_ms=0`、`duration_ms=0`、`attempt_seq=组内下标`、`fallback_count=下标+1`、`is_last_attempt=false`、`route_reason=protocol_unsupported|input_modality_image_unsupported`。
- 无候选时错误映射（`proxy.rs:1020-1120`），优先级：`protocol_unsupported`（404 `model_protocol_unsupported`）→ `image_input_unsupported`（400 `model_input_modality_unsupported`）→ 无可用账号（404 `no_available_account`）→ 无开放模型（404 `no_available_model`）→ 否则 404 `model_not_exposed`；OpenAI/Responses 用 `{error:{message,type,code}}`，Anthropic 用 `{type:"error",error:{type,message}}`；同一次请求写入一条终态日志（`fallback_count=skipped_total`、`attempt_seq=skipped_total`、`is_last_attempt=true`、含 req/res 捕获）。

### 3.10 Files pin（Files API 的"引用即绑定"）

- 仅在 Anthropic + `request_references_files_api(headers)`（`proxy.rs:754-763`，`anthropic-beta` 中含 `files-api-` 前缀）时生效（`proxy.rs:958-975`）。
- 绑定账号由 `files_account(channels, accounts)`（`proxy_routing.rs:266-296`）确定性选出：`channel.enabled && supports_files_api && supported_protocols 含 Anthropic`，账号 `account_is_routable`，按 `(channel.id, account.priority, account.created_at, account.id)` 全序取第一个。
- 若绑定账号在候选里 → 收窄到它，`route_reason=files_api_pinned`；不在候选里 → 不干预，`route_reason=files_api_pin_missed`（注意：收窄前候选已按常规逻辑算好）。

### 3.11 单次 attempt 的上游请求构造（`proxy.rs:1142-1236`）

对每个候选：

1. `effective_model = candidate.upstream_model`；`rewrite_model(body, effective_model, protocol)`（`proxy_http.rs:1374-1427`）：先尝试**文本替换**两种 `"model":"x"`/`"model": "x"` 写法（保留原始字节），失败再整体重序列化（serde 默认 BTreeMap → key 字典序）。
2. `ensure_reasoning_content_passback(routed_body, effective_model, protocol)`（`proxy_http.rs:1429-1471`）：仅 `protocol==OpenAi` 且 `is_deepseek_reasoning_model(effective_model)`（`proxy_http.rs:1473-1485`，规范名 ∈ `deepseek-v4-flash`/`deepseek-v4-flash-vision-exp`/`deepseek-v4.1-flash`/`deepseek-v4-pro`）时，为 `messages[]` 中所有缺失 `reasoning_content` 的 `assistant` 消息插入 `""`；有修改才整体重序列化。
3. Base URL：账号级覆盖（`effective_openai_base_url` / `effective_anthropic_base_url`，`config.rs:652-676`）优先，空则 `channel.base_url_for(protocol)`（Responses 复用 OpenAI base，`config.rs:532-538`）。
4. URL：`openai_path_strips_v1(channel.id)`（仅智谱等适配器声明）且协议为 OpenAI/Responses → `build_upstream_url_without_openai_v1`（去 `/openai`、`/v1` 前缀）；否则 `build_upstream_url`（`proxy_http.rs:598-652`）：OpenAI/Responses 去 `/openai` 入口前缀 + `strip_duplicate_v1`；Anthropic 去 `/anthropic` 前缀 + `strip_duplicate_v1`；保留 `path_and_query`（query 原样）。
5. 出口客户端：`upstream_proxy::model_forwarding_client(account, state.client, &upstream_url)`（`upstream_proxy.rs:252-290`）→ `(client, upstream_proxy_used, retry_proxy_connect)`；配置非法 → `ProxyConfiguration` 错误（该候选直接失败并记日志）。
6. 超时：`channel.timeout_seconds.unwrap_or(state.upstream_timeout_seconds)`（默认 120s，`services.rs:12`）。
7. 头：`apply_request_headers(builder, headers, account.api_key, protocol, auth_strategy)`（`proxy_http.rs:656-703`）：
   - 跳过 hop-by-hop（`is_hop_by_hop`）、`host`、`content-length`（body 已改写，交给客户端重算）、`authorization`、`x-api-key`、`x-flowlet-client`、`x-flowlet-session`；
   - `anthropic-beta` 过滤掉 `context-1m-2025-08-07`（保留其它 beta，空则整头丢弃）；
   - 其余原样转发（含 UA、`x-deepseek-harness-session-id`——**必须透传**）；
   - 最后按渠道 `auth_strategy_for(protocol)` 写入 `Authorization: Bearer <api_key>` 或 `x-api-key: <api_key>`（`api_key` 为空则不写鉴权头）。
8. `builder.body(routed_body).build()` → **唯一的最终上游 Request**；随后从它捕获 `req_headers_json`（脱敏/去 hop-by-hop）与 `req_body_b64`（base64、按 `max_body_bytes` 截断 UTF-8）——这是 `AGENTS.md` §9 "必须捕获最终上游请求"的实现点（`proxy.rs:1201-1208`）。

### 3.12 上游执行、状态与降级（`proxy.rs:1238-1508`）

- 执行：`tokio::time::timeout(timeout, upstream_proxy::execute_model_request(...))`；`execute_model_request`（`upstream_proxy.rs:291-311`）在 `retry_proxy_connect` 时对**连接阶段失败**重试一次（150ms backoff）；超时 → `ProxyForwardError::Timeout{phase:"响应头"}`。
- 成功响应：
  - 记 TTFB = `send_at.elapsed()`（收到响应头）。
  - `status.is_success()` 且账号曾有 `account_deactivated`/`api key is disabled` → 恢复 healthy（`mark_account_credential_recovered`，`proxy.rs:89-117`）。
  - `401` → 标记 invalid（`mark_account_credential_invalid`），**本请求不回退**，把 401 透传给客户端。
  - `should_try_next_status(status, vendor)`（`proxy_routing.rs:300-309`）= 429 / 5xx / (deepseek 且 402)；若还有下一候选 → 写一条 `retryable_status` 的 fallback 日志（`is_last_attempt=false`、`attempt_seq=fallback_count`）并 `continue`。
  - `should_inspect_fallback_body(status)`（400/402/403）→ 缓冲 body 逐项探测（`proxy_routing.rs:317-368`）：
    - `account_deactivated`（JSON `error.code` 或 message 含 "api key is disabled" 或原文含）→ 标记 invalid；有下一候选 → fallback 日志（带 res header/body 捕获）并 continue；
    - `quota exceeded`（多种文案）→ 有下一候选 → fallback；
    - `product is not activated`（`error.code=invalid_parameter_error` 且 message 含）→ 有下一候选 → fallback；
    - 否则按 buffered 成功路径返回（`build_buffered_response`），日志 `route_reason` 经 `enrich_upstream_error_log` 从 `direct|auto` 改为 `upstream_error`，`error_message` 为 `upstream status N`。
  - 其它状态 → `build_response`（流式或缓冲）。
- 失败（网络/超时/代理配置）：有下一候选 → fallback 日志（`route_reason` = `timeout|network_error|upstream_proxy_configuration_error` + `_fallback`，`status=NULL`）；最后一个候选 → 终态日志（`status=502`、`ttfb_ms=NULL`）并记住 `last_network_error`；循环结束 `Err` → 入口返回 502 纯文本。
- `route_reason` 取值：`direct` / `auto` / `fallback_success` / `files_api_pinned` / `files_api_pin_missed` / `retryable_status` / `credential_disabled` / `quota_exceeded` / `product_not_activated` / `upstream_error` / `timeout` / `network_error` / `upstream_proxy_configuration_error`（+ `_fallback` 变体）/ `stream_cancelled` / `stream_timeout` / `stream_error` / `protocol_unsupported` / `input_modality_image_unsupported` / `files_api*`。

### 3.13 缓冲响应转发（`proxy.rs:1730-1905` 尾段、`1907-1942`）

- `read_buffered_body`（`proxy.rs:1712-1728`）：**整个 body 一个绝对超时**（120s）。
- 计算 duration；`prepare_captured_res_body`（`proxy_http.rs:1040-1049`）：按 `content-encoding` 解压（gzip/x-gzip/deflate/br）→ 截断到 UTF-8 边界 → base64；空 body → NULL。
- 非流式路径（`build_response` 尾段）：写日志 → `record_response_usage`（`extract_response_usage`，非 SSE JSON）→ 原样返回 body + 响应头（去 hop-by-hop，保留 content-encoding/content-length）。
- 响应头复制：`copy_response_headers`（`proxy_http.rs:727-734`）只去掉 hop-by-hop；`set-cookie` 等多值头全部保留（`HeaderMap` 多值）。
- `enrich_upstream_error_log`：4xx/5xx 时补 `error_message` 并按需改 `route_reason`。

### 3.14 流式响应转发（`proxy.rs:1776-1863`、`2179-2438`）

判定条件只有 `content-type` 包含 `text/event-stream`（`is_streaming_response`，`proxy_http.rs:588-594`）。

1. **先写一条"未完成"日志并 await**：`record_request_log_and_wait`（`proxy.rs:2116-2123`）——`duration_ms=NULL`，前端据此判断"请求进行中"。这条路会**延迟响应开始**，属于必须保留的时序契约。
2. 构造 `capture_timed_stream(upstream.bytes_stream(), tx_done, capture, send_at, content_encoding, idle_timeout, activity_permit)`（`proxy.rs:2179-2292`）：`unfold` 状态机逐块处理——
   - TTFT：累计 ≤64KiB 探测窗口（`MAX_TTFT_PROBE_BYTES`），`contains_sse_output_token`（`usage.rs:186-203`，只看真实输出 delta/text，不算 metadata）首次为真时记录；
   - 响应体捕获：`capture_res_body` 时累计 ≤`max_body_bytes` 的**原始**字节（不截断已累计部分，超限后不再追加）；
   - usage：`usage_body_buf` ≤1MiB（超限清空并关闭）+ `StreamUsageAccumulator` 增量解析（不占内存随响应增长）；
   - 终止事件探测：保留尾部 ≤512 字节滑动窗口，匹配 `data: [DONE]`、`data:[DONE]`、`"type":"message_stop"`、`event: message_stop`、`"type":"response.completed"`（`proxy.rs:2141-2172`）；
   - 首行/末行/行数统计（日志用）；
   - **每块一个空闲超时**（120s 无数据 → 报 `stream_timeout` 并向客户端抛 IO 错误断流）。
3. Anthropic 兼容修复（`proxy_anthropic_compat::normalize_content_block_starts`，`proxy.rs:1797-1800`）：仅 `protocol==Anthropic` 且响应 `content-encoding` 缺失或为 `identity` 时启用；按 `\r`/`\n` 分行处理，`data:` 后 JSON 中 `type=content_block_start` 的 `content_block` 若 `type=thinking` 缺 `thinking` → 补 `""`、`type=tool_use` 缺 `input` → 补 `{}`；**超过 64KiB 的行整行原样透传**；流末尾不完整行原样透传不修复；错误照常传播。捕获发生在此修复之前 → 日志保留上游原文（`AGENTS.md` §5）。
4. 返回给客户端前，若启用修复则删除 `content-length`（长度可能变化）。
5. `tx_done` 的 `StreamDone` 汇总：`duration_ms`、`ttft_ms`、`res_body_b64`、`usage`、`usage_status`、`usage_source`、`error_message`、`route_reason`。
6. 流结束/断开：`Drop for TimedStreamState`（`proxy.rs:2391-2409`）——已发终止事件视为完整（`success`），否则记 `stream_cancelled`；`send_stream_done`（`proxy.rs:2294-2360`）做 usage 完整性判定：
   - `complete = success || 已见终止标记 || 出现过正 output_tokens 的 usage`；不完整时清空 `output_tokens`/`total_tokens` 并标记 `partial`；
   - `usage_source`：`upstream_response`（正常结束）/ `upstream_stream_recovered`（截断但有完成证据）/ `upstream_stream_partial`。
7. 后台 task：`update_stream_log`（`proxy.rs:2413-2438`）按 `(request_id, is_last_attempt=1, is_stream=1)` 回填 `ttft/duration/res_headers/res_body/error/route_reason`；随后 `record_parsed_usage`。
8. `activity_permit` 随流状态存活到流真正结束（Windows 防待机，`power.rs`）。

### 3.15 Files API 完整流程（`proxy.rs:571-749`）

1. 先生成日志骨架：`request_type="files"`、`route_reason="files_api"`、模型三列 NULL、协议 anthropic、`latency_ms=0`、`attempt_seq=0`；Header 捕获按配置，**请求体不捕获**（multipart 最大 128MiB）。
2. 读 body 上限 `FILES_UPLOAD_LIMIT_BYTES = 128 MiB + 1 MiB`；超限 → 413 + Anthropic 错误信封 `files_upload_too_large`（注意：`to_bytes` 的其它错误也会落此分支）。
3. 账号：`files_account`；无 → 503 `files_account_unavailable`。
4. URL：账号 anthropic 覆盖或渠道 anthropic base + `build_upstream_url`；出口客户端同样走 `model_forwarding_client`（**但此处错误会直接 `Err`，不 fallback**）；超时用渠道/全局；头处理同模型路径。
5. 执行 → 记录状态/ttfb/duration/响应头/响应体捕获 → 上游状态与 body **一律原样透传**（错误原文是客户端配额自愈的依据；`delete` 依赖 `type:"file_deleted"`）；非 2xx 仅补日志字段，不改响应。
6. 不做模型改写、不记 usage、不重写路径（客户端路径就是上游路径）。

### 3.16 捕获、日志与用量落库（`storage_usage.rs`、`request_capture.rs`）

- 每次 attempt（含 skipped、无候选终态）都会 `insert_request_log`（`storage_usage.rs:914-1022`）：
  1. 取捕获写锁 → 开 SQLite 事务（固定锁序：writer → DB，防止与 segment 整理死锁）；
  2. 插入 `request_logs` 行（`req_body_b64`/`res_body_b64` 列**恒为 NULL**，body 只在捕获帧里）；
  3. 插入 `request_capture_refs`（state=`pending`）；
  4. `capture_store.append_locked(record)` 追加 `.flcap` 帧；成功 → ref 置 `ready` + pointer 字段；失败 → ref 置 `failed` + reason（**只 warn，不影响主链路**）；
  5. 提交事务。
- `.flcap` 帧格式（`request_capture.rs:13-17`、`180-220`）：`"FLCAP001"`(8) + `version u16 LE`(1) + `reserved u16 LE`(0) + `compressed_len u64 LE` + `raw_len u64 LE` + `sha256(raw)`(32) + `zstd(raw, level=3)`；头部共 **60 字节**。
- 目录（`request_capture.rs:377-400`）：有 Agent 会话 → `sessions/<agentType>/<YYYY>-<MM>/<sha256(agentType\0sessionId)[:32]>/NNNNNN.flcap`；否则 `unassigned/<YYYY-MM-DD>/<sha256(requestId)[:2]>/NNNNNN.flcap`；按 32MiB 轮转（`select_segment`，`request_capture.rs:418-451`）。
- 读取（`request_capture.rs:331-375`）：seek offset → 校验 magic/version/length/checksum → zstd 解压 → 再校验 raw len + sha256 → JSON 反序列化 → `format_version` 一致。
- 流式补写：`update_request_log_timing`（`storage_usage.rs:1804-1864`）按 request_id + `is_last_attempt=1` + `is_stream=1` 更新，且当存在 capture ref 时把 `res_body_b64` 置 NULL（body 永远不在 SQLite）。
- usage：`record_parsed_usage`（`proxy.rs:2000-2036`）→ `spawn_blocking` → `upsert_usage_record_with_metadata`（`storage_usage.rs:2805+`）：非 `complete` 不算成本；`complete` 时当场按内存价格表估算 `estimated_*`；成本匹配失败留 NULL 由后续 recalc 补。
- usage 捕获口径（`usage.rs`）：
  - 非流式：顶层 `usage` / `/message/usage` / `/response/usage`；
  - OpenAI 形状：`prompt_tokens|input_tokens` 优先，缓存读 `effectiveCachedTokens|prompt_tokens_details.cached_tokens|input_tokens_details.cached_tokens|cache_read_tokens|cached_tokens`，未缓存 = 输入−缓存；
  - Anthropic 形状（出现 `cache_read_input_tokens`/`cache_creation_input_tokens`）：`input_tokens` 优先为未缓存基值，`input_tokens = 未缓存(含 cache write) + cache_read`，`input_uncached_tokens = 输入+cache_creation`，`input_cache_write_tokens = cache_creation`；
  - `total_tokens` 优先读上游，否则输入+输出；
  - 流式增量：逐行 `data:` JSON，遇 `[DONE]`/`message_stop` 记终止证据；每次带 `usage` 合并；`message_start` 只有输入无输出 → 不算完整。
- body 清理（`storage_tasks.rs`）：保留 `body_retention_days`（只清理已有完整 usage 的记录）+ 体积超 `body_max_size_mb` 时按 `body_prune_ratio` 清最老；清理会重写/删除 `.flcap` segment（`rewrite_segment_locked`/`remove_segment_locked`）。
- 日志失败策略：所有落库调用只 `tracing::warn!`；**唯一例外**是流式首条日志 `record_request_log_and_wait`（await，但错误也只 warn）。

### 3.17 生命周期、并发与热更新

- `ProxyController`（`proxy.rs:232-496`）：`inner: Mutex<ProxyRuntime{shutdown: Option<oneshot::Sender>, bind_addr, started_at}>`；`start*` 在锁内判断 `shutdown.is_some()` → `AlreadyRunning`；绑定监听 → 写状态 → spawn axum serve → 返回；`stop` take sender 并 send，清 `started_at`；已停止再 stop → `NotRunning`。
- 幂等在 `FlowletServices::start_proxy`（`services.rs:100-104`）与 `commands/proxy.rs::start_proxy` 再次短路。
- 捕获配置：`Arc<Mutex<LogCaptureConfig>>`，每个请求开头快照一次（`proxy.rs:281-290`）——同请求内 Header/Body/usage 口径一致，设置页保存后下一个请求生效。
- 运行时配置：`RuntimeConfigStore` 原子快照，一次请求只读一个 revision（`runtime_config.rs`）。
- bind 地址/端口修改**不热重绑**：`set_proxy_bind_config` 只更新内存与 SQLite，重绑由前端重启代理完成；`default_client_token` 每请求热读（`proxy.rs:853-857`）。
- 凭证状态：`credential_status` 写入 SQLite + 同步更新内存快照（`update_if`），下一请求立即可见。
- `ActivityTracker`：代理开始转发前 `track()`，非流式随函数返回释放，流式随流状态释放。

---

## 4. 必须保持的行为契约清单（逐条核对）

### 4.1 `AGENTS.md` §5 受控例外 → 源码定位（完整性核对）

| # | `AGENTS.md` §5 条目 | 源码实现 | 迁移判定 |
|---|---|---|---|
| 1 | 不做跨协议转换；不随意改写请求/响应结构 | 无转换层；改写仅限 `rewrite_model` 的 `model` 字段与下文受控例外 | **必须保持** |
| 2 | Anthropic 未压缩 SSE `content_block_start` 的 `thinking`/`tool_use` 补字段；压缩/不完整/超 64KiB 行原样；日志保留原文 | `proxy_anthropic_compat.rs:72-114`（`normalize_content_block_starts`、`MAX_LINE_BYTES=64KiB`、`normalize_line`）；调用点 `proxy.rs:1784-1800`；捕获在修复前（`capture_timed_stream` 先包，修复后包） | **必须保持**（P0） |
| 3 | DeepSeek 推理模型 `reasoning_content` 回填；仅 OpenAI chat/completions；按 canonical 模型门控；只追加不改写 | `proxy_http.rs:1429-1485`（`ensure_reasoning_content_passback`、`is_deepseek_reasoning_model`）；调用点 `proxy.rs:1152-1155` | **必须保持**（P0） |
| 4 | Responses 仅无状态透传；非 POST 拒绝 | `proxy.rs:811-837`（`is_responses_path` + 405 `responses_unsupported_method`） | **必须保持** |
| 5 | Anthropic Files API 绑定单一账号；`files-api-*` beta 收窄候选；上游 status/headers/body 原样 | `proxy.rs:571-749`、`proxy.rs:958-975`、`proxy_routing.rs:266-296` | **必须保持**（P0） |
| 6 | 上游出口可按账号选择；代理失败不得静默改直连 | `upstream_proxy.rs:252-311`（`model_forwarding_client`、`execute_model_request`）；调用点 `proxy.rs:1178-1247`、`680-726` | **必须保持** |
| 7 | `x-flowlet-client` / `x-flowlet-session` 识别后剥离；`x-deepseek-harness-session-id` 原样透传 | `proxy_http.rs:656-703`（`apply_request_headers`；剥离名单含 `x-flowlet-*`，DSH 原生头不在名单）；`agent_session_identity.rs:1-27` | **必须保持** |
| 8 | 入站模型名按 `model-catalog.json` 归一后才匹配路由；未登记原名透传；日志 `public_model` 保留原值 | `model_catalog.rs:160-165`（`routing_model_id`）；`proxy.rs:883-888` | **必须保持** |
| 9 | `/models` 只暴露规范 ID、按协议过滤、空列表合法 | `proxy_http.rs:437-524` | **必须保持** |
| 10 | `virtual_model_id` 对外名、`upstream_model` 仅转发前替换 | `proxy.rs:1150-1151`、`proxy_http.rs:1374-1427` | **必须保持** |

**完整性判定**：任务书给的清单（SSE 透传/64KiB、压缩捕获解压、Anthropic 补字段、DeepSeek 回填、Responses 无状态、Files 单账号、错误透传、降级 attempt、日志旁路、幂等 start/stop、无账号也监听）**覆盖了 §5 的主体**，但**遗漏了以下源码中真实存在的受控改写**（迁移时必须一并实现，否则行为不等价）：

| # | 遗漏项 | 源码 | 说明 |
|---|---|---|---|
| A | `[1m]` 后缀剥离 | `proxy_http.rs:917-935` | Claude Code 长上下文后缀，`extract_model` 时防御性剥离 |
| B | `anthropic-beta` 过滤 `context-1m-2025-08-07` | `proxy_http.rs:705-725` | 转发前剔除该 beta，其余保留；过滤后为空则整头丢弃 |
| C | 智谱 OpenAI 路径去 `/v1` | `proxy_http.rs:631-639`、`channels_config.rs:20-23` | 仅适配器声明 `strips_openai_v1_path` 的渠道 |
| D | URL 去重 `/v1`（base 自带 /v1） | `proxy_http.rs:641-652` | qwen token plan / dashscope / moonshot 等 |
| E | 连接失败仅重试一次（走显式代理的客户端） | `upstream_proxy.rs:291-311` | 150ms 退避，计入同一外层超时 |
| F | 请求体无上限缓冲（模型路径） | `proxy.rs:799-801` | `usize::MAX`；Files 路径才 129MiB 上限 |
| G | 响应头/请求头 hop-by-hop 剥离清单 | `proxy_http.rs:736-748` | 两侧都剥 |
| H | `Content-Length` 丢弃与重算 | `proxy_http.rs:664-670` | 请求侧永远丢弃；流式 Anthropic 修复时响应侧也删 |
| I | CORS 全套头 + 预检 204 | `proxy_http.rs:14-50` | 所有响应（含错误） |
| J | 客户端 token 限流（600 rpm） | `proxy.rs:901-917` | 仅 Host/带 token 时生效 |
| K | 凭证状态机（401 → invalid、deactivated 临时恢复、成功恢复） | `proxy.rs:50-117`、`1274-1279`、`1318-1356` | 跨请求状态 |
| L | 图片输入能力过滤（未知能力不放行） | `model_input_capabilities.rs:201-256` | 与 `AGENTS.md` §8 的"真实能力"一致 |
| M | `/models/{id}` 详情接口（models-cn 价格/规格） | `proxy_http.rs:104-435` | 容易被当成"非核心"漏掉 |

### 4.2 `AGENTS.md` §9 日志与捕获逐条核对

| §9 条目 | 实现 | 备注 |
|---|---|---|
| 脱敏仅由 `log_capture.redact_sensitive_headers` 控制，默认关闭 | `config.rs:2001-2049`；`extract_log_capture`（`proxy_http.rs:799-844`）；`sanitize_headers`（`proxy_http.rs:946-966`） | 关闭时原样保存/展示；开启时 `authorization/x-api-key/cookie/set-cookie/x-auth-token` → `[redacted]`（header 名大小写不敏感） |
| 有候选时每条 attempt 必须捕获"完成 URL、模型、鉴权改写后的最终上游 Request" | `proxy.rs:1201-1208` | 入站报文绝不用于日志 |
| 输入模态/协议被过滤的候选记非终态降级节点，不伪造 HTTP 状态/URL/捕获 | `proxy.rs:985-1018`、`2049-2114` | `status=NULL`、`upstream_url=NULL`、`req/res=NULL` |
| 请求/响应 body 捕获受配置控制 | `capture_headers`/`capture_body`（`proxy.rs:1545-1578`）、`capture_timed_stream`、`prepare_captured_res_body` | 统一 `max_body_bytes`（默认 1MiB）+ UTF-8 边界截断 |
| 新增字段考虑体积 | body 只在 `.flcap` 帧（zstd）里，SQLite 恒 NULL；`RequestCaptureRecord` 字段固定 | — |
| 错误可读 + 底层日志 + 结构化错误写请求日志 | `tracing::error/warn` + `RequestLogInput.error_message/route_reason` | 网络错误对 OpenAI 渠道保留 cause chain（`upstream_proxy.rs:312-335`） |
| 无候选错误码区分五种 | `proxy.rs:1020-1062` | `no_available_account`/`no_available_model`/`model_not_exposed`/`model_protocol_unsupported`/`model_input_modality_unsupported` |

### 4.3 源码存在、但 `AGENTS.md` 未写的行为契约（迁移不可漏）

1. **请求头剥离的精确名单**：`host`、`content-length`、`authorization`、`x-api-key`、`x-flowlet-client`、`x-flowlet-session` + hop-by-hop；**DSH 原生会话头必须透传**。
2. **响应侧流式判定只认 `text/event-stream`**；非 SSE 的 `text/event-stream` 单 JSON 消息按 buffered 处理（日志与 usage 兼容）。
3. **`/health` 不需要鉴权**（Host 模式），其余路径全部需要。
4. **`/v1/models` 不暴露 Responses 协议路由**（协议过滤基于入站探测）。
5. **模型 `enabled` 渠道不被主路由强制**：`match_candidates` 与 `collect_model_entries` 均**不检查 `channel.enabled`**；只有 Files 绑定与 `/models/{id}` 详情检查。迁移时原样保留，否则可能出现"禁用渠道后模型消失/仍在路由"的行为差异。
6. **无候选错误判定顺序**（协议 → 图片 → 账号 → 模型 → 模型未开放）。
7. **429/5xx/deepseek 402 才按状态码降级；400/402/403 才读 body 探测**；401 不降级但标记账号。
8. **`skip` 日志与真实 attempt 共享 `request_id`，`attempt_seq` 连续**；`fallback_count` 语义 = 之前尝试次数。
9. **流式首条日志先写后转发（await）**；其余落库 fire-and-forget。
10. **`request_logs` 的 body 列恒 NULL**（`.flcap` 是唯一 body 存储），读取走 `request_capture_refs` + `RequestCaptureStore::read`。
11. **`.flcap` 的 zstd 压缩级别 3、sha256 校验、60 字节头、32MiB 分段、按 session 分目录**——跨语言二进制契约。
12. **限流 key 用 token 身份而非客户端身份**（同一 token 多个 UA 共桶）。
13. **`public_model` vs `virtual_model` vs `upstream_model` 三列语义**（日志/用量/UI 都依赖）。
14. **成本估算在 usage upsert 当场完成**（complete 才算），不是查询时算。

### 4.4 对任务书清单的修正（重要）

| 任务书/常见假设 | 源码事实 | 结论 |
|---|---|---|
| "捕获时解压（gzip/deflate/br/**zstd**）" | `decompress_for_capture`（`proxy_http.rs:1004-1020`）只支持 `gzip`/`x-gzip`/`deflate`/`br`，**不支持 zstd**；zstd 只用于 `.flcap` 帧和 DSH 会话文件 | **修正**：zstd 是捕获**文件格式**，不是响应体解压编码 |
| "捕获用 Transform 流旁路**采样**" | 没有采样逻辑。捕获是**配置开关 + 单请求上限**（`max_body_bytes` 1MiB、usage 1MiB、TTFT 64KiB）；每个请求全量按上限保留 | **修正** |
| "日志旁路失败不影响主链路" | 基本正确，但流式路径的**首条日志是 await 的**（会延迟响应开始），只是失败被 warn 吞掉 | **补充** |
| "SSE 64KiB data 行处理" | 只存在于 **Anthropic 兼容修复**；OpenAI/Responses 透传**不按行处理**，也没有 64KiB 限制 | **限定范围** |
| "压缩响应不解压" | 正确：`reqwest` 以 `default-features=false` + `json,rustls-tls,stream` 构建，**无自动解压**；客户端收到原始压缩字节 | **确认** |
| "错误透传" | 模型路径：上游 4xx/5xx 会先被**降级探测消费**（400/402/403），不作为终态透传；能被降级的响应 body 不会给客户端。Files API 才严格原样透传 | **需限定** |
| "`/v1/files` 按渠道能力绑定" | 正确，且**仅 Anthropic 入口**；OpenAI 入口同名路径不识别 | **确认** |

---

## 5. Node 等价实现设计（明确结论）

### 5.0 一句话结论

> **入站 `node:http`（不用 fastify/express）；上游 `undici`（不用 `fetch`）；SSE 用 `stream.pipeline` 从上游 body 直连 `res` 保背压；请求体 JSON 只做 Rust 同款最小改写；捕获/日志/用量/`.flcap`/SQLite 放同一个 DB `worker_thread`（`node:sqlite` 单连接优先、better-sqlite3 回退）；`.flcap` 用 Node 内置 zstd。**

### 5.1 运行拓扑（建议）

- **一套无框架依赖的 `@flowlet/proxy-core` 包**（纯 Node，不 import Electron）：桌面主进程与 headless Host 共用。
- **HTTP 监听 + 上游转发在主线程**：全是 I/O 等待，CPU 只在 JSON 解析/字符串拷贝；参考 Rust 也是同一 tokio runtime 服务全部请求。
- **一个专职 DB worker（`worker_thread`）**：独占**一个** SQLite 连接 + `.flcap` 写入器 + 清理任务。原因：
  - `node:sqlite`/`better-sqlite3` 都是**同步 API**；在主线程每请求做 1–3 次事务 + zstd + sha256 会阻塞事件循环，直接表现为 SSE 卡顿；
  - Rust 用 `spawn_blocking` + `Mutex<Connection>` 达到同样效果（串行化写、不阻塞 async 线程）；
  - 单连接单写者保持与 Rust 相同的并发模型，零 `SQLITE_BUSY`。
- 主线程与 worker 的协议：`{type, payload, id}` 消息 + 有序队列；读路径（`/models/{id}` 需要 `channel_models`/`models-cn`、历史日志详情）通过 RPC await；写路径 fire-and-forget（流式首条日志需 await ack）。
- 若压测发现主线程仍被 JSON/捕获拖慢：升级方案是把整个 proxy 移到 `utilityProcess`，成本是配置快照同步；**spike 先用主线程 + DB worker**，不要一上来就过度拆分。
- 生命周期所有者在主进程：`startProxy()`/`stopProxy()` 幂等；自动启动/重启仍由前端触发（`AGENTS.md` §3）。

### 5.2 入站：`node:http`（结论：不用 fastify/express）

理由（针对"模型面"这一层，不是管理面）：

1. **必须字节级透传**：请求体要按原始字节缓冲（后面还要 JSON 改写、base64 捕获），响应体要原样回写（压缩字节、SSE 分块）。框架的 body parser/序列化器会介入。
2. **必须精确控制响应生命周期**：先 `writeHead`，再流式 `pipeline`，最后区分"正常结束/上游错误/客户端断开/空闲超时"。
3. **必须精确控制背压**：Node 的 `res.write()` 返回 `false` + `'drain'` 是最可靠的信号；`pipeline` 会自动 pause/resume 上游。
4. **hop-by-hop 头、重复头、大小写**都要人工处理，框架不会替你做对。
5. fastify 的优点（schema 校验、路由、插件）在模型面上全是负担；express 对流式/错误生命周期更弱。**管理 API（`core/web/commands.rs` 的 42 条白名单）可以另选 fastify**，但不要和模型面共用框架实例，避免 body 限制/超时配置互相干扰。

关键 server 配置（与 Rust 行为对齐）：

```ts
const server = http.createServer(handler);
server.requestTimeout = 0;          // 请求体读取不受 5min 默认限制（模型请求可很大）
server.headersTimeout = 0;          // 或 >= 渠道超时
server.keepAliveTimeout = 65_000;   // 略大于上游 keepAlive 60s
server.on('clientError', ...);      // 断连/解析错误只记日志，不崩溃
// handler 内：
res.setHeader(...); res.writeHead(status, headers); res.flushHeaders();
res.socket?.setNoDelay(true);       // SSE 低延迟
```

### 5.3 上游：`undici`（结论：不用 `fetch`；失败时回退 `node:https`）

- **绝不用 `fetch`**：WHATWG fetch 会**自动解压**并改写 `content-encoding`/`content-length`，无法满足"压缩响应原样透传"，也会破坏捕获口径。
- **`undici.request` 首选**：`dispatcher` 池化/keep-alive、`headersTimeout`/`bodyTimeout`、`AbortSignal`、body 异步迭代、`ProxyAgent`/`EnvHttpProxyAgent` 成熟。
- **必须验证**：`undici.request` 是否原样返回压缩 body 与 `content-encoding`（undici 的解压发生在 fetch 层，`request` 预期是 raw；spike A9 必须实测）。若发现解压，改用 `node:https`（永远不解压）。
- 连接池映射 Rust（`upstream_proxy.rs:229-237`）：
  - `keepAliveTimeout: 60_000`、`keepAliveMaxTimeout`、`connections` 默认；`connect: { timeout: 10_000 }`；
  - TCP keepalive 30s：undici 未直接暴露，可在自定义 `connect`/socket 事件里 `socket.setKeepAlive(true, 30_000)`（或接受差异，spike 记录）。
- 超时拆解见 §5.5（**不要**依赖 undici 的 `bodyTimeout` 直接等价，自己实现每块空闲计时器）。
- 代理：显式配置用 `ProxyAgent({ uri })`（且该 client 不复用系统代理）；系统代理 / `NO_PROXY` 需要**显式实现**（见 §5.11）。

### 5.4 SSE 透传与背压

```ts
// 上游响应已拿到、日志首行已 await 写入
res.writeHead(status, filteredHeaders);
res.flushHeaders();
res.socket?.setNoDelay(true);

const tap = new Transform({                       // 旁路：只观察，不缓冲
  transform(chunk, _enc, cb) {
    state.observe(chunk);                         // ttft/usage/resBody/terminal 探测
    cb(null, chunk);                              // 原样下发
  },
});

pipeline(upstreamBody, tap, res, (err) => {
  // 区分：err===undefined 正常；ABORT_ERR/EPIPE 客户端断开；ERR_STREAM_PREMATURE_CLOSE；
  // 自建 idle timer 触发时主动 destroy upstreamBody 并记 stream_timeout。
});
```

- `Transform` 必须**同步、有上限**（≤1MiB usage 缓冲、≤maxBodyBytes 捕获、512B 终止探测、64KiB TTFT 探测），且 `cb(null, chunk)` 立即回，不制造额外缓冲。
- 修复 Anthropic 起始块时**不要**用 Transform 逐行替换（会把行拼接放大）；按 Rust 同款"按行状态机、超 64KiB 行整行直通、尾部不完整行直通"实现，输出写入 `res` 前**删除 content-length**。
- 背压链路：`pipeline` 在 `res.write()===false` 时自动暂停上游读取，等价 Rust 的 hyper poll 背压。
- 客户端断开：`res.on('close')` / pipeline error → 若有终止标记视为完整，否则 `stream_cancelled`；`upstreamBody.destroy()`。
- 空闲超时：每收到一块 `resetIdleTimer()`；触发时 `upstreamBody.destroy(new Error(...))` → 与 Rust 一样令连接异常终止（客户端看到的是断连而不是干净 EOF）。
- 流结束回填：`updateRequestLogTiming`（worker RPC）+ `upsertUsage`（同一 task 顺序执行，等价 Rust 的 spawn task）。

### 5.5 超时 / 取消 / 重试语义映射

| Rust 行为 | 位置 | Node 等价 |
|---|---|---|
| 连接超时 10s | `upstream_proxy.rs:229-237` | undici `connect.timeout=10_000` |
| 响应头/整个请求首字节 120s（渠道可覆盖） | `proxy.rs:1186-1257` | 自建 `headersTimer`（从 send 开始）；超时 `AbortController.abort()` → `timeout` |
| 缓冲 body 整体 120s | `proxy.rs:1712-1728` | 自建 `bodyDeadline`，超时 abort |
| 流式**每块**空闲 120s（非总时长） | `proxy.rs:2272-2289` | 每 chunk `resetIdleTimer()`；不是总时长 |
| 显式代理连接失败重试一次（150ms）+ 同一外层超时 | `upstream_proxy.rs:291-311` | 捕获"headers 未收到前的连接类错误"，`setTimeout(150)` 后用同一 request 重发；只重试一次 |
| 非流式失败逐候选 fallback；流式只能 fallback 前（收到响应头即定） | `proxy.rs:1142-1508` | 同构循环：only before headers received |
| 取消传播 | hyper 流 drop | `AbortController` + `upstreamBody.destroy()` |

注意：`undici` 的 `headersTimeout`/`bodyTimeout` 语义与 Rust **不完全相同**（bodyTimeout 是两次 chunk 间隔还是整体，取决于版本），因此以自建计时器为准，undici 值设为 `0`（禁用）或足够大。

### 5.6 配置快照与热更新

- 等价 `RuntimeConfigStore`：`getSnapshot(): Readonly<Snapshot>` 返回**冻结对象**（channels/accounts/routes/rules），更新方构造新对象后原子替换引用；请求开头取一次。
- 捕获配置：`captureConfig` 每请求快照（等价 `ProxyAppState::capture_config`）。
- `config.json` 的 UA 规则：Rust **每请求读文件**（`load_ua_rules`）。Node 建议保留"每请求读文件"的等价行为（成本 = 1 次小文件 read；或用 mtime 缓存，但注意行为差异）。如果需要优化，加 mtime+size 缓存并在 spike 中记录差异。
- `default_client_token` 每请求热读（bind 配置内存对象）。
- bind 地址变更：不热重绑（与 Rust 一致），前端重启。
- 凭证状态更新：内存快照同步更新 + 异步 DB 写（Rust 是先 DB 后内存 `update_if`，Node 先内存可接受，崩溃窗口相同）。

### 5.7 请求体处理

- 模型路径：读完整个 body（Buffer）→ 只在需要时 JSON.parse（`extract_model`/`classify_request`/`request_uses_image`/`rewrite_model`/`reasoning_content`）。**不要**一次 parse 多次 —— 建议 parse 一次得到对象后复用（注意 Rust 实际 parse 了多次，语义等价即可）。
- `rewrite_model`：先做文本替换（两种空格写法，保留原始字节与键序），失败再 `JSON.stringify`，且**必须递归按键字典序输出**以贴近 serde_json BTreeMap 行为（否则与 Rust golden 的字节对比会有差异；语义不受影响，但前缀缓存/对拍会受影响）。
- `reasoning_content`：只对 OpenAI 协议 + DeepSeek 规范模型；只给缺失字段的 assistant 追加 `""`；已有值（含 null）不动；有修改才重序列化。
- 请求头：复制时**统一小写化**再写日志（Rust `HeaderMap` 迭代为小写名），但发给上游时保留 Node 默认写法即可（HTTP/1.1 头名大小写不敏感）；重复头在日志里"后者覆盖"以匹配 Rust `serde_json::Map::insert` 行为；响应转发则必须保留全部重复头（尤其 `set-cookie`）。
- `content-length`：请求侧永远丢弃，由客户端按最终 body 重算（undici 对 Buffer body 自动设置）；响应侧缓冲路径保留上游值，流式修复路径删除。

### 5.8 捕获与落库（DB worker）

- worker API（示例）：`insertRequestLog(log)`, `updateRequestLogTiming(...)`, `upsertUsage(...)`, `readChannelModels()`, `readModelsCn()`, `getRequestCapture(id)`, `prune(...)`。
- 写入顺序（必须与 Rust 一致）：
  1. 取受请求触发的 attempt → `insertRequestLog`（worker 内：BEGIN → `request_logs` → `request_capture_refs pending` → append frame → ready/failed → COMMIT）；
  2. 流式：**await 该 ack 后**才开始写响应；
  3. 结束时 `updateRequestLogTiming` → `upsertUsage`（顺序执行）。
- `.flcap`：Node `zlib.zstdCompressSync(raw, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 } })`；`crypto.createHash('sha256').update(raw).digest()`；60 字节头按 LE 写入；`fs.writeSync` 追加 + `fsync`（Rust 用 flush，未 fsync 每帧；崩溃容忍度相同）。
- 目录/分段/清理/重写：照抄 Rust 规则（§3.16）；路径穿越防护：storage_key 不许含 `..`/绝对路径。
- 记录字段：与 `RequestCaptureRecord` 完全同名（snake_case），null 显式写出；`incomplete = is_stream && duration_ms === null`。
- **跨语言验收**：Node 写的帧必须能被 Rust `RequestCaptureStore::read` 读（通过真实 Rust 构建的 `get_request_log_detail` 命令验证，见 spike A7）；Rust 写的帧 Node 也能读（用 Rust 现有测试/真实库样本）。

### 5.9 SQLite：`node:sqlite` 优先，better-sqlite3 回退（需拍板）

- 依据：Electron 45.2.3 内置 Node 24.22.2，`node:sqlite` 的 `DatabaseSync` **无 flag 可用**（本机实测），已有 PoC 用它只读打开真实库；`node:sqlite` 与 better-sqlite3 同为同步 API、同样的单连接串行模型。
- 收益：**彻底消除 Electron ABI/`electron-rebuild`/原生模块签名风险**（平台矩阵文档里列为 DG 风险的"SQLite 双 ABI"直接消失）。
- 代价/风险：`node:sqlite` 的功能面窄于 better-sqlite3（备份 API、扩展、部分 PRAGMA 行为、JSON1 等需逐项确认）；若 storage 迁移组最终选 better-sqlite3，**代理 DB worker 必须用同一个库**（单写者/单连接是硬约束），库的选择交给 storage owner 决定。
- 无论选哪个：`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;`（`storage.rs:73-75`）；事务/语句与 Rust 完全相同；**不要**在主线程再开连接。

### 5.10 日志与诊断

- `logging.rs` 等价：按天滚动、保留 7 个文件、exe 同级 `logs/flowlet.YYYY-MM-DD.log`；启动/panic 应急日志 `flowlet-startup.log`；`RUST_LOG` → `FLOWLET_LOG` 级别映射。
- 日志内容不参与等价性断言（除"错误不吞"）；但**请求日志**（SQLite/`.flcap`）必须逐字段等价。
- 不要只 `console.log`（`AGENTS.md` §9）；代理内所有失败路径先结构化写请求日志，再 warn。

### 5.11 上游出口代理

- 显式配置（全局/账号）：`ProxyAgent({ uri })`，缓存 key = 配置内容；配置变化下次请求生效；在途请求继续用旧 client。
- 账号显式 `use_upstream_proxy=false` → 专用 no-proxy dispatcher（Rust `no_proxy()`）。
- **系统代理差异**：Rust 主 client 由 `reqwest` 构建，默认会使用系统代理；`upstream_proxy_used` 用 `hyper-util Matcher::from_system` 探测（env 变量族）。**Node/undici 默认完全不用系统代理**。因此 Node 必须显式实现：
  - env：`http_proxy`/`https_proxy`/`all_proxy`/`no_proxy`（大小写变体），`no_proxy` 匹配 host/域名后缀/端口/`*`；
  - 可选平台系统设置：Windows 注册表 / macOS SystemConfiguration（Rust 侧具体覆盖面需 spike 实测，本次未运行验证）；
  - **不实现 PAC**（Rust 侧未见 PAC 支持；引入 Electron `resolveProxy` 会带来 PAC 行为差异，需产品决策）。
- 代理失败 → 原候选网络错误，**绝不静默直连**；连接阶段失败重试一次（仅显式代理 client）。

### 5.12 平台能力

- **电源抑制**：Rust `ActivityTracker`/`ActivityPermit`（Windows 防待机）→ Electron `powerSaveBlocker.start('prevent-app-suspension')` 每活动请求引用计数；流式随流结束释放；headless Host 无实现（Rust 亦为空实现）。
- **端口绑定/单实例**：由平台层另一任务覆盖；代理层只接收 bind 地址，失败返回明确错误（`StartFailed`/`InvalidBindAddr`）。
- **进程退出**：只有"退出 Flowlet"才 `stopProxy()`（`AGENTS.md` §3）。

### 5.13 对拍（Rust ↔ Node 等价性验证）方法

1. **Golden 场景夹具**（每场景 JSON）：`channels/accounts/routes/rules` + 入站请求（method/path/headers/body） + mock 上游脚本（每个账号 api_key 对应的响应：status/headers/chunks/延迟/断开/gzip） + 期望（客户端 status/headers/body、mock 上游收到的请求、`request_logs` 关键字段、`usage_records`、capture 记录）。
2. **两端执行器**：
   - Rust：现有 `proxy_tests` + `cargo test`（在开发机/CI，不在本次勘察）；
   - Node：`node:http` mock 上游 + 直接调用 Node `forwardRequest`（与 Rust 测试同样"不经过真实 socket 入站"或经过本地 socket 均可），输出规范化 JSON。
3. **规范化规则**（diff 前）：请求头名字小写、排序；`set-cookie` 多值排序；JSON body 递归排序键；忽略 `request_id`/`created_at`/`latency_ms`/`ttfb_ms`/`duration_ms`/`upstream_url` 端口；时间字段类型固定；body base64 前先解压；`request_logs.id` 忽略但 `(attempt_seq,is_last_attempt,fallback_count)` 必须一致。
4. **必须逐字节相等**的项：客户端收到的响应 body（流式则拼接后逐字节）；mock 上游收到的 path/query/method/headers（除 host/长度）/body 原始字节（允许 JSON 键序差异的字段单独标注）；`.flcap` 解压后的 JSON（除 `captured_at`/id）。
5. **对拍覆盖顺序**：先 20 个 P0 场景（附录 A 的 P0 子集，A.11 与 A.12 之间），再按附录 A 的 P1 批量。

### 5.14 明确不采用

| 选项 | 原因 |
|---|---|
| `fetch` 做上游 | 自动解压/改写头，字节不保真 |
| fastify/express 做模型面 | 需要绕开框架的 body/响应生命周期，SSE 与字节透传无收益 |
| 全代理放 worker/utilityProcess（默认方案） | 增加配置同步/日志 IPC 成本；先在主线程 + DB worker 验证，压测后再拆 |
| 主线程直接 better-sqlite3/node:sqlite 同步写 | 阻塞事件循环，SSE 卡顿（Rust 用 spawn_blocking） |
| 在 Node 侧重新发明 SQLite schema | 必须逐列兼容用户旧库（见 `docs/migration/commands-and-schema.md`） |
| 用 Electron `resolveProxy` 替代系统代理探测 | 会引入 PAC 行为差异，需产品决策 |

### 5.15 建议目录与模块边界

```
packages/proxy-core/            # 纯 Node，无 Electron 依赖，桌面/headless 共用
  src/server.ts                 # node:http createServer、路由、生命周期
  src/forward.ts                # forwardRequest：快照→路由→attempt→响应
  src/routing.ts                # matchCandidates / filesAccount / fallback 判定
  src/upstream.ts               # undici dispatcher 管理、超时、取消、代理
  src/anthropic-compat.ts       # 逐行状态机
  src/rewrite.ts                # rewriteModel / reasoningContent / alias
  src/capture/stream.ts         # Transform：ttft/usage/resBody/terminal
  src/capture/frame.ts          # .flcap 编解码（zstd+sha256）
  src/usage.ts                  # 增量/整包解析
  src/logs.ts                   # RequestLogInput 构造
  src/db/worker.ts              # worker：sqlite + flcap 写 + 清理
  src/db/client.ts              # 主线程 RPC 客户端（有序队列）
  src/config/snapshot.ts        # RuntimeConfigStore 等价
  test/                         # 场景夹具 + mock upstream + 179 测试移植
```

---

## 6. 风险与不确定点

| # | 风险 | 影响 | 证据/说明 | 缓解 / spike 验证 |
|---|---|---|---|---|
| R1 | Node 单线程吞吐 | 高并发流式/大 body 时延抖动，DB/捕获 CPU 阻塞事件循环 | Rust 多线程 tokio + spawn_blocking | DB 工作放 worker；捕获用有上限的 Transform；压测 50/100 并发流（A11）；不达标再拆 utilityProcess |
| R2 | 请求体无上限缓冲 | 恶意/失控请求 OOM | `proxy.rs:799` `usize::MAX`（Rust 同样风险） | 行为等价优先照抄；把"是否加可配置上限"提给产品；Files 保留 129MiB 上限 |
| R3 | undici 原始字节保证 | 若 `undici.request` 隐式解压/改头则不能等价 | 未安装/未实测 | spike A9 强制验证；失败回退 `node:https` |
| R4 | 超时语义漂移 | bodyTimeout/headersTimeout 与 Rust 不完全同义，可能导致长流被截断或该断不断 | 语义差异已知 | 自建 headers/idle/body 三类计时器，禁用 undici 默认；A10 用慢 chunk 场景验证 |
| R5 | 背压不生效 | 上游快/下游慢时内存涨、客户端卡 | 需 `pipeline` 而非 `for await + res.write` | A2 用客户端暂停读取验证内存与上游读取速率 |
| R6 | 系统代理等价 | reqwest 默认用系统代理，Node 默认不用 → 同环境行为不同（有代理环境下直连失败） | `reqwest` 默认 + `Matcher::from_system` | §5.11 显式实现 env + 平台读取；A11 起本地代理服务器验证；PAC 提产品决策 |
| R7 | `.flcap` 跨语言不兼容 | 用户历史日志打不开 / 新日志 Rust 打不开（双版本共存期） | 60B 头 + zstd + sha256 契约 | A7 用真实 Rust `get_request_log_detail` 读 Node 帧、Node 读 Rust 帧 |
| R8 | zstd 编码参数/实现差异 | 帧可解压但字节不同（可接受）；若 Node zstd 不可用则阻塞 | Electron 45/Node 24.22 实测有 `zstdCompressSync` | A7 校验；若目标 Electron 版本降级，需 `@mongodb-js/zstd` 原生包（ABI 风险回归） |
| R9 | SQLite 库选型 | better-sqlite3 需要 electron-rebuild/签名；node:sqlite 功能面窄 | 实测 node:sqlite 可用；PoC 已在用 | 与 storage owner 共同拍板；单连接单写者不变 |
| R10 | 日志顺序/可见性 | 流式"先写后回填"若变成异步 fire-and-forget，前端会短时看不到"进行中"记录 | `record_request_log_and_wait` | A3 断言流开始后立即能查到 `is_stream=1,duration=NULL` 行 |
| R11 | 下游断开判定 | 终止标记 vs 断开的 complete/partial 语义出错 → 用量虚高/缺失 | `Drop for TimedStreamState` | A3/A4 移植 6 个 dropping/terminal 测试 |
| R12 | JSON 键序/序列化差异 | 与 Rust golden 字节不一致；前缀缓存可能受影响 | serde BTreeMap 排序 | §5.7 递归排序键；对拍规范化+原始字节双轨 |
| R13 | 重复头/大小写 | 日志字段与 Rust 不同、`set-cookie` 丢失 | HeaderMap 语义 | 单测覆盖；A8 |
| R14 | 优雅停止语义 | Rust 会等 in-flight 结束（长 SSE 会卡 stop）；Node `server.close()` 同理但 keep-alive 空闲连接需 `closeIdleConnections` | 现状差异小 | 与 Rust 一致：不强制杀流；给 stop 加超时兜底需产品确认（会改变行为） |
| R15 | 客户端鉴权/CORS 现状缺陷 | Host 模式下浏览器跨域预检被 401；照抄会保留缺陷 | `proxy.rs:433-451` | 照抄并在文档标注；修正需产品决策 |
| R16 | 179 个测试移植成本 | 夹具有大量时序/HTTP 细节，容易"移植走样" | 138 个 e2e 依赖 Rust axum mock 上游语义 | 先做共享夹具格式（§5.13），P0 20 个手工对拍，再批量生成 |
| R17 | 电源抑制/挂起恢复 | Windows S0 下长流仍可能被杀 | `power.rs` + `docs/windows-suspend-resume-network-resilience.md` | Electron `powerSaveBlocker`；平台任务负责，代理侧只需 permit 生命周期正确 |

**需要产品/架构拍板的清单**：
1. 模型请求体是否继续无上限（R2）。
2. 系统代理是否必须与 reqwest 行为完全一致（R6）。
3. Host 模式 CORS 预检鉴权缺陷是否照抄（R15）。
4. `stopProxy` 是否允许强制中断 in-flight 长流（R14）。
5. SQLite 库最终选型（R9，与 storage owner 联合决定）。
6. 是否接受"Responses 路由不出现在 `/models`"的现状（若客户端依赖，需产品确认再修）。

---

## 7. 一天可完成的 Spike 定义（可执行、可验收）

### 7.1 目标 / 非目标

**目标（1 天，1 人）**：证明 Node 版代理在**协议主链路 + 一条流式 + 降级 + 捕获/日志骨架**上与 Rust 等价，并验证 §5 的关键技术假设（undici 原始字节、zstd/sha256 帧、node:sqlite、背压、超时）。

**非目标**：不用真上游、不追求全部 179 测试、不做 UI 集成、不做系统代理平台读取、不做 Files 全流程（可作为 P2 加分）、不做性能优化。

### 7.2 交付物（全部在 `poc/proxy-spike/`，可丢弃）

```
poc/proxy-spike/
  package.json            # 仅依赖 undici；node:sqlite/zlib/crypto 内置
  src/server.mjs          # node:http + 路由 + 生命周期 + 快照
  src/forward.mjs         # 路由/attempt/降级/转发
  src/upstream.mjs        # undici dispatcher + 三类超时 + 取消
  src/anthropic-compat.mjs
  src/capture.mjs         # tap Transform + flcap 写
  src/db-worker.mjs       # node:sqlite 单连接 + flcap + 日志/用量
  mock-upstream.mjs       # 按场景脚本返回（状态/分块/延迟/gzip/断开）
  scenarios/*.json        # 场景夹具（见 §7.7）
  run-scenarios.mjs       # 执行器：起 mock+proxy，跑场景，断言，输出 JSON
  README.md               # 运行方式、结果、与 Rust 差异记录
```

### 7.3 时间盒（8 小时）

| 时段 | 工作 | 产出 |
|---|---|---|
| 0.5h | 脚手架 + 快照（从 PoC 数据库**只读**复制 channels/accounts/routes，或手写夹具） | server 起在 127.0.0.1:18641，`/health` 200 |
| 2h | 入站路由 + 模型归一 + 候选匹配 + attempt 循环 + header/URL 构造 | 非流式 chat/messages 成功 + 429→200 fallback |
| 2h | SSE 转发（tap + pipeline + idle/headers 超时 + terminal/drop + usage/log 回填） | 流式场景 A2/A3 通过 |
| 1.5h | 捕获（`.flcap` 写 + sha256/zstd + sqlite 日志/用量）+ Anthropic compat + reasoning 回填 | A5/A6/A7 通过 |
| 1h | 对拍：mock 上游记录 vs Rust golden（若 Rust 端可由开发机产出；否则先 Node 侧快照） | diff 报告 |
| 1h | 结论/风险记录/排期修正 | spike 报告 |

### 7.4 最小端点/协议范围（必须）

| 端点 | 方法 | 验收 |
|---|---|---|
| `/health` | any | 200 `ok` + CORS；OPTIONS 204 |
| `/v1/models` | GET | OpenAI schema，空配置合法空列表 |
| `/anthropic/v1/models` | GET | Anthropic schema |
| `/v1/chat/completions` | POST | 非流式 + 流式 |
| `/anthropic/v1/messages` | POST | 非流式 + 流式（thinking/tool_use 修复） |
| `/v1/responses` | POST | 透传；非 POST 405 |
| 生命周期 | — | `start` 幂等、`stop` 幂等、无账号也可监听 |

Files API 作为 P2：若时间够，实现 upload/list/delete 的"绑定账号 + 原样透传"。

### 7.5 无 API Key 的验证方式（默认路径）

`config.json` 只有渠道 preset、无账号 Key；PoC 数据库副本里虽有 14 个非空 Key，但**未经用户授权不得使用**。因此：

1. **本地 mock 上游（主路径）**：`mock-upstream.mjs` 按场景返回，Key 由夹具任意伪造（如 `key-a`），mock 不校验。所有协议形状（OpenAI/Anthropic/Responses）与异常（429/500/401/account_deactivated/quota/gzip/慢 chunk/断开）都由脚本模拟。
2. **回放 `proxy_tests` 场景**：把 `spawn_spy_upstream` + `build_test_state` + 请求/断言翻译成场景 JSON（§7.7）；优先移植附录 A 列出的 20 个 P0 场景。
3. **Rust↔Node 对拍**：在开发机（不违反本勘察的只读约束，属于 spike 阶段）用现有 `cargo test` 或真实 Rust 构建产出 golden：
   - Rust 侧跑同一 mock 上游，记录其收到的请求与写库结果；
   - Node 侧跑同一夹具，diff；
   - `.flcap` 互读：Rust 真实构建 + `get_request_log_detail` 读 Node 写的库；Node 读 Rust 测试产生的帧。
4. **可选真实上游**：仅当用户显式提供测试 Key/授权时，跑 1 次冒烟（一个账号、一个模型、流式+非流式+files），**不入 CI、不入仓库**，并记录额度消耗。
5. **不建议**用"Flowlet→Flowlet"自环作为等价性 oracle（只验证了本代理的行为，不能验证与真实上游的字节交互）。

### 7.6 验收标准 A1–A12（可执行）

| ID | 验收项 | 断言（运行时） | 对应 Rust 测试 |
|---|---|---|---|
| A1 | 生命周期/健康 | 起两次 start：第二次返回 `AlreadyRunning`（不重复绑定）；未启动 stop 不 crash；无账号/无路由时 `/health` 200、`/v1/models` 200 空列表 | `proxy_starts_without_accounts_or_routes`、`empty_*_model_list_is_valid` |
| A2 | OpenAI 非流式透传 | mock 上游收到：`Authorization: Bearer key-a`（客户端 token 被替换）、path `/v1/chat/completions`、`model` 已改写、无 `content-length`；客户端收到 mock 的 status/headers/body 逐字节一致 | `forwards_status_headers_body_and_replaces_authorization` |
| A3 | 流式与背压 | 客户端逐块读；mock 每 50ms 一块 ×20；断言客户端能在流结束前收到首块（非全缓冲）；客户端 `pause()` 1s 后 mock 侧写入被反压（不继续爆发）；终止后日志 `duration` 非 NULL 且 usage 完整 | `streaming_idle_timeout_resets_after_each_chunk` 等 |
| A4 | 流式异常/断开 | 无终止标记被断开 → usage `partial`（output/total 为 NULL）+ `stream_cancelled`；`[DONE]` 后断开 → `complete`；空闲 120s（用 1s 夹具）→ `stream_timeout` | `dropping_*`、`streaming_timeout_*` |
| A5 | Anthropic 兼容 | mock 返回缺 `thinking`/`input` 的 `content_block_start`：客户端流里字段被补（`""`/`{}`），**日志原始捕获里没有补丁**；>64KiB 行与末尾不完整行原样 | `anthropic_thinking_compat_repairs_client_stream_but_captures_raw_upstream` |
| A6 | DeepSeek 回填 | OpenAI 协议 + `deepseek-v4-pro`：mock 收到每条 assistant 都有 `reasoning_content`（已有值不改）；非 DeepSeek/Anthropic 协议不动 | `deepseek_reasoning_route_injects_reasoning_content_passback`、`non_deepseek_route_leaves_assistant_messages_untouched` |
| A7 | `.flcap` 跨语言 | Node 写帧：magic/version/长度/sha256 校验通过；`zstd -d` 可解；Rust 真实构建 `get_request_log_detail` 能读出同一请求体；Rust 样本 Node 也能读 | `appends_and_randomly_reads_a_compressed_frame` + 真实构建验证 |
| A8 | 日志字段 | `request_logs` 的 `public_model`/`virtual_model`/`upstream_model`/`route_reason`/`attempt_seq`/`is_last_attempt`/`fallback_count`/`ttfb_ms`/`duration_ms` 与场景期望一致；skipped 行 `status/upstream_url/req/res` 为 NULL | `e2e_unsupported_protocol_logs_skipped_route_and_terminal_error`、`missing_account_returns_structured_error_and_log` |
| A9 | 原始字节/压缩 | mock 返回 gzip body：客户端收到字节与 mock 完全一致（含 `content-encoding`/`content-length`）；日志体是**解压后**内容 | `decodes_compressed_buffered_usage_without_mutating_passthrough_bytes`、`decompress_for_capture_*` |
| A10 | 超时语义 | mock 延迟 200ms 才回头 → 头超时生效；流式 chunk 间隔超时生效；持续有 chunk 的长流不被总超时截断 | `streaming_response_can_outlive_channel_timeout_when_chunks_keep_arriving` |
| A11 | 路由/降级 | 429→200 fallback；跨上游变体 fallback；round-robin 顺序；401 标记后下一请求排除；400 `account_deactivated` 降级并恢复；图片请求不发上游且返回 `model_input_modality_unsupported` | `e2e_same_model_account_fallback`、`e2e_cross_variant_fallback_within_canonical_model`、`e2e_401_*`、`e2e_image_request_*` |
| A12 | 出口代理 | 起本地代理服务器；`use_upstream_proxy=true` 的账号请求经代理（记录转发）；代理不可用时该候选失败、**不直连**；连接失败重试 1 次 | `upstream_proxy` 单测 + `e2e` 无对应用例，需新增 |

**通过线**：A1–A10 全过 + A11 至少 4/6 + A7 必过 = **spike 通过，可进入正式移植**。A12/A5 若失败但已定位原因，可列"待解风险"而不阻塞。

### 7.7 场景夹具格式（建议）

```json
{
  "id": "P0-fallback-429-200",
  "channels": [{ "id": "mock", "vendor": "mock", "supported_protocols": ["openai","anthropic","responses"],
                  "openai_base_url": "http://127.0.0.1:18642/v1", "anthropic_base_url": "http://127.0.0.1:18642",
                  "openai_auth": "bearer", "anthropic_auth": "bearer", "enabled": true }],
  "accounts": [{ "id": "a", "channel_id": "mock", "api_key": "key-a", "enabled": true, "priority": 0, "credential_status": "healthy" }],
  "routes": [{ "id": "r1", "virtual_model_id": "deepseek-v4-pro", "channel_id": "mock", "account_id": "a",
               "upstream_model": "deepseek-v4-pro", "client_protocol": "openai", "priority": 0, "enabled": true }],
  "request": { "method": "POST", "path": "/v1/chat/completions",
               "headers": { "authorization": "Bearer any", "content-type": "application/json" },
               "body": { "model": "deepseek-v4-pro", "messages": [{ "role": "user", "content": "hi" }] } },
  "upstream": { "by_auth": { "key-a": { "status": 429, "body": "{}", "chunks": [] } } },
  "expect": { "client_status": 200, "upstream_seen": ["/v1/chat/completions"], "logs": [{ "attempt_seq": 0, "route_reason": "retryable_status", "is_last_attempt": false }] }
}
```

### 7.8 Go / No-Go

- **Go**：A1–A10 全绿 + A7 通过 + 单并发非流式 P95 逻辑耗时 < 5ms（本地 mock）。
- **条件 Go**：A5 修复可行但有时序 bug（记录）；A12 未实现（风险已知）。
- **No-Go（需改方案）**：undici 无法保证原始字节（A9 失败且无法回退 node:https）；Node zstd 与 Rust 帧互读失败且无可行编码库；背压 A3 失败（说明架构需重做，不是实现细节）。

### 7.9 Spike 之后的排期修正

用 spike 实测替换估算：若 A3/A4（流式状态机）比预期难，把 §8 的 Phase 1 增加 2–3 天；若 node:sqlite 被否决，Phase 2 增加原生模块集成 1–2 天。

---

## 8. 移植与排期建议

| 阶段 | 内容 | 人日（1 名资深） | 关键交付/验收 |
|---|---|---:|---|
| P0 对拍基建 | 场景夹具格式 + mock 上游 + Rust/Node 双执行器 + 规范化 diff | 3–4 | 20 个 P0 场景可一键跑 |
| P1 协议主链路 | 入站路由、模型归一、候选匹配、attempt/降级、URL/头、`/models`/`/models/{id}`、健康/CORS | 6–9 | A1/A2/A8/A11 |
| P2 流式 | tap/pipeline/背压、三类超时、取消、终止/断开、Anthropic compat、日志回填 | 4–6 | A3/A4/A5/A10 |
| P3 捕获/观测 | DB worker、sqlite schema 兼容、`.flcap`、usage、日志、清理/轮转 | 4–6 | A7/A8/A9 |
| P4 受控例外/边界 | reasoning 回填、beta 过滤、`[1m]`、智谱路径、Files API、出口代理/重试、凭证状态 | 3–5 | A6/A12 + 附录 A 的 P1 场景 |
| P5 测试移植/长稳 | 179 测试移植、并发/长流/内存/断连压测、日志/用量一致性 | 8–12 | 全部 P0/P1 场景绿 |
| P6 集成/切换 | 与 Electron 壳、headless Host、前端命令、存储迁移联调；双跑灰度/回滚 | 5–8 | 真实用户库只读演练 + 开关切换 |
| **合计** | | **33–50（含 buffer）** | 3 人并行约 3–4 周 |

> 与 `docs/migration/platform-gap-matrix.md` 的结论一致：代理本身**没有硬缺口**（Node/Electron 都能实现），风险在"等价度"与"回归资产移植"，因此**先 spike 再排期**是正确顺序。

---

## 9. 附录

### 附录 A：必须移植的验收场景清单（按测试名归类）

> 共 138 个 `proxy_tests.rs` 测试 + 41 个其它文件单测。优先级：**P0** = 一天 spike 必须（20 个）；**P1** = 核心移植必须；**P2** = 边界/渠道特有。
> 断言要点从测试体与源码行为提炼；具体字段以原测试为准。

#### A.1 协议探测 / URL / 模型改写 / 客户端与会话识别（P1，46 项；含 1 个 `proxy_http` 单测交叉）

| 测试名 | 验什么 |
|---|---|
| `protocol_type_from_path_identifies_anthropic` / `_identifies_openai` / `_returns_none_for_health` / `_keeps_openai_for_responses_subpath` | `from_path` 粗分类语义 |
| `is_responses_path_detects_responses_entry_paths` / `_rejects_other_paths` | 三种入口前缀的 Responses 识别 |
| `recognizes_openai_model_detail_paths_only` | 只有 `/v1/models/{id}`、`/openai/v1/models/{id}` |
| `build_upstream_url_preserves_v1_prefix_for_openai` / `_strips_openai_entry_prefix` / `_strips_anthropic_entry_prefix` | 入口前缀剥离与 `/v1` 保留 |
| `build_upstream_url_dedupes_v1_for_qwen_token_plan_base_url` / `_for_qwen_dashscope_base_url` / `_for_moonshot_base_url` / `_keeps_v1_in_base_when_path_has_no_v1` | base 自带 `/v1` 去重 |
| `build_upstream_url_without_openai_v1_strips_v1_for_zhipu` + `openai_path_strips_v1_only_for_zhipu` | 智谱特例（含 model list 路径） |
| `build_upstream_url_responses_for_longcat_base` / `_dedupes_v1_for_qwen_base` / `_for_deepseek_base` / `_strips_openai_entry_prefix` / `_root_path_matches_deepseek_docs` | Responses 上游 URL（含裸根 `/responses`） |
| `rewrite_model_maps_openai_public_name` / `_maps_anthropic_public_name` / `_replaces_public_model_name` | model 字段改写（文本替换优先） |
| `extract_model_strips_long_context_suffix` | `[1m]`/`[1M]` 剥离 |
| `ensure_reasoning_content_passback_injects_empty_for_deepseek_reasoning` / `_skips_non_deepseek_and_other_protocols` | DeepSeek 回填门控与"已有值不改" |
| `identify_client_by_ua_substring` / `identifies_codex_desktop_and_cli_by_ua` / `ua_no_match_returns_none` / `ua_skip_disabled_and_empty_pattern` | UA 规则 |
| `agent_marker_header_identifies_pi_and_beats_ua_rules` / `_unknown_value_uses_value_as_name` / `_falls_back_to_ua_when_absent` | `x-flowlet-client` 优先级 |
| `identifies_client_from_bearer_token` / `_from_x_api_key` / `rejects_unknown_token` | Host 鉴权 token 精确匹配 |
| `identifies_client_from_json_parses_case_insensitive_headers` / `_respects_marker_header_priority` / `_returns_none_for_invalid_json` | 历史日志重识别 |
| `extracts_opencode_session_with_precedence_and_parent` / `ignores_generic_session_header_without_opencode_identity` / `extracts_claude_code_session_from_official_header` / `extracts_pi_session_only_with_client_marker` / `ignores_pi_session_header_without_client_marker` / `ignores_pi_session_header_with_non_pi_client_marker` | 会话头门控（Adapter 注册表语义） |

#### A.2 响应头 / CORS / 脱敏 / 压缩 / 捕获工具 / 非流式端到端（P1，17 项；含 13 个 `proxy_http` 单测交叉）

| 测试名 | 验什么 |
|---|---|
| `apply_request_headers_drops_stale_content_length` | 丢旧 `content-length`，保留 `content-type` |
| `apply_request_headers_replaces_client_bearer_credentials` / `_replaces_client_x_api_key_credentials` | 客户端凭据被上游 Key 替换，另一种鉴权头被移除 |
| `apply_request_headers_strips_local_agent_identity_before_forwarding` | `x-flowlet-client`/`x-flowlet-session` 剥离，UA 保留 |
| `apply_request_headers_forwards_the_native_dsh_session_header` | DSH 原生会话头**必须透传** |
| `apply_request_headers_filters_context_1m_beta_only` / `_drops_beta_header_when_only_context_1m` | `context-1m` 过滤，其余 beta 保留 |
| `sanitize_headers_redacts_bearer` | header 脱敏 |
| `log_capture_missing_size_limit_uses_512_mb_default` | `log_capture` 缺省 `body_max_size_mb=512` |
| `encode_body_roundtrips_string` | base64 |
| `decompress_for_capture_handles_gzip_and_unknown` / `prepare_captured_res_body_decompresses_then_truncates_utf8` / `content_encoding_value_takes_first_token_lowercase` | 捕获解压/截断/编码头解析 |
| `decodes_compressed_buffered_usage_without_mutating_passthrough_bytes` | gzip 响应：客户端字节不变，usage 从解压体解析 |
| `cors_preflight_allows_browser_requests` / `cors_headers_are_added_to_regular_responses` | CORS 全套 |
| `enriches_final_upstream_error_metadata_without_body_rewrite` | 4xx/5xx 补 `error_message`/`route_reason`，body 不动 |
| `forwards_status_headers_body_and_replaces_authorization`（**P0**） | 非流式端到端：状态/头/body 透传、客户端 token 被上游 Key 替换 |

#### A.3 生命周期 / `/models` 与模型详情（P1，17 项）

| 测试名 | 验什么 |
|---|---|
| `model_list_request_matches_openai_models_endpoint` | 只认 GET 精确路径 |
| `model_list_response_exposes_enabled_route_models` | 过滤规则、去重、字典序、`owned_by=vendor` |
| `model_list_never_exposes_retired_aggregate_names` | `flowlet-pro/flash` 不暴露 |
| `model_list_response_exposes_canonical_openrouter_model` | 规范身份一致性 |
| `model_list_response_anthropic_uses_anthropic_schema` | Anthropic schema（`type/display_name/created_at/first_id/last_id`） |
| `empty_openai_model_list_is_valid` / `empty_anthropic_model_list_is_valid` | 空列表 200 |
| `proxy_starts_without_accounts_or_routes`（**P0**） | 无账号/无路由也能监听并健康 |
| `e2e_models_exposes_direct_models_by_default` / `_hides_disabled_direct_routes` / `_excludes_invalid_key_direct_model` | 路由/账号状态对列表的影响 |
| `e2e_dual_protocol_model_list_consistency` / `e2e_dual_protocol_models_list_consistent_with_direct` | 两协议列表一致 |
| `model_list_does_not_advertise_aliases` | 只返回规范 ID |
| `model_detail_returns_openai_not_found_for_unexposed_model` | 404 `model_not_found` |
| `model_detail_prefers_upstream_limits_and_falls_back_to_models_cn` / `_prefers_raw_upstream_pricing` / `model_detail_price_selection_respects_effective_and_daily_ranges` | 详情字段与价格选择 |

#### A.4 候选匹配 / 轮询 / 规则（P1，14 项）

| 测试名 | 验什么 |
|---|---|
| `candidate_pool_round_robins_accounts_before_next_variant` | 同组账号轮询先于下一个上游变体 |
| `candidate_pool_accepts_native_protocol_and_skips_other_protocols` | 协议过滤与 skipped 分类 |
| `match_candidates_skips_routes_with_inconsistent_canonical_identity` | 脏行不参与 |
| `match_candidates_filters_routes_by_responses_protocol` / `_excludes_channels_without_responses_routes` / `_reports_protocol_mismatched_routes_as_skipped` | Responses 协议路由 |
| `match_candidates_keeps_exact_match_contract_for_aliases` | 候选层不解析别名（归一只在 `proxy.rs`） |
| `e2e_model_sort_order_is_respected` / `e2e_model_enable_disable_sync` | 排序与启停 |
| `e2e_direct_model_account_round_robin` / `e2e_direct_model_same_model_fallback` / `e2e_direct_model_no_cross_model_fallback` | 轮询/同模型降级/不跨模型降级 |
| `rank_candidates_prefers_cheaper_account` / `rank_candidates_no_scores_keeps_priority` | dead code 单测（移植可保留为纯函数） |

#### A.5 降级 / 状态码 / 凭证状态机（P0/P1，18 项）

| 测试名 | 验什么 |
|---|---|
| `should_try_next_status_handles_deepseek_402` | DeepSeek 402 降级 |
| `should_try_next_status_for_rate_limit_and_server_errors` / `should_not_try_next_for_client_errors` | 429/5xx 降级，其余不降级 |
| `inspects_fallback_body_for_supported_client_error_statuses` | 400/402/403 才读 body |
| `detects_quota_exceeded_messages` / `detects_product_not_activated_without_retrying_other_bad_requests` / `detects_deactivated_account_errors` | 三类 body 探测 |
| `e2e_same_model_account_fallback`（**P0**） | 429→200 |
| `e2e_cross_variant_fallback_within_canonical_model`（**P0**） | 同规范模型跨上游变体降级 |
| `e2e_product_not_activated_falls_back_to_next_candidate` | product not activated 降级 |
| `e2e_account_deactivated_falls_back_then_recovers` | 停用→降级→恢复 |
| `e2e_401_marks_invalid_key_and_excludes_from_next_request` / `e2e_same_instance_excludes_401_account_on_next_request` | 401 标记与排除 |
| `e2e_recovers_after_api_key_change` | 改 Key 后恢复 |
| `e2e_new_account_default_credential_status` | 默认 healthy |
| `missing_account_returns_structured_error_and_log` | `no_available_account` + 日志 |
| `e2e_image_request_to_text_only_model_is_rejected_before_upstream`（**P0**） | 图片模态过滤，不发上游 |
| `e2e_unsupported_protocol_logs_skipped_route_and_terminal_error`（**P0**） | skipped 节点 + 终态错误 |
| `deepseek_reasoning_route_injects_reasoning_content_passback`（**P0**） | OpenAI 路由到 DeepSeek 时补 `reasoning_content` |
| `non_deepseek_route_leaves_assistant_messages_untouched`（**P0**） | 非 DeepSeek 不改写请求体 |

#### A.6 别名校验（P1，6 项）

| 测试名 | 验什么 |
|---|---|
| `e2e_alias_inbound_routes_to_canonical_route` | 别名入站路由到规范路由 |
| `e2e_alias_inbound_routes_on_anthropic_messages` | Anthropic 路径同样归一 |
| `e2e_unregistered_model_still_model_not_exposed` | 未登记名不归一 → 404 |
| `e2e_alias_inbound_protocol_mismatch_uses_canonical_name` | 归一后做协议匹配 |
| `e2e_alias_inbound_shares_round_robin_cursor_with_canonical_name` | 别名与规范名共享轮询游标 |
| `e2e_case_variant_inbound_name_routes_to_canonical_case` | 大小写变体 |
| `model_list_does_not_advertise_aliases` | 列表不宣传别名 |

#### A.7 流式（P0/P1，11 项）

| 测试名 | 验什么 |
|---|---|
| `anthropic_thinking_compat_repairs_client_stream_but_captures_raw_upstream`（**P0**） | 客户端修复、捕获原文、64KiB/不完整行/错误 |
| `streaming_idle_timeout_resets_after_each_chunk`（**P0**） | 每块重置空闲超时 |
| `streaming_usage_survives_response_larger_than_capture_limit` | usage 不随响应体增长（增量解析） |
| `streaming_idle_timeout_reports_stream_failure` | 空闲超时 → `stream_timeout` |
| `streaming_timeout_preserves_message_start_usage_as_partial` | 仅 message_start → partial |
| `streaming_timeout_keeps_usage_complete_when_final_output_usage_arrived` | 有正 output usage → complete |
| `dropping_downstream_stream_preserves_received_partial_usage` | 下游断开保留已收 partial |
| `dropping_stream_after_openai_done_marker_marks_complete` / `_after_split_openai_done_marker_marks_complete` / `_after_anthropic_message_stop_marks_complete` | 终止标记（含跨 chunk 拆分）→ complete |
| `streaming_response_can_outlive_channel_timeout_when_chunks_keep_arriving` | 持续输出不被总超时截断 |

#### A.8 Files API（P1，10 项）

| 测试名 | 验什么 |
|---|---|
| `files_api_request_recognizes_the_four_operations` / `request_references_files_api_detects_the_beta_token` | 路径/方法识别、beta 判据 |
| `files_upload_forwards_to_the_bound_account_and_keeps_the_body` | 上传 body 原样、绑定账号 |
| `files_request_keeps_the_operation_paths_and_methods` | list/retrieve/delete 路径方法不变 |
| `files_request_without_a_files_capable_channel_returns_503` | 无可用渠道 503 |
| `files_upstream_error_status_and_body_pass_through_unchanged` | 上游错误原样透传 |
| `messages_referencing_files_pin_to_the_bound_account` / `messages_without_the_files_beta_keep_normal_routing` / `files_beta_pin_miss_falls_back_to_normal_routing` | pin / 不 pin / pin miss |
| `files_account_prefers_a_deterministic_account` | 绑定账号全序确定性 |

#### A.9 渠道原生协议（P2，4 项）

| 测试名 | 验什么 |
|---|---|
| `openai_api_forwards_direct_models_with_native_protocols` / `vibetoken_forwards_direct_models_with_native_protocols` | 两种协议路径、鉴权替换、模型改写、metadata 原样 |
| `openai_api_models_list_respects_protocol_and_disabled_account` / `vibetoken_models_list_respects_protocol_and_disabled_account` | 列表协议/账号过滤 |

#### A.10 工具/非代理核心（P2，2 项）

| 测试名 | 验什么 |
|---|---|
| `export_import_config_roundtrip` | 配置导出导入（属于 config 迁移，非代理） |
| `cleanup_old_logs_works` | 旧日志清理（属于 storage 迁移） |

#### A.11 其它文件单测（41 项；与 A.1/A.2 存在交叉，去重后以 A.12 为准）

- `proxy_http.rs`（14）：见 A.2 摘录，另含 `apply_request_headers_*` 全组。
- `usage.rs`（16）：`extracts_longcat_usage_from_completed_sse`、`incrementally_extracts_usage_across_arbitrary_chunk_boundaries`、`incremental_usage_marks_message_start_only_as_incomplete`、`incremental_usage_accepts_positive_output_without_terminal_marker`、`rejects_sse_usage_without_done_marker`、`extracts_longcat_anthropic_usage_from_message_stop_stream`、`captures_anthropic_cache_write_tokens`、`anthropic_shape_ignores_leaked_prompt_tokens_to_avoid_double_counting_cache`、`anthropic_stream_with_leaked_prompt_tokens_does_not_double_count_cache`、`openai_shape_still_prefers_prompt_tokens`、`extracts_responses_streaming_usage_from_response_completed`、`extracts_responses_non_streaming_top_level_usage`、`extracts_usage_from_completed_stream_without_done_marker`、`rejects_truncated_capture_with_only_message_start_usage`、`extracts_stream_usage_falls_back_to_plain_json_message`、`detects_first_output_token_but_ignores_metadata_events`（其中 3 个与 usage 相关跨列，共 16）。
- `proxy_anthropic_compat.rs`（6）：`repairs_missing_thinking_at_every_chunk_boundary`、`preserves_other_events_existing_values_and_invalid_json_byte_for_byte`、`repairs_real_missing_tool_input_at_every_chunk_boundary`、`repaired_tool_start_preserves_argument_deltas_through_completion`、`oversized_line_passes_through_and_next_event_is_repaired`、`bypass_and_incomplete_tails_are_unchanged_and_errors_propagate`。
- `request_capture.rs`（3）：`appends_and_randomly_reads_a_compressed_frame`、`rotates_session_segments_at_the_configured_limit`、`rejects_storage_keys_that_escape_the_capture_root`。
- `rate_limiter.rs`（2）：`rate_limiter_allows_within_limit`、`rate_limiter_separate_clients`。

**Spike 必跑 P0 子集（20，名称精确）**：

1. `proxy_starts_without_accounts_or_routes`
2. `empty_openai_model_list_is_valid`
3. `empty_anthropic_model_list_is_valid`
4. `forwards_status_headers_body_and_replaces_authorization`
5. `e2e_same_model_account_fallback`
6. `e2e_cross_variant_fallback_within_canonical_model`
7. `e2e_401_marks_invalid_key_and_excludes_from_next_request`
8. `e2e_image_request_to_text_only_model_is_rejected_before_upstream`
9. `e2e_unsupported_protocol_logs_skipped_route_and_terminal_error`
10. `e2e_alias_inbound_routes_to_canonical_route`
11. `anthropic_thinking_compat_repairs_client_stream_but_captures_raw_upstream`
12. `streaming_idle_timeout_resets_after_each_chunk`
13. `deepseek_reasoning_route_injects_reasoning_content_passback`
14. `non_deepseek_route_leaves_assistant_messages_untouched`
15. `decodes_compressed_buffered_usage_without_mutating_passthrough_bytes`
16. `dropping_stream_after_openai_done_marker_marks_complete`
17. `dropping_downstream_stream_preserves_received_partial_usage`
18. `apply_request_headers_strips_local_agent_identity_before_forwarding`
19. `apply_request_headers_forwards_the_native_dsh_session_header`
20. `model_detail_returns_openai_not_found_for_unexposed_model`

#### A.12 全量 179 个测试名（权威清单，§2.1 计数口径）

> 下列清单由源码 `^\s*#\[(tokio::)?test\]` + 下一行函数名机械提取（基线 `26fed4c`），用于核对"是否漏项"；分组说明见 A.1–A.11。

```text
# proxy_tests.rs (138)
protocol_type_from_path_identifies_anthropic
protocol_type_from_path_identifies_openai
recognizes_openai_model_detail_paths_only
model_detail_price_selection_respects_effective_and_daily_ranges
model_detail_prefers_upstream_limits_and_falls_back_to_models_cn
model_detail_returns_openai_not_found_for_unexposed_model
model_detail_prefers_raw_upstream_pricing
extracts_opencode_session_with_precedence_and_parent
ignores_generic_session_header_without_opencode_identity
extracts_claude_code_session_from_official_header
extracts_pi_session_only_with_client_marker
ignores_pi_session_header_without_client_marker
ignores_pi_session_header_with_non_pi_client_marker
protocol_type_from_path_returns_none_for_health
protocol_type_from_path_keeps_openai_for_responses_subpath
is_responses_path_detects_responses_entry_paths
is_responses_path_rejects_other_paths
rewrite_model_maps_openai_public_name
rewrite_model_maps_anthropic_public_name
rewrite_model_replaces_public_model_name
ensure_reasoning_content_passback_injects_empty_for_deepseek_reasoning
ensure_reasoning_content_passback_skips_non_deepseek_and_other_protocols
should_try_next_status_handles_deepseek_402
should_try_next_status_for_rate_limit_and_server_errors
should_not_try_next_for_client_errors
inspects_fallback_body_for_supported_client_error_statuses
detects_quota_exceeded_messages
detects_product_not_activated_without_retrying_other_bad_requests
detects_deactivated_account_errors
identifies_client_from_bearer_token
identifies_client_from_x_api_key
rejects_unknown_token
identifies_client_by_ua_substring
identifies_codex_desktop_and_cli_by_ua
ua_no_match_returns_none
ua_skip_disabled_and_empty_pattern
agent_marker_header_identifies_pi_and_beats_ua_rules
agent_marker_header_unknown_value_uses_value_as_name
agent_marker_falls_back_to_ua_when_absent
identify_client_from_json_parses_case_insensitive_headers
identify_client_from_json_respects_marker_header_priority
identify_client_from_json_returns_none_for_invalid_json
extracts_openai_usage
extracts_input_output_usage_and_computes_total
ignores_response_without_usage
decodes_compressed_buffered_usage_without_mutating_passthrough_bytes
build_upstream_url_preserves_v1_prefix_for_openai
build_upstream_url_strips_openai_entry_prefix
build_upstream_url_strips_anthropic_entry_prefix
build_upstream_url_dedupes_v1_for_qwen_token_plan_base_url
build_upstream_url_dedupes_v1_for_qwen_dashscope_base_url
build_upstream_url_dedupes_v1_for_moonshot_base_url
build_upstream_url_keeps_v1_in_base_when_path_has_no_v1
build_upstream_url_without_openai_v1_strips_v1_for_zhipu
openai_path_strips_v1_only_for_zhipu
build_upstream_url_responses_for_longcat_base
build_upstream_url_responses_dedupes_v1_for_qwen_base
build_upstream_url_responses_for_deepseek_base
build_upstream_url_responses_strips_openai_entry_prefix
build_upstream_url_responses_root_path_matches_deepseek_docs
enriches_final_upstream_error_metadata_without_body_rewrite
forwards_status_headers_body_and_replaces_authorization
deepseek_reasoning_route_injects_reasoning_content_passback
non_deepseek_route_leaves_assistant_messages_untouched
rank_candidates_prefers_cheaper_account
rank_candidates_no_scores_keeps_priority
export_import_config_roundtrip
cleanup_old_logs_works
files_api_request_recognizes_the_four_operations
request_references_files_api_detects_the_beta_token
model_list_request_matches_openai_models_endpoint
model_list_response_exposes_enabled_route_models
model_list_never_exposes_retired_aggregate_names
model_list_response_exposes_canonical_openrouter_model
model_list_response_anthropic_uses_anthropic_schema
cors_preflight_allows_browser_requests
cors_headers_are_added_to_regular_responses
empty_openai_model_list_is_valid
empty_anthropic_model_list_is_valid
proxy_starts_without_accounts_or_routes
missing_account_returns_structured_error_and_log
candidate_pool_round_robins_accounts_before_next_variant
candidate_pool_accepts_native_protocol_and_skips_other_protocols
match_candidates_skips_routes_with_inconsistent_canonical_identity
match_candidates_filters_routes_by_responses_protocol
match_candidates_excludes_channels_without_responses_routes
match_candidates_reports_protocol_mismatched_routes_as_skipped
anthropic_thinking_compat_repairs_client_stream_but_captures_raw_upstream
streaming_idle_timeout_resets_after_each_chunk
streaming_usage_survives_response_larger_than_capture_limit
streaming_idle_timeout_reports_stream_failure
streaming_timeout_preserves_message_start_usage_as_partial
streaming_timeout_keeps_usage_complete_when_final_output_usage_arrived
dropping_downstream_stream_preserves_received_partial_usage
dropping_stream_after_openai_done_marker_marks_complete
dropping_stream_after_split_openai_done_marker_marks_complete
dropping_stream_after_anthropic_message_stop_marks_complete
streaming_response_can_outlive_channel_timeout_when_chunks_keep_arriving
e2e_same_model_account_fallback
e2e_cross_variant_fallback_within_canonical_model
e2e_image_request_to_text_only_model_is_rejected_before_upstream
e2e_unsupported_protocol_logs_skipped_route_and_terminal_error
e2e_product_not_activated_falls_back_to_next_candidate
e2e_account_deactivated_falls_back_then_recovers
e2e_401_marks_invalid_key_and_excludes_from_next_request
e2e_model_sort_order_is_respected
e2e_model_enable_disable_sync
e2e_dual_protocol_model_list_consistency
e2e_models_exposes_direct_models_by_default
e2e_models_hides_disabled_direct_routes
e2e_direct_model_account_round_robin
e2e_direct_model_same_model_fallback
e2e_direct_model_no_cross_model_fallback
e2e_models_excludes_invalid_key_direct_model
e2e_recovers_after_api_key_change
e2e_same_instance_excludes_401_account_on_next_request
e2e_new_account_default_credential_status
e2e_dual_protocol_models_list_consistent_with_direct
e2e_alias_inbound_routes_to_canonical_route
e2e_alias_inbound_routes_on_anthropic_messages
e2e_unregistered_model_still_model_not_exposed
e2e_alias_inbound_protocol_mismatch_uses_canonical_name
e2e_alias_inbound_shares_round_robin_cursor_with_canonical_name
e2e_case_variant_inbound_name_routes_to_canonical_case
model_list_does_not_advertise_aliases
match_candidates_keeps_exact_match_contract_for_aliases
files_upload_forwards_to_the_bound_account_and_keeps_the_body
files_request_keeps_the_operation_paths_and_methods
files_request_without_a_files_capable_channel_returns_503
files_upstream_error_status_and_body_pass_through_unchanged
messages_referencing_files_pin_to_the_bound_account
messages_without_the_files_beta_keep_normal_routing
files_beta_pin_miss_falls_back_to_normal_routing
files_account_prefers_a_deterministic_account
openai_api_forwards_direct_models_with_native_protocols
openai_api_models_list_respects_protocol_and_disabled_account
vibetoken_forwards_direct_models_with_native_protocols
vibetoken_models_list_respects_protocol_and_disabled_account
```

```text
# proxy_http.rs (14)
log_capture_missing_size_limit_uses_512_mb_default
sanitize_headers_redacts_bearer
encode_body_roundtrips_string
decompress_for_capture_handles_gzip_and_unknown
prepare_captured_res_body_decompresses_then_truncates_utf8
content_encoding_value_takes_first_token_lowercase
apply_request_headers_drops_stale_content_length
apply_request_headers_replaces_client_bearer_credentials
apply_request_headers_replaces_client_x_api_key_credentials
apply_request_headers_strips_local_agent_identity_before_forwarding
apply_request_headers_forwards_the_native_dsh_session_header
extract_model_strips_long_context_suffix
apply_request_headers_filters_context_1m_beta_only
apply_request_headers_drops_beta_header_when_only_context_1m
```

```text
# usage.rs (16)
extracts_longcat_usage_from_completed_sse
incrementally_extracts_usage_across_arbitrary_chunk_boundaries
incremental_usage_marks_message_start_only_as_incomplete
incremental_usage_accepts_positive_output_without_terminal_marker
rejects_sse_usage_without_done_marker
extracts_longcat_anthropic_usage_from_message_stop_stream
captures_anthropic_cache_write_tokens
anthropic_shape_ignores_leaked_prompt_tokens_to_avoid_double_counting_cache
anthropic_stream_with_leaked_prompt_tokens_does_not_double_count_cache
openai_shape_still_prefers_prompt_tokens
extracts_responses_streaming_usage_from_response_completed
extracts_responses_non_streaming_top_level_usage
extracts_usage_from_completed_stream_without_done_marker
rejects_truncated_capture_with_only_message_start_usage
extracts_stream_usage_falls_back_to_plain_json_message
detects_first_output_token_but_ignores_metadata_events
```

```text
# proxy_anthropic_compat.rs (6)
repairs_missing_thinking_at_every_chunk_boundary
preserves_other_events_existing_values_and_invalid_json_byte_for_byte
repairs_real_missing_tool_input_at_every_chunk_boundary
repaired_tool_start_preserves_argument_deltas_through_completion
oversized_line_passes_through_and_next_event_is_repaired
bypass_and_incomplete_tails_are_unchanged_and_errors_propagate
```

```text
# request_capture.rs (3)
appends_and_randomly_reads_a_compressed_frame
rotates_session_segments_at_the_configured_limit
rejects_storage_keys_that_escape_the_capture_root
```

```text
# rate_limiter.rs (2)
rate_limiter_allows_within_limit
rate_limiter_separate_clients
```


**核对结论**：`proxy_tests.rs` 138 + `proxy_http.rs` 14 + `usage.rs` 16 + `proxy_anthropic_compat.rs` 6 + `request_capture.rs` 3 + `rate_limiter.rs` 2 = **179**，与 §2.1 统计一致。

### 附录 B：受控例外 → 函数/行号定位表

| 行为 | 文件:行 | 调用点 |
|---|---|---|
| 入站模型名归一 | `core/model_catalog.rs:160-165` | `proxy.rs:888` |
| 模型名 `[1m]` 剥离 | `core/proxy_http.rs:917-935` | `proxy_http.rs:925-935` |
| `model` 字段改写 | `core/proxy_http.rs:1374-1427` | `proxy.rs:1150-1151` |
| DeepSeek `reasoning_content` 回填 | `core/proxy_http.rs:1429-1485` | `proxy.rs:1152-1155` |
| Anthropic 起始块修复 | `core/proxy_anthropic_compat.rs:72-114` | `proxy.rs:1797-1800` |
| `context-1m` beta 过滤 | `core/proxy_http.rs:711-725` | `proxy_http.rs:680-686` |
| 智谱去 `/v1` | `core/proxy_http.rs:631-639` + `channels_config.rs:20-23` | `proxy.rs:1169-1177` |
| `/v1` 去重 | `core/proxy_http.rs:646-652` | `proxy_http.rs:598-625` |
| 保留头剥离 | `core/proxy_http.rs:656-703` | `proxy.rs:1193-1199`、`684-690` |
| hop-by-hop 剥离 | `core/proxy_http.rs:736-748` | 请求/响应两侧 |
| Anthropic beta 丢弃 | `core/proxy_http.rs:680-686` | 同上 |
| Responses 405 | `core/proxy.rs:820-837` | — |
| Files 绑定 | `core/proxy_routing.rs:266-296` | `proxy.rs:657`、`964` |
| Files pin | `core/proxy.rs:958-975` | — |
| 出口代理 | `core/upstream_proxy.rs:229-311` | `proxy.rs:680-682`、`1178-1183` |
| 凭证状态 | `core/proxy.rs:50-117`、`1274-1279`、`1318-1356` | — |
| 限流 | `core/rate_limiter.rs:20-69` | `proxy.rs:901-917` |
| 图片模态 | `core/model_input_capabilities.rs:201-256` | `proxy.rs:946-955` |

### 附录 C：关键常量与枚举

| 名称 | 值 | 位置 |
|---|---|---|
| 默认监听 | `127.0.0.1:18640` | `proxy.rs:119`、`config.rs:1971-1979` |
| 默认客户端 token | `flowlet-local-token` | `config.rs:1966-1968` |
| 默认上游超时 | 120s | `services.rs:12` |
| 限流 | 600 rpm / 秒级补充 | `proxy.rs:306`、`rate_limiter.rs:21-28` |
| body 捕获上限 | 1 MiB（UTF-8 边界） | `config.rs:2001+` |
| usage 解析上限 | 1 MiB 缓冲；SSE 单行 8 MiB | `usage.rs:11`、`proxy.rs:2201-2240` |
| TTFT 探测 | 64 KiB | `proxy.rs:121` |
| 终止探测尾部 | 512 B | `proxy.rs:2141` |
| Anthropic 行上限 | 64 KiB | `proxy_anthropic_compat.rs:7` |
| Files 上限 | 128 MiB + 1 MiB | `proxy.rs:563` |
| `.flcap` | magic `FLCAP001`，v1，60 B 头，zstd level 3，32 MiB 分段 | `request_capture.rs:13-17` |
| 日志滚动 | 按天、保留 7 | `logging.rs:50-57` |
| Agent 标记头 | `x-flowlet-client` / `x-flowlet-session` / `x-deepseek-harness-session-id` | `agent_session_identity.rs:3-8` |
| 客户端凭据头 | `authorization` / `x-api-key` | `proxy_http.rs:754-782` |
| 脱敏头 | `authorization`、`x-api-key`、`cookie`、`set-cookie`、`x-auth-token` | `config.rs:2039-2048` |
| 降级状态码 | 429 / 5xx / deepseek 402 | `proxy_routing.rs:300-309` |
| body 探测状态码 | 400 / 402 / 403 | `proxy_routing.rs:311-315` |
| 错误码 | `no_available_account`、`no_available_model`、`model_not_exposed`、`model_protocol_unsupported`、`model_input_modality_unsupported`、`responses_unsupported_method`、`files_account_unavailable`、`files_upload_too_large`、`model_not_found` | `proxy.rs:1020-1062`、`proxy.rs:820-837`、`proxy.rs:636`、`proxy_http.rs:424` |

### 附录 D：函数索引（文件:行，便于实现者跳转）

| 主题 | 函数 | 位置 |
|---|---|---|
| 启动/停止/状态 | `ProxyController::start*` / `stop` / `status` | `proxy.rs:292-496` |
| 入站分发 | `forward_openai_compatible` / `forward_anthropic_compatible` | `proxy.rs:513-557` |
| Files | `forward_files_api_request` / `files_api_request` | `proxy.rs:571-749` / `proxy_http.rs:87-102` |
| 主流程 | `forward_request` | `proxy.rs:780-1508` |
| 日志上下文 | `RouteLogContext` + `base_log_input` / `log_fallback` / `log_final_network_error` / `log_success_base` | `proxy.rs:1518-1708` |
| 缓冲响应 | `read_buffered_body` / `build_response` / `build_buffered_response` | `proxy.rs:1712-1942` |
| 流式 | `capture_timed_stream` / `send_stream_done` / `TimedStreamState::drop` / `update_stream_log` | `proxy.rs:2179-2438` |
| 捕获帧 | `RequestCaptureStore::append_locked/read/rewrite_segment_locked` | `request_capture.rs:180-375` |
| 日志落库 | `insert_request_log` / `update_request_log_timing` / `upsert_usage_record_with_metadata` | `storage_usage.rs:914-1022` / `1804-1864` / `2805+` |
| usage | `StreamUsageAccumulator` / `extract_usage_from_value` / `contains_sse_output_token` | `usage.rs:18-353` |
| 路由 | `match_candidates` / `sort_route_candidates` / `files_account` / `should_try_next_status` | `proxy_routing.rs:36-390` |
| Anthropic 修复 | `ContentBlockStartCompat::push` / `normalize_line` / `normalize_content_block_starts` | `proxy_anthropic_compat.rs:9-114` |
| 头/URL | `apply_request_headers` / `build_upstream_url` / `sanitize_headers` / `decompress_for_capture` | `proxy_http.rs:598-1049` |
| 模型名/回填 | `extract_model` / `rewrite_model` / `ensure_reasoning_content_passback` | `proxy_http.rs:917-1485` |
| 出口代理 | `model_forwarding_client` / `execute_model_request` | `upstream_proxy.rs:252-311` |

### 附录 E：取证方式与限制（可复核）

- 通读文件：§1.1 所列全部文件；关键函数按段 `read`（非仅注释）。
- 统计：`wc -l`、`grep -c`（测试计数：`^\s*#\[(tokio::)?test\]`）。
- 环境探测：`node -v` = 26.13.0；`poc/electron-host/node_modules/electron` = 45.2.3，`ELECTRON_RUN_AS_NODE=1 electron -e` 输出 Node 24.22.2、`zstd`/`sqlite` 均 `function`。
- `config.json`：9 个渠道 preset、无账号 Key；`log_capture` 默认全开、`redact_sensitive_headers=false`、`max_body_bytes=1MiB`。
- `poc/electron-host/data/flowlet.sqlite`：14 个账号，`api_key` 非空（仅统计长度，未输出内容）；目录 untracked，**未用于任何网络请求**。
- **未做**：`cargo test` / `cargo check` / `npm` 构建 / 上游网络调用 / Rust 运行时行为实测；因此 §3 的行为描述以源码与断言为准，spike 必须实测确认。

---

## 10. 给迁移排期的最终判断

1. **代理核心没有"不可实现"的硬缺口**，全部行为都能在 Node/Electron 复现；真正风险是**等价度**和**回归资产（179 个测试）的移植质量**。
2. 建议排期：**先 1 天 spike（§7）→ 用实测修正 → 再开 P0 对拍基建与 P1/P2 并行**；不要先写业务再补测试，否则 138 个 e2e 断言会失效。
3. 需要在开工前拍板的 6 项见 §6 末尾；其中 **SQLite 选型**与 **系统代理等价**两项会直接影响 P1/P3 的估时。
4. 与平台迁移（`docs/migration/platform-gap-matrix.md`）的接口：`powerSaveBlocker`、窗口/生命周期、单实例、打包；代理只依赖"能拿到系统代理配置"和"能抑制待机"两个平台 port。
