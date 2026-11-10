# Docker 镜像迁移到 Node Host

> 状态：**Node Host 已与当前线上版本（含 GitLab OIDC SSO）对齐**：严格对拍 0/0
> （命令 58 步 + HTTP 检查，Rust oracle = 线上容器二进制 + 生产库快照），镜像已在远端构建并
> 通过容器冒烟（token / oidc 两种模式）；**尚未替换线上 `flowlet` 栈**（部署需要用户授权）。

## 镜像结构（`Dockerfile`）

| 阶段 | 基础镜像 | 作用 |
| --- | --- | --- |
| `web` | `node:26-bookworm-slim` | 构建 `dist-web`（与现有多阶段构建完全一致） |
| `server-deps` | `node:26-bookworm-slim` | 只安装 `packages/flowlet-core` 运行时依赖（`undici`） |
| runtime | `node:26-bookworm-slim` | 非 root `10001`、`/data` 卷、`/app/ui` 静态界面、`/app` 源码 + 依赖 |

与 Rust 镜像的差异：

- **删除 Rust 构建阶段**：镜像内不再有 `cargo`、`target/`、`flowlet-server` 二进制；
- 入口是 `node /app/packages/flowlet-core/src/index.ts`（Node 26 原生执行 TS，无构建产物）；
- 体积目标：< 300 MB（Rust 版 runtime 层约 100 MB + 二进制，实际以远端构建结果为准）；
- 环境变量、端口（8080 / 18640）、`/data` 布局、`HEALTHCHECK`、`STOPSIGNAL SIGTERM`、
  `USER 10001:10001`、`stop_grace_period: 30s` **全部保持不变**。

## 远端构建与冒烟结果（2026-11-09）

| 项 | 结果 |
| --- | --- |
| 镜像 | `flowlet:node-20261109-poc`（`sha256:97956dd353df`，含 SSO/.flcap/价格表） |
| 体积 | **258 MB**（Rust 版 runtime 层 ~100 MB + 24 MB 二进制，Node 版一次到位） |
| 构建 | Docker Engine API `POST /build`，全量 ≈140–270s；改源码后增量 ≈3.6s（npm 层缓存） |
| 冒烟（token 模式） | **20/20 通过**（含 `/api/auth/config`、`/api/session` mode 形状） |
| 冒烟（OIDC 模式） | **12/12 通过**：config.mode=oidc、provider.display_name、token_login=false、无会话 401、Bearer 被拒 401、不可达 IdP 时 `303 /?auth_error=provider_unavailable` |
| 清理 | 冒烟容器/卷已删除；线上 `flowlet` 容器未受影响 |

容器冒烟覆盖：`healthy`、`/health` 200、`/api/auth/config`、`/api/session` 401/200 + mode 形状、
SPA 200、`/api/*` 404、`list_channel_accounts`（14 行）、`list_route_candidates`（44 行）、
6 条常用命令 200、未知命令 501、`/v1/models` 200（4 个模型）、`/v1/models` 无凭据 401；
OIDC 模式另验证 fail-closed（无会话/静态 token 均被拒）与不可达 IdP 的优雅降级。
冒烟使用 `FLOWLET_DISABLE_BACKGROUND_TASKS=1`，避免用库内真实凭据向真实上游发余额请求。

构建期经验：运行阶段已不安装任何 apt 包（健康检查改用 Node `healthcheck.mjs`），
避免了远端拉 Debian 源导致的构建卡顿；镜像内 `/app` 统一 `chmod -R a+rX`，
因为本地工作区文件可能是 0600 而容器以 10001 运行。

## 生产切换记录（2026-11-10）

| 项 | 值 |
| --- | --- |
| 切换前镜像（回滚点） | `flowlet:docker-20261109-gitlab-sso`（Rust headless） |
| 切换后镜像 | `flowlet:docker-20261110-nodehost`（= Node Host，含 SSO / .flcap / 价格表 / 服务凭据） |
| 方式 | Dockhand stack `flowlet` 仅替换 `services.flowlet.image`（`forceRecreate`），`/data` 卷不动 |
| compose 备份 | `.agents/skills/flowlet-docker-deploy/.work/compose.before-20261110-103921.yaml` |
| 回滚 | `flowlet_deploy.py deploy --tag flowlet:docker-20261109-gitlab-sso`（DB schema 只增不改，Rust 可直接读回） |

切换后验证（**14/14 通过**）：容器 healthy；`/health`；`/api/auth/config` = oidc + GitLab + `token_login:false`；
`/api/auth/login` → 302 GitLab authorize（含正确 `client_id`/`redirect_uri`/state/nonce）；
未登录 `/api/session` 401；回调错误路径 303 `?auth_error=state_invalid`；静态界面 200（含「服务凭据」页）；
`/v1/models` 200（4 个模型）；`deepseek-v4.1-flash` OpenAI 流式读到 `[DONE]`；
容器内确认 `service_credentials` 表、`/data/secret.key`、`.flcap` ready 帧可读；新请求日志无错误、无 `stream_cancelled`。
切换后 10 分钟真实客户端流量：30 条请求（`/v1/chat/completions`、`/anthropic/v1/messages`），**0 错误、0 stream_cancelled**。

## 请求日志渠道账号筛选发布记录（2026-11-10 12:32）

| 项 | 值 |
| --- | --- |
| 功能 | 请求日志新增「渠道账号」筛选（渠道 / 具体账号两种粒度）；新增只读命令 `list_request_log_channel_accounts`，`list_request_logs` 入参新增 `account_id` |
| canary 镜像 | `flowlet:node-20261110-logfilters`；容器 `flowlet-canary`（20234/20235，token 模式、独立数据卷） |
| 生产切换前镜像（回滚点） | `flowlet:docker-20261110-nodehost` |
| 生产镜像 | `flowlet:node-20261110-logfilters`（Node Host，`sha256:4a9342d3…`，259 MB） |
| 方式 | canary 先用 Docker Engine API 重建容器验收；生产由 Dockhand stack `flowlet` 仅替换 `services.flowlet.image`（`forceRecreate`），`/data` 卷不动 |
| compose 备份 | `.agents/skills/flowlet-docker-deploy/.work/compose.before-20261110-123218.yaml` |
| 回滚 | `flowlet_deploy.py deploy --tag flowlet:docker-20261110-nodehost` |

验证：canary **27/27 通过**（筛选项形状与 camelCase、按账号/渠道过滤、Nonexistent=0、
流式请求可按其账号筛回、UI bundle 含新命令与「全部渠道账号」文案）；
生产 **16/16 通过**（镜像 tag、healthy、oidc 鉴权不变、未登录 401、SPA、
`/v1/models`、`deepseek-v4.1-flash` 流式 `[DONE]`、新日志 `route_reason=direct`、
账号过滤 SQL、捕获帧 ready、无意外错误）。构建走 Engine API `POST /build`（≈156s，复用 npm 层缓存）。

### 附带修复：`/data` 所有权（Node Host 迁移遗留）

Rust 版线上镜像 `USER root`，Node Host 镜像 `USER 10001:10001`。2026-11-10 10:39 切换到 Node Host 后，
`/data/request-captures` 下由 root 创建的历史目录/帧（共 1141 项）使新请求 `.flcap` 捕获全部
`EACCES` 失败（请求详情 body 缺失），`/data/flowlet-device.json` 也为 root 所有。
本次发布期间以 root exec 执行 `find /data -not -user 10001 -exec chown 10001:10001 {} +`
修复生产与 canary 数据卷；修复后新请求捕获恢复 `state=ready`（04:36 UTC 起 15+ 条 ready、0 failed）。
历史 `failed` 捕获记录无法重写，仍按原样展示。该问题与本次功能改动无关，早于本次发布即存在。

## 服务凭据多实例 / 本机接入 / 保存账号修复发布记录（2026-11-10 13:03）

| 项 | 值 |
| --- | --- |
| 内容 | ① 服务凭据新增 Dockhand provider、同 provider 多实例（环境前缀 `env_prefix` 列 + `{PREFIX}_URL/TOKEN` + CLI `--profile`）、Web Host「本机接入」下载安装引导（`/downloads/`：CLI tar / Skills tar / `install-flowlet.sh` / manifest）；② CLI 更名 `flowlet`（Node 22.6+ 兼容自检）；③ 修复「保存渠道账号」失败：手动余额快照补 `raw_scraped_json`，Rust serde 加 `default`、Node required 列表放开；④ 前端统一 `copyText` 回退（HTTP 内网 `navigator.clipboard` 缺失）与 `errorMessage` 展示（不再出现 `[object Object]`） |
| 生产切换前镜像（回滚点） | `flowlet:node-20261110-logfilters` |
| 生产镜像 | `flowlet:node-20261110-dockhand-localaccess`（`sha256:94e8c85b478b`，260 MB） |
| 方式 | Docker Engine API `POST /build`（上下文 9.8 MB gzip，35 步，≈171s）；Dockhand stack `flowlet` 仅替换 `services.flowlet.image`（`forceRecreate`），`/data` 卷不动 |
| compose 备份 | `.agents/skills/flowlet-docker-deploy/.work/compose.before-20261110-130313.yaml` |
| 回滚 | `flowlet_deploy.py deploy --tag flowlet:node-20261110-logfilters` |

验证：容器 healthy；`/health` 200；`/api/auth/config` = oidc（token_login:false）；未登录 `/api/session` 401；
SPA 200 且新 bundle 与本地 `dist-web` 字节一致（含「本机接入」「环境前缀」「install-flowlet.sh」）；
`/downloads/{manifest.json,flowlet-cli.tar.gz,flowlet-skills.tar.gz,install-flowlet.sh}` 全部 200 且字节数与 manifest 一致；
`/v1/models` 200（4 模型）；`deepseek-v4.1-flash` `/v1/chat/completions` 流式 3/3、`/anthropic/v1/messages` 流式 2/2 均读到结束事件；
生产库副本确认 `channel_accounts` 14、路由 46、`service_credentials` 1 行且新列 `env_prefix` 存在、`channel_account_workspace_links` 14、余额快照 723；
容器内 `commands.ts` 的 `BALANCE_SNAPSHOT_REQUIRED` 已不含 `raw_scraped_json`；日志仅 1 条常态 `balance-sync 3/4`，
OIDC 登录成功记录正常，无 EACCES/panic/其他错误。

## Web 命令层渠道模板合并 + 老前端保存兼容（2026-11-10 13:24）

| 项 | 值 |
| --- | --- |
| 内容 | ① `startHost` 把 `loadChannelsConfig` 合并内置模板后的 `channels_config` 传给 `createWebHost`（`WebHostOptions.channelsConfig`）——数据卷 `/data/config.json` 早于当前版本时，Web 命令层曾报「渠道 openai-api/vibetoken 缺少运行时模板」「余额同步 请求失败: Invalid URL」；② 线上镜像以 13:03 发布的 `flowlet:node-20261110-dockhand-localaccess` 为基座补齐该修复，同时带回 13:03 的前端 `errorMessage`/`copyText`/「本机接入」bundle 与 Node 侧 `BALANCE_SNAPSHOT_REQUIRED` 放开（此前线上跑的是更早的 `logfilters`，老前端提交的手动余额草稿缺 `raw_scraped_json`，保存渠道账号报 400 且错误对象被渲染成 `[object Object]`） |
| 生产切换前镜像（回滚点） | `flowlet:node-20261110-snapshotfix`（= logfilters + 渠道合并 + 快照兼容补丁） |
| 生产镜像 | `flowlet:node-20261110-localaccess-channels`（`sha256:98bdecd2aa8b`，247 MB） |
| 方式 | 以运行中镜像创建 helper 容器 → `PUT /containers/{id}/archive` 覆盖 3 个源码文件（`config/index.ts`、`index.ts`、`web/index.ts`）→ `POST /commit`；Dockhand stack 仅替换 `services.flowlet.image`（`forceRecreate`），`/data` 不动 |
| 镜像基线说明 | 工作树含未完成的 cli-auth / credentials WIP（`web/__tests__/cli-auth.test.ts` 当前 `require is not defined` 失败），**未整树重建**，只把已确认的修复叠加到已发布镜像上 |
| compose 备份 | `.agents/skills/flowlet-docker-deploy/.work/compose.before-20261110-132408.yaml` |
| 回滚 | `flowlet_deploy.py deploy --tag flowlet:node-20261110-snapshotfix` |

验证：canary 用生产数据副本（旧 `config.json` 只有 7 个渠道）跑通 `fetch_channel_models(openai-api)`=96、
`fetch_channel_models(vibetoken)`=65、`query_balance(vibetoken)`=10.85 CNY、缺 `raw_scraped_json` 的
`save_balance_snapshot`=200、`save_channel_accounts`=200；线上 healthy、`/health` 200、SPA 200、
容器日志 `balance-sync 4/4`，容器内 `commands.ts` 已无 `raw_scraped_json` 必填、`index.ts` 含 `channelsConfigToJson`。


## 体验实例（canary）

为便于验收，在远端 Docker 上另起了一个独立容器（**不进入 Dockhand stack、不影响线上**）：

| 项 | 值 |
| --- | --- |
| 容器 / 卷 | `flowlet-canary` / `flowlet-canary-data`（数据卷 = 线上 `/data` 的本地副本，含 .flcap 帧） |
| 端口 | `20234` (Web) / `20235` (模型入口) |
| 镜像 | `flowlet:node-20261110-localaccess-channels`（= 13:03 发布镜像 + Web 命令层渠道模板合并；token 模式） |
| 登录 | token 模式（管理凭据仅存在于部署时生成的本机 env，不入库） |
| 后台任务 | 关闭（`FLOWLET_DISABLE_BACKGROUND_TASKS=1`，避免与线上重复同步） |

canary 验证：令牌登录、14 账号/46 路由/日志与用量、`/v1/models`、「服务凭据」providers/list/export，
以及 `.flcap` 历史请求详情 hydrate。切换正式环境前只需替换 stack 的 `services.flowlet.image`。

## 与线上版本的 1:1 验收口径

1. **管理端功能对拍**：从线上容器只读提取 `/usr/local/bin/flowlet-server`（即当前线上 Rust 二进制），
   加上线上 `/data` 的数据库与目录快照，作为 Rust oracle：

   ```bash
   # 提取（Docker Engine API，只读；产物在 .flowlet-dev-data/，已 gitignore）
   # GET /containers/flowlet/archive?path=/usr/local/bin/flowlet-server
   FLOWLET_RUST_HEADLESS=$PWD/.flowlet-dev-data/flowlet-server-online \
   FLOWLET_PARITY_DB=$PWD/.flowlet-dev-data/prod-copy/flowlet.sqlite \
   node scripts/web-parity.mjs
   ```

   验收线：命令差异 0 + HTTP 差异 0（包含 `/api/session`、`/api/auth/*` 的 SSO 鉴权面）。
2. **数据层**：用同一份生产库快照比较 `usage_summary` / `usage_today_tokens` / `list_request_logs`
   摘要（含 cost）、请求详情（.flcap 帧 hydrate）等。
3. **容器冒烟**：用生产库快照起临时容器，验证 `/health`、鉴权、命令面（含服务凭据）、`/v1/models`、静态界面。
4. **SSO**：用本地 mock OIDC Provider 跑单元测试（真实 GitLab 登录需线上 client secret，不在本地验证）。

## 本地验证（无 docker CLI）

本机没有 docker CLI，服务端镜像构建走 `10.100.217.60:2375` 的 Docker Engine API
（见 `.agents/skills/flowlet-docker-deploy/`）。本地等价验证：

```bash
npm run build:web
scripts/run-node-host.sh                  # 与镜像一致的环境变量 + 数据副本
node scripts/e2e-node-host.mjs            # 端到端冒烟（含 mock 上游流式）
```

## 远程构建与发布（获授权后执行）

1. 用 Engine API `POST /build` 构建（上下文为仓库根，`.dockerignore` 已排除
   `.worktrees/`、`node_modules`、`target`、`dist*`）。服务器已预置
   `node:26-bookworm-slim` 基础镜像，无需拉取 Docker Hub；无需 `DEBIAN_MIRROR`
   （运行阶段不再 apt 安装任何包）。
2. 构建 nginx/代理无变化；部署走既有 Dockhand stack（`env=2`，stack `flowlet`），
   只替换 `services.flowlet.image`。
3. 上线后按技能 `verify` 口径验证：`/health`、管理 API 账号 14 / 路由 56、
   `/v1/chat/completions` 流式、`/anthropic/v1/messages` 流式、`/v1/responses`、
   日志 `route_reason` 与 `upstream_proxy_used` 字段。
4. 回滚点 = 部署前镜像 tag（Rust 版 `flowlet:docker-<日期>`），数据卷 `/data` 不动。

## 后台维护任务（Node Host 已实现）

对齐 Rust `core/host_scheduler.rs` 与 `core/account_balance.rs`：

| 任务 | 首次延迟 / 周期 | 实现位置 | 说明 |
| --- | --- | --- | --- |
| 官方余额同步 | 30s / 5min | `packages/flowlet-core/src/host/scheduler.ts` | 仅启用 + 预设声明 `supports_balance_query` + 官方余额渠道（deepseek/kimi/openrouter/vibetoken）且无账号级自定义 Base URL；串行执行，单账号失败不中断 |
| 存储清理 | 15min / 15min | 同上 + `storage/maintenance.ts` | Body 过期清理（app_meta 的 log_capture 为准）、体积超限按比例清理、余额快照保留（默认 30 天 / 每账号 200 条）、孤儿快照清理 |
| 模型目录同步 | 1h / 1h | 同上 | 抓取 models-cn / models.dev 并原子写入 `FLOWLET_CATALOG_DIR`；单个来源失败不影响另一个 |

## 已补齐（与线上 1:1 的部分）

| 能力 | 实现 | 验证 |
| --- | --- | --- |
| GitLab OIDC SSO | `web/auth.ts`（30+ env 对齐、discovery/JWKS、RS256、PKCE/nonce、白名单、Cookie 会话、CSRF） | auth 单测 22/22；严格对拍 `/api/auth/*` 与 `/api/session` 0 差异；镜像 OIDC 模式冒烟 |
| `.flcap` 捕获帧 | `storage/capture-store.ts`（FLCAP001 + 60B 头 + zstd + sha256 + 32MiB 分段 + compacted 重写） | 帧头/记录 JSON 逐字节一致；Rust↔Node 互读/互写/互清三场景全通过 |
| 目录派生价格表 | `storage/prices.ts`（models-cn/models.dev/config 覆盖、分档、每日峰谷） | prod 目录构建 82 条；Rust 落库 cost 与 Node 重算完全相等 |
| 三方服务凭据 | `storage/secret-box.ts`（ChaCha20-Poly1305，`secret.key` 随 `/data`）、`storage/credentials.ts`（service_credentials 表）、`web/gitlab.ts`（CE 10.8.7）、`web/credentials.ts`（6 条命令） | 单测 26 条；跨实现加解密（Node 写→Rust 导出 / Rust 写→Node 解密）通过；对拍含 mock GitLab 0 差异 |

## 残余差异（均为已知、非用户可见或与 Rust 一致）

- zstd **压缩块字节**非逐字节一致（Rust libzstd 0.13.3 vs Node zlib 1.5.7，差 1 字节）；
  帧头里的长度按各自实际块写、checksum 覆盖原始 JSON，**跨语言互读已实测无损**。
- 不写 `background_jobs` 后台任务日志（Rust 会写），改为结构化 stdout 行；不影响业务数据与页面。
- CLI 已由 Node 版接管：用户侧命令统一为 `flowlet`（`packages/flowlet-cred/`，旧名
  `flowlet-cred` 不再保留别名），通过 `POST /api/commands/export_service_credentials`
  拉取凭据；Rust legacy 二进制 `flowlet-cred` 仅保留做兼容性对拍，Agent 机器不再需要。
  Web Host 的「服务凭据 → 本机接入」提供 `flowlet` 安装脚本与 Skills 下载
  （见 `docs/credential-cli.md` §11）。
- CLI 浏览器授权（`flowlet login`，Node Host 专有）：OIDC-only 实例不再需要把管理凭据交给
  Agent 机器，`flowlet pull` 自动使用本机 `auth.json` 授权；授权/撤销见
  `docs/credential-cli.md` §4 与 `docs/migration/node-host.md` §2.1。Rust Host 未实现该能力，
  且不参与对拍。
- `cleanupOldLogs` 删行后不额外 GC 已 `cleared` 的 orphan compacted 段（Rust 同样不回收）。
- 与 Rust 保持一致、未额外实现：仅 RS256、`client_secret_basic`、无 `REQUIRE_EMAIL_VERIFIED`/`CA_FILE`/
  Sec-Fetch-Site 校验等（设计文档中列为 v1 非目标）。

## 会话标题/项目派生发布记录（2026-11-10 13:31）

| 项 | 值 |
| --- | --- |
| 内容 | Web Host「会话管理」的会话标题与项目目录由代理侧从请求体派生（`proxy/session-derive.ts` → `agent_session_metadata` 表 → 会话聚合 `LEFT JOIN`），规则见 [agent-session-metadata.md](../agent-session-metadata.md)；前端搜索框与 Web 说明同步 |
| 代码 | 提交 `582117d`（同一提交含此前未提交、但已上线的 webchannels/服务凭据/CLI 工作树状态） |
| 构建 | Docker Engine API `POST /build`（197s）→ `flowlet:node-20261110-sessionmeta`（`sha256:9c1374a8…`，260 MB） |
| 部署 | 13:30:34 经 Dockhand 仅替换 `services.flowlet.image`（`forceRecreate`），05:31:06Z healthy；新容器冒烟（临时容器 + 空卷）通过 |
| compose 备份 | `.agents/skills/flowlet-docker-deploy/.work/compose.before-20261110-133034.yaml` |
| 验证 | 生产：`agent_session_metadata` 表存在；带 `x-claude-code-session-id` 的 Anthropic 流式请求后，DB 出现 `title=验证会话标题派生`、`project_path=/tmp/flowlet-sessionmeta-verify`、`source=derived`，请求日志 200 无错误；部署后 91 条请求 0 真实错误、0 `stream_cancelled`；UI chunk 与本地 `dist-web` 字节一致 |
| 并发说明 | 13:32:58 另一个并发会话构建了 `flowlet:node-20261110-cliauth` 并于 13:35:02 覆盖线上镜像；该镜像构建自同一工作树（含本提交），实测新请求仍写入 `agent_session_metadata`，功能未丢失。当前线上 = `flowlet:node-20261110-cliauth` |
| 回滚 | `flowlet_deploy.py deploy --tag flowlet:node-20261110-sessionmeta`（本次发布镜像）或 `flowlet:node-20261110-localaccess-channels`（发布前 stack 值）；DB schema 只增不改 |

## CLI 浏览器授权（`flowlet login`）发布记录（2026-11-10 13:35）

| 项 | 值 |
| --- | --- |
| 背景 | 生产是 OIDC-only（`FLOWLET_ADMIN_ALLOW_TOKEN_LOGIN=0`），管理 API 拒绝一切 Bearer，`flowlet pull --token=<管理凭据>` 必然 401。本次不放开管理鉴权面，改为给 CLI 一条独立作用域授权：浏览器 SSO 会话点一次「授权」→ loopback + PKCE 换 `flwcli_*` token（作用域 `credentials:read`，TTL 30 天，可撤销），`flowlet pull` 自动使用本机 `auth.json` |
| 服务端 | 新表 `cli_auth_tokens`（只存 SHA-256）；`web/cli-auth.ts`；公开路由 `GET /api/auth/cli/start`（HTML 授权页）、`POST /api/auth/cli/exchange`；受保护命令 `create_cli_auth_code` / `list_cli_auth_tokens` / `revoke_cli_auth_token`；CLI token 仅允许 `export_service_credentials`，其它命令 403，且不能用于 `/api/session` |
| CLI | `packages/flowlet-cred`：`flowlet login` / `flowlet logout`；`pull` 凭据优先级 `--token` > `FLOWLET_ADMIN_TOKEN` > 本机 `auth.json`（401 提示重新 login、403 提示作用域） |
| 镜像 | `flowlet:node-20261110-cliauth`（`sha256:fe063d7b3ede…`，259 MB，Engine API `POST /build` 171s） |
| canary | `flowlet-canary` 升级到该镜像后 9/9 通过：授权页参数错误 400；`create_cli_auth_code` 200；`exchange` 200 且 token 前缀 `flwcli_`；CLI token 导出 200、其它命令 403、`/api/session` 401；列表 1 条且不含明文/哈希；撤销 200，撤销后导出 401 |
| 打包 CLI 端到端 | 从 canary `/downloads` 执行官方安装脚本（独立 `--prefix`/`--skills-dir`）→ 真实 `flowlet login --no-browser`（脚本扮演浏览器完成授权页 + 授权）→ `auth.json` 0600 → `flowlet pull --dry-run` 退出 0；终端输出与 `auth.json` 均未出现 token 明文 |
| 部署 | 13:35:02（本地）经 Dockhand 仅替换 `services.flowlet.image`（`forceRecreate`），容器 healthy；compose 备份 `.agents/skills/flowlet-docker-deploy/.work/compose.before-20261110-133453.yaml` |
| 生产验证 | 镜像 tag / healthy；`/api/auth/config` 仍为 `oidc` 且 `token_login=false`（静态管理 Bearer 仍被 401，未放开兜底）；授权页 200（含核准按钮、登录提示分支、`credentials:read`、`DENY`/`no-store`/CSP）；`exchange` 非法 code → 400 `invalid_grant`；`/v1/models` 4 个模型；`deepseek-v4.1-flash` 流式读到 `[DONE]`；`service_credentials` 1 条保留、`cli_auth_tokens` 表可读；自容器启动起请求日志 0 错误（仅历史 Hermes `/v1/props` 404 噪声） |
| 前端 | 「服务凭据 → 本机接入」改为「登录并同步凭据」两步（login + pull）并新增「已授权的 CLI」列表/撤销；`flowlet pull` 不再携带 `--token` |
| 回滚 | `flowlet_deploy.py deploy --tag flowlet:node-20261110-sessionmeta`（发布前 stack 值）；DB schema 只增不改，旧镜像可直接读回 |
| 文案修订（13:45） | 授权相关文案不再写「公司 SSO」（IdP 由 `FLOWLET_OIDC_DISPLAY_NAME` 配置，也可能是 token 模式）：UI/CLI/文档统一为「登录 Flowlet 管理台并授权」，授权页动态展示实例配置的登录方式；同时把 `packages/flowlet-skills/flowlet-credentials/SKILL.md`（安装脚本下发的 Skills 包）同步为含 `flowlet login` 的版本，去掉旧的 `pull --token` 指引。镜像 `flowlet:node-20261110-logintext`（163s，`sha256:3a61bb05…`），13:45:33 部署后：UI 包无「公司 SSO」、含新文案；Skills 包含 `flowlet login` 且无 `pull --token`；`/v1/models` 200、OIDC 配置不变 |
| 并发说明 | 本发布与 sessionmeta 流交替部署；当前线上 = `flowlet:node-20261110-cliauth`，该镜像同时含 sessionmeta 派生与 CLI 授权（sessionmeta 侧已实测派生未丢失） |
| 未覆盖 | Rust Host（桌面/legacy headless）未实现该能力，桌面侧仍可用 `flowlet set`/`--token`；浏览器授权要求 CLI 与浏览器在同一台机器（loopback） |

## 服务凭据「查看原始 token」发布记录（2026-11-10 13:58）

| 项 | 值 |
| --- | --- |
| 需求 | 管理台需要能查看/复制已保存服务凭据的**原始 token**（此前列表只显示 `••••1a2b`） |
| 服务端 | 新增管理命令 `reveal_service_credential`（入参 `{id}`，返回 `{id,name,provider,envPrefix,token}`）：用 `/data/secret.key` 解密单条凭据；仅管理鉴权可用，`flowlet login` 的 CLI token 调用返回 403；明文不写日志、不落库、不缓存；列表接口继续只返回掩码 |
| 前端 | 「服务凭据」表格操作列新增眼睛按钮（Tooltip「查看原始 token（仅管理台可见）」），弹层展示明文 + 复制 + 明文警示 Banner；关闭即清空状态；失败只 toast，不影响列表 |
| 镜像 | 从**干净 HEAD 树 + 本功能文件**构建（避免带上当时并行会话的未提交 WIP）：`flowlet:node-20261110-revealtoken`（233s，`sha256:6da126f9…`） |
| canary | 在 canary 容器内写入一条测试凭据（用其 `/data/secret.key` 加密）→ `list` 仅掩码；`reveal` 200 且返回正确明文与 `envPrefix`；未鉴权 401；不存在 400「凭据不存在」；CLI token 403；测试行已删除 |
| 部署 | 13:58:13 经 Dockhand 替换 `services.flowlet.image`（`forceRecreate`），healthy；compose 备份 `.agents/skills/flowlet-docker-deploy/.work/compose.before-20261110-135749.yaml` |
| 生产验证 | 镜像 tag / healthy；`/api/auth/config` 仍 oidc + `token_login=false`；未鉴权 `reveal_service_credential` 401；UI 包含 `reveal_service_credential` 与「查看原始 token」文案；`service_credentials` 1 条保留；`/v1/models` 200（4 个模型）、`deepseek-v4.1-flash` 流式 `[DONE]` |
| 回滚 | `flowlet_deploy.py deploy --tag flowlet:node-20261110-logintext` |
| 权限边界 | Rust Host（桌面）未实现该命令，桌面端调用失败并提示「无法查看原始 token」；CLI token 作用域不变（仍只能 `export_service_credentials`） |

## 升级停机窗口优化（快速退出 + 会话持久化）发布记录（2026-11-10 14:16）

| 项 | 值 |
| --- | --- |
| 背景 | 每次 Docker 升级都会重建容器：旧 Host 的 `proxy.stop()` 会等最长 SSE 自然结束，直到 `stop_grace_period` 30s 被 SIGKILL，使用端实测停机约 30s；Dockhand `forceRecreate` 还会连带重建 `flowlet-egress`，经代理的 OpenAI 请求同时 502 |
| 内容 | ① Host 退出走 `proxy.dispose()`：关闭监听后只宽限 `FLOWLET_SHUTDOWN_ABORT_MS`（默认 250ms）就强制断开在途连接，`FLOWLET_SHUTDOWN_HARD_EXIT_MS`（默认 2000ms）兜底，第二次信号立即退出；上游连接池关闭限时 150ms，不再拖住停机。② OIDC 会话写穿到 `/data/admin-sessions.json`（0600，存 Cookie 的 sha256/身份/CSRF/过期时间），重启/升级不再把管理台登录态全部踢掉；token 模式不产生会话文件。③ 发布脚本改为「overlay 构建 + 仅替换 flowlet 容器」：更新 stack 文件但不触发 compose 重启，新容器先创建、旧容器停止后立刻启动新容器，egress 全程不重启 |
| 镜像 | `flowlet:node-20261110-fastshutdown5`（`sha256:9124dbc20dd9`，249 MB，作为 `flowlet:node-20261110-usagerepair` 的 overlay） |
| overlay 文件 | `src/index.ts`、`src/proxy/index.ts`、`src/web/auth.ts`、`src/web/session-store.ts`（新文件）；`flowlet:node-20261110-usagerepair` 里含当时尚未提交的 `reveal_service_credential`，未整树重建，只叠加本次改动 |
| 部署 | 2026-11-10 14:16 起多次替换验证；`stack` 文件已指向新镜像，`/data` 卷不动 |
| 实测窗口 | 旧容器 SIGTERM → 退出 **0.72s**（关闭阶段 web 1ms / proxy 485ms / storage 231ms）；新容器启动 → `/health` **1.37s**；使用端探测到不可用 **约 3.1s**（优化前同一实例 30–32s）。egress 未重建 |
| 验证 | 每次替换后 `/health` 200、`/api/auth/config` = oidc、`/v1/models` 200、`deepseek-v4.1-flash` 流式 3/3 读到 `[DONE]`；`/data/admin-sessions.json` 由真实 GitLab 登录产生（一条会话，key 为 64 位 sha256，无原始 Cookie） |
| 测试 | `node --test packages/flowlet-core/src`：224 tests / 0 fail（新增 `__tests__/shutdown.test.ts`：在途未完成请求下 SIGTERM <3s 退出且端口可立即重绑；`web/__tests__/session-store.test.ts`；auth 新增「同一会话文件跨 host 重建仍登录」）；`tsc -p packages/flowlet-core/tsconfig.json` 0 错误 |
| 回滚 | `flowlet_deploy.py deploy --tag flowlet:node-20261110-fastshutdown4`（上一版）或 `flowlet:node-20261110-usagerepair`；Rust 镜像的回滚点仍是 `flowlet:docker-20261109-gitlab-sso`（会话为纯内存，切回需重新登录） |
| 已知限制 | 切换瞬间在途长 SSE 会被中断（宽限 250ms 后强制断）；真正零中断需要入口反代 + 蓝绿双槽，未实施。通过 API 手动创建的容器带有旧 `com.docker.compose.config-hash` 标签，Dockhand 面板可能显示与栈文件不同步；下一次 compose 重启会自行重建 |


## 环境前缀自动生成发布记录（2026-11-10 14:17）

| 项 | 值 |
| --- | --- |
| 需求 | 「环境别名（Env 前缀）」不再要求手写：按已填的名称/备注自动生成，并对已有前缀自动避让 |
| 规则 | 名称+备注中的 ASCII 片段拼成 `{provider 默认前缀}_{片段}`（「公司 Dockhand NA」→ `DOCKHAND_NA`）；纯中文名退化为默认前缀；与其它凭据冲突时追加 `_2`、`_3`；总长 ≤24 且满足 `^[A-Z][A-Z0-9_]{0,23}$`；与 provider 默认前缀同名的片段会被剔除（避免 `DOCKHAND_DOCKHAND`） |
| 交互 | 新建时字段随名称/备注/服务类型实时更新，并提示「已按名称与备注自动生成，可直接修改」；手动输入后不再覆盖；输入框上方提供「自动生成」按钮可随时重新计算；编辑已有凭据时保留其已存前缀（视为手动设置），避免悄悄改名 |
| 代码 | 判定函数 `suggestEnvPrefix` / `envPrefixSegment`（`src/domains/credentials/envPrefix.ts`）+ 表单接线（`CredentialsPage.tsx`）；单测 13 条（含冲突、纯中文、长度截断）+ 页面测试（预填避让、手动后不被覆盖、一键重算） |
| 镜像 | `flowlet:node-20261110-autoprefix`（`sha256:2ba5f63d…`）：从当次一致的 HEAD `16fd9b5` + 本功能文件构建（工作树当时含并行会话未提交的 provider 扩展，刻意隔离） |
| 部署 | 14:17:12 healthy；部署脚本本次走蓝绿切换（新容器 `/v1/models` 200 后 3.1s 完成，egress 未重建）；回滚点 `flowlet:node-20261110-fastshutdown5` |
| 验证 | 生产 healthy；UI 包含「自动生成」「已按名称与备注自动生成」与既有「查看原始 token」「flowlet login」；`service_credentials` 3 条（`GITLAB` / `DOCKHAND_SELF` / `DOCKHAND_NA_PROD`）保留；重启后仅 Hermes `/v1/props` 404 噪声，无真实错误 |
| 并发说明 | 14:19 并行会话又部署了 `flowlet:node-20261110-fastshutdown6`（含其快速退出/会话持久化）。核对其 UI 包仍包含「自动生成」「查看原始 token」「flowlet login」，本次功能未被覆盖；当前线上 = `flowlet:node-20261110-fastshutdown6` |
| 遗留 | 并行会话的 `89733c1`（快速退出 + 管理端会话持久化）已提交，但同一时刻其 Beszel/Uptime Kuma/Jenkins provider 仍为未提交 WIP，导致该 HEAD 自身 `tsc` 不通过（页面已引用未提交的 provider 类型）。因此本次镜像**未包含** `89733c1`；待该功能提交、HEAD 恢复可构建后，重新从 HEAD 构建即可同时带上两者 |

## 服务凭据 Jenkins provider 发布记录（2026-11-10 14:31）

| 项 | 值 |
| --- | --- |
| 内容 | 服务凭据新增 Jenkins provider（用户名 + API Token 的 HTTP Basic 认证）：`service_credentials` 新增可空 `username` 列（Rust/Node 双 Host `ALTER TABLE` 迁移），保存时请求 `GET {base}/me/api/json` 校验、版本取 `X-Jenkins`；UI 表单按 `usernameLabel` 渲染用户名字段，`flowlet pull` 为 Jenkins 生成 `{PREFIX}_URL` / `{PREFIX}_USER` / `{PREFIX}_TOKEN`；CLI 新增 `flowlet jenkins set/status/api/env/clear`（`--profile` 多实例） |
| 镜像 | `flowlet:node-20261110-jenkins`（`sha256:9a0edca49b29b…`，248 MB）；从工作树（含并行会话当时未提交的 provider 扩展）完整构建，构建内 `tsc` 与 `build:web` 通过 |
| 部署 | 14:31:26 经 Dockhand stack 仅替换 `services.flowlet.image`；本次为蓝绿切换（新容器 `c2c88a68eda4` 先过 `/health` 与 `/v1/models`，旧容器优雅退出），切换 ≈2.9s、`/health` 最长不可用 2.70s；egress 未重建 |
| compose 备份 | `.agents/skills/flowlet-docker-deploy/.work/compose.before-20261110-143126.yaml` |
| 回滚 | `flowlet_deploy.py deploy --tag flowlet:node-20261110-fastshutdown6` |
| 验证（canary 9/9） | 新镜像临时容器（token 模式 + 空卷）：provider 列表含 jenkins 且元数据 exact（`usernameLabel` = 用户名、默认前缀 `JENKINS`）；缺用户名被拒；不可达实例返回 `校验失败，未保存：Jenkins API` 且不落库；`username` 列迁移成功；UI chunk 含 `Jenkins 用户设置` / `粘贴 API Token（与用户名一起使用）` / `_USER`；SPA 与 `/v1/models` 正常 |
| 验证（生产 9/9） | 容器镜像 = 新 tag、healthy；`/health` 200；`/api/auth/config` 仍 `mode=oidc` 且 `token_login=false`；容器内存在 `packages/flowlet-core/src/web/jenkins.ts`；UI chunk 含 Jenkins 文案；生产库 `service_credentials` 已有 `username` 列；`/v1/models` 200；SPA 200 |
| 并发说明 | 同一工作树有并行会话在开发 Beszel / Uptime Kuma provider（当时未提交）。本镜像包含其 Node 侧改动（`tsc` 通过），生产 provider 列表为 gitlab/dockhand/jenkins/uptime-kuma/beszel；并行会话后续若按「HEAD + 自身文件」隔离构建并部署，可能覆盖本镜像，需重新部署或提交后重建 |
