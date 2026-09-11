# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.1] - 2026-09-11

0.1.0 之后的第二个正式公开版本，补齐 Agent 生态、渠道与模型目录，并统一了内置插件契约。

### 新增渠道与模型

- 新增 Z.AI（智谱）渠道，支持 API 按量付费账号与控制台用量抓取；
- 千问新增免费额度账号与 Token Plan 套餐账号，并展示套餐过期、未订阅状态；
- 模型目录扩展：DeepSeek V4.1 Flash、DeepSeek V4 Pro 日期快照与视觉实验模型、
  GLM-5.3 与 GLM-5.3 Flash、Qwen3.8 Flash、NVIDIA Nemotron 3 系列、OpenRouter ox-alpha；
- 模型身份改为规范 ID 与厂商官方 API 名双侧归一匹配；价格支持生效时间与高峰/空闲时段。

### Agent 接入

- 新增 DeepSeek Harness 与 Hermes Agent 接入；DeepSeek Harness 支持精确会话关联、
  模型规格声明、交互确认桥与 MCP 服务器四项可选高级能力（默认关闭、可独立开关与恢复）；
- 新增 Codex 账号观测：订阅用量、套餐、Credits，以及刷新、重新授权和删除；
- OpenCode 与 Pi 可按真实路由声明输入模态；Agent 运行时状态与安装方式（含 npx）探测更完整。

### 代理与运行时

- 支持上游代理配置，并为托管子进程注入代理环境变量；
- Windows 绑定 Job Object，Flowlet 异常退出时回收托管子进程；
- Linux 与 macOS 使用文件锁保证单实例运行；改善 Wayland 兼容、窗口缩放与 Linux 便携版一键更新。

### 会话、任务与用量

- 会话详情合并对话与轨迹视图，会话列表读取增加缓存；远端设备会话与最近交互事件可跨设备合并；
- 后台任务统一为 JobDefinition / JobRuntime，具备并发上限与重试策略；
- Agent 原生用量支持按官方公开价估算等价费用，并支持多币种拆分与分时价格；
- 修复用量洞察页品牌图标：按客户端时 DeepSeek Harness、Hermes Agent 缺少 logo，
  按渠道账号时 Codex Desktop、Codex CLI、Claude Code 原生等 Agent 原生账号全部退化为首字母徽标。

### 工程

- 新增根目录 `plugin-registry.json`，统一声明内置渠道与 Agent 贡献，并补充注册表契约测试；
- 前端依赖方向与 workspaces 统一，安装包自动构建流程完善，Android 版本自动同步到蒲公英。

### 分发说明

- 提供 Windows x64 安装包与便携版、Android arm64 APK，并由 GitHub Actions 构建 Linux x64、macOS Apple Silicon 与 Intel 产物；
- 当前主要开发与完整回归环境为 Windows 11 原生环境（未启用 WSL）；Linux 与 macOS 尚未完成作者真机回归验证；
- Windows 桌面产物尚未签名；macOS DMG 使用 ad-hoc 签名但尚未经过 Apple 公证，
  首次启动可能需要手动放行。

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

[0.1.1]: https://github.com/null-object-0000/flowlet/releases/tag/v0.1.1
[0.1.0]: https://github.com/null-object-0000/flowlet/releases/tag/v0.1.0
