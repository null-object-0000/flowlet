import { describe, expect, it } from "vitest";
import { resolveChannelModel, resolveModelSpecification } from "./resolver";
import type { ModelsCnCatalog, ModelsDevCatalog } from "./types";

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
            capabilities: {
              thinking: true,
              toolCalls: true,
              jsonOutput: true,
              inputModalities: ["text", "image"],
              outputModalities: ["text"],
            },
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

function makeModelsDevCatalog(): ModelsDevCatalog {
  return {
    openrouter: {
      id: "openrouter",
      name: "OpenRouter",
      models: {
        "stealth/ox-alpha": {
          id: "stealth/ox-alpha",
          name: "Ox Alpha from models.dev",
          description: "models.dev description",
          reasoning: true,
          tool_call: true,
          structured_output: false,
          modalities: { input: ["text", "image"], output: ["text"] },
          limit: { context: 900_000, output: 120_000 },
        },
      },
    },
  };
}

describe("resolveChannelModel", () => {
  it("maps deepseek channel to deepseek provider", () => {
    const resolved = resolveChannelModel(makeCatalog(), "deepseek", "deepseek-v4-flash");
    expect(resolved).not.toBeNull();
    expect(resolved?.providerId).toBe("deepseek");
    expect(resolved?.limits.contextTokens).toBe(1_000_000);
    expect(resolved?.capabilities.inputModalities).toEqual(["text", "image"]);
    expect(resolved?.capabilities.outputModalities).toEqual(["text"]);
    expect(resolved?.officialPrice?.currency).toBe("CNY");
  });

  it("maps kimi channel to moonshot-cn provider", () => {
    const resolved = resolveChannelModel(makeCatalog(), "kimi", "kimi-k3");
    expect(resolved?.providerId).toBe("moonshot-cn");
  });

  it("resolves a model carried by a custom channel through its official owner", () => {
    const resolved = resolveChannelModel(makeCatalog(), "custom", "deepseek-v4-flash");
    expect(resolved?.providerId).toBe("deepseek");
    expect(resolved?.modelId).toBe("deepseek-v4-flash");
  });

  it("resolves an alias variant upstream model through its canonical model", () => {
    // 千问 Token Plan 账号的路由 upstream_model 保留上游原名 deepseek-v4-flash-0731，
    // 规格与基准价格仍按规范模型 deepseek-v4-flash 的官方归属解析。
    const resolved = resolveChannelModel(makeCatalog(), "qwen", "deepseek-v4-flash-0731");
    expect(resolved?.providerId).toBe("deepseek");
    expect(resolved?.modelId).toBe("deepseek-v4-flash");
    expect(resolved?.officialPrice?.currency).toBe("CNY");
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

describe("resolveModelSpecification", () => {
  it("prefers models-cn over models.dev", () => {
    const resolved = resolveModelSpecification(
      makeCatalog(),
      makeModelsDevCatalog(),
      "openrouter",
      "deepseek-v4-flash",
    );
    expect(resolved?.specificationSource).toBe("models-cn");
    expect(resolved?.limits.contextTokens).toBe(1_000_000);
  });

  it("uses models.dev when models-cn is missing", () => {
    const resolved = resolveModelSpecification(
      makeCatalog(),
      makeModelsDevCatalog(),
      "openrouter",
      "stealth/ox-alpha",
    );
    expect(resolved?.specificationSource).toBe("models.dev");
    expect(resolved?.modelName).toBe("Ox Alpha from models.dev");
    expect(resolved?.limits.contextTokens).toBe(900_000);
  });

  it("returns null when neither catalog contains the model", () => {
    expect(resolveModelSpecification(
      null,
      null,
      "openrouter",
      "stealth/unknown",
    )).toBeNull();
  });

  it("does not use the OpenRouter models.dev provider for another channel", () => {
    expect(resolveModelSpecification(
      null,
      makeModelsDevCatalog(),
      "custom",
      "stealth/ox-alpha",
    )).toBeNull();
  });

  it("waits for models-cn before using models.dev", () => {
    expect(resolveModelSpecification(
      null,
      makeModelsDevCatalog(),
      "openrouter",
      "stealth/ox-alpha",
      undefined,
      false,
    )).toBeNull();
  });
});
