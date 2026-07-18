import { invokeCommand, toAppError } from "../../platform/tauri/client";

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

