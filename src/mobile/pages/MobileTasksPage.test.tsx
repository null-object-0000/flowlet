import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MobileTasksPage } from "./MobileTasksPage";
import { MobileDeviceSelectionProvider } from "../MobileDeviceSelection";

const useMobileDevicesMock = vi.fn();
const useMobileProjectsMock = vi.fn();
const useMobileSubmitTaskMock = vi.fn();
const useMobileS3SettingsMock = vi.fn();
const refreshDeviceMock = vi.hoisted(() => vi.fn<() => Promise<unknown>>());
const refreshS3Mock = vi.hoisted(() => vi.fn<() => Promise<void>>());

vi.mock("lottie-web", () => ({
  default: { loadAnimation: vi.fn(() => ({ destroy: vi.fn() })) },
}));

vi.mock("../../features/device-sync/useMobileDeviceSync", () => ({
  useMobileDevices: () => useMobileDevicesMock(),
  useMobileProjects: (deviceId: string | null) => useMobileProjectsMock(deviceId),
  useMobileSubmitTask: (deviceId: string | null) => useMobileSubmitTaskMock(deviceId),
  useMobileS3Settings: () => useMobileS3SettingsMock(),
  useMobileDeviceSyncActions: () => ({
    saveS3Config: { isPending: false, mutateAsync: vi.fn() },
    testS3Connection: { isPending: false, mutateAsync: vi.fn() },
    refreshS3: { isPending: false, mutateAsync: refreshS3Mock },
  }),
  useMobileDeviceRefresh: () => ({ isPending: false, mutateAsync: refreshDeviceMock }),
}));

const PROJECT = {
  deviceId: "device-1",
  deviceDisplayName: "Office PC",
  devicePlatform: "windows",
  projectId: "project-1",
  projectName: "flowlet",
  hasLocalBinding: true,
  updatedAt: "2026-07-30T02:00:00Z",
  tasks: [
    { id: "task-1", title: "修复登录页", status: "submitted", priority: "p1", updatedAt: "2026-07-30T01:00:00Z" },
  ],
};

function renderPage() {
  return render(
    <MobileDeviceSelectionProvider>
      <MobileTasksPage />
    </MobileDeviceSelectionProvider>,
  );
}

describe("MobileTasksPage", () => {
  beforeEach(() => {
    refreshDeviceMock.mockReset().mockResolvedValue({ source: "lan", refreshedDevices: 1 });
    refreshS3Mock.mockReset().mockResolvedValue(undefined);
    useMobileDevicesMock.mockReturnValue({
      data: [{ deviceId: "device-1", displayName: "Office PC" }],
      isLoading: false,
      isError: false,
    });
    useMobileProjectsMock.mockReturnValue({
      data: [PROJECT],
      isLoading: false,
      isError: false,
    });
    useMobileSubmitTaskMock.mockReturnValue({
      isPending: false,
      mutateAsync: vi.fn(),
    });
    useMobileS3SettingsMock.mockReturnValue({
      data: { config: { endpoint: "https://oss.example.com" }, status: { status: "ok", lastSuccessAt: null } },
      isLoading: false,
    });
  });

  it("renders device projects and their tasks", () => {
    renderPage();
    expect(screen.getByText("flowlet")).toBeInTheDocument();
    expect(screen.getByText(/Office PC · 更新于/)).toBeInTheDocument();
    expect(screen.getByText("修复登录页")).toBeInTheDocument();
    expect(screen.getByText("可执行")).toBeInTheDocument();
  });

  it("refreshes the selected device via pull to refresh", async () => {
    renderPage();
    expect(screen.queryByRole("button", { name: "刷新" })).toBeNull();
    expect(screen.getByText("尚未成功刷新")).toBeInTheDocument();

    const page = screen.getByText("flowlet").closest("section")!;
    const pullSurface = page.parentElement!.parentElement!;
    fireEvent.touchStart(pullSurface, { touches: [{ clientY: 10 }] });
    fireEvent.touchMove(pullSurface, { touches: [{ clientY: 140 }] });
    fireEvent.touchEnd(pullSurface);

    await waitFor(() => expect(refreshDeviceMock).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByText(/最后刷新：/)).toBeInTheDocument());
    expect(refreshS3Mock).not.toHaveBeenCalled();
  });
});