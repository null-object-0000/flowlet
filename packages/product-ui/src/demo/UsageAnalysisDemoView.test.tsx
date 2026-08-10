import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UsageAnalysisDemoView } from "./UsageAnalysisDemoView";

describe("UsageAnalysisDemoView", () => {
  it("keeps one attribution header and switches dimension and metric fixtures", () => {
    render(<UsageAnalysisDemoView zh />);

    expect(screen.getAllByText("多维归因")).toHaveLength(1);
    expect(screen.getByRole("tab", { name: "按模型" }).getAttribute("aria-selected")).toBe("true");

    fireEvent.click(screen.getByRole("tab", { name: "按客户端" }));
    expect(screen.getByRole("tab", { name: "按客户端" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("客户端 × 模型，颜色越深消耗越高")).toBeTruthy();
    expect(screen.getAllByText("Codex Desktop").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "预估费用" }));
    expect(screen.getByRole("button", { name: "预估费用" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("$5.12")).toBeTruthy();
  });
});
