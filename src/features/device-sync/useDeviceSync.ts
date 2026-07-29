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

export function useDeviceDailyUsage(deviceId: string | null, enabled = true) {
  return useQuery({
    queryKey: queryKeys.deviceSync.dailyUsage(deviceId),
    queryFn: () => deviceSyncCommands.dailyUsage(deviceId),
    networkMode: "always",
    staleTime: 15_000,
    retry: false,
    enabled,
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
  return {
    renameCurrentDevice,
    exportBundle,
    exportS3ConnectionConfig,
    previewImport,
    importBundle,
    saveS3Config,
    testS3Connection,
    syncS3,
  };
}
