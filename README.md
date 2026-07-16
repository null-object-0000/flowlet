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

Flowlet 当前处于 Channel / Account / Model 重构雏形阶段，还不是生产就绪版本。当前分支的目标是先验证 LongCat / DeepSeek 双协议透明转发、多账号优先级 fallback、Claude Code 接入、日志和成本统计这条 MVP 主链路。

### 已完成能力

**核心架构**
- Channel / Account / Model 三层数据模型
- SQLite WAL 模式持久化、自动迁移
- 三段价格体系（input_uncached / input_cached / output）

**协议支持**
- OpenAI-compatible 入口：`/v1/*`、`/openai/v1/*`
- Anthropic-compatible 入口：`/anthropic/v1/*`
- 响应零改写、流式透传

**渠道支持**
- LongCat（OpenAI + Anthropic 双协议）
- DeepSeek（OpenAI + Anthropic + 模型同步 + 余额查询）

**路由能力**
- 显式 `auto` 候选顺序路由
- 账号优先级 fallback
- 429/5xx/402 fallback、400/401 不降级
- 请求类型识别仅用于日志，不参与自动换模型

**部署方式**
- 桌面端（Tauri）
- 系统托盘 / 开机自启动仍需实机回归
- Docker、Web Console、无头服务器作为后续阶段验证，不作为当前 MVP 完成项

**可观测性**
- 请求日志（channel/account/protocol/request_type 维度）
- Token / 成本分析（response.usage 旁路提取）
- 账号统计（请求数/失败率/fallback/成本）
- 余额快照（手动登记 + DeepSeek 查询后自动记录）

## 快速开始

### 桌面端

```bash
bun install
bun run tauri:dev
```

详细文档见 [docs/](docs/) 目录。

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
