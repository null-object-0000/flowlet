# Flowlet 架构说明

## 目标

Flowlet 的第一阶段目标是做一个桌面优先、本地运行、OpenAI-compatible 透明转发的 AI 请求路由客户端。

架构设计必须服务于以下边界：

- 不做协议转换。
- 响应零改写。
- 请求侧只做 base_url、Authorization/Header 和可选 model 映射。
- 日志旁路记录，失败不能影响主请求链路。
- Token 和成本分析走离线任务，不能阻塞真实请求。
- 第一阶段只支持 OpenAI-compatible 透明转发。

## 总体结构

```text
Flowlet Desktop
  ├─ src/                         React + TypeScript + Vite 前端
  ├─ src-tauri/                   Tauri 2 桌面壳
  │  └─ src/
  │     ├─ lib.rs                 Tauri 应用入口和 command 注册
  │     ├─ main.rs                桌面进程入口
  │     └─ core/
  │        ├─ mod.rs              Core 模块出口
  │        ├─ config.rs           Provider、Client、虚拟模型等配置结构
  │        └─ proxy.rs            本地代理服务
  └─ docs/                        产品和架构文档
```

## 运行时端口

```text
127.0.0.1:11434  OpenAI-compatible 透明代理端口
```

后续如需要管理 API，优先通过 Tauri command 给桌面 UI 使用；Docker / Web Console 阶段再引入独立管理端口。

## 请求链路

```text
Claude Code / Cursor / Cline / Open WebUI / Cherry Studio / Continue
        ↓
http://127.0.0.1:11434/v1/*
        ↓
Flowlet Local Proxy
        ↓
OpenAI-compatible Provider
```

代理只在请求侧做有限处理：

- 根据配置选择 Provider。
- 将本地 `/v1/*` 路径拼接到 Provider `base_url`。
- 替换上游 `Authorization` Header。
- 必要时将虚拟模型名映射为上游模型名。

响应侧不做业务改写：

- 不改 status code。
- 不改 response body。
- 不包装错误。
- 不补 `usage`。
- 不解析或重组 SSE。

## Core 模块

### config

保存第一阶段需要的基础配置结构：

- Provider 配置。
- Client Token 配置。
- 虚拟模型配置。
- 虚拟模型候选路由。

第一版可以先使用内存配置，后续落 SQLite。API Key 字段保留独立类型，方便后续接入系统密钥链或本地加密。

### proxy

负责本地监听和透明转发：

- `/health` 返回本地服务健康状态。
- `/v1/*` 透明转发到 OpenAI-compatible Provider。
- 普通响应直接透传。
- 流式响应使用上游字节流直接返回，不能缓存完整响应后再返回。
- 旁路生成 metadata 日志事件，日志失败不影响响应。

### storage

第四阶段加入 SQLite，建议表包括：

- `providers`
- `clients`
- `virtual_models`
- `virtual_model_routes`
- `request_logs`
- `usage_records`
- `model_prices`

### analyzer

第六阶段加入离线分析任务：

- 优先从 `response.usage` 提取 token。
- 没有 usage 时标记为 `unknown`。
- 根据 `model_prices` 计算成本。
- 支持按日期、Provider、模型、客户端聚合。

## 桌面端 UI

第一阶段 UI 只做管理和状态展示，不承载复杂平台能力：

- 首页展示代理状态。
- 启动 / 停止本地代理。
- Provider 管理。
- Client Token 管理。
- 虚拟模型管理。
- 请求日志。
- 基础用量统计。
- 一键复制 Base URL。
- 一键复制 Client Token。

全部界面文案使用中文。

## 非目标

第一阶段明确不做：

- Anthropic / Gemini / OpenAI 之间协议转换。
- Docker / Web Console。
- 云端账号系统。
- 团队计费系统。
- MCP / Prompt / Skills / Sessions 管理。
- Provider marketplace。
- 复杂智能路由和小模型路由判断。
