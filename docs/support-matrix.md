# Flowlet 当前支持矩阵

> 状态日期：2026-08-10
> 本文描述当前工作区已经实现或已经确认的能力，不把路线图能力写成已支持。

本文统一说明 Flowlet 当前对渠道、模型和 AI Agent 的支持情况。判断某项能力时，
必须区分以下三层：

1. **上游原生能力**：渠道官方 API 是否真实提供对应协议或端点；
2. **Flowlet 代理能力**：本地代理是否已经完成转发、路由、日志和回归验证；
3. **产品接入能力**：桌面端是否提供账号流程、模型选择、Agent 探测或一键配置。

“OpenAI-compatible”不等于自动支持 OpenAI 的全部 API。尤其是 Chat Completions
与 Responses API，必须分别确认。

## 1. 状态标记

| 标记 | 含义 |
|------|------|
| ✅ | 当前已经实现，并有明确代码路径 |
| ◐ | 上游或底层路径具备能力，但 Flowlet 尚未作为正式产品能力完整验证 |
| — | 当前未实现、未确认或不适用 |
| 取决于上游 | 自定义渠道无法由 Flowlet 预先保证 |

## 2. Flowlet 协议边界

| 客户端入口 | 当前状态 | 说明 |
|------------|----------|------|
| `GET /v1/models` | ✅ | 返回当前 OpenAI 协议下可用的开放模型；空配置返回合法空列表 |
| `GET /v1/models/{model}` | ✅ | 返回已开放模型的上下文、最大输入/输出与价格；底层详情同步数据优先，缺失字段回退本地 models-cn；没有明确来源的最大输入返回 `null`，不从上下文与最大输出推导 |
| `POST /v1/chat/completions` | ✅ | OpenAI Chat Completions 透明转发 |
| `GET /anthropic/v1/models` | ✅ | 返回当前 Anthropic 协议下可用的开放模型 |
| `POST /anthropic/v1/messages` | ✅ | Anthropic Messages 透明转发 |
| `POST /v1/responses` | ✅ | OpenAI Responses API 无状态透传，作为第三协议独立路由（仅声明 `"responses"` 的渠道参与候选）；兼容裸根入口 `POST /responses`；SSE 与 JSON 用量均解析落库 |
| `GET`/`DELETE /v1/responses/{id}`、`input_items` | — | 存储响应管理接口不支持，返回 405 明确错误 |
| OpenAI ↔ Anthropic 转换 | — | Flowlet 明确不做跨协议转换 |
| Responses ↔ Chat Completions 转换 | — | Flowlet 明确不做跨协议转换 |
| Gemini-compatible | — | 尚未提供正式入口 |

Responses 是独立协议（`ProtocolType::Responses`），不是 OpenAI 通配路由的副产品：
路由候选按 `client_protocol = "responses"` 匹配，未声明该协议的渠道（如 Kimi）
不会产生候选；上游端点从渠道 OpenAI Base URL 派生（`{base}/v1/responses`，
裸根入口 `/responses` 则拼出 `{base}/responses`），鉴权复用 `openai_auth`。
仅保证无状态透传：`previous_response_id` / `store` 的多账号粘性不支持。

## 3. 渠道支持

Flowlet 当前有七种渠道模板：LongCat、DeepSeek、Kimi、Qwen、Z.AI、OpenRouter 和自定义渠道。
千问按量付费与 Token Plan 共用 `qwen` 渠道模板，但使用不同的 API Key 和 Base URL，
因此在矩阵中分开列出。

### 3.1 渠道能力矩阵

| 渠道 | OpenAI Chat | Anthropic Messages | 模型列表 | 模型详情 | 余额/资源 | 上游 Responses API | Flowlet Responses 转发 |
|------|-------------|--------------------|----------|----------|-----------|----------------------|------------------------|
| LongCat | ✅ | ✅ | ✅ | ✅ | 控制台抓取资源包与按量余额 | ✅ 官方 Codex 文档确认（无状态） | ✅ |
| DeepSeek | ✅ | ✅ | ✅ | — | ✅ 官方余额 API | ✅ 官方文档确认无状态；模型级可用范围由上游决定 | ✅ |
| Kimi / Moonshot | ✅ | ✅ | ✅ | — | ✅ 官方余额 API | — 官方确认暂不支持 | —（不生成 responses 路由） |
| Qwen 按量付费 | ✅ | ✅ | ✅ | — | — | ✅ 官方明确支持（含有状态 store/retrieve） | ✅（仅无状态透传） |
| Qwen Token Plan | ✅ | ✅ | ✅ | — | ✅ 控制台抓取套餐额度 | ✅ 官方明确支持 | ✅（仅无状态透传） |
| Z.AI | ✅（路径无 `/v1`：`/api/paas/v4/chat/completions`） | ✅ | ✅（端点 `/api/paas/v4/models`） | — | — 官方暂无公开余额接口，先只支持 API 模式 | — 官方文档未确认 | —（不生成 responses 路由） |
| OpenRouter | ✅ | ✅（Anthropic Skin） | ✅ | — | ✅ API Key 用量与 Credits | ✅ 官方 `/api/v1/responses`（无状态） | ✅ |
| 自定义渠道 | 取决于已填写的 OpenAI Base URL | 取决于已填写的 Anthropic Base URL | ✅ 使用标准 OpenAI `/models` | — | — | 取决于上游，当前无自动检测 | ✅（填写 OpenAI Base URL 即生成路由，上游是否支持由用户保证） |

上游 Responses API 的当前结论：

- LongCat 官方 Codex 接入文档使用 `wire_api = "responses"`（端点
  `https://api.longcat.chat/openai/v1/responses`，`disable_response_storage = true`，
  支持 reasoning summaries），确认无状态支持；
- DeepSeek 官方 Responses API 文档确认端点 `https://api.deepseek.com/responses`，
  完全无状态（`store` / `previous_response_id` / `conversation` 不支持）；具体模型的
  Responses 可用性由上游决定，Flowlet 不做模型级能力推断；
- 千问按量付费与 Token Plan 提供 OpenAI-compatible `/compatible-mode/v1/responses`，
  并额外支持 `store` / `previous_response_id` 与 retrieve/delete/input_items
  管理接口（Flowlet 当前不透传这些有状态能力）；
- Kimi 已确认暂不支持 Responses API，`supported_protocols` 不声明 `"responses"`；
- OpenRouter 官方提供 `/api/v1/responses` 和 Anthropic Messages Skin；Flowlet 只开放
  映射到全局白名单的上游模型，不把 OpenRouter 当作新的模型品牌；
- 自定义渠道代表中转站或自建服务，必须由具体账号的上游能力决定。

官方参考：

- [DeepSeek Responses API](https://api-docs.deepseek.com/zh-cn/guides/responses_api)
- [DeepSeek Anthropic 兼容 API](https://api-docs.deepseek.com/zh-cn/guides/anthropic_api)
- [LongCat Codex 接入](https://longcat.chat/platform/docs/zh/codex)
- [千问 OpenAI Responses](https://platform.qianwenai.com/docs/api-reference/chat/openai-responses)
- [千问 Codex 接入](https://help.aliyun.com/en/model-studio/codex)
- [LongCat API 概述](https://longcat.chat/platform/docs/APIDocs.html)
- [DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion)
- [Kimi API 概述](https://platform.kimi.com/docs/api/overview)
- [OpenRouter Responses API](https://openrouter.ai/docs/api/api-reference/responses/create-responses)
- [OpenRouter Claude Code / Anthropic Skin](https://openrouter.ai/docs/guides/coding-agents/claude-code-integration)

### 3.2 账号与路由规则

- 一个账号只属于一个渠道，并保存一个 API Key；
- 同一渠道可以添加多个账号；
- 账号和开放模型为空时，代理仍可正常启动；
- 模型候选来自最近一次上游 `/models` 返回的 `synced_models`；
- 用户必须在账号编辑器中显式选择上游原始模型 ID `exposed_models`；
- 实际路由取“全局白名单（按规范模型判断）∩ `synced_models` ∩ `exposed_models`”；
- 同一规范模型的多个上游 ID 分别生成候选路由，对外模型列表与用量仍按规范 ID 合并；
- 自定义渠道只为已经填写 Base URL 的协议生成路由；
- 客户端协议与上游协议必须一致，Flowlet 不在协议之间转换；
- 第一个渠道账号的新路由默认开启，后续账号的新路由默认关闭；
- 账号优先级、启停状态和失败降级作用于实际路由，不改变模型身份。

## 4. 模型支持

Flowlet 当前总共支持 22 个规范化模型。这个列表是全局白名单，不是按渠道切分的
固定路由表。

| 官方归属 | 规范化模型 ID | Responses 说明 |
|----------|---------------|----------------|
| LongCat | `LongCat-2.0` | ✅ 上游确认 |
| DeepSeek | `deepseek-v4-pro` | ◐ Flowlet 会生成候选；上游模型级可用性需实测 |
| DeepSeek | `deepseek-v4-flash` | ✅ 上游确认 |
| DeepSeek | `deepseek-v4-flash-vision-exp` | ◐ 视觉实验模型；上游模型级可用性需实测 |
| Kimi | `kimi-k3` | — 上游暂不支持 |
| Kimi | `kimi-k2.7-code` | — 上游暂不支持 |
| Qwen | `qwen3.8-max` | ✅ 上游确认 |
| Qwen | `qwen3.8-flash` | ✅ 上游确认 |
| Qwen | `qwen3.7-max` | ✅ 上游确认 |
| Qwen | `qwen3.7-plus` | ✅ 上游确认 |
| Qwen | `qwen3.7-flash` | ✅ 上游确认 |
| Qwen | `qwen3.6-plus` | ✅ 上游确认 |
| Qwen | `qwen3.6-flash` | ✅ 上游确认 |
| Z.AI | `glm-5.3` | — 上游文档未确认支持 |
| Z.AI | `glm-5.3-flash` | — 上游文档未确认支持 |
| Z.AI | `glm-5.2` | — 上游文档未确认支持 |
| Z.AI | `glm-4.7` | — 上游文档未确认支持 |
| Z.AI | `glm-4.5-air` | — 上游文档未确认支持 |
| OpenRouter | `ox-alpha` | — 上游文档未确认支持 |
| OpenRouter | `nemotron-3.5-lightning` | — 上游文档未确认支持 |
| OpenRouter | `nemotron-3-super-120b-a12b` | — 上游文档未确认支持 |
| OpenRouter | `nemotron-3-ultra-550b-a55b` | — 上游文档未确认支持 |

`flowlet-pro` 与 `flowlet-flash` 没有固定档位对应关系；用户可把上述任意已有渠道模型加入任一聚合模型。

### 4.1 模型身份与承载渠道

模型官方归属和实际承载请求的渠道是两件事：

```text
规范化模型 ID
  -> 决定官方品牌、规格和基准价格

Channel + Account + Protocol
  -> 决定请求实际发往哪里
```

只要某个渠道账号的 `/models` 返回全局白名单内的模型，用户就可以在该账号上选择开放。
例如千问 Token Plan 端点可能返回 DeepSeek 模型；该模型仍然是 DeepSeek 模型，只是由
千问账号承载请求。

Responses 能力同样必须按“渠道端点 + 模型”共同判断，不能因为账号属于 Qwen 渠道，就把
它返回的所有第三方模型都视为支持 Responses。Flowlet 的 responses 路由按渠道声明
（`supported_protocols` 含 `"responses"`）生成，模型级上游可用性差异（如 DeepSeek
Responses 暂时只接受 `deepseek-v4-flash`）由上游自行报错，Flowlet 不做模型级拦截。

### 4.2 对外模型名

- 直接模型请求使用规范化模型 ID，例如 `deepseek-v4-pro`；
- 聚合模型使用 `flowlet-pro` 和 `flowlet-flash`；
- 对外请求必须匹配 `virtual_model_id`；
- 真正发送上游前才把模型名替换成 `upstream_model`；
- `/models` 只暴露当前协议下存在可用候选的模型。

## 5. Agent 支持

### 5.1 一等接入矩阵

概览页当前提供六类一等 Agent 入口。

| Agent | 安装探测 | 一键写入/恢复 | 接入协议 | 请求归属 | 原生会话与时间线 | 其他能力 |
|-------|----------|---------------|----------|----------|------------------|----------|
| Claude Code | ✅ CLI、多安装候选、版本 | ✅ | Anthropic Messages | ✅ User-Agent；官方 Session Header | ✅ | 主模型/快速模型/子 Agent 映射，可选 `[1m]` 长上下文 |
| OpenCode | ✅ CLI + Desktop | ✅ | OpenAI Chat Completions | ✅ User-Agent 与原生 Session Header | ✅ | CLI/Desktop 共用 Provider 和凭据配置；可选按路由声明 `modalities` |
| Pi | ✅ CLI | ✅ | OpenAI Chat Completions | ✅ `x-flowlet-client: pi` | ✅ | 可选声明模型 `input`；可部署原生扩展注入 `x-flowlet-session` |
| Codex | ✅ Desktop + CLI | ✅ | Responses（一键写入 `~/.codex/config.toml` + `auth.json`，覆盖 CLI / Desktop / VS Code 插件） | ✅ User-Agent（`codex_cli_rs/`） | ✅，Desktop 与 CLI 分开识别 | 账号发现/授权/套餐用量/credits 查询与单账号删除（承载于渠道账号卡片伪账号行的详情抽屉；删除只移除 Flowlet 本地凭据与观测快照，不影响 Codex 端登录态） |
| DeepSeek Harness | ✅ Web + Harness 目录 + 启动入口 | ✅，安全合并官方 YAML；Cordis 精确会话桥为显式可选高级能力 | OpenAI Chat Completions | ✅ 官方 User-Agent | ✅，DSH v0 原生会话；可选插件注入原生 session id 精确合并代理请求 | `dsh --profile headless` fresh task；暂不支持 resume |
| Hermes Agent | ✅ CLI、版本 | ✅，写入 `~/.hermes/config.yaml` 的 `model:` 段与 `${HERMES_CUSTOM_…_API_KEY}` 引用，密钥写入 `~/.hermes/.env`，注入 `x-flowlet-client: hermes` | OpenAI Chat Completions（`provider: "custom"`） | ✅ `x-flowlet-client: hermes`（复用 OpenAI Python SDK 通用 UA，无法靠 UA 区分） | ✅，`~/.hermes/state.db` SQLite 会话与消息（默认 + 各命名 Profile） | `hermes chat --oneshot --yolo` fresh task；可选「精确会话关联」受管插件；暂不支持 resume |

Codex 账号的新增/重新授权通过独立 Codex CLI 的 `codex app-server` 完成。Desktop 仍参与
安装探测、全局配置和原生会话读取，但 Microsoft Store 应用包内部的 `codex.exe` 不视为
可供 Flowlet 外部启动的 CLI；只有 Desktop、没有通过可执行探测的 CLI 时，Flowlet 会先提示安装 CLI。

“一键写入/恢复”包括：

- 检查当前配置是否指向 Flowlet；
- 修改前备份 Flowlet 管理的字段；
- 写入本地 Base URL、Client Token 和模型映射；
- 恢复时保留用户后来新增的非 Flowlet 字段。

DeepSeek Harness 的一键写入直接安全合并 `$DSH_HOME/settings.yaml` 与
`$DSH_HOME/.credentials.yaml`：Flowlet 复用 DSH 的相邻文件锁协议，并使用原子替换和跨文件
失败回滚。DSH Web 无需运行；运行中可热加载，未运行时下次启动生效。恢复仅还原
`llm-pi-ai.providers.flowlet`、`agent-default-model.provider/model` 与专用 Client Token，
不覆盖其他设置或注释。
基础接入不要求 DSH Profile 已初始化，也不会安装插件。只有用户显式开启“精确会话关联”后，
Flowlet 才部署受管 Cordis 桥；启用或关闭后需重启正在运行的 DSH，且可随时关闭或完整恢复。

OpenCode 与 Pi 的“输入模态声明”默认关闭。开启后，Flowlet 根据 `flowlet-pro` / `flowlet-flash`
当前启用路由的模型目录能力写入客户端官方字段：OpenCode 使用
`modalities: { input: ["text", "image"], output: ["text"] }`，Pi 使用
`input: ["text", "image"]`；没有图片候选的聚合模型只声明 `text`。OpenCode 需重启以刷新模型
能力缓存；Pi 在打开模型选择器时重读 `models.json`。

Codex 全系（Codex CLI、ChatGPT 桌面端、VS Code Codex 插件）共享同一份
`~/.codex/config.toml` 与 `auth.json`，Flowlet 一键写入一次即覆盖三端：受管
`[model_providers.flowlet]`（`wire_api = "responses"`、Base URL 指向本地代理、
`requires_openai_auth = true`）、顶层 `model = "flowlet-pro"` 与
`disable_response_storage = true`（强制无状态，避免 `store`/`previous_response_id`
破坏多账号路由），Client Token 写入 `auth.json` 的 `OPENAI_API_KEY`。写入前备份
受管字段，恢复时还原此前的登录方式与配置（保留用户其它 provider 与注释）。
请求经 User-Agent `codex_cli_rs/` 归属为 Codex（内置兜底规则，无需改 config.json）。

Hermes Agent 的一键写入修改 `~/.hermes/config.yaml` 的 `model:` 段：写入
`provider: "custom"`、`base_url` 指向本地代理，`default` 为用户在接入抽屉中选择的默认
模型（`flowlet-pro` / `flowlet-flash`，默认 `flowlet-pro`），并写入
`api_key: ${HERMES_CUSTOM_<host:port>_API_KEY}` 引用（官方“Custom endpoint”约定，
`custom_endpoint_key_env`），真实密钥落到 `~/.hermes/.env` 的同名变量；同时在
`default_headers` 注入 `x-flowlet-client: hermes` 用于客户端归属。逐键 patch 保留
用户在 `model:` 段内的其它设置（`streaming` / `context_length` 等）；写入前把整个
`model` 值与受管 `.env` 变量备份到 `~/.hermes/.flowlet/`，恢复时整键还原（含全新安装
的空串哨兵 `model: ""`）。Hermes 复用 OpenAI Python SDK 的通用 User-Agent，无法靠 UA
子串区分，因此归属完全依赖注入的标记头，不依赖 `config.json` 的 `ua_rules`。

Hermes 原生请求不携带会话标识（OpenAI Python SDK），因此默认无法把经过 Flowlet 的请求
按会话归并到 `state.db` 的原生会话：请求会被归属为 Hermes 客户端并进入请求日志，但会话
列表会显示「经过 Flowlet（未关联会话）」。若需要按会话查看请求与用量，可在接入抽屉开启
「精确会话关联」（高级可选能力，默认关闭）：Flowlet 向 `~/.hermes/plugins/flowlet-session-bridge/`
写入受管插件（`plugin.yaml` + `__init__.py`）并在 `config.yaml` 的 `plugins.enabled` 注册；
该插件注册 Hermes 官方 `llm_request` 中间件，为发往 Flowlet 本地代理的请求注入
`x-flowlet-session`（值与 `sessions.id` 一致），Flowlet 识别后按 `(agent_type, session_id)`
精确合并。启用或关闭后需重启 Hermes（gateway 需 `hermes gateway restart`）；关闭或恢复时
插件随全局配置一并备份、原子写入与还原。

### 5.2 原生会话数据源

Flowlet 会只读以下 Agent 原生数据，不修改会话正文：

| Agent 类型 | 原生数据源 | 当前读取能力 |
|------------|------------|--------------|
| Claude Code | `~/.claude/projects/**/*.jsonl` | 主/子会话、标题、工作目录、时间线、工具事件、Token 用量 |
| OpenCode | 本地 `opencode.db` | 会话层级、消息与 part、模型、Token 和原生 cost |
| Pi | `~/.pi/agent/sessions/**/*.jsonl` | 树状会话、当前分支、消息、工具事件和 Token 用量 |
| Codex Desktop / CLI | `$CODEX_HOME/sessions/**/*.jsonl`、`session_index.jsonl` | 按 originator 区分 Desktop/CLI，读取时间线、工具事件、用量与模型 |
| Hermes Agent | `~/.hermes/state.db` 与 `~/.hermes/profiles/*/state.db`（SQLite，`HERMES_HOME` 可覆盖） | 会话、标题、工作目录、入口来源（source）、Profile、消息、工具结果与 Token 用量 |

原生会话与经过 Flowlet 的请求按 `(agent_type, session_id)` 合并。未经过 Flowlet 的本地
会话也可以显示，但不会伪造 Flowlet 请求数、失败数或代理费用。

### 5.3 通用客户端兼容

未出现在一等接入卡片中的客户端，只要能手动配置以下任一协议，仍可作为通用客户端使用：

- OpenAI Chat Completions：Base URL 指向 `http://127.0.0.1:18640/v1`；
- Anthropic Messages：Base URL 指向 `http://127.0.0.1:18640/anthropic`；
- OpenAI Responses：Base URL 指向 `http://127.0.0.1:18640/v1`（端点
  `POST /v1/responses`，无状态透传，不要开启 `store`）；
- 鉴权使用 Flowlet Client Token。

Cline、Continue、Open WebUI、Gemini CLI 等目前没有完整的一等安装探测、
全局配置备份/写入和原生会话解析，因此不应在产品文案中与上表 Agent 标成同等级支持。
其中使用 Gemini 原生协议的客户端还需要等待 Flowlet 提供 Gemini-compatible 入口。

## 6. 当前主要缺口

1. Qwen 有状态 Responses 能力（`store` / `previous_response_id` 的账号粘性路由、
   retrieve/delete/input_items 透传）；
2. 各渠道 Responses 的模型级可用范围仍由上游决定，Flowlet 当前不做能力探测；
3. 扩展更多 Agent 的安装探测、配置管理、归属标记和原生会话解析；
4. Gemini-compatible 入口仍未实现。

## 7. 维护要求

发生以下变化时必须同步更新本文：

- 新增或删除渠道模板；
- 渠道新增协议、余额、资源或 Responses 能力；
- 修改 `FLOWLET_SUPPORTED_MODELS` 或聚合模型管理逻辑；
- 新增 Agent 接入卡片、全局配置写入或原生会话解析；
- Flowlet 正式支持新的客户端协议；
- “上游已支持”升级为“Flowlet 已正式支持”。

相关事实来源：

- 渠道模板与能力：`config.json`
- 前端模型白名单与档位：`src/domains/channel/types.ts`
- Rust 模型白名单与路由生成：`src-tauri/src/core/channels_config.rs`
- 代理入口与透明转发：`src-tauri/src/core/proxy.rs`
- Agent 一等入口：`src/features/agent-access/OverviewAgentAccessCard.tsx`
- Agent 环境探测：`src-tauri/src/core/agent_environment.rs`
- Agent 全局配置：`src-tauri/src/core/agent_global_config.rs`
- 原生会话目录与时间线：`src-tauri/src/core/agent_session_metadata.rs`、
  `src-tauri/src/core/agent_session_timeline.rs`
