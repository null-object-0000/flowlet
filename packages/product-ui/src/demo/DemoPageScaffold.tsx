import { useState, type ReactNode } from "react";
import { Button } from "@douyinfe/semi-ui-19";
import { DesktopFilterToolbarView, DesktopRefreshControlView, DesktopTimePresetSelectView, DesktopTimeScopeView } from "../desktop/DesktopControlsView";
import { DesktopPageHeaderView, DesktopPageLayoutView } from "../desktop/DesktopPageLayoutView";

export function DemoPageScaffold({ title, subtitle, controls, children }: {
  title: ReactNode;
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
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [rangeValue, setRangeValue] = useState("range");
  return <DesktopTimeScopeView>
    {range ? <DesktopTimePresetSelectView value={rangeValue} options={[{ value: "range", label: range }]} ariaLabel={zh ? "时间范围" : "Time range"} onChange={setRangeValue} /> : null}
    {action ? <Button type="tertiary" theme="outline">{action}</Button> : null}
    <DesktopRefreshControlView autoRefresh={autoRefresh} liveLabel={zh ? "实时更新中" : "Live"} pausedLabel={zh ? "已暂停" : "Paused"} refreshLabel={zh ? "刷新" : "Refresh"} onToggleAutoRefresh={() => setAutoRefresh((value) => !value)} onRefresh={() => undefined} />
  </DesktopTimeScopeView>;
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
  return <DesktopFilterToolbarView
    ariaLabel={placeholder}
    search={{ value, placeholder, width: 280 }}
    selects={filters.map((filter, index) => ({ key: String(index), value: "all", ariaLabel: filter, options: [{ value: "all", label: filter }] }))}
    segments={statuses ? { value: String(activeStatus ?? 0), ariaLabel: "status", options: statuses.map((status, index) => ({ value: String(index), label: status })) } : undefined}
    onSearchChange={onChange}
    onSegmentChange={(next) => onStatusChange?.(Number(next))}
  />;
}
