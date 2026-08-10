import type { ReactNode } from "react";
import { Switch, Tabs } from "@douyinfe/semi-ui-19";
import styles from "./ModelsServiceView.module.css";

export type ModelsServiceStatModel = {
  key: string;
  label: string;
  value: string;
  tone?: "default" | "success";
};

export type ModelsServiceItemModel = {
  id: string;
  kind: "aggregate" | "direct";
  name: string;
  typeLabel: string;
  summary: ReactNode;
  summaryMuted?: boolean;
  enabled: boolean;
  logo?: ReactNode | string;
  toggleLabel?: string;
  toggleDisabled?: boolean;
  toggleLoading?: boolean;
};

export type ModelsServiceLabels = {
  stats: Record<string, string>;
  statsAria?: string;
  aggregateGroup: string;
  directGroup: string;
  currentVisible: string;
  hint: string;
  ready: string;
  off: string;
  empty?: string;
};

export type ModelsServiceDetailTabModel = {
  key: string;
  label: string;
  content: ReactNode;
};

export type ModelsServiceMetricModel = { key: string; label: ReactNode; value: ReactNode };
export type ModelsServiceCapabilityModel = { key: string; label: ReactNode; value: ReactNode; supported?: boolean };
export type ModelsServiceRouteModel = { key: string; order: ReactNode; title: ReactNode; subtitle: ReactNode; trailing?: ReactNode };

type Props = {
  stats: ModelsServiceStatModel[];
  groups: { aggregate: ModelsServiceItemModel[]; direct: ModelsServiceItemModel[] };
  labels: ModelsServiceLabels;
  density?: "default" | "compact";
  toolbar?: ReactNode;
  kindSummary?: ReactNode;
  detail?: ReactNode;
  loading?: boolean;
  empty?: ReactNode;
  onSelect?: (id: string) => void;
  onToggle?: (id: string, enabled: boolean) => void;
  selectedId?: string | null;
};

function ModelLogo({ logo }: { logo?: ReactNode | string }) {
  if (typeof logo === "string") return <img className={styles.modelLogo} src={logo} alt="" />;
  return logo ? <span className={styles.modelLogoNode}>{logo}</span> : <span className={styles.modelLogoFallback} />;
}

export function ModelsServiceView({ stats, groups, labels, density = "default", toolbar, kindSummary, detail, loading = false, empty, onSelect, onToggle, selectedId }: Props) {
  const renderRow = (model: ModelsServiceItemModel) => (
    <div key={model.id} className={`${styles.modelRow} ${selectedId === model.id ? styles.selected : ""}`}>
      <button type="button" className={styles.modelRowMain} aria-pressed={selectedId === model.id} onClick={() => onSelect?.(model.id)}>
        <span className={styles.modelName}>
          <ModelLogo logo={model.logo} />
          <span><strong>{model.name}</strong><small>{model.typeLabel}</small></span>
        </span>
        <span className={`${styles.routeSummary} ${model.summaryMuted ? styles.routeSummaryMuted : ""}`}>{model.summary}</span>
      </button>
      <span className={styles.rowEnable}>
        {onToggle ? <Switch checked={model.enabled} loading={model.toggleLoading} disabled={model.toggleDisabled} aria-label={model.toggleLabel} onChange={(checked) => onToggle(model.id, checked)} /> : (
          <span className={`${styles.status} ${model.enabled ? styles.statusOn : ""}`}><i />{model.enabled ? labels.ready : labels.off}</span>
        )}
      </span>
    </div>
  );

  const total = groups.aggregate.length + groups.direct.length;
  return (
    <div className={`${styles.page} ${density === "compact" ? styles.compact : ""}`}>
      <section className={styles.statsBar} aria-label={labels.statsAria ?? "model stats"}>
        {stats.map((stat) => <div className={styles.stat} key={stat.key}><span>{stat.label}</span><strong className={stat.tone === "success" ? styles.statSuccess : ""}>{stat.value}</strong></div>)}
        {kindSummary ? <span className={styles.kindSummary}>{kindSummary}</span> : null}
      </section>

      <div className={styles.workspace}>
        <section className={styles.listCard}>
          {toolbar ? <div className={styles.toolbarSlot}>{toolbar}</div> : null}
          <div className={styles.modelList}>
            {loading ? <div className={styles.empty}>{labels.empty}</div> : null}
            {!loading && total === 0 ? <div className={styles.empty}>{empty ?? labels.empty}</div> : null}
            {groups.aggregate.length > 0 ? <><div className={styles.groupTitle}>{labels.aggregateGroup}<span className={styles.groupCount}>{groups.aggregate.length}</span></div>{groups.aggregate.map(renderRow)}</> : null}
            {groups.direct.length > 0 ? <><div className={styles.groupTitle}>{labels.directGroup}<span className={styles.groupCount}>{groups.direct.length}</span></div>{groups.direct.map(renderRow)}</> : null}
          </div>
          <footer className={styles.listFooter}><span>{labels.currentVisible}</span><span>{labels.hint}</span></footer>
        </section>
        {detail}
      </div>
    </div>
  );
}

export function ModelsServiceDetailView({ logo, title, subtitle, tabs, activeKey, onTabChange, footer, empty }: {
  logo?: ReactNode;
  title?: ReactNode;
  subtitle?: ReactNode;
  tabs?: ModelsServiceDetailTabModel[];
  activeKey?: string;
  onTabChange?: (key: string) => void;
  footer?: ReactNode;
  empty?: ReactNode;
}) {
  if (empty) return <section className={`${styles.detailCard} ${styles.detailEmpty}`}>{empty}</section>;
  return (
    <section className={styles.detailCard}>
      <header className={styles.detailHeader}>{logo}<span className={styles.detailTitle}><strong>{title}</strong><small>{subtitle}</small></span></header>
      <div className={styles.detailBody}>
        <Tabs className={styles.detailTabs} type="line" activeKey={activeKey} onChange={(key) => onTabChange?.(String(key))} tabPaneMotion={false}>
          {(tabs ?? []).map((tab) => <Tabs.TabPane tab={tab.label} itemKey={tab.key} key={tab.key}>{tab.content}</Tabs.TabPane>)}
        </Tabs>
      </div>
      {footer ? <footer className={styles.detailFooter}>{footer}</footer> : null}
    </section>
  );
}

export function ModelsServiceTabContentView({ children }: { children: ReactNode }) {
  return <div className={styles.tabContent}>{children}</div>;
}

export function ModelsServiceInfoBannerView({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return <div className={styles.infoBanner}>{icon}<span>{children}</span></div>;
}

export function ModelsServiceSectionView({ title, note, children }: { title: ReactNode; note?: ReactNode; children: ReactNode }) {
  return <section className={styles.detailSection}><header><strong>{title}</strong>{note ? <span>{note}</span> : null}</header><div className={styles.configBox}>{children}</div></section>;
}

export function ModelsServiceMetricGridView({ items }: { items: ModelsServiceMetricModel[] }) {
  return <div className={styles.parameterGrid}>{items.map((item) => <div className={styles.parameterItem} key={item.key}><span>{item.label}</span><strong>{item.value}</strong></div>)}</div>;
}

export function ModelsServiceCapabilityListView({ items }: { items: ModelsServiceCapabilityModel[] }) {
  return <>{items.map((item) => <div className={styles.configRow} key={item.key}><span>{item.label}</span><strong className={item.supported === true ? styles.capYes : item.supported === false ? styles.capNo : ""}>{item.value}</strong></div>)}</>;
}

export function ModelsServiceRouteOverviewView({ title, summary, description, action, routes }: { title: ReactNode; summary?: ReactNode; description: ReactNode; action?: ReactNode; routes: ModelsServiceRouteModel[] }) {
  return <>
    <div className={styles.routeOverview}><div className={styles.routeOverviewHeader}><strong>{title}</strong><span className={styles.routeOverviewActions}>{summary ? <span className={styles.routeCountPill}>{summary}</span> : null}{action}</span></div><span className={styles.routeOverviewDesc}>{description}</span></div>
    <div className={styles.configBox}>{routes.map((route) => <div className={styles.demoRouteRow} key={route.key}><b>{route.order}</b><span><strong>{route.title}</strong><small>{route.subtitle}</small></span>{route.trailing}</div>)}</div>
  </>;
}
