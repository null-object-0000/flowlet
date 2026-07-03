# 破坏式重构实施计划

> 本文档定义 Flowlet 破坏式重构的具体实施步骤、顺序和验证标准。

---

## 总体策略

- **破坏式重构**：不兼容旧 Provider 原型、不做旧 SQLite 表迁移
- **分步实施**：每步完成后运行 `cargo check` 确认编译通过
- **测试驱动**：核心路由逻辑必须有单元测试
- **文档先行**：先写设计文档，再写代码

---

## Phase 1: 数据模型层（config.rs + storage.rs）

### Step 1.1: 替换 config.rs

**目标**：删除旧 `ProviderConfig`、`ModelPrice`、`VirtualModelRoute`，替换为新结构。

**变更清单**：
- [ ] 删除 `ProviderConfig`
- [ ] 删除旧 `ModelPrice`（input_price/output_price）
- [ ] 删除旧 `VirtualModelRoute`（含 provider_name）
- [ ] 新增 `ProtocolType` 枚举
- [ ] 新增 `PriceSource` 枚举
- [ ] 新增 `ChannelPreset`
- [ ] 新增 `ChannelAccount`
- [ ] 新增 `ChannelModel`
- [ ] 新增 `RouteCandidate`（四元组）
- [ ] 新增新 `ModelPrice`（三段价格）
- [ ] 新增 `AccountBalanceSnapshot`
- [ ] 保留 `ClientConfig`（微调）
- [ ] 保留 `VirtualModel`（微调）
- [ ] 新增 `RequestLogRow`（含 channel_id/account_id/protocol）
- [ ] 新增 `UsageRecordRow`（含 channel_id/account_id/protocol）

**验证**：`cargo check` 通过

---

### Step 1.2: 替换 storage.rs

**目标**：重建 SQLite 表，实现新结构的 CRUD。

**变更清单**：
- [ ] 删除旧 `providers` 表
- [ ] 删除旧 `model_prices` 表（二段价格）
- [ ] 删除旧 `virtual_model_routes` 表（含 provider_name）
- [ ] 新增 `channel_presets` 表
- [ ] 新增 `channel_accounts` 表
- [ ] 新增 `channel_models` 表
- [ ] 新增 `model_prices` 表（三段价格）
- [ ] 新增 `account_balance_snapshots` 表
- [ ] 新增 `app_meta` 表
- [ ] 更新 `clients` 表（保持不变）
- [ ] 更新 `virtual_models` 表（保持不变）
- [ ] 更新 `virtual_model_routes` 表（新结构）
- [ ] 更新 `request_logs` 表（新字段）
- [ ] 更新 `usage_records` 表（新字段）
- [ ] 启用 WAL 模式
- [ ] 实现 `migrate()` 函数
- [ ] 实现各表 CRUD 方法
- [ ] 删除 `get_provider` / `save_provider` 方法
- [ ] 新增 `list_channel_presets` / `save_channel_presets`
- [ ] 新增 `list_channel_accounts` / `save_channel_accounts`
- [ ] 新增 `list_channel_models` / `save_channel_models`
- [ ] 新增 `list_route_candidates` / `save_route_candidates`
- [ ] 新增 `list_model_prices` / `save_model_prices`
- [ ] 新增 `list_balance_snapshots` / `save_balance_snapshot`
- [ ] 更新 `insert_request_log` 方法
- [ ] 更新 `analyze_unknown_usage` 方法
- [ ] 更新 `upsert_usage_record` 方法
- [ ] 更新 `recalculate_usage_costs` 方法（三段价格）
- [ ] 更新 `usage_summary` 方法（JOIN channel/account）
- [ ] 更新 `list_request_logs` 方法（JOIN channel/account/client）

**验证**：`cargo check` 通过

---

## Phase 2: 代理层（proxy.rs）

### Step 2.1: 重构协议入口

**变更清单**：
- [ ] 新增 `/openai/v1/{*path}` 路由
- [ ] 新增 `/anthropic/v1/{*path}` 路由
- [ ] 新增 `classify_protocol` 函数
- [ ] 新增 `forward_anthropic_compatible` handler

**验证**：`cargo check` 通过

---

### Step 2.2: 重构路由逻辑

**变更清单**：
- [ ] 删除旧 `route_candidates` 函数
- [ ] 新增 `match_candidates` 函数（按 virtual_model + protocol 匹配）
- [ ] 新增 `resolve_direct_model` 函数
- [ ] 新增 `build_openai_url` 函数
- [ ] 新增 `build_anthropic_url` 函数
- [ ] 更新 `apply_headers` 函数（支持 X-Api-Key）
- [ ] 更新 `identify_client` 函数（支持 X-Api-Key）
- [ ] 更新 `rewrite_model` 函数（支持 Anthropic body）
- [ ] 更新 `should_try_next_status` 函数（支持 DeepSeek 402）

**验证**：`cargo check` 通过

---

### Step 2.3: 重构请求转发

**变更清单**：
- [ ] 更新 `forward_openai_compatible` handler
- [ ] 新增 `forward_anthropic_compatible` handler
- [ ] 更新 `build_response` 函数（新日志字段）
- [ ] 更新 `build_buffered_response` 函数
- [ ] 新增 `build_streaming_response` 函数
- [ ] 更新 `record_request_metadata` 函数
- [ ] 更新 `extract_response_usage` 函数（支持 Anthropic usage）

**验证**：`cargo check` 通过

---

### Step 2.4: 补充单元测试

**变更清单**：
- [ ] `classify_protocol_identifies_anthropic_paths`
- [ ] `classify_protocol_identifies_openai_paths`
- [ ] `match_candidates_filters_by_protocol_and_virtual_model`
- [ ] `match_candidates_sorts_by_priority`
- [ ] `apply_request_headers_replaces_authorization_for_openai`
- [ ] `apply_request_headers_replaces_x_api_key_for_anthropic`
- [ ] `should_try_next_status_handles_deepseek_402`
- [ ] `build_openai_url_strips_v1_prefix`
- [ ] `build_anthropic_url_strips_anthropic_prefix`

**验证**：`cargo test` 全部通过

---

## Phase 3: Tauri 命令层（lib.rs）

### Step 3.1: 更新 AppState

**变更清单**：
- [ ] 删除 `provider: Arc<Mutex<ProviderConfig>>`
- [ ] 新增 `channels: Arc<Mutex<Vec<ChannelPreset>>>`
- [ ] 新增 `accounts: Arc<Mutex<Vec<ChannelAccount>>>`
- [ ] 新增 `models: Arc<Mutex<Vec<ChannelModel>>>`
- [ ] 更新 `routes` 类型为 `Vec<RouteCandidate>`
- [ ] 更新 `prices` 类型为新的 `ModelPrice`
- [ ] 保留 `clients`
- [ ] 保留 `storage`

**验证**：`cargo check` 通过

---

### Step 3.2: 更新 Tauri Commands

**变更清单**：
- [ ] 删除 `get_provider` / `save_provider`
- [ ] 新增 `list_channel_presets` / `save_channel_presets`
- [ ] 新增 `list_channel_accounts` / `save_channel_accounts`
- [ ] 新增 `list_channel_models` / `save_channel_models`
- [ ] 更新 `list_virtual_model_routes` → `list_route_candidates`
- [ ] 更新 `save_virtual_model_routes` → `save_route_candidates`
- [ ] 更新 `list_model_prices` / `save_model_prices`
- [ ] 新增 `list_balance_snapshots` / `save_balance_snapshot`
- [ ] 更新 `start_proxy` 参数
- [ ] 更新 `analyze_usage` 逻辑
- [ ] 更新 `usage_summary` 逻辑
- [ ] 更新 `list_request_logs` 逻辑
- [ ] 新增 `test_channel_connection`

**验证**：`cargo check` 通过

---

## Phase 4: 桌面 UI 层（main.tsx）

### Step 4.1: 类型定义

**变更清单**：
- [ ] 更新 `main.tsx` 中的 TypeScript 类型
- [ ] 新增 `ChannelPreset` 类型
- [ ] 新增 `ChannelAccount` 类型
- [ ] 新增 `ChannelModel` 类型
- [ ] 新增 `RouteCandidate` 类型
- [ ] 新增 `ModelPrice` 类型（三段价格）
- [ ] 新增 `AccountBalanceSnapshot` 类型
- [ ] 更新 `RequestLogRow` 类型
- [ ] 更新 `UsageSummaryRow` 类型

**验证**：`bun run check` 通过

---

### Step 4.2: 页面组件

**变更清单**：
- [ ] 更新概览页（渠道/账号数量）
- [ ] 新增渠道账号页
- [ ] 新增 Claude Code 页
- [ ] 更新客户端 Token 页
- [ ] 新增路由配置页
- [ ] 更新请求日志页
- [ ] 更新用量统计页
- [ ] 新增设置页

**验证**：`bun run build` 通过

---

## Phase 5: 集成验证

### Step 5.1: 编译验证

```bash
bun run check        # TypeScript 类型检查
bun run build         # 前端构建
cargo fmt             # Rust 格式化
cargo check           # Rust 编译检查
cargo test            # Rust 单元测试
```

### Step 5.2: 功能验证

- [ ] 启动代理
- [ ] 访问 `/health`
- [ ] 发送 OpenAI-compatible 请求
- [ ] 发送 Anthropic-compatible 请求
- [ ] 验证 429 fallback
- [ ] 验证 400 不 fallback
- [ ] 验证日志记录
- [ ] 验证用量统计

---

## Phase 6: 文档更新

- [ ] 更新 README.md
- [ ] 更新 docs/architecture.md
- [ ] 更新 docs/roadmap.md
- [ ] 标记 Milestone 0.5 完成

---

## 风险与缓解

| 风险 | 缓解措施 |
|------|----------|
| 重构范围过大 | 分 Phase 实施，每 Phase 可独立验证 |
| 数据丢失 | 破坏式重构，旧数据不保留 |
| 编译错误 | 每步后立即 `cargo check` |
| 测试覆盖不足 | 核心路由逻辑必须有单元测试 |
| UI 交互复杂 | 先实现基础 CRUD，后续迭代优化 |

---

## 完成标准

1. `bun run check` 通过
2. `bun run build` 通过
3. `cargo fmt` 无警告
4. `cargo check` 通过
5. `cargo test` 全部通过
6. 手动验证代理转发正常
7. 文档更新完成
