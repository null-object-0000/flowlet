# Flowlet 破坏式重构策略

## 1. 当前结论

Flowlet 当前还没有正式发布第一个可用版本，因此不需要考虑旧数据结构、旧 SQLite 表、旧 Provider 配置的兼容迁移。

当前代码里的 `ProviderConfig`、`providers` 表、`provider_id = default`、单 Provider / 单 API Key / `/v1/*` OpenAI-compatible 代理结构，都只是早期原型雏形。

接下来应直接按新版产品模型进行破坏式重构：

```text
Channel
Account
Model
Client
Route
Log
Usage
Price
BalanceSnapshot
```

也就是说：

```text
不做旧版本兼容
不做 SQLite 迁移
不保留旧 Provider 概念
允许删除旧表和旧结构
以 Channel / Account / Model 作为第一版正式数据模型
```

---

## 2. 最新产品方向

Flowlet 第一版采用 **LongCat + DeepSeek first** 策略。

第一阶段不再优先铺开大量通用渠道，而是先把 LongCat 和 DeepSeek 这两个首发渠道做深、做完整，用它们验证 Flowlet 的核心能力：

```text
多协议透明转发
响应零改写
Claude Code 接入
多账号管理
账号级 fallback
模型列表同步
价格 / 成本分析
余额 / 资源包 / 用量管理
请求日志与稳定性统计
```

LongCat 和 DeepSeek 都具备 OpenAI-compatible 与 Anthropic-compatible 两种接入能力，能覆盖 Cursor / Cline / Open WebUI / Cherry Studio 这类 OpenAI-compatible 客户端，也能覆盖 Claude Code 这类 Anthropic-compatible 客户端。

---

## 3. 核心原则

底层原则不变：

```text
支持多协议透明转发
不做跨协议转换
响应零改写
请求侧只做必要路由、Header 替换和可选模型映射
日志旁路记录，不影响主请求链路
Token 和成本分析走离线任务
模型列表、价格、余额、额度、用量查询只做异步同步和配置辅助
```

正确链路：

```text
OpenAI-compatible 请求
  -> Flowlet OpenAI-compatible 入口
  -> OpenAI-compatible 上游

Anthropic-compatible 请求 / Claude Code
  -> Flowlet Anthropic-compatible 入口
  -> Anthropic-compatible 上游
```

明确不做：

```text
OpenAI 请求 -> 转 Anthropic 请求
Anthropic 请求 -> 转 OpenAI 请求
Claude Code 请求 -> 转 OpenAI-compatible 请求
```

Flowlet 是多协议本地请求路由客户端，不是协议转换器。

---

## 4. 新版核心概念

当前版本概念收敛为三层：

```text
渠道 Channel
  ↓
账号 Account
  ↓
模型 Model
```

### 4.1 Channel

Channel 是服务商模板，例如：

```text
LongCat
DeepSeek
后续 OpenAI
后续 OpenRouter
后续 Moonshot
自定义 OpenAI-compatible
自定义 Anthropic-compatible
```

第一版正式内置渠道：

```text
LongCat
DeepSeek
```

### 4.2 Account

Account 是用户在某个渠道下配置的一组访问身份。

当前版本必须明确：

```text
一个渠道可以有多个账号
一个账号只对应一个 API Key
```

当前不需要 Credential 概念，也不需要 Key 池。账号就是路由、统计、余额、失败状态的最小单位。

### 4.3 Model

Model 归属于 Channel，不归属于 Account。

```text
LongCat
  └─ LongCat-2.0

DeepSeek
  ├─ deepseek-v4-flash
  └─ deepseek-v4-pro
```

多个账号共享同一个渠道模型列表。

---

## 5. 协议入口设计

本地代理端口仍然使用：

```text
127.0.0.1:18640
```

协议入口：

```text
OpenAI-compatible:
  /v1/*
  /openai/v1/*

Anthropic-compatible:
  /anthropic/v1/messages
  /anthropic/v1/models
```

首发渠道映射：

```text
Flowlet /v1/* 或 /openai/v1/*
  -> LongCat https://api.longcat.chat/openai
  -> DeepSeek https://api.deepseek.com

Flowlet /anthropic/v1/*
  -> LongCat https://api.longcat.chat/anthropic
  -> DeepSeek https://api.deepseek.com/anthropic
```

---

## 6. 路由候选设计

旧版候选是：

```text
model candidates
```

新版改为：

```text
Channel + Account + Protocol + Model
```

第一版路由策略：

```text
按账号 priority 顺序尝试
账号禁用则跳过
请求失败后尝试下一个账号
```

后续再做：

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

通用可 fallback：

```text
429
500
502
503
网络错误
超时
余额不足 / 额度不足
```

通用不建议 fallback：

```text
400
401
422
请求参数错误
协议不匹配
上下文超长
```

DeepSeek 特化规则：

```text
可以 fallback：
- 402 余额不足
- 429 请求速率达到上限
- 500 服务器故障
- 503 服务器繁忙
- 网络错误
- 超时

不自动 fallback：
- 400 请求体格式错误
- 401 API Key 错误
- 422 参数错误
```

401 应记录当前账号错误并提示用户检查 API Key，而不是默认自动切换。

---

## 8. Claude Code 接入

Flowlet 应提供 Anthropic-compatible 本地入口：

```text
ANTHROPIC_BASE_URL=http://127.0.0.1:18640/anthropic
```

Claude Code 不直接保存 LongCat / DeepSeek API Key，而是保存 Flowlet Client Token：

```text
ANTHROPIC_AUTH_TOKEN=flowlet-client-token
```

Flowlet 内部根据 Client Token 识别请求来源，然后转发到实际渠道账号时替换为真实 API Key。

Client Token 识别需要支持：

```text
Authorization: Bearer ...
X-Api-Key: ...
```

---

## 9. 价格与成本模型

LongCat 和 DeepSeek 都需要支持三段价格：

```text
输入未命中缓存
输入命中缓存
输出
```

旧版：

```text
input_price
output_price
```

应改为：

```text
input_uncached_price
input_cached_price
output_price
currency
unit
source
synced_at
```

价格优先级：

```text
用户手动价格 > 渠道同步价格 > 内置模板价格
```

成本计算规则：

```text
成功请求才估算成本
失败请求只记录日志，不计入成本
优先使用 response.usage 中的真实 token
如果 usage 缺失，则标记 unknown
如果无法区分 cached / uncached input，第一版先按 uncached 估算
```

---

## 10. 余额与资源包

LongCat 第一版：

```text
价格：支持内置预设，后续可从模型详情或官方接口同步
余额：先支持用户手动维护余额快照
资源包：先支持用户手动登记资源包总量、剩余量、过期时间
账单 / 余额自动同步：后续如果官方开放 API 再接入
```

DeepSeek 第一版可以做真实余额查询：

```text
GET /user/balance
```

---

## 11. 日志与统计

旧日志中的 `provider_id` 应替换为：

```text
channel_id
account_id
client_protocol
upstream_protocol
```

新版请求日志字段建议：

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
fallback_count
route_reason
error_message
created_at
```

---

## 12. 第一版最小数据表

当前不考虑旧表兼容，建议直接重建为：

```text
channel_presets
channel_accounts
channel_models
clients
virtual_models
virtual_model_routes
request_logs
usage_records
model_prices
account_balance_snapshots
```

可以先不做：

```text
credentials
key_pool
provider_profiles
provider_marketplace
team_billing
```

---

## 13. UI 调整

旧的 Provider 页可以直接废弃，改成“渠道账号”。

建议导航：

```text
概览
渠道账号
Claude Code
客户端 Token
路由配置
请求日志
用量统计
设置
```

渠道账号页第一版只展示：

```text
LongCat
DeepSeek
```

每个渠道下面支持多个账号：

```text
账号名称
API Key
启用状态
优先级
备注
测试连接
最近使用时间
最近错误
余额 / 资源包快照
```

不要出现：

```text
账号下面再新增密钥
一个账号多个 Key
Key 池
Credential 管理
```

---

## 14. 当前代码重构策略

因为第一版还没发布，所以当前最合理策略是：

```text
直接破坏式重构
删除旧 ProviderConfig
删除旧 providers 表
删除旧 provider_id = default 逻辑
删除旧 ModelPrice input/output 二段结构
删除旧单 Provider AppState
删除旧 Provider UI
```

直接改成：

```text
ChannelPreset
ChannelAccount
ChannelModel
ProtocolType
RouteCandidate
RequestLog with channel_id/account_id
UsageRecord with channel_id/account_id/protocol
ModelPrice with cached/uncached/output
AccountBalanceSnapshot
```

---

## 15. 推荐实现顺序

### Step 1：重建数据模型

先定义：

```text
ProtocolType
ChannelPreset
ChannelAccount
ChannelModel
RouteCandidate
ModelPrice
AccountBalanceSnapshot
RequestLogMetadata
UsageRecordInput
```

并重建 SQLite 表。

### Step 2：实现 LongCat OpenAI-compatible

先跑通：

```text
/v1/*
/openai/v1/*
-> LongCat https://api.longcat.chat/openai
```

### Step 3：实现 LongCat 多账号

支持：

```text
LongCat 下多个账号
按 priority 排序
账号禁用跳过
失败 fallback 到下一个账号
日志记录 fallback_count / route_reason
```

### Step 4：实现 Anthropic-compatible 入口

支持：

```text
/anthropic/v1/messages
/anthropic/v1/models
```

### Step 5：实现 Claude Code 向导

支持：

```text
LongCat Claude Code 配置生成
DeepSeek Claude Code 配置生成
一键复制
```

### Step 6：实现 DeepSeek 首发渠道

支持：

```text
DeepSeek Channel Preset
OpenAI-compatible 入口
Anthropic-compatible 入口
多账号
模型列表同步
余额查询
DeepSeek fallback 规则
```

### Step 7：补价格与统计

支持：

```text
三段价格
账号级成本统计
账号级失败率
账号级 fallback 次数
余额快照展示
```

---

## 16. 最终一句话口径

Flowlet 第一版不再围绕旧 Provider 模型继续做，而是直接重构为 **LongCat + DeepSeek first 的多协议本地 AI 请求路由客户端**。

它支持 LongCat / DeepSeek 的 OpenAI-compatible 与 Anthropic-compatible 透明转发，不做跨协议转换，不改写响应。用户可以在一个渠道下配置多个账号，一个账号固定对应一个 API Key，并通过账号优先级完成路由、fallback、日志、成本和余额统计。
