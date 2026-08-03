export type TimeRangeValue = {
  /** UTC ISO timestamp, inclusive. Null together with endAt means all time. */
  startAt: string | null;
  /** UTC ISO timestamp, exclusive. Null together with startAt means all time. */
  endAt: string | null;
};

export type CalendarRangeKind = "day" | "week" | "month" | "custom" | "all";

export function dayRange(offset = 0, now = new Date()): TimeRangeValue {
  const start = localDayStart(now);
  start.setDate(start.getDate() + offset);
  return rangeFromLocalDates(start, start);
}

export function weekRange(offset = 0, now = new Date()): TimeRangeValue {
  const start = localDayStart(now);
  const daysFromMonday = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - daysFromMonday + offset * 7);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  return rangeFromLocalDates(start, end);
}

export function monthRange(offset = 0, now = new Date()): TimeRangeValue {
  const start = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const end = new Date(now.getFullYear(), now.getMonth() + offset + 1, 0);
  return rangeFromLocalDates(start, end);
}

export function recentDaysRange(days: number, now = new Date()): TimeRangeValue {
  const end = localDayStart(now);
  const start = new Date(end);
  start.setDate(start.getDate() - Math.max(1, days) + 1);
  return rangeFromLocalDates(start, end);
}

export function rangeFromLocalDates(startDate: Date, inclusiveEndDate: Date): TimeRangeValue {
  const start = localDayStart(startDate);
  const end = localDayStart(inclusiveEndDate);
  end.setDate(end.getDate() + 1);
  return { startAt: start.toISOString(), endAt: end.toISOString() };
}

export function inclusiveLocalDates(range: TimeRangeValue): [Date, Date] | null {
  if (!range.startAt || !range.endAt) return null;
  const start = new Date(range.startAt);
  const end = new Date(range.endAt);
  if (!isValidDate(start) || !isValidDate(end) || start >= end) return null;
  end.setDate(end.getDate() - 1);
  return [start, end];
}

export function calendarRangeKind(range: TimeRangeValue): CalendarRangeKind {
  const dates = inclusiveLocalDates(range);
  if (!dates) return "all";
  const [start, end] = dates;
  if (sameLocalDay(start, end)) return "day";
  const span = localDaySpan(start, end);
  if (span === 7 && start.getDay() === 1 && end.getDay() === 0) return "week";
  if (
    start.getDate() === 1
    && end.getDate() === new Date(end.getFullYear(), end.getMonth() + 1, 0).getDate()
    && start.getFullYear() === end.getFullYear()
    && start.getMonth() === end.getMonth()
  ) return "month";
  return "custom";
}

export function shiftCalendarRange(range: TimeRangeValue, direction: -1 | 1): TimeRangeValue {
  const dates = inclusiveLocalDates(range);
  if (!dates) return range;
  const [start, end] = dates;
  const kind = calendarRangeKind(range);
  if (kind === "month") {
    return monthRange(direction, start);
  }
  const span = localDaySpan(start, end);
  start.setDate(start.getDate() + span * direction);
  end.setDate(end.getDate() + span * direction);
  return rangeFromLocalDates(start, end);
}

export function isRangeAfterToday(range: TimeRangeValue, now = new Date()): boolean {
  const dates = inclusiveLocalDates(range);
  if (!dates) return true;
  return dates[1] >= localDayStart(now);
}

export function formatTimeRangeLabel(range: TimeRangeValue, language: "zh-CN" | "en-US", now = new Date()): string {
  const dates = inclusiveLocalDates(range);
  if (!dates) return language === "zh-CN" ? "全部时间" : "All time";
  const [start, end] = dates;
  const known = knownRangeLabel(range, language, now);
  const dateFormatter = new Intl.DateTimeFormat(language, {
    year: start.getFullYear() === now.getFullYear() ? undefined : "numeric",
    month: "numeric",
    day: "numeric",
  });
  const rangeLabel = sameLocalDay(start, end)
    ? dateFormatter.format(start)
    : `${dateFormatter.format(start)}–${dateFormatter.format(end)}`;
  return known ? `${known} · ${rangeLabel}` : rangeLabel;
}

function knownRangeLabel(range: TimeRangeValue, language: "zh-CN" | "en-US", now: Date): string | null {
  const candidates: Array<[TimeRangeValue, string, string]> = [
    [dayRange(0, now), "今日", "Today"],
    [dayRange(-1, now), "昨日", "Yesterday"],
    [weekRange(0, now), "本周", "This week"],
    [weekRange(-1, now), "上周", "Last week"],
    [monthRange(0, now), "本月", "This month"],
    [monthRange(-1, now), "上月", "Last month"],
  ];
  const match = candidates.find(([candidate]) => sameRange(candidate, range));
  return match ? (language === "zh-CN" ? match[1] : match[2]) : null;
}

function sameRange(left: TimeRangeValue, right: TimeRangeValue) {
  return left.startAt === right.startAt && left.endAt === right.endAt;
}

function localDayStart(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function sameLocalDay(left: Date, right: Date) {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

function localDaySpan(start: Date, end: Date) {
  const utcStart = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
  const utcEnd = Date.UTC(end.getFullYear(), end.getMonth(), end.getDate());
  return Math.round((utcEnd - utcStart) / 86_400_000) + 1;
}

function isValidDate(date: Date) {
  return !Number.isNaN(date.getTime());
}
