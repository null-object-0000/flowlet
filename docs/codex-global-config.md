# Codex 全局配置管理

Flowlet 管理 Codex 的用户级全局配置。Codex CLI、ChatGPT 桌面端 Codex 与 VS Code Codex 插件共享同一份
`~/.codex/config.toml` 与 `~/.codex/auth.json`（官方确认无需分别配置），一次写入即覆盖全系。

## 文件位置

- 主配置：`~/.codex/config.toml`；
- 凭据：`~/.codex/auth.json`（`OPENAI_API_KEY`，配合 provider 的 `requires_openai_auth = true`，不动系统环境变量）；
- 模型目录：`~/.codex/model-catalog.flowlet.json`（Flowlet 按接入抽屉所选主模型动态生成，声明该模型的上下文窗口与推理档位）；
- Flowlet 备份：配置目录下 `.flowlet/codex-global-config-backup.json`。

Windows 下 `~` 对应 `%USERPROFILE%`。

## Flowlet 管理的字段

主配置：

```toml
model = "<接入抽屉中选择的主模型，如 deepseek-v4-pro>"
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

模型目录（以下为按所选主模型 `deepseek-v4-pro` 动态生成的**实际输出示例**，不同模型字段值不同；
字段说明见 `docs/config.md` 第 10 节）：

```json
{
  "models": [
    {
      "slug": "deepseek-v4-pro",
      "display_name": "DeepSeek-V4-Pro-0813",
      "description": "Flowlet 本地代理转发的 deepseek-v4-pro",
      "default_reasoning_level": "high",
      "supported_reasoning_levels": [
        { "effort": "low", "description": "Fast responses with lighter reasoning" },
        { "effort": "medium", "description": "Greater reasoning depth for complex problems" },
        { "effort": "high", "description": "Extra high reasoning depth for complex problems" },
        { "effort": "xhigh", "description": "Maximum reasoning depth for the hardest problems" }
      ],
      "shell_type": "shell_command",
      "visibility": "list",
      "supported_in_api": true,
      "priority": 1,
      "base_instructions": "",
      "supports_reasoning_summaries": true,
      "default_reasoning_summary": "none",
      "support_verbosity": false,
      "default_verbosity": null,
      "apply_patch_tool_type": "freeform",
      "web_search_tool_type": "text",
      "truncation_policy": { "mode": "tokens", "limit": 10000 },
      "supports_parallel_tool_calls": true,
      "supports_image_detail_original": false,
      "context_window": 1000000,
      "max_context_window": 1000000,
      "auto_compact_token_limit": null,
      "effective_context_window_percent": 95,
      "experimental_supported_tools": [],
      "input_modalities": [ "text" ],
      "availability_nux": null,
      "upgrade": null
    }
  ]
}
```

> 该文件是 Codex CLI 启动时 serde 反序列化的**必填字段集合**：缺失 `shell_type` 等字段会直接报错
> （`missing field ...`）。推理档位只使用 `none` / `minimal` / `low` / `medium` / `high` / `xhigh`，
> 不使用 `max` / `ultra`（后者需要 Codex ≥ 0.144，0.137.0 会拒绝解析）。

## 设计说明

- **Responses 无状态透传**：Flowlet 经 Responses 协议接入 Codex，并强制 `disable_response_storage = true`，
  防止 Codex 携带 `store` / `previous_response_id` 破坏 Flowlet 的多账号路由；该字段是 Flowlet 接入的强制项。
- **模型目录**：Codex 使用 Flowlet 开放的自定义规范模型，不在 Codex 内置模型目录中，必须通过
  `model_catalog_json` 声明元数据（上下文窗口、推理档位），否则 Codex 无法正确识别。目录不再
  使用仓库级静态快照，而是按所选主模型从 `models-cn.json` 动态生成单条目：`context_window` /
  `max_context_window` 取 `limits.contextTokens`，`input_modalities` 始终包含 `text`、目录含
  `image` 时追加，`supported_reasoning_levels` / `default_reasoning_level` 按
  `capabilities.thinking` 给出档位（支持推理：`low` / `medium` / `high` / `xhigh`、默认 `high`；
  否则 `low` / `medium` / `high`、默认 `medium`），`supports_reasoning_summaries` 跟随该能力；
  查不到模型时使用保守条目（`context_window: 128000`、`input_modalities: ["text"]`）并告警。
  `model_catalog_json` 仅在 Codex 启动时读取一次，补写后需重启 Codex 才生效；切换主模型后需重新
  执行一键接入以重新生成目录。
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
