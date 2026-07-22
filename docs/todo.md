# 任务列表

## UI/UX 优化

- [x] 用量成本页中的费用“仅统计 Token 与价格均已知的请求”这句文案不需要单独占一行，可以用一个小提示 icon 放在模块标识旁边，然后鼠标悬浮展示吧
- [ ] 请求日志列表中渠道 / 账号列现在有点宽，有点浪费
- [ ] 用量成本页的 Tokens 日历热力图样式整体要优化下，另外鼠标悬浮上去的 token 信息展示应该和其他页面的 token 信息展示一样
- [-] 请求日志、会话管理、任务日志、用量成本四个页面的数据都可以做成自动刷新的（现在应该部分就是）但是 UI 上还有差异，可以都做成请求日志的设计思路，右上角有个实时更新中的信息露出，点击后可以切换是否实时更新，然后可以把手动强制刷新按钮放在这个切换自动/手动的附近也就是在一行上，你看看怎么设计更好，以及也可以添加上次刷新数据的时间以及下次刷新数据的时间信息露出，然后统一做个公共组件之类的，四个页面复用这个 UI

## Agent 接入

- [x] 是否开启 1m 的配置可以让用户自己选择吧，你看是放在模型服务里好还是放在具体某个 agent 接入详情弹窗里好 —— 已放在 Claude Code 接入详情「全局配置」中（`[1m]` 是客户端侧上下文预算配置、且为 Claude Code 专属机制，不属于模型能力，故不放模型服务页）。「1M 长上下文」开关默认关闭，开启后主模型环境变量写入 `[1m]` 后缀，配置片段与 inspect 状态同步；代理层防御性剥离入站 `[1m]` 后缀并剔除 `context-1m` beta 头
- [ ] Explore(Map OpenCode session implementation) Initializing… Error: flowlet-pro is temporarily unavailable, so auto mode cannot determine the safety of Agent right now. Wait briefly and then try this action again. If it keeps failing, continue with other tasks that don't require this action and come back to it later. Note: reading files, searching code, and other read-only operations do not require the classifier and can still be used.
- [ ] 支持检查 Agent 最新版本号，并提示用户可以升级，如果可以的话再加上更新版本记录（并支持翻译成目标语言）
- [x] 现在 Codex 有定时同步，所以打开 Agent 弹窗详情就不自动触发刷新同步了，除非用户自己手动强制刷新

## 请求日志

- [ ] 性能统计上增加 RPM、TPM 的概念，耗时也需要再拆分下 TTFB、TTFT
- [x] 请求日志列表中增加是否是流式的标识，可以不用单独一列，你看放在哪合适
- [x] 筛选模型类型的时候，如果选对外模型那就是筛选对外模型，而不是路由和对外都筛选
- [-] 请求明细改为文件存储、SQLite 保留索引与统计字段，并继续支持按时间和体积清理；实施计划见 [`request-capture-storage-plan.md`](./request-capture-storage-plan.md)
- [-] Windows 待机恢复后请求失败（其实根因应该是待机中应该也要能运行才对）./docs/windows-suspend-resume-network-resilience.md
- [ ] 设置界面可以新出一个配置项，货币或者说是计价方式，目前支持美元和人民币两种，然后模型也分两种货币方式，一种是官方就同时支持两种货币的，那么取官方价，还有一种可能官方只有美元或者只有人民币的，那么就需要汇率换算，汇率就先 config.json 中配死一个即可
- [-] 被清理的 Body 不应该是未捕获，应该是数据过期被清理之类的文案提示才对

## 模型服务

- [x] 模型基础信息：直接渠道模型（LongCat-2.0、deepseek-v4-pro 等）右侧详情新增「基础信息」区块（上下文窗口、最大输出、输入/输出定价，数据来自渠道模型同步与 config.json `model_prices`，缺失显示 —）。经确认 flowlet-pro/flowlet-flash 聚合模型保持渠道路由面板不变。Claude Code 1M 长上下文已按用户可选开关实现：Claude Code 接入详情「全局配置」中提供「1M 长上下文」开关（默认关），开启后主模型环境变量写入 `[1m]` 后缀（网关场景官方推荐做法，Claude Code 发送前剥离后缀），配置片段同步展示；代理层防御性剥离入站模型名 `[1m]` 后缀、转发前剔除 `context-1m-2025-08-07` beta 头。注意 flowlet-pro 部分后端（如 Kimi K3 约 256K）撑不满 1M 窗口，开关旁已给出提示。参考 https://code.claude.com/docs/zh-CN/model-config#pin-models-for-third-party-deployments
- [ ] 模型的一些基础信息包括定价改成从我们另一个项目公开的数据获取：请按照 docs/agent-integration-prompt.md 的规则，将 models-cn 接入当前项目。数据地址：https://null-object-0000.github.io/models-cn/api.json 目标：读取中国大陆模型厂商的官方价格和模型信息，并实现可测试的模型查询与费用估算能力。要求：人民币官方价格优先；不得硬编码价格或用汇率伪造人民币官方价；官方字段缺失时允许使用 models.dev 补全，但必须保留参考来源，不能覆盖官方值；正确处理币种、市场和标准价/优惠价；仅在 `input.cacheHit` 存在时处理缓存命中价格。请先检查当前项目技术栈和已有模型配置，再实施修改、运行测试，并说明改动文件及使用方式。

## 渠道账号

- [x] 渠道账号保存后，资源模式就不允许切换了

## 未来规划

- [-] 我想通过内置浏览器内容让用户在我们 Flowlet 的环境里进行官网 Web 登陆然后我们就能自动解析出那些不支持 API 方式查询的套餐余量或是 API 余额了 ./docs/scrape-balance-requirements.md
- [ ] 可以出一个任务分发功能，我们只管提交 todo，并且分配给不同的 AI Agent，然后 Flowlet 来调度（这里一定需要用到工作树，不然太乱了）
- [ ] 要想一种办法可以让多个设备上的数据互相都能看到，但明细数据不需要混合在一起，可以按设备分开筛选查看，用量成本这类统计向的数据需要有汇总的版本，当然也可以查看指定设备上的情况
- [ ] 要重前端轻后端，并且要重点看下后端代码是否有超大文件，前端也可以顺带看下
