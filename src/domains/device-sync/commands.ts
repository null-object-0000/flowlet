import { invokeCommand, toAppError } from "../../platform/tauri/client";
import type {
  DailyUsageTotal,
  DeviceUsageImportPreview,
  DeviceUsageImportResult,
  DeviceUsageSnapshot,
  KnownDevice,
  S3ConnectionTestResult,
  S3DevicePullResult,
  S3DeviceSyncResult,
  S3SyncConfigInput,
  S3SyncSettings,
} from "./types";

export const deviceSyncCommands = {
  snapshot: (): Promise<DeviceUsageSnapshot> =>
    invokeCommand<DeviceUsageSnapshot>("device_usage_snapshot")
      .catch((error: unknown) => {
        throw toAppError(error, "device_usage_snapshot_failed");
      }),
  devices: (): Promise<KnownDevice[]> =>
    invokeCommand<KnownDevice[]>("list_known_devices")
      .catch(toDeviceSyncError("device_list_failed")),
  dailyUsage: (deviceId: string | null): Promise<DailyUsageTotal[]> =>
    invokeCommand<DailyUsageTotal[]>("device_daily_usage", { deviceId })
      .catch(toDeviceSyncError("device_daily_usage_failed")),
  renameCurrentDevice: (displayName: string): Promise<void> =>
    invokeCommand<void>("rename_current_device", { displayName })
      .catch(toDeviceSyncError("device_rename_failed")),
  s3Settings: (): Promise<S3SyncSettings> =>
    invokeCommand<S3SyncSettings>("get_s3_sync_settings")
      .catch(toDeviceSyncError("s3_sync_settings_failed")),
  exportS3ConnectionConfig: (): Promise<S3SyncConfigInput> =>
    invokeCommand<S3SyncConfigInput>("export_s3_connection_config")
      .catch(toDeviceSyncError("s3_connection_export_failed")),
  saveS3Config: (config: S3SyncConfigInput): Promise<S3SyncSettings> =>
    invokeCommand<S3SyncSettings>("save_s3_sync_config", { config })
      .catch(toDeviceSyncError("s3_sync_config_save_failed")),
  testS3Connection: (config: S3SyncConfigInput): Promise<S3ConnectionTestResult> =>
    invokeCommand<S3ConnectionTestResult>("test_s3_sync_connection", { config }, 45_000)
      .catch(toDeviceSyncError("s3_sync_connection_test_failed")),
  syncS3: (): Promise<S3DeviceSyncResult> =>
    invokeCommand<S3DeviceSyncResult>("sync_device_usage_s3", undefined, Number.POSITIVE_INFINITY)
      .catch(toDeviceSyncError("s3_device_sync_failed")),
  exportBundle: (path: string): Promise<void> =>
    invokeCommand<void>("export_device_usage_bundle", { path })
      .catch(toDeviceSyncError("device_usage_export_failed")),
  previewImport: (path: string): Promise<DeviceUsageImportPreview> =>
    invokeCommand<DeviceUsageImportPreview>("preview_device_usage_import", { path })
      .catch(toDeviceSyncError("device_usage_import_preview_failed")),
  importBundle: (path: string): Promise<DeviceUsageImportResult> =>
    invokeCommand<DeviceUsageImportResult>("import_device_usage_bundle", { path })
      .catch(toDeviceSyncError("device_usage_import_failed")),
};

export const mobileDeviceSyncCommands = {
  devices: (): Promise<KnownDevice[]> =>
    invokeCommand<KnownDevice[]>("list_shared_devices")
      .catch(toDeviceSyncError("shared_device_list_failed")),
  dailyUsage: (deviceId: string | null): Promise<DailyUsageTotal[]> =>
    invokeCommand<DailyUsageTotal[]>("shared_device_daily_usage", { deviceId })
      .catch(toDeviceSyncError("shared_device_daily_usage_failed")),
  s3Settings: deviceSyncCommands.s3Settings,
  saveS3Config: deviceSyncCommands.saveS3Config,
  testS3Connection: (config: S3SyncConfigInput): Promise<S3ConnectionTestResult> =>
    invokeCommand<S3ConnectionTestResult>("test_s3_read_connection", { config }, 45_000)
      .catch(toDeviceSyncError("s3_read_connection_test_failed")),
  refreshS3: (): Promise<S3DevicePullResult> =>
    invokeCommand<S3DevicePullResult>("refresh_shared_device_usage_s3", undefined, Number.POSITIVE_INFINITY)
      .catch(toDeviceSyncError("s3_device_refresh_failed")),
};

function toDeviceSyncError(code: string) {
  return (error: unknown) => {
    throw toAppError(error, code);
  };
}
