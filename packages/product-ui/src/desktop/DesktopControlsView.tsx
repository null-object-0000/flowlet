import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Button, Dropdown, Input, Popover, Select, Tooltip } from "@douyinfe/semi-ui-19";
import { IconCalendar, IconChevronDown, IconChevronLeft, IconChevronRight, IconRefresh, IconSearch } from "@douyinfe/semi-icons";
import styles from "./DesktopControlsView.module.css";

export type DesktopSelectOption = { value: string; label: ReactNode; disabled?: boolean; group?: string; internalLabel?: ReactNode };
export type DesktopFilterSelectModel = {
  key: string;
  value: string;
  ariaLabel: string;
  options: DesktopSelectOption[];
  insetLabel?: ReactNode;
  loading?: boolean;
  width?: number;
};
export type DesktopSegmentOption = { value: string; label: ReactNode };
export type DesktopDeviceOption = { value: string; label: ReactNode };

const LOADING_DELAY_MS = 500;
const MANUAL_FEEDBACK_MS = 600;

export function DesktopRefreshControlView({ autoRefresh, isFetching, liveLabel, pausedLabel, refreshLabel, timingLabel, onToggleAutoRefresh, onRefresh }: {
  autoRefresh: boolean;
  isFetching?: boolean;
  liveLabel: ReactNode;
  pausedLabel: ReactNode;
  refreshLabel: ReactNode;
  timingLabel?: ReactNode;
  onToggleAutoRefresh: () => void;
  onRefresh: () => void;
}) {
  const [delayedFetching, setDelayedFetching] = useState(false);
  const [manualFeedback, setManualFeedback] = useState(false);
  const debounceRef = useRef<number | null>(null);
  const feedbackRef = useRef<number | null>(null);
  useEffect(() => {
    if (isFetching) debounceRef.current = window.setTimeout(() => setDelayedFetching(true), LOADING_DELAY_MS);
    else {
      if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
      setDelayedFetching(false);
    }
    return () => { if (debounceRef.current != null) window.clearTimeout(debounceRef.current); };
  }, [isFetching]);
  useEffect(() => () => { if (feedbackRef.current != null) window.clearTimeout(feedbackRef.current); }, []);
  const handleRefresh = () => {
    setManualFeedback(true);
    if (feedbackRef.current != null) window.clearTimeout(feedbackRef.current);
    feedbackRef.current = window.setTimeout(() => setManualFeedback(false), MANUAL_FEEDBACK_MS);
    onRefresh();
  };
  const activeLabel = autoRefresh ? liveLabel : pausedLabel;
  return <div className={styles.refreshCluster}>
    <button type="button" className={`${styles.refreshToggle} ${autoRefresh ? styles.live : ""}`} onClick={onToggleAutoRefresh} aria-pressed={autoRefresh} aria-label={String(activeLabel)}><i />{activeLabel}</button>
    <Tooltip content={refreshLabel}><Button aria-label={String(refreshLabel)} icon={<IconRefresh />} type="tertiary" theme="borderless" loading={delayedFetching || manualFeedback} onClick={handleRefresh} /></Tooltip>
    {timingLabel ? <span className={styles.refreshTiming} aria-live="polite">{timingLabel}</span> : null}
  </div>;
}

export function DesktopSearchFieldView({ value, placeholder, ariaLabel, width, onChange }: { value: string; placeholder: string; ariaLabel?: string; width?: number; onChange: (value: string) => void }) {
  return <Input className={styles.searchField} style={width ? { width } : undefined} prefix={<IconSearch />} value={value} placeholder={placeholder} aria-label={ariaLabel} showClear onChange={onChange} />;
}

function DesktopFilterSelectView({ select, onChange }: { select: DesktopFilterSelectModel; onChange?: (key: string, value: string) => void }) {
  const labelId = useId();
  return <>
    {!select.insetLabel ? <span id={labelId} className={styles.srLabel}>{select.ariaLabel}</span> : null}
    <Select
      style={{ width: select.width ?? 142 }}
      insetLabel={select.insetLabel}
      value={select.value}
      loading={select.loading}
      aria-labelledby={!select.insetLabel ? labelId : undefined}
      insetLabelId={select.insetLabel ? labelId : undefined}
      optionList={select.options.map((option) => ({
        value: option.value,
        label: option.internalLabel ?? option.label,
        disabled: option.disabled,
      }))}
      onSelect={(value) => onChange?.(select.key, String(value))}
    />
  </>;
}

export function DesktopFilterToolbarView({ ariaLabel, search, selects = [], segments, actions, onSearchChange, onSelectChange, onSegmentChange }: {
  ariaLabel: string;
  search?: { value: string; placeholder: string; ariaLabel?: string; width?: number };
  selects?: DesktopFilterSelectModel[];
  segments?: { value: string; options: DesktopSegmentOption[]; ariaLabel: string };
  actions?: ReactNode;
  onSearchChange?: (value: string) => void;
  onSelectChange?: (key: string, value: string) => void;
  onSegmentChange?: (value: string) => void;
}) {
  return <section className={styles.filterToolbar} aria-label={ariaLabel}>
    {search ? <DesktopSearchFieldView {...search} onChange={(value) => onSearchChange?.(value)} /> : null}
    {selects.map((select) => <DesktopFilterSelectView key={select.key} select={select} onChange={onSelectChange} />)}
    {segments ? <div className={styles.segmented} aria-label={segments.ariaLabel}>{segments.options.map((option) => <button key={option.value} type="button" aria-pressed={segments.value === option.value} onClick={() => onSegmentChange?.(option.value)}>{option.label}</button>)}</div> : null}
    {actions ? <><span className={styles.toolbarSpacer} /><div className={styles.toolbarActions}>{actions}</div></> : null}
  </section>;
}

export function DesktopTimeScopeView({ children }: { children: ReactNode }) { return <div className={styles.timeScope}>{children}</div>; }

export function DesktopCalendarRangeControlView({ label, panel, open, previousLabel, nextLabel, triggerLabel, previousDisabled, nextDisabled, onOpenChange, onPrevious, onNext }: {
  label: ReactNode; panel: ReactNode; open: boolean; previousLabel: string; nextLabel: string; triggerLabel: string;
  previousDisabled?: boolean; nextDisabled?: boolean; onOpenChange: (open: boolean) => void; onPrevious: () => void; onNext: () => void;
}) {
  return <div className={styles.calendarRange}>
    <Button className={styles.navButton} theme="borderless" size="small" icon={<IconChevronLeft />} aria-label={previousLabel} disabled={previousDisabled} onClick={onPrevious} />
    <Popover trigger="custom" visible={open} onVisibleChange={onOpenChange} onClickOutSide={() => onOpenChange(false)} position="bottomRight" showArrow={false} content={panel} contentClassName={styles.rangePopover}>
      <button type="button" className={styles.rangeTrigger} aria-label={triggerLabel} aria-expanded={open} onClick={() => onOpenChange(!open)}><IconCalendar /><span>{label}</span><IconChevronDown /></button>
    </Popover>
    <Button className={styles.navButton} theme="borderless" size="small" icon={<IconChevronRight />} aria-label={nextLabel} disabled={nextDisabled} onClick={onNext} />
  </div>;
}

export function DesktopCalendarRangePanelView({ title, allLabel, allSelected, quickLabel, presets, customAction, onSelectAll, onSelect }: {
  title: ReactNode; allLabel: ReactNode; allSelected: boolean; quickLabel: ReactNode;
  presets: Array<{ key: string; label: ReactNode; selected?: boolean }>; customAction?: ReactNode;
  onSelectAll: () => void; onSelect: (key: string) => void;
}) {
  return <div className={styles.rangePanel}>
    <header className={styles.rangePanelHeader}><strong>{title}</strong><button type="button" aria-pressed={allSelected} onClick={onSelectAll}>{allLabel}</button></header>
    <div className={styles.quickRangeSection}><span>{quickLabel}</span><div className={styles.quickRangeGrid}>{presets.map((preset) => <button key={preset.key} type="button" aria-pressed={preset.selected} onClick={() => onSelect(preset.key)}>{preset.label}</button>)}</div></div>
    {customAction ? <div className={styles.customRangeSection}>{customAction}</div> : null}
  </div>;
}

export function DesktopCustomRangeActionView({ label }: { label: ReactNode }) {
  return <button type="button" className={styles.customRangeButton}><IconCalendar /><span>{label}</span><IconChevronRight /></button>;
}

export function DesktopTimePresetSelectView({ value, options, ariaLabel, onChange }: { value: string; options: DesktopSelectOption[]; ariaLabel: string; onChange: (value: string) => void }) {
  const labelId = useId();
  return <span className={styles.presetSelectWrap}><span id={labelId} className={styles.srLabel}>{ariaLabel}</span><Select className={styles.presetSelect} size="small" value={value} optionList={options} onChange={(next) => onChange(String(next))} aria-labelledby={labelId} /></span>;
}

export function DesktopTimePeriodSwitchView({ value, options, ariaLabel, onChange }: { value: string; options: DesktopSegmentOption[]; ariaLabel: string; onChange: (value: string) => void }) {
  return <div className={styles.periodSwitch} aria-label={ariaLabel}>{options.map((option) => <button key={option.value} type="button" aria-pressed={value === option.value} onClick={() => onChange(option.value)}>{option.label}</button>)}</div>;
}

export function DesktopTimeRangeNavigatorView({ label, previousLabel, nextLabel, nextDisabled, onPrevious, onNext }: { label: ReactNode; previousLabel: string; nextLabel: string; nextDisabled?: boolean; onPrevious: () => void; onNext: () => void }) {
  return <div className={styles.navigator}><Button theme="borderless" size="small" icon={<IconChevronLeft />} aria-label={previousLabel} onClick={onPrevious} /><strong>{label}</strong><Button theme="borderless" size="small" icon={<IconChevronRight />} aria-label={nextLabel} disabled={nextDisabled} onClick={onNext} /></div>;
}

export function DesktopDeviceTitlePickerView({ title, selectedValue, selectedLabel, allLabel, options, ariaLabel, onChange, allowAll = true }: { title: ReactNode; selectedValue: string | null; selectedLabel?: ReactNode; allLabel: ReactNode; options: DesktopDeviceOption[]; ariaLabel: string; onChange: (value: string | null) => void; allowAll?: boolean }) {
  return <Dropdown position="bottomLeft" trigger="click" clickToHide render={<Dropdown.Menu>{allowAll ? <Dropdown.Item active={selectedValue == null} onClick={() => onChange(null)}>{allLabel}</Dropdown.Item> : null}{options.map((option) => <Dropdown.Item key={option.value} active={option.value === selectedValue} onClick={() => onChange(option.value)}>{option.label}</Dropdown.Item>)}</Dropdown.Menu>}>
    <button type="button" className={styles.deviceTrigger} aria-label={ariaLabel}><span>{selectedValue != null && selectedLabel ? <>{selectedLabel} · {title}</> : title}</span><IconChevronDown /></button>
  </Dropdown>;
}
