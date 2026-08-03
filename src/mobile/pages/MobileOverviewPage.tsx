import { IconChevronLeft, IconChevronRight } from "@douyinfe/semi-icons";
import { Button } from "@douyinfe/semi-ui-19";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import { useMobileDailyUsage, useMobileHourlyUsage, useMobileS3Settings } from "../../features/device-sync/useMobileDeviceSync";
import { formatCompactNumber, formatInteger, type NumberLanguage } from "../../shared/formatters/number";
import { formatCostCny } from "../../shared/formatters/cost";
import { MobileDeviceTitlePicker, useMobileDevicePickerState } from "../MobileDevicePicker";
import { MobileLastRefreshTime } from "../MobileLastRefreshTime";
import { useMobileRefreshController } from "../useMobileRefreshController";
import { MobilePullToRefresh } from "../MobilePullToRefresh";
import { UsageTokenDetailSheet } from "../../features/usage/UsageTokenDetailSheet";
import type { DailyUsageTotal } from "../../domains/device-sync/types";
import {
  buildMobileDailyContextHeatmap,
  buildUsageTokenDetails,
  buildMobileWeeklyHourlyHeatmap,
  buildMobileUsageHeatmap,
  filterMobileUsage,
  formatMobileUsageRange,
  getMobileUsageRange,
  MOBILE_WEEKLY_HEATMAP_BUCKET_HOURS,
  summarizeMobileUsage,
  type MobileUsageHeatmapMetric,
  type MobileUsagePeriod,
} from "../../features/usage/deviceUsagePresentation";
import styles from "./MobilePage.module.css";

export function MobileOverviewPage() {
  const { language, t } = useAppPreferences();
  const devicePicker = useMobileDevicePickerState();
  const deviceId = devicePicker.deviceId;
  const [period, setPeriod] = useState<MobileUsagePeriod>("day");
  const [periodOffset, setPeriodOffset] = useState(0);
  const [heatmapMetric, setHeatmapMetric] = useState<MobileUsageHeatmapMetric>("tokens");
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [selectedHour, setSelectedHour] = useState<string | null>(null);
  const [detailScrollRequest, setDetailScrollRequest] = useState(0);
  const [tokenDetailsScope, setTokenDetailsScope] = useState<"period" | "selected" | null>(null);
  const selectedDetailRef = useRef<HTMLElement | null>(null);
  const settings = useMobileS3Settings();
  const usage = useMobileDailyUsage(deviceId);
  const hourlyUsage = useMobileHourlyUsage(deviceId);
  const refreshController = useMobileRefreshController(deviceId ?? undefined);
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
  const summaryTokenDetails = useMemo(() => buildUsageTokenDetails({
    proxyTotal: summary.tokens,
    proxyInput: summary.inputTokens,
    proxyCachedInput: summary.cachedInputTokens,
    proxyUncachedInput: summary.uncachedInputTokens,
    proxyCacheMeasuredInput: summary.cacheMeasuredInputTokens,
    proxyOutput: summary.outputTokens,
    proxyRequests: summary.requests,
    proxyUnknownUsageCount: days.reduce((total, day) => total + day.unknownCount, 0),
    nativeTotal: summary.nativeTokens,
    nativeInput: summary.nativeInputTokens,
    nativeCachedInput: summary.nativeCachedInputTokens,
    nativeCacheWriteInput: summary.nativeCacheWriteInputTokens,
    nativeOutput: summary.nativeOutputTokens,
    nativeReasoning: summary.nativeReasoningTokens,
    nativeEvents: summary.nativeEvents,
  }), [days, summary]);
  const heatmap = useMemo(
    () => buildMobileUsageHeatmap(usage.data ?? [], period, periodOffset, now, heatmapMetric),
    [heatmapMetric, now, period, periodOffset, usage.data],
  );
  const hourlyHeatmap = useMemo(
    () => buildMobileWeeklyHourlyHeatmap(hourlyUsage.data ?? [], periodOffset, now, heatmapMetric),
    [heatmapMetric, hourlyUsage.data, now, periodOffset],
  );
  const dailyHourlyHeatmap = useMemo(
    () => buildMobileDailyContextHeatmap(hourlyUsage.data ?? [], periodOffset, now, heatmapMetric),
    [heatmapMetric, hourlyUsage.data, now, periodOffset],
  );
  const dailyContextRows = useMemo(() => [
    { date: dailyHourlyHeatmap.cells[0]?.date ?? "", start: 18, cells: dailyHourlyHeatmap.cells.slice(0, 6), context: true, showDate: true, span: 1 },
    { date: dailyHourlyHeatmap.cells[6]?.date ?? "", start: 0, cells: dailyHourlyHeatmap.cells.slice(6, 12), context: false, showDate: true, span: 4 },
    { date: dailyHourlyHeatmap.cells[12]?.date ?? "", start: 6, cells: dailyHourlyHeatmap.cells.slice(12, 18), context: false, showDate: false, span: 1 },
    { date: dailyHourlyHeatmap.cells[18]?.date ?? "", start: 12, cells: dailyHourlyHeatmap.cells.slice(18, 24), context: false, showDate: false, span: 1 },
    { date: dailyHourlyHeatmap.cells[24]?.date ?? "", start: 18, cells: dailyHourlyHeatmap.cells.slice(24, 30), context: false, showDate: false, span: 1 },
  ], [dailyHourlyHeatmap.cells]);
  const activeHourlyHeatmap = period === "day" ? dailyHourlyHeatmap : hourlyHeatmap;
  const selectedDay = useMemo(
    () => selectedDate
      ? (usage.data ?? []).find((day) => day.date === selectedDate) ?? emptyDailyUsage(selectedDate)
      : [...days].sort((left, right) => right.date.localeCompare(left.date))[0]
      ?? null,
    [days, selectedDate, usage.data],
  );
  const selectedHourlyCell = useMemo(
    () => activeHourlyHeatmap.cells.find((cell) => cell.hour === selectedHour)
      ?? activeHourlyHeatmap.cells
        .filter((cell) => cell.hasData)
        .sort((left, right) => right.hour.localeCompare(left.hour))[0]
      ?? null,
    [activeHourlyHeatmap.cells, selectedHour],
  );
  const weekdayLabels = useMemo(
    () => Array.from({ length: 7 }, (_, index) => new Date(2026, 6, 13 + index).toLocaleDateString(language, { weekday: "narrow" })),
    [language],
  );
  const weekDateLabels = useMemo(
    () => Array.from(
      { length: 7 },
      (_, index) => new Date(
        range.start.getFullYear(),
        range.start.getMonth(),
        range.start.getDate() + index,
      ).toLocaleDateString(language, { month: "numeric", day: "numeric" }),
    ),
    [language, range.start],
  );
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
  const selectedTokenDetailsLabel = period === "month"
    ? selectedDay?.date ?? rangeLabel
    : selectedHourlyCell
      ? `${selectedHourlyCell.date} ${String(selectedHourlyCell.hourOfDay).padStart(2, "0")}:00–${String(selectedHourlyCell.hourEnd - 1).padStart(2, "0")}:59`
      : rangeLabel;

  useEffect(() => {
    setSelectedDate(null);
    setSelectedHour(null);
    setTokenDetailsScope(null);
  }, [deviceId]);

  useEffect(() => {
    if (detailScrollRequest === 0) return;
    const frame = window.requestAnimationFrame(() => {
      selectedDetailRef.current?.scrollIntoView({
        behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
        block: "nearest",
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [detailScrollRequest]);

  const revealSelectedDetail = () => setDetailScrollRequest((request) => request + 1);

  return (
    <MobilePullToRefresh
      disabled={refreshController.disabled}
      refreshing={refreshController.loading}
      onRefresh={refreshController.refresh}
    >
    <section className={styles.page}>
      <header className={`${styles.heading} ${styles.headingWithPicker}`}>
        <div className={styles.headingTitleRow}>
          <h2>
            <MobileDeviceTitlePicker
              state={devicePicker}
              allowAll
              formatTitle={(name) => (name == null ? t("全部概览") : `${name} ${t("概览")}`)}
            />
          </h2>
          <MobileLastRefreshTime value={refreshController.lastSuccessAt} />
        </div>
        <p>{t("按设备和时间查看 Token 使用规模与活跃节奏")}</p>
      </header>

      {!settings.isLoading && !settings.data?.config ? (
        <div className={`${styles.card} ${styles.state}`}>
          <strong>{t("尚未配置数据源")}</strong>
          <span>{t("前往设置，扫描桌面端二维码或粘贴连接文本。")}</span>
        </div>
      ) : null}

      <div className={styles.overviewFilters}>
        <div className={styles.periodTabs} aria-label={t("统计维度")}>
          {(["day", "week", "month"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={period === value}
              onClick={() => {
                setPeriod(value);
                setPeriodOffset(0);
                setSelectedDate(null);
                setSelectedHour(null);
                setTokenDetailsScope(null);
              }}
            >
              {value === "day" ? t("日") : value === "week" ? t("周") : t("月")}
            </button>
          ))}
        </div>
        <div className={styles.periodToolbar}>
          <div className={styles.rangeNavigator}>
            <Button
              theme="borderless"
              size="small"
              icon={<IconChevronLeft />}
              aria-label={period === "day" ? t("前一天") : period === "week" ? t("上一周") : t("上一月")}
              onClick={() => {
                setPeriodOffset((offset) => offset - 1);
                setSelectedDate(null);
                setSelectedHour(null);
                setTokenDetailsScope(null);
              }}
            />
            <strong>{rangeLabel}</strong>
            <Button
              theme="borderless"
              size="small"
              icon={<IconChevronRight />}
              disabled={periodOffset === 0}
              aria-label={period === "day" ? t("后一天") : period === "week" ? t("下一周") : t("下一月")}
              onClick={() => {
                setPeriodOffset((offset) => Math.min(0, offset + 1));
                setSelectedDate(null);
                setSelectedHour(null);
                setTokenDetailsScope(null);
              }}
            />
          </div>
        </div>
      </div>

      <div className={styles.stats}>
        <button type="button" className={`${styles.stat} ${styles.expandableStat}`} onClick={() => setTokenDetailsScope("period")} title={t("点击查看完整 Token 明细")}><span>Tokens</span><strong>{formatCompactNumber(summaryTokenDetails.total.total, language)}</strong><small>{t("输入 {input} · 输出 {output}", { input: formatCompactNumber(summaryTokenDetails.total.input, language), output: formatCompactNumber(summaryTokenDetails.total.output, language) })}</small></button>
        <article className={styles.stat}><span>{t("请求量")}</span><strong>{formatInteger(summary.requests + summary.nativeEvents, language)}</strong><small>{summary.nativeEvents > 0 ? t("代理 {proxy} · 原生 {native}", { proxy: formatInteger(summary.requests, language), native: formatInteger(summary.nativeEvents, language) }) : t("{count} 天数据", { count: days.length })}</small></article>
        <button type="button" className={`${styles.stat} ${styles.expandableStat}`} onClick={() => setTokenDetailsScope("period")} title={t("点击查看完整 Token 明细")}><span>{t("缓存输入")}</span><strong>{formatCompactNumber(summaryTokenDetails.total.cachedInput, language)}</strong><small>{t("缓存命中率")} {formatCacheHitRate(summaryTokenDetails.total.cacheHitRate)}</small></button>
        <article className={styles.stat}><span>{t("预估费用")}</span><strong>{formatCostCny(summary.estimatedCost)}</strong><small>{t("Flowlet 可统计用量")}</small></article>
      </div>

      <article className={styles.card}>
        <div className={styles.cardHeader}>
          <div>
            <strong>{t(period === "day"
              ? heatmapMetric === "tokens" ? "30 小时 Token 热力图" : "30 小时预估费用热力图"
              : period === "week"
                ? heatmapMetric === "tokens" ? "每 3 小时 Token 热力图" : "每 3 小时预估费用热力图"
                : heatmapMetric === "tokens" ? "每日 Token 热力图" : "每日预估费用热力图")}</strong>
            <span>{t(period === "day"
              ? "包含昨日最后 6 小时，点击查看时段汇总"
              : period === "week" ? "横轴为星期，纵轴为时段" : "点击日期查看当天汇总")}</span>
          </div>
          <HeatmapMetricSwitch value={heatmapMetric} onChange={setHeatmapMetric} t={t} />
        </div>
        {period !== "month" && hourlyUsage.isError ? <div className={styles.state}><strong>{t("用量数据加载失败")}</strong><span>{hourlyUsage.error.message}</span></div> : null}
        {period === "month" && usage.isError ? <div className={styles.state}><strong>{t("用量数据加载失败")}</strong><span>{usage.error.message}</span></div> : null}
        {period === "day" && !hourlyUsage.isError ? (
          <>
            <div className={styles.dailyHeatmap}>
              {dailyContextRows.map((row, rowIndex) => {
                const boundary = rowIndex === 1;
                return [
                  row.showDate ? (
                    <span
                      className={`${styles.dailyDateLabel} ${row.context ? styles.contextDateLabel : styles.currentDateLabel} ${row.span === 4 ? styles.fourRowDateLabel : ""} ${boundary ? styles.dayBoundary : ""}`}
                      key={`date-${row.date}`}
                    >
                      {formatMobileDateLabel(row.date, language)}
                    </span>
                  ) : null,
                  <span className={`${styles.dailyRangeLabel} ${boundary ? styles.dayBoundary : ""}`} key={`range-${row.date}-${row.start}`}>
                    {String(row.start).padStart(2, "0")}–{String(row.start + 5).padStart(2, "0")}
                  </span>,
                  ...row.cells.map((cell) => {
                    const hourLabel = String(cell.hourOfDay).padStart(2, "0");
                    const title = `${cell.date} ${hourLabel}:00–${hourLabel}:59 · ${formatHeatmapValues(heatmapMetric, cell.tokens, cell.estimatedCost, language, t)} · ${t("{count} 次请求", { count: formatInteger(cell.requests, language) })}${formatNativeSplit(cell.tokens, cell.nativeTokens, language, t)}`;
                    return (
                      <button
                        key={cell.hour}
                        type="button"
                        className={`${styles.hourCell} ${styles.dailyHourCell} ${styles[`heatLevel${cell.level}`]} ${cell.outside ? styles.outside : ""} ${boundary ? styles.dayBoundary : ""}`}
                        disabled={cell.future}
                        aria-label={title}
                        aria-pressed={selectedHourlyCell?.hour === cell.hour}
                        title={title}
                        onClick={() => {
                          setSelectedHour(cell.hour);
                          revealSelectedDetail();
                        }}
                      >
                        <span>{hourLabel}</span>
                      </button>
                    );
                  }),
                ];
              })}
            </div>
            <div className={styles.heatmapLegend}><span>{t("少")}</span>{[0, 1, 2, 3, 4].map((level) => <i key={level} className={`${styles.heatmapCell} ${styles[`heatLevel${level}`]}`} />)}<span>{t("多")}</span></div>
            {!dailyHourlyHeatmap.cells.some((cell) => cell.hasData) ? <div className={styles.emptyHint}>{t("当前周期暂无数据")}</div> : null}
          </>
        ) : null}
        {period === "week" && !hourlyUsage.isError ? (
          <>
            <div className={styles.hourlyHeatmap}>
              <span />
              {weekdayLabels.map((label, dayIndex) => (
                <span className={styles.hourDayLabel} key={`${label}-${dayIndex}`}>{label}</span>
              ))}
              {Array.from(
                { length: 24 / MOBILE_WEEKLY_HEATMAP_BUCKET_HOURS },
                (_, bucketIndex) => {
                const bucketCells = hourlyHeatmap.cells.slice(bucketIndex * 7, bucketIndex * 7 + 7);
                const hourStart = bucketIndex * MOBILE_WEEKLY_HEATMAP_BUCKET_HOURS;
                return [
                  <span className={styles.hourLabel} key={`label-${hourStart}`}>
                    {String(hourStart).padStart(2, "0")}–{String(hourStart + MOBILE_WEEKLY_HEATMAP_BUCKET_HOURS).padStart(2, "0")}
                  </span>,
                  ...bucketCells.map((cell) => {
                    const title = `${cell.date} ${String(cell.hourOfDay).padStart(2, "0")}:00–${String(cell.hourEnd - 1).padStart(2, "0")}:59 · ${formatHeatmapValues(heatmapMetric, cell.tokens, cell.estimatedCost, language, t)} · ${t("{count} 次请求", { count: formatInteger(cell.requests, language) })}${formatNativeSplit(cell.tokens, cell.nativeTokens, language, t)}`;
                    return (
                      <button
                        key={cell.hour}
                        type="button"
                        className={`${styles.hourCell} ${styles[`heatLevel${cell.level}`]} ${cell.outside ? styles.outside : ""}`}
                        disabled={cell.future}
                        aria-label={title}
                        aria-pressed={selectedHourlyCell?.hour === cell.hour}
                        title={title}
                        onClick={() => {
                          setSelectedHour(cell.hour);
                          revealSelectedDetail();
                        }}
                      />
                    );
                  }),
                ];
              })}
              <span aria-hidden="true" />
              {weekDateLabels.map((label, dayIndex) => (
                <span className={styles.hourDateLabel} key={`${label}-${dayIndex}`}>{label}</span>
              ))}
            </div>
            <div className={styles.heatmapLegend}><span>{t("少")}</span>{[0, 1, 2, 3, 4].map((level) => <i key={level} className={`${styles.heatmapCell} ${styles[`heatLevel${level}`]}`} />)}<span>{t("多")}</span></div>
            {!hourlyHeatmap.cells.some((cell) => cell.hasData) ? <div className={styles.emptyHint}>{t("当前周期暂无数据")}</div> : null}
          </>
        ) : null}
        {period === "month" && !usage.isError ? (
          <>
            <div className={styles.heatmapLabels}>
              {weekdayLabels.map((label, index) => <span key={`${index}-${label}`}>{label}</span>)}
            </div>
            <div className={styles.mobileHeatmap}>
              {heatmap.cells.map((cell, cellIndex) => {
                const title = `${cell.date} · ${formatHeatmapValues(heatmapMetric, cell.tokens, cell.estimatedCost, language, t)} · ${t("{count} 次请求", { count: formatInteger(cell.requests, language) })}${formatNativeSplit(cell.tokens, cell.nativeTokens, language, t)}`;
                return (
                  <button
                    key={cell.date}
                    type="button"
                    className={`${styles.heatmapCell} ${styles[`heatLevel${cell.level}`]} ${cellIndex % 7 >= 5 ? styles.weekend : ""} ${cell.outside ? styles.outside : ""}`}
                    disabled={cell.future}
                    aria-label={title}
                    aria-pressed={selectedDay?.date === cell.date}
                    title={title}
                    onClick={() => {
                      setSelectedDate(cell.date);
                      revealSelectedDetail();
                    }}
                  >
                    <span>{Number(cell.date.slice(-2))}</span>
                  </button>
                );
              })}
            </div>
            <div className={styles.heatmapLegend}><span>{t("少")}</span>{[0, 1, 2, 3, 4].map((level) => <i key={level} className={`${styles.heatmapCell} ${styles[`heatLevel${level}`]}`} />)}<span>{t("多")}</span></div>
            {days.length === 0 ? <div className={styles.emptyHint}>{t("当前周期暂无数据")}</div> : null}
          </>
        ) : null}
      </article>

      {period !== "month" && selectedHourlyCell ? (
        <article ref={selectedDetailRef} className={styles.selectedDay}>
          <div><strong>{selectedTokenDetailsLabel}</strong><span>{t("指定时间点")}</span></div>
          <div className={styles.selectedTokenActions}>
            <button type="button" onClick={() => setTokenDetailsScope("selected")} title={t("点击查看完整 Token 明细")}>
              <span>Tokens</span><strong>{formatCompactNumber(selectedTokenDetails?.total.total ?? 0, language)}</strong>
            </button>
            <button type="button" onClick={() => setTokenDetailsScope("selected")} title={t("点击查看完整 Token 明细")}>
              <span>{t("缓存输入")}</span><strong>{formatCompactNumber(selectedTokenDetails?.total.cachedInput ?? 0, language)}</strong>
            </button>
          </div>
          <small>{t("{count} 次请求", { count: formatInteger(selectedHourlyCell.requests, language) })} · {formatHeatmapSecondary(heatmapMetric, selectedHourlyCell.tokens, selectedHourlyCell.estimatedCost, language, t)}</small>
          {selectedHourlyCell.nativeTokens > 0 ? (
            <small>{t("Flowlet {proxy} · 原生 {native}", {
              proxy: formatCompactNumber(selectedHourlyCell.tokens - selectedHourlyCell.nativeTokens, language),
              native: formatCompactNumber(selectedHourlyCell.nativeTokens, language),
            })}</small>
          ) : null}
        </article>
      ) : null}

      {period === "month" && selectedDay ? (
        <article ref={selectedDetailRef} className={styles.selectedDay}>
          <div><strong>{selectedDay.date}</strong><span>{t("指定时间点")}</span></div>
          <div className={styles.selectedTokenActions}>
            <button type="button" onClick={() => setTokenDetailsScope("selected")} title={t("点击查看完整 Token 明细")}>
              <span>Tokens</span><strong>{formatCompactNumber(selectedTokenDetails?.total.total ?? 0, language)}</strong>
            </button>
            <button type="button" onClick={() => setTokenDetailsScope("selected")} title={t("点击查看完整 Token 明细")}>
              <span>{t("缓存输入")}</span><strong>{formatCompactNumber(selectedTokenDetails?.total.cachedInput ?? 0, language)}</strong>
            </button>
          </div>
          <small>{t("{count} 次请求", { count: formatInteger(selectedDay.requestCount + (selectedDay.nativeEventCount ?? 0), language) })} · {formatHeatmapSecondary(heatmapMetric, selectedDay.knownTokens + (selectedDay.nativeTotalTokens ?? 0), selectedDay.estimatedCost ?? 0, language, t)}</small>
          <small>{t("输入 {input} · 输出 {output}", { input: formatCompactNumber(selectedDay.inputTokens + (selectedDay.nativeInputTokens ?? 0), language), output: formatCompactNumber(selectedDay.outputTokens + (selectedDay.nativeOutputTokens ?? 0), language) })}</small>
          {(selectedDay.nativeTotalTokens ?? 0) > 0 ? (
            <small>{t("Flowlet {proxy} · 原生 {native}", {
              proxy: formatCompactNumber(selectedDay.knownTokens, language),
              native: formatCompactNumber(selectedDay.nativeTotalTokens ?? 0, language),
            })}</small>
          ) : null}
        </article>
      ) : null}

      <UsageTokenDetailSheet
        visible={tokenDetailsScope != null}
        onClose={() => setTokenDetailsScope(null)}
        contextLabel={tokenDetailsScope === "selected" ? selectedTokenDetailsLabel : rangeLabel}
        details={tokenDetailsScope === "selected" && selectedTokenDetails ? selectedTokenDetails : summaryTokenDetails}
        language={language}
        t={t}
        mobile
      />
    </section>
    </MobilePullToRefresh>
  );
}

function formatCacheHitRate(value: number | null) {
  return value == null ? "—" : `${(value * 100).toFixed(1)}%`;
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

function formatMobileDateLabel(date: string, language: NumberLanguage) {
  if (!date) return "—";
  return new Date(`${date}T00:00:00`).toLocaleDateString(language, {
    month: "numeric",
    day: "numeric",
  });
}

function HeatmapMetricSwitch({ value, onChange, t }: {
  value: MobileUsageHeatmapMetric;
  onChange: (value: MobileUsageHeatmapMetric) => void;
  t: ReturnType<typeof useAppPreferences>["t"];
}) {
  return (
    <div className={styles.metricSeg} aria-label={t("热力图指标")}>
      {(["tokens", "cost"] as const).map((metric) => (
        <button key={metric} type="button" aria-pressed={value === metric} onClick={() => onChange(metric)}>
          {metric === "tokens" ? "Token" : t("预估费用")}
        </button>
      ))}
    </div>
  );
}

function formatHeatmapSecondary(metric: MobileUsageHeatmapMetric, tokens: number, estimatedCost: number, language: NumberLanguage, t: ReturnType<typeof useAppPreferences>["t"]) {
  return metric === "tokens"
    ? `${t("预估费用")} ${formatCostCny(estimatedCost)}`
    : `Token ${formatCompactNumber(tokens, language)}`;
}

function formatHeatmapValues(metric: MobileUsageHeatmapMetric, tokens: number, estimatedCost: number, language: NumberLanguage, t: ReturnType<typeof useAppPreferences>["t"]) {
  const tokenLabel = `${formatInteger(tokens, language)} Tokens`;
  const costLabel = `${t("预估费用")} ${formatCostCny(estimatedCost)}`;
  return metric === "tokens" ? `${tokenLabel} · ${costLabel}` : `${costLabel} · ${tokenLabel}`;
}

/** 热力图 tooltip 的来源拆分后缀：存在原生用量时追加「Flowlet X · 原生 Y」。 */
function formatNativeSplit(
  tokens: number,
  nativeTokens: number,
  language: NumberLanguage,
  t: ReturnType<typeof useAppPreferences>["t"],
) {
  if (nativeTokens <= 0) return "";
  return ` · ${t("Flowlet {proxy} · 原生 {native}", {
    proxy: formatInteger(tokens - nativeTokens, language),
    native: formatInteger(nativeTokens, language),
  })}`;
}
