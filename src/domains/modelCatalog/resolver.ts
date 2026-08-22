/** 将 Flowlet 的 channel_id + upstream_model 映射到 models-cn  provider + model，
 *  并解析为 ResolvedModel。纯逻辑，便于测试。*/

import type { ModelsCnCatalog, ModelsDevCatalog, ModelsDevModel, ResolvedModel } from "./types";
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

export function parseModelsDevCatalogJson(json: string): ModelsDevCatalog | null {
  try {
    return JSON.parse(json) as ModelsDevCatalog;
  } catch {
    return null;
  }
}

function normalizeValues(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean))];
}

function resolvedFromModelsDev(providerName: string, model: ModelsDevModel): ResolvedModel {
  return {
    providerId: "openrouter",
    providerName,
    modelId: model.id,
    modelName: model.name,
    description: model.description?.trim() || null,
    tokenizer: null,
    specificationSource: "models.dev",
    limits: {
      contextTokens: model.limit?.context ?? null,
      maxOutputTokens: model.limit?.output ?? null,
    },
    capabilities: {
      thinking: model.reasoning ?? false,
      toolCalls: model.tool_call ?? false,
      jsonOutput: model.structured_output ?? false,
      inputModalities: normalizeValues(model.modalities?.input),
      outputModalities: normalizeValues(model.modalities?.output),
    },
    aliases: [],
    officialPrice: null,
    allPrices: [],
    supplementedFromModelsDev: false,
    modelsDevReferenceUrl: null,
  };
}

/** OpenRouter 模型在 models-cn 缺失时，优先读取 models.dev 的 OpenRouter 目录。 */
export function resolveOpenRouterModelsDevModel(
  catalog: ModelsDevCatalog,
  upstreamModel: string,
): ResolvedModel | null {
  const provider = catalog.openrouter;
  if (!provider?.models) return null;
  const normalized = upstreamModel.trim().toLowerCase();
  const canonical = (canonicalModelId(upstreamModel) ?? upstreamModel).trim().toLowerCase();
  let fallback: ModelsDevModel | null = null;
  for (const [key, model] of Object.entries(provider.models)) {
    const ids = [key, model.id].map((value) => value.trim().toLowerCase());
    if (ids.includes(normalized)) return resolvedFromModelsDev(provider.name, model);
    if (ids.some((value) => value === canonical || value.endsWith(`/${canonical}`))) {
      fallback ??= model;
    }
  }
  return fallback ? resolvedFromModelsDev(provider.name, fallback) : null;
}

/** 规格优先级：models-cn → models.dev。 */
export function resolveModelSpecification(
  modelsCnCatalog: ModelsCnCatalog | null,
  modelsDevCatalog: ModelsDevCatalog | null,
  channelId: string,
  upstreamModel: string,
  at?: Date,
  allowModelsDevFallback = true,
): ResolvedModel | null {
  const fromModelsCn = modelsCnCatalog
    ? resolveChannelModel(modelsCnCatalog, channelId, upstreamModel, at)
    : null;
  if (fromModelsCn) return fromModelsCn;
  if (!allowModelsDevFallback) return null;
  if (channelId !== "openrouter") return null;
  return modelsDevCatalog
    ? resolveOpenRouterModelsDevModel(modelsDevCatalog, upstreamModel)
    : null;
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
  const capsMissing = officialCaps == null || (
    officialCaps.thinking == null
    && officialCaps.toolCalls == null
    && officialCaps.jsonOutput == null
    && officialCaps.inputModalities == null
    && officialCaps.outputModalities == null
  );
  const supplemented = Boolean(limitsMissing || capsMissing);
  const referenceUrl = supplemented ? findModelsDevReference(catalog, providerId, canonicalModel) : null;

  return resolveModel(found.provider, found.model, {
    supplemented,
    modelsDevReferenceUrl: referenceUrl,
    at,
  });
}
