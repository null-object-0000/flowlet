# Flowlet 当前支持矩阵

> 状态日期：2026-07-29  
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
| `POST /v1/chat/completions` | ✅ | OpenAI Chat Completions 透明转发 |
| `GET /anthropic/v1/models` | ✅ | 返回当前 Anthropic 协议下可用的开放模型 |
| `POST /anthropic/v1/messages` | ✅ | Anthropic Messages 透明转发 |
| `POST /v1/responses` | ◐ | 通配路由可以机械透传，但尚未完成渠道能力约束、Responses 流式观测和正式回归验证 |
| OpenAI ↔ Anthropic 转换 | — | Flowlet 明确不做跨协议转换 |
| Responses ↔ Chat Completions 转换 | — | Flowlet 明确不做跨协议转换 |
| Gemini-compatible | — | 尚未提供正式入口 |

OpenAI 入口实际由 `/v1/{*path}` 与 `/openai/v1/{*path}` 通配路由承载，因此
`/v1/responses` 可以被转发到同路径上游。但在补齐能力声明、模型限制、日志用量解析和
测试前，不能将其描述为 Flowlet 已正式支持的协议。

## 3. 渠道支持

Flowlet 当前有五种渠道模板：LongCat、DeepSeek、Kimi、Qwen 和自定义渠道。
千问按量付费与 Token Plan 共用 `qwen` 渠道模板，但使用不同的 API Key 和 Base URL，
因此在矩阵中分开列出。

### 3.1 渠道能力矩阵

| 渠道 | OpenAI Chat | Anthropic Messages | 模型列表 | 模型详情 | 余额/资源 | 上游 Responses API |
|------|-------------|--------------------|----------|----------|-----------|----------------------|
| LongCat | ✅ | ✅ | ✅ | ✅ | 控制台抓取资源包与按量余额 | — 官方端点未列出 |
| DeepSeek | ✅ | ✅ | ✅ | — | ✅ 官方余额 API | — 官方当前仅文档化 Chat Completions |
| Kimi / Moonshot | ✅ | ✅ | ✅ | — | ✅ 官方余额 API | — 官方当前声明兼容 Chat Completions |
| Qwen 按量付费 | ✅ | ✅ | ✅ | — | — | ✅ 官方明确支持 |
| Qwen Token Plan | ✅ | ✅ | ✅ | — | ✅ 控制台抓取套餐额度 | ✅ 官方明确支持 |
| 自定义渠道 | 取决于已填写的 OpenAI Base URL | 取决于已填写的 Anthropic Base URL | ✅ 使用标准 OpenAI `/models` | — | — | 取决于上游，当前无自动检测 |

上游 Responses API 的当前结论：

- 千问按量付费提供 OpenAI-compatible `/compatible-mode/v1/responses`；
- 千问 Token Plan 也提供 Responses API，并给出了 Codex `wire_api = "responses"` 配置；
- LongCat、DeepSeek、Kimi 的当前官方端点目录没有确认 `/responses`，应按不支持处理，
  不能仅凭“OpenAI-compatible”推断；
- 自定义渠道代表中转站或自建服务，必须由具体账号的上游能力决定。

千问官方参考：

- [OpenAI-compatible Responses API](https://help.aliyun.com/en/model-studio/qwen-api-via-openai-responses)
- [Codex 接入](https://help.aliyun.com/en/model-studio/codex)
- [Token Plan 快速开始](https://help.aliyun.com/en/model-studio/token-plan-quickstart)

其他渠道官方参考：

- [LongCat API 概述](https://longcat.chat/platform/docs/APIDocs.html)
- [DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion)
- [Kimi API 概述](https://platform.kimi.com/docs/api/overview)

### 3.2 账号与路由规则

- 一个账号只属于一个渠道，并保存一个 API Key；
- 同一渠道可以添加多个账号；
- 账号和开放模型为空时，代理仍可正常启动；
- 模型候选来自最近一次上游 `/models` 返回的 `synced_models`；
- 用户必须在账号编辑器中显式选择 `exposed_models`；
- 实际路由取“全局白名单 ∩ `synced_models` ∩ `exposed_models`”；
- 自定义渠道只为已经填写 Base URL 的协议生成路由；
- 客户端协议与上游协议必须一致，Flowlet 不在协议之间转换；
- 第一个渠道账号的新路由默认开启，后续账号的新路由默认关闭；
- 账号优先级、启停状态和失败降级作用于实际路由，不改变模型身份。

## 4. 模型支持

Flowlet 当前总共支持 11 个规范化模型。这个列表是全局白名单，不是按渠道切分的
固定路由表。

| 官方归属 | 规范化模型 ID | 聚合档位 | Responses 说明 |
|----------|---------------|----------|----------------|
| LongCat | `LongCat-2.0` | `flowlet-pro`、`flowlet-flash` | 当前官方渠道未确认 |
| DeepSeek | `deepseek-v4-pro` | `flowlet-pro` | 当前官方渠道未确认 |
| DeepSeek | `deepseek-v4-flash` | `flowlet-flash` | 当前官方渠道未确认 |
| Kimi | `kimi-k3` | `flowlet-pro` | 当前官方渠道未确认 |
| Kimi | `kimi-k2.7-code` | `flowlet-pro` | 当前官方渠道未确认 |
| Qwen | `qwen3.8-max-preview` | `flowlet-pro` | ✅，仅 Token Plan |
| Qwen | `qwen3.7-max` | `flowlet-pro` | ✅ 上游确认 |
| Qwen | `qwen3.7-plus` | `flowlet-pro` | ✅ 上游确认 |
| Qwen | `qwen3.7-flash` | `flowlet-flash` | ✅ 上游确认 |
| Qwen | `qwen3.6-plus` | `flowlet-pro` | ✅ 上游确认 |
| Qwen | `qwen3.6-flash` | `flowlet-flash` | ✅ 上游确认 |

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
它返回的所有第三方模型都视为支持 Responses。当前可以明确标记的范围是上表中的 Qwen
模型。

### 4.2 对外模型名

- 直接模型请求使用规范化模型 ID，例如 `deepseek-v4-pro`；
- 聚合模型使用 `flowlet-pro` 和 `flowlet-flash`；
- 对外请求必须匹配 `virtual_model_id`；
- 真正发送上游前才把模型名替换成 `upstream_model`；
- `/models` 只暴露当前协议下存在可用候选的模型。

## 5. Agent 支持

### 5.1 一等接入矩阵

概览页当前提供四类一等 Agent 入口。

| Agent | 安装探测 | 一键写入/恢复 | 接入协议 | 请求归属 | 原生会话与时间线 | 其他能力 |
|-------|----------|---------------|----------|----------|------------------|----------|
| Claude Code | ✅ CLI、多安装候选、版本 | ✅ | Anthropic Messages | ✅ User-Agent；官方 Session Header | ✅ | 主模型/快速模型/子 Agent 映射，可选 `[1m]` 长上下文 |
| OpenCode | ✅ CLI + Desktop | ✅ | OpenAI Chat Completions | ✅ User-Agent 与原生 Session Header | ✅ | CLI/Desktop 共用 Provider 和凭据配置 |
| Pi | ✅ CLI | ✅ | OpenAI Chat Completions | ✅ `x-flowlet-client: pi` | ✅ | 可部署原生扩展注入 `x-flowlet-session` |
| ChatGPT（Codex）/ Codex CLI | ✅ Desktop + CLI | — | 当前需要 Responses，尚未正式接入 Flowlet 网关 | — | ✅，Desktop 与 CLI 分开识别 | Codex 账号发现、授权、套餐用量和 credits 查询 |

“一键写入/恢复”包括：

- 检查当前配置是否指向 Flowlet；
- 修改前备份 Flowlet 管理的字段；
- 写入本地 Base URL、Client Token 和模型映射；
- 恢复时保留用户后来新增的非 Flowlet 字段。

Codex 当前不自动写入 `model_providers`。千问上游已经确认支持 Responses API，但 Flowlet
本地 `/v1/responses` 仍处于透明透传、未正式产品化的状态；在完成渠道/模型能力约束和
回归验证后，才适合开放 Codex 一键网关配置。

### 5.2 原生会话数据源

Flowlet 会只读以下 Agent 原生数据，不修改会话正文：

| Agent 类型 | 原生数据源 | 当前读取能力 |
|------------|------------|--------------|
| Claude Code | `~/.claude/projects/**/*.jsonl` | 主/子会话、标题、工作目录、时间线、工具事件、Token 用量 |
| OpenCode | 本地 `opencode.db` | 会话层级、消息与 part、模型、Token 和原生 cost |
| Pi | `~/.pi/agent/sessions/**/*.jsonl` | 树状会话、当前分支、消息、工具事件和 Token 用量 |
| Codex Desktop / CLI | `$CODEX_HOME/sessions/**/*.jsonl`、`session_index.jsonl` | 按 originator 区分 Desktop/CLI，读取时间线、工具事件、用量与模型 |

原生会话与经过 Flowlet 的请求按 `(agent_type, session_id)` 合并。未经过 Flowlet 的本地
会话也可以显示，但不会伪造 Flowlet 请求数、失败数或代理费用。

### 5.3 通用客户端兼容

未出现在一等接入卡片中的客户端，只要能手动配置以下任一协议，仍可作为通用客户端使用：

- OpenAI Chat Completions：Base URL 指向 `http://127.0.0.1:18640/v1`；
- Anthropic Messages：Base URL 指向 `http://127.0.0.1:18640/anthropic`；
- 鉴权使用 Flowlet Client Token。

Cline、Continue、Open WebUI、Gemini CLI、Hermes Agent 等目前没有完整的一等安装探测、
全局配置备份/写入和原生会话解析，因此不应在产品文案中与上表四类 Agent 标成同等级支持。
其中使用 Gemini 原生协议的客户端还需要等待 Flowlet 提供 Gemini-compatible 入口。

## 6. 当前主要缺口

1. 将 Qwen Responses 能力建模为明确的渠道/账号/模型能力，而不是依赖通配路径；
2. 补充 `/v1/responses` 普通响应、SSE、错误、日志、Token 用量与 fallback 测试；
3. 明确自定义渠道的 Responses 能力检测或用户声明机制；
4. 在 Responses 链路正式可用后开放 Codex `model_providers` 一键写入与恢复；
5. 扩展更多 Agent 的安装探测、配置管理、归属标记和原生会话解析；
6. Gemini-compatible 入口仍未实现。

## 7. 维护要求

发生以下变化时必须同步更新本文：

- 新增或删除渠道模板；
- 渠道新增协议、余额、资源或 Responses 能力；
- 修改 `FLOWLET_SUPPORTED_MODELS` 或聚合档位映射；
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
