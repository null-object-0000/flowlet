import { IconChevronDown, IconChevronUp, IconDesktop } from "@douyinfe/semi-icons";
import { Tag } from "@douyinfe/semi-ui-19";
import type { ReactNode } from "react";
import styles from "./MobilePageView.module.css";

export function MobilePageView({ children }: { children: ReactNode }) {
  return <section className={styles.page}>{children}</section>;
}

export function MobilePageHeaderView({ title, subtitle, meta, picker = false }: {
  title: ReactNode;
  subtitle: ReactNode;
  meta?: ReactNode;
  picker?: boolean;
}) {
  return (
    <header className={`${styles.heading} ${picker ? styles.headingWithPicker : ""}`}>
      {picker ? (
        <>
          <div className={styles.headingTitleRow}><h2>{title}</h2>{meta}</div>
          <p>{subtitle}</p>
        </>
      ) : (
        <div><h2>{title}</h2><p>{subtitle}</p></div>
      )}
    </header>
  );
}

export function MobileCardView({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <article className={`${styles.card} ${className}`}>{children}</article>;
}

export type MobileTaskTabModel = { id: string; label: string; count: number };
export type MobileTaskRowModel = {
  id: string;
  project: string;
  status: string;
  statusColor?: "grey" | "blue" | "green" | "orange" | "light-blue";
  title: string;
  round: string;
  device: string;
  updated: string;
};

export function MobileTaskBoardView({ tabs, activeTab, rows, empty, onTabChange, onTaskOpen }: {
  tabs: MobileTaskTabModel[];
  activeTab: string;
  rows: MobileTaskRowModel[];
  empty?: ReactNode;
  onTabChange?: (id: string) => void;
  onTaskOpen?: (id: string) => void;
}) {
  return <>
    <div className={styles.taskTabs} role="group">
      {tabs.map((tab) => <button key={tab.id} type="button" aria-pressed={activeTab === tab.id} onClick={() => onTabChange?.(tab.id)}>{tab.label}<span>{tab.count}</span></button>)}
    </div>
    {rows.length === 0 ? empty : <div className={styles.taskList}>{rows.map((row) => (
      <article
        key={row.id}
        className={styles.taskCard}
        role={onTaskOpen ? "button" : undefined}
        tabIndex={onTaskOpen ? 0 : undefined}
        onClick={() => onTaskOpen?.(row.id)}
        onKeyDown={(event) => {
          if (!onTaskOpen || (event.key !== "Enter" && event.key !== " ")) return;
          event.preventDefault();
          onTaskOpen(row.id);
        }}
      >
        <div className={styles.taskTopline}><span className={styles.taskProject}>{row.project}</span><Tag color={row.statusColor ?? "grey"} size="small">{row.status}</Tag></div>
        <strong className={styles.taskTitle}>{row.title}</strong>
        <div className={styles.taskMeta}><span className={styles.roundBadge}>{row.round}</span><span>{row.device}</span><time>{row.updated}</time></div>
      </article>
    ))}</div>}
  </>;
}

export type MobileDeviceRowModel = {
  id: string;
  name: string;
  platform: string;
  appVersion: string;
  status: string;
  statusTone: "ok" | "fail" | "muted";
  statusTitle?: string;
  metrics: string[];
  lastSeen: string;
  details?: ReactNode;
};

export function MobileDeviceListView({ rows, expandedId, onToggle }: {
  rows: MobileDeviceRowModel[];
  expandedId?: string | null;
  onToggle?: (id: string) => void;
}) {
  return <div className={styles.deviceList}>{rows.map((row) => {
    const expanded = expandedId === row.id;
    return <article className={styles.deviceCard} key={row.id}>
      <button type="button" className={styles.deviceToggle} aria-expanded={expanded} onClick={() => onToggle?.(row.id)}>
        <span className={styles.deviceIcon} aria-hidden="true"><IconDesktop /></span>
        <span className={styles.deviceIdentity}><strong>{row.name}</strong><small>{row.platform} · Flowlet {row.appVersion}</small></span>
        <span className={styles.lanState} data-state={row.statusTone} title={row.statusTitle}><i />{row.status}</span>
        <span className={styles.deviceChevron} aria-hidden="true">{expanded ? <IconChevronUp /> : <IconChevronDown />}</span>
        <span className={styles.deviceMetrics}>{row.metrics.map((metric) => <span key={metric}>{metric}</span>)}</span>
        <time>{row.lastSeen}</time>
      </button>
      {expanded ? row.details : null}
    </article>;
  })}</div>;
}

export { styles as mobileProductViewStyles };
