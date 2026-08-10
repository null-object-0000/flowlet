import type { ReactNode } from "react";
import { Card } from "@douyinfe/semi-ui-19";
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

export function OverviewListRowView({ logo, title, subtitle, trailing, onClick }: { logo: ReactNode; title: ReactNode; subtitle?: ReactNode; trailing?: ReactNode; onClick?: () => void }) {
  const content = <><span className={styles.rowLogo}>{logo}</span><span className={styles.rowCopy}><strong>{title}</strong>{subtitle ? <small>{subtitle}</small> : null}</span>{trailing ? <span className={styles.trailing}>{trailing}</span> : null}</>;
  return onClick ? <button type="button" className={styles.row} onClick={onClick}>{content}</button> : <div className={styles.row}>{content}</div>;
}
