import { describe, expect, it } from "vitest";
import type { DailyUsageTotal } from "../domains/device-sync/types";
import {
  buildMobileUsageHeatmap,
  filterMobileUsage,
  formatMobileUsageRange,
  getMobileUsageRange,
  summarizeMobileUsage,
} from "./mobileUsage";

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
      .toEqual({ requests: 5, tokens: 70, inputTokens: 50, cachedInputTokens: 10, outputTokens: 20 });
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
