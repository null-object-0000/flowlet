# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-08-10

Flowlet 的首个正式公开版本。

### 主要功能

- 提供 OpenAI Chat Completions、Anthropic Messages 与无状态 OpenAI Responses 本地代理入口；
- 管理 LongCat、DeepSeek、Kimi、Qwen、Z.AI、OpenRouter 与自定义渠道账号；
- 从上游同步模型并显式选择开放模型，支持多账号候选、优先级与失败降级；
- 提供 `flowlet-pro` / `flowlet-flash` 聚合模型和 14 个规范化模型；
- 一键接入 Claude Code、OpenCode、Pi 与 Codex CLI / Desktop / VS Code 插件；
- 查看请求日志、Agent 原生会话、Token 用量、预估费用、余额与套餐资源；
- 支持本地请求捕获、历史数据维护、可选 S3 多设备用量同步和 Windows 便携模式。

### 分发说明

- GitHub Actions 构建 Windows x64、Linux x64、macOS Apple Silicon 与 macOS Intel 产物；
- Windows 同时提供 NSIS、MSI 和便携版 ZIP；
- 当前桌面产物尚未签名，操作系统可能显示未知发布者提示。

[0.1.0]: https://github.com/null-object-0000/flowlet/releases/tag/v0.1.0
