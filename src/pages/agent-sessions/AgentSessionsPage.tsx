import { useEffect, useState } from "react";
import { Button, Pagination, Toast, Typography } from "@douyinfe/semi-ui-19";
import { IconRefresh } from "@douyinfe/semi-icons";
import { useNavigate } from "react-router-dom";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import { DEFAULT_AGENT_SESSION_FILTER, type AgentSessionFilter, type AgentSessionNativeUsage, type AgentSessionRow } from "../../domains/agent-session/types";
import { useAgentSessionNativeSummary, useAgentSessions } from "../../features/agent-sessions/useAgentSessions";
import { useAgentDataSync, useAgentSyncStatus } from "../../features/background-tasks/useBackgroundTasks";
import { AgentSessionsView, DesktopFilterToolbarView, type AgentSessionRowModel, type AgentSessionStatusTone } from "@flowlet/product-ui";
import { TokenBreakdownTooltip } from "../../shared/ui/TokenBreakdownTooltip";
import { CostBreakdownTooltip } from "../../shared/ui/CostBreakdownTooltip";
import { CompactNumber } from "../../shared/ui/CompactNumber";
import { PageHeader } from "../../shared/ui/PageHeader";
import { RefreshControl } from "../../shared/ui/RefreshControl";
import { useRefreshControl } from "../../shared/ui/useRefreshControl";
import secondaryButtonStyles from "../../shared/ui/SecondaryButton.module.css";
import { formatCompactNumber, formatInteger } from "../../shared/formatters/number";
import { formatCostAmount, formatCostCny, formatNativeCost } from "../../shared/formatters/cost";
import { formatTimestamp } from "../../shared/formatters/datetime";
import { AgentSessionDetailSideSheet, sessionDisplayTitle } from "./AgentSessionDetailSideSheet";
import { useResponsiveTablePageSize } from "../../shared/ui/useResponsiveTablePageSize";
import styles from "./AgentSessionsPage.module.css";

const { Text } = Typography;

export function AgentSessionsPage() {
  const { language, t } = useAppPreferences();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<AgentSessionFilter>(DEFAULT_AGENT_SESSION_FILTER);
  const [searchDraft, setSearchDraft] = useState("");
  const refresh = useRefreshControl({ intervalMs: 15_000 });
  const [selectedSession, setSelectedSession] = useState<AgentSessionRow | null>(null);
  const sessions = useAgentSessions(filter, refresh.autoRefresh);
  const syncAgentData = useAgentDataSync();
  const syncStatus = useAgentSyncStatus();
  const [lastJobId, setLastJobId] = useState<string | null>(null);
  const { bodyRef, pageSize } = useResponsiveTablePageSize({ rowHeight: 54, initialPageSize: DEFAULT_AGENT_SESSION_FILTER.pageSize });
  const page = sessions.data;
  const checkedTimes = syncStatus.data?.sources.map((source) => source.lastCheckedAt).filter((value): value is string => Boolean(value)).sort() ?? [];
  const latestCheckedAt = checkedTimes.length ? checkedTimes[checkedTimes.length - 1] : null;
  const syncStatusTitle = syncStatus.data?.sources.map((source) => `${agentLabel(source.agentType as AgentSessionRow["agentType"])}：${source.failedCount > 0 ? source.lastError ?? t("同步异常") : t("已扫描 {count} 个会话", { count: source.scannedCount })}`).join("\n");
  const refreshSelectedSessionOverview = async () => {
    const result = await sessions.refetch();
    if (!selectedSession) return;
    const refreshed = result.data?.rows.find((row) =>
      row.agentType === selectedSession.agentType && row.sessionId === selectedSession.sessionId,
    );
    if (refreshed) setSelectedSession(refreshed);
  };

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const search = searchDraft.trim();
      setFilter((current) => current.search === search ? current : { ...current, search, page: 1 });
    }, 280);
    return () => window.clearTimeout(timer);
  }, [searchDraft]);

  useEffect(() => {
    setFilter((current) => current.pageSize === pageSize ? current : {
      ...current,
      page: Math.floor(((current.page - 1) * current.pageSize) / pageSize) + 1,
      pageSize,
    });
  }, [pageSize]);

  return (
    <main className={styles.page}>
      <PageHeader title={t("会话管理")} subtitle={t("统一查看 Agent 本地会话与 Flowlet 请求观测")}>
        <RefreshControl
          autoRefresh={refresh.autoRefresh}
          onToggleAutoRefresh={refresh.toggleAutoRefresh}
          isFetching={sessions.isFetching}
          lastUpdatedAt={sessions.dataUpdatedAt}
          intervalMs={refresh.intervalMs}
          onRefresh={() => void sessions.refetch()}
          language={language}
          t={t}
        />
      </PageHeader>

      {sessions.isError ? <div className={styles.state}><strong>{t("会话加载失败")}</strong><span>{sessions.error.message}</span><Button onClick={() => void sessions.refetch()}>{t("重试")}</Button></div> : null}
      {!sessions.isError ? (
        <AgentSessionsView
          rows={toAgentSessionRowModels(page?.rows ?? [], language, t)}
          loading={sessions.isLoading}
          loadingRowCount={filter.pageSize}
          bodyRef={bodyRef}
          renderRequests={(row, index) => {
            const raw = (page?.rows ?? [])[index];
            if (!raw) return <span>—</span>;
            return <SessionRequestsCell row={raw} language={language} />;
          }}
          renderToken={(row, index) => {
            const raw = (page?.rows ?? [])[index];
            if (!raw) return <span>—</span>;
            return <SessionTokenCell row={raw} language={language} />;
          }}
          renderCost={(row, index) => {
            const raw = (page?.rows ?? [])[index];
            if (!raw) return <span>—</span>;
            return <SessionCostCell row={raw} />;
          }}
          labels={{
            activity: t("最近活动"),
            session: t("主会话"),
            client: t("客户端"),
            requests: t("请求"),
            token: "Token",
            cost: t("费用"),
            status: t("状态"),
            total: t("共 {total} 个主会话", { total: page?.total ?? 0 }),
          }}
          toolbar={(
            <DesktopFilterToolbarView
              ariaLabel={t("会话筛选")}
              search={{ value: searchDraft, placeholder: t("搜索会话标题、ID 或项目目录"), width: 280 }}
              selects={[
                { key: "client", insetLabel: t("客户端"), value: filter.agentType || "__all__", ariaLabel: t("客户端"), width: 210, options: [
                  { value: "__all__", label: t("全部客户端") },
                  { value: "codex-desktop", label: "Codex Desktop" },
                  { value: "codex-cli", label: "Codex CLI" },
                  { value: "claude-code", label: "Claude Code" },
                  { value: "opencode", label: "OpenCode" },
                  { value: "pi", label: "Pi" },
                ] },
                { key: "runtime", insetLabel: t("运行状态"), value: filter.runtimeStatus || "__all__", ariaLabel: t("运行状态"), width: 210, options: [
                  { value: "__all__", label: t("全部状态") },
                  { value: "running", label: t("自动运行中") },
                  { value: "waiting_user", label: t("等待用户确认") },
                  { value: "idle", label: t("空闲") },
                  { value: "unknown", label: t("无法判断") },
                ] },
              ]}
              onSearchChange={setSearchDraft}
              onSelectChange={(key, value) => setFilter((current) => key === "client"
                ? { ...current, agentType: value === "__all__" ? "" : value as AgentSessionFilter["agentType"], page: 1 }
                : { ...current, runtimeStatus: value === "__all__" ? "" : value as AgentSessionFilter["runtimeStatus"], page: 1 })}
              actions={<div className={styles.syncActions}>{lastJobId ? <Button type="tertiary" onClick={() => navigate(`/tasks?jobId=${encodeURIComponent(lastJobId)}`)}>{t("查看任务")}</Button> : null}<Button
                className={`${secondaryButtonStyles.button} ${secondaryButtonStyles.compact}`}
                icon={<IconRefresh />}
                type="tertiary"
                theme="outline"
                loading={sessions.isFetching || syncAgentData.isPending}
                onClick={() => void syncAgentData.mutateAsync({ force: true, triggerSource: "manual" }).then((result) => { setLastJobId(result.jobId); Toast.success(result.message); }).catch((error: Error) => Toast.error(error.message))}
              >
                {t("同步数据")}
              </Button></div>}
            />
          )}
          footer={(
            <>
              <Text type="tertiary" size="small">{t("共 {total} 个主会话", { total: page?.total ?? 0 })}</Text>
              <Pagination total={page?.total ?? 0} currentPage={filter.page} pageSize={filter.pageSize} onPageChange={(pageNumber) => setFilter((current) => ({ ...current, page: pageNumber }))} />
            </>
          )}
          onOpenRow={(id) => {
            const row = page?.rows.find((item) => `${item.agentType}:${item.sessionId}` === id);
            if (row) setSelectedSession(row);
          }}
        />
      ) : null}
      {selectedSession ? (
        <AgentSessionDetailSideSheet
          session={selectedSession}
          onClose={() => setSelectedSession(null)}
          onViewRequestLogs={(sessionId) => navigate(`/logs?search=${encodeURIComponent(sessionId)}`)}
          onRefreshOverview={refreshSelectedSessionOverview}
        />
      ) : null}
    </main>
  );
}


function agentLabel(agentType: AgentSessionRow["agentType"]) {
  if (agentType === "claude-code") return "Claude Code";
  if (agentType === "codex-desktop") return "Codex Desktop";
  if (agentType === "codex-cli") return "Codex CLI";
  if (agentType === "pi") return "Pi";
  return "OpenCode";
}

function flowletTokenBreakdown(row: AgentSessionRow) {
  const hasKnownUsage = row.requestCount > row.unknownUsageCount;
  if (!hasKnownUsage) return null;
  return {
    total: row.knownTokens,
    input: row.inputTokens,
    cachedInput: row.inputCachedTokens,
    uncachedInput: row.inputUncachedTokens,
    output: row.outputTokens,
    cacheHitRate: row.cacheMeasuredInputTokens > 0
      ? Math.max(0, Math.min(1, row.inputCachedTokens / row.cacheMeasuredInputTokens))
      : null,
  };
}

function nativeTokenBreakdown(agentType: AgentSessionRow["agentType"], usage: AgentSessionNativeUsage) {
  const claudeInput = usage.inputTokens + usage.cachedInputTokens + usage.cacheWriteInputTokens;
  const measuredInput = agentType === "claude-code" ? claudeInput : usage.inputTokens;
  const uncachedInput = agentType === "claude-code"
    ? usage.inputTokens
    : Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  return {
    total: usage.totalTokens,
    input: usage.inputTokens,
    cachedInput: usage.cachedInputTokens,
    cacheWriteInput: usage.cacheWriteInputTokens,
    uncachedInput,
    output: usage.outputTokens,
    reasoning: usage.reasoningTokens,
    cacheHitRate: measuredInput > 0
      ? Math.max(0, Math.min(1, usage.cachedInputTokens / measuredInput))
      : null,
  };
}

function nativeCostDisplay(usage: AgentSessionNativeUsage) {
  if (usage.apiEquivalent?.amount != null) return formatCostAmount(usage.apiEquivalent, 4);
  if (usage.cost != null) return formatNativeCost(usage, 4);
  return "—";
}

function projectName(path: string) {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
}

function SessionRequestsCell({ row, language }: { row: AgentSessionRow; language: "zh-CN" | "en-US" }) {
  const { t } = useAppPreferences();
  const nativeSummary = useAgentSessionNativeSummary(row);
  const resolvedNativeSummary = row.nativeSummary ?? nativeSummary.data;
  const requestCount = row.flowletObserved ? row.requestCount : resolvedNativeSummary?.turnCount ?? null;
  const nativeTruncated = resolvedNativeSummary?.truncated === true;
  return (
    <CompactNumber
      value={requestCount}
      language={language}
      prefix={!row.flowletObserved && nativeTruncated ? "≥" : undefined}
      title={!row.flowletObserved && requestCount != null
        ? t("Agent 原生 turn 数：{count}", { count: formatInteger(requestCount, language) })
        : requestCount == null ? undefined : formatInteger(requestCount, language)}
    />
  );
}

function SessionTokenCell({ row, language }: { row: AgentSessionRow; language: "zh-CN" | "en-US" }) {
  const { t } = useAppPreferences();
  const nativeSummary = useAgentSessionNativeSummary(row);
  const resolvedNativeSummary = row.nativeSummary ?? nativeSummary.data;
  const nativeUsage = !row.flowletObserved ? resolvedNativeSummary?.usage ?? null : null;
  const tokenBreakdown = row.flowletObserved ? flowletTokenBreakdown(row) : nativeUsage ? nativeTokenBreakdown(row.agentType, nativeUsage) : null;
  const nativeTruncated = resolvedNativeSummary?.truncated === true;
  const nativeTokenTruncated = nativeTruncated && row.agentType !== "opencode";
  if (!tokenBreakdown) return <span>—</span>;
  return (
    <TokenBreakdownTooltip
      language={language}
      t={t}
      tokens={{
        ...tokenBreakdown,
        unknownUsageCount: row.flowletObserved ? row.unknownUsageCount : undefined,
      }}
    >
      <CompactNumber
        className={styles.tokenTotal}
        value={tokenBreakdown.total}
        language={language}
        prefix={!row.flowletObserved && nativeTokenTruncated ? "≥" : undefined}
        aria-label={t("Token 明细：总计 {total}，缓存命中率 {rate}", {
          total: `${!row.flowletObserved && nativeTokenTruncated ? "≥" : ""}${formatCompactNumber(tokenBreakdown.total, language)}`,
          rate: tokenBreakdown.cacheHitRate == null ? "—" : `${(tokenBreakdown.cacheHitRate * 100).toFixed(1)}%`,
        })}
      />
    </TokenBreakdownTooltip>
  );
}

function SessionCostCell({ row }: { row: AgentSessionRow }) {
  const { t } = useAppPreferences();
  const nativeSummary = useAgentSessionNativeSummary(row);
  const resolvedNativeSummary = row.nativeSummary ?? nativeSummary.data;
  const nativeUsage = !row.flowletObserved ? resolvedNativeSummary?.usage ?? null : null;
  return (
    <CostBreakdownTooltip
      t={t}
      total={row.flowletObserved ? row.estimatedCost : nativeUsage?.cost ?? nativeUsage?.apiEquivalent?.amount ?? null}
      currency="CNY"
      inputUncached={row.flowletObserved ? row.estimatedInputUncachedCost : undefined}
      inputCached={row.flowletObserved ? row.estimatedInputCachedCost : undefined}
      inputCacheWrite={row.flowletObserved ? row.estimatedInputCacheWriteCost : undefined}
      output={row.flowletObserved ? row.estimatedOutputCost : undefined}
      apiEquivalent={nativeUsage?.apiEquivalent ?? null}
    >
      <span className={styles.tokenTotal} onClick={(e) => e.stopPropagation()}>
        {row.flowletObserved ? formatCostCny(row.estimatedCost) : nativeUsage ? nativeCostDisplay(nativeUsage) : "—"}
      </span>
    </CostBreakdownTooltip>
  );
}

/** 把领域行映射为共享展示模型：状态、Token、费用等文案已在此完成本地化。 */
function toAgentSessionRowModels(rows: AgentSessionRow[], language: "zh-CN" | "en-US", t: (key: string, values?: Record<string, string | number>) => string): AgentSessionRowModel[] {
  return rows.map((row) => {
    const nativeSummary = row.nativeSummary ?? null;
    const nativeUsage = !row.flowletObserved ? nativeSummary?.usage ?? null : null;
    const tokenBreakdown = row.flowletObserved ? flowletTokenBreakdown(row) : nativeUsage ? nativeTokenBreakdown(row.agentType, nativeUsage) : null;
    const requestCount = row.flowletObserved ? row.requestCount : nativeSummary?.turnCount ?? null;
    const sourceDeleted = !row.flowletObserved && row.nativeSummary?.sourceAvailable === false;
    const status = row.runtimeStatus;
    const health = !row.flowletObserved
      ? sourceDeleted ? t("源文件已删除") : t("本地会话")
      : row.errorCount > 0 ? t("{count} 次失败", { count: row.errorCount }) : t("请求正常");
    const nativeTruncated = nativeSummary?.truncated === true;
    const nativeTokenTruncated = nativeTruncated && row.agentType !== "opencode";
    return {
      id: `${row.agentType}:${row.sessionId}`,
      ariaLabel: `${row.title ?? row.sessionId} · ${t("会话")}`,
      activityAt: formatTimestamp(row.activityAt, language),
      title: sessionDisplayTitle(row),
      subtitle: row.projectPath ? `${agentLabel(row.agentType)} · ${projectName(row.projectPath)}` : agentLabel(row.agentType),
      client: row.flowletObserved ? row.clientName ?? row.clientId ?? t("未知客户端") : t("未经过 Flowlet"),
      clientSub: row.clientId && row.flowletObserved ? row.clientId : undefined,
      requests: requestCount == null ? undefined : formatInteger(requestCount, language),
      requestsPrefix: !row.flowletObserved && nativeTruncated ? "≥" : undefined,
      requestsTitle: !row.flowletObserved && requestCount != null
        ? t("Agent 原生 turn 数：{count}", { count: formatInteger(requestCount, language) })
        : requestCount == null ? undefined : formatInteger(requestCount, language),
      tokens: tokenBreakdown ? formatCompactNumber(tokenBreakdown.total, language) : undefined,
      tokenHint: tokenBreakdown ? [
        `${t("缓存命中率")} ${tokenBreakdown.cacheHitRate == null ? "—" : `${(tokenBreakdown.cacheHitRate * 100).toFixed(1)}%`}`,
        `${t("输入")} ${formatCompactNumber(tokenBreakdown.input, language)} · ${t("输出")} ${formatCompactNumber(tokenBreakdown.output, language)}`,
      ].join(" · ") : undefined,
      cost: row.flowletObserved ? formatCostCny(row.estimatedCost) : nativeUsage ? nativeCostDisplay(nativeUsage) : undefined,
      status: {
        running: t("自动运行中"),
        waiting_user: t("等待用户确认"),
        idle: t("空闲"),
        unknown: t("无法判断"),
      }[status],
      statusTone: (status === "running" ? "running" : status === "waiting_user" ? "waiting" : "idle") as AgentSessionStatusTone,
      statusHint: health,
    };
  });
}
