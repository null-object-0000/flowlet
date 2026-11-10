# 全局凭据库与 `flowlet`

状态：v7（**新增 OCI 镜像仓库（registry）provider（标准 Docker Registry HTTP API V2 / OCI
Distribution：`GET /v2/` + `WWW-Authenticate` Bearer 质询）**）；
`flowlet registry` 子命令、`pull` 为 registry 生成 `{PREFIX}_HOST` / `{PREFIX}_USER` / `{PREFIX}_TOKEN`。
v6 新增 Beszel provider（邮箱 + 密码换短期 token，PocketBase 底座）；
`flowlet beszel` 子命令、`pull` 为 Beszel 生成 `{PREFIX}_URL` / `{PREFIX}_EMAIL` / `{PREFIX}_PASSWORD`。
v5 新增 Jenkins provider（用户名 + API Token 的 Basic 认证），服务凭据支持用户名字段；
`flowlet jenkins` 子命令、`pull` 为 Jenkins 生成 `{PREFIX}_URL` / `{PREFIX}_USER` / `{PREFIX}_TOKEN`。
v4 新增 `flowlet login` 浏览器授权（loopback + PKCE）：OIDC-only 实例不再需要管理凭据；
v3 起用户侧命令统一为 `flowlet`，并支持同 provider 多实例环境前缀与 `--profile`、Web Host 下载安装引导。
Node 版 CLI 为默认实现；Rust 版二进制名仍为 `flowlet-cred`，标为 legacy，仅用于对拍）
日期：2026-11-10（v1：Node 移植完成；v2：新增 Dockhand provider；v3：CLI 更名 `flowlet` +
多实例 env 前缀 + 本机接入下载；v4：`flowlet login` 浏览器授权 + 本机 `auth.json`；
v5：Jenkins provider + 服务凭据用户名字段；v6：Beszel provider；v7：OCI 镜像仓库 provider）

## 1. 定位

Flowlet 的凭据分两种，**不要混为一谈**：

| 类型 | 用途 | 现状 |
|---|---|---|
| 调用密钥（client token） | 客户端/Agent 调用 Flowlet 模型入口时出示 | `ProxyBindConfig.default_client_token` |
| **三方服务凭据** | Agent 接入后要用的 Anthropic/OpenAI/GitHub/Tavily、CLI token、MCP token 等 | 本文档描述的全局凭据库 |

全局凭据库要解决的是：三方 key 原本散落在各 Agent 的配置文件、MCP 的 `env`/`headers`、
临时环境变量里；现在集中到一份 dotenv，由 CLI 统一写入，Agent 按需读取或用 CLI 注入。

> **命令名**：用户侧统一是 `flowlet`（第二期由 `flowlet-cred` 更名，不保留别名）。
> 仓库内仍保留 Rust legacy 二进制 `flowlet-cred` 仅用于兼容性对拍，见 §3.3。

## 2. 存储布局

凭据有两个落点，职责不同：

- **服务端（Docker / 桌面）**：管理面配置的凭据，加密存在 SQLite；
- **本机 CLI**：`.env` 文件，供 Agent 直接读取 / `source`。

### 2.1 本机 CLI 存储

```text
<config_dir>/flowlet/credentials/
  credentials.env     # 唯一事实源，dotenv 格式，权限 0600
  credentials.json    # 元数据 sidecar：kind / note / created_at / updated_at，权限 0600
  auth.json           # v4 新增：flowlet login 的本机授权（server → token），权限 0600
```

- Linux/macOS：`~/.config/flowlet/credentials/`；Windows：`%APPDATA%\flowlet\credentials\`；
- 可用 `FLOWLET_CRED_DIR` 覆盖（测试、容器内固定路径）；
- 目录用 `0700`，文件用 `0600`；写入是临时文件 + rename 的原子替换，不会留下半截文件；
- `.env` 里的注释与未知行会被保留，重复键以最后一次出现为准（`doctor` 会告警）；
- `auth.json` 只存 `flowlet login` 拿到的 token（`flwcli_…`），与 `credentials.env` 同目录；
  token 只用于 `flowlet pull`，不会写进 `.env`，也不会被 `list` / `env` 输出。

`credentials.env` 示例（文件头由 CLI 维护，Rust legacy 写同一份文案，逐字节一致）：

```dotenv
# Flowlet 全局凭据库
# 由 `flowlet` 维护；请在 CLI 中增删（原子写 + 0600），不要手工重排此文件。
# 读取：Agent 可 cat 本文件；写入：请用 `flowlet set KEY`。
GITHUB_PAT=ghp_xxx
TAVILY_API_KEY='tvly-xxx'
DOCKHAND_NA_URL=http://10.177.40.105:3000
DOCKHAND_NA_TOKEN='••••'
```

值只在安全字符时裸写，否则用单引号并转义内部单引号（可被 `source` 或被常见 dotenv 解析器读取）。

### 2.2 服务端存储（管理面）

```text
<data_dir>/secret.key              # 32 字节随机密钥，0600，首次启动生成
SQLite service_credentials 表       # id / name / provider / base_url / username / env_prefix /
                                   # secret_ciphertext（ChaCha20-Poly1305）/ secret_hint /
                                   # kind / note / enabled / 时间戳 / 最近校验结果
```

- `username` 是可空列（v5 新增）：Jenkins 与 OCI 镜像仓库（v7）存登录用户名、Beszel 存登录邮箱，
  明文存储；GitLab / Dockhand 的行为 NULL；旧库升级时 `ALTER TABLE` 补列，无需回填。

- `env_prefix` 是第二期新增的可空列（旧行 NULL）：存**解析后的大写前缀**，读取时 NULL 按
  provider 默认值解析，升级后行为与第一期一致；
- 数据目录：Docker 是 `/data`（命名卷 `flowlet-data`），桌面是 SQLite 所在目录或便携目录；
- 密文格式 `v1:<base64(nonce||ciphertext)>`，接口只返回 `••••` + 末 4 位；
- 密钥文件与卷一起备份；密钥丢失等于凭据不可解密，需要重新填写。

## 3. CLI

### 3.1 运行方式（Node 默认，Rust legacy）

Node 版位于 `packages/flowlet-cred/`，需要 **Node.js 22.6+**（本仓库 Node 26）直接跑 TS，无构建步骤。
Node 22.6–22.17 的类型剥离仍需 `--experimental-strip-types`，`bin/flowlet.mjs` 会自动检测版本并
补 flag（22.18+/23.6+ 起默认开启）；低于 22.6 会以明确文案退出。package.json 已声明
`"engines": { "node": ">=22.6" }`。

```bash
# 推荐：从仓库根目录用 npm script（参数照常跟在 -- 后）
npm run flowlet -- init
npm run flowlet -- get KEY --reveal

# 或直接运行入口（等价）
node packages/flowlet-cred/src/cli.ts init

# 需要全局命令时
npm link ./packages/flowlet-cred && flowlet init   # bin shim: bin/flowlet.mjs
```

Agent 机器不需要仓库，直接用 Web Host 页面提供的下载安装脚本（见 §14）：

```bash
curl -fsSL http://<flowlet-host>:20134/downloads/install-flowlet.sh \
  | sh -s -- --base=http://<flowlet-host>:20134/downloads
```

Rust legacy 版（仅兼容性对拍/回滚用，Agent 机器不再需要；二进制名仍为 `flowlet-cred`，
Cargo feature `legacy-cred` 默认关闭，需要时显式开启）：

```bash
cargo build --release --manifest-path src-tauri/Cargo.toml \
  --no-default-features --features legacy-cred --bin flowlet-cred
# 产物：src-tauri/target/release/flowlet-cred
```

### 3.2 命令

```bash
flowlet init                                     # 初始化目录与空文件
flowlet path                                     # 打印当前 .env 路径
flowlet list [--json]                            # 名字/类型/备注/更新时间，永不含值
flowlet get <KEY> [--reveal]                     # 默认掩码；--reveal 才输出明文（--mask 兼容旧脚本）
flowlet set <KEY> [--kind=K] [--note=N]          # 值从 stdin 读，或 --value=V
flowlet unset <KEY>
flowlet clear                                    # 清空全部凭据（保留注释与文件头；Node 新增）
flowlet env [--only=A,B]                         # 输出 dotenv
flowlet export [--only=A,B] --format=dotenv|shell|json
flowlet run --with=A,B -- <程序> [参数...]        # 只注入指定凭据到子进程
flowlet doctor                                   # 权限/重复键/元数据检查

# 远程同步（Docker / Web Host 管理的凭据 → 本机 .env）
flowlet login --server=http://host:20134 [--name=机器名] [--no-browser] [--insecure] [--timeout=180]
                                                 # 浏览器 SSO 授权，只保存仅能读服务凭据的本机授权
flowlet logout --server=http://host:20134        # 删除本机该 server 的授权记录
flowlet pull --server=http://host:20134 [--dry-run] [--insecure]
                                                 # 从服务端同步到本机 .env；自动使用本机授权
                                                 # 兼容仍需管理凭据的 token 模式：--token= / FLOWLET_ADMIN_TOKEN

# provider 子命令都支持 --profile=<alias>（多实例，见 §5）
flowlet gitlab set --url=https://gitlab.example.com [--profile=WORK]
flowlet gitlab status [--insecure] [--profile=WORK]
flowlet gitlab projects [--search=S] [--limit=N] [--all] [--json] [--profile=WORK]
flowlet gitlab api GET /projects?per_page=10 [--profile=WORK]
flowlet gitlab env [--profile=WORK]
flowlet gitlab clear [--profile=WORK]

flowlet dockhand set --url=http://dockhand.example.com:3000 [--profile=NA]
flowlet dockhand status [--insecure] [--profile=NA]
flowlet dockhand envs [--json] [--profile=NA]
flowlet dockhand stacks --env=2 [--json] [--profile=NA]
flowlet dockhand api GET /environments [--profile=NA]
flowlet dockhand env [--profile=NA]
flowlet dockhand clear [--profile=NA]

flowlet jenkins set --url=https://jenkins.example.com --user=ci-bot [--profile=WORK]
flowlet jenkins status [--insecure] [--profile=WORK]
flowlet jenkins api GET /api/json?tree=jobs[name,color] [--profile=WORK]
flowlet jenkins env [--profile=WORK]
flowlet jenkins clear [--profile=WORK]

flowlet beszel set --url=http://beszel.example.com:8090 --email=you@example.com [--profile=MON]
                                                 # 密码从 stdin 读取；先认证校验通过才落库
flowlet beszel status [--insecure] [--profile=MON]        # URL、版本、登录邮箱、系统数量
flowlet beszel systems [--json] [--profile=MON]           # 系统列表（id/name/host/status/port）
flowlet beszel api GET /collections/systems/records [--profile=MON]
flowlet beszel env [--profile=MON]
flowlet beszel clear [--profile=MON]

flowlet registry set --url=hub.example.com --user=robot\$project+name [--profile=NA]
                                                 # token 从 stdin 读取；先校验通过才落库
flowlet registry status [--insecure] [--profile=NA]       # 仓库、Registry V2 认证、用户名
flowlet registry env [--profile=NA]                       # {PREFIX}_HOST / _USER / _TOKEN
flowlet registry clear [--profile=NA]
```

### 3.3 Node 与 Rust legacy 的已知差异

- `get` 默认**掩码**，需显式 `--reveal` 才输出明文（Rust legacy 默认明文、`--mask` 掩码）；
  `--mask` 在 Node 版继续可用，跨版本脚本不受影响。
- Node 版额外提供 `clear`（清空全部凭据，保留注释/文件头与权限）；Rust legacy 无此命令。
- Rust legacy **没有** `login` / `logout`，也**没有** `dockhand` 子命令、不支持 `--profile`；
  它是第一期行为的对拍基线：`gitlab` 子命令只读写默认前缀（`GITLAB_*`），`pull` 复用共享
  `env_keys` 写 `DOCKHAND_URL` / `DOCKHAND_TOKEN`（或导出条目里的 `envPrefix`），
  且只认 `--token` / `FLOWLET_ADMIN_TOKEN`（不读 `auth.json`）。
- Rust legacy 二进制名保持 `flowlet-cred`（Cargo 顶层 bin 名 `flowlet` 已被桌面端占用）；
  用户侧命令统一 `flowlet`，不保留 `flowlet-cred` 别名。
- 其余命令的输出、错误文案、dotenv/JSON 文件字节、权限（0700/0600）、原子写行为一致；
  `packages/flowlet-cred/scripts/compat.mjs` 用同一序列对 Rust legacy 与 Node CLI 做逐行对拍
  （路径/RFC3339 时间戳归一化），并验证双向交叉读取：

  ```bash
  npm run cred:compat     # 期望：输出与文件字节级一致
  npm run cred:test       # node:test（本地库 / GitLab mock / Dockhand mock / 多 profile / pull / 兼容性）
  npm run cred:typecheck  # tsc --noEmit
  ```

## 4. 远程登录授权（Docker / Web Host）

生产 Docker 实例（`10.100.217.60:20134`）已切 **OIDC-only**（`FLOWLET_ADMIN_AUTH_MODE=oidc`、
`FLOWLET_ADMIN_ALLOW_TOKEN_LOGIN=0`），管理面不再接受静态管理凭据的 Bearer 登录。
因此 `flowlet pull --token=<管理凭据>` 在这种实例上**必然 401**——CLI 需要一条基于浏览器
SSO 会话的授权路径，这就是 `flowlet login`。

### 4.1 流程

```bash
flowlet login --server=http://<flowlet-host>:20134 [--name=机器名] [--no-browser] [--insecure] [--timeout=180]
flowlet pull  --server=http://<flowlet-host>:20134
flowlet logout --server=http://<flowlet-host>:20134     # 需要时删除本机记录
```

1. CLI 生成 `state`（32 字节）与 PKCE verifier（32 字节），在 `127.0.0.1` 随机端口起 loopback
   回调服务（路径 `/callback`，端口占用会重试）；
2. 打开系统浏览器到 `<server>/api/auth/cli/start?redirect_uri=…&state=…&code_challenge=…`；
   终端同时打印授权 URL，浏览器打不开时可手动打开（`--no-browser` 只跳过自动打开）；
3. 授权页先查 `GET /api/session`：未登录提示先去管理台登录；token 模式提示直接用
   `--token`；OIDC 模式展示「允许 flowlet CLI 读取本机需要的服务凭据？」，点授权后
   `POST /api/commands/create_cli_auth_code`（Cookie 会话 + CSRF）拿到一次性授权码；
4. 浏览器回调 loopback，CLI 用 `code` + `codeVerifier` 调 `POST /api/auth/cli/exchange`，
   换回 `flwcli_…` token，写入 `auth.json`（目录 `0700`、文件 `0600`、原子写）。

`auth.json` 形状（server key 归一为 `scheme://host[:port]`）：

```json
{"version":1,"servers":{"http://10.100.217.60:20134":{"token":"flwcli_…","expiresAt":"…","name":"…","savedAt":"…"}}}
```

`flowlet pull` 的凭据解析优先级：`--token=T` > `FLOWLET_ADMIN_TOKEN` > 本机 `auth.json` 中该
server 的 token。三者都没有时报错：

```text
缺少凭据：先运行 flowlet login --server=<server>（或 --token=管理凭据 / FLOWLET_ADMIN_TOKEN）
```

用 `auth.json` 的 token 收到 401 时提示「登录已过期或被撤销，请重新 flowlet login --server=…」。

### 4.2 安全边界

- **不打开管理 Bearer 兜底**：OIDC 实例仍然 `ALLOW_TOKEN_LOGIN=0`。CLI 授权是一套独立
  机制，不走管理登录面。
- **作用域只有 `credentials:read`**：该 token 只能调用
  `POST /api/commands/export_service_credentials`；调用其它管理命令返回 403
  `{"code":"forbidden","message":"CLI 凭据仅可用于凭据同步"}`。它不能登录管理台、不能改配置、
  不能看日志。
- **只由已登录管理台的浏览器会话签发**：`create_cli_auth_code` 需要现有鉴权 + CSRF，CLI
  自己无法凭空换 token。
- **一次性授权码 + PKCE**：授权码 32 字节随机、120 秒有效、exchange 一次即删；回调地址只允许
  loopback（`http://127.0.0.1:<port>` / `http://localhost:<port>` / `http://[::1]:<port>`），
  校验 `base64url(sha256(codeVerifier))` 与 `code_challenge` 一致。
- **token 不落明文**：服务端只存 SHA-256 哈希；CLI 本机文件 `0600`；任何日志/终端输出都不
  打印明文 token（`--dry-run` 不改变这一行为）。
- **TTL 30 天 + 可撤销**：过期行由服务端在签发时惰性清理；「服务凭据 → 本机接入 → 已授权的
  CLI」列出所有授权（名称 / 创建时间 / 到期时间 / 最近使用）并可逐个撤销，撤销后该机器的
  `pull` 立即 401。本机删除用 `flowlet logout --server=…`（只删本机记录，服务端 token 由
  UI 撤销）。

### 4.3 token 模式实例

`flowlet login` 同样可用，但授权页会提示当前实例是 token 模式、建议直接用
`flowlet pull --server=<origin> --token=<管理凭据>`。token 模式实例保留原有 `--token` /
`FLOWLET_ADMIN_TOKEN` 路径，不受本次改动影响。

## 5. 多实例与环境前缀

同一个 provider 可以有多份凭据（例如公司-北美-线上 / 公司-苏州-线下 / 自用-线上），
每条服务凭据有可选的**环境别名（Env 前缀）**，决定 `flowlet pull` 写入本机 `.env` 的变量名。

### 5.1 命名规则

- 默认生成两把键：`{PREFIX}_URL`（baseUrl，kind `service`）与 `{PREFIX}_TOKEN`（token，
  kind `cli_token`）；需要 Basic 认证的 `jenkins` 额外生成 `{PREFIX}_USER`（用户名，kind `service`）；
  `beszel` 用邮箱 + 密码认证，生成 `{PREFIX}_URL` / `{PREFIX}_EMAIL` / `{PREFIX}_PASSWORD`
  （EMAIL kind `service`，PASSWORD kind `cli_token`）；
- OCI 镜像仓库（`registry`，v7）用「用户名 + 密码/token」做 `docker login`，地址槽位是
  **host[:port]**（无 scheme、无路径），因此生成三把键：`{PREFIX}_HOST`（host，kind `service`）、
  `{PREFIX}_USER`（用户名，kind `service`）、`{PREFIX}_TOKEN`（密码/token，kind `cli_token`）。
  地址键用 `_HOST` 而不是 `_URL`：它保存的是可以直传 `docker login` 的主机名，
  而且默认前缀本身就是 `REGISTRY`，若写成 `{PREFIX}_REGISTRY` 会得到 `REGISTRY_REGISTRY`；
- 未填前缀用 provider 默认值：`gitlab` → `GITLAB`、`dockhand` → `DOCKHAND`、
  `jenkins` → `JENKINS`、`beszel` → `BESZEL`、`registry` → `REGISTRY`（与第一期兼容）；
- 前缀规则：trim 后转大写，`^[A-Z][A-Z0-9_]{0,23}$`，最长 24 个字符；
  非法时保存失败：`环境前缀只能包含字母、数字和下划线，且以字母开头` / `环境前缀不能超过 24 个字符`；
- **唯一性**：所有已启用（`enabled=true`）凭据解析后的前缀必须唯一（不同 provider 也算冲突，
  因为会生成同名环境变量）。冲突时：
  `环境前缀已被「{other.name}」占用：{PREFIX}（同一前缀会生成相同的环境变量名）`；
  停用的凭据不参与冲突检查（`pull` 会跳过它们）。

### 5.2 AI 生成（流式）

前缀不再要求手写，也不再提供本地规则生成：表单右侧只有「AI 生成」按钮。

- 把「服务类型 + 名称 + 备注 + 已占用的前缀」作为 prompt，经**本机模型入口**
  （`/v1/chat/completions`，client token 鉴权，流式）调用一个已开放模型（优先 `flash` / `air` /
  `lightning` 等轻量模型），让模型输出语义缩写片段（如「公司北美 Dockhand 正式」→ `NA_PROD`、
  「个人自建 GitLab」→ `SELF`），再拼成完整前缀并做冲突避让；
- 生成过程通过 SSE（`POST /api/ai/env-prefix`）实时回传进度，界面显示
  「AI 生成中 · 模型 · 已生成 N tokens · X tok/s · 用时」；完成后显示「AI 已生成 · N tokens ·
  X tok/s · 用时」并填入前缀；
- 每次点击 = 一次真实模型调用（计费并写请求日志）；失败、无可用模型、输出不合规时只提示错误，
  **不会**再用规则兜底，输入框保持原值；
- **名称与备注会随 prompt 发送到该上游模型**，不要在名称/备注里写敏感信息。

手动输入始终优先；编辑已有凭据时保留其已存前缀，不会因为改名而改变已同步到 Agent 机器的变量名。
留空前缀时由 Host 用 provider 默认前缀。

### 5.3 UI 与 CLI 的对应关系

UI 的「环境别名（Env 前缀）」填**完整前缀**（例如 `DOCKHAND_NA`）；CLI 的 `--profile=<alias>`
是别名（例如 `na`），由 CLI 自动补 provider 前缀：

| 用途 | UI 环境前缀 | CLI | 本机键 |
|---|---|---|---|
| GitLab 默认实例 | 留空 | `flowlet gitlab ...` | `GITLAB_URL` / `GITLAB_TOKEN` |
| GitLab 工作实例 | `GITLAB_WORK` | `--profile=work` | `GITLAB_WORK_URL` / `GITLAB_WORK_TOKEN` |
| Dockhand 北美 | `DOCKHAND_NA` | `--profile=na` | `DOCKHAND_NA_URL` / `DOCKHAND_NA_TOKEN` |
| Dockhand 苏州 | `DOCKHAND_SZ` | `--profile=sz` | `DOCKHAND_SZ_URL` / `DOCKHAND_SZ_TOKEN` |
| Dockhand 自用 | `DOCKHAND_SELF` | `--profile=self` | `DOCKHAND_SELF_URL` / `DOCKHAND_SELF_TOKEN` |
| Jenkins 默认实例 | 留空 | `flowlet jenkins ...` | `JENKINS_URL` / `JENKINS_USER` / `JENKINS_TOKEN` |
| Jenkins 工作实例 | `JENKINS_WORK` | `--profile=work` | `JENKINS_WORK_URL` / `JENKINS_WORK_USER` / `JENKINS_WORK_TOKEN` |
| Beszel 默认实例 | 留空 | `flowlet beszel ...` | `BESZEL_URL` / `BESZEL_EMAIL` / `BESZEL_PASSWORD` |
| Beszel 监控实例 | `BESZEL_MON` | `--profile=mon` | `BESZEL_MON_URL` / `BESZEL_MON_EMAIL` / `BESZEL_MON_PASSWORD` |
| OCI 镜像仓库默认实例 | 留空 | `flowlet registry ...` | `REGISTRY_HOST` / `REGISTRY_USER` / `REGISTRY_TOKEN` |
| OCI 镜像仓库北美实例 | `REGISTRY_NA` | `--profile=na` | `REGISTRY_NA_HOST` / `REGISTRY_NA_USER` / `REGISTRY_NA_TOKEN` |

- 别名不区分大小写，落库/落本机键名一律大写；
- 未传 `--profile` 时读写 provider 默认前缀，与第一期行为完全一致；
- `set` 成功文案在显式 `--profile` 时会带上生效别名：
  `已保存 Dockhand 凭据（profile: NA）：http://host:3000/api`；
- 未配置对应 profile 时，错误提示会带 `--profile=<ALIAS>` 方便重跑。

### 5.4 示例：三份 Dockhand

```bash
# 服务端 UI 中分别创建三条 Dockhand 凭据，环境前缀填 DOCKHAND_NA / DOCKHAND_SZ / DOCKHAND_SELF。
# Agent 机器先 `flowlet login --server=http://10.100.217.60:20134` 授权一次，再同步：
flowlet pull --server=http://10.100.217.60:20134
# 已写入 DOCKHAND_NA_URL（来自 dockhand / 公司-北美-线上）
# 已写入 DOCKHAND_NA_TOKEN（来自 dockhand / 公司-北美-线上）
# 已写入 DOCKHAND_SZ_URL（来自 dockhand / 公司-苏州-线下）
# 已写入 DOCKHAND_SZ_TOKEN（来自 dockhand / 公司-苏州-线下）
# 已写入 DOCKHAND_SELF_URL（来自 dockhand / 自用-线上）
# 已写入 DOCKHAND_SELF_TOKEN（来自 dockhand / 自用-线上）

# 离线/手动写入单个实例时，CLI 直接按 profile 落键：
printf '%s' "$NA_TOKEN" | flowlet dockhand set --url=http://10.177.40.105:3000 --profile=na
flowlet dockhand status --profile=na
flowlet dockhand env --profile=na        # DOCKHAND_NA_URL / DOCKHAND_NA_TOKEN
flowlet dockhand clear --profile=na      # 只删 NA 这个前缀
```

OCI 镜像仓库同理，地址键是 host[:port]（可直接用于 `docker login`）：

```bash
printf '%s' "$REGISTRY_TOKEN" | flowlet registry set --url=hub.example.com --user='robot$project+name' --profile=na
flowlet registry status --profile=na
# 仓库：hub.example.com
# 认证：Registry V2（registry/2.0）
# 用户：robot$project+name

flowlet registry env --profile=na        # REGISTRY_NA_HOST / REGISTRY_NA_USER / REGISTRY_NA_TOKEN
flowlet registry clear --profile=na      # 只删 NA 这个前缀
```

`pull` 兼容旧服务端：导出条目没有 `envPrefix` 字段时回退 `provider.toUpperCase()`
（`GITLAB` / `DOCKHAND` / `JENKINS` / `BESZEL` / `REGISTRY`），与第一期一致。

## 6. 安全约定

1. **值不进 `list`**：列表只给键名、类型、备注、时间，避免 Agent 一次拉走全部明文。
2. **写入只走 CLI**：键名校验（`[A-Za-z_][A-Za-z0-9_]*`）、值非空、原子写、`0600`。
   手工编辑会跳过这些保证，`doctor` 能发现权限过宽和重复键。
3. **推荐 `run`**：凭据只注入子进程环境，不进入对话上下文，也不出现在 `ps` 的参数里。
4. **`set` 优先 stdin**：`printf '%s' "$TOKEN" | flowlet set KEY`，避免值进 shell history。
5. 当前**不加密**（明文 dotenv，靠 `0600` + 目录权限）：这是有意取舍——Agent 需要能直接
   `cat`/`source`；加密会强制所有读取方都经过 CLI 解密。若后续需要加密，应在不改变
   「`.env` 是事实源」的前提下加一层可选解锁，而不是把值搬进数据库。

## 7. `kind` 语义与扩展

`--kind` 现在只是标签，默认 `api_key`，允许 `cli_token`、`mcp_token` 或任意小写标识
（`[a-z0-9_-]{1,32}`）。后续按类型增加语义时的约定：

- `api_key`：三方 HTTP API 凭据（LLM 厂商、搜索、支付等）；
- `cli_token`：CLI 工具凭据（`gh auth token`、`vercel`、`cloudflare` 等）；
- `mcp_token`：MCP 服务器的 `headers` / `env` 凭据；
- 新增类型时必须同步本文档与 `.agents/skills/flowlet-credentials/SKILL.md`。

## 8. 管理面：服务凭据页（Docker / 桌面）

三方凭据的增删改与校验在 UI 里完成，不要求手工编辑文件：

- **入口**：左侧一级菜单「服务凭据」；
- **列表**：名称、服务类型、实例地址（Jenkins / OCI 镜像仓库额外展示 `@用户名`，Beszel 展示 `@邮箱`）、**环境前缀**（tooltip 展开
  `{PREFIX}_URL` / `{PREFIX}_TOKEN`，Jenkins 还有 `{PREFIX}_USER`，Beszel 还有 `{PREFIX}_EMAIL` / `{PREFIX}_PASSWORD`，
  OCI 镜像仓库是 `{PREFIX}_HOST` / `{PREFIX}_USER` / `{PREFIX}_TOKEN`）、Token 掩码、最近校验结果、启停状态；
- **添加 / 编辑**：服务类型（GitLab / Dockhand / Jenkins / Beszel / OCI 镜像仓库，创建时可选、编辑时不可切换）、名称、实例地址、
  用户名（Jenkins 必填；Beszel 显示「邮箱」且必填；OCI 镜像仓库显示「用户名」且必填，robot account
  直接填 `robot$project+name`）、环境别名（Env 前缀，留空 = 默认）、Token、备注、启用；
  表单文案（token 说明、地址 placeholder、警告 Banner、前缀预览）按所选 provider 动态展示；
- **保存即校验**：服务端按 provider 实际请求上游，失败直接返回错误且不落库：

  | provider | 默认前缀 | 保存时校验请求 | `flowlet pull` 写入本机 `.env` |
  |---|---|---|---|
  | `gitlab` | `GITLAB` | `GET {base}/api/v4/user` | `{PREFIX}_URL` / `{PREFIX}_TOKEN` |
  | `dockhand` | `DOCKHAND` | `GET {base}/api/environments` | `{PREFIX}_URL` / `{PREFIX}_TOKEN` |
  | `jenkins` | `JENKINS` | `GET {base}/me/api/json`（Basic 认证） | `{PREFIX}_URL` / `{PREFIX}_USER` / `{PREFIX}_TOKEN` |
  | `beszel` | `BESZEL` | `POST {base}/api/collections/users/auth-with-password`（邮箱 + 密码换 token） | `{PREFIX}_URL` / `{PREFIX}_EMAIL` / `{PREFIX}_PASSWORD` |
  | `registry` | `REGISTRY` | `GET {base}/v2/`（标准 Registry V2 流程：Basic → `WWW-Authenticate` Bearer 质询 → token → 重试） | `{PREFIX}_HOST` / `{PREFIX}_USER` / `{PREFIX}_TOKEN` |

- **测试**：对已保存凭据重新校验并刷新 `last_verified_at` / `last_error`；成功 toast 会拼
  `@用户名 · 版本 · provider 摘要`（Dockhand 的摘要是「{n} 个环境」，Jenkins 的版本来自
  `X-Jenkins` 响应头，Beszel 的版本来自 `/api/beszel/info`、摘要是「{n} 台系统」，
  registry 的版本来自 `docker-distribution-api-version` 响应头、没有摘要）；
- **删除**：清除服务端密文；已同步到 Agent 机器的 `.env` 不受影响；
- **本机接入**（仅 Web Host）：页面头部「本机接入」按钮提供 CLI / Skills 下载与一键命令，
  以及「已授权的 CLI」列表（见 §4.2 与 §14）。

对应的管理命令（桌面 Tauri 与 Web 白名单同名）：

```text
list_credential_providers / list_service_credentials /
save_service_credential / test_service_credential /
delete_service_credential / export_service_credentials / reveal_service_credential

# v4：CLI 浏览器授权（`flowlet login`）
create_cli_auth_code / list_cli_auth_tokens / revoke_cli_auth_token
```

`export_service_credentials` 是 `flowlet pull` 的数据源，返回明文，要求管理凭据
（Web Host 上未通过鉴权返回 401）**或**作用域为 `credentials:read` 的 CLI token；
`create_cli_auth_code` 只能由已登录的管理台浏览器会话（Cookie + CSRF）调用。
UI 页面本身不调用导出，只调用 `reveal_service_credential` / `list_cli_auth_tokens` /
`revoke_cli_auth_token`。

`reveal_service_credential` 是管理台「查看原始 token」的数据源：解密单条已保存凭据并返回
`{id, name, provider, envPrefix, token}`，只允许管理鉴权（Cookie 会话 + CSRF，或 token 模式
Bearer）；`flowlet login` 签发的 CLI token 作用域只有 `credentials:read` 且白名单仅
`export_service_credentials`，调用本命令返回 403。列表接口继续只返回掩码（`••••1a2b`），
明文不写日志、不缓存；前端用完即丢弃（关闭弹层即清空状态）。Rust Host 未实现该命令，
桌面端调用会失败并提示「无法查看原始 token」。

UI 是配置入口，CLI 是分发/消费入口：

```text
UI 添加凭据（可设环境前缀）→ 服务端加密落库 → Agent 机器 `flowlet pull` → 本机 .env → Agent 读取/run
```

## 9. GitLab 适配（API v4，目标版本 CE 10.8.7）

第一个内置三方服务是 GitLab（第二个是 §10 的 Dockhand），按 **GitLab Community Edition 10.8.7
（revision `eb600b0`）** 实现。版本约束决定了实现细节：

| 约束 | 做法 |
|---|---|
| 10.8 时代 PAT 走 `PRIVATE-TOKEN` 最稳 | 只用 `PRIVATE-TOKEN` 请求头，不用 `Authorization: Bearer` |
| 没有 `/personal_access_tokens/self`（11.x+） | 不做 token 自省；用 `GET /user` 验证有效性 |
| `/version` 仅管理员可用 | 非管理员返回 403/404 时静默降级为「版本未知」，不报错 |
| 分页头是 `X-Next-Page` / `X-Total` | 按 `X-Next-Page` 翻页，`0`/空都视为末页 |
| 支持子路径部署（`https://host/gitlab`） | `normalize_base_url` 保留子路径，用户粘 `/api/v4` 也兼容 |

默认实例存两个键：`GITLAB_URL`（kind `service`）与 `GITLAB_TOKEN`（kind `cli_token`）；
多实例用 `--profile=<alias>` 生成 `GITLAB_{ALIAS}_URL` / `GITLAB_{ALIAS}_TOKEN`。

```bash
printf '%s' "$GITLAB_TOKEN" | flowlet gitlab set --url=https://gitlab.example.com
flowlet gitlab status                            # 用户 / 版本 / API 地址
flowlet gitlab projects --search=flowlet         # 默认只看自己参与的项目，--all 放开
flowlet gitlab api GET /projects/42/merge_requests?state=opened
flowlet gitlab api POST /projects/42/issues --data='{"title":"...","description":"..."}'
flowlet gitlab env                               # GITLAB_URL / GITLAB_TOKEN（含明文，慎用）
flowlet gitlab clear

# 另一个实例（GitLab 子命令都支持 --profile）
printf '%s' "$WORK_TOKEN" | flowlet gitlab set --url=https://gitlab.work.example.com --profile=work
flowlet gitlab status --profile=work
flowlet gitlab env --profile=work               # GITLAB_WORK_URL / GITLAB_WORK_TOKEN
```

设计取舍：

- `set` **先验证再落库**：token 无效或无网络时不会把坏凭据写进全局库；
- `api` 只接受相对路径，避免 token 被发到外部绝对 URL；
- 不做 GitLab 专属的子命令爆炸：10.8 已有端点通过 `api` 透传，常用查询（项目列表）才内置；
- 内网自签证书用 `--insecure`，不写入存储，每次显式指定；
- 错误提示按状态码给出可执行动作（401 token 失效 / 403 权限或管理员 / 404 端点不存在 / 429 限流）。

已验证：用 10.8.7 语义的 mock 服务跑通 `set → status(用户+版本 10.8.7) → projects(含
default_branch/visibility) → api GET /version`，以及错误 token 不落库、未配置时的提示、
`env`/`clear`；`core/gitlab.rs` 7 个单测覆盖 URL 归一、子路径、项目解析、错误映射、分页头。

## 10. Dockhand 适配（Bearer API Token）

第二个内置 provider 是公司内部的 Dockhand Docker 管理面板（`fnsys/dockhand`，实测 1.0.57，
如 `http://10.177.40.105:3000`）。它用 `Authorization: Bearer <API Token>` 鉴权，
环境相关资源都要 `?env=<id>`，与 GitLab 的差异决定了实现细节：

| 约束 | 做法 |
|---|---|
| 没有「当前 token 用户」接口 | 校验只用 `GET /api/environments`：认证通过即 200；401 说明 token 无效 |
| `/api/health` 匿名也可访问 | 不拿 health 校验 token，只在 `status` 里展示面板存活 |
| 资源接口都要 `?env=<id>` | `system` / `stacks` 必须带 `--env`；缺失直接报错，不猜默认环境 |
| 用户可能粘贴 `http://host:3000/api` | `normalizeBaseUrl` 去掉末尾 `/` 与 `/api` 后缀，保留子路径部署（如 `/dockhand`） |
| 内网自签证书 | `--insecure` 跳过 TLS 校验，不写入存储 |

默认实例存两个键：`DOCKHAND_URL`（kind `service`，备注 `dockhand 面板地址`）与
`DOCKHAND_TOKEN`（kind `cli_token`，备注 `dockhand API token`）；多实例用
`--profile=<alias>` 生成 `DOCKHAND_{ALIAS}_*`（见 §5）。

```bash
printf '%s' "$DOCKHAND_TOKEN" | flowlet dockhand set --url=http://dockhand.example.com:3000
flowlet dockhand status
# API：http://dockhand.example.com:3000/api
# 健康：ok
# 环境：2 个
#    2  [CentOS] 10.100.217.60  http://10.100.217.60:2375
#    1  本机  http://127.0.0.1:2375
# Docker 版本：27.3.1

flowlet dockhand envs [--json]             # id/name/host/port/protocol
flowlet dockhand stacks --env=2 [--json]   # stack 名 + 容器数
flowlet dockhand api GET /stacks?env=2     # PATH 可带 /api 前缀与 query，只接受相对路径
flowlet dockhand env                        # DOCKHAND_URL / DOCKHAND_TOKEN（含明文，慎用）
flowlet dockhand clear

# 多实例：--profile 组合成对应前缀
printf '%s' "$NA_TOKEN" | flowlet dockhand set --url=http://10.177.40.105:3000 --profile=na
flowlet dockhand status --profile=na
flowlet dockhand env --profile=na          # DOCKHAND_NA_URL / DOCKHAND_NA_TOKEN
flowlet dockhand clear --profile=na        # 只删 NA 前缀
```

设计取舍：

- `set` **先验证再落库**：token 无效（401）或地址不可达时不写入全局库；
- `status` 的 Docker 版本来自第一个环境的 `GET /api/system?env=<id>`，取不到时显示「未知」，
  不影响健康与环境信息；
- `api` 只接受相对路径，并把 `/api` 前缀归一掉（`dockhand api /environments` 与
  `dockhand api GET /api/environments` 等价），避免 token 被发到外部绝对 URL；
- 错误提示按状态码给出可执行动作（401 token 失效 / 403 权限不足 / 404 面板根地址写错 / 429 限流）；
- `pull` 会把服务端 Dockhand 凭据映射成 `{PREFIX}_URL` / `{PREFIX}_TOKEN` 写入本机 `.env`
  （无 `envPrefix` 的旧服务端回退 `DOCKHAND_*`），未识别的 provider 继续跳过并写 stderr。

## 11. Jenkins 适配（用户名 + API Token）

第三个内置 provider 是 Jenkins（REST API，校验 `GET /me/api/json`）。Jenkins 的 API Token
必须与用户名一起做 HTTP Basic 认证，因此它是唯一需要额外用户名字段的 provider：

| 约束 | 做法 |
|---|---|
| 认证是 Basic，不是 Bearer | 服务端使用 `Authorization: Basic base64(用户名:API Token)`；UI 与 CLI 都必须填写用户名 |
| 没有匿名可用的版本接口 | 校验 `GET {base}/me/api/json`（需认证）；版本取响应头 `X-Jenkins`，缺失时显示「未知」 |
| 用户可能粘贴 `/me/api/json` 或 `/api/json` | `normalizeBaseUrl` 只去末尾 `/`、保留子路径，不猜 API 前缀；错误提示要求填 Jenkins 根地址 |
| 内网自签证书 | `--insecure` 跳过 TLS 校验，不写入存储 |

保存时服务端先校验再落库：401 → 用户名或 API Token 无效；403 → 该用户缺少 Overall/Read
权限；404 → 地址不是 Jenkins 根地址。`flowlet pull` 为 Jenkins 写三把键：
`{PREFIX}_URL`、`{PREFIX}_USER`、`{PREFIX}_TOKEN`（其它 provider 仍是两把）。

```bash
printf '%s' "$JENKINS_TOKEN" | flowlet jenkins set --url=https://jenkins.example.com --user=ci-bot
flowlet jenkins status
# URL：https://jenkins.example.com
# 版本：2.492.1
# 用户：ci-bot

flowlet jenkins api GET /api/json?tree=jobs[name,color]   # 只接受相对路径
flowlet jenkins env        # JENKINS_URL / JENKINS_USER / JENKINS_TOKEN（含明文，慎用）
flowlet jenkins clear

# 多实例：--profile 组合成对应前缀
printf '%s' "$WORK_TOKEN" | flowlet jenkins set --url=https://jenkins.work.example.com --user=ci --profile=work
flowlet jenkins env --profile=work   # JENKINS_WORK_URL / JENKINS_WORK_USER / JENKINS_WORK_TOKEN
```

设计取舍：

- 用户名不是密文，明文落库；token 仍走 `secret_box` 加密 + 掩码展示；
- `api` 只接受相对路径，`PATH` 原样拼在 Jenkins 根地址后（Jenkins 没有统一的 API 前缀，
  不自动补 `/api`），避免 token 被发到外部绝对 URL；
- 错误提示按状态码给出可执行动作（401 凭据无效 / 403 权限不足 / 404 根地址写错 / 429 限流）。

## 12. Beszel 适配（邮箱 + 密码换短期 token）

第四个内置 provider 是 Beszel（开源服务器监控 Hub，PocketBase 底座，默认端口 8090）。
它**没有长期 API Token**：只能用「邮箱 + 密码」调
`POST /api/collections/users/auth-with-password` 换短期 token（PocketBase 默认 14 天）。
因此凭据库保存「邮箱（明文）+ 密码（密文）」，每次校验 / CLI 调用现场换 token。

| 约束 | 做法 |
|---|---|
| 没有长期 token | `set` 时先用邮箱 + 密码认证；token 只在单次命令内缓存，不落库 |
| 认证头是裸 token | 后续请求 `Authorization: <token>`（PocketBase 原生 token，**不是** `Bearer`） |
| 版本接口需认证 | `GET {base}/api/beszel/info` 取 `v`；失败不致命，`status` 显示「版本未知」 |
| 系统数量 | `GET {base}/api/collections/systems/records?perPage=1` 取 `totalItems` |
| 用户可能粘贴 `/api` 或管理面板 `/_/` | `normalizeBaseUrl` 反复剥末尾 `/`、`/api`、`/_`、`/_/`，保留其它子路径 |
| 密码登录可能被禁用 | 403 提示 `DISABLE_PASSWORD_AUTH` 或账号没有读取权限 |

保存时服务端先校验再落库：auth 失败（PocketBase 返回 400）→ 邮箱或密码错误，且提示确认是
Beszel 用户账号而不是 PocketBase 超级管理员；401 → token 无效；403 → 密码登录被禁用或无权限；
404 → 地址不是 Beszel Hub 根地址。`flowlet pull` 为 Beszel 写三把键：
`{PREFIX}_URL`、`{PREFIX}_EMAIL`、`{PREFIX}_PASSWORD`（旧服务端导出没有 `username` 时 EMAIL 写空串）。

```bash
printf '%s' "$BESZEL_PASSWORD" | flowlet beszel set --url=http://beszel.example.com:8090 --email=you@example.com
flowlet beszel status
# URL：http://beszel.example.com:8090
# 版本：0.21.1
# 邮箱：you@example.com
# 系统：3 台

flowlet beszel systems [--json]                                   # id/name/host/status/port
flowlet beszel api GET /api/collections/systems/records?perPage=1  # PATH 可带 /api 前缀与 query
flowlet beszel env        # BESZEL_URL / BESZEL_EMAIL / BESZEL_PASSWORD（含明文，慎用）
flowlet beszel clear

# 多实例：--profile 组合成对应前缀
flowlet beszel status --profile=mon
flowlet beszel env --profile=mon   # BESZEL_MON_URL / BESZEL_MON_EMAIL / BESZEL_MON_PASSWORD
```

设计取舍：

- `set` **先认证再落库**：密码错误或地址不可达时不写入全局库；
- 邮箱明文、密码密文；密码不进入日志，`env` 输出会先在 stderr 打印明文警告；
- `api` 只接受相对路径，并把 `/api` 前缀归一掉；token 只发往填写的 Hub 地址；
- 错误提示按状态码给出可执行动作（400 邮箱/密码、401 token、403 DISABLE_PASSWORD_AUTH /
  无读取权限、404 Hub 根地址、429 限流）。

## 13. OCI 镜像仓库适配（Registry V2）

第五个内置 provider 是 OCI 镜像仓库（`registry`，v7）。它不针对任何单一产品，只依赖容器镜像
仓库的行业通用标准：

- **Docker Registry HTTP API V2**：`GET /v2/` 是认证入口，401 时用 `WWW-Authenticate` 质询；
- **OCI Distribution Specification**：内容寻址与 `/v2/` 端点沿用同一套语义。

因此 Harbor、Docker Hub、GHCR、Quay、ACR 以及任何实现了 `/v2/` 的私有仓库都走同一套流程，
不需要按厂商分支实现。

| 约束 | 做法 |
|---|---|
| 认证入口是 `GET {base}/v2/` | 200 即通过；401 时读 `WWW-Authenticate` 决定后续认证方式 |
| Bearer token 质询 | `WWW-Authenticate: Bearer realm=…,service=…,scope=…` → 带 Basic 头请求 token 端点 → 用返回的 `token` / `access_token` 以 Bearer 重试 `/v2/` |
| 版本信息在响应头 | 取 `docker-distribution-api-version`（如 `registry/2.0`），缺失时显示「未知」 |
| 地址必须是仓库根地址 | `normalize_base_url` 只保留 `http(s)://host[:port]`：补 scheme、去末尾 `/`、去 `/v2`；带路径 / query / 锚点直接报错 |
| 用户名必填 | `docker login` 需要用户名 + 密码/token；允许 `$` `+` `_` `-`（robot account 形如 `robot$project+name`） |

保存时的实际校验流程：

1. `GET {origin}/v2/`，请求头 `Authorization: Basic base64("{username}:{password}")`；
2. 直接 200 → 通过，`version` 取响应头 `docker-distribution-api-version`；
3. 401 且 `WWW-Authenticate` 以 `Bearer` 开头 → 解析 `realm` / `service` / `scope`，
   `GET {realm}?service=…[&scope=…]`（同样带 Basic 头）换 token；
4. 拿到非空 `token` / `access_token` 后，以 `Authorization: Bearer {token}` 重试 `/v2/`；
5. 403 → 认证被拒绝（用户名/token 无效或该账号无权访问）；404 → 不是仓库根地址（提示不要带路径）；
   429 → 触发限流；其它非 2xx → `镜像仓库返回 HTTP {status}`。

明确不做（Harbor 专属能力一律不实现）：

- 不请求 `/api/v2.0/*`（项目、robot account、系统信息等厂商管理 API）；
- 不探测仓库版本 / 项目数量，不调用 `/v2/_catalog`，也不按主机名判断「是不是 Harbor」；
- 不自动创建 robot account，不涉及实例私有的命令行密码 / 工号规则；
- 不支持 `docker search`（各厂商私有搜索接口不统一），也不支持 ChartMuseum 的 `/chartrepo`
  + `helm-push` 插件（改用标准 OCI 方式 `helm push oci://…`）。

robot account 说明：它就是一个普通「用户名 + 密码/token」组合，Flowlet 不做任何特判。
在服务凭据页把用户名填成 `robot$project+name`、Token 填该 robot account 的 token 即可，
与其它镜像仓库账号完全一致。

本机 `.env` 与 `docker login` / `helm registry login` 用法：

```bash
# 服务端管理面添加 OCI 镜像仓库凭据后，Agent 机器同步
flowlet pull --server=http://<flowlet-host>:20134

# 本机 .env 中得到三把键（HOST 是 host[:port]，不带 scheme）
# REGISTRY_HOST=hub.example.com
# REGISTRY_USER=robot$project+pull
# REGISTRY_TOKEN=***

# docker：密码走 stdin，避免出现在 shell history / 进程参数里
printf '%s' "$REGISTRY_TOKEN" | docker login "$REGISTRY_HOST" -u "$REGISTRY_USER" --password-stdin
docker pull "$REGISTRY_HOST/project/app:1.0.0"
docker tag app:local "$REGISTRY_HOST/project/app:1.0.0"
docker push "$REGISTRY_HOST/project/app:1.0.0"

# helm 走 OCI registry（不需要 ChartMuseum 与 helm-push 插件）
printf '%s' "$REGISTRY_TOKEN" | helm registry login "$REGISTRY_HOST" -u "$REGISTRY_USER" --password-stdin
helm push app-1.0.0.tgz "oci://$REGISTRY_HOST/project"
helm pull "oci://$REGISTRY_HOST/project/app" --version 1.0.0

# 离线/手动写入单个实例
printf '%s' "$TOKEN" | flowlet registry set --url=hub.example.com --user='robot$project+name'
flowlet registry status            # 仓库 / Registry V2 认证 / 用户名
flowlet registry env               # REGISTRY_HOST / REGISTRY_USER / REGISTRY_TOKEN（含明文，慎用）
flowlet registry clear
```

设计取舍：

- `set` **先校验再落库**：token 错误、地址不可达或地址带路径都不会写入全局库；
- 只做一次 `GET /v2/` 校验，不做 catalog / 仓库内容探测，避免把凭据发往不必要的端点；
- 内网自签证书用 `--insecure` 跳过 TLS 校验，不写入存储；
- 错误提示按状态码给出可执行动作（401 认证失败 / 403 无权访问 / 404 根地址写错 / 429 限流）；
- 地址键叫 `{PREFIX}_HOST` 而不是 `{PREFIX}_URL`：值是 `docker login` 直接可用的主机名，
  且默认前缀就是 `REGISTRY`，避免出现 `REGISTRY_REGISTRY` 这种重复前缀。

## 14. 本机接入（下载安装）

Web Host 的「服务凭据」页提供「本机接入」抽屉（桌面模式不显示），让 Agent 机器无需仓库即可用上 CLI：

- **安装 CLI**（需要 Node.js 22.6+；22.6–22.17 由 `bin/flowlet.mjs` 自动补类型剥离 flag）：

  ```bash
  curl -fsSL http://<flowlet-host>:20134/downloads/install-flowlet.sh \
    | sh -s -- --base=http://<flowlet-host>:20134/downloads
  ```

  `install-flowlet.sh` 会校验 `node` 版本与产物 sha256，安装到
  `${XDG_DATA_HOME:-$HOME/.local/share}/flowlet/cli`，并把 `flowlet` 软链到
  `${XDG_BIN_HOME:-$HOME/.local/bin}`；可用 `--prefix=` / `--skills-dir=` / `--no-skills` 调整。
- **登录授权**（OIDC 实例必需；这是 v4 起的默认流程）：

  ```bash
  flowlet login --server=http://<flowlet-host>:20134
  ```

  在浏览器登录管理台并确认授权（登录方式为该实例配置的 OIDC/SSO），CLI 只保存一把仅能读服务凭据的本机授权（`auth.json`，
  30 天有效），不收集、不展示任何管理凭据；授权页与终端都不会出现明文 token。
- **同步凭据**（可重复执行，只同步启用中的服务凭据）：

  ```bash
  flowlet pull --server=http://<flowlet-host>:20134
  ```

  已有本机授权时无需再填任何参数。token 模式实例仍可用
  `flowlet pull --server=http://<flowlet-host>:20134 --token=<管理凭据>`
  （或用 `FLOWLET_ADMIN_TOKEN`）；OIDC 实例不开启 `ALLOW_TOKEN_LOGIN`，`--token` 会 401。
- **已授权的 CLI**：抽屉内「已授权的 CLI」段列出名称 / 创建时间 / 到期时间 / 最近使用，
  每行「撤销」需确认；撤销后对应机器上的 `flowlet pull` 立即 401，需要重新 `flowlet login`。
  桌面 Host（Tauri）尚未实现该命令，此时列表位置只显示说明文案，登录与同步命令照常可用。

- **安装 Skills**：下载 `http://<flowlet-host>:20134/downloads/flowlet-skills.tar.gz`，解压到你所
  在 Agent 的 skills 目录，阅读 `flowlet-credentials/SKILL.md`；页面「复制 Agent 提示词」会生成
  带当前地址的完整指令。
- `downloads/` 布局（由 `npm run build:web` 生成，随镜像发布）：

  ```text
  downloads/
    manifest.json          # {version, generatedAt, artifacts:[{path,bytes,sha256}]}
    flowlet-cli.tar.gz     # 内层 flowlet-cli/…，可执行 bin/flowlet
    flowlet-skills.tar.gz  # 内层 flowlet-skills/flowlet-credentials/SKILL.md
    install-flowlet.sh     # POSIX sh 安装脚本
  ```

- 下载产物只包含 CLI 源码与通用 Skills，不包含任何真实 token、`.env` 或 `.agents/` 内容。

## 15. 与 Flowlet 其它能力的关系

- **与渠道账号**：`channel_accounts.api_key` 是上游模型账号，走路由与余额同步；
  全局凭据库不参与模型路由，两者不要互相写入。
- **与 Agent 接入**：后续接入抽屉直接引用本库的键名（MCP 的 `env`/`headers`、CLI 环境变量），
  不再让用户重复粘贴明文；当前尚未接线。
- **与 Docker 版**：服务端提供「服务凭据」管理页，凭据加密落在 `/data`（命名卷）；
  Agent 机器上执行 `flowlet login --server=http://<host>:20134` 授权一次，之后
  `flowlet pull --server=http://<host>:20134` 同步到本地 `.env`。
  容器内没有用户 `config_dir`，CLI 需要显式设置 `FLOWLET_CRED_DIR` 时才在容器里使用。
- **与 Web Host 鉴权（OIDC）**：CLI 授权走**独立作用域 token**（`credentials:read`），
  不打开管理 Bearer 兜底、也不复用管理会话 Cookie；详见 §4.2 与
  [`admin-sso-design.md`](./admin-sso-design.md) §5.1.1 / §7.6。
- **与 UI**：`core/credential_store.rs` 是纯 Rust 模块，后续可直接被桌面/Web 命令复用
  （读列表、读单值、写值、删除），不需要重写存储层。

## 16. 验收

- `cargo test --no-default-features --lib credential_store`：9 个用例覆盖读写、顺序、
  注释保留、引号编码、权限、重复键、导出格式、非法键名；
- `cargo test --no-default-features --lib gitlab`：7 个用例覆盖 URL 归一（含子路径与
  `/api/v4` 粘贴）、相对路径限制、项目解析、错误码提示、分页头（含末页 0 值）；
- `cargo test --no-default-features --lib secret_box`：4 个用例覆盖加解密、密钥跨实例稳定、
  不同密钥不可解、密文篡改被拒；
- `cargo test --no-default-features --lib storage_credentials`：覆盖 CRUD、启停、校验结果落库、
  `env_prefix` 存取；
- `cargo test --no-default-features --lib service_credentials`：覆盖 providers（含 v7 的
  `registry` 顺序）、`env_keys`（registry 三把键含 `_HOST`）、环境前缀归一/唯一性、
  Dockhand / Jenkins / registry 校验、Jenkins / registry 用户名校验；
- `cargo test --no-default-features --lib jenkins`：覆盖 URL 归一、空用户名/token、
  Basic 认证身份解析、`X-Jenkins` 版本与错误码提示；
- `cargo test --no-default-features --lib beszel`：覆盖 URL 归一（`/api`、`/_/`、子路径）、
  相对路径限制、邮箱 + 密码认证、info/systems 解析与错误码提示；
- `cargo test --no-default-features --lib registry`：覆盖仓库地址归一（补 scheme、去 `/v2`、
  拒绝路径/query）、`registry_host`、Basic 直接 200、Bearer 质询换 token 后重试 200、
  401/403/404/429 与网络错误映射、用户名校验；
- `node --test packages/flowlet-core/src/web/__tests__/registry.test.ts`：Node Host 侧的
  同一套 Registry V2 校验与错误文案（与 Rust / CLI 逐字一致）；
- `npm run cred:typecheck` / `npm run cred:test`：Node CLI 覆盖本地库、GitLab mock、Dockhand
  mock、Jenkins mock、Beszel mock、Registry V2 mock、多 profile（`--profile=na/sz/mon` 独立
  键名与实例切换）、`pull` 的 `envPrefix` 映射、`DOCKHAND_*` / `JENKINS_*` / `BESZEL_*` /
  `REGISTRY_*` 映射（`_HOST` 为 host[:port]）、Dockhand / Jenkins / Beszel / registry 纯函数
  （URL 归一/路径/解析/错误提示），以及 Rust legacy 对拍；
- `FLOWLET_RUST_CRED=$PWD/src-tauri/target/debug/flowlet-cred npm run cred:compat`：
  Node CLI 与 Rust legacy 在同一序列下输出/文件字节级一致；
- 端到端（headless + mock GitLab 10.8.7）：`list → save（校验后加密落库）→ test → export →
  delete`，确认 SQLite 中搜不到明文 token、`secret.key` 权限 600、非法 token 不入库、
  未鉴权导出返回 401；再执行 `flowlet pull`，确认本机 `.env` 写入
  `GITLAB_URL` / `GITLAB_TOKEN` 且 `--dry-run` 不写文件；
- 本机接入产物：`npm run build:web` 后 `dist-web/downloads/` 含 4 个文件，
  `manifest.json` 的 sha256 与实际产物一致；在临时 HOME 下用
  `--base=http://127.0.0.1:<port>/downloads` 跑安装脚本，`flowlet --version` 可执行；
- 手工冒烟（凭据库）：`init → set → list → get --mask → env → run --with → doctor`，
  确认 `run` 只注入指定变量、文件权限 600；
- 手工冒烟（GitLab）：对 10.8.7 语义的 mock 执行 `gitlab set → status → projects → api`，
  以及错误 token 不落库、未配置提示、`env`/`clear`；
- 手工冒烟（Dockhand）：对 mock 执行 `dockhand set → status → envs → stacks → api`，
  以及错误 token 不落库、未配置提示、`env`/`clear`；多实例用 `--profile` 验证键名隔离；
- 手工冒烟（Beszel）：对 PocketBase 语义的 mock 执行
  `beszel set → status → systems → api → env → clear`，验证密码错误不落库、地址粘贴
  `/api` / `/_/` 被归一、`info` 失败时 `status` 显示版本未知、多实例 `--profile` 键名隔离；
- 手工冒烟（OCI 镜像仓库）：对 Registry V2 语义的 mock 执行
  `registry set → status → env → clear`，验证错误 token 不落库、401 + `WWW-Authenticate`
  Bearer 质询能换发 token 并重试成功、`status` 显示 `Registry V2（registry/2.0）` 与用户名、
  地址粘贴 `/v2/` 或带路径被拒绝、多实例 `--profile` 键名隔离（`REGISTRY_NA_HOST`）、
  `pull` 写入 `_HOST`（无 scheme）/ `_USER` / `_TOKEN`，并用这三把键实际跑通
  `docker login <host> -u <user> --password-stdin`；确认没有请求任何 `/api/v2.0/*`；
- 远程登录授权（v4）：
  - `flowlet login --server=<oidc-instance>` 一条命令跑通：终端打印授权 URL、浏览器回调完成
    → `auth.json` 出现该 server 记录（目录 0700 / 文件 0600、原子写、server key 归一）；
    `--no-browser` 只跳过自动打开、仍需手动打开 URL；
  - `flowlet pull --server=<oidc-instance>` 不传任何 `--token` 即可同步成功；
    用 `auth.json` token 收到 401 时报「登录已过期或被撤销，请重新 flowlet login --server=…」；
  - `flowlet logout --server=…` 删除本机记录（存在 → `已退出 …`；不存在 → `未找到 …`，退出码 0）；
  - 安全边界：CLI token 调 `export_service_credentials` 以外的命令返回 403、管理台鉴权面未放开
    （OIDC 实例 `ALLOW_TOKEN_LOGIN=0` 时 `--token` 仍 401）、授权码 120 秒过期与一次性、
    回调地址只接受 loopback、`auth.json` 与日志中均无明文 token 之外的凭据；
  - UI：「本机接入」抽屉两步命令带复制按钮且明确「本页不会收集管理凭据」；「已授权的 CLI」
    列出名称/创建时间/到期时间/最近使用，撤销需确认，成功后 toast 并刷新列表；空状态与
    loading/error 齐全；桌面 Host（无 `list_cli_auth_tokens` 命令）时该段只展示说明文案，
    其余段落不受影响；
  - 前端检查：`npm run check` 0 错误、
  `npm test -- src/pages/credentials src/domains/credentials src/features/credentials` 全绿；
  其中服务凭据页覆盖 registry 的 provider 下拉、用户名输入框、env 预览
  `REGISTRY_HOST / REGISTRY_USER / REGISTRY_TOKEN`、默认前缀 `REGISTRY` 与保存 payload
  （带 `username`）。

`FLOWLET_CRED_DIR` 可在两条验收里都指向临时目录，避免污染真实凭据。