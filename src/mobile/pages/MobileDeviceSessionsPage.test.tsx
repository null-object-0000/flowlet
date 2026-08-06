import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MobileDeviceSessionsPage } from "./MobileDeviceSessionsPage";

const mocks = vi.hoisted(() => ({
  backHandler: null as (() => void) | null,
  unregisterBackHandler: vi.fn<() => Promise<void>>(),
  reply: vi.fn<() => Promise<void>>(),
  refreshDevice: vi.fn<() => Promise<{ source: "lan" | "s3"; refreshedDevices: number }>>(),
  refreshS3: vi.fn<() => Promise<void>>(),
  refreshSession: vi.fn<() => Promise<void>>(),
  permissionsQuery: vi.fn(),
  assistantContent: vi.fn<() => string>(),
}));

vi.mock("@tauri-apps/api/app", () => ({
  onBackButtonPress: vi.fn(async (handler: () => void) => {
    mocks.backHandler = handler;
    return { unregister: mocks.unregisterBackHandler };
  }),
}));

vi.mock("../../features/device-sync/useMobileDeviceSync", () => ({
  useMobileDevices: () => ({ data: [{ deviceId: "device-1", displayName: "Office PC" }] }),
  useMobileS3Settings: () => ({ data: { config: null, status: { status: "never", message: "尚未同步" } }, isLoading: false }),
  useMobileDeviceSyncActions: () => ({
    saveS3Config: { isPending: false, mutateAsync: vi.fn() },
    testS3Connection: { isPending: false, mutateAsync: vi.fn() },
    refreshS3: { isPending: false, mutateAsync: mocks.refreshS3 },
  }),
  useMobileDeviceRefresh: () => ({ isPending: false, mutateAsync: mocks.refreshDevice }),
  useMobileSessionLanRefresh: () => ({ isPending: false, mutateAsync: mocks.refreshSession }),
  useMobileSessions: (deviceId: string | null) => ({
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
      lastInteraction: {
        events: [
          { id: "turn-1", kind: "turn", timestamp: "2026-07-30T05:00:00Z", title: null, content: null, model: null, status: "running" },
          { id: "u1", kind: "user-message", timestamp: "2026-07-30T05:00:01Z", title: null, content: "**不要渲染我**", model: null, status: null },
          { id: "r1", kind: "reasoning", timestamp: "2026-07-30T05:00:02Z", title: null, content: "先理解脚本", model: null, status: null },
          { id: "t1", kind: "tool-call", timestamp: "2026-07-30T05:00:03Z", title: "bash", content: "cargo build", model: null, status: null },
          { id: "a1", kind: "assistant-message", timestamp: "2026-07-30T05:00:04Z", title: null, content: "我先执行 **构建** 验证", model: null, status: null },
        ],
      },
    }, {
      deviceId: "device-1",
      deviceDisplayName: "Office PC",
      devicePlatform: "windows",
      agentType: "claude-code",
      sessionId: "session-2",
      parentSessionId: null,
      runtimeStatus: "idle",
      title: "Refactor parser",
      clientName: "Claude Code",
      activityAt: "2026-07-30T04:00:00Z",
      flowletObserved: true,
      requestCount: 5,
      errorCount: 0,
      knownTokens: 3400,
      lastInteraction: {
        events: [
          { id: "u2", kind: "user-message", timestamp: "2026-07-30T04:00:01Z", title: null, content: "整理解析器", model: null, status: null },
          { id: "a2", kind: "assistant-message", timestamp: "2026-07-30T04:00:02Z", title: null, content: mocks.assistantContent(), model: null, status: null },
          { id: "turn-2", kind: "turn", timestamp: "2026-07-30T04:00:03Z", title: null, content: null, model: null, status: "completed" },
        ],
      },
    }],
    isLoading: false,
    isError: false,
  }),
  useMobileWaitingSessionLanRefresh: () => {},
  useMobileRemotePermissions: () => mocks.permissionsQuery(),
  useReplyMobileRemotePermission: () => ({
    isPending: false,
    variables: undefined,
    mutateAsync: mocks.reply,
  }),
}));

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/devices/device-1/sessions"]}>
      <Routes>
        <Route path="/devices/:deviceId/sessions" element={<MobileDeviceSessionsPage />} />
        <Route path="/devices" element={<span>devices list</span>} />
      </Routes>
    </MemoryRouter>,
  );
}

function openSession(title: string) {
  fireEvent.click(screen.getByText(title).closest("article")!);
  return screen.getByRole("dialog");
}

describe("MobileDeviceSessionsPage", () => {
  beforeEach(() => {
    vi.stubEnv("TAURI_ENV_PLATFORM", "android");
    mocks.backHandler = null;
    mocks.unregisterBackHandler.mockReset().mockResolvedValue(undefined);
    mocks.reply.mockReset().mockResolvedValue(undefined);
    mocks.refreshDevice.mockReset().mockResolvedValue({ source: "lan", refreshedDevices: 1 });
    mocks.refreshS3.mockReset().mockResolvedValue(undefined);
    mocks.refreshSession.mockReset().mockResolvedValue(undefined);
    mocks.assistantContent.mockReset().mockReturnValue("已完成整理");
    mocks.permissionsQuery.mockReset().mockReturnValue({
      isLoading: false,
      isFetching: false,
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
    });
  });

  it("shows a back entry to the device page and the device session list", () => {
    renderPage();
    expect(screen.getByRole("button", { name: "返回设备页" })).toBeInTheDocument();
    // 主标题带上设备名：设备名 + 会话
    expect(screen.getByRole("heading", { level: 1, name: "Office PC 会话" })).toBeInTheDocument();
    expect(screen.getByText("查看该设备同步的最近会话与实时运行状态")).toBeInTheDocument();
    expect(screen.getByText("Fix CI")).toBeInTheDocument();
  });

  it("returns to the device page via the back button", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "返回设备页" }));
    expect(screen.getByText("devices list")).toBeInTheDocument();
  });

  it("distinguishes an unavailable OpenCode control service from a LAN failure", () => {
    mocks.permissionsQuery.mockReturnValue({
      isLoading: false,
      isFetching: false,
      isError: false,
      data: {
        available: false,
        serverUrl: "http://127.0.0.1:4096",
        error: "无法连接 OpenCode 控制服务",
        permissions: [],
      },
    });
    renderPage();
    const dialog = openSession("Fix CI");

    expect(within(dialog).getByText("OpenCode 控制服务未连接")).toBeInTheDocument();
    expect(within(dialog).queryByText("目标设备当前无法直连，请确认两台设备位于同一局域网。")).toBeNull();
  });

  it("does not render a stale unavailable result while permissions are refetching", () => {
    mocks.permissionsQuery.mockReturnValue({
      isLoading: false,
      isFetching: true,
      isError: false,
      data: {
        available: false,
        serverUrl: "http://127.0.0.1:4096",
        error: "旧的不可用结果",
        permissions: [],
      },
    });
    renderPage();
    const dialog = openSession("Fix CI");

    expect(within(dialog).getByText("正在连接 Agent 所在设备…")).toBeInTheDocument();
    expect(within(dialog).queryByText("OpenCode 控制服务未连接")).toBeNull();
  });

  it("approves a remote OpenCode permission from the session sheet", async () => {
    renderPage();

    // 卡片上只有最近一次用户输入摘要，审批在弹窗里进行。
    const card = screen.getByText("Fix CI").closest("article")!;
    expect(within(card).getByText("**不要渲染我**")).toBeInTheDocument();
    expect(within(card).getAllByText("OpenCode")).toHaveLength(1);
    expect(within(card).queryByRole("button", { name: "同意本次" })).toBeNull();

    const dialog = openSession("Fix CI");
    expect(within(dialog).getAllByText("OpenCode")).toHaveLength(1);
    expect(within(dialog).getByText("cargo test")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "同意本次" }));
    await waitFor(() => expect(mocks.reply).toHaveBeenCalledWith({
      permissionId: "permission-1",
      decision: "allow_once",
    }));
  });

  it("shows the full latest interaction inside the sheet and closes on backdrop click", async () => {
    renderPage();
    const dialog = openSession("Fix CI");
    // 用户输入保持纯文本原样展示，不做 Markdown 渲染。
    expect(within(dialog).getByText("**不要渲染我**")).toBeInTheDocument();
    // 助手输出保持 Markdown 渲染。
    expect((await within(dialog).findByText("构建")).tagName).toBe("STRONG");
    // 思考与工具调用折叠为过程组。
    expect(within(dialog).getByText("已处理 2 项")).toBeInTheDocument();

    fireEvent.click(dialog.parentElement!);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("closes both collapsed and expanded session sheets with the Android back gesture", async () => {
    renderPage();

    openSession("Refactor parser");
    await waitFor(() => expect(mocks.backHandler).not.toBeNull());
    act(() => mocks.backHandler?.());
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(mocks.unregisterBackHandler).toHaveBeenCalledTimes(1));

    mocks.backHandler = null;
    const expandedDialog = openSession("Refactor parser");
    await waitFor(() => expect(mocks.backHandler).not.toBeNull());
    fireEvent.click(within(expandedDialog).getByRole("button", { name: "展开会话详情" }));
    expect(expandedDialog).toHaveAttribute("data-expanded");

    act(() => mocks.backHandler?.());
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(mocks.unregisterBackHandler).toHaveBeenCalledTimes(2));
  });

  it("opens the sheet for non-OpenCode sessions without approval actions", async () => {
    renderPage();
    const dialog = openSession("Refactor parser");
    expect(within(dialog).getAllByText("Claude Code")).toHaveLength(1);
    expect(within(dialog).getByText("整理解析器")).toBeInTheDocument();
    expect(await within(dialog).findByText("已完成整理")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "同意本次" })).toBeNull();
  });

  it("refreshes only the selected device and supports pull to refresh", async () => {
    renderPage();
    expect(screen.queryByRole("button", { name: "刷新" })).toBeNull();
    expect(screen.getByText("尚未成功刷新")).toBeInTheDocument();

    const page = screen.getByRole("group", { name: "会话状态" }).closest("section")!;
    const pullSurface = page.closest("[class*='_root_']")!;
    fireEvent.touchStart(pullSurface, { touches: [{ clientY: 10 }] });
    fireEvent.touchMove(pullSurface, { touches: [{ clientY: 140 }] });
    fireEvent.touchEnd(pullSurface);
    await waitFor(() => expect(mocks.refreshDevice).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByText(/最后刷新：/)).toBeInTheDocument());
    expect(mocks.refreshS3).not.toHaveBeenCalled();
  });

  it("keeps the session sheet viewport-bound while pull-to-refresh transforms the page", () => {
    renderPage();

    const page = screen.getByRole("group", { name: "会话状态" }).closest("section")!;
    const pullSurface = page.closest("[class*='_root_']")!;
    pullSurface.setAttribute("data-pulling", "true");

    const dialog = openSession("Refactor parser");
    expect(dialog.parentElement?.parentElement).toBe(document.body);
    expect(pullSurface).toHaveAttribute("data-pulling");
    expect(pullSurface).not.toContainElement(dialog);

    pullSurface.removeAttribute("data-pulling");
  });

  it("filters sessions through the status button group", () => {
    renderPage();
    const group = screen.getByRole("group", { name: "会话状态" });
    const waitingButton = within(group).getByRole("button", { name: "等待确认" });
    expect(waitingButton).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("Fix CI")).toBeInTheDocument();

    fireEvent.click(within(group).getByRole("button", { name: "已空闲" }));
    expect(screen.queryByText("Fix CI")).not.toBeInTheDocument();
    expect(screen.getByText("Refactor parser")).toBeInTheDocument();

    fireEvent.click(waitingButton);
    expect(waitingButton).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Fix CI")).toBeInTheDocument();
    expect(screen.queryByText("Refactor parser")).not.toBeInTheDocument();
  });
});