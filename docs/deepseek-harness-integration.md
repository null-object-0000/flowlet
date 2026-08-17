# DeepSeek Harness 接入说明

## 结论

DeepSeek Harness（DSH）在 Flowlet 中登记为本机 `web` Surface，而不是传统 CLI 或
Desktop：用户主要通过 `dsh web` 打开的本地浏览器界面使用它；npm/npx 是分发与启动方式，
`--profile headless` 是自动化 Runner 能力，两者都不改变产品 Surface。

本次核对源码为 `D:\GitHub\deepseek-harness`，提交
`47f943859bef60e4160492346772ded9b24f765a`（2026-08-13）。仓库 manifest 为
`0.1.0-rc.5`，用户实际通过 npm 运行的是 `0.1.0-rc.6`；因此 Flowlet 只依赖已由源码和
已安装包共同确认的稳定边界，不推断未发布内部 API。

## 五类 Adapter

| Adapter | 当前能力 | 明确边界 |
|---|---|---|
| Environment | 分别检测 `$DSH_HOME`/`~/.dsh`、3080 Web 运行状态、PATH 中的 `dsh` 与包版本 | 可只读识别无歧义的 `_npx/<hash>` 包版本并解析 bin 入口供任务执行；多版本共存时要求全局安装。已安装不等于 Web 正在运行 |
| Global Config | 解析配置状态；直接安全合并官方 YAML，一键写入/恢复 Provider、默认模型和 Client Token；精确会话插件、模型规格声明与交互确认桥均为默认关闭的高级能力 | 基础接入不依赖 DSH Web 或 Profile；复用 DSH 的文件锁协议，保留非受管配置和注释 |
| Session | 读取 `sessions/**/session.jsonl(.zstd)` v0，展示最终消息、工具事件和原生 Token 用量 | DSH 预发布格式无迁移承诺；其它版本明确拒绝；打包 delta chunk 不作为最终消息展示 |
| Identity | 使用官方 User-Agent 识别客户端；可选会话桥启用时读取并剥离 `x-flowlet-session` | 与其他 Agent 共用编译期 Identity Adapter registry，实时请求与历史修复规则一致 |
| Runner | 通过稳定全局 `dsh` 命令或 npx 缓存包入口（`node <包 bin>`）执行 `dsh --profile headless <task>` | 仅 fresh session；DSH 没有稳定 resume 参数时明确失败 |

## Flowlet Provider

DSH 的 `llm-pi-ai` Provider 使用 Flowlet OpenAI-compatible 端点：

```yaml
llm-pi-ai:
  providers:
    flowlet:
      displayName: Flowlet
      apiKeyEnv: FLOWLET_CLIENT_TOKEN
      api: openai-completions
      baseURL: http://127.0.0.1:18640/v1
      models:
        - id: flowlet-pro
        - id: flowlet-flash
agent-default-model:
  provider: flowlet
  model: flowlet-pro
```

当前不为 `flowlet-pro` / `flowlet-flash` 声明 `input: [text, image]`。Flowlet 的聚合路由尚未按
输入模态筛选候选，且内置聚合模型目录当前只承诺文本输入；若在 DSH 中宣称支持图片，图片会
通过本地校验后落到不一定支持视觉的上游，形成随机失败。后续只有在聚合路由具备稳定的视觉
能力声明与候选筛选后，才应为对应模型增加 `input: [text, image]`。

模型规格声明同样是默认关闭的高级能力：开启后，Flowlet 会在模型的 `models` 条目写入
`contextWindow: 1048576`（1M），使 DSH 按聚合模型的真实上下文规模做上下文预算；不声明
`maxTokens`——DSH 一旦在模型条目声明 `maxTokens` 就会把它变成每次请求自动携带的输出上限，
而 Flowlet 聚合路由各上游的上限不同，声明单一值会把能力锁死在最低值甚至触发低上限上游报错，
因此保持 DSH 默认的 32768 保守能力值，由后续代理层能力感知统一处理。该开关与 Codex 的
1M 语义一致：仅当 `flowlet-pro` / `flowlet-flash` 的所有启用路由都支持 1M 上下文时开启。
`contextWindow` 与 Provider 其余字段同属受管路径，随同一事务备份和恢复；关闭选项即移除声明，
settings.yaml 热加载、无需重启。

凭据单独写入 `$DSH_HOME/.credentials.yaml`：

```yaml
FLOWLET_CLIENT_TOKEN: <Client Token>
```

一键接入直接修改 DSH 官方配置文件。Flowlet 使用与 DSH 相同的相邻 `<file>.lock` 独占锁协议，
按叶子路径合并 `llm-pi-ai.providers.flowlet`、`agent-default-model.provider`、
`agent-default-model.model` 与专用凭据，再通过临时文件替换完成原子写入；两份文件任一写入失败时
会回滚。操作前只备份这些受管路径，恢复时不会覆盖其他 Provider、设置或用户后来增加的字段。
若现有受管父路径使用无法安全定点改写的行内/复杂 YAML，Flowlet 会明确报错而不会猜测重写。
该能力不依赖 DSH Web 正在运行：运行中由 DSH 热加载，未运行时在下次启动读取。

回归测试直接固定上游提交 `47f943859bef60e4160492346772ded9b24f765a` 中
`packages/boot/app-boot/src/profile.ts` 的 `PROFILE_PATCH_TEMPLATE`。契约测试覆盖官方以 `[]` 初始化的
`cordis.patch.yml` 从接入、重复接入、关闭高级能力到恢复的完整生命周期；每个中间产物都重新解析为
YAML 顶层数组，防止再次生成 `[]` 后直接追加 `- insert` 这类原子写入成功但语义无效的文件。
模型规格声明同样有基于真实上游 fixture 的生命周期契约：写入、重复写入、关闭、恢复每一步都重新
解析 `settings.yaml`，断言 `contextWindow` 出现在两个模型条目、关闭后不残留、恢复后逐字节还原。

任何可选高级能力（精确会话关联、模型规格声明、交互确认桥）都由用户显式开启，默认不启用；未开启时基础
接入不依赖 DSH Web 或 Profile。开关与主操作“重新写入 Flowlet 配置”互为独立：按钮按当前报告
状态保留已启用的高级能力，不会被默认值覆盖关闭。

只有用户显式开启“精确会话关联（高级）”后，一键接入才会通过 DSH 官方 Cordis Profile
配置，在每个已经初始化的 Profile 中部署受管的
`flowlet-session-bridge.mjs`。插件监听官方 `llm/stream` 瀑布取得当前原生 `sessionId`，并使用
`AsyncLocalStorage` 将它限定到当前异步请求；只有 Provider 为 `flowlet` 且目标 URL 位于配置的
Flowlet Base URL 下时才注入 `x-flowlet-session`。并发会话、其他 Provider 和其他 URL 不受影响。
插件文件与 `cordis.patch.yml` 的原始内容均纳入同一备份和事务，恢复接入时原样还原；DSH npm
包及其缓存文件不会被修改。

未启用该高级能力时，基础接入不要求 Profile 已初始化，仍可读取 DSH 原生会话，但不会把每条
代理请求精确合并到原生 session。关闭高级能力会移除受管 Cordis 块并恢复/删除受管插件文件。

Provider 配置与凭据可热加载。Profile 插件属于运行时组合能力，启用或关闭后应重启正在运行的 DSH；
之后无论通过 `npx`、全局 `dsh` 还是其他官方入口启动同一 Profile，插件都会自动加载。请求来源仍由
强制携带的 `User-Agent: deepseek-harness/...` 识别，不额外注入 `x-flowlet-client`。Flowlet 捕获
session id 后按 DSH UA 门控归属，并在转发上游前剥离该 Header；请求日志由此可与原生
`session.jsonl(.zstd)` 精确合并，不按时间猜测。

会话运行状态按最新一组 `turn/start` / `turn/end` 判断：新的 turn 已开始但尚未结束、且会话文件
仍在活跃更新时显示为运行中；`turn/end` 只代表单轮结束，不能用历史任意一条 completed 事件
判定整个 Web 会话已结束。异常退出遗留的未闭合 turn 会在新鲜度窗口后降级为空闲。

### 交互确认桥（approval bridge）

DSH 的 `ApprovalService` 提供 `approval/request` 瀑布：当工具需要批准时，瀑布按注册顺序依次询问
answerer，第一个返回 `allowed-once` / `rejected` / `cancelled` 的 answerer 生效；无人应答时
fail-closed 为 `unavailable`（工具被拒）。Web 模式下 approval 由 DSH 内置 answerer 转发给浏览器
用户确认。`--profile headless` 模式下无人应答，因此所有需要批准的操作都静默被拒。

只有用户显式开启“交互确认桥（高级）”后，一键接入才会在每个已初始化的 DSH Profile 中部署受管的
`flowlet-approval-bridge.mjs`。插件监听 `approval/request` 瀑布作为 answerer，把请求参数（toolName、
callId、reason、DSH 会话 id）经文件桥写入 `~/.flowlet/dsh-control/request-<uuid>.json`，并在等待
期间每秒刷新心跳（Flowlet 端按 5 秒新鲜度窗口过滤活跃请求）。用户确认后 Flowlet 写入
`reply-<uuid>.json`（`"allow-once"` / `"reject"`），插件轮询读回并换算为 DSH 的 `allowed-once` /
`rejected` 结果结束瀑布。请求被取消（signal abort）时插件返回 `cancelled`；超时
（默认 10 分钟）时返回 `unavailable`，避免 Flowlet 未运行时任务永久挂起。

该桥与已有 OpenCode 权限桥同构，复用同一个文件桥目录层次（`~/.flowlet/*-control/`）。桌面端在
会话详情侧滑的“概览”Tab 中展示待确认卡片（toolName + reason + 允许一次/否决按钮），
`waiting_user` 运行态与 OpenCode 的待确认状态共用同一套会话状态推断逻辑。移动端远程确认暂
未覆盖，后续通过泛化 `lan_sync` 的权限端点加入。

插件文件与 `cordis.patch.yml` 的原始内容均纳入同一备份和事务，旧备份（无 `approval_plugin` 字段）
会在 apply 时自动补录。关闭选项会移除受管块并恢复/删除受管插件文件。该能力独立于精确会话关联
和模型规格声明，三者的开关互不影响。

## 仍保留的能力边界

Flowlet 的会话详情使用与上游同版式的“对话 / 轨迹”双视图。轨迹读取 Session Adapter
输出的类型化 trace facts（seq、turn、step、callId、Provider、System Prompt、Tools 与输入/输出），
不在前端直接读取 DSH 文件，也不依赖 DSH Web 正在运行。视图与投影参考上游提交
`47f943859bef60e4160492346772ded9b24f765a` 的 `ui-conversation` / `ui-trajectory`，许可证记录见
仓库根目录 `THIRD_PARTY_NOTICES.md`。会话标题取最后一条原生 `session/title`；非用户来源的
`user/message` 投影为 Context（`source.plugin == "compact"` 的压缩检查点除外，它随
`compaction/summary` 折叠为 compacted 行），inbox/request transport 事件不生成可见行，工具
call/result 按 `callId` 合并，Turn 数按原生 turn 坐标去重而不是按 assistant step 计数。

v0 轨迹事件的解析覆盖（与官方 `ui-conversation` / `ui-trajectory` 消费的集合一致）：

- `turn/start` + `turn/end`：每个轮次投影为一条 turn 事件，状态按 `reason.kind` 映射
  （`completed` → completed、`error` → error、`aborted*` / `blocked` / `interrupted` → cancelled、
  文件内无 `turn/end` → running），并携带轮次时长（turn/end − turn/start）。
- `step/start` / `step/end` / `assistant/chunk`：步骤时长按 assistant/message − step/start 计算；
  首个携带内容的 chunk（text/reasoning/tool-call delta，含官方默认打包的
  `text-chunks` / `reasoning-chunks` / `tool-call-chunks` 存储行——取其 `time0`）到
  step/start 的间隔投影为 `timeToFirstTokenMs`。步骤或轮次关闭时仍未收到 result 的
  `tool/call`，按官方行为合成一条 `status = "error"`、`requestReason = "interrupted"` 的
  tool-result（异常退出会话同理在文件收尾处闭合）。
- `compaction/start|summary|end`：投影为 `compacted` 事件，正文为 `summary` 的 text 块拼接，
  归入 compaction/start 声明的轮次；压缩用量（`usage`）记录在事件上但不计入会话总用量
  （shadowed 事件已在各自时点计费）。
- 撕裂尾部容忍：与 `dsh-session-persistence-jsonl` 的 scanLog/scanZstdFrames 语义一致——只读
  前缀的完整记录；zstd 分帧按官方结构遍历（`blockSize = header >>> 3` 不掩码），损坏或未落盘
  完整的尾帧保留此前已解码内容，不因一个坏帧隐藏整个会话。`agent/inbox/spliced` 仅用于
  next-step 采纳判定（steering 标记），其余 transport 语义不生成可见行。
- `tool/code-dispatch-start` + `tool/code-dispatch`：子工具（code dispatch）投影为
  `parentCallId` 关联的 subtool call/result 行（arguments 为对象时 JSON 化），前端轨迹按
  `parentCallId` 归入子工具行。
- `approval/asked` + `approval/decided`：投影为 `approval` 事件（toolName + reason），
  decided 按 `id` 回写同一行的 outcome（allowed-once / rejected / cancelled / unavailable），
  对话渲染审批历史行。
- `llm/retry`：投影为 `model-retry` 事件（次数/延迟/失败原因）。

对话视图的节点投影与上游 `ui-conversation` 对齐：轮次由 `turn` 事件开合（不再按 user/message
切分），非 user 来源的 `user/message` 渲染为可展开的「上下文注入 / 跨会话召回」折叠行（首行
摘要 + 生产者/文件路径 + 141px 正文滚动），reasoning 渲染为「Think」折叠行（标题保留官方未
本地化的 "Think"，摘要取首行），`compacted` 渲染为「上下文已压缩」标记，`llm/retry` 投影为
模型重试行（次数/延迟/失败原因），轮次状态按 `turn` 事件 status 渲染（运行中脉冲 / 本轮运行
失败 + 失败消息 / 输出 token 上限提示 / 已停止 / 本轮已中断），已完成轮次的尾部展示用时 +
首 token + 解码吞吐（tok/s，输出 tokens ÷（时长 − 首 token））。`user/message` 的
来源 provenance（kind/form/生产者、next-step inbox 采纳的 steering）随 trace 透传，
由对话与轨迹共用。

轨迹视图与上游 `ui-trajectory` 对齐：主记录表为「事件 + 内容」两列（token/耗时等进入选中后
的详情检查器），隐藏的 prologue 并入首个可见轮次，`turn` 为空的记录进入「Between turns」区，
折叠摘要使用官方口径（`N step(s) · M tool call(s)`），时间轴条带对助手消息按 TTFT/解码分段
渐变（--ttft-frac），支持拖选时间区间过滤（右键/双击清除），长列表锚定尾部窗口并提供
「加载更早」分页。

Markdown 渲染器补齐上游 `ui-primitives` 的富文本能力：shiki 4.x 代码高亮（JS 正则引擎 +
css-variables 主题，boot 语法 ts/bash/json，常用语言按需加载，未知语言回退纯文本）、KaTeX
数学公式（micromark math 扩展 + 官方三臂降级渲染）、GFM 脚注（`user-content-fn-*` id +
`↩` 回链，DOM 契约与官方 fixtures 一致）。额外移植了上游的两个 micromark 语法扩展：
`cjkFriendlyStrong`（让 `**强调**` 在无空格 CJK 续排时正常闭合）和 `mathCompatibility`
（`\(...\)` 行内 TeX 与 `\[...\]` 多行显示数学，以及同行 `$$...$$` 显示公式）。

## 已知取舍与未完成项

以下为与官方服务端/客户端差距，经评估后决定暂不实现或属于产品方向差异：

- **轨迹虚拟化**：7,000+ 事件会话的性能由尾窗分页（400 条 + 「加载更早」）保障，未引入
  `@tanstack/react-virtual`，不影响桌面端可用性。
- **流式增量 Markdown 解析**：Flowlet 是历史会话查看器，无需 `IncrementalMarkdownParser`
  的流式增量解析（`animation-frame` 发布节奏），使用一次完整解析即可。
- **`tool-call-chunks` 内容投影**：打包的 `tool-call-chunks` 存储行仅用于流式工具调用重建，
  历史文件中已有完整 `tool/call` 事件（含 name/arguments）。
- `tool/code-dispatch` 的 arguments 内含时间戳等元数据，不参与内容展示。
- `mathCompatibility` 的 `$$...$$` 同行显示公式与 `micromark-extension-math` 默认行为略有
  重叠（后者默认 `$...$` 行内，`$$...$$` 单行在无 `mathCompatibility` 时解析为行内公式），
  两者同时注册时 `mathCompatibility` 的 `sameLineDollarMathFlow` 优先（concrete: true），
  将一行 `$$...$$` 解析为显示公式。
- `cjkFriendlyStrong` 的闭合条件严格遵循官方实现：仅当 `**` 序列前一字符为 Unicode 标点符号
  且后一字符为 CJK 时额外闭合；其他无空格续排场景沿用 CommonMark 默认行为。

- DSH headless 提供稳定 resume/session-id 参数后，再开放 continuation task。
- DSH 提升 `SESSION_FORMAT_VERSION` 时，先按新版本语义补迁移/解析测试，再扩大接受范围。
- 思考模式（`reasoningEfforts` / `compat.thinkingFormat` 声明）未在本次提供：Flowlet 聚合路由
  横跨多种上游思考格式（deepseek 的 `thinking` + `reasoning_effort`、qwen 的 `enable_thinking` 等），
  仅在 DSH 侧声明一种格式仍无法覆盖全部上游，且代理层按上游转换思考参数涉及请求/响应改写，
  与当前“不做跨协议转换”的协议原则冲突；待代理层具备按上游能力转换思考参数的阶段再提供。
- 模型规格当前只声明 `contextWindow`，不声明 `maxTokens` 与 `input` 模态，理由见上文。
- 交互确认桥的移动端远程确认未在 MVP 覆盖，后续通过泛化 `lan_sync` 的权限端点加入。
