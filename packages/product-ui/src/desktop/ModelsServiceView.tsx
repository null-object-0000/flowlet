import { useEffect, useState, type ReactNode } from "react";
import { Button, Input, Select, Switch, Tabs } from "@douyinfe/semi-ui-19";
import { IconDelete, IconHandle, IconPlus, IconRefresh, IconSearch } from "@douyinfe/semi-icons";
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
export type ModelsServiceFilterOption = { value: string; label: ReactNode };
export type ModelsServiceRouteModel = {
  key: string;
  title: ReactNode;
  subtitle: ReactNode;
  usable: boolean;
  enabled: boolean;
  reorderLabel: string;
  reorderTitle: string;
  onlyRouteTitle: string;
  toggleLabel: string;
  usableLabel: ReactNode;
  unavailableLabel: ReactNode;
  removeLabel?: string;
  removeTitle?: string;
};
export type ModelsServiceRelationModel = {
  key: string;
  logo?: ReactNode;
  title: ReactNode;
  subtitle: ReactNode;
  enabled: boolean;
  activeLabel: ReactNode;
  idleLabel: ReactNode;
};

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

export function ModelsServiceDetailView({ logo, title, subtitle, headerAction, tabs, activeKey, onTabChange, footer, empty }: {
  logo?: ReactNode;
  title?: ReactNode;
  subtitle?: ReactNode;
  headerAction?: ReactNode;
  tabs?: ModelsServiceDetailTabModel[];
  activeKey?: string;
  onTabChange?: (key: string) => void;
  footer?: ReactNode;
  empty?: ReactNode;
}) {
  if (empty) return <section className={`${styles.detailCard} ${styles.detailEmpty}`}>{empty}</section>;
  return (
    <section className={styles.detailCard}>
      <header className={styles.detailHeader}>{logo}<span className={styles.detailTitle}><strong>{title}</strong><small>{subtitle}</small></span>{headerAction ? <span className={styles.detailHeaderAction}>{headerAction}</span> : null}</header>
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

export function ModelsServiceRefreshActionView({ label, loading, onClick }: { label: ReactNode; loading?: boolean; onClick?: () => void }) {
  return <Button className={styles.refreshAction} type="tertiary" theme="outline" icon={<IconRefresh />} loading={loading} onClick={onClick}>{label}</Button>;
}

export function ModelsServiceToolbarView({ search, searchPlaceholder, searchLabel, channel, channelLabel, options, onSearchChange, onChannelChange }: {
  search: string;
  searchPlaceholder: string;
  searchLabel: string;
  channel: string;
  channelLabel: string;
  options: ModelsServiceFilterOption[];
  onSearchChange: (value: string) => void;
  onChannelChange: (value: string) => void;
}) {
  return <div className={styles.toolbar}>
    <Input prefix={<IconSearch />} value={search} onChange={onSearchChange} placeholder={searchPlaceholder} aria-label={searchLabel} />
    <Select value={channel} aria-label={channelLabel} optionList={options} onChange={(value) => onChannelChange(String(value))} />
  </div>;
}

export function ModelsServiceRouteOverviewView({ title, summary, description, addLabel, addDisabled, onAdd, routes, busy = false, removable = false, empty, onToggle, onReorder, onRemove }: {
  title: ReactNode;
  summary?: ReactNode;
  description: ReactNode;
  addLabel?: ReactNode;
  addDisabled?: boolean;
  onAdd?: () => void;
  routes?: ModelsServiceRouteModel[];
  busy?: boolean;
  removable?: boolean;
  empty?: ReactNode;
  onToggle?: (key: string, enabled: boolean) => void;
  onReorder?: (sourceKey: string, targetKey: string) => void;
  onRemove?: (key: string) => void;
}) {
  return <>
    <div className={styles.routeOverview}>
      <div className={styles.routeOverviewHeader}>
        <strong>{title}</strong>
        <span className={styles.routeOverviewActions}>
          {summary ? <span className={styles.routeCountPill}>{summary}</span> : null}
          {addLabel ? <Button theme="borderless" type="primary" size="small" icon={<IconPlus />} disabled={busy || addDisabled} onClick={onAdd}>{addLabel}</Button> : null}
        </span>
      </div>
      <span className={styles.routeOverviewDesc}>{description}</span>
    </div>
    {routes ? <ModelsServiceRouteListView routes={routes} busy={busy} removable={removable} empty={empty} onToggle={onToggle} onReorder={onReorder} onRemove={onRemove} /> : null}
  </>;
}

export function ModelsServiceRouteListView({ routes, busy = false, removable = false, framed = true, empty, onToggle, onReorder, onRemove }: {
  routes: ModelsServiceRouteModel[];
  busy?: boolean;
  removable?: boolean;
  framed?: boolean;
  empty?: ReactNode;
  onToggle?: (key: string, enabled: boolean) => void;
  onReorder?: (sourceKey: string, targetKey: string) => void;
  onRemove?: (key: string) => void;
}) {
  const [draggedRouteKey, setDraggedRouteKey] = useState<string | null>(null);
  const [dragTargetKey, setDragTargetKey] = useState<string | null>(null);
  useEffect(() => {
    const cancelPointerDrag = () => { setDraggedRouteKey(null); setDragTargetKey(null); };
    window.addEventListener("pointercancel", cancelPointerDrag);
    window.addEventListener("pointerup", cancelPointerDrag);
    return () => {
      window.removeEventListener("pointercancel", cancelPointerDrag);
      window.removeEventListener("pointerup", cancelPointerDrag);
    };
  }, []);
  const canReorder = !busy && routes.length > 1 && Boolean(onReorder);
  const content = routes.length === 0 ? <div className={styles.emptyRouteState}>{empty}</div> : routes.map((route, index) => {
        const moveByKeyboard = (direction: -1 | 1) => {
          const target = routes[index + direction];
          if (target) onReorder?.(route.key, target.key);
        };
        return <div
          className={`${styles.routeRow} ${draggedRouteKey === route.key ? styles.dragging : ""} ${dragTargetKey === route.key ? styles.dragTarget : ""}`}
          key={route.key}
          onPointerEnter={() => { if (canReorder && draggedRouteKey && draggedRouteKey !== route.key) setDragTargetKey(route.key); }}
          onPointerUp={() => {
            const sourceKey = draggedRouteKey;
            setDraggedRouteKey(null);
            setDragTargetKey(null);
            if (canReorder && sourceKey && sourceKey !== route.key) onReorder?.(sourceKey, route.key);
          }}
        >
          <button
            type="button"
            className={`${styles.dragHandle} ${!canReorder ? styles.dragHandleInactive : ""}`}
            disabled={busy}
            aria-disabled={!canReorder}
            aria-label={route.reorderLabel}
            title={routes.length > 1 ? route.reorderTitle : route.onlyRouteTitle}
            onPointerDown={(event) => {
              if (!canReorder || event.button !== 0) return;
              event.preventDefault();
              setDraggedRouteKey(route.key);
              setDragTargetKey(null);
            }}
            onKeyDown={(event) => {
              if (!canReorder) return;
              if (event.key === "ArrowUp") { event.preventDefault(); moveByKeyboard(-1); }
              else if (event.key === "ArrowDown") { event.preventDefault(); moveByKeyboard(1); }
            }}
          ><IconHandle /></button>
          <span className={styles.priority}>{index + 1}</span>
          <span className={styles.routeCopy}><strong>{route.title}</strong><small>{route.subtitle}</small></span>
          <span className={styles.routeActions}>
            <span className={route.usable ? styles.healthy : styles.unavailable}>{route.usable ? route.usableLabel : route.unavailableLabel}</span>
            <Switch checked={route.enabled} disabled={busy} aria-label={route.toggleLabel} onChange={(checked) => onToggle?.(route.key, checked)} />
            {removable ? <Button className={styles.routeDelete} theme="borderless" type="danger" size="small" icon={<IconDelete />} disabled={busy} aria-label={route.removeLabel} title={route.removeTitle} onClick={() => onRemove?.(route.key)} /> : null}
          </span>
        </div>;
    });
  return framed ? <div className={styles.configBox}>{content}</div> : <>{content}</>;
}

export function ModelsServiceRelationListView({ relations }: { relations: ModelsServiceRelationModel[] }) {
  return <div className={styles.configBox}>{relations.map((relation) => <div className={styles.relationRow} key={relation.key}>
    {relation.logo}
    <span className={styles.routeCopy}><strong>{relation.title}</strong><small>{relation.subtitle}</small></span>
    <span className={relation.enabled ? styles.relationActive : styles.relationIdle}>{relation.enabled ? relation.activeLabel : relation.idleLabel}</span>
  </div>)}</div>;
}
