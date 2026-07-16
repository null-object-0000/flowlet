import type { UsagePeriod, UsageSummaryRow } from "../../domains/usage/types";

export type UsageAggregate = {
  cost: number;
  tokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  uncachedInputTokens: number;
  cacheMeasuredInputTokens: number;
  outputTokens: number;
  requests: number;
  unknown: number;
};

export type UsageBreakdown = UsageAggregate & { key: string; label: string; share: number; brandId?: string };
export type UsageDay = UsageAggregate & { date: string };
export type UsageHeatmapCell = { bucket: string; tokens: number; level: 0 | 1 | 2 | 3 | 4; outside: boolean };
export type UsageHeatmap = {
  cells: UsageHeatmapCell[];
  columns: number;
  rows?: number;
  labels: Array<{ column: number; label: string }>;
  bucketUnit: "day" | "month";
  granularity: "hour" | "day" | "month" | "year";
  totalTokens: number;
};

export function filterUsageRows(rows: UsageSummaryRow[], period: UsagePeriod, now = new Date()): UsageSummaryRow[] {
  const today = localDateKey(now);
  if (period === "all") return rows;
  const rangeStart = localDateKey(startOfUsagePeriod(period, now));
  return rows.filter((row) => {
    const date = row.date.slice(0, 10);
    return date >= rangeStart && date <= today;
  });
}

export function summarizeUsage(rows: UsageSummaryRow[]): UsageAggregate {
  return rows.reduce((total, row) => ({
    cost: total.cost + finite(row.estimated_cost),
    tokens: total.tokens + finite(row.known_tokens),
    inputTokens: total.inputTokens + finite(row.input_tokens),
    cachedInputTokens: total.cachedInputTokens + finite(row.input_cached_tokens),
    uncachedInputTokens: total.uncachedInputTokens + finite(row.input_uncached_tokens),
    cacheMeasuredInputTokens: total.cacheMeasuredInputTokens + finite(row.cache_measured_input_tokens),
    outputTokens: total.outputTokens + finite(row.output_tokens),
    requests: total.requests + finite(row.request_count),
    unknown: total.unknown + finite(row.unknown_count),
  }), { cost: 0, tokens: 0, inputTokens: 0, cachedInputTokens: 0, uncachedInputTokens: 0, cacheMeasuredInputTokens: 0, outputTokens: 0, requests: 0, unknown: 0 });
}

export function groupUsageByModel(rows: UsageSummaryRow[]): UsageBreakdown[] {
  return groupUsage(
    rows,
    (row) => `${row.channel_id ?? "unknown-channel"}::${row.upstream_model ?? "unknown-model"}`,
    (row) => row.upstream_model ?? "未知模型",
    (row) => row.channel_id ?? "unknown-channel",
  );
}

export function groupUsageByChannel(rows: UsageSummaryRow[]): UsageBreakdown[] {
  return groupUsage(rows, (row) => row.channel_id ?? "unknown-channel", (row) => row.channel_name ?? row.channel_id ?? "未知渠道");
}

export function groupUsageByDay(rows: UsageSummaryRow[]): UsageDay[] {
  const groups = new Map<string, UsageAggregate>();
  for (const row of rows) {
    const key = row.date.slice(0, 10);
    const current = groups.get(key) ?? emptyAggregate();
    current.cost += finite(row.estimated_cost);
    current.tokens += finite(row.known_tokens);
    current.inputTokens += finite(row.input_tokens);
    current.cachedInputTokens += finite(row.input_cached_tokens);
    current.uncachedInputTokens += finite(row.input_uncached_tokens);
    current.cacheMeasuredInputTokens += finite(row.cache_measured_input_tokens);
    current.outputTokens += finite(row.output_tokens);
    current.requests += finite(row.request_count);
    current.unknown += finite(row.unknown_count);
    groups.set(key, current);
  }
  return [...groups.entries()].map(([date, value]) => ({ date, ...value })).sort((a, b) => a.date.localeCompare(b.date));
}

export function buildUsageHeatmap(rows: UsageSummaryRow[], period: UsagePeriod, now = new Date(), locale = "zh-CN"): UsageHeatmap {
  const filtered = filterUsageRows(rows, period, now);
  if (period === "year") return yearlyDailyHeatmap(filtered, now, locale);
  if (period === "all") {
    return monthlyBucketHeatmap(filtered, period, now, locale);
  }
  const start = startOfUsagePeriod(period, now);
  const end = endOfUsagePeriod(period, now);
  return dailyCalendarHeatmap(filtered, start, end, now, locale, period === "week" ? "day" : "month");
}

function hourlyHeatmap(rows: UsageSummaryRow[], now: Date): UsageHeatmap {
  const today = localDateKey(now);
  const tokensByHour = new Map<number, number>();
  for (const row of rows) {
    const hour = Number(row.date.slice(11, 13));
    const key = Number.isInteger(hour) ? hour : 0;
    tokensByHour.set(key, (tokensByHour.get(key) ?? 0) + finite(row.known_tokens));
  }
  const values = Array.from({ length: 24 }, (_, hour) => ({ bucket: `${today}T${String(hour).padStart(2, "0")}:00:00`, tokens: tokensByHour.get(hour) ?? 0, outside: false }));
  return finalizeHeatmap(values, 24, [0, 6, 12, 18, 23].map((hour) => ({ column: hour + 1, label: `${String(hour).padStart(2, "0")}:00` })), "hour");
}

function weeklyHeatmap(rows: UsageSummaryRow[], now: Date): UsageHeatmap {
  const tokensByDate = new Map(groupUsageByDay(rows).map((day) => [day.date, day.tokens]));
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
  const values = Array.from({ length: 7 }, (_, offset) => {
    const date = new Date(start);
    date.setDate(start.getDate() + offset);
    const bucket = localDateKey(date);
    return { bucket, tokens: tokensByDate.get(bucket) ?? 0, outside: false };
  });
  return finalizeHeatmap(values, 7, values.map((cell, index) => ({ column: index + 1, label: cell.bucket.slice(5).replace("-", "/") })), "day");
}

function monthlyHeatmap(rows: UsageSummaryRow[], now: Date, locale: string): UsageHeatmap {
  const tokensByDate = new Map(groupUsageByDay(rows).map((day) => [day.date, day.tokens]));
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const gridStart = new Date(first);
  gridStart.setDate(first.getDate() - first.getDay());
  const gridEnd = new Date(last);
  gridEnd.setDate(last.getDate() + (6 - last.getDay()));
  const values: Array<{ bucket: string; tokens: number; outside: boolean }> = [];
  for (const cursor = new Date(gridStart); cursor <= gridEnd; cursor.setDate(cursor.getDate() + 1)) {
    const bucket = localDateKey(cursor);
    const outside = cursor.getMonth() !== now.getMonth();
    values.push({ bucket, tokens: outside ? 0 : tokensByDate.get(bucket) ?? 0, outside });
  }
  const labels = Array.from({ length: 7 }, (_, index) => ({ column: index + 1, label: new Date(2026, 6, 12 + index).toLocaleDateString(locale, { weekday: "short" }) }));
  return finalizeHeatmap(values, 7, labels, "month");
}

function yearlyDailyHeatmap(rows: UsageSummaryRow[], now: Date, locale: string): UsageHeatmap {
  const tokensByDate = new Map(groupUsageByDay(rows).map((day) => [day.date, day.tokens]));
  const first = new Date(now.getFullYear(), 0, 1);
  const last = new Date(now.getFullYear(), 11, 31);
  const gridStart = new Date(first);
  gridStart.setDate(first.getDate() - ((first.getDay() + 6) % 7));
  const gridEnd = new Date(last);
  gridEnd.setDate(last.getDate() + (6 - ((last.getDay() + 6) % 7)));
  const values: Array<{ bucket: string; tokens: number; outside: boolean }> = [];
  for (const cursor = new Date(gridStart); cursor <= gridEnd; cursor.setDate(cursor.getDate() + 1)) {
    const bucket = localDateKey(cursor);
    const outside = cursor.getFullYear() !== now.getFullYear() || cursor > now;
    values.push({ bucket, tokens: outside ? 0 : tokensByDate.get(bucket) ?? 0, outside });
  }
  const labels = Array.from({ length: 12 }, (_, month) => {
    const date = new Date(now.getFullYear(), month, 1);
    const index = values.findIndex((cell) => cell.bucket === localDateKey(date));
    return { column: Math.floor(index / 7) + 1, label: date.toLocaleDateString(locale, { month: "short" }) };
  });
  const heatmap = finalizeHeatmap(values, values.length / 7, labels, "year");
  return { ...heatmap, rows: 7 };
}

function monthlyBucketHeatmap(rows: UsageSummaryRow[], period: "year" | "all", now: Date, locale: string): UsageHeatmap {
  const tokensByMonth = new Map<string, number>();
  for (const row of rows) {
    const key = row.date.slice(0, 7);
    tokensByMonth.set(key, (tokensByMonth.get(key) ?? 0) + finite(row.known_tokens));
  }
  const earliest = [...tokensByMonth.keys()].sort()[0];
  const startYear = period === "year" ? now.getFullYear() : Number(earliest?.slice(0, 4)) || now.getFullYear();
  const values: Array<{ bucket: string; tokens: number; outside: boolean }> = [];
  for (let year = startYear; year <= now.getFullYear(); year += 1) {
    for (let month = 0; month < 12; month += 1) {
      const key = `${year}-${String(month + 1).padStart(2, "0")}`;
      const outside = year === now.getFullYear() && month > now.getMonth();
      values.push({ bucket: key, tokens: outside ? 0 : tokensByMonth.get(key) ?? 0, outside });
    }
  }
  const labels = Array.from({ length: 12 }, (_, month) => ({ column: month + 1, label: new Date(2026, month, 1).toLocaleDateString(locale, { month: "short" }) }));
  return finalizeHeatmap(values, 12, labels, "month", "month");
}

function dailyCalendarHeatmap(rows: UsageSummaryRow[], start: Date, end: Date, now: Date, locale: string, granularity: "day" | "month"): UsageHeatmap {
  const tokensByDate = new Map(groupUsageByDay(rows).map((day) => [day.date, day.tokens]));
  const gridStart = new Date(start);
  gridStart.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  const gridEnd = new Date(end);
  gridEnd.setDate(end.getDate() + (6 - ((end.getDay() + 6) % 7)));
  const values: Array<{ bucket: string; tokens: number; outside: boolean }> = [];
  for (const cursor = new Date(gridStart); cursor <= gridEnd; cursor.setDate(cursor.getDate() + 1)) {
    const bucket = localDateKey(cursor);
    const outside = cursor < start || cursor > end || cursor > now;
    values.push({ bucket, tokens: outside ? 0 : tokensByDate.get(bucket) ?? 0, outside });
  }
  const labels = Array.from({ length: 7 }, (_, index) => ({ column: index + 1, label: new Date(2026, 6, 13 + index).toLocaleDateString(locale, { weekday: "short" }) }));
  return finalizeHeatmap(values, 7, labels, granularity);
}

function finalizeHeatmap(values: Array<{ bucket: string; tokens: number; outside: boolean }>, columns: number, labels: Array<{ column: number; label: string }>, granularity: UsageHeatmap["granularity"], bucketUnit: UsageHeatmap["bucketUnit"] = "day"): UsageHeatmap {
  const max = Math.max(0, ...values.map((cell) => cell.tokens));
  return {
    cells: values.map((cell) => ({ ...cell, level: heatLevel(cell.tokens, max) })),
    columns,
    labels,
    bucketUnit,
    granularity,
    totalTokens: values.reduce((total, cell) => total + cell.tokens, 0),
  };
}

function groupUsage(
  rows: UsageSummaryRow[],
  keyOf: (row: UsageSummaryRow) => string,
  labelOf: (row: UsageSummaryRow) => string,
  brandIdOf?: (row: UsageSummaryRow) => string,
): UsageBreakdown[] {
  const groups = new Map<string, Omit<UsageBreakdown, "share">>();
  for (const row of rows) {
    const key = keyOf(row);
    const current = groups.get(key) ?? { key, label: labelOf(row), brandId: brandIdOf?.(row), ...emptyAggregate() };
    current.cost += finite(row.estimated_cost);
    current.tokens += finite(row.known_tokens);
    current.inputTokens += finite(row.input_tokens);
    current.cachedInputTokens += finite(row.input_cached_tokens);
    current.uncachedInputTokens += finite(row.input_uncached_tokens);
    current.cacheMeasuredInputTokens += finite(row.cache_measured_input_tokens);
    current.outputTokens += finite(row.output_tokens);
    current.requests += finite(row.request_count);
    current.unknown += finite(row.unknown_count);
    groups.set(key, current);
  }
  const totalCost = [...groups.values()].reduce((sum, item) => sum + item.cost, 0);
  const totalTokens = [...groups.values()].reduce((sum, item) => sum + item.tokens, 0);
  return [...groups.values()].map((item) => ({
    ...item,
    share: totalCost > 0 ? item.cost / totalCost : totalTokens > 0 ? item.tokens / totalTokens : 0,
  })).sort((a, b) => b.cost - a.cost || b.tokens - a.tokens || a.label.localeCompare(b.label));
}

function finite(value: number) { return Number.isFinite(value) ? value : 0; }

function heatLevel(value: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (value <= 0 || max <= 0) return 0;
  return Math.max(1, Math.min(4, Math.ceil(Math.log1p(value) / Math.log1p(max) * 4))) as 1 | 2 | 3 | 4;
}

function emptyAggregate(): UsageAggregate {
  return { cost: 0, tokens: 0, inputTokens: 0, cachedInputTokens: 0, uncachedInputTokens: 0, cacheMeasuredInputTokens: 0, outputTokens: 0, requests: 0, unknown: 0 };
}

function localDateKey(value: Date) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function startOfUsagePeriod(period: Exclude<UsagePeriod, "all">, now: Date): Date {
  if (period === "year") return new Date(now.getFullYear(), 0, 1);
  if (period === "quarter") return new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
  if (period === "month") return new Date(now.getFullYear(), now.getMonth(), 1);
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const mondayOffset = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - mondayOffset);
  return start;
}

function endOfUsagePeriod(period: "week" | "month" | "quarter", now: Date): Date {
  if (period === "month") return new Date(now.getFullYear(), now.getMonth() + 1, 0);
  if (period === "quarter") return new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3 + 3, 0);
  const start = startOfUsagePeriod("week", now);
  return new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
}
