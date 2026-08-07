import { describe, expect, it } from "vitest";
import type { HourlyUsageTotal } from "../../domains/device-sync/types";
import { buildMonthWeekdayHourHeatmap } from "./deviceUsagePresentation";

const hour = (date: string, hourOfDay: number, tokens: number, requests = 1): HourlyUsageTotal => ({
  hour: `${date}T${String(hourOfDay).padStart(2, "0")}:00:00`,
  requestCount: requests,
  knownTokens: tokens,
});

describe("buildMonthWeekdayHourHeatmap", () => {
  it("aggregates hourly usage by (weekday, hour) across the selected month", () => {
    // 2026-08-03 为周一；offset -1 选定 2026-07 自然月（2026-07-06、07-13 均为周一）。
    const now = new Date("2026-08-03T12:00:00");
    const result = buildMonthWeekdayHourHeatmap([
      hour("2026-07-06", 9, 100), // 周一 09 点
      hour("2026-07-13", 9, 50), // 下个周一 09 点 → 与上面合计
      hour("2026-07-13", 10, 30), // 周一 10 点
    ], -1, now, "tokens");

    expect(result.cells).toHaveLength(7 * 24);
    const monday9 = result.cells.find((cell) => cell.weekday === 0 && cell.hourOfDay === 9);
    expect(monday9).toBeDefined();
    expect(monday9!.tokens).toBe(150);
    expect(monday9!.requests).toBe(2);
    expect(monday9!.hasData).toBe(true);

    const monday10 = result.cells.find((cell) => cell.weekday === 0 && cell.hourOfDay === 10);
    expect(monday10!.tokens).toBe(30);

    const monday8 = result.cells.find((cell) => cell.weekday === 0 && cell.hourOfDay === 8);
    expect(monday8!.tokens).toBe(0);
    expect(monday8!.hasData).toBe(false);

    // 周二任意时段都不该有数据。
    const tuesday = result.cells.find((cell) => cell.weekday === 1 && cell.hourOfDay === 9);
    expect(tuesday!.hasData).toBe(false);
  });

  it("excludes future hours and future days of the current month", () => {
    // 2026-07-15 为周三，now 为该日 12 点。
    const now = new Date("2026-07-15T12:00:00");
    const result = buildMonthWeekdayHourHeatmap([
      hour("2026-07-15", 10, 100), // 过去小时
      hour("2026-07-15", 15, 200), // 当天未来小时
      hour("2026-07-16", 10, 300), // 未来日期
    ], 0, now, "tokens");

    const wed10 = result.cells.find((cell) => cell.weekday === 2 && cell.hourOfDay === 10);
    const wed15 = result.cells.find((cell) => cell.weekday === 2 && cell.hourOfDay === 15);
    const thu10 = result.cells.find((cell) => cell.weekday === 3 && cell.hourOfDay === 10);

    expect(wed10!.tokens).toBe(100);
    expect(wed10!.hasData).toBe(true);
    expect(wed15!.tokens).toBe(0);
    expect(wed15!.hasData).toBe(false);
    expect(thu10!.tokens).toBe(0);
    expect(thu10!.hasData).toBe(false);
  });

  it("builds cost metric levels from estimated cost when requested", () => {
    const now = new Date("2026-08-03T12:00:00");
    const result = buildMonthWeekdayHourHeatmap([
      { ...hour("2026-07-06", 9, 0), estimatedCost: 1.2 },
      { ...hour("2026-07-13", 9, 0), estimatedCost: 0.8 },
    ], -1, now, "cost");
    const monday9 = result.cells.find((cell) => cell.weekday === 0 && cell.hourOfDay === 9);
    expect(monday9!.estimatedCost).toBe(2.0);
    expect(monday9!.level).toBeGreaterThanOrEqual(0);
  });
});
