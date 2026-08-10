import type { CSSProperties, ReactNode } from "react";
import { Badge, Card } from "@douyinfe/semi-ui-19";
import { IconChevronRight } from "@douyinfe/semi-icons";
import styles from "./OverviewLayoutViews.module.css";

export function OverviewPageView({ service, children }: { service: ReactNode; children: ReactNode }) {
  return <div className={styles.page}>{service}{children}</div>;
}

export function OverviewGridView({ accounts, models, agents }: { accounts: ReactNode; models: ReactNode; agents: ReactNode }) {
  return <div className={styles.grid}><div className={styles.accounts}>{accounts}</div><div>{models}</div><div>{agents}</div></div>;
}

export function OverviewModuleCardView({ title, meta, description, action, onAction, headerExtra, children }: { title: ReactNode; meta?: ReactNode; description?: ReactNode; action?: string; onAction?: () => void; headerExtra?: ReactNode; children: ReactNode }) {
  return (
    <Card className={styles.card}>
      <div className={styles.cardBody}>
        <div className={styles.header}>
          <div className={styles.title}>{title}{meta ? <span className={styles.meta}>{meta}</span> : null}</div>
          {headerExtra ?? (action ? <button type="button" className={styles.action} onClick={onAction}>{action}<IconChevronRight size="small" aria-hidden="true" /></button> : null)}
        </div>
        {description ? <div className={styles.description}>{description}</div> : null}
        <div className={styles.cardContent}>{children}</div>
      </div>
    </Card>
  );
}

export function OverviewListView({ children }: { children: ReactNode }) { return <div className={styles.list}>{children}</div>; }

export function OverviewListRowView({ logo, title, subtitle, trailing, actions, onClick, ariaLabel }: {
  logo: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  trailing?: ReactNode;
  actions?: ReactNode;
  onClick?: () => void;
  ariaLabel?: string;
}) {
  const main = <><span className={styles.rowLogo}>{logo}</span><span className={styles.rowCopy}><span className={styles.rowTitle}>{title}</span>{subtitle ? <small>{subtitle}</small> : null}</span></>;
  return (
    <div className={styles.row}>
      {onClick
        ? <button type="button" className={styles.rowMain} aria-label={ariaLabel} onClick={onClick}>{main}</button>
        : <div className={styles.rowMain}>{main}</div>}
      {trailing ? <span className={styles.trailing}>{trailing}</span> : null}
      {actions ? <span className={styles.rowActions}>{actions}</span> : null}
    </div>
  );
}

export type OverviewAgentSurfaceModel = { label: string; value: string };

export function OverviewAgentListView({ children }: { children: ReactNode }) {
  return <div className={styles.agentList}>{children}</div>;
}

export function OverviewAgentRowView({ name, iconSrc, tone = "neutral", surfaces, updateAvailable = false, onClick, ariaLabel, title }: {
  name: string;
  iconSrc: string;
  tone?: "claude" | "neutral";
  surfaces: OverviewAgentSurfaceModel[];
  updateAvailable?: boolean;
  onClick?: () => void;
  ariaLabel?: string;
  title?: string;
}) {
  const iconStyle = { "--overview-agent-icon": `url("${iconSrc}")` } as CSSProperties;
  return (
    <button type="button" className={styles.agentRow} aria-label={ariaLabel} title={title} onClick={onClick}>
      {updateAvailable ? (
        <Badge dot type="danger">
          <span className={`${styles.agentIcon} ${tone === "claude" ? styles.agentIconClaude : ""}`}><i style={iconStyle} /></span>
        </Badge>
      ) : (
        <span className={`${styles.agentIcon} ${tone === "claude" ? styles.agentIconClaude : ""}`}><i style={iconStyle} /></span>
      )}
      <span className={styles.agentCopy}>
        <strong>{name}</strong>
        <span className={styles.agentSurfaces}>
          {surfaces.map((surface) => <small key={surface.label}><span>{surface.label}</span><span>{surface.value}</span></small>)}
        </span>
      </span>
      <IconChevronRight size="small" className={styles.agentChevron} aria-hidden="true" />
    </button>
  );
}

export function OverviewStatusPillView({ children, tone = "success" }: { children: ReactNode; tone?: "success" | "warning" | "muted" }) {
  return <span className={`${styles.statusPill} ${styles[`status_${tone}`]}`}>{children}</span>;
}
