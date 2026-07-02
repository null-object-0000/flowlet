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

项目处于早期规划 / 原型阶段。

第一阶段目标是完成一个可运行的桌面端 MVP：

- 启动本地代理服务
- 支持 OpenAI-compatible 请求透明转发
- 支持 Provider/Profile 配置
- 支持 `auto` 虚拟模型
- 支持请求/响应日志落盘
- 支持基础用量和成本统计
