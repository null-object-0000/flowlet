import type { ReactNode } from "react";
import styles from "./UsageAnalysisView.module.css";

export type UsageAnalysisBadgeModel = { img?: string; letter?: string; node?: ReactNode };

export type UsageAnalysisRankEntryModel = {
  key: string;
  label: string;
  sublabel?: string;
  badge: UsageAnalysisBadgeModel;
  tokenValue: string;
  tokenShare: string;
  costValue: string;
  costShare: string;
};

export type UsageAnalysisMatrixColumnModel = {
  key: string;
  label: string;
  shortLabel: string;
};

export type UsageAnalysisMatrixCellModel = {
  value: string;
  level: 0 | 1 | 2 | 3 | 4;
  empty?: boolean;
};

export type UsageAnalysisMatrixRowModel = {
  key: string;
  label: string;
  cells: UsageAnalysisMatrixCellModel[];
};

export type UsageAnalysisDetailModel = {
  label: string;
  inputOutput: string;
  outputSpeed: string;
  cacheHitRate: string;
  meta: string;
};

export type UsageAnalysisLabels = {
  dimensionTitle: string;
  dimensionSubtitle: string;
  rankObject: string;
  rankToken: string;
  rankCost: string;
  matrixTitle: string;
  matrixSubtitle: string;
  metricTokens: string;
  metricCost: string;
  selected: string;
  inputOutput: string;
  outputSpeed: string;
  cacheHitRate: string;
  heatLow: string;
  heatHigh: string;
  emptyCell: string;
};

export type UsageAnalysisDimensionModel = {
  key: string;
  label: string;
};

type Props = {
  entries: UsageAnalysisRankEntryModel[];
  columns: UsageAnalysisMatrixColumnModel[];
  rows: UsageAnalysisMatrixRowModel[];
  selectedKey: string | null;
  detail: UsageAnalysisDetailModel | null;
  labels: UsageAnalysisLabels;
  metric: "tokens" | "cost";
  dimensions?: UsageAnalysisDimensionModel[];
  selectedDimension?: string;
  density?: "default" | "compact";
  matrixColumnLimit?: number;
  matrixFooterAction?: ReactNode;
  onSelect?: (key: string) => void;
  onMetricChange?: (metric: "tokens" | "cost") => void;
  onDimensionChange?: (dimension: string) => void;
};

export function UsageAnalysisView({
  entries,
  columns,
  rows,
  selectedKey,
  detail,
  labels,
  metric,
  dimensions = [],
  selectedDimension,
  density = "default",
  matrixColumnLimit = 4,
  matrixFooterAction,
  onSelect,
  onMetricChange,
  onDimensionChange,
}: Props) {
  const visibleColumnCount = Math.min(columns.length, Math.max(1, Math.floor(matrixColumnLimit)));
  const visibleColumns = columns.slice(0, visibleColumnCount);
  const hasHiddenColumns = visibleColumnCount < columns.length;

  return (
    <div className={`${styles.page} ${density === "compact" ? styles.compact : ""}`}>
      <div className={styles.card}>
        <header className={styles.cardHeader}>
          <div className={styles.cardTitle}>
            <strong>{labels.dimensionTitle}</strong>
            <span>{labels.dimensionSubtitle}</span>
          </div>
          {dimensions.length > 0 ? (
            <div className={styles.dimensionTabs} role="tablist" aria-label={labels.dimensionTitle}>
              {dimensions.map((dimension) => (
                <button
                  key={dimension.key}
                  type="button"
                  role="tab"
                  aria-selected={dimension.key === selectedDimension}
                  onClick={() => onDimensionChange?.(dimension.key)}
                >
                  {dimension.label}
                </button>
              ))}
            </div>
          ) : null}
        </header>

        <div className={styles.body}>
          <div className={styles.rankPane}>
            <div className={styles.rankHead}>
              <span>{labels.rankObject}</span>
              <span>{labels.rankToken}</span>
              <span>{labels.rankCost}</span>
              <span aria-hidden="true" />
            </div>
            {entries.map((entry) => {
              const selected = entry.key === selectedKey;
              return (
                <button
                  key={entry.key}
                  type="button"
                  className={`${styles.rankRow} ${selected ? styles.rankRowSelected : ""}`}
                  aria-pressed={selected}
                  onClick={() => onSelect?.(entry.key)}
                >
                  <span className={styles.rankName}>
                    <Badge badge={entry.badge} />
                    <span className={styles.rankNameText}>
                      <strong>{entry.label}</strong>
                      {entry.sublabel ? <small>{entry.sublabel}</small> : null}
                    </span>
                  </span>
                  <span className={styles.metricCell}>
                    <strong>{entry.tokenValue}</strong>
                    <small>{entry.tokenShare}</small>
                  </span>
                  <span className={styles.metricCell}>
                    <strong>{entry.costValue}</strong>
                    <small>{entry.costShare}</small>
                  </span>
                  <span className={styles.rankArrow} aria-hidden="true">›</span>
                </button>
              );
            })}
          </div>

          <aside className={styles.matrixPane}>
            <div className={styles.matrixHead}>
              <div className={styles.matrixTitle}>
                <strong>{labels.matrixTitle}</strong>
                <span>{labels.matrixSubtitle}</span>
              </div>
              <div className={styles.metricSeg} aria-label={labels.matrixTitle}>
                <button type="button" aria-pressed={metric === "tokens"} onClick={() => onMetricChange?.("tokens")}>{labels.metricTokens}</button>
                <button type="button" aria-pressed={metric === "cost"} onClick={() => onMetricChange?.("cost")}>{labels.metricCost}</button>
              </div>
            </div>

            <div className={styles.matrixScroll}>
              <div
                className={styles.matrixGrid}
                style={{ gridTemplateColumns: `minmax(96px, 1.15fr) repeat(${visibleColumns.length}, minmax(0, 1fr))` }}
              >
                <span className={styles.matrixCorner} aria-hidden="true" />
                {visibleColumns.map((column) => (
                  <span key={column.key} className={styles.matrixColHead} title={column.label}>
                    {column.shortLabel}
                  </span>
                ))}
                {rows.map((row) => (
                  <FragmentRow
                    key={row.key}
                    row={{ ...row, cells: row.cells.slice(0, visibleColumnCount) }}
                    selected={row.key === selectedKey}
                    emptyLabel={labels.emptyCell}
                    onSelect={() => onSelect?.(row.key)}
                  />
                ))}
              </div>
            </div>

            <div className={styles.matrixFoot}>
              <span className={styles.heatLegend}>
                <span>{labels.heatLow}</span>
                {[0, 1, 2, 3, 4].map((level) => (
                  <i key={level} className={`${styles.heatSwatch} ${styles[`heatLevel${level}`]}`} />
                ))}
                <span>{labels.heatHigh}</span>
              </span>
              {hasHiddenColumns ? matrixFooterAction : null}
            </div>

            {detail ? (
              <article className={styles.detail}>
                <header className={styles.detailHead}>
                  <strong>{detail.label}</strong>
                  <span className={styles.detailPill}>{labels.selected}</span>
                </header>
                <div className={styles.detailGrid}>
                  <div><span>{labels.inputOutput}</span><strong>{detail.inputOutput}</strong></div>
                  <div><span>{labels.outputSpeed}</span><strong>{detail.outputSpeed}</strong></div>
                  <div><span>{labels.cacheHitRate}</span><strong>{detail.cacheHitRate}</strong></div>
                </div>
                <div className={styles.detailMeta}>{detail.meta}</div>
              </article>
            ) : null}
          </aside>
        </div>
      </div>
    </div>
  );
}

function Badge({ badge }: { badge: UsageAnalysisBadgeModel }) {
  if (badge.node) return <span className={styles.badge}>{badge.node}</span>;
  if (badge.img) {
    return <img className={styles.badge} src={badge.img} alt="" />;
  }
  return <span className={`${styles.badge} ${styles.badgeLetter}`} aria-hidden="true">{badge.letter ?? "?"}</span>;
}

function FragmentRow({ row, selected, emptyLabel, onSelect }: {
  row: UsageAnalysisMatrixRowModel;
  selected: boolean;
  emptyLabel: string;
  onSelect: () => void;
}) {
  return (
    <>
      <button
        type="button"
        className={styles.matrixRowHead}
        aria-pressed={selected}
        title={row.label}
        onClick={onSelect}
      >
        {row.label}
      </button>
      {row.cells.map((cell, index) => (
        cell.empty ? (
          <span key={index} className={`${styles.matrixCell} ${styles.matrixCellEmpty}`} title={emptyLabel}>
            —
          </span>
        ) : (
          <span key={index} className={`${styles.matrixCell} ${styles[`heatLevel${cell.level}`]}`}>
            {cell.value}
          </span>
        )
      ))}
    </>
  );
}
