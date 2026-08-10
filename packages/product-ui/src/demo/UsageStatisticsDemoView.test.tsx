import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UsageStatisticsDemoView } from "./UsageStatisticsDemoView";

describe("UsageStatisticsDemoView", () => {
  it("switches periods and metrics and exposes selectable usage details", () => {
    render(<UsageStatisticsDemoView zh />);

    expect(screen.getByText("24 小时 Token 柱状图")).toBeTruthy();
    expect(screen.getByRole("button", { name: "日" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "周" }));
    expect(screen.getByText("星期 × 小时 Token 热力图")).toBeTruthy();
    expect(screen.getByText("点击图表中的时段查看用量明细")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "预估费用" }));
    expect(screen.getByRole("button", { name: "预估费用" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("星期 × 小时预估费用热力图")).toBeTruthy();

    const cell = screen.getAllByRole("button", { name: /¥/ })[0];
    fireEvent.click(cell);
    expect(screen.getByText("已选中")).toBeTruthy();
    expect(screen.getByText("Flowlet Proxy")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "月" }));
    expect(screen.getByText("每日预估费用热力图")).toBeTruthy();
  });
});
