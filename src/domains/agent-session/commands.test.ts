import { afterEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn((_command: string, _args?: Record<string, unknown>): Promise<unknown> => Promise.resolve(undefined));

vi.mock("../../platform/tauri/client", () => ({
  invokeCommand: (command: string, args?: Record<string, unknown>) => invokeMock(command, args),
  toAppError: (error: unknown, code: string) => ({ code, message: String(error), retryable: true }),
}));

import { agentSessionCommands } from "./commands";

afterEach(() => invokeMock.mockReset());

describe("agentSessionCommands contract", () => {
  it("maps pagination and search to the Rust filter", async () => {
    await agentSessionCommands.list({ page: 2, pageSize: 25, search: "ses_test", agentType: "opencode", flowletStatus: "native" });
    expect(invokeMock).toHaveBeenCalledWith("list_agent_sessions", {
      filter: { page: 2, page_size: 25, search: "ses_test", agent_type: "opencode", flowlet_status: "native" },
    });
  });

  it("lists clients observed in agent sessions", async () => {
    invokeMock.mockResolvedValueOnce([{ id: "opencode", name: "OpenCode" }]);
    expect(await agentSessionCommands.clients()).toEqual([{ id: "opencode", name: "OpenCode" }]);
    expect(invokeMock).toHaveBeenCalledWith("list_agent_session_clients", undefined);
  });

  it("lists direct child sessions for a main session", async () => {
    invokeMock.mockResolvedValueOnce([]);
    await agentSessionCommands.children("opencode", "ses_main");
    expect(invokeMock).toHaveBeenCalledWith("list_agent_session_children", {
      agentType: "opencode",
      parentSessionId: "ses_main",
    });
  });

  it("loads a native session timeline on demand", async () => {
    invokeMock.mockResolvedValueOnce({ sourceAvailable: true, truncated: false, events: [] });
    await agentSessionCommands.timeline("codex-desktop", "session-1");
    expect(invokeMock).toHaveBeenCalledWith("get_agent_session_timeline", {
      agentType: "codex-desktop",
      sessionId: "session-1",
    });
  });

  it("loads a native session summary for list enrichment", async () => {
    invokeMock.mockResolvedValueOnce({ sourceAvailable: true, truncated: false, turnCount: 2, usage: null });
    await agentSessionCommands.nativeSummary("claude-code", "session-2");
    expect(invokeMock).toHaveBeenCalledWith("get_agent_session_native_summary", {
      agentType: "claude-code",
      sessionId: "session-2",
    });
  });
});
