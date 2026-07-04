# Flowlet DeepSeek 首发渠道需求整理

## 1. 当前阶段定位

DeepSeek 适合作为 Flowlet 第一版内置支持渠道。它和 LongCat 一样，可以验证 Flowlet 的核心边界：

- 多协议透明转发
- Claude Code 接入
- 多账号管理
- 价格 / 余额 / 限速 / 错误码能力
- 请求日志和成本统计

Flowlet 第一版内置首发渠道：

```text
P0 内置渠道：
- LongCat
- DeepSeek

后续再扩展：
- OpenAI
- OpenRouter
- Moonshot
- 阿里云百炼
- 火山方舟
- 硅基流动
- 自定义 OpenAI-compatible
- 自定义 Anthropic-compatible
```

相关 DeepSeek 官方文档：

- [DeepSeek API 文档](https://api-docs.deepseek.com/zh-cn/)
- [模型 & 价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)
- [Token 用量计算](https://api-docs.deepseek.com/zh-cn/quick_start/token_usage)
- [限速与隔离](https://api-docs.deepseek.com/zh-cn/quick_start/rate_limit)
- [错误码](https://api-docs.deepseek.com/zh-cn/quick_start/error_codes)
- [接入 Claude Code](https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/claude_code)
- [Anthropic API](https://api-docs.deepseek.com/zh-cn/guides/anthropic_api)
- [API 基本信息](https://api-docs.deepseek.com/zh-cn/api/deepseek-api)
- [创建对话补全](https://api-docs.deepseek.com/zh-cn/api/create-chat-completion)
- [创建文本补全](https://api-docs.deepseek.com/zh-cn/api/create-completion)
- [列出模型](https://api-docs.deepseek.com/zh-cn/api/list-models)
- [查询余额](https://api-docs.deepseek.com/zh-cn/api/get-user-balance)

---

## 2. 渠道能力

DeepSeek 官方文档明确兼容 OpenAI / Anthropic API 格式：

```text
OpenAI-compatible base_url: https://api.deepseek.com
Anthropic-compatible base_url: https://api.deepseek.com/anthropic
```

当前文档列出的模型包括：

```text
deepseek-v4-flash
deepseek-v4-pro
```

`deepseek-chat` 和 `deepseek-reasoner` 将于北京时间 2026-07-24 23:59 弃用。出于兼容考虑，它们分别对应 `deepseek-v4-flash` 的非思考与思考模式。

DeepSeek 渠道第一版支持：

```text
OpenAI-compatible 对话补全透明转发
Anthropic-compatible 消息接口透明转发
Claude Code 接入配置生成
模型列表同步
余额查询
价格预设
Token usage 提取
账号级请求日志
账号级成本统计
账号级 fallback
```

---

## 3. 协议边界

DeepSeek 支持 OpenAI-compatible 和 Anthropic-compatible 两种协议入口，但 Flowlet 仍然不做跨协议转换。

正确链路：

```text
OpenAI-compatible 请求
  -> Flowlet OpenAI-compatible 入口
  -> DeepSeek OpenAI-compatible 上游

Anthropic-compatible 请求 / Claude Code
  -> Flowlet Anthropic-compatible 入口
  -> DeepSeek Anthropic-compatible 上游
```

明确不做：

```text
OpenAI 请求 -> 转 Anthropic 请求
Anthropic 请求 -> 转 OpenAI 请求
Claude Code 请求 -> 转 OpenAI-compatible 请求
```

DeepSeek Anthropic API 文档说明，如果传入不支持的模型名，DeepSeek 后端会自动映射到默认模型；Claude 模型名前缀也会映射到 DeepSeek 模型。Flowlet 不应该依赖这种模型名映射作为自己的协议转换能力。

Flowlet 可以记录：

```text
public_model = claude-sonnet-xxx
upstream_protocol = anthropic-compatible
channel_id = deepseek
```

但不应该自己把它改成 `deepseek-v4-flash`，除非用户明确在 Flowlet 路由规则里配置了模型映射。

---

## 4. Claude Code 接入

DeepSeek 官方 Claude Code 接入使用：

```bash
export ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
export ANTHROPIC_AUTH_TOKEN=<DeepSeek API Key>
export ANTHROPIC_MODEL=deepseek-v4-pro[1m]
export ANTHROPIC_DEFAULT_OPUS_MODEL=deepseek-v4-pro[1m]
export ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek-v4-pro[1m]
export ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-v4-flash
export CLAUDE_CODE_SUBAGENT_MODEL=deepseek-v4-flash
export CLAUDE_CODE_EFFORT_LEVEL=max
```

Flowlet 接入时，Claude Code 不直接保存 DeepSeek API Key，而是保存 Flowlet Client Token：

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:18640/anthropic
export ANTHROPIC_AUTH_TOKEN=flowlet-client-token
export ANTHROPIC_MODEL=deepseek-v4-pro[1m]
export ANTHROPIC_DEFAULT_OPUS_MODEL=deepseek-v4-pro[1m]
export ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek-v4-pro[1m]
export ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-v4-flash
export CLAUDE_CODE_SUBAGENT_MODEL=deepseek-v4-flash
export CLAUDE_CODE_EFFORT_LEVEL=max
```

Flowlet 内部根据 Client Token 识别请求来源，并转发到 DeepSeek 上游时替换为实际账号 API Key。

---

## 5. 多账号管理

Flowlet 的统一产品概念保持不变：

```text
一个渠道可以有多个账号
一个账号只对应一个 API Key
```

但 DeepSeek 文档明确并发限制以厂商账号粒度计算，与 API Key 无关。因此产品文档必须说明：

```text
Flowlet 里的“账号”是用户配置的一条渠道访问身份，一条账号配置固定对应一个 API Key。
它不强行等同于厂商后台的登录账号。
如果用户把同一个 DeepSeek 平台账号下的多个 API Key 配成多个 Flowlet 账号，DeepSeek 官方侧的并发限制仍可能共享。
```

DeepSeek 当前并发限制：

```text
deepseek-v4-pro: 500
deepseek-v4-flash: 2500
```

超过并发限制会收到 HTTP 429。

---

## 6. 模型列表与余额查询

DeepSeek 文档提供模型列表接口：

```text
GET /models
```

DeepSeek 文档提供余额查询接口：

```text
GET /user/balance
```

余额返回字段包括：

```text
is_available
balance_infos
currency
total_balance
granted_balance
topped_up_balance
```

因此 DeepSeek 第一版可以做真实余额查询，不只是手动快照。

---

## 7. 价格模型

DeepSeek 的价格区分三段：

```text
输入缓存命中
输入缓存未命中
输出
```

当前价格预设：

```text
deepseek-v4-flash:
- 输入缓存命中：0.02 元 / 百万 tokens
- 输入缓存未命中：1 元 / 百万 tokens
- 输出：2 元 / 百万 tokens

deepseek-v4-pro:
- 输入缓存命中：0.025 元 / 百万 tokens
- 输入缓存未命中：3 元 / 百万 tokens
- 输出：6 元 / 百万 tokens
```

Flowlet 价格字段继续使用：

```text
input_uncached_price
input_cached_price
output_price
currency
unit
source
synced_at
```

价格来源：

```text
preset
manual
synced
```

价格可能发生变动，因此用户手动价格优先，同步价格其次，内置 preset 兜底。

---

## 8. Fallback 规则

DeepSeek 错误码文档给出的常见错误包括 400、401、402、422、429、500、503。

可以 fallback 到下一个账号：

```text
402 余额不足
429 请求速率达到上限
500 服务器故障
503 服务器繁忙
网络错误
超时
```

不建议自动 fallback：

```text
400 请求体格式错误
401 API Key 错误
422 参数错误
```

401 表示当前账号 API Key 错误。第一版不自动 fallback 401，而是记录账号错误并提示用户检查 API Key。

---

## 9. 数据模型补充

DeepSeek 复用 Channel / Account / Model 三层结构。

Channel Preset 示例：

```text
id: deepseek
name: DeepSeek
vendor: DeepSeek
supported_protocols: openai-compatible, anthropic-compatible
openai_base_url: https://api.deepseek.com
anthropic_base_url: https://api.deepseek.com/anthropic
default_model: deepseek-v4-pro
supports_model_list: true
supports_model_detail: true
supports_price_sync: false
supports_balance_query: true
supports_claude_code: true
```

账号余额快照需要兼容 DeepSeek 返回：

```text
id
account_id
is_available
currency
total_balance
granted_balance
topped_up_balance
source
synced_at
raw_json
created_at
updated_at
```

---

## 10. Roadmap 补充

DeepSeek 应进入 P0/P1 首发内置渠道：

```text
Milestone：DeepSeek Channel Preset
- 内置 DeepSeek 渠道
- OpenAI-compatible base_url
- Anthropic-compatible base_url
- 默认模型 deepseek-v4-pro / deepseek-v4-flash

Milestone：DeepSeek 多协议透明转发
- OpenAI-compatible 对话补全透明转发
- Anthropic-compatible 消息接口透明转发
- 不做 OpenAI <-> Anthropic 协议转换

Milestone：DeepSeek Claude Code 向导
- 生成 Claude Code 环境变量
- Claude Code 使用 Flowlet Client Token
- Flowlet 转发时替换 DeepSeek API Key

Milestone：DeepSeek 模型 / 价格 / 余额
- 模型列表同步
- 余额查询
- 三段价格预设
- Token usage 成本估算

Milestone：DeepSeek 账号级 fallback
- 402 / 429 / 500 / 503 fallback
- 400 / 401 / 422 不自动 fallback
- 记录账号最近错误
```

---

## 11. 最终需求口径

Flowlet 第一版采用 **LongCat + DeepSeek first** 策略。

LongCat 重点验证 LongCat API、Claude Code、OpenAI/Anthropic 双协议、多账号、价格与资源包快照。

DeepSeek 重点验证 OpenAI/Anthropic 双协议、Claude Code、模型列表、余额查询、价格预设、账号级 fallback。

两个渠道一起做，可以把 Flowlet 的核心能力跑通：双协议、多账号、成本、余额、Claude Code 接入。
