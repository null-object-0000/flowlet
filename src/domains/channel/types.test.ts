import { describe, expect, it } from "vitest";
import type { ChannelPreset } from "./types";
import {
  canonicalModelId,
  canonicalModelKey,
  defaultExposedModels,
  stripAggregateVendorPrefix,
} from "./types";

describe("stripAggregateVendorPrefix", () => {
  it("strips the vendor namespace of aggregate-channel model IDs", () => {
    expect(stripAggregateVendorPrefix("deepseek/deepseek-v4-flash")).toBe("deepseek-v4-flash");
    expect(stripAggregateVendorPrefix("z-ai/glm-5.2")).toBe("glm-5.2");
    expect(stripAggregateVendorPrefix("moonshotai/kimi-k3")).toBe("kimi-k3");
  });

  it("keeps plain model IDs unchanged and handles null/blank input", () => {
    expect(stripAggregateVendorPrefix("deepseek-v4-flash")).toBe("deepseek-v4-flash");
    expect(stripAggregateVendorPrefix("")).toBe("");
    expect(stripAggregateVendorPrefix("  ")).toBe("");
  });
});

describe("canonicalModelKey with aggregate vendor prefix", () => {
  it("maps vendor-prefixed IDs to whitelist canonical keys", () => {
    expect(canonicalModelKey("deepseek/deepseek-v4-flash")).toBe("deepseek-v4-flash");
    expect(canonicalModelKey("qwen/qwen3.7-max")).toBe("qwen3.7-max");
    expect(canonicalModelKey("z-ai/glm-5.2")).toBe("glm-5.2");
    expect(canonicalModelKey("stealth/ox-alpha")).toBe("ox-alpha");
    expect(canonicalModelId("deepseek/deepseek-v4-flash")).toBe("deepseek-v4-flash");
    expect(canonicalModelId("stealth/ox-alpha")).toBe("ox-alpha");
    expect(canonicalModelId("openai/gpt-5.5")).toBeNull();
  });

  it("still resolves alias variants after stripping the vendor prefix", () => {
    expect(canonicalModelKey("deepseek/deepseek-v4-flash-0731")).toBe("deepseek-v4-flash");
  });

  it("keeps plain whitelist model IDs unchanged", () => {
    expect(canonicalModelKey("deepseek-v4-flash")).toBe("deepseek-v4-flash");
  });
});

describe("defaultExposedModels", () => {
  it("does not default OpenRouter to the whole whitelist — users select explicitly", () => {
    // OpenRouter 与普通渠道一致：默认开放模型取预设 default_model（无则空），
    // 开放哪些模型由用户在账号编辑器中拉取 /models 后显式勾选。
    const openrouterPreset: ChannelPreset = {
      id: "openrouter",
      name: "OpenRouter",
      vendor: "openrouter",
      supported_protocols: ["openai", "anthropic"],
      default_model: "deepseek-v4-flash",
      small_model: null,
      platform_url: null,
      supports_model_list: true,
      supports_model_detail: false,
      supports_balance_query: false,
      supports_quota_query: false,
      supports_usage_query: false,
      supports_scrape_balance: false,
      openai_base_url: "https://openrouter.ai/api/v1",
      anthropic_base_url: "https://openrouter.ai/api",
      openai_auth: "bearer",
      anthropic_auth: "bearer",
      created_at: "",
      updated_at: "",
    };
    expect(defaultExposedModels(openrouterPreset)).toEqual(["deepseek-v4-flash"]);
  });
});
