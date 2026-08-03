import { Button, SideSheet, Tabs, Tag, Toast, Tooltip } from "@douyinfe/semi-ui-19";
import { IconAlertTriangle, IconCopy, IconExternalOpen, IconRefresh } from "@douyinfe/semi-icons";
import { useState, type ReactNode } from "react";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import type { AgentSessionInteractionEvent, AgentSessionLastInteraction, AgentSessionNativeSummary, AgentSessionNativeUsage, AgentSessionRow, OpenCodePermissionRequest } from "../../domains/agent-session/types";
import { useAgentSessionChildren, useAgentSessionLastInteraction, useAgentSessionNativeSummary, useOpenCodeSessionPermissions, useReplyOpenCodePermission } from "../../features/agent-sessions/useAgentSessions";
import { APP_OVERLAY_Z_INDEX } from "../../shared/ui/overlayLayers";
import { Markdown } from "../../shared/ui/Markdown";
import { formatCompactNumber, formatInteger } from "../../shared/formatters/number";
import { formatCostAmount, formatNativeCost } from "../../shared/formatters/cost";
import { formatFullTimestamp, formatTimestamp } from "../../shared/formatters/datetime";
import styles from "./AgentSessionDetailSideSheet.module.css";

export function AgentSessionDetailSideSheet({
  session,
  onClose,
  onViewRequestLogs,
  onRefreshOverview,
}: {
  session: AgentSessionRow;
  onClose: () => void;
  onViewRequestLogs: (sessionId: string) => void;
  onRefreshOverview?: () => Promise<unknown> | void;
}) {
  const { language, t } = useAppPreferences();
  const [activeTab, setActiveTab] = useState<"overview" | "usage" | "session" | "child-sessions">("overview");
  const [refreshing, setRefreshing] = useState(false);
  const title = sessionDisplayTitle(session);
  const children = useAgentSessionChildren(session);
  const nativeSummary = useAgentSessionNativeSummary(session);
  const lastInteraction = useAgentSessionLastInteraction(session, activeTab === "overview");
  const openCodePermissions = useOpenCodeSessionPermissions(session, activeTab === "overview");
  const pendingApprovalCount = session.agentType === "opencode" && openCodePermissions.data?.available
    ? openCodePermissions.data.permissions.length
    : 0;
  const nativeUsage = session.nativeSummary ?? nativeSummary.data;
  const overviewMetrics = overviewSessionMetrics(session, nativeUsage);
  const refreshActiveTab = async () => {
    setRefreshing(true);
    try {
      if (activeTab === "overview") {
        await Promise.all([
          lastInteraction.refetch(),
          children.refetch(),
          nativeSummary.refetch(),
          onRefreshOverview?.(),
        ]);
        return;
      }
      if (activeTab === "usage") {
        await Promise.all([nativeSummary.refetch(), children.refetch()]);
        return;
      }
      if (activeTab === "child-sessions") {
        await children.refetch();
        return;
      }
      await onRefreshOverview?.();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <SideSheet
      visible
      motion={false}
      width="min(760px, 96vw)"
      title={<SessionHeader session={session} language={language} />}
      onCancel={onClose}
      footer={null}
      bodyStyle={{ padding: 0 }}
      zIndex={APP_OVERLAY_Z_INDEX.sideSheet}
    >
      <Tabs
        className={styles.tabs}
        type="line"
        activeKey={activeTab}
        tabPaneMotion={false}
        onChange={(key) => setActiveTab(key as "overview" | "usage" | "session" | "child-sessions")}
        tabBarExtraContent={(
          <Button
            className={styles.tabRefresh}
            icon={<IconRefresh />}
            aria-label={t("刷新")}
            size="small"
            theme="borderless"
            loading={refreshing}
            onClick={() => void refreshActiveTab()}
          >
            {t("刷新")}
          </Button>
        )}
      >
        <Tabs.TabPane tab={t("概览")} itemKey="overview">
          <div className={styles.overview}>
            <OverviewStats metrics={overviewMetrics} language={language} />
            <div className={styles.sectionHeading}>
              <h3 className={styles.sectionLabel}>{t("最近一轮")}</h3>
            </div>
            <LastInteractionSection
              data={lastInteraction.data}
              loading={lastInteraction.isLoading}
              error={lastInteraction.isError ? lastInteraction.error.message : null}
              language={language}
              onRetry={() => void lastInteraction.refetch()}
              turnBlocked={pendingApprovalCount > 0}
              approvalSection={session.agentType === "opencode" ? (
                <OpenCodeApprovalSection session={session} permissions={openCodePermissions} />
              ) : null}
            />
          </div>
        </Tabs.TabPane>
        <Tabs.TabPane tab={t("用量")} itemKey="usage">
          <div className={styles.body}>
            <DetailSection title={t("Flowlet 请求统计")}>
              <div className={styles.metrics}>
                <Metric label={t("请求数")} value={session.flowletObserved ? formatCompactNumber(session.requestCount, language) : "—"} />
                <Metric label={t("成功")} value={session.flowletObserved ? formatCompactNumber(session.successCount, language) : "—"} />
                <Metric label={t("失败")} value={session.flowletObserved ? formatCompactNumber(session.errorCount, language) : "—"} warning={session.flowletObserved && session.errorCount > 0} />
                <Metric label="Token" value={session.flowletObserved ? formatCompactNumber(session.knownTokens, language) : "—"} />
                <Metric label={t("费用")} value={session.flowletObserved ? `¥${session.estimatedCost.toFixed(4)}` : "—"} />
              </div>
            </DetailSection>

            <NativeUsageSection
              agentType={session.agentType}
              data={nativeUsage}
              loading={nativeSummary.isLoading}
              error={nativeSummary.isError ? nativeSummary.error.message : null}
              language={language}
              onRetry={() => void nativeSummary.refetch()}
            />
          </div>
        </Tabs.TabPane>
        <Tabs.TabPane tab={t("会话")} itemKey="session">
          <div className={styles.body}>
            <DetailSection title={t("会话信息")}>
              <div className={styles.detailGrid}>
                <DetailItem label={t("会话标题")} value={title} wide />
                <DetailItem label={t("会话 ID")} value={session.sessionId} copyable wide onOpen={session.flowletObserved ? () => onViewRequestLogs(session.sessionId) : undefined} />
                {session.parentSessionId ? <DetailItem label={t("父会话 ID")} value={session.parentSessionId} copyable wide /> : null}
                <DetailItem
                  label={session.flowletObserved ? t("客户端") : t("Agent 来源")}
                  value={session.flowletObserved
                    ? session.clientName ?? session.clientId ?? t("未知客户端")
                    : agentLabel(session.agentType)}
                />
                <DetailItem label={t("项目目录")} value={session.projectPath ?? "—"} />
              </div>
            </DetailSection>

            <DetailSection title={t("活动时间")}>
              <div className={styles.detailGrid}>
                {session.flowletObserved ? <DetailItem label={t("Flowlet 首次观测")} value={formatDate(session.startedAt, language)} /> : null}
                {session.flowletObserved ? <DetailItem label={t("Flowlet 最近观测")} value={formatDate(session.updatedAt, language)} /> : null}
                {session.nativeStartedAt ? <DetailItem label={t("Agent 创建时间")} value={formatDate(session.nativeStartedAt, language)} /> : null}
                {session.nativeUpdatedAt ? <DetailItem label={t("Agent 更新时间")} value={formatDate(session.nativeUpdatedAt, language)} /> : null}
              </div>
            </DetailSection>
          </div>
        </Tabs.TabPane>
        {children.data && children.data.length > 0 ? (
          <Tabs.TabPane tab={t("子会话（{count}）", { count: children.data.length })} itemKey="child-sessions">
            <div className={styles.body}>
              <ChildSessionsSection
                rows={children.data ?? []}
                loading={children.isLoading}
                error={children.isError ? children.error.message : null}
                language={language}
                onRetry={() => void children.refetch()}
                onViewRequestLogs={onViewRequestLogs}
              />
            </div>
          </Tabs.TabPane>
        ) : null}
      </Tabs>
    </SideSheet>
  );
}

function LastInteractionSection({
  data,
  loading,
  error,
  language,
  onRetry,
  turnBlocked = false,
  approvalSection = null,
}: {
  data: AgentSessionLastInteraction | null | undefined;
  loading: boolean;
  error: string | null;
  language: "zh-CN" | "en-US";
  onRetry: () => void;
  turnBlocked?: boolean;
  approvalSection?: ReactNode;
}) {
  const { t } = useAppPreferences();
  const turnEvent = data?.events.find((event) => event.kind === "turn") ?? null;
  const events = data?.events.filter((event) => event.kind !== "turn") ?? [];
  const userEventIndex = events.findIndex((event) => event.kind === "user-message");
  const userEvent = userEventIndex >= 0 ? events[userEventIndex] : null;
  const outputEvents = userEventIndex >= 0 ? events.slice(userEventIndex + 1) : events;
  const outputItems = groupInteractionEvents(outputEvents);
  const hasAssistantMessage = outputEvents.some((event) => event.kind === "assistant-message");
  return (
    <div className={styles.lastInteractionContent}>
      {loading ? <div className={styles.interactionLoading}><span /><span /><span /></div> : null}
      {error ? (
        <div className={styles.childError}>
          <span>{t("最近一轮加载失败：{message}", { message: error })}</span>
          <Button size="small" onClick={onRetry}>{t("重试")}</Button>
        </div>
      ) : null}
      {!loading && !error && events.length === 0 ? (
        <>
          <div className={styles.emptyState}>{t("未找到可读取的最近一轮")}</div>
          {approvalSection}
        </>
      ) : null}
      {!loading && !error && events.length > 0 ? (
        <div className={styles.interactionFlow} aria-label={t("最近一轮")}>
          {userEvent ? (
            <article className={styles.userMessageRow} aria-label={t("用户消息")}>
              {userEvent.content ? <pre className={styles.userMessageBubble}>{userEvent.content}</pre> : null}
            </article>
          ) : null}
          {outputItems.length > 0 ? (
            <div className={styles.outputStream}>
              {outputItems.map((item) => item.kind === "event" ? (
                <InteractionOutputEvent key={item.event.id} event={item.event} language={language} />
              ) : (
                <InteractionProcessGroup key={item.id} events={item.events} language={language} />
              ))}
            </div>
          ) : null}
          {approvalSection}
          {turnEvent?.status === "running" && !turnBlocked ? (
            <div className={styles.interactionProgress} role="status"><i />{t("正在处理")}</div>
          ) : null}
          {turnEvent?.status === "cancelled" && !hasAssistantMessage ? (
            <div className={styles.interactionNotice}>{t("本轮已中断，未生成回复")}</div>
          ) : null}
          {turnEvent?.status === "completed" && !hasAssistantMessage ? (
            <div className={styles.interactionNotice}>{t("本轮未生成可展示的回复")}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

type InteractionDisplayItem =
  | { kind: "event"; event: AgentSessionInteractionEvent }
  | { kind: "process"; id: string; events: AgentSessionInteractionEvent[] };

export function groupInteractionEvents(events: AgentSessionInteractionEvent[]): InteractionDisplayItem[] {
  const items: InteractionDisplayItem[] = [];
  let processEvents: AgentSessionInteractionEvent[] = [];
  const flushProcess = () => {
    if (processEvents.length === 0) return;
    items.push({ kind: "process", id: `process:${processEvents[0].id}`, events: processEvents });
    processEvents = [];
  };
  for (const event of events) {
    if (isProcessEvent(event)) {
      processEvents.push(event);
    } else {
      flushProcess();
      items.push({ kind: "event", event });
    }
  }
  flushProcess();
  return items;
}

function isProcessEvent(event: AgentSessionInteractionEvent) {
  return matchesInteractionKind(event.kind, ["reasoning", "tool-call", "tool-result"]);
}

function matchesInteractionKind(
  kind: AgentSessionInteractionEvent["kind"],
  candidates: AgentSessionInteractionEvent["kind"][],
) {
  return candidates.includes(kind);
}

function OpenCodeApprovalSection({ session, permissions }: { session: AgentSessionRow; permissions: ReturnType<typeof useOpenCodeSessionPermissions> }) {
  const { t } = useAppPreferences();
  const reply = useReplyOpenCodePermission(session);
  if (session.agentType !== "opencode") return null;
  if (permissions.isLoading) {
    return <div className={styles.approvalNotice}>{t("正在检查 OpenCode 待确认操作")}</div>;
  }
  if (permissions.isError) {
    return <div className={styles.approvalNotice}>{t("OpenCode 待确认操作读取失败：{message}", { message: permissions.error.message })}</div>;
  }
  if (!permissions.data?.available) {
    return (
      <div className={styles.approvalNotice}>
        <strong>{t("OpenCode 控制服务未连接")}</strong>
        <span>{t("请重新应用 OpenCode 全局接入配置并重启 OpenCode；之后可在这里同意或否决待确认操作。")}</span>
      </div>
    );
  }
  if (permissions.data.permissions.length === 0) return null;

  const decide = async (request: OpenCodePermissionRequest, decision: "allow_once" | "reject") => {
    try {
      await reply.mutateAsync({ permissionId: request.id, decision });
      Toast.success(decision === "allow_once" ? t("已同意 OpenCode 本次操作") : t("已否决 OpenCode 操作"));
    } catch (error) {
      Toast.error(t("OpenCode 操作提交失败：{message}", { message: error instanceof Error ? error.message : String(error) }));
    }
  };

  return (
    <div className={styles.approvalList}>
      {permissions.data.permissions.map((request) => {
        const submitting = reply.isPending && reply.variables?.permissionId === request.id;
        return (
          <article className={styles.approvalCard} key={request.id}>
            <div className={styles.approvalHeader}>
              <IconAlertTriangle className={styles.approvalIcon} />
              <strong>{t("OpenCode 等待确认")}</strong>
              <code>{request.permission}</code>
              <div className={styles.approvalActions}>
                <Button size="small" type="danger" theme="borderless" loading={submitting && reply.variables?.decision === "reject"} disabled={reply.isPending && !submitting} onClick={() => void decide(request, "reject")}>{t("否决")}</Button>
                <Button size="small" type="primary" theme="solid" loading={submitting && reply.variables?.decision === "allow_once"} disabled={reply.isPending && !submitting} onClick={() => void decide(request, "allow_once")}>{t("同意本次")}</Button>
              </div>
            </div>
            {request.patterns.length > 0 ? <pre>{request.patterns.join("\n")}</pre> : null}
          </article>
        );
      })}
    </div>
  );
}

function NativeUsageSection({
  agentType,
  data,
  loading,
  error,
  language,
  onRetry,
}: {
  agentType: AgentSessionRow["agentType"];
  data: AgentSessionNativeSummary | undefined;
  loading: boolean;
  error: string | null;
  language: "zh-CN" | "en-US";
  onRetry: () => void;
}) {
  const { t } = useAppPreferences();
  return (
    <DetailSection title={t("Agent 原生用量")}>
      <p className={styles.usageHint}>{agentType === "codex-desktop" || agentType === "codex-cli" ? t("优先展示官方 API 原币估值，并单独展示 Codex 套餐消耗；两者不换汇、不相加") : t("来自 Agent 本地记录，与 Flowlet 请求统计独立，不参与相加")}</p>
      {!loading && !error && data?.sourceAvailable === false ? <p className={styles.usageHint}>{t("源文件已删除，以下为 Flowlet 最后一次同步保存的数据")}</p> : null}
      {loading ? <div className={styles.nativeUsageLoading} aria-label={t("正在读取 Agent 原生用量")} /> : null}
      {error ? (
        <div className={styles.childError}>
          <span>{t("Agent 原生用量加载失败：{message}", { message: error })}</span>
          <Button size="small" onClick={onRetry}>{t("重试")}</Button>
        </div>
      ) : null}
      {!loading && !error && !data?.usage ? (
        <div className={styles.emptyState}>{t("Agent 原生数据未提供 Token 用量")}</div>
      ) : null}
      {!loading && !error && data?.usage ? (
        <>
          <div className={`${styles.metrics} ${styles.nativeMetrics}`}>
            <Metric label={t("总 Token")} value={formatCompactNumber(data.usage.totalTokens, language)} />
            <Metric label={t("输入")} value={formatCompactNumber(data.usage.inputTokens, language)} />
            <Metric label={t("输出")} value={formatCompactNumber(data.usage.outputTokens, language)} />
            <Metric label={t("缓存读取")} value={formatCompactNumber(data.usage.cachedInputTokens, language)} />
            <Metric label={t("缓存命中率")} value={formatCacheHitRate(data.usage, language)} />
            <Metric label={t("缓存写入")} value={formatCompactNumber(data.usage.cacheWriteInputTokens, language)} />
            <Metric label={t("推理")} value={formatCompactNumber(data.usage.reasoningTokens, language)} />
            <Metric label={t("API 等价价值")} value={data.usage.apiEquivalent ? formatCostAmount(data.usage.apiEquivalent, 4) : "—"} />
            <Metric label={t("套餐消耗")} value={data.usage.planConsumption ? formatCostAmount(data.usage.planConsumption, 4) : "—"} />
            {data.usage.cost != null ? <Metric label={t("原生实际费用")} value={formatNativeCost(data.usage)} /> : null}
          </div>
          {(data.models ?? []).length > 0 ? <p className={styles.usageModels}>{t("模型：{models}", { models: data.models.join("、") })}</p> : null}
          {data.usage.apiEquivalent ? <EstimateMeta label={t("API 价格")} estimate={data.usage.apiEquivalent} /> : null}
          {data.usage.planConsumption ? <EstimateMeta label={t("套餐价格")} estimate={data.usage.planConsumption} /> : null}
        </>
      ) : null}
    </DetailSection>
  );
}

function InteractionProcessGroup({
  events,
  language,
}: {
  events: AgentSessionInteractionEvent[];
  language: "zh-CN" | "en-US";
}) {
  const { t } = useAppPreferences();
  const toolCalls = events.filter((event) => event.kind === "tool-call").length;
  const reasoning = events.filter((event) => event.kind === "reasoning").length;
  return (
    <details className={styles.processGroup}>
      <summary className={styles.processGroupHeader}>
        <span>{t("已处理 {count} 项", { count: events.length })}</span>
        <small>
          {[
            reasoning > 0 ? t("{count} 项思考", { count: reasoning }) : null,
            toolCalls > 0 ? t("{count} 次工具调用", { count: toolCalls }) : null,
          ].filter(Boolean).join(" · ")}
        </small>
      </summary>
      <div className={styles.processGroupBody}>
        {events.map((event) => (
          <ProcessEvent key={event.id} event={event} language={language} />
        ))}
      </div>
    </details>
  );
}

function ProcessEvent({ event, language }: { event: AgentSessionInteractionEvent; language: "zh-CN" | "en-US" }) {
  const { t } = useAppPreferences();
  const label = interactionEventLabel(event.kind, t);
  return (
    <article className={styles.processEvent}>
      <header>
        <span>{label}</span>
        <strong>{event.title ?? event.model ?? label}</strong>
        {event.timestamp ? <time>{formatTimestamp(event.timestamp, language)}</time> : null}
      </header>
      {event.content ? <ToolEventContent event={event} /> : null}
      <InteractionEventStatus event={event} language={language} />
      {event.usage ? <InteractionEventUsage usage={event.usage} language={language} /> : null}
    </article>
  );
}

function ToolEventContent({ event }: { event: AgentSessionInteractionEvent }) {
  const { t } = useAppPreferences();
  const parsed = parseToolPayload(event.content ?? "");
  const fallbackLabel = event.kind === "tool-result"
    ? t("执行结果")
    : toolInputLabel(event.title, t);
  if (!parsed) {
    return (
      <div className={styles.toolPayload}>
        <span>{fallbackLabel}</span>
        <pre>{event.content}</pre>
      </div>
    );
  }
  return (
    <div className={styles.toolPayloadList}>
      {parsed.map(({ key, value }) => (
        <div className={styles.toolPayload} key={key}>
          <span>{toolFieldLabel(key, fallbackLabel, t)}</span>
          <pre>{value}</pre>
        </div>
      ))}
    </div>
  );
}

function parseToolPayload(content: string): Array<{ key: string; value: string }> | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") return null;
    return Object.entries(parsed).map(([key, value]) => ({
      key,
      value: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    }));
  } catch {
    return null;
  }
}

function toolInputLabel(title: string | null, t: (key: string) => string) {
  if (title === "exec") return t("执行脚本");
  if (title === "exec_command" || title === "shell" || title === "bash") return t("命令");
  if (title === "apply_patch") return t("补丁内容");
  return t("调用参数");
}

function toolFieldLabel(key: string, fallback: string, t: (key: string) => string) {
  if (key === "cmd" || key === "command") return t("命令");
  if (key === "output") return t("输出");
  if (key === "workdir" || key === "cwd") return t("工作目录");
  if (key === "exit_code" || key === "exitCode") return t("退出码");
  if (key === "status") return t("状态");
  if (key === "input" || key === "arguments") return fallback;
  return key;
}

function InteractionOutputEvent({
  event,
  language,
}: {
  event: AgentSessionInteractionEvent;
  language: "zh-CN" | "en-US";
}) {
  const { t } = useAppPreferences();
  if (event.kind === "assistant-message") {
    return (
      <article
        className={styles.outputMessage}
        aria-label={t("助手回复")}
      >
        {event.content ? <Markdown content={event.content} /> : null}
        {event.usage ? <InteractionEventUsage usage={event.usage} language={language} /> : null}
      </article>
    );
  }

  if (event.kind === "error") {
    return (
      <article
        className={`${styles.outputMessage} ${styles.assistantError}`}
        aria-label={t("错误")}
      >
        {event.content ? <pre className={styles.errorContent}>{event.content}</pre> : null}
        {event.usage ? <InteractionEventUsage usage={event.usage} language={language} /> : null}
      </article>
    );
  }

  return null;
}

function InteractionEventStatus({ event, language }: { event: AgentSessionInteractionEvent; language: "zh-CN" | "en-US" }) {
  const { t } = useAppPreferences();
  if (!event.status && event.durationMs == null && event.timeToFirstTokenMs == null) return null;
  return (
    <small className={styles.interactionStatus}>
      {[
        event.status ? t("状态：{status}", { status: interactionStatusLabel(event.status, t) }) : null,
        event.durationMs != null ? t("耗时 {duration}", { duration: formatDuration(event.durationMs, language) }) : null,
        event.timeToFirstTokenMs != null ? t("首 Token {duration}", { duration: formatDuration(event.timeToFirstTokenMs, language) }) : null,
      ].filter(Boolean).join(" · ")}
    </small>
  );
}

function InteractionEventUsage({ usage, language }: { usage: AgentSessionNativeUsage; language: "zh-CN" | "en-US" }) {
  const { t } = useAppPreferences();
  const items = [
    [t("总计"), usage.totalTokens],
    [t("输入"), usage.inputTokens],
    [t("输出"), usage.outputTokens],
    [t("缓存读取"), usage.cachedInputTokens],
    [t("缓存写入"), usage.cacheWriteInputTokens],
    [t("推理"), usage.reasoningTokens],
  ] as const;
  return (
    <div className={styles.eventUsage} aria-label={t("单次原生用量")}>
      {items.filter(([, value], index) => index === 0 || value > 0).map(([label, value]) => (
        <span key={label}>{label} {formatCompactNumber(value, language)}</span>
      ))}
      {usage.inputTokens > 0 ? <span>{t("缓存命中率")} {formatCacheHitRate(usage, language)}</span> : null}
      {usage.apiEquivalent?.amount != null ? <span>{t("API 等价")} {formatCostAmount(usage.apiEquivalent, 4)}</span> : null}
      {usage.planConsumption?.amount != null ? <span>{t("套餐消耗")} {formatCostAmount(usage.planConsumption, 4)}</span> : null}
      {usage.cost != null ? <span>{t("原生实际费用")} {formatNativeCost(usage)}</span> : null}
    </div>
  );
}

function interactionEventLabel(kind: AgentSessionInteractionEvent["kind"], t: (key: string, params?: Record<string, string | number>) => string) {
  if (kind === "turn") return t("Agent 轮次");
  if (kind === "user-message") return t("用户消息");
  if (kind === "assistant-message") return t("助手回复");
  if (kind === "reasoning") return t("思考摘要");
  if (kind === "tool-call") return t("工具调用");
  if (kind === "tool-result") return t("工具结果");
  return t("错误");
}

function interactionStatusLabel(status: string, t: (key: string) => string) {
  if (status === "running") return t("运行中");
  if (status === "completed") return t("已完成");
  if (status === "cancelled") return t("已取消");
  return status;
}

function EstimateMeta({ label, estimate }: { label: string; estimate: NonNullable<AgentSessionNativeUsage["apiEquivalent"]> }) {
  const { t } = useAppPreferences();
  const total = estimate.pricedTurnCount + estimate.unpricedTurnCount;
  return <p className={styles.usageModels} title={estimate.sourceUrl ?? undefined}>{t("{label}：原币计价 · 价格核验 {version} · 已计价 {priced}/{total} 轮", { label, version: estimate.priceVersion ?? "—", priced: estimate.pricedTurnCount, total })}</p>;
}

function formatCacheHitRate(usage: AgentSessionNativeUsage, language: "zh-CN" | "en-US") {
  // input_tokens 在各 Agent 原生数据中均为「未缓存输入」，总输入需加上缓存命中和缓存写入。
  const totalInput = usage.inputTokens + usage.cachedInputTokens + usage.cacheWriteInputTokens;
  if (totalInput <= 0) return "—";
  return new Intl.NumberFormat(language, { style: "percent", maximumFractionDigits: 1 }).format(usage.cachedInputTokens / totalInput);
}

function formatDuration(milliseconds: number, language: "zh-CN" | "en-US") {
  if (milliseconds < 1_000) return `${milliseconds} ms`;
  const seconds = milliseconds / 1_000;
  if (seconds < 60) return `${new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(seconds)} s`;
  return `${new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(seconds / 60)} min`;
}

function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return <section className={styles.section}><strong className={styles.sectionTitle}>{title}</strong>{children}</section>;
}

function DetailItem({
  label,
  value,
  wide = false,
  copyable = false,
  onOpen,
}: {
  label: string;
  value: string;
  wide?: boolean;
  copyable?: boolean;
  onOpen?: () => void;
}) {
  const { t } = useAppPreferences();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      Toast.success(t("{label} 已复制", { label }));
    } catch {
      Toast.error(t("复制失败，请手动选择内容"));
    }
  };
  return (
    <div className={`${styles.detailItem} ${wide ? styles.wide : ""}`}>
      <span>{label}</span>
      <div>
        {onOpen ? (
          <Tooltip content={t("查看请求日志明细")}>
            <Button
              className={styles.valueLink}
              aria-label={t("查看会话 {id} 的请求日志明细", { id: value })}
              type="primary"
              theme="borderless"
              size="small"
              onClick={onOpen}
            >
              <span className={styles.linkText} title={value}>{value}</span>
              <IconExternalOpen />
            </Button>
          </Tooltip>
        ) : <strong title={value}>{value}</strong>}
        {copyable ? <Button aria-label={t("复制{label}", { label })} icon={<IconCopy />} theme="borderless" size="small" onClick={() => void copy()} /> : null}
      </div>
    </div>
  );
}

function Metric({ label, value, warning = false }: { label: string; value: string; warning?: boolean }) {
  return <div className={warning ? styles.metricWarning : ""}><span>{label}</span><strong>{value}</strong></div>;
}

function ChildSessionsSection({
  rows,
  loading,
  error,
  language,
  onRetry,
  onViewRequestLogs,
}: {
  rows: AgentSessionRow[];
  loading: boolean;
  error: string | null;
  language: "zh-CN" | "en-US";
  onRetry: () => void;
  onViewRequestLogs: (sessionId: string) => void;
}) {
  const { t } = useAppPreferences();
  if (!loading && !error && rows.length === 0) return null;

  return (
    <DetailSection title={t("子会话（{count}）", { count: rows.length })}>
      {loading ? (
        <div className={styles.childLoading} aria-label={t("正在读取子会话")}>
          <span /><span />
        </div>
      ) : null}
      {error ? (
        <div className={styles.childError}>
          <span>{t("子会话加载失败：{message}", { message: error })}</span>
          <Button size="small" onClick={onRetry}>{t("重试")}</Button>
        </div>
      ) : null}
      {!loading && !error ? (
        <div className={styles.childList}>
          {rows.map((row) => (
            <article className={styles.childRow} key={`${row.agentType}:${row.sessionId}`}>
              <div className={styles.childIdentity}>
                <strong title={row.title ?? row.sessionId}>{sessionDisplayTitle(row)}</strong>
                <small title={row.sessionId}>{row.sessionId}</small>
              </div>
              <div className={styles.childMeta}>
                <span>{formatTimestamp(row.activityAt, language)}</span>
                <small>{row.flowletObserved ? t("{requests} 次请求 · {tokens} Token · ¥{cost}", {
                  requests: formatCompactNumber(row.requestCount, language),
                  tokens: formatCompactNumber(row.knownTokens, language),
                  cost: row.estimatedCost.toFixed(4),
                }) : t("未经过 Flowlet，暂无请求指标")}</small>
              </div>
              <div className={styles.childActions}>
                {row.flowletObserved ? (
                  <>
                    <Tag size="small" color={row.errorCount > 0 ? "red" : "green"}>
                      {row.errorCount > 0 ? t("{count} 次失败", { count: row.errorCount }) : t("正常")}
                    </Tag>
                    <Tooltip content={t("查看请求日志明细")}>
                      <Button
                        aria-label={t("查看会话 {id} 的请求日志明细", { id: row.sessionId })}
                        icon={<IconExternalOpen />}
                        theme="borderless"
                        size="small"
                        onClick={() => onViewRequestLogs(row.sessionId)}
                      />
                    </Tooltip>
                  </>
                ) : <Tag size="small">{t("本地会话")}</Tag>}
              </div>
            </article>
          ))}
        </div>
      ) : null}
    </DetailSection>
  );
}

export function sessionDisplayTitle(session: AgentSessionRow) {
  return session.title?.trim() || projectName(session.projectPath) || session.sessionId;
}

function projectName(path: string | null) {
  if (!path) return null;
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || null;
}

function agentLabel(agentType: AgentSessionRow["agentType"]) {
  if (agentType === "claude-code") return "Claude Code";
  if (agentType === "codex-desktop") return "ChatGPT (Codex)";
  if (agentType === "codex-cli") return "Codex CLI";
  if (agentType === "pi") return "Pi";
  return "OpenCode";
}

function formatDate(value: string, language: "zh-CN" | "en-US") {
  const iso = value.includes("T") || value.endsWith("Z") ? value : `${value.replace(" ", "T")}Z`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(language, {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
}

type OverviewSessionMetrics =
  | { source: "flowlet"; tokens: number; count: number; failures: number; truncated: false }
  | { source: "agent-native"; tokens: number | null; count: number | null; failures: null; truncated: boolean };

/** 概览统计行双源归一：Flowlet 观测走请求数/失败数，Agent 原生走轮次与截断标记。 */
function overviewSessionMetrics(
  session: AgentSessionRow,
  nativeSummary: AgentSessionNativeSummary | undefined,
): OverviewSessionMetrics {
  if (session.flowletObserved) {
    return {
      source: "flowlet",
      tokens: session.knownTokens,
      count: session.requestCount,
      failures: session.errorCount,
      truncated: false,
    };
  }
  return {
    source: "agent-native",
    tokens: nativeSummary?.usage?.totalTokens ?? null,
    count: nativeSummary?.turnCount ?? null,
    failures: null,
    truncated: nativeSummary?.truncated ?? false,
  };
}

function runtimeLabel(status: AgentSessionRow["runtimeStatus"], t: (key: string, params?: Record<string, string | number>) => string) {
  if (status === "running") return t("自动运行中");
  if (status === "waiting_user") return t("等待用户确认");
  if (status === "idle") return t("空闲");
  return t("状态未知");
}

function SessionHeader({ session, language }: { session: AgentSessionRow; language: "zh-CN" | "en-US" }) {
  const { t } = useAppPreferences();
  const title = sessionDisplayTitle(session);
  return (
    <div className={styles.sessionHeader}>
      <div className={styles.sessionHeaderTopline}>
        <span className={styles.agentBadge}>{agentLabel(session.agentType)}</span>
        <strong className={styles.sessionTitle} title={title}>{title}</strong>
      </div>
      <div className={styles.meta}>
        <span className={styles.state} data-state={session.runtimeStatus}><i />{runtimeLabel(session.runtimeStatus, t)}</span>
        {!session.flowletObserved && session.nativeSummary?.sourceAvailable === false ? <Tag size="small" color="grey">{t("源文件已删除")}</Tag> : null}
        <span>{t("最近活跃：{time}", { time: formatFullTimestamp(session.activityAt, language) })}</span>
      </div>
    </div>
  );
}

function OverviewStats({ metrics, language }: { metrics: OverviewSessionMetrics; language: "zh-CN" | "en-US" }) {
  const { t } = useAppPreferences();
  return (
    <div className={styles.stats}>
      <div className={styles.stat}>
        <span>Tokens</span>
        <strong>{metrics.truncated ? "≥" : ""}{metrics.tokens == null ? "—" : formatCompactNumber(metrics.tokens, language)}</strong>
      </div>
      <div className={styles.stat}>
        <span>{metrics.source === "agent-native" ? t("原生轮次") : t("请求数")}</span>
        <strong>{metrics.count == null ? "—" : formatInteger(metrics.count, language)}</strong>
      </div>
      <div className={styles.stat} data-error={metrics.failures != null && metrics.failures > 0 || undefined}>
        <span>{metrics.source === "agent-native" ? t("来源") : t("失败")}</span>
        <strong>{metrics.source === "agent-native" ? t("Agent 原生") : formatInteger(metrics.failures ?? 0, language)}</strong>
      </div>
    </div>
  );
}
