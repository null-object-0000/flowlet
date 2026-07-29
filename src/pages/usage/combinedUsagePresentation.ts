import type { UsageSummaryTotals } from "./usagePresentation";
import type { AgentNativeUsageTotals } from "./nativeUsagePresentation";

export type CombinedUsageTotals = {
  tokens: number;
  flowletTokens: number;
  nativeTokens: number;
  requests: number;
  nativeTurns: number;
  nativeSessions: number;
  flowletValueByCurrency: Record<string, number>;
  nativeValueByCurrency: Record<string, number>;
  apiEquivalentValueByCurrency: Record<string, number>;
};

/**
 * Combines Flowlet's public-price estimate with the API-equivalent value of
 * native-only Agent sessions. Native reported cost and plan consumption are
 * intentionally excluded because they use different accounting semantics.
 */
export function summarizeCombinedUsage(
  flowlet: UsageSummaryTotals,
  native: AgentNativeUsageTotals,
): CombinedUsageTotals {
  return {
    tokens: finite(flowlet.tokens) + finite(native.tokens),
    flowletTokens: finite(flowlet.tokens),
    nativeTokens: finite(native.tokens),
    requests: finite(flowlet.requests),
    nativeTurns: finite(native.turns),
    nativeSessions: finite(native.sessions),
    flowletValueByCurrency: { ...flowlet.costByCurrency },
    nativeValueByCurrency: { ...native.apiEquivalentByCurrency },
    apiEquivalentValueByCurrency: mergeCurrencyAmounts(
      flowlet.costByCurrency,
      native.apiEquivalentByCurrency,
    ),
  };
}

export function mergeCurrencyAmounts(
  ...values: Array<Record<string, number>>
): Record<string, number> {
  const merged: Record<string, number> = {};
  for (const value of values) {
    for (const [currency, amount] of Object.entries(value)) {
      if (!Number.isFinite(amount) || amount <= 0) continue;
      merged[currency] = (merged[currency] ?? 0) + amount;
    }
  }
  return merged;
}

function finite(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
