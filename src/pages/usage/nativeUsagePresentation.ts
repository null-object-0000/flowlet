import type { AgentNativeCostEstimate, AgentNativeUsageSummaryRow, UsagePeriod } from "../../domains/usage/types";
import { filterRowsByUsagePeriod } from "./usagePresentation";

export type AgentNativeUsageTotals = {
  sessions: number;
  sessionsWithUsage: number;
  turns: number;
  tokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  truncatedSessions: number;
  apiEquivalentByCurrency: Record<string, number>;
  nativeCostByCurrency: Record<string, number>;
  planConsumptionByCurrency: Record<string, number>;
  pricedTurns: number;
  unpricedTurns: number;
};

export type AgentNativeUsageBreakdown = AgentNativeUsageTotals & {
  agentType: string;
  models: string[];
};

export function filterAgentNativeUsageRows(
  rows: AgentNativeUsageSummaryRow[],
  period: UsagePeriod,
  now = new Date(),
) {
  return filterRowsByUsagePeriod(rows, period, now);
}

export function summarizeAgentNativeUsage(rows: AgentNativeUsageSummaryRow[]): AgentNativeUsageTotals {
  return rows.reduce((total, row) => addNativeUsageRow(total, row), emptyNativeTotals());
}

export function groupAgentNativeUsage(rows: AgentNativeUsageSummaryRow[]): AgentNativeUsageBreakdown[] {
  const groups = new Map<string, AgentNativeUsageBreakdown>();
  for (const row of rows) {
    const current = groups.get(row.agentType) ?? {
      ...emptyNativeTotals(),
      agentType: row.agentType,
      models: [],
    };
    addNativeUsageRow(current, row);
    for (const model of row.models) {
      if (model && !current.models.includes(model)) current.models.push(model);
    }
    groups.set(row.agentType, current);
  }
  return [...groups.values()].sort((left, right) =>
    right.tokens - left.tokens || right.turns - left.turns || left.agentType.localeCompare(right.agentType));
}

function addNativeUsageRow<T extends AgentNativeUsageTotals>(total: T, row: AgentNativeUsageSummaryRow): T {
  total.sessions += 1;
  total.turns += finite(row.turnCount);
  if (row.truncated) total.truncatedSessions += 1;
  const usage = row.usage;
  if (!usage) return total;
  total.sessionsWithUsage += 1;
  total.tokens += finite(usage.totalTokens);
  total.inputTokens += finite(usage.inputTokens);
  total.cachedInputTokens += finite(usage.cachedInputTokens);
  total.cacheWriteInputTokens += finite(usage.cacheWriteInputTokens);
  total.outputTokens += finite(usage.outputTokens);
  total.reasoningTokens += finite(usage.reasoningTokens);
  addCurrencyAmount(total.nativeCostByCurrency, usage.costCurrency, usage.cost);
  addEstimate(total.apiEquivalentByCurrency, usage.apiEquivalent);
  addEstimate(total.planConsumptionByCurrency, usage.planConsumption);
  total.pricedTurns += finite(usage.apiEquivalent?.pricedTurnCount);
  total.unpricedTurns += finite(usage.apiEquivalent?.unpricedTurnCount);
  return total;
}

function addEstimate(target: Record<string, number>, estimate: AgentNativeCostEstimate | null | undefined) {
  addCurrencyAmount(target, estimate?.currency, estimate?.amount);
}

function addCurrencyAmount(
  target: Record<string, number>,
  currency: string | null | undefined,
  amount: number | null | undefined,
) {
  if (amount == null || !Number.isFinite(amount) || amount <= 0) return;
  const key = currency ?? "";
  target[key] = (target[key] ?? 0) + amount;
}

function emptyNativeTotals(): AgentNativeUsageTotals {
  return {
    sessions: 0,
    sessionsWithUsage: 0,
    turns: 0,
    tokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    truncatedSessions: 0,
    apiEquivalentByCurrency: {},
    nativeCostByCurrency: {},
    planConsumptionByCurrency: {},
    pricedTurns: 0,
    unpricedTurns: 0,
  };
}

function finite(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
