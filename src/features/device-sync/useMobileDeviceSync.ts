import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { mobileDeviceSyncCommands } from "../../domains/device-sync/commands";
import { queryKeys } from "../../shared/query-keys";

export function useMobileDevices() {
  return useQuery({
    queryKey: queryKeys.mobileDeviceSync.devices(),
    queryFn: mobileDeviceSyncCommands.devices,
    staleTime: 15_000,
  });
}

export function useMobileDailyUsage(deviceId: string | null) {
  return useQuery({
    queryKey: queryKeys.mobileDeviceSync.dailyUsage(deviceId),
    queryFn: () => mobileDeviceSyncCommands.dailyUsage(deviceId),
    staleTime: 15_000,
  });
}

export function useMobileHourlyUsage(deviceId: string | null) {
  return useQuery({
    queryKey: queryKeys.mobileDeviceSync.hourlyUsage(deviceId),
    queryFn: () => mobileDeviceSyncCommands.hourlyUsage(deviceId),
    staleTime: 15_000,
  });
}

export function useMobileSessions(deviceId: string | null) {
  return useQuery({
    queryKey: queryKeys.mobileDeviceSync.sessions(deviceId),
    queryFn: () => mobileDeviceSyncCommands.sessions(deviceId),
    staleTime: 15_000,
  });
}

export function useMobileS3Settings() {
  return useQuery({
    queryKey: queryKeys.mobileDeviceSync.s3Settings(),
    queryFn: mobileDeviceSyncCommands.s3Settings,
    staleTime: 15_000,
  });
}

export function useMobileDeviceSyncActions() {
  const queryClient = useQueryClient();
  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.mobileDeviceSync.all });
  };
  const saveS3Config = useMutation({
    mutationFn: mobileDeviceSyncCommands.saveS3Config,
    onSuccess: invalidate,
  });
  const testS3Connection = useMutation({
    mutationFn: mobileDeviceSyncCommands.testS3Connection,
  });
  const refreshS3 = useMutation({
    mutationFn: mobileDeviceSyncCommands.refreshS3,
    onSettled: invalidate,
  });
  return { saveS3Config, testS3Connection, refreshS3 };
}
