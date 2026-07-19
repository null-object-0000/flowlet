import { fireEvent, render, screen } from "@testing-library/react";
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

vi.mock("../../features/agent-sessions/useAgentSessions", () => ({
  useAgentSessions: () => ({
    data: { rows: listedSessions, total: listedSessions.length, page: 1, pageSize: 8 },
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  }),
  useAgentSessionChildren: () => ({
    data: [childSession],
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
  useAgentSessionTimeline: () => ({
    data: {
      sourceAvailable: true,
      truncated: false,
      turnCount: 1,
      usage: {
        inputTokens: 1000,
        cachedInputTokens: 300,
        cacheWriteInputTokens: 50,
        outputTokens: 456,
        reasoningTokens: 120,
        totalTokens: 1576,
        cost: 0.123456,
        costCurrency: "USD",
      },
      models: ["native-model"],
      events: [{
        id: "turn-1",
        kind: "turn",
        source: "agent-native",
        timestamp: "2026-07-18T08:00:00Z",
        title: "Agent 轮次",
        content: null,
        model: "native-model",
        status: "completed",
        durationMs: 62000,
        timeToFirstTokenMs: 1250,
        usage: {
          inputTokens: 1000,
          cachedInputTokens: 300,
          cacheWriteInputTokens: 50,
          outputTokens: 456,
          reasoningTokens: 120,
          totalTokens: 1576,
          cost: null,
          costCurrency: null,
        },
      }, {
        id: "event-1",
        kind: "assistant-message",
        source: "agent-native",
        timestamp: "2026-07-18T08:01:00Z",
        title: null,
        content: "Please inspect the routing bug",
        model: null,
        status: null,
        durationMs: null,
        timeToFirstTokenMs: null,
        usage: {
          inputTokens: 500,
          cachedInputTokens: 100,
          cacheWriteInputTokens: 0,
          outputTokens: 200,
          reasoningTokens: 20,
          totalTokens: 720,
          cost: null,
          costCurrency: null,
        },
      }],
    },
    isLoading: false,
    isFetching: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
  useAgentSessionNativeSummary: () => ({
    data: {
      sourceAvailable: true,
      truncated: false,
      turnCount: 2,
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
    isLoading: false,
    isError: false,
    error: null,
  }),
  useAgentSessionClients: () => ({ data: [], isLoading: false }),
}));

import { AgentSessionsPage } from "./AgentSessionsPage";
import { AgentSessionDetailSideSheet, sessionDisplayTitle } from "./AgentSessionDetailSideSheet";

describe("AgentSessionsPage", () => {
  beforeEach(() => {
    listedSessions = [session];
  });

  it("shows request-style token details and aggregate cache hit rate", () => {
    render(<MemoryRouter><AgentSessionsPage /></MemoryRouter>);

    expect(screen.getByLabelText("Token 明细：总计 1.2万，缓存命中率 50.0%")).toHaveAttribute("title", "12,000");
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
    expect(screen.getByLabelText("Token 明细：总计 13.5万，缓存命中率 16.0%")).toHaveAttribute("title", "135,000");
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

  it("opens session details in a side sheet when a row is clicked", () => {
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

    fireEvent.click(screen.getByRole("tab", { name: "时间线" }));
    expect(screen.getByRole("tab", { name: "时间线" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("原生会话时间线")).toBeInTheDocument();
    expect(screen.getByText("Please inspect the routing bug")).toBeInTheDocument();
    expect(screen.getAllByLabelText("单次原生用量").some((element) => element.textContent?.includes("总计 720"))).toBe(true);
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
    expect(screen.getByText("ChatGPT (Codex)")).toBeInTheDocument();
    expect(screen.queryByText("未知客户端")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "查看会话 ses_native_test 的请求日志明细" })).not.toBeInTheDocument();
    expect(screen.getAllByText("—")).toHaveLength(7);
  });

  it("shows Codex turn usage, latency and cache hit rate in the native timeline", () => {
    render(
      <MemoryRouter>
        <AgentSessionDetailSideSheet session={session} onClose={vi.fn()} onViewRequestLogs={vi.fn()} />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByText("时间线"));
    expect(screen.getByText("Agent 轮次 · Agent 原生")).toBeInTheDocument();
    expect(screen.getByText(/状态：已完成 · 耗时 1 min · 首 Token 1\.3 s/)).toBeInTheDocument();
    expect(screen.getByText("缓存命中率 30%")).toBeInTheDocument();
  });
});

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}{location.search}</output>;
}
