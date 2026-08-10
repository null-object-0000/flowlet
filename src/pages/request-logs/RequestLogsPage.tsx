import { useEffect, useState } from "react";
import { Button, Input, Pagination, Select, Toast, Tooltip } from "@douyinfe/semi-ui-19";
import { IconDelete, IconSearch } from "@douyinfe/semi-icons";
import { useLocation, useNavigate } from "react-router-dom";
import { DEFAULT_REQUEST_LOG_FILTER, type RequestLogFilter, type RequestLogRow, type RequestLogStatusFilter, type RequestLogTimeRange } from "../../domains/request-log/types";
import { ClearRequestLogsModal } from "../../features/request-logs/ClearRequestLogsModal";
import { RequestLogDetailSideSheet } from "../../features/request-logs/RequestLogDetailSideSheet";
import { calculateCacheHitRate, calculateOutputTokenRate, formatDuration, formatPercentage, formatTokenRate, isSuccessfulLog, safeLogText } from "../../features/request-logs/logPresentation";
import { useRequestLogActions, useRequestLogClients, useRequestLogModels, useRequestLogs } from "../../features/request-logs/useRequestLogs";
import { RequestLogsView, type RequestLogsRowModel } from "@flowlet/product-ui";
import { TokenBreakdownTooltip } from "../../shared/ui/TokenBreakdownTooltip";
import { CostBreakdownTooltip } from "../../shared/ui/CostBreakdownTooltip";
import { CompactNumber } from "../../shared/ui/CompactNumber";
import { PageHeader } from "../../shared/ui/PageHeader";
import { RefreshControl } from "../../shared/ui/RefreshControl";
import { useRefreshControl } from "../../shared/ui/useRefreshControl";
import styles from "./RequestLogsPage.module.css";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import { formatCostCny } from "../../shared/formatters/cost";
import { formatTimestamp } from "../../shared/formatters/datetime";
import { formatCompactNumber, formatInteger } from "../../shared/formatters/number";
import { TimePresetSelect, TimeScopeControl } from "../../shared/ui/TimeScopeControl";

const TIME_OPTIONS: Array<{ value: RequestLogTimeRange; label: string }> = [
  { value: "1h", label: "最近 1 小时" },
  { value: "6h", label: "最近 6 小时" },
  { value: "today", label: "今天" },
  { value: "7d", label: "最近 7 天" },
  { value: "all", label: "全部时间" },
];

export function RequestLogsPage() {
  const { language, t } = useAppPreferences();
  const location = useLocation();
  const navigate = useNavigate();
  const initialSearch = initialSearchFromHash();
  const [filter, setFilter] = useState<RequestLogFilter>(() => ({ ...DEFAULT_REQUEST_LOG_FILTER, search: initialSearch }));
  const [searchDraft, setSearchDraft] = useState(initialSearch);
  const refresh = useRefreshControl({ intervalMs: 5_000 });
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const [clearOpen, setClearOpen] = useState(false);
  const [clientSelectValue, setClientSelectValue] = useState("__all__");
  const logs = useRequestLogs(filter, refresh.autoRefresh);
  const models = useRequestLogModels();
  const clients = useRequestLogClients();
  const actions = useRequestLogActions();
  const page = logs.data;
  const summary = page?.summary;
  // 分组只在「有数据」时才作为 Select 的顶层子节点出现：Semi 仅按顶层子节点 key 判断
  // 选项是否变化，若分组始终存在（空→填充），key 不变就不会重新收集，下拉会一直为空。
  const publicModels = models.data?.publicModels ?? [];
  const upstreamModels = models.data?.upstreamModels ?? [];

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const search = searchDraft.trim();
      setFilter((current) => current.search === search ? current : { ...current, search, page: 1 });
    }, 280);
    return () => window.clearTimeout(timer);
  }, [searchDraft]);

  // 详情弹窗内的会话 ID 链接会写入 location.search（HashRouter 下走
  // history.pushState，不会触发 hashchange），所以这里监听 react-router 的
  // location 对象来同步搜索词。这样同页点击会话 ID 链接也能立即触发筛选。
  useEffect(() => {
    const search = new URLSearchParams(location.search).get("search") ?? "";
    setSearchDraft((current) => current === search ? current : search);
    setFilter((current) => current.search === search ? current : { ...current, search, page: 1 });
  }, [location]);

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
      <PageHeader title={t("请求日志")} subtitle={t("查看代理服务的实时请求、模型路由和 Token 消耗")}>
        <TimeScopeControl>
          <TimePresetSelect
            value={filter.timeRange}
            options={TIME_OPTIONS.map((option) => ({ ...option, label: t(option.label) }))}
            onChange={(timeRange) => apply({ timeRange })}
            ariaLabel={t("时间范围")}
          />
        </TimeScopeControl>
        <RefreshControl
          autoRefresh={refresh.autoRefresh}
          onToggleAutoRefresh={refresh.toggleAutoRefresh}
          isFetching={logs.isFetching}
          lastUpdatedAt={logs.dataUpdatedAt}
          intervalMs={refresh.intervalMs}
          onRefresh={() => void logs.refetch()}
          language={language}
          t={t}
        />
      </PageHeader>

      {logs.isError ? <div className={styles.error}><span><strong>{t("请求日志加载失败")}</strong>{safeLogText(logs.error.message)}</span><Button onClick={() => void logs.refetch()}>{t("重试")}</Button></div> : null}

      <RequestLogsView
        stats={[
          { key: "success", label: t("成功率"), value: formatRate(summary?.successCount, summary?.requestCount), hint: t("当前筛选范围"), success: true },
          { key: "duration", label: t("平均总耗时"), value: formatDuration(summary?.averageDurationMs ?? null), hint: `TTFT ${formatDuration(summary?.averageTtftMs ?? null)}` },
          { key: "rate", label: t("平均输出速率"), value: formatTokenRate(summary?.averageOutputTokensPerSecond), hint: t("从首 Token 到完成") },
          { key: "tokens", label: t("Token 消耗"), value: formatCompactNumber(summary?.knownTokens, language), hint: t("缓存命中率 {rate}", { rate: formatPercentage(summary?.cacheHitRate) }) },
        ]}
        rows={toRequestLogRowModels(page?.rows ?? [], language, t)}
        loading={!logs.isError && logs.isLoading}
        renderToken={(_, index) => {
          const row = (page?.rows ?? [])[index];
          if (!row) return <span>—</span>;
          return (
            <TokenBreakdownTooltip
              language={language}
              t={t}
              tokens={{
                total: row.total_tokens,
                input: row.input_tokens,
                cachedInput: row.input_cached_tokens,
                uncachedInput: row.input_uncached_tokens,
                output: row.output_tokens,
                cacheHitRate: calculateCacheHitRate(row),
              }}
            >
              <CompactNumber className={styles.tokenTotal} value={row.total_tokens} language={language} />
            </TokenBreakdownTooltip>
          );
        }}
        renderCost={(_, index) => {
          const row = (page?.rows ?? [])[index];
          if (!row) return <span>—</span>;
          return (
            <CostBreakdownTooltip
              t={t}
              total={row.estimated_cost}
              inputUncached={row.estimated_input_uncached_cost}
              inputCached={row.estimated_input_cached_cost}
              inputCacheWrite={row.estimated_input_cache_write_cost}
              output={row.estimated_output_cost}
              currency="CNY"
            >
              <span className={styles.tokenTotal}>{formatCostCny(row.estimated_cost)}</span>
            </CostBreakdownTooltip>
          );
        }}
        labels={{
          time: t("时间"),
          client: t("客户端"),
          modelInterface: t("模型 / 接口"),
          channelAccount: t("渠道 / 账号"),
          status: t("状态"),
          performance: t("性能"),
          token: "Token",
          cost: t("费用"),
          stream: t("流式"),
          emptyTitle: t("没有找到请求日志"),
          emptyDesc: t("发起一次模型请求，或调整当前筛选条件后再试。"),
        }}
        toolbar={(
          <section className={styles.toolbar} aria-label={t("日志筛选")}>
            <Input className={styles.search} prefix={<IconSearch />} value={searchDraft} placeholder={t("搜索请求 ID、模型、账号或会话")} showClear onChange={setSearchDraft} />
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
              value={filter.model && filter.modelKind ? `${filter.modelKind}:${filter.model}` : "__all__"}
              loading={models.isLoading}
              onChange={(value) => {
                const raw = String(value);
                if (raw === "__all__") {
                  apply({ model: "", modelKind: "" });
                  return;
                }
                // 选项值编码为 "<kind>:<model>"，仅按第一个冒号切分，避免模型名含冒号时误判。
                const separator = raw.indexOf(":");
                const kind = raw.slice(0, separator);
                const model = raw.slice(separator + 1);
                apply({ model, modelKind: kind === "upstream" ? "upstream" : "public" });
              }}
              // Semi UI Select 单选内部用 Map<label,option> 判定选中，要求 label 全局唯一。
              // 同名模型在两个 OptGroup 下 label 会冲突，导致两个分组都被画勾。
              // 这里 label 携带维度前缀仅供 Semi 内部区分；显示文本由 renderOptionItem
              // 自定义为纯模型名，避免前缀污染下拉列表和触发器。
              aria-label="模型筛选"
            >
              <Select.Option value="__all__">{t("全部模型")}</Select.Option>
              {publicModels.length > 0 ? (
                <Select.OptGroup key="public" label={t("对外模型")}>
                  {publicModels.map((model) => (
                    <Select.Option
                      key={`public-${model}`}
                      value={`public:${model}`}
                      label={t("对外模型") + " · " + model}
                      renderOptionItem={() => model}
                    />
                  ))}
                </Select.OptGroup>
              ) : null}
              {upstreamModels.length > 0 ? (
                <Select.OptGroup key="upstream" label={t("路由模型")}>
                  {upstreamModels.map((model) => (
                    <Select.Option
                      key={`upstream-${model}`}
                      value={`upstream:${model}`}
                      label={t("路由模型") + " · " + model}
                      renderOptionItem={() => model}
                    />
                  ))}
                </Select.OptGroup>
              ) : null}
            </Select>
            <div className={styles.statusFilter}>
              {(["all", "success", "error"] as RequestLogStatusFilter[]).map((status) => (
                <button key={status} type="button" className={filter.status === status ? styles.activeStatus : ""} onClick={() => apply({ status })}>
                  {t(status === "all" ? "全部" : status === "success" ? "成功" : "失败")}
                </button>
              ))}
            </div>
            <span className={styles.toolbarSpacer} />
            <Tooltip content={t("清理历史日志")}><Button aria-label={t("清理历史日志")} icon={<IconDelete />} type="danger" theme="borderless" onClick={() => setClearOpen(true)} /></Tooltip>
          </section>
        )}
        footer={(
          <>
            <div className={styles.footerStats}>
              <span>{t("请求 {count} 条", { count: formatInteger(page?.total ?? 0, language) })}</span>
              <span className={(summary?.errorCount ?? 0) > 0 ? styles.footerErrorCount : undefined}>{t("失败 {count} 条", { count: formatInteger(summary?.errorCount ?? 0, language) })}</span>
              <span>{t("当前显示 {count} 条", { count: page?.rows.length ?? 0 })}</span>
            </div>
            <Pagination total={page?.total ?? 0} currentPage={filter.page} pageSize={filter.pageSize} onPageChange={(pageNumber) => apply({ page: pageNumber })} />
          </>
        )}
        onOpenRow={setSelectedRequestId}
      />

      {selectedRequestId ? (
        <RequestLogDetailSideSheet
          key={selectedRequestId}
          requestId={selectedRequestId}
          onClose={() => setSelectedRequestId(null)}
          onNavigate={(path) => {
            setSelectedRequestId(null);
            navigate(path);
          }}
        />
      ) : null}
      {clearOpen ? <ClearRequestLogsModal total={page?.total ?? 0} loading={actions.cleanup.isPending} onCancel={() => setClearOpen(false)} onConfirm={(keepDays) => void cleanup(keepDays)} /> : null}
    </main>
  );
}

/** 把领域行映射为共享展示模型：文案与数值已在此处完成本地化与格式化。 */
function toRequestLogRowModels(rows: RequestLogRow[], language: "zh-CN" | "en-US", t: (key: string, values?: Record<string, string | number>) => string): RequestLogsRowModel[] {
  return rows.map((row) => {
    const success = isSuccessfulLog(row);
    const outputRate = calculateOutputTokenRate(row);
    const cacheHit = calculateCacheHitRate(row);
    return {
      id: row.request_id,
      ariaLabel: t("查看请求 {id}", { id: row.request_id }),
      time: formatTimestamp(row.created_at, language),
      client: row.client_name || row.client_id || t("未知客户端"),
      model: row.public_model || row.virtual_model || "-",
      method: row.method,
      path: row.path.split("?")[0],
      channel: row.channel_name || row.channel_id || t("未路由"),
      account: row.account_name || row.account_id || "-",
      status: success ? "success" : "failure",
      statusLabel: t(success ? "成功" : "失败"),
      duration: formatDuration(row.duration_ms ?? row.latency_ms),
      streaming: row.is_stream || undefined,
      detail: `${row.ttft_ms == null ? "TTFT —" : `TTFT ${formatDuration(row.ttft_ms)}`} · ${formatTokenRate(outputRate)}`,
      tokens: row.total_tokens == null ? undefined : formatCompactNumber(row.total_tokens, language),
      tokenHint: row.total_tokens == null ? undefined : [
        `${t("输入")} ${formatCompactNumber(row.input_tokens, language)}`,
        `${t("缓存命中率")} ${formatPercentage(cacheHit)}`,
      ].join(" · "),
      cost: row.estimated_cost == null ? undefined : formatCostCny(row.estimated_cost),
    };
  });
}

function formatRate(success?: number, total?: number) { return total ? `${((success ?? 0) / total * 100).toFixed(1)}%` : "—"; }

function initialSearchFromHash() {
  const queryIndex = window.location.hash.indexOf("?");
  if (queryIndex < 0) return "";
  return new URLSearchParams(window.location.hash.slice(queryIndex + 1)).get("search") ?? "";
}
