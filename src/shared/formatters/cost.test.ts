import { describe, expect, it } from "vitest";
import { dominantCostCurrency, formatCostAmount, formatMultiCurrencyCost, formatNativeCost } from "./cost";

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

describe("formatMultiCurrencyCost", () => {
  it("falls back to a plain zero amount for empty splits", () => {
    expect(formatMultiCurrencyCost({})).toBe("0.00");
    expect(formatMultiCurrencyCost({ CNY: 0 })).toBe("0.00");
  });

  it("renders a single currency with its own symbol", () => {
    expect(formatMultiCurrencyCost({ CNY: 12.345 })).toBe("¥12.35");
    expect(formatMultiCurrencyCost({ USD: 1.2 })).toBe("$1.20");
  });

  it("orders mixed currencies CNY, USD, CREDITS, then unresolvable", () => {
    expect(formatMultiCurrencyCost({ USD: 5.6, CREDITS: 9, CNY: 1.2, "": 3.4 }))
      .toBe("¥1.20 + $5.60 + 9.00 credits + 3.40");
  });
});

describe("dominantCostCurrency", () => {
  it("picks the currency contributing the largest cost", () => {
    expect(dominantCostCurrency({ CNY: 2, USD: 9 })).toBe("USD");
  });

  it("returns null for empty or non-positive splits", () => {
    expect(dominantCostCurrency({})).toBeNull();
    expect(dominantCostCurrency({ CNY: 0 })).toBeNull();
  });

  it("treats unresolvable currencies as null even when dominant", () => {
    expect(dominantCostCurrency({ "": 5, CNY: 1 })).toBeNull();
  });
});
