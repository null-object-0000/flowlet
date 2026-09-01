import { Button, SideSheet, Tabs, Tag, Toast, Tooltip } from "@douyinfe/semi-ui-19";
import { IconAlertTriangle, IconCopy, IconExternalOpen } from "@douyinfe/semi-icons";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import { agentSessionLabel, type AgentSessionNativeSummary, type AgentSessionNativeUsage, type AgentSessionRow, type DshApprovalRequest, type OpenCodePermissionRequest } from "../../domains/agent-session/types";
import { useAgentSessionChildren, useAgentSessionNativeSummary, useDshSessionPermissions, useOpenCodeSessionPermissions, useReplyDshPermission, useReplyOpenCodePermission } from "../../features/agent-sessions/useAgentSessions";
import { APP_OVERLAY_Z_INDEX } from "../../shared/ui/overlayLayers";
import { SESSION_DETAIL_SHEET_WIDTH } from "../../shared/ui/drawerWidth";
import { RefreshControl } from "../../shared/ui/RefreshControl";
import { useRefreshControl } from "../../shared/ui/useRefreshControl";
import { formatCompactNumber, formatInteger } from "../../shared/formatters/number";
import { formatCostAmount, formatNativeCost } from "../../shared/formatters/cost";
import { formatFullTimestamp, formatTimestamp } from "../../shared/formatters/datetime";
import styles from "./AgentSessionDetailSideSheet.module.css";

// 打开抽屉期间自动刷新当前 Tab 的间隔，与移动端会话详情抽屉（MobileSessionSheet）一致。
const SESSION_AUTO_REFRESH_MS = 5_000;

export function AgentSessionDetailSideSheet({
  session,
  onClose,
  onViewRequestLogs,
  onRefreshOverview,
  remote = false,
}: {
  session: AgentSessionRow;
  onClose: () => void;
  onViewRequestLogs: (sessionId: string) => void;
  onRefreshOverview?: () => Promise<unknown> | void;
  /** 远端设备会话：只读同步快照，本地没有原生文件、请求日志与实时权限控制。 */
  remote?: boolean;
}) {
  const { language, t } = useAppPreferences();
  const [activeTab, setActiveTab] = useState<"overview" | "usage" | "info" | "child-sessions">("overview");
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | undefined>(undefined);
  // 抽屉右上角使用页面公共的自动刷新控件：开关控制抽屉内 5 秒自动刷新。
  const refreshControl = useRefreshControl({ intervalMs: SESSION_AUTO_REFRESH_MS });
  const title = sessionDisplayTitle(session);
  const children = useAgentSessionChildren(session, !remote);
  const nativeSummary = useAgentSessionNativeSummary(session);
  const openCodePermissions = useOpenCodeSessionPermissions(session, activeTab === "overview" && !remote);
  const dshPermissions = useDshSessionPermissions(session, activeTab === "overview" && !remote);
  const nativeUsage = session.nativeSummary ?? nativeSummary.data;
  const overviewMetrics = overviewSessionMetrics(session, nativeUsage);
  /** 按当前 Tab 拉取对应数据（静默版，不带动按钮 loading）。手动刷新与自动刷新共用；
   *  拉取成功后记录本次刷新时间，供右上角「最后刷新」指示展示。 */
  const refetchActiveTab = () => {
    const run = () => {
      // 远端设备会话只刷新同步快照（由页面负责 refetch 共享会话列表）。
      if (remote) return Promise.resolve(onRefreshOverview?.());
      if (activeTab === "overview") {
        return Promise.all([
          children.refetch(),
          nativeSummary.refetch(),
          onRefreshOverview?.(),
        ]);
      }
      if (activeTab === "usage") {
        return Promise.all([nativeSummary.refetch(), children.refetch()]);
      }
      if (activeTab === "child-sessions") {
        return children.refetch();
      }
      return Promise.resolve(onRefreshOverview?.());
    };
    return run().then(() => setLastUpdatedAt(Date.now()));
  };
  // 通过 ref 引用最新的拉取函数，避免定时器随每次渲染重建。
  const refetchActiveTabRef = useRef(refetchActiveTab);
  refetchActiveTabRef.current = refetchActiveTab;
  // 打开抽屉立即拉取一次最新数据。
  useEffect(() => {
    void refetchActiveTabRef.current().catch(() => undefined);
  }, []);
  // 自动刷新开启时每 5 秒刷新当前 Tab，与移动端会话详情一致；页面不可见时跳过。
  useEffect(() => {
    if (!refreshControl.autoRefresh) return;
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      void refetchActiveTabRef.current().catch(() => undefined);
    }, refreshControl.intervalMs);
    return () => window.clearInterval(timer);
  }, [refreshControl.autoRefresh, refreshControl.intervalMs]);

  return (
    <SideSheet
      visible
      motion={false}
      width={SESSION_DETAIL_SHEET_WIDTH}
      title={<SessionHeader session={session} language={language} remote={remote} />}
      onCancel={onClose}
      footer={null}
      bodyStyle={{
        padding: 0,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
      zIndex={APP_OVERLAY_Z_INDEX.sideSheet}
    >
      <div className={styles.drawer}>
        {/* 抽屉顶部固定行：页面公共的自动刷新控件，开关控制抽屉内 5 秒自动刷新 */}
        <div className={styles.drawerToolbar}>
          <RefreshControl
            autoRefresh={refreshControl.autoRefresh}
            onToggleAutoRefresh={refreshControl.toggleAutoRefresh}
            isFetching={remote ? false : children.isFetching || nativeSummary.isFetching || openCodePermissions.isFetching || dshPermissions.isFetching}
            lastUpdatedAt={lastUpdatedAt}
            intervalMs={refreshControl.intervalMs}
            onRefresh={() => void refetchActiveTab()}
            language={language}
            t={t}
          />
        </div>
        <Tabs
          className={styles.tabs}
          type="line"
          activeKey={activeTab}
          tabPaneMotion={false}
          onChange={(key) => setActiveTab(key as "overview" | "usage" | "info" | "child-sessions")}
        >
          <Tabs.TabPane tab={t("概览")} itemKey="overview">
            <div className={styles.tabFrame}>
              <div className={styles.tabScroll}>
                <div className={styles.body}>
                  <OverviewStats metrics={overviewMetrics} language={language} />
                  {remote ? (
                    <RemoteSnapshotNotice session={session} />
                  ) : session.agentType === "opencode" ? (
                    <OpenCodeApprovalSection session={session} permissions={openCodePermissions} />
                  ) : session.agentType === "deepseek-harness" ? (
                    <DshApprovalSection session={session} permissions={dshPermissions} />
                  ) : null}
                </div>
              </div>
            </div>
          </Tabs.TabPane>
          <Tabs.TabPane tab={t("信息")} itemKey="info">
            <div className={styles.tabFrame}>
              <div className={styles.tabScroll}>
                <div className={styles.body}>
                  <DetailSection title={t("会话信息")}>
                    <div className={styles.detailGrid}>
                      <DetailItem label={t("会话标题")} value={title} wide />
                      <DetailItem label={t("会话 ID")} value={session.sessionId} copyable wide onOpen={session.flowletObserved && !remote ? () => onViewRequestLogs(session.sessionId) : undefined} />
                      {session.parentSessionId ? <DetailItem label={t("父会话 ID")} value={session.parentSessionId} copyable wide /> : null}
                      <DetailItem
                        label={session.flowletObserved ? t("客户端") : t("Agent 来源")}
                        value={session.flowletObserved
                          ? session.clientName ?? session.clientId ?? t("未知客户端")
                          : agentSessionLabel(session.agentType)}
                      />
                      {remote ? <DetailItem label={t("来源设备")} value={session.remoteDeviceName ?? session.remoteDeviceId ?? "—"} wide /> : null}
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
              </div>
            </div>
          </Tabs.TabPane>
          <Tabs.TabPane tab={t("用量")} itemKey="usage">
            <div className={styles.tabFrame}>
              <div className={styles.tabScroll}>
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
              </div>
            </div>
          </Tabs.TabPane>
          {children.data && children.data.length > 0 ? (
            <Tabs.TabPane tab={t("子会话（{count}）", { count: children.data.length })} itemKey="child-sessions">
              <div className={styles.tabFrame}>
                <div className={styles.tabScroll}>
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
                </div>
              </div>
            </Tabs.TabPane>
          ) : null}
        </Tabs>
      </div>
    </SideSheet>
  );
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

function DshApprovalSection({ session, permissions }: { session: AgentSessionRow; permissions: ReturnType<typeof useDshSessionPermissions> }) {
  const { t } = useAppPreferences();
  const reply = useReplyDshPermission(session);
  if (session.agentType !== "deepseek-harness") return null;
  if (permissions.isLoading) {
    return <div className={styles.approvalNotice}>{t("正在检查 DeepSeek Harness 待确认操作")}</div>;
  }
  if (permissions.isError) {
    return <div className={styles.approvalNotice}>{t("DeepSeek Harness 待确认操作读取失败：{message}", { message: permissions.error.message })}</div>;
  }
  if (!permissions.data?.available) {
    return (
      <div className={styles.approvalNotice}>
        <strong>{t("DeepSeek Harness 确认桥未连接")}</strong>
        <span>{t("请确保已启用「交互确认桥」高级选项并重启了 DeepSeek Harness；之后可在这里同意或否决待确认操作。")}</span>
      </div>
    );
  }
  if (permissions.data.permissions.length === 0) return null;

  const decide = async (request: DshApprovalRequest, decision: "allow_once" | "reject") => {
    try {
      await reply.mutateAsync({ permissionId: request.approvalId, decision });
      Toast.success(decision === "allow_once" ? t("已同意 DeepSeek Harness 本次操作") : t("已否决 DeepSeek Harness 操作"));
    } catch (error) {
      Toast.error(t("DeepSeek Harness 操作提交失败：{message}", { message: error instanceof Error ? error.message : String(error) }));
    }
  };

  return (
    <div className={styles.approvalList}>
      {permissions.data.permissions.map((request) => {
        const submitting = reply.isPending && reply.variables?.permissionId === request.approvalId;
        return (
          <article className={styles.approvalCard} key={request.approvalId}>
            <div className={styles.approvalHeader}>
              <IconAlertTriangle className={styles.approvalIcon} />
              <strong>{t("DeepSeek Harness 等待确认")}</strong>
              <code>{request.toolName}</code>
              <div className={styles.approvalActions}>
                <Button size="small" type="danger" theme="borderless" loading={submitting && reply.variables?.decision === "reject"} disabled={reply.isPending && !submitting} onClick={() => void decide(request, "reject")}>{t("否决")}</Button>
                <Button size="small" type="primary" theme="solid" loading={submitting && reply.variables?.decision === "allow_once"} disabled={reply.isPending && !submitting} onClick={() => void decide(request, "allow_once")}>{t("同意本次")}</Button>
              </div>
            </div>
            {request.reason ? <pre>{request.reason}</pre> : null}
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
      <p className={styles.usageHint}>{agentType === "codex-desktop" || agentType === "codex-cli" ? t("根据明确的 Token 消耗按官方 API 原价估算费用") : t("来自 Agent 本地记录，与 Flowlet 请求统计独立，不参与相加")}</p>
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
            {data.usage.cost != null ? <Metric label={t("原生实际费用")} value={formatNativeCost(data.usage)} /> : null}
          </div>
          {(data.models ?? []).length > 0 ? <p className={styles.usageModels}>{t("模型：{models}", { models: data.models.join("、") })}</p> : null}
          {data.usage.apiEquivalent ? <EstimateMeta label={t("API 价格")} estimate={data.usage.apiEquivalent} /> : null}
        </>
      ) : null}
    </DetailSection>
  );
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

function SessionHeader({ session, language, remote = false }: { session: AgentSessionRow; language: "zh-CN" | "en-US"; remote?: boolean }) {
  const { t } = useAppPreferences();
  const title = sessionDisplayTitle(session);
  return (
    <div className={styles.sessionHeader}>
      <div className={styles.sessionHeaderTopline}>
        <span className={styles.agentBadge}>{agentSessionLabel(session.agentType)}</span>
        <strong className={styles.sessionTitle} title={title}>{title}</strong>
      </div>
      <div className={styles.meta}>
        <span className={styles.state} data-state={session.runtimeStatus}><i />{runtimeLabel(session.runtimeStatus, t)}</span>
        {remote ? <Tag size="small" color="blue">{t("远端设备")}</Tag> : null}
        {!session.flowletObserved && session.nativeSummary?.sourceAvailable === false ? <Tag size="small" color="grey">{t("源文件已删除")}</Tag> : null}
        {remote ? <span>{t("来自 {device}", { device: session.remoteDeviceName ?? session.remoteDeviceId ?? "—" })}</span> : null}
        <span>{t("最近活跃：{time}", { time: formatFullTimestamp(session.activityAt, language) })}</span>
      </div>
    </div>
  );
}

/** 远端设备会话的概览占位：展示来源设备，并说明快照只读属性。 */
function RemoteSnapshotNotice({ session }: { session: AgentSessionRow }) {
  const { t } = useAppPreferences();
  return (
    <div className={styles.remoteNotice}>
      <strong>{t("远端设备会话快照")}</strong>
      <span>{t("该会话来自设备「{device}」，展示的是最近一次同步的汇总数据；完整记录与请求日志保存在对方设备上。", { device: session.remoteDeviceName ?? session.remoteDeviceId ?? "—" })}</span>
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
