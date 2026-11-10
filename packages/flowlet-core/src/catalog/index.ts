// Model identity catalog + models-cn/models-dev specs. Owner: node-storage.
//
// Rust 等价实现：core/model_catalog.rs、core/storage_tasks.rs（目录读取与归一）。
// 关键规则：别名/厂商前缀/大小写归一必须与 model-catalog.json 一致，入站模型名
// 必须先 normalize 再匹配路由（docs/migration/commands-and-schema.md §6）。
//
// `canonical_model_key` / `find` / `routing_model_id` 逐条对照 model_catalog.rs：
// - 查表键 = trim → 取最后一个 '/' 之后 → 小写；
// - 命中别名 → 规范模型 ID（小写，用于比较）；
// - `find` 返回目录里的**原始** id（保留 LongCat-2.0 这类大小写）；
// - `routingModelId` 未登记的名字原样返回。
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonRow } from "../types.ts";

/** model-catalog.json 的单个模型身份（camelCase，与 Rust serde 反序列化一致）。 */
export interface ModelIdentity {
  id: string;
  ownerChannelId: string;
  officialOwnerName?: string | null;
  modelsCnProviderId: string;
  aliases: string[];
}

export interface ModelCatalog {
  /** 入站模型名 → 规范模型 ID（未登记的名字原样返回）。 */
  routingModelId(name: string): string;
  /** 用于比较/索引的规范 key（小写，别名已归一）。 */
  canonicalKey(name: string): string;
  /** 规范模型 ID 是否在全局白名单内。 */
  isSupported(canonicalId: string): boolean;
  /** 按目录查找模型身份（返回目录原始 id）。 */
  find(name: string): ModelIdentity | null;
  /** 官方归属渠道（用于价格回退）。 */
  ownerChannelForModel(name: string): string | null;
  /** 全局白名单（目录顺序，原始大小写）。 */
  supportedModels(): string[];
  /** 目录原始数据（品牌/别名/价格归属等）。 */
  raw(): JsonRow;
  /** models-cn.json 解析结果（不存在时 null）。 */
  modelsCn(): JsonRow | null;
  modelsDev(): JsonRow | null;
}

function stripVendorPrefix(raw: string): string {
  const trimmed = raw.trim();
  const index = trimmed.lastIndexOf("/");
  return (index >= 0 ? trimmed.slice(index + 1) : trimmed).trim();
}

export class ModelCatalogImpl implements ModelCatalog {
  #models: ModelIdentity[];
  #canonicalIndex = new Map<string, number>();
  #aliasIndex = new Map<string, number>();
  #raw: JsonRow;
  #modelsCn: JsonRow | null;
  #modelsDev: JsonRow | null;

  constructor(raw: JsonRow, modelsCn: JsonRow | null, modelsDev: JsonRow | null) {
    this.#raw = raw;
    this.#modelsCn = modelsCn;
    this.#modelsDev = modelsDev;
    this.#models = Array.isArray(raw.models) ? (raw.models as ModelIdentity[]) : [];
    // 目录文件缺失/为空时退化为空目录（不阻断 Host 启动）；有内容时必须校验版本。
    if (this.#models.length > 0 && raw.schemaVersion !== 1) {
      throw new Error(`不支持的 model-catalog.json schemaVersion：${String(raw.schemaVersion)}`);
    }
    this.#models.forEach((model, index) => {
      const canonicalKey = model.id.trim().toLowerCase();
      if (this.#canonicalIndex.has(canonicalKey)) {
        throw new Error(`model-catalog.json 存在重复模型：${model.id}`);
      }
      this.#canonicalIndex.set(canonicalKey, index);
      for (const alias of model.aliases ?? []) {
        const aliasKey = alias.trim().toLowerCase();
        if (!aliasKey || aliasKey === canonicalKey || this.#aliasIndex.has(aliasKey)) {
          throw new Error(`model-catalog.json 存在无效或重复别名：${alias}`);
        }
        this.#aliasIndex.set(aliasKey, index);
      }
    });
    for (const alias of this.#aliasIndex.keys()) {
      if (this.#canonicalIndex.has(alias)) {
        throw new Error(`model-catalog.json 别名与规范模型 ID 冲突：${alias}`);
      }
    }
  }

  canonicalKey(name: string): string {
    const key = stripVendorPrefix(name).toLowerCase();
    const index = this.#aliasIndex.get(key);
    return index === undefined ? key : this.#models[index].id.trim().toLowerCase();
  }

  find(name: string): ModelIdentity | null {
    const index = this.#canonicalIndex.get(this.canonicalKey(name));
    return index === undefined ? null : this.#models[index];
  }

  routingModelId(name: string): string {
    const identity = this.find(name);
    return identity ? identity.id : name;
  }

  isSupported(canonicalId: string): boolean {
    return this.#canonicalIndex.has(this.canonicalKey(canonicalId));
  }

  ownerChannelForModel(name: string): string | null {
    return this.find(name)?.ownerChannelId ?? null;
  }

  supportedModels(): string[] {
    return this.#models.map((model) => model.id);
  }

  raw(): JsonRow {
    return this.#raw;
  }

  modelsCn(): JsonRow | null {
    return this.#modelsCn;
  }

  modelsDev(): JsonRow | null {
    return this.#modelsDev;
  }
}

function readJson(file: string): JsonRow | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as JsonRow;
  } catch {
    return null;
  }
}

/**
 * 与 Rust `model_catalog()` 等价的加载入口。
 *
 * Rust 把 model-catalog.json 编译进二进制；Node host 从仓库根/MVP 镜像路径读取。
 * 目录存在时优先读 `catalogDir/model-catalog.json`，否则回退 `repoRoot/model-catalog.json`。
 */
export function loadModelCatalog(catalogDir: string, repoRoot: string): ModelCatalog {
  const raw =
    readJson(path.join(catalogDir, "model-catalog.json")) ??
    readJson(path.join(repoRoot, "model-catalog.json")) ??
    readJson(path.join(MODULE_REPO_ROOT, "model-catalog.json")) ??
    {};
  const modelsCn =
    readJson(path.join(catalogDir, "models-cn.json")) ??
    readJson(path.join(repoRoot, "models-cn.json"));
  const modelsDev =
    readJson(path.join(catalogDir, "models-dev.json")) ??
    readJson(path.join(repoRoot, "models-dev.json"));
  const catalog = new ModelCatalogImpl(raw, modelsCn, modelsDev);
  // 进程级单例同步指向本次加载结果，供 config/proxy 中无 catalogDir 的调用方使用。
  defaultCatalog = catalog;
  return catalog;
}

/** 进程级单例（与 Rust `model_catalog()` 语义一致），供 catalog 目录未知的模块使用。 */
let defaultCatalog: ModelCatalog | null = null;

/** 本包所在仓库根（从 src/catalog 上溯四级），仅作为未显式传目录时的兜底。 */
const MODULE_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

export function setDefaultModelCatalog(catalog: ModelCatalog): void {
  defaultCatalog = catalog;
}

export function modelCatalog(): ModelCatalog {
  if (!defaultCatalog) {
    const catalogDir = process.env.FLOWLET_CATALOG_DIR || MODULE_REPO_ROOT;
    defaultCatalog = loadModelCatalog(catalogDir, MODULE_REPO_ROOT);
  }
  return defaultCatalog;
}

/** 当前目录是否已加载到模型身份（供 Host 启动时判断是否需要显式 loadModelCatalog）。 */
export function hasModelIdentityCatalog(): boolean {
  return defaultCatalog !== null && defaultCatalog.supportedModels().length > 0;
}

export function canonicalModelKey(modelId: string): string {
  return modelCatalog().canonicalKey(modelId);
}

export function routingModelId(modelId: string): string {
  return modelCatalog().routingModelId(modelId);
}

export function officialChannelIdForModel(modelId: string): string | null {
  return modelCatalog().ownerChannelForModel(modelId);
}
