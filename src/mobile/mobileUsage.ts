import type { DailyUsageTotal } from "../domains/device-sync/types";

export type MobileUsagePeriod = "week" | "month" | "all";

export function filterMobileUsage(days: DailyUsageTotal[], period: MobileUsagePeriod, now = new Date()) {
  if (period === "all") return days;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (period === "week" ? 6 : 29));
  const startDate = localDate(start);
  return days.filter((day) => day.date >= startDate);
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

function localDate(value: Date) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
