# Flowlet

Flowlet 是一个面向 AI Agent 的本地桌面模型服务控制台。

它负责管理上游渠道账号、对外开放模型、为 AI 客户端和 Agent 提供本地代理端点，并提供请求日志、用量成本和运行状态。

Flowlet 当前采用 LongCat + DeepSeek first 策略，先把 LongCat 和 DeepSeek 的 OpenAI-compatible 与 Anthropic-compatible 两种透明转发入口和多账号管理做完整，再扩展更多渠道。

## 产品原则

- 支持多协议透明转发，但不做跨协议转换
- 响应零改写
- 请求侧只做轻量路由和必要 Header 替换
- 日志旁路记录，不影响主请求链路
- 模型列表、价格、余额、额度、用量查询走异步同步
- Token 和成本通过离线分析完成
- 前端优先：业务流程和状态编排由 React 负责，Rust 提供底层原子能力

## 核心能力

- 本地代理入口（默认端口 18640）
- LongCat + DeepSeek 首发渠道模板
- 多协议入口：OpenAI-compatible 与 Anthropic-compatible
- 多账号管理：测试连接、余额同步、资源包管理
- 开放模型管理：按渠道/账号选择对外开放的模型
- 渠道账号管理：启用/停用、优先级排序、API Key 轮换
- Client Token 管理：固定掩码展示、按需查看明文
- Agent 接入向导：Claude Code、Codex CLI、OpenCode 等
- 请求日志：筛选、详情、清理、实时刷新
- 用量与成本分析
- 设置：语言、主题、开机自启动
- 系统托盘 / 开机自启动

## 当前架构

项目处于双前端过渡期：

- `src/` — Mantine 遗留前端，仅做必要维护
- `src-new/` — 默认重构目标，Semi Design + React 19 + TanStack Query

新前端采用分层架构：

```text
src-new/
├── app/          # Provider、Router、Shell
├── pages/        # 路由页面和页面状态组合
├── features/     # 用户动作与业务编排
├── domains/      # 领域类型、command、query、mutation
├── platform/     # Tauri 等运行平台边界
├── shared/       # 无业务含义的共享 UI 与工具
└── styles/       # reset 与 Design Tokens
```

Rust 后端（`src-tauri/`）负责代理核心、HTTP 转发、SQLite 持久化、系统托盘和渠道同步。

## 当前状态

Flowlet 正在从 Mantine 迁移到 Semi Design（`src-new/`）。新前端已覆盖概览页、渠道账号、开放模型、请求日志、用量成本和设置页面。

### 已完成能力

**新前端（src-new/）**
- 概览页（状态总览 + 三步引导）
- 渠道账号管理（增删改、测试连接、余额同步、LongCat 资源包）
- 模型服务页（路由候选检查）
- 请求日志（列表、详情、筛选、清理、自动刷新）
- 用量成本页
- 设置页（语言、主题、自启动）

**核心后端**
- Channel / Account / Model 三层数据模型
- SQLite WAL 模式持久化
- OpenAI-compatible + Anthropic-compatible 双协议透明转发
- 账号优先级 fallback、429/5xx 降级
- 请求日志旁路捕获（channel/account/protocol 维度）
- Token / 成本分析
- 余额快照与 DeepSeek 余额查询
- 便携版构建、配置导入导出
- Headless 二进制入口（`bin/headless.rs`）
- 运行时代理配置热更新

## 快速开始

### 桌面端（新前端）

```bash
npm install
npm run dev:new
```

### 桌面端（开发模式）

```bash
npm run tauri:dev
```

### 检查与构建

```bash
npm run check          # 前端 typecheck
npm run build:new      # 构建新前端
npm run test:new       # 运行新前端测试
```

### Rust Core 检查

```bash
cd src-tauri
cargo fmt
cargo check
cargo test
```

详细文档见 [docs/](docs/) 目录。

## 透明转发边界

- Flowlet 支持多协议入口，但不做跨协议转换。客户端请求使用什么协议，上游 Provider 就必须原生支持同一种协议。
- OpenAI-compatible 入口支持 `/v1/*`、`/openai/v1/*`。
- Anthropic-compatible 入口支持 `/anthropic/v1/*`，用于 Claude Code、Anthropic SDK 等。
- 请求侧仅做 Provider base_url 替换、Authorization / X-Api-Key 替换和 `auto` 的 model 映射。
- 上游返回的最终响应按原 status、headers、body 流式返回。
- 日志写入走旁路，失败不影响主请求链路。
- `auto` 当前只做顺序候选：429、5xx、network error 会尝试下一个候选；400、参数错误、协议不匹配、上下文超长不自动降级。
