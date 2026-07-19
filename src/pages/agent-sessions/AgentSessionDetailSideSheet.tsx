import { Button, SideSheet, Tabs, Tag, Toast, Tooltip } from "@douyinfe/semi-ui-19";
import { IconCopy, IconExternalOpen } from "@douyinfe/semi-icons";
import { useState, type ReactNode } from "react";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import type { AgentSessionNativeUsage, AgentSessionRow, AgentSessionTimeline, AgentSessionTimelineEvent } from "../../domains/agent-session/types";
import { useAgentSessionChildren, useAgentSessionTimeline } from "../../features/agent-sessions/useAgentSessions";
import { APP_OVERLAY_Z_INDEX } from "../../shared/ui/overlayLayers";
import { formatCompactNumber } from "../../shared/formatters/number";
import { formatCostAmount, formatNativeCost } from "../../shared/formatters/cost";
import styles from "./AgentSessionDetailSideSheet.module.css";

export function AgentSessionDetailSideSheet({
  session,
  onClose,
  onViewRequestLogs,
}: {
  session: AgentSessionRow;
  onClose: () => void;
  onViewRequestLogs: (sessionId: string) => void;
}) {
  const { language, t } = useAppPreferences();
  const [activeTab, setActiveTab] = useState<"overview" | "timeline">("overview");
  const title = sessionDisplayTitle(session);
  const children = useAgentSessionChildren(session);
  const timeline = useAgentSessionTimeline(session);

  return (
    <SideSheet
      visible
      motion={false}
      width="min(760px, 96vw)"
      title={<div className={styles.title}><strong>{title}</strong><span>{agentLabel(session.agentType)} · {t("会话详情")}</span></div>}
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
        onChange={(key) => setActiveTab(key as "overview" | "timeline")}
      >
        <Tabs.TabPane tab={t("概览")} itemKey="overview">
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
              data={timeline.data}
              loading={timeline.isLoading}
              error={timeline.isError ? timeline.error.message : null}
              language={language}
              onRetry={() => void timeline.refetch()}
            />

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
        <Tabs.TabPane tab={t("时间线")} itemKey="timeline">
          <div className={styles.body}>
            <TimelineSection
              data={timeline.data}
              loading={timeline.isLoading}
              fetching={timeline.isFetching}
              error={timeline.isError ? timeline.error.message : null}
              language={language}
              onRetry={() => void timeline.refetch()}
            />
          </div>
        </Tabs.TabPane>
      </Tabs>
    </SideSheet>
  );
}

function TimelineSection({
  data,
  loading,
  fetching,
  error,
  language,
  onRetry,
}: {
  data: AgentSessionTimeline | undefined;
  loading: boolean;
  fetching: boolean;
  error: string | null;
  language: "zh-CN" | "en-US";
  onRetry: () => void;
}) {
  const { t } = useAppPreferences();
  return (
    <section className={styles.section}>
      <div className={styles.timelineHeader}>
        <div>
          <strong className={styles.sectionTitle}>{t("原生会话时间线")}</strong>
          <span>{t("打开详情时从 Agent 本地数据按需只读，不写入 Flowlet 数据库")}</span>
        </div>
        <Button size="small" theme="borderless" loading={fetching && !loading} onClick={onRetry}>{t("刷新")}</Button>
      </div>
      {loading ? <div className={styles.timelineLoading}><span /><span /><span /></div> : null}
      {error ? (
        <div className={styles.childError}>
          <span>{t("原生会话时间线加载失败：{message}", { message: error })}</span>
          <Button size="small" onClick={onRetry}>{t("重试")}</Button>
        </div>
      ) : null}
      {!loading && !error && data && !data.sourceAvailable ? (
        <div className={styles.timelineEmpty}>{t("未找到可读取的原生会话数据")}</div>
      ) : null}
      {!loading && !error && data?.sourceAvailable && data.events.length === 0 ? (
        <div className={styles.timelineEmpty}>{t("该原生会话暂无可展示的消息或工具事件")}</div>
      ) : null}
      {!loading && !error && data && data.events.length > 0 ? (
        <>
          {data.truncated ? <div className={styles.timelineNotice}>{t("会话内容较多，当前仅展示前 {count} 个事件", { count: data.events.length })}</div> : null}
          <div className={styles.timelineList}>
            {data.events.map((event) => <TimelineEventCard key={event.id} event={event} language={language} />)}
          </div>
        </>
      ) : null}
    </section>
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
  data: AgentSessionTimeline | undefined;
  loading: boolean;
  error: string | null;
  language: "zh-CN" | "en-US";
  onRetry: () => void;
}) {
  const { t } = useAppPreferences();
  return (
    <DetailSection title={t("Agent 原生用量")}>
      <p className={styles.usageHint}>{agentType === "codex-desktop" || agentType === "codex-cli" ? t("优先展示官方 API 原币估值，并单独展示 Codex 套餐消耗；两者不换汇、不相加") : t("来自 Agent 本地记录，与 Flowlet 请求统计独立，不参与相加")}</p>
      {loading ? <div className={styles.nativeUsageLoading} aria-label={t("正在读取 Agent 原生用量")} /> : null}
      {error ? (
        <div className={styles.childError}>
          <span>{t("Agent 原生用量加载失败：{message}", { message: error })}</span>
          <Button size="small" onClick={onRetry}>{t("重试")}</Button>
        </div>
      ) : null}
      {!loading && !error && (!data?.sourceAvailable || !data.usage) ? (
        <div className={styles.timelineEmpty}>{t("Agent 原生数据未提供 Token 用量")}</div>
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
            <Metric label={t("API 等价价值")} value={data.usage.apiEquivalent ? formatCostAmount(data.usage.apiEquivalent) : "—"} />
            <Metric label={t("套餐消耗")} value={data.usage.planConsumption ? formatCostAmount(data.usage.planConsumption) : "—"} />
            {data.usage.cost != null ? <Metric label={t("原生实际费用")} value={formatNativeCost(data.usage)} /> : null}
          </div>
          {data.models.length > 0 ? <p className={styles.usageModels}>{t("模型：{models}", { models: data.models.join("、") })}</p> : null}
          {data.usage.apiEquivalent ? <EstimateMeta label={t("API 价格")} estimate={data.usage.apiEquivalent} /> : null}
          {data.usage.planConsumption ? <EstimateMeta label={t("套餐价格")} estimate={data.usage.planConsumption} /> : null}
        </>
      ) : null}
    </DetailSection>
  );
}

function TimelineEventCard({ event, language }: { event: AgentSessionTimelineEvent; language: "zh-CN" | "en-US" }) {
  const { t } = useAppPreferences();
  const label = timelineEventLabel(event.kind, t);
  const expanded = event.kind === "user-message" || event.kind === "assistant-message" || event.kind === "error";
  return (
    <article className={`${styles.timelineEvent} ${styles[`timeline-${event.kind}`] ?? ""}`}>
      <div className={styles.timelineEventHeader}>
        <span>{label} · {t("Agent 原生")}</span>
        <strong>{event.title ?? event.model ?? label}</strong>
        {event.timestamp ? <time>{formatShortDate(event.timestamp, language)}</time> : null}
      </div>
      {event.content ? (
        <details open={expanded}>
          <summary>{expanded ? t("内容") : t("查看内容")}</summary>
          <pre>{event.content}</pre>
        </details>
      ) : null}
      {event.status || event.durationMs != null || event.timeToFirstTokenMs != null ? (
        <small className={styles.timelineStatus}>
          {[
            event.status ? t("状态：{status}", { status: timelineStatusLabel(event.status, t) }) : null,
            event.durationMs != null ? t("耗时 {duration}", { duration: formatDuration(event.durationMs, language) }) : null,
            event.timeToFirstTokenMs != null ? t("首 Token {duration}", { duration: formatDuration(event.timeToFirstTokenMs, language) }) : null,
          ].filter(Boolean).join(" · ")}
        </small>
      ) : null}
      {event.usage ? <EventUsage usage={event.usage} language={language} /> : null}
    </article>
  );
}

function EventUsage({ usage, language }: { usage: AgentSessionNativeUsage; language: "zh-CN" | "en-US" }) {
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
      {usage.apiEquivalent?.amount != null ? <span>{t("API 等价")} {formatCostAmount(usage.apiEquivalent)}</span> : null}
      {usage.planConsumption?.amount != null ? <span>{t("套餐消耗")} {formatCostAmount(usage.planConsumption)}</span> : null}
      {usage.cost != null ? <span>{t("原生实际费用")} {formatNativeCost(usage)}</span> : null}
    </div>
  );
}

function EstimateMeta({ label, estimate }: { label: string; estimate: NonNullable<AgentSessionNativeUsage["apiEquivalent"]> }) {
  const { t } = useAppPreferences();
  const total = estimate.pricedTurnCount + estimate.unpricedTurnCount;
  return <p className={styles.usageModels} title={estimate.sourceUrl ?? undefined}>{t("{label}：原币计价 · 价格核验 {version} · 已计价 {priced}/{total} 轮", { label, version: estimate.priceVersion ?? "—", priced: estimate.pricedTurnCount, total })}</p>;
}

function timelineEventLabel(kind: AgentSessionTimelineEvent["kind"], t: (key: string, params?: Record<string, string | number>) => string) {
  if (kind === "turn") return t("Agent 轮次");
  if (kind === "user-message") return t("用户消息");
  if (kind === "assistant-message") return t("助手回复");
  if (kind === "reasoning") return t("思考摘要");
  if (kind === "tool-call") return t("工具调用");
  if (kind === "tool-result") return t("工具结果");
  return t("错误");
}

function timelineStatusLabel(status: string, t: (key: string) => string) {
  if (status === "running") return t("运行中");
  if (status === "completed") return t("已完成");
  if (status === "cancelled") return t("已取消");
  return status;
}

function formatCacheHitRate(usage: AgentSessionNativeUsage, language: "zh-CN" | "en-US") {
  if (usage.inputTokens <= 0) return "—";
  return new Intl.NumberFormat(language, { style: "percent", maximumFractionDigits: 1 }).format(usage.cachedInputTokens / usage.inputTokens);
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
                <span>{formatShortDate(row.activityAt, language)}</span>
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
  return "OpenCode";
}

function formatDate(value: string, language: "zh-CN" | "en-US") {
  const iso = value.includes("T") || value.endsWith("Z") ? value : `${value.replace(" ", "T")}Z`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(language, {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
}

function formatShortDate(value: string, language: "zh-CN" | "en-US") {
  const iso = value.includes("T") || value.endsWith("Z") ? value : `${value.replace(" ", "T")}Z`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(language, {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  });
}
