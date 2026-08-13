import { describe, expect, it } from "vitest";
import type { AgentNativeUsageSummaryRow } from "../../domains/usage/types";
import { filterAgentNativeUsageRows, groupAgentNativeUsage, summarizeAgentNativeUsage } from "./nativeUsagePresentation";

const rows: AgentNativeUsageSummaryRow[] = [
  {
    date: "2026-07-15",
    activityAt: "2026-07-15T10:00:00Z",
    agentType: "codex-cli",
    sessionId: "codex-1",
    turnCount: 3,
    models: ["gpt-5.6-sol"],
    truncated: false,
    usage: {
      inputTokens: 900,
      cachedInputTokens: 500,
      cacheWriteInputTokens: 0,
      outputTokens: 100,
      reasoningTokens: 20,
      totalTokens: 1020,
      cost: null,
      costCurrency: null,
      apiEquivalent: {
        amount: 0.12,
        currency: "USD",
        sourceUrl: null,
        priceVersion: "2026-07-19",
        pricedTurnCount: 2,
        unpricedTurnCount: 1,
      },
    },
  },
  {
    date: "2026-07-14",
    activityAt: "2026-07-14T10:00:00Z",
    agentType: "opencode",
    sessionId: "opencode-1",
    turnCount: 2,
    models: ["kimi-k3"],
    truncated: true,
    usage: {
      inputTokens: 400,
      cachedInputTokens: 100,
      cacheWriteInputTokens: 20,
      outputTokens: 80,
      reasoningTokens: 0,
      totalTokens: 480,
      cost: 0.03,
      costCurrency: "USD",
      apiEquivalent: null,
    },
  },
  {
    date: "2026-06-30",
    activityAt: "2026-06-30T10:00:00Z",
    agentType: "pi",
    sessionId: "pi-1",
    turnCount: 1,
    models: [],
    truncated: false,
    usage: null,
  },
];

describe("Agent native usage presentation", () => {
  it("filters cumulative session summaries by their latest activity date", () => {
    const now = new Date(2026, 6, 15, 12);
    expect(filterAgentNativeUsageRows(rows, "today", now)).toHaveLength(1);
    expect(filterAgentNativeUsageRows(rows, "week", now)).toHaveLength(2);
    expect(filterAgentNativeUsageRows(rows, "all", now)).toHaveLength(3);
  });

  it("keeps API equivalent and native reported cost separate", () => {
    const summary = summarizeAgentNativeUsage(rows);
    expect(summary).toEqual(expect.objectContaining({
      sessions: 3,
      sessionsWithUsage: 2,
      turns: 6,
      tokens: 1500,
      inputTokens: 1300,
      cachedInputTokens: 600,
      cacheWriteInputTokens: 20,
      outputTokens: 180,
      reasoningTokens: 20,
      truncatedSessions: 1,
      pricedTurns: 2,
      unpricedTurns: 1,
      apiEquivalentByCurrency: { USD: 0.12 },
      nativeCostByCurrency: { USD: 0.03 },
    }));
  });

  it("groups rows by Agent without merging cost semantics", () => {
    const groups = groupAgentNativeUsage(rows);
    expect(groups.map((group) => group.agentType)).toEqual(["codex-cli", "opencode", "pi"]);
    expect(groups[0]).toEqual(expect.objectContaining({
      sessions: 1,
      turns: 3,
      tokens: 1020,
      models: ["gpt-5.6-sol"],
      apiEquivalentByCurrency: { USD: 0.12 },
      nativeCostByCurrency: {},
    }));
  });
});
