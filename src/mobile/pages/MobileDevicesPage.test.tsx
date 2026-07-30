import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MobileDevicesPage } from "./MobileDevicesPage";

const useMobileDevicesMock = vi.fn();
const useMobileDeviceAgentsMock = vi.fn();

vi.mock("lottie-web", () => ({
  default: { loadAnimation: vi.fn(() => ({ destroy: vi.fn() })) },
}));

vi.mock("../../features/device-sync/useMobileDeviceSync", () => ({
  useMobileDevices: () => useMobileDevicesMock(),
  useMobileDeviceAgents: (deviceId: string | null) => useMobileDeviceAgentsMock(deviceId),
}));

describe("MobileDevicesPage", () => {
  beforeEach(() => {
    useMobileDevicesMock.mockReturnValue({
      data: [{
        deviceId: "device-1",
        deviceCreatedAt: "2026-07-01T00:00:00Z",
        displayName: "Office PC",
        platform: "windows",
        appVersion: "0.1.0",
        isCurrent: false,
        timezoneOffsetMinutes: 480,
        firstUsageDate: "2026-07-20",
        lastUsageDate: "2026-07-30",
        dayCount: 11,
        requestCount: 42,
        knownTokens: 12_000,
        lastSeenAt: "2026-07-30T02:00:00Z",
      }],
      isLoading: false,
      isError: false,
    });
    useMobileDeviceAgentsMock.mockReturnValue({
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
    });
  });

  it("expands a device and shows installed agents with Flowlet status", () => {
    render(<MobileDevicesPage />);

    expect(screen.queryByText("Claude Code")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Office PC/ }));

    expect(useMobileDeviceAgentsMock).toHaveBeenCalledWith("device-1");
    expect(screen.getByText("Claude Code")).toBeInTheDocument();
    expect(screen.getByText("CLI 1.2.3")).toBeInTheDocument();
    expect(screen.getByText("已接入 Flowlet")).toBeInTheDocument();
  });
});
