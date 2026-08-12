# Flowlet 架构说明

## 目标

Flowlet 的第一阶段目标是做一个桌面优先、本地运行、多协议透明转发的 AI 请求路由客户端。长期产品方向是面向 AI Agent 的本地使用与成本控制台：代理是高精度数据入口，但代理外 Agent 使用也可经授权的本地 Adapter、导入或手动记录进入统一成本账本。当前阶段仍采用 LongCat + DeepSeek first 策略，优先把 LongCat / DeepSeek 的 OpenAI-compatible 与 Anthropic-compatible 两种透明转发入口做完整，并以 Claude Code 接入作为核心验证场景。

当前正式数据模型已经采用 Channel / Account / Model 架构，不再使用旧 Provider 原型或 `provider_id = default` 逻辑。后续修改必须基于当前迁移后的真实表结构，不得以“尚未实现”为由再次破坏式重建。

模型身份与路由来源必须分离：规范化模型 ID 唯一决定模型的官方厂商、品牌图标、
官方规格和基准价格；Channel / Account 只描述请求实际经过的路由。相同模型 ID
即使同时由官方账号和自定义中转账号提供，也只形成一个模型实体和一条模型用量汇总，
实际渠道与账号仍保留在路由配置、请求日志和渠道成本维度中。自定义渠道没有显式价格时，
费用估算回退到模型官方归属的基准价格。

产品重心是开箱即用的本地 AI 请求路由体验：普通用户选择渠道模板、填写 API Key、选择模型即可接入；中转站等非内置服务使用 `custom` 渠道模板，在账号级填写 OpenAI/Anthropic Base URL，并从标准 OpenAI-compatible `/models` 拉取模型。Flowlet 只允许勾选全局白名单内的返回模型，路由严格取最近一次 `/models` 结果、用户选择和全局白名单的交集，只为已配置地址的协议生成路由，仍不做跨协议转换。更高级的 Header、价格和错误识别规则继续保留为后续能力。

账号保存后只自动补齐对应的直接模型路由；只有全局第一个渠道账号的新直连路由默认开启，后续新增账号的新直连路由默认关闭。`flowlet-pro` 与 `flowlet-flash` 不再按模型名或渠道预设推断候选，用户在模型服务页从已有渠道模型中显式添加、移除、启停和排序。已有聚合路由保持不变，直到用户主动调整。

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
  ├─ model-catalog.json                内置模型身份目录（白名单 / 归属 / 别名）
  ├─ plugin-registry.json              内置渠道、模型目录和 Agent 贡献注册表
  ├─ src-tauri/                        Tauri 2 桌面壳
  │  └─ src/
  │     ├─ lib.rs                      Tauri 应用入口和 command 注册
  │     ├─ main.rs                     桌面进程入口
  │     ├─ commands/                   Tauri command 薄适配层（按领域分组）
  │     │  ├─ mod.rs                   稳定的 command 门面与统一导出
  │     │  ├─ agent.rs                 Agent 环境、账号与全局配置
  │     │  ├─ account_workspace.rs     S3 渠道账号工作区命令
  │     │  ├─ channels.rs              渠道、账号、模型与路由配置
  │     │  ├─ device_sync.rs           设备用量导入、导出与同步
  │     │  ├─ maintenance.rs           应用诊断、配置与存储维护
  │     │  ├─ observability.rs         请求日志、会话与后台任务观测
  │     │  ├─ proxy.rs                 代理生命周期与连接测试
  │     │  ├─ scrape.rs                渠道目录、资源同步与控制台抓取
  │     │  └─ usage.rs                 用量分析、修复与汇总
  │     └─ core/
  │        ├─ mod.rs                   Core 模块出口
  │        ├─ config.rs                运行时配置结构
  │        ├─ channels_config.rs       config.json 反序列化与渠道默认值
  │        ├─ account_workspace_sync.rs 加密账号目录与多桌面同步
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
  │        ├─ storage_device_usage.rs  跨设备用量导入与聚合
  │        ├─ storage_stats.rs         统计查询
  │        ├─ storage_tasks.rs         后台任务持久化
  │        ├─ storage_tests.rs         存储测试
  │        ├─ sync.rs                  模型 / 价格 / 余额异步同步任务
  │        ├─ usage.rs                 Token 提取与成本估算
  │        ├─ logging.rs               日志捕获与脱敏
  │        ├─ metrics.rs               运行时指标
  │        ├─ model_catalog.rs         模型身份目录加载、校验与查询
  │        ├─ plugin_registry.rs       插件清单加载、冲突校验与贡献查询
  │        ├─ agent_environment.rs     Agent 本机安装探测
  │        ├─ agent_global_config.rs   Claude Code / OpenCode 全局配置写入与恢复
  │        ├─ agent_session_identity.rs 请求头中的 Agent / Session 统一识别
  │        ├─ agent_session_sources.rs  原生会话数据源共享工具
  │        ├─ agent_session_metadata.rs 原生会话目录与会话列表
  │        ├─ agent_session_timeline.rs 原生摘要与最后交互内部解析
  │        ├─ agent_source_watcher.rs  Agent 数据源文件监听
  │        ├─ codex_account.rs         Codex 账号与用量
  │        ├─ cost_ledger_source_probe.rs 成本账本只读数据源探针
  │        └─ web/                     内嵌 Web 资源
  └─ docs/                             产品和架构文档
```

应用无条件加载 `src` 中的 Semi Design 前端。旧 Mantine 前端、`ui.version` 入口选择和 legacy fallback 已删除。前端分层与依赖方向见 `AGENTS.md` 第 10 节「前端开发原则」。

### Core 与 Host 边界

`core::services::FlowletServices` 是不依赖 Tauri 的应用服务容器，统一拥有 SQLite
`Storage`、渠道配置、运行时配置快照和代理生命周期。Desktop 与 headless Host 使用同一个
`FlowletServices::open` 完成渠道配置回退、内置配置合并、默认预设初始化、旧空账号清理、
固定虚拟模型补齐和默认路由合并，并通过同一组 `start_proxy` / `stop_proxy` 方法管理代理。

Tauri `AppState` 组合 `FlowletServices`，只额外承担窗口、托盘、WebView、设备身份、文件监听和
平台事件等 Host 能力。headless 不再复制 Storage、快照和代理启动装配，也不再因没有账号或路由
而拒绝监听；空配置下的代理启动语义与桌面端一致。

### 模型目录边界

仓库根目录 `model-catalog.json` 是 Flowlet 支持模型身份的单一事实源，固化规范模型 ID、
官方渠道归属、上游别名与 `models-cn` provider 映射。Rust 通过编译时 `include_str!` 加载并
校验目录，前端通过 TypeScript JSON module 读取同一文件；模型白名单、规范化、品牌归属和
动态规格目录查找不再分别维护硬编码映射。

`config.json.channels_config.default_exposed_models` 仍用于渠道预设漂移检测，不决定全局
白名单。运行时同步的 `models-cn.json` / `models-dev.json` 只补充规格与价格，不能动态扩大
可开放模型范围。修改内置模型目录需要重新构建应用；同步规格和价格无需重启。

### 插件注册边界

`plugin-registry.json` 是内置扩展贡献的声明式入口，目前注册三种贡献：`channel`、
`model-catalog` 和 `agent`。它统一控制内置渠道顺序、模型目录来源，以及 Agent 的身份、
展示元数据、环境检测适配器 ID、全局配置适配器 ID、协议端点和 npm 版本来源。渠道贡献也
显式声明预设适配器 ID，不再假设贡献 ID 必须等于底层实现 ID。Rust 与前端分别加载同一
清单；当前适配器化清单为 schema v2，启动时校验插件 ID、贡献 ID、必填适配器及编译期
适配器白名单。

注册表只声明能力，具体渠道同步、余额查询、Agent 安装检测和全局配置写入仍由编译进应用的
受控适配器实现；同一适配器可以被多个声明式贡献复用，但未知适配器会在注册表加载时明确失败。
当前不加载第三方动态库、不执行插件脚本，也不允许插件绕过类型化 command、
SQLite 或运行时配置快照直接修改代理状态。修改内置注册表需要重新构建应用。

前端 Agent 概览使用 `useQueries` 按注册表一次性创建环境探测 Query，并通过统一的
`useAgentGlobalConfig(agentId)` 处理配置检查、写入和恢复；领域 command 只保留带 `agentId`
的通用边界。新增已注册 Agent 不再复制专用 Query/Mutation Hook，但仍必须提供注册表声明的
Rust 编译期环境与全局配置适配器。接入抽屉同样通过 `globalConfigAdapterId` 选择前端
`AgentAccessAdapter`，由适配器提供安装名称、额外状态、配置开关、写入选项和手动配置片段；
通用 SideSheet 不再按 Agent ID 维护条件分支。Codex 手动配置中的模型目录直接读取仓库根目录
`codex-models.json`，避免前端常量与 Rust 内置目录漂移。

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
- Account 是用户在某个渠道下配置的一组访问身份；每个账号只有一个参与模型请求和路由的 API Key。OpenRouter 可额外保存一个只读账户 Credits 的 Management Key，该辅助凭证不参与代理请求。
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

## 运行时配置快照

渠道模板、渠道账号、路由候选、路由规则和虚拟模型由 Rust 端
`RuntimeConfigStore` 统一发布为带单调递增 `revision` 的不可变
`RuntimeConfigSnapshot`。SQLite 仍是持久化事实源；配置 mutation 只有在持久化成功后
才发布下一版内存快照。

代理处理单个请求时只读取一次当前快照，并在该请求的完整路由过程中持有同一个
`Arc<RuntimeConfigSnapshot>`。因此同一请求使用的渠道、账号、路由和规则必定属于同一
revision，不会观察到多个配置集合依次更新时的中间状态。旧请求可以继续安全使用旧快照，
新请求自动读取最新 revision，无需重启代理。

路由性能分数和轮询游标属于易变运行态，不进入配置快照；Client Token、监听地址和日志捕获
配置也保持各自现有的生命周期。该快照机制没有改变 SQLite 表结构或 `config.json` 字段。

## Agent 本机环境探测

Agent 接入向导通过只读 Tauri command 探测本机 CLI 环境，前端不直接读取文件系统或执行 Shell。调用链为：

```text
Agent 接入组件
  -> src/domains/agent/commands.ts
  -> detect_agent_environment
  -> src-tauri/src/core/agent_environment.rs
```

Claude Code 探测同时检查 PATH 和官方常见安装位置，返回当前主安装、全部候选安装、可执行文件路径、安装目录、版本及安装方式。OpenCode 探测同时覆盖 CLI 与 Desktop：CLI 检查 PATH、原生脚本、npm、Bun 等常见位置并执行版本命令；Desktop 检查各平台常见应用位置且不会启动桌面进程。ChatGPT（Codex）同样同时探测 Desktop 与 Codex CLI；CLI 覆盖 PATH、npm 和官方独立安装目录，并通过 `codex --version` 读取版本。保留全部候选用于识别多版本或 CLI/Desktop 并存；探测结果只存在于 TanStack Query 内存缓存，不写入 SQLite 或 `config.json`。

Codex CLI 当前支持安装探测、账号用量复用和原生会话读取。Codex 与 Claude Code、OpenCode、Pi 同为标准一等 Agent，由 `agent_global_config` 模块一键写入 `~/.codex/config.toml`（`[model_providers.flowlet]` 经 Responses wire API 指向本地代理、`requires_openai_auth = true`）与 `~/.codex/config.toml`，受管字段先备份再写入、恢复时还原；Codex CLI、ChatGPT 桌面端与 VS Code 插件共享同一份配置。账号观测（订阅用量、套餐、Credits、重置机会）承载于概览页渠道账号卡片的伪账号行——该伪账号只读、不参与路由、不开放编辑，行点击打开只读详情抽屉。当前准确支持范围见 [`support-matrix.md`](./support-matrix.md)。

Claude Code 用户级全局配置由独立的 `agent_global_config` 模块管理。前端只读取脱敏状态并触发应用或恢复；Rust 解析 `CLAUDE_CONFIG_DIR` / `~/.claude/settings.json`，安全合并 Flowlet Base URL、Client Token 和模型别名映射。修改前只备份受管字段，恢复时不覆盖用户后续新增的其他 Claude 设置。完整字段和优先级见 [`claude-code-global-config.md`](./claude-code-global-config.md)。

OpenCode CLI 与 Desktop 共用用户级配置。Flowlet 在 `~/.config/opencode/opencode.jsonc`（或已有的 `opencode.json`）中结构化合并 `provider.flowlet`、`model`、`small_model`，并把本地 Server 固定到 `127.0.0.1:4096`；Client Token 单独写入 `~/.local/share/opencode/auth.json` 的 `flowlet` 凭据项。JSONC 修改保留未受管字段和注释；配置与凭据均先备份受管值，再支持恢复。完整行为见 [`opencode-global-config.md`](./opencode-global-config.md)。

Agent 接入抽屉中的 Client Token 默认使用固定长度掩码；查看按钮只在当前抽屉会话中临时展示，关闭后恢复掩码，复制始终使用真实值。Claude Code 手动片段与一键写入字段保持一致；OpenCode 将 Provider 配置和 `auth.json` 凭据拆成两个片段。OpenCode 配置与凭据采用双文件事务写入，第二个文件失败时恢复两个文件的原始字节内容。

Agent 安装引导与版本更新提示：`check_agent_latest_versions` command（`src-tauri/src/core/agent_version.rs`）从 npm registry 并行查询 Claude Code / OpenCode / Pi / Codex 四个包的最新发布版本，带进程内 TTL 缓存（15 分钟）与单 Agent 独立错误处理，只做提示、不执行升级。npm latest 对应的是各 Agent 的 **CLI 包版本**，因此更新比较只取「CLI 面」的已安装版本（`cliInstalledVersion`，`src/domains/agent/versions.ts`）——ChatGPT Desktop / OpenCode Desktop 使用独立版本体系，不参与比较，概览页 Logo 的 Badge dot 与抽屉的版本对比都只在 CLI 标签页出现。前端用纯函数 `isNewerVersion` 判断「有新版」：接入抽屉展示已安装版本与最新版本、检测到新版本时给出「x → y」与官网更新说明链接。未检测到安装时，抽屉内提供官网安装引导链接（Claude Code / OpenCode / Pi / Codex 官方地址）。版本检查数据仅存在于前端 Query 缓存，不写入 SQLite 或 `config.json`。

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
- 保存一个参与模型请求的 API Key；OpenRouter 可选保存仅用于账户 Credits 查询的 Management Key。
- 保存优先级。
- 保存是否启用。
- 保存最近使用时间、最近错误和备注。

当前版本明确一个账号只对应一个路由 API Key，不引入通用 Credential 概念。OpenRouter 的 Management Key 是渠道专用辅助字段，只调用官方 `/credits`，不会进入请求转发。普通用户不需要理解 `base_url`、`auth_type`、`headers_json` 等技术字段。UI 默认展示“选择渠道、填写账号 API Key、选择模型、测试连接、保存并启用”，高级设置再暴露底层字段。

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

渠道资源自动同步在应用启动约 30 秒后首次执行，之后每 5 分钟执行一轮。已启用、使用官方端点且渠道声明支持余额查询的 DeepSeek / Kimi 账号直接调用官方余额 API，不受历史 `resource_sync_mode` 字段影响；配置了自定义 Base URL 的账号不得假定中转服务兼容官方余额接口，因此跳过自动查询。支持控制台抓取的账号仍使用 `channel_accounts.resource_sync_mode` 记录同步方式：`manual` 由用户维护余额或资源包，`auto` 由隐藏 WebView 使用页面自身的 Cookie、签名和请求周期同步。Qwen Token Plan 与 LongCat hybrid 固定使用 `auto`，账号编辑器不提供手动维护入口；SQLite 迁移会把历史 Qwen Token Plan 账号归一化为 `auto`，其他旧账号迁移后默认保持 `manual`。

两类账号由同一个 Rust 周期命令筛选并串行执行，以 `job_type = channel-resource-sync` 写入任务日志，共用防重入保护；任务汇总以 `officialApiAccounts` 和 `consoleAccounts` 区分同步方式。聚合抓取只接受精确匹配的业务 API，并按页面阶段等待配置声明的必需响应槽位，页面 document、监控埋点或普通用量明细不得触发阶段完成。后台控制台抓取同一时刻只处理一个账号：按该账号独立的数据目录创建隐藏 WebView，完成或失败后立即关闭，再处理下一个账号；Cookie / Local Storage 等登录态保留在数据目录中，不依赖 WebView2 进程常驻。每个账号一个独立 profile（`scrape-webview-<account_id>`），与主窗口 profile（`main-webview`）隔离，避免多个抓取窗口共享默认目录时后一个继承前一个的登录态。WebView 数据根目录由 `core::webview_profile::webview_data_root` 解析：便携版（exe 旁存在 `portable.tag`）落在 exe 旁 `data/webview` 子目录，随整个便携目录随身拷贝，与根目录的 `config.json` / `flowlet.sqlite` / `logs` 分离便于管理；安装版落在 `%LOCALAPPDATA%\<identifier>`。便携版首次启动时会把旧位置的 `main-webview` / `scrape-webview-*` 登录态迁移到 exe 旁（幂等，目标已存在即跳过；迁移失败仅告警不阻塞启动）。后台同步遇到登录失效或验证码时不会弹出窗口，只记录渠道、账号标识和缺失槽位，并把该账号标记为等待人工交互；后续周期直接跳过，避免打断用户登录。只要存在符合自动同步条件的账号，每轮调度都必须创建任务日志；等待人工交互的账号要逐个写入跳过原因，即使本轮全部账号都被跳过也要完成任务并汇总 `skippedAccounts`，不得在创建任务前静默返回。用户从账号编辑页点击“立即刷新”并完整抓取成功后清除该标记，后续周期按需重建 WebView 并复用该账号持久化的登录态。

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
- `/v1/responses`（及裸根 `/responses`）作为独立的 Responses 协议转发到声明
  `"responses"` 的渠道端点（上游 URL 从 OpenAI Base URL 派生，仅无状态透传，
  非 POST 管理接口返回 405）。
- 普通响应直接透传。
- 流式响应使用上游字节流直接返回，不能缓存完整响应后再返回。
- 流式响应的 Token 用量随 SSE 字节流增量解析并合并，不依赖完整响应体捕获，长响应超过日志 Body 上限时仍必须准确落库。上游流报错或下游取消时保留断开前已经收到的 usage：带终止标记或正数输出 usage 的记录可标记完整，否则只保存上游已返回字段并标记部分，禁止补算输出和总量；下游取消不会为了等待 usage 而继续后台生成。
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
- `request_capture_refs`
- `usage_records`
- `known_devices`
- `device_daily_usage`
- `device_hourly_usage`
- `device_agent_sessions`
- `account_balance_snapshots`
- `projects`
- `project_tasks`
- `app_meta`

项目管理是桌面端本地工作台能力。第一版一个 `projects` 记录只绑定一个本机目录；
项目会话视角不复制会话数据，而是按目录（含子目录）过滤现有 Agent 会话目录，并按
实时 `runtime_status` 分栏。`project_tasks` 是不关联会话的纯本地任务表，状态限定为
`draft`、`submitted`、`in_progress`、`review`、`done`，任务类型分为 `code`（代码修改）
与 `readonly`（只读分析）；审核通道在 `review` 下允许批准（→ `done`）、退回
（→ `submitted` 并必填原因，重新排队执行），只读分析任务还可转为代码修改任务
（→ `submitted` 并必填代码修改要求，以 `code` 类型重新执行）。任务可基于某个已完成
任务创建（`base_task_id` 记录基础任务 id）：执行时复用该基础任务的 Agent 会话
（`--resume`），并在 prompt 中说明「新任务但仍在该会话中推进」，让新任务延续上个任务
的上下文；本任务已有会话时（退回重跑）仍优先复用本任务自己的会话。删除项目只级联
删除这些本地任务，不删除目录、Agent 原始会话或 Flowlet 请求观测记录。项目与任务 CRUD
写入 SQLite 后立即生效，无需重启。

重复任务（2026-08）与上述一次性审核任务分离：`recurring_tasks` 保存稳定定义（项目、名称、
描述、只读/代码类型、Agent Profile、手动/每日计划、IANA 时区、启停与会话策略），
`recurring_task_runs` 为每次手动、测试或定时触发保存独立配置快照、状态、background job、
Agent 会话和错误。每日计划在保存时解析为 UTC `next_run_at`；Rust 常驻调度器在主窗口隐藏到
托盘后仍每 30 秒检查一次，到期时以 `(recurring_task_id, scheduled_for)` 唯一约束创建 Run，
避免 StrictMode、重复 tick 或重启产生双份结果。Flowlet 退出或电脑休眠时不执行；恢复后只按
当前 `next_run_at` 补一条最近错过的运行并推进到下一天，不连续补齐所有历史周期。

重复任务 Run 与普通项目任务共用 `agent_task_runner` 的项目级执行槽和 Claude Code / Codex /
OpenCode / Pi 进程、输出解析及 background job；普通任务保持 `draft → review` 审核状态机，
重复 Run 只更新自身 `queued/running/succeeded/failed/cancelled/interrupted`。默认每个新 Run
建立新 Agent 会话；`continue` 策略显式延续最近一次成功 Run 的会话；应用重启恢复同一条
`interrupted` Run 时始终尝试从原 job 恢复会话。所有任务定义修改只影响未来 Run，历史 Run
保留运行当时的标题、描述、任务类型、Agent 和会话策略快照。相关表和计划保存后热生效，
无需重启；只有退出 Flowlet 才会停止常驻调度。

任务执行器按 `agent_profile` 分派 Claude Code、OpenCode 或 Pi。Pi 在 Windows npm 安装下
通常通过 cmd / PowerShell shim 启动；为避免多行任务正文被命令行转义截断，Flowlet 使用 stdin
传递完整 prompt，CLI 参数只承载权限、会话名与会话目录。Pi 正常返回后还必须在 Flowlet
专属会话目录中找到指定 session id，并确认 JSONL 的 user message 含完整 prompt；校验失败
按执行失败处理，不得仅凭退出码 0 进入待审核。

任务执行时，Agent 可执行文件由安装探测的当前首选路径解析；项目工作目录来自本机
`projects.directory_path` 绑定。启动任何 Agent 前必须确认该路径仍是现存文件夹。系统重装、
盘符变化或目录迁移导致绑定失效时，应明确提示用户重新绑定项目目录，不得把 Windows
`CreateProcess` 的无效工作目录错误误报为 Agent 可执行文件不可用。

任务的“第 N 次执行”只统计 Agent 子进程及 stdout/stderr 管道均已成功创建的轮次。
项目目录校验失败、CLI 进程创建失败等启动前错误仍写入 `background_jobs` 供排查，但不写入
`project_tasks.execution_history`，也不更新 `last_job_id`。数据库迁移会从存量执行历史中
移除这类误记条目并重算最近执行指针，保留原始 job 与事件日志。

任务详情的会话视图按 `execution_history` 的每次执行时间窗隔离。退回重跑会复用 Claude
Code / OpenCode / Pi 的原生 session id，而原生时间线是累积数据；前端只挂载当前轮次，
并把该轮 `submittedAt`（旧数据回退 `startedAt`）与 `finishedAt`（旧数据缺失时使用下一轮
`startedAt`）传给时间线 command，Rust 按 user-message 交互边界裁剪后再返回。这样每个轮次 Tab 只包含本轮内容，
未访问轮次不读取 job / 时间线，也不会提前构造长会话 DOM。

多设备同步（2026-08）把项目与任务升级为「工作区实体」：`projects.directory_path`
改为可空（远端项目落到新设备后需先「绑定本机目录」才能执行），并新增服务端托管的
`workspace_project_id` / `workspace_archived`；`project_tasks` 新增 `claimed_by` /
`claimed_at`（跨设备执行归属）与 `deleted`（软删除墓碑）。同步通过 S3 工作区加密对象
`<prefix>/flowlet/v1/workspace/projects/<workspace_project_id>.enc`（ChaCha20-Poly1305，
复用账号工作区密钥，AAD 独立），每个项目一个对象，revision + ETag + If-Match 条件写入，
由 `project_workspace_sync` 模块管理。合并规则为 last-writer-wins + 状态机守卫 +
软删除墓碑：新增任务（UUID）双向合并都保留；同一任务编辑按 `updated_at` 新者胜（只有
草稿可编辑，冲突窗口极小）；状态迁移保持既有状态机；删除任务以墓碑传播、删除优先；
删除项目写入 `deleted` 墓碑，其他设备同步后删除各自副本。目录绑定、领取归属与最近
执行 job 是设备本地字段，不进入工作区对象。任务保存 / 提交 / 审核 / 转换后即时推送
该项目到工作区；启动后与设备同步共用同一 15 分钟周期拉取合并。调度器只领取
「本机已绑定目录且未被其他设备执行 / 领取」的 `submitted` 任务。任务一旦被某台设备
执行过（`execution_history` 非空）或正在执行（`claimed_by` 指向其他设备），就永久归属
该设备，其他设备只能查看；基于其他设备任务的子任务（`base_task_id` 指向的父任务归属
其他设备）同样只读。由于 `claimed_by` 是设备本地字段不跨设备同步，其他设备通过
`execution_history` 非空（工作区对象同步）识别「该任务已被执行过」，从而禁止本机领取。
`last_job_id` 是本机执行时写入的设备本地字段（工作区同步不携带、合并时保留本地值），
作为「本机执行过」的强证据：即使任务因设备身份变化 / 数据库迁移导致 `claimed_by`
与当前设备不一致，只要 `last_job_id` 非空就不判为其他设备任务，避免本机创建并执行的
任务被误展示成只读。防止多台设备对同一任务重复执行。

队列排序与置顶（2026-08）：待执行队列按「置顶 → 优先级 → 提交时间」排序——被用户
「提高优先级」（`boost_project_task` 写入 `queue_boosted_at`）的任务排最前，置顶任务之间
按置顶时间倒序（再次置顶可把任务提到队列第一名）；未置顶任务按优先级 p0 > p1 > p2，
同优先级按提交时间（`updated_at`，最近一次提交 / 退回时刻）先到先执行，不再按创建时间。
`queue_boosted_at` 是设备本地字段、不进入工作区对象，合并时保留本地值；任务被领取执行
（`claim_task`）或中断恢复重新排队时自动清空，置顶只对「当前这一轮排队」有效。

执行槽按项目隔离（2026-08）：任务执行槽以「项目」为粒度——每个项目同一时刻至多
一个任务在跑（并行度 1），不同项目互不阻塞、可并行执行。前端调度器跳过「已有任务在
执行的项目」的任务，从其余项目按全局优先级取队首领取；Rust 端 `AGENT_TASK_RUNNING`
以 project_id 为 key 记录运行中任务，领取与释放原子、并发安全。为配合按项目并行，
`save_project` 约束同一本机目录只能绑定一个项目，避免两个项目并行执行同一目录时
Agent 会话、工作区文件被并发读写冲突。

应用重启恢复（2026-08）：Flowlet 在任务执行中（`in_progress`）退出 / 重启时，按项目
隔离的执行槽是内存态（`AGENT_TASK_RUNNING`）会随之丢失，任务会永久卡在 `in_progress`
（调度器只领取 `submitted`）。桌面端启动时调用 `recover_interrupted_project_tasks`
把「本机领取或未领取」的执行中任务恢复为 `submitted`（待处理）重新排队，调度器
下个周期自动领取执行，按任务的 `agent_profile` 复用上次会话继续推进（Claude Code
`--resume`、OpenCode `--session`、Pi `--session-id`）；恢复时在 `execution_history`
最近一条未结束记录上打 `interrupted: true` 标记（含中断时刻 `finishedAt`），前端
待处理列标注「上次执行中断」、执行历史展示「已中断」，与 background_jobs 的
`interrupted`（应用已重启）先例保持一致。其他设备领取的任务永久归属对方，即使对方
离线也不由本机恢复，避免两台设备对同一任务重复执行。

移动端任务提交：设备快照（schema v12）携带轻量 `projects` 目录（工作区项目 id、
名称、是否已绑定目录、任务标题/状态/优先级（前端已移除优先级能力，后端保留字段
写死 P2）/执行轮次计数（供移动端展示「第 N 轮执行」），不含描述与执行历史），
接收端导入只读 `device_projects` 表。移动端据此发现「哪台设备能执行哪个项目」，通过签名 LAN 通道
`POST /flowlet/v1/task/submit`（新增 `task.submit` 能力）把任务默认以 `draft`（草稿待提交）
状态创建到目标设备，与 PC 看板交互一致；移动端再通过 `POST /flowlet/v1/task/status`
（新增 `task.status` 能力）提交（`draft → submitted`）或撤回（`submitted → draft`），
状态机与桌面端审核通道一致，目标设备离线、版本过旧或未绑定目录时返回明确错误。
移动端也可通过 `POST /flowlet/v1/task/edit`（新增 `task.edit` 能力）编辑草稿任务内容，
语义与桌面端 `save_project_task` 一致：只有草稿状态任务可编辑，`title` 必填，
描述 / 任务类型 / Agent Profile 缺省时保留目标设备数据库原值（快照不携带正文，
避免移动端误清空），当前移动端只修改标题。
移动端还可通过 `POST /flowlet/v1/task/delete`（新增 `task.delete` 能力）删除草稿任务，
语义与桌面端 `delete_project_task` 一致（软删除墓碑传播），但只允许删除草稿状态任务：
一旦提交就由桌面端调度，删除权回到执行设备，避免误删进行中 / 待审核 / 已完成的任务。
离线排队（S3 收件箱）为后续可选增强。移动端 S3 权限保持只读，不接触工作区加密对象。

安装实例身份独立保存在 SQLite 同目录的 `flowlet-device.json`。首次启动生成 UUID，
后续启动稳定复用；配置导入、数据库替换和普通数据包不得覆盖或携带该文件，避免把
来源设备恢复成当前设备身份。设备身份格式无效时启动明确失败，不静默生成新 ID。
身份文件同时保存用户可编辑的 `displayName` 和平台类型；默认名称只由平台和设备 ID
短前缀组成，不采集主机名、用户名、MAC、序列号或硬件 ID。重命名只更新展示名称，
不会改变 `deviceId`，保存后立即热生效。

多设备共享使用最小设备快照：`device_usage_snapshot` 返回设备 ID、身份
创建时间、展示名称、平台、Flowlet 版本、快照生成时间、当前本地时区偏移，以及按设备
本地自然日聚合的请求数和 Token 分项。快照版本 2 额外携带最近 180 天按设备本地自然小时
聚合的请求数与总 Token，供移动端周视图按 3 小时时段展示真实的 7×8 热力图；版本 1 快照继续兼容
导入，只是没有小时视图数据。快照版本 3 增加桌面端已知 Agent 的安装摘要和 Flowlet 接入状态：
只同步 Agent ID/名称、CLI 或桌面端安装面、安装方式、版本、全局配置识别结果，以及最近同步的
会话中是否存在经过 Flowlet 的观测记录；不携带可执行文件路径、配置文件路径或任何凭据。
会话摘要继续采用限量根会话策略：`running` 与 `waiting_user` 状态全部保留；两者合计不足
10 条时，按最近活跃时间用 `idle` / `unknown` 会话补足到 10 条；运行态超过 10 条时不截断。
快照版本 4 为这些入选会话增加最后一次交互：除设备/会话寻址、标题、客户端、状态、最近活跃
时间及请求与 Token 汇总外，还携带最后一次真实用户输入以及
该输入之后按原生顺序产生的全部助手回复、思考、工具调用、工具结果和错误事件。产生新的
用户输入后，新快照会以新的最后交互整体覆盖该设备上一版会话数据；单条事件内容和事件数
不做截断。快照仍不携带项目路径、渠道账号、凭据、Header 或代理请求 Body，但最后交互本身
属于敏感会话正文，远端存储必须按敏感数据管理。单个远端对象设有 64 MiB 完整快照硬限制，
超限时拒绝整个对象，不静默裁剪会话内容。版本 1 至 3 快照继续兼容导入，缺失的最后交互按空处理。
快照版本 7 在会话摘要中增加可选的 Agent 原生累计 Token、原生轮次与截断标记。移动端对未经过
Flowlet 的会话使用这些原生指标；原生轮次不冒充 HTTP 请求数，原生数据无法提供的失败数也不显示为 0。
快照版本 8 在每日汇总中增加经过 Flowlet 代理且已成功计价请求的 `estimatedCost`；旧快照缺失该字段时
按 0 兼容，不根据 Token 反向猜测价格。快照版本 9 在小时汇总中增加 `unknownCount`，使周视图选中
3 小时时段的数据可信度可以按该时段精确计算。快照版本 10 进一步为小时汇总增加输入、输出、缓存
计量、预估费用及 Agent 原生输入/输出，使选中 3 小时时段的详情与大周期四项摘要保持同一口径。
版本 1 至 9 快照继续兼容导入，缺失新增字段时按 0 处理；缺失原生摘要时明确显示为不可用。
日行和小时行都由现有 `request_logs` / `usage_records` 实时聚合，不新增当前设备事实表；
导入的小时汇总写入只读共享表 `device_hourly_usage`。历史用量修复后重新生成快照即可按
`(device_id, date)` 更新日汇总，并用较新的版本 2 快照整体替换该设备的小时窗口，无需重启代理。

设置页可把当前设备快照导出为版本化 `flowlet-device-usage` JSON 文件，并在另一设备先
预览再导入。导入数据写入独立的 `known_devices` / `device_daily_usage` /
`device_hourly_usage` /
`device_agent_sessions` / `device_agent_profiles` 只读共享区，
不会进入当前设备的 `request_logs` / `usage_records`，也不会改变当前设备 ID。同一设备
同一日期按快照生成时间幂等更新，旧快照不得覆盖新快照；会话和 Agent 摘要按较新的整份设备
快照整体替换，因此同一会话的新交互会覆盖旧交互。用量页支持全部设备、当前设备和
指定导入设备筛选；共享视图展示请求数、Token 和每日预估费用。预估费用仅汇总快照实际携带的
Flowlet 代理费用；模型与渠道明细缺失时明确显示为不可用，禁止拿当前设备费用冒充全设备费用，
也不为 Agent 原生用量伪造费用。
设备展示名称、平台和应用版本同样按来源快照时间执行新者优先更新；旧版身份文件和缺少
这些字段的旧导出包会生成安全的回退名称，并继续兼容导入。
设置页“设备与用量”会为全部设备显示最后数据更新时间：共享设备使用最近快照生成时间，
当前设备使用本次读取本地实时汇总的时间。

远程同步第一阶段使用通用 S3-compatible 适配器，连接信息存入 SQLite `app_meta`，
`Secret Access Key` 单独存入 Windows Credential Manager、macOS Keychain 或 Linux
Secret Service，不写入 `config.json`、导出包、任务日志或错误消息。配置保存、连接测试
和手动同步均为热更新，不影响代理运行。

桌面端可在同一 S3 空间中显式启用“渠道账号工作区”。工作区对象固定为
`<prefix>/flowlet/v1/workspace/channel-accounts.enc`，使用独立随机 32-byte 密钥执行
ChaCha20-Poly1305 端到端加密；密钥保存在桌面系统凭据库，并且只通过用户主动复制的
“桌面端账号工作区接入包”迁移到另一台桌面设备。普通 S3 移动端连接包和设备快照均不携带
该密钥，因此移动端无法解密渠道 API Key。

账号工作区只统一以下全局字段：稳定 `workspace_account_id`、渠道、账号名称、API Key、
工作区默认 OpenAI / Anthropic Base URL 与归档标记。SQLite 使用
`channel_account_workspace_links` 保存“历史本地账号 ID → 工作区账号 ID”映射，避免重写
请求日志；`channel_account_workspace_defaults` 保存工作区默认地址。本机的账号启停、优先级、
路由、`synced_models` / `exposed_models`、资源状态和 Base URL override 不上传。代理与模型
同步解析地址时遵循“本机 override → 工作区默认 → 渠道内置地址”。因此同一个 Friday
自定义账号可以在工作区保存公网默认地址，公司设备再使用内网本机 override。

启用前必须由用户确认，现有账号随后首次加密上传。全局字段保存采用远端优先和 ETag 冲突
检查：S3 不可用或远端已被其它设备修改时拒绝全局修改，提示先同步；纯本机字段仍可离线热
更新，代理继续使用 SQLite 缓存。远端新账号落到其它设备时默认禁用且不自动生成路由，由该
设备自行选择模型和路由。账号工作区随启动后 5 秒及每 15 分钟的桌面 S3 周期同步刷新；
设置页也提供独立的立即同步、初始化、桌面接入包导入与导出入口。

远端对象布局为
`<prefix>/flowlet/v1/devices/<deviceId>/snapshot.json`。每台设备只写自己的对象，
同步时分页列举同一前缀、逐个下载并复用本地数据包校验与幂等导入；单个损坏对象只计入
失败数，不阻断其它设备。远端刷新状态同时保存每个失败对象的设备标识与具体下载、解析、
校验或导入原因，移动设置页直接展示失败明细；旧状态缺少该字段时按空列表兼容。覆盖已有
当前设备对象时先比较本地保存和远端当前 ETag；通用 S3
继续使用 `If-Match` 条件写入，若对象被另一个写入者修改则停止覆盖并提示可能存在重复设备
ID。阿里云 OSS 的 PutObject 不支持 `If-Match`，因此在 ETag 比较通过后执行普通覆盖写入；
该兼容路径保留同步前冲突检测，但不提供请求级原子条件写入。连接测试会在配置前缀下写入、
读取并删除一个临时小对象，以同时验证列举、读、写和删除权限。

重装系统或从备份还原便携目录后，如果本地保存的 ETag 落后于远端，用户可在冲突提示中
明确选择“恢复本机同步”。恢复操作会先下载远端当前设备快照，并严格核对快照中的
`deviceId` 与 `deviceCreatedAt` 是否同时匹配本地 `flowlet-device.json`；只有匹配时才采纳
远端 ETag 并重新同步。该动作不自动执行，用户必须先确认旧系统或同一便携目录的其它副本
已经停止，避免绕过重复设备 ID 保护。

配置存在时，应用启动 5 秒后执行第一次 S3 设备用量后台同步，以尽快发布当前启动实例的
局域网端点；之后每 15 分钟执行一次；
主窗口隐藏到托盘后任务继续运行，只有退出 Flowlet 才停止。定时同步与手动同步复用同一
执行入口、状态记录和进程内互斥 guard；发生重叠时定时任务静默跳过，不覆盖正在运行的
同步状态。未配置 S3 时定时检查静默跳过，不写入失败状态。每次真正开始的手动或定时同步
都以 `job_type = device-s3-sync` 写入 `background_jobs` / `background_job_events`，记录
触发来源、完成摘要和失败原因；因互斥而跳过的定时检查不创建任务。

设备快照版本 5 增加可选 `lanPeer` 发现信息：桌面端启动独立的随机端口 HTTP 服务，将当前
主路由解析出的私有 IPv4 地址、协议版本、能力列表、20 分钟有效期和本次启动随机生成的
32-byte capability key 写入自己的 S3 快照。capability key 不包含或派生自 S3 凭据，只通过
已经按敏感数据管理的 S3 快照分发；局域网请求使用 HMAC-SHA256、30 秒时间窗和单次 nonce
认证，响应正文使用 ChaCha20-Poly1305 加密并绑定请求 nonce。客户端只连接字面量私有 IP，
拒绝域名、环回、链路本地、公网地址和无显式端口的端点，避免把远端快照变成任意网络探针。

S3 仍是发现和离线回退通道。移动端后台每 5 分钟执行一次 S3 全量拉取，用于持续发现设备和
更新离线设备；页面手动刷新不复用该全量入口。会话页已经明确选中单台设备，点击刷新或下拉
刷新时先直接请求该设备的 LAN 完整快照，成功后立即结束；只有直连不可用时才按
`<deviceId>/snapshot.json` 精确读取这一台设备的 S3 对象，不列举或下载其它设备。等待确认会话
进入页面时仍可执行一次 best-effort LAN 刷新，使 OpenCode pending permission 不必等待后台 S3 周期。
OpenCode 权限读取和“同意本次 / 否决”通过同一认证通道发回 Agent 所在 PC；PC 端再次查询
并调用本机权限桥接，已处理、过期或离线请求返回明确错误，永久放行仍不对外暴露。当前高频
刷新和操作提示在移动会话页前台生效，不承诺应用退到后台后的系统级推送。

移动会话详情默认以半屏底部弹层打开；用户在内容、头部或横线把手区域上滑时自然展开到完整
高度，点击横线把手也可展开/收起，不占用单独的展开按钮。弹层打开期间页面级下拉刷新停用。
展开状态下，仅当本次手势开始时内容已经位于滚动顶部，向下滑过防误触阈值才收回半屏；从
内容中部开始的滚动、短距离抖动、横向滑动和按钮区域手势均不得触发收缩。
详情内刷新位于“最近一轮”标题行，严格使用带签名的 `POST /flowlet/v1/session/read` 单会话接口，只读取指定
`(agent_type, session_id)` 的最新状态、指标与最后交互，并在移动端按主键覆盖该会话；不读取
整台设备快照，也不回退 S3。对端通过 `session.read` capability 声明支持，直连不可用或版本
过旧时保留现有缓存并展示明确错误。

为便于排查“是否已正常开放”和“设备间能否直连”，桌面端在设置页「同步」Tab 展示「局域网直连」
卡片：服务运行状态（监听地址、启动时间、启动失败原因）、对已知设备的轻量探测结果（可达延迟 / 不可达原因
/ 未发布直连信息），以及最近入站请求记录。服务端通过 axum 的 `ConnectInfo` 读取 TCP 对端 IP
记录到内存 ring buffer（容量约 50），旧版客户端没有 ping 端点也会显示为未知来源 IP，不依赖
客户端上报身份。移动端设备列表为每台设备显示连接徽标：直连可达延迟、不可直连、仅云端同步。
探测使用新增 `GET /flowlet/v1/ping` 端点，返回 device_id、协议版本、能力和服务端时间；旧版
Flowlet 返回 404，前端将其归类为“对端版本过旧”，并继续使用 S3 快照作为回退。

移动查看器与桌面端保持在同一仓库和同一个 Rust crate 中，但使用独立的 React Router、
Shell 与精简的 Tauri 启动入口。`#[cfg(desktop)]` 注册代理、托盘、Agent 与完整数据命令，
`#[cfg(mobile)]` 注册 S3 配置、只读连接测试、共享设备目录、日/小时汇总、会话摘要、
设备 Agent 安装与接入摘要、远端刷新，以及经过认证的 LAN 快照读取和 OpenCode 单次权限回复命令。
移动端复用 `DeviceUsageBundle`、S3 适配器、SQLite 导入与聚合逻辑，不启动本地代理，也不
扫描本机 Agent 数据。移动设备页按设备懒加载同步的 Agent 摘要，展示安装面与版本，并区分
已接入 Flowlet、部分接入、其它网关、配置异常、近期仅被观测到和暂未接入等状态。
移动壳层统一持有当前设备筛选，概览页与项目页在标题右侧使用同一个轻量设备菜单，跨 Tab
切换时保持选择；底部导航固定为“概览、项目、设备、设置”，Tab 切换使用 replace 导航，不把
每次切换压入系统返回历史。概览、项目、设备和设置四个主页面统一使用整页下拉刷新，不在标题右侧
重复放置刷新按钮；概览选择具体设备与项目页使用指定设备刷新，概览“全部”和设备页使用全局刷新。
设备页展开单个设备不再直接展示已安装 Agent，而是展示「会话」与「Agent」两个聚合入口卡片，
各自汇总该设备的会话与 Agent 核心信息（会话数、运行/等待数、Token；已安装 Agent 数、已接入
Flowlet 数）。点击任一卡片进入该设备的会话或 Agent 二级页：二级页是独立路由
（`devices/:deviceId/sessions`、`devices/:deviceId/agents`），不挂在主壳下因此没有底部 Tab，
顶部提供返回按钮回到设备页；会话列表与已安装 Agent 列表分别抽取为 `MobileSessionList` /
`MobileAgentList` 共享组件，供二级页复用。二级页由 `MobileSubpageShell` 统一承载：单一页头
（返回按钮 + 主标题 + 描述 + 刷新时间），与其他主页面一致，不再出现双层标题；主标题带上设备名
（如「changen-home 会话」「changen-home Agent」，设备名未就绪时回退为「会话」「Agent」）。
整页下拉刷新包住整个页面，指示器与概览页一致地出现在内容上方的安全区空隙里，不顶到系统状态栏。
页面根 grid（`.page`）使用 `align-content: start`，内容不足一屏时行按自然高度贴顶、不会被拉伸
出现空隙。项目页同样支持按所选设备整页下拉刷新。
移动会话页读取桌面设备按上述规则筛选后的会话摘要，支持按共享设备
和运行状态筛选；最后交互随摘要存储并
可通过类型化命令读取，但当前列表不直接展开正文，也不把远端摘要合并进手机本机的 Agent 会话
事实表。桌面同步继续
执行“拉取其它设备 + 上传当前设备”；移动后台刷新拉取
`<prefix>/flowlet/v1/devices/*/snapshot.json` 并导入只读共享区，页面刷新则使用上述设备级
LAN/S3 策略。手机始终不生成或上传空设备快照。移动前端通过 `VITE_FLOWLET_TARGET=mobile` 或 Tauri 的 Android/iOS 构建平台变量选择
移动路由；Android 和 iOS 分别使用平台覆盖配置，但共享同一套移动页面与领域边界。

Android 工程需在已安装 Android SDK/NDK 的开发机上先执行
`npm run tauri:android:init`。之后使用 `npm run tauri:android:build` 生成 arm64 APK，
或使用 `npm run tauri:android:build:aab` 生成 arm64 AAB。配置本机
`src-tauri/gen/android/keystore.properties` 后，`npm run tauri:android:install`
会构建并通过 ADB 覆盖安装正式签名的 arm64 release APK；该命令不会卸载签名不一致的旧包。
普通的
`npm run tauri:build` 始终构建当前桌面宿主平台，不会同时生成 Android 包。

请求日志采用 SQLite 索引 + `request-captures/` 明细文件的混合存储。`request_logs`
保留列表筛选、会话聚合、路由、性能和 Header 等查询字段，新请求的请求/响应 Body
不再写入 SQLite；`request_capture_refs` 保存日志行到 `.flcap` 压缩帧的相对路径、
offset、长度、校验和和捕获状态。详情与用量重解析按引用随机读取单帧，旧数据库中
尚未迁移的 `req_body_b64` / `res_body_b64` 继续作为兼容回退。有稳定 Agent Session ID
时，捕获文件按 `(agent_type, session_id)` 的哈希目录组织；无 Session ID 时按日期分片，
单个物理 segment 达到约 32 MiB 后轮转，避免长期会话形成无限增长文件。

OpenCode 会话观测当前不建立独立 `sessions` 表。代理在请求进入时从 OpenCode 的
`x-opencode-session`、`x-session-id`、`x-session-affinity` 和
`x-parent-session-id` Header 中提取稳定标识，写入 `request_logs` 的
`agent_type`、`agent_session_id`、`parent_agent_session_id` 字段。会话列表只聚合
`is_last_attempt = 1` 的最终请求，并通过 `request_id` 关联 `usage_records`。会话列表返回
客户端 ID 与名称；筛选维度拆分为 Agent 类型（ChatGPT（Codex）、Codex CLI、Claude Code、OpenCode、Pi）和
运行状态（全部、自动运行中、等待用户确认、空闲、无法判断），原生会话不再因为缺少 `client_id` 被
客户端筛选排除；按运行状态筛选时，OpenCode 的 pending permission 先在本机控制服务合并进运行态，
再参与过滤与分页。模型不是会话固定属性，不作为会话列表字段展示。会话列表
只分页展示没有父会话的主会话，固定每页最多 8 条，以适配桌面窗口内容高度；直接子会话通过
独立只读 command 在主会话详情中按最近活动排序展示，不与主会话平铺。因此日志
保留和清理策略同样决定会话观测数据的保留范围。
主会话运行状态按整棵子会话树聚合：任一后代仍在运行时主会话保持运行中，任一后代等待用户确认时
主会话展示等待确认（优先级高于运行中）；空闲或未知子会话不覆盖主会话自身状态。

查询会话列表时，Rust 会只读、尽力而为地建立本地原生会话目录：OpenCode 从用户本地
`opencode.db` 的 `session` 表读取全部会话的标题、项目目录、父会话和时间；Claude Code 从
`~/.claude/projects` 下识别根会话 JSONL 与 `subagents` 子会话；ChatGPT（Codex）Desktop 与
Codex CLI 共享 `$CODEX_HOME/sessions`，Flowlet 根据 `originator` 分别标记为 `codex-desktop`
和 `codex-cli`，并通过 `session_index.jsonl` 补充任务标题；Pi 从 `~/.pi/agent/sessions`
递归扫描 `<timestamp>_<uuid>.jsonl`，解析头行（`id`/`cwd`/`timestamp`/`parentSession`）取得
会话 UUID、项目目录、时间与派生来源，并以 `session_info` 名或首条用户消息为标题。列表查询只
读取标题、工作目录、父子关系和时间字段。Pi 会话文件为树状结构（entry 通过 `id`/`parentId`
连接，支持原地分支），内部原生解析从叶子沿 `parentId` 回溯到根，重建当前活动分支。
Flowlet 调度 Pi 时同样使用该原生目录，不另设任务会话目录。曾使用
`~/.flowlet/pi-task-sessions/<project_id>` 的旧版本会在桌面端启动时读取会话头中的 `cwd`，
按 Pi 原生路径编码规则把 JSONL 迁入对应项目目录；目标文件已存在时不覆盖，单个文件失败不阻断启动。
原生目录与 Flowlet 请求观测按 `(agent_type, session_id)` 去重合并，因此未经过 Flowlet 的本地
会话也会显示；这类会话没有 Flowlet 请求、费用和失败指标，列表优先读取同步快照中的原生
turn 数、累计 Token、模型集合与同步时间；首次快照尚未生成时才为当前可见行按需读取原生摘要，
并继续以“未经过 Flowlet”标明数据语义。
Claude Code 文件按路径、大小和修改时间缓存，未变化文件不会在每次列表刷新时重复解析。

原生读取失败不影响 Flowlet 聚合结果，也不写入 Agent 文件。Flowlet 通过前端调度的只读同步任务，
把原生会话摘要、列表元数据及来源指纹写入 `agent_session_snapshots`；该快照用于增量判断、后续整理以及源文件
删除后的历史展示，不保存消息正文。会话详情使用 SideSheet 展示原生元数据与 Flowlet 请求指标，不再把列表点击行为
跳转到请求日志；仅 Flowlet 已观测会话的会话 ID 提供显式日志跳转入口，跳转后由请求日志页按该
会话 ID 自动筛选。Codex 的 `archived_sessions` 当前不进入活跃会话列表，CLI 与 Desktop 作为
两个独立筛选项展示。

会话详情不提供完整历史时间线，使用“概览”和“最近一轮”两个 Tab；概览保留原生元数据、
Flowlet 请求指标、Agent 原生累计用量和子会话；OpenCode 待确认权限归入“最近一轮” Tab，
内联在事件流末尾的 Agent 阻塞点展示，此时不再重复显示“正在处理”指示；
该 Tab 在首次切换时按需读取。桌面通过 `get_agent_session_last_interaction`
只返回最后一个真实用户输入及其后的全部回复、思考与工具事件；
`get_agent_session_native_summary` 只返回累计摘要。Rust 内部以只读方式解析 OpenCode
`message` / `part`、Claude Code JSONL、Codex rollout JSONL 和 Pi 活动分支：一部分用于计算
摘要与成本，另一部分仅在生成设备快照时提取最后一个用户回合；解析结果不写入当前设备的
Agent 会话事实表，也不读取 Codex developer 指令。
前端以右侧浅灰用户气泡和左侧 Agent 正文自然区分对话角色，不渲染输入/输出分区标题或重复身份；
输出流把相邻的思考、工具调用和工具结果合并为默认折叠的轻量过程行，工具参数与结果按常见字段
结构化展示，未知格式回退为原始文本。最后一轮提取同时保留所属 Agent 轮次状态：尚未写入最终回复时
显示“正在处理”，已结束但没有可展示回复时给出明确状态，不把未完成误呈现为内容读取丢失。
OpenCode 的可操作状态不从 SQLite 推测：`opencode_control` 通过本机 `GET /permission` 读取进程内
待确认权限并按 `sessionID` 过滤，前端在 OpenCode 会话详情的“最近一轮” Tab 激活期间每 2 秒轮询；“同意本次”和“否决”
分别调用 `POST /permission/{requestID}/reply` 的 `once` 与 `reject`。控制服务离线时返回结构化不可用状态，
不影响会话概览；回复失败保留待确认卡片并向用户显示错误。
原生摘要返回 Agent 累计用量和模型集合。OpenCode 使用 `session` 的累计
Token / cost 与消息级 tokens；Claude Code 对去重后的助手回复 usage 聚合输入、输出、缓存创建和
缓存读取；Codex 使用最新 `total_token_usage` 作为会话总量，并在
`task_started` 到 `task_complete` 之间累加每次 `last_token_usage`，形成可核对的轮次用量，同时记录
轮次总耗时和首 Token 延迟。原生用量与
Flowlet 请求观测始终分栏展示且不相加；OpenCode 原生提供的 cost 直接展示。Codex 在能够确定唯一模型且
价格存在精确匹配时生成两个独立维度：优先展示 `openai-api` 标准基础 API 公开价计算的 API 等价价值，并保留
USD 等原始计价币种；同时展示 `codex-native` 官方 credits 费率计算的套餐消耗。两者不做汇率换算，也不相加；
无法从原生记录确认的长上下文、Priority processing 或 Fast mode 乘数不纳入基础估算。Claude Code 不在
缺少可靠价格映射时伪造费用。产品界面只按需读取最后一次交互，不提供更早历史回溯；列表与详情的
累计指标使用 `get_agent_session_native_summary`，只返回 turn 数、累计用量和模型集合。同步快照存在时
列表不再重复解析原始文件；缺少快照时按可见行懒加载并缓存 5 分钟。原生摘要达到读取上限时，列表用
`≥` 明确表示计数或 Token 为下限。
会话列表中经过 Flowlet 的 Token 汇总复用请求日志的明细提示，按会话聚合输入、缓存输入、未缓存输入、
输出和总 Token；缓存命中率仅以明确返回缓存字段的输入 Token 为分母，缺少 Token 明细的请求单独计数，
不把未知用量当作零值参与命中率。

用量成本页和移动端概览把“经过 Flowlet”与“Agent 原生”Token 合并到同一日/小时统计，明细中拆分
来源。经过代理的 HTTP 请求写入 `usage_records`；未经过 Flowlet 的 Claude Code、Codex、OpenCode
和 Pi 用量按消息或轮次写入 `agent_usage_events`。原生逐事件账本使用
`(agent_type, session_id, event_id)` 幂等去重并按事件时间归集，只纳入未被 Flowlet 观测的根会话，
避免父子会话和代理请求重复相加。缓存命中率仍保持 Flowlet 可测量口径，不把缺少对应分母的原生缓存
输入混入。Agent 自动或手动同步完成后会失效设备用量查询；设备快照携带 `native_*` 聚合字段，使其他
设备和移动端看到相同的来源拆分。费用、API 等价价值和套餐 credits 不换汇、不相加；缺少可靠价格
映射时保留未计价状态。

PC 运行概览顶部“今日消耗”与用量统计页的“日 / 全部设备”使用相同口径：本机代理 Token、本机未经过
Flowlet 的 Agent 原生 Token，以及 `device_daily_usage` 中其他设备当天快照共同计入。概览仍通过
`usage_today_tokens` 返回单条当天聚合，不轮询整段历史；指标点击后进入用量统计页，不再展示悬浮拆解。

PC 用量分析页的 `usage_summary` 进一步把能够确认具体模型的纯原生事件映射为同一只读分析行：
事件自身的 `model` 优先；Codex 等 token 事件不携带模型时，仅在同一会话的
`agent_session_snapshots.summary_json.models` 能确认唯一规范模型时回填，多模型或未知模型会话不猜。
`flowlet-pro` / `flowlet-flash` 是客户端公开聚合别名，不是真实上游模型，因此不会作为 Codex 原生
模型分析行计入；这类会话的真实模型与用量以 Flowlet 请求账本中的 `upstream_model` 为准。该规则也
避免共享 Codex 会话被多台设备同时扫描、但只有实际请求设备持有代理日志时产生跨设备重复统计。
时间范围比较先通过 SQLite `datetime()` 统一 RFC3339 表示，避免周期起点当天的边界误收。
`channel_id = agent-native` 仅表示来源，`account_id` 保存 Agent 类型，
`client_id` 保存统一客户端归属，`request_count = 0`，并用 `native_event_count` 单独表达消息级事件数。
该映射不新增数据库列；`estimated_cost_currency` 只存在于 command 返回结构中，用于让前端优先按
后端实际命中的价格币种聚合。公开价匹配顺序为模型官方渠道、`openai-api` 保留命名空间、唯一非套餐
价格；`codex-native` credits 不进入预估费用。模型无法精确计价时金额为 0、币种为空，Token 仍参与
模型、客户端和设备维度分析。

设备同步快照的 `usage_breakdowns` 同时携带最近 90 天的代理请求维度行与上述 Agent 原生模型维度行。
原生行从本机 `agent_usage_events` 和会话快照动态生成，保留 `native_event_count`、公开价币种与预估费用；
接收端按设备全量替换 `device_usage_breakdowns` 快照，并在导入边界把旧版 Codex Desktop 的 `codex`
客户端键规范化为 `codex-desktop`，因此归并键或模型规则升级后不会残留旧维度行。版本升级后既有原生
账本会在下一次正常设备同步自动补发，无需通过数据完整性检查改写历史记录；源设备与接收设备均需运行
支持该同步字段的版本。

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
同步发现仍可访问数据源中的会话已经消失或归档时，不删除 Flowlet 已保存的摘要快照和
`agent_usage_events` 历史账本，只把快照标记为“源文件已删除”；会话列表和用量统计继续使用最后一次同步值。
源文件重新出现时会强制重新解析并恢复为可用状态。只有用户未来通过明确的删除入口主动要求遗忘时，才可同时
删除快照和原生用量账本。`agent_source_sync_state` 按客户端保存上次检查、上次成功整理、扫描数、变化数、失败数
和错误。单会话失败不覆盖旧快照或指纹，因此后续检查会重试。
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

Claude Code 会话状态优先读取 `~/.claude/sessions/<pid>.json` 的活动进程记录，并按
`sessionId` 合并到原生会话：`waitingFor = permission prompt / user input` 映射为等待用户确认，
`tool execution` 映射为运行中。这样交互式提问或权限确认尚未写入项目 transcript 时也能实时识别；
进程记录不存在或无法识别时，回退到 `~/.claude/projects/**/*.jsonl` 的尾部事件推断。两个目录都纳入
原生数据源监听，状态变化会触发增量同步；不新增持久化字段，也不需要重启代理。

Claude Code 2.1.86 及以上版本会在 API 请求中发送官方
`x-claude-code-session-id` Header。代理将其写入同一组 `agent_type` / `agent_session_id`
字段，其中 `agent_type = 'claude-code'`；恢复的 Claude Code 会话继续使用原 session ID。
Claude Code 与 OpenCode 共用会话聚合、客户端筛选、日志详情和数据修复链路。

设置页提供显式的本地数据修复流程，支持今天、最近 7 天和全部时间，由前端顺序编排四个细粒度
command：历史 Claude Code / OpenCode 会话归因回填、Token 用量修复、未知用量记录补齐、费用重算。
Token 用量修复先重解析已捕获响应；流式捕获缺少终止标记且只有零输出的起始 usage 时不予采信，
再按同一 Agent 会话、规范模型与请求时间窗匹配唯一的原生消息级 usage，多个候选一律跳过。
Anthropic `/messages/count_tokens` 只计算上下文长度，不执行模型推理；请求日志继续保留，
捕获响应与 Agent 原生会话回填会排除该路径；未知用量阶段不会为它建立占位，并会移除
历史遗留的占位或误回填用量。
会话回填只读取已保存的
`req_headers_json`，无法恢复未捕获请求头的旧请求；新请求仍在代理入口实时提取，不依赖修复任务。
用量重解析会覆盖所选范围内已有的解析结果，而不只处理未知记录。修复直接更新现有
`request_logs` / `usage_records`，不需要重启代理。完整的跨设备维护、备份、核验和回滚流程见
[`usage-data-repair.md`](usage-data-repair.md)。

请求性能由 `request_logs` 保存上游响应头时间（TTFB）、首个实际输出内容时间
（TTFT）和总耗时。流式总耗时从请求发出持续到响应流结束；输出 Token 速率由
`output_tokens / (duration - TTFT)` 派生，不重复持久化。`usage_records` 分别保存
输入、缓存命中输入、未缓存输入、输出和总 Token，并以 `usage_status`（`complete`、
`partial`、`unknown`）和 `usage_source` 记录完整性与来源；历史无法细分来源的数据迁移为
`legacy`。缓存命中率只在缓存 Token
信息可用时按 `cached_input / input` 聚合，未知值不按零命中处理。
每个路由 attempt 同时保存实际调用的完整 `upstream_url`，历史详情不依赖当前
渠道或账号 Base URL 反向推导。`req_headers_json` 继续在 SQLite 冗余保存；请求 Body
与响应 Body 写入该 attempt 对应的 `.flcap` 记录，均从最终执行的上游 Request 和与之
对应的第三方响应捕获，因此其中的鉴权凭据和模型均为路由改写后的实际值。客户端入站报文
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

普通 400 请求参数错误同样保持终态，不跨模型重试。若 400 错误体同时明确返回
`code = invalid_parameter_error` 且消息表示 `product is not activated`，则说明当前上游
账号未开通所选模型产品，而非客户端请求结构无效；代理会把该 attempt 记为
`product_not_activated` 并继续尝试同一 Flowlet 聚合模型的下一个候选。

模型价格不写入 SQLite。运行时价格表在内存中装配，来源按优先级为：本地 `models-cn.json`
（国内厂商官方价，CNY，含 `inputTokenRange` 分级与促销价优选）与 `models-dev.json`
（models.dev 国际官方价，USD；`openai` provider 映射为 `openai-api` 命名空间，并按
1 USD = 25 CREDITS 派生 `codex-native` 套餐额度价），`config.json` 的
`channels_config.model_prices` 仅补充目录未覆盖的 `(channel_id, upstream_model)`。
两份目录文件随安装包内置到 exe 旁，后台任务每小时同步一次；价格表在启动时与每次
目录同步成功后重建。

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

应用窗口使用 Tauri 无系统边框模式，由前端壳提供可拖动区域以及最小化、最大化/还原、关闭按钮。关闭主窗口隐藏到托盘，只有“退出 Flowlet”才停止代理并退出应用。主窗口通过 `tauri-plugin-window-state` 记住上次的尺寸、位置与最大化状态：启动时自动恢复（无历史状态时保持 `tauri.conf.json` 的 1200×720 客户区），关闭隐藏到托盘、托盘“显示/隐藏”或退出时落盘；不记忆可见性，`--hidden` 后台启动不受影响。Windows 无系统边框窗口仍包含系统用于缩放的不可见边框；`window_size` 会按当前 DPI 测量外框与客户区差值并补偿原生最小尺寸约束，保证主窗口和项目详情窗口最小时的前端客户区仍不小于 1200×720。历史状态若保存过约 1184×711 的旧客户区，启动恢复后会自动抬回新下限。

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
