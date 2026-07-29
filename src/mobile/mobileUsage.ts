import type { DailyUsageTotal, HourlyUsageTotal } from "../domains/device-sync/types";

export type MobileUsagePeriod = "week" | "month";

export type MobileUsageRange = {
  start: Date;
  end: Date;
  startDate: string;
  endDate: string;
};

export type MobileUsageHeatmapCell = {
  date: string;
  tokens: number;
  requests: number;
  level: 0 | 1 | 2 | 3 | 4;
  outside: boolean;
  hasData: boolean;
};

export type MobileUsageHeatmap = {
  cells: MobileUsageHeatmapCell[];
  columns: 7;
};

export type MobileHourlyHeatmapCell = {
  hour: string;
  date: string;
  hourOfDay: number;
  tokens: number;
  requests: number;
  level: 0 | 1 | 2 | 3 | 4;
  outside: boolean;
  hasData: boolean;
};

export function getMobileUsageRange(
  period: MobileUsagePeriod,
  offset = 0,
  now = new Date(),
): MobileUsageRange {
  const today = startOfLocalDay(now);
  const start = period === "week"
    ? addLocalDays(today, -mondayIndex(today) + offset * 7)
    : new Date(today.getFullYear(), today.getMonth() + offset, 1);
  const end = period === "week"
    ? addLocalDays(start, 6)
    : new Date(start.getFullYear(), start.getMonth() + 1, 0);
  return { start, end, startDate: localDate(start), endDate: localDate(end) };
}

export function filterMobileUsage(
  days: DailyUsageTotal[],
  period: MobileUsagePeriod,
  offset = 0,
  now = new Date(),
) {
  const range = getMobileUsageRange(period, offset, now);
  return days.filter((day) => day.date >= range.startDate && day.date <= range.endDate);
}

export function summarizeMobileUsage(days: DailyUsageTotal[]) {
  return days.reduce((summary, day) => ({
    requests: summary.requests + day.requestCount,
    tokens: summary.tokens + day.knownTokens,
    inputTokens: summary.inputTokens + day.inputTokens,
    cachedInputTokens: summary.cachedInputTokens + day.inputCachedTokens,
    outputTokens: summary.outputTokens + day.outputTokens,
  }), { requests: 0, tokens: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });
}

export function buildMobileUsageHeatmap(
  days: DailyUsageTotal[],
  period: MobileUsagePeriod,
  offset = 0,
  now = new Date(),
): MobileUsageHeatmap {
  const today = startOfLocalDay(now);
  const range = getMobileUsageRange(period, offset, today);
  const filtered = filterMobileUsage(days, period, offset, today);
  const gridStart = addLocalDays(range.start, -mondayIndex(range.start));
  const gridEnd = addLocalDays(range.end, 6 - mondayIndex(range.end));
  const values = new Map(filtered.map((day) => [day.date, day]));
  const max = Math.max(0, ...filtered.map((day) => day.knownTokens));
  const cells: MobileUsageHeatmapCell[] = [];

  for (let cursor = gridStart; cursor <= gridEnd; cursor = addLocalDays(cursor, 1)) {
    const date = localDate(cursor);
    const day = values.get(date);
    const outsideRange = cursor < range.start || cursor > range.end;
    const future = offset === 0 && cursor > today;
    const outside = outsideRange || future;
    const tokens = outside ? 0 : day?.knownTokens ?? 0;
    cells.push({
      date,
      tokens,
      requests: outside ? 0 : day?.requestCount ?? 0,
      level: heatLevel(tokens, max),
      outside,
      hasData: !outside && day !== undefined,
    });
  }

  return { cells, columns: 7 };
}

export function buildMobileWeeklyHourlyHeatmap(
  hours: HourlyUsageTotal[],
  offset = 0,
  now = new Date(),
) {
  const currentHour = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    now.getHours(),
  );
  const range = getMobileUsageRange("week", offset, currentHour);
  const values = new Map(hours.map((item) => [item.hour, item]));
  const inRange = hours.filter((item) => {
    const date = item.hour.slice(0, 10);
    return date >= range.startDate && date <= range.endDate;
  });
  const max = Math.max(0, ...inRange.map((item) => item.knownTokens));
  const cells: MobileHourlyHeatmapCell[] = [];

  for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
    const date = localDate(addLocalDays(range.start, dayIndex));
    for (let hourOfDay = 0; hourOfDay < 24; hourOfDay += 1) {
      const hour = `${date}T${String(hourOfDay).padStart(2, "0")}:00:00`;
      const item = values.get(hour);
      const future = offset === 0 && new Date(
        range.start.getFullYear(),
        range.start.getMonth(),
        range.start.getDate() + dayIndex,
        hourOfDay,
      ) > currentHour;
      const tokens = future ? 0 : item?.knownTokens ?? 0;
      cells.push({
        hour,
        date,
        hourOfDay,
        tokens,
        requests: future ? 0 : item?.requestCount ?? 0,
        level: heatLevel(tokens, max),
        outside: future,
        hasData: !future && item !== undefined,
      });
    }
  }

  return { cells };
}

export function formatMobileUsageRange(
  range: MobileUsageRange,
  period: MobileUsagePeriod,
  language: string,
) {
  if (period === "month") {
    return range.start.toLocaleDateString(language, { year: "numeric", month: "long" });
  }
  const start = range.start.toLocaleDateString(language, { month: "short", day: "numeric" });
  const end = range.end.toLocaleDateString(language, {
    year: range.start.getFullYear() === range.end.getFullYear() ? undefined : "numeric",
    month: "short",
    day: "numeric",
  });
  return `${start} – ${end}`;
}

function heatLevel(value: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (value <= 0 || max <= 0) return 0;
  return Math.max(1, Math.min(4, Math.ceil(Math.log1p(value) / Math.log1p(max) * 4))) as 1 | 2 | 3 | 4;
}

function startOfLocalDay(value: Date) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function addLocalDays(value: Date, days: number) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate() + days);
}

function mondayIndex(value: Date) {
  return (value.getDay() + 6) % 7;
}

function localDate(value: Date) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
