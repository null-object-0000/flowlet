import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { AgentSessionRow } from "../../domains/agent-session/types";

vi.mock("lottie-web", () => ({
  default: { loadAnimation: vi.fn(() => ({ destroy: vi.fn() })) },
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
  knownTokens: 1200,
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

vi.mock("../../features/agent-sessions/useAgentSessions", () => ({
  useAgentSessions: () => ({
    data: { rows: [session], total: 1, page: 1, pageSize: 8 },
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
  useAgentSessionClients: () => ({ data: [], isLoading: false }),
}));

import { AgentSessionsPage } from "./AgentSessionsPage";
import { AgentSessionDetailSideSheet, sessionDisplayTitle } from "./AgentSessionDetailSideSheet";

describe("AgentSessionsPage", () => {
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
    expect(screen.getByText("子会话（1）")).toBeInTheDocument();
    expect(screen.getByText("Child session title")).toBeInTheDocument();
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

    expect(screen.getByText("未经过 Flowlet")).toBeInTheDocument();
    expect(screen.getByText("ChatGPT (Codex)")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "查看会话 ses_native_test 的请求日志明细" })).not.toBeInTheDocument();
    expect(screen.getAllByText("—")).toHaveLength(5);
  });
});

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}{location.search}</output>;
}
