import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  reply: vi.fn<() => Promise<void>>(),
}));

vi.mock("../../features/device-sync/useMobileDeviceSync", () => ({
  useMobileDevices: () => ({ data: [{ deviceId: "device-1", displayName: "Office PC" }] }),
  useMobileS3Settings: () => ({ data: { config: null, status: { status: "never", message: "尚未同步" } }, isLoading: false }),
  useMobileDeviceSyncActions: () => ({
    saveS3Config: { isPending: false, mutateAsync: vi.fn() },
    testS3Connection: { isPending: false, mutateAsync: vi.fn() },
    refreshS3: { isPending: false, mutateAsync: vi.fn() },
  }),
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
          { id: "a2", kind: "assistant-message", timestamp: "2026-07-30T04:00:02Z", title: null, content: "已完成整理", model: null, status: null },
          { id: "turn-2", kind: "turn", timestamp: "2026-07-30T04:00:03Z", title: null, content: null, model: null, status: "completed" },
        ],
      },
    }],
    isLoading: false,
    isError: false,
  }),
  useMobileWaitingSessionLanRefresh: () => {},
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

function openSession(title: string) {
  fireEvent.click(screen.getByText(title).closest("article")!);
  return screen.getByRole("dialog");
}

describe("MobileSessionsPage", () => {
  beforeEach(() => mocks.reply.mockReset().mockResolvedValue(undefined));

  it("approves a remote OpenCode permission from the session sheet", async () => {
    render(<MobileDeviceSelectionProvider><MobileSessionsPage /></MobileDeviceSelectionProvider>);
    const titleHeading = screen.getByText("Office PC 会话").closest("h2")!;
    const header = titleHeading.closest("header")!;
    expect(within(titleHeading.parentElement!).getByRole("button", { name: "切换设备，当前：Office PC" })).toBeInTheDocument();
    expect(within(header).getByText("查看该设备同步的最近会话与实时运行状态").parentElement).toBe(header);

    // 卡片上只有最近一次用户输入摘要，审批在弹窗里进行。
    const card = screen.getByText("Fix CI").closest("article")!;
    expect(within(card).getByText("**不要渲染我**")).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: "同意本次" })).toBeNull();

    const dialog = openSession("Fix CI");
    expect(within(dialog).getByText("cargo test")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "同意本次" }));
    await waitFor(() => expect(mocks.reply).toHaveBeenCalledWith({
      permissionId: "permission-1",
      decision: "allow_once",
    }));
  });

  it("shows the full latest interaction inside the sheet and closes on backdrop click", async () => {
    render(<MobileDeviceSelectionProvider><MobileSessionsPage /></MobileDeviceSelectionProvider>);
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

  it("opens the sheet for non-OpenCode sessions without approval actions", async () => {
    render(<MobileDeviceSelectionProvider><MobileSessionsPage /></MobileDeviceSelectionProvider>);
    const dialog = openSession("Refactor parser");
    expect(within(dialog).getByText("整理解析器")).toBeInTheDocument();
    expect(await within(dialog).findByText("已完成整理")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "同意本次" })).toBeNull();
  });

  it("switches devices from the page title without offering an all-devices option", async () => {
    render(<MobileDeviceSelectionProvider><MobileSessionsPage /></MobileDeviceSelectionProvider>);
    fireEvent.click(screen.getByRole("button", { name: "切换设备，当前：Office PC" }));
    const menu = await waitFor(() => {
      const el = document.querySelector(".semi-dropdown-menu");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(within(menu).getByText("Office PC")).toBeInTheDocument();
    expect(within(menu).queryByText("全部设备")).toBeNull();
  });

  it("filters sessions through the status button group", () => {
    render(<MobileDeviceSelectionProvider><MobileSessionsPage /></MobileDeviceSelectionProvider>);
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
