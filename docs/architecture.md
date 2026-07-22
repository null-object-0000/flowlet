# Flowlet 架构说明

## 目标

Flowlet 的第一阶段目标是做一个桌面优先、本地运行、多协议透明转发的 AI 请求路由客户端。长期产品方向是面向 AI Agent 的本地使用与成本控制台：代理是高精度数据入口，但代理外 Agent 使用也可经授权的本地 Adapter、导入或手动记录进入统一成本账本。当前阶段仍采用 LongCat + DeepSeek first 策略，优先把 LongCat / DeepSeek 的 OpenAI-compatible 与 Anthropic-compatible 两种透明转发入口做完整，并以 Claude Code 接入作为核心验证场景。

当前正式数据模型已经采用 Channel / Account / Model 架构，不再使用旧 Provider 原型或 `provider_id = default` 逻辑。后续修改必须基于当前迁移后的真实表结构，不得以“尚未实现”为由再次破坏式重建。

产品重心是开箱即用的本地 AI 请求路由体验：普通用户选择渠道模板、填写 API Key、选择模型即可接入；高级用户再展开自定义 Base URL、Header、模型名、价格和错误识别规则。

架构设计必须服务于以下边界：

- 支持多协议透明转发，但不做跨协议转换。
- 响应零改写。
- 请求侧只做 base_url、Authorization/Header 和可选 model 映射。
- 日志旁路记录，失败不能影响主请求链路。
- 模型列表、价格、余额、额度、用量查询只能用于异步同步和配置辅助。
- Token 和成本分析走离线任务，不能阻塞真实请求。
- 成本账本与请求日志解耦；实际支付、按量费用、公开价估算、摊销、分配和等价价值使用不同字段表达。
- 外部 Agent Adapter 默认本地只读、显式授权、最小化采集，并使用独立错误边界。
- 第一阶段采用 LongCat + DeepSeek first，同时完成两个首发渠道的 OpenAI-compatible 与 Anthropic-compatible 两种透明转发入口。

## 总体结构

```text
Flowlet Desktop
  ├─ src/                              React 19 + Semi Design 正式前端
  ├─ src-tauri/                        Tauri 2 桌面壳
  │  └─ src/
  │     ├─ lib.rs                      Tauri 应用入口和 command 注册
  │     ├─ main.rs                     桌面进程入口
  │     ├─ commands.rs                 Tauri command 定义
  │     └─ core/
  │        ├─ mod.rs                   Core 模块出口
  │        ├─ config.rs                运行时配置结构
  │        ├─ channels_config.rs       config.json 反序列化与渠道默认值
  │        ├─ presets.rs               内置渠道模板
  │        ├─ proxy.rs                 代理生命周期（启动 / 停止 / 幂等）
  │        ├─ proxy_http.rs            HTTP 转发与请求头改写
  │        ├─ proxy_routing.rs         路由候选与失败降级
  │        ├─ proxy_tests.rs           代理测试
  │        ├─ rate_limiter.rs          客户端级别速率限制
  │        ├─ storage.rs               SQLite 存储与迁移
  │        ├─ storage_maintenance.rs   SQLite 完整压缩与增量空间回收
  │        ├─ storage_config.rs        渠道 / 账号 / 模型配置读写
  │        ├─ storage_usage.rs         用量与会话聚合查询
  │        ├─ storage_stats.rs         统计查询
  │        ├─ storage_tasks.rs         后台任务持久化
  │        ├─ storage_tests.rs         存储测试
  │        ├─ sync.rs                  模型 / 价格 / 余额异步同步任务
  │        ├─ usage.rs                 Token 提取与成本估算
  │        ├─ logging.rs               日志捕获与脱敏
  │        ├─ metrics.rs               运行时指标
  │        ├─ agent_environment.rs     Agent 本机安装探测
  │        ├─ agent_global_config.rs   Claude Code / OpenCode 全局配置写入与恢复
  │        ├─ agent_session_metadata.rs 原生会话目录与会话列表
  │        ├─ agent_session_timeline.rs 原生会话时间线解析
  │        ├─ agent_source_watcher.rs  Agent 数据源文件监听
  │        ├─ codex_account.rs         Codex 账号与用量
  │        ├─ cost_ledger_source_probe.rs 成本账本只读数据源探针
  │        └─ web/                     内嵌 Web 资源
  └─ docs/                             产品和架构文档
```

应用无条件加载 `src` 中的 Semi Design 前端。旧 Mantine 前端、`ui.version` 入口选择和 legacy fallback 已删除。前端分层与依赖方向见 `AGENTS.md` 第 10 节「前端开发原则」。

当前代码已经接入 SQLite 基础配置存储。后续架构文档不再把 SQLite 视为未来能力，而是把它作为 Channel、Account、Model、Client、虚拟模型、日志、用量、价格和快照数据的本地持久化层。

SQLite 迁移由 `Storage::migrate` 负责。除非需求明确允许且已评估用户数据影响，不得直接删除或重建现有表；新增或调整持久化结构必须提供迁移并补充存储测试。

## 当前阶段核心模型

LongCat + DeepSeek first 阶段使用三层概念：

```text
渠道 Channel
  ↓
账号 Account
  ↓
模型 Model
```

- Channel 是服务商模板，当前首发渠道是 LongCat 和 DeepSeek。
- Account 是用户在某个渠道下配置的一组访问身份，当前版本明确一个账号只对应一个 API Key。
- Model 归属于渠道，不归属于账号，例如 LongCat-2.0。

路由候选使用：

```text
Channel + Account + Protocol + Model
```

账号是路由、统计、余额、失败状态的最小单位。

## 运行时端口

```text
127.0.0.1:18640  多协议透明代理端口
```

后续如需要管理 API，优先通过 Tauri command 给桌面 UI 使用；Docker / Web Console 阶段再引入独立管理端口。

## 协议入口

```text
Flowlet Local Proxy
  ├─ OpenAI-compatible Gateway
  │   └─ /v1/*
  │   └─ /openai/v1/*
  │
  ├─ Anthropic-compatible Gateway
  │   ├─ /anthropic/v1/messages
  │   └─ /anthropic/v1/models
  │
  └─ 后续 Gemini-compatible Gateway
      └─ Gemini API paths
```

OpenAI-compatible 请求只能转发到 OpenAI-compatible 上游。Anthropic-compatible 请求只能转发到 Anthropic-compatible 上游或 Claude Gateway。Gemini-compatible 请求只能转发到 Gemini-compatible 上游。

首发渠道默认映射：

```text
Flowlet /v1/* 或 /openai/v1/* -> https://api.longcat.chat/openai
Flowlet /anthropic/v1/* -> https://api.longcat.chat/anthropic
Flowlet /v1/* 或 /openai/v1/* -> https://api.deepseek.com
Flowlet /anthropic/v1/* -> https://api.deepseek.com/anthropic
```

Flowlet 不做：

```text
Claude Code / Anthropic 请求 -> 转成 OpenAI 请求
OpenAI 请求 -> 转成 Anthropic 请求
```

## 请求链路

```text
Cursor / Cline / Open WebUI / Cherry Studio / Continue
        ↓
http://127.0.0.1:18640/v1/*
        ↓
Flowlet OpenAI-compatible Gateway
        ↓
OpenAI-compatible Channel Account

Claude Code
        ↓
ANTHROPIC_BASE_URL=http://127.0.0.1:18640
        ↓
Flowlet Anthropic-compatible Gateway
        ↓
Anthropic-compatible Channel Account
```

代理只在请求侧做有限处理：

- 根据开放模型和可用账号选择 Channel Account。
- 将本地协议入口路径拼接到渠道模板的协议 `base_url`。
- 替换上游 `Authorization` Header 或 `X-Api-Key` Header。
- 必要时将虚拟模型名映射为上游模型名。

响应侧不做业务改写：

- 不改 status code。
- 不改 response body。
- 不包装错误。
- 不补 `usage`。
- 不解析或重组 SSE。

## Agent 本机环境探测

Agent 接入向导通过只读 Tauri command 探测本机 CLI 环境，前端不直接读取文件系统或执行 Shell。调用链为：

```text
Agent 接入组件
  -> src/domains/agent/commands.ts
  -> detect_agent_environment
  -> src-tauri/src/core/agent_environment.rs
```

Claude Code 探测同时检查 PATH 和官方常见安装位置，返回当前主安装、全部候选安装、可执行文件路径、安装目录、版本及安装方式。OpenCode 探测同时覆盖 CLI 与 Desktop：CLI 检查 PATH、原生脚本、npm、Bun 等常见位置并执行版本命令；Desktop 检查各平台常见应用位置且不会启动桌面进程。ChatGPT（Codex）同样同时探测 Desktop 与 Codex CLI；CLI 覆盖 PATH、npm 和官方独立安装目录，并通过 `codex --version` 读取版本。保留全部候选用于识别多版本或 CLI/Desktop 并存；探测结果只存在于 TanStack Query 内存缓存，不写入 SQLite 或 `config.json`。

Codex CLI 当前支持安装探测、账号用量复用和原生会话读取。Flowlet 暂不自动写入 Codex `model_providers`：Codex 当前自定义 Provider 使用 Responses wire API，而 Flowlet 坚持不做跨协议转换；待确认目标上游支持 `/v1/responses` 后再开放一键网关配置。

Claude Code 用户级全局配置由独立的 `agent_global_config` 模块管理。前端只读取脱敏状态并触发应用或恢复；Rust 解析 `CLAUDE_CONFIG_DIR` / `~/.claude/settings.json`，安全合并 Flowlet Base URL、Client Token 和模型别名映射。修改前只备份受管字段，恢复时不覆盖用户后续新增的其他 Claude 设置。完整字段和优先级见 [`claude-code-global-config.md`](./claude-code-global-config.md)。

OpenCode CLI 与 Desktop 共用用户级配置。Flowlet 在 `~/.config/opencode/opencode.jsonc`（或已有的 `opencode.json`）中结构化合并 `provider.flowlet`、`model` 和 `small_model`，并把 Client Token 单独写入 `~/.local/share/opencode/auth.json` 的 `flowlet` 凭据项。JSONC 修改保留未受管字段和注释；配置与凭据均先备份受管值，再支持恢复。完整行为见 [`opencode-global-config.md`](./opencode-global-config.md)。

Agent 接入抽屉中的 Client Token 默认使用固定长度掩码；查看按钮只在当前抽屉会话中临时展示，关闭后恢复掩码，复制始终使用真实值。Claude Code 手动片段与一键写入字段保持一致；OpenCode 将 Provider 配置和 `auth.json` 凭据拆成两个片段。OpenCode 配置与凭据采用双文件事务写入，第二个文件失败时恢复两个文件的原始字节内容。

## Channel Preset 架构

### Channel Preset

Channel Preset 由 Flowlet 内置维护，用来描述一个渠道模板：

- 渠道名称。
- OpenAI-compatible `base_url`。
- Anthropic-compatible `base_url`。
- 认证方式。
- 推荐默认模型。
- 初始模型列表。
- 内置价格来源。
- 支持能力。
- 支持协议列表。

LongCat + DeepSeek first 阶段第一优先模板是 LongCat 和 DeepSeek。两者都声明 OpenAI-compatible 与 Anthropic-compatible 两种上游端点。后续再扩展 OpenAI、OpenRouter、Moonshot、阿里云百炼、火山方舟、硅基流动、自建 New API、自建 LiteLLM、自定义 OpenAI-compatible、自定义 Anthropic-compatible 等模板。

### Channel Account

Channel Account 是用户在某个渠道下配置的一组访问身份：

- 关联 `channel_id`。
- 保存账号名称。
- 保存 API Key。
- 保存优先级。
- 保存是否启用。
- 保存最近使用时间、最近错误和备注。

当前版本明确一个账号只对应一个 API Key，不引入 Credential 概念。普通用户不需要理解 `base_url`、`auth_type`、`headers_json` 等技术字段。UI 默认展示“选择渠道、填写账号 API Key、选择模型、测试连接、保存并启用”，高级设置再暴露底层字段。

## ChannelAdapter

ChannelAdapter 为后续模型列表、价格、余额、额度和用量查询预留统一接口：

```text
ChannelAdapter
  - list_models()
  - get_model_detail()
  - sync_prices()
  - query_balance()
  - query_quota()
  - query_usage()
  - test_connection()
```

ChannelAdapter 只用于异步同步和配置辅助，不参与主请求转发。主请求转发仍然走 `proxy`，响应仍然零改写。

同步任务失败不能影响 AI 请求转发。失败信息只写入本地同步状态、快照表或 UI 提示。

## Core 模块

### config

保存基础配置结构和跨模块共享类型：

- 协议类型。
- 客户端协议类型。
- 上游协议类型。
- 认证方式。
- 路由策略。
- 同步状态。
- 价格来源。
- 能力声明。

### presets

保存内置渠道模板：

- Channel Preset 列表。
- 模板默认字段。
- 模板可见字段和高级字段。
- 模板默认 Capability。

### channel

保存用户渠道和账号配置：

- Channel Account。
- API Key 引用。
- 账号优先级。
- 自定义覆盖项。
- 启用状态。

API Key 字段保留独立类型，方便后续接入系统密钥链或本地加密。

### adapter

封装渠道能力适配器。不同渠道可以有不同实现，但调用方只依赖统一接口。

当前渠道适配器已经承担测试连接、模型同步、余额和资源包等异步能力。新增能力仍应通过明确的 capability 声明暴露；不支持的能力返回明确状态，不得影响主代理请求链路。

### sync

负责异步同步任务：

- 模型列表同步。
- 价格表同步。
- 余额快照查询。
- 额度快照查询。
- 用量快照查询。

同步任务必须独立于主请求链路运行。同步失败时保留已有缓存或快照，不能导致 `/v1/*` 请求失败。

### proxy

负责本地监听和透明转发：

- `/health` 返回本地服务健康状态。
- `/v1/*`、`/openai/v1/*` 透明转发到 OpenAI-compatible 渠道端点。
- `/anthropic/v1/messages`、`/anthropic/v1/models` 透明转发到 Anthropic-compatible 渠道端点。
- 普通响应直接透传。
- 流式响应使用上游字节流直接返回，不能缓存完整响应后再返回。
- 旁路生成 metadata 日志事件，日志失败不影响响应。

### storage

SQLite 当前保存本地配置、日志、用量和同步快照，核心表包括：

- `channel_presets`
- `channel_accounts`
- `channel_models`
- `virtual_models`
- `virtual_model_routes`
- `route_rules`
- `request_logs`
- `usage_records`
- `account_balance_snapshots`
- `app_meta`

OpenCode 会话观测当前不建立独立 `sessions` 表。代理在请求进入时从 OpenCode 的
`x-opencode-session`、`x-session-id`、`x-session-affinity` 和
`x-parent-session-id` Header 中提取稳定标识，写入 `request_logs` 的
`agent_type`、`agent_session_id`、`parent_agent_session_id` 字段。会话列表只聚合
`is_last_attempt = 1` 的最终请求，并通过 `request_id` 关联 `usage_records`。会话列表返回
客户端 ID 与名称；筛选维度拆分为 Agent 类型（ChatGPT（Codex）、Codex CLI、Claude Code、OpenCode、Pi）和
Flowlet 观测状态（全部、经过 Flowlet、未经过 Flowlet），原生会话不再因为缺少 `client_id` 被
客户端筛选排除。模型不是会话固定属性，不作为会话列表字段展示。会话列表
只分页展示没有父会话的主会话，固定每页最多 8 条，以适配桌面窗口内容高度；直接子会话通过
独立只读 command 在主会话详情中按最近活动排序展示，不与主会话平铺。因此日志
保留和清理策略同样决定会话观测数据的保留范围。

查询会话列表时，Rust 会只读、尽力而为地建立本地原生会话目录：OpenCode 从用户本地
`opencode.db` 的 `session` 表读取全部会话的标题、项目目录、父会话和时间；Claude Code 从
`~/.claude/projects` 下识别根会话 JSONL 与 `subagents` 子会话；ChatGPT（Codex）Desktop 与
Codex CLI 共享 `$CODEX_HOME/sessions`，Flowlet 根据 `originator` 分别标记为 `codex-desktop`
和 `codex-cli`，并通过 `session_index.jsonl` 补充任务标题；Pi 从 `~/.pi/agent/sessions`
递归扫描 `<timestamp>_<uuid>.jsonl`，解析头行（`id`/`cwd`/`timestamp`/`parentSession`）取得
会话 UUID、项目目录、时间与派生来源，并以 `session_info` 名或首条用户消息为标题。列表查询只
读取标题、工作目录、父子关系和时间字段。Pi 会话文件为树状结构（entry 通过 `id`/`parentId`
连接，支持原地分支），时间线解析从叶子沿 `parentId` 回溯到根，重建当前活动分支后映射为事件。
原生目录与 Flowlet 请求观测按 `(agent_type, session_id)` 去重合并，因此未经过 Flowlet 的本地
会话也会显示；这类会话没有 Flowlet 请求、费用和失败指标，列表优先读取同步快照中的原生
turn 数、累计 Token、模型集合与同步时间；首次快照尚未生成时才为当前可见行按需读取原生摘要，
并继续以“未经过 Flowlet”标明数据语义。
Claude Code 文件按路径、大小和修改时间缓存，未变化文件不会在每次列表刷新时重复解析。

原生读取失败不影响 Flowlet 聚合结果，也不写入 Agent 文件。Flowlet 通过前端调度的只读同步任务，
把原生会话摘要及来源指纹写入 `agent_session_snapshots`；该快照用于增量判断和后续整理，不保存消息正文，
也不替代 Agent 原始数据源。会话详情使用 SideSheet 展示原生元数据与 Flowlet 请求指标，不再把列表点击行为
跳转到请求日志；仅 Flowlet 已观测会话的会话 ID 提供显式日志跳转入口，跳转后由请求日志页按该
会话 ID 自动筛选。Codex 的 `archived_sessions` 当前不进入活跃会话列表，CLI 与 Desktop 作为
两个独立筛选项展示。

会话详情拆分为“概览”和“时间线”两个 Tab；详情打开时，前端通过独立 Query 按需调用
`get_agent_session_timeline`，概览使用返回的原生累计用量，时间线复用同一份缓存数据。Rust 在阻塞任务中
只读对应原生数据源：OpenCode 联查 `message` / `part`，Claude Code 解析目标 JSONL，Codex
解析目标 rollout JSONL 的 `response_item`。不同来源统一返回用户消息、助手回复、思考摘要、
工具调用、工具结果和错误六类事件，不写入 Flowlet SQLite，也不读取或展示 Codex developer
指令。单次最多扫描 16 MiB、返回 300 个展示事件、每个事件内容最多 8000 字符；达到展示事件上限后
仍继续扫描剩余记录中的轮次、模型与累计用量，详情页同时明确提示事件已截断，避免展示上限造成统计和
费用低估。原生源不存在时返回“不可用”空结果，结构不兼容或读取失败时返回可重试错误。
时间线结果同时返回 Agent 原生累计用量、模型集合和单事件用量。OpenCode 使用 `session` 的累计
Token / cost 与消息级 tokens；Claude Code 对去重后的助手回复 usage 聚合输入、输出、缓存创建和
缓存读取；Codex 使用最新 `total_token_usage` 作为会话总量，并在
`task_started` 到 `task_complete` 之间累加每次 `last_token_usage`，形成可核对的轮次用量，同时记录
轮次总耗时和首 Token 延迟。每个时间线事件显式标记为 Agent 原生来源。原生用量与
Flowlet 请求观测始终分栏展示且不相加；OpenCode 原生提供的 cost 直接展示。Codex 在能够确定唯一模型且
价格存在精确匹配时生成两个独立维度：优先展示 `openai-api` 标准基础 API 公开价计算的 API 等价价值，并保留
USD 等原始计价币种；同时展示 `codex-native` 官方 credits 费率计算的套餐消耗。两者不做汇率换算，也不相加；
无法从原生记录确认的长上下文、Priority processing 或 Fast mode 乘数不纳入基础估算。Claude Code 不在
缺少可靠价格映射时伪造费用。完整时间线只在详情打开或用户主动刷新时读取；列表使用独立的
`get_agent_session_native_summary` 只返回 turn 数、累计用量和模型集合，不返回事件正文。同步快照存在时
列表不再重复解析原始文件；缺少快照时按可见行懒加载并缓存 5 分钟。原生摘要达到读取上限时，列表用
`≥` 明确表示计数或 Token 为下限。
会话列表中经过 Flowlet 的 Token 汇总复用请求日志的明细提示，按会话聚合输入、缓存输入、未缓存输入、
输出和总 Token；缓存命中率仅以明确返回缓存字段的输入 Token 为分母，缺少 Token 明细的请求单独计数，
不把未知用量当作零值参与命中率。

Codex 账号与用量另有独立的周期性后台同步：应用启动约 20 秒后首次执行，此后固定每 5 分钟一轮，前台与
后台同周期（Codex 官方用量窗口本身是 5 小时 / 周级粒度，5 分钟足够新鲜，也避免高频调用官方用量接口与
反复拉起 app-server 进程）。Rust 在同步前先做廉价检查：既没有 `~/.codex/auth.json` 登录凭据、也没有托管
多账号目录时直接跳过，不创建任务、不发起网络请求；存在账号时复用 `query_codex_accounts` 刷新当前账号与
所有托管账号的用量快照，并以 `job_type = codex-account-sync` 记入 `background_jobs` /
`background_job_events`，单个账号刷新失败只记警告事件、不中断整轮同步。任务日志页可按「Codex 账号同步」
类型筛选，详情展示账号数量、失效账号、失败账号与总耗时；同步成功后前端失效 Codex 账号查询缓存以刷新界面。
同一时刻只允许一个 Codex 同步运行，与 Agent 数据同步的互斥相互独立。

Agent 数据同步在应用启动约 3 秒后首次检查，窗口前台每 1 分钟、后台每 5 分钟检查一次，恢复到前台时
尽快补查。自动检查只有发现来源指纹变化时才创建任务；会话页手动同步会强制重新整理并始终保留记录。
Rust 使用 `notify` 监听现有 OpenCode 数据库、Claude Code 项目目录和 Codex sessions 目录，文件事件只作为
“需要重新扫描”的提示，由前端静默 8 秒后触发同一增量同步，并限制文件事件触发间隔至少 30 秒；
定时轮询始终保留为漏事件和新目录的兜底。扫描指纹时仅短暂持有 SQLite 锁，解析 Agent 原始文件期间
不占用数据库，确保任务日志和其他页面查询不会被长任务阻塞。
同步会删除仍可访问数据源中已经消失或归档的会话快照，并在 `agent_source_sync_state` 按客户端保存上次
检查、上次成功整理、扫描数、变化数、失败数和错误。单会话失败不覆盖旧快照或指纹，因此后续检查会重试。
Codex 与 Claude Code 的 JSONL 摘要快照额外保存解析器版本、已读取字节位置、游标前 4 KiB 校验值和
Claude usage ID 去重集合；后续仅解析追加内容，不把消息或工具正文写入 SQLite。文件缩短、游标校验失败或
解析器版本升级时自动从头整理。单轮最多读取 16 MiB，未读完时使用 partial 指纹让下一轮继续推进。
同一时刻只允许一个 Agent 同步运行。通用任务执行信息落入 `background_jobs`，阶段事件落入
`background_job_events`，任务日志页展示触发方式、进度、结果、警告和错误；应用启动时会把上次未结束的
任务标记为 `interrupted`。任务调度属于 React 产品编排，Rust command 负责只读扫描、SQLite 一致写入和
并发互斥；同步失败不会影响代理请求链路，配置变更也不需要重启代理。

自动 Agent 同步单轮最多整理 12 个变化会话，手动同步最多 20 个，优先处理最近活动会话；未处理部分不更新
指纹，下一轮会继续发现。单会话解析在独立线程中执行，等待上限为 5 秒，超过 1 秒记为慢会话；超时、慢会话、
目录扫描、指纹比较、会话解析、SQLite 写入和任务总耗时均进入任务日志。解析原始文件时不持有 Storage 连接锁，
任务取消、列表和详情查询可以并发执行。运行中任务可请求取消，当前会话解析完成或超时后停止后续处理。
任务详情同时记录全量/增量会话数量和实际读取的源文件字节数，增量会话会生成单独的处理事件。
任务列表按 20 条分页并支持状态、类型筛选；用户可清理 90 天前已结束任务，应用启动也会执行相同保留策略，
运行中任务不会被清理。

Claude Code 2.1.86 及以上版本会在 API 请求中发送官方
`x-claude-code-session-id` Header。代理将其写入同一组 `agent_type` / `agent_session_id`
字段，其中 `agent_type = 'claude-code'`；恢复的 Claude Code 会话继续使用原 session ID。
Claude Code 与 OpenCode 共用会话聚合、客户端筛选、日志详情和数据修复链路。

设置页提供显式的本地数据修复流程，支持与请求日志一致的时间范围（最近 1 小时、最近 6 小时、
今天、最近 7 天、全部时间），由前端顺序编排四个细粒度 command：历史 OpenCode
Claude Code / OpenCode 会话归因回填、已捕获响应用量重解析、未知用量记录补齐、费用重算。会话回填只读取已保存的
`req_headers_json`，无法恢复未捕获请求头的旧请求；新请求仍在代理入口实时提取，不依赖修复任务。
用量重解析会覆盖所选范围内已有的解析结果，而不只处理未知记录。修复直接更新现有
`request_logs` / `usage_records`，不新增会话表，也不需要重启代理。

请求性能由 `request_logs` 保存上游响应头时间（TTFB）、首个实际输出内容时间
（TTFT）和总耗时。流式总耗时从请求发出持续到响应流结束；输出 Token 速率由
`output_tokens / (duration - TTFT)` 派生，不重复持久化。`usage_records` 分别保存
输入、缓存命中输入、未缓存输入、输出和总 Token；缓存命中率只在缓存 Token
信息可用时按 `cached_input / input` 聚合，未知值不按零命中处理。
每个路由 attempt 同时保存实际调用的完整 `upstream_url`，历史详情不依赖当前
渠道或账号 Base URL 反向推导。`req_headers_json` 和 `req_body_b64` 从该 attempt
最终执行的上游 Request 捕获，因此其中的鉴权凭据和模型均为路由改写后的实际值；
`res_headers_json` 和 `res_body_b64` 保存与之对应的第三方原始响应。客户端入站报文
不再作为有路由请求的请求侧日志落库。代理构造上游请求时不透传客户端的
`Content-Length`，由 HTTP 客户端根据完成模型改写后的最终 body 重新计算，避免长度
与报文不一致导致上游解析失败。客户端的 `Authorization` 和 `x-api-key` 同样不会
直接透传：代理先移除两者，再按目标渠道的 Bearer 或 X-API-Key 鉴权策略写入所选
账号的实际 API Key；`Host` / HTTP/2 `:authority` 则由最终上游 URL 生成。

请求与响应 Body 可按保留期限和总体积上限自动清理。`request_logs` 分别通过
`req_body_cleared_at` / `req_body_cleanup_reason` 与
`res_body_cleared_at` / `res_body_cleanup_reason` 保存清理时间及原因，前端不得把
已清理数据展示为“未捕获”。清理只处理输入、输出 Token 均已完成计算的记录；
体积上限是软限制，最近一小时的 Body 始终保留。流式日志在响应结束前保持
`duration_ms = NULL`，详情页仅在该状态下短周期刷新，结束后停止轮询。

上游返回 403 时，代理会检查结构化错误体；若错误码为 `account_deactivated` 或消息明确
表示 `api key is disabled`，当前账号会被标记为凭据不可用，并继续尝试同一聚合模型的
下一个候选（包括跨渠道降级）。该状态视为可恢复的临时停用：后续每个新请求仍会探测
一次该账号，探测成功后立即恢复为 `healthy` 并清除错误。普通 403 仍保持终态，避免对
权限或请求错误盲目重试；401 无效密钥仍需修改 Key 或显式测试连接成功后恢复。

模型价格不写入 SQLite。`config.json` 的 `channels_config.model_prices` 在应用启动时加载到内存，是当前成本估算的唯一价格来源。

### 统一 AI 成本账本（目标架构）

成本账本在现有 `request_logs` / `usage_records` 之上增量建设，不替换代理日志主链路。目标层级为 `cost_source -> product/account -> task -> session -> usage_event`，并由独立 `CostAllocationEngine` 按账期生成带版本、可信度和解释信息的 `cost_allocations`。

当前 `usage_records.estimated_cost` 仅表示公开模型价格估算，目标语义映射为 `list_price_cost`。实际现金扣费、套餐或资源包分配成本及 API 等价价值分别使用 `cash_cost`、`allocated_cost` 和 `equivalent_cost`，不得继续复用 `estimated_cost` 表示全部成本。

规划新增的 `cost_sources`、`usage_events`、`agent_tasks`、`agent_sessions` 和 `cost_allocations` 必须通过 SQLite migration 增量创建。网关请求幂等映射为 `usage_event`；无网关请求的 Agent turn、会话汇总、官方记录和手动用量也可以成为事件，因此 `request_id` 可空。

成本公式、金额精度、事务、账期重算和分配版本由 Rust 保证；React 负责来源配置、业务流程编排、状态反馈和解释展示。Adapter 同步失败不能影响代理或其他 Adapter，未经用户授权不读取第三方本地数据，默认不保存 Prompt、Response、对话正文或凭据。

当前已落地的第一步是只读数据源探针：`cost_ledger_source_probe` 复用现有会话元数据与时间线解析器，并通过统一 Observation / Evidence / ProbeReport DTO 报告 Flowlet 网关、Codex、Claude Code 和 OpenCode 的可用粒度、字段缺口、去重键、增量游标、格式指纹及可信度。探针不写 SQLite、不建立账本事实表，也不返回会话正文、凭据或原始文件路径；它用于在 migration 与成本引擎设计前验证真实数据边界。

完整需求、MVP 边界、实施阶段和验收标准见 [`ai-cost-ledger.md`](./ai-cost-ledger.md)。该章节描述目标架构，不代表相关表和引擎已经实现。

### analyzer

离线分析任务：

- 优先从 `response.usage` 提取 token。
- 拆分输入 Token、缓存命中输入、未缓存输入与输出 Token。
- 没有 usage 时标记为 `unknown`。
- 根据运行时内存中的模型价格计算成本。
- 支持按日期、渠道、账号、模型、客户端聚合。

价格以 `config.json` 为唯一真实来源；调整价格后需要重新加载应用运行时。

## 桌面端 UI

桌面 UI 只做管理、接入引导和状态观测，不承载复杂平台能力：

- 概览页展示代理状态、渠道账号、开放模型、客户端访问信息和 AI Agent 接入；
- 代理运行中提供“重启服务”，未运行或启动失败时提供相应启动动作；暂停代理只放在高级设置等低频入口；
- 渠道账号负责 API Key、连接测试、余额、资源包和模型同步，并可分别覆盖 OpenAI-compatible 与 Anthropic-compatible 上游 Base URL；
- 开放模型负责对外模型名、可用账号和启用状态；
- 客户端访问信息提供 Base URL 与默认掩码的 Client Token，并支持查看和复制；
- Agent 接入打开完整说明或配置抽屉，不只复制单个地址；
- 请求日志提供真实筛选、统计、分页、尝试链路和捕获详情；是否脱敏仅由 `log_capture.redact_sensitive_headers` 决定；
- OpenCode 会话页按稳定会话 ID 聚合客户端、请求、Token、费用和失败数，支持客户端筛选，并复用请求日志详情；
- 用量与成本页面只展示真实记录和当前价格配置计算出的结果。
- 设置页的数据修复展示四阶段进度和每阶段结果，用量页不再承担维护操作。

跨页面的大数展示统一使用 `src/shared/formatters/number.ts` 和 `CompactNumber`：中文紧凑格式采用
“万 / 亿 / 万亿”，英文采用 “K / M / B / T”，默认最多保留 1 位小数；紧凑组件同时通过
`title` 保留本地化后的精确整数。业务页面不得再分别维护 Token 或请求数的 K/M、万/亿换算。

应用窗口使用 Tauri 无系统边框模式，由前端壳提供可拖动区域以及最小化、最大化/还原、关闭按钮。关闭主窗口隐藏到托盘，只有“退出 Flowlet”才停止代理并退出应用。

全部界面文案使用中文。

## 非目标

第一阶段明确不做：

- Anthropic / Gemini / OpenAI 之间协议转换。
- Docker / Web Console。
- 云端账号系统。
- 团队计费系统。
- 通用的 MCP / Prompt / Skills 管理，以及脱离 Agent 数据源的跨 Agent 会话编辑。
- Channel marketplace。
- 复杂智能路由和小模型路由判断。
- 在主请求链路实时查询价格、余额、额度或用量。
