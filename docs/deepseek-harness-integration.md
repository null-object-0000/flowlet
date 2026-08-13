# DeepSeek Harness 接入说明

## 结论

DeepSeek Harness（DSH）在 Flowlet 中登记为本机 `web` Surface，而不是传统 CLI 或
Desktop：用户主要通过 `dsh web` 打开的本地浏览器界面使用它；npm/npx 是分发与启动方式，
`--profile headless` 是自动化 Runner 能力，两者都不改变产品 Surface。

本次核对源码为 `D:\GitHub\deepseek-harness`，提交
`47f943859bef60e4160492346772ded9b24f765a`（2026-08-13）。仓库 manifest 为
`0.1.0-rc.5`，用户实际通过 npm 运行的是 `0.1.0-rc.6`；因此 Flowlet 只依赖已由源码和
已安装包共同确认的稳定边界，不推断未发布内部 API。

## 四类 Adapter

| Adapter | 当前能力 | 明确边界 |
|---|---|---|
| Environment | 分别检测 `$DSH_HOME`/`~/.dsh`、3080 Web 运行状态、PATH 中的 `dsh` 与包版本 | 可只读识别无歧义的 `_npx/<hash>` 包版本，但不把临时缓存当作稳定安装；已安装不等于 Web 正在运行 |
| Global Config | 解析配置状态；直接安全合并官方 YAML，一键写入/恢复 Provider、默认模型和 Client Token | 不依赖 DSH Web 运行；复用 DSH 的文件锁协议，保留非受管配置和注释 |
| Session | 读取 `sessions/**/session.jsonl(.zstd)` v0，展示最终消息、工具事件和原生 Token 用量 | DSH 预发布格式无迁移承诺；其它版本明确拒绝；打包 delta chunk 不作为最终消息展示 |
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
      headers:
        x-flowlet-client: deepseek-harness
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

该链路不会向 DSH 安装插件、扩展或 Hook，也不修改 DSH 包和运行时代码。环境探测与原生
Session Adapter 均为只读；Headless Runner 只调用 DSH 官方命令。Provider 中的
`x-flowlet-client` 是普通静态请求 Header，仅用于日志归属，并会在 Flowlet 转发上游前剥离。

两份文件均由 DSH 热加载；若 DSH 未运行，则下次启动直接生效。静态 `x-flowlet-client` 仅用于请求归属，
代理识别后会在转发上游前剥离。DSH 当前没有适合静态配置的动态 session header 注入点，
因此 Flowlet 可以准确识别客户端，但不能仅凭代理请求把每次调用精确关联到 DSH 原生 session；
原生 Session Adapter 仍可独立展示 DSH 会话。

## 仍保留的能力边界

- DSH headless 提供稳定 resume/session-id 参数后，再开放 continuation task。
- DSH 提升 `SESSION_FORMAT_VERSION` 时，先按新版本语义补迁移/解析测试，再扩大接受范围。
