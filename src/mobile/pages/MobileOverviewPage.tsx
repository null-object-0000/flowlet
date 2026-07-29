import { IconChevronLeft, IconChevronRight } from "@douyinfe/semi-icons";
import { Button, Select } from "@douyinfe/semi-ui-19";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import { useMobileDailyUsage, useMobileDevices, useMobileDeviceSyncActions, useMobileS3Settings } from "../../features/device-sync/useMobileDeviceSync";
import { errorMessage } from "../../shared/errors/AppError";
import { formatFullTimestamp } from "../../shared/formatters/datetime";
import { formatCompactNumber, formatInteger } from "../../shared/formatters/number";
import {
  buildMobileUsageHeatmap,
  filterMobileUsage,
  formatMobileUsageRange,
  getMobileUsageRange,
  summarizeMobileUsage,
  type MobileUsagePeriod,
} from "../mobileUsage";
import styles from "./MobilePage.module.css";

export function MobileOverviewPage() {
  const { language, t } = useAppPreferences();
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [period, setPeriod] = useState<MobileUsagePeriod>("month");
  const [periodOffset, setPeriodOffset] = useState(0);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const settings = useMobileS3Settings();
  const devices = useMobileDevices();
  const usage = useMobileDailyUsage(deviceId);
  const actions = useMobileDeviceSyncActions();
  const autoRefreshStarted = useRef(false);
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
  const selectedDay = useMemo(
    () => days.find((day) => day.date === selectedDate)
      ?? [...days].sort((left, right) => right.date.localeCompare(left.date))[0]
      ?? null,
    [days, selectedDate],
  );
  const weekdayLabels = useMemo(
    () => Array.from({ length: 7 }, (_, index) => new Date(2026, 6, 13 + index).toLocaleDateString(language, { weekday: "narrow" })),
    [language],
  );

  useEffect(() => {
    if (!settings.data?.config || autoRefreshStarted.current) return;
    autoRefreshStarted.current = true;
    setRefreshError(null);
    void actions.refreshS3.mutateAsync().catch((error) => {
      setRefreshError(errorMessage(error));
    });
  }, [settings.data?.config]);

  const status = settings.data?.status;
  const statusState = refreshError ? "failed" : actions.refreshS3.isPending ? "running" : status?.status ?? "never";
  const statusText = refreshError
    ? t("自动刷新失败：{message}", { message: refreshError })
    : actions.refreshS3.isPending
      ? t("正在刷新远端数据…")
      : status?.message ?? t("正在读取设置…");

  return (
    <section className={styles.page}>
      <header className={styles.heading}>
        <div><h2>{t("概览")}</h2><p>{t("按设备查看每周或每月 Token 热力图")}</p></div>
      </header>

      {!settings.isLoading && !settings.data?.config ? (
        <div className={`${styles.card} ${styles.state}`}>
          <strong>{t("尚未配置数据源")}</strong>
          <span>{t("前往设置，扫描桌面端二维码或粘贴连接文本。")}</span>
        </div>
      ) : null}

      <div className={styles.overviewFilters}>
        <Select
          value={deviceId ?? "__all__"}
          aria-label={t("设备")}
          optionList={[
            { value: "__all__", label: t("全部设备") },
            ...(devices.data ?? []).map((device) => ({ value: device.deviceId, label: device.displayName })),
          ]}
          onChange={(value) => {
            setDeviceId(value === "__all__" ? null : String(value));
            setSelectedDate(null);
          }}
        />
        <div className={styles.periodToolbar}>
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
                setSelectedDate(null);
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
              }}
            />
          </div>
        </div>
      </div>

      <div className={styles.syncStrip}>
        <div className={styles.status} data-state={statusState}><i /><span>{statusText}</span></div>
        <time>{status?.lastSuccessAt ? formatFullTimestamp(status.lastSuccessAt, language) : t("尚未成功刷新")}</time>
      </div>

      <div className={styles.stats}>
        <article className={styles.stat}><span>Tokens</span><strong>{formatCompactNumber(summary.tokens, language)}</strong><small>{t("输入 {input} · 输出 {output}", { input: formatCompactNumber(summary.inputTokens, language), output: formatCompactNumber(summary.outputTokens, language) })}</small></article>
        <article className={styles.stat}><span>{t("请求量")}</span><strong>{formatInteger(summary.requests, language)}</strong><small>{t("{count} 天数据", { count: days.length })}</small></article>
        <article className={styles.stat}><span>{t("缓存输入")}</span><strong>{formatCompactNumber(summary.cachedInputTokens, language)}</strong><small>Tokens</small></article>
        <article className={styles.stat}><span>{t("设备")}</span><strong>{deviceId ? "1" : formatInteger(devices.data?.length ?? 0, language)}</strong><small>{deviceId ? t("指定设备") : t("全部设备")}</small></article>
      </div>

      <article className={styles.card}>
        <div className={styles.cardHeader}><div><strong>{t("每日 Token 热力图")}</strong><span>{t("点击日期查看当天汇总")}</span></div></div>
        {usage.isError ? <div className={styles.state}><strong>{t("用量数据加载失败")}</strong><span>{usage.error.message}</span></div> : null}
        {!usage.isError ? (
          <>
            <div className={styles.heatmapLabels}>
              {weekdayLabels.map((label, index) => <span key={`${index}-${label}`}>{label}</span>)}
            </div>
            <div className={styles.mobileHeatmap}>
              {heatmap.cells.map((cell) => {
                const title = `${cell.date} · ${formatInteger(cell.tokens, language)} Tokens · ${t("{count} 次请求", { count: formatInteger(cell.requests, language) })}`;
                return (
                  <button
                    key={cell.date}
                    type="button"
                    className={`${styles.heatmapCell} ${styles[`heatLevel${cell.level}`]} ${cell.outside ? styles.outside : ""}`}
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
            <div className={styles.heatmapLegend}><span>{t("少")}</span>{[0, 1, 2, 3, 4].map((level) => <i key={level} className={`${styles.heatmapCell} ${styles[`heatLevel${level}`]}`} />)}<span>{t("多")}</span></div>
            {days.length === 0 ? <div className={styles.emptyHint}>{t("当前周期暂无数据")}</div> : null}
          </>
        ) : null}
      </article>

      {selectedDay ? (
        <article className={styles.selectedDay}>
          <div><strong>{selectedDay.date}</strong><span>{formatCompactNumber(selectedDay.knownTokens, language)} Tokens</span></div>
          <small>{t("{count} 次请求", { count: formatInteger(selectedDay.requestCount, language) })} · {t("输入 {input} · 输出 {output}", { input: formatCompactNumber(selectedDay.inputTokens, language), output: formatCompactNumber(selectedDay.outputTokens, language) })}</small>
        </article>
      ) : null}
    </section>
  );
}
