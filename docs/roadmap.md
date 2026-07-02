# Roadmap

## 当前进度

- [x] 创建 `README.md`
- [x] 创建 `docs/product.md`
- [x] 创建 `docs/roadmap.md`
- [x] 创建 `docs/architecture.md`
- [x] 初始化 React + TypeScript + Vite 前端骨架
- [x] 初始化 Tauri 2 / Rust 后端骨架
- [x] 增加 `src/`、`src-tauri/`、`docs/` 基础目录结构
- [x] 增加基础开发脚本
- [x] 实现代理状态、启动、停止 Tauri command
- [x] 实现 `127.0.0.1:11434/health`
- [x] 实现 `/v1/*` OpenAI-compatible 透明转发雏形
- [x] 接入 SQLite 配置存储
- [x] 完成 Provider / Client / 虚拟模型基础持久化管理
- [x] 完成 `auto` 顺序路由和受限降级雏形
- [x] 完成成功请求的旁路 metadata 日志
- [x] 补充网络失败请求 metadata 日志
- [x] 补充上游错误响应的日志细节
- [x] 完成 unknown token 离线分析雏形
- [x] 完成普通 JSON 响应的 response.usage 旁路提取
- [x] 完成基于已知 token 的成本计算结构
- [x] 完成请求日志 metadata 列表雏形
- [x] 完成桌面端 UI MVP 页面

## 当前阻塞记录

- 2026-07-02：`src-tauri/tauri.conf.json` identifier 调整后，计划再次运行 `cargo check` 复验；当前环境提升权限额度限制导致命令未能执行。下一步恢复权限后优先运行 `cargo check`、`cargo test` 和 `bun run tauri build --debug`。

## 阶段一：项目初始化与文档

- [x] 创建 README.md
- [x] 创建 docs/product.md
- [x] 创建 docs/roadmap.md
- [x] 创建 docs/architecture.md
- [x] 明确产品定位、核心原则、MVP 范围、第一阶段不做什么、后续路线
- [x] 所有文档使用中文

## 阶段二：桌面端技术骨架

- [x] Tauri 2 桌面项目
- [x] React + TypeScript + Vite 前端
- [x] Rust 后端 Core
- [x] 基础目录结构
- [x] 基础开发脚本
- [x] Vite 本地启动验证
- [x] Tauri debug 构建验证

## 阶段三：本地代理 Core MVP

- [x] 默认监听 `127.0.0.1:11434`
- [x] 支持 `/health`
- [x] 支持 `/v1/*` 路径透明转发雏形
- [x] 支持配置一个 OpenAI-compatible Provider
- [x] 请求侧替换上游 base_url 和 Authorization Header
- [x] 流式响应使用上游字节流返回，不缓存完整响应
- [x] 补充 `auto` 路由和受限降级单元测试
- [x] 补充透明转发集成回归测试
- [x] 增加成功请求日志旁路事件，不影响主链路
- [x] 增加网络失败请求日志旁路事件，不影响主链路

## 阶段四：配置与数据存储

- [x] 使用 SQLite 保存基础配置
- [x] providers
- [x] clients
- [x] virtual_models
- [x] virtual_model_routes
- [x] request_logs
- [x] usage_records
- [x] model_prices
- [x] API Key 字段预留加密能力
- [x] Provider 基础管理 Tauri command
- [x] 虚拟模型 auto 路由基础管理 Tauri command
- [x] Client Token 基础管理 Tauri command
- [x] 价格表管理 Tauri command

## 阶段五：虚拟模型 auto

- [x] 对外模型名 `auto`
- [x] `auto` 映射到一个或多个上游模型候选
- [x] 第一版顺序路由
- [x] 429、5xx、network error 尝试下一个候选
- [x] 400、参数错误、协议不匹配、上下文超长不自动降级
- [x] 日志记录 public_model、upstream_model、provider、fallback_count、route_reason
- [x] quota exceeded 文本识别
- [x] timeout fallback 雏形
- [x] timeout UI 配置

## 阶段六：日志与离线分析

- 成功请求默认 metadata 日志
- 失败请求默认 metadata 日志
- 完整请求/响应日志结构预留
- [x] 离线 response.usage 提取雏形
- [x] unknown token 标记
- [x] 基础用量统计查询
- [x] 基础成本统计结构
- [x] response.usage 成本落库雏形

## 阶段七：桌面端 UI MVP

- 首页展示代理服务状态
- 启动 / 停止本地代理
- Provider 管理页
- Client Token 管理页雏形
- 虚拟模型管理页
- 请求日志页 metadata 雏形
- 基础用量统计页雏形
- 一键复制 Base URL
- 一键复制 Client Token

## 后续阶段：Docker / Web Console

- Core 支持 headless 运行
- Web Console
- Docker Compose
- Volume 持久化
- 基础访问鉴权

## 后续阶段：智能路由

- 规则路由
- 请求类型识别
- 小模型路由判断
- 成本 / 延迟 / 成功率综合调度
