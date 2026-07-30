# OpenCode 全局配置管理

Flowlet 管理 OpenCode 用户级全局配置。OpenCode CLI 与 Desktop 读取同一份 Provider、模型和凭据配置，因此一次接入会同时覆盖两端。

## 文件位置

- Provider 与默认模型：`~/.config/opencode/opencode.jsonc`，若只存在 `opencode.json` 则沿用该文件；
- Provider 凭据：`~/.local/share/opencode/auth.json`；
- 权限事件插件：`~/.config/opencode/plugins/flowlet.ts`；
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
- 首次应用前备份 `$schema`、`model`、`small_model`、Provider 启停列表、`provider.flowlet`、`auth.json` 中的 `flowlet` 凭据以及已有同名插件；`server` 原值仅保留用于历史固定端口清理与恢复；
- Flowlet 不再修改 OpenCode 的 `server.hostname` 或 `server.port`；重新应用配置时会清理由短暂发布版本写入的固定端口字段，并恢复备份中的原值；
- 应用时从 `disabled_providers` 移除 `flowlet`；若用户设置了 `enabled_providers` 白名单，则把 `flowlet` 加入白名单；
- 恢复时只还原上述受管字段，保留用户之后新增的其他配置和凭据；
- 若两个文件均由 Flowlet 创建且恢复后为空，则删除对应文件；
- 写入使用临时文件替换，并对支持 Unix 权限的平台设置为 `0600`。
- 配置文件与凭据文件作为一个事务更新；第二个文件写入失败时恢复两个文件修改前的原始字节内容，避免留下半配置状态；
- 手动配置区域分别提供 `opencode.jsonc` 和 `auth.json` 片段，Client Token 默认脱敏但复制使用真实值。

## 覆盖与生效

`OPENCODE_CONFIG` 和 `OPENCODE_CONFIG_CONTENT` 的优先级高于全局配置。Flowlet 检测到这些环境变量时会提示外部覆盖，但不会修改它们。

正在运行的 OpenCode CLI 或 Desktop 可能缓存配置。应用或恢复后应重新启动对应客户端；不需要重启 Flowlet 代理。

## 会话操作

Flowlet 不要求 OpenCode 使用固定控制端口。OpenCode Desktop 自带的 sidecar 使用动态端口；为统一识别 CLI、Web 与 Desktop，Flowlet 安装用户级插件 `~/.config/opencode/plugins/flowlet.ts`：插件只使用 Node 与 Bun 均支持的标准文件 API，按“进程 PID + 项目实例”分别上报自身 Server URL、心跳和 pending permission，并通过串行原子替换避免同一实例内的心跳与权限事件写坏状态文件，因此多个进程、多个项目可以同时运行且不会互相覆盖。插件初始化时还会主动读取当前实例已有的 pending permission，因此继续历史会话不会影响后续识别。

接入状态同时检查 Provider、凭据、主/快速模型和权限插件。只有这些项目都已写入时才显示“已接入 Flowlet”；权限插件缺失或内容落后于当前 Flowlet 托管版本时显示“配置不完整”，接入详情中会标记“权限插件：需安装或更新”，重新写入 Flowlet 配置即可补齐。

会话列表和详情优先使用插件或控制接口返回的 pending permission：只要某会话仍有待确认权限，状态直接为 `waiting_user`；permission 消失后立即回退到 OpenCode SQLite message 推断。详情中的“同意本次”与“否决”会优先经对应进程的插件交回 OpenCode，因此 Desktop sidecar 即使启用了内部鉴权也不需要 Flowlet 读取其密码。插件或控制服务暂不可用时保持 SQLite 回退，不会把只读会话观测整体判为失败。

应用配置后必须重启已经运行的 OpenCode 进程，才能加载权限事件插件；不需要重启 Flowlet 代理。
