# Agent 网关的 ACP 适配

用户维护一份原生配置：A2A 服务填 Card URL 与上游凭据，ACP 程序填可执行程序、参数数组与
宿主工作目录。Agent 都提供 A2A 入口，「接入配置」同时生成 `flowlet acp`、T3 Code 和 Paseo
配置。百晓生等自有远程服务优先保持 A2A 封装，登录与业务接口解析留在独立服务中。

```text
A2A 客户端 ────────────────→ Host /a2a/<id> → 原生 A2A 服务
ACP 客户端 → flowlet acp ──→ Host /a2a/<id> → 官方 a2aacp 执行器 → ACP 程序
```

两种上游均可使用以上两种客户端入口；桥接只提供共同能力，不承诺全部功能等价互转。

## 复用与构建

- 客户端桥复用官方 `@agentclientprotocol/sdk` **2.7.0**，Apache-2.0。
- 上游桥复用官方 `github.com/a2aproject/a2a-go/v2` **v2.8.0** 的 `a2aacp` 执行器，
  Apache-2.0。Flowlet 包装私有环回 HTTP、认证和进程生命周期。
- Go 版本与校验值锁定在 `go.mod` / `go.sum`，来源及许可证见
  `packages/flowlet-agent-bridge/NOTICE`、`LICENSE.a2a-go`。构建附带 Go 依赖许可证；
  CLI 离线下载包附带 ACP SDK 及许可证。
- 源码开发先运行 `npm run agent-bridge:build`，需 Go 1.26+。桌面宿主构建自动生成辅助程序，
  Docker 多阶段构建包含它。交叉编译使用 `GOOS` / `GOARCH`。
- 可在宿主环境用 `FLOWLET_ACP_BRIDGE_BIN` 指向已安装辅助程序，管理页面不接受该配置。

## ACP 上游程序

Electron 本机 Host 默认允许登记。Web/Docker 默认关闭，需在启动环境设置
`FLOWLET_ENABLE_ACP=1` 并重启；缺少辅助程序时不开启。Electron client 模式只管理远程 Host，
不能在客户端机器启动程序。Rust/Tauri 回滚宿主不提供网关。

管理命令使用显式白名单，验证、保存、调用测试仅限管理员。验证与保存会启动程序并协商 ACP，
然后停止验证实例；正式调用按 Agent 延迟启动托管实例。程序以 argv 直接启动，不经过 shell。
Agent 需预先安装和登录，使用宿主身份与环境，剥离 `FLOWLET_*` 变量。启动参数中不要放密钥。
这是受信任管理员托管程序的能力，不是代码沙箱。

辅助 HTTP 仅监听 `127.0.0.1` 随机端口，实例随机认证 Token 经 stdin 传入，不落盘或暴露给
渲染进程。外部请求统一使用模型服务的 Flowlet Client Token，与管理凭据分开；旧 `flwa2a_` 调用密钥只作兼容。
同一 Agent 的获授权调用方共享其宿主身份及任务空间。

ACP 上游 Card 声明文本/结构化数据、流式调用与 Structured Input 扩展；消息和工具输出转换
由官方执行器完成。权限询问暂停为 `TASK_STATE_INPUT_REQUIRED`，用户回复提示中的选项，
或由支持扩展的 A2A 客户端提交结构化回答。**不自动批准**。客户端文件系统、终端和 MCP
委托不开放；不伪造推送通知或扩展 Card 能力。

Host 最多保留 8 个运行环境，每个环境最多创建 1000 个任务；超限明确报错，不淘汰活跃任务。
官方执行器的任务与 ACP 会话存于内存，**不跨运行环境恢复**。保存（含停用）、移除、程序退出
或 Host 停机会终止旧环境与子进程，调用记录保留。重启后使用新的 context/task；旧任务查询
可能返回不存在，保存前应结束重要任务。

## ACP 客户端桥

在 T3 Code / Paseo **服务端所在机器**安装 Flowlet CLI，运行 `flowlet acp`，通过 ACP v1 stdio
提供 Agent 服务。stdout 只有协议帧，启动错误走 stderr。凭据规则与 `flowlet a2a` 一致，支持
`--profile=NAME`、`--prefix=PREFIX`；环境覆盖必须成对提供 `<PREFIX>_URL` 与 `<PREFIX>_TOKEN`，
也可复用全局凭据库，TOKEN 的值与模型服务 Client Token 相同。默认超时 900 秒，支持 `--timeout=1..3600`，`--extensions=URI,...` 传递
A2A 扩展协商头。密钥不放命令参数；页面默认预览占位符；点击复制完整配置时读取当前 Client Token 并填入，不在浏览器持久化。

T3 Code 的 Local ACP Provider 使用生成的 executable/args/env。Paseo 使用 `extends: "acp"`，
`options.supportsMcpServers: false` 及禁用文件/终端能力的配置。默认拒绝客户端附带 MCP 服务器。生成的启动参数显式添加 `--ignore-client-mcp`，兼容 T3 自动注入自带 MCP 的行为：只使用远程 Agent 能力，不执行或转发这些 MCP 配置，并在首次回复中说明。Paseo 仍应关闭 MCP 注入。

模型选择显示为「Agent · 上游默认」，只暴露当前确实可用的选项；A2A 1.0 不提供通用底层模型列表或切换接口，不得将 Flowlet 的模型服务列表伪装成该远程 Agent 可选择的模型。

支持文本与 resource_link 输入，明确拒绝图片、音频和嵌入资源输入，不读取或上传客户端文件。
文本、结构化数据及链接输出展示为文本；内联文件输出完整 data URI，不下载 URL。A2A Artifact
追加/替换映射为 ACP 可更新的输出卡片，最终答案同时输出为消息。卡片表示上游产物。
权限与补充输入以提示消息展示，用户回复后继续同一暂停任务。

完成后保留 contextId、清除 taskId，只有暂停任务携带 taskId 续聊。取消转发 CancelTask，
仅上游确认取消时返回 cancelled。中断、超时、失败不自动重发；未完成任务先查询/取消。
观察到完成或暂停状态即结束当前 ACP 轮次，不等待上游保持打开的 SSE 连接。

映射和可回放历史存于凭据目录 `a2a-sessions/`，绑定 URL、凭据前缀及工作目录，沿用私有文件
权限。`session/load` 回放历史并继续上游 context，不能恢复已消失的上游任务。每进程最多加载
100 个会话，单会话历史上限 8 MiB，单次协议帧和产物上限 4 MiB。同一会话跨进程使用独占锁；
异常退出留下锁时，确认旧进程结束后手动移除，不抢锁。会话文件可能包含用户与 Agent 内容，
删除对应文件即可清除本地历史。

## 数据兼容与热更新

沿用 `a2a_agents` JSON 行存储，仅加入可选 `protocol` 和 `acp` 字段；缺省协议为 A2A。
无表重建和历史重写，现有 A2A Agent、密钥继续有效。已登记 ID 不允许切换协议，需新建 ID。
旧版 Host 不认识 ACP 行，不应使用旧版管理新增 ACP Agent。

Agent 配置、启停、授权与撤销对后续请求立即生效，ACP 保存会停止旧环境。Web ACP 开关、辅助
程序路径和代码升级需重启 Host；CLI 更新后客户端重启桥接。模型路由、计费与 Rust 宿主行为不变。
