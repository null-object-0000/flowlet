# 全局凭据库与 `flowlet-cred`

状态：v0（CLI + 存储已可用；类型语义、UI 与 Agent 接入注入尚未接入）
日期：2026-11-10

## 1. 定位

Flowlet 的凭据分两种，**不要混为一谈**：

| 类型 | 用途 | 现状 |
|---|---|---|
| 调用密钥（client token） | 客户端/Agent 调用 Flowlet 模型入口时出示 | `ProxyBindConfig.default_client_token` |
| **三方服务凭据** | Agent 接入后要用的 Anthropic/OpenAI/GitHub/Tavily、CLI token、MCP token 等 | 本文档描述的全局凭据库 |

全局凭据库要解决的是：三方 key 原本散落在各 Agent 的配置文件、MCP 的 `env`/`headers`、
临时环境变量里；现在集中到一份 dotenv，由 CLI 统一写入，Agent 按需读取或用 CLI 注入。

## 2. 存储布局

凭据有两个落点，职责不同：

- **服务端（Docker / 桌面）**：管理面配置的凭据，加密存在 SQLite；
- **本机 CLI**：`.env` 文件，供 Agent 直接读取 / `source`。

### 2.1 本机 CLI 存储

```text
<config_dir>/flowlet/credentials/
  credentials.env     # 唯一事实源，dotenv 格式，权限 0600
  credentials.json    # 元数据 sidecar：kind / note / created_at / updated_at，权限 0600
```

- Linux/macOS：`~/.config/flowlet/credentials/`；Windows：`%APPDATA%\flowlet\credentials\`；
- 可用 `FLOWLET_CRED_DIR` 覆盖（测试、容器内固定路径）；
- 目录用 `0700`，文件用 `0600`；写入是临时文件 + rename 的原子替换，不会留下半截文件；
- `.env` 里的注释与未知行会被保留，重复键以最后一次出现为准（`doctor` 会告警）。

`credentials.env` 示例：

```dotenv
# Flowlet 全局凭据库
GITHUB_PAT=ghp_xxx
TAVILY_API_KEY='tvly-xxx'
```

值只在安全字符时裸写，否则用单引号并转义内部单引号（可被 `source` 或被常见 dotenv 解析器读取）。

### 2.2 服务端存储（管理面）

```text
<data_dir>/secret.key              # 32 字节随机密钥，0600，首次启动生成
SQLite service_credentials 表       # id / name / provider / base_url /
                                   # secret_ciphertext（ChaCha20-Poly1305）/ secret_hint /
                                   # kind / note / enabled / 时间戳 / 最近校验结果
```

- 数据目录：Docker 是 `/data`（命名卷 `flowlet-data`），桌面是 SQLite 所在目录或便携目录；
- 密文格式 `v1:<base64(nonce||ciphertext)>`，接口只返回 `••••` + 末 4 位；
- 密钥文件与卷一起备份；密钥丢失等于凭据不可解密，需要重新填写。

## 3. CLI

```bash
flowlet-cred init                                # 初始化目录与空文件
flowlet-cred path                                # 打印当前 .env 路径
flowlet-cred list [--json]                       # 名字/类型/备注/更新时间，永不含值
flowlet-cred get <KEY> [--mask]                  # 取单个值
flowlet-cred set <KEY> [--kind=K] [--note=N]     # 值从 stdin 读，或 --value=V
flowlet-cred unset <KEY>
flowlet-cred env [--only=A,B]                    # 输出 dotenv
flowlet-cred export [--only=A,B] --format=dotenv|shell|json
flowlet-cred run --with=A,B -- <程序> [参数...]   # 只注入指定凭据到子进程
flowlet-cred doctor                              # 权限/重复键/元数据检查
flowlet-cred pull --server=http://host:20134 --token=<管理凭据>
                                                 # 从服务端同步到本机 .env（--dry-run 只预览）
```

构建（不依赖 Tauri）：

```bash
cargo build --release --manifest-path src-tauri/Cargo.toml --no-default-features --bin flowlet-cred
# 产物：src-tauri/target/release/flowlet-cred
```

## 4. 安全约定

1. **值不进 `list`**：列表只给键名、类型、备注、时间，避免 Agent 一次拉走全部明文。
2. **写入只走 CLI**：键名校验（`[A-Za-z_][A-Za-z0-9_]*`）、值非空、原子写、`0600`。
   手工编辑会跳过这些保证，`doctor` 能发现权限过宽和重复键。
3. **推荐 `run`**：凭据只注入子进程环境，不进入对话上下文，也不出现在 `ps` 的参数里。
4. **`set` 优先 stdin**：`printf '%s' "$TOKEN" | flowlet-cred set KEY`，避免值进 shell history。
5. 当前**不加密**（明文 dotenv，靠 `0600` + 目录权限）：这是有意取舍——Agent 需要能直接
   `cat`/`source`；加密会强制所有读取方都经过 CLI 解密。若后续需要加密，应在不改变
   「`.env` 是事实源」的前提下加一层可选解锁，而不是把值搬进数据库。

## 5. `kind` 语义与扩展

`--kind` 现在只是标签，默认 `api_key`，允许 `cli_token`、`mcp_token` 或任意小写标识
（`[a-z0-9_-]{1,32}`）。后续按类型增加语义时的约定：

- `api_key`：三方 HTTP API 凭据（LLM 厂商、搜索、支付等）；
- `cli_token`：CLI 工具凭据（`gh auth token`、`vercel`、`cloudflare` 等）；
- `mcp_token`：MCP 服务器的 `headers` / `env` 凭据；
- 新增类型时必须同步本文档与 `.agents/skills/flowlet-credentials/SKILL.md`。

## 6. 管理面：服务凭据页（Docker / 桌面）

三方凭据的增删改与校验在 UI 里完成，不要求手工编辑文件：

- **入口**：左侧一级菜单「服务凭据」（本轮按用户要求新增；此前菜单枚举不含该入口）；
- **列表**：名称、服务类型、实例地址、Token 掩码、最近校验结果、启停状态；
- **添加 / 编辑**：名称、实例地址、Token、备注、启用；GitLab 是第一个 provider；
- **保存即校验**：服务端先请求 `GET {base}/api/v4/user`，失败直接返回错误且不落库；
- **测试**：对已保存凭据重新校验并刷新 `last_verified_at` / `last_error`；
- **删除**：清除服务端密文；已同步到 Agent 机器的 `.env` 不受影响。

对应的管理命令（桌面 Tauri 与 Web 白名单同名）：

```text
list_credential_providers / list_service_credentials /
save_service_credential / test_service_credential /
delete_service_credential / export_service_credentials
```

`export_service_credentials` 是 `flowlet-cred pull` 的数据源，返回明文，因此和其他管理命令
一样要求管理凭据（Web Host 上未通过鉴权返回 401）。UI 页面本身不调用它。

UI 是配置入口，CLI 是分发/消费入口：

```text
UI 添加 GitLab → 服务端加密落库 → Agent 机器 `flowlet-cred pull` → 本机 .env → Agent 读取/run
```

## 7. GitLab 适配（API v4，目标版本 CE 10.8.7）

第一个内置三方服务是 GitLab，按 **GitLab Community Edition 10.8.7（revision `eb600b0`）**
实现。版本约束决定了实现细节：

| 约束 | 做法 |
|---|---|
| 10.8 时代 PAT 走 `PRIVATE-TOKEN` 最稳 | 只用 `PRIVATE-TOKEN` 请求头，不用 `Authorization: Bearer` |
| 没有 `/personal_access_tokens/self`（11.x+） | 不做 token 自省；用 `GET /user` 验证有效性 |
| `/version` 仅管理员可用 | 非管理员返回 403/404 时静默降级为「版本未知」，不报错 |
| 分页头是 `X-Next-Page` / `X-Total` | 按 `X-Next-Page` 翻页，`0`/空都视为末页 |
| 支持子路径部署（`https://host/gitlab`） | `normalize_base_url` 保留子路径，用户粘 `/api/v4` 也兼容 |

存储两个键：`GITLAB_URL`（kind `service`）与 `GITLAB_TOKEN`（kind `cli_token`）。

```bash
printf '%s' "$GITLAB_TOKEN" | flowlet-cred gitlab set --url=https://gitlab.example.com
flowlet-cred gitlab status                       # 用户 / 版本 / API 地址
flowlet-cred gitlab projects --search=flowlet    # 默认只看自己参与的项目，--all 放开
flowlet-cred gitlab api GET /projects/42/merge_requests?state=opened
flowlet-cred gitlab api POST /projects/42/issues --data='{"title":"...","description":"..."}'
flowlet-cred gitlab env                          # GITLAB_URL / GITLAB_TOKEN（含明文，慎用）
flowlet-cred gitlab clear
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

## 8. 与 Flowlet 其它能力的关系

- **与渠道账号**：`channel_accounts.api_key` 是上游模型账号，走路由与余额同步；
  全局凭据库不参与模型路由，两者不要互相写入。
- **与 Agent 接入**：后续接入抽屉直接引用本库的键名（MCP 的 `env`/`headers`、CLI 环境变量），
  不再让用户重复粘贴明文；当前尚未接线。
- **与 Docker 版**：服务端提供「服务凭据」管理页，凭据加密落在 `/data`（命名卷）；
  Agent 机器上执行 `flowlet-cred pull --server=http://<host>:20134` 同步到本地 `.env`。
  容器内没有用户 `config_dir`，CLI 需要显式设置 `FLOWLET_CRED_DIR` 时才在容器里使用。
- **与 UI**：`core/credential_store.rs` 是纯 Rust 模块，后续可直接被桌面/Web 命令复用
  （读列表、读单值、写值、删除），不需要重写存储层。

## 9. 验收

- `cargo test --no-default-features --lib credential_store`：9 个用例覆盖读写、顺序、
  注释保留、引号编码、权限、重复键、导出格式、非法键名；
- `cargo test --no-default-features --lib gitlab`：7 个用例覆盖 URL 归一（含子路径与
  `/api/v4` 粘贴）、相对路径限制、项目解析、错误码提示、分页头（含末页 0 值）；
- `cargo test --no-default-features --lib secret_box`：4 个用例覆盖加解密、密钥跨实例稳定、
  不同密钥不可解、密文篡改被拒；
- `cargo test --no-default-features --lib storage_credentials`：2 个用例覆盖 CRUD、启停、
  校验结果落库；
- 端到端（headless + mock GitLab 10.8.7）：`list → save（校验后加密落库）→ test → export →
  delete`，确认 SQLite 中搜不到明文 token、`secret.key` 权限 600、非法 token 不入库、
  未鉴权导出返回 401；再执行 `flowlet-cred pull`，确认本机 `.env` 写入
  `GITLAB_URL` / `GITLAB_TOKEN` 且 `--dry-run` 不写文件。
- 手工冒烟（凭据库）：`init → set → list → get --mask → env → run --with → doctor`，
  确认 `run` 只注入指定变量、文件权限 600；
- 手工冒烟（GitLab）：对 10.8.7 语义的 mock 执行 `gitlab set → status → projects → api`，
  以及错误 token 不落库、未配置提示、`env`/`clear`。

`FLOWLET_CRED_DIR` 可在两条验收里都指向临时目录，避免污染真实凭据。