import { useMemo, useState } from "react";
import { Button, Select, Typography } from "@douyinfe/semi-ui-19";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import type { UsagePeriod } from "../../domains/usage/types";
import { useUsageSummary } from "../../features/usage/useUsageSummary";
import { ChannelBrandLogo } from "../../features/channel-accounts/ChannelBrandLogo";
import { buildUsageHeatmap, filterUsageRows, groupUsageByChannel, groupUsageByDay, groupUsageByModel, summarizeUsage, type UsageDay, type UsageHeatmap } from "./usagePresentation";
import styles from "./UsageCostPage.module.css";

const { Paragraph, Title } = Typography;
type TrendMetric = "cost" | "tokens";

export function UsageCostPage() {
  const { language, t } = useAppPreferences();
  const usage = useUsageSummary();
  const [period, setPeriod] = useState<UsagePeriod>("month");
  const [metric, setMetric] = useState<TrendMetric>("tokens");
  const rows = useMemo(() => filterUsageRows(usage.query.data ?? [], period), [period, usage.query.data]);
  const summary = useMemo(() => summarizeUsage(rows), [rows]);
  const days = useMemo(() => groupUsageByDay(rows), [rows]);
  const activity = useMemo(() => buildUsageHeatmap(usage.query.data ?? [], period, new Date(), language), [language, period, usage.query.data]);
  const models = useMemo(() => groupUsageByModel(rows), [rows]);
  const channels = useMemo(() => groupUsageByChannel(rows), [rows]);
  const cacheHitRate = summary.cacheMeasuredInputTokens > 0
    ? summary.cachedInputTokens / summary.cacheMeasuredInputTokens
    : null;
  const periodLabel = period === "today" ? t("今天") : period === "7d" ? t("最近 7 天") : t("本月");

  return <main className={styles.page}>
    <header className={styles.pageHeading}>
      <div><Title heading={3}>{t("用量成本")}</Title><Paragraph>{t("查看模型、渠道与账号维度的 Token 消耗和预估费用")}</Paragraph></div>
      <Select
        value={period}
        aria-label={t("统计周期")}
        optionList={[{ value: "today", label: t("今天") }, { value: "7d", label: t("最近 7 天") }, { value: "month", label: t("本月") }]}
        onChange={(value) => setPeriod(value as UsagePeriod)}
      />
    </header>

    <section className={styles.stats} aria-label={t("用量统计")}>
      <Stat label={t("{period}预估费用", { period: periodLabel })} value={formatCost(summary.cost)} meta={t("基于已知价格")} />
      <Stat label={t("{period} Token 消耗", { period: periodLabel })} value={formatCompact(summary.tokens, language)} meta={t("输入 {input} · 输出 {output}", { input: formatCompact(summary.inputTokens, language), output: formatCompact(summary.outputTokens, language) })} />
      <Stat label={t("{period}请求量", { period: periodLabel })} value={formatInteger(summary.requests, language)} meta={t("本地代理记录")} />
      <Stat label={t("缓存命中率")} value={cacheHitRate == null ? "—" : formatPercent(cacheHitRate)} meta={t("缓存 {cached} · 未缓存 {uncached}", { cached: formatCompact(summary.cachedInputTokens, language), uncached: formatCompact(summary.uncachedInputTokens, language) })} />
    </section>

    {usage.query.isError ? <div className={styles.state}><strong>{t("用量数据加载失败")}</strong><span>{usage.query.error.message}</span><Button onClick={() => void usage.query.refetch()}>{t("重试")}</Button></div> : null}
    {!usage.query.isError ? <div className={styles.workspace}>
      <section className={styles.mainCard}>
        <header className={styles.cardHeader}>
          <div><strong>{t(metric === "tokens" ? "Token 活动" : "消耗趋势")}</strong><small>{metric === "tokens" && period === "today" ? t("{period}按小时汇总", { period: periodLabel }) : t("{period}每日汇总", { period: periodLabel })}</small></div>
          <div className={styles.segments}><button type="button" className={metric === "cost" ? styles.active : ""} onClick={() => setMetric("cost")}>{t("费用")}</button><button type="button" className={metric === "tokens" ? styles.active : ""} onClick={() => setMetric("tokens")}>Tokens</button></div>
        </header>
        <div className={styles.trend}>
          <div className={styles.trendSummary}><strong>{metric === "cost" ? formatCost(summary.cost) : `${formatCompact(activity.totalTokens, language)} Tokens`}</strong><span>{periodLabel}{t("累计")}</span></div>
          {metric === "tokens" ? (
            <TokenActivityHeatmap activity={activity} language={language} lessLabel={t("少")} moreLabel={t("多")} />
          ) : (
            <TrendChart days={days} metric={metric} language={language} emptyLabel={usage.query.isLoading ? t("正在加载用量…") : t("当前周期暂无用量数据")} />
          )}
        </div>
        <div className={styles.breakdown}>
          <div className={styles.breakdownHead}><span>{t("模型")}</span><span>{t("请求量")}</span><span>Tokens</span><span>{t("费用占比")}</span></div>
          <div className={styles.breakdownList}>
            {models.length === 0 ? <div className={styles.empty}>{t("暂无模型用量")}</div> : models.map((model) => <div className={styles.breakdownRow} key={model.key}>
              <span className={styles.modelCell}><i>{model.label.slice(0, 2).toUpperCase()}</i><strong>{model.label}</strong></span>
              <span>{formatInteger(model.requests, language)}</span><span>{formatCompact(model.tokens, language)}</span>
              <span className={styles.share}><i><b style={{ width: `${Math.max(0, Math.min(100, model.share * 100))}%` }} /></i><em>{formatPercent(model.share)}</em></span>
            </div>)}
          </div>
        </div>
      </section>

      <aside className={styles.side}>
        <section className={styles.coverageCard}>
          <header><strong>{t("数据完整度")}</strong></header>
          <div className={styles.coverageValue}><strong>{summary.requests > 0 ? formatPercent((summary.requests - summary.unknown) / summary.requests) : "-"}</strong><span>{t("请求包含可统计用量")}</span></div>
          <div className={styles.coverageTrack}><i style={{ width: `${summary.requests > 0 ? Math.max(0, (summary.requests - summary.unknown) / summary.requests * 100) : 0}%` }} /></div>
          <p>{t("费用为本地价格表计算的预估值；缺少 Token 或价格时不会虚构成本。")}</p>
        </section>
        <section className={styles.channelCard}>
          <header><strong>{t("渠道成本")}</strong><span>{t("按预估费用排序")}</span></header>
          <div className={styles.channelList}>{channels.length === 0 ? <div className={styles.empty}>{t("暂无渠道用量")}</div> : channels.map((channel) => <div className={styles.channelRow} key={channel.key}>
            <ChannelBrandLogo channelId={channel.key} name={channel.label} />
            <span><strong>{channel.label}</strong><small>{t("{requests} 次请求 · {tokens} Tokens", { requests: formatInteger(channel.requests, language), tokens: formatCompact(channel.tokens, language) })}</small></span>
            <span><strong>{formatCost(channel.cost)}</strong><small>{formatPercent(channel.share)}</small></span>
          </div>)}</div>
          <footer><span>{t("总计 {count} 个渠道", { count: channels.length })}</span><strong>{formatCost(summary.cost)}</strong></footer>
        </section>
      </aside>
    </div> : null}
  </main>;
}

function Stat({ label, value, meta }: { label: string; value: string; meta: string }) {
  return <div className={styles.stat}><span>{label}</span><strong title={value}>{value}</strong><small title={meta}>{meta}</small></div>;
}

function TrendChart({ days, metric, language, emptyLabel }: { days: UsageDay[]; metric: TrendMetric; language: "zh-CN" | "en-US"; emptyLabel: string }) {
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
    <text className={styles.chartLabel} x="1" y="21">{metric === "cost" ? formatCost(max) : formatCompact(max, language)}</text>
    <path className={styles.chartArea} d={area} /><path className={styles.chartLine} d={line} />
    {points.map((point, index) => <circle key={days[index].date} className={styles.chartDot} cx={point.x} cy={point.y} r="2.8" />)}
    {labelIndexes.map((index) => <text key={days[index].date} className={styles.chartLabel} x={Math.max(0, Math.min(565, points[index].x - 16))} y="153">{days[index].date.slice(5)}</text>)}
  </svg>;
}

function TokenActivityHeatmap({ activity, language, lessLabel, moreLabel }: { activity: UsageHeatmap; language: "zh-CN" | "en-US"; lessLabel: string; moreLabel: string }) {
  const gridStyle = { gridTemplateColumns: `repeat(${activity.columns}, minmax(0, 1fr))` };
  return <div className={`${styles.heatmap} ${styles[`heatmap-${activity.granularity}`]}`}>
    <div className={styles.heatmapLabels} style={gridStyle}>
      {activity.labels.map((label) => <span key={`${label.column}-${label.label}`} style={{ gridColumn: label.column }}>{label.label}</span>)}
    </div>
    <div className={styles.heatmapGrid} style={gridStyle}>
      {activity.cells.map((cell) => {
        const date = new Date(activity.granularity === "hour" ? cell.bucket : `${cell.bucket.slice(0, 10)}T00:00:00`);
        const timeLabel = activity.granularity === "hour"
          ? date.toLocaleString(language, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
          : date.toLocaleDateString(language);
        const title = `${timeLabel} · ${formatInteger(cell.tokens, language)} Tokens`;
        return <span key={cell.bucket} className={`${styles.heatmapCell} ${styles[`heatLevel${cell.level}`]} ${cell.outside ? styles.outside : ""}`} title={title} aria-label={title} />;
      })}
    </div>
    <div className={styles.heatmapLegend}><span>{lessLabel}</span>{[0, 1, 2, 3, 4].map((level) => <i key={level} className={`${styles.heatmapCell} ${styles[`heatLevel${level}`]}`} />)}<span>{moreLabel}</span></div>
  </div>;
}

function formatCost(value: number, digits = 2) { return `$${value.toFixed(digits)}`; }
function formatPercent(value: number) { return `${(value * 100).toFixed(1)}%`; }
function formatInteger(value: number, language: "zh-CN" | "en-US") { return new Intl.NumberFormat(language).format(value); }
function formatCompact(value: number, language: "zh-CN" | "en-US") { return new Intl.NumberFormat(language, { notation: "compact", maximumFractionDigits: 1 }).format(value); }
