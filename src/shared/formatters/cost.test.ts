import { describe, expect, it } from "vitest";
import { formatCostAmount, formatNativeCost } from "./cost";

describe("formatNativeCost", () => {
  it("formats Codex native estimates in credits", () => {
    expect(formatNativeCost({ cost: 1.23456, costCurrency: "CREDITS" }, 4)).toBe("1.2346 credits");
  });

  it("keeps actual native currency values distinct", () => {
    expect(formatNativeCost({ cost: 0.25, costCurrency: "USD" }, 4)).toBe("$0.2500");
  });

  it("does not invent a missing cost", () => {
    expect(formatNativeCost({ cost: null, costCurrency: null })).toBe("—");
  });

  it("keeps API equivalent values in their original currency", () => {
    expect(formatCostAmount({ amount: 3.2, currency: "USD" }, 2)).toBe("$3.20");
    expect(formatCostAmount({ amount: 3.2, currency: "CNY" }, 2)).toBe("¥3.20");
  });
});
