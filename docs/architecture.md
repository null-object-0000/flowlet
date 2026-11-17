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

账号保存后只自动补齐对应的直接模型路由；只有全局第一个渠道账号的新直连路由默认开启，后续新增账号的新直连路由默认关闭。Flowlet 不再提供聚合模型：路由的 `virtual_model_id` 直接保存规范模型 ID，`upstream_model` 保留上游原始 ID，同一规范模型的多账号/多变体形成候选池，用户在模型服务页显式启停和排序。旧版本的 `flowlet-pro` / `flowlet-flash` 聚合路由会在升级迁移时改写为直接模型路由（去重、保留相对顺序），无法归一的旧行保留但不参与路由。

架构设计必须服务于以下边界：

- 支持多协议透明转发，但不做跨协议转换。
- 默认不改写业务响应；仅允许 `AGENTS.md` 第 5 节明确列出的受控兼容例外。
- 请求侧只做 base_url、Authorization/Header 和可选 model 映射。
- 日志旁路记录，失败不能影响主请求链路。
- 模型列表、价格、余额、额度、用量查询只能用于异步同步和配置辅助。
- Token 和成本分析走离线任务，不能阻塞真实请求。
- 成本账本与请求日志解耦；实际支付、按量费用、公开价估算、摊销、分配和等价价值使用不同字段表达。
- 外部 Agent Adapter 默认本地只读、显式授权、最小化采集，并使用独立错误边界。
- 第一阶段采用 LongCat + DeepSeek first，同时完成两个首发渠道的 OpenAI-compatible 与 Anthropic-compatible 两种透明转发入口。

## 总体结构

Node Host 提供独立的通用 Agent 网关：登记原生 A2A 服务或 ACP stdio 程序，复用模型 Client Token，提供
A2A JSON-RPC/SSE 入口及 `flowlet acp` 客户端桥。原生 A2A 透传，ACP 上游由官方
a2a-go/a2aacp 辅助进程执行；ACP 客户端桥基于官方 TypeScript SDK。转换仅限共同能力，
不改变模型协议透传原则。它与模型渠道、内置客户端适配器及模型计费分开，前端复用现有管理命令边界。
运行环境、许可及数据兼容性详见 [ACP 适配](acp-bridge.md)。
新增 SQLite 表通过增量迁移演进；协议范围、权限及存储契约见 [A2A 网关](a2a-gateway.md)。
Agent 调用复用模型 Client Token，与管理凭据分开；旧专用密钥只保留兼容。Go ACP 桥继续保留。

```text
Flowlet
  ├─ src/                              React 19 + Semi Design + TanStack Query
  │  ├─ domains/                       类型化领域命令
  │  └─ platform/
  │     ├─ host/                       Node HTTP 命令与错误边界
  │     ├─ desktop/                    Electron 窗口/对话框/固定事件 bridge
  │     └─ web/                        同源 HTTP 与登录态
  ├─ packages/flowlet-desktop/src/      Electron main / preload / 平台能力
  ├─ packages/flowlet-core/src/
  │  ├─ index.ts                       startHost：SQLite/代理/Web/调度装配
  │  ├─ config/index.ts                默认加载、运行时快照与路由补齐
  │  ├─ catalog/                       模型身份、规格与价格目录来源
  │  ├─ proxy/                         监听、转发、路由、捕获与身份识别
  │  ├─ storage/                       SQLite schema/migration、查询与 .flcap
  │  ├─ web/                           显式 HTTP 命令、权限和管理鉴权
  │  ├─ desktop/                       仅本机 Host 注册的桌面命令
  │  ├─ agent/                         环境、全局配置、账号、原生会话
  │  ├─ device/                        设备身份、LAN 与密钥访问
  │  ├─ services/                      S3 与加密账号工作区
  │  └─ host/                          周期维护与捕获清理 worker
  ├─ packages/flowlet-core/test-fixtures/ 真实上游初始文件
  ├─ packages/flowlet-agent-bridge/     官方 Go A2A/ACP 辅助程序
  ├─ packages/flowlet-cred/             Node CLI 与客户端桥
  ├─ resources/icons/                  桌面图标
  ├─ resources/catalogs/               随包 models-cn / models.dev 快照
  ├─ resources/agent-plugins/          可选受管 Agent 扩展
  ├─ model-catalog.json                模型身份白名单、归属与别名
  └─ plugin-registry.json              受控渠道、目录与 Agent 声明
```

当前仅维护 Electron + Node/TS 和 Web/Docker，不保留 Rust/Tauri 回滚宿主、移动工程、
旧构建或跨语言对拍链路。历史迁移与审计文档置顶标记“已归档”，不得代替当前规范。

### Core 与 Host 边界

`packages/flowlet-core/src/index.ts` 的 `startHost()` 统一装配配置、SQLite、设备身份、
代理、管理 HTTP API 与后台调度。Electron main 同进程调用它；独立 Node/Docker 从同一入口运行。
Node 以这些实际模块完成服务装配，不应照搬旧宿主类名当成当前实现。

前端负责产品判断和流程编排，Node 提供细粒度命令、幂等生命周期、持久化与安全边界。
调用链为 `pages → features → domains → platform/host → POST /api/commands/{command}`。
Web dispatch 位于 `web/commands.ts`，授权为 `web/permissions.ts` 的显式声明；
`desktop/commands.ts` 只在 `ctx.desktop` 存在时注册桌面能力，HTTP 不开放任意宿主操作。

Electron 平台能力由 `packages/flowlet-desktop/src/bridge.ts` 实现 `DesktopHostBridge`，
core 只通过 `ctx.desktop.host.invoke(channel, payload)` 调用，禁止在命令层导入 electron。
窗口、文件对话框与固定事件由 preload 的受控 bridge 提供，不暴露任意 IPC 或 Node API。

桌面 `host` 模式启动本机 Host，`client` 模式只用本机 Client Gateway 反代远程 Web 白名单。
client 模式不提供本机 Agent 配置、抓取、跨设备同步或自启；远程 token/Cookie 留在主进程，
不得交给 renderer。详见 [Electron 宿主](desktop-electron.md)。Web/Docker 功能边界、鉴权、
端口与数据卷见 [Docker 部署](docker.md)。

### 模型目录边界

根 `model-catalog.json` 是模型规范 ID、官方归属与别名的单一事实源，Node 的
`catalog/index.ts` 与前端读取同一声明。`resources/catalogs/` 的规格/价格快照是补充来源，
运行时目录同步不得扩大支持白名单。`config.json.channels_config.default_exposed_models`
不是另一份白名单；新增模型须同时验证真实上游列表、用户选择、协议和规范身份。

### 插件和 Agent 边界

`plugin-registry.json` 只声明受控贡献，不加载第三方动态脚本、动态库或任意命令。
当前 Node 入口为 `agent/registry.ts`、`agent/environment.ts`、`agent/adapters/index.ts`、
`agent/sessions/` 与 `proxy/identity.ts`（相对 `packages/flowlet-core/src/`）。
四类 Environment / Global Config / Session / Identity 能力必须按同一声明组合并保持一致；
新增 Agent 不得复制出互相漂移的 roster，未知适配器必须明确失败。

全局配置遵循官方公开格式、备份受管字段、幂等应用和完整恢复，不改 Agent 程序或安装包。
结构化写入必须用 `packages/flowlet-core/test-fixtures/` 的真实上游文件验证
`inspect → apply → reapply → disable optional capability → restore`，每步重新解析格式。
可选扩展源码位于 `resources/agent-plugins/`；默认不开启，不作为基础 Provider 接入前提。
前端手动片段必须与 Node 一键写入一致。原生会话只读，不能按文件时间猜请求归属。

SQLite 是正式持久化基线；`storage/index.ts` 与 `storage/schema.ts` 负责现有 schema 和迁移，
不得直接重建现有用户库。Node 行为验收依赖测试与端到端冒烟，而不是旧源码或静态命令计数。
`npm run node:commands` 只检查名称、注册和 Web 权限白名单，不证明参数/返回值或行为 100% 覆盖。

## 当前阶段核心模型

正式数据模型使用三层概念：

```text
渠道 Channel
  ↓
账号 Account
  ↓
模型 Model
```

- Channel 是服务商模板，支持范围见 `support-matrix.md`。
- Account 是用户在某个渠道下配置的一组访问身份；每个账号只有一个参与模型请求和路由的 API Key。OpenRouter 可额外保存一个只读账户 Credits 的 Management Key，该辅助凭证不参与代理请求。
- 模型规范身份决定官方归属；实际路由渠道/账号独立，同一模型可以由多个渠道承载。

路由候选使用：

```text
Channel + Account + Protocol + Model
```

账号是路由、统计、余额、失败状态的最小单位。

## 运行时端口

```text
127.0.0.1:18640  多协议透明代理端口
```

管理 API 与模型入口分离：独立 Node Host 默认 8080 管理端口，Electron 使用回环随机管理端口；Docker 映射见 `docker.md`。

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
- 按 `model-catalog.json` 把入站模型名归一到规范模型 ID（别名 / 官方 API 名 / `vendor/`
  前缀 / 大小写变体），未登记的名字不归一。
- Anthropic Files API（无 `model` 字段的 `/v1/files…`）在读取 body 之前分流，按渠道能力
  `supports_files_api` 绑定到单一账号转发；带 `anthropic-beta: files-api-*` 的 `/messages`
  把候选收窄到同一账号。
- 将本地协议入口路径拼接到渠道模板的协议 `base_url`。
- 替换上游 `Authorization` Header 或 `X-Api-Key` Header。
- 必要时用路由的 `upstream_model` 替换入站规范模型 ID（入站别名归一发生在路由匹配之前）。

响应侧默认不做业务改写（`AGENTS.md` 第 5 节受控字段补全例外除外）：

- 不改 status code。
- 不改 response body。
- 不包装错误。
- 不补 `usage`。
- 不解析或重组 SSE。

## 运行时配置快照与后台任务

`config/index.ts` 的 `RuntimeConfig` 以 revision 发布完整配置；SQLite 成功持久化后才更新
内存快照。代理同一次请求必须持有同一快照，不能把不同 revision 的渠道、账号、路由与规则拼接。
新请求读取新快照，旧请求不应因用户保存配置中断。监听、Client Token 和捕获配置保持各自生命周期。

`storage/background-jobs.ts` 保存任务与事件，并提供进程内取消支持；桌面各领域负责租约去重，
`host/scheduler.ts` 提供周期维护。不得把旧宿主的统一 RAII `JobRuntime` 类型声称为 Node 已实现。
必须保留同作用域防重入、取消、超时和中断恢复的行为要求，失败不影响代理主链路。
React 的 Agent 同步编排、固定事件与后台周期须复用执行槽，避免 StrictMode 或隐藏/恢复产生重复定时器。

## Agent 本机环境探测

Agent 接入向导通过只读 Node command 探测本机 CLI 环境，前端不直接读取文件系统或执行 Shell。调用链为：

```text
Agent 接入组件
  -> src/domains/agent/commands.ts
  -> detect_agent_environment
  -> packages/flowlet-core/src/agent/environment.ts
```

Claude Code 探测同时检查 PATH 和官方常见安装位置，返回当前主安装、全部候选安装、可执行文件路径、安装目录、版本及安装方式。OpenCode 探测同时覆盖 CLI 与 Desktop：CLI 检查 PATH、原生脚本、npm、Bun 等常见位置并执行版本命令；Desktop 检查各平台常见应用位置且不会启动桌面进程。ChatGPT（Codex）同样同时探测 Desktop 与 Codex CLI；CLI 覆盖 PATH、npm 和官方独立安装目录，并通过 `codex --version` 读取版本。保留全部候选用于识别多版本或 CLI/Desktop 并存；探测结果只存在于 TanStack Query 内存缓存，不写入 SQLite 或 `config.json`。

Codex CLI 当前支持安装探测、账号用量复用和原生会话读取。Codex 与 Claude Code、OpenCode、Pi 同为标准一等 Agent，由 `agent/adapters/` 模块一键写入 `~/.codex/config.toml`（`[model_providers.flowlet]` 经 Responses wire API 指向本地代理、`requires_openai_auth = true`）与 `~/.codex/config.toml`，受管字段先备份再写入、恢复时还原；Codex CLI、ChatGPT 桌面端与 VS Code 插件共享同一份配置。账号观测（订阅用量、套餐、Credits、重置机会）承载于概览页渠道账号卡片的伪账号行——该伪账号只读、不参与路由、不开放编辑，行点击打开只读详情抽屉。当前准确支持范围见 [`support-matrix.md`](./support-matrix.md)。

Antigravity 订阅额度也由概览页渠道账号卡片承载，但使用独立只读观测报告，而不是持久化渠道账号。
`useAntigravityAccounts -> query_antigravity_accounts` 并行组合 Google OAuth 远端额度与本地服务观测。
`agent/antigravity-oauth.ts` 负责浏览器授权、PKCE/state 回调校验、独立离线授权保存、令牌续期和远端额度查询；
授权后无需保持 Antigravity 运行。授权数据保存在数据库同级 `antigravity-accounts`，与客户端凭据隔离，
不安装扩展、不写客户端配置、不参与代理路由。自动刷新由前端每两分钟触发，失败保留上次成功快照并标记过期；
权限不足或无实测额度时显示错误，不将模型可用性当作 100% 额度。本地发现与授权账号按邮箱去重，授权账号优先。
详情和兼容边界见
[`antigravity-account.md`](./antigravity-account.md)。

Claude Code 用户级全局配置由独立的 `agent/adapters/` 模块管理。前端只读取脱敏状态并触发应用或恢复；Node 解析 `CLAUDE_CONFIG_DIR` / `~/.claude/settings.json`，安全合并 Flowlet Base URL、Client Token 和模型别名映射。修改前只备份受管字段，恢复时不覆盖用户后续新增的其他 Claude 设置。完整字段和优先级见 [`claude-code-global-config.md`](./claude-code-global-config.md)。

OpenCode CLI 与 Desktop 共用用户级配置。Flowlet 在 `~/.config/opencode/opencode.jsonc`（或已有的 `opencode.json`）中结构化合并 `provider.flowlet`、`model`（主模型）与 `small_model`（快速模型）；Flowlet 不再修改 `server.hostname` / `server.port`，重新应用配置时会清理由短暂发布版本写入的固定端口字段并恢复备份原值。Client Token 单独写入 `~/.local/share/opencode/auth.json` 的 `flowlet` 凭据项。JSONC 修改保留未受管字段和注释；配置与凭据均先备份受管值，再支持恢复。完整行为见 [`opencode-global-config.md`](./opencode-global-config.md)。

Agent 接入抽屉中的 Client Token 默认使用固定长度掩码；查看按钮只在当前抽屉会话中临时展示，关闭后恢复掩码，复制始终使用真实值。Claude Code 手动片段与一键写入字段保持一致；OpenCode 将 Provider 配置和 `auth.json` 凭据拆成两个片段。OpenCode 配置与凭据采用双文件事务写入，第二个文件失败时恢复两个文件的原始字节内容。

Agent 安装引导与版本更新提示：`check_agent_latest_versions` command（`packages/flowlet-core/src/agent/version.ts`）按插件注册表从 npm registry 并行查询最新发布版本，带进程内 TTL 缓存（15 分钟）与单 Agent 独立错误处理，只做提示、不执行升级。传统 Agent 的 npm latest 对应 CLI 包版本，DeepSeek Harness 的 npm latest 对应 Web 分发包；ChatGPT Desktop / OpenCode Desktop 使用独立版本体系，不参与比较。前端用纯函数 `isNewerVersion` 判断「有新版」：接入抽屉在对应 CLI 或 Web 标签页展示已安装版本与最新版本、检测到新版本时给出「x → y」与官网更新说明链接。版本检查数据仅存在于前端 Query 缓存，不写入 SQLite 或 `config.json`。

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

## Channel 能力边界

渠道能力必须同时有声明与实现。Node 当前的模型同步、余额、地址与抓取入口分别位于
`web/model-sync.ts`、`web/balance.ts`、`web/config-state.ts` / `proxy/http.ts`、
`desktop/scrape.ts` 与 `scrape/`（相对 `packages/flowlet-core/src/`）。
不得照旧目录名声称 Node 已有一个统一的 Channel Capability Adapter 类。
新增渠道必须核对 `plugin-registry.json`、`config.json`、SQLite 升级及这些真实入口，
保持渠道专属解析隔离、共享路径不扩散特例、不支持能力明确报错。
认证与端点来自配置，不复制 API Key 或另一份地址表。余额/目录同步失败不能影响真实模型请求。
端到端流程与验收见 [渠道接入指南](channel-integration.md)。

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

渠道资源同步复用 Node 命令与后台任务，必须保留防重入与逐账号结果。控制台抓取仅在
Electron 本机 Host 可用，由 `packages/flowlet-desktop/src/scrape.ts` 的 CDP 捕获与
per-account partition 隔离登录态；不依赖旧 WebView 目录。抓取必须等待描述符的业务槽位，
不能用页面文档或埋点替代成功。登录失效/验证码应提示人工处理，后台不得反复弹窗或伪造成功。
Qwen 已有 HTTP 平台登录路径，见 `web/qwen-platform.ts` 与 `channel-integration.md`。

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
- `GET /v1/models/{model}` 由本地代理直接返回开放模型详情，不转发单一上游。规格和价格优先读取渠道详情同步所得 `channel_models`，字段缺失时回退本地 `models-cn.json`；只返回单一规范模型的规格与价格，不再按候选合并规格下限或价格上界。`max_input_tokens` 仅在数据源明确提供独立输入上限时返回；不得用上下文窗口减最大输出推导，当前数据源未提供时返回 `null`。
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
- `app_meta`

安装实例身份独立保存在 SQLite 同目录的 `flowlet-device.json`。首次启动生成 UUID，
后续启动稳定复用；配置导入、数据库替换和普通数据包不得覆盖或携带该文件，避免把
来源设备恢复成当前设备身份。设备身份格式无效时启动明确失败，不静默生成新 ID。
身份文件同时保存用户可编辑的 `displayName` 和平台类型；默认名称只由平台和设备 ID
短前缀组成，不采集主机名、用户名、MAC、序列号或硬件 ID。重命名只更新展示名称，
不会改变 `deviceId`，保存后立即热生效。headless / Docker Host 同样在数据目录生成并
复用该文件，因此 Docker 数据卷中的设备身份跨重启稳定，用量统计中的「本机」即该服务实例。

多设备共享使用最小设备快照：`device_usage_snapshot` 返回设备 ID、身份
创建时间、展示名称、平台、Flowlet 版本、快照生成时间、当前本地时区偏移，以及按设备
本地自然日聚合的请求数和 Token 分项。快照版本 2 额外携带最近 180 天按设备本地自然小时
聚合的请求数与总 Token，供桌面用量视图展示真实的 7×24 逐小时热力图；版本 1 快照继续兼容
导入，只是没有小时视图数据。快照版本 3 增加桌面端已知 Agent 的安装摘要和 Flowlet 接入状态：
只同步 Agent ID/名称、CLI 或桌面端安装面、安装方式、版本、全局配置识别结果，以及最近同步的
会话中是否存在经过 Flowlet 的观测记录；不携带可执行文件路径、配置文件路径或任何凭据。
会话摘要继续采用限量根会话策略：`running` 与 `waiting_user` 状态全部保留；两者合计不足
10 条时，按最近活跃时间用 `idle` / `unknown` 会话补足到 10 条；运行态超过 10 条时不截断。
快照版本 4 为这些入选会话增加最后一次交互：除设备/会话寻址、标题、客户端、状态、最近活跃
时间及请求与 Token 汇总外，还携带最后一次真实用户输入以及
该输入之后按原生顺序产生的全部助手回复、思考、工具调用、工具结果和错误事件。产生新的
用户输入后，新快照会以新的最后交互整体覆盖该设备上一版会话数据；单条事件内容和事件数
不做截断。快照仍不携带渠道账号、凭据、Header 或代理请求 Body，但最后交互本身
属于敏感会话正文，远端存储必须按敏感数据管理。单个远端对象设有 64 MiB 完整快照硬限制，
超限时拒绝整个对象，不静默裁剪会话内容。版本 1 至 3 快照继续兼容导入，缺失的最后交互按空处理。
快照版本 7 在会话摘要中增加可选的 Agent 原生累计 Token、原生轮次与截断标记。共享会话对未经过
Flowlet 的会话使用这些原生指标；原生轮次不冒充 HTTP 请求数，原生数据无法提供的失败数也不显示为 0。
快照版本 8 在每日汇总中增加经过 Flowlet 代理且已成功计价请求的 `estimatedCost`；旧快照缺失该字段时
按 0 兼容，不根据 Token 反向猜测价格。快照版本 9 在小时汇总中增加 `unknownCount`，使周视图选中
3 小时时段的数据可信度可以按该时段精确计算。快照版本 10 进一步为小时汇总增加输入、输出、缓存
计量、预估费用及 Agent 原生输入/输出，使选中 3 小时时段的详情与大周期四项摘要保持同一口径。
版本 1 至 9 快照继续兼容导入，缺失新增字段时按 0 处理；缺失原生摘要时明确显示为不可用。
日行和小时行都由现有 `request_logs` / `usage_records` 实时聚合，不新增当前设备事实表；
导入的小时汇总写入只读共享表 `device_hourly_usage`。历史用量修复后重新生成快照即可按
`(device_id, date)` 更新日汇总，并用较新的版本 2 快照整体替换该设备的小时窗口，无需重启代理。

快照版本 13 增加可选 `accountResources`，用于桌面设备间只读共享工作区级账号资源。普通渠道账号
只有同时具备稳定 `workspace_account_id`、已启用、符合渠道资源自动同步条件且存在成功资源快照时
才会发布；Codex 只发布存在订阅窗口或 Credits 的已登录账号。字段仅包含账号展示身份、套餐、
余额/资源包聚合值、额度窗口、重置/到期时间、观测时间与过期标记，不包含 API Key、Management
Key、Base URL、Cookie、原始抓取 JSON 或错误全文。接收端写入独立只读表
`device_account_resources`，按稳定账号 ID 选择 `observed_at` 最新的设备观测，因此同一账号不会按
多台桌面重复出现。账号资源属于工作区；资源摘要与账号凭据同步是独立边界，
设备快照不携带账号工作区密钥，也不因导入快照而直接请求渠道上游。

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
`Secret Access Key` 通过 Electron keyring bridge 单独存入 safeStorage 加密文件，兼容读取旧 OS 凭据条目，不写入 `config.json`、导出包、任务日志或错误消息。配置保存、连接测试
和手动同步均为热更新，不影响代理运行。

桌面端可在同一 S3 空间中显式启用“渠道账号工作区”。工作区对象固定为
`<prefix>/flowlet/v1/workspace/channel-accounts.enc`，使用独立随机 32-byte 密钥执行
ChaCha20-Poly1305 端到端加密；密钥通过 Electron keyring bridge 保存在 safeStorage 加密文件，并且只通过用户主动复制的
“桌面端账号工作区接入包”迁移到另一台桌面设备。普通 S3 连接包和设备快照均不携带
该密钥；仅连接设备同步不能解密渠道 API Key。

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
校验或导入原因，桌面设置页可读取失败明细；旧状态缺少该字段时按空列表兼容。覆盖已有
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
执行入口、状态记录和 `JobRuntime` 作用域；发生重叠时定时任务静默跳过，不覆盖正在运行的
同步状态。未配置 S3 时定时检查静默跳过，不写入失败状态。每次真正开始的手动或定时同步
都以 `job_type = device-s3-sync` 写入 `background_jobs` / `background_job_events`，记录
触发来源、完成摘要和失败原因；摘要同时记录实际上传/下载字节数与对象列举、下载、导入、
快照生成、上传各阶段耗时。桌面端按远端对象 ETag 缓存已成功导入的快照，后续同步跳过
未变化对象的重复下载和导入；导入失败的对象不更新缓存，下一轮继续重试。因互斥而跳过的
定时检查不创建任务。

设备快照版本 5 增加可选 `lanPeer` 发现信息：桌面端启动独立的随机端口 HTTP 服务，将当前
主路由解析出的私有 IPv4 地址、协议版本、能力列表、20 分钟有效期和本次启动随机生成的
32-byte capability key 写入自己的 S3 快照。capability key 不包含或派生自 S3 凭据，只通过
已经按敏感数据管理的 S3 快照分发；局域网请求使用 HMAC-SHA256、30 秒时间窗和单次 nonce
认证，响应正文使用 ChaCha20-Poly1305 加密并绑定请求 nonce。客户端只连接字面量私有 IP，
拒绝域名、环回、链路本地、公网地址和无显式端口的端点，避免把远端快照变成任意网络探针。

S3 仍是桌面设备间的发现和离线同步通道，桌面同步继续执行“拉取其它设备 + 上传当前设备”。
LAN 服务保留完整快照、单会话读取及 OpenCode 单次权限回复的认证通道；
权限回复仍由 Agent 所在 PC 再次查询并调用本机权限桥接，已处理、过期或离线请求返回明确错误，
不暴露永久放行，也不承诺系统级后台推送。

为便于排查“是否已正常开放”和“设备间能否直连”，桌面端在设置页「同步」Tab 展示「局域网直连」
卡片：服务运行状态（监听地址、启动时间、启动失败原因）、对已知设备的轻量探测结果（可达延迟 / 不可达原因
/ 未发布直连信息），以及最近入站请求记录。服务端从 Node HTTP socket 读取 TCP 对端 IP
记录到内存 ring buffer（容量约 50），旧版客户端没有 ping 端点也会显示为未知来源 IP，不依赖
客户端上报身份。桌面端可据此诊断设备间的直连与 S3 同步状态。
探测使用新增 `GET /flowlet/v1/ping` 端点，返回 device_id、协议版本、能力和服务端时间；旧版
Flowlet 返回 404，前端将其归类为“对端版本过旧”，并继续使用 S3 快照作为回退。

当前产品仅保留 Electron 桌面宿主与 Web/Docker Host；
桌面端保留设备身份、S3/LAN 同步、共享快照兼容与账号工作区。

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

查询会话列表时，Node 会只读、尽力而为地建立本地原生会话目录：OpenCode 从用户本地
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
`get_agent_session_native_summary` 只返回累计摘要。Node 内部以只读方式解析 OpenCode
`message` / `part`、Claude Code JSONL、Codex rollout JSONL 和 Pi 活动分支：一部分用于计算
摘要与成本，另一部分仅在生成设备快照时提取最后一个用户回合；解析结果不写入当前设备的
Agent 会话事实表，也不读取 Codex developer 指令。
前端以右侧浅灰用户气泡和左侧 Agent 正文自然区分对话角色，不渲染输入/输出分区标题或重复身份；
输出流把相邻的思考、工具调用和工具结果合并为默认折叠的轻量过程行，工具参数与结果按常见字段
结构化展示，未知格式回退为原始文本。最后一轮提取同时保留所属 Agent 轮次状态：尚未写入最终回复时
显示“正在处理”，已结束但没有可展示回复时给出明确状态，不把未完成误呈现为内容读取丢失。
OpenCode 的可操作状态不从 SQLite 推测：`agent/opencode-control.ts` 通过本机 `GET /permission` 读取进程内
待确认权限并按 `sessionID` 过滤，前端在 OpenCode 会话详情的“最近一轮” Tab 激活期间每 2 秒轮询；“同意本次”和“否决”
分别调用 `POST /permission/{requestID}/reply` 的 `once` 与 `reject`。控制服务离线时返回结构化不可用状态，
不影响会话概览；回复失败保留待确认卡片并向用户显示错误。
原生摘要返回 Agent 累计用量和模型集合。OpenCode 使用 `session` 的累计
Token / cost 与消息级 tokens；Claude Code 对去重后的助手回复 usage 聚合输入、输出、缓存创建和
缓存读取；Codex 使用最新 `total_token_usage` 作为会话总量，并在
`task_started` 到 `task_complete` 之间累加每次 `last_token_usage`，形成可核对的轮次用量，同时记录
轮次总耗时和首 Token 延迟。原生用量与
Flowlet 请求观测始终分栏展示且不相加；OpenCode 原生提供的 cost 直接展示。Codex 在能够确定唯一模型且
价格存在精确匹配时，只根据明确 Token 消耗展示 `openai-api` 标准基础 API 公开价计算的 API 等价价值，并保留
USD 等原始计价币种；返回未缓存输入、缓存命中、缓存写入和输出四项费用，供列表提示逐项对账。各项由后端与总价一次计算，前端不重复套用价格。不根据套餐类型、自定义比例或周额度百分比派生 credits 或套餐消耗。
用量统计页通过 `usage_summary` 读取按日或小时聚合的 Flowlet 请求行与去重后的 Agent 原生行，按来源设备筛选后再应用 `usage_cost` 固定展示汇率；顶部卡片、选定时段和费用热力图共用同一折算函数。折算只发生在前端展示层，原始费用和币种保持不变，原生实际 cost 不参与合计。
无法从原生记录确认的长上下文、Priority processing 或 Fast mode 乘数不纳入基础估算。Claude Code 不在
缺少可靠价格映射时伪造费用。产品界面只按需读取最后一次交互，不提供更早历史回溯；列表与详情的
累计指标使用 `get_agent_session_native_summary`，只返回 turn 数、累计用量和模型集合。同步快照存在时
列表不再重复解析原始文件；缺少快照时按可见行懒加载并缓存 5 分钟。原生摘要达到读取上限时，列表用
`≥` 明确表示计数或 Token 为下限。
会话列表中经过 Flowlet 的 Token 汇总复用请求日志的明细提示，按会话聚合输入、缓存输入、未缓存输入、
输出和总 Token；缓存命中率仅以明确返回缓存字段的输入 Token 为分母，缺少 Token 明细的请求单独计数，
不把未知用量当作零值参与命中率。

桌面用量成本页把“经过 Flowlet”与“Agent 原生”Token 合并到同一日/小时统计，明细中拆分
来源。经过代理的 HTTP 请求写入 `usage_records`；未经过 Flowlet 的 Claude Code、Codex、OpenCode
和 Pi 用量按消息或轮次写入 `agent_usage_events`。原生逐事件账本使用
`(agent_type, session_id, event_id)` 幂等去重并按事件时间归集，只纳入未被 Flowlet 观测的根会话，
避免父子会话和代理请求重复相加。缓存命中率仍保持 Flowlet 可测量口径，不把缺少对应分母的原生缓存
输入混入。Agent 自动或手动同步完成后会失效设备用量查询；设备快照携带 `native_*` 聚合字段，使其他
桌面设备看到相同的来源拆分。费用、API 等价价值和套餐 credits 不换汇、不相加；缺少可靠价格
映射时保留未计价状态。

PC 运行概览顶部“今日消耗”与用量统计页的“日 / 全部设备”使用相同口径：本机代理 Token、本机未经过
Flowlet 的 Agent 原生 Token，以及 `device_daily_usage` 中其他设备当天快照共同计入。概览仍通过
`usage_today_tokens` 返回单条当天聚合，不轮询整段历史；指标点击后进入用量统计页，不再展示悬浮拆解。

PC 用量分析页的 `usage_summary` 进一步把能够确认具体模型的纯原生事件映射为同一只读分析行：
事件自身的 `model` 优先；Codex 等 token 事件不携带模型时，仅在同一会话的
`agent_session_snapshots.summary_json.models` 能确认唯一规范模型时回填，多模型或未知模型会话不猜。
历史日志中可能出现的 `flowlet-pro` / `flowlet-flash` 是已移除的旧聚合别名，不是真实上游模型，因此不会作为 Codex 原生模型分析行计入；这类会话的真实模型与用量以 Flowlet 请求账本中的 `upstream_model` 为准。该规则也
避免共享 Codex 会话被多台设备同时扫描、但只有实际请求设备持有代理日志时产生跨设备重复统计。
时间范围比较先通过 SQLite `datetime()` 统一 RFC3339 表示，避免周期起点当天的边界误收。
`channel_id = agent-native` 仅表示来源，`account_id` 保存 Agent 类型，
`client_id` 保存统一客户端归属，`request_count = 0`，并用 `native_event_count` 单独表达消息级事件数。
前端用量洞察页因此不把 `agent-native` 当作渠道品牌：渠道账号维度的原生行按 `account_id`、
客户端维度按 `client_id` 解析 Agent 品牌图标（`agentBrandKey`），只有未登记品牌的归属才回退首字母徽标。
该映射不新增数据库列；`estimated_cost_currency` 只存在于 command 返回结构中，用于让前端优先按
后端实际命中的价格币种聚合。公开价匹配顺序为模型官方渠道、`openai-api` 保留命名空间、唯一非套餐
价格；不会从 API 金额或套餐类型换算 credits。模型无法精确计价时金额为 0、币种为空，Token 仍参与
模型、客户端和设备维度分析。

设备同步快照的 `usage_breakdowns` 同时携带最近 90 天的代理请求维度行与上述 Agent 原生模型维度行。
原生行从本机 `agent_usage_events` 和会话快照动态生成，保留 `native_event_count`、公开价币种与预估费用；
接收端按设备全量替换 `device_usage_breakdowns` 快照，并在导入边界把旧版 Codex Desktop 的 `codex`
客户端键规范化为 `codex-desktop`，因此归并键或模型规则升级后不会残留旧维度行。版本升级后既有原生
账本会在下一次正常设备同步自动补发，无需通过数据完整性检查改写历史记录；源设备与接收设备均需运行
支持该同步字段的版本。

Codex 账号与用量另有独立的周期性后台同步：应用启动约 20 秒后首次执行，此后固定每 5 分钟一轮，前台与
后台同周期（Codex 官方用量窗口本身是 5 小时 / 周级粒度，5 分钟足够新鲜，也避免高频调用官方用量接口与
反复拉起 app-server 进程）。Node 在同步前先做廉价检查：既没有 `~/.codex/auth.json` 登录凭据、也没有托管
多账号目录时直接跳过，不创建任务、不发起网络请求；存在账号时复用 `query_codex_accounts` 刷新当前账号与
所有托管账号的用量快照，并以 `job_type = codex-account-sync` 记入 `background_jobs` /
`background_job_events`，单个账号刷新失败只记警告事件、不中断整轮同步。任务记录同时保存账号数量、
失效账号、失败账号与总耗时，可按 `job_type` 与状态筛选；同步成功后前端失效 Codex 账号查询缓存以刷新界面。
同一时刻只允许一个 Codex 同步运行；其 `JobRuntime` 作用域与 Agent 数据同步相互独立。
Codex 账号支持单账号删除（`delete_codex_account`）：按 `account_id → 目录` 确定性映射定位，
目录名规范化不匹配时回退扫描 `snapshot.account_id`，删除后移除托管目录中的 `auth.json` /
`snapshot.json` / `config.toml`。删除只作用于 Flowlet 保存的本地副本，不影响 Codex 客户端
自身的登录状态；若该账号仍是当前登录账号，下一轮同步会按 `~/.codex/auth.json` 重新发现。

Agent 数据同步在应用启动约 3 秒后首次检查，窗口前台每 1 分钟、后台每 5 分钟检查一次，恢复到前台时
尽快补查。自动检查只有发现来源指纹变化时才创建任务；会话页手动同步会强制重新整理并始终保留记录。
前端周期、文件事件与恢复前台触发共用单个执行槽；扫描未完成时合并为一次后续检查，防止生成并行扫描
和多条周期定时器。窗口隐藏后立即把周期检查延后至后台间隔；卸载后不再刷新查询或重建定时器。
Node/Electron 使用受控文件事件监听现有 OpenCode 数据库、Claude Code 项目目录和 Codex sessions 目录，文件事件只作为
“需要重新扫描”的提示，由前端静默 8 秒后触发同一增量同步，并限制文件事件触发间隔至少 30 秒；
冷却期内的新变化延迟到冷却结束后检查，不直接丢弃。
定时轮询始终保留为漏事件和新目录的兜底。扫描指纹时仅短暂持有 SQLite 锁，解析 Agent 原始文件期间
不占用数据库，确保后台任务记录查询和其他页面查询不会被长任务阻塞。
同步发现仍可访问数据源中的会话已经消失或归档时，不删除 Flowlet 已保存的摘要快照和
`agent_usage_events` 历史账本，只把快照标记为“源文件已删除”；会话列表和用量统计继续使用最后一次同步值。
源文件重新出现时会强制重新解析并恢复为可用状态。只有用户未来通过明确的删除入口主动要求遗忘时，才可同时
删除快照和原生用量账本。`agent_source_sync_state` 按客户端保存上次检查、上次成功整理、扫描数、变化数、失败数
和错误。单会话失败不覆盖旧快照或指纹，因此后续检查会重试。
Codex 与 Claude Code 的 JSONL 摘要快照额外保存解析器版本、已读取字节位置、游标前 4 KiB 校验值和
Claude usage ID 去重集合；后续仅解析追加内容，不把消息或工具正文写入 SQLite。文件缩短、游标校验失败或
解析器版本升级时自动从头整理。单轮最多读取 16 MiB，未读完时使用 partial 指纹让下一轮继续推进。
同一时刻只允许一个 Agent 同步运行，进程内状态由 `JobRuntime` 管理。通用任务执行信息落入 `background_jobs`，阶段事件落入
`background_job_events`，包含触发方式、进度、结果、警告和错误；应用启动时会把上次未结束的
任务标记为 `interrupted`。任务调度属于 React 产品编排，Node command 负责只读扫描、SQLite 一致写入和
并发互斥；同步失败不会影响代理请求链路，配置变更也不需要重启代理。

自动 Agent 同步单轮最多整理 12 个变化会话，手动同步最多 20 个，优先处理最近活动会话；未处理部分不更新
指纹，下一轮会继续发现。单会话解析在独立线程中执行，等待上限为 5 秒，超过 1 秒记为慢会话；超时、慢会话、
目录扫描、指纹比较、会话解析、SQLite 写入和任务总耗时均进入任务日志。解析原始文件时不持有 Storage 连接锁，
任务取消、列表和详情查询可以并发执行。运行中任务可请求取消，当前会话解析完成或超时后停止后续处理。
任务详情同时记录全量/增量会话数量和实际读取的源文件字节数，增量会话会生成单独的处理事件。
任务记录按 20 条分页并支持状态、类型筛选；`cleanup_background_jobs` 清理 90 天前已结束任务，应用启动也会执行相同保留策略，
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
当前 Node 自动维护尚未确认有原生 transcript 唯一匹配回填路径；不得按旧宿主描述声称已实现。
如人工审计或后续实现，只允许同一 Agent 会话、规范模型与时间窗唯一匹配，多个候选一律跳过。
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
表示 `api key is disabled`，当前账号会被标记为凭据不可用，并继续尝试同一规范模型的
下一个候选（包括跨渠道降级）。该状态视为可恢复的临时停用：后续每个新请求仍会探测
一次该账号，探测成功后立即恢复为 `healthy` 并清除错误。普通 403 仍保持终态，避免对
权限或请求错误盲目重试；401 无效密钥仍需修改 Key 或显式测试连接成功后恢复。

普通 400 请求参数错误同样保持终态，不跨模型重试。若 400 错误体同时明确返回
`code = invalid_parameter_error` 且消息表示 `product is not activated`，则说明当前上游
账号未开通所选模型产品，而非客户端请求结构无效；代理会把该 attempt 记为
`product_not_activated` 并继续尝试同一规范模型的下一个候选。

模型价格不写入 SQLite。运行时价格表在内存中装配，来源按优先级为：本地 `models-cn.json`
（国内厂商官方价，CNY，含 `inputTokenRange` 分级与促销价优选）与 `models-dev.json`
（models.dev 国际官方价，USD；`openai` provider 映射为 `openai-api` 命名空间），`config.json` 的
`channels_config.model_prices` 仅补充目录未覆盖的 `(channel_id, upstream_model)`。
两份目录文件随安装包内置到 exe 旁，后台任务每小时同步一次；价格表在启动时与每次
目录同步成功后重建。

### 统一 AI 成本账本（目标架构）

成本账本在现有 `request_logs` / `usage_records` 之上增量建设，不替换代理日志主链路。目标层级为 `cost_source -> product/account -> task -> session -> usage_event`，并由独立 `CostAllocationEngine` 按账期生成带版本、可信度和解释信息的 `cost_allocations`。

当前 `usage_records.estimated_cost` 仅表示公开模型价格估算，目标语义映射为 `list_price_cost`。实际现金扣费、套餐或资源包分配成本及 API 等价价值分别使用 `cash_cost`、`allocated_cost` 和 `equivalent_cost`，不得继续复用 `estimated_cost` 表示全部成本。

规划新增的 `cost_sources`、`usage_events`、`agent_tasks`、`agent_sessions` 和 `cost_allocations` 必须通过 SQLite migration 增量创建。网关请求幂等映射为 `usage_event`；无网关请求的 Agent turn、会话汇总、官方记录和手动用量也可以成为事件，因此 `request_id` 可空。

成本公式、金额精度、事务、账期重算和分配版本由 Node/TS 核心 保证；React 负责来源配置、业务流程编排、状态反馈和解释展示。Adapter 同步失败不能影响代理或其他 Adapter，未经用户授权不读取第三方本地数据，默认不保存 Prompt、Response、对话正文或凭据。

当前已落地的第一步是只读数据源探针：`cost_ledger_source_probe` 复用现有会话元数据与时间线解析器，并通过统一 Observation / Evidence / ProbeReport DTO 报告 Flowlet 网关、Codex、Claude Code 和 OpenCode 的可用粒度、字段缺口、去重键、增量游标、格式指纹及可信度。探针不写 SQLite、不建立账本事实表，也不返回会话正文、凭据或原始文件路径；它用于在 migration 与成本引擎设计前验证真实数据边界。

完整需求、MVP 边界、实施阶段和验收标准见 [`ai-cost-ledger.md`](./ai-cost-ledger.md)。该章节描述目标架构，不代表相关表和引擎已经实现。

### analyzer

离线分析任务：

- 优先从 `response.usage` 提取 token。
- 拆分输入 Token、缓存命中输入、未缓存输入与输出 Token。
- 没有 usage 时标记为 `unknown`。
- 根据运行时内存中的模型价格计算成本。
- 支持按日期、渠道、账号、模型、客户端聚合。

价格读取当前运行时内存快照：`models-cn.json` 与 `models-dev.json` 提供主要官方价格，
`config.json.channels_config.model_prices` 只补充目录未覆盖项。目录后台同步成功后会热重建快照；
修改编译/磁盘配置仍按配置加载流程生效，`config.json` 不是价格的唯一真实来源。

## 桌面端 UI

桌面路由保留概览同步加载，模型服务、请求日志、会话管理、用量统计、用量洞察和设置页面按需加载。
各页面的 Suspense 边界放在壳内，加载期间保留侧栏和窗口控件；后台同步组件不随页面切换重建。

桌面 UI 只做管理、接入引导和状态观测，不承载复杂平台能力：

- 概览页展示代理状态、渠道账号、开放模型、客户端访问信息和 AI Agent 接入；
- 代理运行中提供“重启服务”，未运行或启动失败时提供相应启动动作；暂停代理只放在高级设置等低频入口；
- 渠道账号负责 API Key、连接测试、余额、资源包和模型同步，并可分别覆盖 OpenAI-compatible 与 Anthropic-compatible 上游 Base URL；
- 开放模型负责对外模型名、可用账号和启用状态；
- 客户端访问信息提供 Base URL 与默认掩码的 Client Token，并支持查看和复制；
- Agent 接入打开完整说明或配置抽屉，不只复制单个地址；
- 请求日志提供真实筛选、统计、分页、尝试链路和捕获详情；输入模态不匹配或请求协议不支持的候选在尝试链路中记录为未请求上游的“已跳过”降级节点，随后展示实际命中的候选；是否脱敏仅由 `log_capture.redact_sensitive_headers` 决定；
- OpenCode 会话页按稳定会话 ID 聚合客户端、请求、Token、费用和失败数，支持客户端筛选，并复用请求日志详情；
- 用量与成本页面只展示真实记录和当前价格配置计算出的结果。
- 设置页的数据修复展示四阶段进度和每阶段结果，用量页不再承担维护操作。

跨页面的大数展示统一使用 `src/shared/formatters/number.ts` 和 `CompactNumber`：中文紧凑格式采用
“万 / 亿 / 万亿”，英文采用 “K / M / B / T”，默认最多保留 1 位小数；紧凑组件同时通过
`title` 保留本地化后的精确整数。业务页面不得再分别维护 Token 或请求数的 K/M、万/亿换算。

应用窗口使用 Electron 无系统边框模式（`frame:false`），标题栏和窗口控制通过受控 preload
bridge 调用 main；关闭隐藏到托盘，只有“退出 Flowlet”才停代理退出。窗口状态位于数据目录的
`window-state.json`，由 `packages/flowlet-desktop/src/window-state.ts` 读取并校正到工作区。
保留 1200×720 客户区验收与弹层/Toast 层级要求，DPI 与多显示器效果须分别真机验证。

全部界面文案使用中文。

## 非目标

第一阶段明确不做：

- Anthropic / Gemini / OpenAI 之间协议转换。
- 云端账号系统。
- 团队计费系统。
- 通用的 MCP / Prompt / Skills 管理，以及脱离 Agent 数据源的跨 Agent 会话编辑。
- Channel marketplace。
- 复杂智能路由和小模型路由判断。
- 在主请求链路实时查询价格、余额、额度或用量。
