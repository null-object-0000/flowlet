# Flowlet

Flowlet 是一个桌面优先的本地 AI 请求路由客户端。

Flowlet 当前阶段采用 LongCat + DeepSeek first 策略：先把 LongCat 和 DeepSeek 的 OpenAI-compatible 与 Anthropic-compatible 两种透明转发入口、多账号管理、Claude Code 接入、请求日志和 Token / 成本分析做完整，再扩展更多渠道。

项目尚未发布第一个可用版本，因此第一版正式实现允许破坏式重构：不兼容旧 Provider 原型、不做旧 SQLite 表迁移，直接以 Channel / Account / Model 作为正式数据模型。

## 产品原则

- 支持多协议透明转发，但不做跨协议转换
- 响应零改写
- 请求侧只做轻量路由和必要 Header 替换
- 日志旁路记录，不影响主请求链路
- 模型列表、价格、余额、额度、用量查询走异步同步
- Token 和成本通过离线分析完成
- 桌面客户端优先，Docker / Web Console 后续支持

## 核心能力

- 本地代理入口
- LongCat + DeepSeek 首发渠道模板
- 多协议客户端入口：OpenAI-compatible 与 Anthropic-compatible
- Claude Code 接入向导
- 多账号管理：一个账号对应一个 API Key
- 内置渠道模板
- 开箱即用渠道配置：选择渠道、填写 API Key、选择模型、测试连接
- Provider 配置管理
- 渠道能力识别
- 模型列表同步
- 价格表同步 / 手动维护
- 余额 / 额度 / 用量查询
- 渠道测试连接
- 自定义 OpenAI-compatible / Anthropic-compatible 渠道
- Client Token 管理
- 虚拟模型，例如 `auto`
- 免费额度优先与失败降级
- 请求日志查看
- Token / 成本分析
- 桌面端可视化管理
- 后续支持 Docker 部署和 Web 访问

## 当前状态

项目处于早期原型阶段，已经完成第一阶段文档和桌面端技术骨架的初始落地。当前能力统一视为“基础雏形完成”，仍需要稳定性验证和产品化打磨，不应理解为稳定可用版本。

已完成基础雏形：

- 中文 README、产品文档、路线图和架构文档
- Tauri 2 + React + TypeScript + Vite 项目骨架
- Rust Core 基础目录结构
- 本地代理启动 / 停止 / 状态 Tauri command
- `127.0.0.1:11434/health`
- `/v1/*` OpenAI-compatible 透明转发雏形
- Provider 基础管理和 SQLite 基础配置存储
- `auto` 虚拟模型顺序路由雏形
- 429、5xx、network error 的受限 fallback
- 成功请求和网络失败请求 metadata 日志旁路
- Client Token 请求来源识别
- 离线 unknown 用量分析和基础统计查询雏形
- 普通 JSON 响应的 `response.usage` 旁路提取
- 手动模型价格表和基于已知 Token 的成本重算结构
- 桌面首页中文 UI 雏形

下一阶段主线：

- 稳定 LongCat / DeepSeek OpenAI-compatible 透明转发
- 增加 LongCat / DeepSeek Anthropic-compatible 透明转发，用于接入 Claude Code
- 把 Provider 页升级为渠道页：渠道、账号、模型三层结构
- 支持 LongCat / DeepSeek 多账号优先级路由和账号级 fallback
- 支持 LongCat-2.0、deepseek-v4-flash、deepseek-v4-pro 模型与三段价格：输入未命中缓存、输入命中缓存、输出
- LongCat 余额和资源包第一版采用账号级手动快照；DeepSeek 支持官方余额查询
- 继续验证透明转发、fallback、SSE 透传和构建流程

详细阶段需求见 [docs/longcat-first.md](docs/longcat-first.md) 和 [docs/deepseek-first.md](docs/deepseek-first.md)。相关 LongCat 官方文档：[快速开始](https://longcat.chat/platform/docs/zh/)、[API 概述](https://longcat.chat/platform/docs/zh/APIDocs.html)、[Claude Code 配置](https://longcat.chat/platform/docs/zh/ClaudeCode.html)。相关 DeepSeek 官方文档：[API 文档](https://api-docs.deepseek.com/zh-cn/)、[价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)、[Claude Code](https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/claude_code)、[Anthropic API](https://api-docs.deepseek.com/zh-cn/guides/anthropic_api)、[余额查询](https://api-docs.deepseek.com/zh-cn/api/get-user-balance)。

破坏式重构策略见 [docs/breaking-refactor.md](docs/breaking-refactor.md)。

## 当前透明转发边界

- 第一阶段采用 LongCat + DeepSeek first 策略，同时支持 LongCat / DeepSeek 的 OpenAI-compatible 与 Anthropic-compatible 两种透明转发入口。
- Flowlet 支持多协议入口，但不做跨协议转换。客户端请求使用什么协议，上游 Provider 就必须原生支持同一种协议。
- OpenAI-compatible 入口优先支持 `/v1/*`。
- Anthropic-compatible 入口支持 `/anthropic/v1/messages`，用于 Claude Code、Anthropic SDK 和其他 Anthropic-compatible 客户端。
- 请求侧仅做 Provider base_url 替换、Authorization / X-Api-Key 替换和 `auto` 的 model 映射。
- 上游返回的最终响应按原 status、headers、body 流式返回。
- 普通 JSON 响应会旁路复制最多 1MB 响应体用于离线 `usage` 提取；SSE 流式响应不解析。
- 日志写入走旁路，失败不影响主请求链路。
- `auto` 当前只做顺序候选：429、5xx、network error 会尝试下一个候选；400、参数错误、协议不匹配、上下文超长不自动降级。
- 模型列表、价格、余额、额度、用量查询不能进入主请求链路，只能作为配置辅助和异步同步能力。
- Client Token 识别需要同时支持 `Authorization: Bearer ...` 和 `X-Api-Key: ...`，以兼容 Claude Code 的 `ANTHROPIC_AUTH_TOKEN` 与 `ANTHROPIC_API_KEY` 接入方式。

## 本地开发

前端依赖使用 bun：

```bash
bun install
bun run check
bun run build
```

Rust Core 检查：

```bash
cd src-tauri
cargo fmt
cargo check
cargo test
```

桌面开发启动：

```bash
bun run tauri:dev
```
