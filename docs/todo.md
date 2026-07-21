# 任务列表

## UI/UX 优化

- [x] 概览页的 AI Agent 接入模块，以及模型服务页、用量成本页的渠道成本模块的滚动条都是原生样式吧，应该改成和概览页的渠道账号模块以及开放模型模块一样，并且这个滚动条样式应该做成全局统一的
- [x] 请求日志列表页时间要把日期也放出来，可以只放到月、日，年不放，类似会话管理页的时间，但是要到秒，这里都统一下吧，请求日志、会话管理、任务日志三个列表页面的时间展示格式
- [x] 用量成本页的模型列表增加一个费用列，现在只有费用占比，另外这里的价格符号咋都是 $ 不应该跟着模型计价货币的不同采用￥或者$嘛
- [x] 用量成本页中的费用“仅统计 Token 与价格均已知的请求”这句文案不需要单独占一行，可以用一个小提示 icon 放在模块标识旁边，然后鼠标悬浮展示吧
- [ ] 请求日志列表中渠道 / 账号列现在有点宽，有点浪费
- [ ] 用量成本页的 Tokens 日历热力图样式整体要优化下，另外鼠标悬浮上去的 token 信息展示应该和其他页面的 token 信息展示一样

## Agent 接入

- [x] https://code.claude.com/docs/zh-CN/model-config#environment-variables 参考官方文档，看我们 Claude Code CLI 的配置覆盖是不是还不够全面
- [x] Pi 有 Desktop 版吗，没有的话就不该在概览页的 AI Agent 接入模块中展示暂不支持，以及弹窗详情中有 Desktop 的 Tab
- [x] Pi 区分主模型、快速模型吗，如果区分，为啥我们使用写入 Flowlet 配置功能后快速模型展示的是 - ，如果不支持的话就可以直接去掉呀
- [x] Pi 目前看请求里没有会话标识，并且我们也没有去实现针对 Pi 的原生会话数据读取，这是两个工作，你都看看 —— 两项均已实现：(1) 请求会话标识：Pi 走 OpenAI 兼容 SDK、原生请求不带会话标识，故 Flowlet 在写入 Pi 配置时同步写入 `~/.pi/agent/extensions/flowlet.ts`（Pi 官方扩展机制，`before_provider_headers` 事件通过 `ctx.sessionManager.getSessionId()` 实时注入 `x-flowlet-session`，以 `x-flowlet-client: pi` 标记头为门控，仅污染 Flowlet 渠道请求）；代理侧 `extract_agent_session` 与历史修复路径 `agent_session_from_json` 同步新增 Pi 分支识别该头，`apply_request_headers` 转发上游前将其与 `x-flowlet-client` 一并剥离。(2) 原生会话读取：Pi 会话存于 `~/.pi/agent/sessions/<编码后的cwd>/<timestamp>_<uuid>.jsonl`，v3 JSONL 树状结构（id/parentId 支持原地分支）；`agent_session_metadata.rs` 注册目录监听并解析头行（id/cwd/timestamp/parentSession）+ `session_info` 名/首条 user 消息为标题，`agent_session_timeline.rs` 从叶子回溯重建活动分支并映射为时间线事件。注入的 session UUID 与原生会话文件头行 `id` 一致，故 `merge_agent_session_catalog` 可按 `(agent_type, session_id)` 将「经过 Flowlet 的观测会话」与「原生会话」精确合并。前端会话管理页客户端筛选器与 `agentLabel` 已补充 Pi；手动配置片段补上扩展文件内容
- [x] Codex 账号与用量支持周期性后台定时自动同步，单周期不用太频繁，比如五分钟之类的，你可以看看多少时间合适，并且这个要进入到任务日志中 —— 已实现：AppShell 挂载 `CodexAccountAutoSync`，启动约 20 秒后首次执行、此后固定每 5 分钟一轮（前后台同周期，用量窗口本身是 5 小时/周级粒度，5 分钟足够新鲜且避免高频打官方用量接口）。Rust 新增细粒度 command `sync_codex_accounts`：未发现任何 Codex 登录凭据或托管多账号时直接跳过（不建任务、不发网络请求、不拉起 app-server）；否则以 job_type `codex-account-sync` 记入 `background_jobs` / `background_job_events`，同步成功后失效 Codex 账号查询缓存。任务日志页新增「Codex 账号同步」类型筛选，详情展示账号数量、失效账号、失败账号与总耗时；同一时刻只允许一个 Codex 同步运行
- [x] 是否开启 1m 的配置可以让用户自己选择吧，你看是放在模型服务里好还是放在具体某个 agent 接入详情弹窗里好 —— 已放在 Claude Code 接入详情「全局配置」中（`[1m]` 是客户端侧上下文预算配置、且为 Claude Code 专属机制，不属于模型能力，故不放模型服务页）。「1M 长上下文」开关默认关闭，开启后主模型环境变量写入 `[1m]` 后缀，配置片段与 inspect 状态同步；代理层防御性剥离入站 `[1m]` 后缀并剔除 `context-1m` beta 头
- [ ] Explore(Map OpenCode session implementation) Initializing… Error: flowlet-pro is temporarily unavailable, so auto mode cannot determine the safety of Agent right now. Wait briefly and then try this action again. If it keeps failing, continue with other tasks that don't require this action and come back to it later. Note: reading files, searching code, and other read-only operations do not require the classifier and can still be used.
- [ ] 支持检查 Agent 最新版本号，并提示用户可以升级，如果可以的话再加上更新版本记录（并支持翻译成目标语言）
- [ ] 现在 Codex 有定时同步，所以打开 Agent 弹窗详情就不自动触发刷新同步了，除非用户自己手动强制刷新

## 请求日志

- [ ] 性能统计上增加 RPM、TPM 的概念，耗时也需要再拆分下 TTFB、TTFT
- [x] 请求日志列表中增加是否是流式的标识，可以不用单独一列，你看放在哪合适
- [x] 筛选模型类型的时候，如果选对外模型那就是筛选对外模型，而不是路由和对外都筛选
- [-] 出一套清理历史的响应报文的机制，可以是基于时间、也可以基于大小的清理机制
- [-] Windows 待机恢复后请求失败（其实根因应该是待机中应该也要能运行才对）./docs/windows-suspend-resume-network-resilience.md

## 模型服务

- [x] 模型基础信息：直接渠道模型（LongCat-2.0、deepseek-v4-pro 等）右侧详情新增「基础信息」区块（上下文窗口、最大输出、输入/输出定价，数据来自渠道模型同步与 config.json `model_prices`，缺失显示 —）。经确认 flowlet-pro/flowlet-flash 聚合模型保持渠道路由面板不变。Claude Code 1M 长上下文已按用户可选开关实现：Claude Code 接入详情「全局配置」中提供「1M 长上下文」开关（默认关），开启后主模型环境变量写入 `[1m]` 后缀（网关场景官方推荐做法，Claude Code 发送前剥离后缀），配置片段同步展示；代理层防御性剥离入站模型名 `[1m]` 后缀、转发前剔除 `context-1m-2025-08-07` beta 头。注意 flowlet-pro 部分后端（如 Kimi K3 约 256K）撑不满 1M 窗口，开关旁已给出提示。参考 https://code.claude.com/docs/zh-CN/model-config#pin-models-for-third-party-deployments

## 渠道账号

- [ ] 渠道账号保存后，资源模式就不允许切换了

## 未来规划

- [-] 我想通过内置浏览器内容让用户在我们 Flowlet 的环境里进行官网 Web 登陆然后我们就能自动解析出那些不支持 API 方式查询的套餐余量或是 API 余额了 ./docs/scrape-balance-requirements.md
- [ ] 可以出一个任务分发功能，我们只管提交 todo，并且分配给不同的 AI Agent，然后 Flowlet 来调度（这里一定需要用到工作树，不然太乱了）
- [ ] 要想一种办法可以让多个设备上的数据互相都能看到，但明细数据不需要混合在一起，可以按设备分开筛选查看，用量成本这类统计向的数据需要有汇总的版本，当然也可以查看指定设备上的情况
- [ ] 要重前端轻后端，并且要重点看下后端代码是否有超大文件，前端也可以顺带看下
