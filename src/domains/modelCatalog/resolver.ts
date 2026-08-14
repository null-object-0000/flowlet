/** 将 Flowlet 的 channel_id + upstream_model 映射到 models-cn  provider + model，
 *  并解析为 ResolvedModel。纯逻辑，便于测试。*/

import type { ModelsCnCatalog } from "./types";
import { findModelInCatalog, resolveModel } from "./pricing";
import { canonicalModelId, modelsCnProviderIdForModel } from "./identity";

/** 解析本地存储的 JSON 字符串为 ModelsCnCatalog。解析失败返回 null。 */
export function parseCatalogJson(json: string): ModelsCnCatalog | null {
  try {
    return JSON.parse(json) as ModelsCnCatalog;
  } catch {
    return null;
  }
}

/** Flowlet channel_id → models-cn providerId 映射。
 *  kimi → moonshot-cn（中国大陆官方价优先），qwen → qwen-cn，
 *  zhipu → zhipu-cn（中国大陆官方价优先）。 */
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
  _channelId: string,
  upstreamModel: string,
  at?: Date,
): ReturnType<typeof resolveModel> | null {
  // 路由的 upstream_model 可能是别名变体原名（如 deepseek-v4-flash-0731），
  // 官方归属与目录查找统一按规范模型 ID 解析。
  const canonicalModel = canonicalModelId(upstreamModel) ?? upstreamModel;
  const providerId = modelsCnProviderIdForModel(upstreamModel);
  if (!providerId) return null;
  const found = findModelInCatalog(catalog, providerId, canonicalModel);
  if (!found) return null;

  // 判断是否官方字段缺失（limits 全 null 或 capabilities 全 false）。
  const officialLimits = found.model.limits;
  const officialCaps = found.model.capabilities;
  const limitsMissing =
    officialLimits == null ||
    (officialLimits.contextTokens == null && officialLimits.maxOutputTokens == null);
  const capsMissing = officialCaps == null || (!officialCaps.thinking && !officialCaps.toolCalls && !officialCaps.jsonOutput);
  const supplemented = Boolean(limitsMissing || capsMissing);
  const referenceUrl = supplemented ? findModelsDevReference(catalog, providerId, canonicalModel) : null;

  return resolveModel(found.provider, found.model, {
    supplemented,
    modelsDevReferenceUrl: referenceUrl,
    at,
  });
}
