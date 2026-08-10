<div align="center">
  <img src="public/flowlet-logo.png" width="112" alt="Flowlet Logo" />
  <h1>Flowlet</h1>
  <p><strong>给 AI Agent 一个本地、可观测、可切换的模型入口。</strong></p>
  <p>一个桌面应用，统一管理模型账号、接入常用 Agent，并看清每一次调用。</p>
</div>

<p align="center">
  <a href="https://github.com/null-object-0000/flowlet/releases"><strong>下载 Flowlet</strong></a>
  ·
  <a href="https://flowlet.snewbie.site">产品官网</a>
  ·
  <a href="https://github.com/null-object-0000/flowlet/issues">反馈问题</a>
</p>

<p align="center">
  <a href="https://github.com/null-object-0000/flowlet/stargazers"><img src="https://img.shields.io/github/stars/null-object-0000/flowlet?style=flat-square" alt="GitHub Stars" /></a>
  <a href="https://github.com/null-object-0000/flowlet/releases"><img src="https://img.shields.io/badge/release-v0.1.0-2563eb?style=flat-square" alt="Flowlet v0.1.0" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2563eb?style=flat-square" alt="MIT License" /></a>
</p>

## 为什么使用 Flowlet

- **告别反复改配置**：Claude Code、OpenCode、Pi 和 Codex 共用一个本地入口，切换渠道或账号不再逐个修改 Agent。
- **把多个账号变成一个服务**：集中管理 LongCat、DeepSeek、Kimi、Qwen、Z.AI、OpenRouter 与自定义渠道，支持多账号候选和失败降级。
- **知道 Agent 真正在做什么**：统一查看请求、原生会话、工具调用、错误、Token、费用和资源余量。
- **数据留在自己手里**：代理、配置、凭据和使用数据默认保存在本机，不依赖 Flowlet 云服务。

## 你可以用它做什么

### 一键接入常用 Agent

Flowlet 可以检测本机安装，并为以下 Agent 写入和恢复全局配置：

`Claude Code` · `OpenCode CLI / Desktop` · `Pi` · `Codex CLI / Desktop / VS Code`

### 统一管理模型与账号

从上游拉取真实模型列表，明确选择需要开放的模型；为同一模型配置多个账号，并通过
`flowlet-pro` / `flowlet-flash` 给 Agent 提供稳定的聚合模型入口。

### 看清请求、会话与用量

请求失败时可以看到实际路由、上游响应和错误；日常使用时可以按 Agent、模型、渠道与会话
核对 Token、缓存命中、预估费用、套餐余量和 Codex Credits。

## 开始使用

1. 从 [GitHub Releases](https://github.com/null-object-0000/flowlet/releases) 下载 Windows、macOS 或 Linux 版本；
2. 添加一个渠道账号，拉取并选择需要开放的模型；
3. 在概览页选择你的 Agent，一键接入 Flowlet；
4. 回到 Agent 正常工作，在 Flowlet 中查看请求、会话和用量。

> [!NOTE]
> 当前桌面产物尚未签名，Windows 或 macOS 可能显示“未知发布者”提示。

## 本地优先

Flowlet 默认只在本机保存渠道 API Key、Client Token、配置和使用数据。多设备 S3 同步是
可选能力，且不会同步请求正文、凭据或渠道账号。

请求捕获可能包含敏感 Header 和 Body；如果不需要完整排障信息，可以在“设置 → 数据捕获”
中开启敏感 Header 脱敏或关闭相应捕获。

## 了解更多

- [支持的渠道、模型、协议与 Agent](docs/support-matrix.md)
- [配置与数据保留策略](docs/config.md)
- [产品定位](docs/product.md)
- [更新日志](CHANGELOG.md)

<details>
<summary>从源码运行</summary>

需要 Node.js 22、Rust stable 与 Tauri 2 系统依赖：

```bash
git clone https://github.com/null-object-0000/flowlet.git
cd flowlet
npm ci
npm run tauri:dev
```

架构与贡献说明见 [架构文档](docs/architecture.md)。

</details>

## License

[MIT](LICENSE)
