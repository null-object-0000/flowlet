import { describe, expect, it } from "vitest";
import {
  calendarRangeKind,
  dayRange,
  formatTimeRangeLabel,
  inclusiveLocalDates,
  monthRange,
  recentDaysRange,
  shiftCalendarRange,
  weekRange,
} from "./timeRange";

const NOW = new Date(2026, 7, 3, 13, 30);

describe("calendar time ranges", () => {
  it("builds yesterday and previous natural week in local time", () => {
    const yesterday = inclusiveLocalDates(dayRange(-1, NOW));
    const previousWeek = inclusiveLocalDates(weekRange(-1, NOW));

    expect(yesterday?.map(localKey)).toEqual(["2026-08-02", "2026-08-02"]);
    expect(previousWeek?.map(localKey)).toEqual(["2026-07-27", "2026-08-02"]);
  });

  it("recognizes and shifts natural calendar ranges", () => {
    const current = monthRange(0, NOW);
    const previous = shiftCalendarRange(current, -1);

    expect(calendarRangeKind(current)).toBe("month");
    expect(inclusiveLocalDates(previous)?.map(localKey)).toEqual(["2026-07-01", "2026-07-31"]);
  });

  it("shifts custom ranges by their complete day span", () => {
    const current = recentDaysRange(7, NOW);
    const previous = shiftCalendarRange(current, -1);

    expect(calendarRangeKind(current)).toBe("custom");
    expect(inclusiveLocalDates(previous)?.map(localKey)).toEqual(["2026-07-21", "2026-07-27"]);
  });

  it("formats known ranges with their concrete dates", () => {
    expect(formatTimeRangeLabel(weekRange(-1, NOW), "zh-CN", NOW)).toContain("上周");
    expect(formatTimeRangeLabel(dayRange(-1, NOW), "en-US", NOW)).toContain("Yesterday");
  });
});

function localKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
