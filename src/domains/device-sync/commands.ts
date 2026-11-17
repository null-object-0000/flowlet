import { invokeCommand, toAppError } from "../../platform/host/client";
import type {
  DailyUsageTotal,
  DeviceUsageImportPreview,
  DeviceUsageImportResult,
  DeviceUsageSnapshot,
  DeviceRefreshResult,
  HourlyUsageTotal,
  KnownDevice,
  LanPeerProbe,
  LanServerReport,
  S3ConnectionTestResult,
  S3DeviceSyncResult,
  S3SyncConfigInput,
  S3SyncSettings,
  SharedAgentSession,
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
  hourlyUsage: (deviceId: string | null): Promise<HourlyUsageTotal[]> =>
    invokeCommand<HourlyUsageTotal[]>("device_hourly_usage", { deviceId })
      .catch(toDeviceSyncError("device_hourly_usage_failed")),
  /** 读取指定共享设备的 Agent 会话快照（桌面端会话管理页切换设备用）。 */
  sharedSessions: (deviceId: string | null): Promise<SharedAgentSession[]> =>
    invokeCommand<SharedAgentSession[]>("list_shared_device_sessions", { deviceId })
      .catch(toDeviceSyncError("shared_device_sessions_failed")),
  /** 桌面端指定设备刷新：先 LAN 直连，失败时读该设备唯一 S3 对象。 */
  refreshSharedDevice: (deviceId: string): Promise<DeviceRefreshResult> =>
    invokeCommand<DeviceRefreshResult>("refresh_shared_device", { deviceId }, Number.POSITIVE_INFINITY)
      .catch(toDeviceSyncError("shared_device_refresh_failed")),
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
  recoverCurrentDeviceSync: (): Promise<S3ConnectionTestResult> =>
    invokeCommand<S3ConnectionTestResult>("recover_current_device_sync", undefined, Number.POSITIVE_INFINITY)
      .catch(toDeviceSyncError("s3_device_sync_recovery_failed")),
  exportBundle: (path: string): Promise<void> =>
    invokeCommand<void>("export_device_usage_bundle", { path })
      .catch(toDeviceSyncError("device_usage_export_failed")),
  previewImport: (path: string): Promise<DeviceUsageImportPreview> =>
    invokeCommand<DeviceUsageImportPreview>("preview_device_usage_import", { path })
      .catch(toDeviceSyncError("device_usage_import_preview_failed")),
  importBundle: (path: string): Promise<DeviceUsageImportResult> =>
    invokeCommand<DeviceUsageImportResult>("import_device_usage_bundle", { path })
      .catch(toDeviceSyncError("device_usage_import_failed")),
  lanServerStatus: (): Promise<LanServerReport> =>
    invokeCommand<LanServerReport>("lan_server_status")
      .catch(toDeviceSyncError("lan_server_status_failed")),
  probeLanPeers: (deviceId: string | null): Promise<LanPeerProbe[]> =>
    invokeCommand<LanPeerProbe[]>("probe_lan_peers", { deviceId })
      .catch(toDeviceSyncError("lan_peer_probe_failed")),
};

function toDeviceSyncError(code: string): (error: unknown) => never {
  return (error: unknown) => {
    throw toAppError(error, code);
  };
}
