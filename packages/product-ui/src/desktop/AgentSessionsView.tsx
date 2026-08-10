import type { ReactNode } from "react";
import styles from "./AgentSessionsView.module.css";

export type AgentSessionStatusTone = "running" | "waiting" | "idle" | "unknown";

export type AgentSessionRowModel = {
  id: string;
  activityAt: string;
  title: string;
  subtitle: string;
  client: string;
  clientSub?: string;
  requests?: string;
  requestsTitle?: string;
  requestsPrefix?: string;
  tokens?: string;
  tokenHint?: string;
  cost?: string;
  costHint?: string;
  status: string;
  statusTone: AgentSessionStatusTone;
  statusHint: string;
  ariaLabel?: string;
};

export type AgentSessionsLabels = {
  activity: string;
  session: string;
  client: string;
  requests: string;
  token: string;
  cost: string;
  status: string;
  total: string;
};

type Props = {
  rows: AgentSessionRowModel[];
  labels: AgentSessionsLabels;
  density?: "default" | "compact";
  loading?: boolean;
  toolbar?: ReactNode;
  footer?: ReactNode;
  onOpenRow?: (id: string) => void;
  /** 可选渲染插槽：真实应用注入 Token/费用悬浮明细，官网走纯文本。 */
  renderRequests?: (row: AgentSessionRowModel, index: number) => ReactNode;
  renderToken?: (row: AgentSessionRowModel, index: number) => ReactNode;
  renderCost?: (row: AgentSessionRowModel, index: number) => ReactNode;
};

export function AgentSessionsView({ rows, labels, density = "default", loading = false, toolbar, footer, onOpenRow, renderRequests, renderToken, renderCost }: Props) {
  return (
    <div className={`${styles.page} ${density === "compact" ? styles.compact : ""}`}>
      {toolbar ? <div className={styles.toolbarSlot}>{toolbar}</div> : null}
      <div className={styles.tableCard}>
        <div className={`${styles.grid} ${styles.head}`} role="row">
          <span>{labels.activity}</span>
          <span>{labels.session}</span>
          <span>{labels.client}</span>
          <span>{labels.requests}</span>
          <span>{labels.token}</span>
          <span>{labels.cost}</span>
          <span>{labels.status}</span>
        </div>
        <div className={styles.body}>
          {loading ? Array.from({ length: 5 }, (_, index) => <SkeletonRow key={index} index={index} />) : null}
          {!loading ? rows.map((row, index) => (
            <button key={row.id} type="button" className={`${styles.grid} ${styles.row}`} aria-label={row.ariaLabel} onClick={() => onOpenRow?.(row.id)}>
              <span className={styles.activityAt}>{row.activityAt}</span>
              <span className={styles.session}>
                <strong title={row.title}>{row.title}</strong>
                <small title={row.subtitle}>{row.subtitle}</small>
              </span>
              <span className={styles.clientCell}>
                <strong title={row.client}>{row.client}</strong>
                {row.clientSub ? <small title={row.clientSub}>{row.clientSub}</small> : null}
              </span>
              {renderRequests ? <span className={styles.number}>{renderRequests(row, index)}</span> : <span className={styles.number} title={row.requestsTitle}>{row.requestsPrefix}{row.requests ?? "—"}</span>}
              {renderToken ? <span className={styles.number}>{renderToken(row, index)}</span> : <span className={styles.number} title={row.tokenHint}>{row.tokens ?? "—"}</span>}
              {renderCost ? <span className={styles.number}>{renderCost(row, index)}</span> : <span className={styles.number} title={row.costHint}>{row.cost ?? "—"}</span>}
              <span className={styles.statusCell}>
                <em className={styles[`tone_${row.statusTone}`]}>{row.status}</em>
                <small className={row.statusTone === "running" ? styles.hintActive : ""}>{row.statusHint}</small>
              </span>
            </button>
          )) : null}
        </div>
        <footer className={styles.footer}>
          {footer ? footer : <span className={styles.total}>{labels.total}</span>}
        </footer>
      </div>
    </div>
  );
}

function SkeletonRow({ index }: { index: number }) {
  return (
    <div className={`${styles.grid} ${styles.row} ${styles.skeleton}`} aria-hidden="true">
      {Array.from({ length: 7 }, (_, column) => <span key={column} style={{ width: `${48 + ((index + column) % 4) * 12}%` }} />)}
    </div>
  );
}
