import { useEffect, useMemo, useState } from "react";
import { Button, Pagination, Toast, Typography } from "@douyinfe/semi-ui-19";
import { IconRefresh } from "@douyinfe/semi-icons";
import { useNavigate } from "react-router-dom";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import { agentSessionLabel, DEFAULT_AGENT_SESSION_FILTER, type AgentSessionFilter, type AgentSessionInteractionEvent, type AgentSessionNativeSummary, type AgentSessionNativeUsage, type AgentSessionRow, type AgentSessionsPage, type AgentSessionType } from "../../domains/agent-session/types";
import { AGENT_SESSION_OPTIONS } from "../../domains/pluginRegistry";
import type { SharedAgentSession } from "../../domains/device-sync/types";
import { useAgentSessionNativeSummary, useAgentSessions } from "../../features/agent-sessions/useAgentSessions";
import { useAgentDataSync, useAgentSyncStatus } from "../../features/background-tasks/useBackgroundTasks";
import { DeviceUsageTitlePicker } from "../../features/device-sync/DeviceUsageTitlePicker";
import { useKnownDevices, useRefreshSharedDevice, useSharedDeviceSessions } from "../../features/device-sync/useDeviceSync";
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

const EMPTY_DEVICES: Array<{ deviceId: string; displayName: string; isCurrent: boolean }> = [];
const EMPTY_ROWS: AgentSessionRow[] = [];

export function AgentSessionsPage() {
  const { language, t } = useAppPreferences();
  const navigate = useNavigate();
  const knownDevices = useKnownDevices();
  const devices = knownDevices.data ?? EMPTY_DEVICES;
  const currentDeviceId = useMemo(
    () => devices.find((device) => device.isCurrent)?.deviceId ?? null,
    [devices],
  );
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [filter, setFilter] = useState<AgentSessionFilter>(DEFAULT_AGENT_SESSION_FILTER);
  const [searchDraft, setSearchDraft] = useState("");
  const refresh = useRefreshControl({ intervalMs: 15_000 });
  const [selectedSession, setSelectedSession] = useState<AgentSessionRow | null>(null);
  const { bodyRef, pageSize } = useResponsiveTablePageSize({ rowHeight: 54, initialPageSize: DEFAULT_AGENT_SESSION_FILTER.pageSize });
  const refreshSharedDevice = useRefreshSharedDevice(deviceId);
  const selectedDevice = devices.find((device) => device.deviceId === deviceId) ?? null;
  // 设备目录尚未就绪（或读取失败）时回退到本机会话，保持原有行为。
  const isCurrentDevice = deviceId == null || (currentDeviceId != null && deviceId === currentDeviceId);

  // 会话管理必须指定一台设备，不支持“全部设备”：设备目录就绪后默认选中当前设备。
  useEffect(() => {
    if (deviceId == null && currentDeviceId != null) setDeviceId(currentDeviceId);
  }, [deviceId, currentDeviceId]);

  // 选中的设备已从设备目录消失（例如被移除）时回到当前设备。
  useEffect(() => {
    if (deviceId != null && currentDeviceId != null && !devices.some((device) => device.deviceId === deviceId)) {
      setDeviceId(currentDeviceId);
    }
  }, [deviceId, currentDeviceId, devices]);

  // 当前设备：本地会话（观察 + 原生），服务端筛选分页；远端设备：同步快照，客户端筛选分页。
  const sessions = useAgentSessions(filter, refresh.autoRefresh, isCurrentDevice);
  const sharedSessions = useSharedDeviceSessions(
    isCurrentDevice ? null : deviceId,
    !isCurrentDevice && deviceId != null,
    refresh.autoRefresh,
  );
  const syncAgentData = useAgentDataSync();
  const syncStatus = useAgentSyncStatus();
  const [lastJobId, setLastJobId] = useState<string | null>(null);

  const remoteRows = useMemo(() => {
    if (isCurrentDevice || deviceId == null) return EMPTY_ROWS;
    const name = selectedDevice?.displayName ?? "";
    return (sharedSessions.data ?? []).map((shared) => sharedToAgentSessionRow(shared, deviceId, name));
  }, [isCurrentDevice, deviceId, selectedDevice, sharedSessions.data]);

  const remoteFiltered = useMemo(
    () => filterSharedSessions(remoteRows, filter),
    [remoteRows, filter],
  );

  const page: AgentSessionsPage = useMemo(() => {
    if (isCurrentDevice) return sessions.data ?? { rows: EMPTY_ROWS, total: 0, page: filter.page, pageSize: filter.pageSize };
    const start = (filter.page - 1) * filter.pageSize;
    return {
      rows: remoteFiltered.slice(start, start + filter.pageSize),
      total: remoteFiltered.length,
      page: filter.page,
      pageSize: filter.pageSize,
    };
  }, [isCurrentDevice, sessions.data, remoteFiltered, filter]);

  const loading = isCurrentDevice ? sessions.isLoading : sharedSessions.isLoading;
  const isError = isCurrentDevice ? sessions.isError : sharedSessions.isError;
  const errorMessageValue = isCurrentDevice
    ? (sessions.error?.message ?? "")
    : (sharedSessions.error?.message ?? "");
  const refetch = isCurrentDevice ? sessions.refetch : sharedSessions.refetch;

  const changeDevice = (next: string) => {
    if (!next || next === deviceId) return;
    setDeviceId(next);
    setSelectedSession(null);
    setSearchDraft("");
    setFilter((current) => ({ ...DEFAULT_AGENT_SESSION_FILTER, pageSize: current.pageSize }));
  };

  const refreshSelectedSessionOverview = async () => {
    const refreshingSession = selectedSession;
    if (refreshingSession?.remoteDeviceId) {
      const result = await sharedSessions.refetch();
      if (!refreshingSession) return;
      const refreshed = result.data?.find((shared) =>
        shared.agentType === refreshingSession.agentType && shared.sessionId === refreshingSession.sessionId,
      );
      if (refreshed) {
        setSelectedSession((current) => current
          && current.agentType === refreshed.agentType
          && current.sessionId === refreshed.sessionId
          ? sharedToAgentSessionRow(refreshed, current.remoteDeviceId ?? "", current.remoteDeviceName ?? "")
          : current);
      }
      return;
    }
    const result = await sessions.refetch();
    if (!refreshingSession) return;
    const refreshed = result.data?.rows.find((row) =>
      row.agentType === refreshingSession.agentType && row.sessionId === refreshingSession.sessionId,
    );
    if (refreshed) {
      setSelectedSession((current) => current
        && current.agentType === refreshed.agentType
        && current.sessionId === refreshed.sessionId
        ? refreshed
        : current);
    }
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
      <PageHeader
        title={(
          <DeviceUsageTitlePicker
            devices={devices}
            deviceId={deviceId}
            allowAll={false}
            title="会话管理"
            onChange={(value) => changeDevice(value ?? currentDeviceId ?? "")}
          />
        )}
        subtitle={t("统一查看 Agent 会话与 Flowlet 请求观测")}
      >
        <RefreshControl
          autoRefresh={refresh.autoRefresh}
          onToggleAutoRefresh={refresh.toggleAutoRefresh}
          isFetching={isCurrentDevice ? sessions.isFetching : sharedSessions.isFetching}
          lastUpdatedAt={isCurrentDevice ? sessions.dataUpdatedAt : sharedSessions.dataUpdatedAt}
          intervalMs={refresh.intervalMs}
          onRefresh={() => void refetch()}
          language={language}
          t={t}
        />
      </PageHeader>

      {isError ? <div className={styles.state}><strong>{t("会话加载失败")}</strong><span>{errorMessageValue}</span><Button onClick={() => void refetch()}>{t("重试")}</Button></div> : null}
      {!isError ? (
        <AgentSessionsView
          rows={toAgentSessionRowModels(page.rows, language, t)}
          loading={loading}
          loadingRowCount={filter.pageSize}
          bodyRef={bodyRef}
          renderRequests={(row, index) => {
            const raw = page.rows[index];
            if (!raw) return <span>—</span>;
            return <SessionRequestsCell row={raw} language={language} />;
          }}
          renderToken={(row, index) => {
            const raw = page.rows[index];
            if (!raw) return <span>—</span>;
            return <SessionTokenCell row={raw} language={language} />;
          }}
          renderCost={(row, index) => {
            const raw = page.rows[index];
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
            total: t("共 {total} 个主会话", { total: page.total }),
          }}
          toolbar={(
            <DesktopFilterToolbarView
              ariaLabel={t("会话筛选")}
              search={{ value: searchDraft, placeholder: t("搜索会话标题、ID 或项目目录"), width: 280 }}
              selects={[
                { key: "client", insetLabel: t("客户端"), value: filter.agentType || "__all__", ariaLabel: t("客户端"), width: 210, options: [
                  { value: "__all__", label: t("全部客户端") },
                  ...AGENT_SESSION_OPTIONS.map((session) => ({ value: session.id, label: session.name })),
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
              actions={(
                <div className={styles.syncActions}>
                  {isCurrentDevice ? (
                    <>
                      {lastJobId ? <Button type="tertiary" onClick={() => navigate(`/tasks?jobId=${encodeURIComponent(lastJobId)}`)}>{t("查看任务")}</Button> : null}
                      <Button
                        className={`${secondaryButtonStyles.button} ${secondaryButtonStyles.compact}`}
                        icon={<IconRefresh />}
                        type="tertiary"
                        theme="outline"
                        loading={sessions.isFetching || syncAgentData.isPending || (syncStatus.data?.running ?? false)}
                        onClick={() => void syncAgentData.mutateAsync({ force: true, triggerSource: "manual" }).then((result) => { setLastJobId(result.jobId); Toast.success(result.message); }).catch((error: Error) => Toast.error(error.message))}
                      >
                        {t("同步数据")}
                      </Button>
                    </>
                  ) : (
                    <Button
                      className={`${secondaryButtonStyles.button} ${secondaryButtonStyles.compact}`}
                      icon={<IconRefresh />}
                      type="tertiary"
                      theme="outline"
                      loading={sharedSessions.isFetching || refreshSharedDevice.isPending}
                      onClick={() => void refreshSharedDevice.mutateAsync().then((result) => {
                        Toast.success(result.refreshedDevices > 0
                          ? t("已刷新 {device} 的会话数据", { device: selectedDevice?.displayName ?? t("设备") })
                          : t("设备快照已是最新"));
                      }).catch((error: Error) => Toast.error(error.message))}
                    >
                      {t("刷新设备数据")}
                    </Button>
                  )}
                </div>
              )}
            />
          )}
          footer={(
            <>
              <Text type="tertiary" size="small">{t("共 {total} 个主会话", { total: page.total })}</Text>
              <Pagination total={page.total} currentPage={filter.page} pageSize={filter.pageSize} onPageChange={(pageNumber) => setFilter((current) => ({ ...current, page: pageNumber }))} />
            </>
          )}
          onOpenRow={(id) => {
            const row = page.rows.find((item) => `${item.agentType}:${item.sessionId}` === id);
            if (row) setSelectedSession(row);
          }}
        />
      ) : null}
      {selectedSession ? (
        <AgentSessionDetailSideSheet
          session={selectedSession}
          remote={Boolean(selectedSession.remoteDeviceId)}
          onClose={() => setSelectedSession(null)}
          onViewRequestLogs={(sessionId) => navigate(`/logs?search=${encodeURIComponent(sessionId)}`)}
          onRefreshOverview={refreshSelectedSessionOverview}
        />
      ) : null}
    </main>
  );
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
  const nativeTruncated = resolvedNativeSummary?.truncated === true;

  // 远端设备快照只带轻量汇总，不展示输入/输出拆解。
  if (row.remoteDeviceId) {
    const total = row.flowletObserved ? row.knownTokens : nativeUsage?.totalTokens ?? null;
    if (total == null) return <span>—</span>;
    return (
      <CompactNumber
        className={styles.tokenTotal}
        value={total}
        language={language}
        prefix={!row.flowletObserved && nativeTruncated ? "≥" : undefined}
        aria-label={t("Token 总计：{total}", {
          total: `${!row.flowletObserved && nativeTruncated ? "≥" : ""}${formatCompactNumber(total, language)}`,
        })}
      />
    );
  }

  const tokenBreakdown = row.flowletObserved ? flowletTokenBreakdown(row) : nativeUsage ? nativeTokenBreakdown(row.agentType, nativeUsage) : null;
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
  const nativeEstimate = nativeUsage?.apiEquivalent ?? null;

  // 远端设备快照不携带费用信息。
  if (row.remoteDeviceId) return <span>—</span>;

  return (
    <CostBreakdownTooltip
      t={t}
      total={row.flowletObserved ? row.estimatedCost : nativeEstimate?.amount ?? nativeUsage?.cost ?? null}
      currency={row.flowletObserved ? "CNY" : nativeEstimate?.currency ?? nativeUsage?.costCurrency ?? "USD"}
      inputUncached={row.flowletObserved ? row.estimatedInputUncachedCost : undefined}
      inputCached={row.flowletObserved ? row.estimatedInputCachedCost : undefined}
      inputCacheWrite={row.flowletObserved ? row.estimatedInputCacheWriteCost : undefined}
      output={row.flowletObserved ? row.estimatedOutputCost : undefined}
      apiEquivalent={nativeEstimate}
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
    const remote = Boolean(row.remoteDeviceId);
    const health = remote
      ? !row.flowletObserved ? t("远端会话") : row.errorCount > 0 ? t("{count} 次失败", { count: row.errorCount }) : t("请求正常")
      : !row.flowletObserved
        ? sourceDeleted ? t("源文件已删除") : t("本地会话")
        : row.errorCount > 0 ? t("{count} 次失败", { count: row.errorCount }) : t("请求正常");
    const nativeTruncated = nativeSummary?.truncated === true;
    const nativeTokenTruncated = nativeTruncated && row.agentType !== "opencode";
    // 远端设备快照只带轻量汇总（无输入/输出拆解与费用）。
    const remoteTokenTotal = remote ? (row.flowletObserved ? row.knownTokens : nativeUsage?.totalTokens ?? null) : null;
    return {
      id: `${row.agentType}:${row.sessionId}`,
      ariaLabel: `${row.title ?? row.sessionId} · ${t("会话")}`,
      activityAt: formatTimestamp(row.activityAt, language),
      title: sessionDisplayTitle(row),
      subtitle: row.remoteDeviceId
        ? `${agentSessionLabel(row.agentType)} · ${row.remoteDeviceName ?? t("远端设备")}`
        : row.projectPath ? `${agentSessionLabel(row.agentType)} · ${projectName(row.projectPath)}` : agentSessionLabel(row.agentType),
      client: row.flowletObserved ? row.clientName ?? row.clientId ?? t("未知客户端") : t("未经过 Flowlet"),
      clientSub: row.clientId && row.flowletObserved ? row.clientId : undefined,
      requests: requestCount == null ? undefined : formatInteger(requestCount, language),
      requestsPrefix: !row.flowletObserved && nativeTruncated ? "≥" : undefined,
      requestsTitle: !row.flowletObserved && requestCount != null
        ? t("Agent 原生 turn 数：{count}", { count: formatInteger(requestCount, language) })
        : requestCount == null ? undefined : formatInteger(requestCount, language),
      tokens: remote
        ? remoteTokenTotal == null ? undefined : formatCompactNumber(remoteTokenTotal, language)
        : tokenBreakdown ? formatCompactNumber(tokenBreakdown.total, language) : undefined,
      tokenHint: remote ? undefined : tokenBreakdown ? [
        `${t("缓存命中率")} ${tokenBreakdown.cacheHitRate == null ? "—" : `${(tokenBreakdown.cacheHitRate * 100).toFixed(1)}%`}`,
        `${t("输入")} ${formatCompactNumber(tokenBreakdown.input, language)} · ${t("输出")} ${formatCompactNumber(tokenBreakdown.output, language)}`,
      ].join(" · ") : undefined,
      cost: remote ? undefined : row.flowletObserved ? formatCostCny(row.estimatedCost) : nativeUsage ? nativeCostDisplay(nativeUsage) : undefined,
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

/** 把设备同步快照会话映射为领域行：只填充快照内可用的轻量字段，其余置空，
 *  并打上 `remoteDeviceId` 标记，列表/详情据此不展示本地才有能力。 */
function sharedToAgentSessionRow(shared: SharedAgentSession, deviceId: string, deviceName: string): AgentSessionRow {
  const nativeUsage: AgentSessionNativeUsage | null = shared.nativeTotalTokens != null
    ? {
        inputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        totalTokens: shared.nativeTotalTokens,
        cost: null,
        costCurrency: null,
      }
    : null;
  return {
    agentType: shared.agentType as AgentSessionType,
    sessionId: shared.sessionId,
    runtimeStatus: shared.runtimeStatus,
    title: shared.title,
    projectPath: null,
    parentSessionId: shared.parentSessionId,
    clientId: null,
    clientName: shared.clientName,
    nativeStartedAt: null,
    nativeUpdatedAt: null,
    activityAt: shared.activityAt,
    flowletObserved: shared.flowletObserved,
    startedAt: shared.activityAt,
    updatedAt: shared.activityAt,
    requestCount: shared.requestCount,
    successCount: Math.max(0, shared.requestCount - shared.errorCount),
    errorCount: shared.errorCount,
    knownTokens: shared.knownTokens,
    inputTokens: 0,
    inputCachedTokens: 0,
    inputUncachedTokens: 0,
    cacheMeasuredInputTokens: 0,
    outputTokens: 0,
    unknownUsageCount: 0,
    estimatedCost: 0,
    estimatedInputUncachedCost: 0,
    estimatedInputCachedCost: 0,
    estimatedInputCacheWriteCost: 0,
    estimatedOutputCost: 0,
    nativeSummary: (shared.nativeTurnCount != null || shared.nativeTotalTokens != null)
      ? {
          sourceAvailable: true,
          truncated: shared.nativeTruncated ?? false,
          turnCount: shared.nativeTurnCount ?? 0,
          usage: nativeUsage,
          models: [],
        } satisfies AgentSessionNativeSummary
      : null,
    remoteDeviceId: deviceId,
    remoteDeviceName: deviceName,
    remoteEvents: toRemoteInteractionEvents(shared),
  };
}

/** 把快照携带的最近一次交互事件映射为图表可渲染的交互事件（kind 与本地时间线同源）。 */
function toRemoteInteractionEvents(shared: SharedAgentSession): AgentSessionInteractionEvent[] | undefined {
  const events = shared.lastInteraction?.events;
  if (!events || events.length === 0) return undefined;
  return events.map((event) => ({
    id: event.id,
    kind: event.kind as AgentSessionInteractionEvent["kind"],
    source: "agent-native",
    timestamp: event.timestamp,
    title: event.title,
    content: event.content,
    model: event.model,
    status: event.status,
    durationMs: null,
    timeToFirstTokenMs: null,
    usage: null,
  }));
}

/** 远端会话的搜索 / 客户端 / 运行状态筛选在本地完成（快照为全量列表）。 */
function filterSharedSessions(rows: AgentSessionRow[], filter: AgentSessionFilter): AgentSessionRow[] {
  const search = filter.search.trim().toLowerCase();
  return rows.filter((row) => {
    if (filter.agentType && row.agentType !== filter.agentType) return false;
    if (filter.runtimeStatus && row.runtimeStatus !== filter.runtimeStatus) return false;
    if (!search) return true;
    const haystack = [row.title, row.sessionId, row.clientName, row.clientId].filter(Boolean).join(" ").toLowerCase();
    return haystack.includes(search);
  });
}
