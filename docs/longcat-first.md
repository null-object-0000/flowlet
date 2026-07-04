# Flowlet LongCat-first 需求整理

## 1. 当前阶段产品方向

Flowlet 当前阶段采用 **LongCat + DeepSeek first** 策略。本文聚焦 LongCat 这个首发渠道的需求；DeepSeek 需求见 [DeepSeek 首发渠道需求整理](./deepseek-first.md)。

第一阶段不再优先铺开很多通用渠道，而是先把 LongCat 和 DeepSeek 做深、做完整。LongCat 用来验证这些 Flowlet 核心价值：

- 本地 AI 请求路由
- 多协议透明转发
- 响应零改写
- 多账号管理
- Claude Code 接入
- 请求日志
- Token / 成本分析
- 后续价格、额度、资源包管理

LongCat 适合作为第一阶段重点渠道，因为 LongCat API 同时兼容 OpenAI API 格式和 Anthropic API 格式：

```text
OpenAI-compatible 端点: https://api.longcat.chat/openai
Anthropic-compatible 端点: https://api.longcat.chat/anthropic
当前默认模型: LongCat-2.0
```

相关官方文档：

- [LongCat API 开放平台快速开始](https://longcat.chat/platform/docs/zh/)
- [LongCat API 概述](https://longcat.chat/platform/docs/zh/APIDocs.html)
- [LongCat Claude Code 配置](https://longcat.chat/platform/docs/zh/ClaudeCode.html)

因此，Flowlet 的 LongCat 渠道需求从原来的：

```text
只支持 OpenAI-compatible 透明转发
```

调整为：

```text
首发内置 LongCat，同时支持 LongCat OpenAI-compatible 与 LongCat Anthropic-compatible 两种透明转发入口。
```

---

## 2. 核心产品原则

Flowlet 的核心原则不变：

```text
不做协议转换
响应零改写
请求侧只做必要路由、Header 替换和模型映射
日志旁路记录，不影响主请求链路
Token 和成本分析通过离线任务完成
```

但协议范围需要扩展为：

```text
第一阶段采用 LongCat + DeepSeek first 策略。本文聚焦 LongCat：支持 LongCat 的 OpenAI-compatible 与 Anthropic-compatible 两种协议透明转发入口。
```

重点是：**支持多协议透明转发，不代表做跨协议转换。**

正确链路是：

```text
OpenAI-compatible 客户端
  -> Flowlet OpenAI 入口
  -> LongCat OpenAI-compatible 端点

Anthropic-compatible 客户端 / Claude Code
  -> Flowlet Anthropic 入口
  -> LongCat Anthropic-compatible 端点
```

明确不做：

```text
OpenAI 请求 -> 转 Anthropic 请求
Anthropic 请求 -> 转 OpenAI 请求
Claude Code 请求 -> 转 OpenAI-compatible 请求
```

Flowlet 是多协议入口代理，不是协议转换器。

---

## 3. LongCat 接入范围

### 3.1 OpenAI-compatible 入口

LongCat 支持 OpenAI API 格式，对话补全接口为：

```text
/openai/v1/chat/completions
```

Flowlet 应提供本地 OpenAI-compatible 入口，例如：

```text
http://127.0.0.1:18640/openai/v1/chat/completions
```

或继续兼容当前已有的：

```text
http://127.0.0.1:18640/v1/chat/completions
```

第一版可以先保留现有 `/v1/*` 入口，但需求文档中要明确：这是 OpenAI-compatible 入口。

### 3.2 Anthropic-compatible 入口

LongCat 支持 Anthropic Claude API 格式，消息接口为：

```text
/anthropic/v1/messages
```

Flowlet 应提供本地 Anthropic-compatible 入口，例如：

```text
http://127.0.0.1:18640/anthropic/v1/messages
```

这个入口用于支持 Claude Code、Anthropic SDK、以及其他 Anthropic-compatible 客户端。

---

## 4. Claude Code 支持

Claude Code 是 Flowlet 第一阶段的重要验证场景。

LongCat 官方 Claude Code 配置使用的关键环境变量包括：

```json
{
  "ANTHROPIC_AUTH_TOKEN": "your_longcat_api_key",
  "ANTHROPIC_BASE_URL": "https://api.longcat.chat/anthropic",
  "ANTHROPIC_MODEL": "LongCat-2.0",
  "ANTHROPIC_SMALL_FAST_MODEL": "LongCat-2.0",
  "ANTHROPIC_DEFAULT_SONNET_MODEL": "LongCat-2.0",
  "ANTHROPIC_DEFAULT_OPUS_MODEL": "LongCat-2.0",
  "CLAUDE_CODE_MAX_OUTPUT_TOKENS": "131072",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": 1
}
```

Flowlet 接入 Claude Code 时，用户不应该直接把 LongCat API Key 暴露给 Claude Code，而是让 Claude Code 连接 Flowlet：

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "flowlet-client-token",
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:18640/anthropic",
    "ANTHROPIC_MODEL": "LongCat-2.0",
    "ANTHROPIC_SMALL_FAST_MODEL": "LongCat-2.0",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "LongCat-2.0",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "LongCat-2.0",
    "CLAUDE_CODE_MAX_OUTPUT_TOKENS": "131072",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": 1
  }
}
```

Flowlet 内部再根据 Client Token 识别请求来源，并替换为真实 LongCat 账号的 API Key。

Claude Code 支持需要包含：

```text
Claude Code 接入向导
一键复制 Claude Code settings.json 配置
Anthropic-compatible 本地入口
Client Token 鉴权
上游 LongCat API Key 替换
请求日志记录 client_id、channel_id、account_id
```

---

## 5. 渠道、账号、模型概念

当前版本概念应简化为三层：

```text
渠道 Channel
  ↓
账号 Account
  ↓
模型 Model
```

不要引入 Credential 概念。

### 5.1 渠道 Channel

渠道是服务商模板，例如：

```text
LongCat
OpenAI
DeepSeek
OpenRouter
自定义 OpenAI-compatible
自定义 Anthropic-compatible
```

当前版本第一优先渠道是：

```text
LongCat
```

LongCat 渠道需要定义：

```text
渠道名称
支持协议
OpenAI-compatible Base URL
Anthropic-compatible Base URL
默认模型
模型列表
价格规则
错误识别规则
是否支持 Claude Code
是否支持模型列表查询
是否支持模型详情查询
```

### 5.2 账号 Account

账号是用户在某个渠道下配置的一组访问身份。

当前版本明确：

```text
一个账号 = 一个 API Key
```

一个渠道可以配置多个账号：

```text
LongCat 渠道
  ├─ LongCat 账号 A -> API Key A
  ├─ LongCat 账号 B -> API Key B
  └─ LongCat 账号 C -> API Key C
```

不支持：

```text
一个账号 -> 多个 API Key
```

账号就是路由、统计、余额、失败状态的最小单位。

账号字段建议：

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

其中 `api_key_storage` 第一版可以是：

```text
plaintext
```

后续再扩展：

```text
encrypted
system_keychain
```

### 5.3 模型 Model

模型归属于渠道，不归属于账号。

例如 LongCat 当前模型：

```text
LongCat-2.0
```

多个 LongCat 账号都可以使用同一个模型。

模型信息应包含：

```text
channel_id
model
display_name
supported_protocols
context_window
max_output_tokens
supports_stream
pricing
enabled
```

LongCat-2.0 按当前需求预设为支持 OpenAI / Anthropic 两种 API 格式、上下文长度 1M、最大输出长度 128K Tokens。

---

## 6. 多账号路由

对于 LongCat，路由候选不应该只是模型，而应该是：

```text
Channel + Account + Protocol + Model
```

例如 Claude Code 请求：

```text
LongCat / 账号 A / Anthropic-compatible / LongCat-2.0
LongCat / 账号 B / Anthropic-compatible / LongCat-2.0
LongCat / 账号 C / Anthropic-compatible / LongCat-2.0
```

OpenAI-compatible 请求：

```text
LongCat / 账号 A / OpenAI-compatible / LongCat-2.0
LongCat / 账号 B / OpenAI-compatible / LongCat-2.0
LongCat / 账号 C / OpenAI-compatible / LongCat-2.0
```

第一版路由策略建议只做：

```text
按账号 priority 顺序尝试
账号禁用则跳过
请求失败则尝试下一个账号
```

后续再支持：

```text
余额充足优先
资源包优先
低成本优先
成功率优先
轮询
随机
```

---

## 7. Fallback 规则

Flowlet 第一版 fallback 建议：

### 可以尝试下一个账号

```text
429 Too Many Requests
500 Internal Server Error
502 Bad Gateway
503 Service Unavailable
网络错误
超时
402 Payment Required / 额度不足
403 且错误码为 insufficient_quota
```

### 不建议 fallback

```text
400 Bad Request
401 Unauthorized
参数错误
JSON 格式错误
协议不匹配
上下文超长
```

其中 401 通常说明当前 API Key 无效或缺失；400 通常说明请求参数本身错误。这类问题即使换账号也大概率无法解决，不应该自动切换账号。

---

## 8. 日志与统计

请求日志必须从 Provider 维度升级为 Channel + Account 维度。

每次请求至少记录：

```text
request_id
client_id
channel_id
account_id
client_protocol
upstream_protocol
public_model
upstream_model
method
path
status
latency_ms
is_stream
fallback_count
route_reason
error_message
created_at
```

这样后续才能回答这些问题：

```text
LongCat 账号 A 今天用了多少钱
LongCat 账号 B 失败率是多少
Claude Code 主要打到了哪个 LongCat 账号
auto 路由发生了几次账号降级
哪个账号经常触发 429
哪个账号余额不足
```

---

## 9. Token 与成本分析

LongCat 成本模型至少需要支持：

```text
input_uncached_price
input_cached_price
output_price
currency = CNY
unit = 1M tokens
source = preset / manual / synced
synced_at
```

当前 LongCat-2.0 预设价格：

```text
限时折扣价：
输入未命中缓存：¥2 / 百万 Tokens
输入命中缓存：¥0.04 / 百万 Tokens
输出：¥8 / 百万 Tokens

原价：
输入未命中缓存：¥5 / 百万 Tokens
输入命中缓存：¥0.10 / 百万 Tokens
输出：¥20 / 百万 Tokens
```

成本计算规则：

```text
只有 HTTP 200 成功请求才估算成本
失败请求只记录日志，不计入成本
如果 response.usage 能区分 cache token，则按命中 / 未命中分别计算
如果无法区分 cache token，第一版先按未命中缓存输入估算
用户手动价格优先
同步价格其次
内置 preset 价格兜底
```

---

## 10. 余额与资源包管理

当前不应承诺自动余额查询。第一版需求写成：

```text
LongCat 价格：支持内置预设，后续可从模型详情或官方接口同步。
LongCat 余额：第一版支持用户手动维护余额快照。
LongCat 资源包：第一版支持用户手动登记资源包总量、剩余量、过期时间。
LongCat 账单 / 余额自动同步：如果后续官方开放 API，再接入。
```

余额快照字段建议：

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
```

---

## 11. 模型列表与模型详情

LongCat 模型能力规划：

```text
LongCat 模型列表同步
LongCat 模型详情同步
模型上下文长度同步
模型最大输出长度同步
模型价格同步或预设
```

第一版可以先内置：

```text
LongCat-2.0
```

后续再接入模型列表 / 模型详情自动同步。

---

## 12. UI 需求

### 12.1 LongCat 渠道页

页面结构建议：

```text
LongCat 渠道

基础信息：
- 支持协议：OpenAI-compatible / Anthropic-compatible
- 默认模型：LongCat-2.0
- OpenAI 入口状态
- Anthropic 入口状态

账号列表：
- 账号名称
- API Key
- 启用状态
- 优先级
- 最近使用时间
- 最近错误
- 余额快照
- 资源包快照

操作：
- 新增账号
- 编辑账号
- 启用 / 停用账号
- 测试账号
- 删除账号
```

新增账号只需要：

```text
账号名称
API Key
优先级
是否启用
备注
```

不要出现：

```text
账号下面再新增密钥
一个账号绑定多个 API Key
Key 池
Credential 管理
```

### 12.2 Claude Code 接入页

提供“一键复制配置”能力。

展示内容：

```text
ANTHROPIC_AUTH_TOKEN=flowlet-client-token
ANTHROPIC_BASE_URL=http://127.0.0.1:18640/anthropic
ANTHROPIC_MODEL=LongCat-2.0
ANTHROPIC_SMALL_FAST_MODEL=LongCat-2.0
ANTHROPIC_DEFAULT_SONNET_MODEL=LongCat-2.0
ANTHROPIC_DEFAULT_OPUS_MODEL=LongCat-2.0
CLAUDE_CODE_MAX_OUTPUT_TOKENS=131072
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
```

并解释：

```text
Claude Code 只保存 Flowlet Client Token，不直接保存 LongCat API Key。
LongCat API Key 由 Flowlet 在转发到上游时替换。
```

### 12.3 路由配置页

第一版不做复杂策略，只支持：

```text
按账号优先级顺序路由
失败后尝试下一个账号
禁用账号不参与路由
```

展示：

```text
LongCat Anthropic 路由：
1. 工作账号 / LongCat-2.0
2. 备用账号 / LongCat-2.0

LongCat OpenAI 路由：
1. 工作账号 / LongCat-2.0
2. 备用账号 / LongCat-2.0
```

---

## 13. 数据模型建议

### 13.1 channel_presets

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

LongCat preset 示例：

```text
id: longcat
name: LongCat
vendor: LongCat
supported_protocols: openai-compatible, anthropic-compatible
openai_base_url: https://api.longcat.chat/openai
anthropic_base_url: https://api.longcat.chat/anthropic
default_model: LongCat-2.0
supports_model_list: true
supports_model_detail: true
supports_claude_code: true
```

### 13.2 channel_accounts

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

当前版本不需要 credentials 表。

### 13.3 channel_models

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

### 13.4 model_prices

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

### 13.5 account_balance_snapshots

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

### 13.6 request_logs

```text
id
request_id
client_id
channel_id
account_id
client_protocol
upstream_protocol
public_model
upstream_model
method
path
status
latency_ms
is_stream
error_message
fallback_count
route_reason
created_at
```

### 13.7 usage_records

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

## 14. Roadmap 调整建议

### Milestone 0：需求文档重构

```text
更新 README，明确 LongCat + DeepSeek first
更新 docs/product.md，补充 LongCat + DeepSeek first、多协议透明转发、多账号管理
更新 docs/architecture.md，补充 Channel / Account / Model 架构
更新 docs/roadmap.md，重排里程碑
```

### Milestone 1：LongCat OpenAI-compatible 透明转发

```text
支持 LongCat OpenAI base_url
支持 /openai/v1/chat/completions
保留响应零改写
支持 LongCat API Key 替换
记录 channel_id / account_id
```

### Milestone 2：LongCat Anthropic-compatible 透明转发

```text
支持 /anthropic/v1/messages
支持 Anthropic 请求头透传
支持 Claude Code 请求
不做 Anthropic <-> OpenAI 协议转换
```

### Milestone 3：LongCat 多账号管理

```text
LongCat 下可新增多个账号
一个账号只对应一个 API Key
账号支持启用 / 停用
账号支持优先级
按账号优先级路由
失败后 fallback 到下一个账号
```

### Milestone 4：Claude Code 接入向导

```text
生成 Claude Code settings.json
支持一键复制
Claude Code 使用 Flowlet Client Token
Flowlet 转发时替换 LongCat API Key
```

### Milestone 5：模型与价格

```text
内置 LongCat-2.0
支持模型列表同步
支持模型详情同步
支持 LongCat 价格预设
支持 input_uncached / input_cached / output 三段价格
支持成本估算
```

### Milestone 6：余额与资源包快照

```text
支持账号余额手动登记
支持 Token 资源包手动登记
支持资源包过期时间
支持账号维度余额 / 资源包展示
后续再接入官方查询接口
```

### Milestone 7：多账号成本与稳定性统计

```text
按账号统计请求数
按账号统计 Token
按账号统计成本
按账号统计失败率
按账号统计 fallback 次数
展示最近错误
```

---

## 15. 最终需求口径

Flowlet 当前版本采用 **LongCat + DeepSeek first** 策略。本文是 LongCat 首发渠道需求。

Flowlet 内置 LongCat 渠道模板，支持 LongCat OpenAI-compatible 与 Anthropic-compatible 两种协议透明转发，不做跨协议转换，不改写上游响应。

用户可以在 Flowlet 中配置多个 LongCat 账号。一个渠道可以有多个账号，但一个账号只对应一个 API Key，不支持一个账号绑定多个 API Key。账号是路由、统计、余额、失败状态的最小单位。

Flowlet 支持 Claude Code 通过 Anthropic-compatible 本地入口接入，Claude Code 只配置 Flowlet Client Token，不直接保存 LongCat API Key。Flowlet 在转发到 LongCat 上游时替换为实际账号 API Key。

第一阶段重点支持 LongCat 基础接入、OpenAI-compatible 透明转发、Anthropic-compatible 透明转发、Claude Code 接入、多账号管理、账号级 fallback、请求日志、Token / 成本分析。价格先以内置预设和手动维护为主，余额和资源包先支持手动快照；如果后续 LongCat 官方开放余额、账单、资源包查询 API，再接入自动同步。
