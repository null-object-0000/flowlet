import { describe, expect, it } from "vitest";
import type { DailyUsageTotal, HourlyUsageTotal } from "../domains/device-sync/types";
import {
  buildMobileWeeklyHourlyHeatmap,
  buildMobileUsageHeatmap,
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
        cacheMeasuredInputTokens: 50,
        cacheHitRate: 0.2,
        outputTokens: 20,
        nativeEvents: 0,
        nativeTokens: 0,
        nativeInputTokens: 0,
        nativeOutputTokens: 0,
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

  it("merges agent native usage into summaries and heatmap cells", () => {
    const withNative: DailyUsageTotal = {
      ...day("2026-07-29", 3, 40),
      nativeEventCount: 2,
      nativeTotalTokens: 100,
      nativeInputTokens: 60,
      nativeOutputTokens: 40,
    };
    const summary = summarizeMobileUsage([withNative]);
    // 代理口径字段保持独立，原生部分单列，合计由页面渲染时相加。
    expect(summary.requests).toBe(3);
    expect(summary.nativeEvents).toBe(2);
    expect(summary.tokens).toBe(40);
    expect(summary.nativeTokens).toBe(100);
    expect(summary.nativeInputTokens).toBe(60);
    expect(summary.nativeOutputTokens).toBe(40);

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
        nativeOutputTokens: 20,
        nativeTotalTokens: 70,
      },
    ];
    const hourly = buildMobileWeeklyHourlyHeatmap(hours, 0, new Date("2026-07-29T12:30:00"));
    expect(hourly.cells.find((cell) => cell.hour === "2026-07-29T09:00:00"))
      .toMatchObject({
        tokens: 100,
        requests: 3,
        inputTokens: 70,
        outputTokens: 30,
        cachedInputTokens: 5,
        cacheMeasuredInputTokens: 20,
        estimatedCost: 0.25,
        nativeTokens: 70,
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
    expect(heatmap.cells[3]).toMatchObject({ date: "2026-07-30", outside: true, hasData: false });
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
      .toMatchObject({ outside: true, hasData: false });
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

  it("builds a complete calendar grid for the selected month", () => {
    const heatmap = buildMobileUsageHeatmap(
      [day("2026-07-01", 1, 10), day("2026-07-29", 1, 20)],
      "month",
      0,
      new Date("2026-07-29T12:00:00"),
    );

    expect(heatmap.cells).toHaveLength(35);
    expect(heatmap.cells[0]).toMatchObject({ date: "2026-06-29", outside: true });
    expect(heatmap.cells.find((cell) => cell.date === "2026-07-01")).toMatchObject({ hasData: true, tokens: 10 });
    expect(heatmap.cells.find((cell) => cell.date === "2026-07-30")).toMatchObject({ outside: true });
  });

  it("formats week and month labels", () => {
    const now = new Date("2026-07-29T12:00:00");
    expect(formatMobileUsageRange(getMobileUsageRange("month", 0, now), "month", "zh-CN")).toBe("2026年7月");
    expect(formatMobileUsageRange(getMobileUsageRange("week", 0, now), "week", "zh-CN")).toContain("7月27日");
  });
});
