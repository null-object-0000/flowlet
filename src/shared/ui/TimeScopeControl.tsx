import { useState, type ReactNode } from "react";
import { DatePicker } from "@douyinfe/semi-ui-19";
import { DesktopCalendarRangeControlView, DesktopCalendarRangePanelView, DesktopCustomRangeActionView, DesktopTimePeriodSwitchView, DesktopTimePresetSelectView, DesktopTimeRangeNavigatorView, DesktopTimeScopeView } from "@flowlet/product-ui";
import {
  dayRange,
  formatTimeRangeLabel,
  inclusiveLocalDates,
  isRangeAfterToday,
  monthRange,
  rangeFromLocalDates,
  recentDaysRange,
  shiftCalendarRange,
  weekRange,
  type TimeRangeValue,
} from "../timeRange";

type Translate = (source: string, variables?: Record<string, string | number>) => string;

export function TimeScopeControl({ children }: { children: ReactNode }) {
  return <DesktopTimeScopeView>{children}</DesktopTimeScopeView>;
}

export function TimePresetSelect<T extends string>({ value, options, onChange, ariaLabel }: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  return <DesktopTimePresetSelectView value={value} options={options} ariaLabel={ariaLabel} onChange={(next) => onChange(next as T)} />;
}

export function CalendarTimeRangeControl({ value, onChange, language, t, now = new Date() }: {
  value: TimeRangeValue;
  onChange: (value: TimeRangeValue) => void;
  language: "zh-CN" | "en-US";
  t: Translate;
  now?: Date;
}) {
  const [panelOpen, setPanelOpen] = useState(false);
  const selectedDates = inclusiveLocalDates(value);
  const presets: Array<{ label: string; range: TimeRangeValue }> = [
    { label: t("今日"), range: dayRange(0, now) },
    { label: t("昨日"), range: dayRange(-1, now) },
    { label: t("本周"), range: weekRange(0, now) },
    { label: t("上周"), range: weekRange(-1, now) },
    { label: t("本月"), range: monthRange(0, now) },
    { label: t("上月"), range: monthRange(-1, now) },
    { label: t("最近 7 天"), range: recentDaysRange(7, now) },
    { label: t("最近 30 天"), range: recentDaysRange(30, now) },
  ];
  const applyRange = (next: TimeRangeValue) => {
    onChange(next);
    setPanelOpen(false);
  };

  const panel = <DesktopCalendarRangePanelView
    title={t("时间范围")}
    allLabel={t("全部时间")}
    allSelected={!selectedDates}
    quickLabel={t("快捷选择")}
    presets={presets.map((item) => ({ key: item.label, label: item.label, selected: sameRange(item.range, value) }))}
    onSelectAll={() => applyRange({ startAt: null, endAt: null })}
    onSelect={(key) => { const preset = presets.find((item) => item.label === key); if (preset) applyRange(preset.range); }}
    customAction={
        <DatePicker
          type="dateRange"
          density="compact"
          value={selectedDates ?? undefined}
          weekStartsOn={1}
          showClear={false}
          disabledDate={(date) => Boolean(date && date > endOfToday(now))}
          onChangeWithDateFirst
          onChange={(dates, alternateDates) => {
            const nextDates = extractDateRange(dates, alternateDates);
            if (!nextDates) return;
            applyRange(rangeFromLocalDates(nextDates[0], nextDates[1]));
          }}
          triggerRender={() => (
            <DesktopCustomRangeActionView label={t("自定义日期")} />
          )}
        />
    }
  />;

  return <DesktopCalendarRangeControlView label={formatTimeRangeLabel(value, language, now)} panel={panel} open={panelOpen} previousLabel={t("上一个时间范围")} nextLabel={t("下一个时间范围")} triggerLabel={t("选择时间范围")} previousDisabled={!selectedDates} nextDisabled={!selectedDates || isRangeAfterToday(value, now)} onOpenChange={setPanelOpen} onPrevious={() => onChange(shiftCalendarRange(value, -1))} onNext={() => onChange(shiftCalendarRange(value, 1))} />;
}

export function TimePeriodSwitch<T extends string>({ value, options, onChange, ariaLabel }: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  return <DesktopTimePeriodSwitchView value={value} options={options} ariaLabel={ariaLabel} onChange={(next) => onChange(next as T)} />;
}

export function TimeRangeNavigator({ label, previousLabel, nextLabel, onPrevious, onNext, nextDisabled = false }: {
  label: string;
  previousLabel: string;
  nextLabel: string;
  onPrevious: () => void;
  onNext: () => void;
  nextDisabled?: boolean;
}) {
  return <DesktopTimeRangeNavigatorView label={label} previousLabel={previousLabel} nextLabel={nextLabel} nextDisabled={nextDisabled} onPrevious={onPrevious} onNext={onNext} />;
}

function endOfToday(now: Date) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
}

function sameRange(left: TimeRangeValue, right: TimeRangeValue) {
  return left.startAt === right.startAt && left.endAt === right.endAt;
}

function extractDateRange(primary: unknown, alternate: unknown): [Date, Date] | null {
  for (const candidate of [primary, alternate]) {
    if (!Array.isArray(candidate) || candidate.length !== 2) continue;
    const dates = candidate.map((entry) => entry instanceof Date ? entry : new Date(String(entry)));
    if (dates.every((date) => !Number.isNaN(date.getTime()))) return dates as [Date, Date];
  }
  return null;
}
