import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  reply: vi.fn<() => Promise<void>>(),
}));

vi.mock("../../features/device-sync/useMobileDeviceSync", () => ({
  useMobileDevices: () => ({ data: [{ deviceId: "device-1", displayName: "Office PC" }] }),
  useMobileSessions: () => ({
    data: [{
      deviceId: "device-1",
      deviceDisplayName: "Office PC",
      devicePlatform: "windows",
      agentType: "opencode",
      sessionId: "session-1",
      parentSessionId: null,
      runtimeStatus: "waiting_user",
      title: "Fix CI",
      clientName: "OpenCode",
      activityAt: "2026-07-30T05:00:00Z",
      flowletObserved: true,
      requestCount: 2,
      errorCount: 0,
      knownTokens: 1200,
      lastInteraction: null,
    }],
    isLoading: false,
    isError: false,
  }),
  useMobileRemotePermissions: () => ({
    isLoading: false,
    isError: false,
    data: {
      available: true,
      serverUrl: "http://127.0.0.1:4096",
      error: null,
      permissions: [{
        id: "permission-1",
        sessionId: "session-1",
        permission: "bash",
        patterns: ["cargo test"],
        metadata: {},
        always: [],
        tool: null,
      }],
    },
  }),
  useReplyMobileRemotePermission: () => ({
    isPending: false,
    variables: undefined,
    mutateAsync: mocks.reply,
  }),
}));

import { MobileSessionsPage } from "./MobileSessionsPage";
import { MobileDeviceSelectionProvider } from "../MobileDeviceSelection";

describe("MobileSessionsPage LAN approval", () => {
  beforeEach(() => mocks.reply.mockReset().mockResolvedValue(undefined));

  it("submits an allow-once decision to the remote device", async () => {
    render(<MobileDeviceSelectionProvider><MobileSessionsPage /></MobileDeviceSelectionProvider>);
    const header = screen.getByRole("heading", { name: "会话" }).closest("header")!;
    const titleRow = screen.getByRole("heading", { name: "会话" }).parentElement!;
    expect(within(titleRow).getByRole("button", { name: "切换设备，当前：全部设备" })).toBeInTheDocument();
    expect(within(header).getByText("查看各设备同步的最近会话与实时运行状态").parentElement).toBe(header);
    expect(screen.getByText("cargo test")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "同意本次" }));
    await waitFor(() => expect(mocks.reply).toHaveBeenCalledWith({
      permissionId: "permission-1",
      decision: "allow_once",
    }));
  });
});
