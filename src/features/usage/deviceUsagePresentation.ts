import type { DailyUsageTotal, HourlyUsageTotal } from "../../domains/device-sync/types";
import { createHeatLevelScale, type HeatLevel } from "../../shared/visualization/heatmapLevels";

export type MobileUsagePeriod = "week" | "month";

export type MobileUsageRange = {
  start: Date;
  end: Date;
  startDate: string;
  endDate: string;
};

export type MobileUsageHeatmapCell = {
  date: string;
  /** 合计 Token（Flowlet 代理 + Agent 原生），用于色阶与展示。 */
  tokens: number;
  /** 合计次数（代理请求 + 原生交互）。 */
  requests: number;
  /** 其中 Agent 原生部分（未经过 Flowlet）。 */
  nativeTokens: number;
  nativeEvents: number;
  level: HeatLevel;
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
  hourEnd: number;
  tokens: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheMeasuredInputTokens: number;
  estimatedCost: number;
  nativeTokens: number;
  nativeEvents: number;
  unknownRequests: number;
  level: HeatLevel;
  outside: boolean;
  hasData: boolean;
};

export const MOBILE_WEEKLY_HEATMAP_BUCKET_HOURS = 3;

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
  const summary = days.reduce((total, day) => ({
    requests: total.requests + day.requestCount,
    tokens: total.tokens + day.knownTokens,
    inputTokens: total.inputTokens + day.inputTokens,
    cachedInputTokens: total.cachedInputTokens + day.inputCachedTokens,
    cacheMeasuredInputTokens: total.cacheMeasuredInputTokens + day.cacheMeasuredInputTokens,
    outputTokens: total.outputTokens + day.outputTokens,
    estimatedCost: total.estimatedCost + (day.estimatedCost ?? 0),
    nativeEvents: total.nativeEvents + (day.nativeEventCount ?? 0),
    nativeTokens: total.nativeTokens + (day.nativeTotalTokens ?? 0),
    nativeInputTokens: total.nativeInputTokens + (day.nativeInputTokens ?? 0),
    nativeOutputTokens: total.nativeOutputTokens + (day.nativeOutputTokens ?? 0),
  }), {
    requests: 0,
    tokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheMeasuredInputTokens: 0,
    outputTokens: 0,
    estimatedCost: 0,
    nativeEvents: 0,
    nativeTokens: 0,
    nativeInputTokens: 0,
    nativeOutputTokens: 0,
  });
  return {
    ...summary,
    cacheHitRate: summary.cacheMeasuredInputTokens > 0
      ? Math.max(0, Math.min(1, summary.cachedInputTokens / summary.cacheMeasuredInputTokens))
      : null,
  };
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
  const cells: MobileUsageHeatmapCell[] = [];

  for (let cursor = gridStart; cursor <= gridEnd; cursor = addLocalDays(cursor, 1)) {
    const date = localDate(cursor);
    const day = values.get(date);
    const outsideRange = cursor < range.start || cursor > range.end;
    const future = offset === 0 && cursor > today;
    const outside = outsideRange || future;
    const tokens = outside ? 0 : (day?.knownTokens ?? 0) + (day?.nativeTotalTokens ?? 0);
    cells.push({
      date,
      tokens,
      requests: outside ? 0 : (day?.requestCount ?? 0) + (day?.nativeEventCount ?? 0),
      nativeTokens: outside ? 0 : day?.nativeTotalTokens ?? 0,
      nativeEvents: outside ? 0 : day?.nativeEventCount ?? 0,
      level: 0,
      outside,
      hasData: !outside && day !== undefined,
    });
  }

  const scale = createHeatLevelScale(
    cells.filter((cell) => !cell.outside).map((cell) => cell.tokens),
  );
  return {
    cells: cells.map((cell) => ({ ...cell, level: scale.levelFor(cell.tokens) })),
    columns: 7,
  };
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
  const cells: Omit<MobileHourlyHeatmapCell, "level">[] = [];

  for (
    let hourOfDay = 0;
    hourOfDay < 24;
    hourOfDay += MOBILE_WEEKLY_HEATMAP_BUCKET_HOURS
  ) {
    for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
      const date = localDate(addLocalDays(range.start, dayIndex));
      const hour = `${date}T${String(hourOfDay).padStart(2, "0")}:00:00`;
      const bucketStart = new Date(
        range.start.getFullYear(),
        range.start.getMonth(),
        range.start.getDate() + dayIndex,
        hourOfDay,
      );
      const future = offset === 0 && bucketStart > currentHour;
      let tokens = 0;
      let requests = 0;
      let inputTokens = 0;
      let outputTokens = 0;
      let cachedInputTokens = 0;
      let cacheMeasuredInputTokens = 0;
      let estimatedCost = 0;
      let nativeTokens = 0;
      let nativeEvents = 0;
      let unknownRequests = 0;
      let hasData = false;

      if (!future) {
        for (
          let bucketHour = hourOfDay;
          bucketHour < hourOfDay + MOBILE_WEEKLY_HEATMAP_BUCKET_HOURS;
          bucketHour += 1
        ) {
          const itemHour = `${date}T${String(bucketHour).padStart(2, "0")}:00:00`;
          const itemDate = new Date(
            range.start.getFullYear(),
            range.start.getMonth(),
            range.start.getDate() + dayIndex,
            bucketHour,
          );
          if (offset === 0 && itemDate > currentHour) continue;
          const item = values.get(itemHour);
          if (!item) continue;
          tokens += item.knownTokens + (item.nativeTotalTokens ?? 0);
          requests += item.requestCount + (item.nativeEventCount ?? 0);
          inputTokens += (item.inputTokens ?? 0) + (item.nativeInputTokens ?? 0);
          outputTokens += (item.outputTokens ?? 0) + (item.nativeOutputTokens ?? 0);
          cachedInputTokens += item.inputCachedTokens ?? 0;
          cacheMeasuredInputTokens += item.cacheMeasuredInputTokens ?? 0;
          estimatedCost += item.estimatedCost ?? 0;
          nativeTokens += item.nativeTotalTokens ?? 0;
          nativeEvents += item.nativeEventCount ?? 0;
          unknownRequests += item.unknownCount ?? 0;
          hasData = true;
        }
      }

      cells.push({
        hour,
        date,
        hourOfDay,
        hourEnd: hourOfDay + MOBILE_WEEKLY_HEATMAP_BUCKET_HOURS,
        tokens,
        requests,
        inputTokens,
        outputTokens,
        cachedInputTokens,
        cacheMeasuredInputTokens,
        estimatedCost,
        nativeTokens,
        nativeEvents,
        unknownRequests,
        outside: future,
        hasData,
      });
    }
  }

  const scale = createHeatLevelScale(
    cells.filter((cell) => !cell.outside).map((cell) => cell.tokens),
  );
  return {
    cells: cells.map((cell): MobileHourlyHeatmapCell => ({
      ...cell,
      level: scale.levelFor(cell.tokens),
    })),
  };
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
