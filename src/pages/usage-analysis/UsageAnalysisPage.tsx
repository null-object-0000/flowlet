import { Fragment, useMemo, useState } from "react";
import { Button, SideSheet, Tooltip } from "@douyinfe/semi-ui-19";
import { IconChevronRight, IconExternalOpen } from "@douyinfe/semi-icons";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import type { UsageSummaryRow } from "../../domains/usage/types";
import { ChannelBrandLogo } from "../../features/channel-accounts/ChannelBrandLogo";
import { formatDuration, formatTokenRate } from "../../features/request-logs/logPresentation";
import { useKnownDevices } from "../../features/device-sync/useDeviceSync";
import { DeviceUsageTitlePicker } from "../../features/device-sync/DeviceUsageTitlePicker";
import { useModelPriceCurrencyLookup } from "../../features/usage/useModelPriceCurrencies";
import { useUsageSummary } from "../../features/usage/useUsageSummary";
import { AgentBrandMark } from "../../shared/ui/AgentBrandMark";
import { CompactNumber } from "../../shared/ui/CompactNumber";
import { PageHeader } from "../../shared/ui/PageHeader";
import { dominantCostCurrency, formatCostAmount, formatMultiCurrencyCost } from "../../shared/formatters/cost";
import { formatCompactNumber, formatInteger } from "../../shared/formatters/number";
import { RefreshControl } from "../../shared/ui/RefreshControl";
import { TokenBreakdownTooltip } from "../../shared/ui/TokenBreakdownTooltip";
import { useRefreshControl } from "../../shared/ui/useRefreshControl";
import { APP_OVERLAY_Z_INDEX } from "../../shared/ui/overlayLayers";
import { weekRange, type TimeRangeValue } from "../../shared/timeRange";
import { CalendarTimeRangeControl, TimeScopeControl } from "../../shared/ui/TimeScopeControl";
import {
  averageElapsedMsOf,
  buildCrossMatrix,
  cacheHitRateOf,
  cellId,
  filterConsumptionByDevice,
  groupConsumption,
  outputTokensPerSecondOf,
  type ConsumptionDimension,
  type ConsumptionEntry,
  type ConsumptionMetric,
  type CrossMatrix,
  type CrossMatrixAxisEntry,
} from "./consumptionAnalysisPresentation";
import styles from "./UsageAnalysisPage.module.css";

const EMPTY_ROWS: UsageSummaryRow[] = [];
const COMPACT_MATRIX_COLUMN_COUNT = 4;

const DIMENSION_OPTIONS: Array<{ value: ConsumptionDimension; label: string }> = [
  { value: "model", label: "按模型" },
  { value: "account", label: "按渠道账号" },
  { value: "client", label: "按客户端" },
  { value: "device", label: "按设备" },
];

/** AgentBrandMark 已内置品牌图标的客户端 ID（其余客户端展示首字母徽标）。 */
const BRANDED_AGENT_IDS = new Set(["claude-code", "opencode", "pi", "chatgpt-desktop", "codex", "codex-desktop"]);

export function UsageAnalysisPage() {
  const { language, t } = useAppPreferences();
  const refresh = useRefreshControl({ intervalMs: 30_000 });
  const [timeRange, setTimeRange] = useState<TimeRangeValue>(() => weekRange());
  const [dimension, setDimension] = useState<ConsumptionDimension>("model");
  const [matrixMetric, setMatrixMetric] = useState<ConsumptionMetric>("tokens");
  const [matrixExpanded, setMatrixExpanded] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const summaryFilter = useMemo(() => ({ ...timeRange, groupBy: "day" as const }), [timeRange]);
  const { query } = useUsageSummary(summaryFilter, refresh.autoRefresh);
  const { modelCurrencyOf } = useModelPriceCurrencyLookup();
  const knownDevices = useKnownDevices();

  // device_id → 设备展示名：优先用同步来的 known_devices.display_name，
  // 本机则标「本机」，未匹配时回退到 device_id。
  const deviceNameLookup = useMemo(() => {
    const map = new Map<string, string>();
    for (const device of knownDevices.data ?? []) {
      map.set(device.deviceId, device.displayName);
    }
    return map;
  }, [knownDevices.data]);
  const resolveDeviceName = useMemo(() => {
    const currentId = (knownDevices.data ?? []).find((device) => device.isCurrent)?.deviceId;
    return (deviceId: string): string => {
      if (currentId && deviceId === currentId) return t("本机");
      return deviceNameLookup.get(deviceId) || deviceId;
    };
  }, [deviceNameLookup, knownDevices.data, t]);

  const allRows = query.data ?? EMPTY_ROWS;
  const rows = useMemo(
    () => filterConsumptionByDevice(allRows, deviceId),
    [allRows, deviceId],
  );
  const entries = useMemo(
    () => groupConsumption(rows, dimension, modelCurrencyOf, resolveDeviceName),
    [rows, dimension, modelCurrencyOf, resolveDeviceName],
  );
  const matrix = useMemo(
    () => buildCrossMatrix(rows, dimension, matrixMetric, modelCurrencyOf),
    [rows, dimension, matrixMetric, modelCurrencyOf],
  );
  const compactMatrixColumns = matrix.columns.slice(0, COMPACT_MATRIX_COLUMN_COUNT);
  const selected = entries.find((entry) => entry.key === selectedKey) ?? entries[0] ?? null;

  const changeDimension = (next: ConsumptionDimension) => {
    setDimension(next);
    setSelectedKey(null);
    setMatrixExpanded(false);
  };

  const changeTimeRange = (next: TimeRangeValue) => {
    setTimeRange(next);
    setMatrixExpanded(false);
  };

  const loading = query.isPending && query.data == null;
  const matrixSubtitle = dimension === "model"
    ? t("模型 × 渠道账号，颜色越深消耗越高")
    : dimension === "account"
      ? t("渠道账号 × 模型，颜色越深消耗越高")
      : dimension === "client"
        ? t("客户端 × 模型，颜色越深消耗越高")
        : t("设备 × 模型，颜色越深消耗越高");

  return (
    <main className={styles.page}>
      <PageHeader
        title={(
          <DeviceUsageTitlePicker
            devices={knownDevices.data ?? []}
            deviceId={deviceId}
            title="用量洞察"
            onChange={(value) => {
              setDeviceId(value);
              setSelectedKey(null);
              setMatrixExpanded(false);
            }}
          />
        )}
        subtitle={t("合并 Flowlet 请求与可识别模型的 Agent 原生用量，拆解 Token、费用与性能")}
      >
        <TimeScopeControl>
          <CalendarTimeRangeControl
            value={timeRange}
            onChange={changeTimeRange}
            language={language}
            t={t}
          />
        </TimeScopeControl>
        <RefreshControl
          autoRefresh={refresh.autoRefresh}
          onToggleAutoRefresh={refresh.toggleAutoRefresh}
          isFetching={query.isFetching}
          lastUpdatedAt={query.dataUpdatedAt || undefined}
          intervalMs={refresh.intervalMs}
          onRefresh={() => void query.refetch()}
          language={language}
          t={t}
        />
      </PageHeader>

      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <div className={styles.cardTitle}>
            <strong>{t("多维归因")}</strong>
            <span>{t("切换主维度，再交叉查看 Token 与费用归因")}</span>
          </div>
          <div className={styles.dimensionTabs} role="tablist" aria-label={t("分析维度")}>
            {DIMENSION_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="tab"
                aria-selected={dimension === option.value}
                onClick={() => changeDimension(option.value)}
              >
                {t(option.label)}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <div className={styles.state}><span>{t("正在加载用量…")}</span></div>
        ) : null}

        {!loading && query.isError ? (
          <div className={styles.state}>
            <strong>{t("用量数据加载失败")}</strong>
            <span>{query.error.message}</span>
            <Button size="small" onClick={() => void query.refetch()}>{t("重试")}</Button>
          </div>
        ) : null}

        {!loading && !query.isError && entries.length === 0 ? (
          <div className={styles.state}><span>{t("当前周期暂无数据")}</span></div>
        ) : null}

        {!loading && !query.isError && entries.length > 0 ? (
          <div className={styles.body}>
            <div className={styles.rankPane}>
              <div className={styles.rankHead}>
                <span>{t("对象")}</span>
                <span>{t("Token / 占比")}</span>
                <span>{t("预估费用")}</span>
                <span aria-hidden="true" />
              </div>
              {entries.map((entry) => (
                <RankRow
                  key={entry.key}
                  entry={entry}
                  dimension={dimension}
                  selected={entry.key === (selectedKey ?? entries[0]?.key)}
                  onSelect={() => setSelectedKey(entry.key)}
                  language={language}
                  t={t}
                />
              ))}
            </div>

            <aside className={styles.matrixPane}>
              <div className={styles.matrixHead}>
                <div className={styles.matrixTitle}>
                  <strong>{t("交叉归因矩阵")}</strong>
                  <span>{matrixSubtitle}</span>
                </div>
                <div className={styles.metricSeg} aria-label={t("矩阵指标")}>
                  {(["tokens", "cost"] as const).map((metric) => (
                    <button
                      key={metric}
                      type="button"
                      aria-pressed={matrixMetric === metric}
                      onClick={() => setMatrixMetric(metric)}
                    >
                      {metric === "tokens" ? "Token" : t("预估费用")}
                    </button>
                  ))}
                </div>
              </div>

              <div className={styles.matrixScroll}>
                <CrossMatrixGrid
                  entries={entries}
                  columns={compactMatrixColumns}
                  matrix={matrix}
                  metric={matrixMetric}
                  selectedKey={selectedKey ?? entries[0]?.key ?? null}
                  onSelect={setSelectedKey}
                  language={language}
                  t={t}
                />
              </div>

              <div className={styles.matrixFoot}>
                <HeatLegend t={t} />
                <Button
                  className={styles.expandMatrixButton}
                  theme="borderless"
                  size="small"
                  icon={<IconExternalOpen />}
                  onClick={() => setMatrixExpanded(true)}
                >
                  {matrix.columns.length > COMPACT_MATRIX_COLUMN_COUNT
                    ? t("展开全部 {count} 项", { count: matrix.columns.length })
                    : t("展开查看")}
                </Button>
              </div>

              {selected ? (
                <article className={styles.detail} key={selected.key}>
                  <header className={styles.detailHead}>
                    <strong title={selected.label}>{selected.label}</strong>
                    <span className={styles.detailPill}>{t("已选中")}</span>
                  </header>
                  <div className={styles.detailGrid}>
                    <div>
                      <span>{t("输入 / 输出")}</span>
                      <strong>
                        {formatCompactNumber(selected.inputTokens, language)} / {formatCompactNumber(selected.outputTokens, language)}
                      </strong>
                    </div>
                    <div>
                      <span>{t("输出速度")}</span>
                      <Tooltip content={t("输出 Token ÷ 生成耗时（总耗时 − 首 Token），与请求日志同口径")}>
                        <strong className={styles.detailSpeed}>
                          {formatTokenRate(outputTokensPerSecondOf(selected))}
                        </strong>
                      </Tooltip>
                    </div>
                    <div>
                      <span>{t("缓存命中率")}</span>
                      <strong>{formatPercent(cacheHitRateOf(selected))}</strong>
                    </div>
                  </div>
                  <div className={styles.detailMeta}>
                    {selected.requests > 0
                      ? t("{count} 次请求", { count: formatInteger(selected.requests, language) })
                      : t("无 Flowlet 请求")}
                    {selected.nativeEvents > 0
                      ? ` · ${t("{count} 条 Agent 原生事件", { count: formatInteger(selected.nativeEvents, language) })}`
                      : ""}
                    {" · "}
                    {t("平均耗时 {elapsed}", { elapsed: formatDuration(averageElapsedMsOf(selected)) })}
                    {" · "}
                    {t("预估费用")} {formatAggregateCost(selected.costByCurrency, selected.cost)}
                  </div>
                </article>
              ) : null}
            </aside>
          </div>
        ) : null}
      </section>

      <SideSheet
        visible={matrixExpanded}
        motion={false}
        width="min(760px, 96vw)"
        title={t("完整交叉归因矩阵")}
        onCancel={() => setMatrixExpanded(false)}
        footer={null}
        bodyStyle={{ padding: 0 }}
        zIndex={APP_OVERLAY_Z_INDEX.sideSheet}
      >
        <div className={styles.expandedMatrixBody}>
          <div className={styles.expandedMatrixToolbar}>
            <div>
              <strong>{matrixSubtitle}</strong>
              <span>{t("共 {rows} 个对象 × {columns} 个归因项", { rows: entries.length, columns: matrix.columns.length })}</span>
            </div>
            <div className={styles.metricSeg} aria-label={t("矩阵指标")}>
              {(["tokens", "cost"] as const).map((metric) => (
                <button
                  key={metric}
                  type="button"
                  aria-pressed={matrixMetric === metric}
                  onClick={() => setMatrixMetric(metric)}
                >
                  {metric === "tokens" ? "Token" : t("预估费用")}
                </button>
              ))}
            </div>
          </div>
          <div className={styles.expandedMatrixScroll}>
            <CrossMatrixGrid
              entries={entries}
              columns={matrix.columns}
              matrix={matrix}
              metric={matrixMetric}
              selectedKey={selectedKey ?? entries[0]?.key ?? null}
              onSelect={setSelectedKey}
              language={language}
              t={t}
              expanded
            />
          </div>
          <div className={styles.expandedMatrixFoot}><HeatLegend t={t} /></div>
        </div>
      </SideSheet>
    </main>
  );
}

type Translate = ReturnType<typeof useAppPreferences>["t"];
type Language = ReturnType<typeof useAppPreferences>["language"];

function CrossMatrixGrid({ entries, columns, matrix, metric, selectedKey, onSelect, language, t, expanded = false }: {
  entries: ConsumptionEntry[];
  columns: CrossMatrixAxisEntry[];
  matrix: CrossMatrix;
  metric: ConsumptionMetric;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  language: Language;
  t: Translate;
  expanded?: boolean;
}) {
  return (
    <div
      className={`${styles.matrixGrid} ${expanded ? styles.matrixGridExpanded : ""}`}
      style={{
        gridTemplateColumns: expanded
          ? `minmax(150px, 180px) repeat(${columns.length}, minmax(92px, 1fr))`
          : `minmax(96px, 1.15fr) repeat(${columns.length}, minmax(0, 1fr))`,
      }}
    >
      <span className={styles.matrixCorner} aria-hidden="true" />
      {columns.map((column) => (
        <span key={column.key} className={styles.matrixColHead} title={column.label}>
          {column.shortLabel}
        </span>
      ))}
      {entries.map((entry) => (
        <Fragment key={entry.key}>
          <button
            type="button"
            className={styles.matrixRowHead}
            aria-pressed={entry.key === selectedKey}
            title={entry.label}
            onClick={() => onSelect(entry.key)}
          >
            {entry.label}
          </button>
          {columns.map((column) => {
            const cell = matrix.cells.get(cellId(entry.key, column.key));
            if (!cell) {
              return (
                <span key={column.key} className={`${styles.matrixCell} ${styles.matrixCellEmpty}`} title={t("该组合暂无数据")}>
                  —
                </span>
              );
            }
            return (
              <Tooltip
                key={column.key}
                content={(
                  <span className={styles.cellTip}>
                    <strong>{entry.label} · {column.label}</strong>
                    <span>Token {formatCompactNumber(cell.tokens, language)}</span>
                    <span>{t("预估费用")} {formatAggregateCost(cell.costByCurrency, cell.cost)}</span>
                  </span>
                )}
              >
                <button
                  type="button"
                  className={`${styles.matrixCell} ${styles["heatLevel" + cell.level]}`}
                  onClick={() => onSelect(entry.key)}
                >
                  {metric === "tokens"
                    ? <CompactNumber value={cell.tokens} language={language} maximumFractionDigits={1} showExactTitle={false} />
                    : formatCellCost(cell.cost, cell.costByCurrency)}
                </button>
              </Tooltip>
            );
          })}
        </Fragment>
      ))}
    </div>
  );
}

function RankRow({ entry, dimension, selected, onSelect, language, t }: {
  entry: ConsumptionEntry;
  dimension: ConsumptionDimension;
  selected: boolean;
  onSelect: () => void;
  language: Language;
  t: Translate;
}) {
  const cacheRate = cacheHitRateOf(entry);
  return (
    <button
      type="button"
      className={[styles.rankRow, selected ? styles.rankRowSelected : ""].join(" ")}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <span className={styles.rankName}>
        <DimensionBadge dimension={dimension} entry={entry} />
        <span className={styles.rankNameText}>
          <strong>{entry.label}</strong>
          {entry.sublabel ? <small>{entry.sublabel}</small> : null}
        </span>
      </span>
      <TokenBreakdownTooltip
        language={language}
        t={t}
        label={entry.label}
        tokens={{
          total: entry.tokens,
          input: entry.inputTokens,
          cachedInput: entry.cachedInputTokens,
          uncachedInput: entry.uncachedInputTokens,
          output: entry.outputTokens,
          cacheHitRate: cacheRate,
          requests: entry.requests,
          nativeEvents: entry.nativeEvents,
          unknownUsageCount: entry.unknown,
        }}
      >
        <span className={styles.metricCell}>
          <strong><CompactNumber value={entry.tokens} language={language} showExactTitle={false} /></strong>
          <small>{formatPercent(entry.tokenShare)}</small>
        </span>
      </TokenBreakdownTooltip>
      <span className={styles.metricCell}>
        <strong>{formatAggregateCost(entry.costByCurrency, entry.cost)}</strong>
        <small>{formatPercent(entry.costShare)}</small>
      </span>
      <span className={styles.rankArrow} aria-hidden="true"><IconChevronRight size="small" /></span>
    </button>
  );
}

function DimensionBadge({ dimension, entry }: { dimension: ConsumptionDimension; entry: ConsumptionEntry }) {
  if (dimension === "client") {
    const agentId = entry.brandId ?? "";
    if (BRANDED_AGENT_IDS.has(agentId)) {
      return <AgentBrandMark agentId={agentId} className={styles.badge} />;
    }
    return <span className={`${styles.badge} ${styles.badgeLetter}`} aria-hidden="true">{entry.label.trim().charAt(0).toUpperCase() || "?"}</span>;
  }
  return <ChannelBrandLogo channelId={entry.brandId ?? "unknown"} name={entry.label} />;
}

function HeatLegend({ t }: { t: Translate }) {
  return (
    <span className={styles.heatLegend}>
      <span>{t("少")}</span>
      {[0, 1, 2, 3, 4].map((level) => (
        <i key={level} className={`${styles.heatSwatch} ${styles["heatLevel" + level]}`} />
      ))}
      <span>{t("多")}</span>
    </span>
  );
}

/** 聚合费用展示：优先按币种拆分（避免 ¥ 与 $ 混合相加），无币种信息时退化为纯数值。 */
function formatAggregateCost(costByCurrency: Record<string, number>, cost: number) {
  if (Object.keys(costByCurrency).length > 0) return formatMultiCurrencyCost(costByCurrency);
  return formatCostAmount({ amount: cost, currency: null }, 2);
}

/** 矩阵单元格费用：空间有限，只展示主导币种金额，完整拆分在悬浮层。 */
function formatCellCost(cost: number, costByCurrency: Record<string, number>) {
  return formatCostAmount({ amount: cost, currency: dominantCostCurrency(costByCurrency) }, 2);
}

function formatPercent(rate: number | null) {
  return rate == null || !Number.isFinite(rate) ? "—" : `${(rate * 100).toFixed(1)}%`;
}
