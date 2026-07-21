import { invokeCommand, toAppError } from "../../platform/tauri/client";
import type { ModelPriceCurrencyEntry, StorageUsageSummary } from "./types";

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
