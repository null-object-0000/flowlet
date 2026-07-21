import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { getModelPriceCurrencies } from "../../domains/settings/commands";
import type { UsageSummaryRow } from "../../domains/usage/types";
import { queryKeys } from "../../shared/query-keys";

/** Same convention as the usage breakdown grouping key. */
function priceKey(channelId: string, model: string) {
  return `${channelId}::${model}`;
}

/**
 * Resolve the currency a usage row's estimated cost is denominated in, from
 * config.json `channels_config.model_prices`. Model-level lookup keys on
 * channel + upstream model; the channel-level fallback serves aggregates that
 * group by channel only. Both functions keep stable identities across renders
 * so downstream memos do not recompute needlessly.
 */
export function useModelPriceCurrencyLookup() {
  const query = useQuery({
    queryKey: queryKeys.settings.modelPriceCurrencies(),
    queryFn: getModelPriceCurrencies,
    staleTime: 5 * 60 * 1000,
    networkMode: "always",
    refetchOnWindowFocus: false,
    retry: false,
  });

  return useMemo(() => {
    const byModel = new Map<string, string>();
    const byChannel = new Map<string, string>();
    for (const entry of query.data ?? []) {
      if (!entry.currency) continue;
      byModel.set(priceKey(entry.channel_id, entry.upstream_model), entry.currency);
      if (!byChannel.has(entry.channel_id)) byChannel.set(entry.channel_id, entry.currency);
    }
    return {
      modelCurrencyOf: (row: UsageSummaryRow) =>
        row.channel_id && row.upstream_model
          ? byModel.get(priceKey(row.channel_id, row.upstream_model)) ?? null
          : null,
      channelCurrencyOf: (row: UsageSummaryRow) =>
        row.channel_id ? byChannel.get(row.channel_id) ?? null : null,
    };
  }, [query.data]);
}
