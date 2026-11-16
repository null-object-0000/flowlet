import {
  Banner,
  Button,
  Input,
  InputNumber,
  Select,
  SideSheet,
  Switch,
  TextArea,
} from "@douyinfe/semi-ui-19";
import {
  a2aStateLabel,
  callMethodLabel,
  callOutcome,
} from "../../domains/a2a/presentation";
import type { A2aGatewayState } from "../../features/a2a/useA2aGateway";
import { APP_OVERLAY_Z_INDEX as overlayLayers } from "../../shared/ui/overlayLayers";
import styles from "./A2aPage.module.css";
export function A2aOverlays({ model }: { model: A2aGatewayState }) {
  const {
    draft,
    setDraft,
    editing,
    preview,
    setPreview,
    selected,
    setSelected,
    message,
    setMessage,
    contextId,
    setContextId,
    taskId,
    setTaskId,
    result,
    callDetail,
    setCallDetail,
    save,
    inspect,
    invoke,
    rpc,
  } = model;
  return (
    <>
      <SideSheet
        title={editing ? "编辑 Agent" : "登记 Agent"}
        visible={!!draft}
        width={560}
        zIndex={overlayLayers.sideSheet}
        onCancel={() => {
          setDraft(null);
          setPreview(null);
        }}
      >
        {draft && (
          <div className={styles.form}>
            <label className={styles.field}>
              接入协议
              <Select
                aria-label="接入协议"
                disabled={editing}
                value={draft.protocol ?? "a2a"}
                optionList={[
                  { value: "a2a", label: "A2A · 远程 Agent 服务" },
                  {
                    value: "acp",
                    label: "ACP · 宿主上的 Agent 程序",
                    disabled: !model.capabilities.data?.acpRegistration,
                  },
                ]}
                onChange={(value) => {
                  setDraft({
                    ...draft,
                    protocol: value as "a2a" | "acp",
                    acp: draft.acp ?? { command: "", args: [], cwd: "" },
                  });
                  setPreview(null);
                }}
              />
            </label>
            {!model.capabilities.data?.acpRegistration && (
              <p className={styles.muted}>
                当前宿主尚未启用 ACP 程序运行；仍可登记 A2A 服务，并生成供 ACP
                客户端使用的接入配置。
              </p>
            )}
            <label className={styles.field}>
              Agent ID
              <Input
                aria-label="Agent ID"
                disabled={editing}
                value={draft.id}
                onChange={(id) => setDraft({ ...draft, id })}
              />
            </label>
            <label className={styles.field}>
              名称
              <Input
                aria-label="Agent 名称"
                value={draft.name}
                onChange={(name) => setDraft({ ...draft, name })}
              />
            </label>
            {draft.protocol === "acp" ? (
              <>
                <Banner description="程序在 Flowlet 宿主机器上运行，使用该机器已有的 Agent 登录与环境。验证会启动程序进行协议协商。" />
                <label className={styles.field}>
                  可执行程序
                  <Input
                    aria-label="ACP 可执行程序"
                    placeholder="dsh"
                    value={draft.acp?.command ?? ""}
                    onChange={(command) =>
                      setDraft({
                        ...draft,
                        acp: { args: [], cwd: "", ...draft.acp, command },
                      })
                    }
                  />
                </label>
                <label className={styles.field}>
                  启动参数（每行一个参数）
                  <TextArea
                    aria-label="ACP 启动参数"
                    placeholder={"--profile\nacp"}
                    value={draft.acp?.args.join("\n") ?? ""}
                    onChange={(value) =>
                      setDraft({
                        ...draft,
                        acp: {
                          command: "",
                          cwd: "",
                          ...draft.acp,
                          args: value ? value.split("\n") : [],
                        },
                      })
                    }
                  />
                </label>
                <label className={styles.field}>
                  宿主工作目录
                  <Input
                    aria-label="ACP 工作目录"
                    placeholder="绝对路径"
                    value={draft.acp?.cwd ?? ""}
                    onChange={(cwd) =>
                      setDraft({
                        ...draft,
                        acp: { command: "", args: [], ...draft.acp, cwd },
                      })
                    }
                  />
                </label>
                <p className={styles.muted}>
                  保存或停用时会结束旧运行环境。任务与会话保留到该运行环境停止；同一
                  Agent 的获授权调用方共享任务空间。首版通过 A2A
                  提供文本与结构化数据调用。
                </p>
              </>
            ) : (
              <>
                <label className={styles.field}>
                  Agent Card URL
                  <Input
                    aria-label="Agent Card URL"
                    placeholder="https://agent.example.com/.well-known/agent-card.json"
                    value={draft.cardUrl}
                    onChange={(cardUrl) => {
                      setDraft({ ...draft, cardUrl });
                      setPreview(null);
                    }}
                  />
                </label>
                <label className={styles.field}>
                  上游 Bearer Token
                  <Input
                    mode="password"
                    aria-label="上游 Bearer Token"
                    placeholder={editing ? "留空保留已存凭据" : "无鉴权可留空"}
                    value={draft.upstreamToken ?? ""}
                    onChange={(upstreamToken) =>
                      setDraft({
                        ...draft,
                        upstreamToken: upstreamToken || undefined,
                      })
                    }
                  />
                </label>
                {editing && (
                  <Button
                    onClick={() => setDraft({ ...draft, upstreamToken: "" })}
                  >
                    清除上游 Token
                  </Button>
                )}
                <label className={styles.row}>
                  <span>允许访问内网 / 本机服务</span>
                  <Switch
                    checked={draft.allowPrivateNetwork}
                    onChange={(allowPrivateNetwork) =>
                      setDraft({ ...draft, allowPrivateNetwork })
                    }
                  />
                </label>
              </>
            )}
            <label className={styles.row}>
              <span>启用</span>
              <Switch
                checked={draft.enabled}
                onChange={(enabled) => setDraft({ ...draft, enabled })}
              />
            </label>
            <label className={styles.row}>
              <span>调用超时（秒）</span>
              <InputNumber
                min={5}
                max={1800}
                value={draft.timeoutSeconds}
                onChange={(value) =>
                  setDraft({ ...draft, timeoutSeconds: Number(value) })
                }
              />
            </label>
            <div className={styles.row}>
              <Button
                loading={inspect.isPending}
                onClick={() => inspect.mutate(draft)}
              >
                {draft.protocol === "acp" ? "验证 ACP 程序" : "读取 Agent Card"}
              </Button>
              <Button
                theme="solid"
                loading={save.isPending}
                onClick={() => save.mutate(draft)}
              >
                验证并保存
              </Button>
            </div>
            {!!preview && (
              <pre className={styles.code}>
                {JSON.stringify(preview, null, 2)}
              </pre>
            )}
          </div>
        )}
      </SideSheet>
      <SideSheet
        title={selected ? `测试调用 · ${selected.name}` : "测试调用"}
        visible={!!selected}
        width={640}
        zIndex={overlayLayers.sideSheet}
        onCancel={() => setSelected(null)}
      >
        <div className={styles.form}>
          <Banner description="这里使用管理员身份测试。外部客户端统一使用 Flowlet Client Token；流式调用使用 Agent 的 A2A 入口。" />
          <details>
            <summary>会话与任务（续聊 / 查询）</summary>
            <div className={styles.form}>
              <Input
                aria-label="Context ID"
                placeholder="Context ID（续聊时填写）"
                value={contextId}
                onChange={setContextId}
              />
              <Input
                aria-label="Task ID"
                placeholder="Task ID（查询 / 取消任务时填写）"
                value={taskId}
                onChange={setTaskId}
              />
            </div>
          </details>
          <TextArea
            aria-label="消息"
            placeholder="发送给 Agent 的消息"
            value={message}
            onChange={setMessage}
          />
          <div className={styles.row}>
            <Button
              loading={invoke.isPending}
              disabled={!message.trim()}
              onClick={() => invoke.mutate(rpc("SendMessage"))}
            >
              发送消息
            </Button>
            <Button
              disabled={!taskId || invoke.isPending}
              onClick={() => invoke.mutate(rpc("GetTask"))}
            >
              查询任务
            </Button>
            <Button
              disabled={invoke.isPending}
              onClick={() => invoke.mutate(rpc("ListTasks"))}
            >
              列出任务
            </Button>
            <Button
              type="danger"
              disabled={!taskId || invoke.isPending}
              onClick={() => invoke.mutate(rpc("CancelTask"))}
            >
              取消任务
            </Button>
          </div>
          {!!result && (
            <details open>
              <summary>调用结果</summary>
              <pre className={styles.code}>
                {JSON.stringify(result, null, 2)}
              </pre>
            </details>
          )}
        </div>
      </SideSheet>
      <SideSheet
        title="调用详情"
        visible={!!callDetail}
        width={640}
        zIndex={overlayLayers.sideSheet}
        onCancel={() => setCallDetail(null)}
      >
        {callDetail && (
          <div className={styles.form}>
            <dl className={styles.detailGrid}>
              <dt>操作</dt>
              <dd>{callMethodLabel(callDetail.method)}</dd>
              <dt>请求结果</dt>
              <dd>
                {callOutcome(callDetail).label}
                {callDetail.httpStatus !== null
                  ? ` · HTTP ${callDetail.httpStatus}`
                  : ""}
              </dd>
              <dt>请求时间</dt>
              <dd>{new Date(callDetail.startedAt).toLocaleString()}</dd>
              <dt>请求耗时</dt>
              <dd>
                {callDetail.finishedAt === null
                  ? "尚未结束"
                  : `${callDetail.durationMs} ms`}
              </dd>
              <dt>响应时任务状态</dt>
              <dd>{a2aStateLabel(callDetail.state)}</dd>
              <dt>任务最新状态</dt>
              <dd>
                {a2aStateLabel(callDetail.latestTaskState ?? callDetail.state)}
              </dd>
              <dt>Task ID</dt>
              <dd>{callDetail.taskId || "—"}</dd>
              <dt>Context ID</dt>
              <dd>{callDetail.contextId || "—"}</dd>
            </dl>
            {callDetail.error && (
              <Banner type="danger" description={callDetail.error} />
            )}
            <p className={styles.muted}>
              请求成功表示协议请求已返回，不代表任务已经执行完成。任务最新状态来自最近一次成功观测。
            </p>
            <details>
              <summary>请求正文</summary>
              <pre className={styles.code}>
                {callDetail.requestBody ?? "未捕获或已按保留策略清理"}
              </pre>
            </details>
            <details>
              <summary>响应正文</summary>
              <pre className={styles.code}>
                {callDetail.responseBody ?? "未捕获或已按保留策略清理"}
              </pre>
            </details>
            <p className={styles.muted}>
              正文受数据捕获设置控制，每侧最多保留 64 KiB。
            </p>
          </div>
        )}
      </SideSheet>
    </>
  );
}
