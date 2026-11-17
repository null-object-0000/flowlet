# 2026-11-17 发布合并完整性审计

本轮审计结论：**审计时还有 2 项接入/运行时代码未完整合回、2 项工程改动未合回；另外有 2 处线上默认推荐配置较旧。**
A1–A4 已在审计后全部回填 main，并随 `flowlet:node-20261117-parity-a1a4-98f2577` 完成生产发布（2026-11-17 15:18）；只剩架构分叉决策。
HY4 与决策模型的恢复不代表整个历史分支已经合齐。

本报告固定证据版本，避免把并发开发误认成历史发布丢失。审计轮次只审计并增加可重复执行的审计工具；A1–A4 的回填在审计之后单独完成，均未发布或重启生产、未改账号/路由。

## 审计范围与版本

- 起点源码：`9336f96`，包含 HY4 和决策模型恢复。
- 终点源码：`6f910f9`。审计过程中新增 ACP 图片透传与修复，已单独追踪至发布完成。
- 最终生产：`flowlet:node-20261117-acp-images-6f910f9`，镜像 ID `sha256:078d44377b56b7fe23280b8adab989af03aa5744c0313eca13b98765ec87f151`。起点决策模型恢复镜像与本次终点镜像均保存了只读快照。
- 生产镜像由部署脚本以「当前运行镜像 + 覆盖改动文件」的 overlay 链构建；tag `6f910f9` 是发布标签，不代表容器内 `/app` 等于该提交。实测 `/app` 含 `packages/flowlet-core/src/catalog/sources.ts` 等 `6f910f9` 中不存在的文件（即 A1/A2 的线上实现）。A1/A2 回填后（`3f316a2`、`29c522b`），运行时代码已与 `/app` 对齐；内置 `config.json` 的两项默认推荐差异也已随 15:18 的发布补齐。
- 已 fetch origin；核对全部现存本地分支和远端跟踪分支，共 **21 个去重后的分支独有非 merge 提交**。
- 从运行容器取得 `/app` 内的业务源码、内置配置、插件/模型登记与实际静态资源；未读取或导出 `/data` 中的凭据。
- 比较 **128 个 Node 业务模块**（回填 `catalog/sources.ts` 后为 129）：保留类型的 AST 比较用来识别纯注释差异，TS 去类型转译比较用来识别实际执行差异；不凭提交祖先关系判断功能缺失。
- 核对模型身份、渠道协议、插件声明、Node 包依赖，以及线上 CLI 下载包内的 **19 个运行源文件**（另核对 Host 复用的 2 个 CLI 源文件）。
- 起点与终点均核对 **66 个静态/下载产物**，分别与对应版本构建一致；生产保留了旧 hash 资源，另追踪当前 index 的 39 个 JS/CSS 依赖，避免把旧文件里出现的功能字符串当成正在使用的功能。

## 尚未完整合回的内容

| 编号 | 内容 | 已确认状态与影响 | 来源与证据 |
| --- | --- | --- | --- |
| A1 | models-cn 主站优先与双源容灾 | **已回填（`29c522b`）**。审计时线上后端已有主站/镜像回退，本地 main 缺失；Electron、构建预取和前端手动同步仍走旧 GitHub 地址。回填后按 HEAD 重建不再丢容灾。 | `8c2a586`；已补 `packages/flowlet-core/src/catalog/sources.ts`（含契约测试）、`src/domains/modelCatalog/sources.ts`，并改回 scheduler、web command、ModelServicesPage、fetch 脚本。 |
| A2 | 桌面维护命令接受 `systemone` | **已回填（`3f316a2`）**。审计时 Node 桌面参数校验只接受三种旧协议，含决策协议的渠道预设保存、配置导入、路由规则保存均会被拒；Web Host 不受影响。回填后转译代码与线上 `maintenance.ts` 完全一致。 | `8c2a586`；`packages/flowlet-core/src/desktop/maintenance.ts` 的 `PROTOCOL_VARIANTS` 漏项。回填前已用临时真实 SQLite 上下文逐一复现三个命令返回 400。 |
| A3 | 官网 EdgeOne 自动发布流程与部署 SDK 依赖修补 | **已回填（`7b193cd`）**。审计时只在远端 main / 官网分支，本地 main 缺 workflow 与部署工具，官网说明仍是 Cloudflare Pages；不影响 20134 管理台。回填采用最终状态：固定 `minimatch 11.0.1`，不恢复临时 DNS 验证文件。 | `b74899a`、`6a93c7b`：已补 workflow、`scripts/edgeone/`、`website/public/edgeone.json` 与官网说明。`website:check`、`website:build` 通过。 |
| A4 | Windows CLI SIGINT 回归与测试发现命令 | **已回填（`fbf0846`）**。审计时缺的是测试覆盖，不是 CLI 取消/中断运行逻辑；`child.kill("SIGINT")` 在 Windows 是强杀，无法验证正常清理。回填后 `cred:test` 改为显式 glob，测试驱动不进入分发包。 | `b611a83`：已补 test-only `signal-cli.ts`、测试改写和 glob；`npm run cred:test` 171 项通过，`cred:typecheck` 通过。 |

### A2 的复现结果（回填前）

对临时数据库调用真实桌面命令分发器，没有修改生产配置：

```text
save_channel_presets -> 400 参数 presets: unknown variant `systemone`
save_route_rules     -> 400 参数 rules: unknown variant `systemone`
import_config        -> 400 参数 channels: unknown variant `systemone`
```

三者来自同一个协议校验名单，不应拆成三个独立功能计数。

### 配置漂移，不能误报成模型不支持

线上内置 `config.json` 的默认推荐列表缺少：

- `default_exposed_models.kimi` 中的 `kimi-k3.1-pro`；
- `default_exposed_models.qwen` 中的 `qwen4-max`。

本地配置已有这两个推荐值。**双方模型目录的 34 个身份完全相同**，这两个模型的白名单支持没有丢；用户从实际上游列表显式选择模型的规则没有改变。同步默认推荐不应改写用户的账号选择或路由。

## 已确认没有遗漏的内容

| 内容 | 判定证据 |
| --- | --- |
| HY4、hy4-flash、decision-model-preview | 双方模型目录、插件登记完全一致；已恢复的联合模型管理/Agent 隔离回归通过。 |
| 通用 AK/SK、既有服务凭据、用户访问策略、A2A/ACP 既有能力、请求转发/存储/用量 | 在起点和终点 128 个模块的全量对照中，除 A1/A2 对应 3 个模块外，21 个文件字节相同、103 个仅注释不同；没有其余类型或执行差异。当前活动 UI 含 generic-aksk。 |
| 日志清理 Worker | `1d966ad` 虽不是 main 祖先，但功能已随 `d617f7e` 集成；worker、capture-compaction 文件 blob 哈希与旧分支完全一致，存储清理实现一致。清理不阻塞 HTTP、并发追加导致快照失效等 8 项 scheduler 测试通过。不属于待合功能。 |
| 分时/生效窗口价格 | `origin/temp` 的旧提交不是遗漏依据；当前主线已有后续等价实现及规范模型定价。价格/联合模型测试共 43 项通过；Rust 已有按请求时刻、工作日和分时窗口计费测试。旧聚合模型价格函数属于已移除架构。 |
| Node Host 迁移、Docker、平台/设备身份和 parity 目录副本 | `migrate/electron-legacy` 的 8 条历史提交对应能力已在主线和生产实现；`scripts/web-parity.mjs` 已包含复制 catalogs 的逻辑。不是需要重新导入的旧宿主。 |
| 数学/渲染依赖 | `git cherry main origin/temp` 对 `af217af` 返回 `-`：已有等价补丁。不能按旧 commit hash 再补一遍。 |
| 已发布 CLI | 起点 18 个、终点 19 个运行源文件分别与生产下载包逐字节一致；Host 复用的 2 个 CLI 源文件也与终点源码一致。Windows 信号驱动属于未合的测试项 A4，不应误称 CLI 运行文件丢失。 |

## 分支分叉与不能直接整支合并的内容

起点本地 main 比 origin/main **多 35 条、少 9 条**提交；新增 `7d527fa` / `6f910f9` 后为 **多 37 条、少 9 条**。本报告自身的后续提交不计作业务差异。

远端独有的历史中包含 `36b235d`（删除 Rust/Tauri 桌面，仅保留 Android）和 `7335af0`（相应文档重构）。这与当前项目明确要求的“保留 Rust/Tauri 回滚路径”冲突，**不能为了把 behind 清零直接整支合并**。它是待决策的架构分歧，不能和 A1/A2 的接入遗漏一起自动恢复。

官网发布与 Windows 测试应从其中按功能提取；临时域名验证文件则应保持最终已移除状态。

### 21 个分支独有提交的逐项归类

| 提交 | 结论 |
| --- | --- |
| `8c2a586` | HY4/决策主体已恢复；余项 A1、A2 仍未完整恢复。 |
| `7030d5a` | 协议升级已等价合回 `8e1f34f`。 |
| `ef8b2a6` | 自定义网关决策模型支持已等价合回 `8e1f34f`。 |
| `b611a83` | 测试项 A4 待合。 |
| `7335af0` | 随宿主裁剪的文档重构，当前架构不直接采用。 |
| `36b235d` | Rust 桌面退役，与当前回滚规则冲突；非接入功能补丁。 |
| `6a93c7b` | 官网部署依赖修补，属于 A3。 |
| `b7d51cc` | 删除临时验证文件；本地该文件本就不存在，不需要恢复它。 |
| `983017b` | 临时域名验证已被后续移除，不作为待恢复功能。 |
| `b74899a` | 官网 EdgeOne 流程 A3 待合。 |
| `1d966ad` | Worker 已通过另一提交集成，不是遗漏。 |
| `eb0e630` | parity 复制 catalogs 已存在。 |
| `282a4c7` | Node Docker 构建/冒烟能力已有现行实现与生产镜像。 |
| `8ffefe4` | 后台维护与设备身份已有现行实现。 |
| `5c293b3` | 分页/平台解析/预设时间等修复已在现行运行模块中。 |
| `00f2a98` | 临时测试数据库不入库的现行规则已在主线。 |
| `6ef6b1a` | Node Host 已是现行生产宿主，非待恢复功能。 |
| `e4d58ef` | 初始 Node scaffold 已被现行实现覆盖。 |
| `111513a` | 旧版 0.1.2 发布树；不能用它替换现行 0.2.0。 |
| `af217af` | 等价依赖补丁已存在（patch-id 证据）。 |
| `6bdddfa` | 分时价格已有后续等价实现；旧聚合代码不恢复。 |

## 审计期间新增且已完成发布的 ACP 图片能力

并发任务先提交 `7d527fa`（协商后的 inline 图片透传），再提交 `6f910f9`（共享 prompt 校验器不依赖宿主未安装的客户端运行库）。

- 审计过程中曾观察到 `7d527fa` canary 退出且 unhealthy，当时管理 API 冒烟连接被拒；没有将中间失败冒充验收成功。
- 随后另一任务发布 `flowlet:node-20261117-acp-images-6f910f9`，生产与 canary 均 healthy；本轮据此重新取得全量生产快照、重新比较终点源码。
- 最终 Node 运行差异重新收敛到 A1/A2 对应 3 个模块；ACP native 模块与源码一致。
- 最终线上 CLI 下载包中的 19 个源文件均与 `6f910f9` 一致，Host 复用的 `acp.ts` / `acp-prompt.ts` 两个文件也逐字节一致；最新构建的 66 个产物重新全部匹配。
- 最终 canary 只读验证：`list_credential_providers`、`list_channel_presets`、`list_a2a_agents` 均 200，分别返回 8 种 provider、10 个渠道、1 个已登记 Agent；provider 包含 generic-aksk 与 http-bearer。
- 这项新功能现已上线，不再列入待发布缺口。本轮未代替另一任务重新做真实图片上游推理验收。

## 审计后的回填结果（2026-11-17）

A1/A2 已回填 main，未改动生产、未重启容器：

- `3f316a2`：`PROTOCOL_VARIANTS` 补 `systemone`，并新增桌面预设接受决策协议的回归测试。
- `29c522b`：新增 `catalog/sources.ts` 与契约测试；`host/scheduler.ts`、`web/commands.ts` 按候选源同步、记录实际来源并在写入前校验 JSON；前端手动同步改送主站地址（由 Host 回退）；`scripts/fetch-models-cn.mjs` 同样支持双源，保留 Tauri 打包目标路径。
- 转译后 `sources.ts`、`scheduler.ts`、`commands.ts`、`maintenance.ts` 与线上 `/app` 实现完全一致；以 HEAD 重跑本脚本，`onlineOnly`、`runtimeDifferences`、`typeDifferences` 均为空，只剩预期的 `server.mjs` 和内置 `config.json` 的两项默认推荐差异。
- 测试通过：数据源契约 3 项、scheduler 13 项、桌面维护 24 项、Web 命令 313 项；`npm run node:typecheck`、`npm run check`、`vite build --mode web` 通过。
- `fbf0846`：Windows CLI SIGINT 回归与 `cred:test` glob；`7b193cd`：EdgeOne 官网自动发布与固定版部署工具。
- **未重新发布**：线上已在运行等价的 A1/A2 实现，回填只是补齐源码；前端改动尚未进入线上构建。下次发布应重建 Web UI，并决定是否把 `kimi-k3.1-pro`、`qwen4-max` 的内置默认推荐一并带上。

## 可重复核对与验收边界

新增只读脚本 [audit-release-parity.mjs](../scripts/audit-release-parity.mjs)，固定某个 git ref，比较提取的运行镜像源码/配置/下载包。它不联系服务、不写业务数据；发现差异返回退出码 **2**，不会把 type-only 差异直接当成注释，也不会把线上保留的旧 hash 文件当作新构建。

```bash
node scripts/audit-release-parity.mjs \
  --snapshot-dir .agents/skills/flowlet-docker-deploy/.work/full-merge-audit-20261117/final-online \
  --ref 6f910f9 --ui-dir dist-web --report /tmp/flowlet-release-audit.json
```

回填后用 `--ref 29c522b` 重跑，`onlineOnly`、`runtimeDifferences`、`typeDifferences` 为空。`dist-web` 现已是 15:18 发布构建；上面的 `--ui-dir` 示例对应 `6f910f9` 旧快照，重跑旧快照时需省略该参数或使用同版本构建。

原始生产快照、分支提交清单、结构化差异与测试输出保留在该私有 `.work` 目录，未提交镜像源码副本或任何运行凭据。本次脚本语法检查通过，已对起点 `9336f96`、中间态 `7d527fa`、最终 `6f910f9` 和回填后的 `29c522b` 实际执行并正确返回 2。

本轮未做生产浏览器登录后的逐页交互验收；因此结论是“列明审计范围内的合并/发布缺口”，不是承诺现有产品没有其他 bug。剩余工作只有 `36b235d` 的架构分叉决策；发布前再次固定 source ref、镜像 ID、模型/协议集合和下载包。
