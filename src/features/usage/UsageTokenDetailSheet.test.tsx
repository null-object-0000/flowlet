import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@douyinfe/semi-ui-19", () => ({
  SideSheet: ({ children, title, placement, width }: { children: ReactNode; title: ReactNode; placement: string; width: string }) => (
    <section data-testid="desktop-sheet" data-placement={placement} data-width={width}><h2>{title}</h2>{children}</section>
  ),
}));

import { UsageTokenDetailSheet } from "./UsageTokenDetailSheet";

describe("UsageTokenDetailSheet", () => {
  it("compares total, Flowlet, and Agent native values by metric in the mobile bottom sheet", () => {
    render(
      <UsageTokenDetailSheet
        visible
        onClose={vi.fn()}
        contextLabel="2026年8月3日"
        language="zh-CN"
        t={(source) => source}
        mobile
        details={{
          total: column(160, 40, 6),
          flowlet: { ...column(100, 30, 4), cacheWriteInput: null, reasoning: null },
          native: column(60, 10, 2),
        }}
      />,
    );

    expect(screen.getByTestId("sheet")).toHaveAttribute("data-placement", "bottom");
    expect(screen.getByText("Token 用量明细")).toBeInTheDocument();
    expect(screen.getByText("2026年8月3日")).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Token 用量明细" })).toBeInTheDocument();
    expect(screen.getByRole("rowheader", { name: "Tokens" }).parentElement).toHaveTextContent("160");
    expect(screen.getByRole("rowheader", { name: "Tokens" }).parentElement).toHaveTextContent("100");
    expect(screen.getByRole("rowheader", { name: "Tokens" }).parentElement).toHaveTextContent("60");
    expect(screen.getByRole("rowheader", { name: "缓存输入 Token" }).parentElement).toHaveTextContent("40");
    expect(screen.getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual([
      "总计",
      "经过 Flowlet",
      "Agent 原生",
    ]);
  });

  it("uses the standard detail drawer width on desktop", () => {
    render(
      <UsageTokenDetailSheet
        visible
        onClose={vi.fn()}
        contextLabel="2026年8月3日"
        language="zh-CN"
        t={(source) => source}
        details={{
          total: column(160, 40, 6),
          flowlet: column(100, 30, 4),
          native: column(60, 10, 2),
        }}
      />,
    );

    expect(screen.getByTestId("desktop-sheet")).toHaveAttribute("data-placement", "right");
    expect(screen.getByTestId("desktop-sheet")).toHaveAttribute("data-width", "min(760px, 96vw)");
  });
});

function column(total: number, cachedInput: number, requests: number) {
  return {
    total,
    input: total - 20,
    cachedInput,
    cacheWriteInput: 5,
    uncachedInput: total - cachedInput - 20,
    output: 20,
    reasoning: 3,
    requests,
    unknownUsageCount: 0,
    cacheHitRate: 0.5,
  };
}
