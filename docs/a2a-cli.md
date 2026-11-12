# Flowlet 原生 A2A CLI

`flowlet a2a` 是 Node CLI 内置的 A2A 1.0 JSON-RPC/SSE 客户端。它通过统一凭据库调用已登记的
Agent，无需额外 Python 脚本，不包含百晓生或其他服务的专属字段、接口、模型调用和协议转换。
Rust legacy CLI 不增加此功能；Node CLI 运行要求仍为 Node.js 22.6+，没有新增依赖。

## 配置与发现

```bash
flowlet login --server=http://10.100.217.60:20134
flowlet pull --server=http://10.100.217.60:20134

# 无需预先知道任何 profile 名称
flowlet a2a list

# 根据列表返回的 profile 继续调用
flowlet a2a discover --profile=AIOPS
```

`list` 从本机凭据库和环境变量中枚举 `FLOWLET_A2A_URL/TOKEN` 与
`FLOWLET_A2A_<PROFILE>_URL/TOKEN`，读取各目标的 Agent Card。输出 JSON 包含 `agents`、
`total`、`available`、`unavailable`；每条含 name、description、version、skills、profile、prefix、url，
以及可复用的 `invoke.command` / `invoke.args`。调用方替换 args 中的 `<message>` 即可发送请求。

```json
{
  "agents": [{
    "name": "运维百晓生",
    "profile": "AIOPS",
    "prefix": "FLOWLET_A2A_AIOPS",
    "available": true,
    "skills": [{"id":"aiops.ops-qa","name":"运维问答","tags":["ops","troubleshooting"]}],
    "invoke": {"command":"flowlet","args":["a2a","send","<message>","--profile=AIOPS"]}
  }],
  "total": 1,
  "available": 1,
  "unavailable": 0
}
```

技能取自 Agent Card 声明。`available` 表示配置完整且 Card 发现验证成功；经网关读取的 Card
可能是缓存，实际业务执行状态由任务结果表达。列举只读取发现信息。

单个配置缺失、认证失败、不可达或超时，保留为 `available: false` 与 `error`，其他条目继续发现。
默认最多4个并发，每个 Agent 10秒超时，可用 `--timeout` 调整。输出按凭据前缀排序；空列表给出
login/pull 提示。成功完成枚举退出0（包括部分或全部条目不可用），调用方按 available 字段选择。

自动枚举限于 A2A 命名空间。自定义环境前缀可显式使用 `flowlet a2a list --prefix=MY_AGENT`；
`--profile=NAME` 只列所选配置。默认前缀条目的 profile 为 null，调用参数无需 profile；
自定义前缀条目使用返回的 --prefix 参数。列表不包含 token、安全配置或其他服务的凭据。

`--profile=AIOPS` 读取 `FLOWLET_A2A_AIOPS_URL` / `_TOKEN`；不传时读取 `FLOWLET_A2A_URL` / `_TOKEN`。
也可用 `--prefix=MY_AGENT` 指向任意已有前缀，两者互斥。可从凭据库读取，或用同前缀的成对环境变量
覆盖；不允许只覆盖其中一个再与库内另一个混用。CLI 不打印 token，不接收命令行明文 token 参数。

Card 默认在配置的调用 URL 后追加 `/.well-known/agent-card.json`（适用于 Flowlet 网关）；
其他服务可用 `--card-url` 指定同源发现地址。只选择 JSONRPC / 1.0 接口，自动传递该接口的 tenant。
发现与 RPC 均不跟随重定向；Card 和实际 RPC URL 必须与配置同源，不把凭据转交其他域名。
TLS 默认校验，仅显式 `--insecure` 才关闭。`--extensions=URI1,URI2` 声明接受的扩展，不自动接受未知扩展。

## 消息、续聊与附件

```bash
flowlet a2a send '记住本次测试的虚构项目名为薄荷星港，只回复已记住。' --profile=AIOPS --session=demo --new
flowlet a2a send '刚才的项目名是什么？' --profile=AIOPS --session=demo

printf '%s\n' '附件中的测试代号是青柠海湾527。' > ./demo.txt
flowlet a2a send '读取附件中的测试代号，可以使用附件读取工具。' --file=./demo.txt --profile=AIOPS --session=demo
flowlet a2a send '请描述图片。' --file=./image.png --profile=AIOPS --session=demo

# 其他 Agent 可直接使用 URL 或结构化数据，不引入上游特判
flowlet a2a send '分析附件。' --file-url=https://files.example/report.pdf --profile=RESEARCH
flowlet a2a send '分析这条记录。' --data='{"severity":"low","count":3}' --profile=RESEARCH
printf '%s' '从 stdin 读取的问题' | flowlet a2a send --stdin --profile=RESEARCH
```

普通命令输出 JSON。send 默认先用 `returnImmediately: true` 提交，再轮询 GetTask 直到终态或暂停。
响应保持标准 result 结构：`{task: Task}` 或 `{message: Message}`；直接消息也支持保存 context。
默认 `historyLength: 0`，避免轮询反复取回输入文件；需要历史时显式 `--history-length=N`。

`--async` 只提交并返回，`--stream` 使用 SendStreamingMessage，输出逐行 JSON（NDJSON）标准事件。
两者互斥。消息不会因网络错误、5xx、超时或断流而自动重新提交；`--timeout` 是整次命令的总时限。
超时或中断后，错误信息包含已获知的 taskId/contextId，即使未指定本地会话文件也可继续查询。

附件使用标准 raw/base64 Part，URL 附件只传 url Part，CLI 不下载。类型按扩展名推断，未知类型
按 application/octet-stream 发送；恰好一个附件时可用 `--media-type=MIME` 指定类型。
请求 JSON 合计上限4 MiB（含 base64 开销），上游可进一步限制大小、数量和格式。
CLI 不实现任何服务的 multipart 接口；实际上传、附件 ID、内容读取均由标准 Agent 的实现负责。

## 会话与并发

`--session=NAME` 将 context/task ID 存到凭据目录的 `a2a-sessions/<hash>.json`，hash 绑定
配置 URL、凭据前缀和会话名。不同目标及不同会话隔离；文件0600、目录0700，采用原子替换，不含 token。
也可使用 `--state=PATH` 指定文件，两者互斥；显式文件发现目标不匹配时拒绝续聊，`--new` 可明确重建。

```bash
flowlet a2a session show --profile=AIOPS --session=demo
flowlet a2a session clear --profile=AIOPS --session=demo
flowlet a2a send '继续分析。' --context=ctx-... --profile=AIOPS
flowlet a2a send '补充信息。' --task=task-... --profile=RESEARCH
```

每轮新消息只复用 contextId，不会自动回传上个已完成任务的 taskId。显式 --task 用于上游允许的
暂停任务补充输入；--new 与显式 context/task 互斥。发送命令持有会话锁，避免并发进程把会话串错；
get/cancel/subscribe 可以读取正在等待的会话并操作其已保存任务。

Ctrl+C 释放本地会话锁并退出130，不取消上游任务。SIGKILL 等无法清理的退出可能留下 `.lock`，
需确认文件内 PID 对应的进程已经结束，再手工移除该锁文件；不自动猜测过期并覆盖其他进程的锁。
`session clear` 仅删除本地记录，不向上游发送会话删除请求。上游会话失效时，先检查 Agent 的错误，
需要新会话则显式 `send --new`，CLI 不静默丢弃原上下文。

## 任务管理与标准 RPC

```bash
flowlet a2a send '长任务' --async --profile=AIOPS --session=job
flowlet a2a tasks get --profile=AIOPS --session=job
flowlet a2a tasks wait --profile=AIOPS --session=job --timeout=900 --poll-ms=1000
flowlet a2a tasks cancel --profile=AIOPS --session=job
flowlet a2a tasks subscribe --profile=AIOPS --session=job

# 也可显式给 TASK_ID，无需本地会话
flowlet a2a tasks get task-... --profile=AIOPS
flowlet a2a tasks list --profile=AIOPS --context=ctx-... --status=TASK_STATE_COMPLETED --page-size=10
flowlet a2a tasks list --profile=AIOPS --page-size=10 --page-token='上页返回的令牌' --history-length=2 --include-artifacts
```

GetTask/CancelTask 直接输出 Task；ListTasks 保留 tasks、nextPageToken 等标准分页结果。
支持 `--after=ISO_TIMESTAMP` 过滤状态更新时间。列表不自动遍历所有页。
任务订阅输出首个 Task 与后续标准事件，SSE 评论/保活不输出，UTF-8 分片、多行 data 和 CRLF 均可解析。
断流前没有观察到结束或暂停状态时返回错误，并保留已收到的任务 ID，不将 HTTP 200 当作任务完成。

扩展 Card 和其他标准方法通过通用 RPC 调用：

```bash
flowlet a2a discover --extended --profile=RESEARCH
flowlet a2a rpc CreateTaskPushNotificationConfig --params-file=./notification.json --profile=RESEARCH
flowlet a2a rpc GetTask --params='{"id":"task-...","historyLength":0}' --profile=RESEARCH
```

RPC 仅接受 A2A 1.0 标准方法，params 原样传递（另按选定接口补 tenant）。流式方法自动输出 NDJSON。
上游不支持的操作保留标准错误码，不降级成其他操作。

退出码：普通成功/异步提交/查询/取消为0；协议、HTTP、网络及本地错误为1；send/wait 任务
失败、取消、拒绝或需要补充输入/鉴权为2；本地 SIGINT/SIGTERM 为130/143。查询得到失败任务本身
仍是一次成功查询，退出0，调用方从 Task.status 判断执行结果。

## 验证与分发

真实 CLI 子进程测试位于 `packages/flowlet-cred/src/__tests__/a2a.test.ts`，使用独立通用 Agent mock，
覆盖标准发现、任务/直接消息、跨进程会话、附件与 URL、SSE、超时、并发取消、信号、凭据边界及错误。
百晓生只作为真实接入验证服务，不是 CLI 的适配器或内置 Agent。

CLI 与通用技能由 `node scripts/build-local-access.mjs` 打入 Web Host 下载包。
更新已安装 CLI 可重新运行管理台的安装命令，既有凭据和 CLI 授权保留。
服务端网关无新增 API、数据表或热更新规则；本地新增会话文件，CLI 升级无需修改 Agent 注册信息。

### 发布与验收（2026-11-12）

- 实现提交 `f732c01`，恢复诊断与协议校验补充提交 `d41baef`、`c0ac487`。
  最终镜像 `flowlet:node-20261112-a2a-cli-c0ac487`，仅覆盖 `/app/ui/downloads` 四个下载产物，
  未发布工作区其他服务端或前端改动。
- 凭据 CLI 回归通过；最终17项 A2A 真实子进程契约测试通过，类型检查及下载包解压调用通过。
  通用 mock 包含与百晓生不同的 tenant、直接 Message、自定义 MIME、跨域/重定向与异常 SSE 场景。
- 百晓生只作为真实验证：发现、多轮、文本附件正文读取、流式 NDJSON、异步任务、分页、
  实际取消、订阅取消结果、wait 和标准 RPC 均通过。安装后的 CLI 再次验证新会话两轮与9帧流式完成。
- 验收另遇旧测试会话上游历史接口404，CLI 如实输出 FAILED 并退出2，未重发；显式新会话验证通过。
- Canary 与生产四个下载文件 SHA-256 均与本地构建一致；最终 CLI 包 SHA-256 为
  `06032768dcefbb6b71e9929b759fb73c47f42af4111809cc403f65e4591794f6`。
  本机已按服务器安装脚本升级，四个 CLI 入口/模块与仓库源码逐文件校验一致。
- Host 最终切换最长健康探测间隔2.63秒，healthy、OIDC-only、模型流式回归3/3。
  `flowlet-egress` 与独立 `aiops-a2a` 容器 ID / 启动时间未变，既有 CLI login/pull 授权仍有效。
- 没有数据库或凭据格式迁移；本地新增会话记录。下载产物随本次 Host 镜像部署生效，
  已安装的其他机器需重新运行安装脚本；凭据/会话变更由下一次命令读取，无需常驻后台进程。
