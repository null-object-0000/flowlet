import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXPOSED_MODELS_BY_CHANNEL,
  FLOWLET_SUPPORTED_MODELS,
  canonicalModelId,
  modelsCnProviderIdForModel,
  officialChannelIdForModel,
} from "./identity";

describe("model identity catalog", () => {
  it("provides the complete supported-model whitelist without duplicates", () => {
    expect(FLOWLET_SUPPORTED_MODELS).toHaveLength(14);
    expect(new Set(FLOWLET_SUPPORTED_MODELS.map((model) => model.toLowerCase())).size).toBe(14);
    expect(FLOWLET_SUPPORTED_MODELS).toContain("LongCat-2.0");
    expect(FLOWLET_SUPPORTED_MODELS).toContain("glm-4.5-air");
  });

  it("derives owner defaults and models-cn providers from the same identity", () => {
    expect(DEFAULT_EXPOSED_MODELS_BY_CHANNEL.deepseek).toEqual([
      "deepseek-v4-flash",
      "deepseek-v4-pro",
    ]);
    expect(officialChannelIdForModel("z-ai/glm-5.2")).toBe("zhipu");
    expect(modelsCnProviderIdForModel("kimi-k3")).toBe("moonshot-cn");
  });

  it("normalizes aliases while preserving the canonical display ID", () => {
    expect(canonicalModelId("deepseek/deepseek-v4-flash-0731")).toBe("deepseek-v4-flash");
    expect(canonicalModelId("unknown/model")).toBeNull();
  });
});
