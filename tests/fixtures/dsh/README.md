# DSH 会话夹具

这些文件取自真实 DeepSeek Harness 会话（`~/.dsh/sessions`），已解压为
JSONL，并做了两类**不改变结构**的削减：

- 截到第一个完整 `turn/end`（避免出现「turn/start 没有配对 turn/end」或
  「tool/result 没有对应 tool/call」的断链）；
- 长文本截断、`request/header.tools` 置空、`message.source.replayState` 删除、
  重复的打包 chunk 行与 `assistant/message.stream` 只保留前若干条。

字段名、事件类型、`seq`/`time` 坐标与嵌套层级均与真实记录一致，因此这些夹具
固定的是「真实形状」而不是手写想象形状。

| 文件 | 来源 | 覆盖点 |
|---|---|---|
| `session-v0-basic.jsonl` | `session.jsonl.zstd`（`version: 0`） | 预发布 v0 仍可读；`assistant/chunk` 与打包 chunk 行；`data.provenance`/`data.message.source` 双形状 |
| `session-v3-basic.jsonl` | `session.v3.jsonl.zstd`（`isSeeded: false`） | 当前代际：`system/message` 提示词 surface、`data.message.content` 内容块、`data.usage`、`assistant/attempt`、PTC 前身事件名、`session/title` |
| `session-v3-seeded.jsonl` | `session.v3.jsonl.zstd`（`isSeeded: true`） | 继承前缀必须按 `session/end-seed`（`inherited: true`）裁掉，父会话历史不得重复投影 |

重放或新增夹具的方式：从本机 `~/.dsh/sessions` 取真实文件，用仓库外的临时脚本
解压（DSH 的 zstd 是多分帧流，需按分帧逐个解码）后按上面的规则裁剪。
