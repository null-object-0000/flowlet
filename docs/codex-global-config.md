# Codex 全局配置管理

Flowlet 管理 Codex 的用户级全局配置。Codex CLI、ChatGPT 桌面端 Codex 与 VS Code Codex 插件共享同一份
`~/.codex/config.toml` 与 `~/.codex/auth.json`（官方确认无需分别配置），一次写入即覆盖全系。

## 文件位置

- 主配置：`~/.codex/config.toml`；
- 凭据：`~/.codex/auth.json`（`OPENAI_API_KEY`，配合 provider 的 `requires_openai_auth = true`，不动系统环境变量）；
- 模型目录：`~/.codex/model-catalog.flowlet.json`（Flowlet 生成，声明 `flowlet-pro` / `flowlet-flash` 的上下文窗口与推理档位）；
- Flowlet 备份：配置目录下 `.flowlet/codex-global-config-backup.json`。

Windows 下 `~` 对应 `%USERPROFILE%`。

## Flowlet 管理的字段

主配置：

```toml
model = "flowlet-pro"
model_provider = "flowlet"
disable_response_storage = true
preferred_auth_method = "apikey"
model_catalog_json = "~/.codex/model-catalog.flowlet.json"

[model_providers.flowlet]
name = "flowlet"
base_url = "http://127.0.0.1:18640/v1"
wire_api = "responses"
requires_openai_auth = true
```

凭据文件：

```json
{
  "OPENAI_API_KEY": "<Flowlet Client Token>"
}
```

模型目录（由仓库根目录 `codex-models.json` 内置生成，字段说明见 `docs/config.md` 第 10 节）：

```json
{
  "models": [
    {
      "slug": "flowlet-pro",
      "display_name": "Flowlet Pro",
      "description": "Flowlet aggregated coding model routed to available accounts.",
      "default_reasoning_level": "high",
      "supported_reasoning_levels": [
        { "effort": "low", "description": "Fast responses with lighter reasoning" },
        { "effort": "high", "description": "Extra high reasoning depth for complex problems" },
        { "effort": "max", "description": "Maximum reasoning depth for the hardest problems" }
      ],
      "context_window": 1048576,
      "supported_in_api": true
    }
  ]
}
```

## 设计说明

- **Responses 无状态透传**：Flowlet 经 Responses 协议接入 Codex，并强制 `disable_response_storage = true`，
  防止 Codex 携带 `store` / `previous_response_id` 破坏 Flowlet 的多账号路由；该字段是 Flowlet 接入的强制项。
- **模型目录**：`flowlet-pro` / `flowlet-flash` 是 Flowlet 私有聚合模型，不在 Codex 内置模型目录中，
  必须通过 `model_catalog_json` 声明元数据（上下文窗口、推理档位），否则 Codex 无法正确识别。
  `model_catalog_json` 仅在 Codex 启动时读取一次，补写后需重启 Codex 才生效。
- **命名空间文件**：生成文件名带 `flowlet` 前缀（`model-catalog.flowlet.json`），避免覆盖 DeepSeek
  （`~/.codex/models.json`）或千问（`~/.codex/model-catalog.local.json`）等其他厂商的模型目录文件。
- **鉴权方式**：使用 `requires_openai_auth = true` + `auth.json` 的 `OPENAI_API_KEY`（DeepSeek/千问文档
  使用 `experimental_bearer_token` 或环境变量，属合理差异）；备份/恢复保留原有登录态字段。

## 合并、备份与恢复

- 使用 TOML 文档做局部修改，保留用户注释、其他 provider 和未受管字段；`[model_providers.flowlet]`
  表整体替换，顺带清理旧版本残留的多余字段；
- 首次应用前备份受管顶层键（`model`、`model_provider`、`disable_response_storage`、
  `preferred_auth_method`、`model_catalog_json`）、`[model_providers.flowlet]` 表、
  `auth.json` 的 `OPENAI_API_KEY` 以及 `~/.codex/model-catalog.flowlet.json` 的原有内容；
- 重新应用时若备份缺失模型目录字段（旧版本备份），会就地升级备份，使恢复时能清理 Flowlet 生成的模型目录；
- 恢复时只还原上述受管内容，保留用户之后新增的其他配置和凭据；若 `config.toml` / `auth.json` /
  模型目录均由 Flowlet 创建且恢复后为空，则删除对应文件；
- 主配置、凭据与模型目录作为一个事务更新，任一写入失败时恢复全部文件的原始内容，避免留下半配置状态。
