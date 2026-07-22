import { useMemo, useState } from "react";
import { Button, Select, Tooltip, Typography } from "@douyinfe/semi-ui-19";
import { IconInfoCircle } from "@douyinfe/semi-icons";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import type { UsagePeriod } from "../../domains/usage/types";
import { useUsageSummary } from "../../features/usage/useUsageSummary";
import { useModelPriceCurrencyLookup } from "../../features/usage/useModelPriceCurrencies";
import { RefreshControl } from "../../shared/ui/RefreshControl";
import { useRefreshControl } from "../../shared/ui/useRefreshControl";
import { ChannelBrandLogo } from "../../features/channel-accounts/ChannelBrandLogo";
import { buildUsageHeatmap, filterUsageRows, groupUsageByChannel, groupUsageByDay, groupUsageByModel, summarizeUsage, type UsageDay, type UsageHeatmap } from "./usagePresentation";
import styles from "./UsageCostPage.module.css";
import { dominantCostCurrency, formatCostAmount, formatMultiCurrencyCost } from "../../shared/formatters/cost";
import { formatCompactNumber as formatCompact, formatInteger } from "../../shared/formatters/number";

const { Paragraph, Title } = Typography;
type TrendMetric = "cost" | "tokens";

export function UsageCostPage() {
  const { language, t } = useAppPreferences();
  const refresh = useRefreshControl({ intervalMs: 30_000 });
  const usage = useUsageSummary(refresh.autoRefresh);
  const [period, setPeriod] = useState<UsagePeriod>("month");
  const [metric, setMetric] = useState<TrendMetric>("tokens");
  const rows = useMemo(() => filterUsageRows(usage.query.data ?? [], period), [period, usage.query.data]);
  const priceLookup = useModelPriceCurrencyLookup();
  const { modelCurrencyOf, channelCurrencyOf } = priceLookup;
  const summary = useMemo(() => summarizeUsage(rows, modelCurrencyOf), [rows, modelCurrencyOf]);
  const days = useMemo(() => groupUsageByDay(rows), [rows]);
  const activity = useMemo(() => buildUsageHeatmap(usage.query.data ?? [], period, new Date(), language), [language, period, usage.query.data]);
  const models = useMemo(() => groupUsageByModel(rows, modelCurrencyOf), [rows, modelCurrencyOf]);
  const channels = useMemo(() => groupUsageByChannel(rows, channelCurrencyOf), [rows, channelCurrencyOf]);
  const totalCostLabel = formatMultiCurrencyCost(summary.costByCurrency);
  const chartCostCurrency = dominantCostCurrency(summary.costByCurrency);
  const cacheHitRate = summary.cacheMeasuredInputTokens > 0
    ? summary.cachedInputTokens / summary.cacheMeasuredInputTokens
    : null;
  const cacheDetails = <div className={styles.channelUsageTooltip}>
    <span><em>{t("输入 Token")}</em><strong>{formatCompact(summary.inputTokens, language)}</strong></span>
    <span><em>{t("缓存输入 Token")}</em><strong>{formatCompact(summary.cachedInputTokens, language)}</strong></span>
    <span><em>{t("未缓存输入 Token")}</em><strong>{formatCompact(summary.uncachedInputTokens, language)}</strong></span>
  </div>;
  const periodLabel = {
    all: t("全部时间"),
    year: t("今年"),
    quarter: t("本季度"),
    month: t("本月"),
    week: t("本周"),
  }[period];

  return <main className={styles.page}>
    <header className={styles.pageHeading}>
      <div><Title heading={3}>{t("用量成本")}</Title><Paragraph>{t("查看模型、渠道与账号维度的 Token 消耗和预估费用")}</Paragraph></div>
      <RefreshControl
        autoRefresh={refresh.autoRefresh}
        onToggleAutoRefresh={refresh.toggleAutoRefresh}
        isFetching={usage.query.isFetching}
        lastUpdatedAt={usage.query.dataUpdatedAt}
        intervalMs={refresh.intervalMs}
        onRefresh={() => void usage.query.refetch()}
        language={language}
        t={t}
      />
      <Select
        value={period}
        aria-label={t("统计周期")}
        optionList={[
          { value: "all", label: t("全部时间") },
          { value: "year", label: t("今年") },
          { value: "quarter", label: t("本季度") },
          { value: "month", label: t("本月") },
          { value: "week", label: t("本周") },
        ]}
        onChange={(value) => setPeriod(value as UsagePeriod)}
      />
    </header>

    <section className={styles.stats} aria-label={t("用量统计")}>
      <Stat label={t("{period}预估费用", { period: periodLabel })} value={totalCostLabel} meta={t("基于已知价格")} />
      <Stat label={t("{period} Token 消耗", { period: periodLabel })} value={formatCompact(summary.tokens, language)} meta={t("输入 {input} · 输出 {output}", { input: formatCompact(summary.inputTokens, language), output: formatCompact(summary.outputTokens, language) })} />
      <Stat label={t("{period}请求量", { period: periodLabel })} value={formatInteger(summary.requests, language)} meta={t("本地代理记录")} />
      <Stat label={t("缓存命中率")} value={cacheHitRate == null ? "—" : formatPercent(cacheHitRate)} meta={t("缓存 {cached} · 未缓存 {uncached}", { cached: formatCompact(summary.cachedInputTokens, language), uncached: formatCompact(summary.uncachedInputTokens, language) })} tooltip={cacheDetails} />
    </section>

    {usage.query.isError ? <div className={styles.state}><strong>{t("用量数据加载失败")}</strong><span>{usage.query.error.message}</span><Button onClick={() => void usage.query.refetch()}>{t("重试")}</Button></div> : null}
    {!usage.query.isError ? <div className={styles.workspace}>
      <section className={styles.mainCard}>
        <header className={styles.cardHeader}>
          <div><strong>{t(metric === "tokens" ? "Token 活动" : "消耗趋势")}</strong><small>{t("{period}每日汇总", { period: periodLabel })}</small></div>
          <div className={styles.segments}><button type="button" className={metric === "cost" ? styles.active : ""} onClick={() => setMetric("cost")}>{t("费用")}</button><button type="button" className={metric === "tokens" ? styles.active : ""} onClick={() => setMetric("tokens")}>Tokens</button></div>
        </header>
        <div className={styles.trend}>
          <div className={styles.trendSummary}><strong>{metric === "cost" ? totalCostLabel : `${formatCompact(summary.tokens, language)} Tokens`}</strong><span>{periodLabel}{t("累计")}</span></div>
          {metric === "tokens" ? (
            <TokenActivityHeatmap activity={activity} language={language} lessLabel={t("少")} moreLabel={t("多")} />
          ) : (
            <TrendChart days={days} metric={metric} language={language} costCurrency={chartCostCurrency} emptyLabel={usage.query.isLoading ? t("正在加载用量…") : t("当前周期暂无用量数据")} />
          )}
        </div>
        <div className={styles.breakdown}>
          <div className={styles.breakdownHead}><span>{t("模型")}</span><span>{t("请求量")}</span><span>Tokens</span><span>{t("缓存命中率")}</span><span>{t("费用")}</span><span>{t("费用占比")}</span></div>
          <div className={styles.breakdownList}>
            {models.length === 0 ? <div className={styles.empty}>{t("暂无模型用量")}</div> : models.map((model) => <div className={styles.breakdownRow} key={model.key}>
              <span className={styles.modelCell}><ChannelBrandLogo channelId={model.brandId ?? "unknown-channel"} name={model.label} /><strong>{model.label}</strong></span>
              <span>{formatInteger(model.requests, language)}</span>
              <Tooltip content={<div className={styles.channelUsageTooltip}>
                <span><em>{t("输入 Token")}</em><strong>{formatCompact(model.inputTokens, language)}</strong></span>
                <span><em>{t("输出 Token")}</em><strong>{formatCompact(model.outputTokens, language)}</strong></span>
                <span><em>{t("缓存输入 Token")}</em><strong>{formatCompact(model.cachedInputTokens, language)}</strong></span>
                <span><em>{t("未缓存输入 Token")}</em><strong>{formatCompact(model.uncachedInputTokens, language)}</strong></span>
              </div>}>
                <span className={styles.modelTokens}>{formatCompact(model.tokens, language)}</span>
              </Tooltip>
              <span>{model.cacheMeasuredInputTokens > 0 ? formatPercent(model.cachedInputTokens / model.cacheMeasuredInputTokens) : "—"}</span>
              <span className={styles.costCell} title={formatCostAmount({ amount: model.cost, currency: model.currency })}>{formatUsageCost(model.cost, model.currency)}</span>
              <span className={styles.share}><i><b style={{ width: `${Math.max(0, Math.min(100, model.share * 100))}%` }} /></i><em>{formatPercent(model.share)}</em></span>
            </div>)}
          </div>
        </div>
      </section>

      <aside className={styles.side}>
        <section className={styles.coverageCard}>
          <header>
            <strong>{t("数据完整度")}</strong>
            <Tooltip content={t("费用仅统计 Token 与价格均已知的请求")}>
              <IconInfoCircle className={styles.hintIcon} role="img" aria-label={t("费用仅统计 Token 与价格均已知的请求")} />
            </Tooltip>
          </header>
          <div className={styles.coverageValue}><strong>{summary.requests > 0 ? formatPercent((summary.requests - summary.unknown) / summary.requests) : "-"}</strong><span>{t("请求包含可统计用量")}</span></div>
          <div className={styles.coverageTrack}><i style={{ width: `${summary.requests > 0 ? Math.max(0, (summary.requests - summary.unknown) / summary.requests * 100) : 0}%` }} /></div>
        </section>
        <section className={styles.channelCard}>
          <header><strong>{t("渠道成本")}</strong><span>{t("按预估费用排序")}</span></header>
          <div className={styles.channelList}>{channels.length === 0 ? <div className={styles.empty}>{t("暂无渠道用量")}</div> : channels.map((channel) => <div className={styles.channelRow} key={channel.key}>
            <ChannelBrandLogo channelId={channel.key} name={channel.label} />
            <span>
              <strong>{channel.label}</strong>
              <Tooltip content={<div className={styles.channelUsageTooltip}>
                <span><em>{t("请求量")}</em><strong>{formatInteger(channel.requests, language)}</strong></span>
                <span><em>{t("输入 Token")}</em><strong>{formatCompact(channel.inputTokens, language)}</strong></span>
                <span><em>{t("输出 Token")}</em><strong>{formatCompact(channel.outputTokens, language)}</strong></span>
                <span><em>{t("缓存输入 Token")}</em><strong>{formatCompact(channel.cachedInputTokens, language)}</strong></span>
                <span><em>{t("未缓存输入 Token")}</em><strong>{formatCompact(channel.uncachedInputTokens, language)}</strong></span>
              </div>}>
                <small className={styles.channelTokens}>{formatCompact(channel.tokens, language)} Tokens</small>
              </Tooltip>
            </span>
            <span><strong title={formatCostAmount({ amount: channel.cost, currency: channel.currency })}>{formatUsageCost(channel.cost, channel.currency)}</strong><small>{formatPercent(channel.share)}</small></span>
          </div>)}</div>
          <footer><span>{t("总计 {count} 个渠道", { count: channels.length })}</span><strong>{totalCostLabel}</strong></footer>
        </section>
      </aside>
    </div> : null}
  </main>;
}

function Stat({ label, value, meta, tooltip }: { label: string; value: string; meta: string; tooltip?: React.ReactNode }) {
  const valueContent = <strong className={tooltip ? styles.statTooltip : undefined} title={value}>{value}</strong>;
  return <div className={styles.stat}><span>{label}</span>{tooltip ? <Tooltip content={tooltip}>{valueContent}</Tooltip> : valueContent}<small title={meta}>{meta}</small></div>;
}

function TrendChart({ days, metric, language, costCurrency, emptyLabel }: { days: UsageDay[]; metric: TrendMetric; language: "zh-CN" | "en-US"; costCurrency: string | null; emptyLabel: string }) {
  if (days.length === 0) return <div className={styles.chartEmpty}>{emptyLabel}</div>;
  const values = days.map((day) => metric === "cost" ? day.cost : day.tokens);
  const max = Math.max(...values, 1);
  const startX = 36;
  const endX = 592;
  const topY = 18;
  const bottomY = 132;
  const points = values.map((value, index) => ({
    x: days.length === 1 ? (startX + endX) / 2 : startX + (endX - startX) * index / (days.length - 1),
    y: bottomY - (bottomY - topY) * value / max,
  }));
  const line = points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" ");
  const area = `${line} L${points[points.length - 1]?.x ?? endX} ${bottomY} L${points[0].x} ${bottomY} Z`;
  const labelIndexes = [...new Set([0, Math.floor((days.length - 1) / 2), days.length - 1])];
  return <svg className={styles.chart} viewBox="0 0 610 158" preserveAspectRatio="none" aria-label="usage trend">
    <defs><linearGradient id="flowletUsageArea" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="var(--semi-color-primary)" stopOpacity=".38" /><stop offset="100%" stopColor="var(--semi-color-primary)" stopOpacity="0" /></linearGradient></defs>
    {[18, 56, 94, 132].map((y) => <line key={y} className={styles.gridLine} x1="36" y1={y} x2="600" y2={y} />)}
    <text className={styles.chartLabel} x="1" y="21">{metric === "cost" ? formatCostAmount({ amount: max, currency: costCurrency }, 2) : formatCompact(max, language)}</text>
    <path className={styles.chartArea} d={area} /><path className={styles.chartLine} d={line} />
    {points.map((point, index) => <circle key={days[index].date} className={styles.chartDot} cx={point.x} cy={point.y} r="2.8" />)}
    {labelIndexes.map((index) => <text key={days[index].date} className={styles.chartLabel} x={Math.max(0, Math.min(565, points[index].x - 16))} y="153">{days[index].date.slice(5)}</text>)}
  </svg>;
}

function TokenActivityHeatmap({ activity, language, lessLabel, moreLabel }: { activity: UsageHeatmap; language: "zh-CN" | "en-US"; lessLabel: string; moreLabel: string }) {
  const columnStyle = { gridTemplateColumns: `repeat(${activity.columns}, minmax(0, 1fr))` };
  const gridStyle = {
    ...columnStyle,
    ...(activity.rows ? { gridTemplateRows: `repeat(${activity.rows}, minmax(0, 1fr))` } : {}),
  };
  return <div className={`${styles.heatmap} ${styles[`heatmap-${activity.granularity}`]} ${styles[`heatmap-${activity.bucketUnit}-buckets`]}`}>
    <div className={styles.heatmapLabels} style={columnStyle}>
      {activity.labels.map((label) => <span key={`${label.column}-${label.label}`} style={{ gridColumn: label.column }}>{label.label}</span>)}
    </div>
    <div className={styles.heatmapGrid} style={gridStyle}>
      {activity.cells.map((cell) => {
        const date = new Date(activity.bucketUnit === "month" ? `${cell.bucket}-01T00:00:00` : `${cell.bucket.slice(0, 10)}T00:00:00`);
        const timeLabel = activity.bucketUnit === "month"
          ? date.toLocaleDateString(language, { year: "numeric", month: "long" })
          : date.toLocaleDateString(language);
        const title = `${timeLabel} · ${formatInteger(cell.tokens, language)} Tokens`;
        return <span key={cell.bucket} className={`${styles.heatmapCell} ${styles[`heatLevel${cell.level}`]} ${cell.outside ? styles.outside : ""}`} title={title} aria-label={title} />;
      })}
    </div>
    <div className={styles.heatmapLegend}><span>{lessLabel}</span>{[0, 1, 2, 3, 4].map((level) => <i key={level} className={`${styles.heatmapCell} ${styles[`heatLevel${level}`]}`} />)}<span>{moreLabel}</span></div>
  </div>;
}

/** Cost cell formatter: currency symbol follows the model's pricing currency
 *  (¥ / $ / "credits"), with extra precision for sub-cent amounts. */
function formatUsageCost(value: number, currency: string | null) {
  return formatCostAmount({ amount: value, currency }, value > 0 && value < 0.01 ? 4 : 2);
}
function formatPercent(value: number) { return `${(value * 100).toFixed(1)}%`; }
