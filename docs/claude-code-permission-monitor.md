# Claude Code 权限等待监测（一期：只监测，不代理动作）

> 本文档是**已批准但暂缓实施**的方案记录，供后续重启该任务时参考。
> 原计划会话产物已迁移至本文件。

## Context

Flowlet 已支持 Claude Code 的接入（`~/.claude/settings.json` env 写入）与会话观测（`x-claude-code-session-id` + `~/.claude/projects/**/*.jsonl` 解析）。`waiting_user` 识别现状分两层：

- **已支持**：`infer_claude_runtime_status`（`agent_session_metadata.rs:345`）从 JSONL 识别 `AskUserQuestion` / `ExitPlanMode` 两类挂起工具（`claude_tool_waits_for_user`，397 行）——这类等待会以 tool_use block 留在 transcript 尾部，纯文件解析可靠。
- **未支持**：普通工具权限弹窗（Bash/Edit/Write/MCP 等"允许/拒绝？"对话框）。其 JSONL 形态（assistant 以 `stop_reason: tool_use` 收尾、暂无后续）与"工具正在执行"字节级相同，无法区分，现状一律显示 `running`（`docs/product.md` 明确记录该限制）。

本任务：补上**普通权限弹窗**的 `waiting_user` 识别，与已有 JSONL 推断互补叠加。**一期只做监测，不做确认/否决动作代理**（用户拍板）。

已验证的关键事实（官方文档 code.claude.com/docs/en/hooks）：

- `PermissionRequest` hook 在工具调用真正需要权限决策时触发（已自动批准的不触发）；stdin 含 `session_id`、`tool_use_id`、`tool_name`、`tool_input`、`transcript_path`；静默退出（exit 0 无输出）则回退终端原生弹窗。
- `Stop`、`UserPromptSubmit` hook 的 stdin 均含 `session_id`，可作为"弹窗已处理"的清理信号。
- hook 运行期间终端弹窗不出现；因此**扣留（等待远程回复）与被动监测不可兼得**——能观察解决时机的 hook 必须比弹窗活得久，而活得久就扣住了弹窗。一期选择被动监测（即时退出、零扣留）。
- 官方 Remote Control 在 `ANTHROPIC_BASE_URL ≠ api.anthropic.com`（即被 Flowlet 接管）时禁用；包装类竞品（Happy/CCPark）需从它们入口启动会话。Flowlet 架构下 hooks 是唯一可行拦截点。

二期预留（不在本期实现）：同一脚本同一目录演进为"心跳门控扣留 + reply 文件回传决策"（复制 OpenCode 桥接模式），届时只需改脚本等待逻辑 + Rust 写 reply + UI 加按钮，不改文件布局与注册结构。

## 方案

```
claude 终端触发权限
  → PermissionRequest hook（Flowlet 注册的 hook.mjs）写 waiting-{sessionId}.json 后立即静默退出
  → 终端原生弹窗照常出现（零扣留）
  → 用户在终端处理 → Stop / UserPromptSubmit hook 删除标记
Flowlet 侧：
  → list_agent_sessions 扫描 waiting-*.json，transcript 交叉校验 + TTL 兜底
  → 命中会话 runtime_status 合并为 waiting_user（过滤/分页前，与 opencode 同规则）
  → 桌面列表标签/筛选、移动端快照自动生效（waiting_user 展示链路已存在）
```

### 1. hook 脚本（新建源码常量，`agent_global_config.rs`）

`CLAUDE_CODE_HOOK_SOURCE` → 部署到 `~/.flowlet/claude-code-control/hook.mjs`，纯 node 内置模块，按 stdin `hook_event_name` 分支：

- `PermissionRequest`：原子写（tmp+rename）`waiting-{session_id}.json`，内容 `{sessionId, toolUseId, toolName, toolInput, transcriptPath, updatedAt}`；立即静默 exit 0。
- `Stop` / `UserPromptSubmit`：删除本会话 `waiting-{session_id}.json`，exit 0。
- 其他事件/任何异常：永远 exit 0 静默（绝不 exit 2、绝不向 stdout 输出，避免干扰用户 hooks 链）。
- 不注册 `PostToolUse`（每次工具调用都触发，热路径；其清理价值已被 transcript 交叉校验覆盖）。

### 2. settings.json hooks 管理（`src-tauri/src/core/agent_global_config.rs`）

- 注册到 `hooks.PermissionRequest` / `hooks.Stop` / `hooks.UserPromptSubmit` 三个数组，Flowlet 条目以 command 含 `.flowlet/claude-code-control/hook.mjs` 为标识。
- **合并式而非独占式**：apply 先移除旧 Flowlet 条目再追加（幂等、升级安全），保留用户其他 hook 条目与其他事件键；restore 只删 Flowlet 条目，顺势清理空数组/空 `hooks` 对象。无需备份 `hooks` 字段（外科手术式增删，不动用户内容）；`GlobalConfigBackup` 结构不变，旧备份兼容。
- apply 时探测 `node` 在 PATH（复用 `agent_environment.rs` 的可执行文件解析能力）；缺失则跳过安装并在报告中标注原因。
- `inspect_claude_code` 报告新增 `permission_monitor: bool`（脚本内容与受管源码逐字节匹配 且 三个事件条目均在）；**不参与** flowlet/partial 状态判定（仿 Pi `session_extension`，避免打扰主动关闭的用户），仅作状态行展示。
- restore 时删除 `hook.mjs` 与 Flowlet 条目，目录空则删目录。

### 3. Rust 读取与状态合并（新建 `src-tauri/src/core/claude_code_control.rs`）

- `control_dir()` = `~/.flowlet/claude-code-control`；`waiting_markers()` 扫描 `waiting-*.json`。
- 每个 marker 做两级消解：
  1. **transcript 交叉校验**：marker 自带 `transcriptPath`，复用 `agent_session_metadata.rs` 的 JSONL 尾部读取（`read_jsonl_tail` 一带），若尾部已出现该 `toolUseId` 的 `tool_result`（批准完成或拒绝）→ 删除 marker、跳过；
  2. **TTL 兜底**：`updatedAt` 超过 30 分钟视为残留（claude 被杀等情况）→ 删除、跳过。
- `pending_sessions()` 返回仍有有效 marker 的 session_id 集合。
- `list_agent_sessions`（`commands/observability.rs`）在现有 opencode pending 收集之外，追加 claude-code pending 集合；`storage_usage.rs` 的 `list_agent_sessions` 增加第三个参数，opencode 走原 `opencode_control::merge_runtime_status`，claude-code 走新 `claude_code_control::merge_runtime_status`（两条独立路径，不动 opencode 既有逻辑与测试），均在过滤/分页**之前**合并。
- 移动端零成本受益：`runtime_status` 已随设备快照同步，`SharedAgentSession` 无需改动。

### 4. 只读明细（小增量，提升监测可解释性）

- 新 Tauri command `get_claude_code_permission_marker(session_id)` → 返回当前有效 marker（toolName/toolInput 摘要/updatedAt）或 null。
- `AgentSessionDetailSideSheet` 的"最近一轮"Tab：claude-code 会话存在 marker 时展示只读提示条「Claude Code 正在等待权限确认：{toolName}（请在终端中处理）」，无按钮。
- domain 层新增对应 types/commands/query-keys/hook（仿现有 `nativeSummary` 只读链路）。

### 5. 接入抽屉（`AgentAccessSideSheet.tsx` + `src/domains/agent/types.ts`）

- `AgentGlobalConfigReport` 新增 `permission_monitor?: boolean`；`AgentGlobalConfigOptions` 新增 `permissionMonitor?: boolean`（默认开，仿 Pi `sessionExtension`）。
- claude-code 区块新增「权限监测」Switch + 状态行（已安装 / 需安装或更新 / node 不可用），结构复用 Pi 会话扩展行。

### 6. 测试

- Rust 单测：
  - `claude_code_control.rs`：marker 扫描、transcript 交叉校验消解、TTL 过期、merge_runtime_status 仅对 claude-code 生效；
  - `agent_global_config.rs`：apply 幂等且保留用户既有 hooks、restore 仅清 Flowlet 条目、inspect 报告字段、node 缺失降级；
  - `storage_tests.rs`：claude-code pending 合并进 waiting_user 的分页前语义（仿现有 opencode 用例）。
- 前端：`commands.test.ts` / 类型同步，现有测试不回归。
- 手动 e2e 清单：接入（开关默认开）→ 重启 claude → 触发 Bash 权限 → 列表 60s 内显示 waiting_user、详情出现只读提示 → 终端批准/拒绝 → 状态恢复 → 关闭开关后 hooks 被移除、状态不再出现 → 用户自建 hooks 全程不受影响。

### 7. 文档

- `docs/claude-code-global-config.md`：新增「权限监测 hooks」章节（管理字段、合并/恢复语义、node 依赖、需重启 claude 生效）。
- `docs/product.md`：改写"Claude Code 普通工具权限弹窗……保守显示为运行中"的表述，记录新能力边界（含下方已知限制）。
- `docs/architecture.md`、`AGENTS.md` 第 8 节：补一段机制与维护要点（新增事件/目录时的同步清单）。

## 已知边界（写入文档，不隐瞒）

1. 批准后的长时间运行工具，在完成前仍显示 `waiting_user`（完成即自愈；被动机制无法区分"等待权限"与"执行中"）。
2. 被放弃超过 TTL（30 分钟）的权限弹窗回退为 running/idle。
3. hook 需要 node 在 PATH；缺失时跳过安装，状态行明示。
4. 已运行的 claude 进程需重启才加载 hooks。
5. 一期无确认/否决按钮；监测≠代理。

## 关键文件

| 文件 | 改动 |
|---|---|
| `src-tauri/src/core/claude_code_control.rs` | 新建：marker 扫描/消解/pending 集合/merge_runtime_status + 单测 |
| `src-tauri/src/core/agent_global_config.rs` | `CLAUDE_CODE_HOOK_SOURCE`、hooks 合并/恢复、inspect 报告、node 探测 |
| `src-tauri/src/core/mod.rs` | 注册新模块 |
| `src-tauri/src/commands/observability.rs` | `list_agent_sessions` 追加 claude pending；新增 `get_claude_code_permission_marker` |
| `src-tauri/src/core/storage_usage.rs` | `list_agent_sessions` 增加 claude pending 参数与合并 |
| `src-tauri/src/lib.rs` | 注册新 command |
| `src/domains/agent/types.ts`、`src/domains/agent-session/types.ts`/`commands.ts`、`src/shared/query-keys.ts` | 类型与边界封装 |
| `src/features/agent-access/AgentAccessSideSheet.tsx` | 权限监测 Switch + 状态行 |
| `src/pages/agent-sessions/AgentSessionDetailSideSheet.tsx` | 只读等待提示条 |
| 上述文档 4 份 | 同步更新 |

## 验证

1. `cargo test`（新增 + 全量回归）；
2. 前端 `npm run typecheck` + `npm run build`；vitest 跑 domain 层测试（页面级测试存在 semi-icons CSS 的预存环境问题，与本改动无关，如实报告）；
3. 手动 e2e 按第 6 节清单执行（需本机安装 Claude Code 并接入 Flowlet）。
