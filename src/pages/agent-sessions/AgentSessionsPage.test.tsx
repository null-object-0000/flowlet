import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
const {
  permissionReplyMock,
  sessionListRefetchMock,
  childrenRefetchMock,
  nativeSummaryRefetchMock,
  lastInteractionRefetchMock,
} = vi.hoisted(() => ({
  permissionReplyMock: vi.fn(() => Promise.resolve()),
  sessionListRefetchMock: vi.fn(() => Promise.resolve({ data: undefined })),
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
    data: {
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
    },
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
  useAgentSessionClients: () => ({ data: [], isLoading: false }),
}));

import { AgentSessionsPage } from "./AgentSessionsPage";
import { AgentSessionDetailSideSheet, sessionDisplayTitle } from "./AgentSessionDetailSideSheet";

describe("AgentSessionsPage", () => {
  beforeEach(() => {
    listedSessions = [session];
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

  it("offers Codex and an independent Flowlet observation filter", () => {
    render(<MemoryRouter><AgentSessionsPage /></MemoryRouter>);

    fireEvent.click(screen.getByText("全部客户端"));
    const codexOption = screen.getByText("ChatGPT (Codex)");
    expect(codexOption).toBeInTheDocument();
    expect(screen.getByText("Codex CLI")).toBeInTheDocument();
    expect(screen.getByText("Claude Code")).toBeInTheDocument();
    expect(screen.getAllByText("OpenCode").length).toBeGreaterThan(1);
    fireEvent.click(codexOption);

    fireEvent.click(screen.getByText("全部状态"));
    expect(screen.getByText("经过 Flowlet")).toBeInTheDocument();
    expect(screen.getByText("未经过 Flowlet")).toBeInTheDocument();
  });

  it("opens session details and refreshes the active tab", async () => {
    render(<MemoryRouter><AgentSessionsPage /></MemoryRouter>);

    const rowTitle = screen.getByText("Native session title");
    fireEvent.click(rowTitle.closest("button")!);

    expect(screen.getByText(/会话详情/)).toBeInTheDocument();
    expect(screen.getByText("ses_native_test")).toBeInTheDocument();
    expect(screen.getByText("Flowlet 请求统计")).toBeInTheDocument();
    expect(screen.getByText("Agent 原生用量")).toBeInTheDocument();
    expect(screen.getByText("$0.123456")).toBeInTheDocument();
    expect(screen.getByText("模型：native-model")).toBeInTheDocument();
    expect(screen.getByText("子会话（1）")).toBeInTheDocument();
    expect(screen.getByText("Child session title")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "概览" })).toHaveAttribute("aria-selected", "true");
    const tabList = screen.getByRole("tablist");
    fireEvent.click(within(tabList).getByRole("button", { name: "刷新" }));
    await waitFor(() => {
      expect(sessionListRefetchMock).toHaveBeenCalledOnce();
      expect(childrenRefetchMock).toHaveBeenCalledOnce();
      expect(nativeSummaryRefetchMock).toHaveBeenCalledOnce();
    });
    [sessionListRefetchMock, childrenRefetchMock, nativeSummaryRefetchMock].forEach((mock) => mock.mockClear());
    expect(screen.queryByText("完整展示最后一个用户输入及其后的全部 Agent 输出与过程事件")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "最近一轮" }));
    fireEvent.click(within(tabList).getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(lastInteractionRefetchMock).toHaveBeenCalledOnce());
    expect(sessionListRefetchMock).not.toHaveBeenCalled();
    expect(childrenRefetchMock).not.toHaveBeenCalled();
    expect(nativeSummaryRefetchMock).not.toHaveBeenCalled();
    const conversation = screen.getByRole("tabpanel", { name: "最近一轮" });
    const input = within(conversation).getByLabelText("用户消息");
    expect(within(input).getByText("latest complete input")).toBeInTheDocument();
    expect(within(conversation).getByText("first output")).toBeInTheDocument();
    expect(within(conversation).getByText("second output")).toBeInTheDocument();
    expect(within(conversation).getByRole("status")).toHaveTextContent("正在处理");
    expect(within(conversation).queryByText("用户输入")).not.toBeInTheDocument();
    expect(within(conversation).queryByText("Agent 输出")).not.toBeInTheDocument();
    expect(within(conversation).queryByText("OpenCode · native-model")).not.toBeInTheDocument();
    const process = within(conversation).getByText("已处理 3 项").closest("details")!;
    expect(process).not.toHaveAttribute("open");
    fireEvent.click(within(conversation).getByText("已处理 3 项"));
    expect(process).toHaveAttribute("open");
    expect(within(process).getByText("cargo test")).toBeInTheDocument();
    expect(within(process).getByText("E:\\flowlet")).toBeInTheDocument();
    expect(within(process).getByText("2 tests passed")).toBeInTheDocument();
    expect(within(process).getByText("命令")).toBeInTheDocument();
    expect(within(process).getByText("工作目录")).toBeInTheDocument();
    expect(within(process).getByText("退出码")).toBeInTheDocument();
    expect(screen.queryByText("会话时间线")).not.toBeInTheDocument();
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

    expect(screen.queryByText("未经过 Flowlet")).not.toBeInTheDocument();
    expect(screen.getByText("Agent 来源")).toBeInTheDocument();
    expect(screen.getAllByText("ChatGPT (Codex)").length).toBeGreaterThan(0);
    expect(screen.queryByText("未知客户端")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "查看会话 ses_native_test 的请求日志明细" })).not.toBeInTheDocument();
    expect(screen.getAllByText("—")).toHaveLength(7);
  });

  it("allows a pending OpenCode permission once from the session overview", async () => {
    render(
      <MemoryRouter>
        <AgentSessionDetailSideSheet session={session} onClose={vi.fn()} onViewRequestLogs={vi.fn()} />
      </MemoryRouter>,
    );

    const approval = screen.getByText("OpenCode 等待确认").closest("article")!;
    expect(within(approval).getByText("cargo test")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "同意本次" }));

    await waitFor(() => expect(permissionReplyMock).toHaveBeenCalledWith({ permissionId: "per_test", decision: "allow_once" }));
  });
});

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}{location.search}</output>;
}
