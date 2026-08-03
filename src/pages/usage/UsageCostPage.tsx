import { IconChevronDown, IconChevronRight } from "@douyinfe/semi-icons";
import { Button, Dropdown, Pagination, SideSheet } from "@douyinfe/semi-ui-19";
import { useMemo, useState } from "react";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import { useDeviceDailyUsage, useDeviceHourlyUsage, useKnownDevices } from "../../features/device-sync/useDeviceSync";
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
import { TimePeriodSwitch, TimeRangeNavigator, TimeScopeControl } from "../../shared/ui/TimeScopeControl";
import type { DailyUsageTotal } from "../../domains/device-sync/types";
import {
  buildMobileUsageHeatmap,
  buildMobileWeeklyHourlyHeatmap,
  filterMobileUsage,
  formatMobileUsageRange,
  getMobileUsageRange,
  MOBILE_WEEKLY_HEATMAP_BUCKET_HOURS,
  summarizeMobileUsage,
  type MobileUsageHeatmapMetric,
  type MobileUsagePeriod,
} from "../../features/usage/deviceUsagePresentation";
import styles from "./UsageCostPage.module.css";

export function UsageCostPage() {
  const { language, t } = useAppPreferences();
  const refresh = useRefreshControl({ intervalMs: 30_000 });
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [period, setPeriod] = useState<MobileUsagePeriod>("month");
  const [periodOffset, setPeriodOffset] = useState(0);
  const [heatmapMetric, setHeatmapMetric] = useState<MobileUsageHeatmapMetric>("tokens");
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [selectedHour, setSelectedHour] = useState<string | null>(null);
  const [unknownRequestsOpen, setUnknownRequestsOpen] = useState(false);
  const [unknownRequestsPage, setUnknownRequestsPage] = useState(1);
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
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
    () => buildMobileUsageHeatmap(usage.data ?? [], period, periodOffset, now, heatmapMetric),
    [heatmapMetric, now, period, periodOffset, usage.data],
  );
  const hourlyHeatmap = useMemo(
    () => buildMobileWeeklyHourlyHeatmap(hourlyUsage.data ?? [], periodOffset, now, heatmapMetric),
    [heatmapMetric, hourlyUsage.data, now, periodOffset],
  );
  const selectedDay = useMemo(() => {
    if (selectedDate) {
      return days.find((day) => day.date === selectedDate) ?? emptyDailyUsage(selectedDate);
    }
    return [...days].sort((left, right) => right.date.localeCompare(left.date))[0] ?? null;
  }, [days, selectedDate]);
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
  const selectedPeriodTitle = period === "week" && selectedHourlyCell
    ? selectedHourlyCell.date + " " + String(selectedHourlyCell.hourOfDay).padStart(2, "0")
      + ":00–" + String(selectedHourlyCell.hourEnd - 1).padStart(2, "0") + ":59"
    : selectedDay?.date ?? null;
  const selectedLogRange = useMemo(
    () => getSelectedLogRange(period, selectedDay?.date ?? null, selectedHourlyCell?.hour ?? null),
    [period, selectedDay?.date, selectedHourlyCell?.hour],
  );
  const currentDevice = devices.data?.find((device) => device.isCurrent) ?? null;
  const canReadRequestDetails = deviceId == null || currentDevice?.deviceId === deviceId;
  const unknownRequestFilter = useMemo(() => ({
    ...DEFAULT_REQUEST_LOG_FILTER,
    page: unknownRequestsPage,
    pageSize: 8,
    startAt: selectedLogRange?.startAt ?? "",
    endAt: selectedLogRange?.endAt ?? "",
    tokenStatus: "unknown" as const,
  }), [selectedLogRange, unknownRequestsPage]);
  const unknownRequestLogs = useRequestLogs(
    unknownRequestFilter,
    false,
    unknownRequestsOpen && canReadRequestDetails && selectedLogRange != null,
  );
  const activeQuery = period === "week" ? hourlyUsage : usage;
  const tokenConfidence = useMemo(() => {
    const proxyRequests = period === "week"
      ? Math.max(0, (selectedHourlyCell?.requests ?? 0) - (selectedHourlyCell?.nativeEvents ?? 0))
      : selectedDay?.requestCount ?? 0;
    const nativeEvents = period === "week"
      ? selectedHourlyCell?.nativeEvents ?? 0
      : selectedDay?.nativeEventCount ?? 0;
    const unknownRequests = Math.min(
      proxyRequests,
      period === "week"
        ? selectedHourlyCell?.unknownRequests ?? 0
        : selectedDay?.unknownCount ?? 0,
    );
    const proxyRecognized = Math.max(0, proxyRequests - unknownRequests);
    const recognized = proxyRecognized + nativeEvents;
    const total = proxyRequests + nativeEvents;
    return {
      score: total > 0 ? recognized / total : null,
      proxyShare: total > 0 ? proxyRecognized / total : 0,
      nativeShare: total > 0 ? nativeEvents / total : 0,
      unknownShare: total > 0 ? unknownRequests / total : 0,
      unknownCount: unknownRequests,
    };
  }, [period, selectedDay, selectedHourlyCell]);

  const resetSelection = () => {
    setSelectedDate(null);
    setSelectedHour(null);
  };

  return (
    <main className={styles.page}>
      <PageHeader
        title={(
          <DeviceTitlePicker
            devices={devices.data ?? []}
            deviceId={deviceId}
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
            previousLabel={period === "week" ? t("上一周") : t("上一月")}
            nextLabel={period === "week" ? t("下一周") : t("下一月")}
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
          <span>{t("预估费用")}</span>
          <strong>{formatCostCny(summary.estimatedCost)}</strong>
          <small>{t("Flowlet 可统计用量")}</small>
        </article>
      </section>

      <section className={styles.workspace}>
        <article className={[styles.card, styles.heatmapCard].join(" ")}>
          <div className={styles.cardHeader}>
            <div>
              <strong>{t(period === "week"
                ? heatmapMetric === "tokens" ? "每 3 小时 Token 热力图" : "每 3 小时预估费用热力图"
                : heatmapMetric === "tokens" ? "每日 Token 热力图" : "每日预估费用热力图")}</strong>
              <span>{t(period === "week" ? "横轴为星期，纵轴为时段" : "点击日期查看当天汇总")}</span>
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

          {period === "week" && !activeQuery.isPending && !activeQuery.isError ? (
            <div className={styles.hourlyHeatmapFrame}>
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
                          + formatHeatmapValues(heatmapMetric, cell.tokens, cell.estimatedCost, language, t) + " · "
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
                        cell.outside ? styles.outside : "",
                      ].join(" ")}
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
            </div>
          ) : null}
        </article>

        <aside className={styles.insightColumn}>
          <TokenConfidenceCard
            periodTitle={selectedPeriodTitle}
            score={tokenConfidence.score}
            proxyShare={tokenConfidence.proxyShare}
            nativeShare={tokenConfidence.nativeShare}
            unknownShare={tokenConfidence.unknownShare}
            unknownCount={tokenConfidence.unknownCount}
            language={language}
            t={t}
            onShowUnknownRequests={() => {
              setUnknownRequestsPage(1);
              setUnknownRequestsOpen(true);
            }}
          />

          {period === "week" && selectedHourlyCell ? (
            <SelectedPeriodCard
              title={selectedPeriodTitle ?? selectedHourlyCell.date}
              tokens={selectedHourlyCell.tokens}
              inputTokens={selectedHourlyCell.inputTokens}
              outputTokens={selectedHourlyCell.outputTokens}
              requests={selectedHourlyCell.requests}
              proxyRequests={selectedHourlyCell.requests - selectedHourlyCell.nativeEvents}
              nativeEvents={selectedHourlyCell.nativeEvents}
              cachedInputTokens={selectedHourlyCell.cachedInputTokens}
              cacheMeasuredInputTokens={selectedHourlyCell.cacheMeasuredInputTokens}
              estimatedCost={selectedHourlyCell.estimatedCost}
              language={language}
              t={t}
            />
          ) : null}

          {period === "month" && selectedDay ? (
            <SelectedPeriodCard
              title={selectedPeriodTitle ?? selectedDay.date}
              tokens={selectedDay.knownTokens + (selectedDay.nativeTotalTokens ?? 0)}
              inputTokens={selectedDay.inputTokens + (selectedDay.nativeInputTokens ?? 0)}
              outputTokens={selectedDay.outputTokens + (selectedDay.nativeOutputTokens ?? 0)}
              requests={selectedDay.requestCount + (selectedDay.nativeEventCount ?? 0)}
              proxyRequests={selectedDay.requestCount}
              nativeEvents={selectedDay.nativeEventCount ?? 0}
              cachedInputTokens={selectedDay.inputCachedTokens}
              cacheMeasuredInputTokens={selectedDay.cacheMeasuredInputTokens}
              estimatedCost={selectedDay.estimatedCost ?? 0}
              language={language}
              t={t}
            />
          ) : null}

          {!selectedPeriod ? <SelectedPeriodEmpty t={t} /> : null}
        </aside>
      </section>

      <SideSheet
        title={t("未识别 Token 的请求")}
        visible={unknownRequestsOpen && selectedRequestId == null}
        onCancel={() => setUnknownRequestsOpen(false)}
        width="min(640px, 96vw)"
        bodyStyle={{ padding: 0 }}
        zIndex={APP_OVERLAY_Z_INDEX.sideSheet}
        footer={null}
      >
        <div className={styles.unknownRequestsSheet}>
          <div className={styles.unknownRequestsIntro}>
            <strong>{selectedPeriodTitle ?? t("指定时间点")}</strong>
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
  tokens,
  inputTokens,
  outputTokens,
  requests,
  proxyRequests,
  nativeEvents,
  cachedInputTokens,
  cacheMeasuredInputTokens,
  estimatedCost,
  language,
  t,
}: {
  title: string;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  requests: number;
  proxyRequests: number;
  nativeEvents: number;
  cachedInputTokens: number;
  cacheMeasuredInputTokens: number;
  estimatedCost: number;
  language: NumberLanguage;
  t: ReturnType<typeof useAppPreferences>["t"];
}) {
  return (
    <article className={styles.selectedPeriod}>
      <header className={styles.selectedPeriodHeader}>
        <strong>{title}</strong>
        <span>{t("指定时间点")}</span>
      </header>
      <div className={styles.selectedPeriodStats}>
        <SelectedPeriodMetric
          label="Tokens"
          value={formatCompactNumber(tokens, language)}
          detail={t("输入 {input} · 输出 {output}", {
            input: formatCompactNumber(inputTokens, language),
            output: formatCompactNumber(outputTokens, language),
          })}
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
          value={formatCompactNumber(cachedInputTokens, language)}
          detail={`${t("缓存命中率")} ${formatCacheHitRate(
            cacheMeasuredInputTokens > 0 ? cachedInputTokens / cacheMeasuredInputTokens : null,
          )}`}
        />
        <SelectedPeriodMetric
          label={t("预估费用")}
          value={formatCostCny(estimatedCost)}
          detail={t("Flowlet 可统计用量")}
        />
      </div>
    </article>
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

export function DeviceTitlePicker({ devices, deviceId, onChange }: {
  devices: Array<{ deviceId: string; displayName: string }>;
  deviceId: string | null;
  onChange: (deviceId: string | null) => void;
}) {
  const { t } = useAppPreferences();
  const selectedDevice = devices.find((device) => device.deviceId === deviceId) ?? null;
  const selectedName = selectedDevice?.displayName ?? t("全部设备");

  return (
    <Dropdown
      position="bottomLeft"
      trigger="click"
      clickToHide
      render={(
        <Dropdown.Menu>
          <Dropdown.Item active={deviceId == null} onClick={() => onChange(null)}>
            {t("全部设备")}
          </Dropdown.Item>
          {devices.map((device) => (
            <Dropdown.Item
              key={device.deviceId}
              active={device.deviceId === deviceId}
              onClick={() => onChange(device.deviceId)}
            >
              {device.displayName}
            </Dropdown.Item>
          ))}
        </Dropdown.Menu>
      )}
    >
      <button
        type="button"
        className={styles.deviceTitleTrigger}
        aria-label={t("切换设备，当前：{name}", { name: selectedName })}
      >
        <span>{selectedDevice ? `${selectedDevice.displayName} ${t("概览")}` : t("全部概览")}</span>
        <IconChevronDown />
      </button>
    </Dropdown>
  );
}

function SelectedPeriodMetric({ label, value, detail }: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className={styles.selectedPeriodMetric}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
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
  periodTitle,
  score,
  proxyShare,
  nativeShare,
  unknownShare,
  unknownCount,
  language,
  t,
  onShowUnknownRequests,
}: {
  periodTitle: string | null;
  score: number | null;
  proxyShare: number;
  nativeShare: number;
  unknownShare: number;
  unknownCount: number;
  language: NumberLanguage;
  t: ReturnType<typeof useAppPreferences>["t"];
  onShowUnknownRequests: () => void;
}) {
  const scoreLabel = score == null ? "—" : formatConfidence(score);
  const scoreDegrees = score == null ? 0 : Math.max(0, Math.min(360, score * 360));
  return (
    <article className={styles.confidenceCard}>
      <header>
        <strong>{t("数据可信度")}</strong>
        <span>{periodTitle ?? t("暂无选定时间数据")}</span>
      </header>
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
    </article>
  );
}

function getSelectedLogRange(period: MobileUsagePeriod, selectedDate: string | null, selectedHour: string | null) {
  const rawStart = period === "week" ? selectedHour : selectedDate ? `${selectedDate}T00:00:00` : null;
  if (!rawStart) return null;
  const start = new Date(rawStart);
  if (Number.isNaN(start.getTime())) return null;
  const end = new Date(start);
  if (period === "week") end.setHours(end.getHours() + MOBILE_WEEKLY_HEATMAP_BUCKET_HOURS);
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
