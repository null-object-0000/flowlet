import { a2aStateLabel } from "../../domains/a2a/presentation";
import { newA2aId } from "../../domains/a2a/identity";
import { useNavigate } from "react-router-dom";
import {
  Banner,
  Button,
  Input,
  Modal,
  Select,
  Spin,
  Typography,
} from "@douyinfe/semi-ui-19";
import type { A2aAgentInput } from "../../domains/a2a/types";
import { PageHeader } from "../../shared/ui/PageHeader";
import { errorMessage } from "../../shared/errors/AppError";
import { isWebHost } from "../../platform/web/mode";
import { isDesktopHost, isDesktopClient } from "../../platform/desktop/mode";
import { useA2aGateway } from "../../features/a2a/useA2aGateway";
import { A2aOverlays } from "./A2aOverlays";
import styles from "./A2aPage.module.css";

const EMPTY: A2aAgentInput = {
  id: "",
  name: "",
  cardUrl: "",
  enabled: true,
  allowPrivateNetwork: false,
  timeoutSeconds: 300,
  upstreamToken: "",
};

export function A2aPage() {
  const navigate = useNavigate();
  if (!isWebHost && !isDesktopHost)
    return (
      <main className={styles.page}>
        <PageHeader title="A2A 网关" />
        <Banner description="A2A 网关需要 Electron 或 Web/Docker Node Host；当前 Rust 宿主暂不支持。" />
      </main>
    );
  return <A2aContent onBack={() => navigate("/sessions")} />;
}

function A2aContent({ onBack }: { onBack: () => void }) {
  const model = useA2aGateway();
  const {
    agents,
    keys,
    filter,
    setFilter,
    calls,
    setDraft,
    setEditing,
    setPreview,
    keyName,
    setKeyName,
    grants,
    setGrants,
    setSelected,
    setMessage,
    setContextId,
    setTaskId,
    setResult,
    setCallDetail,
    refresh,
    remove,
    createKey,
    revoke,
  } = model;
  const error = agents.error || calls.error || keys.error;
  return (
    <main className={styles.page}>
      <PageHeader
        title="A2A 网关"
        subtitle="登记外部 Agent，统一入口、调用权限与任务观测。"
      >
        <Button theme="borderless" onClick={onBack}>
          返回会话管理
        </Button>
        <Button onClick={() => void refresh()}>刷新</Button>
        <Button
          theme="solid"
          onClick={() => {
            setEditing(false);
            setPreview(null);
            setDraft({ ...EMPTY });
          }}
        >
          登记 Agent
        </Button>
      </PageHeader>
      <div className={styles.content}>
        {error && <Banner type="danger" description={errorMessage(error)} />}
        {agents.isPending ? (
          <Spin />
        ) : (
          <section className={styles.section} aria-label="已登记的 Agent">
            {!agents.data?.length && (
              <p className={styles.muted}>
                尚未登记 Agent。填写标准 Agent Card 地址即可接入 A2A v1 JSON-RPC
                服务。
              </p>
            )}
            {agents.data?.map((agent) => (
              <div key={agent.id} className={styles.row}>
                <div>
                  <strong>{agent.name}</strong> ·{" "}
                  {agent.enabled ? "已启用" : "已停用"}
                  <div className={styles.muted}>{agent.card.description}</div>
                  <Typography.Text copyable>
                    {agent.gatewayUrl ??
                      new URL(
                        agent.gatewayPath,
                        isDesktopClient
                          ? (window.flowletDesktop?.clientBaseUrl ??
                            window.location.origin)
                          : window.location.origin,
                      ).href}
                    /.well-known/agent-card.json
                  </Typography.Text>
                  <div className={styles.muted}>
                    技能：
                    {agent.card.skills.map((s) => s.name).join("、") || "无"}
                  </div>
                </div>
                <Button
                  disabled={!agent.enabled}
                  onClick={() => {
                    setSelected(agent);
                    setResult(null);
                    setMessage("");
                    setContextId(newA2aId());
                    setTaskId("");
                  }}
                >
                  调用与任务
                </Button>
                <Button
                  onClick={() => {
                    setEditing(true);
                    setPreview(null);
                    setDraft({
                      id: agent.id,
                      name: agent.name,
                      cardUrl: agent.cardUrl,
                      enabled: agent.enabled,
                      allowPrivateNetwork: agent.allowPrivateNetwork,
                      timeoutSeconds: agent.timeoutSeconds,
                    });
                  }}
                >
                  编辑
                </Button>
                <Button
                  type="danger"
                  loading={remove.isPending}
                  onClick={() =>
                    Modal.confirm({
                      title: `移除 ${agent.name}？`,
                      content: "将停止该 Agent 的网关入口，保留调用记录。",
                      onOk: () => remove.mutateAsync(agent.id),
                    })
                  }
                >
                  移除
                </Button>
              </div>
            ))}
          </section>
        )}
        <section className={styles.section} aria-label="调用密钥">
          <strong>调用密钥</strong>
          <p className={styles.muted}>
            仅用于 A2A 入口，按 Agent 授权。管理凭据、模型 Client Token
            不可用于这里。获授权的调用方共享该 Agent 的上游身份与任务空间。
          </p>
          <div className={styles.row}>
            <Input
              aria-label="密钥名称"
              placeholder="调用方名称"
              value={keyName}
              onChange={setKeyName}
            />
            <Select
              multiple
              aria-label="允许调用的 Agent"
              placeholder="允许调用的 Agent"
              value={grants}
              style={{ minWidth: 220 }}
              optionList={agents.data?.map((a) => ({
                value: a.id,
                label: a.name,
              }))}
              onChange={(value) => setGrants(value as string[])}
            />
            <Button
              disabled={!keyName.trim() || !grants.length}
              loading={createKey.isPending}
              onClick={() => createKey.mutate()}
            >
              创建密钥
            </Button>
          </div>
          {keys.data?.map((key) => (
            <div className={styles.row} key={key.id}>
              <span>
                {key.name} · {key.agentIds.join("、")}
              </span>
              <Button
                type="danger"
                loading={revoke.isPending}
                onClick={() =>
                  Modal.confirm({
                    title: `撤销 ${key.name}？`,
                    content: "撤销后新请求立即失效。",
                    onOk: () => revoke.mutateAsync(key.id),
                  })
                }
              >
                撤销
              </Button>
            </div>
          ))}
        </section>
        <section className={styles.section} aria-label="调用记录">
          <div className={styles.row}>
            <strong>最近调用</strong>
            <Select
              showClear
              placeholder="全部 Agent"
              aria-label="筛选 Agent"
              value={filter}
              optionList={agents.data?.map((a) => ({
                value: a.id,
                label: a.name,
              }))}
              onChange={(value) => setFilter(value as string | undefined)}
            />
          </div>
          <div className={styles.table}>
            <table>
              <thead>
                <tr>
                  <th>时间 / Agent</th>
                  <th>方法 / 调用方</th>
                  <th>任务状态</th>
                  <th>耗时 / HTTP</th>
                  <th>详情</th>
                </tr>
              </thead>
              <tbody>
                {calls.data?.map((call) => (
                  <tr key={call.id}>
                    <td>
                      {new Date(call.startedAt).toLocaleString()}
                      <br />
                      {call.agentId}
                    </td>
                    <td>
                      {call.method}
                      <br />
                      {keys.data?.find((k) => k.id === call.keyId)?.name ??
                        call.keyId}
                    </td>
                    <td>{call.error || a2aStateLabel(call.state)}</td>
                    <td>
                      {call.durationMs} ms / {call.httpStatus ?? "—"}
                    </td>
                    <td>
                      <Button
                        theme="borderless"
                        onClick={() => setCallDetail(call)}
                      >
                        查看
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!calls.data?.length && (
              <p className={styles.muted}>暂无调用记录</p>
            )}
          </div>
        </section>
      </div>
      <A2aOverlays model={model} />
    </main>
  );
}
