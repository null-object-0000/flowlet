import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  submitTask: vi.fn(),
  setTaskStatus: vi.fn(),
  editTask: vi.fn(),
  deleteTask: vi.fn(),
  refreshLan: vi.fn(),
}));

vi.mock("../../domains/device-sync/commands", () => ({
  mobileDeviceSyncCommands: mocks,
}));

import { queryKeys } from "../../shared/query-keys";
import { useMobileDeleteTask, useMobileEditTask, useMobileSetTaskStatus, useMobileSubmitTask } from "./useMobileDeviceSync";

function createWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  return { queryClient, Wrapper };
}

describe("useMobileSubmitTask", () => {
  beforeEach(() => {
    mocks.submitTask.mockReset().mockResolvedValue({ taskId: "task-9", status: "draft" });
    mocks.refreshLan.mockReset().mockResolvedValue({ attemptedDevices: 1, refreshedDevices: 1, failedDevices: 0 });
  });

  it("refreshes the target device snapshot after a successful LAN submit so the list shows the new task", async () => {
    const { queryClient, Wrapper } = createWrapper();
    // 预置旧的 projects / devices 缓存，确保失效可观测。
    queryClient.setQueryData(queryKeys.mobileDeviceSync.projects(null), []);
    queryClient.setQueryData(queryKeys.mobileDeviceSync.devices(), []);

    const { result } = renderHook(() => useMobileSubmitTask("device-1"), { wrapper: Wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync({ projectId: "project-1", title: "新任务" }))
        .resolves.toEqual({ taskId: "task-9", status: "draft" });
    });

    expect(mocks.submitTask).toHaveBeenCalledWith("device-1", { projectId: "project-1", title: "新任务" });
    // 提交成功后先直连刷新目标设备快照，再失效项目 / 设备查询。
    expect(mocks.refreshLan).toHaveBeenCalledWith("device-1");
    expect(queryClient.getQueryState(queryKeys.mobileDeviceSync.projects(null))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(queryKeys.mobileDeviceSync.devices())?.isInvalidated).toBe(true);
  });

  it("keeps the submit successful when the follow-up LAN refresh fails", async () => {
    mocks.refreshLan.mockRejectedValue(new Error("lan gone"));
    const { queryClient, Wrapper } = createWrapper();
    queryClient.setQueryData(queryKeys.mobileDeviceSync.projects(null), []);

    const { result } = renderHook(() => useMobileSubmitTask("device-1"), { wrapper: Wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync({ projectId: "project-1", title: "新任务" }))
        .resolves.toEqual({ taskId: "task-9", status: "draft" });
    });

    expect(mocks.refreshLan).toHaveBeenCalledWith("device-1");
    expect(queryClient.getQueryState(queryKeys.mobileDeviceSync.projects(null))?.isInvalidated).toBe(true);
  });
});

describe("useMobileEditTask", () => {
  it("refreshes the target device snapshot after editing a draft task", async () => {
    mocks.editTask.mockReset().mockResolvedValue({ taskId: "task-1", status: "draft" });
    mocks.refreshLan.mockReset().mockResolvedValue({ attemptedDevices: 1, refreshedDevices: 1, failedDevices: 0 });
    const { queryClient, Wrapper } = createWrapper();
    queryClient.setQueryData(queryKeys.mobileDeviceSync.projects(null), []);

    const { result } = renderHook(() => useMobileEditTask("device-1"), { wrapper: Wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync({ taskId: "task-1", title: "新标题" }))
        .resolves.toEqual({ taskId: "task-1", status: "draft" });
    });

    expect(mocks.editTask).toHaveBeenCalledWith("device-1", { taskId: "task-1", title: "新标题" });
    expect(mocks.refreshLan).toHaveBeenCalledWith("device-1");
    expect(queryClient.getQueryState(queryKeys.mobileDeviceSync.projects(null))?.isInvalidated).toBe(true);
  });

  it("keeps the edit successful when the follow-up LAN refresh fails", async () => {
    mocks.editTask.mockReset().mockResolvedValue({ taskId: "task-1", status: "draft" });
    mocks.refreshLan.mockReset().mockRejectedValue(new Error("lan gone"));
    const { queryClient, Wrapper } = createWrapper();
    queryClient.setQueryData(queryKeys.mobileDeviceSync.projects(null), []);

    const { result } = renderHook(() => useMobileEditTask("device-1"), { wrapper: Wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync({ taskId: "task-1", title: "新标题" }))
        .resolves.toEqual({ taskId: "task-1", status: "draft" });
    });

    expect(mocks.editTask).toHaveBeenCalledWith("device-1", { taskId: "task-1", title: "新标题" });
    expect(mocks.refreshLan).toHaveBeenCalledWith("device-1");
    expect(queryClient.getQueryState(queryKeys.mobileDeviceSync.projects(null))?.isInvalidated).toBe(true);
  });
});

describe("useMobileDeleteTask", () => {
  it("refreshes the target device snapshot after deleting a draft task", async () => {
    mocks.deleteTask.mockReset().mockResolvedValue({ taskId: "task-1", status: "deleted" });
    mocks.refreshLan.mockReset().mockResolvedValue({ attemptedDevices: 1, refreshedDevices: 1, failedDevices: 0 });
    const { queryClient, Wrapper } = createWrapper();
    queryClient.setQueryData(queryKeys.mobileDeviceSync.projects(null), []);

    const { result } = renderHook(() => useMobileDeleteTask("device-1"), { wrapper: Wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync({ taskId: "task-1" }))
        .resolves.toEqual({ taskId: "task-1", status: "deleted" });
    });

    expect(mocks.deleteTask).toHaveBeenCalledWith("device-1", { taskId: "task-1" });
    expect(mocks.refreshLan).toHaveBeenCalledWith("device-1");
    expect(queryClient.getQueryState(queryKeys.mobileDeviceSync.projects(null))?.isInvalidated).toBe(true);
  });

  it("keeps the delete successful when the follow-up LAN refresh fails", async () => {
    mocks.deleteTask.mockReset().mockResolvedValue({ taskId: "task-1", status: "deleted" });
    mocks.refreshLan.mockReset().mockRejectedValue(new Error("lan gone"));
    const { queryClient, Wrapper } = createWrapper();
    queryClient.setQueryData(queryKeys.mobileDeviceSync.projects(null), []);

    const { result } = renderHook(() => useMobileDeleteTask("device-1"), { wrapper: Wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync({ taskId: "task-1" }))
        .resolves.toEqual({ taskId: "task-1", status: "deleted" });
    });

    expect(mocks.deleteTask).toHaveBeenCalledWith("device-1", { taskId: "task-1" });
    expect(mocks.refreshLan).toHaveBeenCalledWith("device-1");
    expect(queryClient.getQueryState(queryKeys.mobileDeviceSync.projects(null))?.isInvalidated).toBe(true);
  });
});

describe("useMobileSetTaskStatus", () => {
  it("refreshes the target device snapshot after a successful status change", async () => {
    mocks.setTaskStatus.mockReset().mockResolvedValue({ taskId: "task-1", status: "submitted" });
    mocks.refreshLan.mockReset().mockResolvedValue({ attemptedDevices: 1, refreshedDevices: 1, failedDevices: 0 });
    const { queryClient, Wrapper } = createWrapper();
    queryClient.setQueryData(queryKeys.mobileDeviceSync.projects(null), []);

    const { result } = renderHook(() => useMobileSetTaskStatus("device-1"), { wrapper: Wrapper });
    await act(async () => {
      await expect(result.current.mutateAsync({ taskId: "task-1", status: "submitted" }))
        .resolves.toEqual({ taskId: "task-1", status: "submitted" });
    });

    expect(mocks.setTaskStatus).toHaveBeenCalledWith("device-1", { taskId: "task-1", status: "submitted" });
    expect(mocks.refreshLan).toHaveBeenCalledWith("device-1");
    expect(queryClient.getQueryState(queryKeys.mobileDeviceSync.projects(null))?.isInvalidated).toBe(true);
  });
});
