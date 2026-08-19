import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionRow } from "../../domains/agent-session/types";

vi.mock("lottie-web", () => ({
  default: { loadAnimation: vi.fn(() => ({ destroy: vi.fn() })) },
}));

vi.mock("../../features/background-tasks/useBackgroundTasks", () => ({
  useAgentDataSync: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useAgentSyncStatus: () => ({ data: { running: false, sources: [] } }),
  useAgentSyncSchedule: () => null,
}));

const remoteSession = {
  deviceId: "remote-device",
  deviceDisplayName: "办公室电脑",
  devicePlatform: "windows",
  agentType: "claude-code",
  sessionId: "remote-session-1",
  parentSessionId: null,
  runtimeStatus: "running",
  title: "Remote session title",
  clientName: "Claude Code",
  activityAt: "2026-07-19T10:00:00Z",
  flowletObserved: true,
  requestCount: 6,
  errorCount: 1,
  knownTokens: 5000,
  nativeTurnCount: null,
  nativeTotalTokens: null,
  nativeTruncated: false,
  lastInteraction: null,
};

const refreshSharedDeviceMock = vi.fn(() => Promise.resolve({ source: "lan", refreshedDevices: 1 }));

vi.mock("../../features/device-sync/useDeviceSync", () => ({
  useKnownDevices: () => ({
    data: [
      { deviceId: "current-device", displayName: "本机", isCurrent: true },
      { deviceId: "remote-device", displayName: "办公室电脑", isCurrent: false },
    ],
  }),
  useSharedDeviceSessions: (deviceId: string | null) => ({
    data: deviceId === "remote-device" ? [remoteSession] : [],
    isLoading: false,
    isError: false,
    isFetching: false,
    error: null,
    refetch: vi.fn(() => Promise.resolve({ data: [] })),
    dataUpdatedAt: undefined,
  }),
  useRefreshSharedDevice: () => ({ isPending: false, mutateAsync: refreshSharedDeviceMock }),
}));

const session: AgentSessionRow = {
  agentType: "opencode",
  sessionId: "ses_native_test",
  runtimeStatus: "idle",
  title: "Native session title",
  projectPath: "D:\\GitHub\\flowlet",
  parentSessionId: null,
  clientId: "opencode",
  clientName: "OpenCode",
  nativeStartedAt: "2026-07-18T08:00:00Z",
  nativeUpdatedAt: "2026-07-18T09:00:00Z",
  activityAt: "2026-07-18T09:05:00Z",
  flowletObserved: true,
  startedAt: "2026-07-18 08:05:00",
  updatedAt: "2026-07-18 09:05:00",
  requestCount: 4,
  successCount: 3,
  errorCount: 1,
  knownTokens: 12000,
  inputTokens: 10000,
  inputCachedTokens: 4000,
  inputUncachedTokens: 6000,
  cacheMeasuredInputTokens: 8000,
  outputTokens: 2000,
  unknownUsageCount: 1,
  estimatedCost: 0.25,
  estimatedInputUncachedCost: 0.12,
  estimatedInputCachedCost: 0.04,
  estimatedInputCacheWriteCost: 0.02,
  estimatedOutputCost: 0.07,
};

const childSession: AgentSessionRow = {
  ...session,
  sessionId: "ses_child",
  title: "Child session title",
  parentSessionId: "ses_native_test",
  requestCount: 2,
  successCount: 2,
  errorCount: 0,
  knownTokens: 420,
  estimatedCost: 0.05,
};

let listedSessions = [session];
const defaultPermissionsReport = {
  available: true,
  serverUrl: "http://127.0.0.1:4096",
  error: null,
  permissions: [{
    id: "per_test",
    sessionId: "ses_native_test",
    permission: "bash",
    patterns: ["cargo test"],
    metadata: {},
    always: [],
    tool: null,
  }],
};
let permissionsReport: typeof defaultPermissionsReport | null = defaultPermissionsReport;
const {
  permissionReplyMock,
  sessionListRefetchMock,
  childrenRefetchMock,
  nativeSummaryRefetchMock,
  lastInteractionRefetchMock,
} = vi.hoisted(() => ({
  permissionReplyMock: vi.fn(() => Promise.resolve()),
  sessionListRefetchMock: vi.fn<() => Promise<{ data: { rows: AgentSessionRow[] } }>>(
    () => Promise.resolve({ data: { rows: [] } }),
  ),
  childrenRefetchMock: vi.fn(() => Promise.resolve()),
  nativeSummaryRefetchMock: vi.fn(() => Promise.resolve()),
  lastInteractionRefetchMock: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../features/agent-sessions/useAgentSessions", () => ({
  useAgentSessions: () => ({
    data: { rows: listedSessions, total: listedSessions.length, page: 1, pageSize: 8 },
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: sessionListRefetchMock,
  }),
  useAgentSessionChildren: () => ({
    data: [childSession],
    isLoading: false,
    isError: false,
    error: null,
    refetch: childrenRefetchMock,
  }),
  useOpenCodeSessionPermissions: () => ({
    data: permissionsReport,
    isLoading: false,
    isError: false,
    error: null,
  }),
  useReplyOpenCodePermission: () => ({
    mutateAsync: permissionReplyMock,
    isPending: false,
    variables: undefined,
  }),
  useAgentSessionNativeSummary: () => ({
    data: {
      sourceAvailable: true,
      truncated: false,
      turnCount: 2,
      models: ["native-model"],
      usage: {
        inputTokens: 100000,
        cachedInputTokens: 20000,
        cacheWriteInputTokens: 5000,
        outputTokens: 10000,
        reasoningTokens: 0,
        totalTokens: 135000,
        cost: 0.123456,
        costCurrency: "USD",
      },
    },
    isLoading: false,
    isError: false,
    error: null,
    refetch: nativeSummaryRefetchMock,
  }),
  useAgentSessionLastInteraction: () => ({
    data: {
      sourceAvailable: true,
      truncated: false,
      turnCount: 1,
      usage: null,
      models: ["native-model"],
      events: [
        { id: "turn-latest", kind: "turn", source: "agent-native", timestamp: "2026-07-18T09:00:00Z", title: null, content: null, model: "native-model", status: "running", durationMs: null, timeToFirstTokenMs: null, usage: null },
        { id: "user-latest", kind: "user-message", source: "agent-native", timestamp: "2026-07-18T09:00:00Z", title: null, content: "latest complete input", model: null, status: null, durationMs: null, timeToFirstTokenMs: null, usage: null },
        { id: "assistant-first", kind: "assistant-message", source: "agent-native", timestamp: "2026-07-18T09:00:01Z", title: null, content: "first output", model: "native-model", status: "completed", durationMs: null, timeToFirstTokenMs: null, usage: null },
        { id: "reasoning-latest", kind: "reasoning", source: "agent-native", timestamp: "2026-07-18T09:00:02Z", title: "思考摘要", content: "check the implementation", model: null, status: null, durationMs: null, timeToFirstTokenMs: null, usage: null },
        { id: "tool-call-latest", kind: "tool-call", source: "agent-native", timestamp: "2026-07-18T09:00:03Z", title: "exec_command", content: JSON.stringify({ cmd: "cargo test", workdir: "E:\\flowlet" }), model: null, status: "completed", durationMs: null, timeToFirstTokenMs: null, usage: null },
        { id: "tool-result-latest", kind: "tool-result", source: "agent-native", timestamp: "2026-07-18T09:00:04Z", title: "exec_command", content: JSON.stringify({ output: "2 tests passed", exit_code: 0 }), model: null, status: "completed", durationMs: null, timeToFirstTokenMs: null, usage: null },
        { id: "assistant-second", kind: "assistant-message", source: "agent-native", timestamp: "2026-07-18T09:00:02Z", title: null, content: "second output", model: "native-model", status: "completed", durationMs: null, timeToFirstTokenMs: null, usage: null },
      ],
    },
    isLoading: false,
    isFetching: false,
    isError: false,
    error: null,
    refetch: lastInteractionRefetchMock,
  }),
  useAgentSessionTimeline: () => ({
    data: {
      sourceAvailable: true,
      truncated: false,
      turnCount: 1,
      usage: null,
      models: ["native-model"],
      events: [],
    },
    isLoading: false,
    isFetching: false,
    isError: false,
    error: null,
    refetch: vi.fn(() => Promise.resolve()),
  }),
  useDshSessionPermissions: () => ({
    data: { available: false, permissions: [], error: null },
    isLoading: false,
    isFetching: false,
    isError: false,
    error: null,
  }),
  useReplyDshPermission: () => ({ mutateAsync: vi.fn(), isPending: false, variables: undefined }),
  useAgentSessionClients: () => ({ data: [], isLoading: false }),
}));

import { AgentSessionsPage } from "./AgentSessionsPage";
import { AgentSessionDetailSideSheet, sessionDisplayTitle } from "./AgentSessionDetailSideSheet";

describe("AgentSessionsPage", () => {
  beforeEach(() => {
    listedSessions = [session];
    permissionsReport = defaultPermissionsReport;
    [
      permissionReplyMock,
      sessionListRefetchMock,
      childrenRefetchMock,
      nativeSummaryRefetchMock,
      lastInteractionRefetchMock,
    ].forEach((mock) => mock.mockClear());
  });

  it("shows request-style token details and aggregate cache hit rate", () => {
    render(<MemoryRouter><AgentSessionsPage /></MemoryRouter>);

    expect(screen.getByLabelText("Token 明细：总计 1.20万，缓存命中率 50.0%")).toHaveAttribute("title", "12,000");
  });

  it("shows the native runtime state separately from request health", () => {
    listedSessions = [{ ...session, runtimeStatus: "waiting_user" }];
    render(<MemoryRouter><AgentSessionsPage /></MemoryRouter>);

    expect(screen.getByText("等待用户确认")).toBeInTheDocument();
    expect(screen.getByText("1 次失败")).toBeInTheDocument();
  });

  it("identifies DeepSeek Harness sessions in the list and detail sheet", () => {
    listedSessions = [{
      ...session,
      agentType: "deepseek-harness",
      sessionId: "session-b8684683-3a1e-4bc2-a004-e2c56756eb22",
      title: "DSH session",
      projectPath: "E:\\dsh-test",
      clientId: "deepseek-harness",
      clientName: "DeepSeek Harness",
      flowletObserved: false,
    }];
    render(<MemoryRouter><AgentSessionsPage /></MemoryRouter>);

    expect(screen.getByText("DeepSeek Harness · dsh-test")).toBeInTheDocument();
    expect(screen.queryByText("OpenCode · dsh-test")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("DSH session").closest("button")!);
    expect(screen.getAllByText("DeepSeek Harness").length).toBeGreaterThan(0);
    expect(screen.queryByText("Agent 来源")).toBeInTheDocument();
  });

  it("shows native turn and token summaries for sessions not observed by Flowlet", () => {
    listedSessions = [{
      ...session,
      agentType: "claude-code",
      flowletObserved: false,
      clientId: null,
      clientName: null,
      requestCount: 0,
      knownTokens: 0,
    }];

    render(<MemoryRouter><AgentSessionsPage /></MemoryRouter>);

    expect(screen.getByTitle("Agent 原生 turn 数：2")).toHaveTextContent("2");
    expect(screen.getByLabelText("Token 明细：总计 13.50万，缓存命中率 16.0%")).toHaveAttribute("title", "135,000");
  });

  it("keeps archived native usage visible after the source file is deleted", () => {
    listedSessions = [{
      ...session,
      agentType: "claude-code",
      flowletObserved: false,
      clientId: null,
      clientName: null,
      requestCount: 0,
      knownTokens: 0,
      nativeSummary: {
        sourceAvailable: false,
        truncated: false,
        turnCount: 2,
        models: ["native-model"],
        usage: {
          inputTokens: 100000,
          cachedInputTokens: 20000,
          cacheWriteInputTokens: 5000,
          outputTokens: 10000,
          reasoningTokens: 0,
          totalTokens: 135000,
          cost: null,
          costCurrency: null,
        },
      },
      nativeSyncedAt: "2026-07-18T09:01:00Z",
    }];

    render(<MemoryRouter><AgentSessionsPage /></MemoryRouter>);

    expect(screen.getByText("源文件已删除")).toBeInTheDocument();
    expect(screen.getByTitle("Agent 原生 turn 数：2")).toHaveTextContent("2");
    expect(screen.getByLabelText("Token 明细：总计 13.50万，缓存命中率 16.0%")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Native session title").closest("button")!);
    fireEvent.click(screen.getByRole("tab", { name: "用量" }));
    const usage = screen.getByRole("tabpanel", { name: "用量" });
    expect(within(usage).getByText("源文件已删除，以下为 Flowlet 最后一次同步保存的数据")).toBeInTheDocument();
    expect(within(usage).getByText("13.50万")).toBeInTheDocument();
  });

  it("offers client and runtime status filters", () => {
    render(<MemoryRouter><AgentSessionsPage /></MemoryRouter>);

    fireEvent.click(screen.getByText("全部客户端"));
    const codexOption = screen.getByText("Codex Desktop");
    expect(codexOption).toBeInTheDocument();
    expect(screen.getByText("Codex CLI")).toBeInTheDocument();
    expect(screen.getByText("Claude Code")).toBeInTheDocument();
    expect(screen.getAllByText("OpenCode").length).toBeGreaterThan(1);
    expect(screen.getByText("DeepSeek Harness")).toBeInTheDocument();
    fireEvent.click(codexOption);

    fireEvent.click(screen.getByText("运行状态"));
    const optionLabels = Array.from(document.querySelectorAll(".semi-select-option-text")).map((el) => el.textContent);
    expect(optionLabels).toEqual(expect.arrayContaining(["自动运行中", "等待用户确认", "空闲", "无法判断"]));
    expect(screen.queryByText("经过 Flowlet")).not.toBeInTheDocument();
  });

  it("opens session details and refreshes the active tab", async () => {
    permissionsReport = { ...defaultPermissionsReport, permissions: [] };
    render(<MemoryRouter><AgentSessionsPage /></MemoryRouter>);

    const rowTitle = screen.getByText("Native session title");
    fireEvent.click(rowTitle.closest("button")!);

    expect(screen.getByRole("tab", { name: "概览" })).toHaveAttribute("aria-selected", "true");
    const overview = screen.getByRole("tabpanel", { name: "概览" });

    // 会话摘要直接作为抽屉标题，概览只保留 3 列统计行，避免重复展示。
    expect(screen.getAllByText("空闲").some((element) => !overview.contains(element))).toBe(true);
    expect(within(overview).queryByText("Native session title")).not.toBeInTheDocument();
    expect(within(overview).queryByText("空闲")).not.toBeInTheDocument();
    expect(within(overview).getByText("1.20万")).toBeInTheDocument();
    expect(within(overview).getByText("4")).toBeInTheDocument();
    expect(within(overview).getByText("1")).toBeInTheDocument();

    // 刷新概览：最近一轮 + 子会话 + 原生用量 + 列表。
    // 抽屉打开时会立即自动刷新一次（移动端同款行为），先清除该次调用再验证手动刷新。
    const tabList = screen.getByRole("tablist");
    const drawer = screen.getByRole("dialog");
    [sessionListRefetchMock, childrenRefetchMock, nativeSummaryRefetchMock, lastInteractionRefetchMock].forEach((mock) => mock.mockClear());
    fireEvent.click(within(drawer).getByRole("button", { name: "刷新数据" }));
    await waitFor(() => {
      expect(lastInteractionRefetchMock).toHaveBeenCalledOnce();
      expect(childrenRefetchMock).toHaveBeenCalledOnce();
      expect(nativeSummaryRefetchMock).toHaveBeenCalledOnce();
      expect(sessionListRefetchMock).toHaveBeenCalledOnce();
    });
    [sessionListRefetchMock, childrenRefetchMock, nativeSummaryRefetchMock, lastInteractionRefetchMock].forEach((mock) => mock.mockClear());

    // 最近一轮嵌入概览
    expect(within(overview).queryByText("完整展示最后一个用户输入及其后的全部 Agent 输出与过程事件")).not.toBeInTheDocument();
    const input = within(overview).getByLabelText("用户消息");
    expect(within(input).getByText("latest complete input")).toBeInTheDocument();
    expect(within(overview).getByText("first output")).toBeInTheDocument();
    expect(within(overview).getByText("second output")).toBeInTheDocument();
    expect(within(overview).getByRole("status")).toHaveTextContent("正在处理");
    expect(within(overview).queryByText("用户输入")).not.toBeInTheDocument();
    expect(within(overview).queryByText("Agent 输出")).not.toBeInTheDocument();
    expect(within(overview).queryByText("OpenCode · native-model")).not.toBeInTheDocument();
    const process = within(overview).getByText("已处理 3 项").closest("details")!;
    expect(process).not.toHaveAttribute("open");
    fireEvent.click(within(overview).getByText("已处理 3 项"));
    expect(process).toHaveAttribute("open");
    expect(within(process).getByText("cargo test")).toBeInTheDocument();
    expect(within(process).getByText("E:\\flowlet")).toBeInTheDocument();
    expect(within(process).getByText("2 tests passed")).toBeInTheDocument();
    expect(within(process).getByText("命令")).toBeInTheDocument();
    expect(within(process).getByText("工作目录")).toBeInTheDocument();
    expect(within(process).getByText("退出码")).toBeInTheDocument();
    expect(screen.queryByText("会话时间线")).not.toBeInTheDocument();

    // 用量 Tab：Flowlet 请求统计 + Agent 原生用量
    fireEvent.click(screen.getByRole("tab", { name: "用量" }));
    const usage = screen.getByRole("tabpanel", { name: "用量" });
    expect(within(usage).getByText("Flowlet 请求统计")).toBeInTheDocument();
    expect(within(usage).getByText("Agent 原生用量")).toBeInTheDocument();
    expect(within(usage).getByText("$0.123456")).toBeInTheDocument();
    expect(within(usage).getByText("模型：native-model")).toBeInTheDocument();

    // 用量 Tab 刷新：只刷新原生用量与子会话
    fireEvent.click(within(drawer).getByRole("button", { name: "刷新数据" }));
    await waitFor(() => {
      expect(nativeSummaryRefetchMock).toHaveBeenCalledOnce();
      expect(childrenRefetchMock).toHaveBeenCalledOnce();
    });
    expect(lastInteractionRefetchMock).not.toHaveBeenCalled();
    expect(sessionListRefetchMock).not.toHaveBeenCalled();
    [childrenRefetchMock, nativeSummaryRefetchMock].forEach((mock) => mock.mockClear());

    // 信息 Tab：会话信息与活动时间
    fireEvent.click(screen.getByRole("tab", { name: "信息" }));
    const sessionPane = screen.getByRole("tabpanel", { name: "信息" });
    expect(within(sessionPane).getByText("ses_native_test")).toBeInTheDocument();
    expect(within(sessionPane).getByText("D:\\GitHub\\flowlet")).toBeInTheDocument();

    // 子会话 Tab
    fireEvent.click(screen.getByRole("tab", { name: "子会话（1）" }));
    const childrenPane = screen.getByRole("tabpanel", { name: "子会话（1）" });
    expect(within(childrenPane).getByText("Child session title")).toBeInTheDocument();
  });

  it("does not reopen a closed detail drawer when an in-flight overview refresh completes", async () => {
    let resolveRefresh: ((value: { data: { rows: AgentSessionRow[] } }) => void) | undefined;
    sessionListRefetchMock.mockImplementationOnce(() => new Promise((resolve) => {
      resolveRefresh = resolve;
    }));
    render(<MemoryRouter><AgentSessionsPage /></MemoryRouter>);

    fireEvent.click(screen.getByText("Native session title").closest("button")!);
    const drawer = screen.getByRole("dialog");
    await waitFor(() => expect(sessionListRefetchMock).toHaveBeenCalledOnce());

    const closeButton = drawer.querySelector<HTMLButtonElement>(".semi-sidesheet-close");
    expect(closeButton).not.toBeNull();
    fireEvent.click(closeButton!);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await act(async () => {
      resolveRefresh?.({ data: { rows: [{ ...session, title: "Refreshed title" }] } });
      await Promise.resolve();
    });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("falls back to the project name when native title is unavailable", () => {
    expect(sessionDisplayTitle({ ...session, title: null })).toBe("flowlet");
  });

  it("opens request logs filtered by the selected session ID", () => {
    render(
      <MemoryRouter initialEntries={["/sessions"]}>
        <AgentSessionsPage />
        <LocationProbe />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByText("Native session title").closest("button")!);
    fireEvent.click(screen.getByRole("tab", { name: "信息" }));
    fireEvent.click(screen.getByRole("button", { name: "查看会话 ses_native_test 的请求日志明细" }));

    expect(screen.getByTestId("location")).toHaveTextContent("/logs?search=ses_native_test");
  });

  it("opens request logs for a child session from the detail list", () => {
    render(
      <MemoryRouter initialEntries={["/sessions"]}>
        <AgentSessionsPage />
        <LocationProbe />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByText("Native session title").closest("button")!);
    fireEvent.click(screen.getByRole("tab", { name: "子会话（1）" }));
    fireEvent.click(screen.getByRole("button", { name: "查看会话 ses_child 的请求日志明细" }));

    expect(screen.getByTestId("location")).toHaveTextContent("/logs?search=ses_child");
  });

  it("marks native-only sessions without exposing a request-log action", () => {
    render(
      <MemoryRouter>
        <AgentSessionDetailSideSheet
          session={{ ...session, agentType: "codex-desktop", flowletObserved: false, clientId: null, clientName: null }}
          onClose={vi.fn()}
          onViewRequestLogs={vi.fn()}
        />
      </MemoryRouter>,
    );

    // 概览：native 来源的统计行显示为 Agent 原生，而非请求指标
    const overview = screen.getByRole("tabpanel", { name: "概览" });
    expect(screen.getAllByText("Codex Desktop").some((element) => !overview.contains(element))).toBe(true);
    expect(within(overview).queryByText("Codex Desktop")).not.toBeInTheDocument();
    expect(within(overview).getByText("Agent 原生")).toBeInTheDocument();

    // 信息 Tab：显示 Agent 来源，无请求日志入口
    fireEvent.click(screen.getByRole("tab", { name: "信息" }));
    const sessionPane = screen.getByRole("tabpanel", { name: "信息" });
    expect(within(sessionPane).getByText("Agent 来源")).toBeInTheDocument();
    expect(within(sessionPane).queryByText("未知客户端")).not.toBeInTheDocument();
    expect(within(sessionPane).queryByRole("button", { name: "查看会话 ses_native_test 的请求日志明细" })).not.toBeInTheDocument();
    expect(screen.queryByText("未经过 Flowlet")).not.toBeInTheDocument();
  });

  it("allows a pending OpenCode permission once from the overview", async () => {
    render(
      <MemoryRouter>
        <AgentSessionDetailSideSheet session={session} onClose={vi.fn()} onViewRequestLogs={vi.fn()} />
      </MemoryRouter>,
    );

    expect(screen.getByRole("tab", { name: "概览" })).toHaveAttribute("aria-selected", "true");
    const overview = screen.getByRole("tabpanel", { name: "概览" });
    const approval = within(overview).getByText("OpenCode 等待确认").closest("article")!;
    expect(within(approval).getByText("cargo test")).toBeInTheDocument();
    expect(within(overview).queryByRole("status")).not.toBeInTheDocument();
    fireEvent.click(within(approval).getByRole("button", { name: "同意本次" }));

    await waitFor(() => expect(permissionReplyMock).toHaveBeenCalledWith({ permissionId: "per_test", decision: "allow_once" }));
  });

  it("switches devices from the page title and shows only that device's sessions", async () => {
    render(<MemoryRouter><AgentSessionsPage /></MemoryRouter>);

    // 默认当前设备：展示本地会话与「同步数据」按钮。
    expect(screen.getByText("Native session title")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "同步数据" })).toBeInTheDocument();
    expect(screen.queryByText("Remote session title")).not.toBeInTheDocument();

    // 主标题设备切换器没有「全部设备」选项，只能指定具体设备。
    fireEvent.click(screen.getByRole("button", { name: /切换设备/ }));
    expect(screen.queryByText("全部设备")).not.toBeInTheDocument();
    fireEvent.click(await screen.findByText("办公室电脑"));

    // 远端设备：展示该设备同步的会话与「刷新设备数据」，不展示本地会话。
    expect(await screen.findByText("Remote session title")).toBeInTheDocument();
    expect(screen.getByText("Claude Code · 办公室电脑")).toBeInTheDocument();
    expect(screen.queryByText("Native session title")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "刷新设备数据" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "同步数据" })).not.toBeInTheDocument();
  });

  it("opens a remote session as a read-only snapshot but keeps all detail tabs", async () => {
    render(<MemoryRouter><AgentSessionsPage /></MemoryRouter>);

    fireEvent.click(screen.getByRole("button", { name: /切换设备/ }));
    fireEvent.click(await screen.findByText("办公室电脑"));
    fireEvent.click((await screen.findByText("Remote session title")).closest("button")!);

    expect(screen.getByText("远端设备会话快照")).toBeInTheDocument();
    expect(screen.getByText(/来自 办公室电脑/)).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "概览" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "对话" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "轨迹" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "用量" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "信息" })).toBeInTheDocument();
  });
});

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}{location.search}</output>;
}
