# Roadmap

## 当前判断

Flowlet 已经完成桌面端和本地透明代理的基础雏形，但还不是稳定可用版本。当前阶段路线调整为 LongCat + DeepSeek first：先把 LongCat / DeepSeek OpenAI-compatible、Anthropic-compatible、Claude Code 接入、多账号管理、余额和账号级统计做完整。

旧 Provider 模型已经通过 `refactor/channel-account-model` 重构并合入主线，正式采用 Channel / Account / Model。当前版本仍按 MVP 验证阶段对待，优先收敛主链路：渠道账号、多协议透明转发、账号优先级 fallback、Claude Code、日志与成本。

旧 Provider 原型阶段曾允许破坏式重构；当前 Channel / Account / Model 数据已成为正式基线，后续成本账本必须通过增量 migration 演进，不得重建或丢弃现有 SQLite 数据。

最关键的产品原则：

```text
Flowlet 不应该让普通用户维护 base_url 和模型名。
普通用户应该选择渠道模板，填写 API Key，选择模型；自定义渠道只是高级能力。
Flowlet 应该支持多协议透明转发，但不做跨协议转换；Claude Code 需要通过 Anthropic-compatible 入口接入。
LongCat + DeepSeek first 阶段使用 Channel / Account / Model 三层概念，一个账号只对应一个 API Key。
```

## 已完成基础雏形

- [x] 创建 `README.md`
- [x] 创建 `docs/product.md`
- [x] 创建 `docs/roadmap.md`
- [x] 创建 `docs/architecture.md`
- [x] 初始化 React + TypeScript + Vite 前端骨架
- [x] 初始化 Tauri 2 / Rust 后端骨架
- [x] 增加 `src/`、`src-tauri/`、`docs/` 基础目录结构
- [x] 增加基础开发脚本
- [x] 实现代理状态、启动、停止 Tauri command
- [x] 实现 `127.0.0.1:18640/health`
- [x] 实现 `/v1/*` OpenAI-compatible 透明转发雏形
- [x] 接入 SQLite 配置存储
- [x] 完成 Provider / Client / 虚拟模型基础持久化管理
- [x] 完成 `auto` 顺序路由和受限降级雏形
- [x] 完成成功请求的旁路 metadata 日志
- [x] 补充网络失败请求 metadata 日志
- [x] 补充上游错误响应的日志细节
- [x] 完成 unknown token 离线分析雏形
- [x] 完成普通 JSON 响应的 `response.usage` 旁路提取
- [x] 完成基于已知 token 的成本计算结构
- [x] 完成请求日志 metadata 列表雏形
- [x] 完成桌面端 UI MVP 页面

这些项目代表“骨架和雏形完成”，后续仍需回归验证、产品化交互和异常场景补强。

## 当前阻塞记录

- 2026-07-02：`src-tauri/tauri.conf.json` identifier 调整后，计划再次运行 `cargo check` 复验；当前环境提升权限额度限制导致命令未能执行。下一步恢复权限后优先运行 `cargo check`、`cargo test` 和 `bun run tauri build --debug`。

## Milestone 0：需求校准与文档更新

- [x] 更新 README，明确 LongCat + DeepSeek first
- [x] 更新 `docs/product.md`，补充 LongCat + DeepSeek first / Channel / Account / Model
- [x] 更新 `docs/architecture.md`，补充 Channel / Account / Model 和多协议入口
- [x] 更新 `docs/roadmap.md`，区分“已完成雏形”和“待产品化”
- [x] 修复 `docs/product.md` Markdown 代码块问题
- [x] 新增 `docs/provider-presets.md`
- [x] 新增 `docs/provider-capabilities.md`
- [x] 调整产品边界：LongCat + DeepSeek first，多协议透明转发，不做跨协议转换
- [x] 新增 `docs/longcat-first.md`
- [x] 新增 `docs/deepseek-first.md`
- [x] 调整当前阶段策略为 LongCat + DeepSeek first
- [x] 新增 `docs/breaking-refactor.md`
- [x] 明确第一版允许破坏式重构，不做旧 Provider / SQLite 兼容迁移

## Milestone 0.5：破坏式数据模型重构 ✅

- [x] 删除旧 `ProviderConfig`
- [x] 删除旧 `providers` / `provider_profiles` 表设计
- [x] 删除旧 `provider_id = default` 逻辑
- [x] 删除旧二段 `input_price` / `output_price` 价格结构
- [x] 删除旧单 Provider AppState
- [x] 删除旧 Provider UI
- [x] 定义 `ProtocolType`
- [x] 定义 `ChannelPreset`
- [x] 定义 `ChannelAccount`
- [x] 定义 `ChannelModel`
- [x] 定义 `RouteCandidate`
- [x] 定义三段 `ModelPrice`
- [x] 定义 `AccountBalanceSnapshot`
- [x] 定义带 `channel_id` / `account_id` 的 `RequestLogMetadata`
- [x] 定义带协议和账号维度的 `UsageRecordInput`
- [x] 重建 SQLite 表：`channel_presets`、`channel_accounts`、`channel_models`、`clients`、`virtual_models`、`virtual_model_routes`、`request_logs`、`usage_records`、`model_prices`、`account_balance_snapshots`
- [x] 重构代理层支持多协议入口和多账号路由
- [x] 重构桌面 UI 适配 Channel / Account / Model 三层架构
- [x] 运行 `cargo check` / `cargo test` / `cargo fmt` 通过
- [x] 运行 `bun run check` / `bun run build` 通过

## Milestone 1：LongCat OpenAI-compatible 透明转发 ✅

- [x] 运行 `bun run check`
- [x] 运行 `bun run build`
- [x] 运行 `cargo fmt`
- [x] 运行 `cargo test`
- [x] 运行 `cargo check`
- [x] 支持 LongCat OpenAI base_url (`https://api.longcat.chat/openai`)
- [x] 验证 `/v1/*` OpenAI-compatible 透明转发
- [x] 支持 `/openai/v1/chat/completions`
- [x] 支持 LongCat API Key 替换
- [x] 记录 `channel_id` / `account_id`
- [x] 验证 400 不 fallback
- [x] 验证 429 / 5xx fallback
- [x] 验证 SSE 不解析、不改写
- [x] 复验日志旁路失败不影响主请求链路

## Milestone 2：LongCat Anthropic-compatible 透明转发

- [x] Anthropic-compatible Gateway
- [x] 支持 `/anthropic/v1/*` 透明转发
- [x] 按 Channel Preset 的认证策略替换上游 Header
- [x] LongCat Anthropic 使用 `Authorization: Bearer ...`
- [x] 支持 Claude Code 请求识别
- [x] 不做 Anthropic <-> OpenAI 协议转换

## Milestone 3：LongCat 多账号管理 ✅

- [x] 内置 LongCat Channel Preset
- [x] LongCat 下可新增多个账号
- [x] 一个账号只对应一个 API Key
- [x] 账号支持启用 / 停用
- [x] 账号支持优先级
- [x] 按账号优先级路由
- [x] 失败后 fallback 到下一个账号
- [x] 账号禁用后不参与路由

## Milestone 3.5：DeepSeek 首发渠道支持

- [x] 内置 DeepSeek Channel Preset
- [x] 支持 DeepSeek OpenAI base_url `https://api.deepseek.com`
- [x] 支持 DeepSeek Anthropic base_url `https://api.deepseek.com/anthropic`
- [x] 支持 `deepseek-v4-flash`
- [x] 支持 `deepseek-v4-pro`
- [x] 默认模型调整为 `deepseek-v4-pro`
- [x] 支持 DeepSeek 模型列表同步（`/models`）并写入 `channel_models`
- [x] 支持 DeepSeek 余额查询（`/user/balance`）并自动保存余额快照
- [x] 支持 DeepSeek 三段价格预设
- [x] 支持 DeepSeek Claude Code 接入向导
- [x] DeepSeek 402 / 429 / 500 / 503 支持账号级 fallback
- [x] DeepSeek 403 `account_deactivated` 临时隔离、fallback 与成功探测后自动恢复
- [x] DeepSeek 400 / 401 / 422 不自动 fallback

## Milestone 4：Claude Code 接入向导 ✅

- [x] 检测 Claude Code 是否安装、当前版本、安装位置和多安装候选
- [x] 检测、应用并恢复 Claude Code 用户级全局 Flowlet 配置
- [x] Claude Code 接入向导
- [x] 支持一键复制配置
- [x] 提供 `ANTHROPIC_BASE_URL=http://127.0.0.1:18640/anthropic` 配置提示
- [x] Client Token 支持 `Authorization: Bearer ...`
- [x] Client Token 支持 `X-Api-Key: ...`
- [x] Claude Code 使用 Flowlet Client Token
- [x] Flowlet 转发时替换渠道账号 API Key
- [x] OpenCode CLI / Desktop 共享全局配置检测、应用与恢复
- [x] OpenCode CLI / Desktop 安装位置与版本环境识别
- [x] Agent 接入 Client Token 默认脱敏及手动配置片段对齐
- [x] OpenCode 配置与凭据双文件失败回滚

## Milestone 5：LongCat 模型与价格 ✅

- [x] 内置 LongCat-2.0
- [x] 支持 DeepSeek 模型列表同步
- [x] 支持 LongCat / DeepSeek 价格预设
- [x] 支持 `input_uncached_price`
- [x] 支持 `input_cached_price`
- [x] 支持 `output_price`
- [x] 支持 HTTP 200 成功请求成本估算（通过 response.usage）
- [x] 失败请求不计入成本（无 usage 时标记 unknown）

## Milestone 6：LongCat 余额与资源包快照 ✅

- [x] 支持账号余额手动登记
- [x] 支持 Token 资源包手动登记
- [x] 支持资源包过期时间
- [x] 支持账号维度余额 / 资源包展示
- [x] 支持余额快照记录持久化（account_balance_snapshots 表）
- [x] 账号"登记"按钮打开快照表单，预填最近快照
- [ ] 后续再接入官方查询接口

## Milestone 7：多账号成本与稳定性统计 ✅

- [x] 按账号统计请求数
- [x] 按账号统计 Token
- [x] 按账号统计成本
- [x] 按账号统计失败率
- [x] 按账号统计 fallback 次数
- [x] 展示最近错误
- [x] 新增"账号统计"视图（StatsPanel）

## Milestone 8：统一 AI 成本账本

完整需求、数据模型、阶段范围和验收标准见 [`ai-cost-ledger.md`](./ai-cost-ledger.md)。本 Milestone 中未勾选项均为目标能力，不代表当前已实现。

### Phase 0：语义与迁移设计

- [x] 将完整需求整理为项目产品与技术基线
- [x] 明确当前 `estimated_cost` 仅为公开价估算，目标映射为 `list_price_cost`
- [x] 建立 Flowlet、Codex、Claude Code、OpenCode 只读数据源探针与统一 Observation / Evidence / ProbeReport 契约
- [ ] 冻结金额精度、币种、时区、账期和摊销边界
- [ ] 设计增量 migrations、唯一键、索引和幂等导入策略
- [ ] 为按量、Token 包、订阅和未分配场景建立 Rust 验收夹具

### Phase 1：网关账本 MVP

- [ ] 新增 `cost_sources`、`usage_events`、`agent_tasks`、`agent_sessions`、`cost_allocations`
- [ ] 网关请求幂等映射为统一使用事件
- [ ] 实现独立 `CostAllocationEngine` 和账期版本
- [ ] 支持按量 API、Token 包、固定周期订阅和手动成本来源
- [ ] 分离实际支付、已摊销、已分配、未分配、待摊销和 API 等价价值
- [ ] 将“用量成本”升级为金额优先、可解释的“成本账本”
- [ ] 支持任务、会话和请求三级只读成本归集

### Phase 2：代理外 Agent 使用

- [ ] 建立经用户授权的 Adapter 权限、同步和错误隔离框架
- [ ] 复用 Codex、Claude Code、OpenCode、Pi 本地会话读取能力生成基础使用事件
- [ ] 支持 Token、Credits、操作数和会话数的分配降级
- [ ] 支持手动导入、手动使用记录和同步状态
- [ ] 展示证据等级、分配方法和可信度

### Phase 3：任务管理与成本优化

- [ ] 自动任务识别、任务合并/拆分和会话移动
- [ ] Cursor、GitHub Copilot 等更多 Adapter
- [ ] 账期对比、额度过期预警和套餐利用率
- [ ] 基于明确证据提供套餐与成本优化建议

## 桌面端增强

- [x] 系统托盘（显示/隐藏窗口、启动/停止代理、退出）
- [x] 关闭窗口时最小化到托盘而非退出
- [ ] 开机自启动（tauri-plugin-autostart）实机回归
- [x] 托盘tooltip显示代理状态（运行中/已停止）
- [ ] Agent 终端：在 Flowlet 内通过 PTY 承载受支持的 Agent CLI；不拉起外部终端或外部 Agent 进程，按 [`agent-terminal.md`](./agent-terminal.md) 分阶段实施

## 后续阶段：Docker / Web Console

- [ ] Core 支持 headless 运行（独立于 Tauri GUI）
- [ ] Web Console
- [ ] Docker Compose
- [ ] Volume 持久化
- [ ] 基础访问鉴权

## 配置管理

- [x] 配置导入/导出（JSON 格式，包含渠道/账号/路由/客户端/规则/价格）
- [x] 配置热重载（导入后自动刷新内存状态）

## 可观测性

- [x] Prometheus 指标端点（`/metrics`，请求数/失败数/fallback/Token/成本/活跃请求）
- [x] OpenCode 请求 Header 会话识别（含父会话）
- [x] 基于请求日志聚合 OpenCode 会话、Token、费用和失败数
- [x] 基于 `x-claude-code-session-id` 聚合 Claude Code CLI 会话
- [x] 设置页历史会话归因与用量成本分阶段修复进度
- [x] 通过 OpenCode 本地数据库为 Flowlet 已观测会话补充标题、项目、父会话和原生时间
- [x] 通过 Claude Code JSONL 为 Flowlet 已观测会话补充标题、项目和原生时间
- [x] 主列表仅展示根会话，并在会话详情中展示直接子会话
- [x] 展示未经过 Flowlet 的 OpenCode / Claude Code 原生会话并与请求观测去重合并
- [x] 展示 ChatGPT（Codex）Desktop 原生活跃任务、标题和子任务
- [x] Codex CLI 安装版本与位置检测、接入 Tab 和原生活跃会话
- [x] 会话列表按 Agent 类型与 Flowlet 观测状态独立筛选
- [x] 按需只读展示 OpenCode / Claude Code / Codex 原生消息与工具时间线
- [x] 展示 Agent 原生会话累计用量和单次回复 Token 明细，并与 Flowlet 观测分离
- [x] Codex 原生会话按任务轮次聚合 Token、缓存命中率、总耗时和首 Token 延迟
- [x] 未经过 Flowlet 的 Codex 会话分别估算原币种 API 等价价值与 Codex 套餐 credits 消耗，并展示价格版本与计价覆盖率
- [x] 增量整理 Agent 原生会话快照，支持自动轮询、文件变化触发和失败重试
- [x] 对持续增长的 Codex / Claude JSONL 保存字节游标，只解析上次快照后的新增记录
- [x] 任务日志持久化同步进度、阶段、结果与错误
- [x] Agent 同步批次上限、单会话超时、慢任务指标、取消与任务日志分页清理
- [ ] 导入 OpenCode 原生消息
- [ ] OpenCode 实时 Session Status 与事件订阅

## 安全与限流

- [x] 每客户端速率限制（Token Bucket 算法，默认 600 请求/分钟/客户端）
- [x] API 429 响应 + Retry-After 头
- [x] 配置验证（渠道/账号/API Key/路由引用完整性检查）

## 渠道增强

- [x] 每渠道超时配置（`timeout_seconds`，覆盖全局超时）

## 运维维护

- [x] 请求日志与 Body 清理（按保留策略释放 SQLite 页面）
- [x] 数据库空间维护（旧库一次性完整优化 + 新旧库后续限量增量回收）
- [x] 数据库统计（日志数、用量记录数、文件大小和可回收空间）

## 后续阶段：智能路由

- [ ] 规则路由（按客户端/模型/协议匹配，强制路由到指定渠道账号）
- [x] 请求类型识别（chat/code/reasoning/long_context/tool_use 五类，仅用于日志）
- [ ] 小模型路由判断（短聊天请求自动使用渠道配置的便宜模型）
- [ ] 成本/延迟/成功率综合调度（按账号评分排序候选，低成本高成功率优先）
