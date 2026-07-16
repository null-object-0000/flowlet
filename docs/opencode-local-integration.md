# OpenCode Desktop 本地直读集成设计

> 本文档针对 **OpenCode Desktop**（Electron 桌面版），非 CLI 版本。

> 当前已先落地代理侧会话观测：从 OpenCode 请求 Header 提取稳定会话 ID，并基于
> `request_logs` 聚合请求、Token、费用和失败情况，不建立独立会话表。本文件其余内容描述
> 后续本地数据库直读阶段，用于补充标题、项目、消息和未经过 Flowlet 的历史会话。

## 核心原则

**Flowlet 自动直读，用户零配置。**

前提：Flowlet 必须有运行在用户电脑上的本地进程、桌面端或 Local Agent。纯浏览器网页、纯云端服务无法越过系统权限读取 OpenCode Desktop 的本地文件。

用户不需要：

- 填写 OpenCode 地址
- 设置端口
- 复制密码
- 修改 OpenCode 配置
- 手动导入历史会话

Flowlet 启动后自己检测即可。

## 架构概览

```text
OpenCode Desktop
   ├─ 配置文件 (opencode.jsonc / opencode.json / config.json)
   ├─ auth.json (凭证)
   ├─ opencode.db (会话/消息 SQLite)
   └─ opencode.db-wal (WAL 增量)
          ↑
          │ 自动发现、只读监听
          │
   Flowlet Local Bridge
          ↓
   Flowlet 会话、任务、Agent 数据
```

---

## 一、自动识别 OpenCode 数据目录

三级发现机制，逐级回退：

### 优先级 1：通过 IPC / 本地协议获取路径

OpenCode Desktop 通过 Electron 管理本地数据文件。Flowlet 应优先通过 Desktop 自身的 IPC 通道或本地 HTTP API 获取实际路径。

### 优先级 2：标准桌面版目录

桌面版 Electron 应用 ID：

| 版本 | 应用 ID |
|------|---------|
| 正式版 | `ai.opencode.desktop` |
| Beta | `ai.opencode.desktop.beta` |
| 开发版 | `ai.opencode.desktop.dev` |

桌面版 Electron `userData` 路径为：

```ts
join(app.getPath("appData"), appId)
```

Windows 正式版典型路径：

```text
%APPDATA%\ai.opencode.desktop
```

macOS 典型路径：

```text
~/Library/Application Support/ai.opencode.desktop
```

Linux 典型路径：

```text
~/.config/ai.opencode.desktop
```

### 优先级 3：特征文件扫描

在用户目录下有限范围扫描：

```text
opencode.db
opencode.db-wal
auth.json
opencode.json
opencode.jsonc
```

通过数据库表名验证：

```sql
SELECT name FROM sqlite_master WHERE type = 'table';
```

只接受包含 `session`、`message`、`part`、`project` 表的数据库。

---

## 二、配置读取：读取合并后的最终配置

OpenCode 配置来源多元：

- 全局 `opencode.jsonc` / `opencode.json`
- 项目目录配置
- `.opencode` 目录
- 环境变量
- 企业托管配置
- 远程配置
- Auth Well-known 配置

Flowlet 不应只解析某一文件，否则可能与用户在 OpenCode 中实际看到的渠道、模型不一致。

### 最稳读取方式

通过 Desktop 内置的 Config Service API 获取合并后的最终配置。OpenCode Desktop 提供内部接口输出已经完成多层次合并的配置。示例输出：

```json
{
  "model": "openai/gpt-5.4",
  "small_model": "openai/gpt-5-mini",
  "provider": {
    "openai": {
      "options": {
        "baseURL": "https://example.com/v1"
      },
      "models": {
        "gpt-5.4": {},
        "gpt-5-mini": {}
      }
    }
  }
}
```

### Flowlet 内部标准化结构

```ts
interface OpenCodeProvider {
  providerId: string
  displayName?: string
  baseUrl?: string
  models: OpenCodeModel[]
  defaultModel?: string
  credentialConfigured: boolean
  credentialType?: "api" | "oauth" | "wellknown"
  source: "global" | "project" | "environment" | "remote"
}
```

---

## 三、配置修改：直接用 OpenCode 的文件格式

OpenCode CLI 与 Desktop 共用用户级全局配置。Flowlet 优先修改已有的：

```text
~/.config/opencode/opencode.jsonc
```

或已有配置文件：

```text
~/.config/opencode/opencode.json
```

不存在时 Flowlet 创建 `opencode.jsonc`。Client Token 不写进 Provider 配置，而是单独保存为：

```text
~/.local/share/opencode/auth.json
```

其中 Provider ID 固定为 `flowlet`，凭据格式为 `{ "type": "api", "key": "..." }`。

### 写入策略

1. 找到现有配置文件
2. 保留原始 JSONC 注释
3. 使用 `jsonc-parser` 做局部 Patch
4. 写入临时文件
5. 原子替换
6. 保留一份最近备份

### 写入内容示例

修改默认模型：

```json
{
  "model": "anthropic/claude-sonnet-4-6"
}
```

新增 OpenAI Compatible 渠道：

```json
{
  "provider": {
    "flowlet-gateway": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Flowlet Gateway",
      "options": {
        "baseURL": "https://gateway.example.com/v1"
      },
      "models": {
        "gpt-5.4": {
          "name": "GPT-5.4"
        }
      }
    }
  }
}
```

### 配置缓存注意事项

OpenCode 全局配置缓存 TTL 为无限期。直接改文件后：

- 磁盘配置一定已修改
- 正在运行的 OpenCode 实例不一定马上刷新
- 下次启动一定读取新配置

Flowlet 可做到用户零操作：

```text
修改配置
  ↓
检测 OpenCode 当前是否有运行中 Session
  ↓
没有任务运行：自动重启 OpenCode
有任务运行：等待任务结束后自动重启
```

更温和方式：提示"新配置将在下一次会话生效"，但不要求用户做任何操作。

---

## 四、凭证读取与修改

凭证保存在桌面版数据目录下：

```text
<userData>/auth.json
```

支持三类凭证：

```ts
type Auth =
  | { type: "api"; key: string; metadata?: Record<string, string> }
  | { type: "oauth"; refresh: string; access: string; expires: number; accountId?: string }
  | { type: "wellknown"; key: string; token: string }
```

### 安全原则

Flowlet 直接读取，但只把状态信息返回给业务层：

```json
{
  "providerId": "anthropic",
  "configured": true,
  "type": "api",
  "maskedKey": "sk-ant-••••••••9x2d"
}
```

**不把明文 Key 返回 Flowlet Web 前端。**

### 写入要求

- 更新 `auth.json` 时保持文件权限 `0600`
- OpenCode 自己写入也使用 `0600`

### 桥接接口

```ts
setProviderCredential(providerId, credential)
removeProviderCredential(providerId)
getProviderCredentialStatus(providerId)
```

不提供：

```ts
getPlaintextApiKey()  // 禁止
```

---

## 五、会话信息读取 SQLite

数据库位置：

```text
<userData>/opencode.db
```

OpenCode 开启：

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;
```

### 只读连接配置

```ts
const db = new Database(dbPath, {
  readonly: true,
  fileMustExist: true,
})

db.pragma("busy_timeout = 5000")
db.pragma("query_only = ON")
```

**不要设置 `immutable=1`**——OpenCode 使用 WAL，`immutable=1` 可能看不到尚未 checkpoint 到主数据库的数据。

### 关键表结构

**session 表**包含：

| 字段 | 说明 |
|------|------|
| id | 会话 ID |
| project_id | 项目 ID |
| workspace_id | 工作区 ID |
| parent_id | 父会话 ID |
| title | 标题 |
| directory | 工作目录 |
| cost | 费用 |
| tokens_input / tokens_output / tokens_reasoning | Token 统计 |
| tokens_cache_read / tokens_cache_write | 缓存 Token |
| agent | Agent 类型 |
| model | `{ id, providerID, variant }` |
| time_created / time_updated / time_archived | 时间戳 |

**message 表**通过 `session_id` 关联会话，消息内容存在 JSON `data` 字段。

**part 表**通过 `message_id` 关联消息，工具调用、文本、推理、文件内容等保存在 JSON `data` 中。

### Flowlet 内部结构

```ts
interface FlowletImportedSession {
  externalSessionId: string
  projectId: string
  directory: string
  title: string
  providerId?: string
  modelId?: string
  agent?: string
  cost: number
  tokens: { input: number; output: number; reasoning: number }
  messages: FlowletMessage[]
  createdAt: number
  updatedAt: number
}
```

---

## 六、实时增量同步

### WAL 监听

直接监听 `opencode.db-wal` 文件变化，做 300~500ms debounce，然后增量查询：

```sql
SELECT * FROM session WHERE time_updated > ?;
```

```sql
SELECT * FROM message WHERE time_created > ? ORDER BY time_created, id;
```

### 同步水位

```ts
interface OpenCodeSyncCursor {
  databasePath: string
  lastSessionUpdatedAt: number
  lastMessageCreatedAt: number
  lastMessageId?: string
  schemaFingerprint: string
}
```

### SQLite 可同步 vs 边界

可以同步：

- 会话历史
- 用户消息
- AI 回复
- Tool Part
- Token / Cost
- 使用模型
- 项目目录
- 文件变更摘要
- Todo

不能完整反映运行态：

- 正在排队
- 等待用户授权
- 当前流式 token
- 内存中的 Abort 状态
- 尚未提交的工具执行状态

> OpenCode Server API 单独提供了 Session Status 和实时事件，说明这些信息并不完全等同于数据库历史。第一版只读会话信息、串联数据，SQLite 足够。

---

## 七、Flowlet 侧完整接口设计

```ts
interface OpenCodeLocalAdapter {
  // 自动发现
  discoverInstallations(): Promise<OpenCodeInstallation[]>
  resolvePaths(): Promise<OpenCodePaths>

  // 配置
  readResolvedConfig(projectDirectory?: string): Promise<OpenCodeConfig>
  updateGlobalConfig(patch: Partial<OpenCodeConfig>): Promise<void>
  updateProjectConfig(
    projectDirectory: string,
    patch: Partial<OpenCodeConfig>,
  ): Promise<void>

  // 渠道凭证
  listProviderCredentials(): Promise<ProviderCredentialStatus[]>
  setProviderCredential(
    providerId: string,
    credential: ProviderCredentialInput,
  ): Promise<void>
  removeProviderCredential(providerId: string): Promise<void>

  // 会话
  listSessions(query?: SessionQuery): Promise<OpenCodeSession[]>
  readSession(sessionId: string): Promise<OpenCodeSessionDetail>
  readMessages(sessionId: string): Promise<OpenCodeMessage[]>

  // 增量同步
  watchSessions(
    callback: (event: OpenCodeSessionChange) => void,
  ): Promise<Disposable>

  // 配置生效
  scheduleReload(): Promise<void>
}
```

---

## 八、用户体验流程

```text
安装了 OpenCode Desktop
  ↓
打开 Flowlet
  ↓
Flowlet 自动发现 Desktop 本地数据
  ↓
渠道、模型、历史会话自动展示
  ↓
在 Flowlet 修改渠道或模型
  ↓
OpenCode Desktop 自动同步生效
```

不需要用户额外完成任何接入操作。

---

## 实现路径总结

| 数据 | 读取方式 | 写入方式 |
|------|----------|----------|
| 配置 | Desktop API / 直接读取 JSONC | JSONC 文件直接修改 |
| 凭证 | `<userData>/auth.json` 读取状态 | `auth.json` 覆盖写入，权限 0600 |
| 会话 | `<userData>/opencode.db` 只读查询 | 只读，不写 |
| 增量同步 | `<userData>/opencode.db-wal` 文件监听 | — |
| 配置生效 | — | Flowlet 判断空闲后通知 Desktop 重载配置 |
