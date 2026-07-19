# Flowlet AI Cost Ledger：统一 AI 使用与成本账本

## 1. 文档状态

- 状态：已纳入产品规划；数据源只读探针 v1 已实现，账本持久化与成本引擎尚未实现
- 目标版本：分阶段交付，第一阶段先完成可验证的最小闭环
- 需求来源：2026-07-19 成本账本完整需求整理
- 关联文档：[产品定义](./product.md)、[架构说明](./architecture.md)、[路线图](./roadmap.md)

本文是成本账本的产品与技术基线。实现时如调整成本语义、持久化模型、隐私边界或阶段范围，应同步更新本文、`docs/architecture.md` 和 `docs/roadmap.md`。

---

## 2. 背景与产品目标

Flowlet 当前能够记录经过本地代理的请求，并依据模型 Token 单价计算请求级公开价估算费用。但用户真实支付的 AI 成本还包括 Token 包、固定额度资源包、月度或年度订阅、预付余额、赠送额度，以及 Flowlet 无法自动读取的手动购买服务。

同时，Codex、Claude Code、Cursor、GitHub Copilot、ChatGPT Desktop 等工具可能使用官方账号而不经过 Flowlet 代理。代理流量因此是高精度使用数据的一种来源，但不能成为成本统计的前提。

Flowlet 的长期产品表达调整为：

> Flowlet 是面向 AI Agent 的本地使用与成本控制台，帮助用户了解自己为了每个任务、每个会话和每次请求实际支付了多少钱，以及购买的套餐是否得到充分利用。

成本账本需要回答：

1. 用户在 AI 服务上一共支付了多少钱？
2. 本周期截至今天已经摊销了多少钱？
3. 每个任务、会话和请求分别消耗了多少成本？
4. 某个订阅或资源包是否划算、是否得到充分利用？
5. 哪些额度即将过期或已经形成损失？
6. 未经过 Flowlet 代理的 Agent 使用能否纳入统计？

---

## 3. 产品原则

### 3.1 金额优先，Token 与成本分离

页面优先展示金额。Token、Credits、请求数、操作数和时长是计算依据及解释信息，不等同于用户最终成本。

### 3.2 成本语义不可混用

必须分别表达：

| 概念 | 语义 |
|------|------|
| 实际支付金额 | 用户真实支付的现金 |
| 按量费用 | 某次 API 使用实际产生或可确认的费用 |
| 已摊销成本 | 固定周期套餐截至当前时间已经发生的持有成本 |
| 已分配成本 | 已摊销成本或资源包成本中已归属到使用行为的部分 |
| 未分配成本 | 已摊销但无法归属到具体使用行为的成本 |
| 待摊销成本 | 套餐未来期间对应的成本 |
| API 等价价值 | 按公开 API 单价计算的使用价值 |
| 过期损失 | 额度过期时未使用部分对应的成本 |
| 公开价估算 | 当前 `estimated_cost` 所表示的模型公开价估算 |

不得把以上概念统一显示为“实际费用”。兼容迁移期间，现有 `estimated_cost` 在产品语义上视为 `list_price_cost`，旧字段继续可读，待数据迁移稳定后再决定是否移除。

### 3.3 与网关解耦

账本同时接收两类数据：

```text
代理内使用：精确请求、模型、Token、账号和路由信息
代理外使用：本地 Agent 数据、官方 API、导入或手动记录
```

### 3.4 不伪造精度

只能识别任务级或会话级信息时，就只展示该层级成本。没有请求级证据时不生成虚假请求；没有 Token 时不得把估算 Token 伪装为官方用量。

### 3.5 可解释、可重算、可追踪

每个成本数字都应能展开查看成本来源、计费方式、使用证据、分摊公式、可信度、计算时间、账期和版本。账期内新增使用后允许动态重算，但历史计算依据必须可追踪。

### 3.6 本地优先与最小化采集

外部 Agent 使用记录默认只保存在本机。成本统计优先保存 Session ID、时间、用量汇总、项目和分支；除非用户明确开启，不采集或保存完整 Prompt、Response、对话正文和凭据。

---

## 4. 归集模型

```text
成本来源 Cost Source
  └── 产品 / 账号
        └── 任务 Task
              └── 会话 Session
                    └── 使用事件 Usage Event
```

### 4.1 成本来源

代表用户购买或获得的一项 AI 资源，例如 DeepSeek 按量 API、LongCat Token 包、ChatGPT Pro、Claude Max、Cursor Pro 或 OpenAI 赠送 Credits。

支持类型：

```text
pay_as_you_go
token_pack
subscription
prepaid_credit
free_credit
manual
```

### 4.2 任务

任务是用户主要查看的成本归集对象。第一版识别优先级为：

1. Agent 原生 Task ID；
2. Parent Session；
3. 顶层 Session；
4. Repository + Git Branch + 时间窗口；
5. 用户手动创建、命名或合并。

MVP 先将顶层 Session 作为任务，自动聚类、合并和拆分放到后续阶段。

### 4.3 会话

会话对应 Codex、Claude Code、OpenCode 等 Agent 的一次 Session，尽量记录 Agent 类型、外部 Session ID、父会话、项目目录、仓库、分支、开始/结束时间、操作数、Token/Credits 和所属任务。

### 4.4 使用事件

`usage_event` 是统一的最小使用记录，不强制存在 `request_id`。它可以是网关请求、Agent turn、一次操作、会话汇总、任务汇总、官方用量记录或手动录入。

---

## 5. 成本来源与计算规则

### 5.1 按量 API

```text
按量费用
= 未缓存输入 Token × 未缓存输入单价
+ 缓存输入 Token × 缓存输入单价
+ 输出 Token × 输出单价
```

官方 API 返回实际费用时优先使用官方费用；只有 Token 和价格时记录为高可信度计算值，并保留价格版本和来源。

### 5.2 Token 包

```text
单位成本 = 购买金额 ÷ 总计费额度

计费用量
= 输入 Token × 输入权重
+ 缓存输入 Token × 缓存权重
+ 输出 Token × 输出权重

使用事件分配成本 = 计费用量 × 单位成本
```

多个资源包并存时：

1. 优先采用渠道提供的真实扣减顺序；
2. 无法确认时按最早过期优先（FEFO）；
3. 每次分配记录实际消耗的资源包；
4. 过期的未使用额度进入过期损失，不回摊到历史使用。

### 5.3 固定周期订阅

```text
每日持有成本 = 套餐金额 ÷ 账期总天数
截至今日已摊销 = 每日持有成本 × 已经过天数
待摊销 = 套餐金额 - 已摊销

某使用事件分配成本
= 当前可分配成本 × 事件权重 ÷ 周期内全部事件总权重
```

权重可来自计费 Token、Credits、操作数、会话数、任务数、活跃时长或用户手动权重。周期结束前分配结果可能随新增使用动态变化，必须标记为动态估算。

### 5.4 预付余额、免费额度与手动来源

- 预付余额：优先按实际扣减记录；只有余额快照时可按快照差计算周期成本，但降低可信度。
- 免费额度：`cash_cost = 0`，同时保留公开 API 单价对应的 `equivalent_cost`。
- 手动来源：允许录入名称、金额、币种、账期、额度、单位、账号/产品、备注和分配方法。

### 5.5 套餐内多产品分配

一个来源可覆盖多个产品。用户可以选择全部归属某产品、手动比例或按使用量动态分配。未配置产品分配规则时，不得默认把整个 ChatGPT/Claude 等套餐归属给某个 Agent。

---

## 6. 可信度与证据

每条成本分配记录必须包含 `confidence`、`allocation_method`、证据引用和解释数据。

可信度枚举：

```text
exact
high
medium
low
unallocated
```

分配方式枚举：

```text
metered_actual
token_based
credit_based
operation_based
session_based
task_based
duration_based
manual_ratio
time_amortized
unallocated
```

| 场景 | 建议可信度 |
|------|------------|
| 官方 API 返回实际费用 | exact |
| 网关请求有完整 Token 和可信价格 | high；价格即账单时可为 exact |
| 套餐按完整 Token 或 Credits 分配 | high |
| 只有操作数或会话数 | medium |
| 只有活跃时长 | low / medium |
| 仅知道套餐金额，没有使用信息 | unallocated |

---

## 7. 网关外使用采集

### 7.1 Adapter 边界

规划统一适配器：

```text
CodexUsageAdapter
ClaudeCodeUsageAdapter
OpenCodeUsageAdapter
CursorUsageAdapter
CopilotUsageAdapter
ChatGPTDesktopUsageAdapter
```

Adapter 负责安装和版本检测、经用户授权读取本地会话数据、提取用量与项目上下文、映射为统一 `usage_event`，并保存来源、证据和同步时间。

采集能力按以下顺序降级：

```text
官方 Usage API
本地结构化数据库
本地结构化日志
Agent CLI 输出
进程和会话观察
用户导入
用户手动录入
```

每个 Adapter 使用独立权限与错误边界；单个同步失败不能影响代理、其他 Adapter 或已有账本数据。

### 7.2 Codex 官方账号场景

Codex 可继续通过官方 ChatGPT 账号使用，不要求修改 Base URL 或官方认证。Flowlet 只做经授权的旁路读取：Session、时间、项目/仓库/分支、父子关系、操作数，以及本地确实存在的 Token/Credits 和原始记录引用。

禁止劫持网络请求、修改官方认证、读取或上传凭据，也不得把未公开且不稳定的接口作为唯一数据来源。

### 7.3 授权说明

读取第三方本地数据库或日志前，UI 必须说明读取位置、字段范围、用途、是否上传和关闭方法。默认不开启正文采集。

---

## 8. 目标数据模型

以下是逻辑模型，字段类型、索引和外键在实现设计中确定。所有新增表通过 SQLite migration 增量创建，不重建现有数据库。

### 8.1 `cost_sources`

```text
id, name, type, provider, product, account_id
currency, purchase_amount
starts_at, ends_at
quota_amount, quota_unit, remaining_quota, expires_at
allocation_method, allocation_config_json, product_allocation_json
source, status, remark
created_at, updated_at
```

`source`：`official_api | local_detected | imported | manual`。

### 8.2 `usage_events`

```text
id, source_type, source_adapter, provider, product
account_id, client_id
task_id, session_id, parent_session_id, request_id
agent_type, event_type
project_path, repository, git_branch
started_at, ended_at, duration_ms
input_tokens, input_cached_tokens, input_uncached_tokens
output_tokens, total_tokens
credits_used, operation_count, weighted_usage
evidence_level, raw_source_ref, raw_metadata_json
created_at, updated_at
```

- `source_type`：`gateway | local_cli | desktop_app | official_api | imported | manual`
- `event_type`：`request | operation | session_summary | task_summary | daily_summary | manual_usage`
- `request_id` 可空；只有网关事件或存在真实请求证据时才填写。

### 8.3 `agent_tasks`

```text
id, name, agent_type
repository, git_branch, project_path
started_at, ended_at
detection_method, is_user_edited
created_at, updated_at
```

### 8.4 `agent_sessions`

```text
id, external_session_id, parent_session_id, task_id
agent_type, source_adapter
repository, git_branch, project_path
started_at, ended_at, title
raw_metadata_json
created_at, updated_at
```

当前会话页是请求日志与本地只读目录的查询时聚合，尚无独立表。引入该表时应保留 `(agent_type, external_session_id, source_adapter)` 的稳定去重能力，并支持重复同步幂等更新。

### 8.5 `cost_allocations`

```text
id, cost_source_id, usage_event_id
task_id, session_id, request_id
cash_cost, allocated_cost, equivalent_cost, list_price_cost
allocation_method, allocation_weight, confidence
calculation_period_start, calculation_period_end
allocation_version, calculated_at, explanation_json
created_at, updated_at
```

金额应使用明确精度的定点表示或最小货币单位，不能以未经约束的浮点运算作为最终账本真值。多币种第一阶段按原币种分别汇总；如展示折算总额，汇率来源、时间和版本必须可解释。

---

## 9. 成本计算服务

新增独立 `CostAllocationEngine`，复杂分摊不能继续堆积在请求日志或前端查询展示中。

职责：

1. 读取成本来源和账期内使用事件；
2. 计算实际支付、时间摊销和资源包消耗；
3. 根据分配策略计算权重；
4. 写入带版本和解释的成本分配记录；
5. 聚合任务、会话和请求成本；
6. 只重算受影响账期；
7. 保证相同输入和版本得到确定性结果。

重算触发条件：新增/更新使用事件、Token 分析完成、成本来源或分配规则变化、任务/会话归属变化、导入官方用量、跨天、账期结束和资源包过期。

后端负责确定性公式、事务、精度、版本和持久化；React 负责配置流程、状态、导航、解释展示和用户反馈。这符合 Flowlet 的前端优先原则，同时把数据一致性留在 Rust 边界内。

---

## 10. 页面信息架构

将现有“用量成本”逐步升级为“成本账本”，一级结构为：

```text
成本总览
任务
会话
请求
成本来源
```

### 10.1 成本总览

首要指标：本周期实际支付、截至今日已摊销、已分配使用成本、未分配成本、待摊销成本、API 等价价值。

次要指标：日均成本、平均任务成本、平均会话成本、平均请求成本，并展示套餐利用率、资源包剩余价值、即将过期额度、过期损失、来源/Agent/产品占比和项目/任务排行。

### 10.2 任务、会话和请求

- 任务：名称、Agent、项目/仓库/分支、会话数、事件数、用量、时长、分配成本、等价价值和可信度。
- 会话：Session、Agent、所属任务、时间、时长、事件数、用量、分配成本、等价价值和可信度。
- 请求：仅在存在真实请求级证据时展示实际/分配/等价/公开价费用、成本来源、Token、计费权重、归属、公式和可信度。

后续支持任务重命名、合并/拆分、移动会话和手动成本归属；MVP 先保证查看和基础归属闭环。

### 10.3 成本来源管理

支持新建/编辑来源、金额与账期、账号与产品关联、额度和分配方法、产品比例、已摊销/已分配/剩余金额、到期资源和历史账期。

---

## 11. MVP 范围

### 11.1 必须支持

- 成本来源：按量 API、Token 包、固定周期订阅、手动来源。
- 使用来源：Flowlet 网关请求、现有 Claude Code/OpenCode Session、Codex 本地 Session 基础采集、手动导入或录入。
- 归集层级：请求、会话、顶层 Session 任务。
- 指标：实际支付、已摊销、已分配、未分配、待摊销、API 等价价值及三层平均成本。
- 算法：API Token 计费、Token 包按计费用量分配、订阅按天摊销、订阅按 Token/操作数/会话数分配、闲置成本单列。
- 解释能力：来源、方法、公式、证据、可信度、账期、版本和计算时间。

### 11.2 第一阶段不做

- 自动套餐购买建议；
- 覆盖所有 Agent；
- 云端跨设备同步、团队和多租户；
- 财务级发票或税务核算；
- 第三方应用网络劫持；
- 无证据时精确推算官方账号 Token；
- 自动任务聚类、复杂合并和拆分；
- 隐式多币种汇率折算。

---

## 12. 分阶段实施

### Phase 0：模型与迁移设计

- 先以只读探针验证数据源可行性，冻结统一 `SourceIdentity`、`SessionObservation`、`UsageObservation`、`AccountEntitlement`、`BalanceObservation`、`Evidence` 与 `SourceProbeReport` 契约；
- 冻结金额、账期、时区、币种、资源包消耗和可信度语义；
- 设计 migrations、唯一键、索引、幂等导入和金额精度；
- 将现有 `estimated_cost` 明确映射为 `list_price_cost`；
- 为每种公式先补 Rust 单元测试和验收夹具。

### Phase 1：网关成本账本闭环

- 新增成本来源、使用事件、分配记录和计算引擎；
- 把现有网关请求幂等映射到 `usage_events`；
- 支持按量 API、Token 包、订阅和手动来源；
- 提供成本总览、来源管理以及请求/会话/任务只读归集。

### Phase 2：代理外使用接入

- 复用现有 Codex、Claude Code、OpenCode 本地会话读取能力；
- 经授权持久化会话和基础使用事件；
- 支持 Token/Credits/操作数/会话数的能力降级和可信度展示；
- 支持手动导入、同步状态和 Adapter 错误隔离。

### Phase 3：管理与分析

- 任务自动识别、合并、拆分和移动会话；
- Cursor、GitHub Copilot 等更多 Adapter；
- 账期对比、过期预警、套餐利用率；
- 基于明确证据的成本优化建议。

---

## 13. 验收标准

### 13.1 按量 API

给定完整 Token 和价格的请求，可以看到按公式计算的费用；会话和任务金额等于其下事件金额之和；价格、公式和证据可展开追踪。

### 13.2 Token 包

给定 ¥100、100M 计费 Token 的资源包，使用 10M 后已分配成本为 ¥10、剩余额度价值为 ¥90；额度过期后未使用部分进入过期损失，不回算到历史请求。

### 13.3 月度订阅

给定 ¥300、30 天套餐，每日摊销 ¥10；第 10 天已摊销 ¥100、待摊销 ¥200。若任务权重占 20%，该任务分配 ¥20；无法归属的已摊销金额显示为未分配。

### 13.4 Codex 官方账号

请求不经过 Flowlet 时，仍可在授权后识别 Session 及项目/分支并绑定 ChatGPT 套餐；有 Token/Credits 时按对应用量分配，没有时允许按操作数、会话或时长分配，并明确方法和可信度。

### 13.5 数据不足

只有套餐金额、没有使用数据时，显示实际支付、已摊销、未分配和待摊销；已分配为 0，不生成虚假请求成本。

### 13.6 动态重算

新增事件或修改规则后只重算受影响账期；分配版本更新；任务、会话和请求汇总一致；旧计算依据可追踪。

### 13.7 隔离与隐私

Adapter 失败不影响代理；未经授权不读取第三方数据；默认不保存正文和凭据；关闭 Adapter 后停止继续同步但不静默删除已有账本数据。

---

## 14. 当前实现差距与代码落点

当前状态：

- 已提供只读 `probe_cost_ledger_sources` 探针，统一报告 Flowlet 网关、Codex、Claude Code 与 OpenCode 的字段能力、粒度、去重键、增量游标、格式指纹、缺失字段、可信度和少量无正文样本；
- 探针只返回内存 DTO，不创建账本表、不持久化第三方会话、不返回 Prompt、Response、对话正文、凭据或原始文件路径；样本中的会话汇总以 `is_rollup` 标记，不能与其 turn 样本相加；
- `usage_records.estimated_cost` 是基于运行时模型价格的公开价估算，不是统一账本实际成本；
- 网关请求已具备请求、Token、账号、模型和 Agent Session 归因基础；
- Codex、Claude Code、OpenCode 原生会话已支持只读、尽力而为的查询时聚合；
- 尚无 `cost_sources`、`usage_events`、`agent_tasks`、持久化 `agent_sessions` 或 `cost_allocations`；
- 尚无独立成本分配引擎和账期版本。

实施前重点检查：

```text
src-tauri/src/core/storage.rs
src-tauri/src/core/storage_usage.rs
src-tauri/src/core/usage.rs
src-tauri/src/core/agent_session_metadata.rs
src-tauri/src/core/cost_ledger_source_probe.rs
src-tauri/src/commands.rs

src/domains/cost-ledger/
src/domains/usage/
src/domains/agent-session/
src/features/usage/
src/pages/usage/UsageCostPage.tsx
src/pages/agent-sessions/
src/features/request-logs/
```

实施约束：保留请求日志和现有 `usage_records`；通过迁移新增账本表；网关请求幂等映射为使用事件；核心公式仅在 Rust 实现；前端不复制公式；每种分配方式必须有单元测试；日志保留策略与账本证据保留策略必须明确解耦。

---

## 15. 实施前必须关闭的设计问题

以下问题不阻塞需求入库，但必须在 Phase 0 冻结：

1. 金额存储采用最小货币单位还是定点十进制，以及不同币种的小数精度；
2. 账期按用户本地时区还是来源时区结算，夏令时和首尾日期如何处理；
3. 订阅“已摊销”按自然日、精确秒还是账单日边界计算；
4. 动态分配时“未分配成本”的明确公式，避免把全部已摊销金额强行分完；
5. Token 包部分消耗、退款、续期、叠加包和官方扣减顺序的表达方式；
6. 多币种总览是否只分币种展示，何时引入有版本的汇率快照；
7. 原始证据被清理或第三方日志变化后，已生成分配记录如何保留审计能力；
8. Adapter 授权、暂停、重扫、数据删除与重复导入的完整生命周期。
