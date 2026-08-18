import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { deviceSyncCommands } from "../../domains/device-sync/commands";
import { queryKeys } from "../../shared/query-keys";

export function useKnownDevices() {
  return useQuery({
    queryKey: queryKeys.deviceSync.devices(),
    queryFn: deviceSyncCommands.devices,
    networkMode: "always",
    staleTime: 15_000,
    retry: false,
  });
}

export function useDeviceDailyUsage(deviceId: string | null, enabled = true, autoRefresh = false) {
  return useQuery({
    queryKey: queryKeys.deviceSync.dailyUsage(deviceId),
    queryFn: () => deviceSyncCommands.dailyUsage(deviceId),
    networkMode: "always",
    staleTime: 15_000,
    retry: false,
    enabled,
    refetchOnWindowFocus: false,
    refetchInterval: autoRefresh ? 30_000 : false,
  });
}

export function useDeviceHourlyUsage(deviceId: string | null, enabled = true, autoRefresh = false) {
  return useQuery({
    queryKey: queryKeys.deviceSync.hourlyUsage(deviceId),
    queryFn: () => deviceSyncCommands.hourlyUsage(deviceId),
    networkMode: "always",
    staleTime: 15_000,
    retry: false,
    enabled,
    refetchOnWindowFocus: false,
    refetchInterval: autoRefresh ? 30_000 : false,
  });
}

/** 桌面端会话管理页读取指定共享设备的 Agent 会话快照。 */
export function useSharedDeviceSessions(deviceId: string | null, enabled = true, autoRefresh = false) {
  return useQuery({
    queryKey: queryKeys.deviceSync.sharedSessions(deviceId),
    queryFn: () => deviceSyncCommands.sharedSessions(deviceId),
    networkMode: "always",
    staleTime: 15_000,
    retry: false,
    enabled: enabled && deviceId != null,
    refetchOnWindowFocus: false,
    refetchInterval: autoRefresh ? 15_000 : false,
  });
}

/** 桌面端指定设备刷新：LAN 直连优先，失败时读该设备唯一 S3 对象。 */
export function useRefreshSharedDevice(deviceId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      if (!deviceId) throw new Error("未选择设备");
      return deviceSyncCommands.refreshSharedDevice(deviceId);
    },
    onSettled: async () => {
      if (!deviceId) return;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.deviceSync.sharedSessions(deviceId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.deviceSync.devices() }),
      ]);
    },
  });
}

export function useS3SyncSettings() {
  return useQuery({
    queryKey: queryKeys.deviceSync.s3Settings(),
    queryFn: deviceSyncCommands.s3Settings,
    networkMode: "always",
    staleTime: 15_000,
    retry: false,
  });
}

export function useLanServerStatus() {
  return useQuery({
    queryKey: queryKeys.deviceSync.lanServerStatus(),
    queryFn: deviceSyncCommands.lanServerStatus,
    networkMode: "always",
    staleTime: 10_000,
    retry: false,
  });
}

export function useLanProbes(enabled = true) {
  return useQuery({
    queryKey: queryKeys.deviceSync.lanProbes(),
    queryFn: () => deviceSyncCommands.probeLanPeers(null),
    networkMode: "always",
    staleTime: 10_000,
    retry: false,
    enabled,
  });
}

export function useDeviceUsageTransfer() {
  const queryClient = useQueryClient();
  const renameCurrentDevice = useMutation({
    mutationFn: deviceSyncCommands.renameCurrentDevice,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.deviceSync.devices() });
    },
  });
  const exportBundle = useMutation({ mutationFn: deviceSyncCommands.exportBundle });
  const exportS3ConnectionConfig = useMutation({
    mutationFn: deviceSyncCommands.exportS3ConnectionConfig,
  });
  const previewImport = useMutation({ mutationFn: deviceSyncCommands.previewImport });
  const importBundle = useMutation({
    mutationFn: deviceSyncCommands.importBundle,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.deviceSync.all });
    },
  });
  const saveS3Config = useMutation({
    mutationFn: deviceSyncCommands.saveS3Config,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.deviceSync.s3Settings() });
    },
  });
  const testS3Connection = useMutation({ mutationFn: deviceSyncCommands.testS3Connection });
  const syncS3 = useMutation({
    mutationFn: deviceSyncCommands.syncS3,
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.deviceSync.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.usage.all }),
      ]);
    },
  });
  const recoverCurrentDeviceSync = useMutation({
    mutationFn: deviceSyncCommands.recoverCurrentDeviceSync,
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.deviceSync.s3Settings() });
    },
  });
  return {
    renameCurrentDevice,
    exportBundle,
    exportS3ConnectionConfig,
    previewImport,
    importBundle,
    saveS3Config,
    testS3Connection,
    syncS3,
    recoverCurrentDeviceSync,
  };
}
