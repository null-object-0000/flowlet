export type NativeCostValue = {
  cost: number | null;
  costCurrency: string | null;
};

export type CostAmountValue = {
  amount: number | null;
  currency: string | null;
};

export function formatNativeCost(value: NativeCostValue, digits = 6) {
  return formatCostAmount({ amount: value.cost, currency: value.costCurrency }, digits);
}

export function formatCostAmount(value: CostAmountValue, digits = 6) {
  if (value.amount == null || !Number.isFinite(value.amount)) return "—";
  const amount = value.amount.toFixed(digits);
  if (value.currency === "USD") return `$${amount}`;
  if (value.currency === "CNY") return `¥${amount}`;
  if (value.currency === "CREDITS") return `${amount} credits`;
  return `${amount} ${value.currency ?? ""}`.trim();
}

const CURRENCY_DISPLAY_ORDER: Record<string, number> = { CNY: 0, USD: 1, CREDITS: 2 };

function currencyDisplayOrder(currency: string) {
  return CURRENCY_DISPLAY_ORDER[currency] ?? (currency === "" ? 4 : 3);
}

/** Format a per-currency cost split as one label, e.g. "¥12.34 + $5.60".
 *  Stable order: CNY, USD, CREDITS, other codes, then unresolvable ("").
 *  Empty or all-zero splits fall back to a plain zero amount. */
export function formatMultiCurrencyCost(costByCurrency: Record<string, number>, digits = 2) {
  const entries = Object.entries(costByCurrency).filter(([, amount]) => Number.isFinite(amount) && amount > 0);
  if (entries.length === 0) return formatCostAmount({ amount: 0, currency: null }, digits);
  entries.sort((a, b) => currencyDisplayOrder(a[0]) - currencyDisplayOrder(b[0]) || b[1] - a[1]);
  return entries.map(([currency, amount]) => formatCostAmount({ amount, currency: currency === "" ? null : currency }, digits)).join(" + ");
}

/** The currency contributing the largest cost, for single-value views (chart
 *  axis labels) that cannot render a mixed-currency sum. Null when empty. */
export function dominantCostCurrency(costByCurrency: Record<string, number>): string | null {
  let best: string | null = null;
  let bestAmount = 0;
  for (const [currency, amount] of Object.entries(costByCurrency)) {
    if (!Number.isFinite(amount) || amount <= bestAmount) continue;
    best = currency;
    bestAmount = amount;
  }
  return best === "" ? null : best;
}
