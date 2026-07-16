import { describe, expect, it } from "vitest";
import type { UsageSummaryRow } from "../../domains/usage/types";
import { filterUsageRows, groupUsageByChannel, groupUsageByModel, summarizeUsage } from "./usagePresentation";

const rows = [
  { date: "2026-07-15", channel_id: "deepseek", channel_name: "DeepSeek", upstream_model: "deepseek-v4-pro", request_count: 3, known_tokens: 1200, unknown_count: 1, estimated_cost: 0.12 },
  { date: "2026-07-14", channel_id: "deepseek", channel_name: "DeepSeek", upstream_model: "deepseek-v4-pro", request_count: 2, known_tokens: 800, unknown_count: 0, estimated_cost: 0.08 },
  { date: "2026-06-30", channel_id: "longcat", channel_name: "LongCat", upstream_model: "LongCat-2.0", request_count: 5, known_tokens: 5000, unknown_count: 0, estimated_cost: 0.5 },
] as UsageSummaryRow[];

describe("usage presentation", () => {
  it("filters local summary rows by selected period", () => {
    const now = new Date(2026, 6, 15, 12);
    expect(filterUsageRows(rows, "today", now)).toHaveLength(1);
    expect(filterUsageRows(rows, "7d", now)).toHaveLength(2);
    expect(filterUsageRows(rows, "month", now)).toHaveLength(2);
  });

  it("aggregates totals and breakdown shares without fixture data", () => {
    const july = rows.slice(0, 2);
    expect(summarizeUsage(july)).toEqual({ cost: 0.2, tokens: 2000, requests: 5, unknown: 1 });
    expect(groupUsageByModel(july)[0]).toEqual(expect.objectContaining({ label: "deepseek-v4-pro", share: 1, requests: 5 }));
    expect(groupUsageByChannel(july)[0]).toEqual(expect.objectContaining({ label: "DeepSeek", share: 1, tokens: 2000 }));
  });
});
