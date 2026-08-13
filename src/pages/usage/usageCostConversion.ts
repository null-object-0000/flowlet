import type { UsageSummaryRow } from "../../domains/usage/types";
import type { UsageCostDisplayConfig } from "../../domains/settings/types";

export type ConvertedUsageCost = {
  total: number;
  flowlet: number;
  native: number;
  flowletOriginalByCurrency: Record<string, number>;
  nativeOriginalByCurrency: Record<string, number>;
  currency: "CNY" | "USD";
  unsupportedCurrencies: string[];
};

export function summarizeConvertedUsageCost(
  rows: UsageSummaryRow[],
  config: UsageCostDisplayConfig,
  currencyOf: (row: UsageSummaryRow) => string | null,
): ConvertedUsageCost {
  let flowlet = 0;
  let native = 0;
  const flowletOriginalByCurrency: Record<string, number> = {};
  const nativeOriginalByCurrency: Record<string, number> = {};
  const unsupported = new Set<string>();
  for (const row of rows) {
    const amount = row.estimated_cost;
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const currency = currencyOf(row)?.trim().toUpperCase() ?? "";
    const original = row.channel_id === "agent-native"
      ? nativeOriginalByCurrency
      : flowletOriginalByCurrency;
    original[currency] = (original[currency] ?? 0) + amount;
    const converted = convertUsageCost(amount, currency, config);
    if (converted == null) {
      unsupported.add(currency || "UNKNOWN");
      continue;
    }
    if (row.channel_id === "agent-native") native += converted;
    else flowlet += converted;
  }
  return {
    total: flowlet + native,
    flowlet,
    native,
    flowletOriginalByCurrency,
    nativeOriginalByCurrency,
    currency: config.display_currency,
    unsupportedCurrencies: [...unsupported].sort(),
  };
}

export function convertUsageCost(
  amount: number,
  sourceCurrency: string,
  config: UsageCostDisplayConfig,
): number | null {
  if (!Number.isFinite(amount)) return null;
  const source = sourceCurrency.toUpperCase();
  if (source === config.display_currency) return amount;
  if (!config.currency_conversion_enabled) return null;
  if (!Number.isFinite(config.usd_to_cny_rate) || config.usd_to_cny_rate <= 0) return null;
  if (source === "USD" && config.display_currency === "CNY") {
    return amount * config.usd_to_cny_rate;
  }
  if (source === "CNY" && config.display_currency === "USD") {
    return amount / config.usd_to_cny_rate;
  }
  return null;
}

export function groupConvertedUsageCost(
  rows: UsageSummaryRow[],
  config: UsageCostDisplayConfig,
  currencyOf: (row: UsageSummaryRow) => string | null,
) {
  const grouped = new Map<string, UsageSummaryRow[]>();
  for (const row of rows) {
    const key = row.date;
    const group = grouped.get(key) ?? [];
    group.push(row);
    grouped.set(key, group);
  }
  return new Map([...grouped].map(([key, group]) => [
    key,
    summarizeConvertedUsageCost(group, config, currencyOf),
  ]));
}
