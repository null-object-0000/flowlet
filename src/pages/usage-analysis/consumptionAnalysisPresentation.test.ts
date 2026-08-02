import { describe, expect, it } from "vitest";
import type { UsageSummaryRow } from "../../domains/usage/types";
import {
  averageElapsedMsOf,
  buildCrossMatrix,
  cacheHitRateOf,
  cellId,
  CROSS_MATRIX_MAX_COLS,
  groupConsumption,
  outputTokensPerSecondOf,
  secondaryDimensionOf,
} from "./consumptionAnalysisPresentation";

function row(partial: Partial<UsageSummaryRow>): UsageSummaryRow {
  return {
    date: "2026-07-30",
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
    ...partial,
  };
}

const rows = [
  // deepseek-v4-pro 主账号
  row({ channel_id: "deepseek", channel_name: "DeepSeek", account_id: "acc-ds-1", account_name: "主账号", upstream_model: "deepseek-v4-pro", client_id: "claude-code", client_name: "Claude Code", known_tokens: 2000, input_tokens: 1800, input_cached_tokens: 1200, cache_measured_input_tokens: 1800, output_tokens: 200, request_count: 4, estimated_cost: 0.2 }),
  // 同一规范模型的别名变体（MODEL_ALIASES：deepseek-v4-flash-0731 → deepseek-v4-flash）
  row({ channel_id: "qwen", channel_name: "Qwen", account_id: "acc-qwen-tp", account_name: "Token Plan", upstream_model: "deepseek-v4-flash-0731", client_id: "claude-code", client_name: "Claude Code", known_tokens: 500, output_tokens: 500, request_count: 1, estimated_cost: 0.05 }),
  row({ channel_id: "deepseek", channel_name: "DeepSeek", account_id: "acc-ds-1", account_name: "主账号", upstream_model: "deepseek-v4-flash", client_id: "opencode", client_name: "OpenCode", known_tokens: 300, output_tokens: 300, request_count: 1, estimated_cost: 0.03 }),
  // longcat 免费额度账号
  row({ channel_id: "longcat", channel_name: "LongCat", account_id: "acc-lc-1", account_name: "免费额度", upstream_model: "LongCat-2.0", client_id: "claude-code", client_name: "Claude Code", known_tokens: 1000, input_tokens: 900, input_cached_tokens: 450, cache_measured_input_tokens: 900, output_tokens: 100, request_count: 2, estimated_cost: 0 }),
  // 自定义渠道（中转站）：USD 计价
  row({ channel_id: "custom", channel_name: "中转站", account_id: "acc-or-1", account_name: "OpenRouter 备用", upstream_model: "gpt-5-mini", client_id: null, known_tokens: 400, output_tokens: 400, request_count: 1, estimated_cost: 0.4 }),
  // 无客户端归属
  row({ channel_id: "longcat", channel_name: "LongCat", account_id: "acc-lc-1", account_name: "免费额度", upstream_model: "LongCat-2.0", client_id: null, known_tokens: 100, output_tokens: 100, request_count: 1, estimated_cost: 0 }),
];

const cnyOnly = () => "CNY";
const mixedCurrency = (r: UsageSummaryRow) => (r.channel_id === "custom" ? "USD" : "CNY");

describe("groupConsumption", () => {
  it("groups by canonical model id and merges alias variants", () => {
    const entries = groupConsumption(rows, "model", cnyOnly);
    expect(entries.map((entry) => entry.key)).toEqual(["deepseek-v4-pro", "longcat-2.0", "deepseek-v4-flash", "gpt-5-mini"]);
    const flash = entries[2];
    expect(flash.label).toBe("deepseek-v4-flash");
    expect(flash.tokens).toBe(800);
    expect(flash.requests).toBe(2);
    expect(flash.brandId).toBe("deepseek");
    expect(flash.tokenShare).toBeCloseTo(800 / 4300);
  });

  it("groups by channel account, keeping custom channel accounts separate", () => {
    const entries = groupConsumption(rows, "account", cnyOnly);
    const keys = entries.map((entry) => entry.key);
    expect(keys).toContain("deepseek::acc-ds-1");
    expect(keys).toContain("custom::acc-or-1");
    expect(keys).toContain("longcat::acc-lc-1");
    const deepseek = entries.find((entry) => entry.key === "deepseek::acc-ds-1");
    expect(deepseek?.label).toBe("DeepSeek · 主账号");
    expect(deepseek?.tokens).toBe(2300);
    expect(deepseek?.brandId).toBe("deepseek");
    const custom = entries.find((entry) => entry.key === "custom::acc-or-1");
    expect(custom?.label).toBe("中转站 · OpenRouter 备用");
  });

  it("groups by client and buckets missing client ids as unknown", () => {
    const entries = groupConsumption(rows, "client", cnyOnly);
    expect(entries.map((entry) => entry.key)).toEqual(["claude-code", "unknown-client", "opencode"]);
    const claudeCode = entries[0];
    expect(claudeCode.label).toBe("Claude Code");
    expect(claudeCode.tokens).toBe(3500);
    const unknown = entries[1];
    expect(unknown.label).toBe("未识别客户端");
    expect(unknown.tokens).toBe(500);
  });

  it("splits cost by currency instead of mixing CNY and USD sums", () => {
    const entries = groupConsumption(rows, "account", mixedCurrency);
    const custom = entries.find((entry) => entry.key === "custom::acc-or-1");
    expect(custom?.costByCurrency).toEqual({ USD: 0.4 });
    const deepseek = entries.find((entry) => entry.key === "deepseek::acc-ds-1");
    expect(deepseek?.costByCurrency).toEqual({ CNY: 0.23 });
  });

  it("derives performance metrics with request-log semantics", () => {
    const perfRows = [
      // deepseek-v4-pro：生成耗时 (5200−200)+(3100−100)=8000ms，生成输出 300 token
      row({ channel_id: "deepseek", channel_name: "DeepSeek", account_id: "acc-ds-1", upstream_model: "deepseek-v4-pro", output_tokens: 200, elapsed_total_ms: 5200, elapsed_measured_count: 1, generation_total_ms: 5000, generation_output_tokens: 200 }),
      row({ channel_id: "deepseek", channel_name: "DeepSeek", account_id: "acc-ds-1", upstream_model: "deepseek-v4-pro", output_tokens: 100, elapsed_total_ms: 3100, elapsed_measured_count: 1, generation_total_ms: 3000, generation_output_tokens: 100 }),
      // longcat：只有总耗时、无生成耗时（非流式），速度不可计算但平均耗时可用
      row({ channel_id: "longcat", channel_name: "LongCat", account_id: "acc-lc-1", upstream_model: "LongCat-2.0", output_tokens: 100, elapsed_total_ms: 900, elapsed_measured_count: 1 }),
    ];
    const entries = groupConsumption(perfRows, "model", cnyOnly);
    const pro = entries.find((entry) => entry.key === "deepseek-v4-pro");
    expect(outputTokensPerSecondOf(pro!)).toBeCloseTo(300 / 8);
    expect(averageElapsedMsOf(pro!)).toBeCloseTo((5200 + 3100) / 2);
    const longcat = entries.find((entry) => entry.key === "longcat-2.0");
    expect(outputTokensPerSecondOf(longcat!)).toBeNull();
    expect(averageElapsedMsOf(longcat!)).toBeCloseTo(900);
  });

  it("computes cache hit rate from cache-measured input only", () => {
    const entries = groupConsumption(rows, "model", cnyOnly);
    const pro = entries.find((entry) => entry.key === "deepseek-v4-pro");
    expect(cacheHitRateOf(pro!)).toBeCloseTo(1200 / 1800);
    const flash = entries.find((entry) => entry.key === "deepseek-v4-flash");
    expect(cacheHitRateOf(flash!)).toBeNull();
  });
});

describe("buildCrossMatrix", () => {
  it("crosses model rows against channel-account columns", () => {
    const matrix = buildCrossMatrix(rows, "model", "tokens", cnyOnly);
    expect(secondaryDimensionOf("model")).toBe("account");
    expect(matrix.columns.map((column) => column.key)).toEqual(["deepseek::acc-ds-1", "longcat::acc-lc-1", "qwen::acc-qwen-tp", "custom::acc-or-1"]);
    const deepseekCell = matrix.cells.get(cellId("deepseek-v4-flash", "deepseek::acc-ds-1"));
    expect(deepseekCell?.tokens).toBe(300);
    const aliasCell = matrix.cells.get(cellId("deepseek-v4-flash", "qwen::acc-qwen-tp"));
    expect(aliasCell?.tokens).toBe(500);
    expect(matrix.cells.get(cellId("longcat-2.0", "deepseek::acc-ds-1"))).toBeUndefined();
  });

  it("crosses client rows against model columns", () => {
    const matrix = buildCrossMatrix(rows, "client", "tokens", cnyOnly);
    expect(secondaryDimensionOf("client")).toBe("model");
    expect(matrix.columns[0].label).toBe("deepseek-v4-pro");
    const cell = matrix.cells.get(cellId("claude-code", "deepseek-v4-pro"));
    expect(cell?.tokens).toBe(2000);
    expect(cell?.cost).toBe(0.2);
  });

  it("caps columns at the top N by the selected metric and reports coverage", () => {
    const tokenMatrix = buildCrossMatrix(rows, "account", "tokens", cnyOnly, 2);
    expect(tokenMatrix.columns).toHaveLength(2);
    expect(tokenMatrix.columns.map((column) => column.key)).toEqual(["deepseek-v4-pro", "longcat-2.0"]);
    expect(tokenMatrix.columnCoverage).toBeCloseTo((2000 + 1100) / 4300);

    const costMatrix = buildCrossMatrix(rows, "account", "cost", mixedCurrency, 2);
    expect(costMatrix.columns.map((column) => column.key)).toEqual(["gpt-5-mini", "deepseek-v4-pro"]);
  });

  it("assigns heat levels from the current period cell distribution", () => {
    const matrix = buildCrossMatrix(rows, "model", "tokens", cnyOnly);
    const hottest = matrix.cells.get(cellId("deepseek-v4-pro", "deepseek::acc-ds-1"));
    expect(hottest?.level).toBe(4);
    expect(matrix.scale.levelFor(0)).toBe(0);
  });

  it("uses the shared default column cap", () => {
    expect(CROSS_MATRIX_MAX_COLS).toBe(4);
    const matrix = buildCrossMatrix(rows, "model", "tokens", cnyOnly);
    expect(matrix.columns.length).toBeLessThanOrEqual(CROSS_MATRIX_MAX_COLS);
  });
});
