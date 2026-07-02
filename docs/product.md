# Flowlet 产品定义

## 1. 产品定位

Flowlet 是一个桌面优先的本地 AI 请求路由客户端。

它让 Claude Code、Cursor、Cline、Open WebUI、Cherry Studio、Continue 等 AI 工具统一接入一个本地入口，并在不做协议转换、不改写响应内容的前提下，实现 Provider 管理、虚拟模型路由、请求日志和 Token 成本分析。

Flowlet 不是 LiteLLM Desktop、New API Desktop，也不是 Helicone / Portkey 这类服务端 AI Gateway。它的核心定位是：

> 一个本地运行、可视化管理、响应零改写的 AI 请求路由客户端。

---

## 2. 一句话介绍

Flowlet 是一个本地 AI 请求路由客户端，让多个 AI 工具通过一个本地入口访问不同 Provider，并提供虚拟模型、请求日志和成本分析能力。

---

## 3. 核心原则

### 3.1 不做协议转换

Flowlet 不负责 OpenAI、Anthropic、Gemini、Codex Responses 等协议之间的互相转换。

正确链路是：

```text
OpenAI-compatible 请求 → OpenAI-compatible Provider
Anthropic-compatible 请求 → Anthropic-compatible Provider
Gemini-compatible 请求 → Gemini-compatible Provider
````

不做：

```text
OpenAI 请求 → 转 Anthropic
Anthropic 请求 → 转 Gemini
Gemini 请求 → 转 OpenAI
```

上游 Provider 必须原生支持客户端正在使用的协议。

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
如果没有 usage，则使用 tokenizer 估算
根据模型价格表计算费用
按日期 / 客户端 / Provider / 模型聚合统计
```

分析失败不能影响请求转发。

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
http://127.0.0.1:11434/v1
```

AI 工具不再直接请求各个 Provider，而是先请求 Flowlet。

Flowlet 再根据配置将请求转发给真实上游 Provider。

---

### 5.2 可视化管理 Provider

用户可以在 Flowlet 中配置多个 Provider，例如：

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
```

Provider 配置包括：

```text
名称
协议类型
base_url
认证方式
API Key
默认模型
是否启用
```

---

### 5.3 Client Token 识别请求来源

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

例如：

```text
Claude Code 今天用了多少 Token
Cursor 本周花了多少钱
Cline 哪些请求失败最多
Open WebUI 主要使用了哪些模型
```

---

### 5.4 虚拟模型

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
auto → 阿里云百炼 qwen-plus
auto → DeepSeek deepseek-chat
auto → OpenRouter 某个备用模型
```

响应返回时，Flowlet 不会把上游响应中的模型名改回 `auto`，而是保持上游原始响应。

---

### 5.5 免费额度优先和失败降级

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

---

### 5.6 请求日志查看

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

### 5.7 Token / 成本分析

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
一键启动 / 停止本地代理
Provider 管理
Client Token 管理
虚拟模型管理
请求日志查看
用量和成本看板
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
  - Provider/Profile 管理
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
        ├─ 127.0.0.1:11434 代理端口
        └─ 127.0.0.1:11435 管理 API
```

请求链路：

```text
Claude Code / Cursor / Cline / Open WebUI
        ↓
http://127.0.0.1:11434/v1/*
        ↓
Flowlet Local Proxy
        ↓
OpenAI-compatible Provider / Anthropic-compatible Provider / Gemini-compatible Provider
```

---

## 9. Docker 模式架构

```text
Docker Container
  ├─ Reverse Proxy Core
  │   ├─ 0.0.0.0:11434
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
2. 本地代理端口 127.0.0.1:11434
3. Provider/Profile 配置
4. Client Token 配置
5. OpenAI-compatible 请求透明转发
6. 请求侧 base_url / header rewrite
7. 响应零改写
8. 普通响应透明转发
9. 流式响应透明转发
10. 虚拟模型 auto
11. 顺序降级
12. 原始请求/响应日志落盘
13. 基础 Token / 成本离线分析
14. 日志列表
15. 基础用量统计看板
16. 一键复制 Base URL
17. 一键复制 Client Token
```

---

## 11. 第一阶段不做什么

为了控制复杂度，第一阶段明确不做：

```text
不做协议转换
不做 OpenAI ↔ Anthropic ↔ Gemini 互转
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
不做 Sessions 管理
```

---

## 12. 日志策略

### 12.1 Metadata 模式

默认开启，只记录：

```text
request_id
client_id
provider_id
virtual_model
upstream_model
method
path
status
latency_ms
is_stream
created_at
error_message
fallback_count
route_reason
```

---

### 12.2 安全日志模式

记录部分脱敏后的请求/响应摘要：

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

```text
request headers
request body
response headers
response body
stream chunks
```

完整日志必须支持：

```text
敏感 Header 脱敏
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

### 15.1 clients

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

### 15.2 providers

```text
id
name
protocol_type
base_url
auth_type
api_key
enabled
created_at
updated_at
```

---

### 15.3 provider_profiles

```text
id
name
provider_id
headers_json
default_model
enabled
created_at
updated_at
```

---

### 15.4 virtual_models

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

### 15.5 virtual_model_routes

```text
id
virtual_model_id
provider_id
profile_id
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

### 15.6 request_logs

```text
id
request_id
client_id
provider_id
profile_id
virtual_model
upstream_model
protocol_type
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

### 15.7 usage_records

```text
id
request_id
client_id
provider_id
virtual_model
upstream_model
input_tokens
output_tokens
total_tokens
estimated_cost
analyzed_at
```

---

### 15.8 model_prices

```text
id
provider_id
model
input_price
output_price
currency
unit
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

### 阶段一：Desktop MVP

```text
Tauri Desktop
本地透明代理
Provider/Profile
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

### 阶段二：路由增强

```text
多虚拟模型
免费额度优先策略
模型价格表
日志搜索
按 client / provider / model / day 聚合统计
日志清理策略
导入 / 导出配置
```

---

### 阶段三：Docker / Web Console

```text
Core headless
Web Console
Docker Compose
Volume 持久化
基础鉴权
内网访问
```

---

### 阶段四：智能路由

```text
规则路由
请求类型识别
小模型路由判断
成本 / 延迟 / 成功率综合调度
用户反馈闭环
```

---

## 19. 最终产品定义

Flowlet 是一个 Desktop-first、本地优先、响应零改写、不做协议转换的 AI 请求路由客户端。

它通过可视化客户端帮助用户统一管理多个 AI 工具的本地接入、Provider 配置、虚拟模型、请求日志和用量成本。

代理层只做必要的请求路由和认证替换，响应完全透明透传，日志和成本分析通过旁路记录与离线任务完成。

未来 Flowlet 可以扩展 Docker / Web Console 形态，支持高级用户和小团队在内网环境中部署使用。
