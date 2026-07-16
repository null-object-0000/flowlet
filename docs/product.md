# Flowlet 产品定义

## 1. 产品定位

Flowlet 是一个桌面优先的本地 AI 请求路由客户端。

当前阶段采用 **LongCat + DeepSeek first** 策略：先把 LongCat 和 DeepSeek 的 OpenAI-compatible 与 Anthropic-compatible 两种透明转发入口、多账号管理、Claude Code 接入、请求日志和 Token / 成本分析做完整，再扩展更多渠道。详细阶段需求见 [LongCat-first 需求整理](./longcat-first.md) 和 [DeepSeek 首发渠道需求整理](./deepseek-first.md)。相关官方文档：LongCat [快速开始](https://longcat.chat/platform/docs/zh/)、[API 概述](https://longcat.chat/platform/docs/zh/APIDocs.html)、[Claude Code 配置](https://longcat.chat/platform/docs/zh/ClaudeCode.html)；DeepSeek [API 文档](https://api-docs.deepseek.com/zh-cn/)、[价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)、[Claude Code](https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/claude_code)、[Anthropic API](https://api-docs.deepseek.com/zh-cn/guides/anthropic_api)、[余额查询](https://api-docs.deepseek.com/zh-cn/api/get-user-balance)。

Flowlet 尚未发布第一个可用版本，因此第一版正式实现允许破坏式重构：不做旧 Provider 原型兼容，不做旧 SQLite 表迁移，直接以 Channel / Account / Model 作为正式数据模型。详细策略见 [破坏式重构策略](./breaking-refactor.md)。

它让 Claude Code、Cursor、Cline、Open WebUI、Cherry Studio、Continue 等 AI 工具统一接入一个本地入口，并在不做协议转换、不改写响应内容的前提下，实现开箱即用渠道配置、虚拟模型路由、请求日志和 Token 成本分析。

Flowlet 不是 LiteLLM Desktop、New API Desktop，也不是 Helicone / Portkey 这类服务端 AI Gateway。它的核心定位是：

> 一个本地运行、可视化管理、响应零改写、内置常用渠道模板的 AI 请求路由客户端。

---

## 2. 一句话介绍

Flowlet 是一个本地 AI 请求路由客户端，普通用户选择渠道、填写 API Key、选择模型即可让多个 AI 工具通过一个本地入口访问不同 Provider；高级用户仍可自定义 OpenAI-compatible 或 Anthropic-compatible 渠道。

当前阶段一句话：

> Flowlet LongCat + DeepSeek first：内置 LongCat 和 DeepSeek 渠道模板，支持 OpenAI-compatible 与 Anthropic-compatible 两种协议透明转发，支持 Claude Code 接入和多账号路由。

---

## 3. 核心原则

### 3.1 多协议透明转发，但不做跨协议转换

Flowlet 不负责 OpenAI、Anthropic、Gemini、Codex Responses 等协议之间的互相转换，但应该支持多个客户端协议入口。

正确链路是：

```text
OpenAI-compatible 请求 -> OpenAI-compatible Provider
Anthropic-compatible 请求 -> Anthropic-compatible Provider
Gemini-compatible 请求 -> Gemini-compatible Provider
```

不做：

```text
OpenAI 请求 -> 转 Anthropic
Anthropic 请求 -> 转 Gemini
Gemini 请求 -> 转 OpenAI
```

上游 Provider 必须原生支持客户端正在使用的协议。

第一阶段采用 LongCat + DeepSeek first 策略，同时支持 LongCat / DeepSeek 的 OpenAI-compatible 与 Anthropic-compatible 两种透明转发入口。

---

### 3.2 响应零改写

响应侧是 Flowlet 最重要的边界。

Flowlet 不对上游返回内容做任何业务层面的改写：

```text
不改 status code
不改 response body
不改错误结构
不补 usage
不格式化响应
不做兼容转换
不改流式 SSE chunk 内容
```

Flowlet 只允许旁路复制日志，不参与响应内容处理。

这里的“响应零改写”指的是业务响应不动、响应 body 不动、错误结构不动，不承诺底层 TCP chunk 或 hop-by-hop header 字节级完全一致。

---

### 3.3 请求侧只做轻量处理

请求侧允许做有限处理：

```text
base_url 替换
Authorization Header 替换
X-Api-Key Header 替换
必要 Header 替换
可选 model name 映射
client token 识别
Provider/Profile 路由
```

Flowlet 不改请求体结构，不理解具体协议语义，不为了兼容不同 Provider 重新组织请求内容。

---

### 3.4 日志旁路记录

主请求链路只负责稳定转发，不承担复杂分析。

Flowlet 可以将请求和响应旁路记录到本地日志，用于后续分析：

```text
请求来源
Provider
模型
状态码
耗时
错误信息
请求体
响应体
流式响应内容
```

日志记录失败不能影响真实请求。

---

### 3.5 Token 和成本离线分析

Flowlet 不在主链路中强依赖实时 Token 统计。

Token 和成本分析通过离线任务完成：

```text
优先从 response.usage 中提取 token
如果没有 usage，则使用 tokenizer 估算或标记 unknown
根据模型价格表计算费用
按日期 / 客户端 / Provider / 模型聚合统计
```

分析失败不能影响请求转发。

---

### 3.6 同步能力不进入主请求链路

模型列表、价格、余额、额度、用量查询只能作为异步同步能力或配置辅助能力。

```text
同步失败不能影响 AI 请求转发
余额 / 额度 / 用量只能作为快照展示和路由参考
主请求链路不实时查询余额、额度或价格
```

---

## 4. 目标用户

### 4.1 个人开发者

同时使用多个 AI 工具，希望统一管理 Provider、API Key 和本地接入配置。

典型工具包括：

```text
Claude Code
Cursor
Cline
Open WebUI
Cherry Studio
Continue
Codex
Gemini CLI
```

---

### 4.2 AI Coding 重度用户

希望知道每个 AI 工具实际使用了多少 Token、花了多少钱、哪个 Provider 更稳定、哪个模型更适合当前任务。

---

### 4.3 BYOK 用户

用户自己持有 OpenAI、DeepSeek、OpenRouter、阿里云百炼、火山方舟、硅基流动、Moonshot 等 Provider 的 API Key，希望全部在本地统一管理，不希望 API Key 分散在不同工具里。

---

### 4.4 高级用户 / 小团队

希望后续通过 Docker 部署在 NAS、家用主机、内网服务器上，让多个设备或团队成员共享同一个本地/内网 AI 请求入口。

---

## 5. 核心场景

### 5.1 统一本地入口

用户在 AI 工具中统一配置 Flowlet 的本地地址：

```text
http://127.0.0.1:18640/v1
```

AI 工具不再直接请求各个 Provider，而是先请求 Flowlet。

Flowlet 再根据配置将请求转发给真实上游渠道。

---

### 5.2 渠道模板与用户渠道

Flowlet 不应该要求普通用户手动理解 `base_url`、`auth_type`、`headers_json` 等技术细节。

当前阶段渠道设计分成三层：

```text
渠道模板 Channel Preset
渠道账号 Channel Account
渠道模型 Channel Model
```

Flowlet 内置常用渠道模板，并按协议分组。

OpenAI-compatible 渠道：

```text
OpenAI
DeepSeek
OpenRouter
Moonshot
阿里云百炼
火山方舟
硅基流动
自建 New API
自建 LiteLLM
自定义 OpenAI-compatible
```

Anthropic-compatible 渠道：

```text
Anthropic
Anthropic Gateway
自定义 Anthropic-compatible
Claude Code Gateway / 企业网关
```

只支持 OpenAI-compatible 的渠道不能直接承接 Claude Code 请求。Claude Code 需要 Anthropic-compatible Provider 或 Claude Gateway，除非未来明确新增协议转换模式。

普通用户只需要：

```text
1. 选择渠道
2. 填写 API Key
3. 选择默认模型
4. 测试连接
5. 保存并启用
```

高级用户才需要展开：

```text
1. 自定义 Base URL
2. 自定义 Header
3. 自定义模型名
4. 自定义价格
5. 自定义错误识别规则
```

---

### 5.3 渠道能力 Provider Capability

每个渠道模板都需要声明能力：

```text
是否支持模型列表查询
是否支持价格查询
是否支持余额查询
是否支持额度查询
是否支持用量查询
是否支持流式响应
是否支持 OpenAI-compatible
是否支持 Anthropic-compatible
是否支持 Gemini-compatible
```

核心原则：

```text
价格、余额、额度、用量查询不能进入主请求链路
这些能力只能用于异步同步和配置辅助
同步失败不能影响 AI 请求转发
```

---

### 5.4 价格 / 额度 / 余额同步

模型价格来源分三类：

```text
1. 内置模板 preset
2. 用户手动 manual
3. 渠道同步 synced
```

价格优先级：

```text
用户手动价格 > 渠道同步价格 > 内置模板价格
```

余额、额度、用量查询结果只作为快照保存：

```text
provider_balance_snapshots
provider_quota_snapshots
provider_usage_snapshots
```

不要把余额、额度、用量查询作为每次请求实时判断的强依赖。额度感知路由只能使用缓存数据或快照数据，快照过期时应降级为普通路由策略。

---

### 5.5 Client Token 识别请求来源

Flowlet 可以为不同 AI 工具生成不同 Client Token，例如：

```text
Claude Code
Cursor
Cline
Open WebUI
Cherry Studio
Continue
```

通过 Client Token，Flowlet 可以识别请求来源，并在日志和成本分析中按客户端维度聚合。

Client Token 识别不能只看 `Authorization: Bearer ...`，还要支持 `X-Api-Key: ...`。Claude Code 的 `ANTHROPIC_AUTH_TOKEN` 会以 Bearer Token 形式发送，`ANTHROPIC_API_KEY` 会以 `X-Api-Key` 形式发送，Flowlet 两种方式都应支持。

例如：

```text
Claude Code 今天用了多少 Token
Cursor 本周花了多少钱
Cline 哪些请求失败最多
Open WebUI 主要使用了哪些模型
```

---

### 5.6 Claude Code 接入

Claude Code 主要使用 Anthropic API / Claude Code Gateway 接入方式。Flowlet 要支持 Claude Code，必须提供 Anthropic-compatible 本地入口。

推荐用户配置：

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:18640"
export ANTHROPIC_AUTH_TOKEN="flowlet-client-token"
```

如果用户使用 API Key 形式：

```bash
export ANTHROPIC_API_KEY="flowlet-client-token"
```

Flowlet 需要把 Anthropic-compatible 请求透明转发到 Anthropic-compatible Provider 或 Claude Gateway，并保持响应零改写。

---

### 5.7 虚拟模型

Flowlet 支持对外暴露虚拟模型，例如：

```text
auto
cheap-auto
coding-auto
fast-auto
long-context-auto
reasoning-auto
```

客户端请求时可以使用：

```json
{
  "model": "auto",
  "messages": []
}
```

Flowlet 在请求侧将虚拟模型映射到实际 Provider 和真实模型，例如：

```text
auto -> 阿里云百炼 qwen-plus
auto -> DeepSeek deepseek-chat
auto -> OpenRouter 某个备用模型
```

响应返回时，Flowlet 不会把上游响应中的模型名改回 `auto`，而是保持上游原始响应。

---

### 5.8 免费额度优先和失败降级

Flowlet 可以将多个 Provider / Model 配置为一个虚拟模型的候选路线。

例如：

```text
free-auto
  1. 阿里云百炼某个免费额度模型
  2. 火山方舟某个免费额度模型
  3. DeepSeek 低价模型
  4. OpenRouter 备用模型
```

当上游返回以下情况时，可以尝试降级：

```text
429 rate limit
quota exceeded
insufficient quota
account_deactivated / api key is disabled
5xx
timeout
network error
当前模型不可用
```

不建议自动降级的情况：

```text
400 bad request
请求参数错误
上下文超长
工具调用格式不支持
协议不匹配
```

检测到账号凭据已停用时，Flowlet 会将当前账号标记为临时不可用，并在仍有候选路由时
立即降级。`account_deactivated` 属于可恢复状态，后续请求会继续探测该账号；上游重新
启用相同 Key 后，首次成功请求自动恢复账号并清除错误。

---

### 5.9 请求日志查看

Flowlet 提供请求日志列表，用户可以查看：

```text
请求时间
客户端来源
Provider
虚拟模型
实际模型
请求路径
状态码
耗时
是否流式
错误信息
降级次数
路由原因
```

完整请求体和响应体需要用户主动开启。

---

### 5.10 Token / 成本分析

Flowlet 基于请求日志离线分析 Token 和成本。

分析维度包括：

```text
按日期
按客户端
按 Provider
按模型
按虚拟模型
按请求状态
```

典型问题：

```text
今天总共花了多少钱
Claude Code 花了多少钱
auto 实际路由到了哪些模型
哪个 Provider 最便宜
哪个模型失败率最高
哪个客户端请求最多
```

---

### 5.11 OpenCode 会话观测

Flowlet 从 OpenCode 请求携带的稳定会话 Header 中提取会话与父会话 ID，并基于请求日志
聚合会话的客户端、请求数、成功/失败数、Token、预估费用和最近活动时间，并支持按客户端筛选。
由于一个会话允许切换模型，模型不作为会话列表属性展示。第一版不复制
OpenCode 的完整会话数据，也不建立独立会话表；点击会话后复用请求日志筛选和详情查看。

完整 Header 或 Body 捕获关闭时，会话标识仍会被结构化提取。清理请求日志会同时移除对应
的会话观测结果。

对于功能上线前已经存在的请求，设置页提供带进度的数据修复：先从已捕获请求头回填
OpenCode 会话归因，再重解析响应用量、补齐未知用量记录并重算费用。未保存请求头或响应体
的历史内容无法反向恢复。用户可以选择最近 1 小时、最近 6 小时、今天、最近 7 天或全部时间；
所选范围内已解析过的响应也会重新解析并覆盖现有用量。该操作复用请求日志和用量表，
不建立独立会话表，也无需重启代理。

### 5.12 Claude Code 会话观测

Claude Code 2.1.86 及以上版本通过官方 `x-claude-code-session-id` 请求 Header 暴露稳定会话 ID。
Flowlet 在代理入口结构化提取该字段，与 OpenCode 共用会话列表、客户端筛选、请求统计、Token、
费用和失败聚合。Claude Code 恢复会话时沿用原 ID，因此恢复前后的请求会归入同一会话。
功能上线前已捕获请求头的历史日志可通过设置页数据修复回填；未捕获请求头的数据无法恢复。

---

## 6. 产品形态

### 6.1 主形态：Desktop App

Flowlet 的主产品形态是桌面客户端。

支持目标：

```text
Windows
macOS
Linux
```

桌面端能力包括：

```text
可视化配置
系统托盘
开机自启
自动启动本地代理，并按运行状态提供启动 / 重启操作；暂停入口仅放在高级设置
渠道模板选择
渠道账号管理
Client Token 管理
虚拟模型管理
请求日志查看
用量和成本看板
设置页本地数据修复与阶段进度
一键复制接入配置
```

---

### 6.2 补充形态：Docker / Web Console

后续支持 Docker / Web Console 形态。

适合：

```text
NAS
家庭服务器
内网服务器
小团队共享代理
多设备统一配置
```

Docker / Web 不是第一阶段主形态，而是高级部署形态。

---

## 7. 技术架构

Flowlet 可以拆成三层：

```text
AI Reverse Proxy Core
  - 本地代理
  - OpenAI-compatible Gateway
  - Anthropic-compatible Gateway
  - Channel Preset
  - Channel Account
  - ChannelAdapter
  - 模型 / 价格 / 额度异步同步
  - Client Token 管理
  - 请求转发
  - Header 替换
  - 虚拟模型路由
  - 日志落盘
  - 离线分析
  - 管理 API

Desktop Client
  - Tauri 可视化客户端
  - 系统托盘
  - 开机自启
  - 管理 Core 生命周期
  - 调用 Core 管理 API

Web Console
  - 复用 Desktop 前端
  - Docker 模式浏览器访问
  - 调用 Core 管理 API
```

---

## 8. Desktop 模式架构

```text
Tauri Desktop App
  ├─ UI
  ├─ 系统托盘
  ├─ 开机自启
  ├─ 启停 Core
  └─ Core 内置 / sidecar
        ├─ 127.0.0.1:18640 代理端口
        └─ 127.0.0.1:11435 管理 API
```

请求链路：

```text
Cursor / Cline / Open WebUI
        ↓
http://127.0.0.1:18640/v1/*
        ↓
Flowlet Local Proxy
        ↓
OpenAI-compatible Provider

Claude Code
        ↓
ANTHROPIC_BASE_URL=http://127.0.0.1:18640
        ↓
Flowlet Local Proxy
        ↓
Anthropic-compatible Provider / Claude Gateway
```

---

## 9. Docker 模式架构

```text
Docker Container
  ├─ Reverse Proxy Core
  │   ├─ 0.0.0.0:18640
  │   └─ 0.0.0.0:11435
  ├─ Web Console
  │   └─ 0.0.0.0:3000
  └─ SQLite / Logs Volume
```

Docker 模式要求：

```text
Core 可以 headless 运行
配置和日志通过 volume 持久化
Web Console 通过管理 API 控制 Core
支持 docker-compose
支持基础访问鉴权
```

---

## 10. MVP 范围

第一阶段只做最核心能力：

```text
1. 桌面客户端
2. 本地代理端口 127.0.0.1:18640
3. LongCat Channel Preset
4. LongCat Account 管理
5. Client Token 配置
6. LongCat OpenAI-compatible 请求透明转发
7. 请求侧 base_url / header rewrite
8. 响应零改写
9. LongCat Anthropic-compatible 请求透明转发
10. Claude Code 接入向导设计预留
11. 普通响应透明转发
12. 流式响应透明转发
13. 按账号优先级顺序路由
14. 账号级 fallback
15. 原始请求/响应日志落盘
16. 基础 Token / 成本离线分析
17. 日志列表
18. 基础用量统计看板
19. 一键复制 Base URL
20. 一键复制 Client Token
21. 渠道测试连接雏形
```

---

## 11. 第一阶段不做什么

为了控制复杂度，第一阶段明确不做：

```text
不做协议转换
不做 OpenAI <-> Anthropic <-> Gemini 互转
不做响应改写
不做错误包装
不补 usage 字段
不做实时 Token 精准统计
不做复杂智能路由
不做小模型路由判断
不做 Provider marketplace
不做云端多租户后台
不做团队计费系统
不做 MCP 管理
不做 Prompt 管理
不做 Skills 管理
不在主请求链路实时查询余额 / 额度 / 用量
```

---

## 12. 日志策略

### 12.1 Metadata 模式

默认开启，只记录：

```text
request_id
client_id
channel_id
account_id
client_protocol
upstream_protocol
virtual_model
upstream_model
method
path
upstream_url
status
latency_ms
ttfb_ms
ttft_ms
duration_ms
is_stream
created_at
error_message
fallback_count
route_reason
```

---

### 12.2 安全日志模式

记录请求/响应摘要；是否脱敏由 `log_capture.redact_sensitive_headers` 决定：

```text
prompt 摘要
response 摘要
usage 信息
cost 信息
错误摘要
```

---

### 12.3 完整日志模式

用户主动开启后，记录完整内容：

请求侧内容以每次路由 attempt 实际执行的第三方请求为准：URL、鉴权 Header 和
`model` 已完成账号及路由改写；响应侧保存同一次第三方调用返回的原始响应。
因此 fallback 链路中的每个 attempt 都有各自对应的请求和响应报文，而不是共用
客户端发给 Flowlet 的入站请求。

```text
request headers
request body
response headers
response body
stream chunks
```

完整日志支持：

```text
可配置的敏感 Header 捕获层脱敏
最大单条日志大小
日志保留天数
自动清理
按 client 开关
按 provider 开关
```

---

## 13. 流式响应策略

流式响应遵循：

```text
不解析
不改写
不格式化
不重组
不缓存后再返回
```

正确方式：

```text
上游 chunk 到达
  ├─ 立即转发给客户端
  └─ 旁路复制到日志 buffer
```

日志失败不能影响 stream 主链路。

---

## 14. 路由策略

### 14.1 第一阶段：顺序路由

虚拟模型按配置顺序选择候选模型：

```text
auto
  1. Provider A / Model A
  2. Provider B / Model B
  3. Provider C / Model C
```

失败后按顺序尝试下一个候选。

---

### 14.2 第二阶段：成本优先

优先使用：

```text
免费额度模型
低价模型
剩余额度充足的模型
```

---

### 14.3 第三阶段：规则路由

根据请求特征进行路由：

```text
prompt 长度
是否包含代码
是否要求 JSON
是否是翻译
是否是总结
是否是复杂推理
是否需要长上下文
```

---

### 14.4 第四阶段：小模型智能路由

未来可以启动一个小模型，专门判断当前请求应该走哪个模型更合适。

小模型不回答用户问题，只输出路由决策：

```json
{
  "task_type": "coding",
  "complexity": "medium",
  "priority": "cost",
  "suggested_route": "coding-cheap",
  "confidence": 0.82
}
```

Flowlet 再根据路由结果选择具体 Provider 和 Model。

---

## 15. 数据模型建议

当前阶段采用 Channel / Account / Model 三层结构，详细字段见 [LongCat-first 需求整理](./longcat-first.md)。

### 15.1 channel_presets

```text
id
name
vendor
supported_protocols
openai_base_url
anthropic_base_url
default_model
supports_model_list
supports_model_detail
supports_price_sync
supports_balance_query
supports_quota_query
supports_claude_code
notes
created_at
updated_at
```

---

### 15.2 channel_accounts

```text
id
channel_id
name
api_key
api_key_storage
enabled
priority
remark
last_used_at
last_error
created_at
updated_at
```

当前版本不需要 credentials 表，一个账号只对应一个 API Key。

---

### 15.3 channel_models

```text
id
channel_id
model
display_name
supported_protocols
context_window
max_output_tokens
supports_stream
enabled
source
synced_at
created_at
updated_at
```

---

### 15.4 clients

```text
id
name
token
app_type
enabled
created_at
updated_at
```

---

### 15.5 virtual_models

```text
id
name
protocol_type
routing_strategy
enabled
created_at
updated_at
```

---

### 15.6 virtual_model_routes

```text
id
virtual_model_id
channel_id
account_id
client_protocol
upstream_protocol
upstream_model
priority
cost_weight
latency_weight
quality_weight
free_quota_first
enabled
created_at
updated_at
```

---

### 15.7 request_logs

```text
id
request_id
client_id
channel_id
account_id
client_protocol
upstream_protocol
virtual_model
public_model
upstream_model
method
path
status
latency_ms
is_stream
request_body_path
response_body_path
error_message
fallback_count
route_reason
created_at
```

---

### 15.8 usage_records

```text
id
request_id
client_id
channel_id
account_id
client_protocol
upstream_protocol
model
input_tokens
input_cached_tokens
input_uncached_tokens
output_tokens
total_tokens
estimated_cost
currency
analyzed_at
```

---

### 15.9 model_prices

```text
id
channel_id
model
input_uncached_price
input_cached_price
output_price
currency
unit
source
synced_at
created_at
updated_at
```

`source` 可取值：

```text
preset
synced
manual
```

---

### 15.10 account_balance_snapshots

```text
id
account_id
balance
currency
token_pack_total
token_pack_used
token_pack_remaining
token_pack_expire_at
source
synced_at
remark
created_at
updated_at
```

---

## 16. 和其他项目的区别

### 16.1 和 LiteLLM / New API 的区别

LiteLLM / New API 更偏：

```text
协议适配
统一 Gateway
Provider 转换
复杂路由
服务端平台
```

Flowlet 更偏：

```text
本地透明代理
响应零改写
不做协议转换
桌面客户端
内置渠道模板
本地日志和成本分析
```

---

### 16.2 和 Helicone / Portkey 的区别

Helicone / Portkey 更偏：

```text
云 / 服务端 AI Gateway
Observability 平台
企业级日志与监控
```

Flowlet 更偏：

```text
本地桌面客户端
AI 请求路由
Provider 管理
个人和小团队本地使用
```

---

### 16.3 和 CC Switch 的区别

CC Switch 更像：

```text
AI Coding Tool Switcher
```

重点是切换 Claude Code、Codex、Gemini CLI 等工具配置。

Flowlet 更像：

```text
Local AI Request Router
```

重点是让所有 AI 工具统一走一个本地请求入口，并提供路由、日志和成本分析。

---

## 17. 产品价值

### 17.1 对用户

```text
不用每个 AI 工具重复配置 Provider
不用把 API Key 分散放在不同工具里
不用维护常见渠道的 base_url
可以本地统一管理所有请求
可以知道每个工具用了多少钱
可以快速切换不同 Provider
可以用 auto 模型自动选择候选模型
可以优先使用免费额度和低价模型
可以保留原始响应，不担心代理改坏协议
```

---

### 17.2 对产品

```text
复杂度可控
不陷入协议转换深坑
桌面端差异化明显
可以逐步扩展 Docker / Web
可以后续再补 key pool、智能路由、团队模式
```

---

## 18. 阶段路线

### 阶段一：Desktop MVP 稳定化

```text
Tauri Desktop
本地透明代理
Provider/Profile 基础雏形
Client Token
OpenAI-compatible 透明转发
响应零改写
虚拟模型 auto
顺序降级
请求/响应日志
离线 Token / Cost
基础 Dashboard
```

---

### 阶段二：开箱即用渠道模板

```text
Channel Preset
Channel Account
Channel Model
渠道选择
API Key 填写
默认模型选择
测试连接
高级自定义渠道
```

---

### 阶段三：Anthropic-compatible 与 Claude Code 支持

```text
Anthropic-compatible Gateway
/v1/messages 透明转发
/v1/models 透明转发
Anthropic-compatible Channel Preset
Claude Code 接入向导
Authorization Bearer / X-Api-Key 双识别
不做 OpenAI <-> Anthropic 协议转换
```

---

### 阶段四：渠道能力与同步框架

```text
Channel Capability
ChannelAdapter
client_protocol / upstream_protocol
模型列表同步
价格同步
余额快照
额度快照
用量快照
同步失败不影响代理
```

---

### 阶段五：价格与成本分析产品化

```text
manual / synced / preset 价格来源
成本统计页优化
按 client / provider / model / day 聚合统计
价格过期提示
unknown token 重算
```

---

### 阶段六：额度感知 auto 路由

```text
剩余额度展示
免费额度优先
低价优先
缓存数据兜底
快照过期时降级为顺序路由
```

---

### 阶段七：Docker / Web Console

```text
Core headless
Web Console
Docker Compose
Volume 持久化
基础鉴权
内网访问
```

---

## 19. 最终产品定义

Flowlet 是一个 Desktop-first、本地优先、响应零改写、支持多协议透明转发但不做跨协议转换、内置常用渠道模板的 AI 请求路由客户端。

它通过可视化客户端帮助用户统一管理多个 AI 工具的本地接入、渠道模板、用户渠道、虚拟模型、请求日志和用量成本。

代理层只做必要的请求路由和认证替换，响应完全透明透传，日志、同步和成本分析通过旁路记录与离线任务完成。

未来 Flowlet 可以扩展 Docker / Web Console 形态，支持高级用户和小团队在内网环境中部署使用。
