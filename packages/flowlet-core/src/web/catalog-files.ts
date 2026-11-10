// 模型目录文件 / 自定义抓取描述符读取。Owner: node-web.
//
// 权威实现：src-tauri/src/core/storage_tasks.rs（models-cn / models.dev 读取、
// get_models_cn_currencies）与 core/custom_scrape.rs（list_channels）。
// Web 命令只读文件，不触发同步任务；目录路径来自 HostOptions.catalogDir。
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

import type { JsonRow } from "../types.ts";
import { CommandError } from "../types.ts";

function readTextOrNull(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** `get_models_cn_catalog`：返回本地 models-cn.json 原文（不存在 → null）。 */
export function readModelsCnCatalog(catalogDir: string): string | null {
  return readTextOrNull(path.join(catalogDir, "models-cn.json"));
}

/** `get_models_dev_provider_catalog`：抽取单个 provider 子集，返回 JSON 字符串或 null。 */
export function readModelsDevProviderCatalog(catalogDir: string, providerId: string): string | null {
  const raw = readTextOrNull(path.join(catalogDir, "models-dev.json"));
  if (raw === null) return null;
  let catalog: unknown;
  try {
    catalog = JSON.parse(raw);
  } catch {
    return null;
  }
  if (catalog === null || typeof catalog !== "object" || Array.isArray(catalog)) return null;
  const value = (catalog as JsonRow)[providerId];
  if (value === undefined) return null;
  // Rust 侧 serde_json::Value 的对象键按 BTreeMap 排序；这里递归排序保持字符串等价。
  return stableStringify({ [providerId]: value });
}

/** 与 serde_json 默认（无 preserve_order）一致的对象键排序序列化。 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as JsonRow)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const MODEL_CATALOG_PATH = fileURLToPath(new URL("../../../../model-catalog.json", import.meta.url));

let cachedCatalog: JsonRow | null = null;

/** 读取仓库内置 model-catalog.json（模型 → 渠道归属 / models-cn provider 映射）。 */
export function modelCatalogRaw(): JsonRow {
  if (cachedCatalog !== null) return cachedCatalog;
  try {
    const parsed: unknown = JSON.parse(readFileSync(MODEL_CATALOG_PATH, "utf8"));
    cachedCatalog = parsed !== null && typeof parsed === "object" ? (parsed as JsonRow) : {};
  } catch {
    cachedCatalog = {};
  }
  return cachedCatalog;
}

function ownerChannelForModelsCnProvider(providerId: string): string | null {
  const catalog = modelCatalogRaw();
  const models = catalog.models;
  if (!Array.isArray(models)) return null;
  for (const model of models) {
    if (model === null || typeof model !== "object") continue;
    const row = model as JsonRow;
    if (row.modelsCnProviderId === providerId && typeof row.ownerChannelId === "string") {
      return row.ownerChannelId;
    }
  }
  return null;
}

/** Rust `storage_tasks::get_models_cn_currencies`：[(channelId:modelId, currency)]。 */
export function readModelsCnCurrencies(catalogDir: string): [string, string][] {
  const raw = readModelsCnCatalog(catalogDir);
  if (raw === null) return [];
  let catalog: unknown;
  try {
    catalog = JSON.parse(raw);
  } catch (error) {
    throw CommandError.badRequest(
      `解析 models-cn JSON 失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const providers =
    catalog !== null && typeof catalog === "object" && !Array.isArray(catalog)
      ? (catalog as JsonRow).providers
      : undefined;
  if (!Array.isArray(providers)) throw CommandError.badRequest("models-cn 缺少 providers 字段");
  const result: [string, string][] = [];
  for (const provider of providers) {
    if (provider === null || typeof provider !== "object") continue;
    const providerRow = provider as JsonRow;
    const providerId = typeof providerRow.id === "string" ? providerRow.id : "";
    const channelId = ownerChannelForModelsCnProvider(providerId);
    if (channelId === null) continue;
    const models = providerRow.models;
    if (!Array.isArray(models)) continue;
    for (const model of models) {
      if (model === null || typeof model !== "object") continue;
      const row = model as JsonRow;
      const upstreamModel = typeof row.id === "string" ? row.id : "";
      if (upstreamModel === "") continue;
      result.push([`${channelId}:${upstreamModel}`, currencyOf(row)]);
    }
  }
  return result;
}

function currencyOf(model: JsonRow): string {
  const prices = model.prices;
  if (Array.isArray(prices)) {
    for (const price of prices) {
      if (price === null || typeof price !== "object") continue;
      const row = price as JsonRow;
      if (row.market === "china" && row.currency === "CNY") return "CNY";
    }
    const first = prices[0];
    if (first !== null && typeof first === "object" && typeof (first as JsonRow).currency === "string") {
      return (first as JsonRow).currency as string;
    }
  }
  return "CNY";
}

// ─── 自定义抓取渠道（custom-scrape 描述符） ─────────────────────────────────

export interface CustomScrapeChannelInfo {
  channelId: string;
  accountName: string | null;
}

/** Rust `custom_scrape::discovery_roots`：exe 同级目录优先，其次 ~/.flowlet。 */
function discoveryRoots(): string[] {
  const roots: string[] = [];
  const script = process.argv[1];
  const exeDir = script ? path.dirname(path.resolve(script)) : path.dirname(process.execPath);
  roots.push(path.join(exeDir, "custom-scrape"));
  roots.push(path.join(homedir(), ".flowlet", "custom-scrape"));
  return roots;
}

/** Rust `custom_scrape::list_channels` 的最小等价：列出通过基础校验的描述符。 */
export function listCustomScrapeChannels(): CustomScrapeChannelInfo[] {
  const seen = new Set<string>();
  const result: CustomScrapeChannelInfo[] = [];
  for (const root of discoveryRoots()) {
    let entries: string[];
    try {
      if (!statSync(root).isDirectory()) continue;
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of entries) {
      const dir = path.join(root, name);
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      if (!existsSync(path.join(dir, "manifest.json"))) continue;
      const dirName = name.toLowerCase();
      if (seen.has(dirName)) continue;
      seen.add(dirName);
      const info = loadCustomScrapeDescriptor(dir);
      if (info !== null) result.push(info);
    }
  }
  return result;
}

function loadCustomScrapeDescriptor(dir: string): CustomScrapeChannelInfo | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8"));
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const manifest = raw as JsonRow;
  if (manifest.schemaVersion !== 1) return null;
  const channelId = typeof manifest.channelId === "string" ? manifest.channelId.trim() : "";
  if (channelId === "") return null;
  const accountName =
    typeof manifest.accountName === "string" && manifest.accountName.trim() !== ""
      ? manifest.accountName.trim()
      : null;
  const fallback = manifest.fallback === true;
  if (channelId === "custom" && accountName === null && !fallback) return null;
  const modes = manifest.modes;
  const resourceModes = manifest.resourceModes;
  if (!Array.isArray(resourceModes) || resourceModes.length === 0) return null;
  if (modes === null || typeof modes !== "object" || Array.isArray(modes)) return null;
  for (const entry of resourceModes) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
    const mode = entry as JsonRow;
    if (typeof mode.resourceMode !== "string" || mode.resourceMode.trim() === "") return null;
    if (typeof mode.modeKey !== "string" || mode.modeKey.trim() === "") return null;
    if (!Object.prototype.hasOwnProperty.call(modes, mode.modeKey.trim())) return null;
  }
  return { channelId, accountName };
}