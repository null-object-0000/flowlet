# Docker 与浏览器部署

> **迁移状态（2026-11，分支 `migrate/electron`）**：Docker 版正在从 Rust `headless` 二进制迁移到
> **Node Host**（`packages/flowlet-core`，Node 26 直接执行 TypeScript）。迁移目标是行为等价替换：
> 镜像不再包含 Rust 工具链与编译产物，环境变量、端口、`/data` 数据卷、SQLite schema、管理端
> 鉴权（token / GitLab OIDC）全部保持相同契约。当前线上实例（10.100.217.60）已于 **2026-11-10 切换为 Node Host 镜像**
> `flowlet:docker-20261110-nodehost`（回滚点 `flowlet:docker-20261109-gitlab-sso`）。实现契约见 [migration/node-host.md](migration/node-host.md)，
> 镜像与冒烟记录见 [migration/docker-node.md](migration/docker-node.md)。

Docker 版由独立服务和 React 管理界面组成，不需要 Tauri、GTK、显示服务或桌面登录会话。
使用与桌面端相同的渠道适配器、模型白名单、SQLite 存储和运行时路由。管理台支持静态管理凭据（token 模式）或 GitLab OIDC 单点登录（oidc 模式，见下文）。当前支持 API Key 渠道账号的新增、编辑、启停、删除、模型列表拉取、模型及候选路由启停/优先级调整、请求日志、「会话管理」，以及与桌面端一致的「用量统计」「用量洞察」页面（设备切换、日/周/月热力图、Token 明细、费用折算和未识别 Token 请求明细）。

用量统计只读取本服务自己的 SQLite：Web Host 在数据目录生成并复用与桌面端同格式的 `flowlet-device.json` 设备身份，「用量统计」中的「本机」就是该 Docker 实例，不扫描服务器上的个人数据，也不运行局域网直连或 S3 设备同步。费用展示设置（统一货币折算、目标币种、固定汇率和备注）保存在 SQLite `app_meta`，由「设置 → 费用展示」维护，不写入容器内的 `config.json`；`config.json` 的 `usage_cost` 仍只影响桌面端。

Web Host 与桌面端执行同一组后台维护任务：每 15 分钟做一次存储清理（请求/响应 Body 的过期与超限清理、余额快照保留策略），每 1 小时同步一次 models-cn 与 models.dev 目录；两者都写入后台任务日志、不依赖管理页面是否打开。设置页提供与桌面端一致的「内容捕获与保留策略」区块，可开关 Body 捕获、设置保留天数/体积上限并开启敏感 Header 脱敏，保存后下一次请求立即生效，清理任务也按同一份配置执行。

本机 Agent 自动发现/写入配置、原生会话采集、桌面 WebView 控制台抓取和本机 OAuth 授权仍使用桌面端。Web 版不会扫描服务器上的个人 Agent 配置。

「服务凭据」页面集中管理 Agent 接入所需的三方服务 token（provider：GitLab API v4，按 CE 10.8.7 实现；Dockhand 面板 API，Bearer Token）：token 经 ChaCha20-Poly1305 加密后存 SQLite，密钥文件 `secret.key` 在 `/data` 下并随命名卷备份；管理接口只返回 `••••1234` 掩码，保存时会实际请求上游校验（GitLab `GET /api/v4/user`、Dockhand `GET /api/environments`），失败不落库。同 provider 多实例用「环境别名（Env 前缀）」区分，`flowlet pull` 生成 `{PREFIX}_URL` / `{PREFIX}_TOKEN`（如三份 Dockhand 得到 `DOCKHAND_NA_URL` / `DOCKHAND_SZ_URL` / `DOCKHAND_SELF_URL`）。页面还提供「本机接入」下载引导：可直接下载 `install-flowlet.sh`、CLI 与 Skills 包（`/downloads/`），用一条 `curl ... | sh` 命令在 Agent 机器安装 `flowlet`。安装后在 Agent 机器上执行
`flowlet login --server=http://<服务器地址>:20134`，在浏览器用公司 SSO 完成授权（loopback + PKCE），
CLI 只保存一把 **仅能读服务凭据** 的本机授权（`~/.config/flowlet/credentials/auth.json`，30 天有效，
可在管理台「服务凭据 → 本机接入 → 已授权的 CLI」撤销）；随后
`flowlet pull --server=http://<服务器地址>:20134` 把启用中的凭据同步到本地
`~/.config/flowlet/credentials/credentials.env`，Agent 继续读本机 `.env` 或用 `flowlet run` 注入；
服务端不向 Agent 下发明文以外的任何凭据管理能力。OIDC-only 实例**不需要**开启
`FLOWLET_ADMIN_ALLOW_TOKEN_LOGIN`，也不需要把管理凭据交给 Agent 机器；`--token` 只在 token 模式实例
（或显式保留了 Bearer 兜底的实例）使用。

「会话管理」在 Web 版只聚合经过本实例代理的请求观测：按请求携带的 Agent 类型与会话标识聚合客户端、请求数、成功/失败数、Token、预估费用和最近活动时间，并支持客户端筛选、会话标题/项目目录搜索、子会话查看和跳转请求日志。它不读取服务器本机 Agent 原生会话文件，因此不展示原生用量、原生时间线，也不提供 OpenCode 实时权限确认；这些能力仍需在桌面端使用。文件夹级别的原生会话上报仍依赖桌面端设备同步，Web 版不参与。

会话行的**标题与项目目录**由代理侧从已读入内存的请求体派生（标题取该会话第一条人类消息，项目取请求体里的工作目录，如 Claude Code 的 `Primary working directory`、Codex 的 `<environment_context><cwd>`），存入 SQLite `agent_session_metadata` 并合并进会话聚合，详见 [agent-session-metadata.md](agent-session-metadata.md)。派生值不依赖 `log_capture`（Body 未捕获也生效）、不要求客户端安装插件；代价是**近似值**：客户端里手工改的会话名不会同步，请求体里没有工作目录的 Agent（如 DSH）只显示标题。

## 启动

需要 Docker Engine 和 Compose 插件。仓库提供的是源码构建方案，目前没有预先发布的官方 Flowlet 容器镜像。

```bash
cp .env.docker.example .env
# 用下面命令生成随机字符串，填到 .env 的 FLOWLET_ADMIN_TOKEN
openssl rand -hex 32
# 把 FLOWLET_PUBLIC_PROXY_URL 改为客户端可访问的服务器地址，如 http://10.100.217.60:20135
docker compose up -d --build
docker compose logs -f flowlet
```

默认管理界面为 `http://服务器地址:20134`。默认 token 模式输入 `FLOWLET_ADMIN_TOKEN` 登录；
配置 `FLOWLET_ADMIN_AUTH_MODE=oidc` 后改为 GitLab 授权登录（见「管理端 GitLab OIDC SSO」）。
模型调用的 OpenAI Base URL 为 `http://服务器地址:20135/v1`，Anthropic Base URL 为 `http://服务器地址:20135/anthropic`，Responses 使用 `/v1/responses`。
调用密钥可在「渠道账号 → 显示调用密钥」查看。先添加渠道账号、拉取并勾选需要开放的模型，再到「模型服务」调整候选渠道/账号的启停和优先级。

服务启动 30 秒后会自动同步一轮官方余额，之后每 5 分钟一轮：DeepSeek、Kimi、OpenRouter、VibeToken 等提供官方余额 API 的渠道由服务端直接查询并写入余额快照，不依赖管理页面是否打开，账号与渠道改动在下一轮生效、无需重启。LongCat、Qwen、Z.AI 与自定义渠道依赖桌面端隐藏 WebView 抓取控制台，Web Host 不支持该能力，需要在桌面端同步或手动维护余额。

管理凭据与模型调用密钥分别鉴权。管理凭据不能调用模型，调用密钥不能访问管理接口。未设置 `FLOWLET_CLIENT_TOKEN` 时，首次启动随机生成调用密钥并保存到数据卷，后续重启继续使用。
token 模式的浏览器凭据仅保存在当前标签页的 sessionStorage 中；OIDC 模式改用 HttpOnly 会话 Cookie，
重启容器会使所有管理会话失效，需要重新登录。HTTP 部署下 Cookie 不带 `Secure`，只应在可信内网使用；
需要公网访问时请在入口配置 HTTPS。

构建时若 Debian 官方源较慢，可在 `.env` 中设置 `DEBIAN_MIRROR=http://mirrors.tuna.tsinghua.edu.cn` 后重新构建。替换范围仅限构建容器的软件源，仍使用 Debian 仓库签名验证；参见 [TUNA Debian 镜像说明](https://mirrors.tuna.tsinghua.edu.cn/help/debian/)。Docker Hub 基础镜像需要由宿主机拉取，`DEBIAN_MIRROR` 不替代 Docker 镜像仓库。

## 管理端 GitLab OIDC SSO

目标实例：公司 GitLab（`https://git.17usoft.com`，GitLab CE 10.8.7 + 定制 OIDC）。
完整方案、M0 验证结果与安全边界见 [`admin-sso-design.md`](./admin-sso-design.md)。

1. 在 GitLab 创建 OAuth 应用（个人应用即可）：Redirect URI 填
   `http://10.100.217.60:20134/api/auth/callback`；Scopes **只勾 `openid`**；
2. 在 `.env` 配置：

```bash
FLOWLET_ADMIN_AUTH_MODE=oidc
FLOWLET_PUBLIC_WEB_URL=http://10.100.217.60:20134
FLOWLET_OIDC_ISSUER=http://git.17usoft.com
FLOWLET_OIDC_DISCOVERY_URL=https://git.17usoft.com/.well-known/openid-configuration
FLOWLET_OIDC_ALLOW_HTTP_ISSUER=1
FLOWLET_OIDC_CLIENT_ID=<Application ID>
FLOWLET_OIDC_CLIENT_SECRET=<Secret>
FLOWLET_OIDC_SCOPES=openid
FLOWLET_OIDC_DISPLAY_NAME=GitLab
FLOWLET_OIDC_ALLOWED_SUBS=<你的 GitLab sub>
FLOWLET_OIDC_PKCE=auto
FLOWLET_OIDC_NONCE=required
```

3. `docker compose up -d` 重启容器；打开管理台应显示「使用 GitLab 登录」。
   访问地址必须与 `FLOWLET_PUBLIC_WEB_URL` 完全一致（含 scheme/端口），否则 CSRF Origin 校验会拒绝。
4. 回退：把 `FLOWLET_ADMIN_AUTH_MODE` 改回 `token` 并设置随机 `FLOWLET_ADMIN_TOKEN`，重启即可；
   `ALLOW_TOKEN_LOGIN=1` 可在 OIDC 故障时保留 Bearer 兜底登录。

OIDC 模式不内置任何 client secret；GitLab 应用 Secret 只放在 `.env`/部署密钥中，不要提交仓库。
会话保存在进程内存，容器重启后所有人需要重新登录；当前为单管理员/单实例设计。

**CLI 凭据同步的授权方式**：OIDC 模式下管理台不接受静态管理 Bearer，`ALLOW_TOKEN_LOGIN`
默认关闭且**不应为了让 Agent 机器同步凭据而打开**。CLI 走独立的浏览器授权：Agent 机器执行
`flowlet login --server=http://<服务器地址>:20134` 打开授权页（复用当前管理台登录状态 + CSRF），
签发一把作用域仅 `credentials:read`、TTL 30 天的 token，只能调
`export_service_credentials`（其它命令 403）；之后 `flowlet pull --server=...` 自动使用它。
授权页面本身先 `GET /api/session` 判断模式：token 模式会提示改用
`flowlet pull --server=<origin> --token=<管理凭据>`，OIDC 模式才展示授权按钮。撤销在
「服务凭据 → 本机接入 → 已授权的 CLI」逐条进行。

> 注意：`--token` 仅适用于 token 模式（或显式 `FLOWLET_ADMIN_ALLOW_TOKEN_LOGIN=1` 的紧急兜底）。
> 线上 OIDC-only 实例（20134）用它必然 401，而 `flowlet login` 不需要也不接受任何管理凭据。

## 配置与数据

| 环境变量 | 默认值 / 用途 |
| --- | --- |
| `FLOWLET_ADMIN_AUTH_MODE` | `token`（默认）或 `oidc` |
| `FLOWLET_ADMIN_TOKEN` | token 模式必填（至少 24 字符）；oidc 模式仅在 `ALLOW_TOKEN_LOGIN=1` 时需要 |
| `FLOWLET_ADMIN_ALLOW_TOKEN_LOGIN` | OIDC 模式下是否允许 Bearer token 兜底，默认 `0`；**CLI 同步凭据不需要它**（`flowlet login` 走独立作用域 token） |
| `FLOWLET_PUBLIC_WEB_URL` | OIDC 模式必填；浏览器访问管理台的绝对地址，如 `http://10.100.217.60:20134` |
| `FLOWLET_OIDC_ISSUER` | OIDC issuer；目标 GitLab 为 `http://git.17usoft.com` |
| `FLOWLET_OIDC_DISCOVERY_URL` | 可选；issuer 为 http 时必填且必须 https |
| `FLOWLET_OIDC_ALLOW_HTTP_ISSUER` | 允许 issuer 为 http（旧自建 GitLab），需同时提供 https discovery |
| `FLOWLET_OIDC_CLIENT_ID` / `FLOWLET_OIDC_CLIENT_SECRET` | GitLab OAuth 应用凭据 |
| `FLOWLET_OIDC_SCOPES` | 默认 `openid`；目标 GitLab 不支持请求 profile/email |
| `FLOWLET_OIDC_ALLOWED_SUBS` | 单用户准入：GitLab 用户 `sub`，v1 目标实例使用此项 |
| `FLOWLET_OIDC_ALLOWED_GROUPS` | 可选；多人时用 GitLab 组完整路径 |
| `FLOWLET_OIDC_PKCE` | `auto`（默认）/`required`/`off` |
| `FLOWLET_OIDC_NONCE` | `required`（默认）/`best_effort`/`off` |
| `FLOWLET_ADMIN_SESSION_IDLE_MINUTES` / `FLOWLET_ADMIN_SESSION_TTL_HOURS` | 会话空闲/绝对超时，默认 30 分钟 / 8 小时 |
| `FLOWLET_CLIENT_TOKEN` | 可选；提供时覆盖已保存的调用密钥 |
| `FLOWLET_WEB_PORT` | Compose 宿主机 Web 端口，默认 `20134` |
| `FLOWLET_PROXY_PORT` | Compose 宿主机模型入口端口，默认 `20135` |
| `FLOWLET_PUBLIC_PROXY_URL` | 在界面显示的模型入口，不含 `/v1`；端口映射或反向代理部署时应填写 |
| `FLOWLET_BIND_ADDR` | 容器内默认 `0.0.0.0:18640` |
| `FLOWLET_WEB_ADDR` | 容器内默认 `0.0.0.0:8080` |
| `FLOWLET_DB_PATH` | `/data/flowlet.sqlite` |
| `FLOWLET_CONFIG_PATH` | 数据库同目录的 `config.json`，不存在时生成内置默认副本 |
| `FLOWLET_STATIC_DIR` | `/app/ui` |
| `FLOWLET_CATALOG_DIR` | `/data/catalogs`，价格目录同步文件持久化位置 |
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

## 不使用 Docker 的开发运行

Node Host（迁移后的默认形态，无需 Rust 工具链）：

```bash
npm ci
npm run build:web
scripts/run-node-host.sh          # 复制数据副本到 .flowlet-dev-data/ 后启动
# 等价于：node packages/flowlet-core/src/index.ts
```

端到端冒烟：`node scripts/e2e-node-host.mjs`；Rust↔Node 对拍：`node scripts/web-parity.mjs`。

Rust 版（回滚/对照用）：

```bash
export FLOWLET_ADMIN_TOKEN="$(openssl rand -hex 32)"
cargo run --manifest-path src-tauri/Cargo.toml --no-default-features --bin headless
```

默认监听 `127.0.0.1:8080` 和 `127.0.0.1:18640`，数据库位于 `flowlet-data/`。
桌面构建继续使用默认 Cargo feature；独立服务通过 `--no-default-features --bin headless` 排除桌面依赖。
