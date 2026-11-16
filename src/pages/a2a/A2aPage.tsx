import { useState } from "react";
import {
  Banner,
  Button,
  Dropdown,
  Input,
  Modal,
  Pagination,
  Select,
  Spin,
  Switch,
  Tag,
} from "@douyinfe/semi-ui-19";
import { IconMore, IconPlus, IconRefresh } from "@douyinfe/semi-icons";
import {
  a2aStateLabel,
  callMethodLabel,
  callOutcome,
} from "../../domains/a2a/presentation";
import { newA2aId } from "../../domains/a2a/identity";
import type { A2aAgent, A2aAgentInput } from "../../domains/a2a/types";
import { APP_OVERLAY_Z_INDEX } from "../../shared/ui/overlayLayers";
import { PageHeader } from "../../shared/ui/PageHeader";
import { errorMessage } from "../../shared/errors/AppError";
import { isWebHost } from "../../platform/web/mode";
import { isDesktopHost, isDesktopClient } from "../../platform/desktop/mode";
import { useA2aGateway } from "../../features/a2a/useA2aGateway";
import { A2aOverlays } from "./A2aOverlays";
import { AgentGatewayAccess } from "./AgentGatewayAccess";
import styles from "./A2aPage.module.css";

const EMPTY: A2aAgentInput = {
  id: "",
  name: "",
  cardUrl: "",
  enabled: true,
  allowPrivateNetwork: false,
  timeoutSeconds: 300,
  upstreamToken: "",
  protocol: "a2a",
};
type Tab = "agents" | "calls";
const time = (value: string) =>
  new Date(value).toLocaleString(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
export function A2aPage() {
  if (!isWebHost && !isDesktopHost)
    return (
      <main className={styles.page}>
        <PageHeader title="Agent 网关" />
        <Banner description="Agent 网关需要 Electron 或 Web/Docker Node Host；当前 Rust 宿主暂不支持。" />
      </main>
    );
  return <A2aContent />;
}
function A2aContent() {
  const model = useA2aGateway();
  const [tab, setTab] = useState<Tab>("agents");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [accessAgent, setAccessAgent] = useState<A2aAgent | null>(null);
  const origin = isDesktopClient
    ? (window.flowletDesktop?.clientBaseUrl ?? window.location.origin)
    : window.location.origin;
  const { agents, calls } = model;
  const error = agents.error || calls.error;
  const agentName = (id: string) =>
    agents.data?.find((agent) => agent.id === id)?.name ?? id;
  const edit = (agent?: A2aAgent) => {
    model.setEditing(!!agent);
    model.setPreview(null);
    model.setDraft(
      agent
        ? {
            id: agent.id,
            name: agent.name,
            cardUrl: agent.cardUrl,
            enabled: agent.enabled,
            allowPrivateNetwork: agent.allowPrivateNetwork,
            timeoutSeconds: agent.timeoutSeconds,
            protocol: agent.protocol ?? "a2a",
            acp: agent.acp,
          }
        : { ...EMPTY, id: `agent-${newA2aId().slice(0, 8)}` },
    );
  };
  const visibleAgents =
    agents.data?.filter((agent) =>
      `${agent.name} ${agent.id} ${agent.card.description ?? ""}`
        .toLowerCase()
        .includes(search.toLowerCase()),
    ) ?? [];
  const rows = calls.data ?? [];
  const currentPage = Math.min(page, Math.max(1, Math.ceil(rows.length / 12)));
  return (
    <main className={styles.page}>
      <PageHeader
        title="Agent 网关"
        subtitle="连接你的 Agent，为不同客户端提供统一接入。"
      >
        <Button
          aria-label="刷新网关"
          icon={<IconRefresh />}
          loading={agents.isFetching || calls.isFetching}
          onClick={() => void model.refresh()}
        />
        <Button theme="solid" icon={<IconPlus />} onClick={() => edit()}>
          添加 Agent
        </Button>
      </PageHeader>
      <nav className={styles.tabs} aria-label="网关视图">
        {(
          [
            ["agents", "Agent", agents.data?.length],
            ["calls", "调用记录"],
          ] as const
        ).map(([id, label, count]) => (
          <button
            key={id}
            type="button"
            aria-current={tab === id ? "page" : undefined}
            onClick={() => setTab(id)}
          >
            {label}
            {count !== undefined && <span>{count}</span>}
          </button>
        ))}
      </nav>
      {error && <Banner type="danger" description={errorMessage(error)} />}
      <div className={styles.content}>
        {tab === "agents" && (
          <>
            <div className={styles.toolbar}>
              <div>
                <strong>已连接的 Agent</strong>
                <p className={styles.muted}>
                  维护原生配置，复制 A2A 或 ACP 客户端接入方式。
                </p>
              </div>
              <Input
                showClear
                aria-label="搜索 Agent"
                placeholder="搜索名称或描述"
                value={search}
                onChange={setSearch}
                className={styles.search}
              />
            </div>
            {agents.isPending ? (
              <Spin />
            ) : (
              <div className={styles.agentGrid}>
                {visibleAgents.map((agent) => (
                  <article className={styles.agentCard} key={agent.id}>
                    <header className={styles.cardHeader}>
                      <div className={styles.agentMark} aria-hidden="true">
                        {agent.name.slice(0, 1).toUpperCase()}
                      </div>
                      <div className={styles.agentIdentity}>
                        <h3>{agent.name}</h3>
                        <span className={styles.muted}>{agent.id}</span>
                      </div>
                      <Tag size="small">
                        {(agent.protocol ?? "a2a").toUpperCase()}
                      </Tag>
                      <Dropdown
                        trigger="click"
                        position="bottomRight"
                        render={
                          <Dropdown.Menu>
                            <Dropdown.Item onClick={() => edit(agent)}>
                              编辑配置
                            </Dropdown.Item>
                            <Dropdown.Item
                              type="danger"
                              onClick={() =>
                                Modal.confirm({
                                  zIndex: APP_OVERLAY_Z_INDEX.modal,
                                  title: `移除 ${agent.name}？`,
                                  content:
                                    "将停止调用入口并清除密钥授权，调用记录保留。",
                                  onOk: () =>
                                    model.remove.mutateAsync(agent.id),
                                })
                              }
                            >
                              移除 Agent
                            </Dropdown.Item>
                          </Dropdown.Menu>
                        }
                      >
                        <Button
                          theme="borderless"
                          aria-label={`管理 ${agent.name}`}
                          icon={<IconMore />}
                        />
                      </Dropdown>
                    </header>
                    <p className={styles.description}>
                      {agent.card.description || "此 Agent 暂未提供描述。"}
                    </p>
                    <div className={styles.skills}>
                      {agent.card.skills.slice(0, 4).map((skill) => (
                        <Tag key={skill.id} size="small">
                          {skill.name}
                        </Tag>
                      ))}
                      {agent.card.skills.length > 4 && (
                        <span className={styles.muted}>
                          +{agent.card.skills.length - 4}
                        </span>
                      )}
                    </div>
                    <div className={styles.cardMeta}>
                      <span
                        className={
                          agent.enabled ? styles.enabled : styles.muted
                        }
                      >
                        {agent.enabled ? "● 已启用" : "○ 已停用"}
                      </span>
                      <span
                        title={
                          agent.protocol === "acp"
                            ? agent.acp?.cwd
                            : agent.endpoint
                        }
                      >
                        {agent.protocol === "acp" ? "宿主程序" : "远程服务"}
                      </span>
                    </div>
                    <footer className={styles.cardFooter}>
                      <Button
                        theme="solid"
                        type="tertiary"
                        onClick={() => setAccessAgent(agent)}
                      >
                        接入配置
                      </Button>
                      <Button
                        theme="borderless"
                        disabled={!agent.enabled}
                        onClick={() => {
                          model.setSelected(agent);
                          model.setResult(null);
                          model.setMessage("");
                          model.setContextId(newA2aId());
                          model.setTaskId("");
                        }}
                      >
                        测试调用
                      </Button>
                      <Button
                        theme="borderless"
                        onClick={() => {
                          model.setFilter(agent.id);
                          setPage(1);
                          setTab("calls");
                        }}
                      >
                        调用记录
                      </Button>
                    </footer>
                  </article>
                ))}
              </div>
            )}
            {!agents.isPending && !visibleAgents.length && (
              <div className={styles.empty}>
                <strong>
                  {search ? "没有匹配的 Agent" : "连接第一个 Agent"}
                </strong>
                <p>
                  {search
                    ? "试试其他名称或清空搜索。"
                    : "添加远程 A2A 服务或宿主 ACP 程序，然后为客户端生成接入配置。"}
                </p>
                <Button onClick={() => (search ? setSearch("") : edit())}>
                  {search ? "清空搜索" : "添加 Agent"}
                </Button>
              </div>
            )}
          </>
        )}
        {tab === "calls" && (
          <section className={styles.section} aria-label="调用记录">
            <div className={styles.toolbar}>
              <div>
                <strong>调用记录</strong>
                <p className={styles.muted}>
                  {model.showOperations
                    ? "包含任务查询与订阅等协议操作，最近 100 条。"
                    : "展示消息、取消和异常请求；成功的轮询查询默认隐藏。"}
                </p>
              </div>
              <div className={styles.actions}>
                <label className={styles.inlineLabel}>
                  <Switch
                    size="small"
                    checked={model.showOperations}
                    onChange={(value) => {
                      model.setShowOperations(value);
                      setPage(1);
                    }}
                  />
                  显示协议操作
                </label>
                <Select
                  showClear
                  aria-label="筛选 Agent"
                  placeholder="全部 Agent"
                  value={model.filter}
                  optionList={agents.data?.map((agent) => ({
                    value: agent.id,
                    label: agent.name,
                  }))}
                  onChange={(value) => {
                    model.setFilter(value as string | undefined);
                    setPage(1);
                  }}
                />
              </div>
            </div>
            <div className={styles.table}>
              <table>
                <thead>
                  <tr>
                    <th>时间 / Agent</th>
                    <th>操作 / 调用方</th>
                    <th>请求结果</th>
                    <th>任务最新状态</th>
                    <th>请求耗时</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows
                    .slice((currentPage - 1) * 12, currentPage * 12)
                    .map((call) => {
                      const outcome = callOutcome(call);
                      return (
                        <tr key={call.id}>
                          <td>
                            <span>{agentName(call.agentId)}</span>
                            <small>{time(call.startedAt)}</small>
                          </td>
                          <td>
                            <span title={call.method}>
                              {callMethodLabel(call.method)}
                            </span>
                            <small>
                              {call.keyId === "admin-test"
                                ? "管理台测试"
                                : call.keyId === "client-token"
                                  ? "Flowlet Client Token"
                                  : "旧调用密钥"}
                            </small>
                          </td>
                          <td>
                            <span
                              className={styles[outcome.tone]}
                              title={call.error ?? undefined}
                            >
                              {outcome.label}
                            </span>
                            <small>
                              {call.httpStatus !== null
                                ? `HTTP ${call.httpStatus}`
                                : "未收到 HTTP 响应"}
                            </small>
                          </td>
                          <td>
                            <span
                              title={
                                call.latestTaskObservedAt
                                  ? `观测于 ${time(call.latestTaskObservedAt)}`
                                  : undefined
                              }
                            >
                              {a2aStateLabel(
                                call.latestTaskState ?? call.state,
                              )}
                            </span>
                            {call.taskId && (
                              <small title={call.taskId}>
                                {call.taskId.slice(0, 14)}…
                              </small>
                            )}
                          </td>
                          <td className={styles.duration}>
                            {call.finishedAt === null
                              ? "—"
                              : call.durationMs < 1000
                                ? `${call.durationMs} ms`
                                : `${(call.durationMs / 1000).toFixed(1)} s`}
                          </td>
                          <td>
                            <Button
                              theme="borderless"
                              onClick={() => model.setCallDetail(call)}
                            >
                              详情
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
            {calls.isPending ? (
              <Spin />
            ) : (
              !rows.length && (
                <div className={styles.empty}>
                  <strong>暂无调用记录</strong>
                  <p>
                    消息发出后会显示在这里；可开启「显示协议操作」查看查询记录。
                  </p>
                </div>
              )
            )}
            <footer className={styles.listFooter}>
              <span className={styles.muted}>
                最近 {rows.length} 条 · 请求耗时不代表任务执行总时长
              </span>
              <Pagination
                size="small"
                total={rows.length}
                pageSize={12}
                currentPage={currentPage}
                onPageChange={setPage}
              />
            </footer>
          </section>
        )}
      </div>
      <A2aOverlays model={model} />
      <AgentGatewayAccess
        agent={accessAgent}
        origin={origin}
        onClose={() => setAccessAgent(null)}
      />
    </main>
  );
}
