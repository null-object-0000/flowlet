import { IconChevronRight } from "@douyinfe/semi-icons";
import { Button, Pagination, SideSheet } from "@douyinfe/semi-ui-19";
import { useMemo, useState } from "react";
import { UsageStatisticsView, type UsageStatisticsCellModel, type UsageStatisticsConfidenceModel, type UsageStatisticsDetailModel } from "@flowlet/product-ui";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import { useDeviceDailyUsage, useDeviceHourlyUsage, useKnownDevices } from "../../features/device-sync/useDeviceSync";
import { DeviceUsageTitlePicker } from "../../features/device-sync/DeviceUsageTitlePicker";
import { PageHeader } from "../../shared/ui/PageHeader";
import { RefreshControl } from "../../shared/ui/RefreshControl";
import { useRefreshControl } from "../../shared/ui/useRefreshControl";
import { formatCompactNumber, formatInteger, type NumberLanguage } from "../../shared/formatters/number";
import { formatCostAmount, formatMultiCurrencyCost } from "../../shared/formatters/cost";
import { DEFAULT_REQUEST_LOG_FILTER } from "../../domains/request-log/types";
import { useRequestLogs } from "../../features/request-logs/useRequestLogs";
import { RequestLogDetailSideSheet } from "../../features/request-logs/RequestLogDetailSideSheet";
import { formatTimestamp } from "../../shared/formatters/datetime";
import { APP_OVERLAY_Z_INDEX } from "../../shared/ui/overlayLayers";
import { DETAIL_SHEET_WIDTH } from "../../shared/ui/drawerWidth";
import { TimePeriodSwitch, TimeRangeNavigator, TimeScopeControl } from "../../shared/ui/TimeScopeControl";
import { UsageTokenDetailSheet } from "../../features/usage/UsageTokenDetailSheet";
import { useUsageSummary } from "../../features/usage/useUsageSummary";
import { useModelPriceCurrencyLookup } from "../../features/usage/useModelPriceCurrencies";
import { useUsageCostDisplaySetting } from "../../features/settings/useUsageCostDisplaySetting";
import { createHeatLevelScale } from "../../shared/visualization/heatmapLevels";
import { groupConvertedUsageCost, summarizeConvertedUsageCost } from "./usageCostConversion";
import type { DailyUsageTotal } from "../../domains/device-sync/types";
import {
  buildMobileUsageHeatmap,
  buildMobileDailyHourlyHeatmap,
  buildUsageTokenDetails,
  buildWeekdayHourHeatmap,
  DEFAULT_USAGE_PERIOD,
  filterMobileUsage,
  formatMobileUsageRange,
  getMobileUsageRange,
  summarizeMobileUsage,
  type MobileUsageHeatmapMetric,
  type MobileUsagePeriod,
} from "../../features/usage/deviceUsagePresentation";
import styles from "./UsageCostPage.module.css";

export function UsageCostPage() {
  const { language, t } = useAppPreferences();
  const refresh = useRefreshControl({ intervalMs: 30_000 });
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [period, setPeriod] = useState<MobileUsagePeriod>(DEFAULT_USAGE_PERIOD);
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
  const periodLogRange = useMemo(() => {
    const start = new Date(`${range.startDate}T00:00:00`);
    const end = new Date(`${range.endDate}T00:00:00`);
    end.setDate(end.getDate() + 1);
    return { startAt: start.toISOString(), endAt: end.toISOString() };
  }, [range.endDate, range.startDate]);
  const costUsage = useUsageSummary({
    startAt: periodLogRange.startAt,
    endAt: periodLogRange.endAt,
    groupBy: period === "month" ? "day" : "hour",
  }, refresh.autoRefresh);
  const usageCostSetting = useUsageCostDisplaySetting();
  const { modelCurrencyOf } = useModelPriceCurrencyLookup();
  const costConfig = usageCostSetting.query.data ?? {
    currency_conversion_enabled: false,
    display_currency: "CNY" as const,
    usd_to_cny_rate: 7.2,
    exchange_rate_note: "",
  };
  const scopedCostRows = useMemo(
    () => (costUsage.query.data ?? []).filter((row) => deviceId == null || row.device_id === deviceId),
    [costUsage.query.data, deviceId],
  );
  const convertedPeriodCost = useMemo(
    () => summarizeConvertedUsageCost(scopedCostRows, costConfig, modelCurrencyOf),
    [costConfig, modelCurrencyOf, scopedCostRows],
  );
  const convertedCostByBucket = useMemo(
    () => groupConvertedUsageCost(scopedCostRows, costConfig, modelCurrencyOf),
    [costConfig, modelCurrencyOf, scopedCostRows],
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
  const costForBucket = (bucket: string) => convertedCostByBucket.get(bucket)?.total ?? 0;
  const rawViewCells = period === "month" ? heatmap.cells : activeHourlyHeatmap.cells;
  const viewBucketKeys = period === "month"
    ? heatmap.cells.map((cell) => cell.date)
    : activeHourlyHeatmap.cells.map((cell) => cell.hour);
  const convertedCostScale = createHeatLevelScale(
    rawViewCells
      .map((cell, index) => ({ cell, bucket: viewBucketKeys[index] }))
      .filter(({ cell }) => cell.hasData)
      .map(({ bucket }) => costForBucket(bucket)),
  );
  const selectedConvertedCost = selectedPeriodTitle
    ? convertedCostByBucket.get(period === "month" ? selectedDay?.date ?? "" : selectedHourlyCell?.hour ?? "")
    : undefined;
  const formatConvertedCost = (amount: number) => formatCostAmount({
    amount,
    currency: convertedPeriodCost.currency,
  }, 4);
  const costPresentation = (value: typeof convertedPeriodCost) => {
    const flowletOriginal = formatMultiCurrencyCost(value.flowletOriginalByCurrency, 4);
    const nativeOriginal = formatMultiCurrencyCost(value.nativeOriginalByCurrency, 4);
    const flowlet = formatConvertedCost(value.flowlet);
    const native = formatConvertedCost(value.native);
    const rate = costConfig.currency_conversion_enabled
      ? t("按固定汇率 1 USD = {rate} CNY 折算", { rate: costConfig.usd_to_cny_rate })
      : t("未启用汇率折算，仅计入目标币种");
    return {
      hint: t("Flowlet {flowlet} · 原生 {native}", { flowlet, native }),
      tooltip: <div className={styles.costTooltip}>
        <strong>{t("费用折算对账")}</strong>
        <div className={styles.costTooltipSource}>
          <span><b>Flowlet</b><small>{t("原币 {original}", { original: flowletOriginal })}</small><em>{flowlet}</em></span>
          <span><b>{t("Agent 原生")}</b><small>{t("原币 {original}", { original: nativeOriginal })}</small><em>{native}</em></span>
        </div>
        <p>{rate}</p>
        {value.unsupportedCurrencies.length > 0 ? <p>{t("未折算币种：{currencies}", { currencies: value.unsupportedCurrencies.join("、") })}</p> : null}
        {costConfig.exchange_rate_note ? <p>{costConfig.exchange_rate_note}</p> : null}
      </div>,
    };
  };

  const openUnknownRequests = (scope: "period" | "selected") => {
    setUnknownRequestsScope(scope);
    setUnknownRequestsPage(1);
    setUnknownRequestsOpen(true);
  };

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
  const viewConfidence = (value: TokenConfidence): UsageStatisticsConfidenceModel => {
    const scoreLabel = value.score == null ? "—" : formatConfidence(value.score);
    return {
      scoreLabel,
      scoreDegrees: value.score == null ? 0 : Math.max(0, Math.min(360, value.score * 360)),
      recognizedLabel: t("Token 已识别"),
      recognizedHint: value.score == null ? t("当前筛选范围暂无数据") : t("当前按可统计请求覆盖计算"),
      proxyLabel: t("Flowlet 可统计用量"),
      proxyValue: formatConfidence(value.proxyShare),
      nativeLabel: t("Agent 原生用量"),
      nativeValue: formatConfidence(value.nativeShare),
      unknownLabel: t("未知 / 待识别"),
      unknownValue: formatConfidence(value.unknownShare),
      notice: value.unknownCount > 0
        ? t("{count} 次请求暂未识别 Token，可在数据完整性检查中尝试修复。", { count: formatInteger(value.unknownCount, language) })
        : t("当前范围内所有请求均包含可统计 Token；来源级评分将在同步数据支持后进一步细分。"),
      noticeActionable: value.unknownCount > 0,
      ariaLabel: t("Token 已识别 {score}", { score: scoreLabel }),
    };
  };
  const viewCells: UsageStatisticsCellModel[] = rawViewCells.map((cell, index) => {
    const hourlyCell = period === "month" ? null : activeHourlyHeatmap.cells[index];
    const dailyCell = period === "month" ? heatmap.cells[index] : null;
    const tokens = cell.tokens;
    const estimatedCost = costForBucket(viewBucketKeys[index]);
    return {
      key: period === "month" ? dailyCell!.date : hourlyCell!.hour,
      label: period === "month" ? dailyCell!.date : String(hourlyCell!.hourOfDay).padStart(2, "0"),
      value: heatmapMetric === "tokens" ? tokens : estimatedCost,
      displayValue: formatHeatmapValues(heatmapMetric, tokens, estimatedCost, convertedPeriodCost.currency, language, t),
      level: heatmapMetric === "cost" ? convertedCostScale.levelFor(estimatedCost) : cell.level,
      disabled: cell.future,
      hasData: cell.hasData,
      adjacent: dailyCell?.adjacentMonth,
      outside: dailyCell?.outside,
      weekend: period === "month" ? index % 7 >= 5 : undefined,
    };
  });
  const chartTitle = t(period === "day"
    ? heatmapMetric === "tokens" ? "24 小时 Token 柱状图" : "24 小时预估费用柱状图"
    : period === "week"
      ? heatmapMetric === "tokens" ? "星期 × 小时 Token 热力图" : "星期 × 小时预估费用热力图"
      : heatmapMetric === "tokens" ? "每日 Token 热力图" : "每日预估费用热力图");
  const chartHint = t(period === "day"
    ? "横轴为小时，点击柱查看对应时段"
    : period === "week" ? "纵轴为星期、横轴为小时（24 小时制），点击查看对应时段" : "点击日期查看当天汇总");
  const selectedDetail: UsageStatisticsDetailModel | null = selectedPeriod && selectedTokenDetails ? {
    title: selectedPeriodTitle ?? t("指定时间点"),
    contextLabel: t("指定时间点"),
    metrics: [
      {
        key: "tokens", label: "Tokens", value: formatCompactNumber(selectedTokenDetails.total.total, language),
        hint: t("输入 {input} · 输出 {output}", { input: formatCompactNumber(selectedTokenDetails.total.input, language), output: formatCompactNumber(selectedTokenDetails.total.output, language) }),
        expandable: true, title: t("点击查看完整 Token 明细"),
      },
      {
        key: "requests", label: t("请求量"),
        value: formatInteger(period === "month" ? (selectedDay?.requestCount ?? 0) + (selectedDay?.nativeEventCount ?? 0) : selectedHourlyCell?.requests ?? 0, language),
        hint: t("代理 {proxy} · 原生 {native}", {
          proxy: formatInteger(period === "month" ? selectedDay?.requestCount ?? 0 : Math.max(0, (selectedHourlyCell?.requests ?? 0) - (selectedHourlyCell?.nativeEvents ?? 0)), language),
          native: formatInteger(period === "month" ? selectedDay?.nativeEventCount ?? 0 : selectedHourlyCell?.nativeEvents ?? 0, language),
        }),
      },
      {
        key: "cache", label: t("缓存输入"), value: formatCompactNumber(selectedTokenDetails.total.cachedInput, language),
        hint: `${t("缓存命中率")} ${formatCacheHitRate(selectedTokenDetails.total.cacheHitRate)}`,
        expandable: true, title: t("点击查看完整 Token 明细"),
      },
      { key: "cost", label: t("折算预估费用"), value: formatConvertedCost(selectedConvertedCost?.total ?? 0), ...costPresentation(selectedConvertedCost ?? { ...convertedPeriodCost, total: 0, flowlet: 0, native: 0, flowletOriginalByCurrency: {}, nativeOriginalByCurrency: {} }) },
    ],
    confidence: viewConfidence(selectedTokenConfidence),
  } : null;

  return (
    <main className={styles.sharedPage}>
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
          isFetching={activeQuery.isFetching || costUsage.query.isFetching}
          lastUpdatedAt={activeQuery.dataUpdatedAt || undefined}
          intervalMs={refresh.intervalMs}
          onRefresh={() => void Promise.all([activeQuery.refetch(), costUsage.query.refetch()])}
          language={language}
          t={t}
        />
      </PageHeader>

      <UsageStatisticsView
        stats={[
          { key: "tokens", label: "Tokens", value: formatCompactNumber(summaryTokenDetails.total.total, language), hint: t("输入 {input} · 输出 {output}", { input: formatCompactNumber(summaryTokenDetails.total.input, language), output: formatCompactNumber(summaryTokenDetails.total.output, language) }), expandable: true, title: t("点击查看完整 Token 明细") },
          { key: "requests", label: t("请求量"), value: formatInteger(summary.requests + summary.nativeEvents, language), hint: summary.nativeEvents > 0 ? t("代理 {proxy} · 原生 {native}", { proxy: formatInteger(summary.requests, language), native: formatInteger(summary.nativeEvents, language) }) : t("{count} 天数据", { count: days.length }) },
          { key: "cache", label: t("缓存输入"), value: formatCompactNumber(summaryTokenDetails.total.cachedInput, language), hint: `${t("缓存命中率")} ${formatCacheHitRate(summaryTokenDetails.total.cacheHitRate)}`, expandable: true, title: t("点击查看完整 Token 明细") },
          { key: "cost", label: t("折算预估费用"), value: formatConvertedCost(convertedPeriodCost.total), ...costPresentation(convertedPeriodCost) },
        ]}
        cells={viewCells}
        confidence={viewConfidence(periodTokenConfidence)}
        detail={selectedDetail}
        period={period}
        metric={heatmapMetric}
        selectedKey={period === "month" ? selectedDay?.date ?? null : selectedHourlyCell?.hour ?? null}
        loading={(activeQuery.isPending && activeQuery.data == null) || (costUsage.query.isPending && costUsage.query.data == null) ? <span>{t("正在加载用量…")}</span> : null}
        error={activeQuery.isError || costUsage.query.isError ? <><strong>{t("用量数据加载失败")}</strong><span>{activeQuery.error?.message ?? costUsage.query.error?.message}</span><Button size="small" onClick={() => void Promise.all([activeQuery.refetch(), costUsage.query.refetch()])}>{t("重试")}</Button></> : null}
        labels={{
          statsAria: t("用量统计"), confidenceTitle: t("数据可信度"), confidencePeriod: rangeLabel,
          chartTitle, chartHint, metricAria: t("热力图指标"), tokens: "Token", cost: t("折算预估费用"),
          selectHint: t("选择有数据的日期或时段后查看详情"), emptyTitle: t("暂无选定时间数据"), emptyLabel: "Token", emptyPeriod: t("当前周期暂无数据"),
          low: t("少"), high: t("多"), weekdayLabels,
          dailyMaxLabel: heatmapMetric === "tokens" ? formatCompactNumber(dailyChartMax, language) : formatConvertedCost(Math.max(0, ...viewCells.map((cell) => cell.value))),
        }}
        onMetricChange={setHeatmapMetric}
        onSelect={(key) => period === "month" ? setSelectedDate(key) : setSelectedHour(key)}
        onStatClick={() => setTokenDetailsScope("period")}
        onDetailMetricClick={() => setTokenDetailsScope("selected")}
        onConfidenceNotice={openUnknownRequests}
      />


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
  currency: "CNY" | "USD",
  language: NumberLanguage,
  t: ReturnType<typeof useAppPreferences>["t"],
) {
  const tokenLabel = `${formatInteger(tokens, language)} Tokens`;
  const costLabel = `${t("折算预估费用")} ${formatCostAmount({ amount: estimatedCost, currency }, 4)}`;
  return metric === "tokens" ? `${tokenLabel} · ${costLabel}` : `${costLabel} · ${tokenLabel}`;
}
