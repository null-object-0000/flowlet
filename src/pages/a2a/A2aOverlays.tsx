import {
  Banner,
  Button,
  Input,
  InputNumber,
  Modal,
  SideSheet,
  Switch,
  Typography,
} from "@douyinfe/semi-ui-19";
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
    newToken,
    setNewToken,
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
        title={editing ? "编辑 A2A Agent" : "登记 A2A Agent"}
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
              <Button onClick={() => setDraft({ ...draft, upstreamToken: "" })}>
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
                读取 Agent Card
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
        title={selected ? `调用 ${selected.name}` : "调用与任务"}
        visible={!!selected}
        width={640}
        zIndex={overlayLayers.sideSheet}
        onCancel={() => setSelected(null)}
      >
        <div className={styles.form}>
          <Banner description="这里使用管理员身份测试。外部客户端请使用专用调用密钥；流式调用使用 Agent 的 A2A 入口。" />
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
          <Input
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
            <pre className={styles.code}>{JSON.stringify(result, null, 2)}</pre>
          )}
        </div>
      </SideSheet>
      <SideSheet
        title="A2A 调用详情"
        visible={!!callDetail}
        width={640}
        zIndex={overlayLayers.sideSheet}
        onCancel={() => setCallDetail(null)}
      >
        <pre className={styles.code}>{JSON.stringify(callDetail, null, 2)}</pre>
        <p className={styles.muted}>
          正文受数据捕获设置控制，每侧最多保留 64 KiB；不记录认证请求头。
        </p>
      </SideSheet>
      <Modal
        title="调用密钥（仅显示一次）"
        visible={!!newToken}
        zIndex={overlayLayers.modal}
        onCancel={() => setNewToken("")}
        onOk={() => setNewToken("")}
      >
        <p>请保存到客户端凭据中，关闭后无法再次查看。</p>
        <Typography.Text copyable>{newToken}</Typography.Text>
      </Modal>
    </>
  );
}
