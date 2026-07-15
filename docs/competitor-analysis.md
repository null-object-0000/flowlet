# Flowlet 竞品分析报告

## 一、竞品全景

| 竞品 | Stars | 形态 | 核心定位 | 覆盖 AI 工具数 |
|------|-------|------|----------|----------------|
| **CC Switch** | 118k | Tauri 桌面端 (Win/Mac/Linux) | 供应商代理与配置管理 | 7 |
| **TiyGate** | — | 桌面端 + 服务端 | 通用 AI 网关、模型路由与日志 | 多 |
| **claude-tap** | — | 抓包工具 | Agent Trace 查看器 | 2 (Claude Code, Codex) |
| **CodeBurn** | 8.7k | CLI + macOS 菜单栏 + GNOME | Agent 用量/成本分析 | 32 |
| **CodexBar** | 18.3k | macOS 菜单栏 (Swift) | Provider 额度与状态查看 | 59 |

## 二、功能维度对比

### 2.1 渠道与账号管理

| 能力 | Flowlet | CC Switch | TiyGate | claude-tap | CodeBurn | CodexBar |
|------|---------|-----------|---------|------------|----------|----------|
| 多账号管理 | ✅ 渠道账号三层架构 | ✅ 多供应商 + 一键切换 | ✅ 多服务商接入 | ❌ | ❌ | ❌ |
| 渠道预设模板 | ✅ LongCat / DeepSeek 内置 | ✅ 50+ 预设 | — | ❌ | ❌ | ❌ |
| API Key 管理 | ✅ 加密存储 + 掩码展示 | ✅ | ✅ | ❌ | ❌ | ❌ |
| 账号优先级路由 | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| 格式转换 | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ |
| 故障转移 / 熔断 | ✅ 状态码 fallback | ✅ 熔断 + 健康监控 | ✅ 故障转移 | ❌ | ❌ | ❌ |
| MCP 管理 | ❌ | ✅ 统一面板 + 双向同步 | — | ❌ | ❌ | ❌ |
| Prompts / Skills 管理 | ❌ | ✅ Markdown 编辑器 + 跨应用同步 | — | ❌ | ❌ | ❌ |
| 云同步 | ❌ | ✅ Dropbox / OneDrive / iCloud / WebDAV | — | ❌ | ❌ | ❌ |

### 2.2 代理服务

| 能力 | Flowlet | CC Switch | TiyGate |
|------|---------|-----------|---------|
| 本地代理 | ✅ 127.0.0.1:18640 | ✅ 热切换 | ✅ |
| OpenAI 协议 | ✅ `/v1/*` `/openai/v1/*` | ✅ | ✅ |
| Anthropic 协议 | ✅ `/anthropic/v1/*` | ✅ | ✅ |
| 健康检查 | ✅ `/health` | ✅ | — |
| 客户端速率限制 | ✅ Token Bucket 600 req/min | — | — |
| 并发热更新 | ✅ 无需重启 | ✅ | — |
| CORS / Preflight | ✅ | — | — |

### 2.3 请求日志

| 能力 | Flowlet | CC Switch | TiyGate | claude-tap |
|------|---------|-----------|---------|------------|
| 请求列表 | ✅ metadata | ✅ 详细请求日志 | ✅ 完整请求/响应日志 | ✅ 真实 API 流量 |
| 详情查看 | ✅ 侧边栏 | — | — | ✅ System Prompt / 工具调用 / 流式响应 |
| Token Diff | ❌ | ❌ | ❌ | ✅ 请求 Diff |
| 结构化过滤 | ✅ 多维度筛选 | — | — | — |
| 导出 | ❌ | — | — | — |
| Body 捕获 | ✅ 配置可控 | — | — | ✅ |

### 2.4 用量与成本

| 能力 | Flowlet | CodeBurn | CodexBar | CC Switch |
|------|---------|----------|----------|-----------|
| 成本统计 | ✅ 按渠道/模型/日期 | ✅ 按工具/模型/项目/任务 | ❌ (仅额度) | ✅ |
| Token 统计 | ✅ | ✅ | ❌ | ✅ |
| 趋势图表 | ✅ SVG 折线图 | ✅ 日趋势 + 预测 | ✅ 历史图 | ✅ |
| 预估费用 | ✅ 基于本地价格表 | ✅ LiteLLM 价格 | ❌ | ✅ 自定义价格 |
| 数据完整度 | ✅ | ✅ | ❌ | — |
| 预算看护 | ❌ | ✅ 软/硬 cap + checkpoint | ❌ | ❌ |
| 模型对比 | ❌ | ✅ one-shot / retry / 效率 | ❌ | ❌ |
| Yield 分析 | ❌ | ✅ Productive / Reverted / Abandoned | ❌ | ❌ |
| 浪费扫描 | ❌ | ✅ 自动发现 + 一键修复 | ❌ | — |

### 2.5 Agent 接入

| 能力 | Flowlet | CC Switch | claude-tap |
|------|---------|-----------|------------|
| Claude Code | ✅ 配置向导 + 一键复制 | ✅ 完整管理 | ✅ 抓包 |
| OpenCode | ✅ 配置向导 | ✅ 完整管理 | ❌ |
| Codex | ✅ 配置卡片（Desktop 直读规划中） | ✅ 完整管理 | ✅ 抓包 |
| Gemini CLI | ❌ | ✅ 完整管理 | ❌ |
| Cursor | ❌ | ❌ | ❌ |
| Cline / Continue | ❌ | ❌ | ❌ |
| 本地文件直读 | 📐 规划中 (OpenCode Desktop) | ❌ (改配置文件) | ✅ 网络抓包 |
| 配置备份 | ❌ | ✅ 自动备份 + 回滚 | ❌ |
| 配置检测 | ❌ | ❌ | ✅ |

### 2.6 平台与运维

| 能力 | Flowlet | CC Switch | CodeBurn | CodexBar |
|------|---------|-----------|----------|----------|
| Windows | ✅ (Tauri) | ✅ | ✅ web | ❌ |
| macOS | ✅ (Tauri) | ✅ | ✅ menubar | ✅ (Swift) |
| Linux | ✅ (Tauri) | ✅ | ✅ GNOME | ❌ |
| 系统托盘 | ✅ | ✅ | — | ❌ |
| 开机自启动 | ✅ | ✅ | ❌ | ❌ |
| 国际化 | ✅ zh / en | ✅ zh / en / ja / de | ❌ | ✅ 21 语言 |
| Widget / 小组件 | ❌ | ❌ | ❌ | ✅ WidgetKit |
| 开源 | ❌ | ✅ MIT | ✅ MIT | ✅ MIT |

---

## 三、竞争态势评估

### Flowlet 的竞争优势

1. **前端优先的桌面体验**：React 19 + Semi Design + CSS Modules，桌面端交互体验优于绝大多数竞品
2. **多协议透明转发**：OpenAI + Anthropic 双入口，不做跨协议转换，保持协议原生意图
3. **渠道账号模型**：Channel / Account / Model 三层架构清晰，区别于 CC Switch 的"通用 Provider"模型
4. **桌面代理 + Agent 接入一体化**：以本地透明代理为核心，自然延伸到 Agent 配置向导
5. **配置热更新**：渠道、账号、路由无需重启即可生效

### Flowlet 的能力缺口

| 缺口 | 竞品参照 | 优先级 |
|------|----------|--------|
| MCP / Prompts / Skills 统一管理 | CC Switch | 高（Agent 接入差异化关键） |
| 配置写入其他 Agent | CC Switch | 高 |
| 请求日志 Body 级查看 / 导出 | claude-tap | 中 |
| 预算看守 + 模型对比 + 浪费扫描 | CodeBurn | 中 |
| Provider 状态监控 + 事件告警 | CodexBar | 低 |
| 云同步 | CC Switch | 低 |
| 格式转换（不支持的协议适配） | CC Switch / TiyGate | 低（Flowlet 当前策略不做跨协议转换） |

### 核心威胁

1. **CC Switch (118k ⭐)**：功能覆盖面最广，MCP/Prompts/Skills + 云同步 + 一键切换，社区活跃。Flowlet 的差异化应在 Agent 深度接入（直读本地文件 + Session/Trace 观测）上
2. **CodeBurn (8.7k ⭐)**：用量分析深度远超 Flowlet 当前能力（optimize / guard / compare / yield），但其不做代理也不做渠道管理，是垂直补充型竞品
3. **CodexBar (18.3k ⭐)**：在"轻量状态展示"维度验证了市场需求，Flowlet 的概览页已经覆盖了这个需求

---

## 四、建议方向

1. **坚持 Agent 接入差异化**：CC Switch 做"全"，Flowlet 做"深"。通过 OpenCode Desktop 本地直读、Session/Trace 观测、配置写入等能力形成差异化
2. **补齐 MCP/Prompts/Skills 管理**：Agent 接入不只是给 Base URL，而是统一管理 Agent 的全部配置
3. **深化用量分析**：吸收 CodeBurn 的 optimize / compare / yield 方法论，在代理层直接做智能分析
4. **请求日志增强**：Body 级查看 + Diff + 导出，向 claude-tap 的 Trace 能力靠拢
5. **不做的事**：跨协议转换、企业级多租户、权重调度（保持产品定位清晰）
