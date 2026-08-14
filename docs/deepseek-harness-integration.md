# DeepSeek Harness 接入说明

## 结论

DeepSeek Harness（DSH）在 Flowlet 中登记为本机 `web` Surface，而不是传统 CLI 或
Desktop：用户主要通过 `dsh web` 打开的本地浏览器界面使用它；npm/npx 是分发与启动方式，
`--profile headless` 是自动化 Runner 能力，两者都不改变产品 Surface。

本次核对源码为 `D:\GitHub\deepseek-harness`，提交
`47f943859bef60e4160492346772ded9b24f765a`（2026-08-13）。仓库 manifest 为
`0.1.0-rc.5`，用户实际通过 npm 运行的是 `0.1.0-rc.6`；因此 Flowlet 只依赖已由源码和
已安装包共同确认的稳定边界，不推断未发布内部 API。

## 五类 Adapter

| Adapter | 当前能力 | 明确边界 |
|---|---|---|
| Environment | 分别检测 `$DSH_HOME`/`~/.dsh`、3080 Web 运行状态、PATH 中的 `dsh` 与包版本 | 可只读识别无歧义的 `_npx/<hash>` 包版本，但不把临时缓存当作稳定安装；已安装不等于 Web 正在运行 |
| Global Config | 解析配置状态；直接安全合并官方 YAML，一键写入/恢复 Provider、默认模型和 Client Token；精确会话插件为显式可选高级能力 | 基础接入不依赖 DSH Web 或 Profile；复用 DSH 的文件锁协议，保留非受管配置和注释 |
| Session | 读取 `sessions/**/session.jsonl(.zstd)` v0，展示最终消息、工具事件和原生 Token 用量 | DSH 预发布格式无迁移承诺；其它版本明确拒绝；打包 delta chunk 不作为最终消息展示 |
| Identity | 使用官方 User-Agent 识别客户端；可选会话桥启用时读取并剥离 `x-flowlet-session` | 与其他 Agent 共用编译期 Identity Adapter registry，实时请求与历史修复规则一致 |
| Runner | 通过稳定全局命令执行 `dsh --profile headless <task>` | 仅 fresh session；DSH 没有稳定 resume 参数时明确失败 |

## Flowlet Provider

DSH 的 `llm-pi-ai` Provider 使用 Flowlet OpenAI-compatible 端点：

```yaml
llm-pi-ai:
  providers:
    flowlet:
      displayName: Flowlet
      apiKeyEnv: FLOWLET_CLIENT_TOKEN
      api: openai-completions
      baseURL: http://127.0.0.1:18640/v1
      sessionIdHeader: x-flowlet-session
      models:
        - id: flowlet-pro
        - id: flowlet-flash
agent-default-model:
  provider: flowlet
  model: flowlet-pro
```

当前不为 `flowlet-pro` / `flowlet-flash` 声明 `input: [text, image]`。Flowlet 的聚合路由尚未按
输入模态筛选候选，且内置聚合模型目录当前只承诺文本输入；若在 DSH 中宣称支持图片，图片会
通过本地校验后落到不一定支持视觉的上游，形成随机失败。后续只有在聚合路由具备稳定的视觉
能力声明与候选筛选后，才应为对应模型增加 `input: [text, image]`。

凭据单独写入 `$DSH_HOME/.credentials.yaml`：

```yaml
FLOWLET_CLIENT_TOKEN: <Client Token>
```

一键接入直接修改 DSH 官方配置文件。Flowlet 使用与 DSH 相同的相邻 `<file>.lock` 独占锁协议，
按叶子路径合并 `llm-pi-ai.providers.flowlet`、`agent-default-model.provider`、
`agent-default-model.model` 与专用凭据，再通过临时文件替换完成原子写入；两份文件任一写入失败时
会回滚。操作前只备份这些受管路径，恢复时不会覆盖其他 Provider、设置或用户后来增加的字段。
若现有受管父路径使用无法安全定点改写的行内/复杂 YAML，Flowlet 会明确报错而不会猜测重写。
该能力不依赖 DSH Web 正在运行：运行中由 DSH 热加载，未运行时在下次启动读取。

只有用户显式开启“精确会话关联（高级）”后，一键接入才会通过 DSH 官方 Cordis Profile
配置，在每个已经初始化的 Profile 中部署受管的
`flowlet-session-bridge.mjs`。插件监听官方 `llm/stream` 瀑布取得当前原生 `sessionId`，并使用
`AsyncLocalStorage` 将它限定到当前异步请求；只有 Provider 为 `flowlet` 且目标 URL 位于配置的
Flowlet Base URL 下时才注入 `x-flowlet-session`。并发会话、其他 Provider 和其他 URL 不受影响。
插件文件与 `cordis.patch.yml` 的原始内容均纳入同一备份和事务，恢复接入时原样还原；DSH npm
包及其缓存文件不会被修改。

未启用该高级能力时，基础接入不要求 Profile 已初始化，仍可读取 DSH 原生会话，但不会把每条
代理请求精确合并到原生 session。关闭高级能力会移除受管 Cordis 块并恢复/删除受管插件文件。

Provider 配置与凭据可热加载。Profile 插件属于运行时组合能力，启用或关闭后应重启正在运行的 DSH；
之后无论通过 `npx`、全局 `dsh` 还是其他官方入口启动同一 Profile，插件都会自动加载。未来
DSH 原生支持 `sessionIdHeader` 后，Provider 字段会形成同值兜底，但当前 npm `0.1.0-rc.6` 不以
该未发布能力为前提。请求来源仍由强制携带的 `User-Agent: deepseek-harness/...` 识别，不额外
注入 `x-flowlet-client`。Flowlet 捕获 session id 后按 DSH UA 门控归属，并在转发上游前剥离该
Header；请求日志由此可与原生 `session.jsonl(.zstd)` 精确合并，不按时间猜测。

会话运行状态按最新一组 `turn/start` / `turn/end` 判断：新的 turn 已开始但尚未结束、且会话文件
仍在活跃更新时显示为运行中；`turn/end` 只代表单轮结束，不能用历史任意一条 completed 事件
判定整个 Web 会话已结束。异常退出遗留的未闭合 turn 会在新鲜度窗口后降级为空闲。

## 仍保留的能力边界

- DSH headless 提供稳定 resume/session-id 参数后，再开放 continuation task。
- DSH 提升 `SESSION_FORMAT_VERSION` 时，先按新版本语义补迁移/解析测试，再扩大接受范围。
