---
name: flowlet-credentials
description: 通过 flowlet CLI 使用 Flowlet 下发的全局凭据库（GitLab / Dockhand 等三方服务 token）。当需要为 MCP 服务器、CLI 工具或三方 API 取用密钥，或需要新增/更新/删除一把凭据时使用；也适用于「Agent 要用某个 token 但不想让它进入上下文」的场景——优先用 flowlet run 把值注入子进程。
---

# Flowlet 凭据库（flowlet-credentials）

Flowlet 在一台机器上维护一个全局凭据库（单个 dotenv 文件，默认
`~/.config/flowlet/credentials/credentials.env`，可用 `FLOWLET_CRED_DIR` 覆盖），
并通过 `flowlet` 命令读写。凭据可以来自 Flowlet Web Host 服务凭据页下发
（`flowlet pull`），也可以在本机直接 `flowlet set`。

## 何时使用

- 某个命令 / MCP 服务器 / API 需要 token，但你不希望 token 进入对话上下文；
- 需要查询本机有哪些凭据可用（只列键名，不打印值）；
- 需要把凭据注入子进程环境（推荐方式）；
- 需要新增、更新或删除一把凭据。

## 先确认 CLI 已安装

```sh
flowlet --version
```

未安装时，使用 Flowlet Web Host「服务凭据 → 本机接入」提供的安装命令
（`install-flowlet.sh`，需要 Node.js 22.6+），或向用户索取安装命令，不要自行猜测下载地址。

## 常用命令

```sh
flowlet init                     # 初始化凭据目录
flowlet list                     # 列出凭据键名（永不含明文值）
flowlet get <KEY> --reveal       # 仅在确实需要明文时使用，注意不要回显到对话
flowlet set <KEY>                # 值从 stdin 读取，避免出现在进程列表
flowlet unset <KEY>              # 删除
flowlet env                      # 输出 dotenv（可写入其它 .env）
flowlet run --with=A,B -- <命令>  # 只把指定凭据注入子进程环境（推荐）
flowlet doctor                   # 检查权限、重复键与元数据
flowlet pull --server=<Flowlet 地址> --token=<管理凭据>
                                 # 从 Flowlet Web Host 同步服务凭据到本机
```

## 多实例与环境前缀

同一个服务（例如三份 Dockhand）可以有多个实例，Flowlet 用「环境别名 / Env 前缀」
区分它们。同步到本机后，环境变量名为：

```text
{PREFIX}_URL    服务地址
{PREFIX}_TOKEN  访问 token
```

未设置前缀时使用 provider 默认值：GitLab → `GITLAB_URL` / `GITLAB_TOKEN`，
Dockhand → `DOCKHAND_URL` / `DOCKHAND_TOKEN`。

示例（Dockhand 三实例：北美线上 / 苏州线下 / 自用线上）：

```text
DOCKHAND_NA_URL    DOCKHAND_NA_TOKEN
DOCKHAND_SZ_URL    DOCKHAND_SZ_TOKEN
DOCKHAND_SELF_URL  DOCKHAND_SELF_TOKEN
```

使用具体实例时：

```sh
flowlet dockhand status --profile=na
flowlet dockhand envs --profile=na --json
flowlet dockhand stacks --env=2 --profile=na
flowlet dockhand api /environments --profile=na
```

GitLab 同理：`flowlet gitlab status --profile=work`。

## 安全规则

- 不要把明文 token 打印到对话、日志或提交到任何仓库；
- 优先用 `flowlet run --with=KEY -- <命令>` 注入子进程，而不是先 `get --reveal` 再手工拼环境变量；
- 不要把 `.env` / `credentials.env` / `credentials.json` 提交到 git；
- `flowlet list` 只暴露键名；`flowlet get` 默认掩码，`--reveal` 是显式动作；
- 凭据文件由 CLI 原子写入（0600）维护，不要手工重排；确需手工编辑时先备份。

## 故障排查

- `flowlet doctor`：权限、重复键、元数据异常；
- 命令不存在 / 版本过低：重新运行安装命令，确认 Node.js ≥ 22 且 `~/.local/bin` 在 PATH 中；
- `flowlet pull` 拉不到凭据：确认 Flowlet 服务凭据已启用、环境前缀唯一，并核对管理凭据；
- 环境变量名冲突：同一 provider 的多实例必须在 Flowlet 页面设置不同「环境别名（Env 前缀）」。
