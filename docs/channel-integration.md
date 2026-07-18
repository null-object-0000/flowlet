# Flowlet 新增渠道接入指南

本文说明如何在 Flowlet 中接入一个新的上游模型渠道。实施前应先阅读：

- [`AGENTS.md`](../AGENTS.md)
- [`docs/config.md`](./config.md)
- [`docs/architecture.md`](./architecture.md)

接入目标不是“让渠道出现在下拉框里”，而是完整打通以下链路：

```text
官方协议与端点
  -> config.json 渠道模板
  -> SQLite 渠道预设迁移
  -> 账号创建、测试、保存
  -> 模型与余额同步
  -> 默认开放模型和 Flowlet 档位路由
  -> OpenAI / Anthropic 代理请求
  -> UI、图标、日志和回归测试
```

## 1. 先确认官方能力

必须以渠道官方文档为准，记录并核实：

- 渠道 ID、展示名称、vendor；
- API Key 控制台地址；
- 原生支持 OpenAI-compatible、Anthropic-compatible 中的哪些协议；
- 每种协议的 Base URL、请求路径和鉴权方式；
- 模型列表、模型详情、余额、配额、用量等端点；
- 默认模型、上下文窗口、最大输出和流式能力；
- 官方价格和计价单位；
- 特殊请求约束，例如 Thinking、工具调用或上下文限制。

不得因为某个客户端可以接入，就推断渠道一定支持对应协议；必须确认客户端实际使用的协议和官方 Base URL。Flowlet 不做跨协议转换，只能为上游原生兼容的协议建立路由。

## 2. 已接入渠道对照

| 能力 | LongCat | DeepSeek | Kimi |
|------|---------|----------|------|
| 渠道 ID | `longcat` | `deepseek` | `kimi` |
| OpenAI Base URL | `https://api.longcat.chat/openai` | `https://api.deepseek.com` | `https://api.moonshot.cn/v1` |
| Anthropic Base URL | `https://api.longcat.chat/anthropic` | `https://api.deepseek.com/anthropic` | `https://api.moonshot.cn/anthropic` |
| 鉴权 | Bearer | Bearer | Bearer |
| 模型同步 | 列表后逐模型查详情 | 标准模型列表 | 模型列表直接携带部分详情 |
| 自动余额 | 否 | 是 | 是 |
| Token 资源包 UI | 是 | 否 | 否 |
| 默认 Flowlet 档位 | `LongCat-2.0 → pro + flash` | `v4-pro → pro`、`v4-flash → flash` | `kimi-k3 → pro`、`kimi-k2.7-code → pro` |

这些差异应由能力字段和小型渠道适配函数表达，不要把 LongCat、DeepSeek 或 Kimi 的特殊响应结构扩散到通用代理代码。

## 3. 配置与默认值

### 3.1 修改 `config.json`

在 `channels_config.channels` 增加渠道模板：

```jsonc
{
  "id": "new-provider",
  "name": "New Provider",
  "vendor": "new-provider",
  "platform_url": "https://example.com/api-keys",
  "supported_protocols": ["openai"],
  "openai_base_url": "https://api.example.com/v1",
  "anthropic_base_url": "",
  "openai_auth": "bearer",
  "anthropic_auth": "bearer",
  "default_model": "example-model",
  "small_model": null,
  "supports_model_list": true,
  "supports_model_detail": false,
  "supports_price_sync": false,
  "supports_balance_query": false,
  "supports_quota_query": false,
  "supports_usage_query": false,
  "endpoints": {
    "models": "https://api.example.com/v1/models"
  }
}
```

同时按实际能力维护：

- `channels_config.model_prices`；
- `channels_config.default_exposed_models`；
- `channels_config.flowlet_tiers`。

`flowlet_tiers` 只声明明确进入 `flowlet-pro` 或 `flowlet-flash` 的模型，值为档位数组；同一个上游模型可以同时进入多个档位。不要根据模型名称猜档位，也不要把所有模型默认映射到同一档。

### 3.2 同步代码默认值

以下位置必须与 `config.json` 一致：

- `src/domains/channel/types.ts`
  - `DEFAULT_EXPOSED_MODELS_BY_CHANNEL`
  - `FLOWLET_TIERS_BY_CHANNEL_MODEL`
- `src-tauri/src/core/config.rs`
  - `ChannelPreset::<channel>()`
- `src-tauri/src/core/presets.rs`
  - `builtin_channel_presets()`

外部 `config.json` 可能来自旧版本。新增渠道时必须确认内置配置合并和 SQLite 迁移能够把新渠道带到已有安装，不能只验证全新数据库。

## 4. SQLite 与升级迁移

Flowlet 运行时的渠道预设会进入 SQLite。新增或修改渠道时至少验证：

1. SQLite 中没有该渠道时，启动后能够追加；
2. SQLite 已有旧渠道记录时，协议、Base URL、鉴权等运行时字段能够更新；
3. 账号、API Key、账号级 Base URL 覆盖不被修改；
4. 现有路由的优先级和 `enabled` 状态不被重置；
5. 迁移是幂等的，多次启动结果一致。

当前相关实现：

- `src-tauri/src/core/storage_config.rs`
  - `ensure_missing_presets`
  - `sync_preset_protocol_config`
  - 渠道能力字段的其他定向迁移
- `src-tauri/src/lib.rs`
  - `build_app_state`
  - `merge_builtin_config`
- `src-tauri/src/core/storage_tests.rs`
  - 新增渠道与旧预设升级测试

修改字段时不能只扩展 `ensure_missing_presets`：该函数遇到已存在的渠道会跳过，已有用户仍会保留旧值。

## 5. Rust 渠道能力适配

### 5.1 端点解析

在 `src-tauri/src/core/channels_config.rs` 中为非标准端点提供小型 helper。解析优先级保持：

1. `config.json` 的 `endpoints` 显式覆盖；
2. 基于渠道 Base URL 的兼容拼接；
3. 明确返回不可用，不猜测第三方地址。

通用的模型列表测试连接也要检查渠道是否使用 `/models` 还是 `/v1/models`。

### 5.2 模型同步

在 `src-tauri/src/core/sync.rs` 中按官方响应定义最小反序列化结构，并转换为统一 `ChannelModel`：

- `channel_id`、`model`、`display_name` 正确；
- `supported_protocols` 不超过渠道真实能力；
- 官方返回上下文和输出上限时原样使用；
- 官方未返回时使用 `None`，不要统一硬编码；
- 保留 `source`、`synced_at`、创建和更新时间；
- 空模型 ID 必须过滤；
- 网络、HTTP 状态和 JSON 解析错误必须真实返回。

LongCat 的模型详情请求是渠道特例；DeepSeek、Kimi 的列表结构也不同。新渠道应选择最接近的实现参考，不要机械复制。

### 5.3 余额和资源能力

只有官方提供稳定余额接口时才设置 `supports_balance_query=true`，并实现：

- 正确端点和鉴权；
- 超时；
- HTTP 错误；
- 业务错误码；
- 金额和币种解析；
- 不在错误或日志中泄露 API Key。

Token 资源包、配额、用量等能力同理。UI 应依赖渠道能力或明确的渠道特例，不应假定所有渠道都有资源包。

### 5.4 Tauri command 分发

当前 `src-tauri/src/commands.rs` 中的模型同步和余额查询仍按 `channel_id` 分发。新增实现后必须把渠道加入对应分支，并同步不支持渠道时的错误文案。

command 只执行细粒度底层操作。账号保存后的余额、模型、路由刷新仍由 React 编排。

## 6. 默认开放模型与路由

账号保存后的调用链是：

```text
AccountEditorDrawer
  -> useAccountActions.saveAll
  -> save_channel_accounts
  -> refreshSavedAccounts
     -> query_balance（能力允许时）
     -> sync_models（能力允许时）
     -> mergeDefaultRoutes
     -> save_route_candidates（仅新增缺失路由时）
```

检查以下行为：

- 每个可用账号都生成独立候选；
- 每个真实支持的协议都生成对应路由；
- 直接模型使用 `virtual_model_id == upstream_model`；
- 聚合模型根据 `flowlet_tiers` 映射到 `flowlet-pro` 或 `flowlet-flash`；
- 已存在路由不被重复创建；
- 用户关闭的路由不会因账号编辑或模型同步被重新开启；
- 保存单账号不应无条件重写全部路由；
- 自定义 Base URL 时，官方余额和模型同步是否应跳过必须明确。

若渠道需要进入 Flowlet 聚合模型，还必须验证 `proxy_routing.rs` 和 `proxy_http.rs` 中的协议、账号健康状态和 `/models` 过滤条件。

## 7. 前端接入

### 7.1 渠道选择与账号编辑

渠道列表优先从 `list_channel_presets` 动态渲染。新增渠道不应继续扩大“LongCat 或 DeepSeek”之类的硬编码文案。

需要检查：

- 新增账号时可选择渠道；
- 编辑账号时渠道归属不被意外改变；
- `platform_url` 能打开官方 API Key 页面；
- 能力字段正确控制余额、模型同步和资源区；
- loading、失败和部分成功提示完整；
- 保存过程不因串行刷新所有账号而变慢。

### 7.2 品牌图标

涉及 AI/LLM 品牌图标时，先按 `AGENTS.md` 读取 Lobe Icons 官方技能。

默认流程：

1. 优先从 `@lobehub/icons-static-svg` 获取官方静态 SVG；
2. 固化到 `public/icons/lobe/`；
3. 更新 `public/icons/lobe/README.md` 中的来源版本和文件清单；
4. 保留上游许可证；
5. 在 `ChannelBrandLogo` 等共享组件中接入；
6. 检查明暗背景、尺寸和下拉选项中的可读性。

不得为单个页面复制另一套品牌图标实现，也不得默认依赖运行时 CDN。

### 7.3 概览和文案

检查无账号引导、快捷添加入口、账号列表、开放模型和 Agent 接入说明。优先使用动态渠道数据；确需固定推荐渠道时，必须同步测试和 `AGENTS.md` 中的产品规则。

## 8. 测试要求

每个新渠道至少覆盖适用的测试：

### Rust

- `config.json` 能解析渠道、端点、价格、默认模型和档位；
- 全新 SQLite 能追加渠道；
- 已有 SQLite 能迁移新增协议或端点；
- 模型响应解析成功、空列表和错误响应；
- 余额响应成功、业务错误和 HTTP 错误；
- command 能分发到新渠道；
- OpenAI 与 Anthropic `/models` 只暴露真实可用模型；
- 直接模型和 Flowlet 聚合模型能够匹配健康账号；
- 不支持的协议不会建立或命中路由。

上游相关测试应使用本地 mock server，不能依赖真实 API Key 或产生费用。

### 前端

- 渠道出现在选择器中；
- 创建和编辑账号保留正确渠道；
- 能力字段控制正确的资源 UI；
- 默认直接路由和聚合路由生成正确；
- 重复合并保留用户的 `enabled` 和优先级；
- 品牌图标和概览入口正常。

## 9. 验证清单

完成后依次执行：

```text
bun run check
bun run test
bun run build
cargo fmt --check
cargo check
cargo test <相关测试名>
```

再使用不含生产密钥的本地数据验证：

1. 全新数据库启动；
2. 从旧版本数据库升级；
3. 新增账号并测试连接；
4. 保存后模型与余额同步；
5. `/v1/models`；
6. `/anthropic/v1/models`（渠道支持时）；
7. 直接模型请求；
8. `flowlet-pro` / `flowlet-flash` 请求；
9. 禁用账号、禁用路由和无效 Key；
10. 请求日志中的最终上游 URL、模型和鉴权改写。

不得在没有用户授权时调用可能产生费用的真实模型接口。模型列表、余额等只读接口也应避免在自动化测试中依赖公网。

## 10. 修改文件检查表

按渠道能力选择，不要求无关文件产生空改动：

- [ ] `config.json`
- [ ] `docs/config.md`
- [ ] `src/domains/channel/types.ts`
- [ ] `src-tauri/src/core/config.rs`
- [ ] `src-tauri/src/core/presets.rs`
- [ ] `src-tauri/src/core/channels_config.rs`
- [ ] `src-tauri/src/core/storage_config.rs`
- [ ] `src-tauri/src/lib.rs`
- [ ] `src-tauri/src/core/sync.rs`
- [ ] `src-tauri/src/commands.rs`
- [ ] `src/features/channel-accounts/`
- [ ] `src/pages/overview/`
- [ ] `public/icons/lobe/`
- [ ] Rust 存储、同步、路由测试
- [ ] 前端账号、默认路由和 UI 测试

交付说明必须包含：

- 新增了哪些协议和能力；
- 是否改变数据结构；
- 如何迁移已有 SQLite；
- 哪些字段热更新、哪些需要重启；
- 哪些检查实际通过；
- 哪些检查因环境或外部条件未完成。
