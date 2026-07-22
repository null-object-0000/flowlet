# 请求明细文件化存储计划

## 1. 背景与目标

Flowlet 当前把请求日志的索引字段、Header、请求 Body 和响应 Body 一并写入
SQLite `request_logs`。Body 使用 Base64 保存，容易让 `flowlet.sqlite` 快速增长；清理
Body 后，SQLite 文件还需要依靠增量回收或完整压缩才能向文件系统归还空间。

本计划将请求明细改为“文件保存完整捕获记录，SQLite 保存查询索引和统计字段”的
混合架构：

- 捕获文件保存一次上游调用 attempt 的完整请求、响应和错误信息；
- SQLite 冗余保存日志列表、筛选、聚合和用量分析所需字段；
- SQLite 不再保存新请求的原始请求 Body 和响应 Body；
- 日志详情、用量重解析等需要 Body 的场景按 SQLite 指针从捕获文件读取；
- 有稳定 Agent Session ID 的请求进入同一逻辑会话流；无 Session ID 的请求进入日期分片；
- 请求明细写入失败不得影响代理转发，也不得把“写入失败”伪装成“未捕获”。

这里的“完整捕获记录”仍严格受 `log_capture` 控制。关闭某项捕获或开启敏感 Header
脱敏后，文件中只能保存配置允许落盘的内容，不得绕过用户配置额外保存原文。

## 2. 非目标

- 不用文件扫描替代请求日志列表、会话聚合、用量成本和筛选查询；
- 不把 Agent 原生会话文件复制进 Flowlet；
- 不改变 OpenAI-compatible / Anthropic-compatible 的代理协议行为；
- 不因为文件写入、压缩、整理或损坏阻塞、失败或中断上游响应；
- 第一阶段不删除 SQLite 旧 Body 列，不做不可回滚的表重建；
- 不保证一个长期会话永远只有一个无限增长的物理文件。

## 3. 目标数据边界

### 3.1 SQLite 继续保存

`request_logs` 继续作为请求 attempt 的查询索引，至少保留：

- `id`、`request_id`、`attempt_seq`、`is_last_attempt`；
- `agent_type`、`agent_session_id`、`parent_agent_session_id`；
- 客户端、渠道、账号、协议、模型和路由字段；
- method、path、完整 `upstream_url`；
- status、错误摘要、TTFB、TTFT、duration、stream 标识和时间；
- `req_headers_json`、`res_headers_json`（第一阶段继续冗余保存，支持现有归因修复和详情快速读取）；
- Body 捕获状态、清理时间和清理原因；
- 捕获文件引用或与引用表的一对一关联。

`usage_records` 继续保存 Token、费用及其分析状态。列表、会话、用量和统计查询不得
依赖扫描捕获文件。

### 3.2 捕获文件保存

每个 attempt 的文件记录至少包含：

- 格式版本、Flowlet 版本、日志 ID、请求 ID、attempt 序号和捕获时间；
- Agent 类型、Session ID、父 Session ID；
- 最终上游 URL、method、协议、渠道、账号和最终模型；
- 路由改写完成后的最终上游请求 Header 和 Body；
- 与该 attempt 对应的第三方响应 Header、Body、状态和错误原文；
- Body 的原始字节长度、实际捕获长度、是否截断、内容类型和内容编码；
- 敏感 Header 是否已脱敏；
- 记录校验和。

Body 在记录内部使用 Base64 表示原始字节，整个记录作为独立压缩帧存储。这样保留
自描述和恢复能力，同时由压缩抵消 JSON/Base64 的大部分体积开销。

## 4. 文件组织与格式

### 4.1 数据目录

捕获目录与 SQLite 数据目录同级，便携版位于 exe 旁，建议命名为：

```text
request-captures/
  sessions/
    <agent-type>/<yyyy-mm>/<session-hash>/000001.flcap
  unassigned/
    <yyyy-mm-dd>/<shard>/000001.flcap
  quarantine/
  tmp/
```

- `session-hash = SHA-256(agent_type + "\0" + session_id)` 的截断值；
- 路径中不得直接使用客户端提供的 Session ID；
- 原始 Session ID 仍写在受捕获策略约束的记录和 SQLite 索引中；
- 无稳定 Session ID 时按日期和固定分片写入，避免单目录产生过多文件。

### 4.2 会话与物理分段

同一 `(agent_type, agent_session_id)` 进入同一逻辑会话流，但物理文件必须轮转：

- 单 segment 建议上限 32 MiB，实测后可在 16–64 MiB 范围调整；
- 日期跨月或达到体积上限后创建下一个递增 segment；
- 单条记录超过 segment 目标大小时允许独占一个 segment；
- 不允许长期会话形成无限增长的单文件。

### 4.3 帧格式

`.flcap` 是仅追加的版本化容器。每条记录使用独立帧，至少包含：

```text
magic | format_version | flags | compressed_length | raw_length | checksum | zstd(json)
```

独立帧允许根据 `offset + length` 随机读取一条详情，无需解压整个会话文件。文件尾部
出现不完整帧时，启动修复只能截断到最后一个校验通过的帧，不能丢弃此前有效记录。

## 5. SQLite 引用模型

优先新增一对一引用表，避免继续扩大 `request_logs` 热表：

```text
request_capture_refs
  request_log_id       PRIMARY KEY -> request_logs.id
  storage_key          相对捕获根目录的规范化路径
  offset               帧起始位置
  length               帧总长度
  checksum             帧或未压缩记录校验和
  format_version       文件格式版本
  state                pending | ready | failed | cleared | corrupt
  failure_reason       可读错误摘要
  finalized_at         完成时间
  created_at / updated_at
```

约束：

- 数据库只保存捕获根目录下的相对路径；读取后必须再次校验规范化路径未逃逸数据目录；
- `ready` 必须同时具备合法位置、长度和校验和；
- `cleared` 表示曾捕获但已按保留策略删除，不等于 `pending`、`failed` 或配置关闭；
- 旧记录没有引用行时，详情读取器才回退到 SQLite 的 `req_body_b64` / `res_body_b64`。

## 6. 写入与崩溃一致性

### 6.1 非流式请求

1. 代理生成 request log ID，并插入不含 Body 的 SQLite 元数据及 `pending` 引用状态；
2. 上游响应完成后，组装该 attempt 的完整捕获记录；
3. 专用文件写入器追加并校验完整帧；
4. SQLite 事务把引用更新为 `ready`，随后完成用量记录；
5. 任一步捕获失败只把状态更新为 `failed` 并记录原因，不改变客户端响应。

### 6.2 流式请求

- 建立上游响应后立即保存可查询元数据，但不把未完成 Body 标记为可用；
- 流式字节继续旁路、有上限地进入现有捕获缓冲，绝不能为落盘而延迟转发；
- 流正常结束后写入完整帧并更新 duration、用量和文件引用；
- 客户端取消、上游断流或应用退出时，允许写入带 `incomplete = true` 的记录；
- 若未形成合法记录，状态明确为 `failed` 或 `pending/interrupted`。

### 6.3 写入器

- 使用 Rust 后端单独的异步写入组件，按 segment 串行追加；
- 设置有界队列和明确的过载指标，队列满时不得无限阻塞代理请求；
- flush/fsync 策略需要基准测试，默认可以批量 flush，但正常退出必须尽力排空队列；
- 请求 Header、Body、API Key 等不得写入普通 tracing 日志作为失败诊断。

### 6.4 启动恢复

启动恢复任务应：

- 检查活跃 segment 尾部并截断不完整帧；
- 将长期停留在 `pending` 的引用标记为 `failed/interrupted`，或按日志 ID 找回已写入帧；
- 识别没有 SQLite 引用的孤儿帧并进入可回收清单；
- 将校验失败的 segment 移入 `quarantine`，保留可读错误，不阻止代理启动；
- 所有恢复动作写入后台任务日志。

## 7. 读取链路

新增统一 `RequestCaptureStore`，业务代码不得自行拼接路径或直接解析 `.flcap`。

读取优先级：

1. `request_capture_refs.state = ready`：按 offset/length 读取并校验文件记录；
2. 没有新引用的历史记录：读取 SQLite 旧 Body 字段；
3. `cleared`：返回清理时间和原因；
4. `failed` / `corrupt` / 文件缺失：返回明确的明细不可用原因；
5. 配置未捕获：保持“未捕获”语义。

需要接入统一读取器的现有链路至少包括：

- 请求日志详情；
- 响应用量重解析和未知用量补齐；
- 数据修复任务；
- 导出、复制和后续会话 Trace；
- 存储占用统计。

请求日志列表继续只读 SQLite，不得因捕获目录很大而变慢。

## 8. 清理、配额与压缩

现有 `body_retention_days`、`body_max_size_mb` 和 `body_prune_ratio` 语义保持不变，
但执行目标从 SQLite Body 改为捕获文件：

- 整个 segment 的所有 Body 都过期时，直接删除 segment 并批量更新引用状态；
- segment 同时包含保留和过期记录时，通过临时文件重写存活帧，成功校验后原子替换；
- 重写时从过期记录中移除请求/响应 Body，但可按配置和产品需要保留 Header 与元数据；
- 文件替换成功后才能提交 SQLite 新 offset 和 `cleared` 状态；
- 崩溃后不得同时把旧、新两个含敏感 Body 的文件长期遗留在数据目录；
- SQLite 增量回收继续用于其他表，但不再承担日常 Body 空间回收。

设置页存储统计需要拆分显示：

- SQLite 文件大小、有效页和空闲页；
- 捕获文件总大小、可回收大小、segment 数和异常文件数；
- Header/元数据与 Body 的估算占用；
- 最近一次捕获整理结果。

“优化存储”最终应同时覆盖 SQLite 压缩和捕获 segment 整理，但两者分阶段执行、分别
报告进度和错误；任一失败都不得破坏另一侧可用数据。

## 9. 安全与隐私

- 保持 `redact_sensitive_headers` 的唯一控制语义，UI 不做第二套脱敏；
- 文件不得保存配置禁止捕获的 Header 或 Body；
- 捕获目录与 SQLite 一样属于敏感本地数据，日志、诊断包和导出前必须明确提示；
- Windows 上使用仅当前用户可访问的合理权限；便携目录权限不可控时在设置页提示风险；
- 校验和只用于损坏检测，不提供保密性；本计划不把加密静默伪装成已完成能力；
- 后续若增加静态加密，密钥不得与捕获文件明文同目录保存；
- 删除/重写必须覆盖所有临时文件、孤儿文件和 quarantine 保留策略，避免绕过 Body 保留期。

## 10. 便携模式、备份与升级

- `flowlet.sqlite`、`request-captures/` 和 `config.json` 构成同一份本地数据集；
- 复制便携目录可整体迁移，SQLite 只保存相对路径；
- 单独复制 SQLite 后，日志列表和用量仍可使用，但详情明确显示捕获文件缺失；
- 单独复制捕获目录不自动导入，需后续提供校验/重建索引工具；
- 应用升级不得删除未知版本捕获文件；格式版本不支持时只读失败并提示升级，不得覆盖；
- 完整备份必须在暂停写入或取得一致性快照后进行。

## 11. 历史数据迁移

迁移必须可中断、可继续，并分成两步：

### 11.1 兼容上线

- 新版本先创建引用表和捕获目录；
- 新请求只把 Body 写入捕获文件，SQLite Body 列保持 `NULL`；
- 详情读取新文件优先、旧 SQLite 回退；
- 旧版应用回退后看不到新 Body，但仍能读取请求元数据，因此发布说明必须明确回退边界。

### 11.2 后台搬迁旧 Body

1. 分批读取仍含 SQLite Body 的旧 attempt；
2. 生成捕获帧并校验可读性；
3. SQLite 事务写入 `ready` 引用；
4. 再把旧 `req_body_b64` / `res_body_b64` 设为 `NULL`；
5. 不写清理原因，因为数据仍然可从文件读取；
6. 记录已处理条数、迁移字节数、失败条数和断点；
7. 全量完成后由现有增量回收逐步归还 SQLite 空闲页，用户仍可主动执行完整优化。

第一阶段保留旧列。只有经过至少一个稳定版本、确认不存在旧版回退和遗漏读取路径后，
才单独评估通过 SQLite 表重建删除旧 Body 列。

## 12. 实施阶段

### Phase 0：基线与原型

- 记录 SQLite Body 数量、字节数、典型 Body 大小和会话分布；
- 用真实 OpenAI JSON、Anthropic JSON、SSE 和二进制/非 UTF-8 Body 验证帧格式；
- 对比 JSONL、独立 zstd 帧的压缩率、随机读取和追加耗时；
- 确定 segment 上限、flush 策略和 Windows 文件替换行为。

完成标准：格式说明和基准结果可复现，损坏尾帧可恢复。

### Phase 1：捕获存储基础设施

- 新增 `RequestCaptureStore`、路径校验、帧编码/解码和 segment 轮转；
- 新增 `request_capture_refs` migration；
- 新增启动恢复、校验和错误状态；
- 单元测试覆盖版本、截断、损坏、并发追加、轮转和路径逃逸。

完成标准：独立测试可稳定追加和随机读取，不接入代理主链路。

### Phase 2：新请求双层写入

- 代理 request/response capture 改为文件写入；
- SQLite 继续写元数据和 Header，但新 Body 列保持 `NULL`；
- 覆盖普通响应、SSE、fallback、多 attempt、取消和错误响应；
- 文件写入失败只改变 capture state，不影响客户端响应。

完成标准：新请求的 SQLite 不含 Body，日志详情仍能完整展示配置允许捕获的内容。

### Phase 3：统一读取与修复链路

- 请求日志详情使用统一读取器；
- 用量重解析、未知用量补齐和导出改为从统一读取器取 Body；
- 前端区分未捕获、写入中、写入失败、已清理、文件损坏和文件缺失；
- 不再让任何业务代码直接依赖 SQLite Body 列。

完成标准：相关 Rust 测试能在 SQLite Body 为 `NULL` 时完成详情和用量重解析。

### Phase 4：清理、统计与运维

- 将保留期和体积配额迁移到捕获文件；
- 实现整 segment 删除、混合 segment 重写和孤儿回收；
- 设置页展示 SQLite 与捕获文件的分项占用；
- 优化存储流程增加捕获整理阶段和可取消进度。

完成标准：清理后 Body 不可通过旧 segment、临时文件或 SQLite 恢复，元数据和用量仍可查询。

### Phase 5：历史 Body 搬迁

- 提供可中断后台迁移任务；
- 校验文件成功后再清空 SQLite Body；
- 迁移失败保留旧 Body 并可重试；
- 完成后验证数据库空间回收和便携目录整体迁移。

完成标准：迁移前后日志详情内容一致，失败不会导致 Body 丢失。

### Phase 6：稳定期收尾

- 观察至少一个稳定版本的损坏率、队列过载、捕获失败和整理耗时；
- 更新 `docs/architecture.md`、`docs/config.md`、设置页说明和发布说明；
- 决定是否移除 SQLite 旧 Body 列；
- 评估 Header 是否也迁出 SQLite，仅保留解析后的归因字段。

## 13. 测试与验收清单

### 正确性

- 每个 fallback attempt 的最终上游请求与对应响应严格配对；
- 请求和响应 Header/Body 捕获开关分别生效；
- 脱敏开关关闭时原样保存，开启时文件与 UI 都只出现 `[redacted]`；
- Body 截断、gzip 响应、SSE、非 UTF-8 和空 Body 行为与现状一致；
- Session ID 相同进入同一逻辑流，不同 Agent 的相同 ID 不混合；
- 无 Session ID 请求可正常记录、查询和清理。

### 故障与恢复

- 文件不可写、磁盘满、队列满、应用崩溃和断电模拟不影响代理响应；
- 尾帧截断、校验失败、文件缺失和路径非法都有明确状态；
- `pending`、孤儿帧、临时文件和 quarantine 可被恢复任务处理；
- 清理和 segment 重写中断后，不出现 SQLite 指向错误 offset 的情况。

### 性能

- 日志列表和用量聚合不扫描捕获文件；
- 代理转发延迟不因 fsync 或压缩出现明显回归；
- 打开单条详情只读取对应帧；
- 长会话通过轮转保持文件大小有界；
- 15 分钟后台清理不会长时间独占 SQLite 锁或阻塞代理。

### 升级与回滚

- 旧数据库原地升级后可继续查询；
- 新旧 Body 混合状态可同时读取；
- 历史搬迁中断后可继续；
- 便携目录整体复制后详情引用仍有效；
- 单独缺失捕获目录时元数据和用量仍可访问。

### 必跑检查

- `cargo fmt --check`；
- `cargo check`；
- 捕获存储、代理、存储和数据修复相关 Rust tests；
- `bun run check`；
- `bun run build`；
- Windows 便携版真实启动、迁移、清理、退出 flush 和目录复制验证。

## 14. 关键决策记录

当前已确认：

1. 采用文件明细 + SQLite 索引的混合架构，不采用纯文件查询；
2. 文件记录完整 attempt，SQLite 可以冗余字段但不再保存新 Body；
3. 同会话使用同一逻辑流，但物理 segment 必须有大小上限；
4. 无 Session ID 的请求仍必须支持；
5. 第一阶段保留 SQLite Header 和旧 Body 列，以兼容现有修复链路和历史数据；
6. 迁移必须先验证文件，再清空 SQLite Body；
7. 捕获故障不得影响代理主链路。

实施前仍需通过 Phase 0 数据决定：

- segment 的最终大小上限；
- zstd 压缩级别与 flush/fsync 批次；
- 捕获队列容量和过载策略；
- 混合 segment 触发重写的存活比例；
- Header 长期是否继续在 SQLite 冗余保存。
