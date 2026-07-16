import { useEffect, useState } from "react";
import { Button, Input, Pagination, Select, Toast, Tooltip, Typography } from "@douyinfe/semi-ui-19";
import { IconDelete, IconRefresh, IconSearch } from "@douyinfe/semi-icons";
import { DEFAULT_REQUEST_LOG_FILTER, type RequestLogFilter, type RequestLogStatusFilter, type RequestLogTimeRange } from "../../domains/request-log/types";
import { ClearRequestLogsModal } from "../../features/request-logs/ClearRequestLogsModal";
import { RequestLogDetailSideSheet } from "../../features/request-logs/RequestLogDetailSideSheet";
import { RequestLogTable } from "../../features/request-logs/RequestLogTable";
import { formatDuration, formatPercentage, formatTokenRate, safeLogText } from "../../features/request-logs/logPresentation";
import { useRequestLogActions, useRequestLogClients, useRequestLogModels, useRequestLogs } from "../../features/request-logs/useRequestLogs";
import secondaryButtonStyles from "../../shared/ui/SecondaryButton.module.css";
import styles from "./RequestLogsPage.module.css";
import { useAppPreferences } from "../../app/preferences/AppPreferences";

const { Paragraph, Text, Title } = Typography;

const TIME_OPTIONS: Array<{ value: RequestLogTimeRange; label: string }> = [
  { value: "1h", label: "最近 1 小时" },
  { value: "6h", label: "最近 6 小时" },
  { value: "today", label: "今天" },
  { value: "7d", label: "最近 7 天" },
  { value: "all", label: "全部时间" },
];

export function RequestLogsPage() {
  const { language, t } = useAppPreferences();
  const initialSearch = initialSearchFromHash();
  const [filter, setFilter] = useState<RequestLogFilter>(() => ({ ...DEFAULT_REQUEST_LOG_FILTER, search: initialSearch }));
  const [searchDraft, setSearchDraft] = useState(initialSearch);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const [clearOpen, setClearOpen] = useState(false);
  const [clientSelectValue, setClientSelectValue] = useState("__all__");
  const logs = useRequestLogs(filter, autoRefresh);
  const models = useRequestLogModels();
  const clients = useRequestLogClients();
  const actions = useRequestLogActions();
  const page = logs.data;
  const summary = page?.summary;

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const search = searchDraft.trim();
      setFilter((current) => current.search === search ? current : { ...current, search, page: 1 });
    }, 280);
    return () => window.clearTimeout(timer);
  }, [searchDraft]);

  const apply = (patch: Partial<RequestLogFilter>) => setFilter((current) => ({ ...current, ...patch, page: patch.page ?? 1 }));

  const cleanup = async (keepDays: number) => {
    try {
      const [deletedLogs, deletedUsage] = await actions.cleanup.mutateAsync(keepDays);
      setClearOpen(false);
      Toast.success(t("已清理 {logs} 条请求日志、{usage} 条用量记录", { logs: deletedLogs, usage: deletedUsage }));
    } catch (error) {
      Toast.error(t("日志清理失败：{message}", { message: safeLogText(error instanceof Error ? error.message : String(error)) }));
    }
  };

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div><Title heading={3} style={{ margin: 0 }}>{t("请求日志")}</Title><Paragraph type="tertiary" style={{ margin: 0 }}>{t("查看代理服务的实时请求、模型路由和 Token 消耗")}</Paragraph></div>
        <button type="button" className={`${styles.liveIndicator} ${autoRefresh ? styles.live : ""}`} onClick={() => setAutoRefresh((value) => !value)}>
          <i />{t(autoRefresh ? "实时更新中" : "实时更新已暂停")}
        </button>
      </header>

      <section className={styles.stats} aria-label={t("日志统计")}>
        <StatCard label={t("请求数")} value={formatInteger(summary?.requestCount, language)} hint={t("失败 {count} 条", { count: formatInteger(summary?.errorCount, language) })} />
        <StatCard label={t("成功率")} value={formatRate(summary?.successCount, summary?.requestCount)} hint={t("当前筛选范围")} success />
        <StatCard label={t("平均总耗时")} value={formatDuration(summary?.averageDurationMs ?? null)} hint={`TTFT ${formatDuration(summary?.averageTtftMs ?? null)}`} />
        <StatCard label={t("平均输出速率")} value={formatTokenRate(summary?.averageOutputTokensPerSecond)} hint={t("从首 Token 到完成")} />
        <StatCard label={t("Token 消耗")} value={formatCompactNumber(summary?.knownTokens, language)} hint={t("缓存命中率 {rate}", { rate: formatPercentage(summary?.cacheHitRate) })} />
      </section>

      <section className={styles.toolbar} aria-label={t("日志筛选")}>
        <Input className={styles.search} prefix={<IconSearch />} value={searchDraft} placeholder={t("搜索请求 ID、模型、账号或会话")} showClear onChange={setSearchDraft} />
        <Select value={filter.timeRange} optionList={TIME_OPTIONS.map((option) => ({ ...option, label: t(option.label) }))} onChange={(value) => apply({ timeRange: value as RequestLogTimeRange })} aria-label={t("时间")} />
        <Select
          value={clientSelectValue}
          loading={clients.isLoading}
          optionList={[
            { value: "__all__", label: t("全部客户端") },
            ...(clients.data ?? []).map((client) => ({
              value: client.id || "__unknown__",
              label: client.name || client.id || t("未知客户端"),
            })),
          ]}
          onChange={(value) => {
            const selected = Array.isArray(value) ? value[0] ?? "__all__" : value ?? "__all__";
            setClientSelectValue(selected);
            setFilter((current) => ({
              ...current,
              clientId: selected === "__all__" ? "" : selected,
              page: 1,
            }));
          }}
          aria-label={t("客户端")}
        />
        <Select
          value={filter.model || "__all__"}
          loading={models.isLoading}
          optionList={[{ value: "__all__", label: t("全部模型") }, ...(models.data ?? []).map((model) => ({ value: model, label: model }))]}
          onChange={(value) => apply({ model: value === "__all__" ? "" : String(value) })}
          aria-label="模型筛选"
        />
        <div className={styles.statusFilter}>
          {(["all", "success", "error"] as RequestLogStatusFilter[]).map((status) => (
            <button key={status} type="button" className={filter.status === status ? styles.activeStatus : ""} onClick={() => apply({ status })}>
              {t(status === "all" ? "全部" : status === "success" ? "成功" : "失败")}
            </button>
          ))}
        </div>
        <span className={styles.toolbarSpacer} />
        <Tooltip content={t("清理历史日志")}><Button aria-label={t("清理历史日志")} icon={<IconDelete />} type="danger" theme="borderless" onClick={() => setClearOpen(true)} /></Tooltip>
        <Button
          className={`${secondaryButtonStyles.button} ${secondaryButtonStyles.compact}`}
          icon={<IconRefresh />}
          type="tertiary"
          theme="outline"
          loading={logs.isFetching}
          onClick={() => void logs.refetch()}
        >
          {t("刷新")}
        </Button>
      </section>

      <section className={styles.tableCard}>
        {logs.isError ? <div className={styles.error}><span><strong>{t("请求日志加载失败")}</strong>{safeLogText(logs.error.message)}</span><Button onClick={() => void logs.refetch()}>{t("重试")}</Button></div> : null}
        {!logs.isError ? <RequestLogTable rows={page?.rows ?? []} loading={logs.isLoading} onOpenDetail={setSelectedRequestId} /> : null}
        <footer className={styles.tableFooter}>
          <Text type="tertiary" size="small">{t("共 {total} 条记录 · 当前显示 {count} 条", { total: page?.total ?? 0, count: page?.rows.length ?? 0 })}</Text>
          <Pagination total={page?.total ?? 0} currentPage={filter.page} pageSize={filter.pageSize} onPageChange={(pageNumber) => apply({ page: pageNumber })} />
        </footer>
      </section>

      {selectedRequestId ? <RequestLogDetailSideSheet key={selectedRequestId} requestId={selectedRequestId} onClose={() => setSelectedRequestId(null)} /> : null}
      {clearOpen ? <ClearRequestLogsModal total={page?.total ?? 0} loading={actions.cleanup.isPending} onCancel={() => setClearOpen(false)} onConfirm={(keepDays) => void cleanup(keepDays)} /> : null}
    </main>
  );
}

function StatCard({ label, value, hint, success = false }: { label: string; value: string; hint: string; success?: boolean }) {
  return <div className={styles.statCard}><span>{label}</span><div><strong>{value}</strong><small className={success ? styles.successHint : ""}>{hint}</small></div></div>;
}

function formatInteger(value: number | undefined, language: "zh-CN" | "en-US") { return (value ?? 0).toLocaleString(language); }
function formatRate(success?: number, total?: number) { return total ? `${((success ?? 0) / total * 100).toFixed(1)}%` : "—"; }
function formatCompactNumber(value: number | undefined, language: "zh-CN" | "en-US") {
  const amount = value ?? 0;
  if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(2)}M`;
  if (amount >= 1_000) return `${(amount / 1_000).toFixed(1)}K`;
  return amount.toLocaleString(language);
}

function initialSearchFromHash() {
  const queryIndex = window.location.hash.indexOf("?");
  if (queryIndex < 0) return "";
  return new URLSearchParams(window.location.hash.slice(queryIndex + 1)).get("search") ?? "";
}
