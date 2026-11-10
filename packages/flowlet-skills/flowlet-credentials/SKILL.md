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
  Dockhand），保存即校验，token 加密存服务端，界面只显示掩码；同一 provider 多实例用
  「环境别名（Env 前缀）」区分（例如 `DOCKHAND_NA` / `DOCKHAND_SZ` / `DOCKHAND_SELF`）。
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
- CLI 的 `gitlab set` / `dockhand set` 只用于没有服务端管理面的离线场景；正常流程不要手工配置。

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

## 多实例与环境前缀

- `flowlet pull` 按服务凭据的「环境前缀」写两把键：`{PREFIX}_URL` / `{PREFIX}_TOKEN`；
  未设前缀时用 provider 默认（`GITLAB` / `DOCKHAND`）。
- 例：三份 Dockhand 的环境前缀为 `DOCKHAND_NA` / `DOCKHAND_SZ` / `DOCKHAND_SELF`，
  `.env` 里就是 `DOCKHAND_NA_URL` / `DOCKHAND_NA_TOKEN` / …；**不要假设只有
  `DOCKHAND_URL` 一把**，先 `flowlet list` 看实际键名。
- 离线用 CLI 时用 `--profile=<alias>` 选实例，CLI 自动组合 provider 前缀：
  `--profile=na` → `DOCKHAND_NA_*`，`--profile=work` → `GITLAB_WORK_*`；
  不传 `--profile` 读写默认前缀（`DOCKHAND_*` / `GITLAB_*`）。
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