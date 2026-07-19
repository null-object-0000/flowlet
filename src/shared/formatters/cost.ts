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
