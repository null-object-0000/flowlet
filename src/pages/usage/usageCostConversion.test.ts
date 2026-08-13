import { describe, expect, it } from "vitest";
import type { UsageSummaryRow } from "../../domains/usage/types";
import { summarizeConvertedUsageCost } from "./usageCostConversion";

function row(cost: number, currency: string, native = false): UsageSummaryRow {
  return {
    date: "2026-08-13",
    client_id: null,
    client_name: null,
    channel_id: native ? "agent-native" : "longcat",
    channel_name: null,
    account_id: null,
    account_name: null,
    upstream_model: "model",
    request_count: native ? 0 : 1,
    known_tokens: 1,
    input_tokens: 1,
    input_cached_tokens: 0,
    input_uncached_tokens: 1,
    cache_measured_input_tokens: 1,
    output_tokens: 0,
    unknown_count: 0,
    estimated_cost: cost,
    estimated_cost_currency: currency,
    elapsed_total_ms: 0,
    elapsed_measured_count: 0,
    generation_total_ms: 0,
    generation_output_tokens: 0,
    device_id: "device",
  };
}

describe("usage cost conversion", () => {
  it("adds Flowlet and native API-equivalent values after converting to CNY", () => {
    expect(summarizeConvertedUsageCost(
      [row(10, "CNY"), row(2, "USD", true)],
      { currency_conversion_enabled: true, display_currency: "CNY", usd_to_cny_rate: 7.2, exchange_rate_note: "" },
      (value) => value.estimated_cost_currency ?? null,
    )).toEqual({
      total: 24.4,
      flowlet: 10,
      native: 14.4,
      flowletOriginalByCurrency: { CNY: 10 },
      nativeOriginalByCurrency: { USD: 2 },
      currency: "CNY",
      unsupportedCurrencies: [],
    });
  });

  it("does not silently mix currencies when conversion is disabled", () => {
    expect(summarizeConvertedUsageCost(
      [row(10, "CNY"), row(2, "USD", true)],
      { currency_conversion_enabled: false, display_currency: "CNY", usd_to_cny_rate: 7.2, exchange_rate_note: "" },
      (value) => value.estimated_cost_currency ?? null,
    )).toEqual({
      total: 10,
      flowlet: 10,
      native: 0,
      flowletOriginalByCurrency: { CNY: 10 },
      nativeOriginalByCurrency: { USD: 2 },
      currency: "CNY",
      unsupportedCurrencies: ["USD"],
    });
  });
});
