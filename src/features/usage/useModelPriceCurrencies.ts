import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { backgroundTaskCommands } from "../../domains/background-task/commands";
import type { UsageSummaryRow } from "../../domains/usage/types";
import { queryKeys } from "../../shared/query-keys";

/** Same convention as the usage breakdown grouping key. */
function priceKey(channelId: string, model: string) {
  return `${channelId}::${model}`;
}

/**
 * Resolve the currency a usage row's estimated cost is denominated in,
 * from the local models-cn catalog. Model-level lookup keys on
 * channel + upstream model; the channel-level fallback serves aggregates that
 * group by channel only. Both functions keep stable identities across renders
 * so downstream memos do not recompute needlessly.
 */
export function useModelPriceCurrencyLookup() {
  const query = useQuery({
    queryKey: queryKeys.modelCatalog.catalog(),
    queryFn: backgroundTaskCommands.getModelsCnCurrencies,
    staleTime: 10 * 60 * 1000,
    networkMode: "always",
    refetchOnWindowFocus: false,
    retry: false,
  });

  return useMemo(() => {
    const byModel = new Map<string, string>();
    const byChannel = new Map<string, string>();
    for (const [key, currency] of query.data ?? []) {
      // key 格式为 "channel_id:upstream_model"
      const separator = key.indexOf(":");
      if (separator <= 0) continue;
      const channelId = key.slice(0, separator);
      const upstreamModel = key.slice(separator + 1);
      byModel.set(priceKey(channelId, upstreamModel), currency);
      if (!byChannel.has(channelId)) byChannel.set(channelId, currency);
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
