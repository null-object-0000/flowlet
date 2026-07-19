import { invokeCommand, toAppError } from "../../platform/tauri/client";
import type { StorageUsageSummary } from "./types";

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
