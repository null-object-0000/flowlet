<div align="center">
  <img src="public/flowlet-logo.png" width="112" alt="Flowlet Logo" />
  <h1>Flowlet</h1>
  <p><strong>给 AI Agent 一个本地、可观测、可切换的模型入口。</strong></p>
  <p>统一管理模型渠道与账号，把 Claude Code、OpenCode、Pi 等 Agent 接入本地代理，并在一个桌面应用里查看请求、会话、Token、费用和资源余量。</p>
</div>

<p align="center">
  <a href="https://github.com/null-object-0000/flowlet/stargazers"><img src="https://img.shields.io/github/stars/null-object-0000/flowlet?style=flat-square" alt="GitHub Stars" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2563eb?style=flat-square" alt="MIT License" /></a>
  <a href="https://github.com/null-object-0000/flowlet/releases"><img src="https://img.shields.io/badge/release-v0.1.0-2563eb?style=flat-square" alt="Flowlet v0.1.0" /></a>
  <img src="https://img.shields.io/badge/desktop-Tauri%202-24c8db?style=flat-square" alt="Tauri 2" />
</p>

<p align="center">
  <strong>官网：<a href="https://flowlet.snewbie.site">flowlet.snewbie.site</a></strong>
</p>

> [!NOTE]
> Flowlet v0.1.0 是首个正式公开版本。可以从
> [GitHub Releases](https://github.com/null-object-0000/flowlet/releases) 下载桌面安装包或
> Windows 便携版。当前产物尚未签名，系统可能提示“未知发布者”；也欢迎通过
> [Issues](https://github.com/null-object-0000/flowlet/issues) 提交反馈。

## 为什么是 Flowlet

AI Agent 越来越多，但模型渠道、账号、套餐、请求日志和会话数据往往散落在不同地方。
Flowlet 把这些日常操作收敛到本地桌面：

- **一个本地入口**：OpenAI-compatible 与 Anthropic-compatible 客户端使用固定的
  Base URL 和 Client Token，不必在每个 Agent 中反复更换上游密钥。
- **多个渠道与账号**：管理 LongCat、DeepSeek、Kimi、千问 Qwen 和自定义中转服务，
  为同一模型配置多个候选账号和优先级。
- **明确开放哪些模型**：从上游 `/models` 拉取真实列表，只开放 Flowlet 支持且由用户
  明确选择的模型。
- **Agent 不再是黑盒**：统一查看经过 Flowlet 的请求，以及 Claude Code、OpenCode、
  Pi、Codex Desktop / CLI 的本地原生会话和时间线。
- **用量与费用更容易核对**：查看 Token、缓存命中、模型价格、渠道费用、套餐余量和
  Codex credits；不同币种和不同成本语义不会被强行相加。
- **本地优先**：代理、配置、SQLite 数据库和请求捕获默认保存在本机；多设备共享是
  可选能力。

## 现在可以做什么

### 管理渠道账号与开放模型

- 同一渠道添加多个账号，测试连接、启用/停用和调整路由优先级；
- 拉取上游真实模型列表，白名单外模型可见但不可误开放；
- 使用 `flowlet-pro` / `flowlet-flash` 聚合模型，或直接使用规范化模型 ID；
- 查看 DeepSeek、Kimi 官方余额，以及 LongCat、Qwen Token Plan 的资源余量；
- 使用自定义渠道连接标准 OpenAI-compatible / Anthropic-compatible 中转服务。

### 一键接入 AI Agent

- **Claude Code**：检测安装与版本，一键写入/恢复全局配置，支持主模型、快速模型、
  子 Agent 模型和可选 `[1m]` 长上下文；
- **OpenCode**：同时识别 CLI 与 Desktop，共用 Flowlet Provider 和凭据配置；
- **Pi**：写入 OpenAI-compatible Provider，并可安装会话扩展以注入稳定 Session ID；
- **ChatGPT（Codex）/ Codex CLI**：检测 Desktop 与 CLI，读取 Codex 账号、套餐用量、
  credits 和原生会话。

### 看清请求、会话与成本

- 请求日志支持客户端、模型、渠道、状态、时间和会话筛选；
- 查看最终上游 URL、Header、Body、错误、路由尝试、首 Token 延迟与总耗时；
- 原生读取 Claude Code JSONL、OpenCode SQLite、Pi JSONL 和 Codex rollout；
- 会话详情统一展示消息、思考摘要、工具调用、工具结果、错误和 Token 用量；
- 请求捕获采用 SQLite 索引与本地 `.flcap` 明细文件，支持按时间和体积自动清理；
- 数据维护工具可以修复历史会话归因、重新解析 Token 并重算费用。

### 在多设备查看用量

Flowlet 支持把最小化的每日用量快照同步到兼容 S3 的对象存储，并在其它桌面设备读取。
当前代码还包含实验性的 Android 只读查看器，用于查看设备用量和会话摘要；它不会启动
手机本地代理，也不会同步请求正文、Header、API Key 或渠道账号。

## 当前支持范围

### 渠道

| 渠道 | OpenAI Chat | Anthropic Messages | 模型同步 | 余额 / 资源 |
|------|-------------|--------------------|----------|-------------|
| LongCat | ✅ | ✅ | ✅ | 资源包与按量余额 |
| DeepSeek | ✅ | ✅ | ✅ | 官方余额 |
| Kimi / Moonshot | ✅ | ✅ | ✅ | 官方余额 |
| 千问 Qwen | ✅ | ✅ | ✅ | Token Plan 套餐余量 |
| Z.AI | ✅ | ✅ | ✅ | — |
| OpenRouter | ✅ | ✅ | ✅ | API Key 用量与 Credits |
| 自定义渠道 | 取决于上游 | 取决于上游 | 标准 OpenAI `/models` | — |

### Agent

| Agent | 安装探测 | 一键接入 Flowlet | 原生会话 |
|-------|----------|------------------|----------|
| Claude Code | ✅ | ✅ | ✅ |
| OpenCode CLI / Desktop | ✅ | ✅ | ✅ |
| Pi | ✅ | ✅ | ✅ |
| ChatGPT（Codex）/ Codex CLI | ✅ | ✅ | ✅ |

Flowlet 当前正式支持 Chat Completions、Anthropic Messages 与无状态 Responses API
透明转发。完整的渠道、14 个模型、协议和 Agent 能力边界见
[当前支持矩阵](docs/support-matrix.md)。

## 3 分钟启动

### 环境要求

- [Node.js](https://nodejs.org/) 22+
- [Rust stable](https://www.rust-lang.org/tools/install)
- [Tauri 2 系统依赖](https://v2.tauri.app/start/prerequisites/)

### 从源码运行桌面端

```bash
git clone https://github.com/null-object-0000/flowlet.git
cd flowlet
npm ci
npm run tauri:dev
```

首次启动后：

1. Flowlet 会自动尝试启动本地代理；
2. 在概览页添加渠道账号并填写上游 API Key；
3. 点击“拉取模型列表”，选择需要开放的模型并保存；
4. 在“AI Agent 接入”中选择 Claude Code、OpenCode 或 Pi，一键写入全局配置；
5. 回到你的 Agent 发起请求，在 Flowlet 中查看日志、会话和用量。

没有账号或开放模型时，代理仍会正常监听，只是 `/models` 返回空列表。

### 本地访问地址

默认代理地址为 `http://127.0.0.1:18640`。

| 用途 | 地址 |
|------|------|
| 健康检查 | `http://127.0.0.1:18640/health` |
| OpenAI Base URL | `http://127.0.0.1:18640/v1` |
| OpenAI 模型列表 | `http://127.0.0.1:18640/v1/models` |
| OpenAI Chat Completions | `http://127.0.0.1:18640/v1/chat/completions` |
| Anthropic Base URL | `http://127.0.0.1:18640/anthropic` |
| Anthropic Messages | `http://127.0.0.1:18640/anthropic/v1/messages` |

客户端鉴权使用 Flowlet 概览页展示的 **Client Token**，不是渠道 API Key：

```bash
curl http://127.0.0.1:18640/v1/models \
  -H "Authorization: Bearer <FLOWLET_CLIENT_TOKEN>"
```

## 构建

### 桌面安装包

```bash
npm ci
npm run fetch:catalogs
npx tauri build
```

仓库的构建工作流覆盖：

- Windows x64：NSIS、MSI、便携版 ZIP；
- Linux x64：AppImage、Debian package；
- macOS Apple Silicon / Intel：DMG。

Windows 还可以使用 `npm run tauri:build` 在完成安装包构建后额外生成便携版 ZIP；
该步骤需要 Python 3。

当前产物尚未签名。Windows 和 macOS 可能显示“未知发布者”或阻止直接打开。
详细说明见 [安装包构建](docs/release-builds.md)。

### Android 只读查看器（实验性）

```bash
npm run tauri:android:init
npm run tauri:android:build
```

需要 Android Studio、Android SDK/NDK 和 Java 17–21。该构建只提供多设备用量与会话摘要
查看，不包含桌面端的渠道管理和本地代理。

## 数据与安全

- 渠道 API Key、Client Token、配置和使用数据默认只保存在本机；
- 请求日志是否脱敏由 `log_capture.redact_sensitive_headers` 控制，**当前默认关闭**；
- 默认状态下，请求捕获可能原样保存 `Authorization`、`x-api-key`、Cookie、Header 和 Body；
- 如果不需要排查完整请求，请在“设置 → 数据捕获”中开启敏感 Header 脱敏，或关闭对应
  Header / Body 捕获；
- 可选 S3 设备同步只发送最小用量与会话摘要，不发送请求正文、凭据或渠道账号；
- Flowlet 的费用主要是基于官方价格目录的估算，不等同于账单实付或订阅成本分摊。

完整字段和保留策略见 [`docs/config.md`](docs/config.md)。

## 产品边界

Flowlet 是面向 AI Agent 的本地模型服务控制台，不是通用企业 LLM Gateway：

- 不做不同模型服务协议之间的转换；
- 不随意改写上游响应结构；
- 不提供企业多租户、复杂权重调度或大规模网关控制面；
- fallback 只处理适合重试的网络错误、429 和部分 5xx，不会用换模型掩盖参数错误；
- Agent 原生用量与经过 Flowlet 的请求分开统计，不重复相加。

更完整的产品定义见 [产品文档](docs/product.md)。

## 路线方向

接下来重点推进：

- 扩展更多 Agent 的安装探测、配置写入、请求归属和原生会话；
- 完善统一 AI 成本账本，区分实付、公开价估算、套餐 credits 和分摊；
- 完善多设备同步与移动端只读体验；
- 继续提升代理稳定性、日志可诊断性和渠道接入体验。

进度和阶段边界见 [Roadmap](docs/roadmap.md)。

## 开发与贡献

Flowlet 使用 React 19、TypeScript、Semi Design、TanStack Query、Tauri 2、Rust 和 SQLite。
README 只保留用户需要的最小技术信息，代码分层、代理链路、存储和 Agent 数据源说明统一
维护在 [架构文档](docs/architecture.md)。

常用检查：

```bash
npm run check
npm test
npm run build

cd src-tauri
cargo check
cargo test
```

欢迎提交 Issue 或 Pull Request。如果 Flowlet 对你的 Agent 工作流有帮助，也欢迎点一个
[Star](https://github.com/null-object-0000/flowlet/stargazers)，这会帮助更多人发现它。

## 文档

- [当前支持矩阵](docs/support-matrix.md)
- [产品定义](docs/product.md)
- [架构说明](docs/architecture.md)
- [新增渠道接入指南](docs/channel-integration.md)
- [`config.json` 字段说明](docs/config.md)
- [Claude Code 全局配置](docs/claude-code-global-config.md)
- [OpenCode 全局配置](docs/opencode-global-config.md)
- [安装包构建](docs/release-builds.md)
- [Roadmap](docs/roadmap.md)

## License

[MIT](LICENSE)
