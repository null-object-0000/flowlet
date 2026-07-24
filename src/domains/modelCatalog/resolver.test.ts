import { describe, expect, it } from "vitest";
import { resolveChannelModel } from "./resolver";
import type { ModelsCnCatalog } from "./types";

function makeCatalog(): ModelsCnCatalog {
  return {
    schemaVersion: "1.0",
    providers: [
      {
        schemaVersion: "1.0",
        health: { status: "healthy", lastSuccessfulAt: "", lastAttemptAt: "", consecutiveFailures: 0 },
        id: "deepseek",
        name: "DeepSeek",
        ownedBy: "deepseek",
        models: [
          {
            id: "deepseek-v4-flash",
            name: "DeepSeek-V4-Flash",
            aliases: [{ id: "deepseek-chat", mode: "non-thinking" }],
            capabilities: { thinking: true, toolCalls: true, jsonOutput: true },
            limits: { contextTokens: 1_000_000, maxOutputTokens: 384_000 },
            prices: [
              { market: "china", currency: "CNY", unit: "1M_tokens", rateType: "standard", input: { standard: 1, cacheHit: 0.02 }, output: 2, sourceUrl: "https://deepseek.com/pricing" },
            ],
          },
        ],
        sources: [{ url: "https://deepseek.com", kind: "pricing", locale: "zh-CN", retrievedAt: "2026-07-22T00:00:00Z", contentHash: "sha256:x" }],
      },
      {
        schemaVersion: "1.0",
        health: { status: "healthy", lastSuccessfulAt: "", lastAttemptAt: "", consecutiveFailures: 0 },
        id: "moonshot-cn",
        name: "Kimi China",
        ownedBy: "moonshot",
        models: [
          {
            id: "kimi-k3",
            name: "Kimi-K3",
            aliases: [],
            capabilities: { thinking: true, toolCalls: true },
            limits: { contextTokens: 262_144 },
            prices: [
              { market: "china", currency: "CNY", unit: "1M_tokens", rateType: "standard", input: { standard: 20, cacheHit: 2 }, output: 100, sourceUrl: "https://kimi.com/pricing" },
            ],
          },
        ],
        sources: [{ url: "https://kimi.com", kind: "pricing", locale: "zh-CN", retrievedAt: "2026-07-22T00:00:00Z", contentHash: "sha256:x" }],
      },
    ],
    inventories: [],
    calibration: { modelsDev: { models: [] } },
  };
}

describe("resolveChannelModel", () => {
  it("maps deepseek channel to deepseek provider", () => {
    const resolved = resolveChannelModel(makeCatalog(), "deepseek", "deepseek-v4-flash");
    expect(resolved).not.toBeNull();
    expect(resolved?.providerId).toBe("deepseek");
    expect(resolved?.limits.contextTokens).toBe(1_000_000);
    expect(resolved?.officialPrice?.currency).toBe("CNY");
  });

  it("maps kimi channel to moonshot-cn provider", () => {
    const resolved = resolveChannelModel(makeCatalog(), "kimi", "kimi-k3");
    expect(resolved?.providerId).toBe("moonshot-cn");
  });

  it("returns null for unknown channel", () => {
    expect(resolveChannelModel(makeCatalog(), "unknown", "x")).toBeNull();
  });

  it("returns null when model not found", () => {
    expect(resolveChannelModel(makeCatalog(), "deepseek", "missing")).toBeNull();
  });

  it("marks supplemented when limits missing", () => {
    const catalog = makeCatalog();
    catalog.providers[0].models[0].limits = undefined;
    const resolved = resolveChannelModel(catalog, "deepseek", "deepseek-v4-flash");
    expect(resolved?.supplementedFromModelsDev).toBe(true);
  });
});
