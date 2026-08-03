import { describe, expect, it } from "vitest";
import type { DailyUsageTotal, HourlyUsageTotal } from "../domains/device-sync/types";
import {
  buildMobileDailyHourlyHeatmap,
  buildMobileWeeklyHourlyHeatmap,
  buildMobileUsageHeatmap,
  buildUsageTokenDetails,
  filterMobileUsage,
  formatMobileUsageRange,
  getMobileUsageRange,
  summarizeMobileUsage,
} from "../features/usage/deviceUsagePresentation";

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
  it("uses natural days and supports previous days", () => {
    const now = new Date("2026-08-03T12:00:00");
    expect(getMobileUsageRange("day", 0, now)).toMatchObject({
      startDate: "2026-08-03",
      endDate: "2026-08-03",
    });
    expect(getMobileUsageRange("day", -1, now)).toMatchObject({
      startDate: "2026-08-02",
      endDate: "2026-08-02",
    });
  });

  it("uses Monday-to-Sunday natural weeks and supports previous weeks", () => {
    const now = new Date("2026-07-29T12:00:00");
    expect(getMobileUsageRange("week", 0, now)).toMatchObject({
      startDate: "2026-07-27",
      endDate: "2026-08-02",
    });
    expect(getMobileUsageRange("week", -1, now)).toMatchObject({
      startDate: "2026-07-20",
      endDate: "2026-07-26",
    });
  });

  it("uses natural months and supports previous months", () => {
    const now = new Date("2026-07-29T12:00:00");
    expect(getMobileUsageRange("month", 0, now)).toMatchObject({
      startDate: "2026-07-01",
      endDate: "2026-07-31",
    });
    expect(getMobileUsageRange("month", -1, now)).toMatchObject({
      startDate: "2026-06-01",
      endDate: "2026-06-30",
    });
  });

  it("filters only the selected calendar range", () => {
    const days = [
      day("2026-07-20", 1, 10),
      day("2026-07-27", 2, 20),
      day("2026-07-29", 3, 30),
    ];
    expect(filterMobileUsage(days, "week", 0, new Date("2026-07-29T12:00:00")).map((item) => item.date))
      .toEqual(["2026-07-27", "2026-07-29"]);
  });

  it("summarizes request and token breakdowns", () => {
    expect(summarizeMobileUsage([day("2026-07-28", 2, 30), day("2026-07-29", 3, 40)]))
      .toEqual({
        requests: 5,
        tokens: 70,
        inputTokens: 50,
        cachedInputTokens: 10,
        uncachedInputTokens: 40,
        cacheMeasuredInputTokens: 50,
        cacheHitRate: 0.2,
        outputTokens: 20,
        nativeEvents: 0,
        nativeTokens: 0,
        nativeInputTokens: 0,
        nativeCachedInputTokens: 0,
        nativeCacheWriteInputTokens: 0,
        nativeOutputTokens: 0,
        nativeReasoningTokens: 0,
        estimatedCost: 0,
      });
  });

  it("sums proxy estimated cost without fabricating native cost", () => {
    const proxyDay = { ...day("2026-07-29", 3, 40), estimatedCost: 1.25 };
    const nativeDay = {
      ...day("2026-07-30", 0, 0),
      nativeEventCount: 2,
      nativeTotalTokens: 100,
    };

    expect(summarizeMobileUsage([proxyDay, nativeDay]).estimatedCost).toBe(1.25);
  });

  it("builds total, Flowlet, and Agent native token detail sections without fabricating unavailable fields", () => {
    const details = buildUsageTokenDetails({
      proxyTotal: 100,
      proxyInput: 80,
      proxyCachedInput: 30,
      proxyUncachedInput: 50,
      proxyCacheMeasuredInput: 80,
      proxyOutput: 20,
      proxyRequests: 4,
      proxyUnknownUsageCount: 1,
      nativeTotal: 60,
      nativeInput: 20,
      nativeCachedInput: 10,
      nativeCacheWriteInput: 5,
      nativeOutput: 25,
      nativeReasoning: 3,
      nativeEvents: 2,
    });

    expect(details.total).toMatchObject({
      total: 160,
      input: 115,
      cachedInput: 40,
      cacheWriteInput: null,
      uncachedInput: 70,
      output: 45,
      reasoning: null,
      requests: 6,
      unknownUsageCount: 1,
    });
    expect(details.flowlet.cacheWriteInput).toBeNull();
    expect(details.flowlet.reasoning).toBeNull();
    expect(details.native).toMatchObject({ total: 60, input: 35, cachedInput: 10, requests: 2 });
  });

  it("merges agent native usage into summaries and heatmap cells", () => {
    const withNative: DailyUsageTotal = {
      ...day("2026-07-29", 3, 40),
      nativeEventCount: 2,
      nativeTotalTokens: 100,
      nativeInputTokens: 60,
      nativeCachedInputTokens: 20,
      nativeCacheWriteInputTokens: 10,
      nativeOutputTokens: 40,
      nativeReasoningTokens: 5,
    };
    const summary = summarizeMobileUsage([withNative]);
    // 代理口径字段保持独立，原生部分单列，合计由页面渲染时相加。
    expect(summary.requests).toBe(3);
    expect(summary.nativeEvents).toBe(2);
    expect(summary.tokens).toBe(40);
    expect(summary.nativeTokens).toBe(100);
    expect(summary.nativeInputTokens).toBe(60);
    expect(summary.nativeCachedInputTokens).toBe(20);
    expect(summary.nativeCacheWriteInputTokens).toBe(10);
    expect(summary.nativeOutputTokens).toBe(40);
    expect(summary.nativeReasoningTokens).toBe(5);

    const heatmap = buildMobileUsageHeatmap(
      [withNative],
      "month",
      0,
      new Date("2026-07-29T12:00:00"),
    );
    expect(heatmap.cells.find((cell) => cell.date === "2026-07-29"))
      .toMatchObject({ tokens: 140, requests: 5, nativeTokens: 100, nativeEvents: 2, hasData: true });

    const hours: HourlyUsageTotal[] = [
      {
        hour: "2026-07-29T09:00:00",
        requestCount: 1,
        knownTokens: 30,
        inputTokens: 20,
        inputCachedTokens: 5,
        cacheMeasuredInputTokens: 20,
        outputTokens: 10,
        unknownCount: 1,
        estimatedCost: 0.25,
        nativeEventCount: 2,
        nativeInputTokens: 50,
        nativeCachedInputTokens: 15,
        nativeCacheWriteInputTokens: 5,
        nativeOutputTokens: 20,
        nativeReasoningTokens: 7,
        nativeTotalTokens: 70,
      },
    ];
    const hourly = buildMobileWeeklyHourlyHeatmap(hours, 0, new Date("2026-07-29T12:30:00"));
    expect(hourly.cells.find((cell) => cell.hour === "2026-07-29T09:00:00"))
      .toMatchObject({
        tokens: 100,
        requests: 3,
        inputTokens: 90,
        outputTokens: 30,
        cachedInputTokens: 20,
        cacheMeasuredInputTokens: 90,
        estimatedCost: 0.25,
        nativeTokens: 70,
        nativeInputTokens: 50,
        nativeCachedInputTokens: 15,
        nativeCacheWriteInputTokens: 5,
        nativeOutputTokens: 20,
        nativeReasoningTokens: 7,
        nativeEvents: 2,
        unknownRequests: 1,
        hasData: true,
      });
  });

  it("marks native-only days as heatmap data", () => {
    const nativeOnly: DailyUsageTotal = {
      date: "2026-07-29",
      requestCount: 0,
      knownTokens: 0,
      inputTokens: 0,
      inputCachedTokens: 0,
      inputUncachedTokens: 0,
      cacheMeasuredInputTokens: 0,
      outputTokens: 0,
      unknownCount: 0,
      nativeEventCount: 1,
      nativeTotalTokens: 50,
    };
    const heatmap = buildMobileUsageHeatmap(
      [nativeOnly],
      "month",
      0,
      new Date("2026-07-29T12:00:00"),
    );
    expect(heatmap.cells.find((cell) => cell.date === "2026-07-29"))
      .toMatchObject({ tokens: 50, requests: 1, nativeTokens: 50, hasData: true });
  });

  it("does not report a cache hit rate without cache-measured input", () => {
    expect(summarizeMobileUsage([{
      ...day("2026-07-29", 3, 40),
      inputCachedTokens: 0,
      cacheMeasuredInputTokens: 0,
    }]).cacheHitRate).toBeNull();
  });

  it("builds one row for a week and disables future dates", () => {
    const heatmap = buildMobileUsageHeatmap(
      [day("2026-07-27", 2, 20), day("2026-07-29", 3, 80)],
      "week",
      0,
      new Date("2026-07-29T12:00:00"),
    );

    expect(heatmap.cells).toHaveLength(7);
    expect(heatmap.cells[0]).toMatchObject({ date: "2026-07-27", tokens: 20, hasData: true });
    expect(heatmap.cells[2]).toMatchObject({ date: "2026-07-29", tokens: 80, level: 4 });
    expect(heatmap.cells[3]).toMatchObject({ date: "2026-07-30", outside: true, future: true, hasData: false });
  });

  it("aggregates a week into 7 days by 3-hour buckets", () => {
    const hours: HourlyUsageTotal[] = [
      { hour: "2026-07-27T09:00:00", requestCount: 2, knownTokens: 20, unknownCount: 1 },
      { hour: "2026-07-27T10:00:00", requestCount: 1, knownTokens: 30 },
      { hour: "2026-07-29T11:00:00", requestCount: 3, knownTokens: 80 },
    ];
    const heatmap = buildMobileWeeklyHourlyHeatmap(
      hours,
      0,
      new Date("2026-07-29T12:30:00"),
    );

    expect(heatmap.cells).toHaveLength(7 * 8);
    expect(heatmap.cells.find((cell) => cell.hour === "2026-07-27T09:00:00"))
      .toMatchObject({ hourEnd: 12, tokens: 50, requests: 3, unknownRequests: 1, hasData: true });
    expect(heatmap.cells.find((cell) => cell.hour === "2026-07-29T09:00:00"))
      .toMatchObject({ hourEnd: 12, tokens: 80, level: 4, hasData: true });
    expect(heatmap.cells.find((cell) => cell.hour === "2026-07-29T15:00:00"))
      .toMatchObject({ outside: true, future: true, hasData: false });
  });

  it("assigns weekly bucket colors from the current visible distribution", () => {
    const tokens = [10, 20, 30, 40, 1_000_000];
    const hours: HourlyUsageTotal[] = tokens.map((knownTokens, index) => ({
      hour: `2026-07-${String(27 + index).padStart(2, "0")}T09:00:00`,
      requestCount: 1,
      knownTokens,
    }));
    const heatmap = buildMobileWeeklyHourlyHeatmap(
      hours,
      0,
      new Date("2026-08-02T23:00:00"),
    );
    const levels = tokens.map((_, index) => heatmap.cells.find(
      (cell) => cell.hour === `2026-07-${String(27 + index).padStart(2, "0")}T09:00:00`,
    )?.level);
    expect(levels).toEqual([1, 1, 2, 3, 4]);
  });

  it("builds a selected day into 24 one-hour cells and disables future hours", () => {
    const hours: HourlyUsageTotal[] = [{
      hour: "2026-08-03T09:00:00",
      requestCount: 2,
      knownTokens: 30,
      inputTokens: 20,
      inputCachedTokens: 5,
      cacheMeasuredInputTokens: 20,
      outputTokens: 10,
      nativeEventCount: 1,
      nativeInputTokens: 8,
      nativeCachedInputTokens: 2,
      nativeCacheWriteInputTokens: 1,
      nativeOutputTokens: 4,
      nativeReasoningTokens: 3,
      nativeTotalTokens: 15,
    }];
    const heatmap = buildMobileDailyHourlyHeatmap(
      hours,
      0,
      new Date("2026-08-03T12:30:00"),
    );

    expect(heatmap.cells).toHaveLength(24);
    expect(heatmap.cells[9]).toMatchObject({
      hour: "2026-08-03T09:00:00",
      hourEnd: 10,
      tokens: 45,
      requests: 3,
      inputTokens: 31,
      cachedInputTokens: 7,
      nativeTokens: 15,
      nativeCachedInputTokens: 2,
      hasData: true,
    });
    expect(heatmap.cells[8]).toMatchObject({ outside: false, future: false, hasData: false, tokens: 0 });
    expect(heatmap.cells[13]).toMatchObject({ outside: true, future: true, hasData: false });
  });

  it("switches daily and hourly heat levels between token and estimated cost", () => {
    const days: DailyUsageTotal[] = [
      { ...day("2026-07-27", 1, 1_000), estimatedCost: 0.01 },
      { ...day("2026-07-28", 1, 10), estimatedCost: 10 },
    ];
    const tokenDays = buildMobileUsageHeatmap(
      days,
      "week",
      0,
      new Date("2026-08-02T23:00:00"),
      "tokens",
    );
    const costDays = buildMobileUsageHeatmap(
      days,
      "week",
      0,
      new Date("2026-08-02T23:00:00"),
      "cost",
    );

    expect(tokenDays.cells.find((cell) => cell.date === "2026-07-27"))
      .toMatchObject({ estimatedCost: 0.01, level: 4 });
    expect(tokenDays.cells.find((cell) => cell.date === "2026-07-28")?.level).toBe(1);
    expect(costDays.cells.find((cell) => cell.date === "2026-07-27")?.level).toBe(1);
    expect(costDays.cells.find((cell) => cell.date === "2026-07-28")?.level).toBe(4);

    const hours: HourlyUsageTotal[] = [
      { hour: "2026-07-27T09:00:00", requestCount: 1, knownTokens: 1_000, estimatedCost: 0.01 },
      { hour: "2026-07-28T09:00:00", requestCount: 1, knownTokens: 10, estimatedCost: 10 },
    ];
    const tokenHours = buildMobileWeeklyHourlyHeatmap(
      hours,
      0,
      new Date("2026-08-02T23:00:00"),
      "tokens",
    );
    const costHours = buildMobileWeeklyHourlyHeatmap(
      hours,
      0,
      new Date("2026-08-02T23:00:00"),
      "cost",
    );

    expect(tokenHours.cells.find((cell) => cell.hour === "2026-07-27T09:00:00")?.level).toBe(4);
    expect(tokenHours.cells.find((cell) => cell.hour === "2026-07-28T09:00:00")?.level).toBe(1);
    expect(costHours.cells.find((cell) => cell.hour === "2026-07-27T09:00:00")?.level).toBe(1);
    expect(costHours.cells.find((cell) => cell.hour === "2026-07-28T09:00:00")?.level).toBe(4);
  });

  it("builds a complete calendar grid for the selected month", () => {
    const heatmap = buildMobileUsageHeatmap(
      [day("2026-07-01", 1, 10), day("2026-07-29", 1, 20)],
      "month",
      0,
      new Date("2026-07-29T12:00:00"),
    );

    expect(heatmap.cells).toHaveLength(35);
    expect(heatmap.cells[0]).toMatchObject({ date: "2026-06-29", outside: true, future: false });
    expect(heatmap.cells.find((cell) => cell.date === "2026-07-01")).toMatchObject({ hasData: true, tokens: 10 });
    expect(heatmap.cells.find((cell) => cell.date === "2026-07-30")).toMatchObject({ outside: true });
  });

  it("shows real usage in adjacent-month calendar cells without adding it to the month summary", () => {
    const adjacent = day("2026-07-31", 2, 40);
    const current = day("2026-08-01", 3, 60);
    const days = [adjacent, current];
    const heatmap = buildMobileUsageHeatmap(
      days,
      "month",
      0,
      new Date("2026-08-03T12:00:00"),
    );

    expect(heatmap.cells.find((cell) => cell.date === "2026-07-31"))
      .toMatchObject({ outside: true, hasData: true, tokens: 40, requests: 2 });
    expect(summarizeMobileUsage(filterMobileUsage(days, "month", 0, new Date("2026-08-03T12:00:00"))).tokens)
      .toBe(60);
  });

  it("formats week and month labels", () => {
    const now = new Date("2026-07-29T12:00:00");
    expect(formatMobileUsageRange(getMobileUsageRange("month", 0, now), "month", "zh-CN")).toBe("2026年7月");
    expect(formatMobileUsageRange(getMobileUsageRange("day", 0, now), "day", "zh-CN")).toBe("2026年7月29日");
    expect(formatMobileUsageRange(getMobileUsageRange("week", 0, now), "week", "zh-CN")).toContain("7月27日");
  });
});
