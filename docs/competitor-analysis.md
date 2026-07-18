# Flowlet 竞品分析报告

## 一、竞品全景

| 竞品 | Stars | 技术栈 | 形态 | 核心定位 | 覆盖 AI 工具数 | 开源 |
|------|-------|--------|------|----------|----------------|------|
| **CC Switch** | 118k | Tauri 2 + React | 桌面端 (Win/Mac/Linux) | 供应商代理与配置管理 | 7 | ✅ MIT |
| **AIUsage** | 410 | SwiftUI | macOS 14+ 桌面端 | AI 订阅账号、Agent 代理与用量分析 | 4 条 Agent 代理，12+ Provider | ✅ Apache-2.0 |
| **TiyGate** | — | — | 桌面端 + 服务端 | 通用 AI 网关、模型路由与日志 | 多 | — |
| **claude-tap** | 2.5k | Python + Web | 本地代理 + Web 查看器 | Agent Trace 查看器 | 16+ | ✅ MIT |
| **CodeBurn** | 8.7k | TypeScript/npm | CLI + macOS 菜单栏 + GNOME + Web | Agent 用量/成本分析 | 32 | ✅ MIT |
| **CodexBar** | 18.3k | Swift | macOS 菜单栏 | Provider 额度与状态查看 | 59 | ✅ MIT |

> AIUsage 数据核对时间：2026-07-18。能力以 [AIUsage 官方仓库](https://github.com/sylearn/AIUsage) README 为准；Stars 等动态指标仅表示核对时快照。

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
| Pi | ❌ | ❌ | ❌ | ✅ | ❌ |
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
| 本地文件直读 | 📐 规划中 | ❌ | ✅ 会话日志/opencode.db | ❌ | ✅ 读取会话文件 |
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
