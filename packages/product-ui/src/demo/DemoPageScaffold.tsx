import type { ReactNode } from "react";
import { DesktopPageHeaderView, DesktopPageLayoutView } from "../desktop/DesktopPageLayoutView";
import styles from "./DemoPageScaffold.module.css";

export function DemoPageScaffold({ title, subtitle, controls, children }: {
  title: string;
  subtitle: string;
  controls?: ReactNode;
  children: ReactNode;
}) {
  return (
    <DesktopPageLayoutView header={<DesktopPageHeaderView title={title} subtitle={subtitle}>{controls}</DesktopPageHeaderView>}>
      {children}
    </DesktopPageLayoutView>
  );
}

export function DemoRefreshControl({ zh, range, action }: { zh: boolean; range?: string; action?: string }) {
  return (
    <div className={styles.headerControls}>
      {range ? <button type="button" className={styles.controlButton}>{range}<span aria-hidden="true">⌄</span></button> : null}
      {action ? <button type="button" className={styles.controlButton}>{action}</button> : null}
      <span className={styles.liveStatus}><i />{zh ? "实时更新中" : "Live"}</span>
      <button type="button" className={styles.refreshButton} aria-label={zh ? "刷新" : "Refresh"}>↻</button>
    </div>
  );
}

export function DemoFilterToolbar({ value, placeholder, filters = [], statuses, activeStatus, onChange, onStatusChange }: {
  value: string;
  placeholder: string;
  filters?: string[];
  statuses?: string[];
  activeStatus?: number;
  onChange: (value: string) => void;
  onStatusChange?: (index: number) => void;
}) {
  return (
    <div className={styles.filterToolbar}>
      <label className={styles.search}><span aria-hidden="true">⌕</span><input value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} /></label>
      {filters.map((filter) => <button key={filter} type="button" className={styles.filterButton}>{filter}<span aria-hidden="true">⌄</span></button>)}
      {statuses ? (
        <div className={styles.segmented}>
          {statuses.map((status, index) => <button key={status} type="button" aria-pressed={index === activeStatus} onClick={() => onStatusChange?.(index)}>{status}</button>)}
        </div>
      ) : null}
    </div>
  );
}
