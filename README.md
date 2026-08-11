<div align="center">
  <img src="public/flowlet-logo.png" width="112" alt="Flowlet Logo" />
  <h1>Flowlet</h1>
  <p><strong>让多个 AI Agent 共用一个可控、可追溯的本地模型入口。</strong></p>
  <p>一次接入，统一切换；请求失败知道原因，Token 和费用知道花在哪。</p>
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

## 下载

| 系统 | 下载 |
| --- | --- |
| Windows | [![安装版 EXE x64](https://img.shields.io/badge/安装版-EXE_x64-2563eb?style=flat-square&logo=windows11&logoColor=white)](https://github.com/null-object-0000/flowlet/releases/download/v0.1.0/Flowlet_0.1.0_windows_x64-setup.exe) [![安装版 MSI x64](https://img.shields.io/badge/安装版-MSI_x64-2563eb?style=flat-square&logo=windows11&logoColor=white)](https://github.com/null-object-0000/flowlet/releases/download/v0.1.0/Flowlet_0.1.0_windows_x64.msi) [![便携版 ZIP x64](https://img.shields.io/badge/便携版-ZIP_x64-0891b2?style=flat-square&logo=windows11&logoColor=white)](https://github.com/null-object-0000/flowlet/releases/download/v0.1.0/Flowlet_0.1.0_x64_portable.zip) |
| Android | [![APK arm64](https://img.shields.io/badge/移动辅助端-APK_arm64-22a559?style=flat-square&logo=android&logoColor=white)](https://github.com/null-object-0000/flowlet/releases/download/v0.1.0/Flowlet_0.1.0_arm64.apk) |
| macOS | [![DMG Apple Silicon](https://img.shields.io/badge/DMG-Apple_Silicon-111111?style=flat-square&logo=apple&logoColor=white)](https://github.com/null-object-0000/flowlet/releases/download/v0.1.0/Flowlet_0.1.0_darwin_aarch64.dmg) [![DMG Intel x64](https://img.shields.io/badge/DMG-Intel_x64-555555?style=flat-square&logo=apple&logoColor=white)](https://github.com/null-object-0000/flowlet/releases/download/v0.1.0/Flowlet_0.1.0_darwin_x64.dmg) |
| Linux | [![AppImage x64](https://img.shields.io/badge/AppImage-x64-e95420?style=flat-square&logo=linux&logoColor=white)](https://github.com/null-object-0000/flowlet/releases/download/v0.1.0/Flowlet_0.1.0_linux_amd64.AppImage) [![DEB x64](https://img.shields.io/badge/DEB-x64-dc3545?style=flat-square&logo=debian&logoColor=white)](https://github.com/null-object-0000/flowlet/releases/download/v0.1.0/Flowlet_0.1.0_linux_amd64.deb) |

> Android 版是实验性移动辅助端；本地代理、渠道账号与模型管理仍需使用桌面版。macOS、Linux
> 与桌面安装包当前尚未完成代码签名，系统可能显示未知开发者或未知发布者提示。

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

### 让 Agent 在项目中完成任务

绑定本机项目目录，用看板把代码修改或只读分析任务交给 Claude Code、Codex、OpenCode 或 Pi。
Flowlet 负责排队执行、人工审核、退回续跑和执行记录，请求、会话与用量会自动留下证据。

### 从手机查看并轻量操作

Release 同时提供实验性 Android 移动辅助端，可通过自有 S3 与局域网查看多设备用量、会话和 Agent 状态，
也可提交项目任务或远程处理 Agent 的交互确认（当前已支持 OpenCode 权限请求）。移动端当前
仍是实验性能力，不替代桌面端代理和账号管理。

## 开始使用

1. 从 [GitHub Releases](https://github.com/null-object-0000/flowlet/releases) 下载桌面端或 Android 移动辅助端；
2. 添加一个渠道账号，拉取并选择需要开放的模型；
3. 在概览页选择你的 Agent，一键接入 Flowlet；
4. 回到 Agent 正常工作，在 Flowlet 中查看请求、会话和用量。

> [!NOTE]
> 当前主要开发与回归环境是 **Windows 11 原生环境（未启用 WSL）**。macOS 与 Linux
> 版本由 GitHub Actions 自动构建，但尚未完成作者真机回归验证；后续完成对应环境测试后
> 会更新支持状态。当前桌面产物尚未签名，系统也可能显示“未知发布者”提示。

## 本地优先

Flowlet 默认只在本机保存渠道 API Key、Client Token、配置和使用数据。多设备 S3 同步是
可选能力，且不会同步请求正文、凭据或渠道账号。

请求捕获可能包含敏感 Header 和 Body；如果不需要完整排障信息，可以在“设置 → 数据捕获”
中开启敏感 Header 脱敏或关闭相应捕获。

## 了解更多

- [支持的渠道、模型、协议与 Agent](docs/support-matrix.md)
- [配置与数据保留策略](docs/config.md)
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
