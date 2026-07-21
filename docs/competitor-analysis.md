# Flowlet 竞品分析报告

> 本文档由原 `competitor-analysis.md`、`competitor-deep-analysis.md`、`competitors.md` 于 2026-07-21 整合而成。
> Stars 等动态指标仅为核对时快照（AIUsage 数据核对时间：2026-07-18），功能对比可能随时间过时。

## 一、竞品全景

| 竞品 | Stars | 技术栈 | 形态 | 核心定位 | 覆盖 AI 工具数 | 开源 |
|------|-------|--------|------|----------|----------------|------|
| **CC Switch** | 118k | Tauri 2 + React | 桌面端 (Win/Mac/Linux) | 供应商代理与配置管理 | 7 | ✅ MIT |
| **AIUsage** | 410 | SwiftUI | macOS 14+ 桌面端 | AI 订阅账号、Agent 代理与用量分析 | 4 条 Agent 代理，12+ Provider | ✅ Apache-2.0 |
| **TiyGate** | — | — | 桌面端 + 服务端 | 通用 AI 网关、模型路由与日志 | 多 | — |
| **claude-tap** | 2.5k | Python + Web | 本地代理 + Web 查看器 | Agent Trace 查看器 | 16+ | ✅ MIT |
| **CodeBurn** | 8.7k | TypeScript/npm | CLI + macOS 菜单栏 + GNOME + Web | Agent 用量/成本分析 | 32 | ✅ MIT |
| **CodexBar** | 18.3k | Swift | macOS 菜单栏 | Provider 额度与状态查看 | 59 | ✅ MIT |

> AIUsage 能力以 [AIUsage 官方仓库](https://github.com/sylearn/AIUsage) README 为准。

---

## 二、功能维度对比（完整版）

### 2.1 渠道与账号管理

| 能力 | Flowlet | CC Switch | AIUsage | TiyGate | claude-tap | CodeBurn | CodexBar |
|------|---------|-----------|---------|---------|------------|----------|----------|
| 多账号管理 | ✅ Channel/Account/Model | ✅ 多供应商+一键切换 | ✅ 12+ Provider、多账号 | ✅ 多服务商接入 | ❌ | ❌ | ❌ |
| 渠道预设模板 | ✅ LongCat/DeepSeek/Kimi 内置 | ✅ 50+ 预设 | ✅ Provider 与模型库 | — | ❌ | ❌ | ❌ |
| API Key 管理 | ✅ 加密存储+掩码展示 | ✅ | ✅ macOS Keychain | ✅ | ❌ | ❌ | ❌ |
| 账号优先级路由 | ✅ | ✅ | — | ✅ | ❌ | ❌ | ❌ |
| 账号启用/禁用 | ✅ | ✅ | ✅ 账号/节点切换 | — | ❌ | ❌ | ❌ |
| 账号 base URL 覆盖 | ✅ per-account | — | ✅ per-node/provider | — | ❌ | ❌ | ❌ |
| 余额快照 | ✅ 手动+自动 | ❌ | ✅ 额度与订阅状态 | ❌ | ❌ | ❌ | ❌ |
| 连接状态检测 | ✅ credential_status | ✅ 健康监控 | ✅ 独立刷新 | ✅ | ❌ | ❌ | ❌ |
| 格式转换 | ❌ | ✅ | ✅ Claude→OpenAI 等 | ✅ | ❌ | ❌ | ❌ |
| 故障转移/熔断 | ✅ 状态码 fallback | ✅ 熔断+健康监控 | — | ✅ 故障转移 | ❌ | ❌ | ❌ |
| MCP 管理 | ❌ | ✅ 统一面板+双向同步 | ❌ 仅调用分析 | — | ❌ | ✅ MCP 工具 | ❌ |
| Prompts/Skills 管理 | ❌ | ✅ MD 编辑器+跨应用同步 | ❌ 仅 Skill 调用分析 | — | ❌ | ❌ | ❌ |
| 云同步 | ❌ | ✅ Dropbox/OneDrive/iCloud/WebDAV | ❌ | — | ❌ | ❌ | ❌ |
| 配置导入 | ✅ 配置/数据导入 | ✅ Deep Link | ✅ CC Switch Provider 导入 | — | ❌ | ❌ | ❌ |

### 2.2 代理服务

| 能力 | Flowlet | CC Switch | AIUsage | TiyGate | claude-tap |
|------|---------|-----------|---------|---------|------------|
| 本地代理 | ✅ :18640 | ✅ 热切换 | ✅ 四条独立代理+全局固定端点 | ✅ | ✅ 自动端口 |
| OpenAI 协议 | ✅ /v1/* + /openai/v1/* | ✅ | ✅ Chat/Responses | ✅ | ✅ 转发 |
| Anthropic 协议 | ✅ /anthropic/v1/* | ✅ | ✅ Messages/透传 | ✅ | ✅ 转发 |
| 不做跨协议转换 | ✅ | ❌（做转换） | ❌（做转换） | — | ✅ |
| 健康检查 | ✅ /health | ✅ | — | — | ❌ |
| 客户端速率限制 | ✅ Token Bucket 600/min | — | — | — | ❌ |
| 并发热更新 | ✅ 无需重启 | ✅ | ✅ 活跃节点热切换 | — | — |
| CORS / Preflight | ✅ | — | — | — | ✅ |
| 验证 auth header | ✅ bearer 或 x-api-key | — | ✅ CPA 管理密钥隔离 | — | — |
| 401 标记失效账号 | ✅ | — | — | — | — |
| SSE 透传 | ✅ TTFB/duration 捕获 | — | — | — | ✅ 低开销转发 |
| 代理模式 | — | — | ✅ 直连、代理、CPA sidecar | — | ✅ Reverse + Forward |
| LAN 访问 | ❌ | — | ✅ 可选，默认仅 loopback | — | — |
| 本地 CA | — | — | — | — | ✅ 用于 Forward 模式 |
| VS Code 集成 | — | — | — | — | ✅ claudeProcessWrapper |

### 2.3 请求日志与 Trace

| 能力 | Flowlet | CC Switch | AIUsage | TiyGate | claude-tap |
|------|---------|-----------|---------|---------|------------|
| 请求列表 | ✅ metadata | ✅ 详细请求日志 | ✅ 代理记录/本地会话账本 | ✅ 完整请求/响应 | ✅ 全量请求/响应/工具 |
| 详情查看 | ✅ 侧边栏 | — | ✅ 用量与调用分析 | — | ✅ 结构化展开 |
| 请求/响应 Body | ✅ 配置可控 | — | ✅ OpenCode 可选请求日志 | ✅ | ✅ 全量 |
| System Prompt 查看 | ❌ | — | ❌ | — | ✅ |
| 工具调用查看 | ❌（metadata 有） | — | ✅ MCP/Skill/Tool 次数 | — | ✅ 参数+结果 |
| 流式响应重建 | ❌ | — | ❌ | — | ✅ |
| 推理过程 (Thinking) | ❌ | — | ❌ | — | ✅ |
| 请求 Diff | ❌ | ❌ | ❌ | ❌ | ✅ 结构化+字符级高亮 |
| 路径过滤 | ❌ | — | — | — | ✅ /v1/messages 等 |
| 模型分组 | ❌ | — | ✅ per-model 趋势 | — | ✅ 侧边栏 |
| 全文搜索 | ❌ | — | — | — | ✅ 消息/工具/Prompt |
| 结构化过滤 | ✅ 多维度筛选 | — | ✅ 按来源/周期 | — | ❌ |
| Token 用量明细 | ✅ 从响应提取 | — | ✅ 代理档案+本地账本 | — | ✅ input/output/cache |
| 导出 | ❌ | — | — | — | ✅ 自包含 HTML + compact JSON |
| 实时查看器 | ❌ | ❌ | ❌ | ❌ | ✅ SSE 推送到浏览器 |
| 深色模式 | — | — | — | — | ✅ 跟随系统 |
| i18n | ✅ zh/en | — | — | — | ✅ 8 语言 |
| Iframe 嵌入 | — | — | ❌ | — | ✅ 隐藏头部/控件 |
| 键盘导航 | — | — | — | — | ✅ j/k |
| cURL 复制 | — | — | — | — | ✅ 一键复制 |
| 请求矩形校正 | ❌ | ✅ | ❌ | — | ❌ |

### 2.4 用量与成本

| 能力 | Flowlet | AIUsage | CodeBurn | CodexBar | CC Switch |
|------|---------|---------|----------|----------|-----------|
| 成本统计 | ✅ 按渠道/模型/日期 | ✅ 按来源/模型/周期 | ✅ 按工具/模型/项目/任务 | ❌（仅额度） | ✅ |
| Token 统计 | ✅ | ✅ | ✅ | ❌ | ✅ |
| 趋势图表 | ✅ SVG 折线图 | ✅ per-model/周期趋势 | ✅ 日趋势+预测 | ✅ 历史图 | ✅ |
| 预估费用 | ✅ 本地价格表 | ✅ per-model 定价 | ✅ LiteLLM 价格 | ❌ | ✅ 自定义价格 |
| 数据完整度 | ✅ | ✅ 区分代理/非代理来源 | ✅ | ❌ | — |
| 按项目分解 | ❌ | ❌ | ✅ | ❌ | — |
| 按任务类型分解 | ❌ | ❌ | ✅ 13 类 | ❌ | — |
| 按模型对比 | ❌ | ✅ per-model | ✅ one-shot/retry/效率 | ❌ | ❌ |
| 预算看护 | ❌ | ❌ | ✅ 软/硬 cap+checkpoint | ❌ | ❌ |
| Yield 分析 | ❌ | ❌ | ✅ Productive/Reverted/Abandoned | ❌ | ❌ |
| 浪费扫描 | ❌ | ✅ 零调用 Skill/MCP | ✅ 自动发现+一键修复 | ❌ | — |
| 设置节省vs实际 | ❌ | ❌ | ✅ 回测对比 | ❌ | — |
| 订阅追踪 | ❌ | ✅ 12+ Provider | ✅ Pro/Max 计划 | ✅ | — |
| 货币选择 | ❌ | ✅ USD/CNY 模型定价 | ✅ 162 种货币 | ❌ | — |
| 模型别名 | ❌ | ✅ 模型库/CPA 别名归一 | ✅ | — | — |
| 自定义价格 | ✅ | ✅ | ✅ | — | — |
| 本地模型节省计算 | ❌ | ❌ | ✅ | — | — |
| 跨设备合计 | ❌ | ❌ | ✅ PIN 配对 | — | — |
| CSV/JSON 导出 | ❌ | — | ✅ | ❌ | — |
| Forecast 预测 | ❌ | ❌ | ✅ | ✅ | — |
| Burn-down 燃尽图 | ❌ | ❌ | — | ✅ | — |
| Session/Weekly/Monthly | — | ✅ 自选周期 | ✅ | ✅ | — |
| 重置倒计时 | — | ✅ 配额状态 | — | ✅ | — |
| 剩余百分比 | — | ✅ 配额进度 | — | ✅ | — |
| On pace 节奏判断 | — | — | — | ✅ | — |
| Admin API 集成 | — | — | — | ✅ | — |

### 2.5 Agent 接入与管理

| 能力 | Flowlet | CC Switch | AIUsage | claude-tap | CodeBurn |
|------|---------|-----------|---------|------------|----------|
| Claude Code | ✅ 配置向导 | ✅ 完整管理 | ✅ 原生代理/配置写入 | ✅ | ✅ 用量追踪 |
| OpenCode | ✅ 配置向导 | ✅ 完整管理 | ✅ 原生代理/配置接管 | ✅ | ✅ 用量追踪 |
| Codex (CLI) | ✅ | ✅ 完整管理 | ✅ 原生代理/账号切换 | ✅ | ✅ 用量追踪 |
| Codex (Desktop) | 📐 直读规划 | ✅ | ❌ | ✅ 本地监听 | ✅ |
| Gemini CLI | ❌ | ✅ 完整管理 | ❌（CPA 可暴露 Gemini API） | ✅ | ✅ 用量追踪 |
| Claude Desktop | ❌ | ✅ | ❌ | ❌ | ✅ 用量追踪 |
| Claude Science | ❌ | ❌ | ✅ 本地虚拟登录与代理 | ❌ | ❌ |
| Cursor | ❌ | ❌ | ❌ | ✅ | ✅ 用量追踪 |
| Cursor CLI | ❌ | ❌ | ❌ | ✅ | ❌ |
| Cline | ❌ | ❌ | ❌ | ❌ | ✅ 用量追踪 |
| Continue | ❌ | ❌ | ❌ | ❌ | ✅ 用量追踪 |
| OpenClaw | ❌ | ✅ | ❌ | ✅ | ❌ |
| Hermes Agent | ❌ | ✅ | ❌ | ✅ | ❌ |
| Kimi / MiMo | ❌ | ❌ | ❌（仅订阅监控） | ✅ | — |
| Pi | ✅ 配置写入+会话读取 | ❌ | ❌ | ✅ | ❌ |
| Qoder CLI | ❌ | ❌ | ❌ | ✅ | ❌ |
| Antigravity CLI | ❌ | ❌ | ❌（仅订阅监控/CPA 账号） | ✅ | ❌ |
| CodeBuddy CLI | ❌ | ❌ | ❌ | ✅ | ❌ |
| Devin | — | — | ❌ | — | ✅ 用量追踪 |
| Copilot | — | — | ❌（仅订阅监控） | — | ✅ 用量追踪 |
| Roo Code | — | — | ❌ | — | ✅ 用量追踪 |
| Kiro | — | — | ❌（仅订阅监控） | — | ✅ 用量追踪 |
| 配置写入 Agent | ❌ | ✅ 各 Agent 直接写入 | ✅ Claude/Codex/OpenCode | ❌ | ❌ |
| 配置备份 | ❌ | ✅ 原子写入+自动备份 | ✅ 接管前保留原配置 | ❌ | ❌ |
| 配置回滚 | ❌ | ✅ act undo | ✅ 停用时恢复 | ❌ | ❌ |
| 本地文件直读 | ✅ Codex/Claude Code/OpenCode/Pi | ❌ | ✅ 会话日志/opencode.db | ❌ | ✅ 读取会话文件 |
| 一键切换 Provider | ❌（前端决策） | ✅ 托盘+主界面 | ✅ 菜单栏+主界面 | ❌ | ❌ |

### 2.6 Agent MCP / Prompts / Skills

| 能力 | Flowlet | CC Switch | AIUsage | claude-tap | CodeBurn |
|------|---------|-----------|---------|------------|----------|
| MCP 服务器管理 | ❌ | ✅ 统一面板 | ❌ 仅读取配置做调用分析 | ❌ | ✅ MCP 工具 |
| MCP 跨应用同步 | ❌ | ✅ 双向 | ❌ | ❌ | — |
| MCP Deep Link 导入 | ❌ | ✅ | ❌ | ❌ | — |
| Prompts 管理 (CLAUDE.md/AGENTS.md/GEMINI.md) | ❌ | ✅ MD 编辑器+跨应用同步+回填保护 | ❌ | ❌ | — |
| Skills 安装 | ❌ | ✅ GitHub/ZIP 一键安装 | ❌ 仅读取目录做调用分析 | ❌ | — |
| Skills 仓库管理 | ❌ | ✅ 自定义仓库 | ❌ | ❌ | — |
| MCP/Skill/Tool 调用分析 | 📐 Agent Session/Trace 方向 | — | ✅ 排名、趋势、零调用检测 | ✅ Trace 明细 | — |

### 2.7 Provider 状态监控

| 能力 | Flowlet | AIUsage | CodexBar | CodeBurn | CC Switch |
|------|---------|---------|----------|----------|-----------|
| Provider 状态轮询 | ❌ | ✅ 多账号独立刷新 | ✅ 事件徽章+图标叠加 | ❌ | ✅ 健康监控 |
| 故障事件展示 | ❌ | — | ✅ 菜单内徽章 | ❌ | — |
| 余额/额度查看 | ✅ 渠道余额快照 | ✅ 12+ Provider | ✅ 59 Provider | ❌ | ❌ |
| Session/Weekly/Monthly 窗口 | — | ✅ 周期分析 | ✅ | ✅ | — |
| 重置倒计时 | — | — | ✅ | ✅ | — |
| 费用趋势 | — | ✅ | ✅ | ✅ | — |
| 信用额度购买 | — | ❌ | ✅ | — | — |

### 2.8 平台与运维

| 能力 | Flowlet | CC Switch | AIUsage | CodeBurn | CodexBar | claude-tap |
|------|---------|-----------|---------|----------|----------|------------|
| Windows | ✅ Tauri | ✅ | ❌ | ✅ web | ❌ | ❌（Python CLI） |
| macOS | ✅ Tauri | ✅ | ✅ macOS 14+ | ✅ menubar | ✅ Swift 原生 | ✅ |
| Linux | ✅ Tauri | ✅ | ❌ | ✅ GNOME | ❌ | ✅ CLI |
| 系统托盘/菜单栏 | ✅ | ✅ | ✅ | — | ❌ | ❌ |
| 开机自启动 | ✅ | ✅ | — | ❌ | ❌ | ❌ |
| 国际化 | ✅ zh/en | ✅ zh/en/ja/de | — | ❌ | ✅ 21 语言 | ✅ 8 语言 |
| Widget/小组件 | ❌ | ❌ | ❌ | ❌ | ✅ WidgetKit | ❌ |
| 自动更新 | ❌ | ✅ | —（CPA sidecar 可独立更新/回滚） | — | ✅ Sparkle | ❌ |
| 原子写入 | — | ✅ | —（配置块合并/幂等接管） | — | — | — |
| 自动备份 | — | ✅ 保留 10 份 | ✅ OpenCode 原配置 | — | — | ✅ 保留 50 个 |
| 深色/浅色/系统主题 | ✅ | ✅ | ✅ SwiftUI | — | — | ✅ |
| i18n 语言数 | 2 | 4 | — | 0 | 21 | 8 |
| 开源 | ❌ | ✅ MIT | ✅ Apache-2.0 | ✅ MIT | ✅ MIT | ✅ MIT |
| 商业化 | — | ✅ Sponsor+合作 | ✅ Sponsor | ✅ Pro 付费 | ❌ 纯免费 | ❌ |
| 中央同步服务 | ❌ | ❌ | ❌ | ✅（预览） | ❌ | ❌ |

---

## 三、竞争态势评估

### Flowlet 的竞争优势

1. **前端优先的桌面体验**：React 19 + Semi Design + CSS Modules，桌面端交互体验优于绝大多数竞品
2. **多协议透明转发**：OpenAI + Anthropic 双入口，不做跨协议转换，保持协议原生语义
3. **渠道账号模型**：Channel / Account / Model 三层架构清晰，含余额快照、连接状态检测
4. **桌面代理 + Agent 接入一体化**：以本地透明代理为核心，自然延伸到 Agent 配置向导
5. **配置热更新**：渠道、账号、路由无需重启即可生效
6. **客户端级别速率限制 + CORS**：内置 Token Bucket + preflight 支持

### Flowlet 的能力缺口

| 缺口 | 竞品参照 | 优先级 | 说明 |
|------|----------|--------|------|
| MCP 统一管理 | CC Switch, CodeBurn | **高** | Agent 接入差异化的核心战场 |
| 配置写入 Agent | CC Switch, AIUsage | **高** | 竞品可合并、接管并恢复各 Agent 配置文件 |
| MCP/Skill/Tool 调用分析 | AIUsage | **高** | 本地 Session 数据可支撑排名、趋势和零调用检测 |
| 请求日志 Body 级查看 + Diff | claude-tap | **中** | 透明代理天然可做，只需"可选全量捕获" |
| 请求日志 Trace 查看器 | claude-tap | **中** | 结构化展开 + 实时查看 |
| 预算看护 + 浪费扫描 | CodeBurn | **中** | 代理层数据天然可做优化分析 |
| 模型对比 + Yield | CodeBurn | **中** | 需要 git + 代理层数据联动 |
| Provider 状态监控 | CodexBar | **低** | 竞品已有但非核心差异点 |
| 云同步 | CC Switch | **低** | 锦上添花能力 |
| 跨设备合计 | CodeBurn | **低** | 非核心场景 |
| 格式转换 | CC Switch, TiyGate | **低** | 与"不做跨协议转换"策略一致，不做 |

### 核心威胁

1. **CC Switch (118k ⭐)**：功能覆盖面最广，50+ 预设 + MCP 双向同步 + 配置直接写入 + 云同步。社区极其活跃。MCP + Skills + Prompts 统一管理是其核心壁垒
2. **AIUsage (410 ⭐)**：体量尚小，但主链路与 Flowlet 最接近。它已把多订阅账号、四条 Agent 代理、统一 Provider、配置写入、CPA 账号池、用量和 MCP/Skill/Tool 分析放进同一款产品；macOS-only 是当前边界，快速迭代和 128 个 Release 表明其产品推进速度值得持续跟踪
3. **CodeBurn (8.7k ⭐)**：用量分析深度远超 Flowlet 当前能力。覆盖 32 种工具 + LiteLLM 价格数据 + 浪费扫描 + 预算看护 + Yield 分析。不做代理也不做渠道管理，是"深度垂直"型竞品
4. **CodexBar (18.3k ⭐)**：在"轻量状态展示"维度验证了市场需求，59 Provider + Swift 原生体验。Flowlet 概览页已覆盖基础需求
5. **claude-tap (2.5k ⭐)**：请求/响应全量抓包 + 结构化 Diff + 实时查看器 + 16+ Agent。其"代理层即可观测"模式与 Flowlet 透明代理高度互补，但不做渠道/配置管理

---

## 四、建议方向

1. **坚持 Agent 接入差异化**：CC Switch 做配置生态的"全"，AIUsage 做订阅与代理聚合，Flowlet 做 Agent 运行链路的"深"（统一模型服务 + 本地 Session/Trace + 请求关联）
2. **补齐 MCP/Prompts/Skills 管理**：这是 CC Switch 的核心壁垒，也是 Agent 接入从"给配置"到"管配置"的升级
3. **把 Agent Session 转化为调用洞察**：参考 AIUsage 的 MCP/Skill/Tool 排名、趋势和零调用检测，但进一步关联代理请求、模型、成本与 Trace
4. **请求日志升级为 Trace 观看器**：透明代理天然能做"可选全量捕获" + 结构化 Diff + 直接对标 claude-tap 的观测能力
5. **用量分析深化**：代理层数据 + 本地分析，吸收 AIUsage 的多来源归因和 CodeBurn 的 optimize / compare / yield 方法论
6. **保持跨平台和协议边界优势**：AIUsage 当前仅支持 macOS 且依赖转换/sidecar；Flowlet 应持续验证 Windows/macOS/Linux 的一致体验，并坚持协议原生透传
7. **不做的事**：跨协议转换、企业级多租户、权重调度、云同步（保持产品定位清晰）

---

## 五、源码实现深潜

> 基于源码仓库的实际实现分析，非仅 README 描述。

### 5.1 CC Switch (118k ⭐)

#### 技术栈
- **前端**：React 18 + TypeScript + Vite + TanStack Query v5 + TailwindCSS 3.4 + shadcn/ui (Radix)
- **后端**：Tauri 2 + Rust，~100+ Rust 源文件
- **数据库**：SQLite，19+ 表，13 个版本迁移

#### 实际架构
```
Commands (36 files) → Services (30+ files) → Database DAO → SQLite
```

#### 核心实现深度

**1. 代理层（35+ Rust 文件）— 最复杂的部分**
- 基于 Axum 的 HTTP 服务器，手动 hyper accept loop，保留 header 大小写
- **真实格式转换**：OpenAI↔Anthropic↔Gemini 的 transform 代码 1000+ 行
  - OpenAI Chat Completions ↔ Anthropic Messages
  - OpenAI Responses API ↔ Anthropic Messages
  - Gemini Native ↔ Anthropic Messages
  - Codex Responses ↔ Anthropic（保留 tool context）
- **完整熔断器**：CLOSED/OPEN/HALF_OPEN 状态机 + half-open 探测
- **请求矫正器**：thinking budget 超限自动修改重试、thinking signature 移除重试
- **Media 清理**：纯文本模型自动替换图片块
- **JSON 规范化**：确定性请求哈希去重
- **Gemini  shadow state**：ThoughtSignature/tool call 跨请求重放
- **SSE 聚合回退**：嗅探未标记的 SSE body 并聚合为 JSON

**2. MCP 同步**
- 每个 Agent 独立适配器：`claude.rs`、`codex.rs`、`gemini.rs`、`hermes.rs`、`opencode.rs`
- 实现 `import_from_<app>()`、`sync_enabled_to_<app>()`、`sync_single_server_to_<app>()`
- 数据库存储 per-app 布尔启用标志
- **注意**：只是配置文件读写，不是运行时 MCP 代理

**3. 数据库迁移**
- 13 个版本迁移，带 savepoint 回滚
- v2→v3 skills 迁移会破坏旧安装记录，依赖文件系统扫描恢复

**4. 前端组件**
- `providers/`、`mcp/`、`prompts/`、`skills/`、`sessions/`、`proxy/`、`usage/` 等
- 使用 CodeMirror 编辑 Markdown prompts
- @dnd-kit 实现拖拽排序

#### 代码反映的局限
- **后端测试匮乏**：仅 `database/tests.rs`，无代理测试、无 MCP 同步测试
- **无 MCP 服务器运行时**：只做配置文件同步
- **无 Trace/Session 分析**：只有基础的会话浏览
- **推广驱动严重**：25+ API  Relay 赞助商

#### 关键发现
CC Switch 的核心不是"配置管理"，**其真正壁垒是代理层的格式转换 + 熔断 + 请求矫正**。35+ Rust 文件的代理实现是其最深的护城河。

### 5.2 claude-tap (2.5k ⭐)

#### 技术栈
- **后端**：Python 3.11+ (~15K LOC)，aiohttp + asyncio
- **前端**：纯原生 JS（无框架）(~5K LOC)，自包含 HTML 查看器
- **存储**：SQLite (WAL 模式)，schema version 4

#### 实际架构（35 个 Python 模块）

| 层级 | 模块 |
|------|------|
| CLI/入口 | `cli.py`、`cli_clients.py`、`cli_update.py` |
| 代理核心 | `proxy.py` (反向)、`forward_proxy.py` (CONNECT/MITM)、`ws_proxy.py` |
| 客户端适配 | `bedrock.py`、`codex_app_cdp.py`、`codex_app_transcript.py`、`cursor_transcript.py`、`global_inject.py` |
| Trace/存储 | `trace.py`、`trace_store.py`、`trace_log_handler.py`、`compact_trace.py` |
| 查看器/仪表盘 | `viewer.py`、`live.py`、`dashboard.py`、`shared_dashboard.py`、`export.py` |
| 加密/传输 | `certs.py` (CA + 逐主机证书)、`sse.py` (SSE 重组器) |
| macOS App | `macos_app.py`、`macos_bundle.py` |

#### 核心实现深度

**1. 代理架构 — 双模式**
- **Reverse 模式**：`aiohttp` 服务器，重写 `ANTHROPIC_BASE_URL` 到 localhost
  - 请求体解析 + 上游特殊适配（Bedrock `bedrock/` 前缀剥离、DeepSeek user_id 哈希、Vertex 路径检测）
  - SSE 流式管道 + `SSEReassembler` 重组完整响应
  - WebSocket 升级检测 + 路由到 `ws_proxy.py`
  - 路径白名单：仅允许已知 API 路径（`/v1/messages`、`/v1/chat/completions` 等）
- **Forward 模式**：原始 `asyncio.start_server` TCP 服务器
  - `CONNECT` 方法 HTTPS 隧道
  - **本地回环 TLS 终止**：启动临时 TLS 服务器，中继原始字节，读取明文 HTTP
  - `CertificateAuthority` 类生成逐主机证书，持久化 CA 在 `~/.claude-tap/ca.pem`
  - macOS keychain 信任（`security add-trusted-cert`，无需 sudo）

**2. SSE 重组器 — 完整流式协议重新实现**
- Anthropic：`message_start` → `content_block_start/delta/stop` → `message_delta` → `message_stop`
- OpenAI Responses API：`response.created` → `response.output_item.added/done` → `response.output_text.delta` → `response.completed`
- OpenAI Chat Completions：含 tool_calls 累积、reasoning_details (MiniMax)
- Gemini：`streamGenerateContent`（裸 `data:` 帧）
- AWS Bedrock：二进制 EventStream（base64 编码帧）

**3. Trace 存储**
- SQLite `~/.local/share/claude-tap/traces.sqlite3`
- 表：`sessions`、`records`、`proxy_logs`、`record_blobs`、`migration_state`
- 大字段（tools、messages）提取到 blob 存储 + 哈希引用去重
- 敏感 header 脱敏：`authorization`、`x-api-key`、`cookie`、`set-cookie` 等前缀截断

**4. Codex App CDP 监听**
- 连接 Codex App Chrome DevTools Protocol 端点 (`http://127.0.0.1:9238`)
- `/json/list` 评分函数选择最佳 CDP target
- 监听 WebSocket 帧：配对请求消息与响应事件
- `response.output_item.done` 合并到 `response.completed`（输出数组为空时的补偿）
- 自动重连（10 秒间隔）

**5. 自包含 HTML 查看器**
- 纯原生 JS（无框架），无外部依赖
- 模板注入：CSS + 11 JS 文件 + i18n JSON + 内联 trace 数据
- >50 记录时用"懒加载"模式：元数据侧边栏 + 原始 JSONL
- 防 `</script>` 闭合：转义 `</` 到 `<\/`
- 支持 iframe 嵌入模式（`embed=1`、`hideHeader=1` 等 query 参数）

**6. 测试覆盖（68 个测试文件）**
- 单元测试：SSE 重组、URL 构造、body 解析、header 过滤、blob 压缩、viewer 元数据提取、i18n 一致性、路径白名单、Bedrock 解码
- 启动测试：per-client 验证环境变量注入 + CA 信任 + 代理模式
- 浏览器测试：Playwright (`test_responses_browser.py`、`test_search_browser.py`、`test_nav_browser.py`)
- 快照/视觉测试：`test_verify_screenshots.py`、`test_check_screenshots.py`
- E2E：`tests/e2e/` 目录
- **覆盖率目标**：总计 65%，diff 80%

#### 代码反映的局限
- **Codex App CDP 是尽力而为**：需要特定版本暴露调试端点
- **Bedrock EventStream 重组**：正则 JSON 扫描的启发式解码器，可能失败
- **无 OAuth token 刷新拦截**：Forward 模式捕获 HTTPS 但不理解 OAuth flow
- **Cursor/Qoder/Antigravity 需要 OS 级 CA 信任**
- **WebSocket 帧重组可能丢数据**：客户端发送相同 key 不同值时

#### 关键发现
claude-tap 的核心不是"抓包"，**其真正壁垒是 SSE 重组器的多协议流式重新实现 + 本地 CA 的 MITM 代理 + 高质量的查看器**。代码质量高（68 测试文件），协议兼容性处理细致。

### 5.3 CodeBurn (8.7k ⭐)

#### 技术栈
- **主栈**：TypeScript (Node 22.13+)，Ink TUI
- **定价**：内置 LiteLLM 快照 + 在线获取（24h 缓存）
- **存储**：JSONL 会话文件读取（不走代理）

#### 实际架构
```
src/
├── providers/    (32+ provider 文件 + 解析器)
├── guard/        (hooks, settings, store, usage, flags, cli)
├── act/          (apply/undo 日志)
├── mcp/          (MCP stdio 服务器)
├── sharing/      (跨设备配对)
├── sync/         (团队遥测 - 预览)
├── data/         (内置 LiteLLM 快照 + 定价回退)
├── parser.ts     (~2000+ 行, 核心解析引擎)
├── optimize.ts   (~2500+ 行, 浪费检测)
├── models.ts     (~800+ 行, 定价引擎)
├── classifier.ts (~200 行, 任务分类)
└── 40+ 其他模块
```

#### 核心实现深度

**1. Parser 引擎 — 最精良的部分**
- **大 JSONL 行解析器**：>32KB 行用手摇流式 JSON 解析器，仅提取需要字段
- **Buffer 变体**：同一逻辑对 Buffer 输入复制（文件读取器超限时）
- **流式去重**：`dedupeStreamingMessageIds` 处理 Claude 流式
- **MCP 库存提取**：`extractMcpInventory` 跨所有 `deferred_tools_delta` 附件合并
- **紧凑条目**：用户文本 2000 字符、bash 命令 2000 字符、tool blocks 500 上限

**2. 定价引擎 — 多层回退**
1. 用户价格覆盖（精确/前缀/大小写不敏感）
2. 内置覆盖（Cursor house 模型）
3. 精确模型名匹配
4. 规范名（剥离前缀、日期、pin）
5. 别名解析（80+ 内置别名）
6. 前缀匹配（最长优先）
7. 大小写不敏感索引
8. 变体后缀剥离（`:thinking`、`-TEE`）
9. 回退数据（`pricing-fallback.json` from models.dev/OpenRouter）
- 内置 LiteLLM 快照编译进二进制（离线可用）
- Claude fast mode 1.6x 定价、Web search $0.01/请求
- 本地模型节省计算、代理路径归属

**3. Optimize 检测器 — 15 个独立检测器**

| 检测器 | 检测内容 | Token 估算 |
|--------|----------|------------|
| `build-folder-reads` | 读 node_modules/.git/dist 等 | 600 tokens/read |
| `redundant-rereads` | 跨会话重复读同文件 | 600 tokens/read |
| `read-edit-ratio` | 低读写比 | 基于健康 4:1 的差距 |
| `warmup-heavy` | 缓存创建开销 | 中位数 vs 基线 |
| `unused-mcp` | MCP 服务器零调用 | 400 tokens/tool |
| `mcp-low-coverage` | <20% tool 覆盖率 | 缓存感知 schema 成本 |
| `mcp-project-scope` | 项目中未使用的服务器 | 冷项目 schema 成本 |
| `retry-heavy-capabilities` | 技能和重试相关 | 50% 重试轮次 tokens |
| `low-worth-sessions` | 昂贵但无编辑/提交 | 完整会话 tokens |
| `context-heavy-sessions` | 输入/缓存淹没输出(>25:1) | 超出目标比例部分 |
| `cost-outliers` | >2× 项目平均成本 | 超出 2× 部分 |
| `claude-md-too-long` | CLAUDE.md 膨胀 | 13 tokens/行超阈值 |
| `bash-output-cap` | BASH_MAX_OUTPUT_LENGTH 未限制 | 从会话模式估算 |
| `unused-agents` | ghost agents 从未调用 | 80 tokens/agent |
| `unused-skills/commands` | ghost skills/commands | 80 tokens/skill |

- **Cache 感知 MCP schema 成本估算**：write 1.25×、read 0.1×
- 趋势追踪（active/improving/resolved）48h 窗口
- A-F 健康等级评分
- `--apply` 日志化备份 + undo 支持

**4. Guard 机制**
- Claude Code hook 协议实现：PreToolUse + Stop + SessionStart
- **Fail-open**：任何错误 → exit 0 空输出（破损 guard 不阻塞会话）
- 增量缓存：per-session 缓存文件追踪 cost、softWarned、sawEdit、sawGitCommit
- `codeburn guard allow` 每会话解除 hard cap
- **仅 Claude Code 可用**（hook 是 Claude Code 特性）

**5. Yield 分析**
- 时间戳关联 git commits：`[sessionStart, sessionEnd + 1 hour]`
- **Productive**：main 分支已有提交
- **Reverted**：≥50% main 提交后来被 revert
- **Abandoned**：无提交或提交未合并
- 通过 `git log --all --grep="^This reverts commit"` 检测

**6. 测试（100+ 测试文件）**
- Parser：15+ 测试文件（流式去重、大 JSON、Gemini 缓存、MCP 库存等）
- Optimize：~500 行 comprehensive test
- Guard、Pricing、Yield、Sync、MCP、Act/Undo、Security

#### 代码反映的局限
- **Optimize 是 Claude 中心**：`scanSessions` 硬编码 `'claude'`，非 Claude 用户只能得到有限检测
- **Guard 仅 Claude Code**：hook 机制不适用其他工具
- **Cursor 是估算**：README 诚实标注"undercount for long conversations"
- **Yield 是粗粒度时间戳关联**：无代码级归属，不处理 rebase/squash
- **分类器简单正则**：英文优先，无语义理解

#### 关键发现
CodeBurn 的核心不是"统计"，**其真正壁垒是 Parser 引擎的生产级鲁棒性 + 定价系统的多层回退 + 15 个检测器的工程方法论**。测试覆盖最全面（100+ 文件），README 对局限的坦诚度最高。

### 5.4 CodexBar (18.3k ⭐)

#### 技术栈
- **主栈**：Swift 98.7% (Swift 6.2+严格并发)，SwiftUI + WidgetKit
- **模块**：8 个 Swift 模块 + 1 个 C 模块 (CSQLite3)

#### 实际架构
```
Sources/
├── CodexBarCore          # 获取+解析引擎，59 provider 子目录
├── CodexBar              # App 状态+UI，200+ 文件
├── CodexBarWidget        # 6 种 WidgetKit 小组件
├── CodexBarCLI           # CLI 工具 (scripts/CI)
├── CodexBarClaudeWatchdog # Claude PTY 辅助进程
├── CodexBarClaudeWebProbe # Claude web 诊断 CLI
├── AdaptiveRefreshCore   # 纯策略刷新调度函数
└── AdaptiveReplayKit     # 测试/调试响应重放基础设施
```

#### 核心实现深度

**1. Provider 获取策略 — 5 族分类**
- **API Token** (~25)：OpenAI、Claude Admin、ElevenLabs、DeepSeek、OpenRouter、LiteLLM 等
- **Browser Cookies / Web Scrape** (~20)：Cursor、OpenCode、Manus、Kimi、Mistral 等
- **CLI** (~8)：Codex (RPC+PTY)、Claude (PTY)、Grok、Kiro、Gemini 等
- **OAuth** (~4)：Codex、Claude、Copilot、Vertex AI
- **Local Probe** (~4)：JetBrains AI、Zed、Bedrock、Windsurf SQLite

**2. Codex Provider 三级回退链**
1. **OAuth API**（首选）：读 `~/.codex/auth.json`，8 天 TTL 刷新，`GET /wham/usage` → session/weekly 窗口 + model-specific 窗口
2. **CLI RPC**：`codex -s read-only -a untrusted app-server`，JSON-RPC over stdin/stdout：`initialize`、`account/read`、`account/rateLimits/read`，有界初始化超时
3. **OpenAI Web Dashboard**（opt-in, 默认关）：隐藏 `WKWebView` 加载 chatgpt.com，解析 Recharts 数据 + 购买链接

**3. Claude Provider 三级回退链**
1. OAuth API → 2. CLI PTY (`claude --allowed-tools ""`，发送 `/usage`，解析 ANSI 输出) → 3. Web API
- 独立 watchdog 进程 (`CodexBarClaudeWatchdog`) 稳定 PTY 会话

**4. 本地成本扫描（最复杂的子系统）**
- **Codex**：扫 `~/.codex/sessions/YYYY/MM/DD/*.jsonl`，解析 `event_msg` token_count + `turn_context` 模型标记
- **Claude**：扫 `~/.claude/projects/**`，解析 `type: "assistant"` 行的 `message.usage`
- **模型定价**：从 `models.dev` API 获取，计算 USD 成本
- **去重**：Claude streaming chunks 按 `message.id + requestId` 去重
- **Bedrock Cost Explorer** + **Vertex AI Cloud Monitoring** 集成

**5. WidgetKit — 6 种小组件**
- Switcher、Usage、History、Metric、BurnDown、CombinedBurnDown
- 共享 `WidgetSnapshotStore` 写入 App Group 容器
- **仅 12/59 Provider 可选**（Codex、Claude、Cursor、Gemini、Alibaba 等）
- Burn-down 仅 Codex 和 Claude

**6. 自适应刷新**
- `AdaptiveRefreshCore` 纯策略函数
- Low Power Mode + 热状态感知（降频）
- 可配置 manual/1m/2m/5m/15m

**7. 状态轮询**
- **仅 5/59 Provider** 有状态轮询（OpenAI、Claude、Cursor、Factory、Copilot via Statuspage.io API）
- 其余 54 个为静态链接或无状态

**8. 测试（150+ 测试文件）**
- 深度：`ClaudeOAuth*`、`Codex*`、`Bedrock*`、`Cursor*`、`Gemini*`
- 自适应刷新：`AdaptiveRefreshPolicy*`、`AdaptiveRefreshHeuristics*`
- 基础设施：`MemoryPressure*`、`MainThreadHangWatchdog*`
- 性能回归：`BatteryDrainDiagnostic*`、`OverviewScrollStutterInvestigation*`
- 回放测试：`AdaptiveReplayKit` 可捕获/回放 provider 响应

#### 代码反映的局限
- **长尾 Provider 脆弱**：大多数是单路径 cookie scraper，目标网站改版即失效
- **Widget 覆盖低**：仅 12/59 可选
- **状态轮询覆盖极低**：仅 5/59
- **成本扫描仅 4 个 Provider**：Codex、Claude、Vertex AI、Bedrock
- **SwiftUI 严格并发债务**：大量 `MainActor` 标注和 `Sendable` 约束
- **AI 生成代码占比高**：".agents/skills/" 目录暗示大量 PR 由 AI 驱动

#### 关键发现
CodexBar 的核心不是"菜单栏"，**其真正壁垒是 59 Provider 的多策略获取引擎 + Codex/Claude 的三级回退链 + 本地成本扫描的精确实现**。Swift 原生体验是差异化，但长尾 Provider 质量堪忧。

---

## 六、代码质量综合对比

| 维度 | Flowlet | CC Switch | claude-tap | CodeBurn | CodexBar |
|------|---------|-----------|------------|----------|----------|
| 后端语言 | Rust | Rust | Python | TypeScript | Swift |
| 前端方案 | React 19 + Semi | React 18 + shadcn | 原生 JS | Ink TUI | SwiftUI |
| 后端 ~文件数 | 50-70 | 100+ | 35 模块 | 40+ 模块 | 200+ |
| 数据库 | SQLite | SQLite 19+表 | SQLite WAL | 无 (读文件) | 无 |
| 迁移版本 | — | 13 | schema v4 | — | — |
| 后端测试 | 有 | 仅 DB | 68 测试文件 | 100+ 测试文件 | 150+ |
| 协议处理 | 透传 | 格式转换 | 透传+重组 | 无(读文件) | 无(读API) |
| 文档质量 | 架构优先 | 用户手册+路由指南 | 支持矩阵+集成指南 | 详尽 providers 文档 | 全面 docs/ |

### 各竞品真正的技术壁垒

| 竞品 | 真正壁垒 | 表面定位 |
|------|----------|----------|
| **CC Switch** | 35+ Rust 文件的代理层（格式转换+熔断+矫正器） | "配置管理工具" |
| **claude-tap** | SSE 多协议重组器 + 本地 CA MITM + 高质量查看器 | "抓包工具" |
| **CodeBurn** | Parser 生产级鲁棒性 + 定价多层回退 + 15 检测器方法论 | "用量分析" |
| **CodexBar** | 59 Provider 多策略获取 + 三级回退链 + 本地成本扫描 | "菜单栏工具" |

---

## 七、源码视角的战略启示

### 1. CC Switch 证明了"代理层复杂度"可以成为壁垒
CC Switch 的 35+ Rust 文件代理实现是其最深护城河。Flowlet 如果坚持"不做跨协议转换"，就需要在**代理层的可观测性**和**Agent 接口深度**上建立等价壁垒。

### 2. claude-tap 证明了"Trace 查看器"有独立价值
claude-tap 的 68 个测试文件 + 高质量查看器 + SSE 重组器，说明"让开发者看到 Agent 真实行为"是一个独立的、可防守的产品方向。Flowlet 的透明代理 + 可选全量捕获可以自然延伸到这个方向。

### 3. CodeBurn 证明了"用量分析深度"远未饱和
15 个检测器 + 多层定价回退 + Guard 机制，说明"告诉用户怎么省钱"有大量可探索空间。但要注意：**Optimize 本质是 Claude 中心**。Flowlet 如果做用量分析，需要支持多 Agent 数据来源。

### 4. CodexBar 证明了"轻量状态展示"的天花板
18.3k stars 说明有大量用户只需要"看到余额"。但 CodexBar 的后端复杂度（59 Provider × 多策略）也证明了这不是一门轻松的生意。Flowlet 的概览页已经覆盖了核心需求。

### 5. Flowlet 的差异化定位应是"代理 + 可观测性 + Agent 直读"
- **不做 CC Switch 的全**（格式转换、7 工具），做**深**（本地直读、WAL 监听、Trace Diff）
- **不做 CodeBurn 的广**（32 工具），做**代理层实时**（请求即分析，非事后回溯）
- **不做 CodexBar 的多**（59 Provider），做**Agent 原生**（与 Agent 本地数据深度集成）
- **吸收 claude-tap 的观测力**：可选全量捕获 + 结构化 Diff + 实时查看器
