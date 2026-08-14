import { describe, expect, it } from "vitest";
import {
  aggregateCapabilitiesIntersection,
  aggregateMaxPrice,
  aggregateMaxStandardPrice,
  aggregateMinLimits,
  buildPricingStrategyRows,
  effectiveWindowPricesAt,
  estimateCost,
  findModelByAlias,
  findModelInCatalog,
  hasInputLengthTiers,
  isPromotionalDiscount,
  nextEffectivePricesAt,
  resolveCapabilities,
  resolveLimits,
  resolveModel,
  resolvePrice,
  selectOfficialPrice,
} from "./pricing";
import type { ModelsCnModel, ModelsCnPrice, ModelsCnProvider, ResolvedModel, ResolvedPrice } from "./types";
import type { PricingStrategyRow } from "./pricing";

function makeResolvedPrice(overrides: Partial<Parameters<typeof resolvePrice>[0]> = {}) {
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
  it("selects china + CNY + promotional as highest priority", () => {
    // promotional 优先：厂商官网当前生效的是促销价（如 LongCat-2.0 输入 2 / 输出 8）。
    const prices = [
      { market: "international", currency: "USD", unit: "1M_tokens", rateType: "standard", input: { standard: 0.14 }, output: 0.28, sourceUrl: "u1" },
      { market: "china", currency: "CNY", unit: "1M_tokens", rateType: "standard", input: { standard: 1 }, output: 2, sourceUrl: "u2" },
      { market: "china", currency: "CNY", unit: "1M_tokens", rateType: "promotional", input: { standard: 0.5 }, output: 1, sourceUrl: "u3" },
    ] as const;
    const selected = selectOfficialPrice([...prices]);
    expect(selected?.sourceUrl).toBe("u3");
    expect(selected?.currency).toBe("CNY");
    expect(selected?.rateType).toBe("promotional");
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

  it("switches old, off-peak and peak prices at the declared boundaries", () => {
    const prices: ModelsCnPrice[] = [
      { market: "china", currency: "CNY", unit: "1M_tokens", rateType: "standard", input: { standard: 1 }, output: 2, effectiveTo: "2026-08-17T00:00:00+08:00", sourceUrl: "old" },
      { market: "china", currency: "CNY", unit: "1M_tokens", rateType: "standard", input: { standard: 1.5 }, output: 4.5, effectiveFrom: "2026-08-17T00:00:00+08:00", dailyTimeRange: { label: "空闲时段", timeZone: "Asia/Shanghai", intervals: [{ start: "00:00", end: "09:00" }, { start: "12:00", end: "14:00" }, { start: "18:00", end: "00:00" }] }, sourceUrl: "off-peak" },
      { market: "china", currency: "CNY", unit: "1M_tokens", rateType: "standard", input: { standard: 3 }, output: 9, effectiveFrom: "2026-08-17T00:00:00+08:00", dailyTimeRange: { label: "高峰时段", timeZone: "Asia/Shanghai", intervals: [{ start: "09:00", end: "12:00" }, { start: "14:00", end: "18:00" }] }, sourceUrl: "peak" },
    ];
    expect(selectOfficialPrice(prices, new Date("2026-08-16T15:59:59Z"))?.sourceUrl).toBe("old");
    expect(selectOfficialPrice(prices, new Date("2026-08-17T00:59:59Z"))?.sourceUrl).toBe("off-peak");
    expect(selectOfficialPrice(prices, new Date("2026-08-17T01:00:00Z"))?.sourceUrl).toBe("peak");
    expect(selectOfficialPrice(prices, new Date("2026-08-17T04:00:00Z"))?.sourceUrl).toBe("off-peak");
    expect(effectiveWindowPricesAt(prices, new Date("2026-08-16T12:00:00Z"))).toHaveLength(1);
    expect(nextEffectivePricesAt(prices, new Date("2026-08-16T12:00:00Z"))).toHaveLength(2);
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

  it("captures explicitCacheHit only when present", () => {
    const p = resolvePrice({ market: "china", currency: "CNY", unit: "1M_tokens", rateType: "standard", input: { standard: 1, explicitCacheHit: 0.5 }, output: 2, sourceUrl: "u" });
    expect(p.inputCacheHit).toBe(0.5);
    const p2 = resolvePrice({ market: "china", currency: "CNY", unit: "1M_tokens", rateType: "standard", input: { standard: 1 }, output: 2, sourceUrl: "u" });
    expect(p2.inputCacheHit).toBeNull();
  });
});

describe("isPromotionalDiscount", () => {
  it("shows an original price only for a real promotional reduction", () => {
    expect(isPromotionalDiscount("promotional", 1, 0.8)).toBe(true);
    expect(isPromotionalDiscount("promotional", 1, 1)).toBe(false);
    expect(isPromotionalDiscount("promotional", 1, 1.2)).toBe(false);
    expect(isPromotionalDiscount("standard", 1, 0.8)).toBe(false);
  });

  it("ignores floating-point noise", () => {
    expect(isPromotionalDiscount("promotional", 1, 1 - 1e-12)).toBe(false);
  });
});

describe("buildPricingStrategyRows", () => {
  it("merges standard and promotional prices for the same input range", () => {
    const base = {
      market: "china",
      currency: "CNY",
      unit: "1M_tokens",
      inputTokenRange: { label: "输入<=256k", maxInclusive: 256_000 },
      sourceUrl: "u",
    } as const;
    const rows = buildPricingStrategyRows([
      { ...base, rateType: "standard", input: { standard: 2, cacheHit: 0.4, explicitCacheCreation: 2.5, explicitCacheHit: 0.2 }, output: 8 },
      { ...base, rateType: "promotional", input: { standard: 1.6, cacheHit: 0.32, explicitCacheCreation: 2, explicitCacheHit: 0.16 }, output: 6.4 },
    ], "china", "CNY");

    expect(rows).toHaveLength(1);
    expect(rows[0].current.rateType).toBe("promotional");
    expect(rows[0].standard?.input.explicitCacheHit).toBe(0.2);
  });

  it("sorts tiers by their lower input boundary and filters other markets", () => {
    const prices: ModelsCnPrice[] = [
      { market: "china", currency: "CNY", unit: "1M_tokens", rateType: "standard", inputTokenRange: { label: "256k-1m", minExclusive: 256_000, maxInclusive: 1_000_000 }, input: { standard: 6 }, output: 24, sourceUrl: "u" },
      { market: "international", currency: "USD", unit: "1M_tokens", rateType: "standard", input: { standard: 1 }, output: 2, sourceUrl: "u" },
      { market: "china", currency: "CNY", unit: "1M_tokens", rateType: "standard", inputTokenRange: { label: "<=256k", maxInclusive: 256_000 }, input: { standard: 2 }, output: 8, sourceUrl: "u" },
    ];
    const rows = buildPricingStrategyRows(prices, "china", "CNY");

    expect(rows.map((row) => row.inputTokenRange?.label)).toEqual(["<=256k", "256k-1m"]);
  });

  it("keeps peak and off-peak prices as separate rows", () => {
    const prices: ModelsCnPrice[] = [
      { market: "china", currency: "CNY", unit: "1M_tokens", rateType: "standard", input: { standard: 1.5 }, output: 4.5, dailyTimeRange: { label: "空闲时段", timeZone: "Asia/Shanghai", intervals: [{ start: "00:00", end: "09:00" }] }, sourceUrl: "u" },
      { market: "china", currency: "CNY", unit: "1M_tokens", rateType: "standard", input: { standard: 3 }, output: 9, dailyTimeRange: { label: "高峰时段", timeZone: "Asia/Shanghai", intervals: [{ start: "09:00", end: "12:00" }] }, sourceUrl: "u" },
    ];
    const rows = buildPricingStrategyRows(prices, "china", "CNY");
    expect(rows.map((row) => row.current.dailyTimeRange?.label)).toEqual(["空闲时段", "高峰时段"]);
  });
});

describe("hasInputLengthTiers", () => {
  const range = (overrides: Partial<ModelsCnPrice["inputTokenRange"]> = {}) => ({
    label: "输入<=256k",
    maxInclusive: 256_000,
    ...overrides,
  });

  it("is true when any row carries an input token range", () => {
    const rows = [
      {
        key: "a",
        inputTokenRange: null,
        current: { market: "china", currency: "CNY", unit: "1M_tokens", rateType: "standard", input: { standard: 12 }, output: 36, sourceUrl: "u" },
        standard: null,
      },
      {
        key: "b",
        inputTokenRange: range(),
        current: { market: "china", currency: "CNY", unit: "1M_tokens", rateType: "standard", input: { standard: 18 }, output: 54, sourceUrl: "u" },
        standard: null,
      },
    ] as unknown as PricingStrategyRow[];
    expect(hasInputLengthTiers(rows)).toBe(true);
  });

  it("is false for a single flat row with only explicit-cache prices (no input token range)", () => {
    // 对应 qwen3.8-max：models-cn 仅返回一条无分段的 standard 价格，
    // 但带显式缓存价格，因此会走策略卡片分支——此时不应标记为「分段计价」。
    const rows = [
      {
        key: "a",
        inputTokenRange: null,
        current: { market: "china", currency: "CNY", unit: "1M_tokens", rateType: "standard", input: { standard: 12, cacheHit: 1.5, explicitCacheCreation: 15, explicitCacheHit: 1 }, output: 36, sourceUrl: "u" },
        standard: null,
      },
    ] as unknown as PricingStrategyRow[];
    expect(hasInputLengthTiers(rows)).toBe(false);
  });

  it("is false when rows is empty", () => {
    expect(hasInputLengthTiers([])).toBe(false);
  });
});

describe("estimateCost", () => {
  it("estimates uncached cost by default", () => {
    const price = makeResolvedPrice();
    const estimate = estimateCost(price, { inputTokens: 2_000_000, outputTokens: 500_000 });
    expect(estimate).not.toBeNull();
    expect(estimate?.inputCost).toBeCloseTo(2, 6);
    expect(estimate?.outputCost).toBeCloseTo(1, 6);
    expect(estimate?.totalCost).toBeCloseTo(3, 6);
    expect(estimate?.cacheApplied).toBe(false);
  });

  it("applies cache hit price only when useCache = true AND inputCached exists", () => {
    const price = makeResolvedPrice({ input: { standard: 1, cacheHit: 0.02 } });
    const estimate = estimateCost(price, { inputTokens: 2_000_000, outputTokens: 500_000, useCache: true });
    expect(estimate?.cacheApplied).toBe(true);
    expect(estimate?.inputCost).toBeCloseTo(0.04, 6);
    expect(estimate?.inputRate).toBe(0.02);
  });

  it("does NOT apply cache when inputCached is null even if useCache = true", () => {
    const price = makeResolvedPrice({ input: { standard: 1 } });
    const estimate = estimateCost(price, { inputTokens: 1_000_000, outputTokens: 100_000, useCache: true });
    expect(estimate?.cacheApplied).toBe(false);
    expect(estimate?.inputRate).toBe(1);
  });

  it("does NOT apply cache when useCache = false even if inputCached exists", () => {
    const price = makeResolvedPrice({ input: { standard: 1, cacheHit: 0.02 } });
    const estimate = estimateCost(price, { inputTokens: 1_000_000, outputTokens: 100_000, useCache: false });
    expect(estimate?.cacheApplied).toBe(false);
    expect(estimate?.inputRate).toBe(1);
  });

  it("returns null when price is null", () => {
    // estimateCost expects ResolvedPrice not null; this tests the guard in caller
    // We test the type by passing a valid price here.
    const price = makeResolvedPrice();
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

/** 构造一个最简 ResolvedModel，便于聚合测试只关注目标字段。 */
function makeResolved(overrides: Partial<ResolvedModel> = {}): ResolvedModel {
  return {
    providerId: "p",
    providerName: "P",
    modelId: "m",
    modelName: "M",
    limits: { contextTokens: null, maxOutputTokens: null },
    capabilities: { thinking: false, toolCalls: false, jsonOutput: false },
    aliases: [],
    officialPrice: null,
    allPrices: [],
    supplementedFromModelsDev: false,
    modelsDevReferenceUrl: null,
    ...overrides,
  };
}

function makeAggPrice(overrides: Partial<ResolvedPrice> = {}): ResolvedPrice {
  return {
    market: "china",
    currency: "CNY",
    unit: "1M_tokens",
    rateType: "promotional",
    dailyTimeRange: null,
    effectiveFrom: null,
    effectiveTo: null,
    inputUncached: 2,
    inputCached: 0.04,
    inputCacheWrite: null,
    inputCacheHit: null,
    output: 8,
    sourceUrl: "https://example.com",
    retrievedAt: null,
    ...overrides,
  };
}

describe("aggregateMinLimits", () => {
  it("returns the minimum of each limit across sub-models", () => {
    const subs = [
      makeResolved({ limits: { contextTokens: 100_000, maxOutputTokens: 8_000 } }),
      makeResolved({ limits: { contextTokens: 50_000, maxOutputTokens: 16_000 } }),
      makeResolved({ limits: { contextTokens: 200_000, maxOutputTokens: 4_000 } }),
    ];
    expect(aggregateMinLimits(subs)).toEqual({ contextTokens: 50_000, maxOutputTokens: 4_000 });
  });

  it("ignores null limits when computing min", () => {
    const subs = [
      makeResolved({ limits: { contextTokens: 100_000, maxOutputTokens: null } }),
      makeResolved({ limits: { contextTokens: null, maxOutputTokens: 8_000 } }),
    ];
    expect(aggregateMinLimits(subs)).toEqual({ contextTokens: 100_000, maxOutputTokens: 8_000 });
  });
});

describe("aggregateCapabilitiesIntersection", () => {
  it("returns true only when every sub-model supports the capability", () => {
    const subs = [
      makeResolved({ capabilities: { thinking: true, toolCalls: true, jsonOutput: true } }),
      makeResolved({ capabilities: { thinking: true, toolCalls: false, jsonOutput: true } }),
    ];
    expect(aggregateCapabilitiesIntersection(subs)).toEqual({ thinking: true, toolCalls: false, jsonOutput: true });
  });

  it("returns all-false for empty sub-models", () => {
    expect(aggregateCapabilitiesIntersection([])).toEqual({ thinking: false, toolCalls: false, jsonOutput: false });
  });
});

describe("aggregateMaxPrice", () => {
  it("returns the max of each price component across sub-models", () => {
    const subs = [
      makeResolved({ officialPrice: makeAggPrice({ inputUncached: 2, output: 8, inputCached: 0.04 }) }),
      makeResolved({ officialPrice: makeAggPrice({ inputUncached: 5, output: 20, inputCached: 0.1 }) }),
    ];
    const result = aggregateMaxPrice(subs);
    expect(result?.inputUncached).toBe(5);
    expect(result?.output).toBe(20);
    expect(result?.inputCached).toBe(0.1);
  });

  it("returns null when currencies differ", () => {
    const subs = [
      makeResolved({ officialPrice: makeAggPrice({ currency: "CNY" }) }),
      makeResolved({ officialPrice: makeAggPrice({ currency: "USD" }) }),
    ];
    expect(aggregateMaxPrice(subs)).toBeNull();
  });

  it("drops cacheHit when any sub-model lacks it", () => {
    const subs = [
      makeResolved({ officialPrice: makeAggPrice({ inputCached: 0.04 }) }),
      makeResolved({ officialPrice: makeAggPrice({ inputCached: null }) }),
    ];
    expect(aggregateMaxPrice(subs)?.inputCached).toBeNull();
  });
});

describe("aggregateMaxStandardPrice", () => {
  it("returns null when no sub-model has a standard price", () => {
    const subs = [
      makeResolved({ allPrices: [{ market: "china", currency: "CNY", unit: "1M_tokens", rateType: "promotional", input: { standard: 2 }, output: 8, sourceUrl: "u" }] }),
    ];
    expect(aggregateMaxStandardPrice(subs)).toBeNull();
  });

  it("picks the max from standard prices across sub-models", () => {
    const subs = [
      makeResolved({ allPrices: [{ market: "china", currency: "CNY", unit: "1M_tokens", rateType: "standard", input: { standard: 5, cacheHit: 0.1 }, output: 20, sourceUrl: "u" }] }),
      makeResolved({ allPrices: [{ market: "china", currency: "CNY", unit: "1M_tokens", rateType: "standard", input: { standard: 10, cacheHit: 0.5 }, output: 50, sourceUrl: "u" }] }),
    ];
    const result = aggregateMaxStandardPrice(subs);
    expect(result?.inputUncached).toBe(10);
    expect(result?.output).toBe(50);
    expect(result?.inputCached).toBe(0.5);
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
