# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.1] - Unreleased

当前开发迭代统一计入 0.1.1。

## [0.1.0] - 2026-08-11

Flowlet 的首个正式公开版本。

### 主要功能

- 提供 OpenAI Chat Completions、Anthropic Messages 与无状态 OpenAI Responses 本地代理入口，保持协议与响应原貌；
- 统一管理多个模型渠道与账号，按需开放模型，并支持虚拟模型、多候选路由和失败降级；
- 一键接入 Claude Code、Codex、OpenCode 与 Pi，支持配置检查、备份、写入和恢复；
- 将 Agent 会话、实际请求、路由结果、Token 与费用关联起来，便于定位失败和核对消耗；
- 可把代码修改或分析任务交给本机 Agent 执行，并进行排队、审核、退回续跑和历史追踪；
- 提供按模型、账号、客户端和设备统计的用量与性能洞察；
- 支持自有 S3 多设备同步与局域网直连，并提供实验性 Android 移动辅助端。

### 分发说明

- 提供 Windows x64 安装包与便携版、Android arm64 APK，并由 GitHub Actions 构建 Linux x64、macOS Apple Silicon 与 Intel 产物；
- 当前主要开发与完整回归环境为 Windows 11 原生环境（未启用 WSL）；Linux 与 macOS 尚未完成作者真机回归验证；
- Windows 桌面产物尚未签名；macOS DMG 使用 ad-hoc 签名但尚未经过 Apple 公证，
  首次启动可能需要手动放行。

[0.1.1]: https://github.com/null-object-0000/flowlet/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/null-object-0000/flowlet/releases/tag/v0.1.0
