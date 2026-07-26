import { invokeCommand, toAppError } from "../../platform/tauri/client";

export type AppDiagnostics = {
  os: string;
  database: string;
  proxy: string;
};

export type AppMeta = {
  version: string;
  dataDir: string;
  diagnostics: AppDiagnostics;
};

export async function getAppVersion(): Promise<string> {
  try {
    return await invokeCommand<string>("get_app_version");
  } catch (error) {
    throw toAppError(error, "app_version_read_failed");
  }
}

export async function getAppDataDir(): Promise<string> {
  try {
    return await invokeCommand<string>("get_app_data_dir");
  } catch (error) {
    throw toAppError(error, "app_data_dir_read_failed");
  }
}

export async function getAppDiagnostics(): Promise<AppDiagnostics> {
  try {
    return await invokeCommand<AppDiagnostics>("get_app_diagnostics");
  } catch (error) {
    throw toAppError(error, "app_diagnostics_read_failed");
  }
}
