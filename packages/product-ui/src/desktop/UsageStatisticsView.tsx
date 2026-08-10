import styles from "./UsageStatisticsView.module.css";

export type UsageStatisticsPeriod = "day" | "week" | "month";
export type UsageStatisticsMetric = "tokens" | "cost";

export type UsageStatisticsStatModel = {
  key: string;
  label: string;
  value: string;
  hint: string;
};

export type UsageStatisticsCellModel = {
  key: string;
  label: string;
  value: number;
  displayValue: string;
  level: 0 | 1 | 2 | 3 | 4;
  disabled?: boolean;
};

export type UsageStatisticsDetailModel = {
  title: string;
  tokenValue: string;
  requestValue: string;
  cacheValue: string;
  costValue: string;
  sourceHint: string;
};

export type UsageStatisticsLabels = {
  confidenceTitle: string;
  confidenceValue: string;
  confidenceHint: string;
  chartTitle: string;
  chartHint: string;
  tokens: string;
  cost: string;
  selected: string;
  selectHint: string;
  requests: string;
  cacheInput: string;
  estimatedCost: string;
  low: string;
  high: string;
};

type Props = {
  stats: UsageStatisticsStatModel[];
  cells: UsageStatisticsCellModel[];
  detail: UsageStatisticsDetailModel | null;
  labels: UsageStatisticsLabels;
  period: UsageStatisticsPeriod;
  metric: UsageStatisticsMetric;
  selectedKey: string | null;
  onMetricChange?: (metric: UsageStatisticsMetric) => void;
  onSelect?: (key: string) => void;
};

export function UsageStatisticsView({ stats, cells, detail, labels, period, metric, selectedKey, onMetricChange, onSelect }: Props) {
  const maxValue = Math.max(1, ...cells.map((cell) => cell.value));
  return (
    <div className={styles.page}>
      <section className={styles.stats} aria-label="Usage summary">
        {stats.map((stat) => (
          <article key={stat.key} className={styles.stat}>
            <span>{stat.label}</span>
            <strong>{stat.value}</strong>
            <small>{stat.hint}</small>
          </article>
        ))}
      </section>

      <section className={styles.workspace}>
        <div className={styles.leftColumn}>
          <article className={styles.confidenceCard}>
            <header><strong>{labels.confidenceTitle}</strong><b>{labels.confidenceValue}</b></header>
            <div className={styles.confidenceTrack}><i /></div>
            <p>{labels.confidenceHint}</p>
          </article>

          <article className={styles.chartCard}>
            <header className={styles.chartHeader}>
              <div><strong>{labels.chartTitle}</strong><span>{labels.chartHint}</span></div>
              <div className={styles.metricSwitch} aria-label={labels.chartTitle}>
                <button type="button" aria-pressed={metric === "tokens"} onClick={() => onMetricChange?.("tokens")}>{labels.tokens}</button>
                <button type="button" aria-pressed={metric === "cost"} onClick={() => onMetricChange?.("cost")}>{labels.cost}</button>
              </div>
            </header>
            {period === "day" ? (
              <div className={styles.barFrame}>
                <div className={styles.barScale}><span>{cells.reduce((best, cell) => cell.value > best.value ? cell : best, cells[0])?.displayValue}</span><span>0</span></div>
                <div className={styles.barPlot}>
                  {cells.map((cell) => (
                    <button
                      key={cell.key}
                      type="button"
                      className={styles.barSlot}
                      aria-label={`${cell.label} · ${cell.displayValue}`}
                      aria-pressed={cell.key === selectedKey}
                      disabled={cell.disabled}
                      onClick={() => onSelect?.(cell.key)}
                    >
                      <i style={{ height: `${Math.max(3, (cell.value / maxValue) * 100)}%` }} />
                      <span>{Number(cell.label) % 2 === 0 ? cell.label : ""}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className={`${styles.heatmap} ${period === "week" ? styles.week : styles.month}`}>
                {cells.map((cell) => (
                  <button
                    key={cell.key}
                    type="button"
                    className={`${styles.heatCell} ${styles[`heatLevel${cell.level}`]}`}
                    aria-label={`${cell.label} · ${cell.displayValue}`}
                    aria-pressed={cell.key === selectedKey}
                    disabled={cell.disabled}
                    onClick={() => onSelect?.(cell.key)}
                  >{period === "month" ? cell.label : null}</button>
                ))}
              </div>
            )}
            {period !== "day" ? <div className={styles.legend}><span>{labels.low}</span>{[0, 1, 2, 3, 4].map((level) => <i key={level} className={styles[`heatLevel${level}`]} />)}<span>{labels.high}</span></div> : null}
          </article>
        </div>

        <aside className={styles.detailCard}>
          {detail ? <>
            <header><div><strong>{detail.title}</strong><span>{detail.sourceHint}</span></div><em>{labels.selected}</em></header>
            <div className={styles.detailHero}><span>Tokens</span><strong>{detail.tokenValue}</strong></div>
            <div className={styles.detailGrid}>
              <div><span>{labels.requests}</span><strong>{detail.requestValue}</strong></div>
              <div><span>{labels.cacheInput}</span><strong>{detail.cacheValue}</strong></div>
              <div><span>{labels.estimatedCost}</span><strong>{detail.costValue}</strong></div>
            </div>
            <div className={styles.sourceRows}>
              <div><span>Flowlet Proxy</span><i><b style={{ width: "78%" }} /></i><strong>78%</strong></div>
              <div><span>Agent Native</span><i><b style={{ width: "22%" }} /></i><strong>22%</strong></div>
            </div>
          </> : <div className={styles.emptyDetail}><span>⌁</span><strong>{labels.selectHint}</strong></div>}
        </aside>
      </section>
    </div>
  );
}
