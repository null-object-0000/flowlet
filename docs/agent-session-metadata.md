# Agent 会话名称与项目的服务端派生（Web Host / Docker）

> 适用实现：`packages/flowlet-core`（Docker / Web Host 实际运行）。桌面 Rust Host 不参与本次
> 派生：桌面端已经能通过读取本机原生会话文件（`agent_session_adapter`）拿到真实标题与 cwd，
> 并且 `merge_agent_session_catalog` 以原生值优先。

## 1. 背景与边界

Docker 版「会话管理」只聚合经过本实例代理的请求观测（[docker.md](docker.md)），会话行的
`title` / `projectPath` 在聚合代码里恒为 `null`，因此只能显示客户端与会话 ID。

本次改动**只做服务端派生**：

- 数据来源是代理在路由前已经读入内存的请求体（`forwardModelRequest` 中的 `bodyBytes`），
  不依赖 `log_capture` 配置、不读取服务器上的 Agent 原生会话文件、不新增任何入站端点、
  不要求客户端安装插件或改动配置；
- 派生值标记为 `source = "derived"`，语义是**近似值**：标题取该会话第一条人类消息，
  不是用户在客户端里手工改的名字；项目路径取请求体里的工作目录；
- 不做 DSH 桥接上报、不做会话改名同步（后续如需精确标题，另按 `docs/deepseek-harness-integration.md`
  的可选高级能力模型扩展）。

不派生的场景：请求体为空或不是 JSON（如 Files API 上传、`GET /models`）、未识别出 Agent 会话
身份（没有 `agent_session_id`）。此时不写任何元数据行。

## 2. 存储

新增表（Node Host 与桌面 Rust 的 schema 契约同步维护，只增不改；桌面旧版本读到未知表会忽略）：

```sql
CREATE TABLE IF NOT EXISTS agent_session_metadata (
    agent_type   TEXT NOT NULL,
    session_id   TEXT NOT NULL,
    title        TEXT,
    project_path TEXT,
    source       TEXT NOT NULL DEFAULT 'derived',
    updated_at   TEXT NOT NULL,
    PRIMARY KEY (agent_type, session_id)
);
```

不建额外索引：主键已覆盖会话聚合的 `LEFT JOIN`。

写入语义（每个命中会话身份的模型请求 upsert 一次，失败不影响主链路）：

```sql
INSERT INTO agent_session_metadata (agent_type, session_id, title, project_path, source, updated_at)
VALUES (?, ?, ?, ?, 'derived', ?)
ON CONFLICT(agent_type, session_id) DO UPDATE SET
    title        = COALESCE(excluded.title, agent_session_metadata.title),
    project_path = COALESCE(excluded.project_path, agent_session_metadata.project_path),
    updated_at   = excluded.updated_at;
```

- `COALESCE` 保证「某次请求没解析出标题」不会把历史值清成 NULL；
- 后续若引入更可信来源（`manual` / `agent`），以 `source` 优先级覆盖，不在本文件范围内；
- 不随 `request_logs` 清理而删除，避免会话元数据因 Body 保留策略消失。

## 3. 聚合

观测会话查询（`listObservedAgentSessions`）对 `request_logs` 的聚合结果 `LEFT JOIN` 上表：

```sql
LEFT JOIN agent_session_metadata m
       ON m.agent_type = rl.agent_type
      AND m.session_id = rl.agent_session_id
```

SELECT 增加 `MAX(m.title) AS session_title`、`MAX(m.project_path) AS session_project_path`，
映射到 `AgentSessionRow.title` / `AgentSessionRow.projectPath`。

已有的搜索（标题、项目路径）与项目筛选逻辑复用同一行数据，无需改动；前端
`sessionDisplayTitle = title || 项目目录名 || sessionId` 直接生效。

## 4. 派生规则

实现位置：`packages/flowlet-core/src/proxy/session-derive.ts`（纯函数，无 IO、无 `Date.now()`）。
入口签名：

```ts
export function deriveSessionMetadata(
  agentType: string,
  body: Buffer,
): { title: string | null; projectPath: string | null };
```

### 4.1 通用约束

- body > 4 MiB、空、非 UTF-8 JSON 时返回全 `null`，不抛错；
- 项目路径接受度：非空、≤ 1024 字符、无换行/控制字符，且必须是绝对路径形态
  （`/`、`~/`、`X:\`、`X:/`）；不满足则丢弃（不截断，截断会破坏按项目筛选的语义）；
- 标题：只取**首个合格的人类用户消息**，折叠空白、去除首尾标点空白；≤ 120 UTF-8 字节且
  ≤ 60 个字符（按 Unicode 码点截断，不切半个字符）；空串、纯符号、以 `<` 开头的
  XML 风格环境块（如 `<environment_context>`、`<system-reminder>`）一律跳过；
- 同一个 body 内标题只取一次，不做模型侧改写或猜测。

### 4.2 消息文本抽取（按协议，全部从 JSON 结构取，不做正则扫全文本）

| 协议 | 结构 |
| --- | --- |
| OpenAI chat/completions | `messages[]` 中 `role === "user"`；`content` 为字符串或 `[{type:"text", text}]` |
| Anthropic Messages | `messages[]` 中 `role === "user"`；`content` 为字符串或 `[{type:"text", text}]`；`system` 只用于项目路径检测 |
| OpenAI Responses | `input` 为字符串或 `[{role, content:[{type:"input_text"|"output_text"|"text", text}]}]`；`instructions` 只用于项目路径检测 |

跳过规则：`role` 为 `system` / `developer` / `assistant` / `tool` 的消息不参与标题；
文本块以 `<` 开头时整块丢弃（XML 风格环境块：Claude Code 的 `<system-reminder>`、Codex 的
`<environment_context>`、OpenCode 的 `<env>` 等）。这些块与真实提问常在同一条 user 消息的不同
text 块里，因此按块丢弃而不是丢整条消息。

### 4.3 项目路径特征（按顺序取第一个命中，全部在「候选环境文本」内）

候选环境文本 = `system`（Anthropic）、`instructions`（Responses）、所有 `system`/`developer`
消息文本，以及首个用户消息文本（Claude Code 与 Codex 的 cwd 可能出现在用户侧环境块中）。

按以下顺序匹配（每行以 `^` 锚定，允许前导空白）：

1. `<cwd>…</cwd>`（Codex Responses 的 `<environment_context>`）
2. `<workspace_roots>` 内的第一个 `<root>…</root>`
3. `Primary working directory:` 之后的同一行剩余内容（Claude Code 新版）
4. `Current working directory:` 之后的同一行剩余内容（Pi / Hermes）
5. `Working directory:` 之后的同一行剩余内容（Claude Code 旧版 / OpenCode `<env>`）
6. `Workspace root folder:` 之后的同一行剩余内容（OpenCode）

命中后去掉成对的引号/反引号与行尾标点，再按 4.1 校验。

> 已知限制：DSH 请求体里没有 cwd（cwd 只在 DSH 会话文件头），因此 DSH 会话只会有标题、
> 没有项目路径；OpenCode/Pi 未装客户端的场景以源码为准，若上游格式变化只影响该 Agent 的
> 项目路径，不影响标题与整体链路。

## 5. 测试与验证

- `session-derive` 纯函数单测：每个 Agent 的真实请求体样本（含中文标题/中文路径、Windows 路径、
  `<system-reminder>` 前缀、超长标题/路径、非 JSON body）；
- 存储契约测试：写入请求日志 + 元数据后 `listObservedAgentSessionsPage` 返回 title/projectPath，
  按标题与项目搜索可命中，`upsert` 单字段不覆盖另一字段；
- 代理集成：带会话身份的请求触发 upsert，未识别会话身份（无 `agent_session_id`）不写；
- 检查：`npm run node:typecheck`、`node --test packages/flowlet-core/src/**/__tests__/`。
