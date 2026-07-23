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

`channels_config` 的部分默认值在代码库中重复出现，目前没有共享 schema 生成器，必须手动保持一致：

| 位置 | 作用 |
|------|------|
| `config.json`（仓库根目录） | 运行时外部文件 + 编译时 `include_str!` 默认值 |
| `src/domains/channel/types.ts` 中的 `DEFAULT_EXPOSED_MODELS_BY_CHANNEL` | 前端创建默认开放模型时的兜底常量 |
| `src-tauri/src/core/config.rs` 中的 `ChannelPreset::longcat()` / `ChannelPreset::deepseek()` / `ChannelPreset::kimi()` / `ChannelPreset::qwen()` | Rust 侧的工厂默认值 |

新增渠道或修改默认开放模型时，务必同步更新对应位置，否则可能出现「外部配置 → SQLite → 前端展示」链条不一致的问题。

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
  }
]
```

**行为**：

- 代理收到请求后，用 `User-Agent` 逐个匹配 `enabled` 的规则；命中第一条即停止。
- 与鉴权 token 解耦：仅决定日志/用量中的客户端归属，不控制能否请求。
- 不命中任何规则时，客户端标记为"未知"（`client_id = NULL`）。
- 每次请求都从 `config.json` 热读，修改后立即生效，无需重启代理。

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
  "body_retention_days": 3,          // Body 保留天数（-1=永久, 0=不保留, N=保留 N 天后清除）
  "body_max_size_mb": 512,           // Body 数据体积上限（MB），超出后按比例清理最老的记录（0=不限制）
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
| `body_retention_days` | `number` | `3` | Body 保留天数：`-1` = 永久保留；`0` = 不保留（落库后立即清除 Body）；`N` = 保留 N 天后自动清除 |
| `body_max_size_mb` | `number` | `512` | Body 数据体积上限（MB）。超出后按 `body_prune_ratio` 比例清理至少一小时前、已有完整 Token 统计的记录。`0` = 不限制（仅受 `body_retention_days` 控制） |
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
  "default_exposed_models": { ... },    // 各渠道默认开放的模型
  "flowlet_tiers": { ... }              // Flowlet 档位映射
}
```

### 6.1 `channels` — 渠道模板

每个元素定义一个上游渠道（如 LongCat、DeepSeek、Kimi、千问 Qwen）。

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
    "token_pack": {                        // 模式 key(longcat: token_pack / pay_as_you_go;qwen: token_plan)
      "console_url": "https://longcat.chat/platform/usage?tab=token",
      "interceptor_js": "...",             // document-start 注入的响应拦截器 JS(IIFE)
      "extractor_js": "function extract(raw){ ... }",  // 解析器 JS(函数声明)
      "aggregate": false                   // 是否需聚合多份响应后再调 extractor
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
| `supported_protocols` | `string[]` | 否 | `[]` | 支持的协议，可选 `"openai"` / `"anthropic"` |
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
| `endpoints` | `object` | 否 | `{}` | 端点 URL 覆盖，key 如 `"models"` / `"model_detail"` / `"balance"` |
| `scrape` | `object` | 否 | `{}` | 控制台抓取配置。key 为渠道内的抓取模式(如 `"token_pack"` / `"pay_as_you_go"` / `"token_plan"`),value 为 `{ console_url, interceptor_js, extractor_js, aggregate? }`。`extractor_js` 返回统一汇总字段；LongCat `token_pack` 还返回完整 `token_packs` 数组，原始接口 payload 单独写入 `raw_scraped_json`。页面始终自行生成 Cookie、签名和 Header；Windows/Linux 优先从原生 WebView 网络层读取目标响应，macOS 与原生监听失败时使用 document-start `interceptor_js` fallback。每轮确认原生监听 ready 或注入 ACK 后刷新；ready 超时立即结束。未捕获响应不会被判定为未登录；用户手动刷新时展示控制台供其完成登录、验证码或等待页面加载，周期自动同步则保持窗口隐藏并把失败写入任务日志。 |

**端点解析优先级**：

1. `endpoints[key]` 显式覆盖（优先）
2. 基于 `openai_base_url` 拼接（如 `{base}/v1/models`）
3. 返回空字符串

**行为**：

- 启动时从 `config.json` 解析；缺失的渠道模板会追加到 SQLite `channel_presets` 表。
- 已有渠道模板的 `supported_protocols`、`openai_base_url`、`anthropic_base_url`、`openai_auth`、`anthropic_auth` 会在启动时从有效配置同步，确保新增协议和端点修正能迁移到已有安装。
- 后续通过 `list_channel_presets` command 供前端使用。
- 同步渠道模板**不会**修改已创建账号的覆盖地址，也不会新增、删除或改变现有路由的启用状态。
- 千问 Qwen（`id = "qwen"`）的渠道级端点是**按量付费**端点；Token Plan 订阅账号
  （`resource_mode = "token_plan"`）通过账号级 `base_url_override` /
  `anthropic_base_url_override` 指向 `https://token-plan.cn-beijing.maas.aliyuncs.com`
  下的专属端点，由账号编辑器在选择 Token Plan 模式时自动写入。

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
| `currency` | `string` | 否 | `"USD"` | 货币单位 |
| `unit` | `string` | 否 | `"1M tokens"` | 计价单位 |
| `source_url` | `string \| null` | 否 | `null` | 价格来源页面，用于解释预估依据 |
| `price_version` | `string \| null` | 否 | `null` | 价格版本或最近核验日期 |

**行为**：

- 应用启动时从 `config.json` 解析并加载到运行时内存；SQLite 不再保存 `model_prices` 表。
- 用于离线成本估算（`estimated_cost`），不进入主请求链路。
- `channel_id = "openai-api"` 是标准 OpenAI API 公开价格的保留命名空间，用于计算 Codex 原生会话的 API 等价价值；结果保留价格表原币种，不做汇率转换。
- `channel_id = "codex-native"` 是 Codex 套餐消耗的保留价格命名空间，按官方 credits/百万 Token 费率独立估算；两个保留命名空间都不代表新增代理渠道。
- Codex 原生预估只在会话能够确定唯一模型且对应价格表存在精确模型匹配时生成；无法确认模型或无公开价格的模型保持未计价，不做推测。API 等价价值采用标准基础 API 价格，不叠加无法从原生记录可靠确认的长上下文、Priority processing 或 Fast mode 等乘数。
- `config.json` 是模型价格的唯一真实来源；修改后需要重启应用以重新加载运行时价格。

### 6.3 `default_exposed_models` — 默认开放模型

```jsonc
"default_exposed_models": {
  "longcat": ["LongCat-2.0"],
  "deepseek": ["deepseek-v4-flash", "deepseek-v4-pro"],
  "kimi": ["kimi-k3", "kimi-k2.7-code"],
  "qwen": ["qwen3.7-max", "qwen3.7-plus", "qwen3.6-plus", "qwen3.6-flash"]
}
```

**结构**：`Record<channel_id, upstream_model[]>`。

**行为**：

- 用于初始化时的默认模型开放列表。
- 前端可通过 `getDefaultExposedModels(channel)` 读取。
- 千问 Token Plan 账号（`resource_mode = "token_plan"`）不使用此处的渠道级默认列表，
  而是由代码级常量 `QWEN_TOKEN_PLAN_DEFAULT_MODELS`
  （`src/domains/channel/types.ts` 与 `src-tauri/src/core/channels_config.rs` 各一份，
  必须手动保持一致）提供套餐专属默认模型 `["qwen3.8-max-preview", "qwen3.6-flash"]`，
  因为 `qwen3.8-max-preview` 仅 Token Plan 可用。

### 6.4 `flowlet_tiers` — Flowlet 档位映射

```jsonc
"flowlet_tiers": {
  "longcat": {
    "longcat-2.0": ["pro", "flash"]
  },
  "deepseek": {
    "deepseek-v4-pro": ["pro"],
    "deepseek-v4-flash": ["flash"]
  },
  "kimi": {
    "kimi-k3": ["pro"],
    "kimi-k2.7-code": ["pro"]
  },
  "qwen": {
    "qwen3.7-max": ["pro"],
    "qwen3.7-plus": ["pro"],
    "qwen3.6-plus": ["pro"],
    "qwen3.6-flash": ["flash"],
    "qwen3.8-max-preview": ["pro"]
  }
}
```

**结构**：`Record<channel_id, Record<model_name_lower, tier[]>>`。旧配置中的单个
`"pro"` / `"flash"` 字符串仍可兼容读取。

**行为**：账号保存后的默认路由合并会根据该映射，将上游模型同时加入
一个或多个聚合模型；已有路由的启用状态和优先级保持不变，
只补充缺失的账号、协议和聚合路由。

**tier 取值**：`"pro"` | `"flash"`。

**行为**：

- 用于 Flowlet 对外模型分层（Flowlet Pro / Flowlet Flash）。
- 查询时模型名会先 `trim().to_lowercase()` 再匹配。
- 未匹配到的模型返回 `"none"`。

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

4. **在 `flowlet_tiers` 中声明档位映射**（可选）。

5. **按 `docs/channel-integration.md` 完成 Rust 适配、SQLite 迁移、前端、图标与测试**。

6. **同步更新本文档**（第 6.1 节及示例）。

7. **运行检查**：
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
