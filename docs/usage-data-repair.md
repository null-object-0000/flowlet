# 本机用量历史整理与核验

本文用于在另一台 Flowlet 设备（例如公司电脑 `changen-work`）上整理历史 Token
数据。目标是尽可能恢复真实的上游消耗，同时保留无法确认的记录，不用猜测值填充历史。

## 1. 统计口径

用量成本页选择“本机”时，Token 由两个互斥来源合并：

- **经过 Flowlet**：来自 `usage_records`，记录代理实际完成的上游调用；
- **Agent 原生**：来自 `agent_usage_events`，只纳入未被 Flowlet 观测的本地 Agent
  交互。

已带 Flowlet 会话标识的请求不会再作为 Agent 原生用量叠加。Claude Code 的
`away_summary`、客户端重试、未被 transcript 采纳但确实经过代理的响应仍属于真实上游
调用，因此可能使 Flowlet 汇总高于 Claude Code transcript。这不等于重复计数。

Token 汇总可用于日常用量分析；页面中的费用是按当前渠道价格计算的估算值，不等同于
渠道账单、套餐扣减或最终支付金额。

## 2. 适用场景

以下情况应执行一次“全部时间”整理：

- 从旧版升级到包含 Agent 原生逐事件账本的新版本；
- 历史请求曾保留响应 Body，但当时未识别出 usage；
- Token 解析、渠道价格或会话归因规则升级；
- 新设备首次统一整理旧数据库；
- 用量页存在较多“未知记录”。

修复能力受原始数据限制：

- 有完整响应捕获时，可以用当前解析器重新计算 Token；
- Body 已清理时，不能从请求内容反推出可靠的响应 usage；
- 本地 Agent transcript 仅在会话、模型和请求时间窗能够唯一对应时用于回填；
  存在多个候选或无法定位原始会话时仍只用于审计；
- 无法确认的记录必须继续标记为未知，不得填 0 或估算 Token。

## 3. 版本前置条件

先安装或运行包含以下能力的同一版本 Flowlet：

- Anthropic usage 以 `input_tokens` 为未缓存基值，避免兼容上游泄漏
  `prompt_tokens` 时重复计算缓存输入；
- `agent_usage_events` 原生用量逐事件账本；
- 设置页“数据维护”四阶段修复；
- 当前设备快照能够携带 `native_*` 用量字段。

不要在旧可执行文件上先整理数据库，再用新版本重新解释结果。公司电脑和其他设备应先
升级到同一发布版本，再执行维护。

## 4. 修复前备份

推荐安排一个短维护窗口：

1. 确认没有必须持续运行的 Agent 请求；
2. 从托盘执行“退出 Flowlet”，让代理和 SQLite 写入完全停止；
3. 备份实际数据目录中的 `flowlet.sqlite`；
4. 同时备份同目录的 `request-captures/`；
5. 备份目录名带设备名和时间，例如
   `changen-work-pre-usage-repair-YYYYMMDD-HHMMSS/`；
6. 重新启动 Flowlet。

便携版的数据通常位于可执行文件旁；安装版以“设置 → 存储管理”显示的实际数据位置为
准，不要根据另一台机器的路径猜测。

`flowlet.sqlite` 和 `request-captures/` 必须来自同一时间点。不要只复制正在写入的
SQLite 文件；无法停机时应使用 SQLite 在线备份 API，而不是普通文件复制。

## 5. 执行历史整理

打开：

```text
应用设置 → 数据维护 → 数据完整性检查
```

选择“全部时间”，点击“开始检查”。前端按顺序执行：

1. **会话归因**：按已保存 Header 和最新识别规则修复历史会话；
2. **Token 用量**：读取最终 attempt 的完整响应捕获，用当前解析器覆盖或补齐
   `usage_records`；历史流式捕获被截断时，按同一 Agent 会话、模型和请求执行时间窗
   匹配唯一的原生消息级用量，歧义记录自动跳过；
3. **未知记录**：为仍无可解析 usage 的请求建立明确的未知记录；
4. **预估费用**：按当前渠道、模型和价格配置重新计算费用。

四个阶段全部显示“已完成”后再离开页面。修复使用事务更新，不删除原始请求日志，代理
无需重启。

随后进入“会话管理”点击“同步数据”，确保 Claude Code、Codex、OpenCode 和 Pi 的本地
来源按当前解析器重新整理。超大会话可能需要多轮同步追平；可在“任务日志”查看剩余、
警告和失败项。

## 6. 修复后核验

至少检查以下内容：

- 用量成本页选择“本机”，热力图和汇总卡不再长时间显示旧缓存；
- 最近新请求的输入、缓存输入、未缓存输入和输出与 Agent 原生记录一致；
- Flowlet 已观测会话没有再次出现在“未经过 Flowlet”的原生来源中；
- `away_summary`、重试和未采纳响应仍保留为经过 Flowlet 的真实调用；
- 未返回 usage 的请求仍显示为未知，而不是 0 Token；
- 数据库 `PRAGMA integrity_check` 返回 `ok`，`PRAGMA foreign_key_check` 无结果；
- 重新生成或同步设备快照后，移动端和其他设备看到的该设备汇总一致。

建议记录以下修复前后数字，便于审计：

- `request_logs`、`usage_records`、`agent_usage_events` 行数；
- 已知 Token 总量与未知记录数；
- 有完整响应捕获的最终请求数；
- 本次补齐的用量记录数；
- 修复后的数据库完整性结果。

## 7. 如何判断差异

### Flowlet 高于 transcript

先检查是否来自以下真实调用：

- Claude Code `away_summary`；
- 客户端主动重试；
- 上游返回成功，但客户端未采纳或未写入 transcript；
- Agent 子任务或内部模型调用。

这些请求只要确实经过上游，就应计入 Flowlet。不能仅因 transcript 没有普通 assistant
记录而删除。

### Flowlet 低于 transcript

常见原因：

- 响应未返回 usage；
- 流式响应不完整；
- 历史 Body 已清理；
- 请求未经过 Flowlet，且 Agent 原生同步尚未完成；
- 原生数据源已移动、归档或不可访问。

优先修复数据来源和同步状态。无法恢复时保留未知，接受总量可能略低估。

### transcript 回填

transcript 唯一匹配回填已纳入“Token 用量”维护阶段，但只有同时满足以下条件才会执行：

- 会话 ID、模型和请求时间窗能唯一对应；
- 能区分正式响应、内部摘要、重试和未采纳响应；
- 歧义记录全部跳过。

不得按整段时间窗口比例缩放，也不得只按行序盲目对齐。

## 8. 回滚

如果修复后发现异常：

1. 退出 Flowlet；
2. 保存当前异常数据库供排查；
3. 恢复同一备份集中的 `flowlet.sqlite` 与 `request-captures/`；
4. 启动 Flowlet；
5. 检查代理状态、请求日志和用量页。

回滚只影响本机日志与统计数据，不应替换 `config.json`，除非备份计划明确包含并要求恢复
配置。

## 9. 实现入口

- 前端编排：`src/features/settings/useDataRepair.ts`
- Tauri command：`src-tauri/src/commands/usage.rs`
- 捕获响应重解析：`Storage::reanalyze_captured_usage`
- Agent 原生会话唯一匹配回填：`Storage::repair_usage_from_native_sessions`
- 未知用量补齐：`Storage::analyze_unknown_usage`
- 费用重算：`Storage::recalculate_usage_costs`
- 原生用量账本：`agent_usage_events`
- 捕获文件：数据库同目录的 `request-captures/`

## 10. `changen-work` 执行清单

到公司后按以下顺序操作：

1. 拉取并检查当前分支最新代码，阅读 `AGENTS.md` 和本文；
2. 确认公司机正在运行的 Flowlet 版本已包含当前 usage 修复与
   `agent_usage_events` 账本；
3. 从“设置 → 存储管理”确认实际数据目录，不套用个人电脑路径；
4. 在维护窗口退出 Flowlet，配套备份 `flowlet.sqlite` 与
   `request-captures/`；
5. 启动新版 Flowlet，在“应用设置 → 数据维护”选择“全部时间”并开始检查；
6. 等待会话归因、Token 用量、未知记录、预估费用四阶段全部完成；
7. 在“会话管理”执行手动同步，必要时多轮运行直到任务日志不再显示待追平会话；
8. 记录修复前后请求数、用量记录数、已知 Token、未知记录和原生事件数；
9. 按 Agent 类型、HTTP 状态、会话 ID、模型和捕获可用性审计未知记录；
10. 只对能够唯一事件级对应的记录准备 transcript dry-run，不直接修改歧义项；
11. 检查数据库完整性、最近请求和用量成本页，再重新生成设备同步快照；
12. 保留修复前备份和修复后检查点，直到核验完成。

## 11. 交给公司电脑 Agent 的提示词

将下面整段复制给在 `changen-work` 上运行、能够访问 Flowlet 仓库和本机数据的 Agent：

```text
你正在公司电脑 changen-work 上维护 Flowlet。请整理本机历史用量数据，并完成可审计的
修复与核验。不要套用其他机器的路径或统计结果。

开始前必须：
1. 阅读仓库根目录 AGENTS.md 和 docs/usage-data-repair.md，并遵守当前代码和文档；
2. 检查当前分支最新代码及真实调用链，确认运行版本已包含：
   - Anthropic usage 使用 input_tokens 优先、避免 prompt_tokens 重复计算缓存；
   - agent_usage_events 原生逐事件账本；
   - 设置页四阶段数据维护；
3. 从当前应用或源码确认 changen-work 的真实数据库目录，不猜路径；
4. 先做只读盘点，报告 request_logs、usage_records、agent_usage_events、未知用量、
   最终请求响应捕获数量，以及按 Agent/状态/模型的分布。

数据修改前：
1. 安排维护窗口并退出 Flowlet；
2. 将 flowlet.sqlite 与同目录 request-captures/ 作为同一备份集保存，备份名包含
   changen-work 和时间；
3. 验证备份存在且可读后再重新启动新版 Flowlet；
4. 不修改 config.json，不删除请求日志，不清理 Body，不覆盖 Agent 原始会话文件。

正式整理：
1. 在“应用设置 → 数据维护 → 数据完整性检查”选择“全部时间”；
2. 执行并等待会话归因、Token 用量、未知记录、预估费用四阶段全部成功；
3. 在“会话管理”手动同步 Agent 数据；超大会话需要多轮同步时继续追平，并检查任务日志；
4. 生成修复后只读报告，比较修复前后的行数、已知 Token、未知记录、费用重算数量和
   Agent 原生事件数量；
5. 执行 SQLite integrity_check 和 foreign_key_check；
6. 核验用量成本页“本机”数据以及最近若干 Claude Code、Codex、OpenCode、Pi 会话。

未知用量审计规则：
1. 先按 agent_type、HTTP status、agent_session_id、模型、协议和响应捕获是否存在拆分；
2. 400/429/502 等错误请求不得假设产生了 Token；
3. Flowlet 高于 Agent transcript 时，先识别 away_summary、客户端重试、未采纳响应、
   子任务和内部模型调用；真实经过上游的调用必须保留；
4. 不得把整个 Agent 会话累计量直接叠加到已被 Flowlet 观测的会话；
5. transcript 回填必须先 dry-run，并同时满足会话 ID、模型、时间顺序、输出 Token 或
   上游响应 ID 能够唯一对应；
6. 不得按时间窗口比例缩放，不得按 transcript 与数据库行序盲目对齐；
7. 歧义记录保持未知，不填 0、不估算、不修改；
8. 如果 dry-run 找不到正 Token 的高置信度唯一映射，明确报告“无可安全回填记录”，
   不要为了完成任务强行写库。

如果需要做 transcript 事件级回填：
1. 在内置修复完成后再创建第二份数据库检查点；
2. 只更新 dry-run 中唯一匹配的 request_id；
3. 使用单个 SQLite 事务；
4. 更新后逐条复核输入、缓存输入、未缓存输入、缓存写入、输出和总 Token；
5. 保留内部调用和未匹配记录；
6. 再次运行完整性检查，并给出回滚路径。

最终报告必须包含：
- 实际数据目录和运行版本/提交；
- 两份备份或检查点路径；
- 四阶段修复结果；
- 修复前后准确数字与差值；
- 未知记录按 Agent/状态/模型的分布；
- transcript dry-run 的高置信度、歧义和跳过数量；
- 是否修改数据结构、配置，是否需要重启；
- integrity_check、foreign_key_check 和适用代码检查的真实结果；
- 仍无法恢复的数据与原因。

优先使用 Flowlet 已有 command 和维护界面，不重复实现一套一次性解析逻辑。任何可能覆盖
正确历史数据的操作，都必须先有备份、dry-run 和明确的一一对应证据。
```
