import { afterEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn((_command: string, _args?: Record<string, unknown>): Promise<unknown> => Promise.resolve(undefined));

vi.mock("../../platform/tauri/client", () => ({
  invokeCommand: (command: string, args?: Record<string, unknown>) => invokeMock(command, args),
  toAppError: (error: unknown, code: string) => ({ code, message: String(error), retryable: true }),
}));

import { deviceSyncCommands, mobileDeviceSyncCommands } from "./commands";

afterEach(() => invokeMock.mockReset());

describe("deviceSyncCommands contract", () => {
  it("reads the minimal device usage snapshot through the typed Tauri boundary", async () => {
    const snapshot = {
      schemaVersion: 2,
      deviceId: "8d58734f-0b71-49ea-b5a4-115b389a9ae7",
      deviceCreatedAt: "2026-07-28T00:00:00Z",
      displayName: "Windows · 8D58",
      platform: "windows",
      appVersion: "0.1.0",
      generatedAt: "2026-07-28T01:00:00Z",
      timezoneOffsetMinutes: 480,
      days: [],
      hours: [],
    };
    invokeMock.mockResolvedValueOnce(snapshot);

    await expect(deviceSyncCommands.snapshot()).resolves.toEqual(snapshot);
    expect(invokeMock).toHaveBeenCalledWith("device_usage_snapshot", undefined);
  });

  it("passes device and file arguments through the typed boundary", async () => {
    invokeMock.mockResolvedValueOnce([]);
    await deviceSyncCommands.dailyUsage("device-1");
    expect(invokeMock).toHaveBeenLastCalledWith("device_daily_usage", { deviceId: "device-1" });

    invokeMock.mockResolvedValueOnce([]);
    await deviceSyncCommands.hourlyUsage(null);
    expect(invokeMock).toHaveBeenLastCalledWith("device_hourly_usage", { deviceId: null });

    invokeMock.mockResolvedValueOnce(undefined);
    await deviceSyncCommands.renameCurrentDevice("公司笔记本");
    expect(invokeMock).toHaveBeenLastCalledWith("rename_current_device", { displayName: "公司笔记本" });

    invokeMock.mockResolvedValueOnce(undefined);
    await deviceSyncCommands.exportBundle("C:/tmp/usage.json");
    expect(invokeMock).toHaveBeenLastCalledWith("export_device_usage_bundle", { path: "C:/tmp/usage.json" });
  });

  it("passes S3 configuration without exposing it through another domain", async () => {
    const config = {
      endpoint: "https://example.com",
      region: "auto",
      bucket: "flowlet-sync",
      prefix: "",
      accessKeyId: "access-key",
      secretAccessKey: "secret",
      pathStyle: true,
    };
    invokeMock.mockResolvedValueOnce({ message: "ok" });
    await deviceSyncCommands.testS3Connection(config);
    expect(invokeMock).toHaveBeenLastCalledWith("test_s3_sync_connection", { config });

    invokeMock.mockResolvedValueOnce(config);
    await deviceSyncCommands.exportS3ConnectionConfig();
    expect(invokeMock).toHaveBeenLastCalledWith("export_s3_connection_config", undefined);

    invokeMock.mockResolvedValueOnce(undefined);
    await deviceSyncCommands.syncS3();
    expect(invokeMock).toHaveBeenLastCalledWith("sync_device_usage_s3", undefined);
  });

  it("keeps cloud sync read-only while allowing authenticated LAN permission replies", async () => {
    const config = {
      endpoint: "https://example.com",
      region: "auto",
      bucket: "flowlet-sync",
      prefix: "users/me",
      accessKeyId: "read-only-key",
      secretAccessKey: "secret",
      pathStyle: false,
    };
    invokeMock.mockResolvedValueOnce([]);
    await mobileDeviceSyncCommands.devices();
    expect(invokeMock).toHaveBeenLastCalledWith("list_shared_devices", undefined);

    invokeMock.mockResolvedValueOnce([]);
    await mobileDeviceSyncCommands.agents("device-1");
    expect(invokeMock).toHaveBeenLastCalledWith("list_shared_device_agents", { deviceId: "device-1" });

    invokeMock.mockResolvedValueOnce([]);
    await mobileDeviceSyncCommands.dailyUsage(null);
    expect(invokeMock).toHaveBeenLastCalledWith("shared_device_daily_usage", { deviceId: null });

    invokeMock.mockResolvedValueOnce([]);
    await mobileDeviceSyncCommands.hourlyUsage("device-1");
    expect(invokeMock).toHaveBeenLastCalledWith("shared_device_hourly_usage", { deviceId: "device-1" });

    invokeMock.mockResolvedValueOnce([]);
    await mobileDeviceSyncCommands.sessions("device-1");
    expect(invokeMock).toHaveBeenLastCalledWith("list_shared_device_sessions", { deviceId: "device-1" });

    invokeMock.mockResolvedValueOnce({ attemptedDevices: 1, refreshedDevices: 1, failedDevices: 0 });
    await mobileDeviceSyncCommands.refreshLan("device-1");
    expect(invokeMock).toHaveBeenLastCalledWith("refresh_shared_device_usage_lan", { deviceId: "device-1" });

    invokeMock.mockResolvedValueOnce({ message: "ok" });
    await mobileDeviceSyncCommands.testS3Connection(config);
    expect(invokeMock).toHaveBeenLastCalledWith("test_s3_read_connection", { config });

    invokeMock.mockResolvedValueOnce({ remoteDevices: 1 });
    await mobileDeviceSyncCommands.refreshS3();
    expect(invokeMock).toHaveBeenLastCalledWith("refresh_shared_device_usage_s3", undefined);

    invokeMock.mockResolvedValueOnce({ available: true, permissions: [] });
    await mobileDeviceSyncCommands.remoteOpenCodePermissions("device-1", "session-1");
    expect(invokeMock).toHaveBeenLastCalledWith("list_remote_opencode_permissions", {
      deviceId: "device-1",
      sessionId: "session-1",
    });

    invokeMock.mockResolvedValueOnce(undefined);
    await mobileDeviceSyncCommands.replyRemoteOpenCodePermission("device-1", "permission-1", "allow_once");
    expect(invokeMock).toHaveBeenLastCalledWith("reply_remote_opencode_permission", {
      deviceId: "device-1",
      permissionId: "permission-1",
      decision: "allow_once",
    });
  });
});
