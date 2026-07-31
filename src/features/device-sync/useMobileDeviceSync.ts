import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { mobileDeviceSyncCommands } from "../../domains/device-sync/commands";
import { queryKeys } from "../../shared/query-keys";
import type { OpenCodePermissionDecision } from "../../domains/agent-session/types";

export function useMobileDevices() {
  return useQuery({
    queryKey: queryKeys.mobileDeviceSync.devices(),
    queryFn: mobileDeviceSyncCommands.devices,
    staleTime: 15_000,
  });
}

export function useMobileLanProbes(enabled = true) {
  return useQuery({
    queryKey: queryKeys.mobileDeviceSync.lanProbes(),
    queryFn: mobileDeviceSyncCommands.cachedLanProbes,
    staleTime: 60_000,
    refetchInterval: 30_000,
    retry: false,
    enabled,
  });
}

export function useMobileDeviceAgents(deviceId: string | null) {
  return useQuery({
    queryKey: queryKeys.mobileDeviceSync.agents(deviceId ?? "none"),
    queryFn: () => mobileDeviceSyncCommands.agents(deviceId!),
    enabled: deviceId != null,
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
    refetchInterval: 15_000,
  });
}

export function useMobileRemotePermissions(deviceId: string, sessionId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.mobileDeviceSync.permissions(deviceId, sessionId),
    queryFn: () => mobileDeviceSyncCommands.remoteOpenCodePermissions(deviceId, sessionId),
    enabled,
    refetchInterval: enabled ? 2_000 : false,
    retry: false,
  });
}

export function useReplyMobileRemotePermission(deviceId: string, sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ permissionId, decision }: { permissionId: string; decision: OpenCodePermissionDecision }) =>
      mobileDeviceSyncCommands.replyRemoteOpenCodePermission(deviceId, permissionId, decision),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.mobileDeviceSync.permissions(deviceId, sessionId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.mobileDeviceSync.sessions(deviceId) }),
      ]);
    },
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

/**
 * 监听 Rust 后台定时同步完成事件，触发本地 query 失效。
 * 同时在应用从后台恢复时立即失效一次，避免事件丢失导致数据陈旧。
 * 应在 MobileShell 中挂载一次，所有页面共享。
 */
export function useMobileDeviceSyncBackground() {
  const queryClient = useQueryClient();
  useEffect(() => {
    let stopped = false;
    const invalidate = () => {
      if (stopped) return;
      void queryClient.invalidateQueries({ queryKey: queryKeys.mobileDeviceSync.all });
    };
    let unlisten: UnlistenFn | undefined;
    listen("mobile-device-sync-updated", invalidate)
      .then((fn) => {
        if (stopped) {
          fn();
          return;
        }
        unlisten = fn;
      })
      .catch(() => undefined);
    const onVisibility = () => {
      if (!document.hidden) invalidate();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisibility);
      void unlisten?.();
    };
  }, [queryClient]);
}
