// 抓取到的资源包数组归一化（Rust `merge_longcat_token_packs` /
// `normalize_scrape_token_packs` / `longcat_list_item_as_pack` 等）。
//
// 背景：LongCat 的 summary（`token-packs/summary`）与 list（`token-packs/list`）
// 用两套 ID：summary 的 `lotId` 是内部批次 ID，list 的 `resourceId`/`packageId`
// 是套餐资源 ID。跨接口关联靠 `summary.bizOrderNo == "CEP-" + list.packageId`。
// list 只补充名称/状态等展示字段，summary 的额度数值保持权威。
import type { JsonRow } from "../types.ts";
import { parseJsonOrNull } from "./custom-registry.ts";

function asObject(value: unknown): JsonRow | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRow)
    : null;
}

/** Rust `longcat_list_item_as_pack`：把 list item 映射成 pack 形状。 */
export function longcatListItemAsPack(item: unknown): JsonRow | null {
  const source = asObject(item);
  if (source === null) return null;
  const resourceId = source["resourceId"] ?? source["packageId"];
  if (resourceId === undefined || resourceId === null) return null;
  const pack: JsonRow = {
    lotId: resourceId,
    packageId: resourceId,
    _fromList: true,
  };
  const mappings: ReadonlyArray<readonly [string, string]> = [
    ["packageName", "packageName"],
    ["sourceTypeCode", "sourceTypeCode"],
    ["sourceTypeText", "sourceTypeText"],
    ["statusCode", "statusCode"],
    ["statusText", "statusText"],
    ["displayStatusCode", "displayStatusCode"],
    ["displayStatusText", "displayStatusText"],
    ["totalTokenAmount", "totalToken"],
    ["usedTokenAmount", "consumedToken"],
    ["remainTokenAmount", "remainingToken"],
    ["validEndTime", "expireTime"],
    ["validStartTime", "validStartTime"],
    ["acquireTime", "acquireTime"],
    ["acquireDateText", "acquireDateText"],
    ["usagePercent", "usagePercent"],
    ["validDays", "validDays"],
    ["applicableModels", "applicableModels"],
    ["skuCode", "skuCode"],
    ["productId", "productId"],
  ];
  for (const [from, to] of mappings) {
    if (source[from] !== undefined) pack[to] = source[from];
  }
  return pack;
}

function jsonScalarString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/** Rust `longcat_pack_identity_keys`：跨接口关联用的身份键集合。 */
export function longcatPackIdentityKeys(pack: unknown): string[] {
  const row = asObject(pack);
  if (row === null) return [];
  const keys: string[] = [];
  const bizOrderNo = row["bizOrderNo"];
  if (typeof bizOrderNo === "string") {
    keys.push(`biz:${bizOrderNo}`);
    if (bizOrderNo.startsWith("CEP-")) keys.push(`package:${bizOrderNo.slice(4)}`);
  }
  const packageId = jsonScalarString(row["packageId"] ?? row["resourceId"]);
  if (packageId !== null) {
    keys.push(`package:${packageId}`);
    keys.push(`biz:CEP-${packageId}`);
  } else if (row["_fromList"] === true) {
    const lotId = jsonScalarString(row["lotId"]);
    if (lotId !== null) {
      keys.push(`package:${lotId}`);
      keys.push(`biz:CEP-${lotId}`);
    }
  }
  const lotId = jsonScalarString(row["lotId"]);
  if (lotId !== null) keys.push(`lot:${lotId}`);
  return keys;
}

/** Rust `merge_longcat_pack_details`：list 记录只补充字段，不覆盖 summary 的额度。 */
function mergeLongcatPackDetails(target: JsonRow, incoming: JsonRow): void {
  const targetFromList = target["_fromList"] === true;
  const incomingFromList = incoming["_fromList"] === true;
  if (targetFromList && !incomingFromList) {
    const merged = { ...incoming };
    enrichLongcatPackFromList(merged, target);
    for (const key of Object.keys(target)) delete target[key];
    Object.assign(target, merged);
    return;
  }
  if (incomingFromList) enrichLongcatPackFromList(target, incoming);
}

function enrichLongcatPackFromList(target: JsonRow, listPack: JsonRow): void {
  const packageId = listPack["packageId"] ?? listPack["lotId"];
  if (packageId !== undefined && packageId !== null) target["packageId"] = packageId;
  for (const field of [
    "packageName",
    "sourceTypeCode",
    "sourceTypeText",
    "statusCode",
    "statusText",
    "displayStatusCode",
    "displayStatusText",
    "validStartTime",
    "acquireTime",
    "acquireDateText",
    "usagePercent",
    "validDays",
    "applicableModels",
    "skuCode",
    "productId",
  ]) {
    if (listPack[field] !== undefined) target[field] = listPack[field];
  }
}

/**
 * Rust `merge_longcat_token_packs`：summary 优先（额度权威），list 补展示字段，
 * 最后按内部身份去重。返回 JSON 字符串；没有任何包时返回 null。
 */
export function mergeLongcatTokenPacks(
  slots: Map<string, string>,
  extracted: string | null,
): string | null {
  const candidates: JsonRow[] = [];

  const summaryRaw = slots.get("token_packs_summary");
  if (summaryRaw !== undefined) {
    const root = parseJsonOrNull(summaryRaw);
    const record = asObject(root);
    if (record !== null) {
      const data = asObject(record["data"]) ?? record;
      const current = asObject(data["currentLot"]);
      if (current !== null) candidates.push(current);
      const others = data["otherLots"];
      if (Array.isArray(others)) {
        for (const item of others) {
          const row = asObject(item);
          if (row !== null) candidates.push(row);
        }
      }
    }
  }

  if (extracted !== null) {
    const parsed = parseJsonOrNull(extracted);
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        const row = asObject(item);
        if (row !== null) candidates.push(row);
      }
    }
  }

  const listRaw = slots.get("token_packs_list");
  if (listRaw !== undefined) {
    const root = parseJsonOrNull(listRaw);
    const record = asObject(root);
    if (record !== null) {
      const data = asObject(record["data"]) ?? record;
      const items = data["items"];
      if (Array.isArray(items)) {
        for (const item of items) {
          const pack = longcatListItemAsPack(item);
          if (pack !== null) candidates.push(pack);
        }
      }
    }
  }

  const packs: JsonRow[] = [];
  const indexes = new Map<string, number>();
  for (const candidate of candidates) {
    let index: number | undefined;
    for (const key of longcatPackIdentityKeys(candidate)) {
      const found = indexes.get(key);
      if (found !== undefined) {
        index = found;
        break;
      }
    }
    if (index !== undefined) {
      mergeLongcatPackDetails(packs[index] as JsonRow, candidate);
      for (const key of longcatPackIdentityKeys(packs[index])) indexes.set(key, index);
    } else {
      const next = packs.length;
      packs.push(candidate);
      for (const key of longcatPackIdentityKeys(candidate)) indexes.set(key, next);
    }
  }

  return packs.length === 0 ? null : JSON.stringify(packs);
}

/**
 * Rust `normalize_scrape_token_packs`：
 * - Z.AI：extractor 已归一化为数组，直接透传；
 * - 其他渠道：extractor 产出了数组则透传，否则回退 LongCat 合并逻辑。
 */
export function normalizeScrapeTokenPacks(
  channelId: string,
  slots: Map<string, string>,
  extracted: string | null,
): string | null {
  if (channelId === "zhipu") return extracted;
  return mergeLongcatTokenPacks(slots, extracted);
}