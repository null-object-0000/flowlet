import { invokeCommand, toAppError } from "../../platform/tauri/client";
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
  S3DevicePullResult,
  S3DeviceSyncResult,
  S3SyncConfigInput,
  S3SyncSettings,
  SharedAgentSession,
  SharedDeviceProject,
  SyncedAgentSession,
  SyncedAgentProfile,
  TaskStatusInput,
  TaskSubmitInput,
  TaskSubmitResult,
} from "./types";
import type { OpenCodePermissionDecision, OpenCodePermissionReport } from "../agent-session/types";

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
  lanServerStatus: (): Promise<LanServerReport> =>
    invokeCommand<LanServerReport>("lan_server_status")
      .catch(toDeviceSyncError("lan_server_status_failed")),
  probeLanPeers: (deviceId: string | null): Promise<LanPeerProbe[]> =>
    invokeCommand<LanPeerProbe[]>("probe_lan_peers", { deviceId })
      .catch(toDeviceSyncError("lan_peer_probe_failed")),
};

export const mobileDeviceSyncCommands = {
  devices: (): Promise<KnownDevice[]> =>
    invokeCommand<KnownDevice[]>("list_shared_devices")
      .catch(toDeviceSyncError("shared_device_list_failed")),
  agents: (deviceId: string): Promise<SyncedAgentProfile[]> =>
    invokeCommand<SyncedAgentProfile[]>("list_shared_device_agents", { deviceId })
      .catch(toDeviceSyncError("shared_device_agents_failed")),
  dailyUsage: (deviceId: string | null): Promise<DailyUsageTotal[]> =>
    invokeCommand<DailyUsageTotal[]>("shared_device_daily_usage", { deviceId })
      .catch(toDeviceSyncError("shared_device_daily_usage_failed")),
  hourlyUsage: (deviceId: string | null): Promise<HourlyUsageTotal[]> =>
    invokeCommand<HourlyUsageTotal[]>("shared_device_hourly_usage", { deviceId })
      .catch(toDeviceSyncError("shared_device_hourly_usage_failed")),
  sessions: (deviceId: string | null): Promise<SharedAgentSession[]> =>
    invokeCommand<SharedAgentSession[]>("list_shared_device_sessions", { deviceId })
      .catch(toDeviceSyncError("shared_device_sessions_failed")),
  refreshLan: (deviceId: string | null): Promise<{ attemptedDevices: number; refreshedDevices: number; failedDevices: number }> =>
    invokeCommand<{ attemptedDevices: number; refreshedDevices: number; failedDevices: number }>("refresh_shared_device_usage_lan", { deviceId })
      .catch(toDeviceSyncError("lan_device_refresh_failed")),
  refreshDevice: (deviceId: string): Promise<DeviceRefreshResult> =>
    invokeCommand<DeviceRefreshResult>("refresh_shared_device", { deviceId }, Number.POSITIVE_INFINITY)
      .catch(toDeviceSyncError("shared_device_refresh_failed")),
  refreshSessionLan: (deviceId: string, agentType: string, sessionId: string): Promise<SyncedAgentSession> =>
    invokeCommand<SyncedAgentSession>("refresh_shared_device_session_lan", { deviceId, agentType, sessionId })
      .catch(toDeviceSyncError("shared_device_session_lan_refresh_failed")),
  probeLanPeers: (deviceId: string | null): Promise<LanPeerProbe[]> =>
    invokeCommand<LanPeerProbe[]>("probe_lan_peers", { deviceId })
      .catch(toDeviceSyncError("lan_peer_probe_failed")),
  cachedLanProbes: (): Promise<LanPeerProbe[]> =>
    invokeCommand<LanPeerProbe[]>("list_cached_lan_probes")
      .catch(toDeviceSyncError("lan_peer_probe_failed")),
  s3Settings: deviceSyncCommands.s3Settings,
  saveS3Config: deviceSyncCommands.saveS3Config,
  testS3Connection: (config: S3SyncConfigInput): Promise<S3ConnectionTestResult> =>
    invokeCommand<S3ConnectionTestResult>("test_s3_read_connection", { config }, 45_000)
      .catch(toDeviceSyncError("s3_read_connection_test_failed")),
  refreshS3: (): Promise<S3DevicePullResult> =>
    invokeCommand<S3DevicePullResult>("refresh_shared_device_usage_s3", undefined, Number.POSITIVE_INFINITY)
      .catch(toDeviceSyncError("s3_device_refresh_failed")),
  remoteOpenCodePermissions: (deviceId: string, sessionId: string): Promise<OpenCodePermissionReport> =>
    invokeCommand<OpenCodePermissionReport>("list_remote_opencode_permissions", { deviceId, sessionId })
      .catch(toDeviceSyncError("remote_opencode_permission_list_failed")),
  replyRemoteOpenCodePermission: (
    deviceId: string,
    permissionId: string,
    decision: OpenCodePermissionDecision,
  ): Promise<void> =>
    invokeCommand<void>("reply_remote_opencode_permission", { deviceId, permissionId, decision })
      .catch(toDeviceSyncError("remote_opencode_permission_reply_failed")),
  projects: (deviceId: string | null): Promise<SharedDeviceProject[]> =>
    invokeCommand<SharedDeviceProject[]>("list_shared_device_projects", { deviceId })
      .catch(toDeviceSyncError("shared_device_projects_failed")),
  submitTask: (deviceId: string, input: TaskSubmitInput): Promise<TaskSubmitResult> =>
    invokeCommand<TaskSubmitResult>("submit_task_lan", { deviceId, input }, 15_000)
      .catch(toDeviceSyncError("lan_task_submit_failed")),
  setTaskStatus: (deviceId: string, input: TaskStatusInput): Promise<TaskSubmitResult> =>
    invokeCommand<TaskSubmitResult>("set_task_status_lan", { deviceId, ...input }, 15_000)
      .catch(toDeviceSyncError("lan_task_status_failed")),
};

function toDeviceSyncError(code: string): (error: unknown) => never {
  return (error: unknown) => {
    throw toAppError(error, code);
  };
}
