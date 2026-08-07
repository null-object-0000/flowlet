# 跨设备任务合并展示与草稿交接方案

> 状态：方案草案  
> 日期：2026-08-06  
> 范围：桌面端之间的项目任务展示、执行设备归属与未执行草稿交接

## 1. 背景

Flowlet 当前存在两条不同的数据通路：

1. **项目工作区同步**：通过 S3 加密工作区对象同步完整项目任务，包含标题、描述、
   状态、任务类型、Agent Profile、父任务、退回原因与执行历史；本机目录、领取租约和
   最近 Job 保持设备本地。
2. **设备快照同步**：通过 LAN / S3 设备快照写入只读 `device_projects`，任务仅包含
   ID、标题、状态、优先级（后端保留写死 P2，前端不再维护）和执行轮次计数，用于跨设备
   发现与移动端观测。

设备快照刻意不携带任务描述和执行历史，因此它适合合并展示，但不足以直接创建一条可执行的
本机任务。此前通过直接复制 SQLite 记录实现“同步”，会造成项目 ID 重映射、重复任务、
来源丢失和删除语义不清，不能作为正式能力。

本文方案的目标是：保持设备快照轻量，在用户明确操作时，将符合条件的其他设备草稿安全地
交给本机执行，并避免任务重复执行或丢失。

## 2. 目标与非目标

### 2.1 目标

- 同一项目看板合并展示本机任务与其他设备任务，按任务 UUID 去重，本机完整记录优先。
- 明确展示任务来源设备与当前执行设备。
- 允许从未执行、无父任务依赖的远端草稿转到本机执行。
- 来源设备对资格进行最终校验，不能仅信任缓存快照。
- 交接过程可重试、幂等、可审计，不因任一步失败导致任务丢失。
- 复用现有签名、加密 LAN 通道，不在设备快照中扩散任务正文。
- 与现有 S3 项目工作区同步、状态机、调度器和软删除墓碑兼容。

### 2.2 非目标

- 不允许迁移已执行任务的 Agent 会话、Job 或运行中进程。
- 不支持有父任务依赖的任务跨设备迁移。
- 不通过普通设备快照同步任务描述、Prompt、执行历史或凭据。
- 第一版不支持来源设备离线时通过 S3 收件箱交接。
- 第一版不支持进行中、待审核或已完成任务更换执行设备。

## 3. 产品规则

### 3.1 可交接资格

来源设备必须在交接时重新读取本机事实表，并同时满足：

```text
deleted = false
status = draft
base_task_id IS NULL
last_job_id IS NULL
execution_history IS NULL OR execution_history = []
rejection_reason IS NULL
不存在有效 claimed_by / claimed_at 租约
不存在未完成的其他 handoff
任务 updated_at 与发起方预期版本一致
```

说明：

- 草稿曾经提交、随后在真正执行前撤回，只要没有 Job 和执行历史，仍可交接。
- 只要执行过一轮，即使后来回到草稿，也不可交接；其后续工作依赖来源设备的会话与运行记录。
- `base_task_id` 非空时不可交接，避免目标设备缺少父任务会话。
- 前端显示的“可转到本机”只是快照提示，来源设备返回的实时校验结果才是最终结论。

### 3.2 项目匹配

目标项目按以下顺序匹配：

1. `workspace_project_id` 相同：自动匹配。
2. 本机只有一个名称规范化后相同且已绑定目录的项目：可预选，但确认框必须展示来源与目标。
3. 存在多个同名项目或没有匹配项：要求用户选择目标项目；未绑定目录的项目不可作为执行目标。

交接后任务的 `project_id` 使用目标设备本机项目 ID，任务 UUID 保持不变。

### 3.3 执行归属

新增持久字段 `execution_device_id` 表示任务被指定在哪台设备执行：

- `NULL`：尚未指定，沿用当前调度行为。
- 当前设备 ID：本机可提交、领取和执行。
- 其他设备 ID：本机只读展示，不提供提交、审核和执行动作。

交接不是普通删除。来源设备保留任务事实，但将执行归属改为目标设备；这样不会产生会通过
项目工作区同步扩散的删除墓碑，也不会因为接收端保存失败而永久丢失任务。

## 4. 数据模型

### 4.1 `project_tasks`

新增：

| 字段 | 类型 | 含义 |
|---|---|---|
| `execution_device_id` | `TEXT NULL` | 任务的指定执行设备；为空表示未指定 |

调度器领取条件增加：

```sql
execution_device_id IS NULL OR execution_device_id = :current_device_id
```

保存、提交、撤回、审核和删除命令必须校验当前设备是否具有写权限。来源设备完成交接后，
仅允许取消未完成交接或展示任务，不允许继续编辑和执行。

### 4.2 `task_handoffs`

新增交接事务表：

| 字段 | 类型 | 含义 |
|---|---|---|
| `transfer_id` | `TEXT PRIMARY KEY` | 客户端生成的幂等 UUID |
| `task_id` | `TEXT NOT NULL` | 任务 UUID |
| `source_device_id` | `TEXT NOT NULL` | 来源设备 |
| `target_device_id` | `TEXT NOT NULL` | 目标设备 |
| `target_project_id` | `TEXT` | 接收端本机项目 ID，仅接收端使用 |
| `expected_updated_at` | `TEXT NOT NULL` | 资格校验时的任务版本 |
| `payload_hash` | `TEXT` | 完整交接负载哈希 |
| `state` | `TEXT NOT NULL` | `prepared` / `received` / `committed` / `cancelled` / `expired` |
| `expires_at` | `TEXT NOT NULL` | prepare 锁超时时间 |
| `created_at` | `TEXT NOT NULL` | 创建时间 |
| `updated_at` | `TEXT NOT NULL` | 最近更新时间 |

同一个 `task_id` 同时最多存在一个未结束交接。建议 prepare 有效期为 10 分钟，过期后允许
重新发起。已提交的 `transfer_id` 重放必须返回同一结果，不重复写任务。

### 4.3 项目工作区对象

`WorkspaceTask` 增加可选 `executionDeviceId`，旧对象缺失时按 `NULL` 处理。该字段参与加密
工作区同步，但不包含任何设备路径或凭据。

合并规则：

- 普通内容仍使用 `updated_at` 的 last-writer-wins。
- 非空 `execution_device_id` 不得被旧版本对象的缺失字段覆盖为空。
- 交接提交产生的新归属优先于交接开始前的同版本普通编辑。
- 删除墓碑仍最高优先级；已删除任务不能交接。

### 4.4 轻量设备快照

设备快照保持不包含描述与执行历史。为改善 UI，可在下一版快照中增加非敏感字段：

```ts
type SyncedProjectTask = {
  id: string;
  title: string;
  status: string;
  priority: string; // 前端已移除优先级能力，后端保留字段写死 P2
  executionCount?: number; // 已开始的执行轮次数，供「第 N 轮执行」展示
  updatedAt: string;
  executionDeviceId?: string | null;
  handoffHint?: "eligible" | "has_parent" | "has_execution" | "not_draft";
};
```

`handoffHint` 只用于决定按钮和提示是否显示，不替代来源设备实时校验。快照 schema 版本升级，
接收旧版快照时字段缺失按 `unknown` 处理，仍允许用户点击后执行 preflight。

## 5. LAN 交接协议

复用现有 `x-flowlet-timestamp`、`x-flowlet-nonce`、`x-flowlet-signature` 和加密响应机制。
新增能力标记 `task.handoff.v1`；未声明能力的设备显示“来源设备版本过旧”。

### 5.1 Preflight / Prepare

```http
POST /flowlet/v1/task/handoff/prepare
```

请求：

```json
{
  "transferId": "uuid",
  "projectId": "source-workspace-project-id",
  "taskId": "task-uuid",
  "expectedUpdatedAt": "2026-08-06T12:00:00Z",
  "targetDeviceId": "target-device-id"
}
```

来源设备在单个 SQLite 事务中：

1. 查找项目和任务；
2. 执行完整资格校验；
3. 创建或复用 `prepared` 交接记录；
4. 返回完整但最小化的任务负载。

响应负载仅包含：任务 UUID、标题、描述、状态、任务类型、Agent Profile、优先级、创建时间、
更新时间、来源项目标识和负载哈希。因为合格任务必然没有父任务、Job、退回原因和执行历史，
这些字段不传输。不得包含目录、API Key、Client Token、请求日志或 Agent 会话正文。

### 5.2 接收端落库

接收端校验：

- 目标项目存在且绑定本机目录；
- 本机不存在不同内容的同 UUID 任务；
- Payload 哈希与来源响应一致；
- 状态仍为 `draft`。

随后在一个本地事务中：

1. 以相同任务 UUID 写入目标项目；
2. 设置 `execution_device_id = current_device_id`；
3. 写入 `task_handoffs.state = received`；
4. 不自动提交，保持草稿等待用户确认。

若本机已存在同 UUID 且内容、来源和目标一致，视为幂等成功；若内容不同，停止并提示冲突。

### 5.3 Commit

```http
POST /flowlet/v1/task/handoff/commit
```

请求包含 `transferId`、`taskId`、`payloadHash` 和目标设备接收回执。来源设备在事务中：

1. 校验 prepare 未过期且哈希一致；
2. 再次确认任务仍为同一版本；
3. 设置 `execution_device_id = target_device_id`；
4. 标记交接 `committed`；
5. 更新任务 `updated_at` 并触发项目工作区推送与设备快照刷新。

来源设备不软删除任务。其看板将任务显示为“已转到〈目标设备〉”，并取消所有本机执行动作。

### 5.4 Cancel / Resume

```http
POST /flowlet/v1/task/handoff/cancel
```

- `prepared` 可安全取消。
- `received` 但未 commit 时，接收端优先重试 commit；用户明确取消时删除接收端尚未提交、
  尚未执行的副本，再通知来源端取消。
- `committed` 不允许通过 cancel 回滚；若要转回，发起一笔新的反向交接。
- 应用重启后扫描未完成交接：`prepared` 等待过期，`received` 自动重试 commit。

## 6. 同一工作区的优化路径

当本机已经通过项目工作区同步获得同 UUID 的完整任务时，不需要再次传输正文：

1. 前端识别本机已有完整任务；
2. 仍向来源设备执行资格校验和 prepare；
3. 本机仅更新 `execution_device_id` 与交接回执；
4. commit 后由工作区同步收敛执行归属。

这一路径在 UI 上仍叫“转到本机执行”，但底层是执行设备归属变更，而不是复制任务。

## 7. 前端交互

### 7.1 看板卡片

- 本机任务：沿用现有卡片和操作。
- 远端任务：展示“其他设备 · 设备名”。
- 远端草稿且快照提示可交接：显示“转到本机”动作。
- 资格未知：允许点击，按钮文案仍为“转到本机”，点击后先做实时 preflight。
- 已执行、有父任务或非草稿：不显示按钮，详情中解释不可转移原因。

### 7.2 确认弹窗

确认内容至少展示：

- 来源设备和来源项目；
- 目标设备和目标项目目录；
- 任务标题与完整 UUID；
- “交接后来源设备不可继续执行，本机仍以草稿保存”的说明。

### 7.3 过程状态

```text
正在检查来源任务
  → 正在接收任务内容
  → 正在确认执行归属
  → 已转到本机（草稿）
```

来源设备离线、版本过旧、任务已变化、资格失效和项目未绑定必须分别提示，不能统一显示
“转移失败”。不得用 `setTimeout` 假装状态已收敛。

## 8. 并发、幂等与失败恢复

| 场景 | 处理 |
|---|---|
| 重复点击“转到本机” | 复用同一 `transfer_id`，返回当前状态 |
| 两台设备同时请求同一任务 | 来源事务只允许第一笔进入 `prepared`，其余返回冲突 |
| prepare 后接收端写入失败 | 来源任务不变；交接过期后可重试 |
| 接收成功、commit 请求丢失 | 接收端保存 `received` 回执并自动重试 commit |
| commit 成功、响应丢失 | 重放同一请求返回 `committed` |
| prepare 后来源任务被编辑 | commit 比对 `updated_at` / payload hash，拒绝提交 |
| 来源设备重启 | `task_handoffs` 持久化，继续处理或等待过期 |
| 工作区同步同时发生 | 归属字段合并规则防止旧对象清空新归属 |
| 目标项目后来解绑目录 | 任务保留草稿，但禁止提交，提示重新绑定 |

## 9. 安全与隐私

- 完整任务正文只在用户主动点击交接后，通过已配对设备的签名加密 LAN 通道传输。
- 请求时间戳、nonce 防重放逻辑沿用现有实现；交接再增加 `transfer_id` 业务幂等。
- 来源端校验目标设备 ID 已存在于已知设备目录，并拥有有效 LAN 描述。
- 日志只记录 transfer ID、任务 ID、来源/目标设备、状态和错误码，不记录任务描述。
- `device_projects.tasks_json` 继续保持轻量，不因本功能加入描述或执行历史。
- 不传输目录路径、凭据、环境变量、请求 Header、Agent 会话正文或后台 Job 输出。

## 10. 错误码建议

| 错误码 | 用户提示 |
|---|---|
| `handoff_source_offline` | 来源设备当前不可达 |
| `handoff_unsupported` | 来源设备版本过旧，不支持任务交接 |
| `handoff_task_not_found` | 来源任务不存在或已删除 |
| `handoff_not_draft` | 只有草稿任务可以转到本机 |
| `handoff_has_parent` | 该任务依赖父任务，需在来源设备继续处理 |
| `handoff_already_executed` | 该任务已有执行记录，需在来源设备继续处理 |
| `handoff_task_changed` | 任务内容已变化，请刷新后重试 |
| `handoff_in_progress` | 该任务正在交接到另一台设备 |
| `handoff_target_unbound` | 目标项目尚未绑定本机目录 |
| `handoff_uuid_conflict` | 本机存在同 ID 的不同任务，未执行覆盖 |
| `handoff_commit_pending` | 任务已接收到本机，正在确认来源归属 |

## 11. 实施拆分

### 阶段 A：资格与归属

- 增加 `execution_device_id` 与 `task_handoffs` 迁移。
- 更新 `ProjectTask`、`WorkspaceTask` 和前端类型。
- 调度器和所有任务 mutation 增加执行设备权限校验。
- 设备快照增加可选归属和资格提示，保持向后兼容。

### 阶段 B：LAN 协议

- 增加 `task.handoff.v1` capability。
- 实现 prepare / commit / cancel handler 与客户端调用。
- 增加 Tauri command 和类型化前端 domain 边界。
- 增加交接恢复扫描与过期清理。

### 阶段 C：桌面 UI

- 远端草稿卡片增加“转到本机”。
- 增加目标项目确认、进度与错误提示。
- 交接成功后只失效当前项目任务、共享设备项目和交接状态 query。
- 来源设备卡片展示“已转到其他设备”，不提供本机执行动作。

### 阶段 D：增强

- 支持同一工作区已存在完整任务时只变更执行归属。
- 支持来源设备离线时的加密 S3 收件箱交接。
- 提供交接记录查看与手动重试入口。

## 12. 测试清单

### Rust 单元与存储测试

- 所有资格条件的允许/拒绝组合。
- prepare 并发互斥、幂等重放和过期恢复。
- received / commit 中断恢复。
- 调度器仅领取归属为空或属于本机的任务。
- 工作区对象新旧版本兼容及归属字段合并。
- 交接不生成删除墓碑。

### LAN 集成测试

- 签名、加密、nonce 防重放。
- capability 不支持、设备离线和超时。
- prepare → receive → commit 完整路径。
- commit 响应丢失后的重试。
- 来源任务在 prepare 后被编辑时拒绝 commit。

### 前端测试

- 远端、本机同 UUID 时本机优先。
- 不同状态和资格提示下按钮显隐正确。
- 远端任务不会触发本机提交、审核或删除 mutation。
- 目标项目匹配、同名冲突和未绑定目录提示。
- 成功后 query 精确失效并展示本机草稿。

### 手工验收

1. 两台桌面设备完成配对并处于同一局域网。
2. 来源设备创建独立草稿，填写描述但不执行。
3. 目标设备看板只通过轻量快照看到摘要。
4. 点击“转到本机”，确认目标项目。
5. 目标设备获得完整描述且仍为草稿；来源设备显示已转移且不可执行。
6. 目标设备提交并执行，确认来源设备不会重复领取。
7. 分别验证有父任务、已执行、来源离线和并发交接的拒绝路径。

## 13. 配置、热更新与升级

- 不新增 `config.json` 字段。
- SQLite 字段和表由应用启动迁移，升级应用后需重启一次完成迁移。
- LAN capability 在进程启动时发布，升级后需要重启来源与目标 Flowlet。
- 设备快照和项目工作区对象均保持旧版本可读；旧客户端只能只读展示，不出现交接动作。
- 第一版上线前不应再通过直接写 SQLite 的方式复制任务。

