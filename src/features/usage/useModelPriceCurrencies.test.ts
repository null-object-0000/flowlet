import { describe, expect, it } from "vitest";
import type { UsageSummaryRow } from "../../domains/usage/types";
import { buildModelPriceCurrencyLookup } from "./useModelPriceCurrencies";

function row(partial: Partial<UsageSummaryRow>): UsageSummaryRow {
  return {
    date: "2026-08-01",
    client_id: null,
    client_name: null,
    channel_id: null,
    channel_name: null,
    account_id: null,
    account_name: null,
    upstream_model: null,
    request_count: 1,
    known_tokens: 0,
    input_tokens: 0,
    input_cached_tokens: 0,
    input_uncached_tokens: 0,
    cache_measured_input_tokens: 0,
    output_tokens: 0,
    unknown_count: 0,
    estimated_cost: 0,
    elapsed_total_ms: 0,
    elapsed_measured_count: 0,
    generation_total_ms: 0,
    generation_output_tokens: 0,
    device_id: null,
    ...partial,
  };
}

describe("buildModelPriceCurrencyLookup", () => {
  it("resolves currency by model name only, ignoring the row's routing channel", () => {
    // models-cn 返回 deepseek:deepseek-v4-flash → CNY；模型被 Qwen 渠道承载也应命中。
    const lookup = buildModelPriceCurrencyLookup([["deepseek:deepseek-v4-flash", "CNY"]]);
    const qwenRow = row({ channel_id: "qwen", channel_name: "Qwen", upstream_model: "deepseek-v4-flash" });
    expect(lookup.modelCurrencyOf(qwenRow)).toBe("CNY");
  });

  it("resolves an alias variant to its canonical model in the catalog", () => {
    const lookup = buildModelPriceCurrencyLookup([["deepseek:deepseek-v4-flash", "CNY"]]);
    const aliasRow = row({ channel_id: "qwen", upstream_model: "deepseek-v4-flash-0731" });
    expect(lookup.modelCurrencyOf(aliasRow)).toBe("CNY");
  });

  it("resolves the raw upstream name when present in the catalog", () => {
    const lookup = buildModelPriceCurrencyLookup([["qwen:deepseek-v4-flash-0731", "USD"]]);
    const aliasRow = row({ channel_id: "qwen", upstream_model: "deepseek-v4-flash-0731" });
    expect(lookup.modelCurrencyOf(aliasRow)).toBe("USD");
  });

  it("prefers the backend-declared currency over the catalog", () => {
    const lookup = buildModelPriceCurrencyLookup([["longcat:LongCat-2.0", "CNY"]]);
    const nativeRow = row({
      channel_id: "agent-native",
      upstream_model: "LongCat-2.0",
      estimated_cost_currency: "USD",
    });
    expect(lookup.modelCurrencyOf(nativeRow)).toBe("USD");
  });

  it("falls back to default CNY when the catalog is missing the model or empty", () => {
    const empty = buildModelPriceCurrencyLookup([]);
    expect(empty.modelCurrencyOf(row({ channel_id: "qwen", upstream_model: "deepseek-v4-flash" })))
      .toBe("CNY");

    const missing = buildModelPriceCurrencyLookup([["longcat:LongCat-2.0", "CNY"]]);
    expect(missing.modelCurrencyOf(row({ channel_id: "qwen", upstream_model: "some-unlisted-model" })))
      .toBe("CNY");
  });

  it("falls back to default CNY when the row carries no model name", () => {
    const lookup = buildModelPriceCurrencyLookup([["longcat:LongCat-2.0", "CNY"]]);
    expect(lookup.modelCurrencyOf(row({ channel_id: "longcat" }))).toBe("CNY");
  });

  it("resolves channel-level currency for channel-only aggregates", () => {
    const lookup = buildModelPriceCurrencyLookup([
      ["deepseek:deepseek-v4-pro", "CNY"],
      ["longcat:LongCat-2.0", "CNY"],
      ["custom:gpt-5-mini", "USD"],
    ]);
    expect(lookup.channelCurrencyOf(row({ channel_id: "deepseek" }))).toBe("CNY");
    expect(lookup.channelCurrencyOf(row({ channel_id: "custom" }))).toBe("USD");
    expect(lookup.channelCurrencyOf(row({ channel_id: "unlisted-channel" }))).toBe("CNY");
  });
});
