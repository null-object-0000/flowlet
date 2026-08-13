import type { CSSProperties, ReactNode } from "react";
import { IconBarChartVStroked, IconChevronRight } from "@douyinfe/semi-icons";
import { Tooltip } from "@douyinfe/semi-ui-19";
import styles from "./UsageStatisticsView.module.css";

export type UsageStatisticsPeriod = "day" | "week" | "month";
export type UsageStatisticsMetric = "tokens" | "cost";

export type UsageStatisticsStatModel = {
  key: string;
  label: ReactNode;
  value: ReactNode;
  hint: ReactNode;
  tooltip?: ReactNode;
  expandable?: boolean;
  title?: string;
};

export type UsageStatisticsCellModel = {
  key: string;
  label: string;
  value: number;
  displayValue: string;
  level: 0 | 1 | 2 | 3 | 4;
  disabled?: boolean;
  hasData?: boolean;
  adjacent?: boolean;
  outside?: boolean;
  weekend?: boolean;
};

export type UsageStatisticsConfidenceModel = {
  scoreLabel: string;
  scoreDegrees: number;
  recognizedLabel: ReactNode;
  recognizedHint: ReactNode;
  proxyLabel: ReactNode;
  proxyValue: ReactNode;
  nativeLabel: ReactNode;
  nativeValue: ReactNode;
  unknownLabel: ReactNode;
  unknownValue: ReactNode;
  notice: ReactNode;
  noticeActionable?: boolean;
  ariaLabel: string;
};

export type UsageStatisticsDetailMetricModel = {
  key: string;
  label: ReactNode;
  value: ReactNode;
  hint: ReactNode;
  tooltip?: ReactNode;
  expandable?: boolean;
  title?: string;
};

export type UsageStatisticsDetailModel = {
  title: ReactNode;
  contextLabel: ReactNode;
  metrics: UsageStatisticsDetailMetricModel[];
  confidence?: UsageStatisticsConfidenceModel;
};

export type UsageStatisticsLabels = {
  statsAria?: string;
  confidenceTitle: ReactNode;
  confidencePeriod: ReactNode;
  chartTitle: ReactNode;
  chartHint: ReactNode;
  metricAria?: string;
  tokens: ReactNode;
  cost: ReactNode;
  selectHint: ReactNode;
  emptyTitle?: ReactNode;
  emptyLabel?: ReactNode;
  emptyPeriod?: ReactNode;
  low: ReactNode;
  high: ReactNode;
  weekdayLabels?: ReactNode[];
  dailyMaxLabel?: ReactNode;
};

type Props = {
  stats: UsageStatisticsStatModel[];
  cells: UsageStatisticsCellModel[];
  confidence: UsageStatisticsConfidenceModel;
  detail: UsageStatisticsDetailModel | null;
  labels: UsageStatisticsLabels;
  period: UsageStatisticsPeriod;
  metric: UsageStatisticsMetric;
  selectedKey: string | null;
  loading?: ReactNode;
  error?: ReactNode;
  onMetricChange?: (metric: UsageStatisticsMetric) => void;
  onSelect?: (key: string) => void;
  onStatClick?: (key: string) => void;
  onDetailMetricClick?: (key: string) => void;
  onConfidenceNotice?: (scope: "period" | "selected") => void;
};

function ConfidenceBreakdown({ confidence, compact = false }: { confidence: UsageStatisticsConfidenceModel; compact?: boolean }) {
  return <div className={compact ? styles.selectedConfidenceBreakdown : styles.confidenceBreakdown}>
    <div><i className={styles.proxyDot} /><span>{confidence.proxyLabel}</span><strong>{confidence.proxyValue}</strong></div>
    <div><i className={styles.nativeDot} /><span>{confidence.nativeLabel}</span><strong>{confidence.nativeValue}</strong></div>
    <div><i className={styles.unknownDot} /><span>{confidence.unknownLabel}</span><strong>{confidence.unknownValue}</strong></div>
  </div>;
}

function ConfidenceSummary({ confidence, compact = false }: { confidence: UsageStatisticsConfidenceModel; compact?: boolean }) {
  return <div className={styles.confidenceSummary}>
    <div className={`${styles.confidenceRing} ${compact ? styles.confidenceRingCompact : ""}`} style={{ "--confidence-degrees": `${confidence.scoreDegrees}deg` } as CSSProperties} aria-label={confidence.ariaLabel}>
      <strong>{confidence.scoreLabel}</strong>
    </div>
    <div><strong>{confidence.recognizedLabel}</strong><span>{confidence.recognizedHint}</span></div>
  </div>;
}

function ConfidenceNotice({ confidence, onClick }: { confidence: UsageStatisticsConfidenceModel; onClick?: () => void }) {
  if (confidence.noticeActionable && onClick) return <button type="button" className={styles.confidenceNotice} onClick={onClick}><span>{confidence.notice}</span><IconChevronRight /></button>;
  return <p className={styles.confidenceNoticeStatic}>{confidence.notice}</p>;
}

export function UsageStatisticsView({ stats, cells, confidence, detail, labels, period, metric, selectedKey, loading, error, onMetricChange, onSelect, onStatClick, onDetailMetricClick, onConfidenceNotice }: Props) {
  const maxValue = Math.max(1, ...cells.filter((cell) => !cell.disabled).map((cell) => cell.value));
  const weekdays = labels.weekdayLabels ?? ["一", "二", "三", "四", "五", "六", "日"];
  return <div className={styles.page}>
    <section className={styles.stats} aria-label={labels.statsAria ?? "Usage summary"}>
      {stats.map((stat) => {
        const hint = stat.tooltip
          ? <Tooltip
              autoAdjustOverflow
              position="topRight"
              showArrow
              style={{ width: "auto", maxWidth: "calc(100vw - 24px)" }}
              content={stat.tooltip}
            ><small tabIndex={0}>{stat.hint}</small></Tooltip>
          : <small>{stat.hint}</small>;
        const content = <><span>{stat.label}</span><strong>{stat.value}</strong>{hint}</>;
        return stat.expandable
          ? <button key={stat.key} type="button" className={`${styles.stat} ${styles.expandable}`} title={stat.title} onClick={() => onStatClick?.(stat.key)}>{content}</button>
          : <article key={stat.key} className={styles.stat}>{content}</article>;
      })}
    </section>

    <section className={styles.confidenceCard}>
      <header><strong>{labels.confidenceTitle}</strong><span>{labels.confidencePeriod}</span></header>
      <div className={styles.confidenceBody}><ConfidenceSummary confidence={confidence} /><ConfidenceBreakdown confidence={confidence} /></div>
      <ConfidenceNotice confidence={confidence} onClick={() => onConfidenceNotice?.("period")} />
    </section>

    <article className={styles.chartCard}>
      <header className={styles.chartHeader}>
        <div><strong>{labels.chartTitle}</strong><span>{labels.chartHint}</span></div>
        <div className={styles.metricSwitch} aria-label={labels.metricAria ?? String(labels.chartTitle)}>
          <button type="button" aria-pressed={metric === "tokens"} onClick={() => onMetricChange?.("tokens")}>{labels.tokens}</button>
          <button type="button" aria-pressed={metric === "cost"} onClick={() => onMetricChange?.("cost")}>{labels.cost}</button>
        </div>
      </header>
      {loading ? <div className={styles.state}>{loading}</div> : null}
      {error ? <div className={styles.state}>{error}</div> : null}
      {!loading && !error && period === "day" ? <div className={styles.dailyFrame}>
        <div className={styles.dailyChart}>
          <div className={styles.dailyScale}><span>{labels.dailyMaxLabel ?? cells.reduce((best, cell) => cell.value > best.value ? cell : best, cells[0])?.displayValue}</span><span>0</span></div>
          <div className={styles.dailyPlot}>{cells.map((cell) => <span className={styles.dailySlot} key={cell.key}><button type="button" className={styles.dailyBar} style={{ "--daily-bar-height": `${Math.max(cell.hasData === false ? 0 : 3, (cell.value / maxValue) * 100)}%` } as CSSProperties} data-has-data={cell.hasData !== false} disabled={cell.disabled} aria-label={`${cell.label} · ${cell.displayValue}`} aria-pressed={cell.key === selectedKey} title={cell.displayValue} onClick={() => onSelect?.(cell.key)} /></span>)}</div>
          <div className={styles.dailyHours}>{cells.map((cell, index) => <span key={cell.key}>{index % 2 === 0 ? cell.label : ""}</span>)}</div>
        </div>
        {!cells.some((cell) => cell.hasData !== false) ? <div className={styles.emptyHint}>{labels.emptyPeriod}</div> : null}
      </div> : null}
      {!loading && !error && period === "week" ? <div className={styles.weekFrame}>
        <div className={styles.weekHeatmap}>
          {weekdays.map((label, index) => <span key={`weekday-${index}`} className={`${styles.weekdayLabel} ${index >= 5 ? styles.weekend : ""}`} style={{ gridColumn: 1, gridRow: index + 1 }}>{label}</span>)}
          {cells.map((cell, index) => <button key={cell.key} type="button" className={`${styles.weekCell} ${styles[`heatLevel${cell.level}`]}`} style={{ gridColumn: index % 24 + 2, gridRow: Math.floor(index / 24) + 1 }} disabled={cell.disabled} aria-label={`${cell.label} · ${cell.displayValue}`} aria-pressed={cell.key === selectedKey} title={cell.displayValue} onClick={() => onSelect?.(cell.key)} />)}
          {Array.from({ length: 24 }, (_, hour) => <span key={`hour-${hour}`} className={styles.hourLabel} style={{ gridColumn: hour + 2, gridRow: 8 }}>{String(hour).padStart(2, "0")}</span>)}
        </div>
        <HeatmapLegend labels={labels} />
        {!cells.some((cell) => cell.hasData !== false) ? <div className={styles.emptyHint}>{labels.emptyPeriod}</div> : null}
      </div> : null}
      {!loading && !error && period === "month" ? <div className={styles.monthFrame}>
        <div className={styles.monthLabels}>{weekdays.map((label, index) => <span key={`month-weekday-${index}`}>{label}</span>)}</div>
        <div className={styles.monthHeatmap}>{cells.map((cell, index) => <button key={cell.key} type="button" className={`${styles.monthCell} ${styles[`heatLevel${cell.level}`]} ${cell.weekend ?? index % 7 >= 5 ? styles.weekend : ""} ${cell.adjacent ? styles.adjacent : ""} ${cell.outside ? styles.outside : ""}`} disabled={cell.disabled} aria-label={`${cell.label} · ${cell.displayValue}`} aria-pressed={cell.key === selectedKey} title={cell.displayValue} onClick={() => onSelect?.(cell.key)} />)}</div>
        <HeatmapLegend labels={labels} />
        {!cells.some((cell) => cell.hasData !== false) ? <div className={styles.emptyHint}>{labels.emptyPeriod}</div> : null}
      </div> : null}
    </article>

    <aside className={styles.detailColumn}>
      {detail ? <article className={`${styles.detailCard} ${detail.confidence ? styles.detailWithConfidence : ""}`}>
        <header><strong>{detail.title}</strong><span>{detail.contextLabel}</span></header>
        <div className={styles.detailMetrics}>{detail.metrics.map((item) => {
          const hint = item.tooltip
            ? <Tooltip
                autoAdjustOverflow
                position="topRight"
                showArrow
                style={{ width: "auto", maxWidth: "calc(100vw - 24px)" }}
                content={item.tooltip}
              ><small tabIndex={0}>{item.hint}</small></Tooltip>
            : <small>{item.hint}</small>;
          const content = <><span>{item.label}</span><strong>{item.value}</strong>{hint}</>;
          return item.expandable
            ? <button key={item.key} type="button" className={`${styles.detailMetric} ${styles.expandableMetric}`} title={item.title} onClick={() => onDetailMetricClick?.(item.key)}>{content}</button>
            : <div key={item.key} className={styles.detailMetric}>{content}</div>;
        })}</div>
        {detail.confidence ? <section className={styles.selectedConfidence}>
          <header><strong>{labels.confidenceTitle}</strong><span>{detail.confidence.scoreLabel}</span></header>
          <div className={styles.selectedConfidenceOverview}><ConfidenceSummary confidence={detail.confidence} compact /><ConfidenceBreakdown confidence={detail.confidence} compact /></div>
          <ConfidenceNotice confidence={detail.confidence} onClick={() => onConfidenceNotice?.("selected")} />
        </section> : null}
      </article> : <article className={`${styles.detailCard} ${styles.detailEmpty}`}><div className={styles.emptyVisual}><IconBarChartVStroked size="extra-large" /></div><div className={styles.emptyCopy}><span>{labels.emptyLabel ?? "Token"}</span><strong>{labels.emptyTitle ?? labels.selectHint}</strong><small>{labels.selectHint}</small></div></article>}
    </aside>
  </div>;
}

function HeatmapLegend({ labels }: { labels: UsageStatisticsLabels }) {
  return <div className={styles.legend}><span>{labels.low}</span>{[0, 1, 2, 3, 4].map((level) => <i key={level} className={styles[`heatLevel${level}`]} />)}<span>{labels.high}</span></div>;
}
