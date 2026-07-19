import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@douyinfe/semi-ui-19", () => ({
  Tooltip: ({ children, content }: { children: ReactNode; content: ReactNode }) => <>{children}{content}</>,
}));

import { TokenBreakdownTooltip } from "./TokenBreakdownTooltip";

describe("TokenBreakdownTooltip", () => {
  it("renders the shared token breakdown and missing-detail count", () => {
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
          unknownUsageCount: 1,
        }}
      >
        <span>1,200</span>
      </TokenBreakdownTooltip>,
    );

    expect(screen.getByText(/总 Token/)).toHaveTextContent("1,200");
    expect(screen.getByText("缓存输入 Token").parentElement).toHaveTextContent("400");
    expect(screen.getByText("未缓存输入 Token").parentElement).toHaveTextContent("600");
    expect(screen.getByText("输出 Token").parentElement).toHaveTextContent("200");
    expect(screen.getByText("缓存命中率").parentElement).toHaveTextContent("50.0%");
    expect(screen.getByText("无 Token 明细请求").parentElement).toHaveTextContent("1");
  });
});
