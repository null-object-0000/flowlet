# Claude Code 全局配置管理

## 1. 目标

Flowlet 管理 Claude Code 用户级全局配置，使用户从任意系统终端、IDE 或工作目录启动 Claude Code 时，都可以通过 Flowlet 的 Anthropic-compatible 本地入口访问开放模型。

本能力不负责打开系统终端或启动外部 Claude Code 进程。Flowlet 内嵌 Agent 终端是后续独立能力，见 [`agent-terminal.md`](./agent-terminal.md)。

## 2. 配置位置

Claude Code 官方用户配置文件：

```text
~/.claude/settings.json
```

Windows 中默认解析为：

```text
%USERPROFILE%\.claude\settings.json
```

如果启动 Flowlet 时存在 `CLAUDE_CONFIG_DIR`，则使用：

```text
%CLAUDE_CONFIG_DIR%\settings.json
```

后端会解析已有文件的真实路径，兼容符号链接。配置文件不存在时，只在用户主动点击“全局接入 Flowlet”后创建。

## 3. 状态模型

```text
not_configured   没有 Flowlet 管理字段
flowlet          Base URL、认证和模型映射均正确指向 Flowlet
other_gateway    当前 ANTHROPIC_BASE_URL 指向其他网关
partial          已存在相关字段，但不足以形成有效 Flowlet 配置
invalid          settings.json 不是合法 JSON，或顶层 / env 结构无效
```

`invalid` 状态下禁止写入，避免覆盖用户需要手动修复的配置。

状态结果可以返回配置文件路径、Base URL、模型名和“Token 是否配置”，但绝不返回 Token、API Key 或备份中的原始凭据。

接入抽屉默认以固定长度掩码展示 Client Token；用户主动点击查看后仅在当前抽屉会话临时显示，关闭后恢复掩码。复制 Token 或手动配置片段时仍使用真实值。

## 4. Flowlet 管理字段

点击“全局接入 Flowlet”后，Flowlet 在 `settings.json.env` 中写入：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:18640/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "<Flowlet Client Token>",
    "ANTHROPIC_MODEL": "flowlet-pro",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "flowlet-pro",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "flowlet-pro",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "flowlet-flash",
    "ANTHROPIC_SMALL_FAST_MODEL": "flowlet-flash",
    "CLAUDE_CODE_SUBAGENT_MODEL": "flowlet-flash"
  }
}
```

模型别名必须完整映射：Claude Code 的主会话、模型切换和后台功能可能分别使用 Opus、Sonnet 和 Haiku。Flowlet 将 Opus / Sonnet 映射到 `flowlet-pro`，将 Haiku 和子 Agent 映射到 `flowlet-flash`。

`ANTHROPIC_SMALL_FAST_MODEL` 是 Claude Code 的遗留小模型变量。它在会话标题生成等后台任务中仍优先于 `ANTHROPIC_DEFAULT_HAIKU_MODEL` 生效，因此必须一并写入 `flowlet-flash`。如果 settings.json 中残留用户手动配置的 `ANTHROPIC_SMALL_FAST_MODEL`（例如指向某个直接模型），接入状态会被判定为 `partial`，重新写入后即可收敛；其原值进入备份并可恢复。

为避免用户级配置继续绕过 Flowlet，应用时移除以下冲突字段：

```text
ANTHROPIC_API_KEY
CLAUDE_CODE_USE_BEDROCK
CLAUDE_CODE_USE_VERTEX
CLAUDE_CODE_USE_FOUNDRY
CLAUDE_CODE_USE_MANTLE
```

这些字段的原值会进入 Flowlet 本地备份并可恢复。

## 5. 安全合并与备份

Flowlet 只修改 `env` 中明确声明的受管字段，保留：

- permissions；
- hooks；
- plugins；
- MCP；
- theme；
- 用户自定义环境变量；
- 其他未知字段。

第一次接入前创建活动备份：

```text
<Claude 配置目录>/.flowlet/claude-code-global-config-backup.json
```

备份保存受管字段在修改前是否存在及其原值。再次写入 Flowlet 配置不会覆盖原始活动备份。

点击“恢复接入前配置”时：

1. 读取当前 `settings.json`；
2. 只恢复 Flowlet 受管字段；
3. 保留用户接入 Flowlet 之后新增或修改的其他字段；
4. 如果原文件不存在且恢复后没有其他内容，删除 Flowlet 创建的空配置文件；
5. 成功后删除活动备份标记。

配置与备份均使用临时文件写入后原子替换。Unix 平台文件权限设置为 `0600`。Windows 文件保存在当前用户的 Claude 配置目录中，不向前端返回备份内容。

## 6. 配置优先级限制

用户级 `settings.json` 不是 Claude Code 的最高优先级。以下来源可能覆盖它：

- 启动 Claude Code 的 Shell 环境变量；
- 命令行参数；
- 项目 `.claude/settings.json`；
- 项目 `.claude/settings.local.json`；
- 企业托管配置。

Flowlet 会检查自身进程环境中已存在的 Claude 相关环境变量，只返回变量名称并在 UI 中提示，不读取或展示其值。

Flowlet 无法预先扫描用户未来可能进入的所有项目，因此项目级和企业托管覆盖需要用户在具体 Claude Code 会话中通过 `/status` 确认。

## 7. 调用链

```text
AgentAccessSideSheet
  -> useClaudeCodeGlobalConfig
  -> src/domains/agent/commands.ts
  -> inspect/apply/restore_agent_global_config
  -> src-tauri/src/core/agent_global_config.rs
  -> ~/.claude/settings.json
```

前端负责状态展示、操作编排和用户反馈；Rust 负责路径解析、JSON 校验、受管字段合并、备份、恢复、原子写入和凭据隔离。

## 8. 生效方式

- Flowlet 自身配置与代理：不需要重启；
- 已经运行的 Claude Code：需要退出并重新启动；
- 新启动的 Claude Code：自动读取用户级 `settings.json`；
- 修改 Flowlet 代理端口或 Client Token 后：重新点击“重新写入 Flowlet 配置”。

手动配置区域提供与第 4 节一键写入内容一致的完整 `settings.json.env` 片段，不再只提供 Base URL 和 Token 两个环境变量。

## 9. 参考

- [Claude Code 配置](https://code.claude.com/docs/en/configuration)
- [Claude Code 环境变量](https://code.claude.com/docs/en/env-vars)
- [Claude Code 模型配置](https://code.claude.com/docs/en/model-config)
