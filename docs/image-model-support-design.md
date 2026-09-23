# 生图（Image Generation）模型支持设计

> 状态：设计草案，未实现
> 结论先行：**当前 Flowlet 不支持生图类模型**。入站转发通道天然可用，但模型身份、路由匹配、计量三层均按 chat 语义实现，生图请求今天会拿到 404 `model_not_exposed`。
> 目标支持清单来自本机 `image-gen` 技能实测（Friday Gateway）。
> 本文描述 A 档（最小可用直通）方案；B 档（按张计量）与 C 档（Agent 侧声明）在文末给出边界。

---

## 1. 现状核查（基于当前代码，非推测）

### 1.1 已经天然具备的能力

| 能力 | 位置 | 说明 |
|---|---|---|
| 入站路径通配 | [proxy.rs:364](../src-tauri/src/core/proxy.rs#L364) | `/v1/{*path}`、`/openai/v1/{*path}` 为 catch-all，`/v1/images/generations` 不会 404，会进入 OpenAI 协议转发链路 |
| 上游 URL 透传拼接 | [proxy_http.rs:653](../src-tauri/src/core/proxy_http.rs#L653) | `build_upstream_url` 按路径拼接，可得到 `{openai_base_url}/v1/images/generations` |
| 鉴权与保留头处理 | [proxy_http.rs:711](../src-tauri/src/core/proxy_http.rs#L711) | `apply_request_headers` 与协议无关，可复用；已剥离 `Content-Length` 交给 reqwest 重算，对 multipart 同样正确 |
| body 内 `model` 改写 | [proxy_http.rs:1398](../src-tauri/src/core/proxy_http.rs#L1398) | JSON 字段级替换，生图请求体同样含 `model` |
| 响应原样透传 | `proxy.rs` 转发段 | 不强制 SSE 解析，`url` / `b64_json` 两种返回都能过 |

**结论：转发不是瓶颈，"被识别为一个可开放模型"才是。**

### 1.2 硬阻断清单

| # | 阻断点 | 位置 | 后果 |
|---|---|---|---|
| 1 | 全局白名单是硬门禁，23 个模型全为 chat LLM，前端与 Rust 同源 `model-catalog.json` | [identity.ts:28](../src/domains/modelCatalog/identity.ts#L28)、[channels_config.rs:387](../src-tauri/src/core/channels_config.rs#L387) | 账号编辑器对白名单外模型只展示、禁用勾选（[AccountEditorDrawer.tsx:270](../src/features/channel-accounts/AccountEditorDrawer.tsx#L270)、[:745](../src/features/channel-accounts/AccountEditorDrawer.tsx#L745)）→ `exposed_models` 不可能含生图模型 → 不生成路由 → 404 `model_not_exposed`（[proxy.rs:741](../src-tauri/src/core/proxy.rs#L741)） |
| 2 | 无「模型类型 / 端点族」维度，协议枚举仅 `openai / anthropic / responses` | [config.rs:189](../src-tauri/src/core/config.rs#L189) | 仅把生图模型塞进白名单，会以 `client_protocol = openai` 生成路由；`match_candidates` 只按 `virtual_model_id + protocol` 匹配（[proxy_routing.rs:71](../src-tauri/src/core/proxy_routing.rs#L71)）→ `/v1/chat/completions` 也会命中生图模型，且会出现在 `/v1/models` 被 Agent 选中 |
| 3 | 计量与成本全为 token 语义 | [usage.rs:244](../src-tauri/src/core/usage.rs#L244)、`models-cn.json` 价格单位 `1M_tokens` | 按张计费的模型无法计量（见 §2 实测：8 个模型里 5 个是按张计费） |
| 4 | 模型目录无生图规格 | `models-cn.json` 36 条 `outputModalities` 全为 `["text"]`；[model_input_capabilities.rs:13](../src-tauri/src/core/model_input_capabilities.rs#L13) 只认 text/image **输入**模态 | 模型服务页显示「暂无可用模型规格」。注：展示层的输出模态概念**已存在**（`ModelCapabilities.outputModalities` 与 `MODEL_MODALITY_LABELS.image = "图像"`，[ModelServicesPage.tsx:835](../src/pages/models/ModelServicesPage.tsx#L835)），缺的是**目录数据与路由/kind 门控** |
| 5 | 响应体捕获默认上限 1MB | `config.json` → `log_capture.max_body_bytes` | `b64_json` 会被截断；multipart 编辑请求的图片二进制会被 base64 放大落库 |
| 6 | 上游 `/models` 不带模态/形态元数据 | 见 §2.2 结论 1 | `kind` 与请求形态**无法从上游推断**，只能由我们的目录做唯一事实源 |

---

## 2. 目标支持清单（本机 `image-gen` 技能实测）

来源：`/home/nichangen/.agents/skills/image-gen`（Friday Gateway / oneai）。
模型清单以技能 `node scripts/models.mjs --image-only` 的实时返回为准，**文档收录的模型名可能过时**。

### 2.1 提供商与模型

提供商：**Friday Gateway（oneai）**，公司内部网关，OpenAI 兼容面 `https://oneai.17usoft.com/v1`，`Authorization: Bearer $ONEAI_API_KEY`。
在 Flowlet 里它天然是一个 `custom` 渠道账号（OpenAI Base URL + Anthropic Base URL）。

实测可用生图模型 **8 个**（`GET /v1/models` 返回 17 个模型，其中 image=8、chat=9）：

| 系列 | 模型 Code | 请求形态 | 返回形态 | 计费 | 单价 |
|---|---|---|---|---|---|
| GPT Image | `gpt-image-2` | 扁平（OpenAI 风格） | `data[].b64_json`（固定，不支持 `response_format`） | token | 输出 ¥219/1M、文本输入 ¥36.5/1M、图片输入 ¥58.4/1M |
| GPT Image | `gpt-image-2.5-flare` | 同上 | 同上 | token | 同上；1024² `high` ≈¥0.39、`low` ≈¥0.045 |
| GPT Image | `gpt-image-2.5-sunburst` | 同上 | 同上 | token | 同上（编辑精度优先） |
| Seedream | `doubao-seedream-5.0-pro` | 扁平 + `response_format`；尺寸用 `1K/2K/3K/4K`；**无 `n`/`quality`** | `data[].url` | 按张 | ¥0.3（≤236 万像素）/ ¥0.6 |
| Seedream | `doubao-seedream-5.0-lite` | 同上 | 同上 | 按张 | ¥0.22 |
| Qwen-Image | `qwen-image-3.0` | **`input.messages` 嵌套**；尺寸用 `宽*高` | `output.choices[].message.content[].image` | 按张 | ¥0.18（≤120 万像素）/ ¥0.36 |
| Qwen-Image | `qwen-image-3.0-pro` | 同上 | 同上 | 按张 | ¥0.25 / ¥0.5 |
| Z-Image | `z-image-turbo` | 同上 | 同上 | 按张 | ¥0.09 |

**明确排除**：`gemini-3.1-flash-image-preview`（Gemini 协议面 `/google/v1/models/{model}:generateContent`，接入点未部署，实测 400；且 Flowlet 无该协议面）。

### 2.2 实测结论（其中 3 条改变了原方案）

#### 结论 1：上游 `/v1/models` **确实返回**生图模型 → 原先担心的规范冲突不成立

- `GET https://oneai.17usoft.com/v1/models` 实测返回 8 个生图模型 ID，因此现有「拉取模型列表 → 勾选」流程**能拿到候选**，把它们加入白名单即可勾选，**不需要放宽 AGENTS.md §6「不允许手工添加模型 ID」**；
- 但 `/v1/models` **不带任何模态/形态元数据** —— 技能自己是靠写死的正则表分类的（`scripts/lib.mjs:1003-1030`：`/gpt-image/i`、`/seedream/i`、`/qwen-image/i`、`/z-image/i` …）。
- **设计含义**：`kind`（chat/image）与请求形态**只能由 `model-catalog.json` 作为唯一事实源**，不得从上游响应推断。

#### 结论 2：同一端点三种请求形态 —— 本期最大的设计约束

全部 8 个模型都走**同一个** `POST /v1/images/generations`，但 body 形态分三种，响应路径也各不相同：

| 形态 | 模型 | 尺寸写法 | 张数 | 质量 | 输出格式 | 参考图 |
|---|---|---|---|---|---|---|
| `openai-images`（扁平） | GPT Image 系列 | `1024x1024` / `1536x1024` / `1024x1536` / `auto` | `n`（1–10） | `quality` | `output_format` | 走 `/v1/images/edits`（multipart） |
| `seedream`（扁平） | Seedream 系列 | `1K/2K/3K/4K` 或 `宽x高` | **无 `n`** | 无 | `output_format`（仅 lite） | 同端点 `image` 字段，URL 或 Base64，最多 10 张 |
| `dashscope-image`（嵌套） | Qwen-Image / Z-Image | **`宽*高` 星号** | **无 `n`** | 无 | 无 | `input.messages[].content[].image`，1–3 张 |

按 AGENTS.md §5「不做跨协议转换、不随意改写请求结构」，Flowlet **不得**把三种形态统一成一种。因此：

- `kind = image` 的目录条目必须再带一个 **`requestShape`** 字段（`openai-images` / `seedream` / `dashscope-image`）；
- 路由匹配仍只按模型名，**形态由模型决定**，Flowlet 不转换；
- **新增本地预校验**：入站 body 形态与目标模型声明的 `requestShape` 不匹配时，直接返回本地结构化错误（如 `image_request_shape_mismatch`），而不是把请求打给上游换回一个 400 —— 这与既有 `model_input_modality_unsupported` 预校验同一性质，**不是**协议转换；
- 这一条也是「只做 `kind=image` + 协议 `images`」不够的原因：协议族只能区分 chat / images，区分不了三种形态。

#### 结论 3：编辑（图生图 / 局部重绘）是真实需求，且是 multipart

- `/v1/images/edits` 为 `multipart/form-data`，`model` 是**表单字段**（gpt-image 系列 + dall-e）；支持 `mask`（透明区域=编辑范围）、`input_fidelity` 等；
- 技能用它做图生图、多图合成、局部重绘 —— **这是生图能力的一半，A 档不应简单 501 掉**；
- `extract_model`（[proxy_http.rs:975](../src-tauri/src/core/proxy_http.rs#L975)）只解析 JSON，multipart 会得到 `public_model = None` → 误导性 404。需要从 multipart 表单字段提取 `model`；
- 附带风险：body 捕获会把整个 multipart（含图片二进制）base64 落库，**存储放大明显**，必须纳入捕获策略。

#### 结论 4：计费两模式，B 档设计已可确定

- **token 模式**：GPT Image 系列（网关返回 usage）；
- **按张模式 + 像素阶梯**：Seedream / Qwen-Image / Z-Image（如 `maxPixels: 2360000` 以下 ¥0.3，以上 ¥0.6）；
- 现有 `models-cn.json` 只有 `1M_tokens` 一种单位，且运行时价格结构 `ModelPrice`（[config.rs:776](../src-tauri/src/core/config.rs#L776)）是按 token 的字段（`input_uncached_price` / `output_price` + 按**输入长度**分档的 `tiers`），`unit` 只是元数据字符串 → **B 档必须扩展结构，不能只加数据条目**；
- A 档因此**不得**给生图模型填任何价格条目：结构填不对会算出 0 或错值，属于「无真实数据支撑的指标」。留空 → `estimate_cost_at` 返回 `None` → 界面显示「无价格」，才是正确行为。

#### 结论 5：网关是「一个渠道、多协议面」

`oneai` 有 5 个互相独立的协议面：`/v1`（OpenAI，含生图）、`/google/v1`（Gemini）、`/anthropic/v1`（Claude）、`/openapi/v1`（OCR/搜索/视频）、`/system/v1`（用量）。
Flowlet 的 `custom` 渠道天然对应其中的 OpenAI + Anthropic 两面；**Gemini 面无对应协议，故 Gemini 生图明确排除**。

#### 结论 6：上游不支持流式生图

网关明确要求「不要传 `stream` 和 `partial_images`」→ 生图路径不涉及 SSE，Flowlet 的流式处理逻辑不需要扩展。

#### 结论 7：Seedream `watermark` 默认 `true`

上游默认给图打水印。Flowlet **不得**替客户端注入 `watermark: false`（那是改写请求体），但必须在 UI/文档中提示该模型需显式关闭水印。

---

## 3. A 档方案：新增 `images` 协议 + 模型 `kind` / `requestShape` 门控

### 3.1 核心决策

**方案一（推荐）：`ProtocolType` 新增 `Images` 变体 + 模型目录新增 `kind` 与 `requestShape`**

- 复用 `route.client_protocol` 作为候选池隔离维度 —— 该字段已是 TEXT 列，**无需 SQLite 迁移**；
- `match_candidates` 天然按协议隔离，错误语义自动正确（chat 模型打到生图端点 → `model_protocol_unsupported`）；
- `/v1/models` 走 OpenAI 协议路径，生图模型（`client_protocol = images`）天然不出现在列表里，避免 Agent 把生图模型当对话模型选中；
- `kind` 决定「该模型允许生成哪一族路由」，`requestShape` 决定「该模型的请求体形态」，两者都只在 `model-catalog.json` 声明。

**方案二（不推荐）：`RouteCandidate` 新增 `endpoint_family` 字段**

- 语义更准确，但需 SQLite 加列 + 迁移、`match_candidates` 加一维、新增错误码、日志 `client_protocol` 仍无法区分，改动面与风险都更大。

### 3.2 目录字段映射

| 模型 `kind` | 允许生成的 `client_protocol` | `requestShape` |
|---|---|---|
| `chat`（默认，缺失即此值） | `openai` / `anthropic` / `responses` | 不适用 |
| `image` | `images` | `openai-images` / `seedream` / `dashscope-image` |

`Images` 协议在上游侧复用 OpenAI Base URL 与 OpenAI 鉴权策略。

### 3.3 改动清单

#### ① 模型目录 `model-catalog.json`

- 每个模型新增**可选**字段 `kind: "chat" | "image"`（缺省 `chat`）与 `requestShape`（仅 `kind = image` 需要）；
- 建议 `schemaVersion` **保持 1**（字段可选、向后兼容）。理由：[identity.ts:23](../src/domains/modelCatalog/identity.ts#L23) 与 [model_catalog.rs:42](../src-tauri/src/core/model_catalog.rs#L42) 都硬断言 `schemaVersion === 1`，升级版本号需同步改两处校验与既有测试；
- 按 §2.1 新增 8 个生图模型条目，`aliases` 登记上游变体，遵守 AGENTS.md §6「模型身份由规范化模型 ID 决定」；`ownerChannelId` 的处理见 §3.4；
- 生图模型**不同时进入 `flowlet_tiers` 聚合池**；
- ⚠️ **两处硬断言必须同步改**，否则测试直接失败：
  - [model_catalog.rs:155](../src-tauri/src/core/model_catalog.rs#L155) `assert_eq!(catalog.supported_models().len(), 23)` —— 模型总数写死在测试里；
  - [model_catalog.rs:219](../src-tauri/src/core/model_catalog.rs#L219) `embedded_channel_defaults_match_catalog_ownership` 要求**每个 `ownerChannelId` 都是 `config.json` → `channels_config.default_exposed_models` 的 key**，且该数组包含该模型 id，最后还断言 `configured_count == models.len()`。

#### ② Rust 模型目录 `src-tauri/src/core/model_catalog.rs`

- `ModelIdentity` 增加 `kind`（serde `default` = chat）与 `request_shape`（可选）；
- 新增 `ModelKind` / `ImageRequestShape` 枚举与 `allowed_protocols()`，作为路由生成的唯一门控来源。

#### ③ 协议枚举 `src-tauri/src/core/config.rs`

- `ProtocolType` 增加 `#[serde(rename = "images")] Images`；
- `from_path`：在 `v1/` 分支之前判断 `v1/images/` 与 `openai/v1/images/` → `Images`；
- `is_responses_path` 不受影响；
- `base_url_for`（[:490](../src-tauri/src/core/config.rs#L490)）与 `auth_strategy_for`（[:499](../src-tauri/src/core/config.rs#L499)）：`Images` 并入 OpenAI 分支；
- `classify_request`：建议新增 `RequestType::Image`（`as_str = "image"`），否则生图请求在日志中显示 `unknown`；需同步前端 `request_type` 展示与相关测试；
- `parse_protocols`（[channels_config.rs:594](../src-tauri/src/core/channels_config.rs#L594)）：增加 `"images"` 分支。**当前默认分支 `_ => ProtocolType::OpenAi` 会把拼错的协议名静默降级为 openai**，建议改为显式白名单 + 未知值忽略并记录日志。

#### ④ 路由生成（三处必须一致，否则前后端对账会互相删路由）

- Rust [channels_config.rs:402](../src-tauri/src/core/channels_config.rs#L402) `merge_default_routes`：`preset.supported_protocols` 需与模型 `allowed_protocols()` 取交集。注意当前循环顺序是 protocol 在外、model 在内，**kind 判断需下移到模型循环内**；
- 前端 [commands.ts:125](../src/domains/model/commands.ts#L125) `mergeDefaultRoutes` / `buildDefaultRoutes`：同样加 kind 门控；
- 前端 [commands.ts:167](../src/domains/model/commands.ts#L167) `reconcileAccountRoutes` 的 custom 渠道 `hasEndpoint` 判断：把 `images` 归入 OpenAI 分支，否则 custom 渠道生图路由会被保存时误删；
- Rust `protocol_has_endpoint`（[channels_config.rs:439](../src-tauri/src/core/channels_config.rs#L439)）：同样把 `Images` 并入 OpenAI 分支。

#### ⑤ 转发层 `proxy.rs` / `proxy_http.rs`

- 路由注册：catch-all 已覆盖，**无需新增 route**（可选：显式声明以提升可读性）；
- `build_upstream_url`：`Images` 并入 `OpenAi | Responses` 分支；
- [proxy.rs:851](../src-tauri/src/core/proxy.rs#L851) 的 `openai_path_strips_v1` 分支：把 `Images` 加入 `matches!`，否则智谱生图会拼成 `/api/paas/v4/v1/images/generations`；
- `ensure_reasoning_content_passback`（[proxy_http.rs:1449](../src-tauri/src/core/proxy_http.rs#L1449)）：gate 为 `*protocol != ProtocolType::OpenAi`，新增变体后自动不作用于 `Images`；**必须补回归测试**，防止未来改成 `matches!` 时误伤；
- `request_uses_image`（[model_input_capabilities.rs:164](../src-tauri/src/core/model_input_capabilities.rs#L164)）：match 补 `Images => false`（生图请求体没有 chat 语义的 `image_url` 输入；multipart 也解析不了 JSON）；
- **新增形态预校验**（见 §2.2 结论 2）：按目标模型的 `requestShape` 校验 body 形态，不匹配则本地返回 `image_request_shape_mismatch`，不打上游；
- `is_model_list_request`：不变。

#### ⑥ `/v1/images/edits`（multipart）—— A 档建议**支持**

- 从 multipart 表单字段提取 `model` 用于路由匹配（替代 `extract_model` 的 JSON 解析路径）；
- 路由与鉴权与 `generations` 一致；**不做 body 改写**（`model` 字段在 multipart 中同样需要按路由替换上游模型名 —— 这是既有 `rewrite_model` 的等价操作，需确认改写方式：multipart 需按 part 重写，而非 JSON 字符串替换）；
- 若 A 档决定先不做，必须返回明确的结构化错误（如 501 + `image_edits_unsupported`），**不得**让客户端收到误导性的 404 `model_not_exposed`。

#### ⑦ 日志与捕获

- `client_protocol` / `upstream_protocol` 会写入 `"images"`（TEXT 列，无迁移）；
- 前端协议标签、请求类型标签需补 `images` / `image` 文案（[logPresentation.ts](../src/features/request-logs/logPresentation.ts) 等）；
- 响应体捕获：`b64_json` 可能超 `max_body_bytes`（默认 1MB）；multipart 编辑请求的输入图二进制会被 base64 放大。A 档建议对 `images` 协议默认豁免响应体捕获，并在请求详情页明示「生图响应体过大未完整捕获」。

#### ⑧ 计量与成本：A 档**不造假**

- `estimate_cost_at`（[storage_usage.rs:406](../src-tauri/src/core/storage_usage.rs#L406)）在找不到价格条目时返回 `None` —— 生图模型自然显示「无价格」，**这符合 AGENTS.md 禁止无真实数据支撑的指标**，A 档无需新增 `per_image` 价格；
- 明确边界：A 档只记请求数、状态、延迟、上游报文；今日 Token 不含生图；用量页对 `images` 协议显示「未计量（不支持按 token 计费）」而不是 `0`，避免用户误以为免费。

#### ⑨ 前端 UI

- [channel/types.ts:24](../src/domains/channel/types.ts#L24) `ProtocolType` 加 `"images"`；[model/types.ts:13](../src/domains/model/types.ts#L13) 同步；
- 账号编辑器：模型列表按 `kind` 分组、打「生图」Tag；**生图模型要显示 `requestShape` 对应的调用形态提示**（三种形态尺寸写法不同，写错会 400）；复用同一 OpenAI Base URL 输入，不新增账号字段；
- 模型服务页：`MODEL_MODALITY_LABELS` 已含 `image → 图像`，**无需改标签**；只需让生图模型在 `models-cn.json` 中带上 `outputModalities: ["image"]`，规格缺失时走既有空态；
- Seedream 模型需提示「上游默认打水印，需显式传 `watermark: false`」；
- 聚合模型：`flowlet-pro` / `flowlet-flash` 成员选择器必须禁用 `kind = image` 的模型；`aggregate_model_inputs` 与 DSH/OpenCode/Pi 的模型声明都不应把生图模型算入。

#### ⑩ 渠道与注册表

- `config.json` → `channels_config.channels[].supported_protocols` 为支持生图的渠道加 `"images"`（`custom` 建议默认加，中转站最可能承载生图）；
- `plugin-registry.json` 渠道贡献声明与 [plugin_contract.rs:47](../src-tauri/src/core/plugin_contract.rs#L47) 校验需允许 `"images"`；校验中 `if channel_id != "custom"` 分支需确认不会把 `images` 误判为缺少 Base URL；
- 若 8 个生图模型的 `ownerChannelId` 涉及新渠道身份（doubao / z-image 等），需按 `docs/channel-integration.md` 走完整渠道接入流程；
- 同步 `docs/config.md` 第 7/8/9 节、`AGENTS.md` §5 协议列表与 §6 模型白名单、`docs/architecture.md`。

### 3.4 ⚠️ 归属身份（`ownerChannelId`）需要决策

`ownerChannelId` 不是装饰字段，它决定官方品牌、规格与基准价格的解析（AGENTS.md §6），并被
`official_channel_id_for_model`（[model_catalog.rs:144](../src-tauri/src/core/model_catalog.rs#L144)）用于价格回退
（[storage_usage.rs:433](../src-tauri/src/core/storage_usage.rs#L433)）。

现有 `default_exposed_models` 只有 6 个 key：`longcat` / `deepseek` / `kimi` / `qwen` / `zhipu` / `openrouter`（`custom` 不在其中）。
8 个目标模型的官方归属如下：

| 模型 | 官方归属 | Flowlet 现有渠道身份？ |
|---|---|---|
| `qwen-image-3.0` / `qwen-image-3.0-pro` | 阿里云百炼（Qwen） | ✅ `qwen` |
| `z-image-turbo` | 阿里云 Model Studio / 通义（[Alibaba Cloud 文档](https://www.alibabacloud.com/help/en/model-studio/z-image-api-reference)） | ✅ `qwen`（需确认是否与 qwen 共用 `modelsCnProviderId`） |
| `gpt-image-2` / `gpt-image-2.5-flare` / `gpt-image-2.5-sunburst` | OpenAI | ❌ 无 |
| `doubao-seedream-5.0-pro` / `doubao-seedream-5.0-lite` | 字节火山方舟（[火山引擎文档](https://docs.volcengine.com/docs/6492/2172373?lang=zh)） | ❌ 无 |

三种处理方式：

- **(a) 推荐：新增「归属身份」`openai` / `doubao`** —— 只用于品牌、规格与价格归属，不建可调用渠道（用户仍通过 `custom` 渠道账号实际调用）。改动：`model-catalog.json` 填 `ownerChannelId`，`config.json` 的 `default_exposed_models` 增加对应 key 与模型列表（满足 §3.3 ① 的硬断言）。前端 `channelById.get(ownerChannelId)?.name ?? ownerChannelId`（[modelServiceView.ts:114](../src/pages/models/modelServiceView.ts#L114)）已有回退，但**品牌图标需按 AGENTS.md 的 Lobe Icons 规则补静态资源**，否则显示为裸 ID。
- **(b) 归到 `custom`** —— 与 AGENTS.md §6「模型身份和官方归属由规范化模型 ID 决定，不由实际承载请求的渠道决定」直接冲突，且 `custom` 不在 `default_exposed_models` 中，需要额外放宽。**不推荐**。
- **(c) 为 OpenAI / 豆包建真正的可调用渠道** —— 需要走完整 `docs/channel-integration.md` 流程（协议核实、SQLite 迁移、余额、模型同步、品牌图标、回归测试）。若后续确实要直连官方 API，再做；本期不必。

### 3.5 迁移与兼容

- **无 SQLite schema 变更**：`client_protocol` 为 TEXT；`exposed_models` / `synced_models` 存上游原名；
- 旧配置无 `kind` → 默认 `chat`，现有行为完全不变；
- 旧日志无 `"images"` 取值，前端展示需兜底；
- `schemaVersion` 保持 1（见 3.3 ①）。

### 3.6 测试清单

**Rust**

- `from_path("/v1/images/generations") == Images`；`/v1/chat/completions` 仍为 OpenAi；
- 路由生成：`kind = image` 的模型只生成 `images` 协议路由；`kind = chat` 不生成 `images` 路由；
- 匹配：images 请求 + chat 模型 → 404 `model_protocol_unsupported`；chat 请求 + image 模型 → 同上；
- **形态校验**：`dashscope-image` 模型收到扁平 body → 本地 `image_request_shape_mismatch`，且**未发起上游请求**（断言假上游零调用）；
- `build_upstream_url`：`/v1/images/generations` → `{base}/v1/images/generations`，含智谱无 `/v1` 分支；
- multipart：`/v1/images/edits` 能从表单字段提取 `model` 并完成路由与上游模型名改写；
- e2e（沿用 [proxy_tests.rs](../src-tauri/src/core/proxy_tests.rs) 假上游 harness）：三种形态各一条透传用例 + 日志 `client_protocol = "images"`；
- 回归：`ensure_reasoning_content_passback` 对 `Images` 不改写 body；
- **目录契约**：更新 `supported_models().len()` 断言；`embedded_channel_defaults_match_catalog_ownership` 通过（每个 `ownerChannelId` 都在 `default_exposed_models` 中且条目齐平）。

**前端**

- `mergeDefaultRoutes` / `reconcileAccountRoutes` 的 kind 门控单测（含 custom 渠道不被误删）；
- `ProtocolType` 展示兜底单测；
- 生图模型不出现在聚合模型候选中的单测。

### 3.7 实现前必须实测确认项

1. 三种形态的 body 与 `model` 字段位置（已从技能配置确认，但需对真实网关复跑一次确认未变更）；
2. Flowlet 的 custom 渠道 `/models` 同步在真实网关上是否返回全部 8 个生图模型（技能实测为 8 个，但网关已部署模型会变动）；
3. multipart 下 `model` 字段的改写方式（是否必须重写 part，以及网关是否接受改写后的 multipart）；
4. 生图响应的 `usage` 字段形态（决定 B 档 token 模式解析）。

---

## 4. B 档与 C 档边界（本次不做）

- **B 档 · 计量完整**：`models-cn.json` 引入 `unit = "per_image"` + 像素阶梯（`maxPixels` / `outputYuanPerImage`，见 §2.1 价格表）；GPT Image 系列按 token 模式解析网关返回的 `usage`；成本账本与用量页支持两种口径。预计 +2–3 天。
- **C 档 · Agent 侧**：OpenCode / Pi / DSH 的模型声明是 chat 语义，生图模型不得进入 `flowlet-pro` / `flowlet-flash` 聚合池，也不得写入客户端的模型能力声明。

---

## 5. 工作量估算

| 档位 | 内容 | 估算 |
|---|---|---|
| A 档 | 上述全部改动 + 三种形态校验 + multipart 编辑 + 归属身份 + 测试 + 文档同步（不含真实渠道联调） | 4–6 天 |
| B 档 | 按张计量 + token 模式 | +2–3 天 |

> 相比只做 `kind=image` 的初版方案，A 档因三项实测发现而增加约 2–3 天：「同一端点三种请求形态」、「multipart 编辑」、「openai / doubao 归属身份缺失」。

---

## 6. 风险提示

- 生图不属于 AGENTS.md §15 的当前核心链路（渠道账号 → 开放模型 → 本地代理 → Agent 接入）。若目标只是让某个 Agent 用生图，**短期更省事的方案是客户端直连上游，Flowlet 只做渠道账号管理**；
- **三种请求形态是最大的体验风险**：客户端（Agent）必须按模型形态发请求，Flowlet 不做转换。若 Agent 只会发 OpenAI 扁平形态，则可用模型只有 GPT Image + Seedream 两族；
- 计费缺失容易被误解为免费，UI 必须显式标注「未计量」；
- 生图响应体与 multipart 输入图体积较大，需评估 `body_retention_days` / `body_max_size_mb` 的存储影响；
- 本机 `image-gen` 技能使用的是公司内部网关与个人 API Key；Flowlet 侧应以用户自建的 `custom` 渠道账号承载，**不得把技能里的 Key 或内部地址硬编码进仓库**。
