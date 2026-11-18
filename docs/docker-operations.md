# Docker 运维参考

首次安装请先看 [Docker 快速开始](docker.md)。本页用于配置登录、管理数据和维护实例，不是部署必读步骤。

- [Web Host 功能范围](#web-host-功能范围)
- [管理端 GitLab OIDC SSO](#管理端-gitlab-oidc-sso)
- [配置与数据](#配置与数据)
- [升级与停机窗口](#升级与停机窗口)
- [不使用 Docker 的开发运行](#不使用-docker-的开发运行)

## Web Host 功能范围

Docker 版使用 Node Host，提供浏览器管理台，可管理渠道账号、开放模型和路由，也可查看请求日志、会话和用量。它不会扫描服务器上的个人 Agent 配置或原生会话；本机 Agent 配置写入、桌面 WebView 抓取和设备同步仍使用桌面端。

用量统计只读取本服务自己的 SQLite：Web Host 在数据目录生成并复用与桌面端同格式的 `flowlet-device.json` 设备身份，「用量统计」中的「本机」就是该 Docker 实例，不扫描服务器上的个人数据，也不运行局域网直连或 S3 设备同步。费用展示设置（统一货币折算、目标币种、固定汇率和备注）保存在 SQLite `app_meta`，由「设置 → 费用展示」维护，不写入容器内的 `config.json`；`config.json` 的 `usage_cost` 仍只影响桌面端。

Web Host 与桌面端执行同一组后台维护任务：每 15 分钟做一次存储清理（请求/响应 Body 的过期与超限清理、余额快照保留策略），每 1 小时同步一次 models-cn 与 models.dev 目录；两者都写入后台任务日志、不依赖管理页面是否打开。设置页提供与桌面端一致的「内容捕获与保留策略」区块，可开关 Body 捕获、设置保留天数/体积上限并开启敏感 Header 脱敏，保存后下一次请求立即生效，清理任务也按同一份配置执行。

本机 Agent 自动发现/写入配置、原生会话采集、桌面 WebView 控制台抓取和本机 OAuth 授权仍使用桌面端。Web 版不会扫描服务器上的个人 Agent 配置。

第三方服务凭据的安装、授权、同步与撤销见[凭据 CLI](credential-cli.md)。

「会话管理」在 Web 版只聚合经过本实例代理的请求观测：按请求携带的 Agent 类型与会话标识聚合客户端、请求数、成功/失败数、Token、预估费用和最近活动时间，并支持客户端筛选、会话标题/项目目录搜索、子会话查看和跳转请求日志。它不读取服务器本机 Agent 原生会话文件，因此不展示原生用量、原生时间线，也不提供 OpenCode 实时权限确认；这些能力仍需在桌面端使用。文件夹级别的原生会话上报仍依赖桌面端设备同步，Web 版不参与。

会话行的**标题与项目目录**由代理侧从已读入内存的请求体派生（标题取该会话第一条人类消息，项目取请求体里的工作目录，如 Claude Code 的 `Primary working directory`、Codex 的 `<environment_context><cwd>`），存入 SQLite `agent_session_metadata` 并合并进会话聚合，详见 [agent-session-metadata.md](agent-session-metadata.md)。派生值不依赖 `log_capture`（Body 未捕获也生效）、不要求客户端安装插件；代价是**近似值**：客户端里手工改的会话名不会同步，请求体里没有工作目录的 Agent（如 DSH）只显示标题。

服务启动 30 秒后会自动同步一轮官方余额，之后每 5 分钟一轮：DeepSeek、Kimi、OpenRouter、VibeToken 等提供官方余额 API 的渠道由服务端直接查询并写入余额快照，不依赖管理页面是否打开，账号与渠道改动在下一轮生效、无需重启。**Qwen 账号在管理台完成一次「登录千问平台」后也参与这轮周期同步**：Node Host 直接调用千问平台 HTTP 接口拉取余额、免费额度与 Token Plan 订阅，不再依赖 WebView；未登录的 Qwen 账号会被跳过（不刷失败日志）。LongCat、Z.AI 与自定义渠道仍依赖桌面端隐藏 WebView 抓取控制台，Web Host 不支持该能力，需要在桌面端同步或手动维护余额。

## 管理端 GitLab OIDC SSO

默认的静态 Token 模式不需要 GitLab。如需开放公网访问，先为管理和模型入口配置 HTTPS 反代并限制来源端口直连。设置 `FLOWLET_PUBLIC_WEB_URL` 为用户在浏览器实际访问的管理台地址，设置 `FLOWLET_PUBLIC_PROXY_URL` 为 Agent 实际访问的模型入口根地址（不含 `/v1`）。

1. 在 GitLab 创建 OAuth 应用，回调登记为 `<管理台外部地址>/api/auth/callback`，至少启用 `openid` scope。
2. 在 `.env` 配置下列变量。使用真实的 HTTPS 地址和你自己的应用凭据，Secret 不要提交到仓库。

```dotenv
FLOWLET_ADMIN_AUTH_MODE=oidc
FLOWLET_PUBLIC_WEB_URL=https://flowlet.example.com
FLOWLET_OIDC_ISSUER=https://gitlab.example.com
FLOWLET_OIDC_CLIENT_ID=<GitLab Application ID>
FLOWLET_OIDC_CLIENT_SECRET=<GitLab Secret>
FLOWLET_OIDC_SCOPES=openid
FLOWLET_OIDC_ALLOWED_SUBS=<首位管理员的 GitLab sub>
```

3. 执行 `docker compose up -d` 应用环境配置，打开管理台并验证登录。浏览器访问地址必须与 `FLOWLET_PUBLIC_WEB_URL` 一致（包括协议和端口）。

管理凭据、调用密钥各自鉴权，不能混用。未配置 `FLOWLET_CLIENT_TOKEN` 时，首次启动生成并保存到数据卷；不要把管理凭据交给 Agent。OIDC 的 CLI 同步使用 [独立浏览器授权](credential-cli.md)，不需要开 Bearer 兜底。如需回退，可改回 `FLOWLET_ADMIN_AUTH_MODE=token`，设置 `FLOWLET_ADMIN_TOKEN` 后重新创建容器。

### 在管理台里自助配置（推荐）

部署只负责「这个 GitLab 能连上、应用凭据对不对」；**谁能登录、谁能管理、启用哪些登录方式**都在
管理台「设置 → 登录与访问」里改，保存即热生效，不用改 compose、不用重启容器：

| 项 | 作用 |
| --- | --- |
| 启用 OIDC 登录 / 启用 GitHub 登录 | 登录页出现哪些入口。可以只开一个；两个都关需要打开 `FLOWLET_ADMIN_ALLOW_TOKEN_LOGIN=1`，否则保存会被拒绝（防止把自己锁在门外） |
| 可登录（用户 ID / 邮箱） | 准入名单。GitLab 用户 ID 就是 `sub`（Users 设置页可见） |
| 可登录组（GitLab 组完整路径） | 组内成员都能登录，默认**只读** |
| 可登录邮箱域 | 同组，默认只读；放得太宽等于全公司可见服务凭据 |
| 管理员（用户 ID / 邮箱） | 命中者是管理员，可以改配置；其余可登录者只读。不填时「可登录」里直接列出的个人是管理员，按组/域进来的只读 |

库内配置优先于 `FLOWLET_OIDC_ALLOWED_*` / `FLOWLET_OIDC_ADMIN_*` 环境变量；点「移除界面配置」
后准入回落到环境变量。**issuer、discovery 地址、client 凭据、回调地址仍然以部署环境变量为准**
（回调地址要逐字登记在 GitLab 应用里，容器也要能访问到 GitLab，这些是应用进程无法自证的），
界面只展示部署信息，不接受修改这些字段，也不把部署 Secret 复制到 SQLite。
SQLite 仅新增 `app_meta` 的 OIDC 准入/展示覆盖和登录方式开关，无表结构迁移。
禁用入口拒绝未完成的登录回调，已有会话继续有效；准入和角色修改在下次登录时使用。
移除 OIDC 覆盖保留入口开关，恢复启动时的部署默认。

## 配置与数据

| 环境变量 | 默认值 / 用途 |
| --- | --- |
| `FLOWLET_ADMIN_AUTH_MODE` | `token`（默认）或 `oidc` |
| `FLOWLET_ADMIN_TOKEN` | token 模式必填（至少 24 字符）；oidc 模式仅在 `FLOWLET_ADMIN_ALLOW_TOKEN_LOGIN=1` 时需要 |
| `FLOWLET_ADMIN_ALLOW_TOKEN_LOGIN` | OIDC 模式下是否允许 Bearer token 兜底，默认 `0`；**CLI 同步凭据不需要它**（`flowlet login` 走独立作用域 token） |
| `FLOWLET_PUBLIC_WEB_URL` | OIDC 模式必填；浏览器访问管理台的绝对地址，如 `https://flowlet.example.com` |
| `FLOWLET_OIDC_ISSUER` | OIDC 提供器的 issuer，如 `https://gitlab.example.com` |
| `FLOWLET_OIDC_DISCOVERY_URL` | 可选；issuer 为 http 时必填且必须 https |
| `FLOWLET_OIDC_ALLOW_HTTP_ISSUER` | 允许 issuer 为 http（旧自建 GitLab），需同时提供 https discovery |
| `FLOWLET_OIDC_CLIENT_ID` / `FLOWLET_OIDC_CLIENT_SECRET` | GitLab OAuth 应用凭据 |
| `FLOWLET_OIDC_SCOPES` | 默认 `openid`；其他 scope 由你的提供器决定 |
| `FLOWLET_OIDC_ALLOWED_SUBS` | 允许指定 GitLab 用户的 `sub` |
| `FLOWLET_OIDC_ALLOWED_GROUPS` | 可选；多人时用 GitLab 组完整路径 |
| `FLOWLET_OIDC_PKCE` | `auto`（默认）/`required`/`off` |
| `FLOWLET_OIDC_NONCE` | `required`（默认）/`best_effort`/`off` |
| `FLOWLET_ADMIN_SESSION_IDLE_MINUTES` / `FLOWLET_ADMIN_SESSION_TTL_HOURS` | 会话空闲/绝对超时，默认 30 分钟 / 8 小时 |
| `FLOWLET_CLIENT_TOKEN` | 可选；提供时覆盖已保存的调用密钥 |
| `FLOWLET_WEB_PORT` | Compose 宿主机 Web 端口，默认 `20134` |
| `FLOWLET_PROXY_PORT` | Compose 宿主机模型入口端口，默认 `20135` |
| `FLOWLET_PUBLIC_PROXY_URL` | 在界面显示的模型入口，不含 `/v1`；端口映射或反向代理部署时应填写 |
| `FLOWLET_PUBLIC_A2A_URL` | Node Host 的 A2A 对外根地址，如 `https://flowlet.example.com`；反代时填写，用于 Agent Card，改变需重启 |
| `FLOWLET_BIND_ADDR` | 容器内默认 `0.0.0.0:18640` |
| `FLOWLET_WEB_ADDR` | 容器内默认 `0.0.0.0:8080` |
| `FLOWLET_DB_PATH` | `/data/flowlet.sqlite` |
| `FLOWLET_CONFIG_PATH` | 数据库同目录的 `config.json`，不存在时生成内置默认副本 |
| `FLOWLET_STATIC_DIR` | `/app/ui` |
| `FLOWLET_CATALOG_DIR` | `/data/catalogs`，价格目录同步文件持久化位置 |
| `FLOWLET_SHUTDOWN_ABORT_MS` | 进程退出时在途请求的宽限毫秒数，默认 `250`；超时后强制断开连接，避免容器 stop 被长 SSE 拖到 `stop_grace_period` |
| `FLOWLET_SHUTDOWN_HARD_EXIT_MS` | 关闭硬超时毫秒数，默认 `2000`；超过后直接退出进程 |
| `RUST_LOG` | `info`（Rust 版；Node Host 不使用） |
| `NODE_ENV` | `production`（Node Host） |

Compose 使用命名卷 `flowlet-data` 持久化 `/data`；容器以 UID/GID `10001:10001` 运行。自定义绑定目录时需赋予该用户写权限。
不新增 Docker 专用数据库表，沿用现有 SQLite schema/migration；Web 保存的账号、路由与余额记录和桌面端使用相同结构。不会自动导入本机桌面数据。

渠道账号与路由保存后立即发布到代理运行时，不需重启。上游代理设置会影响后续新建连接。监听地址/调用密钥修改后重启代理；环境变量和手动修改的 `config.json` 在容器重启后生效。Web「刷新模型」重读当前数据；渠道预设来源文件变更需重启容器。

备份完整数据卷前先停止服务，避免仅复制正在写入的 SQLite 主文件而遗漏 WAL：

```bash
docker compose stop flowlet
# 使用现有的卷备份工具备份 flowlet-data 的全部内容
docker compose start flowlet
```

不要运行 `docker compose down -v`，除非明确需要删除所有账号与日志。
升级代码后运行 `docker compose up -d --build`，保留同一个数据卷。`/health` 是无需凭据的进程存活检查，Dockerfile 已配置 healthcheck；健康并不代表上游渠道可用。

构建时若 Debian 官方源较慢，可在 `.env` 中设置 `DEBIAN_MIRROR=http://mirrors.tuna.tsinghua.edu.cn` 后重新构建。替换范围仅限构建容器的软件源，仍使用 Debian 仓库签名验证；参见 [TUNA Debian 镜像说明](https://mirrors.tuna.tsinghua.edu.cn/help/debian/)。Docker Hub 基础镜像需要由宿主机拉取，`DEBIAN_MIRROR` 不替代 Docker 镜像仓库。

## 升级与停机窗口

使用仓库 Compose 部署的实例，先备份整个 `flowlet-data`，再更新源码并运行 `docker compose up -d --build`；保留原数据卷。容器替换会中断一段时间，在途长流式请求可能断开。`/health` 只验证进程可用；升级后还应验证管理登录和实际模型调用。

已有独立反向代理或出口组件的自定义部署，应按实例的发布流程切换，避免无关容器一起重建。历史实例和迁移记录见 [Node Host Docker 迁移档案](archive/tauri-migration/docker-node.md)，不是新部署步骤或停机承诺。

## 不使用 Docker 的开发运行

```bash
npm ci
npm run build:web
scripts/run-node-host.sh
```

脚本可能准备开发数据副本；运行前核对其数据来源，不要复用生产数据库。端到端冒烟：`npm run node:e2e`。
