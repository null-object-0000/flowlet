import type { DailyUsageTotal, HourlyUsageTotal } from "../../domains/device-sync/types";
import { createHeatLevelScale, type HeatLevel } from "../../shared/visualization/heatmapLevels";

export type UsagePeriod = "day" | "week" | "month";

/** 用量统计的默认统计维度。 */
export const DEFAULT_USAGE_PERIOD: UsagePeriod = "week";
export type UsageHeatmapMetric = "tokens" | "cost";

export type UsageRange = {
  start: Date;
  end: Date;
  startDate: string;
  endDate: string;
};

export type UsageHeatmapCell = {
  date: string;
  /** 合计 Token（Flowlet 代理 + Agent 原生），用于色阶与展示。 */
  tokens: number;
  /** 合计次数（代理请求 + 原生交互）。 */
  requests: number;
  /** 其中 Agent 原生部分（未经过 Flowlet）。 */
  nativeTokens: number;
  nativeEvents: number;
  /** Flowlet 可统计请求的预估费用；Agent 原生用量暂不计价。 */
  estimatedCost: number;
  level: HeatLevel;
  /** 是否为月视图首尾补位的相邻月份日期。 */
  adjacentMonth: boolean;
  outside: boolean;
  future: boolean;
  hasData: boolean;
};

export type UsageHeatmap = {
  cells: UsageHeatmapCell[];
  columns: 7;
};

export type HourlyHeatmapCell = {
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
  nativeInputTokens: number;
  nativeCachedInputTokens: number;
  nativeCacheWriteInputTokens: number;
  nativeOutputTokens: number;
  nativeReasoningTokens: number;
  nativeEvents: number;
  unknownRequests: number;
  level: HeatLevel;
  outside: boolean;
  future: boolean;
  hasData: boolean;
};

export function getUsageRange(
  period: UsagePeriod,
  offset = 0,
  now = new Date(),
): UsageRange {
  const today = startOfLocalDay(now);
  const start = period === "day"
    ? addLocalDays(today, offset)
    : period === "week"
      ? addLocalDays(today, -mondayIndex(today) + offset * 7)
      : new Date(today.getFullYear(), today.getMonth() + offset, 1);
  const end = period === "day"
    ? start
    : period === "week"
      ? addLocalDays(start, 6)
      : new Date(start.getFullYear(), start.getMonth() + 1, 0);
  return { start, end, startDate: localDate(start), endDate: localDate(end) };
}

export function filterUsage(
  days: DailyUsageTotal[],
  period: UsagePeriod,
  offset = 0,
  now = new Date(),
) {
  const range = getUsageRange(period, offset, now);
  return days.filter((day) => day.date >= range.startDate && day.date <= range.endDate);
}

export function summarizeUsage(days: DailyUsageTotal[]) {
  const summary = days.reduce((total, day) => ({
    requests: total.requests + day.requestCount,
    tokens: total.tokens + day.knownTokens,
    inputTokens: total.inputTokens + day.inputTokens,
    cachedInputTokens: total.cachedInputTokens + day.inputCachedTokens,
    uncachedInputTokens: total.uncachedInputTokens + day.inputUncachedTokens,
    cacheMeasuredInputTokens: total.cacheMeasuredInputTokens + day.cacheMeasuredInputTokens,
    outputTokens: total.outputTokens + day.outputTokens,
    estimatedCost: total.estimatedCost + (day.estimatedCost ?? 0),
    nativeEvents: total.nativeEvents + (day.nativeEventCount ?? 0),
    nativeTokens: total.nativeTokens + (day.nativeTotalTokens ?? 0),
    nativeInputTokens: total.nativeInputTokens + (day.nativeInputTokens ?? 0),
    nativeCachedInputTokens: total.nativeCachedInputTokens + (day.nativeCachedInputTokens ?? 0),
    nativeCacheWriteInputTokens: total.nativeCacheWriteInputTokens + (day.nativeCacheWriteInputTokens ?? 0),
    nativeOutputTokens: total.nativeOutputTokens + (day.nativeOutputTokens ?? 0),
    nativeReasoningTokens: total.nativeReasoningTokens + (day.nativeReasoningTokens ?? 0),
  }), {
    requests: 0,
    tokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    uncachedInputTokens: 0,
    cacheMeasuredInputTokens: 0,
    outputTokens: 0,
    estimatedCost: 0,
    nativeEvents: 0,
    nativeTokens: 0,
    nativeInputTokens: 0,
    nativeCachedInputTokens: 0,
    nativeCacheWriteInputTokens: 0,
    nativeOutputTokens: 0,
    nativeReasoningTokens: 0,
  });
  return {
    ...summary,
    cacheHitRate: summary.cacheMeasuredInputTokens > 0
      ? Math.max(0, Math.min(1, summary.cachedInputTokens / summary.cacheMeasuredInputTokens))
      : null,
  };
}

export function buildUsageHeatmap(
  days: DailyUsageTotal[],
  period: UsagePeriod,
  offset = 0,
  now = new Date(),
  metric: UsageHeatmapMetric = "tokens",
): UsageHeatmap {
  const today = startOfLocalDay(now);
  const range = getUsageRange(period, offset, today);
  const gridStart = addLocalDays(range.start, -mondayIndex(range.start));
  const gridEnd = period === "month"
    ? addLocalDays(gridStart, 41)
    : addLocalDays(range.end, 6 - mondayIndex(range.end));
  // 月视图的首尾补位日期也属于可见日历范围，应展示它们已有的真实数据；
  // 页面顶部汇总仍通过 filterUsage 严格限定在所选自然月。
  const values = new Map(days.map((day) => [day.date, day]));
  const cells: UsageHeatmapCell[] = [];

  for (let cursor = gridStart; cursor <= gridEnd; cursor = addLocalDays(cursor, 1)) {
    const date = localDate(cursor);
    const day = values.get(date);
    const outsideRange = cursor < range.start || cursor > range.end;
    const future = offset === 0 && cursor > today;
    const outside = outsideRange || future;
    const tokens = future ? 0 : (day?.knownTokens ?? 0) + (day?.nativeTotalTokens ?? 0);
    cells.push({
      date,
      tokens,
      requests: future ? 0 : (day?.requestCount ?? 0) + (day?.nativeEventCount ?? 0),
      nativeTokens: future ? 0 : day?.nativeTotalTokens ?? 0,
      nativeEvents: future ? 0 : day?.nativeEventCount ?? 0,
      estimatedCost: future ? 0 : day?.estimatedCost ?? 0,
      level: 0,
      adjacentMonth: period === "month" && outsideRange,
      outside,
      future,
      hasData: !future && day !== undefined,
    });
  }

  const scale = createHeatLevelScale(
    cells.filter((cell) => cell.hasData).map((cell) => metric === "tokens" ? cell.tokens : cell.estimatedCost),
  );
  return {
    cells: cells.map((cell) => ({
      ...cell,
      level: scale.levelFor(metric === "tokens" ? cell.tokens : cell.estimatedCost),
    })),
    columns: 7,
  };
}

export type UsageTokenDetailColumn = {
  total: number;
  input: number;
  cachedInput: number;
  cacheWriteInput: number | null;
  uncachedInput: number;
  output: number;
  reasoning: number | null;
  requests: number;
  unknownUsageCount: number;
  cacheHitRate: number | null;
};

export type UsageTokenDetails = {
  total: UsageTokenDetailColumn;
  flowlet: UsageTokenDetailColumn;
  native: UsageTokenDetailColumn;
};

export function buildUsageTokenDetails({
  proxyTotal,
  proxyInput,
  proxyCachedInput,
  proxyUncachedInput,
  proxyCacheMeasuredInput,
  proxyOutput,
  proxyRequests,
  proxyUnknownUsageCount,
  nativeTotal,
  nativeInput,
  nativeCachedInput,
  nativeCacheWriteInput,
  nativeOutput,
  nativeReasoning,
  nativeEvents,
}: {
  proxyTotal: number;
  proxyInput: number;
  proxyCachedInput: number;
  proxyUncachedInput: number;
  proxyCacheMeasuredInput: number;
  proxyOutput: number;
  proxyRequests: number;
  proxyUnknownUsageCount: number;
  nativeTotal: number;
  nativeInput: number;
  nativeCachedInput: number;
  nativeCacheWriteInput: number;
  nativeOutput: number;
  nativeReasoning: number;
  nativeEvents: number;
}): UsageTokenDetails {
  const nativeMeasuredInput = nativeInput + nativeCachedInput + nativeCacheWriteInput;
  const totalCachedInput = proxyCachedInput + nativeCachedInput;
  const totalMeasuredInput = proxyCacheMeasuredInput + nativeMeasuredInput;
  return {
    total: {
      total: proxyTotal + nativeTotal,
      input: proxyInput + nativeMeasuredInput,
      cachedInput: totalCachedInput,
      cacheWriteInput: null,
      uncachedInput: proxyUncachedInput + nativeInput,
      output: proxyOutput + nativeOutput,
      reasoning: null,
      requests: proxyRequests + nativeEvents,
      unknownUsageCount: proxyUnknownUsageCount,
      cacheHitRate: totalMeasuredInput > 0 ? totalCachedInput / totalMeasuredInput : null,
    },
    flowlet: {
      total: proxyTotal,
      input: proxyInput,
      cachedInput: proxyCachedInput,
      cacheWriteInput: null,
      uncachedInput: proxyUncachedInput,
      output: proxyOutput,
      reasoning: null,
      requests: proxyRequests,
      unknownUsageCount: proxyUnknownUsageCount,
      cacheHitRate: proxyCacheMeasuredInput > 0 ? proxyCachedInput / proxyCacheMeasuredInput : null,
    },
    native: {
      total: nativeTotal,
      input: nativeMeasuredInput,
      cachedInput: nativeCachedInput,
      cacheWriteInput: nativeCacheWriteInput,
      uncachedInput: nativeInput,
      output: nativeOutput,
      reasoning: nativeReasoning,
      requests: nativeEvents,
      unknownUsageCount: 0,
      cacheHitRate: nativeMeasuredInput > 0 ? nativeCachedInput / nativeMeasuredInput : null,
    },
  };
}

/** 选定自然日的 24 个逐小时格，供日视图和上下文视图复用。 */
export function buildDailyHourlyHeatmap(
  hours: HourlyUsageTotal[],
  offset = 0,
  now = new Date(),
  metric: UsageHeatmapMetric = "tokens",
) {
  const currentHour = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    now.getHours(),
  );
  const range = getUsageRange("day", offset, currentHour);
  const date = range.startDate;
  const values = new Map(hours.map((item) => [item.hour, item]));
  const cells: Omit<HourlyHeatmapCell, "level">[] = [];

  for (let hourOfDay = 0; hourOfDay < 24; hourOfDay += 1) {
    const hour = `${date}T${String(hourOfDay).padStart(2, "0")}:00:00`;
    const bucketStart = new Date(
      range.start.getFullYear(),
      range.start.getMonth(),
      range.start.getDate(),
      hourOfDay,
    );
    const future = bucketStart > currentHour;
    const item = future ? undefined : values.get(hour);
    const nativeInputTokens = item?.nativeInputTokens ?? 0;
    const nativeCachedInputTokens = item?.nativeCachedInputTokens ?? 0;
    const nativeCacheWriteInputTokens = item?.nativeCacheWriteInputTokens ?? 0;
    const nativeOutputTokens = item?.nativeOutputTokens ?? 0;
    const nativeReasoningTokens = item?.nativeReasoningTokens ?? 0;
    const nativeTokens = item?.nativeTotalTokens ?? 0;
    const nativeEvents = item?.nativeEventCount ?? 0;
    const nativeMeasuredInput = nativeInputTokens
      + nativeCachedInputTokens
      + nativeCacheWriteInputTokens;

    cells.push({
      hour,
      date,
      hourOfDay,
      hourEnd: hourOfDay + 1,
      tokens: (item?.knownTokens ?? 0) + nativeTokens,
      requests: (item?.requestCount ?? 0) + nativeEvents,
      inputTokens: (item?.inputTokens ?? 0) + nativeMeasuredInput,
      outputTokens: (item?.outputTokens ?? 0) + nativeOutputTokens,
      cachedInputTokens: (item?.inputCachedTokens ?? 0) + nativeCachedInputTokens,
      cacheMeasuredInputTokens: (item?.cacheMeasuredInputTokens ?? 0) + nativeMeasuredInput,
      estimatedCost: item?.estimatedCost ?? 0,
      nativeTokens,
      nativeInputTokens,
      nativeCachedInputTokens,
      nativeCacheWriteInputTokens,
      nativeOutputTokens,
      nativeReasoningTokens,
      nativeEvents,
      unknownRequests: item?.unknownCount ?? 0,
      outside: future,
      future,
      hasData: item !== undefined,
    });
  }

  const scale = createHeatLevelScale(
    cells.filter((cell) => cell.hasData).map((cell) => (
      metric === "tokens" ? cell.tokens : cell.estimatedCost
    )),
  );
  return {
    cells: cells.map((cell): HourlyHeatmapCell => ({
      ...cell,
      level: scale.levelFor(metric === "tokens" ? cell.tokens : cell.estimatedCost),
    })),
  };
}

/**
 * 桌面端日视图：前一日末 6 小时 + 选中日 24 小时 + 后一日首 6 小时。
 * 36 个格子共用同一热度色阶，保证跨零点上下文可以直接比较。
 */
export function buildDesktopDailyContextHeatmap(
  hours: HourlyUsageTotal[],
  offset = 0,
  now = new Date(),
  metric: UsageHeatmapMetric = "tokens",
) {
  const previous = buildDailyHourlyHeatmap(hours, offset - 1, now, metric).cells.slice(18);
  const current = buildDailyHourlyHeatmap(hours, offset, now, metric).cells;
  const next = buildDailyHourlyHeatmap(hours, offset + 1, now, metric).cells.slice(0, 6);
  const cells = [...previous, ...current, ...next];
  const scale = createHeatLevelScale(
    cells.filter((cell) => cell.hasData).map((cell) => (
      metric === "tokens" ? cell.tokens : cell.estimatedCost
    )),
  );
  return {
    cells: cells.map((cell): HourlyHeatmapCell => ({
      ...cell,
      level: scale.levelFor(metric === "tokens" ? cell.tokens : cell.estimatedCost),
    })),
  };
}

/**
 * PC 周视图热力图：选中自然周的 7×24 逐小时格子。
 * y 轴 7 个星期（0 = 周一）、x 轴 24 个小时（24 小时制），
 * 每个格子对应周内一个真实小时，可据此展开 Token 明细与请求日志。
 */
export function buildWeekdayHourHeatmap(
  hours: HourlyUsageTotal[],
  offset = 0,
  now = new Date(),
  metric: UsageHeatmapMetric = "tokens",
) {
  const currentHour = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    now.getHours(),
  );
  const range = getUsageRange("week", offset, currentHour);
  const values = new Map(hours.map((item) => [item.hour, item]));
  const cells: Omit<HourlyHeatmapCell, "level">[] = [];

  // 按天主序、小时内序排列：第 index 个格子的星期 = floor(index / 24)。
  for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
    const date = localDate(addLocalDays(range.start, dayIndex));
    for (let hourOfDay = 0; hourOfDay < 24; hourOfDay += 1) {
      const hour = `${date}T${String(hourOfDay).padStart(2, "0")}:00:00`;
      const bucketStart = new Date(
        range.start.getFullYear(),
        range.start.getMonth(),
        range.start.getDate() + dayIndex,
        hourOfDay,
      );
      const future = offset === 0 && bucketStart > currentHour;
      const item = future ? undefined : values.get(hour);
      const nativeInputTokens = item?.nativeInputTokens ?? 0;
      const nativeCachedInputTokens = item?.nativeCachedInputTokens ?? 0;
      const nativeCacheWriteInputTokens = item?.nativeCacheWriteInputTokens ?? 0;
      const nativeOutputTokens = item?.nativeOutputTokens ?? 0;
      const nativeReasoningTokens = item?.nativeReasoningTokens ?? 0;
      const nativeTokens = item?.nativeTotalTokens ?? 0;
      const nativeEvents = item?.nativeEventCount ?? 0;
      const nativeMeasuredInput = nativeInputTokens
        + nativeCachedInputTokens
        + nativeCacheWriteInputTokens;

      cells.push({
        hour,
        date,
        hourOfDay,
        hourEnd: hourOfDay + 1,
        tokens: (item?.knownTokens ?? 0) + nativeTokens,
        requests: (item?.requestCount ?? 0) + nativeEvents,
        inputTokens: (item?.inputTokens ?? 0) + nativeMeasuredInput,
        outputTokens: (item?.outputTokens ?? 0) + nativeOutputTokens,
        cachedInputTokens: (item?.inputCachedTokens ?? 0) + nativeCachedInputTokens,
        cacheMeasuredInputTokens: (item?.cacheMeasuredInputTokens ?? 0) + nativeMeasuredInput,
        estimatedCost: item?.estimatedCost ?? 0,
        nativeTokens,
        nativeInputTokens,
        nativeCachedInputTokens,
        nativeCacheWriteInputTokens,
        nativeOutputTokens,
        nativeReasoningTokens,
        nativeEvents,
        unknownRequests: item?.unknownCount ?? 0,
        outside: future,
        future,
        hasData: item !== undefined,
      });
    }
  }

  const scale = createHeatLevelScale(
    cells.filter((cell) => cell.hasData).map((cell) => (
      metric === "tokens" ? cell.tokens : cell.estimatedCost
    )),
  );
  return {
    cells: cells.map((cell): HourlyHeatmapCell => ({
      ...cell,
      level: scale.levelFor(metric === "tokens" ? cell.tokens : cell.estimatedCost),
    })),
  };
}

export function formatUsageRange(
  range: UsageRange,
  period: UsagePeriod,
  language: string,
) {
  if (period === "month") {
    return range.start.toLocaleDateString(language, { year: "numeric", month: "long" });
  }
  if (period === "day") {
    return range.start.toLocaleDateString(language, {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
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
