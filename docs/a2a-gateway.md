# 通用 A2A 网关

Flowlet Node Host（Electron 本机宿主及 Web/Docker）可登记外部 A2A Agent，统一管理调用入口、
访问密钥和调用记录。入口位于「会话管理 → A2A 网关」。旧 Rust/Tauri/Android 宿主暂不提供此能力。
Electron 客户端模式管理的是远程 Node Host 的 Agent；调用方应连接远程 Host，不能把客户端本机网关当作 A2A 入口。

## 范围与调用链

```text
A2A 客户端 → Flowlet Host /a2a/<agent-id> → 已登记的外部 A2A Agent
管理界面 → 显式管理命令 → 注册表 / 调用密钥 / 调用记录
```

这是协议级能力，不包含任何特定 Agent 的登录、换票、业务 API、提示词或响应解析。
外部 Agent 不属于 `plugin-registry.json` 的内置客户端适配器，也不是模型或渠道；
不写模型白名单，不参与模型路由、Token 计量或模型成本估算。

首版协议为 **A2A v1.0 JSON-RPC + SSE**，不做 0.3 转换，不支持 REST/gRPC 或 push 通知。
Card 必须声明 `supportedInterfaces` 中 `protocolBinding: "JSONRPC"`、`protocolVersion: "1.0"`。
支持 `SendMessage`、`SendStreamingMessage`、`GetTask`、`ListTasks`、`CancelTask`、`SubscribeToTask`；
具体操作是否可用取决于上游。消息、上下文、任务 ID 和响应体原样转发，不做额外模型调用。
Flowlet 不重试 A2A 请求，避免断流、超时或 5xx 后重复执行任务。断流后用已收到的 task ID 查询。

## 登记与认证

1. 登记 ID、名称、完整 Agent Card URL；按需要填写上游 Bearer Token。
2. 内网或本机服务必须显式开启「允许访问内网 / 本机服务」。
3. 「读取 Agent Card」可预览技能；「验证并保存」会重新读取并验证 Card 后保存。
4. 创建调用密钥，显式选择允许调用的 Agent。完整密钥只在创建时返回一次。
5. 把客户端指向 `http(s)://<Flowlet Host>/a2a/<id>`，并配置该调用密钥。

上游 Token 使用现有数据目录 `secret.key` 加密；编辑时省略 `upstreamToken` 保留，空串清除。
跨域更换 Card 地址必须重新填写或清除 Token，不能把旧凭据自动发往新域名。
上游调用仅注入该 Agent 的凭据，不转发调用方 Authorization、Cookie 或其他任意请求头。
调用密钥以 `flwa2a_` 开头，数据库只保存 SHA-256；管理 Token、模型 Client Token、CLI Token
均不能用于 A2A 数据面。Agent 授权覆盖该 Agent 的消息和任务操作。

**首版按 Agent 授权，不按任务所有者隔离。** 同一 Agent 的获授权调用方共享上游服务身份和任务空间。
网关不会把不同调用方映射成上游不同员工。需要人员隔离时应使用具备独立身份的上游实例并分别登记。

停用、修改、撤销在下一次请求生效，无需重启；不追溯中断已发送的任务。
删除 Agent 会同时清除所有调用密钥对该 ID 的授权，防止同 ID 重新登记继承旧授权；保留调用记录。
上游服务生命周期独立，Flowlet 不安装扩展、不执行启动脚本、不接管外部进程。

## 发现与入口

数据面端口是 **Web/Host 端口**，与模型代理端口独立：

| 路径 | 用途 |
|---|---|
| `GET /a2a/<id>/.well-known/agent-card.json` | 带 A2A 调用密钥读取改写后的 Agent Card |
| `POST /a2a/<id>` | 带 A2A 调用密钥发送 JSON-RPC 2.0 请求 |

Card 中的接口地址和安全声明改为网关地址与 Bearer；上游签名被移除（改写后原签名不再有效）。
只保留选中的 JSONRPC v1 接口及其 tenant 声明，不向客户端宣传不支持的传输或 push 能力。
生产反代设置 `FLOWLET_PUBLIC_A2A_URL=https://flowlet.example.com`，
供 Card 生成绝对调用地址；未设置时按直接访问 Host 的 HTTP 地址生成（不信任 forwarded headers）。
该变量只接受根地址，配置改变需要重启 Host。

```bash
curl http://localhost:8080/a2a/research \
  -H "Authorization: Bearer $FLOWLET_A2A_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":"example-1","method":"SendMessage","params":{"message":{"messageId":"msg-1","role":"ROLE_USER","parts":[{"text":"你好"}]}}}'
```

上游 Card URL 与调用 URL 必须同源；不自动跟随重定向。地址解析在实际连接前校验并固定解析结果，
内网访问默认拒绝；即使开启内网，仍禁止链路本地、云元数据、未指定、组播和 IPv4 隧道绕过地址。
只支持无鉴权或 Bearer 上游，不执行 Card 中的 OAuth 流程。

## 观测与存储

SQLite 新增 `a2a_agents`、`a2a_keys`、`a2a_calls` 三张独立表及索引，在首次使用 A2A 时幂等创建。
不改变现有模型表与请求日志表，旧 Rust 宿主会忽略新表。备份时连同 `secret.key` 一起保留。

调用记录包含 Agent、调用密钥 ID、方法、耗时、HTTP 状态、task/context ID、上游任务状态和错误。
HTTP 200 不代表任务完成：JSON-RPC error 与任务状态独立记录，未观察到终态的 SSE 会标记异常结束。
最多保留 2000 次调用，界面读取最近 100 条，支持按 Agent 筛选。
请求/响应正文服从现有 `log_capture.capture_req_body` / `capture_res_body`，每侧最多
`min(max_body_bytes, 64 KiB)`；正文也受 `body_retention_days` 和 `body_max_size_mb` 控制，
保存及查看记录时清理，也接入 Host 每 15 分钟的存储维护。A2A 正文容量独立计算，模型捕获库不受影响。认证头不写入此日志。
`body_retention_days=-1` 永久保留正文，`0` 不保留；`body_max_size_mb=0` 不限制容量。
界面提供非流式消息测试、任务查询/列表/取消；持续流式消费由客户端使用 A2A 数据面完成。

## 管理命令

显式白名单：`list_a2a_agents`、`inspect_a2a_agent`、`save_a2a_agent`、`delete_a2a_agent`、
`list_a2a_keys`、`create_a2a_key`、`revoke_a2a_key`、`list_a2a_calls`、`invoke_a2a_agent`。
沿用管理认证、OIDC/CSRF 和角色检查；CLI 的凭据同步授权不能执行这些命令。
Viewer 只读 Agent 和调用记录，不能读取/创建密钥、写配置或发起测试。

## 验证

```bash
node --test packages/flowlet-core/src/a2a/gateway.test.ts
npm run node:typecheck
npm run check
npm run build:web
npm run build:desktop
node scripts/desktop-command-parity.mjs
```

真实外部 Agent 的认证及业务测试应在独立验证环境完成。不要在网关代码中加入该 Agent 的域名、
换票逻辑或定制请求格式；接入失败时检查外部服务自身的错误与网络环境。

2026-11-12 首次真实验证：使用独立的运维百晓生 A2A facade，在临时 Node Host 登记后，
单轮消息、客户端显式 `contextId` 续聊、`GetTask`、SSE（6 帧、完成状态与结束标记）通过。
另用 Hermes 自身的 `_fetch_card` / `_send_task`，带 Flowlet 调用密钥完成发现、问答和同会话追问。
未写 Hermes 正式配置或安装常驻服务。facade 自身的 SSO 换票与内部 SSE 解析均未进入 Flowlet。
验证发现该 facade 的自动生成首轮 context 与内部会话绑定存在问题；使用客户端生成的 contextId
可正常续聊，Flowlet 不对该问题做上游专属补丁。

协议依据：[A2A v1 specification](https://a2a-protocol.org/latest/specification/)。

## 线上部署记录（2026-11-12）

- 代码提交：`bf06412`；镜像：`flowlet:node-20261112-a2a-bf06412`。
- 入口：`http://10.100.217.60:20134/#/a2a`，仍由原 OIDC 管理登录保护。
- 发布前以线上一致性备份在独立 canary 验证升级：14 个渠道账号、10 条服务凭据保留；
  通用 A2A 注册、上游 Bearer 注入、调用密钥授权、Card 改写、消息、任务查询/列表/取消、
  SSE、日志与撤销通过；模型列表及一次真实模型流式调用通过。
- 镜像内 673 个交付文件 SHA-256 校验通过；运行用户、入口、端口、健康检查与卷契约保持一致。
- 主容器切换观测不可用窗口约 3.14 秒；发布后 healthy，OIDC 配置保留，模型流式回归 3/3。
  主实例账号/凭据数量保持 14/10，`flowlet-egress` 的容器 ID 与启动时间未变。
- 线上 SQLite 在线备份及关键配置位于数据卷 `/data/backups/a2a-20261112-bf06412/`；
  原镜像 `flowlet:node-20261110-settingsnav2` 保留，可按部署技能回滚。
- 此次发布网关本身，未在服务器安装或常驻百晓生封装；注册时仍需提供网关可访问的外部 Agent 地址。
