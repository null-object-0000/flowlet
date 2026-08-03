import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { dayRange, weekRange } from "../timeRange";
import { CalendarTimeRangeControl, TimePresetSelect, TimeScopeControl } from "./TimeScopeControl";

const t = (source: string) => source;
const NOW = new Date(2026, 7, 3, 13, 30);

describe("TimeScopeControl", () => {
  it("navigates a natural week to the previous historical week", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <TimeScopeControl>
        <CalendarTimeRangeControl
          value={weekRange(0, NOW)}
          onChange={onChange}
          language="zh-CN"
          t={t}
          now={NOW}
        />
      </TimeScopeControl>,
    );

    expect(screen.getByRole("button", { name: "选择时间范围" })).toHaveTextContent("本周");
    expect(screen.getByRole("button", { name: "下一个时间范围" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "上一个时间范围" }));
    expect(onChange).toHaveBeenCalledWith(weekRange(-1, NOW));
  });

  it("renders compact preset selects with the page-owned value and label", () => {
    render(
      <TimePresetSelect
        value="all"
        options={[
          { value: "today", label: "今天" },
          { value: "all", label: "全部时间" },
        ]}
        onChange={() => undefined}
        ariaLabel="时间范围"
      />,
    );

    expect(screen.getByRole("combobox", { name: "时间范围" })).toHaveTextContent("全部时间");
  });

  it("renders explicit historical day labels", () => {
    render(
      <CalendarTimeRangeControl
        value={dayRange(-1, NOW)}
        onChange={() => undefined}
        language="zh-CN"
        t={t}
        now={NOW}
      />,
    );
    expect(screen.getByRole("button", { name: "选择时间范围" })).toHaveTextContent("昨日");
  });

  it("applies quick ranges directly and closes the compact panel", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <CalendarTimeRangeControl
        value={weekRange(0, NOW)}
        onChange={onChange}
        language="zh-CN"
        t={t}
        now={NOW}
      />,
    );

    await user.click(screen.getByRole("button", { name: "选择时间范围" }));
    expect(screen.getByText("快捷选择")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "上月" }));

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      startAt: monthStartIso(2026, 6),
      endAt: monthStartIso(2026, 7),
    }));
    expect(screen.getByRole("button", { name: "选择时间范围" })).toHaveAttribute("aria-expanded", "false");
  });
});

function monthStartIso(year: number, zeroBasedMonth: number) {
  return new Date(year, zeroBasedMonth, 1).toISOString();
}
