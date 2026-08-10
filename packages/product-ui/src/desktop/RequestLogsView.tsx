import type { ReactNode } from "react";
import styles from "./RequestLogsView.module.css";

export type RequestLogsStatItem = {
  key: string;
  label: string;
  value: string;
  hint?: string;
  success?: boolean;
};

export type RequestLogsRowModel = {
  id: string;
  time: string;
  client: string;
  model: string;
  method: string;
  path: string;
  channel: string;
  account: string;
  status: "success" | "failure";
  statusLabel: string;
  duration: string;
  streaming?: boolean;
  detail?: string;
  tokens?: string;
  cost?: string;
  tokenHint?: string;
  costHint?: string;
  ariaLabel?: string;
};

export type RequestLogsLabels = {
  time: string;
  client: string;
  modelInterface: string;
  channelAccount: string;
  status: string;
  performance: string;
  token: string;
  cost: string;
  stream: string;
  emptyTitle: string;
  emptyDesc: string;
};

type Props = {
  stats: RequestLogsStatItem[];
  rows: RequestLogsRowModel[];
  labels: RequestLogsLabels;
  density?: "default" | "compact";
  loading?: boolean;
  toolbar?: ReactNode;
  footer?: ReactNode;
  onOpenRow?: (id: string) => void;
  /** 可选渲染插槽：真实应用注入 Token 悬浮明细，官网走纯文本。 */
  renderToken?: (row: RequestLogsRowModel, index: number) => ReactNode;
  renderCost?: (row: RequestLogsRowModel, index: number) => ReactNode;
};

export function RequestLogsView({ stats, rows, labels, density = "default", loading = false, toolbar, footer, onOpenRow, renderToken, renderCost }: Props) {
  return (
    <div className={`${styles.page} ${density === "compact" ? styles.compact : ""}`}>
      <section className={styles.stats} aria-label={labels.status}>
        {stats.map((stat) => (
          <div className={styles.statCard} key={stat.key}>
            <span>{stat.label}</span>
            <div>
              <strong title={stat.value}>{stat.value}</strong>
              {stat.hint ? <small title={stat.hint} className={stat.success ? styles.successHint : ""}>{stat.hint}</small> : null}
            </div>
          </div>
        ))}
      </section>

      {toolbar ? <div className={styles.toolbarSlot}>{toolbar}</div> : null}

      <section className={styles.tableCard}>
        <div className={`${styles.grid} ${styles.head}`} role="row">
          <span role="columnheader">{labels.time}</span>
          <span role="columnheader">{labels.client}</span>
          <span role="columnheader">{labels.modelInterface}</span>
          <span role="columnheader">{labels.channelAccount}</span>
          <span role="columnheader">{labels.status}</span>
          <span role="columnheader">{labels.performance}</span>
          <span role="columnheader">{labels.token}</span>
          <span role="columnheader">{labels.cost}</span>
        </div>

        <div className={styles.body}>
          {loading ? Array.from({ length: 5 }, (_, index) => <SkeletonRow key={index} index={index} />) : null}
          {!loading && rows.length === 0 ? (
            <div className={styles.empty}>
              <strong>{labels.emptyTitle ?? "—"}</strong>
              <span>{labels.emptyDesc ?? ""}</span>
            </div>
          ) : null}
          {!loading ? rows.map((row, index) => (
            <button
              key={row.id}
              type="button"
              className={`${styles.grid} ${styles.row}`}
              aria-label={row.ariaLabel}
              onClick={() => onOpenRow?.(row.id)}
            >
              <span className={styles.time}>{row.time}</span>
              <span className={styles.clientCell}>
                <strong title={row.client}>{row.client}</strong>
              </span>
              <span className={styles.primaryCell}>
                <strong title={row.model}>{row.model}</strong>
                <small title={`${row.method} ${row.path}`}><b>{row.method}</b> {row.path}</small>
              </span>
              <span className={styles.primaryCell}>
                <strong>{row.channel}</strong>
                <small>{row.account}</small>
              </span>
              <span className={`${styles.status} ${row.status === "success" ? styles.success : styles.failure}`}>{row.statusLabel}</span>
              <span className={styles.metricCell}>
                <strong>
                  {row.duration}
                  {row.streaming ? <span className={styles.streamBadge}>{labels.stream}</span> : null}
                </strong>
                {row.detail ? <small>{row.detail}</small> : null}
              </span>
              {renderToken ? <span className={styles.number}>{renderToken(row, index)}</span> : <span className={styles.number} title={row.tokenHint}>{row.tokens ?? "—"}</span>}
              {renderCost ? <span className={styles.number}>{renderCost(row, index)}</span> : <span className={styles.number} title={row.costHint}>{row.cost ?? "—"}</span>}
            </button>
          )) : null}
        </div>
        {footer ? <div className={styles.tableFooter}>{footer}</div> : null}
      </section>
    </div>
  );
}

function SkeletonRow({ index }: { index: number }) {
  return (
    <div className={`${styles.grid} ${styles.row} ${styles.skeleton}`} aria-hidden="true">
      {Array.from({ length: 8 }, (_, column) => <span key={column} style={{ width: `${48 + ((index + column) % 4) * 12}%` }} />)}
    </div>
  );
}
