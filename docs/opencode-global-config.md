# OpenCode 全局配置管理

Flowlet 管理 OpenCode 用户级全局配置。OpenCode CLI 与 Desktop 读取同一份 Provider、模型和凭据配置，因此一次接入会同时覆盖两端。

## 文件位置

- Provider 与默认模型：`~/.config/opencode/opencode.jsonc`，若只存在 `opencode.json` 则沿用该文件；
- Provider 凭据：`~/.local/share/opencode/auth.json`；
- Flowlet 备份：配置目录下 `.flowlet/opencode-global-config-backup.json`。

Windows 下 `~` 对应 `%USERPROFILE%`。

## Flowlet 管理的字段

配置文件：

```jsonc
{
  "model": "flowlet/flowlet-pro",
  "small_model": "flowlet/flowlet-flash",
  "provider": {
    "flowlet": {
      "name": "Flowlet",
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://127.0.0.1:18640/v1"
      },
      "models": {
        "flowlet-pro": { "name": "flowlet-pro" },
        "flowlet-flash": { "name": "flowlet-flash" }
      }
    }
  }
}
```

凭据文件：

```json
{
  "flowlet": {
    "type": "api",
    "key": "<Flowlet Client Token>"
  }
}
```

状态接口只返回凭据是否存在，不返回 Token 内容。

## 合并、备份与恢复

- 使用 JSONC CST 做局部修改，保留其他 Provider、用户字段和未受管注释；
- 首次应用前备份 `$schema`、`model`、`small_model`、Provider 启停列表、`provider.flowlet` 和 `auth.json` 中的 `flowlet` 凭据；
- 应用时从 `disabled_providers` 移除 `flowlet`；若用户设置了 `enabled_providers` 白名单，则把 `flowlet` 加入白名单；
- 恢复时只还原上述受管字段，保留用户之后新增的其他配置和凭据；
- 若两个文件均由 Flowlet 创建且恢复后为空，则删除对应文件；
- 写入使用临时文件替换，并对支持 Unix 权限的平台设置为 `0600`。
- 配置文件与凭据文件作为一个事务更新；第二个文件写入失败时恢复两个文件修改前的原始字节内容，避免留下半配置状态；
- 手动配置区域分别提供 `opencode.jsonc` 和 `auth.json` 片段，Client Token 默认脱敏但复制使用真实值。

## 覆盖与生效

`OPENCODE_CONFIG` 和 `OPENCODE_CONFIG_CONTENT` 的优先级高于全局配置。Flowlet 检测到这些环境变量时会提示外部覆盖，但不会修改它们。

正在运行的 OpenCode CLI 或 Desktop 可能缓存配置。应用或恢复后应重新启动对应客户端；不需要重启 Flowlet 代理。
