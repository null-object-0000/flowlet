/** 将 Flowlet 的 channel_id + upstream_model 映射到 models-cn  provider + model，
 *  并解析为 ResolvedModel。纯逻辑，便于测试。*/

import type { ModelsCnCatalog } from "./types";
import { findModelInCatalog, resolveModel } from "./pricing";

/** 解析本地存储的 JSON 字符串为 ModelsCnCatalog。解析失败返回 null。 */
export function parseCatalogJson(json: string): ModelsCnCatalog | null {
  try {
    return JSON.parse(json) as ModelsCnCatalog;
  } catch {
    return null;
  }
}

/** Flowlet channel_id → models-cn providerId 映射。
 *  kimi → moonshot-cn（中国大陆官方价优先），qwen → qwen-cn。 */
export const PROVIDER_BY_CHANNEL: Record<string, string> = {
  longcat: "longcat",
  deepseek: "deepseek",
  kimi: "moonshot-cn",
  qwen: "qwen-cn",
};

/** 尝试在 calibration.modelsDev 中查找参考链接（用于补全标记）。 */
function findModelsDevReference(catalog: ModelsCnCatalog, providerId: string, modelId: string): string | null {
  for (const entry of catalog.calibration?.modelsDev?.models ?? []) {
    if (entry.provider === providerId && entry.model === modelId) return entry.referenceUrl;
  }
  return null;
}

/** 解析 Flowlet 渠道模型。纯函数。
 *  若 models-cn 无该模型，返回 null。
 *  `supplemented` 标记：当官方 limits/capabilities 字段缺失但 models.dev 有时为 true。 */
export function resolveChannelModel(
  catalog: ModelsCnCatalog,
  channelId: string,
  upstreamModel: string,
): ReturnType<typeof resolveModel> | null {
  const providerId = PROVIDER_BY_CHANNEL[channelId];
  if (!providerId) return null;
  const found = findModelInCatalog(catalog, providerId, upstreamModel);
  if (!found) return null;

  // 判断是否官方字段缺失（limits 全 null 或 capabilities 全 false）。
  const officialLimits = found.model.limits;
  const officialCaps = found.model.capabilities;
  const limitsMissing =
    officialLimits == null ||
    (officialLimits.contextTokens == null && officialLimits.maxOutputTokens == null);
  const capsMissing = officialCaps == null || (!officialCaps.thinking && !officialCaps.toolCalls && !officialCaps.jsonOutput);
  const supplemented = Boolean(limitsMissing || capsMissing);
  const referenceUrl = supplemented ? findModelsDevReference(catalog, providerId, upstreamModel) : null;

  return resolveModel(found.provider, found.model, {
    supplemented,
    modelsDevReferenceUrl: referenceUrl,
  });
}
