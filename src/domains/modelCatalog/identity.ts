import catalogJson from "../../../model-catalog.json";
import { MODEL_CATALOG_PLUGIN_SOURCE } from "../pluginRegistry";

/** 模型类型：`chat` 为对话模型（缺省），`decision` 为结构化决策模型。 */
export type ModelKind = "chat" | "decision";

/** 模型类型允许的候选协议。决策模型只走 TypeSafe System One，不进入对话模型池。 */
const MODEL_KIND_PROTOCOLS: Record<ModelKind, readonly string[]> = {
  chat: ["openai", "anthropic", "responses"],
  decision: ["systemone"],
};

export type ModelIdentity = {
  id: string;
  ownerChannelId: string;
  officialOwnerName?: string;
  modelsCnProviderId: string;
  aliases: string[];
  /** 缺省 `chat`。 */
  kind?: ModelKind;
};

export type ModelIdentityCatalog = {
  schemaVersion: number;
  models: ModelIdentity[];
};

const catalog = catalogJson as ModelIdentityCatalog;

if (MODEL_CATALOG_PLUGIN_SOURCE !== "model-catalog.json") {
  throw new Error(`Unexpected model catalog plugin source: ${MODEL_CATALOG_PLUGIN_SOURCE}`);
}

if (catalog.schemaVersion !== 1) {
  throw new Error(`Unsupported model catalog schema: ${catalog.schemaVersion}`);
}

for (const model of catalog.models) {
  if (model.kind !== undefined && model.kind !== "chat" && model.kind !== "decision") {
    throw new Error(`Unsupported model kind for ${model.id}: ${String(model.kind)}`);
  }
}

export const MODEL_IDENTITIES: readonly ModelIdentity[] = catalog.models;
export const FLOWLET_SUPPORTED_MODELS: string[] = MODEL_IDENTITIES.map((model) => model.id);

export const DEFAULT_EXPOSED_MODELS_BY_CHANNEL: Record<string, string[]> =
  MODEL_IDENTITIES.reduce<Record<string, string[]>>((grouped, model) => {
    // 只有对话模型进入「渠道默认开放模型」；决策模型必须由用户显式勾选。
    if ((model.kind ?? "chat") === "chat") (grouped[model.ownerChannelId] ??= []).push(model.id);
    return grouped;
  }, {});

export const MODEL_ALIASES: Record<string, string> = Object.fromEntries(
  MODEL_IDENTITIES.flatMap((model) => model.aliases.map((alias) => [alias.toLowerCase(), model.id])),
);

const MODEL_BY_KEY = new Map(
  MODEL_IDENTITIES.map((model) => [model.id.trim().toLowerCase(), model] as const),
);

const ALIAS_TARGET_BY_KEY = new Map(
  Object.entries(MODEL_ALIASES).map(([alias, canonical]) => [
    alias.trim().toLowerCase(),
    canonical.trim().toLowerCase(),
  ]),
);

export function stripAggregateVendorPrefix(modelId: string): string {
  const raw = (modelId ?? "").trim();
  const index = raw.lastIndexOf("/");
  return index >= 0 ? raw.slice(index + 1) : raw;
}

export function canonicalModelKey(modelId: string | null | undefined): string {
  const key = stripAggregateVendorPrefix(modelId ?? "").trim().toLowerCase();
  return ALIAS_TARGET_BY_KEY.get(key) ?? key;
}

export function modelIdentityFor(modelId: string | null | undefined): ModelIdentity | null {
  if (!modelId?.trim()) return null;
  return MODEL_BY_KEY.get(canonicalModelKey(modelId)) ?? null;
}

export function canonicalModelId(modelId: string | null | undefined): string | null {
  return modelIdentityFor(modelId)?.id ?? null;
}

export function officialChannelIdForModel(modelId: string | null | undefined): string | null {
  return modelIdentityFor(modelId)?.ownerChannelId ?? null;
}

export function officialOwnerNameForModel(modelId: string | null | undefined): string | null {
  return modelIdentityFor(modelId)?.officialOwnerName?.trim() || null;
}

export function modelsCnProviderIdForModel(modelId: string | null | undefined): string | null {
  return modelIdentityFor(modelId)?.modelsCnProviderId ?? null;
}

export function modelKindFor(modelId: string | null | undefined): ModelKind {
  return modelIdentityFor(modelId)?.kind ?? "chat";
}

export function allowedProtocolsForModel(modelId: string | null | undefined): readonly string[] {
  return MODEL_KIND_PROTOCOLS[modelKindFor(modelId)];
}

/** 某个渠道官方归属的决策模型 ID。
 *
 *  决策模型不在上游标准对话 `/models` 列表中稳定出现，但模型 ID 与端点由官方文档固定；
 *  账号编辑器在渠道声明 `systemone` 且账号有网关地址时，把它们作为目录声明的候选补进
 *  `/models` 结果，仍需用户显式勾选。 */
export function decisionModelIdsForChannel(channelId: string): string[] {
  return MODEL_IDENTITIES.filter(
    (model) => (model.kind ?? "chat") === "decision" && model.ownerChannelId === channelId,
  ).map((model) => model.id);
}

/** 目录未登记的模型不额外收紧（与 Node Host `ModelCatalog.supportsProtocol` 对齐）。 */
export function modelSupportsProtocol(
  modelId: string | null | undefined,
  protocol: string,
): boolean {
  if (!modelIdentityFor(modelId)) return true;
  return allowedProtocolsForModel(modelId).includes(protocol);
}
