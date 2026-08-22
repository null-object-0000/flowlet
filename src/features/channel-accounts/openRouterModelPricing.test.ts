import { describe, expect, it } from "vitest";
import { isFreeModelPricing, modelCandidateSortRank, type ModelCandidate } from "./openRouterModelPricing";

describe("OpenRouter model pricing", () => {
  it("treats a model as free only when every declared charge is zero", () => {
    expect(isFreeModelPricing({
      prompt: "0",
      completion: "0.000000",
      request: "0",
      image: "0",
    })).toBe(true);
    expect(isFreeModelPricing({ prompt: "0", completion: "0.000001" })).toBe(false);
    expect(isFreeModelPricing({ prompt: "0", completion: "0", web_search: "0.01" })).toBe(false);
    expect(isFreeModelPricing(null)).toBe(false);
    expect(isFreeModelPricing({ prompt: "unknown", completion: "0" })).toBe(false);
  });

  it("requires every tier to remain free", () => {
    expect(isFreeModelPricing([
      { prompt: "0", completion: "0" },
      { min_context: 200_000, prompt: "0", completion: "0" },
    ])).toBe(true);
    expect(isFreeModelPricing([
      { prompt: "0", completion: "0" },
      { min_context: 200_000, prompt: "0.1", completion: "0" },
    ])).toBe(false);
  });

  it("orders candidates by free and supported status", () => {
    const free = { prompt: "0", completion: "0" };
    const paid = { prompt: "0.1", completion: "0.2" };
    const candidates: Array<ModelCandidate & { supported: boolean }> = [
      { model: "paid-unsupported", pricing: paid, supported: false },
      { model: "free-unsupported", pricing: free, supported: false },
      { model: "paid-supported", pricing: paid, supported: true },
      { model: "free-supported", pricing: free, supported: true },
    ];

    candidates.sort((a, b) => (
      modelCandidateSortRank(a, a.supported) - modelCandidateSortRank(b, b.supported)
    ));

    expect(candidates.map((candidate) => candidate.model)).toEqual([
      "free-supported",
      "paid-supported",
      "free-unsupported",
      "paid-unsupported",
    ]);
  });
});
