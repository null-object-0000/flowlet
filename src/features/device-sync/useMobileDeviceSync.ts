import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { mobileDeviceSyncCommands } from "../../domains/device-sync/commands";
import { queryKeys } from "../../shared/query-keys";
import type { OpenCodePermissionDecision } from "../../domains/agent-session/types";
import type { TaskStatusInput, TaskSubmitInput } from "../../domains/device-sync/types";

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

/**
 * 等待确认的会话需要最近一次交互作为审批依据，但移动端后台同步默认 5 分钟一次，
 * 缓存里的 lastInteraction 可能滞后。页面出现 waiting_user 会话时，对其所在设备
 * 做一次 best-effort LAN 快照刷新并失效对应 sessions query；每个设备每次页面挂载
 * 只刷一次，LAN 不可达时静默沿用缓存数据。
 */
export function useMobileWaitingSessionLanRefresh(deviceIds: string[]) {
  const queryClient = useQueryClient();
  const refreshedRef = useRef(new Set<string>());
  const idsKey = deviceIds.join("\n");
  useEffect(() => {
    for (const deviceId of idsKey.split("\n").filter(Boolean)) {
      if (refreshedRef.current.has(deviceId)) continue;
      refreshedRef.current.add(deviceId);
      mobileDeviceSyncCommands
        .refreshLan(deviceId)
        .then(() => queryClient.invalidateQueries({ queryKey: queryKeys.mobileDeviceSync.sessions(deviceId) }))
        .catch(() => undefined);
    }
  }, [idsKey, queryClient]);
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

/** 共享设备项目目录：移动端任务提交入口的数据源。
 *  deviceId 传 null 表示读取全部设备的项目快照（跨设备任务混合展示用）。 */
export function useMobileProjects(deviceId: string | null) {
  return useQuery({
    queryKey: queryKeys.mobileDeviceSync.projects(deviceId),
    queryFn: () => mobileDeviceSyncCommands.projects(deviceId),
    staleTime: 15_000,
  });
}

/** 向指定设备提交任务（签名 LAN 通道）。任务默认以草稿状态创建。
 *  deviceId 由页面从表单选中的可执行项目派生；成功后失效全部设备项目，保证跨设备混合列表即时更新。 */
export function useMobileSubmitTask(deviceId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: TaskSubmitInput) => {
      if (!deviceId) throw new Error("请先选择设备");
      return mobileDeviceSyncCommands.submitTask(deviceId, input);
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.mobileDeviceSync.projects(null) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.mobileDeviceSync.devices() }),
      ]);
    },
  });
}

/** 通过签名 LAN 通道提交 / 撤回任务（草稿 ↔ 已提交），与 PC 看板交互一致。 */
export function useMobileSetTaskStatus(deviceId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: TaskStatusInput) => {
      if (!deviceId) throw new Error("请先选择设备");
      return mobileDeviceSyncCommands.setTaskStatus(deviceId, input);
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.mobileDeviceSync.projects(null) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.mobileDeviceSync.devices() }),
      ]);
    },
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

export function useMobileDeviceRefresh(deviceId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      if (!deviceId) throw new Error("请先选择设备");
      return mobileDeviceSyncCommands.refreshDevice(deviceId);
    },
    onSettled: async () => {
      if (!deviceId) return;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.mobileDeviceSync.devices() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.mobileDeviceSync.agents(deviceId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.mobileDeviceSync.dailyUsage(deviceId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.mobileDeviceSync.hourlyUsage(deviceId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.mobileDeviceSync.sessions(deviceId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.mobileDeviceSync.projects(deviceId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.mobileDeviceSync.lanProbes() }),
      ]);
    },
  });
}

export function useMobileSessionLanRefresh(session: {
  deviceId: string;
  agentType: string;
  sessionId: string;
} | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      if (!session) throw new Error("未选择会话");
      return mobileDeviceSyncCommands.refreshSessionLan(
        session.deviceId,
        session.agentType,
        session.sessionId,
      );
    },
    onSuccess: async () => {
      if (!session) return;
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.mobileDeviceSync.sessions(session.deviceId),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.mobileDeviceSync.permissions(session.deviceId, session.sessionId),
        }),
      ]);
    },
  });
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
