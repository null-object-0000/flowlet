# OpenCode 本地集成

> 本文档于 2026-07-21 按当前实现改写。原始设计中的 WAL 实时同步、
> `OpenCodeLocalAdapter` 统一接口、Config Service IPC 读取等方案未被采用；
> 实际落地的是「代理请求头提取 + 请求日志聚合 + 原生只读直读」路线。

## 核心原则

**Flowlet 自动直读，用户零配置。**

前提：Flowlet 必须有运行在用户电脑上的本地进程。纯浏览器网页、纯云端服务无法越过系统权限读取 OpenCode 的本地文件。

用户不需要：

- 填写 OpenCode 地址
- 设置端口
- 复制密码
- 修改 OpenCode 配置
- 手动导入历史会话

Flowlet 启动后自己检测即可。

同时坚持：

- 原生数据源只读，Flowlet 不写入、不修改 OpenCode 的任何文件；
- 原生读取失败不影响 Flowlet 自身的请求聚合结果；
- 不复制消息正文到 Flowlet SQLite，不建立独立会话表；
- 原生指标与 Flowlet 请求观测分栏展示，不相加，避免同一请求重复计算。

## 一、总体架构（当前实现）

```text
OpenCode (CLI / Desktop)
   │
   ├─ 请求头 x-opencode-session / x-parent-session-id
   │       ↓ 经过 Flowlet 本地代理时结构化提取
   │   request_logs.agent_type / agent_session_id / parent_agent_session_id
   │       ↓ GROUP BY (agent_type, agent_session_id)
   │   会话列表「经过 Flowlet」指标：请求数 / Token / 费用 / 失败数
   │
   ├─ opencode.db（session / message / part 表）
   │       ↑ 只读连接，列表与详情按需查询
   │   原生会话目录（标题 / 工作目录 / 父会话 / 时间）
   │   + 原生时间线（消息 / 思考 / 工具事件）+ 原生累计 Token / cost
   │
   └─ opencode.db 所在目录
           ↑ notify 文件监听（仅作「需要重扫」提示）
       前端调度增量同步 → agent_session_snapshots（指纹 + 原生摘要）
```

两类数据按 `(agent_type, session_id)` 去重合并：经过 Flowlet 的会话同时具备请求指标和原生摘要；未经过 Flowlet 的本地会话也会展示，但没有请求、费用和失败指标。

## 二、会话身份提取（代理侧）

OpenCode 请求经过 Flowlet 代理时，`proxy.rs` 的 `extract_agent_session()` 结构化提取会话标识：

- **识别方式**：请求携带 `x-opencode-session` 头，或 User-Agent 包含 `opencode/`；
- **会话 ID 回退顺序**：`x-opencode-session` → `x-session-id` → `x-session-affinity`；
- **父会话**：`x-parent-session-id`；
- 提取结果写入 `request_logs` 的 `agent_type`（`opencode`）、`agent_session_id`、`parent_agent_session_id` 三个字段，并建立 `(agent_type, agent_session_id, created_at)` 索引。

完整 Header / Body 捕获关闭时，会话标识仍然会被提取。会话 ID 经 `valid_session_header()` 校验：去空白、非空、不超过长度上限。

功能上线前的历史请求无法自动具备会话标识；设置页数据修复（见第七节）可从已捕获的 `req_headers_json` 回填归因（`storage_usage.rs` 的 `agent_session_from_json()` 使用与代理相同的 Header 优先级），未捕获请求头的旧请求无法恢复。

## 三、会话列表聚合

**不建立独立 sessions 表。** 会话列表由两路数据合并（`list_agent_sessions` command）：

### 经过 Flowlet 的观测指标

对 `request_logs` 聚合：

```sql
WHERE is_last_attempt = 1 AND agent_session_id IS NOT NULL
GROUP BY agent_type, agent_session_id
LEFT JOIN usage_records ...
```

产出每个会话的客户端、请求数、成功/失败数、输入/缓存/输出 Token、预估费用和最近活动时间。

### 原生会话目录

只读查询 `opencode.db` 的 `session` 表：

```sql
SELECT id, title, directory, parent_id, time_created, time_updated FROM session
```

只取标题、工作目录、父子关系和时间字段；**不读取原生 token / cost 列**——经过 Flowlet 的会话其费用指标以 Flowlet 请求聚合为准。

### 合并规则

- 按 `(agent_type, session_id)` 去重，原生行提供身份，观测行补充指标，并标记 `flowlet_observed`；
- 列表只分页展示没有父会话的主会话（每页最多 8 条，适配桌面窗口高度）；
- 直接子会话通过独立 command（`list_agent_session_children`）在主会话详情中按最近活动排序展示；
- 客户端筛选维度拆分为 Agent 类型和 Flowlet 观测状态（全部 / 经过 Flowlet / 未经过 Flowlet），原生会话不因缺少 `client_id` 被排除；
- 模型不是会话固定属性（一个会话允许切换模型），不作为列表字段展示；
- 清理请求日志会同时移除对应的观测结果。

相关 command：`list_agent_sessions`、`list_agent_session_children`、`list_agent_session_clients`。

## 四、原生数据目录发现与只读直读

### 目录发现

`opencode_database_candidates()` 按顺序尝试以下候选路径（`HashSet` 去重）：

| 优先级 | 路径 | 覆盖 |
|--------|------|------|
| 1 | `~/.local/share/opencode/opencode.db` | CLI 标准布局（Linux） |
| 2 | `<data_dir>/opencode/opencode.db` | CLI 布局（Win: `%APPDATA%\opencode`，macOS: `~/Library/Application Support/opencode`） |
| 3 | `<data_dir>/ai.opencode.desktop/opencode.db` | Desktop 布局 |
| 4 | `<config_dir>/ai.opencode.desktop/opencode.db` | Desktop 备选 |

### 只读连接

```rust
OpenFlags::SQLITE_OPEN_READ_ONLY | SQLITE_OPEN_NO_MUTEX
busy_timeout = 750ms
```

不使用 `immutable=1`：OpenCode 使用 WAL 模式，`immutable` 可能看不到尚未 checkpoint 的数据。

### 时间线直读

会话详情「时间线」Tab 按需调用 `get_agent_session_timeline`（前端 Query，打开详情或手动刷新时才读取）：

```sql
SELECT m.id, m.time_created, m.data, p.id, p.time_created, p.data
FROM message m LEFT JOIN part p ON p.message_id = m.id
WHERE m.session_id = ?1
ORDER BY COALESCE(p.time_created, m.time_created), m.id, p.id
```

- `part.type` 的 text / reasoning / tool 等类型统一映射为六类事件：用户消息、助手回复、思考摘要、工具调用、工具结果、错误（与 Claude Code、Codex 时间线同构）；
- 读取上限：单会话最多扫描 **16 MiB**、返回 **300** 个展示事件、单条事件内容最多 **8000** 字符；达到事件上限后仍继续扫描剩余记录统计轮次与累计用量，详情页提示事件已截断；
- 原生累计用量单独读取：`session` 表的累计 Token / cost 与消息级 tokens；OpenCode 原生提供的 cost 直接展示；
- 内容不写入 Flowlet SQLite；原生源不存在时返回「不可用」空结果，结构不兼容或读取失败时返回可重试错误。

列表页不解析消息正文：同步快照存在时直接使用 `agent_session_snapshots` 的摘要；缺少快照时按可见行懒加载 `get_agent_session_native_summary`（只返回 turn 数、累计用量和模型集合）并缓存 5 分钟。

## 五、变更监听与增量同步

### 文件监听

`agent_source_watcher.rs` 使用 `notify` 监听 opencode.db 所在**父目录**（`NonRecursive`，同时监听 Claude Code 项目目录和 Codex sessions 目录）：

- 只关心扩展名为 `jsonl` / `db` / `sqlite` / `wal` 或文件名为 `session_index.jsonl` 的变化；
- 按 agent_type **去抖 750ms** 后发出 Tauri 事件 `agent-source-changed`；
- 文件事件只作为「需要重新扫描」的提示，不直接触发解析；监听失败时记录警告，轮询兜底仍然有效。

### 前端调度

`AgentDataAutoSync.tsx` 消费事件并调度 `sync_agent_data`：

- 收到文件事件后静默 **8 秒**再触发，触发间隔至少 **30 秒**；
- 轮询兜底：窗口前台每 **1 分钟**、后台每 **5 分钟**，应用启动约 **3 秒**后首次检查，恢复前台时尽快补查。

### 同步快照

同步只在来源指纹变化时更新 `agent_session_snapshots`（PK `(agent_type, session_id)`）：

- 指纹 = `native_updated_at | activity_at | title | project_path`，未读完的增量轮次追加 `|partial:{offset}`；
- 保存内容：指纹、原生摘要 JSON、`source_offset`、`parser_version`、`usage_ids_json`、游标校验值——**不保存消息正文**；
- 文件缩短、游标校验失败或解析器版本升级时自动从头整理；单轮最多读取 16 MiB；
- 已消失或归档的会话快照会被删除；`agent_source_sync_state` 按客户端保存检查时间、扫描数、变化数、失败数和错误；单会话失败不覆盖旧快照，后续检查会重试；
- 同一时刻只允许一个 Agent 同步运行，任务信息落入 `background_jobs`，任务日志页可查看触发方式、进度、结果和错误。

## 六、全局配置与凭据写入

OpenCode CLI 与 Desktop 共用用户级全局配置。Flowlet 在 `~/.config/opencode/opencode.jsonc`（或已有的 `opencode.json`）中结构化合并 `provider.flowlet`、`model` 和 `small_model`，并把 Client Token 单独写入 `~/.local/share/opencode/auth.json` 的 `flowlet` 凭据项；两个文件事务写入，第二个失败时恢复原始字节。完整字段、备份与恢复行为见 [`opencode-global-config.md`](./opencode-global-config.md)。

注意：该链路写入的是用户级配置，不区分 CLI / Desktop，也不读取 Desktop 的 `userData` 目录。

## 七、数据修复

设置页提供显式的本地数据修复（`useDataRepair` 顺序编排四个细粒度 command，时间范围支持最近 1 小时 / 6 小时 / 今天 / 7 天 / 全部）：

| 阶段 | Tauri command | 作用 |
|------|---------------|------|
| 会话归因 | `repair_agent_sessions` | 从已捕获请求头回填会话标识 |
| 用量重解析 | `repair_captured_usage` | 重解析已捕获响应，覆盖范围内已有结果 |
| 未知用量补齐 | `repair_unknown_usage` | 补齐缺失的用量记录 |
| 费用重算 | `repair_usage_costs` | 按当前价格配置重算费用 |

修复直接更新现有 `request_logs` / `usage_records`，不新增会话表，也不需要重启代理。

## 八、与原设计的差异（未实现 / 未采用）

| 原设计 | 当前状态 |
|--------|----------|
| `OpenCodeLocalAdapter` 统一 TS 接口（discoverInstallations / watchSessions 等） | 未采用；能力拆分在 `proxy.rs`、`agent_session_metadata.rs`、`agent_session_timeline.rs`、`storage_tasks.rs` 等 Rust 模块，前端通过类型化 command 调用 |
| 通过 Desktop IPC / Config Service 读取合并后的最终配置 | 未实现；配置写入只操作用户级 `opencode.jsonc`（见第六节） |
| 监听 `opencode.db-wal` 做 300–500ms 增量查询、导入消息到 Flowlet 表 | 未实现；改为目录级 `notify` 提示 + 指纹增量同步，且只同步摘要，不导入消息正文 |
| 读取 Desktop `userData/auth.json` 凭据状态、桥接凭证增删 | 未实现；凭据写入走用户级 `auth.json`，不做凭据状态回读 |
| 修改配置后检测空闲并自动重启 OpenCode | 未实现；配置变更下次启动 / 会话生效 |
| 读取 `session` 表的 cost / tokens_* / agent / model 列 | 未采用；经过 Flowlet 的会话指标以请求聚合为准，原生累计用量仅在详情页展示且不与请求统计相加 |

## 九、后续阶段（规划）

以下能力仍属于后续阶段，优先级低于成本账本主线（见 [`ai-cost-ledger.md`](./ai-cost-ledger.md)）：

- **消息正文导入 / 完整会话同步**：当前时间线按需只读、不落库；若成本账本需要任务级证据，再评估导入边界（默认仍应最小化采集、显式授权）；
- **配置变更生效提示**：检测 OpenCode 运行状态并提示「下次会话生效」或空闲时重载；
- **原生运行态信息**：排队、等待授权、流式中 token 等运行态不在 SQLite 中，需要 OpenCode Server API，当前不做。
