import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MobileDevicesPage } from "./MobileDevicesPage";

const useMobileDevicesMock = vi.fn();
const useMobileAccountResourcesMock = vi.fn();
const useMobileDeviceAgentsMock = vi.fn();
const useMobileLanProbesMock = vi.fn();
const useMobileSessionsMock = vi.fn();
const refreshMock = vi.hoisted(() => vi.fn<() => Promise<void>>());

vi.mock("lottie-web", () => ({
  default: { loadAnimation: vi.fn(() => ({ destroy: vi.fn() })) },
}));

vi.mock("../../features/device-sync/useMobileDeviceSync", () => ({
  useMobileDevices: () => useMobileDevicesMock(),
  useMobileAccountResources: () => useMobileAccountResourcesMock(),
  useMobileDeviceAgents: (deviceId: string | null) => useMobileDeviceAgentsMock(deviceId),
  useMobileLanProbes: () => useMobileLanProbesMock(),
  useMobileSessions: (deviceId: string | null) => useMobileSessionsMock(deviceId),
}));

vi.mock("../useMobileRefreshController", () => ({
  useMobileRefreshController: () => ({
    refresh: refreshMock,
    loading: false,
    disabled: false,
    lastSuccessAt: "2026-07-30T02:03:04Z",
  }),
}));

const DEVICE = {
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
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/devices"]}>
      <Routes>
        <Route path="/devices" element={<MobileDevicesPage />} />
        <Route path="/devices/:deviceId/sessions" element={<span>sessions sub</span>} />
        <Route path="/devices/:deviceId/agents" element={<span>agents sub</span>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("MobileDevicesPage", () => {
  beforeEach(() => {
    refreshMock.mockReset().mockResolvedValue(undefined);
    useMobileDevicesMock.mockReturnValue({
      data: [DEVICE],
      isLoading: false,
      isError: false,
    });
    useMobileAccountResourcesMock.mockReturnValue({
      data: [],
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
    useMobileSessionsMock.mockReturnValue({
      data: [{
        deviceId: "device-1",
        deviceDisplayName: "Office PC",
        devicePlatform: "windows",
        agentType: "claude-code",
        sessionId: "session-1",
        parentSessionId: null,
        runtimeStatus: "running",
        title: "Fix parser",
        clientName: "Claude Code",
        activityAt: "2026-07-30T01:00:00Z",
        flowletObserved: true,
        requestCount: 3,
        errorCount: 0,
        knownTokens: 800,
        lastInteraction: null,
      }],
      isLoading: false,
      isError: false,
    });
    useMobileLanProbesMock.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
    });
  });

  it("uses page pull-to-refresh without a header refresh button", async () => {
    renderPage();
    expect(screen.queryByRole("button", { name: "刷新" })).toBeNull();
    expect(screen.getByText(/最后刷新：/)).toBeInTheDocument();

    const page = screen.getByText("资源").closest("section")!;
    const pullSurface = page.parentElement!;
    fireEvent.touchStart(pullSurface, { touches: [{ clientY: 10 }] });
    fireEvent.touchMove(pullSurface, { touches: [{ clientY: 140 }] });
    fireEvent.touchEnd(pullSurface);

    expect(refreshMock).toHaveBeenCalledOnce();
  });

  it("places account resources before synchronized devices", () => {
    renderPage();
    const accountHeading = screen.getByText("账号资源");
    const deviceHeading = screen.getByText("同步设备");
    expect(accountHeading.compareDocumentPosition(deviceHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("expands a device into session and agent entry cards instead of inline agents", () => {
    renderPage();

    expect(screen.queryByText("Claude Code")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Office PC/ }));

    expect(useMobileSessionsMock).toHaveBeenCalledWith("device-1");
    expect(useMobileDeviceAgentsMock).toHaveBeenCalledWith("device-1");

    // 两个聚合入口卡片，展示核心信息。
    expect(screen.getByText("会话")).toBeInTheDocument();
    expect(screen.getByText(/1 个会话/)).toBeInTheDocument();
    expect(screen.getByText("Agent")).toBeInTheDocument();
    expect(screen.getByText(/1 个已安装 Agent/)).toBeInTheDocument();

    // 已安装 Agent 明细不再直接展示在设备页，需进入 Agent 二级页。
    expect(screen.queryByText("Claude Code")).not.toBeInTheDocument();
    expect(screen.queryByText("CLI 1.2.3")).not.toBeInTheDocument();
  });

  it("navigates to the session and agent sub-pages from the entry cards", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: /Office PC/ }));

    fireEvent.click(screen.getByRole("button", { name: /会话/ }));
    expect(screen.getByText("sessions sub")).toBeInTheDocument();
  });

  it("navigates to the agent sub-page from the agent entry card", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: /Office PC/ }));

    fireEvent.click(screen.getByRole("button", { name: /Agent/ }));
    expect(screen.getByText("agents sub")).toBeInTheDocument();
  });

  it("shows cloud-only badge when device has no LAN descriptor", () => {
    useMobileLanProbesMock.mockReturnValue({
      data: [{ deviceId: "device-1", lanPublished: false, reachable: false, latencyMs: null, protocolVersion: null, errorKind: null, error: null }],
      isLoading: false,
      isError: false,
    });
    renderPage();
    expect(screen.getByText("仅云端")).toBeInTheDocument();
  });

  it("shows direct latency badge when device is reachable", () => {
    useMobileLanProbesMock.mockReturnValue({
      data: [{ deviceId: "device-1", lanPublished: true, reachable: true, latencyMs: 12, protocolVersion: 1, errorKind: null, error: null }],
      isLoading: false,
      isError: false,
    });
    renderPage();
    expect(screen.getByText("直连 12ms")).toBeInTheDocument();
  });

  it("shows unreachable badge with error title when probe fails", () => {
    useMobileLanProbesMock.mockReturnValue({
      data: [{ deviceId: "device-1", lanPublished: true, reachable: false, latencyMs: null, protocolVersion: null, errorKind: "unreachable", error: "局域网设备不可达" }],
      isLoading: false,
      isError: false,
    });
    renderPage();
    const badge = screen.getByText("不可直连");
    expect(badge).toBeInTheDocument();
    expect(badge.closest("span")).toHaveAttribute("title", "局域网设备不可达");
  });
});
