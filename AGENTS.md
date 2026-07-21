# Flowlet Agent Instructions

本文件是 Flowlet 项目中所有 AI 编程 Agent 的统一协作规范。

维护本项目需安装 Semi Design 技能：https://semi.design/zh-CN/start/mcp-skills

涉及 AI / LLM 品牌图标时，必须先读取 Lobe Icons 官方技能：https://lobehub.com/icons/skill.md

图标资源默认规则：

- 优先尝试 `@lobehub/icons-static-svg` 等官方静态包，不优先引入 React 组件包 `@lobehub/icons`；
- Flowlet 是本地桌面应用，核心界面使用的品牌图标应优先固化到项目资源，避免运行时 CDN 依赖；
- 固化静态图标时必须记录来源版本并保留上游许可证；
- 只有官方静态包无法满足交互或主题需求时，才评估引入 React 图标组件及其 peer dependencies。

适用于但不限于：

- Codex
- Claude Code
- OpenCode
- Pi
- Cursor Agent
- GitHub Copilot
- 其他能够读取项目规则文件的 AI Agent

请优先遵循本文件。不要为不同 Agent 重复维护彼此冲突的项目规则。

---

## 1. 项目定位

Flowlet 是一个面向 AI Agent 的本地桌面模型服务控制台。

它负责：

- 管理上游渠道账号；
- 管理对外开放模型；
- 为 AI 客户端和 Agent 提供本地代理端点；
- 提供请求日志、用量成本和运行状态；
- 提供 Agent 接入配置与后续会话观测能力。

Flowlet 不以通用企业级 LLM 网关为核心定位。

当前不追求：

- N×N 协议转换；
- 大规模企业多租户；
- 复杂网关控制面；
- S3 日志归档；
- 以权重、吞吐、延迟为核心的复杂调度系统。

---

## 2. 核心架构原则：前端优先

Flowlet 采用前端优先的桌面应用架构。

### React 前端负责

- 产品状态判断；
- 页面状态与交互；
- 业务流程编排；
- 代理自动启动、重启和失败重试的触发；
- loading、error、empty、ready 等 UI 状态；
- 配置保存后的后续动作；
- 通知、提示和用户反馈；
- 组合多个后端 command 完成完整业务流程。

### Rust 后端负责

- 本地代理服务；
- HTTP 请求转发；
- 本地端口监听；
- SQLite 持久化；
- 文件系统和系统托盘能力；
- Tauri command；
- 配置读写；
- 请求日志；
- 模型同步和余额查询等底层能力；
- 返回真实、明确、可处理的错误。

### 默认决策原则

当一个能力既可以在前端编排，也可以在 Rust 中做业务判断时：

1. 优先把业务流程和产品判断放在前端；
2. Rust 提供细粒度、稳定、可复用、可测试的底层 command；
3. 不要因为“后端更稳”就把所有产品逻辑下沉到 Rust；
4. 只有涉及并发安全、数据一致性、安全边界、系统生命周期或必须由底层保证的约束时，才下沉到 Rust。

示例：

- 应用初始化后是否自动调用 `start_proxy`：由前端决定；
- `start_proxy` 是否幂等、端口是否可监听：由 Rust 保证；
- 概览页展示“启动服务”还是“重启服务”：由前端决定；
- 代理真实运行状态：由 Rust 返回。

---

## 3. 代理生命周期

代理运行状态与渠道账号、开放模型配置状态相互独立。

### 必须遵循

- Flowlet 前端初始化完成后，如果代理未运行，应自动尝试启动一次；
- 没有渠道账号时，代理仍然可以启动；
- 没有开放模型时，代理仍然可以启动；
- 没有路由时，代理仍然可以启动；
- 账号和模型只决定代理当前是否有可用模型，不决定代理能否运行；
- 自动启动失败后不得无限循环重试；
- React StrictMode 下不得重复触发代理启动；
- Rust 的 `start_proxy` 必须保持幂等；
- 概览页不常驻展示停止按钮；
- 代理运行中展示“重启服务”；
- 代理未运行展示“启动服务”；
- 代理启动失败展示“重新启动”及错误原因；
- 暂停代理只放在高级设置等低频入口，不得出现在系统托盘右键菜单中；
- 关闭主窗口默认隐藏到托盘，代理继续运行；
- 只有执行“退出 Flowlet”时才停止代理并退出应用。

---

## 4. 配置状态与代理状态必须分离

不要将以下状态混为一个字段：

### 代理状态

- starting
- running
- stopped
- failed

### 模型服务配置状态

- unconfigured：没有可用渠道账号；
- no_models：存在可用账号，但没有可用开放模型；
- ready：存在可用账号和开放模型。

代理可以处于：

```text
running + unconfigured
running + no_models
running + ready
````

以上均为合法状态。

不要使用下面这类逻辑阻止代理启动：

```ts
accounts.length > 0
hasUsableAccount
hasAvailableModel
routes.length > 0
```

这些判断只用于：

* 页面引导；
* 模型可用性；
* `/models` 返回；
* 具体请求路由；
* 错误提示。

---

## 5. 协议原则

Flowlet 当前支持：

* OpenAI-compatible
* Anthropic-compatible

默认原则：

* 不做跨协议转换；
* 不随意改写请求结构；
* 不随意改写响应结构；
* 不把 Anthropic 请求转换成 OpenAI 请求；
* 不把 OpenAI 请求转换成 Anthropic 请求；
* 对外模型名使用 `virtual_model_id`；
* `upstream_model` 只用于向上游发起请求前替换模型名；
* 直接模型请求必须匹配 `virtual_model_id`；
* `/models` 只能暴露当前协议下可用的开放模型；
* 空配置时 `/models` 应返回合法空列表，而不是 500。

---

## 6. 渠道、账号和模型关系

核心数据关系：

```text
Channel
  └── Account
        └── Exposed Model / Route Candidate
```

规则：

* 一个账号只属于一个渠道；
* 一个账号保存一个 API Key；
* 用户可以在同一渠道下添加多个账号；
* 不创建隐式默认账号；
* 账号必须由用户主动创建；
* 开放模型必须明确绑定可用账号；
* 模型对外名称是 `virtual_model_id`；
* 模型上游名称是 `upstream_model`；
* 普通用户主要管理“开放模型”，不是复杂路由；
* Route Candidate、Route Rule 等高级能力不要主导普通页面的信息架构。

默认开放模型：

```text
LongCat:
- LongCat-2.0

DeepSeek:
- deepseek-v4-flash
- deepseek-v4-pro

Kimi:
- kimi-k3
- kimi-k2.7-code

千问 Qwen（按量付费账号）:
- qwen3.7-max
- qwen3.6-flash

千问 Qwen（Token Plan 账号，resource_mode = "token_plan"）:
- qwen3.8-max-preview
- qwen3.6-flash
```

千问 Qwen 是单渠道双资源模式：渠道级端点为按量付费地址；
Token Plan 账号（sk-sp 前缀 Key）通过账号级 Base URL 覆盖接入套餐专属端点，
默认开放模型由代码级常量（`QWEN_TOKEN_PLAN_DEFAULT_MODELS`，前端 TS 与
Rust `channels_config.rs` 各一份，必须同步维护）提供。

---

## 7. 概览页规则

概览页是状态总览和接入引导，不是统计大屏。

当前新版概览页必须保持已经确认的信息架构和功能边界：

* 主体由代理服务状态、渠道账号、开放模型、客户端访问信息、AI Agent 接入五个独立业务组件组成；
* UI 可以基于 Semi Design 和当前 Design Tokens 调整，但不得擅自改变模块划分、功能或左侧菜单枚举；
* 1200×720 桌面窗口下概览页不得出现页面级滚动条；内容溢出应优先通过组件密度、字号层级和内部布局解决；
* 跨页面视觉调整优先修改 Design Tokens 或共享组件，不要只为概览页复制一套局部样式；
* 新增账号、管理账号、管理模型、查看接入详情等轻量导航动作使用链接按钮，不伪装成主操作按钮。

不要在概览页加入：

* 今日请求数；
* 今日 Token；
* 今日成本；
* 请求趋势；
* 最近请求；
* 快捷操作集合；
* 复杂数据图表。

### 没有账号时

展示：

* 代理服务状态；
* 渠道账号引导；
* LongCat、DeepSeek、Kimi 和千问 Qwen 添加入口；
* 三步接入流程。

隐藏：

* 开放模型列表；
* 客户端访问信息；
* AI Agent 接入。

### 已有账号时

可展示：

* 代理服务状态；
* 渠道账号；
* 开放模型；
* 客户端访问信息；
* AI Agent 接入。

### 概览页禁止展示

* 完整 API Key；
* 脱敏 API Key；
* 无真实数据支持的硬编码指标；
* 所有模型统一写死为 128K；
* 所有模型统一写死为按量计费。

API Key 只在账号编辑界面中管理。

Client Token 与渠道 API Key 不同，可以在客户端访问信息中展示和复制，但必须默认使用固定长度掩码；只有用户主动点击查看按钮后才临时展示明文，复制操作始终使用真实值。

---

## 8. Agent 接入方向

Flowlet 的长期差异化重点是 Agent 接入，而不是通用网关能力。

重点支持：

* Claude Code
* Codex CLI
* OpenCode
* Pi
* Cline
* Continue
* Open WebUI
* Gemini CLI
* Hermes Agent

Agent 接入能力应逐步提供：

* Agent 类型；
* Base URL；
* Client Token；
* 默认模型；
* 配置片段；
* 复制完整配置；
* 配置检测；
* 配置备份；
* 配置写入；
* 最近请求；
* 会话和 Trace。

点击 Agent 卡片不应只复制一个 Base URL。应优先打开完整接入说明或配置抽屉。

### 客户端归属标记头

请求日志 / 用量中的“客户端”归属优先由请求头 `x-flowlet-client` 决定，再回退到
`config.json` 的 `ua_rules`（User-Agent 子串匹配）。复用通用 SDK、User-Agent 无法
区分的 Agent（如 Pi，其 UA 为通用 `OpenAI/JS`），必须在 Flowlet 写入的全局配置中
注入 `x-flowlet-client: <agent_id>`（Pi 写在 `models.json` 的 `providers.flowlet.headers`），
使 Flowlet 接管后即可识别。该头仅用于归属，不参与鉴权或路由；Flowlet 在识别后、
转发上游前会将其剥离（见 `proxy_http.rs` 的 `apply_request_headers`），不向上游泄露。
新增此类 Agent 时，需同步在 Rust `proxy_http.rs` 的 `agent_client_marker_name` 登记
展示名，并在一键写入与手动配置片段中同时注入该头。

---

## 9. 日志与捕获

请求日志可能包含敏感信息。

必须注意：

* 请求日志是否脱敏仅由 `log_capture.redact_sensitive_headers` 控制，当前默认关闭，用户可自行开启；
* `redact_sensitive_headers = false` 时，SQLite 原样保存，UI 原样展示并复制 Header、Body 和错误信息，包括 API Key、Authorization、x-api-key、Cookie、Token 等字段；
* `redact_sensitive_headers = true` 时，捕获层在落库前将受支持的敏感 Header 替换为 `[redacted]`，UI 直接展示并复制落库内容，不再二次脱敏；
* 有路由候选时，每条 attempt 的请求日志必须从完成 URL、模型和鉴权改写后的最终上游 Request 捕获，并与同一次第三方调用的响应对应；不得用客户端入站报文代替上游请求报文；
* 请求和响应 Body 捕获必须明确受配置控制；
* 新增日志字段时，要考虑存储体积；
* 错误应对用户可读，同时保留详细底层日志；
* 不要只 `console.log` 错误；
* 结构化错误应写入请求日志。

无可用候选时应区分：

* `no_available_account`
* `no_available_model`
* `model_not_exposed`

---

## 10. 前端开发原则

Flowlet 已完成前端目录正式化：`src/` 是唯一正式前端，使用 React 19、Semi Design、TanStack Query 和 CSS Modules。旧 Mantine 前端与运行时切换机制已经删除。

* 不得重新引入 Mantine 组件、样式或旧前端 Hook；
* 前端依赖方向保持 `pages -> features -> domains -> platform`，`shared` 不导入具体业务领域；
* 优先使用 Semi 组件 props、Flowlet Design Tokens 和共享 UI 组件，再增加同目录 CSS Module；
* 页面或 feature 不得全局覆盖 `.semi-*`，不得依赖不断提高选择器优先级或 `!important` 解决样式冲突；
* 无系统边框窗口的拖动区和窗口控制按钮是全局固定层；`SideSheet` / Drawer 必须使用 `src/shared/ui/overlayLayers.ts` 的共享层级，确保弹层标题、关闭按钮位于窗口标题层之上，不得在业务组件中临时堆叠 `z-index`；
* 提高 `SideSheet` / Modal 层级时必须同步检查 Toast：Semi 静态 Toast 默认层级可能低于自定义弹层，必须保持 `Toast > 二级 Modal > SideSheet > 窗口标题层`，并验证弹层内的成功、警告和错误提示未被遮挡；
* 页面组件不要无限膨胀；
* 复杂状态和动作优先抽成 Hook；
* 后端数据由领域 command 与 TanStack Query 读取，mutation 成功后只失效受影响的 query，不恢复全局 `refreshAll`；
* 页面和组件不得直接拼写 Tauri command 名称，必须通过 `src/domains` 到 `src/platform/tauri` 的类型化边界调用；
* 页面负责展示与有限交互；
* 不要在 render 期间触发 Tauri command；
* React Effect 必须考虑 StrictMode 重复执行；
* 异步操作必须有 loading 和 error 状态；
* 不要吞掉 Promise rejection；
* 不要用 `setTimeout` 掩盖数据一致性问题。

桌面窗口必须保持无系统边框模式。新壳负责：

* 提供覆盖有效空白区域的可拖动窗口区域；
* 提供可用的最小化、最大化/还原、关闭按钮组；
* 窗口控制按钮不得触发拖动；
* 关闭主窗口时隐藏到托盘，只有“退出 Flowlet”才停止代理并退出进程。

建议拆分：

```text
src/
  ├── app/          # Provider、Router、Shell
  ├── pages/        # 路由页面和页面状态组合
  ├── features/     # 用户动作与业务编排
  ├── domains/      # 领域类型、command、query、mutation
  ├── platform/     # Tauri 等运行平台边界
  ├── shared/       # 无业务含义的共享 UI 与工具
  └── styles/       # reset 与 Design Tokens
```

---

## 11. Rust 开发原则

* Tauri command 应保持职责单一；
* command 返回明确的 `Result<T, String>` 或结构化错误；
* 不要在 Rust 中重复前端页面状态逻辑；
* 代理共享配置必须支持运行时读取最新值；
* 启动、停止操作必须具备并发安全性；
* `start_proxy` 必须幂等；
* `stop_proxy` 在已停止状态下不应导致崩溃；
* 请求路由必须校验账号启用状态和 API Key；
* 不得因为无账号或无模型而阻止代理监听；
* 不得因单次请求失败导致代理进程退出；
* 新增代理行为应补充 Rust 测试。

---

## 12. 修改代码前的要求

修改前：

1. 先检查当前分支最新代码；
2. 不要根据旧对话或旧文件结构直接猜测；
3. 找到真实调用链；
4. 确认前端、Tauri command、代理核心和存储之间的职责；
5. 评估是否会影响热更新、日志、托盘和便携模式。

涉及代理时重点检查：

* `src/features/proxy-lifecycle/useProxyOverviewLifecycle.ts`
* `src/features/proxy-lifecycle/useProxyAutoStart.ts`
* `src/features/proxy-lifecycle/useProxyActions.ts`
* `src/domains/proxy/commands.ts`
* `src/features/proxy-lifecycle/ProxyStatusCard.tsx`
* `src/pages/overview/OverviewPage.tsx`
* `src/platform/tauri/client.ts`
* `src-tauri/src/lib.rs`
* `src-tauri/src/commands.rs`
* `src-tauri/src/core/proxy.rs`
* `src-tauri/src/core/proxy_http.rs`
* `src-tauri/src/core/proxy_routing.rs`

文件结构可能变化，以当前代码为准。

---

## 13. 修改完成后的要求

完成后必须：

1. 总结修改了哪些文件；
2. 解释关键状态和调用链；
3. 明确说明是否改变现有数据结构；
4. 说明哪些配置支持热更新，哪些需要重启；
5. 运行适用的检查：

   * 前端 typecheck；
   * 前端 build；
   * `cargo check`；
   * 相关 Rust tests；
6. 不得在未实际运行检查时声称全部通过；
7. 如有失败，列出真实错误和未完成项；
8. 不要为了通过检查删除有效测试或关闭类型检查。

---

## 14. config.json 维护

`config.json` 是 Flowlet 的渠道与运行时配置文件，位于项目根目录。

### 字段文档

完整的字段说明见 **`docs/config.md`**，包含：

- 每个字段的类型、默认值、是否必须；
- 运行时行为（热更新 vs 需重启）；
- 端点解析优先级；
- 新增渠道的完整步骤。

### 新增渠道

新增渠道或扩展渠道协议、余额、模型同步等能力前，**必须先阅读并按
`docs/channel-integration.md` 执行**。该文档以 LongCat、DeepSeek、Kimi 为参照，
覆盖官方能力核实、配置默认值、SQLite 升级迁移、Rust command、前端账号流程、
默认路由、品牌图标和回归测试。

不得只修改 `config.json` 或只让渠道出现在前端。必须验证从旧 SQLite 升级后，
渠道协议、账号、开放模型、`/models` 和真实代理候选链均一致。

### 修改 config.json 时必须同步文档

对 `config.json` 的任何字段变更（新增、删除、修改语义或默认值），**必须同步更新 `docs/config.md`**：

1. 字段新增 / 修改 / 删除时，更新 `docs/config.md` 对应章节的字段表和行为说明；
2. 新增渠道时，按 `docs/config.md` 第 8 节的步骤操作；
3. 若运行时行为（热更新 / 需重启）发生变化，同步更新第 7 节；
4. 若源码中反序列化结构（`channels_config.rs` / `config.rs`）发生变化，同步更新第 9 节；
5. **默认值同步**：修改 `channels_config.default_exposed_models` 时，必须同步 `src/domains/channel/types.ts` 中的 `DEFAULT_EXPOSED_MODELS_BY_CHANNEL`；修改 `channels_config.flowlet_tiers` 时，必须同步同文件中的 `FLOWLET_TIERS_BY_CHANNEL_MODEL`；修改 Rust 工厂默认值时同步 `src-tauri/src/core/config.rs`（详见 `docs/config.md`）。

### 加载优先级

- 外部 `config.json`（exe 旁）优先；
- 缺失或解析失败时，回退到编译时 `include_str!` 进二进制的默认副本；
- 首次启动不存在时，写入内置副本到磁盘。

因此修改仓库根目录 `config.json` 会同时影响「编译时默认值」和「便携版打包产物」。

涉及文件：

- `config.json` — 项目根目录
- `src-tauri/src/core/channels_config.rs` — JSON 反序列化与 `DEFAULT_CONFIG_JSON`
- `src-tauri/src/core/config.rs` — 运行时结构体
- `src-tauri/src/core/proxy.rs` / `proxy_http.rs` — 读写与热加载
- `src-tauri/src/lib.rs` — 启动时加载与回退
- `src-tauri/src/commands.rs` — `read_config` / `write_config` command
- `scripts/build-portable.mjs` — 便携版打包

---

## 15. 当前优先级

当前优先级依次为：

1. 渠道账号可用；
2. 开放模型可用；
3. 本地代理稳定；
4. Agent 接入体验；
5. 请求日志可排查；
6. 用量与成本准确；
7. Agent Session / Trace；
8. 高级路由和调度。

不要为了低优先级能力破坏当前核心链路。

---

## 16. 文档维护清单

项目核心文档各自的职责和更新时机：

| 文档 | 职责 | 何时必须更新 |
|------|------|-------------|
| `AGENTS.md` | AI Agent 协作规范 | 协作流程、优先级、架构原则变化时 |
| `docs/channel-integration.md` | 新增渠道的端到端接入流程和检查清单 | 新增渠道，或渠道接入架构、迁移、同步、路由流程变化时 |
| `docs/config.md` | `config.json` 字段与运行时行为说明 | 任何 `config.json` 字段变更时（见第 14 节） |
| `docs/architecture.md` | 总体架构与核心模型 | 架构分层、核心数据模型变化时 |
| `docs/roadmap.md` | 产品路线图 | 优先级或阶段目标调整时 |

修改代码前先检查对应文档是否仍然准确；若已过时，一并更新。
