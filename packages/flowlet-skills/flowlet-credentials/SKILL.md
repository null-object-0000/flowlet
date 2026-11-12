---
name: flowlet-credentials
description: >
  通过 `flowlet` 读写 Flowlet 全局凭据库（单个 dotenv 文件，默认
  `~/.config/flowlet/credentials/credentials.env`）。当需要为 MCP 服务器、CLI 工具
  或三方 API（GitHub、搜索、LLM 厂商等）取用密钥，或需要新增/更新/删除一把凭据时使用。
  也适用于「Agent 要用某个 token 但不想让它进入上下文」的场景——优先用
  `flowlet run` 把值注入子进程。
---

# Flowlet 全局凭据库

Flowlet 用**一个全局 dotenv 文件**保管三方服务凭据，由 `flowlet` CLI 统一写入，
Agent 读取同一份文件或经 CLI 取用。凭据不属于 Flowlet 对外提供的模型服务，而是
Claude Code / Codex / DSH 等 Agent 在接入后需要使用的三方 key。

> 命令名是 `flowlet`（旧名 `flowlet-cred` 已废弃、不保留别名；仓库内 Rust legacy
> 二进制的文件名仍叫 `flowlet-cred`，仅用于兼容性对拍，Agent 不要调用它）。

## 定位与边界

- 文件：`~/.config/flowlet/credentials/credentials.env`（可用 `FLOWLET_CRED_DIR` 覆盖）；
  元数据在同目录 `credentials.json`（类型、备注、时间）。
- 写入只走 CLI：原子写 + `0600`，键名校验，不会写出半截文件。
- `--kind` 目前只是标签（`api_key` / `cli_token` / `mcp_token` / 自定义），
  具体类型的格式校验后续再加。

## 安装与来源

- **确认已安装**：`flowlet --version`；没有时用 Flowlet Web Host「服务凭据 → 本机接入」
  提供的安装命令（需要 Node.js 22.6+）：
  `curl -fsSL http://<Flowlet 地址>:20134/downloads/install-flowlet.sh | sh -s -- --base=http://<Flowlet 地址>:20134/downloads`
- **管理面在 Flowlet UI**：Docker / 桌面左侧「服务凭据」页添加服务（当前支持 GitLab、
  Dockhand、Jenkins、Beszel、OCI 镜像仓库），保存即校验，token 加密存服务端，界面只显示掩码；同一 provider 多实例用
  「环境别名（Env 前缀）」区分（例如 `DOCKHAND_NA` / `DOCKHAND_SZ` / `DOCKHAND_SELF`）。
  Jenkins 额外需要「用户名」（API Token 与用户名一起做 Basic 认证）；Beszel 额外需要「邮箱」
  （登录密码换短期 token，没有长期 API Token）；OCI 镜像仓库额外需要「用户名」
  （`docker login` 的用户名 + 密码/token）。
- **本机消费（先 login，再 pull）**：Agent 机器上先执行

  ```bash
  flowlet login --server=http://<Flowlet 地址>:20134
  ```

  浏览器会打开 Flowlet 管理台的授权页（loopback + PKCE，登录方式为该实例配置的 OIDC/SSO）；授权后 CLI 只在
  `~/.config/flowlet/credentials/auth.json` 保存一把**仅能读服务凭据**的 token（30 天有效，
  可用 `flowlet logout --server=...` 删本机记录，服务端在 UI「已授权的 CLI」里撤销）。
  **不要**要求用户粘贴管理凭据或 `FLOWLET_ADMIN_TOKEN`——OIDC-only 实例不接受它。
  然后同步：

  ```bash
  flowlet pull --server=http://<Flowlet 地址>:20134
  ```

  把启用中的凭据同步到本机 `.env`（`--dry-run` 只预览）。之后的读取方式不变。
- **token 模式实例**：授权页会提示改用
  `flowlet pull --server=<origin> --token=$FLOWLET_ADMIN_TOKEN`；这是唯一仍需 `--token` 的场景。
- CLI 的 `gitlab set` / `dockhand set` / `jenkins set` / `uptime-kuma set` / `beszel set` /
  `registry set` 只用于没有服务端管理面的离线场景；正常流程不要手工配置。

## 命令

```bash
flowlet init                                     # 首次初始化
flowlet list [--json]                            # 只看名字/类型/备注，永不含明文
flowlet get <KEY> [--mask]                       # 取单个值（--mask 只看掩码）
flowlet set <KEY> [--kind=K] [--note=N]          # 值从 stdin 读，或 --value=V
flowlet unset <KEY>
flowlet env [--only=A,B]                         # 输出 dotenv
flowlet export --format=shell|json [--only=A,B]
flowlet run --with=A,B -- <程序> [参数...]        # 只注入指定凭据到子进程
flowlet doctor                                   # 权限/重复键/元数据检查

# 远程同步（Docker / Web Host）
flowlet login --server=<origin> [--no-browser]   # 浏览器 SSO 授权，先做这一步
flowlet logout --server=<origin>                 # 删除本机登录记录
flowlet pull --server=<origin> [--dry-run]       # 自动使用 login 的本机授权
```

## A2A Agent 原生调用

`flowlet a2a` 是通用 A2A 1.0 JSON-RPC/SSE 客户端；直接读取凭据库，无需 Python 脚本或手动取出密钥。

```bash
flowlet login --server=http://<Flowlet 地址>:20134
flowlet pull --server=http://<Flowlet 地址>:20134

# 先从本机同步配置发现 Agent、技能、profile 和调用参数
flowlet a2a list

# --profile=RESEARCH 对应 FLOWLET_A2A_RESEARCH_URL / FLOWLET_A2A_RESEARCH_TOKEN
# 已有任意环境前缀则使用 --prefix=MY_AGENT（与 --profile 互斥）
flowlet a2a discover --profile=RESEARCH
flowlet a2a send '请记住虚构项目名为青柠灯塔。' --profile=RESEARCH --session=demo --new
flowlet a2a send '刚才的项目名是什么？' --profile=RESEARCH --session=demo
flowlet a2a send '请读取附件正文。' --file=./notes.txt --profile=RESEARCH --session=demo
flowlet a2a send '请分析图片。' --file=./image.png --profile=RESEARCH --session=demo

flowlet a2a send '长任务' --async --profile=RESEARCH --session=job
flowlet a2a tasks get --profile=RESEARCH --session=job
flowlet a2a tasks wait --profile=RESEARCH --session=job
flowlet a2a tasks cancel --profile=RESEARCH --session=job
flowlet a2a tasks subscribe --profile=RESEARCH --session=job
flowlet a2a tasks list --profile=RESEARCH --page-size=10
flowlet a2a session show --profile=RESEARCH --session=demo
```

- list 自动枚举 FLOWLET_A2A 命名空间；可用性表示 Card 发现成功，单个失败单独列 error。自定义前缀可用 list --prefix 指定。
- 普通输出为 JSON，`send --stream` / `tasks subscribe` 输出 NDJSON 标准事件；所有请求发送 A2A-Version: 1.0。
- send 默认等待任务结束；异步返回用 --async；查询/取消返回标准 Task，SendMessage 返回 `{task: ...}` 或 `{message: ...}`。
- 每个 Agent 会话使用独立 --session 名称；也可显式 --state=FILE、--context=ID。续聊不回传旧 taskId；
  --task=ID 仅用于显式继续上游允许继续的暂停任务。
- 会话记录绑定实例与凭据前缀，0600、原子写，不包含调用密钥；同名会话发送串行化。
- --file 使用标准 raw Part，--file-url 使用标准 URL Part，CLI 不下载 URL；--data=JSON 可发送结构化 Part。
  MIME 按常见扩展名推断，未知类型为 application/octet-stream；单附件可用 --media-type 显式指定。
  请求合计上限4 MiB，实际附件数量/格式/大小由上游能力决定，不在 CLI 写特定 Agent 限制。
- 网络错误、超时和断流不自动重发消息；先 tasks get 查询已保存任务。中断本地等待/订阅不会取消上游任务，取消需显式 tasks cancel。
- send/wait 任务失败、取消或暂停时退出2，协议/网络错误退出1；会话文件中保存已获取的任务 ID。

## 多实例与环境前缀

- `flowlet pull` 按服务凭据的「环境前缀」写键：一般 provider 是两把
  `{PREFIX}_URL` / `{PREFIX}_TOKEN`；Jenkins 是三把 `{PREFIX}_URL` / `{PREFIX}_USER` /
  `{PREFIX}_TOKEN`，Beszel 是三把 `{PREFIX}_URL` / `{PREFIX}_EMAIL` / `{PREFIX}_PASSWORD`，
  OCI 镜像仓库是三把 `{PREFIX}_HOST` / `{PREFIX}_USER` / `{PREFIX}_TOKEN`
  （`_HOST` 是 host[:port]，不带 scheme，可直接用于 `docker login`），
  **Uptime Kuma 是 `{PREFIX}_URL` / `{PREFIX}_API_KEY`（不是 `_TOKEN`）**。
  未设前缀时用 provider 默认（`GITLAB` / `DOCKHAND` / `JENKINS` / `UPTIME_KUMA` /
  `BESZEL` / `REGISTRY`）。
- 例：三份 Dockhand 的环境前缀为 `DOCKHAND_NA` / `DOCKHAND_SZ` / `DOCKHAND_SELF`，
  `.env` 里就是 `DOCKHAND_NA_URL` / `DOCKHAND_NA_TOKEN` / …；**不要假设只有
  `DOCKHAND_URL` 一把**，先 `flowlet list` 看实际键名。
- 离线用 CLI 时用 `--profile=<alias>` 选实例，CLI 自动组合 provider 前缀：
  `--profile=na` → `DOCKHAND_NA_*` / `REGISTRY_NA_*`，`--profile=work` → `GITLAB_WORK_*` /
  `JENKINS_WORK_*`，`--profile=tw`（uptime-kuma）→ `UPTIME_KUMA_TW_*`；不传 `--profile`
  读写默认前缀（`DOCKHAND_*` / `GITLAB_*` / `JENKINS_*` / `UPTIME_KUMA_*` / `REGISTRY_*`）。
- 环境前缀规则：大写字母开头，只含大写字母/数字/下划线，最长 24；同一 provider 多实例
  必须使用不同前缀（否则生成同名环境变量）。

## 使用规则（重要）

1. **不要 `cat` 整个凭据文件再粘进上下文。** 需要知道有哪些键用 `list`；
   需要某个值用 `get` 或（更推荐）`run`。
2. **推荐 `run`**：凭据只进子进程环境，不进入对话、不落终端历史。
   ```bash
   flowlet run --with=GITHUB_PAT -- gh pr list
   flowlet run --with=TAVILY_API_KEY -- node ./search.mjs
   ```
3. **写入用 stdin**，避免值出现在 `ps` / shell history：
   ```bash
   printf '%s' "$TOKEN" | flowlet set GITHUB_PAT --kind=mcp_token --note=github
   ```
4. 更新已存在的键时 `created_at` 保留、`updated_at` 刷新；`--kind` / `--note` 不传则沿用旧值。
5. 凭据名只允许字母、数字、下划线（不能数字开头）；值不能为空。
6. 删除前先 `list` 确认没有别的 Agent 在用；`unset` 会同时清掉元数据。

## GitLab（API v4，目标 GitLab CE 10.8.7）

GitLab 凭据不放进明文环境变量里手工传递，统一用内置适配器：

```bash
printf '%s' "$GITLAB_TOKEN" | flowlet gitlab set --url=https://gitlab.example.com
flowlet gitlab status                      # 当前用户、实例版本、API 地址
flowlet gitlab projects --search=flowlet   # 拿项目 id / path_with_namespace
flowlet gitlab api GET /projects/42/merge_requests?state=opened
flowlet gitlab api POST /projects/42/issues --data='{"title":"bug","description":"..."}'
```

要点：

- 实例是 **GitLab CE 10.8.7**：只有 10.8 已存在的端点可用。`/personal_access_tokens/self`
  是 11.x+，不要用；`/version` 仅管理员可读，非管理员会显示「版本未知」。
- 认证头固定为 `PRIVATE-TOKEN`，不要改用 `Authorization: Bearer`。
- `api` 只接受相对路径（如 `/projects`），防止 token 被发到外部地址。
- 内网自签证书：在命令后加 `--insecure`（每次显式指定，不落库）。
- 找不到项目时先 `projects --search=`；返回的 `id` 才是各端点要的 `:id`。
- `--profile=<alias>` 选择多实例，例如 `flowlet gitlab status --profile=work`；
  `env --profile=work` 输出 `GITLAB_WORK_URL` / `GITLAB_WORK_TOKEN`。
- **不要把 `gitlab env` 的输出贴进对话**，它包含明文 token。

## Dockhand（Bearer API Token，实测 1.0.57）

Dockhand 是公司内部 Docker 管理面板，用 `Authorization: Bearer <API Token>` 鉴权；
环境相关的资源接口都要 `?env=<id>`。校验 token 只能看 `GET /api/environments`
（`/api/health` 匿名可访问，不能证明 token 有效）。

```bash
printf '%s' "$DOCKHAND_TOKEN" | flowlet dockhand set --url=http://dockhand.example.com:3000
flowlet dockhand status             # health / 环境列表 / Docker 版本
flowlet dockhand envs [--json]      # id、name、host、port、protocol
flowlet dockhand stacks --env=2     # stack 名 + 容器数（--env 必填）
flowlet dockhand api GET /stacks?env=2
flowlet dockhand env                # DOCKHAND_URL / DOCKHAND_TOKEN（含明文）
flowlet dockhand clear

# 多实例
flowlet dockhand status --profile=na
flowlet dockhand env --profile=na   # DOCKHAND_NA_URL / DOCKHAND_NA_TOKEN
flowlet dockhand clear --profile=na
```

要点：

- 地址可以粘贴 `http://host:3000/api`，CLI 会归一成面板根地址；子路径部署（如 `/dockhand`）保留。
- `api` 只接受相对路径，PATH 可带 `/api` 前缀与 query。
- 内网自签证书加 `--insecure`（每次显式指定，不落库）。
- `pull` 会按环境前缀写键（默认 `DOCKHAND_URL` / `DOCKHAND_TOKEN`，多实例见上）。
- **不要把 `dockhand env` 的输出贴进对话**，它包含明文 token。

## Jenkins（用户名 + API Token）

Jenkins 的 REST API 用 HTTP Basic 认证：用户名 + API Token。凭据库里 Jenkins 是一个独立
provider，除了地址和 token 还保存用户名；校验请求是 `GET {base}/me/api/json`，版本取响应头
`X-Jenkins`。

```bash
printf '%s' "$JENKINS_TOKEN" | flowlet jenkins set --url=https://jenkins.example.com --user=ci-bot
flowlet jenkins status              # URL / 版本 / 当前用户
flowlet jenkins api GET /api/json?tree=jobs[name,color]
flowlet jenkins env                 # JENKINS_URL / JENKINS_USER / JENKINS_TOKEN（含明文）
flowlet jenkins clear

# 多实例
flowlet jenkins status --profile=work
flowlet jenkins env --profile=work  # JENKINS_WORK_URL / JENKINS_WORK_USER / JENKINS_WORK_TOKEN
```

要点：

- 服务端管理面里保存 Jenkins 凭据时**必须填用户名**，否则校验直接拒绝；token 必须属于该用户。
- 地址填 Jenkins 根地址（如 `https://jenkins.example.com`），不要带 `/me` 或 `/api/json`；
  子路径部署（如 `https://host/ci`）保留，末尾 `/` 会被去掉。
- `api` 只接受相对路径，PATH 原样拼在根地址后（Jenkins 没有统一 API 前缀，不会自动加 `/api`）。
- 内网自签证书加 `--insecure`（每次显式指定，不落库）。
- `pull` 会写三把键（默认 `JENKINS_URL` / `JENKINS_USER` / `JENKINS_TOKEN`，多实例见上）。
- **不要把 `jenkins env` 的输出贴进对话**，它包含明文 token。

## Uptime Kuma（Prometheus /metrics 只读）

Uptime Kuma 2.x **没有监控管理 REST API**：API Key 只用于 Prometheus `/metrics` 鉴权
（Basic 空用户名 + Key），不是监控项 / 通知的管理令牌，也不能当 Push token。
校验请求是 `GET {base}/metrics`，要求返回 `text/plain` Prometheus 文本；版本取
`app_version` 指标（公司内部构建是 `0.0.xx`），监控状态取 `monitor_status`。

```bash
printf '%s' "$KUMA_API_KEY" | flowlet uptime-kuma set --url=https://host/uptime-kuma
flowlet uptime-kuma status              # 指标样本 / 版本 / 监控 up-down 数量
flowlet uptime-kuma monitors [--json]   # 从 /metrics 解析 UP/DOWN + id + 名称（只读）
flowlet uptime-kuma env                 # UPTIME_KUMA_URL / UPTIME_KUMA_API_KEY（含明文）
flowlet uptime-kuma clear

# 多实例
flowlet uptime-kuma status --profile=tw
flowlet uptime-kuma env --profile=tw    # UPTIME_KUMA_TW_URL / UPTIME_KUMA_TW_API_KEY
```

要点：

- 地址填**实例根地址并带子路径**（如 `https://host/uptime-kuma`）；粘贴
  `/#/settings/api-keys` 设置页地址会被归一（丢弃 fragment），末尾 `/metrics` 也会被去掉。
- 子路径写错时 Kuma 的 SPA 兜底会返回 200 HTML——CLI 会按「不是 Prometheus 指标」报错，
  不要把它当成凭据有效。
- `disableAuth=true` 的实例可能匿名 200，此时无法从响应判断 Key 真伪；这类实例仍建议创建
  API Key，避免配置误用。
- 只能读：不能创建/暂停监控、不能改通知；写操作走 Kuma 页面或 Socket.IO 管理面。
- 内网自签证书加 `--insecure`（每次显式指定，不落库）。
- `pull` 会写两把键（默认 `UPTIME_KUMA_URL` / `UPTIME_KUMA_API_KEY`，多实例见上）。
- **不要把 `uptime-kuma env` 的输出贴进对话**，它包含明文 API Key。

## Beszel（服务器监控 Hub，邮箱 + 密码换短期 token）

Beszel 是开源服务器监控 Hub（PocketBase 底座，默认端口 8090）。它**没有长期 API Token**：
用「邮箱 + 密码」调 `POST /api/collections/users/auth-with-password` 换短期 token
（PocketBase 默认 14 天），CLI 每次现场换、不落库。后续请求头是
`Authorization: <token>`（**不是** `Bearer`）。版本取 `GET /api/beszel/info` 的 `v`，
系统数量取 `/api/collections/systems/records` 的 `totalItems`。

```bash
printf '%s' "$BESZEL_PASSWORD" | flowlet beszel set --url=http://beszel.example.com:8090 --email=you@example.com
flowlet beszel status              # URL / 版本 / 登录邮箱 / 系统数量
flowlet beszel systems [--json]    # id / name / host / status / port
flowlet beszel api GET /api/collections/systems/records?perPage=1
flowlet beszel env                 # BESZEL_URL / BESZEL_EMAIL / BESZEL_PASSWORD（含明文）
flowlet beszel clear

# 多实例
flowlet beszel status --profile=mon
flowlet beszel env --profile=mon   # BESZEL_MON_URL / BESZEL_MON_EMAIL / BESZEL_MON_PASSWORD
```

要点：

- 服务端管理面里保存 Beszel 凭据时**必须填邮箱**；邮箱明文、密码密文。
- 认证失败（PocketBase 返回 400）通常意味着邮箱或密码错误，或用了 PocketBase 超级管理员账号
  而不是 Beszel 用户账号；403 时密码登录可能被 `DISABLE_PASSWORD_AUTH` 禁用。
- 地址填 Hub 根地址；粘贴 `http://host:8090/api` 或管理面板 `http://host:8090/_/` 会被归一。
- `api` 只接受相对路径，PATH 可带 `/api` 前缀与 query。
- 内网自签证书加 `--insecure`（每次显式指定，不落库）。
- `pull` 会写三把键（默认 `BESZEL_URL` / `BESZEL_EMAIL` / `BESZEL_PASSWORD`，多实例见上）。
- **不要把 `beszel env` 的输出贴进对话**，它包含明文密码。

## OCI 镜像仓库（Registry V2，用户名 + 密码/token）

凭据库里 OCI 镜像仓库是一个独立 provider（`registry`），只按行业通用标准
Docker Registry HTTP API V2 / OCI Distribution 实现：校验是 `GET {base}/v2/`，
401 时按 `WWW-Authenticate: Bearer realm=…,service=…` 换 token 后重试，
版本取 `docker-distribution-api-version` 响应头。Harbor、Docker Hub、GHCR、Quay、ACR
等任何实现 `/v2/` 的仓库都走同一套流程；**不做**任何厂商专属 API（例如 Harbor 的
`/api/v2.0/*`）、不自动创建 robot account、不支持 `docker search` / ChartMuseum。

```bash
printf '%s' "$REGISTRY_TOKEN" | flowlet registry set --url=hub.example.com --user='robot$project+name'
flowlet registry status             # 仓库 / Registry V2 认证 / 用户名
flowlet registry env                # REGISTRY_HOST / REGISTRY_USER / REGISTRY_TOKEN（含明文）
flowlet registry clear

# 多实例
flowlet registry status --profile=na
flowlet registry env --profile=na   # REGISTRY_NA_HOST / REGISTRY_NA_USER / REGISTRY_NA_TOKEN
```

要点：

- 服务端管理面里保存 OCI 镜像仓库凭据时**必须填用户名**（`docker login` 需要用户名 +
  密码/token）；用户名允许 `$` `+` `_` `-`，robot account 直接填 `robot$project+name`，
  **没有特判**——它只是普通用户名 + token。
- 地址填仓库根地址（如 `hub.example.com` 或 `https://hub.example.com`）；带路径 / query /
  锚点会被拒绝，粘贴 `/v2/` 会被归一掉。
- `_HOST` 是 host[:port]（无 scheme），可直接传给 `docker login` / `helm registry login`：
  ```bash
  printf '%s' "$REGISTRY_TOKEN" | docker login "$REGISTRY_HOST" -u "$REGISTRY_USER" --password-stdin
  printf '%s' "$REGISTRY_TOKEN" | helm registry login "$REGISTRY_HOST" -u "$REGISTRY_USER" --password-stdin
  docker pull "$REGISTRY_HOST/project/app:1.0.0"
  helm push app-1.0.0.tgz "oci://$REGISTRY_HOST/project"
  ```
- 内网自签证书加 `--insecure`（每次显式指定，不落库）。
- `pull` 会写三把键（默认 `REGISTRY_HOST` / `REGISTRY_USER` / `REGISTRY_TOKEN`，多实例见上）。
- **不要把 `registry env` 的输出贴进对话**，它包含明文 token。

## 通用 API（Bearer）

给「一个地址 + 一把 `Authorization: Bearer <token>`」的三方服务用（provider id `http-bearer`）。
典型例子是自建面板：FileBrowser Quantum、各种 admin UI、小众 SaaS 的 API Key。它们的认证
模型和 GitLab / Dockhand 一样，但**没有统一的元数据接口**，所以这个 provider 只保证
「存得住、同步得到、注入得进去」，校验是尽力而为。

```bash
printf '%s' "$TOKEN" | flowlet http-bearer set --url=https://files.example.com/files --profile=FB
flowlet http-bearer status --profile=FB     # 地址 / 状态码 / 认证是否生效
flowlet http-bearer env --profile=FB        # HTTP_BEARER_FB_URL / HTTP_BEARER_FB_TOKEN（含明文）
flowlet http-bearer clear --profile=FB
```

要点：

- 不传 `--profile` 时默认前缀是 `HTTP_BEARER`（`HTTP_BEARER_URL` / `HTTP_BEARER_TOKEN`）；
  实际使用时几乎总该显式给一个有意义的前缀，例如 `--profile=FB`，或直接在服务端页面把
  环境前缀填成 `FILEBROWSER`。
- 校验打**两次**：带 token 一次、不带一次。
  - 401/403 → 确定失败，不保存；
  - 带 token 2xx 且匿名 401/403 → 「认证生效」；
  - 带 token 2xx 且匿名也 2xx → 只能说「地址可达」，**不会谎报 token 有效**。
    首页公开、只有 `/api/*` 才鉴权的服务（例如 FileBrowser Quantum 的 `/files`）属于这一类；
  - 404/405 → 「该路径没有端点，无法据此判断 token」，**仍然允许保存**：通用 provider
    猜不到服务的端点布局（`https://api.cloudflare.com/client/v4` 的裸根就是 404）。
- 子路径部署请带上子路径（`https://host/files`）。裸路径返回 301 到「带斜杠」时，
  探针会在同一地址上补 `/` 重试一次——**不跟随 Location**，token 不会被带到别的地址。
- 不跟随重定向、10s 超时、`--insecure` 跳过 TLS 校验，与其它 provider 一致。
- `pull` 写两把键：`{PREFIX}_URL` / `{PREFIX}_TOKEN`。

## 与 Agent 配置的关系

- MCP 服务器配置里的 `env` / `headers`、CLI 的 `*_TOKEN` 环境变量都从这份库取；
  Flowlet 接入抽屉后续会直接引用这里的键，而不是让用户重复粘贴明文。
- 需要把凭据写进某个 Agent 的配置时，用 `flowlet get` 取值后交给写入流程，
  不要自行拼 `credentials.env` 的路径去改文件。

## 排查

```bash
flowlet path     # 当前实际使用的文件路径
flowlet doctor   # 权限、重复键、缺元数据
```

若提示 `凭据不存在`，先 `list` 看键名（大小写敏感）；多实例时确认 `--profile` 与
`.env` 中的前缀是否对应。

若 `flowlet pull` 报 `缺少凭据：先运行 flowlet login --server=…` 或
`登录已过期或被撤销，请重新 flowlet login --server=…`，重新走一次 login；不要在 OIDC-only
实例上尝试 `--token` / `FLOWLET_ADMIN_TOKEN`（必然 401）。服务端撤销入口在
「服务凭据 → 本机接入 → 已授权的 CLI」。