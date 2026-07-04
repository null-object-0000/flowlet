# Flowlet 架构说明

## 目标

Flowlet 的第一阶段目标是做一个桌面优先、本地运行、多协议透明转发的 AI 请求路由客户端。当前阶段采用 LongCat + DeepSeek first 策略，优先把 LongCat / DeepSeek 的 OpenAI-compatible 与 Anthropic-compatible 两种透明转发入口做完整，并以 Claude Code 接入作为核心验证场景。

第一版正式实现采用破坏式重构策略。当前 Provider 原型、旧 SQLite 表和 `provider_id = default` 逻辑不需要兼容迁移，直接重建为 Channel / Account / Model 架构。

产品重心是开箱即用的本地 AI 请求路由体验：普通用户选择渠道模板、填写 API Key、选择模型即可接入；高级用户再展开自定义 Base URL、Header、模型名、价格和错误识别规则。

架构设计必须服务于以下边界：

- 支持多协议透明转发，但不做跨协议转换。
- 响应零改写。
- 请求侧只做 base_url、Authorization/Header 和可选 model 映射。
- 日志旁路记录，失败不能影响主请求链路。
- 模型列表、价格、余额、额度、用量查询只能用于异步同步和配置辅助。
- Token 和成本分析走离线任务，不能阻塞真实请求。
- 第一阶段采用 LongCat + DeepSeek first，同时完成两个首发渠道的 OpenAI-compatible 与 Anthropic-compatible 两种透明转发入口。

## 总体结构

```text
Flowlet Desktop
  ├─ src/                         React + TypeScript + Vite 前端
  ├─ src-tauri/                   Tauri 2 桌面壳
  │  └─ src/
  │     ├─ lib.rs                 Tauri 应用入口和 command 注册
  │     ├─ main.rs                桌面进程入口
  │     └─ core/
  │        ├─ mod.rs              Core 模块出口
  │        ├─ config.rs           基础配置结构
  │        ├─ presets.rs          内置渠道模板
  │        ├─ provider.rs         用户渠道配置
  │        ├─ adapter.rs          渠道能力适配器
  │        ├─ sync.rs             模型 / 价格 / 额度异步同步任务
  │        ├─ proxy.rs            本地透明代理
  │        ├─ storage.rs          SQLite 存储
  │        └─ analyzer.rs         离线 Token / 成本分析
  └─ docs/                        产品和架构文档
```

当前代码已经接入 SQLite 基础配置存储。后续架构文档不再把 SQLite 视为未来能力，而是把它作为 Channel、Account、Model、Client、虚拟模型、日志、用量、价格和快照数据的本地持久化层。

因为第一版尚未发布，SQLite 可以直接重建为新版最小表集合，不保留旧 `providers`、`provider_profiles` 或旧二段价格结构。

## 当前阶段核心模型

LongCat + DeepSeek first 阶段使用三层概念：

```text
渠道 Channel
  ↓
账号 Account
  ↓
模型 Model
```

- Channel 是服务商模板，当前首发渠道是 LongCat 和 DeepSeek。
- Account 是用户在某个渠道下配置的一组访问身份，当前版本明确一个账号只对应一个 API Key。
- Model 归属于渠道，不归属于账号，例如 LongCat-2.0。

路由候选使用：

```text
Channel + Account + Protocol + Model
```

账号是路由、统计、余额、失败状态的最小单位。

## 运行时端口

```text
127.0.0.1:18640  多协议透明代理端口
```

后续如需要管理 API，优先通过 Tauri command 给桌面 UI 使用；Docker / Web Console 阶段再引入独立管理端口。

## 协议入口

```text
Flowlet Local Proxy
  ├─ OpenAI-compatible Gateway
  │   └─ /v1/*
  │   └─ /openai/v1/*
  │
  ├─ Anthropic-compatible Gateway
  │   ├─ /anthropic/v1/messages
  │   └─ /anthropic/v1/models
  │
  └─ 后续 Gemini-compatible Gateway
      └─ Gemini API paths
```

OpenAI-compatible 请求只能转发到 OpenAI-compatible 上游。Anthropic-compatible 请求只能转发到 Anthropic-compatible 上游或 Claude Gateway。Gemini-compatible 请求只能转发到 Gemini-compatible 上游。

首发渠道默认映射：

```text
Flowlet /v1/* 或 /openai/v1/* -> https://api.longcat.chat/openai
Flowlet /anthropic/v1/* -> https://api.longcat.chat/anthropic
Flowlet /v1/* 或 /openai/v1/* -> https://api.deepseek.com
Flowlet /anthropic/v1/* -> https://api.deepseek.com/anthropic
```

Flowlet 不做：

```text
Claude Code / Anthropic 请求 -> 转成 OpenAI 请求
OpenAI 请求 -> 转成 Anthropic 请求
```

## 请求链路

```text
Cursor / Cline / Open WebUI / Cherry Studio / Continue
        ↓
http://127.0.0.1:18640/v1/*
        ↓
Flowlet OpenAI-compatible Gateway
        ↓
OpenAI-compatible Provider

Claude Code
        ↓
ANTHROPIC_BASE_URL=http://127.0.0.1:18640
        ↓
Flowlet Anthropic-compatible Gateway
        ↓
Anthropic-compatible Provider / Claude Gateway
```

代理只在请求侧做有限处理：

- 根据用户渠道配置选择 Provider。
- 将本地协议入口路径拼接到 Provider `base_url`。
- 替换上游 `Authorization` Header 或 `X-Api-Key` Header。
- 必要时将虚拟模型名映射为上游模型名。

响应侧不做业务改写：

- 不改 status code。
- 不改 response body。
- 不包装错误。
- 不补 `usage`。
- 不解析或重组 SSE。

## Channel Preset 架构

### Channel Preset

Channel Preset 由 Flowlet 内置维护，用来描述一个渠道模板：

- 渠道名称。
- OpenAI-compatible `base_url`。
- Anthropic-compatible `base_url`。
- 认证方式。
- 推荐默认模型。
- 初始模型列表。
- 内置价格来源。
- 支持能力。
- 支持协议列表。

LongCat + DeepSeek first 阶段第一优先模板是 LongCat 和 DeepSeek。两者都声明 OpenAI-compatible 与 Anthropic-compatible 两种上游端点。后续再扩展 OpenAI、OpenRouter、Moonshot、阿里云百炼、火山方舟、硅基流动、自建 New API、自建 LiteLLM、自定义 OpenAI-compatible、自定义 Anthropic-compatible 等模板。

### Channel Account

Channel Account 是用户在某个渠道下配置的一组访问身份：

- 关联 `channel_id`。
- 保存账号名称。
- 保存 API Key。
- 保存优先级。
- 保存是否启用。
- 保存最近使用时间、最近错误和备注。

当前版本明确一个账号只对应一个 API Key，不引入 Credential 概念。普通用户不需要理解 `base_url`、`auth_type`、`headers_json` 等技术字段。UI 默认展示“选择渠道、填写账号 API Key、选择模型、测试连接、保存并启用”，高级设置再暴露底层字段。

## ChannelAdapter

ChannelAdapter 为后续模型列表、价格、余额、额度和用量查询预留统一接口：

```text
ChannelAdapter
  - list_models()
  - get_model_detail()
  - sync_prices()
  - query_balance()
  - query_quota()
  - query_usage()
  - test_connection()
```

ChannelAdapter 只用于异步同步和配置辅助，不参与主请求转发。主请求转发仍然走 `proxy`，响应仍然零改写。

同步任务失败不能影响 AI 请求转发。失败信息只写入本地同步状态、快照表或 UI 提示。

## Core 模块

### config

保存基础配置结构和跨模块共享类型：

- 协议类型。
- 客户端协议类型。
- 上游协议类型。
- 认证方式。
- 路由策略。
- 同步状态。
- 价格来源。
- 能力声明。

### presets

保存内置渠道模板：

- Channel Preset 列表。
- 模板默认字段。
- 模板可见字段和高级字段。
- 模板默认 Capability。

### channel

保存用户渠道和账号配置：

- Channel Account。
- API Key 引用。
- 账号优先级。
- 自定义覆盖项。
- 启用状态。

API Key 字段保留独立类型，方便后续接入系统密钥链或本地加密。

### adapter

封装渠道能力适配器。不同渠道可以有不同实现，但调用方只依赖统一接口。

第一阶段可以先实现 OpenAI-compatible 的测试连接和模型列表查询雏形；随后补充 Anthropic-compatible 的连接测试、模型列表和 Claude Code 接入辅助。价格、余额、额度、用量查询允许先用“不支持”能力声明占位。

### sync

负责异步同步任务：

- 模型列表同步。
- 价格表同步。
- 余额快照查询。
- 额度快照查询。
- 用量快照查询。

同步任务必须独立于主请求链路运行。同步失败时保留已有缓存或快照，不能导致 `/v1/*` 请求失败。

### proxy

负责本地监听和透明转发：

- `/health` 返回本地服务健康状态。
- `/v1/*` 透明转发到 OpenAI-compatible Provider。
- `/v1/messages`、`/v1/models` 透明转发到 Anthropic-compatible Provider / Claude Gateway。
- 普通响应直接透传。
- 流式响应使用上游字节流直接返回，不能缓存完整响应后再返回。
- 旁路生成 metadata 日志事件，日志失败不影响响应。

### storage

SQLite 保存本地配置、日志、用量和同步快照，建议表包括：

- `channel_presets`
- `channel_accounts`
- `channel_models`
- `clients`
- `virtual_models`
- `virtual_model_routes`
- `request_logs`
- `usage_records`
- `model_prices`
- `account_balance_snapshots`
- `provider_quota_snapshots`
- `provider_usage_snapshots`
- `provider_sync_runs`

### analyzer

离线分析任务：

- 优先从 `response.usage` 提取 token。
- 没有 usage 时标记为 `unknown`。
- 根据 `model_prices` 计算成本。
- 支持按日期、Provider、模型、客户端聚合。

价格来源优先级为：用户手动价格 > 渠道同步价格 > 内置模板价格。

## 桌面端 UI

第一阶段 UI 只做管理和状态展示，不承载复杂平台能力：

- 首页展示代理状态。
- 启动 / 停止本地代理。
- Provider 管理。
- 协议入口配置。
- 渠道模板选择。
- API Key 填写。
- 模型选择和模型列表同步。
- 渠道测试连接。
- Client Token 管理。
- Claude Code 接入向导。
- 虚拟模型管理。
- 请求日志。
- 基础用量统计。
- 一键复制 Base URL。
- 一键复制 Client Token。

全部界面文案使用中文。

## 非目标

第一阶段明确不做：

- Anthropic / Gemini / OpenAI 之间协议转换。
- Docker / Web Console。
- 云端账号系统。
- 团队计费系统。
- MCP / Prompt / Skills / Sessions 管理。
- Provider marketplace。
- 复杂智能路由和小模型路由判断。
- 在主请求链路实时查询价格、余额、额度或用量。
