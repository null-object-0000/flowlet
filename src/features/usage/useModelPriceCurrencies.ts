import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { backgroundTaskCommands } from "../../domains/background-task/commands";
import type { UsageSummaryRow } from "../../domains/usage/types";
import { canonicalModelId } from "../../domains/channel/types";
import { queryKeys } from "../../shared/query-keys";

/** 本地价格目录解析不到时的兜底币种，与 Rust `get_models_cn_currencies` 默认一致。 */
const DEFAULT_CURRENCY = "CNY";

/**
 * Resolve the currency a usage row's estimated cost is denominated in,
 * from the local models-cn catalog.
 *
 * models-cn 目录中的模型全局唯一（同一模型不会跨渠道重复出现），因此直接以
 * **模型名**索引货币，不做「渠道-模型」二维匹配。Rust 返回的 key 虽带渠道前缀
 * （`channel_id:upstream_model`），这里解析后仅按模型名建表；用量行的
 * `upstream_model` 是上游原名（可能是别名变体，如 deepseek-v4-flash-0731），
 * 查询时依次尝试原样名与 `canonicalModelId` 规范化后的规范名。
 *
 * 代理行的 `estimated_cost_currency` 在 Rust 聚合层为 NULL，币种完全依赖本地
 * 价格目录解析；目录缺失（如便携版首次启动未同步 models-cn）或模型不在目录时
 * 回退到默认人民币，保证「预估费用」列始终带货币符号，而不是显示无币种裸数值。
 * 两个函数保持稳定身份，避免下游 memo 无谓重算。
 */
/** 由 Rust `get_models_cn_currencies` 返回的 `channel_id:upstream_model → currency`
 *  对构建货币查询。模型全局唯一，因此只按模型名索引（渠道前缀仅用于渠道级兜底表）。 */
export function buildModelPriceCurrencyLookup(data: Array<[string, string]>) {
  const byModel = new Map<string, string>();
  const byChannel = new Map<string, string>();
  for (const [key, currency] of data) {
    // key 格式为 "channel_id:upstream_model"，只取模型名做模型级索引。
    const separator = key.indexOf(":");
    if (separator <= 0) continue;
    const channelId = key.slice(0, separator);
    const upstreamModel = key.slice(separator + 1);
    if (upstreamModel) byModel.set(upstreamModel, currency);
    if (channelId && !byChannel.has(channelId)) byChannel.set(channelId, currency);
  }
  return {
    modelCurrencyOf: (row: UsageSummaryRow) => {
      if (row.estimated_cost_currency) return row.estimated_cost_currency;
      if (!row.upstream_model) return DEFAULT_CURRENCY;
      const canonical = canonicalModelId(row.upstream_model);
      return byModel.get(row.upstream_model)
        ?? (canonical ? byModel.get(canonical) : undefined)
        ?? DEFAULT_CURRENCY;
    },
    channelCurrencyOf: (row: UsageSummaryRow) =>
      row.channel_id
        ? byChannel.get(row.channel_id) ?? DEFAULT_CURRENCY
        : DEFAULT_CURRENCY,
  };
}

export function useModelPriceCurrencyLookup() {
  const query = useQuery({
    queryKey: queryKeys.modelCatalog.currencies(),
    queryFn: backgroundTaskCommands.getModelsCnCurrencies,
    staleTime: 10 * 60 * 1000,
    networkMode: "always",
    refetchOnWindowFocus: false,
    retry: false,
  });

  return useMemo(() => buildModelPriceCurrencyLookup(query.data ?? []), [query.data]);
}
