import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MobileDeviceAgentsPage } from "./MobileDeviceAgentsPage";

vi.mock("lottie-web", () => ({
  default: { loadAnimation: vi.fn(() => ({ destroy: vi.fn() })) },
}));

vi.mock("../../features/device-sync/useMobileDeviceSync", () => ({
  useMobileDevices: () => ({ data: [{ deviceId: "device-1", displayName: "Office PC" }] }),
  useMobileS3Settings: () => ({ data: { config: null, status: { status: "never", message: "尚未同步" } }, isLoading: false }),
  useMobileDeviceSyncActions: () => ({
    saveS3Config: { isPending: false, mutateAsync: vi.fn() },
    testS3Connection: { isPending: false, mutateAsync: vi.fn() },
    refreshS3: { isPending: false, mutateAsync: vi.fn() },
  }),
  useMobileDeviceRefresh: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useMobileDeviceAgents: () => ({
    data: [{
      agentId: "claude-code",
      agentName: "Claude Code",
      installed: true,
      installations: [{ surface: "cli", installMethod: "npm", version: "1.2.3" }],
      flowletConfigState: "flowlet",
      flowletObserved: true,
    }],
    isLoading: false,
    isError: false,
  }),
}));

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/devices/device-1/agents"]}>
      <Routes>
        <Route path="/devices/:deviceId/agents" element={<MobileDeviceAgentsPage />} />
        <Route path="/devices" element={<span>devices list</span>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("MobileDeviceAgentsPage", () => {
  beforeEach(() => {
    vi.stubEnv("TAURI_ENV_PLATFORM", "android");
  });

  it("shows the device agent list without a bottom tab bar", () => {
    renderPage();
    expect(screen.getByRole("button", { name: "返回设备页" })).toBeInTheDocument();
    // 主标题带上设备名：设备名 + Agent
    expect(screen.getByRole("heading", { level: 1, name: "Office PC Agent" })).toBeInTheDocument();
    expect(screen.getByText("该设备已安装的 Agent 及其 Flowlet 接入状态")).toBeInTheDocument();
    expect(screen.getByText("Claude Code")).toBeInTheDocument();
    expect(screen.getByText("已接入 Flowlet")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "主导航" })).toBeNull();
  });

  it("returns to the device page via the back button", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "返回设备页" }));
    expect(screen.getByText("devices list")).toBeInTheDocument();
  });
});