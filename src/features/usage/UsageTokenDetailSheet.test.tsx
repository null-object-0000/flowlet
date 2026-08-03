import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@douyinfe/semi-ui-19", () => ({
  SideSheet: ({ children, title, placement }: { children: ReactNode; title: ReactNode; placement: string }) => (
    <section data-testid="sheet" data-placement={placement}><h2>{title}</h2>{children}</section>
  ),
}));

import { UsageTokenDetailSheet } from "./UsageTokenDetailSheet";

describe("UsageTokenDetailSheet", () => {
  it("shows total, Flowlet, and Agent native sections in a bottom sheet on mobile", () => {
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
    expect(screen.getByText("总计").parentElement).toHaveTextContent("160 Tokens");
    expect(screen.getByText("经过 Flowlet").parentElement).toHaveTextContent("100 Tokens");
    expect(screen.getByText("Agent 原生").parentElement).toHaveTextContent("60 Tokens");
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
