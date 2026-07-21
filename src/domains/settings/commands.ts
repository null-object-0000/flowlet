import { invokeCommand, toAppError } from "../../platform/tauri/client";
import type { ModelPriceCurrencyEntry, ModelPriceInfo, ModelPriceTierInfo, StorageUsageSummary } from "./types";

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

export async function exportAllData(destPath: string) {
  try {
    await invokeCommand<void>("export_all_data", { destPath }, Number.POSITIVE_INFINITY);
  } catch (error) {
    throw toAppError(error, "data_export_failed");
  }
}

export async function importAllData(sourcePath: string) {
  try {
    await invokeCommand<void>("import_all_data", { sourcePath }, Number.POSITIVE_INFINITY);
  } catch (error) {
    throw toAppError(error, "data_import_failed");
  }
}

export async function getStorageUsage(scanId: string) {
  try {
    return await invokeCommand<StorageUsageSummary>("storage_usage_summary", { scanId });
  } catch (error) {
    throw toAppError(error, "storage_usage_read_failed");
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
