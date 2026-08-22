import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXPOSED_MODELS_BY_CHANNEL,
  FLOWLET_SUPPORTED_MODELS,
  canonicalModelId,
  modelsCnProviderIdForModel,
  officialChannelIdForModel,
  officialOwnerNameForModel,
} from "./identity";

describe("model identity catalog", () => {
  it("provides the complete supported-model whitelist without duplicates", () => {
    expect(FLOWLET_SUPPORTED_MODELS).toHaveLength(19);
    expect(new Set(FLOWLET_SUPPORTED_MODELS.map((model) => model.toLowerCase())).size).toBe(19);
    expect(FLOWLET_SUPPORTED_MODELS).toContain("LongCat-2.0");
    expect(FLOWLET_SUPPORTED_MODELS).toContain("glm-5.3");
    expect(FLOWLET_SUPPORTED_MODELS).toContain("glm-4.5-air");
    expect(FLOWLET_SUPPORTED_MODELS).toContain("ox-alpha");
    expect(FLOWLET_SUPPORTED_MODELS).toContain("nemotron-3.5-lightning");
    expect(FLOWLET_SUPPORTED_MODELS).toContain("nemotron-3-super-120b-a12b");
    expect(FLOWLET_SUPPORTED_MODELS).toContain("nemotron-3-ultra-550b-a55b");
  });

  it("derives owner defaults and models-cn providers from the same identity", () => {
    expect(DEFAULT_EXPOSED_MODELS_BY_CHANNEL.deepseek).toEqual([
      "deepseek-v4-flash",
      "deepseek-v4-pro",
    ]);
    expect(DEFAULT_EXPOSED_MODELS_BY_CHANNEL.zhipu).toEqual([
      "glm-5.3",
      "glm-5.2",
      "glm-4.7",
      "glm-4.5-air",
    ]);
    expect(officialChannelIdForModel("z-ai/glm-5.3")).toBe("zhipu");
    expect(officialChannelIdForModel("z-ai/glm-5.2")).toBe("zhipu");
    expect(modelsCnProviderIdForModel("kimi-k3")).toBe("moonshot-cn");
    expect(DEFAULT_EXPOSED_MODELS_BY_CHANNEL.openrouter).toEqual([
      "ox-alpha",
      "nemotron-3.5-lightning",
      "nemotron-3-super-120b-a12b",
      "nemotron-3-ultra-550b-a55b",
    ]);
    expect(officialChannelIdForModel("stealth/ox-alpha")).toBe("openrouter");
    expect(officialChannelIdForModel("nvidia/nemotron-3.5-lightning:free")).toBe("openrouter");
    expect(officialOwnerNameForModel("nvidia/nemotron-3.5-lightning:free")).toBe("NVIDIA");
  });

  it("normalizes aliases while preserving the canonical display ID", () => {
    expect(canonicalModelId("deepseek/deepseek-v4-flash-0731")).toBe("deepseek-v4-flash");
    expect(canonicalModelId("stealth/ox-alpha")).toBe("ox-alpha");
    expect(canonicalModelId("nvidia/nemotron-3.5-lightning:free")).toBe("nemotron-3.5-lightning");
    expect(canonicalModelId("nvidia/nemotron-3-super-120b-a12b:free")).toBe("nemotron-3-super-120b-a12b");
    expect(canonicalModelId("nvidia/nemotron-3-ultra-550b-a55b:free")).toBe("nemotron-3-ultra-550b-a55b");
    expect(canonicalModelId("unknown/model")).toBeNull();
  });
});
