# models-cn 接入规则

本文档定义 Flowlet 接入 [models-cn](https://github.com/null-object-0000/models-cn) 官方价格与模型信息的规则。所有涉及模型基础信息、定价、费用估算的代码必须遵守本文件。

## 1. 数据源与优先级

| 优先级 | 数据源 | 用途 |
|--------|--------|------|
| 1（唯一） | `models-cn/api.json` 的 `providers[].models[].prices[]` | 中国大陆模型厂商官方价格与模型信息 |
| 2 | `models-cn/api.json` 的 `calibration.modelsDev` | 官方字段缺失时的唯一允许补全来源 |

**注意**：`config.json` 的 `model_prices` 已移除。价格数据完全来自 models-cn，成本估算也使用 models-cn 数据。

### 字段缺失补全规则

- 官方字段（models-cn）**存在**时，必须使用官方值，不得以任何其它来源覆盖。
- 官方字段**缺失**（`null` / 字段不存在 / 数组为空）时，允许使用 `models.dev`（`calibration.modelsDev`）补全。
- 使用 `models.dev` 补全时，**必须保留参考来源**：`source_url` 指向 `models.dev` 对应模型页，`price_version` 标注 `"models.dev"` 字样与 `referenceUrl`。
- **禁止使用汇率**把美元官方价换算为人民币「官方价」。人民币价必须直接来自 `market = "china"` + `currency = "CNY"` 的条目。

## 2. 价格选取规则

每条模型在 models-cn 中可能有多个 `prices[]` 条目（`market` × `currency` × `rateType` 组合）。选取规则：

1. **首选** `market = "china"` + `currency = "CNY"` + `rateType = "standard"`。
2. 若无标准价，取 `market = "china"` + `currency = "CNY"` + `rateType = "promotional"`（需在 UI 标注「优惠价」）。
3. 若中国大陆官方价完全缺失，才可回退到 `market = "international"` 条目，并明确标注币种（如 USD）。
4. 同一模型若同时存在标准价与优惠价，默认展示标准价，优惠价作为辅助信息展示。

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
- 所有价格展示必须附带来源（`source_url`）与抓取时间（`retrievedAt` / `price_version`）。

## 5. 可测试性要求

- 价格选取、费用估算、模型解析必须实现为**纯函数**（无副作用、无网络请求、无 `Date.now()`），并配套 Vitest 单元测试。
- 网络请求（fetch models-cn）必须与纯逻辑分离，通过注入或 Query 层 mock。
- 纯函数签名必须覆盖：正常路径、字段缺失、多市场价、优惠价、缓存价存在/不存在。

## 6. 前端接入方式

- **后台定时任务拉取**：Rust 后端启动后 1 小时触发第一次同步，之后每 1 小时自动拉取 `https://null-object-0000.github.io/models-cn/api.json`，保存到本地 SQLite `models_cn_catalog` 表。每次同步写入 `background_jobs` 任务日志。
- **前端只读本地**：前端通过 `get_models_cn_catalog` 命令读取本地最新目录，不发起远程请求。本地无数据时，不展示 models-cn 相关内容（基础信息 Tab 仅展示渠道同步数据，价格信息 Tab 展示空状态 + 「立即同步」按钮）。
- **手动同步**：用户可点击「立即同步」按钮触发 `sync_models_cn_catalog` 命令，结果写入任务日志。
- **内容去重**：同步前计算 SHA-256 hash，与本地最新数据比较，内容未变化则跳过保存（返回 `skipped: true`）。
- 解析后建立 `(providerId, modelId)` → 模型详情 + 官方价格的索引。
- 模型服务页「基础信息」与「价格信息」Tab 优先展示 models-cn 数据；`config.json` 的 `model_prices` 仅作为展示降级。

## 7. 直接渠道模型详情 Tab 结构

直接渠道模型（`kind === "direct"`）的详情使用 Tab 隔离三个板块：

| Tab | 内容 | 数据来源 |
|-----|------|----------|
| 基础信息 | 上下文窗口、最大输出、能力（thinking/toolCalls 等）、别名 | models-cn `limits` + `capabilities`，缺失降级到渠道同步 |
| 价格信息 | 官方价格（按上述规则选取）、缓存价、来源、抓取时间 | models-cn `prices[]`，缺失降级到 `config.json` |
| 渠道路由 | 已有路由账号、优先级、启用状态 | 本项目路由配置（不变） |

聚合模型（`flowlet-pro` / `flowlet-flash`）保持原有「渠道路由」面板，不强制 Tab。

## 8. 禁止事项

- 禁止硬编码任何模型价格。
- 禁止用汇率把美元价换算为人民币「官方价」。
- 禁止在 `input.cacheHit` 不存在时展示缓存命中价。
- 禁止用 models.dev 值覆盖 models-cn 官方值。
- 禁止在纯函数中发起网络请求或读取全局时钟。
