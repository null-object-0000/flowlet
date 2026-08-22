# models-cn 接入规则

本文档定义 Flowlet 接入 [models-cn](https://github.com/null-object-0000/models-cn) 官方价格与模型信息的规则。所有涉及模型基础信息、定价、费用估算的代码必须遵守本文件。

## 1. 数据源与优先级

| 范围 | 数据源 | 用途 |
|------|--------|------|
| 国内模型 | `models-cn/api.json` 的 `providers[].models[].prices[]` | 中国大陆模型厂商官方价格与模型信息 |
| 国际模型 | `models.dev/api.json`（本地落盘为 `models-dev.json`） | OpenAI 等国际厂商官方价格，仅 Rust 侧用于成本估算（如 Codex 会话的 `openai-api` USD 等价） |
| 补全 | `models-cn/api.json` 的 `calibration.modelsDev` | models-cn 官方字段缺失时的唯一允许补全来源 |

**注意**：`config.json` 的 `model_prices` 不再是主要价格来源，仅补充两份目录未覆盖的
`(channel_id, upstream_model)`（如自定义渠道显式价格）；与目录冲突时以目录为准。
国内模型价格来自 models-cn，国际模型价格来自 models.dev，成本估算使用合并后的价格表。

### 字段缺失补全规则

- 官方字段（models-cn）**存在**时，必须使用官方值，不得以任何其它来源覆盖。
- 官方字段**缺失**（`null` / 字段不存在 / 数组为空）时，允许使用 `models.dev`（`calibration.modelsDev`）补全。
- 使用 `models.dev` 补全时，**必须保留参考来源**：`source_url` 指向 `models.dev` 对应模型页，`price_version` 标注 `"models.dev"` 字样与 `referenceUrl`。
- **禁止使用汇率**把美元官方价换算为人民币「官方价」。人民币价必须直接来自 `market = "china"` + `currency = "CNY"` 的条目。

## 2. 价格选取规则

每条模型在 models-cn 中可能有多个 `prices[]` 条目（`market` × `currency` × `rateType` 组合）。选取规则：

1. **首选** `market = "china"` + `currency = "CNY"` + `rateType = "promotional"`：促销价是厂商当前实际生效价（需在 UI 标注「优惠价」）。
2. 若无促销价，取 `market = "china"` + `currency = "CNY"` + `rateType = "standard"`。
3. 若中国大陆官方价完全缺失，才可回退到 `market = "international"` 条目，并明确标注币种（如 USD）。
4. 同一模型若同时存在标准价与促销价，促销价作为当前价展示与计价，标准价仅在确有降价时作为划线原价辅助展示。

## 3. 缓存命中价格

`prices[].input` 是一个对象，可能包含：

- `standard`：常规输入价（必须存在）
- `cacheHit`：缓存命中价（**可选**）
- `explicitCacheCreation`：显式缓存写入价（可选）
- `explicitCacheHit`：显式缓存命中价（可选）

规则：

- **仅在 `input.cacheHit` 字段存在时**，才处理缓存命中价格。
- 若 `input.cacheHit` 不存在，视该模型**无官方缓存价**，不得用 `standard` 或其它字段伪造。
- 缓存写入价（`explicitCacheCreation`）仅在字段存在且用户场景涉及显式缓存写入时才使用。

## 4. 币种、市场、优惠价展示

- 币种直接展示 `currency` 字段（CNY / USD），不自动换算。
- 市场价（`market = "china"`）优先于国际价。
- 优惠价（`rateType = "promotional"`）需明确标注，不得伪装为标准价。
- 只有 `rateType = "promotional"` 且同维度标准价确实高于当前价时才展示划线原价；
  输入、缓存命中、缓存写入和输出价格分别判断，相等时不得划线。
- 所有价格展示必须附带来源（`source_url`）与抓取时间（`retrievedAt` / `price_version`）。
- `retrievedAt` 是 UTC 时间点，界面展示时必须转换为操作系统本地时区。

## 5. 可测试性要求

- 价格选取、费用估算、模型解析必须实现为**纯函数**（无副作用、无网络请求、无 `Date.now()`），并配套 Vitest 单元测试。
- 网络请求（fetch models-cn）必须与纯逻辑分离，通过注入或 Query 层 mock。
- 纯函数签名必须覆盖：正常路径、字段缺失、多市场价、优惠价、缓存价存在/不存在。

## 6. 前端接入方式

- **后台定时任务拉取**：Rust 后端启动后 1 小时触发第一次同步，之后每 1 小时顺序拉取 `https://null-object-0000.github.io/models-cn/api.json` 与 `https://models.dev/api.json`，分别保存为 exe 旁 `models-cn.json` / `models-dev.json` 文件（**不是 SQLite 表**）。每次同步独立写入 `background_jobs` 任务日志，并在任一同步成功后用两份目录 + `config.json` 的 `model_prices` 重建运行时价格表。
- **前端只读本地**：前端通过 `get_models_cn_catalog` 命令读取本地最新 models-cn 目录，不发起远程请求。本地无数据时，不展示 models-cn 相关内容（价格信息 Tab 展示空状态 + 「立即同步」按钮）。模型服务还会通过 `get_models_dev_provider_catalog("openrouter")` 只读取 models.dev 的 OpenRouter provider 子目录，避免把完整大文件经 IPC 传给前端；OpenRouter 模型规格按 `models-cn → models.dev` 回退，两份目录都未收录时不展示推测规格。
- **手动同步**：用户可点击「立即同步」按钮，前端并发触发 `sync_models_cn_catalog` + `sync_models_dev_catalog` 两个命令；单个源失败不影响另一个。
- **内容去重**：同步前计算 SHA-256 hash，与本地最新数据比较，内容未变化则跳过保存（返回 `skipped: true`）。
- 解析后建立 `(providerId, modelId)` → 模型详情 + 官方价格的索引。

## 7. 直接渠道模型详情 Tab 结构

直接渠道模型（`kind === "direct"`）的详情使用 Tab 隔离三个板块：

| Tab | 内容 | 数据来源 |
|-----|------|----------|
| 基础信息 | 上下文窗口、最大输出、输入/输出模态、能力（thinking/toolCalls 等）、别名 | models-cn `limits` + `capabilities`，缺失降级到渠道同步 |
| 价格信息 | 官方完整价格策略（按输入区间合并标准价与促销价）、隐式缓存、显式缓存创建/命中、输出价、来源、抓取时间 | models-cn `prices[]` |
| 渠道路由 | 已有路由账号、优先级、启用状态 | 本项目路由配置（不变） |

聚合模型（`flowlet-pro` / `flowlet-flash`）保持原有「渠道路由」面板，不强制 Tab。

## 8. 禁止事项

- 禁止硬编码任何模型价格。
- 禁止用汇率把美元价换算为人民币「官方价」。
- 禁止在 `input.cacheHit` 不存在时展示缓存命中价。
- 禁止用 models.dev 值覆盖 models-cn 官方值。
- 禁止在纯函数中发起网络请求或读取全局时钟。
