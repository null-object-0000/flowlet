import { invokeCommand, toAppError } from "../../platform/tauri/client";
import { isWebHost } from "../../platform/web/mode";
import type { LogCaptureConfig, UpstreamProxyConfig, UsageCostDisplayConfig } from "./types";
import type { DatabaseCompactionResult, ModelPriceCurrencyEntry, ModelPriceInfo, ModelPriceTierInfo, StorageUsageSummary } from "./types";

export async function getLogCaptureConfig(): Promise<LogCaptureConfig> {
  try {
    return await invokeCommand<LogCaptureConfig>("get_log_capture_config");
  } catch (error) {
    throw toAppError(error, "log_capture_read_failed");
  }
}

export async function setLogCaptureConfig(config: LogCaptureConfig): Promise<void> {
  try {
    await invokeCommand<void>("set_log_capture_config", { config });
  } catch (error) {
    throw toAppError(error, "log_capture_update_failed");
  }
}

export const DEFAULT_USAGE_COST_DISPLAY_CONFIG: UsageCostDisplayConfig = {
  currency_conversion_enabled: false,
  display_currency: "CNY",
  usd_to_cny_rate: 7.2,
  exchange_rate_note: "",
};

/** Web Host stores this config in SQLite `app_meta` instead of config.json. */
const USAGE_COST_DISPLAY_META_KEY = "usage_cost_display_config";

export async function getUsageCostDisplayConfig(): Promise<UsageCostDisplayConfig> {
  try {
    if (isWebHost) {
      const raw = await invokeCommand<string | null>("read_app_meta", { key: USAGE_COST_DISPLAY_META_KEY });
      return parseUsageCostDisplayMeta(raw);
    }
    const raw = await invokeCommand<string>("read_config");
    return parseUsageCostDisplayConfig(raw);
  } catch (error) {
    throw toAppError(error, "usage_cost_config_read_failed");
  }
}

export async function setUsageCostDisplayConfig(config: UsageCostDisplayConfig): Promise<UsageCostDisplayConfig> {
  const normalized = normalizeUsageCostDisplayConfig(config);
  try {
    if (isWebHost) {
      await invokeCommand<void>("write_app_meta", {
        key: USAGE_COST_DISPLAY_META_KEY,
        value: JSON.stringify(normalized),
      });
      return normalized;
    }
    const raw = await invokeCommand<string>("read_config");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("config.json 顶层必须是对象");
    }
    const updated = { ...(parsed as Record<string, unknown>), usage_cost: normalized };
    await invokeCommand<void>("write_config", { content: `${JSON.stringify(updated, null, 2)}\n` });
    return normalized;
  } catch (error) {
    throw toAppError(error, "usage_cost_config_update_failed");
  }
}

/** Parse the `usage_cost_display_config` app_meta payload used by Web Host.
 *  Missing, empty, malformed or non-object JSON falls back to defaults. */
export function parseUsageCostDisplayMeta(raw: string | null | undefined): UsageCostDisplayConfig {
  if (raw == null || raw === "") return { ...DEFAULT_USAGE_COST_DISPLAY_CONFIG };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_USAGE_COST_DISPLAY_CONFIG };
  }
  return normalizeUsageCostDisplayConfig(parsed);
}

export function parseUsageCostDisplayConfig(rawConfigJson: string): UsageCostDisplayConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawConfigJson);
  } catch {
    return { ...DEFAULT_USAGE_COST_DISPLAY_CONFIG };
  }
  const usageCost = (parsed as { usage_cost?: unknown } | null)?.usage_cost;
  if (typeof usageCost !== "object" || usageCost === null || Array.isArray(usageCost)) {
    return { ...DEFAULT_USAGE_COST_DISPLAY_CONFIG };
  }
  return normalizeUsageCostDisplayConfig(usageCost);
}

/** Normalize any JSON value into a `UsageCostDisplayConfig`. Shared by the
 *  desktop config.json parser and the Web Host app_meta reader/writer so both
 *  transports enforce identical validation rules. */
export function normalizeUsageCostDisplayConfig(value: unknown): UsageCostDisplayConfig {
  const config = typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const rate = typeof config.usd_to_cny_rate === "number" && Number.isFinite(config.usd_to_cny_rate)
    && config.usd_to_cny_rate > 0
    ? config.usd_to_cny_rate
    : DEFAULT_USAGE_COST_DISPLAY_CONFIG.usd_to_cny_rate;
  return {
    currency_conversion_enabled: config.currency_conversion_enabled === true,
    display_currency: config.display_currency === "USD" ? "USD" : "CNY",
    usd_to_cny_rate: rate,
    exchange_rate_note: typeof config.exchange_rate_note === "string" ? config.exchange_rate_note.trim() : "",
  };
}

export const DEFAULT_UPSTREAM_PROXY_CONFIG: UpstreamProxyConfig = {
  enabled: false,
  url: "",
};

export async function getUpstreamProxyConfig(): Promise<UpstreamProxyConfig> {
  try {
    const config = await invokeCommand<UpstreamProxyConfig>("get_upstream_proxy_config");
    return normalizeUpstreamProxyConfig(config);
  } catch (error) {
    throw toAppError(error, "upstream_proxy_config_read_failed");
  }
}

export async function setUpstreamProxyConfig(
  config: UpstreamProxyConfig,
): Promise<UpstreamProxyConfig> {
  const normalized = normalizeUpstreamProxyConfig(config);
  try {
    await invokeCommand<void>("set_upstream_proxy_config", { config: normalized });
    return normalized;
  } catch (error) {
    throw toAppError(error, "upstream_proxy_config_update_failed");
  }
}

export function parseUpstreamProxyConfig(raw: unknown): UpstreamProxyConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ...DEFAULT_UPSTREAM_PROXY_CONFIG };
  }
  const value = raw as Record<string, unknown>;
  return normalizeUpstreamProxyConfig({
    enabled: value.enabled === true,
    url: typeof value.url === "string" ? value.url : "",
  });
}

function normalizeUpstreamProxyConfig(
  config: UpstreamProxyConfig | undefined,
): UpstreamProxyConfig {
  const url = typeof config?.url === "string" ? config.url.trim() : "";
  return {
    enabled: config?.enabled === true && url.length > 0,
    url,
  };
}

export async function cleanupExpiredBodyData(retentionDays: number): Promise<number> {
  try {
    return await invokeCommand<number>("cleanup_expired_body_data", { retentionDays });
  } catch (error) {
    throw toAppError(error, "body_cleanup_failed");
  }
}

export async function getAutostartEnabled() {
  try {
    return await invokeCommand<boolean>("is_autostart_enabled");
  } catch (error) {
    throw toAppError(error, "autostart_read_failed");
  }
}

export async function setAutostartEnabled(enabled: boolean) {
  try {
    await invokeCommand<void>(enabled ? "enable_autostart" : "disable_autostart");
    return await invokeCommand<boolean>("is_autostart_enabled");
  } catch (error) {
    throw toAppError(error, "autostart_update_failed");
  }
}

export async function getStorageUsage(scanId: string) {
  try {
    return await invokeCommand<StorageUsageSummary>("storage_usage_summary", { scanId });
  } catch (error) {
    throw toAppError(error, "storage_usage_read_failed");
  }
}

export async function compactDatabase(): Promise<DatabaseCompactionResult> {
  try {
    return await invokeCommand<DatabaseCompactionResult>("compact_database", undefined, Number.POSITIVE_INFINITY);
  } catch (error) {
    throw toAppError(error, "database_compaction_failed");
  }
}

export async function getModelPriceCurrencies(): Promise<ModelPriceCurrencyEntry[]> {
  try {
    const raw = await invokeCommand<string>("read_config");
    return parseModelPriceCurrencies(raw);
  } catch (error) {
    throw toAppError(error, "config_read_failed");
  }
}

export async function getModelPrices(): Promise<ModelPriceInfo[]> {
  try {
    const raw = await invokeCommand<string>("read_config");
    return parseModelPrices(raw);
  } catch (error) {
    throw toAppError(error, "config_read_failed");
  }
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseModelPriceTier(entry: unknown): ModelPriceTierInfo | null {
  if (typeof entry !== "object" || entry === null) return null;
  const { up_to_input_tokens, input_uncached_price, input_cached_price, input_cache_write_price, output_price } =
    entry as Record<string, unknown>;
  const inputUncached = asFiniteNumber(input_uncached_price);
  const inputCached = asFiniteNumber(input_cached_price);
  const output = asFiniteNumber(output_price);
  if (inputUncached == null || inputCached == null || output == null) return null;
  const upTo = up_to_input_tokens == null ? null : asFiniteNumber(up_to_input_tokens);
  if (up_to_input_tokens != null && upTo == null) return null;
  const cacheWrite =
    input_cache_write_price == null ? null : asFiniteNumber(input_cache_write_price);
  if (input_cache_write_price != null && cacheWrite == null) return null;
  return {
    up_to_input_tokens: upTo,
    input_uncached_price: inputUncached,
    input_cached_price: inputCached,
    input_cache_write_price: cacheWrite,
    output_price: output,
  };
}

/** Extract full per-model pricing from raw config.json text. Tolerates
 *  malformed JSON and unexpected shapes: consumers degrade to "—" rows
 *  rather than failing when pricing data is absent. Entries missing required
 *  numeric fields are dropped, matching `parseModelPriceCurrencies` style. */
export function parseModelPrices(rawConfigJson: string): ModelPriceInfo[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawConfigJson);
  } catch {
    return [];
  }
  const root = parsed as { channels_config?: { model_prices?: unknown }; model_prices?: unknown } | null;
  const prices = root?.channels_config?.model_prices ?? root?.model_prices;
  if (!Array.isArray(prices)) return [];
  return prices.flatMap((entry): ModelPriceInfo[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const {
      channel_id,
      upstream_model,
      input_uncached_price,
      input_cached_price,
      input_cache_write_price,
      output_price,
      tiers,
      currency,
      unit,
      source_url,
      price_version,
    } = entry as Record<string, unknown>;
    if (typeof channel_id !== "string" || typeof upstream_model !== "string") return [];
    const inputUncached = asFiniteNumber(input_uncached_price);
    const inputCached = asFiniteNumber(input_cached_price);
    const output = asFiniteNumber(output_price);
    if (inputUncached == null || inputCached == null || output == null) return [];
    const cacheWrite =
      input_cache_write_price == null ? null : asFiniteNumber(input_cache_write_price);
    if (input_cache_write_price != null && cacheWrite == null) return [];
    const parsedTiers = Array.isArray(tiers)
      ? tiers.flatMap((tier) => {
          const parsedTier = parseModelPriceTier(tier);
          return parsedTier ? [parsedTier] : [];
        })
      : [];
    return [{
      channel_id,
      upstream_model,
      input_uncached_price: inputUncached,
      input_cached_price: inputCached,
      input_cache_write_price: cacheWrite,
      output_price: output,
      tiers: parsedTiers,
      currency: typeof currency === "string" && currency.trim() ? currency : "USD",
      unit: typeof unit === "string" && unit.trim() ? unit : "1M tokens",
      source_url: typeof source_url === "string" ? source_url : null,
      price_version: typeof price_version === "string" ? price_version : null,
    }];
  });
}

/** Extract per-model cost currencies from raw config.json text. Tolerates
 *  malformed JSON and unexpected shapes: the usage page degrades to
 *  symbol-less amounts rather than failing when pricing data is absent. */
export function parseModelPriceCurrencies(rawConfigJson: string): ModelPriceCurrencyEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawConfigJson);
  } catch {
    return [];
  }
  const root = parsed as { channels_config?: { model_prices?: unknown }; model_prices?: unknown } | null;
  const prices = root?.channels_config?.model_prices ?? root?.model_prices;
  if (!Array.isArray(prices)) return [];
  return prices.flatMap((entry): ModelPriceCurrencyEntry[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const { channel_id, upstream_model, currency } = entry as Record<string, unknown>;
    if (typeof channel_id !== "string" || typeof upstream_model !== "string") return [];
    return [{ channel_id, upstream_model, currency: typeof currency === "string" ? currency : null }];
  });
}
