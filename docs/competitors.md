# 竞品分析

## 竞品清单

| 竞品 | 核心定位 | 与 Flowlet 的关系 |
|------|----------|-------------------|
| CC Switch | AI 编程工具供应商、代理与配置管理 | 产品形态和功能模块高度重合 |
| AIUsage | AI 订阅账号、Agent 代理与用量分析 | 账号、模型服务、Agent 接入和观测主链路高度重合 |
| TiyGate | 通用 AI 网关、模型路由与日志 | 网关架构高度重合 |
| claude-tap | Claude Code 请求与 Agent Trace 查看 | 请求日志、调试能力重合 |
| CodeBurn | AI 编程用量与成本分析 | 用量成本模块重合 |
| CodexBar | 多 Provider 额度与状态查看 | 轻量状态监控参考 |

## 接近程度

```text
CC Switch  ≈  AIUsage  >  TiyGate  >  claude-tap  >  CodeBurn  >  CodexBar
```

---

## 详细分析

### CC Switch

- **定位**：AI 编程工具的供应商、代理与配置管理
- **核心能力**：
  - 多工具、多供应商账号管理与一键切换
  - 本地代理、格式转换、故障转移、熔断和供应商健康监控
  - 请求日志、Token 用量和成本统计
  - MCP、Prompts、Skills 的统一配置与同步
- **覆盖工具**：Claude Code、Claude Desktop、Codex、Gemini CLI、OpenCode、OpenClaw、Hermes Agent
- **与 Flowlet 的关系**：产品形态和功能模块高度重合。不只是简单切换 API Key，而是覆盖了「模型服务—渠道账号—请求日志—用量成本—客户端接入」全链路，是 Flowlet 当前最直接的竞品

### AIUsage

- **定位**：面向 macOS 的 AI 订阅账号、Agent 代理和用量分析桌面应用
- **核心能力**：
  - 统一管理 12+ Provider 的多账号、额度、成本和凭据
  - 为 Claude Code、Codex CLI、OpenCode、Claude Science 提供独立本地代理和上游切换
  - 通过 Unified API Providers 将一份 Base URL、协议、Key、模型和价格配置分发到多个 Agent
  - 可选托管 CLIProxyAPI sidecar，提供 OAuth 账号池、模型发现和 OpenAI/Anthropic/Gemini 多协议 API
  - 从本地会话与代理记录统计 Token、成本及 MCP、Skill、Tool 调用
  - 自动合并或接管 Agent 配置，并支持从 CC Switch 导入部分 Provider
- **覆盖工具**：Claude Code、Codex CLI、OpenCode、Claude Science；CPA Gateway 还可向其他 API 客户端暴露端点
- **与 Flowlet 的关系**：与 Flowlet 的「渠道账号—开放模型—本地代理—Agent 接入—用量观测」主链路高度重合，是直接竞品。AIUsage 当前优势在多订阅额度聚合、Agent 配置写入和调用分析；Flowlet 的差异方向是 Windows/macOS/Linux 跨平台、协议原生透传，以及围绕统一开放模型和 Agent Session/Trace 的深度整合
- **边界差异**：AIUsage 当前仅支持 macOS 14+，并接受 Claude→OpenAI 等跨协议转换及 CLIProxyAPI sidecar；Flowlet 当前坚持 OpenAI/Anthropic 协议内透传，不以跨协议转换为目标

### TiyGate

- **定位**：通用 AI 网关（桌面端 + 服务端形态）
- **核心能力**：多服务商接入、虚拟模型、路由容灾、完整请求/响应日志、用量统计
- **与 Flowlet 的关系**：网关架构高度重合。Flowlet 与它的差异在于更聚焦 Agent 接入而非通用网关能力

### claude-tap

- **定位**：本地代理 + Agent Trace 查看器
- **核心能力**：查看真实 API 流量、System Prompt、对话历史、工具调用、流式响应、Token 用量、请求 Diff
- **与 Flowlet 的关系**：在 Agent 会话观测和 Trace 维度高度重合。Flowlet 后续的 Agent Session / Trace 能力可直接对标

### CodeBurn

- **定位**：AI 编程工具的用量与成本分析
- **核心能力**：按工具、模型、项目、任务统计 Token 和费用，数据本地读取，不走代理
- **与 Flowlet 的关系**：在用量统计方面有重叠，但 CodeBurn 偏事后分析，Flowlet 偏实时观测 + 代理层联动

### CodexBar

- **定位**：轻量桌面菜单栏工具
- **核心能力**：在菜单栏查看 Codex、Claude、Cursor、Gemini 等 Provider 的额度、使用量、重置时间、服务状态
- **与 Flowlet 的关系**：在 Provider 额度和余额展示上重叠，但 CodexBar 是纯展示型，不做代理也不做配置管理

## 分类标签

| 竞品 | 分类 |
|------|------|
| CC Switch | 供应商代理与配置管理 |
| AIUsage | 订阅账号、Agent 代理与用量分析 |
| TiyGate | 通用 AI 网关 |
| claude-tap | Agent Trace 查看器 |
| CodeBurn | Agent 用量/成本分析 |
| CodexBar | Provider 额度与状态菜单栏 |
