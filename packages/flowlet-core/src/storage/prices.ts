// 价格表重建 + 价格解析：与 Rust `storage_tasks::rebuild_price_table` /
// `config.rs::ModelPrice::resolve_prices_at` 对齐。
//
// 数据来源（顺序与 Rust 一致）：
//   1. `<catalogDir>/models-cn.json`（国内厂商官方价，CNY，含促销/分档/生效窗口/每日峰谷）
//   2. `<catalogDir>/models-dev.json`（models.dev OpenAI 官方 API 价，USD）
//   3. config.json `channels_config.model_prices`（只补目录未覆盖的 (channel, model)）
//
// provider → Flowlet channel 映射来自 model-catalog.json（与 Rust
// `owner_channel_for_models_cn_provider` / models.dev 的 openai→openai-api 一致）。
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { modelCatalog } from "../catalog/index.ts";
import { parseChannelsConfig } from "../config/index.ts";
import type { JsonRow } from "../types.ts";

export const MODELS_CN_FILE = "models-cn.json";
export const MODELS_DEV_FILE = "models-dev.json";

export interface ModelPriceTier {
  up_to_input_tokens: number | null;
  input_uncached_price: number;
  input_cached_price: number;
  input_cache_write_price: number | null;
  output_price: number;
}

export interface ModelPriceDailyInterval {
  start: string;
  end: string;
  days: string[];
}

export interface ModelPriceDailyTimeRange {
  label: string;
  time_zone: string;
  intervals: ModelPriceDailyInterval[];
}

export interface ModelPriceSchedule {
  rate_type: string;
  effective_from: string | null;
  effective_to: string | null;
  daily_time_range: ModelPriceDailyTimeRange | null;
  input_uncached_price: number;
  input_cached_price: number;
  input_cache_write_price: number | null;
  output_price: number;
  tiers: ModelPriceTier[];
  source_url: string | null;
}

export interface ModelPrice {
  id: string;
  channel_id: string;
  upstream_model: string;
  input_uncached_price: number;
  input_cached_price: number;
  input_cache_write_price: number | null;
  output_price: number;
  tiers: ModelPriceTier[];
  schedules: ModelPriceSchedule[];
  currency: string;
  unit: string;
  source_url: string | null;
  price_version: string | null;
  created_at: string;
  updated_at: string;
}

type ResolvedPrices = [number, number, number | null, number];

function numOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nullableNum(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asObject(value: unknown): JsonRow | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRow) : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

// ─── 价格解析（Rust config.rs::resolve_prices_at） ───────────────────────────

function resolveTieredPrices(
  inputUncachedPrice: number,
  inputCachedPrice: number,
  inputCacheWritePrice: number | null,
  outputPrice: number,
  tiers: ModelPriceTier[],
  inputTokens: number | null,
): ResolvedPrices {
  if (tiers.length === 0) {
    return [inputUncachedPrice, inputCachedPrice, inputCacheWritePrice, outputPrice];
  }
  const input = inputTokens ?? 0;
  for (const tier of tiers) {
    const hit = tier.up_to_input_tokens === null || input <= tier.up_to_input_tokens;
    if (hit) {
      return [
        tier.input_uncached_price,
        tier.input_cached_price,
        tier.input_cache_write_price,
        tier.output_price,
      ];
    }
  }
  return [inputUncachedPrice, inputCachedPrice, inputCacheWritePrice, outputPrice];
}

function parsePriceTime(value: string, allowEndOfDay: boolean): number | null {
  if (allowEndOfDay && value === "24:00") return 24 * 60;
  const [hourText, minuteText, ...rest] = value.split(":");
  if (rest.length > 0 || hourText === undefined || minuteText === undefined) return null;
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour >= 24 || minute < 0 || minute >= 60) return null;
  return hour * 60 + minute;
}

const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

interface ZonedClock {
  minuteOfDay: number;
  weekday: string;
}

/** 把 UTC 时刻换算到 IANA 时区的“分钟数 + 星期”（Rust chrono_tz 语义）。 */
function zonedClock(atMs: number, timeZone: string): ZonedClock | null {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
    const parts = formatter.formatToParts(new Date(atMs));
    let hour: number | null = null;
    let minute: number | null = null;
    let weekday: string | null = null;
    for (const part of parts) {
      if (part.type === "hour") hour = Number(part.value);
      else if (part.type === "minute") minute = Number(part.value);
      else if (part.type === "weekday") {
        const index = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(part.value);
        weekday = index >= 0 ? WEEKDAY_KEYS[index] : null;
      }
    }
    if (hour === null || minute === null || weekday === null) return null;
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    return { minuteOfDay: hour * 60 + minute, weekday };
  } catch {
    // 时区名无效（Intl 抛 RangeError）→ Rust chrono_tz 解析失败同样返回 false。
    return null;
  }
}

function dailyTimeRangeContains(range: ModelPriceDailyTimeRange, atMs: number): boolean {
  const clock = zonedClock(atMs, range.time_zone);
  if (!clock) return false;
  return range.intervals.some((interval) => {
    if (interval.days.length > 0) {
      const day = clock.weekday;
      if (!interval.days.some((declared) => declared.toLowerCase() === day)) return false;
    }
    const start = parsePriceTime(interval.start, false);
    if (start === null) return false;
    const end = parsePriceTime(interval.end, true);
    if (end === null) return false;
    if (end > start) return clock.minuteOfDay >= start && clock.minuteOfDay < end;
    return clock.minuteOfDay >= start || clock.minuteOfDay < end;
  });
}

function parseRfc3339Ms(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function scheduleAppliesAt(schedule: ModelPriceSchedule, atMs: number): boolean {
  if (schedule.effective_from !== null) {
    const from = parseRfc3339Ms(schedule.effective_from);
    if (from === null || atMs < from) return false;
  }
  if (schedule.effective_to !== null) {
    const to = parseRfc3339Ms(schedule.effective_to);
    if (to === null || atMs >= to) return false;
  }
  if (schedule.daily_time_range !== null) {
    return dailyTimeRangeContains(schedule.daily_time_range, atMs);
  }
  return true;
}

function scheduleResolvePrices(schedule: ModelPriceSchedule, inputTokens: number | null): ResolvedPrices {
  return resolveTieredPrices(
    schedule.input_uncached_price,
    schedule.input_cached_price,
    schedule.input_cache_write_price,
    schedule.output_price,
    schedule.tiers,
    inputTokens,
  );
}

/**
 * Rust `ModelPrice::resolve_prices_at`：存在目录时段数据时只返回当前生效且命中
 * 每日时段的价格变体；无匹配返回 null（不用过期价格兜底）。
 */
export function resolvePricesAt(
  price: ModelPrice,
  inputTokens: number | null,
  atMs: number = Date.now(),
): ResolvedPrices | null {
  // 兼容 config.json 只给扁平价的旧价格对象（schedules/tiers 缺省视为空）。
  const schedules = price.schedules ?? [];
  const tiers = price.tiers ?? [];
  if (schedules.length === 0) {
    return resolveTieredPrices(
      price.input_uncached_price,
      price.input_cached_price,
      price.input_cache_write_price,
      price.output_price,
      tiers,
      inputTokens,
    );
  }
  let best: ModelPriceSchedule | null = null;
  let bestKey = -1;
  for (const schedule of schedules) {
    if (!scheduleAppliesAt(schedule, atMs)) continue;
    const key = schedule.rate_type === "promotional" ? 1 : 0;
    // Rust `max_by_key` 在并列时取最后一个匹配项。
    if (key >= bestKey) {
      best = schedule;
      bestKey = key;
    }
  }
  return best ? scheduleResolvePrices(best, inputTokens) : null;
}

/** Rust `ModelPrice::resolve_prices`：解析失败时回退扁平单价（= Utc::now 时刻）。 */
export function resolvePrices(
  price: ModelPrice,
  inputTokens: number | null,
  atMs: number = Date.now(),
): ResolvedPrices {
  const resolved = resolvePricesAt(price, inputTokens, atMs);
  if (resolved) return resolved;
  return [
    price.input_uncached_price,
    price.input_cached_price,
    price.input_cache_write_price,
    price.output_price,
  ];
}

// ─── models-cn → ModelPrice ─────────────────────────────────────────────────

interface BestModelPrice {
  market: string;
  currency: string;
  rate_type: string;
  input_standard: number;
  input_cache_hit: number;
  input_cache_write: number | null;
  output: number;
  source_url: string | null;
}

/** model-catalog.json 的 modelsCnProviderId → ownerChannelId（Rust owner_channel_for_models_cn_provider）。 */
export function providerIdToChannelId(providerId: string): string | null {
  const models = asArray(modelCatalog().raw().models);
  for (const entry of models) {
    const model = asObject(entry);
    if (!model) continue;
    if (model.modelsCnProviderId === providerId) {
      const owner = model.ownerChannelId;
      if (typeof owner === "string" && owner !== "") return owner;
    }
  }
  return null;
}

/** Rust `select_best_model_cn_price`：china+CNY+promotional 优先。 */
function selectBestModelCnPrice(model: JsonRow): BestModelPrice | null {
  const prices = asArray(model.prices).map(asObject).filter((item): item is JsonRow => item !== null);
  if (prices.length === 0) return null;
  let best: JsonRow | null = null;
  let bestScore = -1;
  for (const price of prices) {
    const market = typeof price.market === "string" ? price.market : "";
    const currency = typeof price.currency === "string" ? price.currency : "";
    const rateType = typeof price.rateType === "string" ? price.rateType : "";
    let score = 0;
    if (market === "china") score += 4;
    if (currency === "CNY") score += 2;
    if (rateType === "promotional") score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = price;
    }
  }
  return best ? parseModelCnPrice(best) : null;
}

function parseModelCnPrice(price: JsonRow): BestModelPrice | null {
  const input = asObject(price.input);
  if (!input) return null;
  const inputStandard = typeof input.standard === "number" ? input.standard : null;
  const output = typeof price.output === "number" ? price.output : null;
  if (inputStandard === null || output === null) return null;
  const inputCacheHit = typeof input.cacheHit === "number" ? input.cacheHit : inputStandard;
  const inputCacheWrite = nullableNum(input.explicitCacheCreation);
  return {
    market: typeof price.market === "string" ? price.market : "",
    currency: typeof price.currency === "string" ? price.currency : "",
    rate_type: typeof price.rateType === "string" ? price.rateType : "",
    input_standard: inputStandard,
    input_cache_hit: inputCacheHit,
    input_cache_write: inputCacheWrite,
    output,
    source_url: nullableString(price.sourceUrl),
  };
}

function buildPriceTiersFromRows(rows: JsonRow[]): ModelPriceTier[] {
  const ranged: Array<{ min: number; max: number; standard: number; cacheHit: number; cacheWrite: number | null; output: number }> = [];
  for (const price of rows) {
    const range = asObject(price.inputTokenRange);
    if (!range) continue;
    if (typeof range.maxInclusive !== "number") continue;
    const minExclusive = typeof range.minExclusive === "number" ? range.minExclusive : -1;
    const input = asObject(price.input);
    if (!input) continue;
    if (typeof input.standard !== "number") continue;
    if (typeof price.output !== "number") continue;
    const cacheHit = typeof input.cacheHit === "number" ? input.cacheHit : input.standard;
    ranged.push({
      min: minExclusive,
      max: range.maxInclusive,
      standard: input.standard,
      cacheHit,
      cacheWrite: nullableNum(input.explicitCacheCreation),
      output: price.output,
    });
  }
  if (ranged.length < 2) return [];
  ranged.sort((left, right) => (left.min !== right.min ? left.min - right.min : left.max - right.max));
  return ranged.map((entry, index) => ({
    up_to_input_tokens: index === ranged.length - 1 ? null : entry.max,
    input_uncached_price: entry.standard,
    input_cached_price: entry.cacheHit,
    input_cache_write_price: entry.cacheWrite,
    output_price: entry.output,
  }));
}

/** Rust `build_price_tiers`：与最优价同 (market, currency, rateType) 的区间行。 */
function buildPriceTiers(model: JsonRow, best: BestModelPrice): ModelPriceTier[] {
  const matching = asArray(model.prices)
    .map(asObject)
    .filter((price): price is JsonRow => price !== null)
    .filter((price) => {
      const market = typeof price.market === "string" ? price.market : "";
      const currency = typeof price.currency === "string" ? price.currency : "";
      const rateType = typeof price.rateType === "string" ? price.rateType : "";
      return market === best.market && currency === best.currency && rateType === best.rate_type;
    });
  return buildPriceTiersFromRows(matching);
}

/** Rust `build_price_schedules`：同 market/currency 的生效窗口/每日时段价格变体。 */
function buildPriceSchedules(model: JsonRow, best: BestModelPrice): ModelPriceSchedule[] {
  const prices = asArray(model.prices).map(asObject).filter((item): item is JsonRow => item !== null);
  const sameMarket = prices.filter(
    (price) =>
      (typeof price.market === "string" ? price.market : "") === best.market &&
      (typeof price.currency === "string" ? price.currency : "") === best.currency,
  );
  const hasScheduling = sameMarket.some(
    (price) =>
      price.effectiveFrom !== undefined ||
      price.effectiveTo !== undefined ||
      price.dailyTimeRange !== undefined,
  );
  if (!hasScheduling) return [];

  const groups = new Map<string, JsonRow[]>();
  for (const price of sameMarket) {
    const key = JSON.stringify({
      rateType: price.rateType ?? null,
      effectiveFrom: price.effectiveFrom ?? null,
      effectiveTo: price.effectiveTo ?? null,
      dailyTimeRange: price.dailyTimeRange ?? null,
    });
    const bucket = groups.get(key);
    if (bucket) bucket.push(price);
    else groups.set(key, [price]);
  }
  const schedules: ModelPriceSchedule[] = [];
  // Rust 用 BTreeMap 分组，按 key 排序输出（保证结果稳定）。
  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key)!;
    const representative =
      group.find((price) => price.inputTokenRange === undefined) ?? group[0];
    const parsed = parseModelCnPrice(representative);
    if (!parsed) continue;
    const rawRange = asObject(representative.dailyTimeRange);
    schedules.push({
      rate_type: parsed.rate_type,
      effective_from: nullableString(representative.effectiveFrom),
      effective_to: nullableString(representative.effectiveTo),
      daily_time_range: rawRange ? parseDailyTimeRange(rawRange) : null,
      input_uncached_price: parsed.input_standard,
      input_cached_price: parsed.input_cache_hit,
      input_cache_write_price: parsed.input_cache_write,
      output_price: parsed.output,
      tiers: buildPriceTiersFromRows(group),
      source_url: parsed.source_url,
    });
  }
  return schedules;
}

/** models-cn 的 dailyTimeRange 是 camelCase（timeZone/label/intervals）。 */
function parseDailyTimeRange(raw: JsonRow): ModelPriceDailyTimeRange {
  return {
    label: typeof raw.label === "string" ? raw.label : "",
    time_zone: typeof raw.timeZone === "string" ? raw.timeZone : "",
    intervals: asArray(raw.intervals)
      .map(asObject)
      .filter((item): item is JsonRow => item !== null)
      .map((interval) => ({
        start: typeof interval.start === "string" ? interval.start : "",
        end: typeof interval.end === "string" ? interval.end : "",
        days: asArray(interval.days).filter((day): day is string => typeof day === "string"),
      })),
  };
}

/** Rust `build_prices_from_models_cn_catalog`。 */
export function buildPricesFromModelsCnCatalog(catalogJson: string, now = new Date().toISOString()): ModelPrice[] {
  const catalog = JSON.parse(catalogJson) as JsonRow;
  const providers = asArray(catalog.providers);
  const prices: ModelPrice[] = [];
  for (const providerEntry of providers) {
    const provider = asObject(providerEntry);
    if (!provider) continue;
    const providerId = typeof provider.id === "string" ? provider.id : "";
    const channelId = providerIdToChannelId(providerId);
    if (!channelId) continue;
    for (const modelEntry of asArray(provider.models)) {
      const model = asObject(modelEntry);
      if (!model) continue;
      const upstreamModel = typeof model.id === "string" ? model.id : "";
      if (!upstreamModel) continue;
      const best = selectBestModelCnPrice(model);
      if (!best) continue;
      prices.push({
        id: `models-cn-${channelId}-${upstreamModel}`,
        channel_id: channelId,
        upstream_model: upstreamModel,
        input_uncached_price: best.input_standard,
        input_cached_price: best.input_cache_hit,
        input_cache_write_price: best.input_cache_write,
        output_price: best.output,
        tiers: buildPriceTiers(model, best),
        schedules: buildPriceSchedules(model, best),
        currency: "CNY",
        unit: "1M tokens",
        source_url: best.source_url,
        price_version: `models-cn ${now}`,
        created_at: now,
        updated_at: now,
      });
    }
  }
  return prices;
}

// ─── models.dev → ModelPrice ────────────────────────────────────────────────

function modelsDevProviderToChannelId(providerId: string): string | null {
  return providerId === "openai" ? "openai-api" : null;
}

/** Rust `build_models_dev_tiers`：base 价覆盖 ≤ 第一个 context size，其余逐档。 */
function buildModelsDevTiers(
  cost: JsonRow,
  baseInput: number,
  baseCacheRead: number | null,
  baseCacheWrite: number | null,
  baseOutput: number,
): ModelPriceTier[] {
  const contextTiers: Array<{ size: number; entry: JsonRow }> = [];
  for (const entryValue of asArray(cost.tiers)) {
    const entry = asObject(entryValue);
    if (!entry) continue;
    const tier = asObject(entry.tier);
    if (!tier || tier.type !== "context") continue;
    if (typeof tier.size !== "number") continue;
    contextTiers.push({ size: tier.size, entry });
  }
  if (contextTiers.length === 0) return [];
  contextTiers.sort((left, right) => left.size - right.size);
  const tiers: ModelPriceTier[] = [
    {
      up_to_input_tokens: contextTiers[0].size,
      input_uncached_price: baseInput,
      input_cached_price: baseCacheRead ?? baseInput,
      input_cache_write_price: baseCacheWrite,
      output_price: baseOutput,
    },
  ];
  contextTiers.forEach((item, index) => {
    const input = typeof item.entry.input === "number" ? item.entry.input : baseInput;
    const output = typeof item.entry.output === "number" ? item.entry.output : baseOutput;
    const cacheRead = nullableNum(item.entry.cache_read);
    const cacheWrite = nullableNum(item.entry.cache_write);
    const next = contextTiers[index + 1];
    tiers.push({
      up_to_input_tokens: next ? next.size : null,
      input_uncached_price: input,
      input_cached_price: cacheRead ?? input,
      input_cache_write_price: cacheWrite,
      output_price: output,
    });
  });
  return tiers;
}

/** Rust `build_prices_from_models_dev_catalog`（仅 openai → openai-api，USD）。 */
export function buildPricesFromModelsDevCatalog(catalogJson: string, now = new Date().toISOString()): ModelPrice[] {
  const catalog = asObject(JSON.parse(catalogJson) as unknown);
  if (!catalog) throw new Error("models.dev 顶层必须是 provider 对象");
  const prices: ModelPrice[] = [];
  for (const [providerId, providerValue] of Object.entries(catalog)) {
    const channelId = modelsDevProviderToChannelId(providerId);
    if (!channelId) continue;
    const provider = asObject(providerValue);
    if (!provider) continue;
    const models = asObject(provider.models);
    if (!models) continue;
    const sourceUrl = typeof provider.doc === "string" ? provider.doc : "https://models.dev/";
    for (const [modelId, modelValue] of Object.entries(models)) {
      if (modelId.trim() === "") continue;
      const model = asObject(modelValue);
      if (!model) continue;
      const cost = asObject(model.cost);
      if (!cost) continue;
      if (typeof cost.input !== "number" || typeof cost.output !== "number") continue;
      const cacheRead = nullableNum(cost.cache_read);
      const cacheWrite = nullableNum(cost.cache_write);
      prices.push({
        id: `models-dev-${channelId}-${modelId}`,
        channel_id: channelId,
        upstream_model: modelId,
        input_uncached_price: cost.input,
        input_cached_price: cacheRead ?? cost.input,
        input_cache_write_price: cacheWrite,
        output_price: cost.output,
        tiers: buildModelsDevTiers(cost, cost.input, cacheRead, cacheWrite, cost.output),
        schedules: [],
        currency: "USD",
        unit: "1M tokens",
        source_url: sourceUrl,
        price_version: `models.dev ${now}`,
        created_at: now,
        updated_at: now,
      });
    }
  }
  return prices;
}

// ─── 合并 / 重建 ────────────────────────────────────────────────────────────

/** Rust `merge_price_tables`：目录优先，config 仅补未覆盖 key；排除 codex-native。 */
export function mergePriceTables(catalogPrices: ModelPrice[], configPrices: ModelPrice[]): ModelPrice[] {
  const keys = new Set<string>();
  const merged: ModelPrice[] = [];
  for (const price of [...catalogPrices, ...configPrices]) {
    if (price.channel_id.toLowerCase() === "codex-native") continue;
    const key = `${price.channel_id.toLowerCase()}\0${price.upstream_model.toLowerCase()}`;
    if (keys.has(key)) continue;
    keys.add(key);
    merged.push(price);
  }
  return merged;
}

/** config.json `channels_config.model_prices` → ModelPrice（Rust ChannelConfigJson 的 price 部分）。 */
export function configPricesFromJson(configJson: JsonRow): ModelPrice[] {
  const prices = parseChannelsConfig(configJson).prices as JsonRow[];
  return prices.map((price) => ({
    id: String(price.id ?? `price-${price.channel_id}-${price.upstream_model}`),
    channel_id: String(price.channel_id ?? ""),
    upstream_model: String(price.upstream_model ?? ""),
    input_uncached_price: numOr(price.input_uncached_price, 0),
    input_cached_price: numOr(price.input_cached_price, 0),
    input_cache_write_price: nullableNum(price.input_cache_write_price),
    output_price: numOr(price.output_price, 0),
    tiers: asArray(price.tiers).map((tierValue) => {
      const tier = asObject(tierValue) ?? {};
      return {
        up_to_input_tokens: nullableNum(tier.up_to_input_tokens),
        input_uncached_price: numOr(tier.input_uncached_price, 0),
        input_cached_price: numOr(tier.input_cached_price, 0),
        input_cache_write_price: nullableNum(tier.input_cache_write_price),
        output_price: numOr(tier.output_price, 0),
      };
    }),
    schedules: [],
    currency: String(price.currency ?? ""),
    unit: String(price.unit ?? ""),
    source_url: nullableString(price.source_url),
    price_version: nullableString(price.price_version),
    created_at: String(price.created_at ?? ""),
    updated_at: String(price.updated_at ?? ""),
  }));
}

/** Rust `read_models_cn_file`/`read_models_dev_file` 的目录解析（FLOWLET_CATALOG_DIR 优先）。 */
export function resolveCatalogDir(catalogDir: string): string {
  return process.env.FLOWLET_CATALOG_DIR || catalogDir;
}

function readCatalogFile(catalogDir: string, fileName: string): string | null {
  const file = path.join(resolveCatalogDir(catalogDir), fileName);
  if (!existsSync(file)) return null;
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export interface PriceTableBuildResult {
  prices: ModelPrice[];
  count: number;
  catalogCount: number;
  configCount: number;
}

/**
 * Rust `storage_tasks::rebuild_price_table` 的等价实现：
 * models-cn + models.dev + config.json model_prices，合并后返回完整价格表。
 */
export function buildPriceTable(catalogDir: string, configJson: JsonRow): PriceTableBuildResult {
  const catalogPrices: ModelPrice[] = [];
  const modelsCn = readCatalogFile(catalogDir, MODELS_CN_FILE);
  if (modelsCn !== null) {
    try {
      catalogPrices.push(...buildPricesFromModelsCnCatalog(modelsCn));
    } catch {
      /* 解析失败：忽略该目录（Rust 记 warn 后继续） */
    }
  }
  const modelsDev = readCatalogFile(catalogDir, MODELS_DEV_FILE);
  if (modelsDev !== null) {
    try {
      catalogPrices.push(...buildPricesFromModelsDevCatalog(modelsDev));
    } catch {
      /* 解析失败：忽略该目录 */
    }
  }
  const configPrices = configPricesFromJson(configJson);
  const prices = mergePriceTables(catalogPrices, configPrices);
  return {
    prices,
    count: prices.length,
    catalogCount: catalogPrices.length,
    configCount: configPrices.length,
  };
}