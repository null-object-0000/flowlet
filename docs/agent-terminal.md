# Agent 终端规划

## 1. 背景与结论

Flowlet 计划增加独立的“Agent 终端”菜单，让用户直接在应用内打开并操作已安装 Agent CLI 的内嵌终端，例如 Claude Code、OpenCode CLI 和 Hermes Agent。

这不是普通的“执行命令并显示 stdout”。Claude Code 等交互式 CLI 会使用 ANSI 控制序列、光标移动、窗口尺寸、原始输入模式和子进程，因此需要完整的伪终端（PTY）；Windows 对应 ConPTY。前端还需要终端模拟器负责渲染和键盘输入。

工作量判断：**较大，应独立分阶段实施**。

| 能力 | 工作量 | 主要原因 |
|---|---:|---|
| 可交互 PTY / ConPTY | 大 | 输入输出、ANSI、resize、进程树和异常退出 |
| 终端前端 | 中到大 | xterm 渲染、焦点、复制、缩放、主题和中文输入 |
| 会话生命周期 | 中到大 | 托盘隐藏、关闭确认、应用退出和孤儿进程清理 |
| 凭据与安全边界 | 中 | Token 注入、日志隔离、命令白名单 |
| 多 Agent / 多标签页 | 中 | Adapter、并发会话和资源回收 |

因此，Agent 终端不阻塞当前 Claude Code 配置检测与一键接入闭环。推荐先完成配置闭环，再开始单 Agent PTY 原型。

## 2. 产品目标

Agent 终端要解决：

- 用户不离开 Flowlet 即可打开并操作已安装 Agent CLI 的内嵌终端；
- Flowlet 为启动的 Agent 临时注入本地代理地址、Client Token 和模型配置；
- 用户选择工作目录后直接开始 Agent 会话；
- 终端产生的模型请求自动进入 Flowlet 请求日志、用量成本和 Agent Session；
- Flowlet 可以明确展示 Agent 的安装、运行、退出和异常状态；
- 从终端会话可以跳转到对应请求日志或会话观测页面。

第一阶段不追求通用终端体验，也不替代 Windows Terminal、PowerShell、iTerm2 等系统终端。

## 3. 核心产品边界

### 3.1 支持对象

首版只支持有明确 CLI 可执行文件的 Agent：

1. Claude Code CLI；
2. OpenCode CLI；
3. 后续 Hermes Agent、Codex CLI、Gemini CLI。

ChatGPT Desktop 是桌面应用，不属于 Agent 终端的 CLI 范围。Agent 终端不负责打开外部桌面应用。

### 3.2 不做通用 Shell

首版禁止：

- 用户输入任意可执行文件路径；
- 启动任意 PowerShell、CMD、Bash 或自定义命令；
- 拼接或执行用户提供的完整命令字符串；
- 把 Tauri Shell 的 unrestricted spawn 权限直接暴露给前端；
- 将 Agent 终端扩展成服务器 SSH 客户端；
- 默认保存完整终端输出或键盘输入。

Flowlet 只从已验证的 Agent 安装结果中选择可执行文件，并以参数数组启动。

### 3.3 仅保留两种产品路径

```text
Flowlet 内嵌 Agent 终端
  -> 用户始终在 Flowlet 页面内操作
  -> PTY 和 Agent 子进程只是内部技术实现
  -> 环境变量只注入当前 Agent 子进程
  -> 不修改用户全局配置
  -> 关闭会话后自动失效

写入 Agent 全局配置
  -> 安全合并 ~/.claude/settings.json 等 Agent 配置
  -> Flowlet 不启动 Agent 或系统终端
  -> 用户可以在任意系统终端、IDE 或工作目录中自行启动
  -> 修改前备份并支持恢复
```

两种方式相互补充，除此之外不提供第三种“仅拉起外部 Agent 进程”或“打开系统终端”能力。内嵌 Agent 终端使用临时环境注入；持久化配置由对应 Agent 的接入向导管理。

## 4. 信息架构与交互

### 4.1 左侧菜单

新增一级菜单：`Agent 终端`。

建议位置：模型服务之后、请求日志之前。它是执行入口；请求日志、会话管理和用量成本是执行后的观测入口。

### 4.2 1200×720 页面布局

```text
┌─────────────────────────────────────────────────────────────┐
│ Agent / 安装版本 │ 工作目录 │ 模型配置 │ 启动新会话          │
├─────────────────────────────────────────────────────────────┤
│ 会话标签：Claude Code · project-a    [+]              [×]  │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│                     xterm 终端区域                           │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│ 运行中 · PID · Flowlet 已接入      请求日志  会话详情  停止 │
└─────────────────────────────────────────────────────────────┘
```

页面级不得滚动。工具栏、标签栏和状态栏固定，终端区域填满剩余空间并由 PTY resize 同步实际行列数。

### 4.3 空状态

- 没有安装任何支持的 CLI：展示支持列表和安装指引；
- Claude Code 已安装但代理未运行：允许用户先启动代理；
- 没有可用模型：解释终端可以启动，但模型请求会失败，并提供“管理模型”；
- 没有 Client Token：禁止以 Flowlet 接入模式启动，并引导完成客户端访问配置；
- 工作目录不存在或不可访问：禁止启动并展示具体原因。

### 4.4 启动表单

首版字段：

- Agent：只展示已识别或可安装的受支持 Agent；
- 安装版本：只读；
- 可执行文件：默认隐藏在高级信息中；
- 工作目录：用户明确选择，记忆最近一次非敏感目录；
- 模型：默认 `flowlet-pro`，允许切换 `flowlet-flash`；
- 接入模式：固定通过 Flowlet，不在内嵌终端中混用 Agent 当前的外部网关配置。

### 4.5 生命周期交互

- Flowlet 隐藏到托盘：Agent 会话继续运行；
- 关闭仍在运行的终端标签：二次确认；
- Agent 自然退出：标签保留退出码和最后输出，可手动关闭或重新启动；
- 执行“退出 Flowlet”：终止全部 PTY 会话及其子进程树，再退出应用；
- Flowlet 崩溃：尽可能通过 Windows Job Object / Unix process group 清理子进程树；
- 首版不支持应用重启后恢复原 PTY，会话只存在于本次应用进程。

## 5. 技术架构

```text
React Agent Terminal Page
  └─ xterm.js + fit addon
       ↕ Tauri command / Channel
Rust AgentTerminalManager
  ├─ AgentRegistry
  ├─ TerminalSession registry
  ├─ PTY reader / writer / resize
  └─ process tree lifecycle
       ↕
Windows ConPTY / Unix PTY
       ↕
Claude Code / OpenCode / Hermes
```

### 5.1 前端职责

- 选择 Agent、工作目录和模型；
- 创建、切换和关闭终端标签；
- 使用 xterm.js 渲染 ANSI 输出并转发键盘输入；
- 使用 fit addon 计算列数、行数并触发 resize；
- 展示 starting、running、exited、failed 状态；
- 代理启动、配置缺失、关闭确认和错误提示；
- 跳转到请求日志和 Agent Session；
- 不直接拼写 Tauri command，通过 `src/domains/agent-terminal` 类型化边界调用。

### 5.2 Rust 职责

- 根据 Agent Registry 校验 `agent_id` 和已发现的可执行文件；
- 创建 PTY / ConPTY，并在该 PTY 内部创建 Agent 子进程；该子进程不是独立产品入口；
- 持有 session、PTY master、writer、child 和退出状态；
- 读取输出并流式发送给前端；
- 接收输入和 resize；
- 终止单个会话及全部会话；
- 应用退出时清理进程树；
- 返回明确、结构化、可处理的错误；
- 不承担页面状态和产品流程判断。

### 5.3 建议前端依赖

- `@xterm/xterm`：终端模拟器；
- `@xterm/addon-fit`：根据容器尺寸计算行列；
- 暂不引入搜索、WebGL、链接识别等附加组件。

### 5.4 Rust PTY 方案

首选候选：`portable-pty`。

原因：

- 支持 Windows ConPTY 和 Unix PTY；
- API 包含 open、spawn、reader、writer、resize 和 child lifecycle；
- 来自 WezTerm 生态，适合真实交互式终端场景。

实现前必须做一个独立 spike，验证：

- Windows 10/11 ConPTY；
- 中文输入输出；
- Claude Code 全屏刷新和 ANSI 控制；
- 终端 resize；
- Ctrl+C、Ctrl+D、方向键和粘贴；
- Claude Code 启动的子进程能否随会话可靠退出；
- 与 Tokio / Tauri runtime 的线程模型是否稳定。

Tauri Shell 插件只适合受限命令执行或普通子进程，不作为交互式 Agent 终端的核心实现。

## 6. Agent Adapter

终端能力不应把 Claude Code 特例散落到页面和 PTY 管理器中。

```ts
interface AgentTerminalAdapter {
  agentId: string;
  displayName: string;
  detectEnvironment(): Promise<AgentEnvironmentReport>;
  buildLaunchSpec(input: AgentLaunchInput): AgentLaunchSpec;
  validateLaunch(input: AgentLaunchInput): AgentLaunchValidation;
}

interface AgentLaunchSpec {
  executablePath: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}
```

Claude Code 通过 Flowlet 启动时注入：

```text
ANTHROPIC_BASE_URL=http://127.0.0.1:<port>/anthropic
ANTHROPIC_AUTH_TOKEN=<Flowlet Client Token>
ANTHROPIC_MODEL=flowlet-pro | flowlet-flash
CLAUDE_CODE_SUBAGENT_MODEL=flowlet-flash
```

不得把上游渠道 API Key 注入 Agent 进程。

## 7. Tauri 接口草案

### 7.1 类型

```ts
type AgentTerminalStatus = "starting" | "running" | "exited" | "failed";

interface AgentTerminalSession {
  id: string;
  agentId: string;
  displayName: string;
  cwd: string;
  pid?: number;
  status: AgentTerminalStatus;
  exitCode?: number;
  createdAt: string;
}
```

### 7.2 Command

```text
start_agent_terminal(input) -> AgentTerminalSession
write_agent_terminal(session_id, data)
resize_agent_terminal(session_id, cols, rows)
stop_agent_terminal(session_id)
list_agent_terminals() -> AgentTerminalSession[]
```

`start_agent_terminal` 只接受结构化的 `agent_id`、`cwd`、`model` 和尺寸，不接受完整命令字符串、任意环境变量表或任意可执行路径。

### 7.3 输出流

优先评估 Tauri Channel 传输：

```ts
type AgentTerminalEvent =
  | { type: "output"; sessionId: string; data: string }
  | { type: "status"; session: AgentTerminalSession }
  | { type: "exit"; sessionId: string; exitCode?: number }
  | { type: "error"; sessionId: string; message: string };
```

输出必须保持顺序。需要验证 UTF-8 跨 chunk 解码和大输出背压；不能为每个字节或字符发送一次 Tauri event。

## 8. 安全与隐私

### 8.1 启动安全

- executable 必须来自后端探测并重新校验存在性；
- 只允许 Agent Registry 中声明的 Agent；
- 参数由 Adapter 构造，不通过 Shell 解析；
- cwd 必须 canonicalize、存在且为目录；
- 前端不能传入任意环境变量；
- 不申请 unrestricted shell spawn 权限。

### 8.2 凭据安全

- Client Token 仅由 Rust 从当前 Flowlet 配置读取并注入子进程；
- 前端启动参数不携带完整 Token；
- 不在 tracing、错误、终端标题、Session 元数据中记录 Token；
- 不把上游渠道 API Key 暴露给 Agent；
- 终端输出可能包含敏感信息，默认不落库、不遥测、不写应用日志。

### 8.3 进程安全

- Windows 使用 Job Object 或等价机制管理完整子进程树；
- Unix 使用 process group；
- stop command 必须幂等；
- 应用退出必须有最大等待时间，超时后强制清理；
- Agent 单次崩溃不得导致 Flowlet 或代理服务退出。

## 9. 数据与持久化

MVP 不新增 SQLite 表。

内存中只保存当前运行所需的 session metadata。可以保存最近使用的 `agent_id`、模型和工作目录，但工作目录属于隐私信息，应作为本地偏好处理，不进入请求日志或遥测。

后续如需要终端历史，只保存最小元数据：

- session ID；
- Agent 类型和版本；
- 启动/退出时间；
- 退出码；
- 可选工作目录引用；
- 对应的 Flowlet Agent Session ID。

默认不保存终端全文、键盘输入或环境变量。

## 10. 分阶段实施

### 阶段 A：Claude Code 配置闭环 ✅

- [x] 检测 `~/.claude/settings.json` 和环境变量；
- [x] 判断未配置、已接入 Flowlet、其他网关和配置冲突；
- [x] 安全合并配置、自动备份和恢复；
- 不启动 PTY。

### 阶段 B：PTY 技术验证

- 新增最小 Rust PTY 模块；
- 使用测试命令验证输入、输出、resize 和退出；
- 在 Windows 上运行 Claude Code；
- 前端只提供实验性单终端画布；
- 不加入正式左侧菜单；
- 输出一份 spike 结果并决定 PTY crate。

通过条件：Claude Code 能完成登录态启动、输入提示、流式输出、工具确认和正常退出，且 Flowlet 不崩溃、不残留进程。

### 阶段 C：Agent 终端 MVP

- 增加正式“Agent 终端”菜单；
- 仅支持 Claude Code；
- 工作目录选择；
- 临时注入 Flowlet 环境；
- 单个运行会话；
- 终端 resize、复制粘贴、Ctrl+C 和关闭确认；
- 托盘隐藏继续运行，退出 Flowlet 清理进程。

### 阶段 D：多会话与可观测性

- 多标签页；
- 从终端跳转请求日志和会话详情；
- 展示请求数、Token、费用和最近错误；
- 会话自然退出后的结果状态；
- 不保存完整终端内容。

### 阶段 E：多 Agent

- 抽象并稳定 `AgentTerminalAdapter`；
- 接入 OpenCode CLI；
- 接入 Hermes Agent、Codex CLI、Gemini CLI；
- 按 Agent 能力声明不同启动字段和环境变量；
- ChatGPT Desktop 不进入 Agent 终端范围。

## 11. MVP 验收标准

### 功能

- 能识别并选择已安装的 Claude Code；
- 能选择一个存在的工作目录；
- 能通过 PTY 启动 Claude Code；
- 能输入、粘贴、使用方向键和 Ctrl+C；
- ANSI 颜色、光标移动和流式输出正常；
- 容器尺寸变化后终端内容不出现持续错位；
- Claude Code 请求通过 Flowlet 代理并出现在请求日志；
- 关闭标签、Agent 自然退出、Flowlet 退出均有正确状态和清理行为。

### 安全

- 前端拿不到渠道 API Key；
- Client Token 不出现在日志和错误中；
- 不能借 command 接口启动任意程序；
- 终端输出默认不持久化；
- 退出应用后没有残留 Claude Code 及其工具子进程。

### 稳定性

- React StrictMode 不重复启动 Agent；
- start / stop command 并发安全且 stop 幂等；
- 终端高频输出不阻塞代理请求；
- 前端刷新或页面切换不会意外杀死 Rust PTY 会话；
- 单个终端失败不影响其他业务页面和本地代理。

## 12. 测试计划

### Rust

- Agent Registry 只允许已声明 Agent；
- 路径 canonicalize 和 cwd 校验；
- 启动参数与环境变量构造；
- PTY 输入输出顺序；
- resize；
- 自然退出、手动停止、重复停止；
- 输出读取线程异常；
- 应用退出清理全部会话；
- Token 不进入 Debug / Serialize 输出。

自动化测试优先使用专用 fixture CLI，不依赖开发机真实安装或登录的 Claude Code。

### 前端

- 安装、未安装、加载失败和无模型状态；
- 防止重复点击启动；
- xterm mount / dispose；
- resize 去抖；
- 关闭运行中会话确认；
- 页面切换后会话状态恢复；
- 错误、退出码和重新启动交互。

### Windows 实机

- Windows 10 1809+ 和 Windows 11；
- 原生安装、WinGet 和 npm 安装的 Claude Code；
- 中文输入法、复制粘贴和宽字符；
- Git Bash 可用和仅 PowerShell 两种 Claude Code 环境；
- Flowlet 隐藏托盘、窗口恢复和应用退出；
- Claude Code 工具调用产生子进程时的进程树清理。

## 13. 主要风险

| 风险 | 影响 | 应对 |
|---|---|---|
| ConPTY 行为和 ANSI 兼容问题 | 终端错位或无法交互 | 先做 Windows spike，不直接进入正式 UI |
| 高频输出压垮 IPC 或 React | 卡顿并影响代理体验 | 合并 chunk、背压、终端渲染节流 |
| 子进程树无法完全退出 | 残留 Agent 或工具进程 | Job Object / process group + 退出测试 |
| Token 泄漏到日志或 UI | 严重安全问题 | Rust 内部注入、禁止序列化、默认不保存终端输出 |
| 多 Agent 启动参数差异 | 条件分支失控 | Agent Registry + Adapter |
| 抢占当前核心功能开发 | 延迟渠道和代理稳定性 | 配置闭环优先，终端按独立里程碑实施 |

## 14. 参考

- [Tauri Shell](https://v2.tauri.app/plugin/shell/)
- [portable-pty](https://docs.rs/portable-pty/)
- [xterm.js](https://xtermjs.org/)
- [Claude Code 环境变量](https://code.claude.com/docs/en/env-vars)
- [Claude Code 配置](https://code.claude.com/docs/en/configuration)
