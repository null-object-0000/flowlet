import { describe, expect, it } from "vitest";
import type { UsageSummaryTotals } from "./usagePresentation";
import type { AgentNativeUsageTotals } from "./nativeUsagePresentation";
import { mergeCurrencyAmounts, summarizeCombinedUsage } from "./combinedUsagePresentation";

const flowlet: UsageSummaryTotals = {
  cost: 1.25,
  tokens: 1200,
  inputTokens: 900,
  cachedInputTokens: 300,
  uncachedInputTokens: 600,
  cacheMeasuredInputTokens: 900,
  outputTokens: 300,
  requests: 8,
  unknown: 1,
  costByCurrency: { CNY: 1, USD: 0.25 },
};

const native: AgentNativeUsageTotals = {
  sessions: 2,
  sessionsWithUsage: 2,
  turns: 5,
  tokens: 800,
  inputTokens: 650,
  cachedInputTokens: 200,
  cacheWriteInputTokens: 20,
  outputTokens: 150,
  reasoningTokens: 30,
  truncatedSessions: 0,
  apiEquivalentByCurrency: { USD: 0.5, CREDITS: 3 },
  nativeCostByCurrency: { USD: 0.1 },
  planConsumptionByCurrency: { CREDITS: 2 },
  pricedTurns: 4,
  unpricedTurns: 1,
};

describe("combined usage presentation", () => {
  it("combines tokens and keeps request and native-turn scales separate", () => {
    expect(summarizeCombinedUsage(flowlet, native)).toEqual(expect.objectContaining({
      tokens: 2000,
      flowletTokens: 1200,
      nativeTokens: 800,
      requests: 8,
      nativeTurns: 5,
      nativeSessions: 2,
    }));
  });

  it("merges API-equivalent values by currency without conversion", () => {
    expect(summarizeCombinedUsage(flowlet, native).apiEquivalentValueByCurrency).toEqual({
      CNY: 1,
      USD: 0.75,
      CREDITS: 3,
    });
  });

  it("does not add native reported cost or plan consumption", () => {
    const combined = summarizeCombinedUsage(flowlet, native);
    expect(combined.apiEquivalentValueByCurrency.USD).toBe(0.75);
    expect(combined.apiEquivalentValueByCurrency.CREDITS).toBe(3);
  });

  it("ignores invalid and non-positive currency amounts", () => {
    expect(mergeCurrencyAmounts(
      { USD: 1, CNY: Number.NaN },
      { USD: -2, CNY: 0, CREDITS: 4 },
    )).toEqual({ USD: 1, CREDITS: 4 });
  });
});
