import { Fragment, useMemo, useState } from "react";
import { Button, Tooltip } from "@douyinfe/semi-ui-19";
import { IconChevronRight } from "@douyinfe/semi-icons";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import type { UsagePeriod, UsageSummaryRow } from "../../domains/usage/types";
import { ChannelBrandLogo } from "../../features/channel-accounts/ChannelBrandLogo";
import { formatDuration, formatTokenRate } from "../../features/request-logs/logPresentation";
import { useKnownDevices } from "../../features/device-sync/useDeviceSync";
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
import {
  averageElapsedMsOf,
  buildCrossMatrix,
  cacheHitRateOf,
  cellId,
  groupConsumption,
  outputTokensPerSecondOf,
  secondaryDimensionOf,
  type ConsumptionDimension,
  type ConsumptionEntry,
  type ConsumptionMetric,
} from "./consumptionAnalysisPresentation";
import styles from "./UsageAnalysisPage.module.css";

const EMPTY_ROWS: UsageSummaryRow[] = [];

const PERIOD_OPTIONS: Array<{ value: UsagePeriod; label: string }> = [
  { value: "today", label: "今日" },
  { value: "week", label: "本周" },
  { value: "month", label: "本月" },
  { value: "all", label: "全部" },
];

const DIMENSION_OPTIONS: Array<{ value: ConsumptionDimension; label: string }> = [
  { value: "model", label: "按模型" },
  { value: "account", label: "按渠道账号" },
  { value: "client", label: "按客户端" },
  { value: "device", label: "按设备" },
];

/** AgentBrandMark 已内置品牌图标的客户端 ID（其余客户端展示首字母徽标）。 */
const BRANDED_AGENT_IDS = new Set(["claude-code", "opencode", "pi", "chatgpt-desktop", "codex"]);

export function UsageAnalysisPage() {
  const { language, t } = useAppPreferences();
  const refresh = useRefreshControl({ intervalMs: 30_000 });
  const [period, setPeriod] = useState<UsagePeriod>("week");
  const [dimension, setDimension] = useState<ConsumptionDimension>("model");
  const [matrixMetric, setMatrixMetric] = useState<ConsumptionMetric>("tokens");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const { query } = useUsageSummary(period, refresh.autoRefresh);
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

  const rows = query.data ?? EMPTY_ROWS;
  const entries = useMemo(
    () => groupConsumption(rows, dimension, modelCurrencyOf, resolveDeviceName),
    [rows, dimension, modelCurrencyOf, resolveDeviceName],
  );
  const matrix = useMemo(
    () => buildCrossMatrix(rows, dimension, matrixMetric, modelCurrencyOf),
    [rows, dimension, matrixMetric, modelCurrencyOf],
  );
  const selected = entries.find((entry) => entry.key === selectedKey) ?? entries[0] ?? null;

  const changeDimension = (next: ConsumptionDimension) => {
    setDimension(next);
    setSelectedKey(null);
  };

  const loading = query.isPending && query.data == null;
  const matrixSubtitle = dimension === "model"
    ? t("模型 × 渠道账号，颜色越深消耗越高")
    : dimension === "account"
      ? t("渠道账号 × 模型，颜色越深消耗越高")
      : t("客户端 × 模型，颜色越深消耗越高");

  return (
    <main className={styles.page}>
      <PageHeader title={t("用量分析")} subtitle={t("按模型、渠道账号和客户端拆解 Token、费用与性能")}>
        <div className={styles.periodTabs} aria-label={t("统计周期")}>
          {PERIOD_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={period === option.value}
              onClick={() => setPeriod(option.value)}
            >
              {t(option.label)}
            </button>
          ))}
        </div>
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
                <div
                  className={styles.matrixGrid}
                  style={{ gridTemplateColumns: `minmax(84px, 1.15fr) repeat(${matrix.columns.length}, minmax(56px, 1fr))` }}
                >
                  <span aria-hidden="true" />
                  {matrix.columns.map((column) => (
                    <span key={column.key} className={styles.matrixColHead} title={column.label}>
                      {column.shortLabel}
                    </span>
                  ))}
                  {entries.map((entry) => (
                    <Fragment key={entry.key}>
                      <button
                        type="button"
                        className={styles.matrixRowHead}
                        aria-pressed={entry.key === (selectedKey ?? entries[0]?.key)}
                        title={entry.label}
                        onClick={() => setSelectedKey(entry.key)}
                      >
                        {entry.label}
                      </button>
                      {matrix.columns.map((column) => {
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
                              onClick={() => setSelectedKey(entry.key)}
                            >
                              {matrixMetric === "tokens"
                                ? <CompactNumber value={cell.tokens} language={language} maximumFractionDigits={1} showExactTitle={false} />
                                : formatCellCost(cell.cost, cell.costByCurrency)}
                            </button>
                          </Tooltip>
                        );
                      })}
                    </Fragment>
                  ))}
                </div>
              </div>

              <div className={styles.matrixFoot}>
                <HeatLegend t={t} />
                {matrix.columnCount > matrix.columns.length ? (
                  <span className={styles.coverage}>
                    {t("展示前 {count} 个{dimension} · 覆盖 {share}", {
                      count: matrix.columns.length,
                      dimension: t(secondaryDimensionOf(dimension) === "account" ? "渠道账号" : "模型"),
                      share: formatPercent(matrix.columnCoverage),
                    })}
                  </span>
                ) : null}
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
                    {t("{count} 次请求", { count: formatInteger(selected.requests, language) })}
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
    </main>
  );
}

type Translate = ReturnType<typeof useAppPreferences>["t"];
type Language = ReturnType<typeof useAppPreferences>["language"];

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

