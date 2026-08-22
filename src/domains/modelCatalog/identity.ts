import catalogJson from "../../../model-catalog.json";
import { MODEL_CATALOG_PLUGIN_SOURCE } from "../pluginRegistry";

export type ModelIdentity = {
  id: string;
  ownerChannelId: string;
  officialOwnerName?: string;
  modelsCnProviderId: string;
  aliases: string[];
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

export const MODEL_IDENTITIES: readonly ModelIdentity[] = catalog.models;
export const FLOWLET_SUPPORTED_MODELS: string[] = MODEL_IDENTITIES.map((model) => model.id);

export const DEFAULT_EXPOSED_MODELS_BY_CHANNEL: Record<string, string[]> =
  MODEL_IDENTITIES.reduce<Record<string, string[]>>((grouped, model) => {
    (grouped[model.ownerChannelId] ??= []).push(model.id);
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
