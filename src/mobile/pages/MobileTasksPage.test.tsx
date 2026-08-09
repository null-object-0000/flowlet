import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MobileTasksPage } from "./MobileTasksPage";
import { MobileDeviceSelectionProvider } from "../MobileDeviceSelection";

const useMobileDevicesMock = vi.fn();
const useMobileProjectsMock = vi.fn();
const useMobileSubmitTaskMock = vi.fn();
const useMobileSetTaskStatusMock = vi.fn();
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
  useMobileSetTaskStatus: (deviceId: string | null) => useMobileSetTaskStatusMock(deviceId),
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
    window.localStorage.clear();
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
    useMobileSetTaskStatusMock.mockReturnValue({
      isPending: false,
      mutateAsync: vi.fn(),
    });
    useMobileS3SettingsMock.mockReturnValue({
      data: { config: { endpoint: "https://oss.example.com" }, status: { status: "ok", lastSuccessAt: null } },
      isLoading: false,
    });
  });

  it("renders PC-consistent status tabs and task cards", () => {
    renderPage();
    // 四个折叠 Tab：待处理 / 进行中 / 待审核 / 已完成，无「全部」
    expect(screen.getByRole("button", { name: /待处理/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /进行中/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /待审核/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /已完成/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /全部/ })).toBeNull();
    // 任务卡片：项目名、完整标题、设备与右下角添加任务悬浮按钮
    expect(screen.getByText("flowlet")).toBeInTheDocument();
    expect(screen.getByText("修复登录页")).toBeInTheDocument();
    expect(screen.getByText("Office PC")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /添加任务/ })).toBeInTheDocument();
  });

  it("switches project via the header picker and remembers the choice", () => {
    useMobileProjectsMock.mockReturnValue({
      data: [
        {
          ...PROJECT,
          projectId: "project-1",
          projectName: "flowlet",
          updatedAt: "2026-07-30T01:00:00Z",
          tasks: [{ id: "task-1", title: "项目一任务", status: "submitted", priority: "p1", updatedAt: "2026-07-30T01:00:00Z" }],
        },
        {
          ...PROJECT,
          projectId: "project-2",
          projectName: "blog",
          updatedAt: "2026-07-30T02:00:00Z",
          tasks: [{ id: "task-2", title: "项目二任务", status: "submitted", priority: "p1", updatedAt: "2026-07-30T02:00:00Z" }],
        },
      ],
      isLoading: false,
      isError: false,
    });
    const { unmount } = renderPage();
    // 默认选中最近更新的项目（blog）
    expect(screen.getByText("项目二任务")).toBeInTheDocument();
    expect(screen.queryByText("项目一任务")).toBeNull();

    // 点击标题切换器打开项目下拉，切换到 flowlet
    fireEvent.click(screen.getByRole("button", { name: /切换项目/ }));
    fireEvent.click(screen.getByText("flowlet"));
    expect(screen.queryByText("项目二任务")).toBeNull();
    expect(screen.getByText("项目一任务")).toBeInTheDocument();

    // 选择已写入本地存储
    expect(window.localStorage.getItem("flowlet.mobile.projects.activeKey")).toBe("project-1");

    // 重新挂载后默认选中上次的项目（flowlet），而不是最近更新的 blog
    unmount();
    renderPage();
    expect(screen.getByText("项目一任务")).toBeInTheDocument();
    expect(screen.queryByText("项目二任务")).toBeNull();
  });

  it("filters tasks by status tab", () => {
    useMobileProjectsMock.mockReturnValue({
      data: [{
        ...PROJECT,
        tasks: [
          { id: "task-1", title: "已提交任务", status: "submitted", priority: "p1", updatedAt: "2026-07-30T01:00:00Z" },
          { id: "task-2", title: "已完成任务", status: "done", priority: "p2", updatedAt: "2026-07-30T01:10:00Z" },
        ],
      }],
      isLoading: false,
      isError: false,
    });
    renderPage();
    expect(screen.getByText("已提交任务")).toBeInTheDocument();
    expect(screen.queryByText("已完成任务")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /已完成/ }));
    expect(screen.queryByText("已提交任务")).toBeNull();
    expect(screen.getByText("已完成任务")).toBeInTheDocument();
  });

  it("opens task detail sheet and submits a draft task via LAN direct", async () => {
    useMobileProjectsMock.mockReturnValue({
      data: [{
        ...PROJECT,
        tasks: [
          { id: "task-1", title: "草稿任务", status: "draft", priority: "p0", updatedAt: "2026-07-30T01:00:00Z" },
        ],
      }],
      isLoading: false,
      isError: false,
    });
    const setStatus = vi.fn().mockResolvedValue({ taskId: "task-1", status: "submitted" });
    useMobileSetTaskStatusMock.mockReturnValue({
      isPending: false,
      mutateAsync: setStatus,
    });
    renderPage();

    fireEvent.click(screen.getByText("草稿任务"));
    // 详情抽屉展示完整信息与状态说明
    expect(screen.getByRole("dialog", { name: /草稿任务/ })).toBeInTheDocument();
    expect(screen.getByText("任务等待提交到桌面端")).toBeInTheDocument();
    expect(screen.getByText("task-1")).toBeInTheDocument();

    // 点击「提交」走局域网直连
    fireEvent.click(screen.getByRole("button", { name: /^提交$/ }));
    await waitFor(() => expect(setStatus).toHaveBeenCalledWith({ taskId: "task-1", status: "submitted" }));
  });

  it("opens the compose sheet from the FAB and creates a draft task", async () => {
    const submitTask = vi.fn().mockResolvedValue({ taskId: "new-task", status: "draft" });
    useMobileSubmitTaskMock.mockReturnValue({
      isPending: false,
      mutateAsync: submitTask,
    });
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: /^添加任务$/ }));
    // 半屏/大半屏添加任务抽屉出现
    const dialog = screen.getByRole("dialog", { name: /添加任务/ });
    expect(dialog).toBeInTheDocument();
    // 展开后展示完整表单：任务描述 + 任务类型 + Agent Profile（默认 Claude Code）
    fireEvent.click(screen.getByRole("button", { name: /展开添加任务表单/ }));
    expect(screen.getByPlaceholderText("补充上下文与期望结果（可选）")).toBeInTheDocument();
    expect(screen.getByText("Agent Profile")).toBeInTheDocument();
    expect(screen.getByText("Claude Code")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/修复登录页样式/), { target: { value: "新任务标题" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /^添加任务$/ }));
    await waitFor(() => expect(submitTask).toHaveBeenCalledWith({
      projectId: "project-1",
      title: "新任务标题",
      description: "",
      taskType: "code",
      agentProfile: "Claude Code",
    }));
  });

  it("refreshes all shared projects via pull to refresh", async () => {
    renderPage();
    expect(screen.queryByRole("button", { name: "刷新" })).toBeNull();
    expect(screen.getByText("尚未成功刷新")).toBeInTheDocument();

    const page = screen.getByText("flowlet").closest("section")!;
    const pullSurface = page.parentElement!.parentElement!;
    fireEvent.touchStart(pullSurface, { touches: [{ clientY: 10 }] });
    fireEvent.touchMove(pullSurface, { touches: [{ clientY: 140 }] });
    fireEvent.touchEnd(pullSurface);

    await waitFor(() => expect(refreshS3Mock).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByText(/最后刷新：/)).toBeInTheDocument());
    expect(refreshDeviceMock).not.toHaveBeenCalled();
  });
});
