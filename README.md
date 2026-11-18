<div align="center">
  <img src="public/flowlet-logo.png" width="112" alt="Flowlet Logo" />
  <h1>Flowlet</h1>
  <p><strong>让多个 AI Agent 共用一个模型入口。</strong></p>
  <p>集中管理模型账号，切换上游不用逐个重配 Agent。请求失败时查实际路由和上游错误，平时按 Agent、模型与账号核对 Token 和预估费用。</p>
</div>

<p align="center">
  <a href="https://github.com/null-object-0000/flowlet/releases"><strong>下载桌面版</strong></a>
  · <a href="docs/docker.md">自托管 Web / Docker</a>
  · <a href="https://flowlet.snewbie.site/zh#demo">官网交互演示</a>
</p>

## 选择运行方式

| 我想…… | 从这里开始 |
| --- | --- |
| 在自己的电脑上使用，并让 Flowlet 管理本机 Agent 配置 | 下载 [Windows、macOS 或 Linux 桌面版](https://github.com/null-object-0000/flowlet/releases)。安装包和首次启动说明见[安装手册](docs/installation.md)。 |
| 在服务器上提供模型入口，用浏览器管理 | 按 [Docker 部署文档](docs/docker.md)启动独立 Web Host。也可以用桌面端[客户端模式](docs/desktop-electron.md)连接已有 Web Host；远程管理不会写入本机 Agent 配置。 |

## 接入第一个 Agent

1. 添加一个渠道账号，填写上游 API Key，拉取模型列表。
2. 勾选要开放的模型。同一模型可由多个可用账号承载，并在适用的失败场景下切换候选。
3. 用 Flowlet 提供的 **Base URL、Client Token 和已开放的模型**配置 Agent。桌面本机模式可为 Claude Code、Codex、OpenCode、Pi 等受支持工具备份、写入和恢复配置；其它兼容客户端可手动接入。
4. 发出一个请求，在「请求日志」查看实际路由、上游结果和用量。能关联到会话的请求也可从「会话管理」查看。

Flowlet 不做跨协议转换。OpenAI Chat Completions、Anthropic Messages、无状态 OpenAI Responses 等入口的适用范围，见[支持矩阵](docs/support-matrix.md)。开放模型以[模型目录](model-catalog.json)和账号实际可用资源为准。

## 数据在哪里

数据默认保存在你运行 Flowlet 的机器，不依赖 Flowlet 云服务。模型请求仍会发送到你选用的上游。桌面多设备同步是可选项；渠道账号工作区需要单独启用，并使用独立密钥端到端加密。

请求捕获可能包含敏感 Header 和正文，可在「设置 → 数据捕获」开启敏感 Header 脱敏或关闭相应捕获。分享日志前请先检查是否包含凭据或会话内容。

## 文档与反馈

- [安装与首次使用](docs/installation.md) · [Docker 部署](docs/docker.md) · [支持矩阵](docs/support-matrix.md)
- [Agent 网关：A2A](docs/a2a-gateway.md)
- [配置与数据保留策略](docs/config.md) · [更新日志](CHANGELOG.md) · [反馈问题](https://github.com/null-object-0000/flowlet/issues)

<details>
<summary>从源码运行</summary>

桌面开发使用 Node.js 24+ 和 npm。

```bash
git clone https://github.com/null-object-0000/flowlet.git
cd flowlet
npm ci
npm run fetch:catalogs
npm run desktop:dev
# 仅预览前端：npm run dev:frontend
```

见[架构](docs/architecture.md)、[Electron 宿主](docs/desktop-electron.md)和[发布构建](docs/release-builds.md)。

</details>

[MIT License](LICENSE)
