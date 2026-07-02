# Provider Presets

> 当前 LongCat + DeepSeek first 阶段优先使用 Channel / Account / Model 术语，详见 `docs/longcat-first.md` 和 `docs/deepseek-first.md`。本文保留为后续多渠道泛化设计参考；其中 Provider Preset 可理解为 Channel Preset，User Provider 可理解为 Channel Account。

## 1. 目标

Provider Preset 的目标是把 Flowlet 的 Provider 配置从“技术字段表单”变成“开箱即用渠道选择”。

普通用户不应该维护 `base_url`、`auth_type`、`headers_json` 和模型名。普通用户应该选择渠道模板、填写 API Key、选择模型、测试连接、保存启用。自定义渠道是高级能力。

Provider Preset 必须区分客户端协议和上游协议。Flowlet 支持多协议透明转发，但不做跨协议转换。

## 2. 概念

### 2.1 Provider Preset

Provider Preset 是 Flowlet 内置维护的渠道模板，描述一个渠道的默认配置和能力：

```text
渠道名称
客户端协议
上游协议
默认 Base URL
认证方式
默认模型
可选模型列表
内置价格表
渠道能力
用户可见字段
高级设置字段
```

Preset 不保存用户 API Key。

### 2.2 User Provider

User Provider 是用户实际启用的渠道实例，关联一个 Provider Preset，并保存用户自己的配置：

```text
preset_id
用户命名
API Key
默认模型
是否启用
自定义 Base URL
自定义 Header
自定义模型
自定义价格
自定义错误识别规则
```

User Provider 可以覆盖 Preset 的部分字段，但默认 UI 不暴露底层技术字段。

## 3. 内置渠道列表

第一批内置渠道模板按协议分组。

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

Gemini-compatible 渠道后续按相同结构扩展。

只有当 `client_protocol` 和 `upstream_protocol` 属于同一种协议时，渠道才能直接用于透明转发。只支持 OpenAI-compatible 的渠道不能直接承接 Claude Code 请求，除非未来明确新增协议转换模式。

## 4. 普通用户配置流程

```text
1. 打开 Provider 页面
2. 点击新增渠道
3. 选择渠道模板
4. 填写 API Key
5. 选择默认模型
6. 点击测试连接
7. 保存并启用
```

模型选择优先使用同步到的模型列表；如果渠道不支持模型列表查询，则使用内置模型列表或允许用户手动输入。

## 5. 高级设置

高级用户可以展开以下字段：

```text
Base URL
认证 Header
额外 Header
默认模型名
模型名映射
手动价格
错误识别规则
超时时间
是否参与 auto 路由
```

高级设置的原则是：能覆盖，但不要求普通用户理解。

## 6. 字段可见性

普通模式展示：

```text
渠道
名称
API Key
默认模型
启用状态
测试连接
```

高级模式展示：

```text
Base URL
Auth Type
Headers
模型名映射
价格覆盖
错误识别
同步能力开关
```

## 7. 自定义渠道规则

自定义渠道用于支持未内置的服务或用户自建网关。第一阶段应分别提供：

```text
自定义 OpenAI-compatible
自定义 Anthropic-compatible
```

必填：

```text
名称
Base URL
API Key
默认模型
```

可选：

```text
额外 Header
模型列表
价格表
错误识别规则
能力声明
```

自定义渠道默认只承诺同协议透明转发，不默认支持模型列表、价格、余额、额度或用量查询。

## 8. Preset 数据建议

```text
id
name
client_protocol
upstream_protocol
base_url
auth_type
default_model
default_models_json
default_prices_json
capabilities_json
visible_fields_json
advanced_fields_json
enabled
created_at
updated_at
```

## 9. User Provider 数据建议

```text
id
preset_id
name
api_key
default_model
base_url_override
auth_type_override
headers_json
model_overrides_json
price_overrides_json
error_rules_json
capability_overrides_json
enabled
created_at
updated_at
```

## 10. 产品边界

- Preset 是配置辅助，不是 Provider marketplace。
- Preset 更新不能破坏用户已有 User Provider。
- Preset 中的价格只能作为兜底参考，不能替代用户手动价格或渠道同步价格。
- Provider 测试连接失败只影响配置保存提示，不影响已运行代理。
- Preset 不能暗示 Flowlet 会做 OpenAI / Anthropic / Gemini 之间的协议转换。
