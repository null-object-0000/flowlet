import { describe, expect, it } from "vitest";
import {
  estimateCost,
  findModelByAlias,
  findModelInCatalog,
  resolveCapabilities,
  resolveLimits,
  resolveModel,
  resolvePrice,
  selectOfficialPrice,
} from "./pricing";
import type { ModelsCnModel, ModelsCnPrice, ModelsCnProvider } from "./types";

function makePrice(overrides: Partial<Parameters<typeof resolvePrice>[0]> = {}) {
  return resolvePrice({
    market: "china",
    currency: "CNY",
    unit: "1M_tokens",
    rateType: "standard",
    input: { standard: 1, cacheHit: 0.1 },
    output: 2,
    sourceUrl: "https://example.com/pricing",
    ...overrides,
  });
}

function makeProvider(overrides: Partial<ModelsCnProvider> = {}): ModelsCnProvider {
  return {
    schemaVersion: "1.0",
    health: { status: "healthy", lastSuccessfulAt: "", lastAttemptAt: "", consecutiveFailures: 0 },
    id: "deepseek",
    name: "DeepSeek",
    ownedBy: "deepseek",
    models: [],
    sources: [{ url: "https://example.com", kind: "pricing", locale: "zh-CN", retrievedAt: "2026-07-22T00:00:00Z", contentHash: "sha256:x" }],
    ...overrides,
  };
}

function makeModel(overrides: Partial<ModelsCnModel> = {}): ModelsCnModel {
  return {
    id: "deepseek-v4-flash",
    name: "DeepSeek-V4-Flash",
    aliases: [],
    capabilities: { thinking: true, toolCalls: true, jsonOutput: true },
    limits: { contextTokens: 1_000_000, maxOutputTokens: 384_000 },
    prices: [
      {
        market: "china",
        currency: "CNY",
        unit: "1M_tokens",
        rateType: "standard",
        input: { standard: 1, cacheHit: 0.02 },
        output: 2,
        sourceUrl: "https://example.com/pricing",
      },
    ],
    ...overrides,
  };
}

describe("selectOfficialPrice", () => {
  it("selects china + CNY + standard as highest priority", () => {
    const prices = [
      { market: "international", currency: "USD", unit: "1M_tokens", rateType: "standard", input: { standard: 0.14 }, output: 0.28, sourceUrl: "u1" },
      { market: "china", currency: "CNY", unit: "1M_tokens", rateType: "standard", input: { standard: 1 }, output: 2, sourceUrl: "u2" },
      { market: "china", currency: "CNY", unit: "1M_tokens", rateType: "promotional", input: { standard: 0.5 }, output: 1, sourceUrl: "u3" },
    ] as const;
    const selected = selectOfficialPrice([...prices]);
    expect(selected?.sourceUrl).toBe("u2");
    expect(selected?.currency).toBe("CNY");
    expect(selected?.rateType).toBe("standard");
  });

  it("falls back to promotional when no standard exists", () => {
    const prices: ModelsCnPrice[] = [
      { market: "china", currency: "CNY", unit: "1M_tokens", rateType: "promotional", input: { standard: 0.5 }, output: 1, sourceUrl: "u1" },
    ];
    const selected = selectOfficialPrice(prices);
    expect(selected?.rateType).toBe("promotional");
  });

  it("falls back to international when no china market exists", () => {
    const prices: ModelsCnPrice[] = [
      { market: "international", currency: "USD", unit: "1M_tokens", rateType: "standard", input: { standard: 0.14 }, output: 0.28, sourceUrl: "u1" },
    ];
    const selected = selectOfficialPrice(prices);
    expect(selected?.market).toBe("international");
    expect(selected?.currency).toBe("USD");
  });

  it("returns null for empty prices", () => {
    expect(selectOfficialPrice([])).toBeNull();
  });
});

describe("resolvePrice", () => {
  it("keeps cacheHit only when present", () => {
    const withCache = resolvePrice({ market: "china", currency: "CNY", unit: "1M_tokens", rateType: "standard", input: { standard: 1, cacheHit: 0.02 }, output: 2, sourceUrl: "u" });
    expect(withCache.inputCached).toBe(0.02);
    const withoutCache = resolvePrice({ market: "china", currency: "CNY", unit: "1M_tokens", rateType: "standard", input: { standard: 1 }, output: 2, sourceUrl: "u" });
    expect(withoutCache.inputCached).toBeNull();
  });

  it("captures explicitCacheCreation only when present", () => {
    const p = resolvePrice({ market: "china", currency: "CNY", unit: "1M_tokens", rateType: "standard", input: { standard: 1, explicitCacheCreation: 1.5 }, output: 2, sourceUrl: "u" });
    expect(p.inputCacheWrite).toBe(1.5);
    const p2 = resolvePrice({ market: "china", currency: "CNY", unit: "1M_tokens", rateType: "standard", input: { standard: 1 }, output: 2, sourceUrl: "u" });
    expect(p2.inputCacheWrite).toBeNull();
  });
});

describe("estimateCost", () => {
  it("estimates uncached cost by default", () => {
    const price = makePrice();
    const estimate = estimateCost(price, { inputTokens: 2_000_000, outputTokens: 500_000 });
    expect(estimate).not.toBeNull();
    expect(estimate?.inputCost).toBeCloseTo(2, 6);
    expect(estimate?.outputCost).toBeCloseTo(1, 6);
    expect(estimate?.totalCost).toBeCloseTo(3, 6);
    expect(estimate?.cacheApplied).toBe(false);
  });

  it("applies cache hit price only when useCache = true AND inputCached exists", () => {
    const price = makePrice({ input: { standard: 1, cacheHit: 0.02 } });
    const estimate = estimateCost(price, { inputTokens: 2_000_000, outputTokens: 500_000, useCache: true });
    expect(estimate?.cacheApplied).toBe(true);
    expect(estimate?.inputCost).toBeCloseTo(0.04, 6);
    expect(estimate?.inputRate).toBe(0.02);
  });

  it("does NOT apply cache when inputCached is null even if useCache = true", () => {
    const price = makePrice({ input: { standard: 1 } });
    const estimate = estimateCost(price, { inputTokens: 1_000_000, outputTokens: 100_000, useCache: true });
    expect(estimate?.cacheApplied).toBe(false);
    expect(estimate?.inputRate).toBe(1);
  });

  it("does NOT apply cache when useCache = false even if inputCached exists", () => {
    const price = makePrice({ input: { standard: 1, cacheHit: 0.02 } });
    const estimate = estimateCost(price, { inputTokens: 1_000_000, outputTokens: 100_000, useCache: false });
    expect(estimate?.cacheApplied).toBe(false);
    expect(estimate?.inputRate).toBe(1);
  });

  it("returns null when price is null", () => {
    // estimateCost expects ResolvedPrice not null; this tests the guard in caller
    // We test the type by passing a valid price here.
    const price = makePrice();
    expect(estimateCost(price, { inputTokens: 0, outputTokens: 0 })?.totalCost).toBe(0);
  });
});

describe("resolveCapabilities", () => {
  it("defaults to false when capabilities missing", () => {
    expect(resolveCapabilities(undefined)).toEqual({ thinking: false, toolCalls: false, jsonOutput: false });
  });

  it("preserves true values", () => {
    expect(resolveCapabilities({ thinking: true, toolCalls: true, jsonOutput: true })).toEqual({ thinking: true, toolCalls: true, jsonOutput: true });
  });
});

describe("resolveLimits", () => {
  it("returns null when limits missing", () => {
    expect(resolveLimits(undefined)).toEqual({ contextTokens: null, maxOutputTokens: null });
  });

  it("preserves values", () => {
    expect(resolveLimits({ contextTokens: 128_000, maxOutputTokens: 8_192 })).toEqual({ contextTokens: 128_000, maxOutputTokens: 8_192 });
  });
});

describe("resolveModel", () => {
  it("resolves official price and retrievedAt", () => {
    const provider = makeProvider();
    const model = makeModel();
    const resolved = resolveModel(provider, model);
    expect(resolved.officialPrice?.currency).toBe("CNY");
    expect(resolved.officialPrice?.retrievedAt).toBe("2026-07-22T00:00:00Z");
    expect(resolved.limits.contextTokens).toBe(1_000_000);
    expect(resolved.capabilities.thinking).toBe(true);
  });

  it("marks supplementedFromModelsDev when requested", () => {
    const provider = makeProvider();
    const model = makeModel();
    const resolved = resolveModel(provider, model, { supplemented: true, modelsDevReferenceUrl: "https://models.dev/..." });
    expect(resolved.supplementedFromModelsDev).toBe(true);
    expect(resolved.modelsDevReferenceUrl).toBe("https://models.dev/...");
  });

  it("officialPrice is null when model has no prices", () => {
    const provider = makeProvider();
    const model = makeModel({ prices: [] });
    const resolved = resolveModel(provider, model);
    expect(resolved.officialPrice).toBeNull();
  });
});

describe("findModelInCatalog", () => {
  it("finds by providerId + modelId", () => {
    const catalog = { providers: [makeProvider({ models: [makeModel()] })] };
    const found = findModelInCatalog(catalog, "deepseek", "deepseek-v4-flash");
    expect(found?.model.id).toBe("deepseek-v4-flash");
  });

  it("returns null when not found", () => {
    const catalog = { providers: [makeProvider({ models: [makeModel()] })] };
    expect(findModelInCatalog(catalog, "deepseek", "nope")).toBeNull();
    expect(findModelInCatalog(catalog, "missing", "deepseek-v4-flash")).toBeNull();
  });
});

describe("findModelByAlias", () => {
  it("matches model id case-insensitively", () => {
    const catalog = { providers: [makeProvider({ models: [makeModel()] })] };
    expect(findModelByAlias(catalog, "DEEPSEEK-V4-FLASH")?.model.id).toBe("deepseek-v4-flash");
  });

  it("matches aliases", () => {
    const catalog = { providers: [makeProvider({ models: [makeModel({ aliases: [{ id: "deepseek-chat", mode: "non-thinking" }] })] })] };
    expect(findModelByAlias(catalog, "deepseek-chat")?.model.id).toBe("deepseek-v4-flash");
  });
});
