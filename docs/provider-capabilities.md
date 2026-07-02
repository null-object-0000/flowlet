# Provider Capabilities

> 当前 LongCat + DeepSeek first 阶段优先使用 Channel / Account / Model 术语，详见 `docs/longcat-first.md` 和 `docs/deepseek-first.md`。本文保留为后续多渠道能力泛化设计参考；其中 Provider Capability 可理解为 Channel Capability，ProviderAdapter 可理解为 ChannelAdapter。

## 1. 目标

Provider Capability 用来描述每个渠道支持哪些辅助能力，让 Flowlet 能够逐步支持模型列表、价格、余额、额度和用量同步。

这些能力只能用于异步同步、配置辅助和路由参考，不能进入主请求链路。

## 2. 能力字段

建议每个 Provider Preset 声明以下能力：

```text
supports_model_list
supports_price_sync
supports_balance_query
supports_quota_query
supports_usage_query
supports_stream
supports_openai_compatible
supports_anthropic_compatible
supports_gemini_compatible
```

Channel Account 可以覆盖部分能力，例如自建网关禁用价格同步，或手动声明支持模型列表。

## 3. ChannelAdapter

ChannelAdapter 是渠道能力适配器，统一封装配置辅助和异步同步逻辑。

```text
ChannelAdapter
  - test_connection()
  - list_models()
  - sync_prices()
  - query_balance()
  - query_quota()
  - query_usage()
```

Adapter 只依赖 Channel Preset 和 Channel Account 配置，不参与主请求转发。

## 4. 异步同步原则

```text
同步失败不能影响 AI 请求转发
同步任务不阻塞代理启动
同步任务不在每次请求前执行
同步结果写入本地 SQLite
同步状态和错误在 UI 展示
过期数据可以展示，但必须标注更新时间
```

同步任务适合触发于：

```text
用户点击同步
新增账号后首次测试
应用启动后的后台任务
定时后台任务
价格或模型列表过期后刷新
```

## 5. 模型列表同步

模型列表来源优先级：

```text
渠道同步模型列表
内置模板模型列表
用户手动模型
```

如果渠道不支持模型列表查询，UI 仍应允许用户手动输入模型名。

模型列表同步失败不能禁用渠道或账号，只能提示用户继续使用已保存模型或手动模型。

## 6. 价格同步

模型价格来源分三类：

```text
preset  内置模板价格
synced  渠道同步价格
manual  用户手动价格
```

价格优先级：

```text
manual > synced > preset
```

成本分析只使用本地价格表，不在分析时实时请求 Provider。

## 7. 余额 / 额度 / 用量快照

余额、额度、用量查询结果保存为快照：

```text
account_balance_snapshots
account_quota_snapshots
account_usage_snapshots
```

快照只用于展示和路由参考：

```text
展示当前余额
展示剩余额度
展示上次同步时间
辅助 auto 候选排序
余额不足时提示用户
```

快照不能作为每次请求的实时强依赖。快照过期或同步失败时，路由应降级为普通顺序路由或成本路由。

## 8. 流式响应能力

`supports_stream` 表示渠道是否支持流式响应。

即使渠道支持流式响应，Flowlet 仍然遵守响应零改写：

```text
不解析 SSE
不重组 chunk
不补 usage
不改变错误结构
```

## 9. 协议能力

`supports_openai_compatible` 表示该渠道可直接接收 OpenAI-compatible 请求。

`supports_anthropic_compatible` 表示该渠道可直接接收 Anthropic-compatible 请求，可用于 Claude Code 这类 Anthropic API 客户端。

`supports_gemini_compatible` 表示该渠道可直接接收 Gemini-compatible 请求，作为后续扩展。

Flowlet 支持多协议透明转发，但不做跨协议转换。能力声明必须和 Channel Preset 的 `supported_protocols`、入口协议和上游协议一起使用：

```text
OpenAI-compatible 请求 -> OpenAI-compatible Provider
Anthropic-compatible 请求 -> Anthropic-compatible Provider / Claude Gateway
Gemini-compatible 请求 -> Gemini-compatible Provider
```

不能让用户误以为 Flowlet 会把 Claude Code / Anthropic 请求转换成 OpenAI 请求。

## 10. Claude Code 认证识别

Claude Code 接入 Anthropic-compatible Gateway 时，Flowlet 的 Client Token 识别需要同时支持：

```text
Authorization: Bearer ...
X-Api-Key: ...
```

其中 `ANTHROPIC_AUTH_TOKEN` 对应 `Authorization: Bearer ...`，`ANTHROPIC_API_KEY` 对应 `X-Api-Key: ...`。两种方式都应该能够识别为 Flowlet Client Token。

## 11. 同步状态

建议记录每次同步运行：

```text
id
channel_id
account_id
sync_type
status
started_at
finished_at
error_message
raw_result_path
```

`sync_type` 可取值：

```text
models
prices
balance
quota
usage
connection_test
```

## 12. UI 表达

Provider 页面应清晰区分：

```text
支持
不支持
未配置
同步失败
上次同步时间
```

不要把同步失败展示成代理不可用。代理是否可用由测试连接和真实请求结果决定，同步能力只是辅助信息。
