# Flowlet

Flowlet 是一个桌面优先的本地 AI 请求路由客户端。

它让 Claude Code、Cursor、Cline、Open WebUI、Cherry Studio 等 AI 工具统一接入一个本地入口，并在不做协议转换、不改写响应内容的前提下，实现 Provider 管理、虚拟模型路由、请求日志和 Token 成本分析。

## 产品原则

- 不做协议转换
- 响应零改写
- 请求侧只做轻量路由和必要 Header 替换
- 日志旁路记录，不影响主请求链路
- Token 和成本通过离线分析完成
- 桌面客户端优先，Docker / Web Console 后续支持

## 核心能力

- 本地代理入口
- Provider 配置管理
- Client Token 管理
- 虚拟模型，例如 `auto`
- 免费额度优先与失败降级
- 请求日志查看
- Token / 成本分析
- 桌面端可视化管理
- 后续支持 Docker 部署和 Web 访问

## 当前状态

项目处于早期原型阶段，已经完成第一阶段文档和桌面端技术骨架的初始落地。

当前已完成：

- 中文 README、产品文档、路线图和架构文档
- Tauri 2 + React + TypeScript + Vite 项目骨架
- Rust Core 基础目录结构
- 本地代理启动 / 停止 / 状态 Tauri command
- `127.0.0.1:11434/health`
- `/v1/*` OpenAI-compatible 透明转发雏形
- Provider 基础内存配置
- SQLite 基础配置存储
- `auto` 虚拟模型顺序路由雏形
- 429、5xx、network error 的受限 fallback
- 成功请求和网络失败请求 metadata 日志旁路
- Client Token 请求来源识别
- 离线 unknown 用量分析和基础统计查询雏形
- 普通 JSON 响应的 `response.usage` 旁路提取
- 手动模型价格表和基于已知 Token 的成本重算结构
- 桌面首页中文 UI 雏形

第一阶段继续推进目标：

- 启动本地代理服务
- 支持 OpenAI-compatible 请求透明转发
- 支持 Provider/Profile 配置
- 支持 `auto` 虚拟模型
- 支持请求/响应日志落盘
- 支持基础用量和成本统计

## 当前透明转发边界

- 第一阶段只支持 OpenAI-compatible `/v1/*`。
- 请求侧仅做 Provider base_url 替换、Authorization 替换和 `auto` 的 model 映射。
- 上游返回的最终响应按原 status、headers、body 流式返回。
- 普通 JSON 响应会旁路复制最多 1MB 响应体用于离线 `usage` 提取；SSE 流式响应不解析。
- 日志写入走旁路，失败不影响主请求链路。
- `auto` 当前只做顺序候选：429、5xx、network error 会尝试下一个候选；400、参数错误、协议不匹配、上下文超长不自动降级。

## 本地开发

前端依赖使用 bun：

```bash
bun install
bun run check
bun run build
```

Rust Core 检查：

```bash
cd src-tauri
cargo fmt
cargo check
```

桌面开发启动：

```bash
bun run tauri:dev
```
