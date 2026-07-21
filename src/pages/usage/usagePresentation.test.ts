import { describe, expect, it } from "vitest";
import type { UsageSummaryRow } from "../../domains/usage/types";
import { buildUsageHeatmap, filterUsageRows, groupUsageByChannel, groupUsageByModel, summarizeUsage } from "./usagePresentation";

const rows = [
  { date: "2026-07-15", channel_id: "deepseek", channel_name: "DeepSeek", upstream_model: "deepseek-v4-pro", request_count: 3, known_tokens: 1200, input_tokens: 900, input_cached_tokens: 600, input_uncached_tokens: 300, cache_measured_input_tokens: 900, output_tokens: 300, unknown_count: 1, estimated_cost: 0.12 },
  { date: "2026-07-14", channel_id: "deepseek", channel_name: "DeepSeek", upstream_model: "deepseek-v4-pro", request_count: 2, known_tokens: 800, input_tokens: 600, input_cached_tokens: 300, input_uncached_tokens: 300, cache_measured_input_tokens: 600, output_tokens: 200, unknown_count: 0, estimated_cost: 0.08 },
  { date: "2026-06-30", channel_id: "longcat", channel_name: "LongCat", upstream_model: "LongCat-2.0", request_count: 5, known_tokens: 5000, input_tokens: 4000, input_cached_tokens: 0, input_uncached_tokens: 4000, cache_measured_input_tokens: 4000, output_tokens: 1000, unknown_count: 0, estimated_cost: 0.5 },
] as UsageSummaryRow[];

describe("usage presentation", () => {
  it("filters local summary rows by selected period", () => {
    const now = new Date(2026, 6, 15, 12);
    expect(filterUsageRows(rows, "week", now)).toHaveLength(2);
    expect(filterUsageRows(rows, "month", now)).toHaveLength(2);
    expect(filterUsageRows(rows, "quarter", now)).toHaveLength(2);
    expect(filterUsageRows(rows, "year", now)).toHaveLength(3);
    expect(filterUsageRows(rows, "all", now)).toHaveLength(3);
  });

  it("builds calendar heatmaps for every natural time dimension", () => {
    const now = new Date(2026, 6, 15, 12);
    expect(buildUsageHeatmap(rows, "week", now)).toEqual(expect.objectContaining({ bucketUnit: "day", columns: 7 }));
    expect(buildUsageHeatmap(rows, "month", now).cells.length).toBeGreaterThanOrEqual(35);
    expect(buildUsageHeatmap(rows, "quarter", now).cells.length).toBeGreaterThan(80);
    expect(buildUsageHeatmap(rows, "year", now)).toEqual(expect.objectContaining({ bucketUnit: "day", rows: 7, columns: 53 }));
    expect(buildUsageHeatmap(rows, "all", now)).toEqual(expect.objectContaining({ bucketUnit: "month", columns: 12 }));
  });

  it("aggregates totals and breakdown shares without fixture data", () => {
    const july = rows.slice(0, 2);
    expect(summarizeUsage(july)).toEqual({ cost: 0.2, tokens: 2000, inputTokens: 1500, cachedInputTokens: 900, uncachedInputTokens: 600, cacheMeasuredInputTokens: 1500, outputTokens: 500, requests: 5, unknown: 1, costByCurrency: {} });
    expect(groupUsageByModel(july)[0]).toEqual(expect.objectContaining({ label: "deepseek-v4-pro", share: 1, requests: 5 }));
    expect(groupUsageByChannel(july)[0]).toEqual(expect.objectContaining({ label: "DeepSeek", share: 1, tokens: 2000 }));
  });

  it("attributes the pricing currency to model and channel groups", () => {
    const currencyOf = (row: UsageSummaryRow) => (row.upstream_model === "deepseek-v4-pro" ? "CNY" : null);
    const byModel = groupUsageByModel(rows, currencyOf);
    expect(byModel.find((item) => item.label === "deepseek-v4-pro")?.currency).toBe("CNY");
    expect(byModel.find((item) => item.label === "LongCat-2.0")?.currency).toBeNull();
    const byChannel = groupUsageByChannel(rows, (row) => (row.channel_id === "longcat" ? "CNY" : null));
    expect(byChannel.find((item) => item.label === "LongCat")?.currency).toBe("CNY");
  });

  it("splits summary costs by currency", () => {
    const currencyOf = (row: UsageSummaryRow) => (row.channel_id === "longcat" ? "USD" : "CNY");
    expect(summarizeUsage(rows, currencyOf).costByCurrency).toEqual({ CNY: 0.2, USD: 0.5 });
  });

  it("keeps identical model names from different channels separate for branding", () => {
    const result = groupUsageByModel([
      rows[0],
      { ...rows[0], channel_id: "longcat", channel_name: "LongCat" },
    ]);
    expect(result).toHaveLength(2);
    expect(result.map((item) => item.brandId)).toEqual(expect.arrayContaining(["deepseek", "longcat"]));
  });
});
