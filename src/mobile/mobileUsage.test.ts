import { describe, expect, it } from "vitest";
import type { DailyUsageTotal } from "../domains/device-sync/types";
import { filterMobileUsage, summarizeMobileUsage } from "./mobileUsage";

const day = (date: string, requests: number, tokens: number): DailyUsageTotal => ({
  date,
  requestCount: requests,
  knownTokens: tokens,
  inputTokens: tokens - 10,
  inputCachedTokens: 5,
  inputUncachedTokens: tokens - 15,
  cacheMeasuredInputTokens: tokens - 10,
  outputTokens: 10,
  unknownCount: 0,
});

describe("mobile usage aggregation", () => {
  it("filters the latest seven local calendar days", () => {
    const days = [day("2026-07-22", 1, 10), day("2026-07-23", 2, 20), day("2026-07-29", 3, 30)];
    expect(filterMobileUsage(days, "week", new Date("2026-07-29T12:00:00")).map((item) => item.date))
      .toEqual(["2026-07-23", "2026-07-29"]);
  });

  it("summarizes request and token breakdowns", () => {
    expect(summarizeMobileUsage([day("2026-07-28", 2, 30), day("2026-07-29", 3, 40)]))
      .toEqual({ requests: 5, tokens: 70, inputTokens: 50, cachedInputTokens: 10, outputTokens: 20 });
  });
});
