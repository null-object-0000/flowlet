import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@douyinfe/semi-ui-19", () => ({
  Tooltip: ({ children, content }: { children: ReactNode; content: ReactNode }) => <>{children}{content}</>,
}));

import { TokenBreakdownTooltip } from "./TokenBreakdownTooltip";

describe("TokenBreakdownTooltip", () => {
  it("renders total and cache hit rate first, then the detailed breakdown", () => {
    render(
      <TokenBreakdownTooltip
        language="zh-CN"
        t={(source) => source}
        label="2026年7月15日"
        tokens={{
          total: 1200,
          input: 1000,
          cachedInput: 400,
          uncachedInput: 600,
          output: 200,
          cacheHitRate: 0.5,
          unknownUsageCount: 1,
        }}
      >
        <span>1,200</span>
      </TokenBreakdownTooltip>,
    );

    expect(screen.getByText(/总消耗 Token/)).toHaveTextContent("1,200");
    expect(screen.getByText("2026年7月15日")).toBeInTheDocument();
    expect(screen.getByText("缓存命中率").parentElement).toHaveTextContent("50.0%");
    expect(screen.getByText("缓存输入 Token").parentElement).toHaveTextContent("400");
    expect(screen.getByText("未缓存输入 Token").parentElement).toHaveTextContent("600");
    expect(screen.getByText("输出 Token").parentElement).toHaveTextContent("200");
    expect(screen.getByText("无 Token 明细请求").parentElement).toHaveTextContent("1");

    // 结构顺序：总消耗 Token → 缓存命中率 → 明细（输入/输出等）。
    const texts = screen.getAllByText(/总消耗 Token|缓存命中率|输入 Token|输出 Token/).map((node) => node.textContent);
    expect(texts).toEqual(["总消耗 Token 1,200", "缓存命中率", "输入 Token", "缓存输入 Token", "未缓存输入 Token", "输出 Token"]);
  });

  it("renders the optional request count when provided", () => {
    render(
      <TokenBreakdownTooltip
        language="zh-CN"
        t={(source) => source}
        tokens={{
          total: 1200,
          input: 1000,
          cachedInput: 400,
          uncachedInput: 600,
          output: 200,
          cacheHitRate: 0.5,
          requests: 827,
        }}
      >
        <span>1,200</span>
      </TokenBreakdownTooltip>,
    );

    expect(screen.getByText("请求量").parentElement).toHaveTextContent("827");
  });

  it("renders Flowlet and Agent native source totals and cached input separately", () => {
    render(
      <TokenBreakdownTooltip
        language="zh-CN"
        t={(source) => source}
        tokens={{
          total: 1200,
          input: 1000,
          cachedInput: 450,
          uncachedInput: 550,
          output: 200,
          cacheHitRate: 0.45,
          sourceBreakdown: {
            flowletTotal: 800,
            nativeTotal: 400,
            flowletCachedInput: 300,
            nativeCachedInput: 150,
          },
        }}
      >
        <span>1,200</span>
      </TokenBreakdownTooltip>,
    );

    expect(screen.getByText("来源拆分")).toBeInTheDocument();
    expect(screen.getByText("Flowlet Token").parentElement).toHaveTextContent("800");
    expect(screen.getByText("Agent 原生 Token").parentElement).toHaveTextContent("400");
    expect(screen.getByText("Flowlet 缓存输入").parentElement).toHaveTextContent("300");
    expect(screen.getByText("Agent 原生缓存输入").parentElement).toHaveTextContent("150");
  });
});
