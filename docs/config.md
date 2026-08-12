# config.md — config.json 完整字段说明

`config.json` 是 Flowlet 的**渠道与运行时配置文件**，位于项目根目录（与 `package.json` 同级）。

Rust 后端在启动时读取它，并通过 Tauri command `read_config` / `write_config` 提供底层读写能力；当前正式前端没有通用配置编辑入口。

---

## 1. 文件位置与加载优先级

| 场景 | 实际路径 |
|------|----------|
| 桌面应用（便携版 / 安装版） | `flowlet.exe` 同级目录下的 `config.json` |
| headless 模式 | 当前工作目录下的 `config.json` |
| 前端开发（`bun run dev`） | 项目根目录 `config.json` |

### 资源声明

`src-tauri/tauri.conf.json` 的 `resources` 字段声明了 `"../config.json": "config.json"`，确保 Tauri 打包时把根目录的 `config.json` 复制到资源目录，最终发布在 exe 旁边。

### 加载与回退逻辑

1. **外部 `config.json` 优先**：Rust 启动时先尝试读取 exe 旁的 `config.json`。
2. **编译时内置副本**：若外部文件不存在、或缺少 `channels_config` 字段、或解析失败，回退到 `include_str!` 进二进制的默认配置（即仓库根目录 `config.json` 的编译时快照）。
3. **首次启动写入**：若运行时 `config.json` 不存在，`ensure_config_file` 会把内置副本写入磁盘，用户之后可直接编辑。
4. **便携版打包**：`scripts/build-portable.mjs` 会把根目录 `config.json` 复制进便携版 ZIP。

> 修改仓库根目录的 `config.json` 会同时影响「编译时内置默认值」和「便携版打包产物」。

### 默认值同步（重要）

`channels_config` 的渠道模板仍有 Rust 工厂兜底；模型身份已集中到共享目录：

| 位置 | 作用 |
|------|------|
| `config.json`（仓库根目录） | 运行时外部文件 + 编译时 `include_str!` 默认值 |
| `model-catalog.json` | 模型白名单、官方渠道归属、别名和 models-cn provider 映射的单一事实源 |
| `src-tauri/src/core/config.rs` 中的 `ChannelPreset::longcat()` / `ChannelPreset::deepseek()` / `ChannelPreset::kimi()` / `ChannelPreset::qwen()` / `ChannelPreset::zhipu()` / `ChannelPreset::openrouter()` | Rust 侧的工厂默认值 |

> OpenRouter（`openrouter`）是聚合渠道：其 `/models` 返回全部主流模型（带
> `vendor/` 前缀），因此天然可以勾选开放任意 Flowlet 白名单模型；开放哪些模型
> 由用户在账号编辑器中**显式勾选**，与普通渠道一致，**不进入**
> `default_exposed_models` / `DEFAULT_EXPOSED_MODELS_BY_CHANNEL`（不维护静态默认
> 开放列表，也不默认全勾选）。

新增渠道或修改模型支持范围时，务必同步更新对应位置；前端和 Rust 均从
`model-catalog.json` 读取模型身份，不再维护两份白名单或别名表。

---

## 2. 顶层结构

```jsonc
{
  "ua_rules": [ ... ],          // UA 客户端识别规则
  "log_capture": { ... },       // 请求日志捕获配置
  "bind": { ... },              // 代理监听地址
  "channels_config": { ... }    // 渠道、价格、模型配置
}
```

| 字段 | 类型 | 必须 | 说明 |
|------|------|------|------|
| `ua_rules` | `UaClientRule[]` | 是 | 基于 User-Agent 子串的客户端身份识别规则 |
| `log_capture` | `object` | 是 | 请求/响应日志的捕获与脱敏配置 |
| `bind` | `object` | 是 | 本地代理监听的 host/port |
| `channels_config` | `object` | 是 | 渠道模板、价格、默认开放模型、档位 |

## 3. `ua_rules` — 客户端身份识别

```jsonc
"ua_rules": [
  {
    "id": "opencode",          // 规则唯一标识
    "pattern": "opencode/",    // User-Agent 包含此子串即命中
    "name": "OpenCode",        // 日志/用量中展示的客户端名称
    "enabled": true            // 是否启用
  },
  {
    "id": "codex",
    "pattern": "codex_cli_rs/",
    "name": "Codex",
    "enabled": true
  },
  {
    "id": "codex-desktop",
    "pattern": "Codex Desktop/",
    "name": "Codex Desktop",
    "enabled": true
  }
]
```

**行为**：

- 代理收到请求后，用 `User-Agent` 逐个匹配 `enabled` 的规则；命中第一条即停止。
- 与鉴权 token 解耦：仅决定日志/用量中的客户端归属，不控制能否请求。
- 不命中任何规则时，客户端标记为"未知"（`client_id = NULL`）。
- 每次请求都从 `config.json` 热读，修改后立即生效，无需重启代理。
- 内置兜底规则：Flowlet 随版本内置少量默认规则（当前为 `codex` 与
  `codex-desktop`），加载时按 `id` 去重补入——用户配置中完全缺失该 `id` 时才补充，
  用户显式禁用则尊重用户。因此早于该规则的已有安装无需改 `config.json` 也能正确
  归属；该机制不改写用户文件。

**字段说明**：

| 字段 | 类型 | 必须 | 说明 |
|------|------|------|------|
| `id` | `string` | 是 | 规则唯一标识，在日志中作为 `client_id` |
| `pattern` | `string` | 是 | User-Agent 子串，区分大小写 |
| `name` | `string` | 是 | 展示名称 |
| `enabled` | `bool` | 是 | `false` 时跳过该规则 |

---

## 4. `log_capture` — 请求日志捕获

```jsonc
"log_capture": {
  "capture_req_headers": true,       // 记录请求 Header
  "capture_req_body": true,          // 记录请求 Body
  "capture_res_headers": true,       // 记录响应 Header
  "capture_res_body": true,          // 记录响应 Body
  "max_body_bytes": 1048576,         // 单条 Body 最大字节数（1 MB）
  "redact_sensitive_headers": false, // 是否脱敏敏感 Header
  "body_retention_days": 7,          // Body 保留天数（-1=永久, 0=不保留, N=保留 N 天后清除）
  "body_max_size_mb": 1024,          // Body 数据体积上限（MB），超出后按比例清理最老的记录（0=不限制）
  "body_prune_ratio": 0.1            // 超出体积上限时，清理最老记录的比例（0.0~1.0）
}
```

**字段说明**：

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `capture_req_headers` | `bool` | `true` | 是否记录请求 Header |
| `capture_req_body` | `bool` | `true` | 是否记录请求 Body |
| `capture_res_headers` | `bool` | `true` | 是否记录响应 Header |
| `capture_res_body` | `bool` | `true` | 是否记录响应 Body |
| `max_body_bytes` | `number` | `1048576` | 单条 Body 截断上限（1 MB） |
| `redact_sensitive_headers` | `bool` | `false` | 关闭时原样保存、展示和复制；开启后，`authorization` / `x-api-key` / `cookie` / `set-cookie` / `x-auth-token` 在落库前被替换为 `[redacted]` |
| `body_retention_days` | `number` | `7` | Body 保留天数：`-1` = 永久保留；`0` = 不保留（落库后立即清除 Body）；`N` = 保留 N 天后自动清除 |
| `body_max_size_mb` | `number` | `1024` | Body 数据体积上限（MB）。超出后按 `body_prune_ratio` 比例清理至少一小时前、已有完整 Token 统计的记录。`0` = 不限制（仅受 `body_retention_days` 控制） |
| `body_prune_ratio` | `number` | `0.1` | 超出 `body_max_size_mb` 时，单次清理最老记录的比例（`0.0`~`1.0`）。例如 `0.1` = 清理最老的 10%（按 `created_at` 升序），将体积压回阈值以下 |

**行为**：

- 缺失任何字段时使用上述默认值。
- 修改后立即生效（热读），无需重启代理。
- Body 在版本化 `.flcap` 压缩帧中以 base64 表示原始字节，文件位于 SQLite 同目录的
  `request-captures/`；SQLite 只保存随机读取所需的相对路径、offset、长度和校验和。
- 新请求的 `req_body_b64` / `res_body_b64` SQLite 列保持 `NULL`；旧数据库中尚未迁移的
  Body 仍可由详情与数据修复链路兼容读取。
- UI 不再二次脱敏，展示和复制的内容与 SQLite 捕获内容一致。
- 清理仅针对输入、输出 Token 均已完成计算的记录，确保未完成计算的记录仍可重解析。
- 应用启动 15 分钟后执行第一次清理，之后每 15 分钟执行一次；任务在后台线程运行，并写入任务日志。每轮先把最多 200 条旧 SQLite Body 搬迁到捕获文件，文件引用提交成功后才清空旧列；随后执行过期和超限清理。完成后，已启用增量回收的数据库最多向文件系统归还 64 MB 空闲页，避免长时间锁库。
- 过期清理与体积上限清理都会记录请求、响应 Body 各自的清理时间与原因，详情页可区分“未捕获”“数据过期被清理”和“因空间上限被清理”。
- 体积上限是软限制：只清理至少一小时前的 Body，最近一小时的数据始终保留；若近期数据本身超过上限，则允许暂时超限，优先保证最新请求可排查。
- 文件 Body 清理通过重写仍有有效记录的 segment 完成：SQLite 引用事务提交后才删除旧
  segment，不能只标记“已清理”而在文件中留下原文。旧 SQLite Body 被清除后仍会先把
  对应页放入 freelist；新建数据库默认使用 `auto_vacuum = INCREMENTAL`，旧数据库需要在
  设置页执行一次“优化存储”，完整压缩并切换到增量模式。完整优化期间前端会暂停代理，
  完成或失败后恢复原运行状态；后续定时任务只做每轮最多 64 MB 的增量回收。

---

## 5. `bind` — 代理监听地址

```jsonc
"bind": {
  "host": "127.0.0.1",  // 监听地址；"0.0.0.0" 表示允许局域网
  "port": 18640         // 监听端口
}
```

**字段说明**：

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `host` | `string` | `"127.0.0.1"` | 监听地址。`"0.0.0.0"` 表示允许局域网访问 |
| `port` | `number` | `18640` | 监听端口。`0` 会被归一化为 `18640` |

**行为**：

- 优先从 `config.json` 顶层 `bind` 读取；缺失时回退到 SQLite `app_meta` 中的旧配置。
- `host = "0.0.0.0"` 时，`normalized()` 会设置 `allow_lan = true`。
- **修改 host/port 后需要重启代理**才能生效（不属于热更新字段）。

---

## 6. `channels_config` — 渠道配置

```jsonc
"channels_config": {
  "channels": [ ... ],                  // 渠道模板列表
  "model_prices": [ ... ],              // 模型价格预设
  "default_exposed_models": { ... }     // 各渠道默认提供的模型
}
```

### 6.1 `channels` — 渠道模板

每个元素定义一个上游渠道（如 LongCat、DeepSeek、Kimi、Qwen、Z.AI、OpenRouter）。

```jsonc
{
  "id": "longcat",                         // 渠道唯一标识（与 vendor 通常一致）
  "name": "LongCat",                       // 展示名称
  "vendor": "longcat",                     // 厂商标识
  "platform_url": "https://...",           // 渠道控制台跳转地址（可选）
  "supported_protocols": ["openai", "anthropic"],
  "openai_base_url": "https://api.longcat.chat/openai",
  "anthropic_base_url": "https://api.longcat.chat/anthropic",
  "openai_auth": "bearer",                 // "bearer" 或 "x_api_key"
  "anthropic_auth": "bearer",
  "default_model": "LongCat-2.0",          // 该渠道默认使用的模型
  "small_model": null,                     // 小模型（可选）
  "supports_model_list": true,             // 是否支持拉取模型列表
  "supports_model_detail": true,           // 是否支持查询模型详情
  "supports_price_sync": false,            // 是否支持同步价格
  "supports_balance_query": false,         // 是否支持查询余额
  "supports_quota_query": false,           // 是否支持查询额度
  "supports_usage_query": false,           // 是否支持查询用量
  "supports_scrape_balance": true,         // 是否支持控制台抓取套餐余量
  "endpoints": {                           // 端点 URL 覆盖（可选）
    "models": "https://api.longcat.chat/openai/v1/models",
    "model_detail": "https://api.longcat.chat/openai/v1/models/{id}"
  },
  "scrape": {                              // 控制台抓取配置(可选)
    "hybrid": {                            // 模式 key(longcat: hybrid;qwen: token_plan)
      "console_url": "https://longcat.chat/platform/usage?tab=token",
      "console_url_secondary": "https://longcat.chat/platform/usage?tab=api",
      "console_url_tertiary": "https://longcat.chat/platform/fuel_pack",
      "interceptor_js": "...",             // document-start 注入的响应拦截器 JS(IIFE)
      "extractor_js": "function extract(bundle){ ... }", // 解析器 JS(函数声明)
      "aggregate": true,                   // 是否需聚合多份响应后再调 extractor
      "required_slots": ["token_packs_summary", "api_usage_summary", "token_packs_list"]
    }
  }
}
```

**字段说明**：

| 字段 | 类型 | 必须 | 默认值 | 说明 |
|------|------|------|--------|------|
| `id` | `string` | 是 | — | 渠道唯一标识，在账号/路由/价格中引用 |
| `name` | `string` | 是 | — | 前端展示名称 |
| `vendor` | `string` | 是 | — | 厂商标识，用于内部匹配 |
| `platform_url` | `string?` | 否 | `null` | 渠道控制台跳转地址，前端"获取 API Key"按钮链接 |
| `supported_protocols` | `string[]` | 否 | `[]` | 支持的协议，可选 `"openai"` / `"anthropic"` / `"responses"`（OpenAI Responses API，仅无状态透传） |
| `openai_base_url` | `string` | 否 | `""` | OpenAI 协议的上游 Base URL |
| `anthropic_base_url` | `string` | 否 | `""` | Anthropic 协议的上游 Base URL |
| `openai_auth` | `string` | 否 | `"bearer"` | OpenAI 协议鉴权方式：`"bearer"` 或 `"x_api_key"` |
| `anthropic_auth` | `string` | 否 | `"bearer"` | Anthropic 协议鉴权方式：`"bearer"` 或 `"x_api_key"` |
| `default_model` | `string` | 否 | `""` | 该渠道默认使用的上游模型名 |
| `small_model` | `string?` | 否 | `null` | 小模型名，用于轻量任务 |
| `supports_model_list` | `bool` | 否 | `false` | 是否支持从上游拉取模型列表 |
| `supports_model_detail` | `bool` | 否 | `false` | 是否支持查询单个模型详情 |
| `supports_price_sync` | `bool` | 否 | `false` | 是否支持从上游同步价格 |
| `supports_balance_query` | `bool` | 否 | `false` | 是否支持查询账户余额 |
| `supports_quota_query` | `bool` | 否 | `false` | 是否支持查询额度 |
| `supports_usage_query` | `bool` | 否 | `false` | 是否支持查询用量 |
| `supports_scrape_balance` | `bool` | 否 | `false` | 是否支持通过后台 webview 登录控制台并拦截 API 抓取套餐余量 |
| `endpoints` | `object` | 否 | `{}` | 端点 URL 覆盖，key 如 `"models"` / `"model_detail"` / `"balance"`；OpenRouter 额外使用 `"credits"` |
| `scrape` | `object` | 否 | `{}` | 控制台抓取配置。key 为渠道内的抓取模式（当前 LongCat 为 `"hybrid"`，Qwen 为 `"token_plan"`），value 可包含 `console_url`、可选的 `console_url_secondary`、可选的 `console_url_tertiary`（第三阶段导航 URL，用于 LongCat 加载 `/platform/fuel_pack` 补全已用尽/已过期的历史资源包）、`interceptor_js`、`extractor_js`、`aggregate` 与 `required_slots`。聚合模式按 `required_slots` 判断完整性；单页面模式等待全部必需槽位，多页面且槽位数与页面数一致时按顺序让每个页面等待对应槽位。`extractor_js` 返回统一汇总字段；LongCat 还返回完整 `token_packs` 数组（活跃包来自第一阶段 `token-packs/summary`，历史包来自第三阶段 `token-packs/list`，按 `lotId=resourceId` 去重合并，历史包以 `_fromList: true` 标记），原始接口 payload 单独写入 `raw_scraped_json`。Qwen `token_plan` 模式额外拦截 `/tokenplan/personal/api/v2/reset-card/list`（页面加载时自动请求的可选槽位：有重置卡时进入 `raw_scraped_json` bundle，无卡不阻断同步，不进入 `required_slots`）。页面始终自行生成 Cookie、签名和 Header；Windows/Linux 优先从原生 WebView 网络层读取精确匹配的目标响应，macOS 与原生监听失败时使用 document-start `interceptor_js` fallback。未捕获响应不会被判定为未登录；任务日志会记录渠道、账号标识及缺失槽位。 |

内置 `custom` 模板用于中转站等完全自定义账号。渠道级 Base URL 保持为空，
真实地址保存在账号的 `base_url_override` / `anthropic_base_url_override`；至少填写
一个协议地址，Flowlet 只为实际填写地址的协议生成路由。OpenAI-compatible 使用
Bearer，Anthropic-compatible 使用 `x-api-key`。模型只能从标准 OpenAI `/models`
拉取，并统一受全局白名单约束；不提供手工添加、余额、额度、价格或控制台抓取能力。

`openrouter` 是聚合渠道：OpenAI-compatible 端点为 `https://openrouter.ai/api/v1`，
Anthropic 兼容端点（Anthropic Skin）为 `https://openrouter.ai/api`，均使用 Bearer
鉴权；**Responses 协议**（`"responses"`）从 OpenAI Base URL 派生为
`https://openrouter.ai/api/v1/responses`，官方仅支持**无状态**透传（`store: true`
或 `previous_response_id` 非空会返回 400），与 Flowlet 的 responses 语义一致。
**资源查询**（`supports_balance_query=true`）根据账号凭证分两级处理：未配置
`channel_accounts.management_key` 时走 `GET /api/v1/key`（`endpoints.balance`），以
普通模型调用 API Key 查询该 Key 的 `limit_remaining`；未设置消费限额时返回 null，
前端展示“未设置 Key 限额”，不再误报“尚未同步”。配置 Management Key 后改走
`GET /api/v1/credits`（`endpoints.credits`），使用 `total_credits - total_usage` 展示真实
账户 Credits 余额。Management Key 只用于 Credits 查询，不参与模型请求、连接测试或
路由鉴权；保存后立即生效并触发同步，无需重启代理。账号工作区启用时，该字段与 API
Key 一样包含在端到端加密的账号目录中。
模型列表走标准 OpenAI `/models`（`/api/v1/models`，模板已用 `endpoints.models`
显式覆盖）。OpenRouter `/models` 返回的模型 ID 带 `vendor/` 命名空间前缀（如
`deepseek/deepseek-v4-flash`）：白名单判断和规范模型映射会先剥离该前缀（Rust
`canonical_model_key` / 前端 `canonicalModelKey`），路由 `upstream_model` 仍保留
上游原始 ID 用于转发。由于 OpenRouter `/models` 返回全部主流模型，其账号天然
**可以**勾选开放任意 Flowlet 白名单模型——未来白名单新增模型时，只要 `/models`
返回即可由用户勾选开放；开放哪些模型由用户在账号编辑器中显式勾选，不默认全勾选
（`config.json` 不为 `openrouter` 声明 `default_exposed_models`）。

**Responses 协议端点解析**：

`responses` 不引入独立的 Base URL / 鉴权字段，统一从 OpenAI 配置派生：

- 上游 URL = `{openai_base_url}` + 入站路径（沿用 `/v1` 去重规则）：
  LongCat → `https://api.longcat.chat/openai/v1/responses`；
  Qwen → `https://dashscope.aliyuncs.com/compatible-mode/v1/responses`；
  DeepSeek → `https://api.deepseek.com/v1/responses`（裸根入口
  `/responses` 则拼出官方规范端点 `https://api.deepseek.com/responses`）；
  OpenRouter → `https://openrouter.ai/api/v1/responses`（官方仅无状态透传，
  `store: true` / `previous_response_id` 非空会返回 400，与 Flowlet 语义一致）。
- 鉴权复用 `openai_auth`；账号级覆盖复用 `base_url_override`。
- 自定义渠道只有在填写了 OpenAI Base URL 时才生成 responses 路由。
- 仅无状态透传 `POST /v1/responses`：存储响应管理接口
  （`GET`/`DELETE /v1/responses/{id}`、`input_items`）返回 405；
  `previous_response_id` / `store` 的多账号粘性不保证。
- `/v1/models` 仍按 OpenAI 协议口径返回，不存在 responses 专属模型列表。

**端点解析优先级**：

1. `endpoints[key]` 显式覆盖（优先）
2. 基于 `openai_base_url` 拼接（如 `{base}/v1/models`）
3. 返回空字符串

**行为**：

- 启动时从 `config.json` 解析；缺失的渠道模板会追加到 SQLite `channel_presets` 表。
- 已有渠道模板的 `name`、`supported_protocols`、`openai_base_url`、`anthropic_base_url`、`openai_auth`、`anthropic_auth` 会在启动时从有效配置同步，确保渠道更名、新增协议和端点修正能迁移到已有安装。
- 后续通过 `list_channel_presets` command 供前端使用。
- 同步渠道模板**不会**修改已创建账号的覆盖地址，也不会新增、删除或改变现有路由的启用状态。
- Qwen（`id = "qwen"`）是双资源模式渠道：渠道级端点是**按量付费 API** 端点
  （通用 `sk-` 前缀 Key，`resource_mode = "pay_as_you_go"`，默认）；Token Plan 订阅账号
  （`sk-sp-` 前缀 Key，`resource_mode = "token_plan"`）通过账号级 `base_url_override` /
  `anthropic_base_url_override` 指向 `https://token-plan.cn-beijing.maas.aliyuncs.com`
  下的专属端点，由账号编辑器在选择 Token Plan 模式时自动写入。API 按量付费账号
  没有官方余额接口也没有可用的控制台抓取模式，走手动维护余额，不参与自动同步；
  Token Plan 订阅额度由官方控制台抓取并固定自动同步。

### 6.2 `model_prices` — 模型价格预设

```jsonc
{
  "channel_id": "longcat",          // 关联渠道 id
  "upstream_model": "LongCat-2.0",  // 上游模型名
  "input_uncached_price": 2.0,      // 输入价格（未缓存，每 unit）
  "input_cached_price": 0.04,       // 输入价格（已缓存，每 unit）
  "input_cache_write_price": null,  // 可选：缓存写入价格（每 unit）
  "output_price": 8.0,              // 输出价格（每 unit）
  "currency": "CNY",                // 货币单位
  "unit": "1M tokens",              // 计价单位
  "source_url": null,                // 可选：价格来源
  "price_version": null              // 可选：价格版本或核验日期
}
```

**字段说明**：

| 字段 | 类型 | 必须 | 默认值 | 说明 |
|------|------|------|--------|------|
| `channel_id` | `string` | 是 | — | 关联的渠道 id |
| `upstream_model` | `string` | 是 | — | 上游模型名 |
| `input_uncached_price` | `number` | 否 | `0` | 未缓存输入 token 单价 |
| `input_cached_price` | `number` | 否 | `0` | 已缓存输入 token 单价 |
| `input_cache_write_price` | `number \| null` | 否 | `null` | 缓存写入 token 单价；缺失时回退到未缓存输入单价 |
| `output_price` | `number` | 否 | `0` | 输出 token 单价 |
| `tiers` | `array` | 否 | `[]` | 按输入长度分级计价；非空时按请求总输入 Token 选档 |
| `tiers[].up_to_input_tokens` | `number \| null` | 否 | `null` | 该档总输入 Token 闭区间上限；`null` 为无上限兜底档 |
| `tiers[].input_uncached_price` / `input_cached_price` / `input_cache_write_price` / `output_price` | 同上 | 否 | 同上 | 该档内的单价，语义同扁平字段 |
| `currency` | `string` | 否 | `"USD"` | 货币单位 |
| `unit` | `string` | 否 | `"1M tokens"` | 计价单位 |
| `source_url` | `string \| null` | 否 | `null` | 价格来源页面，用于解释预估依据 |
| `price_version` | `string \| null` | 否 | `null` | 价格版本或最近核验日期 |

**行为**：

- 运行时价格表以两份本地模型目录为主装配：`models-cn.json`（国内厂商官方价，CNY）与
  `models-dev.json`（models.dev 国际官方价，USD），两者随安装包内置到 exe 旁，并由后台任务
  每小时自动同步更新；`config.json` 的 `model_prices` 仅补充目录未覆盖的
  `(channel_id, upstream_model)`（例如自定义渠道的显式价格），与目录冲突时以目录为准。
- 价格表在应用启动时与每次目录同步成功后重建（重建时会重新读取 `config.json`，
  因此 config 价格改动最迟在下一次目录同步后生效，也可通过重启立即生效）；
  SQLite 不保存 `model_prices` 表。
- 用于离线成本估算（`estimated_cost`），不进入主请求链路。
- `channel_id = "openai-api"` 是标准 OpenAI API 公开价格的保留命名空间，用于计算 Codex 原生会话的 API 等价价值；数据来自 `models-dev.json` 的 `openai` provider，结果保留价格表原币种，不做汇率转换。
- `channel_id = "codex-native"` 是 Codex 套餐消耗的保留价格命名空间，由 `openai-api` 美元价按固定比例（1 USD = 25 CREDITS）派生；两个保留命名空间都不代表新增代理渠道，也无需在 `model_prices` 中手工维护。
- Codex 原生预估只在会话能够确定唯一模型且对应价格表存在精确模型匹配时生成；无法确认模型或无公开价格的模型保持未计价，不做推测。API 等价价值采用标准基础 API 价格，不叠加无法从原生记录可靠确认的长上下文、Priority processing 或 Fast mode 等乘数。

### 6.3 `default_exposed_models` — 默认开放模型

```jsonc
"default_exposed_models": {
  "longcat": ["LongCat-2.0"],
  "deepseek": ["deepseek-v4-flash", "deepseek-v4-pro"],
  "kimi": ["kimi-k3", "kimi-k2.7-code"],
  "qwen": ["qwen3.8-max", "qwen3.7-max", "qwen3.7-plus", "qwen3.7-flash", "qwen3.6-plus", "qwen3.6-flash"],
  "zhipu": ["glm-5.2", "glm-4.7", "glm-4.5-air"]
}
```

**结构**：`Record<channel_id, upstream_model[]>`。

**行为**：

- 该字段是各渠道「默认提供哪些模型」的描述性列表，**不再直接作为开放模型的白名单**。
  真正的白名单来自仓库根目录 `model-catalog.json`；Rust `supported_models()` 与前端
  `FLOWLET_SUPPORTED_MODELS` 均读取该目录，不需要双写同步。
- 白名单**不按渠道区分**：任意渠道账号只要底层 `/models` 返回了其中的模型，就可勾选开放。
  例如千问套餐端点也会返回 `deepseek-v4-pro`，该模型在全局白名单内，故可勾选。
- 一个账号开放哪些模型由**用户显式选择**：在账号编辑器里手动「拉取模型列表」
  （底层 `/models`，Rust command `fetch_channel_models`），编辑器展示全量上游模型、
  白名单之外的模型展示但禁用勾选，用户勾选后将上游返回的原始模型 ID 保存到
  `channel_accounts.exposed_models`；同一规范模型映射到多个独立上游资源时可分别勾选。
- 实际为账号自动生成的直连路由 = 全局白名单 **∩ 最近一次 `/models` 返回的
  `synced_models` ∩ 用户勾选的上游原始 ID `exposed_models`**。白名单按规范模型判断，
  路由 `virtual_model_id` 使用规范 ID，`upstream_model` 保留原始 ID；同一规范模型的
  多个上游 ID 分别生成 Route Candidate，对外 `/models` 仍只暴露一个规范模型。
  - 白名单之外的模型**绝不生成路由**（即使上游 `/models` 返回了、用户也看得到，仍不可勾选）。
  - `exposed_models` 为 `NULL`（尚未用新流程配置）的账号**保持路由现状不动**（老账号升级不受影响）；
    为空数组的账号**不开放任何模型**；旧版本只保存规范 ID 的别名选择在规范 ID 未
    精确返回时，兼容回退到同规范模型的首个上游 ID。
- `channel_accounts.synced_models` / `models_synced_at` 保存最近一次 `/models` 结果，
  既作为编辑器候选池缓存，也作为已配置账号生成路由时的来源校验；未在
  `synced_models` 中的模型不会生成或保留路由。
- 保存账号时前端按 `exposed_models` 对账路由：删除取消勾选模型关联的直连与聚合路由、补齐新勾选模型的直连路由，
  保留用户已有的启停状态、优先级和时间戳。
- 自动补齐路由时，只有全局最早创建的渠道账号的新路由默认开启；后续新增的任何官方
  或自定义渠道账号，其新路由默认关闭并等待用户手动开启。已有路由的启停状态不追溯修改。
- 合并逻辑前后端各一份：`src-tauri/src/core/channels_config.rs` 的 `merge_default_routes`
  与 `src/domains/model/commands.ts` 的 `mergeDefaultRoutes`，行为必须一致（只追加缺失路由，
  不覆盖用户已有的启停状态、优先级和时间戳；删除动作由前端 `reconcileAccountRoutes` 在保存时执行）。
- `custom` 渠道不例外：模型必须来自该账号 `/models` 返回结果，并与全局白名单取交集；
  白名单外模型展示为“不支持”且禁用勾选，不能进入 `exposed_models` 或生成路由。
- `openrouter` 是聚合渠道：`/models` 返回全部主流模型（带 `vendor/` 前缀，按
  `canonicalModelKey` 剥前缀映射白名单），因此其账号**可以**勾选开放任意白名单
  模型——未来白名单新增模型时，只要 OpenRouter `/models` 返回即可由用户勾选开放。
  开放哪些模型由用户在账号编辑器中显式勾选（与其他渠道一致），不默认全勾选，也
  不进入 `DEFAULT_EXPOSED_MODELS_BY_CHANNEL`（避免官方归属映射
  `official_channel_id_for_model` 被聚合渠道污染），无需在 `config.json` /
  `DEFAULT_EXPOSED_MODELS_BY_CHANNEL` 同步维护静态列表。

`flowlet-pro` 与 `flowlet-flash` 的候选关系不属于 `config.json`。用户在模型服务页从已有
渠道模型中显式添加；添加时复用该渠道模型已经存在的协议路由，保存后立即热更新。

---

## 7. 运行时行为

### 热更新 vs 需重启

| 配置 | 修改后行为 |
|------|-----------|
| `ua_rules` | **热更新**：下次请求立即生效 |
| `log_capture` | **热更新**：下次请求立即生效 |
| `bind` | **需重启代理**：监听地址在启动时绑定 |
| `channels_config` | **需重启应用**：仅在启动时解析一次；缺失渠道会追加，协议、Base URL 和鉴权字段会同步到 SQLite，模型价格只加载到运行时内存 |

### 前端读写

Rust 暴露以下 Tauri command；当前正式前端没有通用配置编辑入口：

- `read_config()` → 返回 `config.json` 原始字符串
- `write_config(content)` → 写入完整 JSON 字符串

**写入校验**：`write_config_raw` 仅校验顶层为 JSON 对象或数组，**不做字段级 schema 校验**。新增配置编辑入口时，前端必须自行完成字段级语义校验。

> 前端不直接访问文件系统；渠道、账号和模型数据通过各自的 Tauri command（如 `list_channel_presets`）从 SQLite 获取。

---

## 8. 新增渠道的完整步骤

端到端实现必须先阅读 [`docs/channel-integration.md`](./channel-integration.md)。该文档包含
LongCat、DeepSeek、Kimi 对照、SQLite 升级迁移、模型/余额同步、默认路由、前端与测试要求。

要在 Flowlet 中添加一个新渠道（例如 `NewProvider`）：

1. **在 `config.json` 的 `channels_config.channels` 数组中新增一项**：
   - 设置 `id`、`name`、`vendor`
   - 配置 `supported_protocols`、`*base_url`、`*auth`
   - 声明 `supports_*` 能力开关
   - 如有非标准端点，在 `endpoints` 中覆盖

2. **在 `model_prices` 中为该渠道添加价格条目**（可选，用于成本估算）。

3. **在 `default_exposed_models` 中声明默认开放的模型列表**。

4. **按 `docs/channel-integration.md` 完成 Rust 适配、SQLite 迁移、前端、图标与测试**。

5. **同步更新本文档**（第 6.1 节及示例）。

6. **运行检查**：
   - `cargo check`（Rust 编译）
   - `bun run build`（前端构建）
   - 启动应用验证渠道模板已加载

---

## 9. 相关源码

| 关注点 | 文件 |
|--------|------|
| 资源声明（打包到 exe 旁） | `src-tauri/tauri.conf.json`（`resources` 字段） |
| JSON 反序列化结构 | `src-tauri/src/core/channels_config.rs` |
| 运行时配置结构（`ChannelPreset`、`ProxyBindConfig`、`LogCaptureConfig`、`UaClientRule`） | `src-tauri/src/core/config.rs` |
| 配置读写与热加载 | `src-tauri/src/core/proxy.rs`、`src-tauri/src/core/proxy_http.rs` |
| 启动时加载与回退 | `src-tauri/src/lib.rs`（`build_app_state`、`load_channels_config_from`） |
| 前端读写 command | `src-tauri/src/commands.rs`（`read_config`、`write_config`） |
| 便携版打包 | `scripts/build-portable.mjs` |
| 前端渠道类型与默认开放模型 | `src/domains/channel/types.ts` |


---

## 10. `codex-models.json` — Codex 模型目录

`codex-models.json` 是 Flowlet 的 **Codex 模型目录数据源**，位于项目根目录（与 `config.json` 同级）。

Codex 使用自定义模型（`flowlet-pro` / `flowlet-flash`）时，必须通过 `~/.codex/config.toml` 的
`model_catalog_json` 指向一个声明模型元数据（上下文窗口、推理档位）的 JSON 文件，否则 Codex
无法正确识别这些模型。官方参照：DeepSeek 与千问 AI 平台的 Codex 接入文档均要求该文件。

### 文件内容

```json
{
  "models": [
    {
      "slug": "flowlet-pro",
      "display_name": "Flowlet Pro",
      "description": "Flowlet aggregated coding model routed to available accounts.",
      "default_reasoning_level": "high",
      "supported_reasoning_levels": [
        { "effort": "low", "description": "Fast responses with lighter reasoning" },
        { "effort": "medium", "description": "Greater reasoning depth for complex problems" },
        { "effort": "high", "description": "Extra high reasoning depth for complex problems" },
        { "effort": "xhigh", "description": "Maximum reasoning depth for the hardest problems" }
      ],
      "shell_type": "shell_command",
      "visibility": "list",
      "supported_in_api": true,
      "priority": 1,
      "base_instructions": "",
      "supports_reasoning_summaries": false,
      "default_reasoning_summary": "none",
      "support_verbosity": false,
      "default_verbosity": null,
      "apply_patch_tool_type": "freeform",
      "web_search_tool_type": "text",
      "truncation_policy": { "mode": "tokens", "limit": 10000 },
      "supports_parallel_tool_calls": true,
      "supports_image_detail_original": false,
      "context_window": 1048576,
      "max_context_window": 1048576,
      "auto_compact_token_limit": null,
      "effective_context_window_percent": 95,
      "experimental_supported_tools": [],
      "input_modalities": [ "text" ],
      "availability_nux": null,
      "upgrade": null
    }
  ]
}
```

### 字段与 Codex 版本兼容性

Codex CLI 通过 serde 反序列化该文件，**缺失必填字段会导致 Codex 启动直接报错**：

```text
failed to parse model_catalog_json path `...` as JSON: missing field `shell_type` ...
```

必填/关键字段：

- `slug` / `display_name` / `description`：模型标识与展示名；
- `default_reasoning_level` / `supported_reasoning_levels`：默认推理档位与可选档位；
- `shell_type`：shell 工具类型，Flowlet 取值 `shell_command`（启用 shell 工具；`disabled` 会禁用）；
- `visibility`：`list`（出现在模型选择器）或 `hide`；
- `supported_in_api` / `priority`：是否可用于 API 与模型选择器排序（数值越小越靠前）；
- `base_instructions`：发送给上游的系统提示词，Flowlet 聚合模型取空串；
- `supports_reasoning_summaries` / `support_verbosity` / `default_verbosity`：0.137.0 起为必填/可空
  字段，Flowlet 置 `false` / `false` / `null`；
- `truncation_policy`：工具输出截断策略，`{ "mode": "tokens", "limit": 10000 }` 与官方内置模型一致；
- `context_window` / `max_context_window` / `effective_context_window_percent`：上下文窗口声明与
  可用输入比例（默认 95）；
- `experimental_supported_tools`：实验性工具列表，空数组；
- `availability_nux` / `upgrade` / `auto_compact_token_limit`：可空字段，Flowlet 置 `null`。

推理档位注意：Codex CLI 0.137.0 只接受 `none` / `minimal` / `low` / `medium` / `high` / `xhigh`，
**不接受 `max` / `ultra`**（更高版本才支持）。DeepSeek 官方示例中的 `"effort": "max"` 与
`minimal_client_version: "0.144.0"` 面向 Codex ≥ 0.144；Flowlet 目录面向 0.137.0 及以后，
统一用 `xhigh` 表达最高推理档位，且不声明 `minimal_client_version`。

`context_window` 与 `supported_reasoning_levels` 是 Flowlet 对外声明值：实际可用上下文与推理档位
取决于当前路由模型，仅当路由模型支持时才完整生效。调整后需**重新执行 Codex 一键接入**并重启
Codex（`model_catalog_json` 仅在 Codex 启动时读取一次）。

`src-tauri/src/core/codex_model_catalog.rs` 的回归测试会校验每个模型的必填字段与推理档位合法值，
防止再次出现缺字段导致 Codex 无法启动。

### 加载方式

- **编译时内置**：`src-tauri/src/core/codex_model_catalog.rs` 通过 `include_str!` 把仓库根目录
  `codex-models.json` 编译进二进制；`apply_codex` 写入 `~/.codex/config.toml` 的
  `model_catalog_json = "~/.codex/model-catalog.flowlet.json"`，并把本文件内容原样写入
  `~/.codex/model-catalog.flowlet.json`。
- **命名空间**：生成文件名带 `flowlet` 前缀，避免覆盖 DeepSeek（`~/.codex/models.json`）或
  千问（`~/.codex/model-catalog.local.json`）等其他厂商的模型目录文件。
- **备份与恢复**：写入前会备份 `~/.codex/model-catalog.flowlet.json` 的原有内容与
  `model_catalog_json` 原值；恢复接入前配置时一并还原。

### 默认值同步（重要）

| 位置 | 作用 |
|------|------|
| `codex-models.json`（仓库根目录） | 唯一数据源：Rust `include_str!` 内置 + 写入 `~/.codex/model-catalog.flowlet.json` |
| `src/features/agent-access/AgentAccessSideSheet.tsx` 中的 `CODEX_MODEL_CATALOG_JSON` | 前端手动配置片段的展示与复制 |

修改 `codex-models.json` 时，务必同步更新 `CODEX_MODEL_CATALOG_JSON`，否则手动片段与一键写入
内容不一致。
