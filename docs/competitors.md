# 竞品分析

## 竞品概览

### TiyGate

- **定位**：通用 AI 网关（桌面端 + 服务端形态）
- **核心能力**：多服务商接入、虚拟模型、路由容灾、完整请求/响应日志、用量统计
- **与 Flowlet 的关系**：方案最接近。Flowlet 在做的事情它基本都覆盖，差异在于 Flowlet 更聚焦 Agent 接入而非通用网关

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

## 竞品接近程度

```text
TiyGate  >  claude-tap  >  CodeBurn  >  CodexBar
```

## 分类标签

| 竞品 | 分类 |
|------|------|
| TiyGate | 通用 AI 网关 |
| claude-tap | Agent Trace 查看器 |
| CodeBurn | Agent 用量/成本分析 |
| CodexBar | Provider 额度与状态菜单栏 |
