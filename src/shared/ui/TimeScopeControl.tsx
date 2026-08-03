import { useId, useState, type ReactNode } from "react";
import { Button, DatePicker, Popover, Select } from "@douyinfe/semi-ui-19";
import { IconCalendar, IconChevronDown, IconChevronLeft, IconChevronRight } from "@douyinfe/semi-icons";
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
import styles from "./TimeScopeControl.module.css";

type Translate = (source: string, variables?: Record<string, string | number>) => string;

export function TimeScopeControl({ children }: { children: ReactNode }) {
  return <div className={styles.scope}>{children}</div>;
}

export function TimePresetSelect<T extends string>({ value, options, onChange, ariaLabel }: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  const labelId = useId();
  return (
    <span className={styles.presetSelectWrap}>
      <span id={labelId} className={styles.srLabel}>{ariaLabel}</span>
      <Select
        className={styles.presetSelect}
        size="small"
        value={value}
        optionList={options}
        onChange={(next) => onChange(next as T)}
        aria-labelledby={labelId}
      />
    </span>
  );
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

  const panel = (
    <div className={styles.rangePanel}>
      <header className={styles.rangePanelHeader}>
        <strong>{t("时间范围")}</strong>
        <button
          type="button"
          aria-pressed={!selectedDates}
          onClick={() => applyRange({ startAt: null, endAt: null })}
        >
          {t("全部时间")}
        </button>
      </header>
      <div className={styles.quickRangeSection}>
        <span>{t("快捷选择")}</span>
        <div className={styles.quickRangeGrid}>
          {presets.map((item) => (
            <button
              key={item.label}
              type="button"
              aria-pressed={sameRange(item.range, value)}
              onClick={() => applyRange(item.range)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
      <div className={styles.customRangeSection}>
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
            <button type="button" className={styles.customRangeButton}>
              <IconCalendar />
              <span>{t("自定义日期")}</span>
              <IconChevronRight />
            </button>
          )}
        />
      </div>
    </div>
  );

  return (
    <div className={styles.calendarRange}>
      <Button
        className={styles.navButton}
        theme="borderless"
        size="small"
        icon={<IconChevronLeft />}
        aria-label={t("上一个时间范围")}
        disabled={!selectedDates}
        onClick={() => onChange(shiftCalendarRange(value, -1))}
      />
      <Popover
        trigger="custom"
        visible={panelOpen}
        onVisibleChange={setPanelOpen}
        onClickOutSide={() => setPanelOpen(false)}
        position="bottomRight"
        showArrow={false}
        content={panel}
        contentClassName={styles.rangePopover}
      >
        <button
          type="button"
          className={styles.rangeTrigger}
          aria-label={t("选择时间范围")}
          aria-expanded={panelOpen}
          onClick={() => setPanelOpen((open) => !open)}
        >
          <IconCalendar />
          <span>{formatTimeRangeLabel(value, language, now)}</span>
          <IconChevronDown />
        </button>
      </Popover>
      <Button
        className={styles.navButton}
        theme="borderless"
        size="small"
        icon={<IconChevronRight />}
        aria-label={t("下一个时间范围")}
        disabled={!selectedDates || isRangeAfterToday(value, now)}
        onClick={() => onChange(shiftCalendarRange(value, 1))}
      />
    </div>
  );
}

export function TimePeriodSwitch<T extends string>({ value, options, onChange, ariaLabel }: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  return (
    <div className={styles.periodSwitch} aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function TimeRangeNavigator({ label, previousLabel, nextLabel, onPrevious, onNext, nextDisabled = false }: {
  label: string;
  previousLabel: string;
  nextLabel: string;
  onPrevious: () => void;
  onNext: () => void;
  nextDisabled?: boolean;
}) {
  return (
    <div className={styles.navigator}>
      <Button theme="borderless" size="small" icon={<IconChevronLeft />} aria-label={previousLabel} onClick={onPrevious} />
      <strong>{label}</strong>
      <Button theme="borderless" size="small" icon={<IconChevronRight />} aria-label={nextLabel} disabled={nextDisabled} onClick={onNext} />
    </div>
  );
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
