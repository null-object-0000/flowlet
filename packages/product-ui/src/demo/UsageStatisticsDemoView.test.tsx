import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UsageStatisticsDemoView } from "./UsageStatisticsDemoView";

describe("UsageStatisticsDemoView", () => {
  it("switches periods and metrics and exposes selectable usage details", () => {
    const { container } = render(<UsageStatisticsDemoView zh />);

    expect(screen.getByText("24 小时 Token 柱状图")).toBeTruthy();
    expect(screen.getByRole("button", { name: "日" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "周" }));
    expect(screen.getByText("星期 × 小时 Token 热力图")).toBeTruthy();
    expect(screen.getByLabelText("Token 已识别 99.4%")).toBeTruthy();
    expect(container.querySelectorAll('button[style*="grid-column"]')).toHaveLength(168);

    fireEvent.click(screen.getByRole("button", { name: "预估费用" }));
    expect(screen.getByRole("button", { name: "预估费用" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("星期 × 小时预估费用热力图")).toBeTruthy();

    const cell = screen.getAllByRole("button", { name: /¥/ })[0];
    fireEvent.click(cell);
    expect(screen.getByText("指定时间点")).toBeTruthy();
    expect(screen.getAllByText("Agent 原生用量").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "月" }));
    expect(screen.getByText("每日预估费用热力图")).toBeTruthy();
  });
});
