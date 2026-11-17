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
  -> 默认开放模型和直接模型路由
  -> OpenAI / Anthropic / Responses 代理请求
  -> UI、图标、日志和回归测试
```

## 1. 先确认官方能力

必须以渠道官方文档为准，记录并核实：

- 渠道 ID、展示名称、vendor；
- API Key 控制台地址；
- 原生支持 OpenAI-compatible、Anthropic-compatible、OpenAI Responses API 中的哪些协议；
- 每种协议的 Base URL、请求路径和鉴权方式（Responses 端点须单独确认，
  不能凭“OpenAI-compatible”推断；支持时确认有状态/无状态能力边界）；
- 模型列表、模型详情、余额、配额、用量等端点；
- 默认模型、上下文窗口、最大输出和流式能力；
- 官方价格和计价单位；
- 特殊请求约束，例如 Thinking、工具调用或上下文限制。

不得因为某个客户端可以接入，就推断渠道一定支持对应协议；必须确认客户端实际使用的协议和官方 Base URL。Flowlet 不做跨协议转换，只能为上游原生兼容的协议建立路由。

## 2. 已接入渠道对照

| 能力 | LongCat | DeepSeek | Kimi | Qwen | Z.AI | OpenRouter | 自定义渠道 |
|------|---------|----------|------|-----------|------------|------------|------------|
| 渠道 ID | `longcat` | `deepseek` | `kimi` | `qwen` | `zhipu` | `openrouter` | `custom` |
| OpenAI Base URL | `https://api.longcat.chat/openai` | `https://api.deepseek.com` | `https://api.moonshot.cn/v1` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `https://open.bigmodel.cn/api/paas/v4` | `https://openrouter.ai/api/v1` | 账号级填写 |
| Anthropic Base URL | `https://api.longcat.chat/anthropic` | `https://api.deepseek.com/anthropic` | `https://api.moonshot.cn/anthropic` | `https://dashscope.aliyuncs.com/apps/anthropic` | `https://open.bigmodel.cn/api/anthropic` | `https://openrouter.ai/api` | 账号级填写 |
| Responses | ✅ 从 OpenAI Base URL 派生（无状态） | ✅ 从 OpenAI Base URL 派生（无状态，暂仅 v4-flash） | — 不支持 | ✅ 从 OpenAI Base URL 派生（仅透传无状态子集） | — 上游未确认 | ✅ 从 OpenAI Base URL 派生（`/api/v1/responses`，仅无状态透传） | 填写 OpenAI Base URL 即启用 |
| 鉴权 | Bearer | Bearer | Bearer | Bearer | OpenAI Bearer / Anthropic x-api-key | Bearer | OpenAI Bearer / Anthropic x-api-key |
| 模型同步 | 列表后逐模型查详情 | 标准模型列表 | 模型列表直接携带部分详情 | 标准模型列表（无上下文详情） | 标准 OpenAI `/models`（端点不以 `/v1` 结尾，必须 `endpoints.models` 覆盖） | 标准 OpenAI `/models`（模型 ID 带 `vendor/` 前缀，按规范模型剥前缀映射白名单） | 标准 OpenAI `/models` |
| 余额端点 | — | `GET /user/balance` | `GET /v1/users/me/balance` | — | — | 普通 Key：`GET /api/v1/key`；Management Key：`GET /api/v1/credits` | — |
| 自动余额 | 否 | 是 | 是 | 否 | 否 | 是 | 否 |
| 资源模式 | Token 资源包 UI | 否 | 否 | API 按量付费 + Token Plan 订阅双模式（两种模式均由官方控制台自动同步：按量付费抓福利页余额与免费额度，Token Plan 抓订阅套餐端点） | API 按量付费（官方控制台自动同步余额与额度包） | 手动维护（按量付费） | 手动维护 |

聚合模型 `flowlet-pro` / `flowlet-flash` 与对应档位映射已移除：新渠道不需要把渠道模型登记到任何
聚合档位，只需按 `default_exposed_models` 登记默认开放模型；路由按规范模型身份生成，同一规范
模型的多个上游变体自然形成候选池。

这些差异应由能力字段和小型渠道适配函数表达，不要把 LongCat、DeepSeek 或 Kimi 的特殊响应结构扩散到通用代理代码。

Z.AI（`zhipu`）是首个「OpenAI 兼容但路径不带 `/v1`」的官方渠道：官方端点为
`https://open.bigmodel.cn/api/paas/v4/chat/completions` 与
`/api/paas/v4/models`，均无 `/v1` 前缀。代理转发时必须走小型渠道适配函数
`openai_path_strips_v1` + `build_upstream_url_without_openai_v1`，去掉入站
`/v1/chat/completions` 中的 `/v1`；Anthropic 协议（`/api/anthropic/v1/messages`）
保持标准拼接。`config.json` 模板还必须显式覆盖 `endpoints.models`
（`/api/paas/v4/models`），否则 `openai_models_url` 会拼出 `/v1/models` 变体。

`custom` 是面向中转站的通用模板，不代表单一厂商。每个账号独立保存 API Key 和
两种协议的 Base URL；未填写地址的协议不生成候选路由。模型必须来自该账号标准
OpenAI-compatible `/models` 的实际返回结果，并统一受 Flowlet 全局白名单约束：
白名单外模型照常展示，但标记为“不支持”且不可勾选。最终候选必须同时存在于
最近一次 `/models` 结果、用户勾选列表和全局白名单中。

OpenRouter（`openrouter`）是聚合渠道：OpenAI-compatible 端点为
`https://openrouter.ai/api/v1`，Anthropic 兼容端点（Anthropic Skin）为
`https://openrouter.ai/api`，均使用 Bearer 鉴权；Responses 端点从 OpenAI Base
URL 派生为 `https://openrouter.ai/api/v1/responses`，官方仅支持**无状态**透传
（`store: true` 或 `previous_response_id` 非空会返回 400），与 Flowlet 的
responses 语义一致。模型列表走标准 OpenAI `/models`（`/api/v1/models`），返回
的模型 ID 带 `vendor/` 命名空间前缀（如 `deepseek/deepseek-v4-flash`）；白名单
判断和规范模型映射会先剥离该前缀（`canonical_model_key` / `canonicalModelKey`），
路由 `upstream_model` 仍保留上游原始 ID 用于转发。由于 OpenRouter `/models`
返回全部主流模型，其账号天然**可以**勾选开放任意 Flowlet 白名单模型——未来白
名单新增模型时，只要 `/models` 返回即可由用户勾选开放；开放哪些模型由用户在
账号编辑器中显式勾选，不默认全勾选（`config.json` 不为 `openrouter` 声明
`default_exposed_models`）。

OpenRouter 支持两级资源查询（`supports_balance_query=true`）：普通模型调用 API Key
走 `GET /api/v1/key`，展示该 Key 的 `limit_remaining`；没有配置 Key 消费上限时该字段
为 null，同步仍成功，UI 展示“未设置 Key 限额”。用户可在账号编辑器额外维护可选的
Management Key；配置后改走 `GET /api/v1/credits`，以 `total_credits - total_usage`
展示真实账户 Credits 余额。Management Key 不参与模型请求、连接测试和路由，认证失败
也不得把普通 API Key 标记为 `invalid_key`。实现仍由
`packages/flowlet-core/src/web/balance.ts` 与 `web/commands.ts` 的 `query_balance` 分发，保存后
前端 `refreshSavedAccounts` 自动触发同步，快照落库并在概览页展示。

Qwen 是双资源模式渠道：默认 **API 按量付费**（通用 `sk-` 前缀 Key + 渠道级
dashscope 端点，`resource_mode = "pay_as_you_go"`），并支持 **Token Plan** 订阅
（`sk-sp-` 前缀 Key，`resource_mode = "token_plan"`）：Token Plan 账号通过账号级
Base URL 覆盖指向 `https://token-plan.cn-beijing.maas.aliyuncs.com` 下的专属端点
（OpenAI `/compatible-mode/v1`，Anthropic `/apps/anthropic`），账号编辑器在选择
Token Plan 模式时自动写入覆盖。两种资源模式均由官方控制台隐藏 WebView 自动同步：

- **Token Plan**（scrape mode `token_plan`，控制台
  `/home/billing/subscription/token-plan-individual`）抓订阅额度
  （`subscription` / `quota-config` / `usage` / `reset-card/list`）。2026-10 控制台
  改版后主额度窗口由周额度（`weekly` + `per1WeekPercentage`）改为月额度
  （`monthly` + `per1MonthPercentage`）：槽位校验只要求业务信封存在且含任一数值型
  额度窗口 / 任一 `per*Percentage`，账号资源同步按 5 小时 → 7 天 → 每月 输出全部窗口
  （月额度排最后），`extractor_js` 按 月 → 周 → 5 小时
  回退。历史快照仍是周口径，向后兼容不得移除；详见 `docs/config.md` 的 `scrape` 字段；
- **API 按量付费**（scrape mode `freetier`，控制台 `/home/benefits` 福利页）抓
  免费额度与账单：`ListBailianFreetier`（freetier 模板清单）、
  `DescribeFqInstance`（免费额度实例，页面按 40 个模板一批连发多批，Node 侧按
  `Template.Code` 跨批合并并裁剪字段）、`GetBillingAccountAvailableAmount`
  （账户可用余额 → 快照 `balance`）、`ListSettleBillTotalSummary`（本月结算账单）
  与可选的 `queryCurrentCertInfo`（实名认证）、`tool/user/info.json`（会话信息）。
  `sec_token` 由页面自带（`tool/user/info.json` 下发），Flowlet 不伪造请求。

免费额度模型（`Template.Name` 即上游模型 ID）只在账号编辑器内展示与排序：
模型勾选列表中「valid 且有剩余」的免费模型优先展示并标注剩余额度与周期，
不开放为可路由模型（白名单约束不变）。存量 Qwen 按量付费账号启动时统一迁移为
`resource_sync_mode = "auto"`（此前仅有手动维护，无自动数据可丢）。

Qwen API 按量付费的余额与免费额度还有一条**不依赖 WebView** 的官方 HTTP 通道
（`packages/flowlet-core/src/web/qwen-platform.ts`）：账号在编辑器里点「登录千问平台」后，
Flowlet 走千问官方 CLI（`@qianwenai/qianwen-cli`）使用的 device flow（PKCE S256）
取得访问令牌，再以 `POST https://cli.qianwenai.com/data/v2/api.json` 调用
`BssOpenAPI-V3` 的 `DescribeFqInstance`（免费额度实例，`Template.Name` 由网关直接
给出，缺失时才用公开的 `https://alioth.alicdn.com/model-mapping` 反查回填）、
`GetBillingAccountAvailableAmount`（账户可用余额/未结清，与控制台同口径；该动作
不可用时回退 `GetFundAccountAvailableAmount`）与 `ListSettleBillTotalSummary`
（当月结算账单，可选），最后写成与控制台抓取**同构的 slot bundle**
（`billing_amount` / `fq_instance` / `settle_bill`），因此前端解析器
（`src/features/channel-accounts/qwenFreetierDetails.ts`）、余额快照表与展示逻辑
完全复用，快照 `source = "qwen_platform"`、`remark = "千问平台 API"`。

- 触发顺序：`scrape_balance` 与周期同步（`sync_scrape_balances`）先尝试 HTTP；
  未登录、令牌过期或请求失败时**静默回退**控制台抓取，桌面端既有行为不变；
- Web Host / Docker 没有 WebView，这条 HTTP 路径是它们获取余额与免费额度、订阅额度的
  唯一途径；Node Host 的周期余额同步（启动 30 秒后首轮、之后每 5 分钟）会把
  **已登录的 Qwen 账号**纳入同一轮任务，未登录账号直接跳过；`qwen_platform_status|login_start|login_poll|logout|sync` 已加入
  `packages/flowlet-core/src/web/commands.ts` 的显式命令白名单，授权页由客户端浏览器打开；
- 凭据按**千问平台账号**共享，存放在数据目录 `qwen-platform/credentials.json`
  （权限 0600，`platforms` 存令牌、`accounts` 存 Flowlet 账号 → 平台账号绑定）：
  同一个平台账号登录一次即可被同渠道的多个 Flowlet 账号复用（未绑定的账号会回退到
  最近更新的有效令牌并自动补绑定）；`logout` 只解绑当前账号，最后一个引用者登出才
  删除平台令牌。旧版本按 `<account_id>.json` 存的凭据会在首次读取时自动迁移。
  `client-id` 文件用于 device flow 的 `client_id`。令牌没有 refresh token：过期后
  必须重新走一次 device flow（实测服务端下发的有效期约 2 天），账号编辑器展示
  「登录有效至 …」。device flow 只返回数字 `User.Id`，展示身份由
  `/api/account/info.json` 补全（掩码邮箱，如 `nich*****@outlook.com`）；
- 一次同步会**同时拉取两套数据**（不再按 `resource_mode` 二选一）：按量付费的
  `billing_amount` / `fq_instance` / `settle_bill` 与 Token Plan 的
  `subscription` / `quota_config` / `usage` / `reset_card_list?` 合并进同一个
  `raw_scraped_json`，因此账号编辑器只需一个面板同时展示「余额 + 免费额度」和
  「订阅额度」（有订阅才渲染）。某个平台账号没有 Token Plan 时，订阅相关槽位直接
  跳过，不会把「未订阅」误报为同步失败；两套都取不到才报错；
- 网关返回的免费额度实例带英文展示单位（`Thousand Tokens` / `TenThousand Word` /
  `Second` / `Piece`），且带 `InstanceName` / `Uid` / `StartTime`。写入 bundle 前
  Node 侧归一到基础单位（`tokens` / `字` / `秒` / `张`，`BaseValue` 语义不变），
  并丢弃账号身份字段，避免前端把 1000 千tokens 显示成 1,000 Tokens、也避免把
  账号 Uid 写进余额快照；`Template.Name` 由网关直接给出，缺失时才用
  model-mapping 反查；
- 平台登录令牌**只用于余额/免费额度查询**，不参与模型调用、连接测试与路由；
  渠道 API Key 仍是唯一的模型调用凭据，也不写入 SQLite；
- 这些网关接口来自千问官方 CLI 的公开行为（不是模型 API 的一部分），接口变化时
  需对照 CLI 新版本更新 `packages/flowlet-core/src/web/qwen-platform.ts`；控制台抓取配置保留为兜底，
  `freetier` scrape mode 的槽位定义同时是前端解析口径的事实来源。

**Token Plan 订阅**共用同一次「登录千问平台」，但接口不同（`sync_account` 按
`resource_mode` 分派）：

- 先用 device-flow 访问令牌换 cs-data 专用派生令牌：
  `POST cli.qianwenai.com/data/v2/api.json`
  `{product:"ModelStudioRegional", action:"GenerateCLIAccessToken", version:"2026-02-10"}`；
- 再用派生令牌调
  `POST https://cs-data.qianwenai.com/cli/api.json?action=BroadScopeAspnGateway&product=sfm_bailian&api=<api>`
  （form-urlencoded：`params=<JSON {Api,V,Data:{...,cornerstoneParam}}>&region=cn-beijing`），
  `api` 与控制台抓取同名：`zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/`
  `subscription` / `quota-config` / `usage` / `reset-card/list`；
- 四个响应**原样**写入 `subscription` / `quota_config` / `usage` / `reset_card_list`
  槽位（前端解析器沿 `data.DataV2.data.data` 取业务数据），因此
  `qwenTokenPlanDetails` 的订阅额度窗口（5 小时 / 月）、重置券、过期/未订阅判定
  全部复用；`reset-card/list` 是可选槽位，接口失败只跳过它；
- `subscription` 需要 `commodityCode = sfm_tokenplansolo_public_cn`（个人版）；
  接口拒绝该参数时回退无参调用；订阅为业务错误（未订阅）时整体同步继续，只跳过
  Token Plan 槽位；
- 实测（2026-11）：`subscription` 返回
  `{specCode, status, remainingDays, startTime, endTime, autoRenewFlag}`、
  `quota_config` 返回 `{standard:{five_hour, monthly}, ...}`、
  `usage` 返回 `{per1MonthPercentage, per1MonthResetTime}`（0~1 或百分数都兼容）、
  重置券为数组（无券时为空数组）。


### ChatGPT API（OpenAI）

渠道 ID `openai-api`，展示名 ChatGPT API，使用官方项目 API Key。支持
`https://api.openai.com/v1/chat/completions` 和 `/v1/responses`，模型列表为
`GET /v1/models`，均使用 Bearer 鉴权；不声明 Anthropic 或 API Key 余额/配额查询能力。
与 `chatgpt` 订阅观测伪账号分离，复用已固化且保留许可证的 OpenAI SVG。
账号高级设置可选择直连或使用全局代理地址。新账号默认直连。升级时，已通过全局代理转发模型的账号迁移为使用代理，其他账号迁移为直连。显式选择代理时，模型转发、模型拉取、
连接测试和 API 余额查询共用此设置，不受旧账号的全局开关影响。

实际选中显式代理的模型请求仅能在确认尚未发送业务请求的建连失败阶段重连；具体判定与预算以
`packages/flowlet-core/src/proxy/upstream.ts` 及 mock 测试为准，不照搬旧客户端错误类型。
上游 HTTP 状态、发送请求后的断连、响应读取失败及 SSE 中断均不触发重连。
ChatGPT API 的最终网络错误日志及重连告警记录底层原因链，用于区分连接、隧道与 TLS
故障；旧日志只有通用错误文本，不能据此倒推出某次故障的具体网络根因。


余额仅支持手动维护，账号编辑页提供官方账单页链接。该渠道不创建浏览器采集窗口，
不保存或使用控制台登录状态，不自动同步余额、赠送额度或到期时间。

2026-10-30 核实的官方来源：
- [订阅 API 额度与领取条件](https://developers.openai.com/api/docs/guides/chatgpt-api-credits)
- [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol)
- [GPT-6.1 Terra](https://developers.openai.com/api/docs/models/gpt-6.1-terra)
- [GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra)
- [GPT-6 Sol](https://developers.openai.com/api/docs/models/gpt-6-sol)
- [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)

这五个模型登记在全局目录，规格和价格取本地 models.dev 的 OpenAI 目录。
实际可用性仍取决于用户项目 `/models` 的返回及显式选择。Responses 仅沿用 Flowlet
的无状态边界；工具调用的协议约束、额度领取与升级行为见 `docs/config.md`。
测试仅使用本地 mock，不调用付费推理。

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

- `channels_config.default_exposed_models`；
- `channels_config.model_prices`：仅当渠道厂商**未被** `models-cn.json` / `models-dev.json` 目录覆盖时才需要手工维护（例如自定义中转站）。国内厂商与 OpenAI 官方价格已由两份本地目录提供，请勿重复填写。

### 3.2 同步代码默认值

必须核对 `src/domains/channel/types.ts`、根 `model-catalog.json` / `plugin-registry.json`，
以及 `packages/flowlet-core/src/config/index.ts` 的解析、内置合并与默认路由。
Node 没有旧宿主的预设工厂目录，不要按旧类型名复制空实现。

外部配置可能来自旧版本，必须验证内置合并和 SQLite 升级能把新渠道带到已有安装。

## 4. SQLite 与升级迁移

Flowlet 运行时的渠道预设会进入 SQLite。新增或修改渠道时至少验证：

1. SQLite 中没有该渠道时，启动后能够追加；
2. SQLite 已有旧渠道记录时，协议、Base URL、鉴权等运行时字段能够更新；
3. 账号、API Key、账号级 Base URL 覆盖不被修改；
4. 现有路由的优先级和 `enabled` 状态不被重置；
5. 迁移是幂等的，多次启动结果一致。

当前入口（均已按 Node 文件定位）：

- `packages/flowlet-core/src/config/index.ts`：`loadChannelsConfig`、`mergeBuiltinConfig`、`loadRuntimeSnapshot`；
- `packages/flowlet-core/src/storage/index.ts` 与 `storage/schema.ts`：预设写入、schema 与升级迁移；
- `packages/flowlet-core/src/index.ts`：启动装配；
- `packages/flowlet-core/src/storage/__tests__/storage.test.ts`：存储与旧数据回归。

不能只测试缺失渠道追加：已有旧预设的协议、地址和鉴权也必须能定向更新，而账号与路由状态不重置。

## 5. Node 渠道能力接入

### 5.1 端点解析

核对 `packages/flowlet-core/src/web/config-state.ts`、`web/model-sync.ts` 与 `proxy/http.ts`：
账号级覆盖优先，其次配置中的端点覆盖，再按渠道 Base URL 做明确的兼容拼接；不猜第三方地址。
模型同步和测试连接要同时验证 `/models`、`/v1/models` 以及非标准路径。

### 5.2 模型与余额

当前实际入口是 `web/model-sync.ts`、`web/balance.ts`，不是旧宿主的 Adapter 文件目录。
新增渠道仍应隔离专属 DTO / 解析和错误，不把渠道分支散落到转发主流程。

模型结果必须保留渠道、上游原始 ID、真实协议、规格、source 与时间；空 ID 过滤，未知规格不硬编码。
余额只在官方接口真实可用时声明能力，覆盖超时、HTTP/业务错误、金额和币种，不泄漏 Key。
控制台抓取为桌面独有能力，入口为 `desktop/scrape.ts` 与 `scrape/`，平台执行在
`packages/flowlet-desktop/src/scrape.ts` 的隔离 BrowserWindow/CDP。

### 5.3 声明与分发

渠道在根 `plugin-registry.json` 声明 `channelId` / `adapterId`，在 `config.json` 声明真实
`supports_*`、协议、地址和鉴权。必须同时修改相应 Node 实现和测试，不得只登记能力或默默回退。
当前 Node 各能力入口并非一个统一的 Capability Adapter 类，接入时须查真实调用链。
HTTP 命令在 `web/commands.ts` / `web/permissions.ts` 显式登记，桌面专属注册在
`desktop/commands.ts`；不能为了复用 UI 把桌面抓取开放给 Web/Docker。

配置内的页面脚本只允许受控抓取回调 `window.__FLOWLET_SCRAPE__?.invoke?.(...)`（若提供），
不得依赖任意 IPC；CDP + 有界 stash 才是真实捕获来源。账号保存后的刷新继续由 React 编排。

## 6. 默认开放模型与路由

账号保存后的调用链是：

```text
AccountEditorDrawer
  -> useAccountActions.saveAll
  -> save_channel_accounts
  -> refreshSavedAccounts
     -> query_balance（能力允许时）
     -> sync_models（能力允许时）
     -> reconcileAccountRoutes
     -> save_route_candidates（仅新增缺失路由时）
```

检查以下行为：

- 每个可用账号都生成独立候选；
- 每个真实支持的协议都生成对应路由；
- 全局第一个渠道账号生成的新路由默认开启；此后新增的任何官方或自定义渠道账号，
  路由仍自动创建但默认关闭，必须由用户手动开启；
- 路由 `virtual_model_id` 写入规范模型 ID，`upstream_model` 保留上游原始 ID（入站模型名先按
  `model-catalog.json` 归一到规范 ID 再匹配）；
- 账号保存只补齐直连路由；持久化路由行只接受规范模型身份，`virtual_model_id` 与
  `upstream_model` 归一后必须属于同一规范模型（高级规则的显式映射例外）；
- 旧版本 `flowlet-pro` / `flowlet-flash` 路由会在升级迁移时改写为对应直接模型路由
  （去重、保留相对顺序），不需要手工重建；
- 已存在路由不被重复创建；
- 用户关闭的路由不会因账号编辑或模型同步被重新开启；
- 保存单账号不应无条件重写全部路由；
- 自定义 Base URL 时，官方余额和模型同步是否应跳过必须明确。

渠道模型生成直接路由后，还必须验证 `packages/flowlet-core/src/proxy/routing.ts` 和 `proxy/http.ts` 中的规范模型身份校验、协议、账号健康状态和 `/models` 过滤条件。

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

### Node/TS

- 渠道/目录/配置与 Node 入口的相关契约测试通过，确认注册表、预设、Capability Adapter、能力声明、
  scrape mode、默认模型与模型目录互相一致；
- `config.json` 能解析渠道、端点、价格、默认模型与模型目录；
- 全新 SQLite 能追加渠道；
- 已有 SQLite 能迁移新增协议或端点；
- 模型响应解析成功、空列表和错误响应；
- 余额响应成功、业务错误和 HTTP 错误；
- command 能分发到新渠道；
- OpenAI 与 Anthropic `/models` 只暴露真实可用模型；
- 直接模型能按规范模型身份匹配健康账号；
- 不支持的协议不会建立或命中路由。

上游相关测试应使用本地 mock server，不能依赖真实 API Key 或产生费用。

### 前端

- 渠道出现在选择器中；
- 创建和编辑账号保留正确渠道；
- 能力字段控制正确的资源 UI；
- 默认直接路由生成正确，且只有全局第一个账号的新路由默认开启；
- 重复合并保留用户的 `enabled` 和优先级；
- 品牌图标和概览入口正常。

## 9. 验证清单

完成后依次执行：

```text
npm run check
npm test
npm run build:desktop
npm run build:web
npm run node:typecheck
npm run node:commands
node --test packages/flowlet-core/src
```

再使用不含生产密钥的本地数据验证：

1. 全新数据库启动；
2. 从旧版本数据库升级（验证旧 `flowlet-pro` / `flowlet-flash` 路由改写为直接模型路由、去重与顺序）；
3. 新增账号并测试连接；
4. 保存后模型与余额同步；
5. `/v1/models`；
6. `/anthropic/v1/models`（渠道支持时）；
7. 规范模型 ID 请求与已登记别名请求；
8. 禁用账号、禁用路由和无效 Key；
9. 请求日志中的最终上游 URL、模型和鉴权改写。

不得在没有用户授权时调用可能产生费用的真实模型接口。模型列表、余额等只读接口也应避免在自动化测试中依赖公网。

## 10. 修改文件检查表

按渠道能力选择，不要求无关文件产生空改动：

- [ ] `config.json`
- [ ] `docs/config.md`
- [ ] `src/domains/channel/types.ts`
- [ ] 根 `model-catalog.json` / `plugin-registry.json`
- [ ] `packages/flowlet-core/src/config/index.ts`
- [ ] `packages/flowlet-core/src/storage/index.ts` / `storage/schema.ts`
- [ ] `packages/flowlet-core/src/web/model-sync.ts` / `web/balance.ts`
- [ ] `packages/flowlet-core/src/web/commands.ts` / `web/permissions.ts`
- [ ] 适用的 `packages/flowlet-core/src/proxy/` / `scrape/` / `desktop/`
- [ ] `src/features/channel-accounts/`
- [ ] `src/pages/overview/`
- [ ] `public/icons/lobe/`
- [ ] Node 存储、同步、路由测试
- [ ] 前端账号、默认路由和 UI 测试

交付说明必须包含：

- 新增了哪些协议和能力；
- 是否改变数据结构；
- 如何迁移已有 SQLite；
- 哪些字段热更新、哪些需要重启；
- 哪些检查实际通过；
- 哪些检查因环境或外部条件未完成。


## VibeToken 聚合渠道（2026-11-05）

渠道 `vibetoken` 不作为模型官方归属。OpenAI Base URL 为 `https://vibetoken.cn/v1`，
支持 Chat Completions 与无状态 Responses，均为 Bearer 鉴权；未声明 Anthropic。
`GET /v1/models` 返回全量目录与 `vendor/<官方名>` 原始 ID，复用目录归一、全局白名单、
用户显式选择及 synced_models 校验，不配置默认开放模型。快照资源保留独立上游 ID。
模型同步读取 context_length、顶层 max_output_tokens / max_completion_tokens，不硬编码规格。
`pricing` 保留原始数据（单位为每百万 Token），不套用 OpenRouter 的每 Token 价格算法。

余额通过 `GET /api/v1/billing/balance` 自动同步，使用 `available`（已扣除 held），币种 CNY；
数值为零仍视为成功同步，缺少 available 或错误响应不得伪造零余额。账号级 Base URL 覆盖时，
沿用现有规则禁用官方余额查询。控制台为 `https://vibetoken.cn/api-key`。
编译期 Capability Adapter 与插件注册表同步登记，旧外部配置与 SQLite 启动时幂等补齐预设，
保留账号、Key、地址覆盖及路由启停/优先级。无数据库结构变更，更新应用并重启后可用。

官方静态图标包 `@lobehub/icons-static-svg@1.102.0` 未包含 VibeToken，使用官网
`https://vibetoken.cn/favicon.svg` 的原始像素 T 标志，固化为
`public/icons/providers/vibetoken.svg`（官网镜像资源同步）；以 CSS mask 跟随 Flowlet 主题，
不依赖运行时 CDN。来源日期、快照 SHA-256 与上游权利说明见同目录 README.md。

来源：[快速开始](https://docs.vibetoken.cn/zh)、[模型 API](https://docs.vibetoken.cn/zh/api-reference/models)、
[Responses](https://docs.vibetoken.cn/zh/api-reference/responses)、[计费](https://docs.vibetoken.cn/zh/api-reference/billing)。
已用用户提供的 Key 只读验证模型与余额端点，未调用付费推理；Key 不进入仓库或 fixture。


## 腾讯混元（TokenHub）（2026-11-16）

渠道 `hunyuan`（展示名「腾讯混元」）经腾讯云**大模型服务平台 TokenHub** 接入。旧版
`api.hunyuan.cloud.tencent.com` 已停止新增模型，Hy4 系列只在 TokenHub 提供，因此渠道模板
直接指向 TokenHub，而不是旧混元端点。

- OpenAI Base URL：`https://tokenhub.tencentmaas.com/v1`（`GET /v1/models`、Bearer 鉴权）；
- Anthropic Base URL：`https://tokenhub.tencentmaas.com`（请求路径 `/v1/messages`，
  使用 `x-api-key`，与 OpenAI / Responses 的 Bearer 鉴权区分）；
- Responses：从 OpenAI Base URL 派生 `/v1/responses`，无状态透传；
- 控制台：`https://console.cloud.tencent.com/tokenhub/apikey`；
- 地域：广州站 `tokenhub.tencentmaas.com`；新加坡站为 `tokenhub-intl.tencentmaas.com`，
  需在账号级 Base URL 覆盖中切换，不跨站调用。

协议结论以官方模型协议表为准：`hy4` 的 OpenAI Chat Completions、OpenAI Responses 与
Anthropic Messages 均为原生支持。调用前必须在控制台开通对应模型服务，未开通时上游返回
402（与模型是否支持该协议无关）。TokenHub 对部分模型只提供 Chat Completions，再由平台
转换 Responses；`hy4` 不属于这一档。

`hy4` 和 `hy4-flash` 为两个独立规范模型，均支持上述三协议，保持用户独立勾选和路由。

模型与价格：`hy4` 登记为规范模型 ID，官方归属 `hunyuan`，models-cn provider 为
`tencent-hunyuan`（上下文 1,048,576、最大输出 65,536，支持文本与图片输入、思考与工具调用；
基准价 6 元/百万输入（缓存命中 0.3）、18 元/百万输出）。别名 `tencent/hy4` 用于入站归一。
`hy4-preview` 是另一个上游资源，未登记白名单；需要时再单独评估。

Token Plan：`sk-tp` 前缀 Key 使用 `https://tokenhub.tencentmaas.com/plan/v3` 与
`https://tokenhub.tencentmaas.com/plan/anthropic`，与按量付费端点不同。渠道模板默认走按量付费，
Token Plan 账号通过账号级 Base URL 覆盖接入（与 Qwen Token Plan 的处理方式一致）。

余额：TokenHub 没有公开余额 API，`supports_balance_query = false`，不做控制台抓取；
账号余额/额度只支持手动维护。

图标：使用 `@lobehub/icons-static-svg@1.93.0` 的 `hunyuan-color.svg`，固化到
`public/icons/lobe/hunyuan-color.svg`，不依赖运行时 CDN。

官方来源：[API 使用说明](https://cloud.tencent.cn/document/product/1823/130078)、
[语言模型调用概览（模型协议表）](https://cloud.tencent.cn/document/product/1823/130079)、
[Responses API 兼容模式说明](https://cloud.tencent.cn/document/product/1823/133813)、
[模型列表](https://cloud.tencent.cn/document/product/1823/130051)。


## 阿里云百炼决策模型（TypeSafe System One）

`decision-model-preview` 是独立的结构化决策模型，模型目录登记 `kind: "decision"`。
它使用 `POST /v1/systemone`（上游百炼网关为 `/compatible-mode/v1/systemone`），
请求与响应原样透传，仅按候选替换 `model`；记录上游真实输入 Token，不虚构输出 Token。
协议隔离由目录、前端候选对账、Node 路由共同保证；它不进入对话模型池或 Agent 接入。

Qwen 需要账号级 Token Plan 或业务空间网关地址，缺失时禁用选择并不生成候选。
自定义网关使用其 OpenAI Base URL，模型只接受该账号实际 `/models` 返回结果。
账户显式勾选、取消勾选后的路由对账、地址覆盖与热更新均沿用既有账号流程。
旧外部配置与 SQLite 预设通过内置协议升级补齐，不重置已有账号和路由状态。
联合发布回归见 `src/pages/models/modelReleaseContract.test.ts`，同时验证 HY4、Flash、决策模型。

官方来源：[决策模型 API](https://help.aliyun.com/zh/model-studio/decision-model-api)。
