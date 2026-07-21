import type { ChannelModel } from "../../domains/model/types";
import type { ModelPriceInfo } from "../../domains/settings/types";
import type { ModelServiceItem } from "./modelServiceView";

/** 直接渠道模型的产品级基础信息：上下文/最大输出限制（来自渠道模型同步）
 *  与定价（来自 config.json `channels_config.model_prices`）。聚合模型
 *  （flowlet-pro/flowlet-flash）没有单一上游，不产出基础信息。 */
export type ModelBasicInfo = {
  contextWindow: number | null;
  maxOutputTokens: number | null;
  price: ModelPriceInfo | null;
};

/** 与 Rust `flowlet_tiers` 的 `trim().to_lowercase()` 归一化保持一致，
 *  避免 `LongCat-2.0` 这类大小写差异导致失配。 */
function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

export function buildModelBasicInfo(
  model: ModelServiceItem,
  channelModels: ChannelModel[],
  prices: ModelPriceInfo[],
): ModelBasicInfo | null {
  if (model.kind !== "direct") return null;
  // 直接模型满足 virtual_model_id === upstream_model（见 proxy_http.rs
  // /models 暴露逻辑），publicModel 可作上游名兜底。
  const channelId = model.channelId ?? model.routeGroups[0]?.channelId;
  const upstream = model.routeGroups[0]?.upstreamModel ?? model.publicModel;
  if (!channelId) {
    return { contextWindow: null, maxOutputTokens: null, price: null };
  }
  const channelKey = normalizeKey(channelId);
  const upstreamKey = normalizeKey(upstream);
  const channelModel = channelModels.find(
    (candidate) =>
      normalizeKey(candidate.channel_id) === channelKey &&
      normalizeKey(candidate.model) === upstreamKey,
  );
  const price =
    prices.find(
      (candidate) =>
        normalizeKey(candidate.channel_id) === channelKey &&
        normalizeKey(candidate.upstream_model) === upstreamKey,
    ) ?? null;
  return {
    contextWindow: channelModel?.context_window ?? null,
    maxOutputTokens: channelModel?.max_output_tokens ?? null,
    price,
  };
}
