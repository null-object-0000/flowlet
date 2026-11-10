// Model identity / capability index for the proxy.
//
// 权威实现：`src-tauri/src/core/model_catalog.rs`（别名与厂商前缀归一）、
// `model_input_capabilities.rs`（图片输入模态），两者都只读 model-catalog.json /
// models-cn.json / models-dev.json。这里在 proxy 内自行构建索引，不依赖 catalog
// 模块的 `routingModelId` 实现细节（契约只保证 raw/modelsCn/modelsDev 返回原始文档）。
import type { ModelCatalog } from "../catalog/index.ts";
import { asArray, isRecord, str, type JsonRow } from "./util.ts";

export interface ModelIdentity {
  id: string;
  ownerChannelId: string;
  modelsCnProviderId: string;
  aliases: string[];
}

const DEEPSEEK_REASONING_MODELS = new Set([
  "deepseek-v4-flash",
  "deepseek-v4.1-flash",
  "deepseek-v4-flash-vision-exp",
  "deepseek-v4-pro",
]);

const RETIRED_AGGREGATE_MODELS = new Set(["flowlet-pro", "flowlet-flash"]);

export interface ModelsCnMatch {
  model: JsonRow;
  retrievedAt: string | null;
}

export class ModelIdentityIndex {
  #models: ModelIdentity[] = [];
  #canonicalIndex = new Map<string, number>();
  #aliasIndex = new Map<string, number>();
  #modalities = new Map<string, Set<string>>();
  #modelsCnKeys = new Set<string>();
  #modelsCnProviders: { providerId: string; models: JsonRow[] }[] = [];

  constructor(catalog: ModelCatalog) {
    const raw = catalog.raw();
    for (const entry of asArray(isRecord(raw) ? raw.models : [])) {
      const id = str(entry.id) ?? "";
      if (!id.trim()) continue;
      const identity: ModelIdentity = {
        id,
        ownerChannelId: str(entry.ownerChannelId) ?? "",
        modelsCnProviderId: str(entry.modelsCnProviderId) ?? "",
        aliases: asArray<unknown>(entry.aliases).filter((value): value is string => typeof value === "string"),
      };
      this.#canonicalIndex.set(id.trim().toLowerCase(), this.#models.length);
      for (const alias of identity.aliases) {
        const key = alias.trim().toLowerCase();
        if (key) this.#aliasIndex.set(key, this.#models.length);
      }
      this.#models.push(identity);
    }
    this.#mergeModelsCn(catalog.modelsCn());
    this.#mergeModelsDev(catalog.modelsDev());
  }

  /** Rust `canonical_model_key`：去厂商前缀 + lower + 别名表。 */
  canonicalKey(modelId: string): string {
    const raw = modelId.trim();
    const slash = raw.lastIndexOf("/");
    const key = (slash >= 0 ? raw.slice(slash + 1) : raw).trim().toLowerCase();
    const index = this.#aliasIndex.get(key);
    return index === undefined ? key : this.#models[index].id.trim().toLowerCase();
  }

  find(modelId: string): ModelIdentity | undefined {
    const index = this.#canonicalIndex.get(this.canonicalKey(modelId));
    return index === undefined ? undefined : this.#models[index];
  }

  /** 入站模型名 → 规范模型 ID；未登记原样返回（Rust `routing_model_id`）。 */
  routingModelId(name: string): string {
    const identity = this.find(name);
    return identity ? identity.id : name;
  }

  isRetiredAggregateModelId(modelId: string): boolean {
    return RETIRED_AGGREGATE_MODELS.has(modelId.trim().toLowerCase());
  }

  isDeepseekReasoningModel(modelId: string): boolean {
    return DEEPSEEK_REASONING_MODELS.has(this.canonicalKey(modelId));
  }

  supportsImage(modelId: string): boolean {
    const modalities = this.#modalities.get(this.canonicalKey(modelId));
    return modalities !== undefined && modalities.has("image");
  }

  findModelsCnModel(modelId: string): ModelsCnMatch | undefined {
    const identity = this.find(modelId);
    if (!identity) return undefined;
    const canonical = this.canonicalKey(identity.id);
    for (const provider of this.#modelsCnProviders) {
      if (provider.providerId !== identity.modelsCnProviderId) continue;
      const model = provider.models.find(
        (candidate) => this.canonicalKey(str(candidate.id) ?? "") === canonical,
      );
      if (!model) return undefined;
      let retrievedAt: string | null = null;
      for (const source of asArray(model.sources)) {
        if (str(source.kind) !== "pricing") continue;
        const value = str(source.retrievedAt);
        if (value && (retrievedAt === null || value < retrievedAt)) retrievedAt = value;
      }
      return { model, retrievedAt };
    }
    return undefined;
  }

  #mergeModelsCn(raw: JsonRow | null): void {
    if (!isRecord(raw)) return;
    for (const provider of asArray(raw.providers)) {
      const providerId = str(provider.id);
      if (!providerId) continue;
      const models = asArray(provider.models);
      this.#modelsCnProviders.push({ providerId, models });
      for (const model of models) {
        const modelId = str(model.id);
        if (modelId === undefined) continue;
        const identity = this.find(modelId);
        if (!identity || identity.modelsCnProviderId !== providerId) continue;
        const key = this.canonicalKey(modelId);
        this.#modelsCnKeys.add(key);
        this.#setModalities(key, model.capabilities?.inputModalities);
      }
    }
  }

  #mergeModelsDev(raw: JsonRow | null): void {
    if (!isRecord(raw)) return;
    const providers: [string, string][] = [
      ["openrouter", "openrouter"],
      ["openai", "openai-api"],
    ];
    for (const [providerId, ownerId] of providers) {
      const provider = raw[providerId];
      const models = isRecord(provider) && isRecord(provider.models) ? provider.models : null;
      if (!models) continue;
      for (const [modelId, model] of Object.entries(models)) {
        const identity = this.find(modelId);
        const key = this.canonicalKey(modelId);
        if (!identity || identity.ownerChannelId !== ownerId || this.#modelsCnKeys.has(key)) {
          continue;
        }
        this.#setModalities(key, isRecord(model) ? model.modalities?.input : undefined);
      }
    }
  }

  #setModalities(key: string, values: unknown): void {
    const set = new Set<string>();
    for (const value of asArray<unknown>(values)) {
      if (typeof value !== "string") continue;
      const normalized = value.trim().toLowerCase();
      if (normalized) set.add(normalized);
    }
    this.#modalities.set(key, set);
  }
}