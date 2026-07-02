# Roadmap

## 当前判断

Flowlet 已经完成桌面端和本地透明代理的基础雏形，但还不是稳定可用版本。当前阶段路线调整为 LongCat + DeepSeek first：先把 LongCat / DeepSeek OpenAI-compatible、Anthropic-compatible、Claude Code 接入、多账号管理、余额和账号级统计做完整。

第一版正式实现允许破坏式重构：不兼容旧 Provider 原型、不做旧 SQLite 表迁移，直接使用 Channel / Account / Model 数据模型。详细策略见 [breaking-refactor.md](./breaking-refactor.md)。

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
- [x] 实现 `127.0.0.1:11434/health`
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

## Milestone 0.5：破坏式数据模型重构

- [ ] 删除旧 `ProviderConfig`
- [ ] 删除旧 `providers` / `provider_profiles` 表设计
- [ ] 删除旧 `provider_id = default` 逻辑
- [ ] 删除旧二段 `input_price` / `output_price` 价格结构
- [ ] 删除旧单 Provider AppState
- [ ] 删除旧 Provider UI
- [ ] 定义 `ProtocolType`
- [ ] 定义 `ChannelPreset`
- [ ] 定义 `ChannelAccount`
- [ ] 定义 `ChannelModel`
- [ ] 定义 `RouteCandidate`
- [ ] 定义三段 `ModelPrice`
- [ ] 定义 `AccountBalanceSnapshot`
- [ ] 定义带 `channel_id` / `account_id` 的 `RequestLogMetadata`
- [ ] 定义带协议和账号维度的 `UsageRecordInput`
- [ ] 重建 SQLite 表：`channel_presets`、`channel_accounts`、`channel_models`、`clients`、`virtual_models`、`virtual_model_routes`、`request_logs`、`usage_records`、`model_prices`、`account_balance_snapshots`

## Milestone 1：LongCat OpenAI-compatible 透明转发

- [ ] 运行 `bun run check`
- [ ] 运行 `bun run build`
- [ ] 运行 `cargo fmt`
- [ ] 运行 `cargo test`
- [ ] 运行 `cargo check`
- [ ] 验证 `/health`
- [ ] 支持 LongCat OpenAI base_url
- [ ] 验证 `/v1/*` OpenAI-compatible 透明转发
- [ ] 支持 `/openai/v1/chat/completions`
- [ ] 支持 LongCat API Key 替换
- [ ] 记录 `channel_id` / `account_id`
- [ ] 验证 400 不 fallback
- [ ] 验证 429 / 5xx fallback
- [ ] 验证 SSE 不解析、不改写
- [ ] 复验日志旁路失败不影响主请求链路

## Milestone 2：LongCat Anthropic-compatible 透明转发

- [ ] Anthropic-compatible Gateway
- [ ] 支持 `/anthropic/v1/messages` 透明转发
- [ ] 支持 `/anthropic/v1/models` 透明转发
- [ ] 支持 Anthropic 请求头透传
- [ ] 支持 Claude Code 请求
- [ ] 不做 Anthropic <-> OpenAI 协议转换

## Milestone 3：LongCat 多账号管理

- [ ] 内置 LongCat Channel Preset
- [ ] LongCat 下可新增多个账号
- [ ] 一个账号只对应一个 API Key
- [ ] 账号支持启用 / 停用
- [ ] 账号支持优先级
- [ ] 按账号优先级路由
- [ ] 失败后 fallback 到下一个账号
- [ ] 账号禁用后不参与路由

## Milestone 3.5：DeepSeek 首发渠道支持

- [ ] 内置 DeepSeek Channel Preset
- [ ] 支持 DeepSeek OpenAI base_url `https://api.deepseek.com`
- [ ] 支持 DeepSeek Anthropic base_url `https://api.deepseek.com/anthropic`
- [ ] 支持 `deepseek-v4-flash`
- [ ] 支持 `deepseek-v4-pro`
- [ ] 支持 DeepSeek 模型列表同步
- [ ] 支持 DeepSeek 余额查询
- [ ] 支持 DeepSeek 三段价格预设
- [ ] 支持 DeepSeek Claude Code 接入向导
- [ ] DeepSeek 402 / 429 / 500 / 503 支持账号级 fallback
- [ ] DeepSeek 400 / 401 / 422 不自动 fallback

## Milestone 4：Claude Code 接入向导

- [ ] Claude Code 接入向导
- [ ] 生成 Claude Code `settings.json`
- [ ] 支持一键复制
- [ ] 提供 `ANTHROPIC_BASE_URL=http://127.0.0.1:11434/anthropic` 配置提示
- [ ] Client Token 支持 `Authorization: Bearer ...`
- [ ] Client Token 支持 `X-Api-Key: ...`
- [ ] Claude Code 使用 Flowlet Client Token
- [ ] Flowlet 转发时替换 LongCat API Key

## Milestone 5：LongCat 模型与价格

- [ ] 内置 LongCat-2.0
- [ ] 支持模型列表同步
- [ ] 支持模型详情同步
- [ ] 支持 LongCat 价格预设
- [ ] 支持 `input_uncached_price`
- [ ] 支持 `input_cached_price`
- [ ] 支持 `output_price`
- [ ] 支持 HTTP 200 成功请求成本估算
- [ ] 失败请求不计入成本

## Milestone 6：LongCat 余额与资源包快照

- [ ] 支持账号余额手动登记
- [ ] 支持 Token 资源包手动登记
- [ ] 支持资源包过期时间
- [ ] 支持账号维度余额 / 资源包展示
- [ ] 后续再接入官方查询接口

## Milestone 7：多账号成本与稳定性统计

- [ ] 按账号统计请求数
- [ ] 按账号统计 Token
- [ ] 按账号统计成本
- [ ] 按账号统计失败率
- [ ] 按账号统计 fallback 次数
- [ ] 展示最近错误

## 后续阶段：Docker / Web Console

- [ ] Core 支持 headless 运行
- [ ] Web Console
- [ ] Docker Compose
- [ ] Volume 持久化
- [ ] 基础访问鉴权

## 后续阶段：智能路由

- [ ] 规则路由
- [ ] 请求类型识别
- [ ] 小模型路由判断
- [ ] 成本 / 延迟 / 成功率综合调度
