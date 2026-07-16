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

export type UsageBreakdown = UsageAggregate & { key: string; label: string; share: number };
export type UsageDay = UsageAggregate & { date: string };

export function filterUsageRows(rows: UsageSummaryRow[], period: UsagePeriod, now = new Date()): UsageSummaryRow[] {
  const today = localDateKey(now);
  const month = today.slice(0, 7);
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
  const weekStart = localDateKey(start);
  return rows.filter((row) => {
    const date = row.date.slice(0, 10);
    if (period === "today") return date === today;
    if (period === "month") return date.startsWith(month);
    return date >= weekStart && date <= today;
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
  return groupUsage(rows, (row) => row.upstream_model ?? "unknown-model", (row) => row.upstream_model ?? "未知模型");
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

function groupUsage(
  rows: UsageSummaryRow[],
  keyOf: (row: UsageSummaryRow) => string,
  labelOf: (row: UsageSummaryRow) => string,
): UsageBreakdown[] {
  const groups = new Map<string, Omit<UsageBreakdown, "share">>();
  for (const row of rows) {
    const key = keyOf(row);
    const current = groups.get(key) ?? { key, label: labelOf(row), ...emptyAggregate() };
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

function emptyAggregate(): UsageAggregate {
  return { cost: 0, tokens: 0, inputTokens: 0, cachedInputTokens: 0, uncachedInputTokens: 0, cacheMeasuredInputTokens: 0, outputTokens: 0, requests: 0, unknown: 0 };
}

function localDateKey(value: Date) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
