import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CostBreakdownTooltip } from "./CostBreakdownTooltip";

describe("CostBreakdownTooltip", () => {
  it("shows API-equivalent cost in its original currency with token-based breakdown", async () => {
    render(
      <CostBreakdownTooltip
        total={null}
        currency="CNY"
        apiEquivalent={{
          amount: 12.7288,
          inputUncachedAmount: 10,
          inputCachedAmount: 0.5,
          inputCacheWriteAmount: 0.2288,
          outputAmount: 2,
          currency: "USD",
        }}
        t={(value) => value}
      >
        <span>cost</span>
      </CostBreakdownTooltip>,
    );

    fireEvent.mouseEnter(screen.getByText("cost"));

    expect(await screen.findByText("API 等价价值 $12.7288")).toBeInTheDocument();
    expect(screen.getByText("$10.0000")).toBeInTheDocument();
    expect(screen.getByText("$0.5000")).toBeInTheDocument();
    expect(screen.getByText("$0.2288")).toBeInTheDocument();
    expect(screen.getByText("$2.0000")).toBeInTheDocument();
    expect(screen.queryByText(/¥/)).not.toBeInTheDocument();
  });
});
