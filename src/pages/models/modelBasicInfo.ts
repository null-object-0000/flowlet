import type { ChannelModel } from "../../domains/model/types";
import type { ModelPriceInfo } from "../../domains/settings/types";
import { officialChannelIdForModel } from "../../domains/channel/types";
import type { ModelServiceItem } from "./modelServiceView";

/** 开放模型的产品级基础信息：上下文/最大输出限制（来自渠道模型同步）
 *  与定价（来自 config.json `channels_config.model_prices`）。 */
export type ModelBasicInfo = {
  contextWindow: number | null;
  maxOutputTokens: number | null;
  price: ModelPriceInfo | null;
};

/** 与路由模型 ID 的 `trim().to_lowercase()` 归一化保持一致，
 *  避免 `LongCat-2.0` 这类大小写差异导致失配。 */
function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

export function buildModelBasicInfo(
  model: ModelServiceItem,
  channelModels: ChannelModel[],
  prices: ModelPriceInfo[],
): ModelBasicInfo | null {
  // 路由满足 virtual_model_id 与 upstream_model 属于同一规范模型（见 proxy_http.rs
  // /models 暴露逻辑），publicModel 可作上游名兜底。
  const channelId =
    officialChannelIdForModel(model.publicModel)
    ?? model.channelId
    ?? model.routeGroups[0]?.channelId;
  const upstream = model.publicModel;
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
