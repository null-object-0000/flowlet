import { describe, expect, it } from "vitest";
import type { HourlyUsageTotal } from "../../domains/device-sync/types";
import { buildWeekdayHourHeatmap } from "./deviceUsagePresentation";

const hour = (date: string, hourOfDay: number, tokens: number, requests = 1): HourlyUsageTotal => ({
  hour: `${date}T${String(hourOfDay).padStart(2, "0")}:00:00`,
  requestCount: requests,
  knownTokens: tokens,
});

describe("buildWeekdayHourHeatmap", () => {
  it("builds 7×24 concrete hour cells for the selected week, ordered day-major", () => {
    // 2026-08-03 为周一；offset -1 选定上一自然周 2026-07-27（周一）～ 2026-08-02（周日）。
    const now = new Date("2026-08-03T12:00:00");
    const result = buildWeekdayHourHeatmap([
      hour("2026-07-27", 9, 100), // 周一 09 点
      hour("2026-07-27", 10, 30), // 周一 10 点
      hour("2026-07-28", 9, 50), // 周二 09 点
    ], -1, now, "tokens");

    expect(result.cells).toHaveLength(7 * 24);
    // 第 index 个格子的星期 = floor(index / 24)。
    expect(result.cells[0]).toMatchObject({ date: "2026-07-27", hourOfDay: 0, hour: "2026-07-27T00:00:00" });
    expect(result.cells[24]).toMatchObject({ date: "2026-07-28", hourOfDay: 0 });

    const monday9 = result.cells.find((cell) => cell.date === "2026-07-27" && cell.hourOfDay === 9);
    expect(monday9).toBeDefined();
    expect(monday9!.hour).toBe("2026-07-27T09:00:00");
    expect(monday9!.hourEnd).toBe(10);
    expect(monday9!.tokens).toBe(100);
    expect(monday9!.requests).toBe(1);
    expect(monday9!.hasData).toBe(true);

    const tuesday9 = result.cells.find((cell) => cell.date === "2026-07-28" && cell.hourOfDay === 9);
    expect(tuesday9!.tokens).toBe(50);
    expect(tuesday9!.hasData).toBe(true);

    // 周内无数据的小时保持空态。
    const sunday23 = result.cells.find((cell) => cell.date === "2026-08-02" && cell.hourOfDay === 23);
    expect(sunday23!.tokens).toBe(0);
    expect(sunday23!.hasData).toBe(false);
    expect(sunday23!.future).toBe(false);
  });

  it("excludes future hours of the current week", () => {
    // 2026-07-27 为周一，now 为该日 12 点（offset 0 = 本周）。
    const now = new Date("2026-07-27T12:00:00");
    const result = buildWeekdayHourHeatmap([
      hour("2026-07-27", 10, 100), // 过去小时
      hour("2026-07-27", 15, 200), // 当天未来小时
      hour("2026-07-28", 10, 300), // 未来日期
    ], 0, now, "tokens");

    const monday10 = result.cells.find((cell) => cell.date === "2026-07-27" && cell.hourOfDay === 10);
    const monday15 = result.cells.find((cell) => cell.date === "2026-07-27" && cell.hourOfDay === 15);
    const tuesday10 = result.cells.find((cell) => cell.date === "2026-07-28" && cell.hourOfDay === 10);

    expect(monday10!.tokens).toBe(100);
    expect(monday10!.hasData).toBe(true);
    expect(monday10!.future).toBe(false);

    expect(monday15!.tokens).toBe(0);
    expect(monday15!.hasData).toBe(false);
    expect(monday15!.future).toBe(true);

    expect(tuesday10!.tokens).toBe(0);
    expect(tuesday10!.hasData).toBe(false);
    expect(tuesday10!.future).toBe(true);
  });

  it("builds cost metric levels from estimated cost when requested", () => {
    const now = new Date("2026-08-03T12:00:00");
    const result = buildWeekdayHourHeatmap([
      { ...hour("2026-07-27", 9, 0), estimatedCost: 1.2 },
      { ...hour("2026-07-27", 10, 0), estimatedCost: 0.8 },
    ], -1, now, "cost");
    const monday9 = result.cells.find((cell) => cell.date === "2026-07-27" && cell.hourOfDay === 9);
    const monday10 = result.cells.find((cell) => cell.date === "2026-07-27" && cell.hourOfDay === 10);
    expect(monday9!.estimatedCost).toBe(1.2);
    expect(monday10!.estimatedCost).toBe(0.8);
    expect(monday9!.level).toBeGreaterThanOrEqual(0);
    expect(monday10!.level).toBeLessThanOrEqual(monday9!.level);
  });
});
