import { IconChevronLeft, IconChevronRight } from "@douyinfe/semi-icons";
import { Button, Select } from "@douyinfe/semi-ui-19";
import { useMemo, useState } from "react";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import { useDeviceDailyUsage, useDeviceHourlyUsage, useKnownDevices } from "../../features/device-sync/useDeviceSync";
import { PageHeader } from "../../shared/ui/PageHeader";
import { RefreshControl } from "../../shared/ui/RefreshControl";
import { useRefreshControl } from "../../shared/ui/useRefreshControl";
import { formatCompactNumber, formatInteger, type NumberLanguage } from "../../shared/formatters/number";
import {
  buildMobileUsageHeatmap,
  buildMobileWeeklyHourlyHeatmap,
  filterMobileUsage,
  formatMobileUsageRange,
  getMobileUsageRange,
  MOBILE_WEEKLY_HEATMAP_BUCKET_HOURS,
  summarizeMobileUsage,
  type MobileUsagePeriod,
} from "../../features/usage/deviceUsagePresentation";
import styles from "./UsageCostPage.module.css";

export function UsageCostPage() {
  const { language, t } = useAppPreferences();
  const refresh = useRefreshControl({ intervalMs: 30_000 });
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [period, setPeriod] = useState<MobileUsagePeriod>("month");
  const [periodOffset, setPeriodOffset] = useState(0);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [selectedHour, setSelectedHour] = useState<string | null>(null);
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
  const heatmap = useMemo(
    () => buildMobileUsageHeatmap(usage.data ?? [], period, periodOffset, now),
    [now, period, periodOffset, usage.data],
  );
  const hourlyHeatmap = useMemo(
    () => buildMobileWeeklyHourlyHeatmap(hourlyUsage.data ?? [], periodOffset, now),
    [hourlyUsage.data, now, periodOffset],
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
    () => Array.from(
      { length: 7 },
      (_, index) => new Date(2026, 6, 13 + index).toLocaleDateString(language, { weekday: "narrow" }),
    ),
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
  const selectedPeriod = period === "week" ? selectedHourlyCell : selectedDay;
  const activeQuery = period === "week" ? hourlyUsage : usage;
  const tokenConfidence = useMemo(() => {
    const unknownRequests = days.reduce((total, day) => total + day.unknownCount, 0);
    const proxyRecognized = Math.max(0, summary.requests - unknownRequests);
    const recognized = proxyRecognized + summary.nativeEvents;
    const total = summary.requests + summary.nativeEvents;
    return {
      score: total > 0 ? recognized / total : null,
      proxyShare: total > 0 ? proxyRecognized / total : 0,
      nativeShare: total > 0 ? summary.nativeEvents / total : 0,
      unknownShare: total > 0 ? unknownRequests / total : 0,
      unknownCount: unknownRequests,
    };
  }, [days, summary.nativeEvents, summary.requests]);

  const resetSelection = () => {
    setSelectedDate(null);
    setSelectedHour(null);
  };

  return (
    <main className={styles.page}>
      <PageHeader title={t("用量概览")} subtitle={t("按设备和时间查看 Token 使用规模与活跃节奏")}>
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

      <section className={styles.toolbar}>
        <Select
          className={styles.deviceSelect}
          value={deviceId ?? "__all__"}
          aria-label={t("设备")}
          optionList={[
            { value: "__all__", label: t("全部设备") },
            ...(devices.data ?? []).map((device) => ({ value: device.deviceId, label: device.displayName })),
          ]}
          onChange={(value) => {
            setDeviceId(value === "__all__" ? null : String(value));
            resetSelection();
          }}
        />
        <div className={styles.periodTabs} aria-label={t("统计维度")}>
          {(["week", "month"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={period === value}
              onClick={() => {
                setPeriod(value);
                setPeriodOffset(0);
                resetSelection();
              }}
            >
              {value === "week" ? t("周") : t("月")}
            </button>
          ))}
        </div>
        <div className={styles.rangeNavigator}>
          <Button
            theme="borderless"
            size="small"
            icon={<IconChevronLeft />}
            aria-label={period === "week" ? t("上一周") : t("上一月")}
            onClick={() => {
              setPeriodOffset((offset) => offset - 1);
              resetSelection();
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
              resetSelection();
            }}
          />
        </div>
      </section>

      <section className={styles.stats}>
        <article className={styles.stat}>
          <span>Tokens</span>
          <strong>{formatCompactNumber(summary.tokens + summary.nativeTokens, language)}</strong>
          <small>{t("输入 {input} · 输出 {output}", {
            input: formatCompactNumber(summary.inputTokens + summary.nativeInputTokens, language),
            output: formatCompactNumber(summary.outputTokens + summary.nativeOutputTokens, language),
          })}</small>
        </article>
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
        <article className={styles.stat}>
          <span>{t("缓存输入")}</span>
          <strong>{formatCompactNumber(summary.cachedInputTokens, language)}</strong>
          <small>{t("缓存命中率")} {formatCacheHitRate(summary.cacheHitRate)}</small>
        </article>
        <article className={styles.stat}>
          <span>{t("设备")}</span>
          <strong>{deviceId ? "1" : formatInteger(devices.data?.length ?? 0, language)}</strong>
          <small>{deviceId ? t("指定设备") : t("全部设备")}</small>
        </article>
      </section>

      <section className={styles.workspace}>
        <article className={[styles.card, styles.heatmapCard].join(" ")}>
          <div className={styles.cardHeader}>
            <div>
              <strong>{t(period === "week" ? "每 3 小时 Token 热力图" : "每日 Token 热力图")}</strong>
              <span>{t(period === "week" ? "横轴为星期，纵轴为时段" : "点击日期查看当天汇总")}</span>
            </div>
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

          {period === "week" && !activeQuery.isPending && !activeQuery.isError ? (
            <>
              <div className={styles.hourlyHeatmap}>
                <span />
                {weekdayLabels.map((label, dayIndex) => (
                  <span className={styles.hourDayLabel} key={label + "-" + dayIndex}>{label}</span>
                ))}
                {Array.from(
                  { length: 24 / MOBILE_WEEKLY_HEATMAP_BUCKET_HOURS },
                  (_, bucketIndex) => {
                    const bucketCells = hourlyHeatmap.cells.slice(bucketIndex * 7, bucketIndex * 7 + 7);
                    const hourStart = bucketIndex * MOBILE_WEEKLY_HEATMAP_BUCKET_HOURS;
                    return [
                      <span className={styles.hourLabel} key={"label-" + hourStart}>
                        {String(hourStart).padStart(2, "0")}–{String(hourStart + MOBILE_WEEKLY_HEATMAP_BUCKET_HOURS).padStart(2, "0")}
                      </span>,
                      ...bucketCells.map((cell) => {
                        const title = cell.date + " " + String(cell.hourOfDay).padStart(2, "0") + ":00–"
                          + String(cell.hourEnd - 1).padStart(2, "0") + ":59 · "
                          + formatInteger(cell.tokens, language) + " Tokens · "
                          + t("{count} 次请求", { count: formatInteger(cell.requests, language) })
                          + formatNativeSplit(cell.tokens, cell.nativeTokens, language, t);
                        return (
                          <button
                            key={cell.hour}
                            type="button"
                            className={[
                              styles.hourCell,
                              styles["heatLevel" + cell.level],
                              cell.outside ? styles.outside : "",
                            ].join(" ")}
                            disabled={!cell.hasData}
                            aria-label={title}
                            aria-pressed={selectedHourlyCell?.hour === cell.hour}
                            title={title}
                            onClick={() => setSelectedHour(cell.hour)}
                          />
                        );
                      }),
                    ];
                  },
                )}
                <span aria-hidden="true" />
                {weekDateLabels.map((label, dayIndex) => (
                  <span className={styles.hourDateLabel} key={label + "-" + dayIndex}>{label}</span>
                ))}
              </div>
              <HeatmapLegend t={t} />
              {!hourlyHeatmap.cells.some((cell) => cell.hasData) ? (
                <div className={styles.emptyHint}>{t("当前周期暂无数据")}</div>
              ) : null}
            </>
          ) : null}

          {period === "month" && !activeQuery.isPending && !activeQuery.isError ? (
            <>
              <div className={styles.heatmapLabels}>
                {weekdayLabels.map((label, index) => <span key={index + "-" + label}>{label}</span>)}
              </div>
              <div className={styles.monthHeatmap}>
                {heatmap.cells.map((cell) => {
                  const title = cell.date + " · " + formatInteger(cell.tokens, language) + " Tokens · "
                    + t("{count} 次请求", { count: formatInteger(cell.requests, language) })
                    + formatNativeSplit(cell.tokens, cell.nativeTokens, language, t);
                  return (
                    <button
                      key={cell.date}
                      type="button"
                      className={[
                        styles.heatmapCell,
                        styles["heatLevel" + cell.level],
                        cell.outside ? styles.outside : "",
                      ].join(" ")}
                      disabled={!cell.hasData}
                      aria-label={title}
                      aria-pressed={selectedDay?.date === cell.date}
                      title={title}
                      onClick={() => setSelectedDate(cell.date)}
                    >
                      <span>{Number(cell.date.slice(-2))}</span>
                    </button>
                  );
                })}
              </div>
              <HeatmapLegend t={t} />
              {days.length === 0 ? <div className={styles.emptyHint}>{t("当前周期暂无数据")}</div> : null}
            </>
          ) : null}
        </article>

        <aside className={styles.insightColumn}>
          {period === "week" && selectedHourlyCell ? (
            <SelectedPeriodCard
              title={selectedHourlyCell.date + " " + String(selectedHourlyCell.hourOfDay).padStart(2, "0")
                + ":00–" + String(selectedHourlyCell.hourEnd - 1).padStart(2, "0") + ":59"}
              tokens={formatCompactNumber(selectedHourlyCell.tokens, language)}
              detail={t("{count} 次请求", { count: formatInteger(selectedHourlyCell.requests, language) })}
              split={selectedHourlyCell.nativeTokens > 0
                ? t("Flowlet {proxy} · 原生 {native}", {
                  proxy: formatCompactNumber(selectedHourlyCell.tokens - selectedHourlyCell.nativeTokens, language),
                  native: formatCompactNumber(selectedHourlyCell.nativeTokens, language),
                })
                : null}
            />
          ) : null}

          {period === "month" && selectedDay ? (
            <SelectedPeriodCard
              title={selectedDay.date}
              tokens={formatCompactNumber(selectedDay.knownTokens + (selectedDay.nativeTotalTokens ?? 0), language)}
              detail={t("{count} 次请求", {
                count: formatInteger(selectedDay.requestCount + (selectedDay.nativeEventCount ?? 0), language),
              }) + " · "
                + t("输入 {input} · 输出 {output}", {
                  input: formatCompactNumber(selectedDay.inputTokens + (selectedDay.nativeInputTokens ?? 0), language),
                  output: formatCompactNumber(selectedDay.outputTokens + (selectedDay.nativeOutputTokens ?? 0), language),
                })}
              split={(selectedDay.nativeTotalTokens ?? 0) > 0
                ? t("Flowlet {proxy} · 原生 {native}", {
                  proxy: formatCompactNumber(selectedDay.knownTokens, language),
                  native: formatCompactNumber(selectedDay.nativeTotalTokens ?? 0, language),
                })
                : null}
            />
          ) : null}

          {!selectedPeriod ? <SelectedPeriodEmpty t={t} /> : null}

          <TokenConfidenceCard
            score={tokenConfidence.score}
            proxyShare={tokenConfidence.proxyShare}
            nativeShare={tokenConfidence.nativeShare}
            unknownShare={tokenConfidence.unknownShare}
            unknownCount={tokenConfidence.unknownCount}
            language={language}
            t={t}
          />
        </aside>
      </section>
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

function SelectedPeriodCard({ title, tokens, detail, split }: {
  title: string;
  tokens: string;
  detail: string;
  split?: string | null;
}) {
  return (
    <article className={styles.selectedPeriod}>
      <span className={styles.selectedLabel}>Token</span>
      <strong className={styles.selectedTokens}>{tokens}</strong>
      <small>Tokens</small>
      <div className={styles.selectedMeta}>
        <strong>{title}</strong>
        <span>{detail}</span>
        {split ? <span>{split}</span> : null}
      </div>
    </article>
  );
}

function SelectedPeriodEmpty({ t }: { t: ReturnType<typeof useAppPreferences>["t"] }) {
  return (
    <article className={[styles.selectedPeriod, styles.selectedPeriodEmpty].join(" ")}>
      <span className={styles.selectedLabel}>Token</span>
      <strong>{t("暂无选定时间数据")}</strong>
      <small>{t("选择有数据的日期或时段后查看详情")}</small>
    </article>
  );
}

function TokenConfidenceCard({
  score,
  proxyShare,
  nativeShare,
  unknownShare,
  unknownCount,
  language,
  t,
}: {
  score: number | null;
  proxyShare: number;
  nativeShare: number;
  unknownShare: number;
  unknownCount: number;
  language: NumberLanguage;
  t: ReturnType<typeof useAppPreferences>["t"];
}) {
  const scoreLabel = score == null ? "—" : formatConfidence(score);
  const scoreDegrees = score == null ? 0 : Math.max(0, Math.min(360, score * 360));
  return (
    <article className={styles.confidenceCard}>
      <header>
        <strong>{t("数据可信度")}</strong>
        <span>{t("Token 与费用估算的数据来源构成")}</span>
      </header>
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
      {unknownCount > 0 ? (
        <p>{t("{count} 次请求暂未识别 Token，可在数据完整性检查中尝试修复。", {
          count: formatInteger(unknownCount, language),
        })}</p>
      ) : (
        <p>{t("当前范围内所有请求均包含可统计 Token；来源级评分将在同步数据支持后进一步细分。")}</p>
      )}
    </article>
  );
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
  return (Math.max(0, Math.min(1, value)) * 100).toFixed(1) + "%";
}
