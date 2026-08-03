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
import {
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
  const [period, setPeriod] = useState<MobileUsagePeriod>("month");
  const [periodOffset, setPeriodOffset] = useState(0);
  const [heatmapMetric, setHeatmapMetric] = useState<MobileUsageHeatmapMetric>("tokens");
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [selectedHour, setSelectedHour] = useState<string | null>(null);
  const [detailScrollRequest, setDetailScrollRequest] = useState(0);
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
  const heatmap = useMemo(
    () => buildMobileUsageHeatmap(usage.data ?? [], period, periodOffset, now, heatmapMetric),
    [heatmapMetric, now, period, periodOffset, usage.data],
  );
  const hourlyHeatmap = useMemo(
    () => buildMobileWeeklyHourlyHeatmap(hourlyUsage.data ?? [], periodOffset, now, heatmapMetric),
    [heatmapMetric, hourlyUsage.data, now, periodOffset],
  );
  const selectedDay = useMemo(
    () => days.find((day) => day.date === selectedDate)
      ?? [...days].sort((left, right) => right.date.localeCompare(left.date))[0]
      ?? null,
    [days, selectedDate],
  );
  const selectedHourlyCell = useMemo(
    () => hourlyHeatmap.cells.find((cell) => cell.hour === selectedHour)
      ?? hourlyHeatmap.cells
        .filter((cell) => cell.hasData)
        .sort((left, right) => right.hour.localeCompare(left.hour))[0]
      ?? null,
    [hourlyHeatmap.cells, selectedHour],
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

  useEffect(() => {
    setSelectedDate(null);
    setSelectedHour(null);
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
          {(["week", "month"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={period === value}
              onClick={() => {
                setPeriod(value);
                setPeriodOffset(0);
                setSelectedDate(null);
                setSelectedHour(null);
              }}
            >
              {value === "week" ? t("周") : t("月")}
            </button>
          ))}
        </div>
        <div className={styles.periodToolbar}>
          <div className={styles.rangeNavigator}>
            <Button
              theme="borderless"
              size="small"
              icon={<IconChevronLeft />}
              aria-label={period === "week" ? t("上一周") : t("上一月")}
              onClick={() => {
                setPeriodOffset((offset) => offset - 1);
                setSelectedDate(null);
                setSelectedHour(null);
              }}
            />
            <strong>{rangeLabel}</strong>
            <Button
              theme="borderless"
              size="small"
              icon={<IconChevronRight />}
              disabled={periodOffset === 0}
              aria-label={period === "week" ? t("下一周") : t("下一月")}
              onClick={() => {
                setPeriodOffset((offset) => Math.min(0, offset + 1));
                setSelectedDate(null);
                setSelectedHour(null);
              }}
            />
          </div>
        </div>
      </div>

      <div className={styles.stats}>
        <article className={styles.stat}><span>Tokens</span><strong>{formatCompactNumber(summary.tokens + summary.nativeTokens, language)}</strong><small>{t("输入 {input} · 输出 {output}", { input: formatCompactNumber(summary.inputTokens + summary.nativeInputTokens, language), output: formatCompactNumber(summary.outputTokens + summary.nativeOutputTokens, language) })}</small></article>
        <article className={styles.stat}><span>{t("请求量")}</span><strong>{formatInteger(summary.requests + summary.nativeEvents, language)}</strong><small>{summary.nativeEvents > 0 ? t("代理 {proxy} · 原生 {native}", { proxy: formatInteger(summary.requests, language), native: formatInteger(summary.nativeEvents, language) }) : t("{count} 天数据", { count: days.length })}</small></article>
        <article className={styles.stat}><span>{t("缓存输入")}</span><strong>{formatCompactNumber(summary.cachedInputTokens, language)}</strong><small>{t("缓存命中率")} {formatCacheHitRate(summary.cacheHitRate)}</small></article>
        <article className={styles.stat}><span>{t("预估费用")}</span><strong>{formatCostCny(summary.estimatedCost)}</strong><small>{t("Flowlet 可统计用量")}</small></article>
      </div>

      <article className={styles.card}>
        <div className={styles.cardHeader}>
          <div>
            <strong>{t(period === "week"
              ? heatmapMetric === "tokens" ? "每 3 小时 Token 热力图" : "每 3 小时预估费用热力图"
              : heatmapMetric === "tokens" ? "每日 Token 热力图" : "每日预估费用热力图")}</strong>
            <span>{t(period === "week" ? "横轴为星期，纵轴为时段" : "点击日期查看当天汇总")}</span>
          </div>
          <HeatmapMetricSwitch value={heatmapMetric} onChange={setHeatmapMetric} t={t} />
        </div>
        {period === "week" && hourlyUsage.isError ? <div className={styles.state}><strong>{t("用量数据加载失败")}</strong><span>{hourlyUsage.error.message}</span></div> : null}
        {period === "month" && usage.isError ? <div className={styles.state}><strong>{t("用量数据加载失败")}</strong><span>{usage.error.message}</span></div> : null}
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
                        disabled={!cell.hasData}
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
                    disabled={!cell.hasData}
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

      {period === "week" && selectedHourlyCell ? (
        <article ref={selectedDetailRef} className={styles.selectedDay}>
          <div><strong>{selectedHourlyCell.date} {String(selectedHourlyCell.hourOfDay).padStart(2, "0")}:00–{String(selectedHourlyCell.hourEnd - 1).padStart(2, "0")}:59</strong><span>{formatHeatmapPrimary(heatmapMetric, selectedHourlyCell.tokens, selectedHourlyCell.estimatedCost, language)}</span></div>
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
          <div><strong>{selectedDay.date}</strong><span>{formatHeatmapPrimary(heatmapMetric, selectedDay.knownTokens + (selectedDay.nativeTotalTokens ?? 0), selectedDay.estimatedCost ?? 0, language)}</span></div>
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
    </section>
    </MobilePullToRefresh>
  );
}

function formatCacheHitRate(value: number | null) {
  return value == null ? "—" : `${(value * 100).toFixed(1)}%`;
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

function formatHeatmapPrimary(metric: MobileUsageHeatmapMetric, tokens: number, estimatedCost: number, language: NumberLanguage) {
  return metric === "tokens" ? `${formatCompactNumber(tokens, language)} Tokens` : formatCostCny(estimatedCost);
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
