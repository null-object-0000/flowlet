import { useEffect, useState } from "react";
import { Button, Input, Pagination, Select, Toast, Typography } from "@douyinfe/semi-ui-19";
import { IconRefresh, IconSearch } from "@douyinfe/semi-icons";
import { useNavigate } from "react-router-dom";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import { DEFAULT_AGENT_SESSION_FILTER, type AgentSessionFilter, type AgentSessionNativeUsage, type AgentSessionRow } from "../../domains/agent-session/types";
import { useAgentSessionNativeSummary, useAgentSessions } from "../../features/agent-sessions/useAgentSessions";
import { useAgentDataSync, useAgentSyncSchedule, useAgentSyncStatus } from "../../features/background-tasks/useBackgroundTasks";
import secondaryButtonStyles from "../../shared/ui/SecondaryButton.module.css";
import { TokenBreakdownTooltip } from "../../shared/ui/TokenBreakdownTooltip";
import { formatCompactNumber, formatInteger } from "../../shared/formatters/number";
import { formatCostAmount, formatNativeCost } from "../../shared/formatters/cost";
import { CompactNumber } from "../../shared/ui/CompactNumber";
import { AgentSessionDetailSideSheet, sessionDisplayTitle } from "./AgentSessionDetailSideSheet";
import styles from "./AgentSessionsPage.module.css";

const { Paragraph, Text, Title } = Typography;

export function AgentSessionsPage() {
  const { language, t } = useAppPreferences();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<AgentSessionFilter>(DEFAULT_AGENT_SESSION_FILTER);
  const [searchDraft, setSearchDraft] = useState("");
  const [selectedSession, setSelectedSession] = useState<AgentSessionRow | null>(null);
  const sessions = useAgentSessions(filter);
  const syncAgentData = useAgentDataSync();
  const syncStatus = useAgentSyncStatus();
  const nextSyncAt = useAgentSyncSchedule();
  const [lastJobId, setLastJobId] = useState<string | null>(null);
  const page = sessions.data;
  const checkedTimes = syncStatus.data?.sources.map((source) => source.lastCheckedAt).filter((value): value is string => Boolean(value)).sort() ?? [];
  const latestCheckedAt = checkedTimes.length ? checkedTimes[checkedTimes.length - 1] : null;
  const syncStatusTitle = syncStatus.data?.sources.map((source) => `${agentLabel(source.agentType as AgentSessionRow["agentType"])}：${source.failedCount > 0 ? source.lastError ?? t("同步异常") : t("已扫描 {count} 个会话", { count: source.scannedCount })}`).join("\n");

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const search = searchDraft.trim();
      setFilter((current) => current.search === search ? current : { ...current, search, page: 1 });
    }, 280);
    return () => window.clearTimeout(timer);
  }, [searchDraft]);

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <Title heading={3} style={{ margin: 0 }}>{t("会话管理")}</Title>
          <Paragraph type="tertiary" style={{ margin: 0 }}>{t("统一查看 Agent 本地会话与 Flowlet 请求观测")}</Paragraph>
        </div>
      </header>

      <section className={styles.toolbar} aria-label={t("会话筛选")}>
        <Input prefix={<IconSearch />} value={searchDraft} placeholder={t("搜索会话标题、ID 或项目目录")} showClear onChange={setSearchDraft} />
        <Select
          style={{ width: "100%" }}
          insetLabel={t("客户端")}
          value={filter.agentType || "__all__"}
          optionList={[
            { value: "__all__", label: t("全部客户端") },
            { value: "codex-desktop", label: "ChatGPT (Codex)" },
            { value: "codex-cli", label: "Codex CLI" },
            { value: "claude-code", label: "Claude Code" },
            { value: "opencode", label: "OpenCode" },
          ]}
          onChange={(value) => setFilter((current) => ({ ...current, agentType: value === "__all__" ? "" : String(value) as AgentSessionFilter["agentType"], page: 1 }))}
        />
        <Select
          style={{ width: "100%" }}
          insetLabel={t("Flowlet 状态")}
          value={filter.flowletStatus || "__all__"}
          optionList={[
            { value: "__all__", label: t("全部状态") },
            { value: "observed", label: t("经过 Flowlet") },
            { value: "native", label: t("未经过 Flowlet") },
          ]}
          onChange={(value) => setFilter((current) => ({ ...current, flowletStatus: value === "__all__" ? "" : String(value) as AgentSessionFilter["flowletStatus"], page: 1 }))}
        />
        <span className={styles.syncMeta} title={syncStatusTitle}>{syncStatus.data?.running ? t("正在同步 Agent 数据…") : syncStatus.data?.sources.some((source) => source.failedCount > 0) ? t("部分客户端同步异常") : latestCheckedAt ? t("上次 {last} · 下次 {next}", { last: formatDate(latestCheckedAt, language), next: nextSyncAt ? formatDate(new Date(nextSyncAt).toISOString(), language) : "—" }) : t("自动同步：前台每 1 分钟，后台每 5 分钟")}</span>
        <div className={styles.syncActions}>{lastJobId ? <Button type="tertiary" onClick={() => navigate(`/tasks?jobId=${encodeURIComponent(lastJobId)}`)}>{t("查看任务")}</Button> : null}<Button
          className={`${secondaryButtonStyles.button} ${secondaryButtonStyles.compact}`}
          icon={<IconRefresh />}
          type="tertiary"
          theme="outline"
          loading={sessions.isFetching || syncAgentData.isPending}
          onClick={() => void syncAgentData.mutateAsync({ force: true, triggerSource: "manual" }).then((result) => { setLastJobId(result.jobId); Toast.success(result.message); }).catch((error: Error) => Toast.error(error.message))}
        >
          {t("同步数据")}
        </Button></div>
      </section>

      <section className={styles.tableCard}>
        <div className={`${styles.grid} ${styles.head}`} role="row">
          <span>{t("最近活动")}</span><span>{t("主会话")}</span><span>{t("客户端")}</span><span>{t("请求")}</span><span>Token</span><span>{t("费用")}</span><span>{t("状态")}</span>
        </div>
        <div className={styles.body}>
          {sessions.isLoading ? Array.from({ length: 7 }, (_, index) => <SkeletonRow key={index} />) : null}
          {sessions.isError ? <div className={styles.state}><strong>{t("会话加载失败")}</strong><span>{sessions.error.message}</span><Button onClick={() => void sessions.refetch()}>{t("重试")}</Button></div> : null}
          {!sessions.isLoading && !sessions.isError && (page?.rows.length ?? 0) === 0 ? <div className={styles.state}><strong>{t("暂无 Agent 会话")}</strong><span>{t("安装并使用 ChatGPT（Codex）、Claude Code 或 OpenCode 后，本地会话会自动出现在这里。")}</span></div> : null}
          {!sessions.isLoading && !sessions.isError ? page?.rows.map((row) => <SessionRow key={`${row.agentType}:${row.sessionId}`} row={row} language={language} onOpen={() => setSelectedSession(row)} />) : null}
        </div>
        <footer className={styles.footer}>
          <Text type="tertiary" size="small">{t("共 {total} 个主会话", { total: page?.total ?? 0 })}</Text>
          <Pagination total={page?.total ?? 0} currentPage={filter.page} pageSize={filter.pageSize} onPageChange={(pageNumber) => setFilter((current) => ({ ...current, page: pageNumber }))} />
        </footer>
      </section>
      {selectedSession ? (
        <AgentSessionDetailSideSheet
          session={selectedSession}
          onClose={() => setSelectedSession(null)}
          onViewRequestLogs={(sessionId) => navigate(`/logs?search=${encodeURIComponent(sessionId)}`)}
        />
      ) : null}
    </main>
  );
}

function SessionRow({ row, language, onOpen }: { row: AgentSessionRow; language: "zh-CN" | "en-US"; onOpen: () => void }) {
  const { t } = useAppPreferences();
  const nativeSummary = useAgentSessionNativeSummary(row);
  const resolvedNativeSummary = row.nativeSummary ?? nativeSummary.data;
  const nativeUsage = !row.flowletObserved ? resolvedNativeSummary?.usage ?? null : null;
  const tokenBreakdown = row.flowletObserved
    ? flowletTokenBreakdown(row)
    : nativeUsage
      ? nativeTokenBreakdown(row.agentType, nativeUsage)
      : null;
  const nativeAvailable = resolvedNativeSummary?.sourceAvailable === true;
  const nativeTruncated = resolvedNativeSummary?.truncated === true;
  const nativeTokenTruncated = nativeTruncated && row.agentType !== "opencode";
  const requestCount = row.flowletObserved ? row.requestCount : nativeAvailable ? resolvedNativeSummary?.turnCount ?? null : null;
  return (
    <button type="button" className={`${styles.grid} ${styles.row}`} onClick={onOpen}>
      <span>{formatDate(row.activityAt, language)}</span>
      <span className={styles.session}><strong title={row.title ?? row.sessionId}>{sessionDisplayTitle(row)}</strong><small title={row.projectPath ?? row.sessionId}>{row.projectPath ? `${agentLabel(row.agentType)} · ${projectName(row.projectPath)}` : agentLabel(row.agentType)}{row.nativeSyncedAt && !row.flowletObserved ? ` · ${t("已同步")}` : ""}</small></span>
      <span className={styles.client}><strong title={row.flowletObserved ? row.clientName ?? row.clientId ?? t("未知客户端") : t("未经过 Flowlet")}>{row.flowletObserved ? row.clientName ?? row.clientId ?? t("未知客户端") : t("未经过 Flowlet")}</strong>{row.clientId ? <small title={row.clientId}>{row.clientId}</small> : <small>{t("仅本地会话")}</small>}</span>
      <CompactNumber
        value={requestCount}
        language={language}
        prefix={!row.flowletObserved && nativeTruncated ? "≥" : undefined}
        title={!row.flowletObserved && requestCount != null
          ? t("Agent 原生 turn 数：{count}", { count: formatInteger(requestCount, language) })
          : requestCount == null ? undefined : formatInteger(requestCount, language)}
      />
      {tokenBreakdown ? (
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
      ) : <span>—</span>}
      <span title={!row.flowletObserved && nativeUsage ? nativeCostTitle(nativeUsage, t) : undefined}>{row.flowletObserved ? `¥${row.estimatedCost.toFixed(4)}` : nativeUsage ? nativeCostDisplay(nativeUsage) : "—"}</span>
      <span className={!row.flowletObserved ? styles.localOnly : row.errorCount > 0 ? styles.warning : styles.success}>{!row.flowletObserved ? t("本地会话") : row.errorCount > 0 ? t("{count} 次失败", { count: row.errorCount }) : t("正常")}</span>
    </button>
  );
}

function agentLabel(agentType: AgentSessionRow["agentType"]) {
  if (agentType === "claude-code") return "Claude Code";
  if (agentType === "codex-desktop") return "ChatGPT (Codex)";
  if (agentType === "codex-cli") return "Codex CLI";
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

function nativeCostTitle(usage: AgentSessionNativeUsage, t: (key: string, variables?: Record<string, string | number>) => string) {
  const parts: string[] = [];
  if (usage.apiEquivalent) parts.push(t("API 等价价值：{value}", { value: formatCostAmount(usage.apiEquivalent, 4) }));
  if (usage.planConsumption) parts.push(t("套餐消耗：{value}", { value: formatCostAmount(usage.planConsumption, 4) }));
  if (usage.cost != null) parts.push(t("原生实际费用：{value}", { value: formatNativeCost(usage, 4) }));
  return parts.join(" · ") || undefined;
}

function nativeCostDisplay(usage: AgentSessionNativeUsage) {
  if (usage.apiEquivalent?.amount != null) return formatCostAmount(usage.apiEquivalent, 4);
  if (usage.cost != null) return formatNativeCost(usage, 4);
  if (usage.planConsumption?.amount != null) return formatCostAmount(usage.planConsumption, 4);
  return "—";
}

function projectName(path: string) {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
}

function SkeletonRow() {
  return <div className={`${styles.grid} ${styles.row} ${styles.skeleton}`} aria-hidden="true">{Array.from({ length: 7 }, (_, index) => <span key={index} />)}</div>;
}

function formatDate(value: string, language: "zh-CN" | "en-US") {
  const iso = value.includes("T") || value.endsWith("Z") ? value : `${value.replace(" ", "T")}Z`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(language, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}
