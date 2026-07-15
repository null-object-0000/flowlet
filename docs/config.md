# config.md — config.json 完整字段说明

`config.json` 是 Flowlet 的**渠道与运行时配置文件**，位于项目根目录（与 `package.json` 同级）。

Rust 后端在启动时读取它，前端通过 Tauri command `read_config` / `write_config` 间接读写它。

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

### 三处同步（重要）

`channels_config` 的默认值在代码库中**重复出现三次**，目前没有共享 schema 生成器，必须手动保持一致：

| 位置 | 作用 |
|------|------|
| `config.json`（仓库根目录） | 运行时外部文件 + 编译时 `include_str!` 默认值 |
| `src/domain.ts` 中的 `defaultExposedModelsByChannel`、`defaultFlowletTierByChannel`、`flowletPublicModels` | 前端启动时的兜底常量 |
| `src-tauri/src/core/config.rs` 中的 `ChannelPreset::longcat()` / `ChannelPreset::deepseek()` | Rust 侧的工厂默认值 |

新增或修改渠道时，务必同步更新这三处，否则可能出现「外部配置 → SQLite → 前端展示」链条不一致的问题。

---

## 2. 顶层结构

```jsonc
{
  "ui": { "version": "next" },   // 前端版本
  "ua_rules": [ ... ],          // UA 客户端识别规则
  "log_capture": { ... },       // 请求日志捕获配置
  "bind": { ... },              // 代理监听地址
  "channels_config": { ... }    // 渠道、价格、模型配置
}
```

| 字段 | 类型 | 必须 | 说明 |
|------|------|------|------|
| `ui` | `object` | 否 | 前端版本选择；缺失或非法时使用 `legacy` |
| `ua_rules` | `UaClientRule[]` | 是 | 基于 User-Agent 子串的客户端身份识别规则 |
| `log_capture` | `object` | 是 | 请求/响应日志的捕获与脱敏配置 |
| `bind` | `object` | 是 | 本地代理监听的 host/port |
| `channels_config` | `object` | 是 | 渠道模板、价格、默认开放模型、档位 |

### 2.1 `ui` — 前端版本

~~~jsonc
"ui": {
  "version": "next"
}
~~~

| 字段 | 类型 | 必须 | 默认值 | 可选值 | 说明 |
|------|------|------|--------|--------|------|
| `version` | `string` | 否 | `next` | `legacy`、`next` | 应用启动时选择 Mantine 旧版或 Semi 新版前端；当前重构分支默认新版 |

**行为**：

- 前端 bootstrap 通过 Tauri command `read_config` 读取原始 JSON，并且只在应用启动时解析一次；
- `legacy` 加载现有 Mantine 前端，`next` 加载 `src-new` 中的 Semi 前端；
- 字段缺失、类型错误、值非法、JSON 解析失败或 command 调用失败时，安全回退到 `legacy`；
- 修改后必须重启整个 Flowlet 应用，不支持运行时热切换；
- Rust 不负责 UI 产品判断，也不为该字段维护独立运行时结构；Rust 只提供原始配置读取能力。
---

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
  "redact_sensitive_headers": false  // 是否脱敏敏感 Header
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
| `redact_sensitive_headers` | `bool` | `false` | 开启后，`authorization` / `x-api-key` / `cookie` / `set-cookie` / `x-auth-token` 会被替换为 `[redacted]` |

**行为**：

- 缺失任何字段时使用上述默认值。
- 修改后立即生效（热读），无需重启代理。
- Body 以 base64 形式存入 SQLite。

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

每个元素定义一个上游渠道（如 LongCat、DeepSeek）。

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
  "endpoints": {                           // 端点 URL 覆盖（可选）
    "models": "https://api.longcat.chat/openai/v1/models",
    "model_detail": "https://api.longcat.chat/openai/v1/models/{id}"
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
| `endpoints` | `object` | 否 | `{}` | 端点 URL 覆盖，key 如 `"models"` / `"model_detail"` / `"balance"` |

**端点解析优先级**：

1. `endpoints[key]` 显式覆盖（优先）
2. 基于 `openai_base_url` 拼接（如 `{base}/v1/models`）
3. 返回空字符串

**行为**：

- 启动时从 `config.json` 解析后写入 SQLite `channel_presets` 表（仅当表为空时写入）。
- 后续通过 `list_channel_presets` command 供前端使用。
- 修改渠道模板**不会**影响已创建的账号和路由，但会影响新增账号的默认值和模型同步。

### 6.2 `model_prices` — 模型价格预设

```jsonc
{
  "channel_id": "longcat",          // 关联渠道 id
  "upstream_model": "LongCat-2.0",  // 上游模型名
  "input_uncached_price": 2.0,      // 输入价格（未缓存，每 unit）
  "input_cached_price": 0.04,       // 输入价格（已缓存，每 unit）
  "output_price": 8.0,              // 输出价格（每 unit）
  "currency": "CNY",                // 货币单位
  "unit": "1M tokens"               // 计价单位
}
```

**字段说明**：

| 字段 | 类型 | 必须 | 默认值 | 说明 |
|------|------|------|--------|------|
| `channel_id` | `string` | 是 | — | 关联的渠道 id |
| `upstream_model` | `string` | 是 | — | 上游模型名 |
| `input_uncached_price` | `number` | 否 | `0` | 未缓存输入 token 单价 |
| `input_cached_price` | `number` | 否 | `0` | 已缓存输入 token 单价 |
| `output_price` | `number` | 否 | `0` | 输出 token 单价 |
| `currency` | `string` | 否 | `"USD"` | 货币单位 |
| `unit` | `string` | 否 | `"1M tokens"` | 计价单位 |

**行为**：

- 启动时若 SQLite `model_prices` 表为空，从 `config.json` 写入。
- 用于离线成本估算（`estimated_cost`），不进入主请求链路。
- 价格来源标记为 `PriceSource::Preset`。

### 6.3 `default_exposed_models` — 默认开放模型

```jsonc
"default_exposed_models": {
  "longcat": ["LongCat-2.0"],
  "deepseek": ["deepseek-v4-flash", "deepseek-v4-pro"]
}
```

**结构**：`Record<channel_id, upstream_model[]>`。

**行为**：

- 用于初始化时的默认模型开放列表。
- 前端可通过 `getDefaultExposedModels(channel)` 读取。

### 6.4 `flowlet_tiers` — Flowlet 档位映射

```jsonc
"flowlet_tiers": {
  "longcat": {
    "longcat-2.0": "pro"
  },
  "deepseek": {
    "deepseek-v4-pro": "pro",
    "deepseek-v4-flash": "flash"
  }
}
```

**结构**：`Record<channel_id, Record<model_name_lower, tier>>`。

**tier 取值**：`"pro"` | `"flash"` | `"none"`。

**行为**：

- 用于 Flowlet 对外模型分层（Flowlet Pro / Flowlet Flash）。
- 查询时模型名会先 `trim().to_lowercase()` 再匹配。
- 未匹配到的模型返回 `"none"`。

---

## 7. 运行时行为

### 热更新 vs 需重启

| 配置 | 修改后行为 |
|------|-----------|
| `ui.version` | **需重启应用**：仅在前端 bootstrap 时读取一次 |
| `ua_rules` | **热更新**：下次请求立即生效 |
| `log_capture` | **热更新**：下次请求立即生效 |
| `bind` | **需重启代理**：监听地址在启动时绑定 |
| `channels_config` | **需重启应用**：仅在启动时解析一次，写入 SQLite |

### 前端读写

前端通过 Tauri command 间接操作：

- `read_config()` → 返回 `config.json` 原始字符串
- `write_config(content)` → 写入完整 JSON 字符串

**写入校验**：`write_config_raw` 仅校验顶层为 JSON 对象或数组，**不做字段级 schema 校验**。字段级语义校验由前端 `src/app/actions/configActions.ts` 中的 `validateConfigData` 负责（校验渠道/账号/路由/客户端的引用完整性、API Key 非空等），但该校验仅用于导入/导出配置包（`ConfigBundle`），不用于 `config.json` 的写入。

> 前端不直接访问文件系统。启动 bootstrap 会通过 `read_config` 读取原始 JSON，仅解析 `ui.version`；渠道、账号和模型数据仍通过各自的 Tauri command（如 `list_channel_presets`）从 SQLite 获取。

---

## 8. 新增渠道的完整步骤

要在 Flowlet 中添加一个新渠道（例如 `NewProvider`）：

1. **在 `config.json` 的 `channels_config.channels` 数组中新增一项**：
   - 设置 `id`、`name`、`vendor`
   - 配置 `supported_protocols`、`*base_url`、`*auth`
   - 声明 `supports_*` 能力开关
   - 如有非标准端点，在 `endpoints` 中覆盖

2. **在 `model_prices` 中为该渠道添加价格条目**（可选，用于成本估算）。

3. **在 `default_exposed_models` 中声明默认开放的模型列表**。

4. **在 `flowlet_tiers` 中声明档位映射**（可选）。

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
| 前端配置校验（导入/导出 ConfigBundle 用） | `src/app/actions/configActions.ts`（`validateConfigData`） |
| 便携版打包 | `scripts/build-portable.mjs` |
| 前端 UI 版本解析 | `src/bootstrap/uiVersion.ts` |
| 前端类型定义 | `src/domain.ts`（`ChannelPreset`、`ProxyBindConfig`、`LogCaptureConfig`、`FlowletTier`） |
| 前端启动兜底常量 | `src/domain.ts`（`defaultExposedModelsByChannel`、`defaultFlowletTierByChannel`、`flowletPublicModels`） |
