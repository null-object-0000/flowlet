import { IconBarChartVStroked, IconChevronRight } from "@douyinfe/semi-icons";
import { Button, Pagination, SideSheet } from "@douyinfe/semi-ui-19";
import { useMemo, useState } from "react";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import { useDeviceDailyUsage, useDeviceHourlyUsage, useKnownDevices } from "../../features/device-sync/useDeviceSync";
import { DeviceUsageTitlePicker } from "../../features/device-sync/DeviceUsageTitlePicker";
import { PageHeader } from "../../shared/ui/PageHeader";
import { RefreshControl } from "../../shared/ui/RefreshControl";
import { useRefreshControl } from "../../shared/ui/useRefreshControl";
import { formatCompactNumber, formatInteger, type NumberLanguage } from "../../shared/formatters/number";
import { formatCostCny } from "../../shared/formatters/cost";
import { DEFAULT_REQUEST_LOG_FILTER } from "../../domains/request-log/types";
import { useRequestLogs } from "../../features/request-logs/useRequestLogs";
import { RequestLogDetailSideSheet } from "../../features/request-logs/RequestLogDetailSideSheet";
import { formatTimestamp } from "../../shared/formatters/datetime";
import { APP_OVERLAY_Z_INDEX } from "../../shared/ui/overlayLayers";
import { DETAIL_SHEET_WIDTH } from "../../shared/ui/drawerWidth";
import { TimePeriodSwitch, TimeRangeNavigator, TimeScopeControl } from "../../shared/ui/TimeScopeControl";
import { UsageTokenDetailSheet } from "../../features/usage/UsageTokenDetailSheet";
import type { DailyUsageTotal } from "../../domains/device-sync/types";
import {
  buildMobileUsageHeatmap,
  buildMobileDailyHourlyHeatmap,
  buildUsageTokenDetails,
  buildWeekdayHourHeatmap,
  filterMobileUsage,
  formatMobileUsageRange,
  getMobileUsageRange,
  summarizeMobileUsage,
  type MobileUsageHeatmapMetric,
  type MobileUsagePeriod,
  type UsageTokenDetails,
} from "../../features/usage/deviceUsagePresentation";
import styles from "./UsageCostPage.module.css";

export function UsageCostPage() {
  const { language, t } = useAppPreferences();
  const refresh = useRefreshControl({ intervalMs: 30_000 });
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [period, setPeriod] = useState<MobileUsagePeriod>("day");
  const [periodOffset, setPeriodOffset] = useState(0);
  const [heatmapMetric, setHeatmapMetric] = useState<MobileUsageHeatmapMetric>("tokens");
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [selectedHour, setSelectedHour] = useState<string | null>(null);
  const [unknownRequestsOpen, setUnknownRequestsOpen] = useState(false);
  const [unknownRequestsScope, setUnknownRequestsScope] = useState<"period" | "selected">("selected");
  const [unknownRequestsPage, setUnknownRequestsPage] = useState(1);
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const [tokenDetailsScope, setTokenDetailsScope] = useState<"period" | "selected" | null>(null);
  const devices = useKnownDevices();
  const usage = useDeviceDailyUsage(deviceId, true, refresh.autoRefresh);
  const hourlyUsage = useDeviceHourlyUsage(deviceId, true, refresh.autoRefresh);
  const now = useMemo(() => new Date(), []);
  const range = useMemo(
    () => getMobileUsageRange(period, periodOffset, now),
    [now, period, periodOffset],
  );
  const rangeLabel = useMemo(
    () => formatMobileUsageRange(range, period, language),
    [language, period, range],
  );
  const days = useMemo(
    () => filterMobileUsage(usage.data ?? [], period, periodOffset, now),
    [now, period, periodOffset, usage.data],
  );
  const summary = useMemo(() => summarizeMobileUsage(days), [days]);
  const periodUnknownRequests = useMemo(
    () => days.reduce((total, day) => total + day.unknownCount, 0),
    [days],
  );
  const summaryTokenDetails = buildUsageTokenDetails({
    proxyTotal: summary.tokens,
    proxyInput: summary.inputTokens,
    proxyCachedInput: summary.cachedInputTokens,
    proxyUncachedInput: summary.uncachedInputTokens,
    proxyCacheMeasuredInput: summary.cacheMeasuredInputTokens,
    proxyOutput: summary.outputTokens,
    proxyRequests: summary.requests,
    proxyUnknownUsageCount: periodUnknownRequests,
    nativeTotal: summary.nativeTokens,
    nativeInput: summary.nativeInputTokens,
    nativeCachedInput: summary.nativeCachedInputTokens,
    nativeCacheWriteInput: summary.nativeCacheWriteInputTokens,
    nativeOutput: summary.nativeOutputTokens,
    nativeReasoning: summary.nativeReasoningTokens,
    nativeEvents: summary.nativeEvents,
  });
  const heatmap = useMemo(
    () => buildMobileUsageHeatmap(usage.data ?? [], period, periodOffset, now, heatmapMetric),
    [heatmapMetric, now, period, periodOffset, usage.data],
  );
  const weekHourlyHeatmap = useMemo(
    () => buildWeekdayHourHeatmap(hourlyUsage.data ?? [], periodOffset, now, heatmapMetric),
    [heatmapMetric, hourlyUsage.data, now, periodOffset],
  );
  const dailyHourlyChart = useMemo(
    () => buildMobileDailyHourlyHeatmap(hourlyUsage.data ?? [], periodOffset, now, heatmapMetric),
    [heatmapMetric, hourlyUsage.data, now, periodOffset],
  );
  const activeHourlyHeatmap = period === "day" ? dailyHourlyChart : weekHourlyHeatmap;
  const dailyChartMax = useMemo(
    () => Math.max(0, ...dailyHourlyChart.cells
      .filter((cell) => !cell.future)
      .map((cell) => heatmapMetric === "tokens" ? cell.tokens : cell.estimatedCost)),
    [dailyHourlyChart.cells, heatmapMetric],
  );
  const selectedDay = useMemo(() => {
    if (selectedDate) {
      return (usage.data ?? []).find((day) => day.date === selectedDate) ?? emptyDailyUsage(selectedDate);
    }
    return [...days].sort((left, right) => right.date.localeCompare(left.date))[0] ?? null;
  }, [days, selectedDate, usage.data]);
  const selectedHourlyCell = useMemo(
    () => activeHourlyHeatmap.cells.find((cell) => cell.hour === selectedHour)
      ?? activeHourlyHeatmap.cells
        .filter((cell) => cell.hasData)
        .sort((left, right) => right.hour.localeCompare(left.hour))[0]
      ?? null,
    [activeHourlyHeatmap.cells, selectedHour],
  );
  const weekdayLabels = useMemo(
    () => Array.from(
      { length: 7 },
      (_, index) => new Date(2026, 6, 13 + index).toLocaleDateString(language, { weekday: "narrow" }),
    ),
    [language],
  );
  const selectedPeriod = period === "month" ? selectedDay : selectedHourlyCell;
  const selectedPeriodTitle = period !== "month" && selectedHourlyCell
    ? selectedHourlyCell.date + " " + String(selectedHourlyCell.hourOfDay).padStart(2, "0")
      + ":00–" + String(selectedHourlyCell.hourEnd - 1).padStart(2, "0") + ":59"
    : selectedDay?.date ?? null;
  const selectedTokenDetails = useMemo(() => {
    if (period === "month") {
      if (!selectedDay) return null;
      return buildUsageTokenDetails({
        proxyTotal: selectedDay.knownTokens,
        proxyInput: selectedDay.inputTokens,
        proxyCachedInput: selectedDay.inputCachedTokens,
        proxyUncachedInput: selectedDay.inputUncachedTokens,
        proxyCacheMeasuredInput: selectedDay.cacheMeasuredInputTokens,
        proxyOutput: selectedDay.outputTokens,
        proxyRequests: selectedDay.requestCount,
        proxyUnknownUsageCount: selectedDay.unknownCount,
        nativeTotal: selectedDay.nativeTotalTokens ?? 0,
        nativeInput: selectedDay.nativeInputTokens ?? 0,
        nativeCachedInput: selectedDay.nativeCachedInputTokens ?? 0,
        nativeCacheWriteInput: selectedDay.nativeCacheWriteInputTokens ?? 0,
        nativeOutput: selectedDay.nativeOutputTokens ?? 0,
        nativeReasoning: selectedDay.nativeReasoningTokens ?? 0,
        nativeEvents: selectedDay.nativeEventCount ?? 0,
      });
    }
    if (!selectedHourlyCell) return null;
    const nativeMeasuredInput = selectedHourlyCell.nativeInputTokens
      + selectedHourlyCell.nativeCachedInputTokens
      + selectedHourlyCell.nativeCacheWriteInputTokens;
    const proxyInput = Math.max(0, selectedHourlyCell.inputTokens - nativeMeasuredInput);
    const proxyCachedInput = Math.max(0, selectedHourlyCell.cachedInputTokens - selectedHourlyCell.nativeCachedInputTokens);
    return buildUsageTokenDetails({
      proxyTotal: Math.max(0, selectedHourlyCell.tokens - selectedHourlyCell.nativeTokens),
      proxyInput,
      proxyCachedInput,
      proxyUncachedInput: Math.max(0, proxyInput - proxyCachedInput),
      proxyCacheMeasuredInput: Math.max(0, selectedHourlyCell.cacheMeasuredInputTokens - nativeMeasuredInput),
      proxyOutput: Math.max(0, selectedHourlyCell.outputTokens - selectedHourlyCell.nativeOutputTokens),
      proxyRequests: Math.max(0, selectedHourlyCell.requests - selectedHourlyCell.nativeEvents),
      proxyUnknownUsageCount: selectedHourlyCell.unknownRequests,
      nativeTotal: selectedHourlyCell.nativeTokens,
      nativeInput: selectedHourlyCell.nativeInputTokens,
      nativeCachedInput: selectedHourlyCell.nativeCachedInputTokens,
      nativeCacheWriteInput: selectedHourlyCell.nativeCacheWriteInputTokens,
      nativeOutput: selectedHourlyCell.nativeOutputTokens,
      nativeReasoning: selectedHourlyCell.nativeReasoningTokens,
      nativeEvents: selectedHourlyCell.nativeEvents,
    });
  }, [period, selectedDay, selectedHourlyCell]);
  const selectedLogRange = useMemo(
    () => getSelectedLogRange(
      period,
      selectedDay?.date ?? null,
      selectedHourlyCell?.hour ?? null,
      selectedHourlyCell?.hourEnd ?? null,
    ),
    [period, selectedDay?.date, selectedHourlyCell?.hour, selectedHourlyCell?.hourEnd],
  );
  const periodLogRange = useMemo(() => {
    const start = new Date(`${range.startDate}T00:00:00`);
    const end = new Date(`${range.endDate}T00:00:00`);
    end.setDate(end.getDate() + 1);
    return { startAt: start.toISOString(), endAt: end.toISOString() };
  }, [range.endDate, range.startDate]);
  const unknownRequestLogRange = unknownRequestsScope === "period"
    ? periodLogRange
    : selectedLogRange;
  const currentDevice = devices.data?.find((device) => device.isCurrent) ?? null;
  const canReadRequestDetails = deviceId == null || currentDevice?.deviceId === deviceId;
  const unknownRequestFilter = useMemo(() => ({
    ...DEFAULT_REQUEST_LOG_FILTER,
    page: unknownRequestsPage,
    pageSize: 8,
    startAt: unknownRequestLogRange?.startAt ?? "",
    endAt: unknownRequestLogRange?.endAt ?? "",
    tokenStatus: "unknown" as const,
  }), [unknownRequestLogRange, unknownRequestsPage]);
  const unknownRequestLogs = useRequestLogs(
    unknownRequestFilter,
    false,
    unknownRequestsOpen && canReadRequestDetails && unknownRequestLogRange != null,
  );
  // 日柱状图与周热力图依赖逐小时用量；月视图（日历热力图）依赖每日汇总。
  const activeQuery = period === "month" ? usage : hourlyUsage;
  const selectedTokenConfidence = useMemo(() => {
    const proxyRequests = period === "month"
      ? selectedDay?.requestCount ?? 0
      : Math.max(0, (selectedHourlyCell?.requests ?? 0) - (selectedHourlyCell?.nativeEvents ?? 0));
    const nativeEvents = period === "month"
      ? selectedDay?.nativeEventCount ?? 0
      : selectedHourlyCell?.nativeEvents ?? 0;
    const unknownRequests = period === "month"
      ? selectedDay?.unknownCount ?? 0
      : selectedHourlyCell?.unknownRequests ?? 0;
    return calculateTokenConfidence(proxyRequests, nativeEvents, unknownRequests);
  }, [period, selectedDay, selectedHourlyCell]);
  const periodTokenConfidence = useMemo(
    () => calculateTokenConfidence(
      summary.requests,
      summary.nativeEvents,
      periodUnknownRequests,
    ),
    [periodUnknownRequests, summary.nativeEvents, summary.requests],
  );

  const openUnknownRequests = (scope: "period" | "selected") => {
    setUnknownRequestsScope(scope);
    setUnknownRequestsPage(1);
    setUnknownRequestsOpen(true);
  };

  const periodConfidenceCard = (
    <TokenConfidenceCard
      periodTitle={rangeLabel}
      confidence={periodTokenConfidence}
      language={language}
      t={t}
      onShowUnknownRequests={() => openUnknownRequests("period")}
    />
  );

  const resetSelection = () => {
    setSelectedDate(null);
    setSelectedHour(null);
    setTokenDetailsScope(null);
  };
  const openTokenDetails = tokenDetailsScope === "selected" && selectedTokenDetails
    ? selectedTokenDetails
    : summaryTokenDetails;
  const openTokenDetailsLabel = tokenDetailsScope === "selected" && selectedPeriodTitle
    ? selectedPeriodTitle
    : rangeLabel;
  const unknownRequestsTitle = unknownRequestsScope === "period"
    ? rangeLabel
    : selectedPeriodTitle;

  return (
    <main className={[styles.page, styles.pageTimeline].join(" ")}>
      <PageHeader
        title={(
          <DeviceUsageTitlePicker
            devices={devices.data ?? []}
            deviceId={deviceId}
            title="用量统计"
            onChange={(value) => {
              setDeviceId(value);
              resetSelection();
            }}
          />
        )}
        subtitle={t("按设备和时间查看 Token 使用规模与活跃节奏")}
      >
        <TimeScopeControl>
          <TimePeriodSwitch
            value={period}
            options={([
              { value: "day", label: t("日") },
              { value: "week", label: t("周") },
              { value: "month", label: t("月") },
            ] as Array<{ value: MobileUsagePeriod; label: string }>)}
            onChange={(value) => {
              setPeriod(value);
              setPeriodOffset(0);
              resetSelection();
            }}
            ariaLabel={t("统计周期")}
          />
          <TimeRangeNavigator
            label={rangeLabel}
            previousLabel={period === "day" ? t("前一天") : period === "week" ? t("上一周") : t("上一月")}
            nextLabel={period === "day" ? t("后一天") : period === "week" ? t("下一周") : t("下一月")}
            onPrevious={() => {
              setPeriodOffset((offset) => offset - 1);
              resetSelection();
            }}
            onNext={() => {
              setPeriodOffset((offset) => Math.min(0, offset + 1));
              resetSelection();
            }}
            nextDisabled={periodOffset === 0}
          />
        </TimeScopeControl>
        <RefreshControl
          autoRefresh={refresh.autoRefresh}
          onToggleAutoRefresh={refresh.toggleAutoRefresh}
          isFetching={activeQuery.isFetching}
          lastUpdatedAt={activeQuery.dataUpdatedAt || undefined}
          intervalMs={refresh.intervalMs}
          onRefresh={() => void activeQuery.refetch()}
          language={language}
          t={t}
        />
      </PageHeader>

      <section className={styles.stats}>
        <button type="button" className={[styles.stat, styles.expandableStat].join(" ")} onClick={() => setTokenDetailsScope("period")} title={t("点击查看完整 Token 明细")}>
          <span>Tokens</span>
          <strong>{formatCompactNumber(summaryTokenDetails.total.total, language)}</strong>
          <small>{t("输入 {input} · 输出 {output}", {
            input: formatCompactNumber(summaryTokenDetails.total.input, language),
            output: formatCompactNumber(summaryTokenDetails.total.output, language),
          })}</small>
        </button>
        <article className={styles.stat}>
          <span>{t("请求量")}</span>
          <strong>{formatInteger(summary.requests + summary.nativeEvents, language)}</strong>
          <small>{summary.nativeEvents > 0
            ? t("代理 {proxy} · 原生 {native}", {
              proxy: formatInteger(summary.requests, language),
              native: formatInteger(summary.nativeEvents, language),
            })
            : t("{count} 天数据", { count: days.length })}</small>
        </article>
        <button type="button" className={[styles.stat, styles.expandableStat].join(" ")} onClick={() => setTokenDetailsScope("period")} title={t("点击查看完整 Token 明细")}>
          <span>{t("缓存输入")}</span>
          <strong>{formatCompactNumber(summaryTokenDetails.total.cachedInput, language)}</strong>
          <small>{t("缓存命中率")} {formatCacheHitRate(summaryTokenDetails.total.cacheHitRate)}</small>
        </button>
        <article className={styles.stat}>
          <span>{t("预估费用")}</span>
          <strong>{formatCostCny(summary.estimatedCost)}</strong>
          <small>{t("Flowlet 可统计用量")}</small>
        </article>
      </section>

      <section className={styles.periodConfidenceModule}>
        {periodConfidenceCard}
      </section>

      <section className={[styles.workspace, styles.workspaceTimeline].join(" ")}>
        <article className={[styles.card, styles.heatmapCard].join(" ")}>
          <div className={styles.cardHeader}>
            <div>
              <strong>{t(period === "day"
                ? heatmapMetric === "tokens" ? "24 小时 Token 柱状图" : "24 小时预估费用柱状图"
                : period === "week"
                  ? heatmapMetric === "tokens" ? "星期 × 小时 Token 热力图" : "星期 × 小时预估费用热力图"
                  : heatmapMetric === "tokens" ? "每日 Token 热力图" : "每日预估费用热力图")}</strong>
              <span>{t(period === "day"
                ? "横轴为小时，点击柱查看对应时段"
                : period === "week" ? "纵轴为星期、横轴为小时（24 小时制），点击查看对应时段"
                  : "点击日期查看当天汇总")}</span>
            </div>
            <HeatmapMetricSwitch value={heatmapMetric} onChange={setHeatmapMetric} t={t} />
          </div>

          {activeQuery.isPending && activeQuery.data == null ? (
            <div className={styles.state}><span>{t("正在加载用量…")}</span></div>
          ) : null}
          {activeQuery.isError ? (
            <div className={styles.state}>
              <strong>{t("用量数据加载失败")}</strong>
              <span>{activeQuery.error.message}</span>
              <Button size="small" onClick={() => void activeQuery.refetch()}>{t("重试")}</Button>
            </div>
          ) : null}

          {period === "day" && !activeQuery.isPending && !activeQuery.isError ? (
            <div className={styles.dailyBarFrame}>
              <div className={styles.dailyBarChart}>
                <div className={styles.dailyBarScale} aria-hidden="true">
                  <span>{heatmapMetric === "tokens"
                    ? formatCompactNumber(dailyChartMax, language)
                    : formatCostCny(dailyChartMax)}</span>
                  <span>0</span>
                </div>
                <div className={styles.dailyBarPlot}>
                  {dailyHourlyChart.cells.map((cell) => {
                    const hourLabel = String(cell.hourOfDay).padStart(2, "0");
                    const title = cell.date + " " + hourLabel + ":00–" + hourLabel + ":59 · "
                      + formatHeatmapValues(heatmapMetric, cell.tokens, cell.estimatedCost, language, t) + " · "
                      + t("{count} 次请求", { count: formatInteger(cell.requests, language) })
                      + formatNativeSplit(cell.tokens, cell.nativeTokens, language, t);
                    const value = heatmapMetric === "tokens" ? cell.tokens : cell.estimatedCost;
                    const ratio = dailyChartMax > 0 ? value / dailyChartMax : 0;
                    return (
                      <span
                        key={cell.hour}
                        className={styles.dailyBarSlot}
                      >
                        <button
                          type="button"
                          className={styles.dailyBar}
                          style={{ "--daily-bar-height": `${ratio * 100}%` } as React.CSSProperties}
                          disabled={cell.future}
                          data-has-data={cell.hasData}
                          aria-label={title}
                          aria-pressed={selectedHourlyCell?.hour === cell.hour}
                          title={title}
                          onClick={() => setSelectedHour(cell.hour)}
                        />
                      </span>
                    );
                  })}
                </div>
                <div className={styles.dailyBarHours} aria-hidden="true">
                  {dailyHourlyChart.cells.map((cell) => (
                    <span key={cell.hour}>{cell.hourOfDay % 2 === 0 ? String(cell.hourOfDay).padStart(2, "0") : ""}</span>
                  ))}
                </div>
              </div>
              {!dailyHourlyChart.cells.some((cell) => cell.hasData) ? (
                <div className={styles.emptyHint}>{t("当前周期暂无数据")}</div>
              ) : null}
            </div>
          ) : null}

          {period === "week" && !activeQuery.isPending && !activeQuery.isError ? (
            <div className={styles.weekHourlyFrame}>
              <div className={styles.weekHourlyHeatmap}>
                {weekdayLabels.map((label, weekdayIndex) => (
                  <span
                    key={"weekday-" + weekdayIndex}
                    className={[styles.weekHourlyWeekdayLabel, weekdayIndex >= 5 ? styles.weekend : ""].join(" ")}
                    style={{ gridColumn: 1, gridRow: weekdayIndex + 1 }}
                  >
                    {label}
                  </span>
                ))}
                {weekHourlyHeatmap.cells.map((cell, cellIndex) => {
                  // 构建器按天主序、小时内序排列：第 index 格子的星期 = floor(index / 24)。
                  const weekday = Math.floor(cellIndex / 24);
                  const hourLabel = String(cell.hourOfDay).padStart(2, "0");
                  const title = cell.date + " " + hourLabel + ":00–" + hourLabel + ":59 · "
                    + formatHeatmapValues(heatmapMetric, cell.tokens, cell.estimatedCost, language, t) + " · "
                    + t("{count} 次请求", { count: formatInteger(cell.requests, language) })
                    + formatNativeSplit(cell.tokens, cell.nativeTokens, language, t);
                  return (
                    <button
                      key={cell.hour}
                      type="button"
                      style={{ gridColumn: cell.hourOfDay + 2, gridRow: weekday + 1 }}
                      className={[
                        styles.weekHourlyCell,
                        styles["heatLevel" + cell.level],
                      ].join(" ")}
                      disabled={cell.future}
                      aria-label={title}
                      aria-pressed={selectedHourlyCell?.hour === cell.hour}
                      title={title}
                      onClick={() => setSelectedHour(cell.hour)}
                    />
                  );
                })}
                {Array.from({ length: 24 }, (_, hour) => (
                  <span
                    key={"hour-" + hour}
                    className={styles.weekHourlyHourLabel}
                    style={{ gridColumn: hour + 2, gridRow: 8 }}
                  >
                    {String(hour).padStart(2, "0")}
                  </span>
                ))}
              </div>
              <HeatmapLegend t={t} />
              {!weekHourlyHeatmap.cells.some((cell) => cell.hasData) ? (
                <div className={styles.emptyHint}>{t("当前周期暂无数据")}</div>
              ) : null}
            </div>
          ) : null}

          {period === "month" && !activeQuery.isPending && !activeQuery.isError ? (
            <div className={styles.monthHeatmapFrame}>
              <div className={styles.heatmapLabels}>
                {weekdayLabels.map((label, index) => <span key={index + "-" + label}>{label}</span>)}
              </div>
              <div className={styles.monthHeatmap}>
                {heatmap.cells.map((cell, cellIndex) => {
                  const title = cell.date + " · "
                    + formatHeatmapValues(heatmapMetric, cell.tokens, cell.estimatedCost, language, t) + " · "
                    + t("{count} 次请求", { count: formatInteger(cell.requests, language) })
                    + formatNativeSplit(cell.tokens, cell.nativeTokens, language, t);
                  return (
                    <button
                      key={cell.date}
                      type="button"
                      className={[
                        styles.heatmapCell,
                        styles["heatLevel" + cell.level],
                        cellIndex % 7 >= 5 ? styles.weekend : "",
                        cell.adjacentMonth ? styles.adjacentMonth : "",
                        cell.outside ? styles.outside : "",
                        cell.hasData ? styles.hasData : "",
                      ].join(" ")}
                      disabled={cell.future}
                      aria-label={title}
                      aria-pressed={selectedDay?.date === cell.date}
                      title={title}
                      onClick={() => setSelectedDate(cell.date)}
                    />
                  );
                })}
              </div>
              <HeatmapLegend t={t} />
              {days.length === 0 ? <div className={styles.emptyHint}>{t("当前周期暂无数据")}</div> : null}
            </div>
          ) : null}
        </article>

        <aside className={[styles.insightColumn, styles.insightTimeline].join(" ")}>

          {(period === "day" || period === "week") && selectedHourlyCell ? (
            <SelectedPeriodCard
              title={selectedPeriodTitle ?? selectedHourlyCell.date}
              inputTokens={selectedHourlyCell.inputTokens}
              outputTokens={selectedHourlyCell.outputTokens}
              requests={selectedHourlyCell.requests}
              proxyRequests={selectedHourlyCell.requests - selectedHourlyCell.nativeEvents}
              nativeEvents={selectedHourlyCell.nativeEvents}
              cachedInputTokens={selectedHourlyCell.cachedInputTokens}
              cacheMeasuredInputTokens={selectedHourlyCell.cacheMeasuredInputTokens}
              estimatedCost={selectedHourlyCell.estimatedCost}
              tokenDetails={selectedTokenDetails!}
              onExpandTokenDetails={() => setTokenDetailsScope("selected")}
              language={language}
              t={t}
              confidence={selectedTokenConfidence}
              onShowUnknownRequests={() => openUnknownRequests("selected")}
            />
          ) : null}

          {period === "month" && selectedDay ? (
            <SelectedPeriodCard
              title={selectedPeriodTitle ?? selectedDay.date}
              inputTokens={selectedDay.inputTokens
                + (selectedDay.nativeInputTokens ?? 0)
                + (selectedDay.nativeCachedInputTokens ?? 0)
                + (selectedDay.nativeCacheWriteInputTokens ?? 0)}
              outputTokens={selectedDay.outputTokens + (selectedDay.nativeOutputTokens ?? 0)}
              requests={selectedDay.requestCount + (selectedDay.nativeEventCount ?? 0)}
              proxyRequests={selectedDay.requestCount}
              nativeEvents={selectedDay.nativeEventCount ?? 0}
              cachedInputTokens={selectedDay.inputCachedTokens + (selectedDay.nativeCachedInputTokens ?? 0)}
              cacheMeasuredInputTokens={selectedDay.cacheMeasuredInputTokens
                + (selectedDay.nativeInputTokens ?? 0)
                + (selectedDay.nativeCachedInputTokens ?? 0)
                + (selectedDay.nativeCacheWriteInputTokens ?? 0)}
              estimatedCost={selectedDay.estimatedCost ?? 0}
              tokenDetails={selectedTokenDetails!}
              onExpandTokenDetails={() => setTokenDetailsScope("selected")}
              language={language}
              t={t}
              confidence={selectedTokenConfidence}
              onShowUnknownRequests={() => openUnknownRequests("selected")}
            />
          ) : null}

          {!selectedPeriod ? <SelectedPeriodEmpty t={t} /> : null}
        </aside>
      </section>

      <UsageTokenDetailSheet
        visible={tokenDetailsScope != null}
        onClose={() => setTokenDetailsScope(null)}
        contextLabel={openTokenDetailsLabel}
        details={openTokenDetails}
        language={language}
        t={t}
      />

      <SideSheet
        title={t("未识别 Token 的请求")}
        visible={unknownRequestsOpen && selectedRequestId == null}
        onCancel={() => setUnknownRequestsOpen(false)}
        width={DETAIL_SHEET_WIDTH}
        bodyStyle={{ padding: 0 }}
        zIndex={APP_OVERLAY_Z_INDEX.sideSheet}
        footer={null}
      >
        <div className={styles.unknownRequestsSheet}>
          <div className={styles.unknownRequestsIntro}>
            <strong>{unknownRequestsTitle ?? t("指定时间点")}</strong>
            <span>{deviceId == null
              ? t("全部设备的聚合用量中，仅本机保存了可展开的原始请求日志。")
              : canReadRequestDetails
                ? t("以下为当前设备在该时间段内尚未识别 Token 的请求。")
                : t("同步设备只包含聚合快照，不包含原始请求日志；请在来源设备上查看明细。")}</span>
          </div>
          {!canReadRequestDetails ? (
            <div className={styles.unknownRequestsState}>
              <strong>{t("此设备没有可读取的请求明细")}</strong>
              <span>{t("为避免同步敏感请求内容，设备用量同步目前只传输聚合统计。")}</span>
            </div>
          ) : unknownRequestLogs.isError ? (
            <div className={styles.unknownRequestsState}>
              <strong>{t("请求明细加载失败")}</strong>
              <span>{unknownRequestLogs.error.message}</span>
              <Button size="small" onClick={() => void unknownRequestLogs.refetch()}>{t("重试")}</Button>
            </div>
          ) : (
            <>
              <div className={styles.unknownRequestList} aria-label={t("未识别 Token 的请求列表")}>
                {unknownRequestLogs.isLoading ? (
                  <div className={styles.unknownRequestsState}><span>{t("正在加载请求明细…")}</span></div>
                ) : null}
                {!unknownRequestLogs.isLoading && (unknownRequestLogs.data?.rows.length ?? 0) === 0 ? (
                  <div className={styles.unknownRequestsState}>
                    <strong>{t("没有找到未识别 Token 的本机请求")}</strong>
                    <span>{t("数据可能已被完整性检查修复，或未识别请求来自其他同步设备。")}</span>
                  </div>
                ) : null}
                {!unknownRequestLogs.isLoading ? unknownRequestLogs.data?.rows.map((row) => (
                  <button
                    key={row.id}
                    type="button"
                    className={styles.unknownRequestRow}
                    onClick={() => setSelectedRequestId(row.request_id)}
                  >
                    <span className={styles.unknownRequestTime}>{formatTimestamp(row.created_at, language)}</span>
                    <span className={styles.unknownRequestMain}>
                      <strong>{row.public_model || row.virtual_model || row.upstream_model || t("未知模型")}</strong>
                      <small>{row.client_name || row.client_id || t("未知客户端")} · {row.channel_name || row.channel_id || t("未路由")}</small>
                    </span>
                    <span className={styles.unknownRequestStatus} data-error={row.status == null || row.status >= 400 || Boolean(row.error_message)}>
                      {row.status ?? t("失败")}
                    </span>
                    <IconChevronRight />
                  </button>
                )) : null}
              </div>
              <footer className={styles.unknownRequestsFooter}>
                <span>{t("本机共 {count} 条", { count: formatInteger(unknownRequestLogs.data?.total ?? 0, language) })}</span>
                <Pagination
                  total={unknownRequestLogs.data?.total ?? 0}
                  currentPage={unknownRequestsPage}
                  pageSize={8}
                  onPageChange={setUnknownRequestsPage}
                />
              </footer>
            </>
          )}
        </div>
      </SideSheet>
      {selectedRequestId ? (
        <RequestLogDetailSideSheet
          key={selectedRequestId}
          requestId={selectedRequestId}
          onClose={() => setSelectedRequestId(null)}
        />
      ) : null}
    </main>
  );
}

function HeatmapLegend({ t }: { t: ReturnType<typeof useAppPreferences>["t"] }) {
  return (
    <div className={styles.heatmapLegend}>
      <span>{t("少")}</span>
      {[0, 1, 2, 3, 4].map((level) => (
        <i key={level} className={[styles.heatmapCell, styles["heatLevel" + level]].join(" ")} />
      ))}
      <span>{t("多")}</span>
    </div>
  );
}

function SelectedPeriodCard({
  title,
  inputTokens,
  outputTokens,
  requests,
  proxyRequests,
  nativeEvents,
  cachedInputTokens,
  cacheMeasuredInputTokens,
  estimatedCost,
  tokenDetails,
  onExpandTokenDetails,
  language,
  t,
  confidence,
  onShowUnknownRequests,
}: {
  title: string;
  inputTokens: number;
  outputTokens: number;
  requests: number;
  proxyRequests: number;
  nativeEvents: number;
  cachedInputTokens: number;
  cacheMeasuredInputTokens: number;
  estimatedCost: number;
  tokenDetails: UsageTokenDetails;
  onExpandTokenDetails: () => void;
  language: NumberLanguage;
  t: ReturnType<typeof useAppPreferences>["t"];
  confidence?: TokenConfidence;
  onShowUnknownRequests?: () => void;
}) {
  return (
    <article className={[styles.selectedPeriod, confidence ? styles.selectedPeriodWithConfidence : ""].join(" ")}>
      <header className={styles.selectedPeriodHeader}>
        <strong>{title}</strong>
        <span>{t("指定时间点")}</span>
      </header>
      <div className={styles.selectedPeriodStats}>
        <SelectedPeriodMetric
          label="Tokens"
          value={formatCompactNumber(tokenDetails.total.total, language)}
          detail={t("输入 {input} · 输出 {output}", {
            input: formatCompactNumber(inputTokens, language),
            output: formatCompactNumber(outputTokens, language),
          })}
          onClick={onExpandTokenDetails}
          title={t("点击查看完整 Token 明细")}
        />
        <SelectedPeriodMetric
          label={t("请求量")}
          value={formatInteger(requests, language)}
          detail={t("代理 {proxy} · 原生 {native}", {
            proxy: formatInteger(Math.max(0, proxyRequests), language),
            native: formatInteger(nativeEvents, language),
          })}
        />
        <SelectedPeriodMetric
          label={t("缓存输入")}
          value={formatCompactNumber(tokenDetails.total.cachedInput, language)}
          detail={`${t("缓存命中率")} ${formatCacheHitRate(
            cacheMeasuredInputTokens > 0 ? cachedInputTokens / cacheMeasuredInputTokens : null,
          )}`}
          onClick={onExpandTokenDetails}
          title={t("点击查看完整 Token 明细")}
        />
        <SelectedPeriodMetric
          label={t("预估费用")}
          value={formatCostCny(estimatedCost)}
          detail={t("Flowlet 可统计用量")}
        />
      </div>
      {confidence && onShowUnknownRequests ? (
        <section className={styles.selectedConfidence}>
          <header>
            <strong>{t("数据可信度")}</strong>
            <span>{confidence.score == null ? "—" : formatConfidence(confidence.score)}</span>
          </header>
          <SelectedTokenConfidenceDetails
            confidence={confidence}
            language={language}
            t={t}
            onShowUnknownRequests={onShowUnknownRequests}
          />
        </section>
      ) : null}
    </article>
  );
}

function SelectedTokenConfidenceDetails({
  confidence,
  language,
  t,
  onShowUnknownRequests,
}: {
  confidence: TokenConfidence;
  language: NumberLanguage;
  t: ReturnType<typeof useAppPreferences>["t"];
  onShowUnknownRequests: () => void;
}) {
  const { score, proxyShare, nativeShare, unknownShare, unknownCount } = confidence;
  const scoreLabel = score == null ? "—" : formatConfidence(score);
  const scoreDegrees = score == null ? 0 : Math.max(0, Math.min(360, score * 360));

  return (
    <>
      <div className={styles.selectedConfidenceOverview}>
        <div className={styles.confidenceSummary}>
          <div
            className={styles.confidenceRing}
            style={{ "--confidence-degrees": `${scoreDegrees}deg` } as React.CSSProperties}
            aria-label={t("Token 已识别 {score}", { score: scoreLabel })}
          >
            <strong>{scoreLabel}</strong>
          </div>
          <div>
            <strong>{t("Token 已识别")}</strong>
            <span>{score == null
              ? t("当前筛选范围暂无数据")
              : t("当前按可统计请求覆盖计算")}</span>
          </div>
        </div>
        <div className={styles.selectedConfidenceBreakdown}>
          <ConfidenceRow className={styles.proxyDot} label={t("Flowlet 可统计用量")} value={formatConfidence(proxyShare)} />
          <ConfidenceRow className={styles.nativeDot} label={t("Agent 原生用量")} value={formatConfidence(nativeShare)} />
          <ConfidenceRow className={styles.unknownDot} label={t("未知 / 待识别")} value={formatConfidence(unknownShare)} />
        </div>
      </div>
      {unknownCount > 0 ? (
        <button type="button" className={styles.confidenceNotice} onClick={onShowUnknownRequests}>
          <span>{t("{count} 次请求暂未识别 Token，可在数据完整性检查中尝试修复。", {
            count: formatInteger(unknownCount, language),
          })}</span>
          <IconChevronRight />
        </button>
      ) : (
        <p>{t("当前范围内所有请求均包含可统计 Token；来源级评分将在同步数据支持后进一步细分。")}</p>
      )}
    </>
  );
}

function HeatmapMetricSwitch({ value, onChange, t }: {
  value: MobileUsageHeatmapMetric;
  onChange: (value: MobileUsageHeatmapMetric) => void;
  t: ReturnType<typeof useAppPreferences>["t"];
}) {
  return (
    <div className={styles.metricSeg} aria-label={t("热力图指标")}>
      {(["tokens", "cost"] as const).map((metric) => (
        <button
          key={metric}
          type="button"
          aria-pressed={value === metric}
          onClick={() => onChange(metric)}
        >
          {metric === "tokens" ? "Token" : t("预估费用")}
        </button>
      ))}
    </div>
  );
}

function SelectedPeriodMetric({ label, value, detail, onClick, title }: {
  label: string;
  value: string;
  detail: string;
  onClick?: () => void;
  title?: string;
}) {
  const content = (
    <>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </>
  );
  if (onClick) {
    return (
      <button type="button" className={[styles.selectedPeriodMetric, styles.expandableMetric].join(" ")} onClick={onClick} title={title}>
        {content}
      </button>
    );
  }
  return (
    <div className={styles.selectedPeriodMetric}>
      {content}
    </div>
  );
}

function SelectedPeriodEmpty({ t }: { t: ReturnType<typeof useAppPreferences>["t"] }) {
  return (
    <article className={[styles.selectedPeriod, styles.selectedPeriodEmpty].join(" ")}>
      <div className={styles.selectedEmptyVisual} aria-hidden="true">
        <IconBarChartVStroked size="extra-large" />
      </div>
      <div className={styles.selectedEmptyCopy}>
        <span className={styles.selectedLabel}>Token</span>
        <strong>{t("暂无选定时间数据")}</strong>
        <small>{t("选择有数据的日期或时段后查看详情")}</small>
      </div>
    </article>
  );
}

function TokenConfidenceCard({
  periodTitle,
  confidence,
  language,
  t,
  onShowUnknownRequests,
}: {
  periodTitle: string | null;
  confidence: TokenConfidence;
  language: NumberLanguage;
  t: ReturnType<typeof useAppPreferences>["t"];
  onShowUnknownRequests: () => void;
}) {
  return (
    <article className={styles.confidenceCard}>
      <header>
        <strong>{t("数据可信度")}</strong>
        <span>{periodTitle ?? t("暂无选定时间数据")}</span>
      </header>
      <TokenConfidenceDetails
        confidence={confidence}
        language={language}
        t={t}
        onShowUnknownRequests={onShowUnknownRequests}
      />
    </article>
  );
}

function TokenConfidenceDetails({
  confidence,
  language,
  t,
  onShowUnknownRequests,
}: {
  confidence: TokenConfidence;
  language: NumberLanguage;
  t: ReturnType<typeof useAppPreferences>["t"];
  onShowUnknownRequests: () => void;
}) {
  const { score, proxyShare, nativeShare, unknownShare, unknownCount } = confidence;
  const scoreLabel = score == null ? "—" : formatConfidence(score);
  const scoreDegrees = score == null ? 0 : Math.max(0, Math.min(360, score * 360));
  return (
    <>
      <div className={styles.confidenceBody}>
        <div className={styles.confidenceSummary}>
          <div
            className={styles.confidenceRing}
            style={{ "--confidence-degrees": `${scoreDegrees}deg` } as React.CSSProperties}
            aria-label={t("Token 已识别 {score}", { score: scoreLabel })}
          >
            <strong>{scoreLabel}</strong>
          </div>
          <div>
            <strong>{t("Token 已识别")}</strong>
            <span>{score == null
              ? t("当前筛选范围暂无数据")
              : t("当前按可统计请求覆盖计算")}</span>
          </div>
        </div>
        <div className={styles.confidenceBreakdown}>
          <ConfidenceRow className={styles.proxyDot} label={t("Flowlet 可统计用量")} value={formatConfidence(proxyShare)} />
          <ConfidenceRow className={styles.nativeDot} label={t("Agent 原生用量")} value={formatConfidence(nativeShare)} />
          <ConfidenceRow className={styles.unknownDot} label={t("未知 / 待识别")} value={formatConfidence(unknownShare)} />
        </div>
      </div>
      {unknownCount > 0 ? (
        <button type="button" className={styles.confidenceNotice} onClick={onShowUnknownRequests}>
          <span>{t("{count} 次请求暂未识别 Token，可在数据完整性检查中尝试修复。", {
            count: formatInteger(unknownCount, language),
          })}</span>
          <IconChevronRight />
        </button>
      ) : (
        <p>{t("当前范围内所有请求均包含可统计 Token；来源级评分将在同步数据支持后进一步细分。")}</p>
      )}
    </>
  );
}

type TokenConfidence = ReturnType<typeof calculateTokenConfidence>;

function calculateTokenConfidence(proxyRequests: number, nativeEvents: number, unknownRequests: number) {
  const safeProxyRequests = Math.max(0, proxyRequests);
  const safeNativeEvents = Math.max(0, nativeEvents);
  const safeUnknownRequests = Math.min(safeProxyRequests, Math.max(0, unknownRequests));
  const proxyRecognized = Math.max(0, safeProxyRequests - safeUnknownRequests);
  const recognized = proxyRecognized + safeNativeEvents;
  const total = safeProxyRequests + safeNativeEvents;
  return {
    score: total > 0 ? recognized / total : null,
    proxyShare: total > 0 ? proxyRecognized / total : 0,
    nativeShare: total > 0 ? safeNativeEvents / total : 0,
    unknownShare: total > 0 ? safeUnknownRequests / total : 0,
    unknownCount: safeUnknownRequests,
  };
}

function getSelectedLogRange(
  period: MobileUsagePeriod,
  selectedDate: string | null,
  selectedHour: string | null,
  selectedHourEnd: number | null,
) {
  const rawStart = period === "month" ? selectedDate ? `${selectedDate}T00:00:00` : null : selectedHour;
  if (!rawStart) return null;
  const start = new Date(rawStart);
  if (Number.isNaN(start.getTime())) return null;
  const end = new Date(start);
  if (period === "day") end.setHours(end.getHours() + 1);
  else if (period === "week") {
    end.setHours(selectedHourEnd ?? start.getHours() + 1);
  }
  else end.setDate(end.getDate() + 1);
  return { startAt: start.toISOString(), endAt: end.toISOString() };
}

function emptyDailyUsage(date: string): DailyUsageTotal {
  return {
    date,
    requestCount: 0,
    knownTokens: 0,
    inputTokens: 0,
    inputCachedTokens: 0,
    inputUncachedTokens: 0,
    cacheMeasuredInputTokens: 0,
    outputTokens: 0,
    unknownCount: 0,
    estimatedCost: 0,
  };
}

function ConfidenceRow({ className, label, value }: { className: string; label: string; value: string }) {
  return (
    <div>
      <i className={className} />
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

/** 热力图 tooltip 的来源拆分后缀：存在原生用量时追加「Flowlet X · 原生 Y」。 */
function formatNativeSplit(
  tokens: number,
  nativeTokens: number,
  language: NumberLanguage,
  t: ReturnType<typeof useAppPreferences>["t"],
) {
  if (nativeTokens <= 0) return "";
  return " · " + t("Flowlet {proxy} · 原生 {native}", {
    proxy: formatInteger(tokens - nativeTokens, language),
    native: formatInteger(nativeTokens, language),
  });
}

function formatCacheHitRate(value: number | null) {
  return value == null ? "—" : (value * 100).toFixed(1) + "%";
}

function formatConfidence(value: number) {
  const normalized = Math.max(0, Math.min(1, value));
  return normalized === 1 ? "100%" : (normalized * 100).toFixed(1) + "%";
}

function formatHeatmapValues(
  metric: MobileUsageHeatmapMetric,
  tokens: number,
  estimatedCost: number,
  language: NumberLanguage,
  t: ReturnType<typeof useAppPreferences>["t"],
) {
  const tokenLabel = `${formatInteger(tokens, language)} Tokens`;
  const costLabel = `${t("预估费用")} ${formatCostCny(estimatedCost)}`;
  return metric === "tokens" ? `${tokenLabel} · ${costLabel}` : `${costLabel} · ${tokenLabel}`;
}
