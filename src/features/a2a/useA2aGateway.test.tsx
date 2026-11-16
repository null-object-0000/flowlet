import { createElement, type ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { a2aCommands } from "../../domains/a2a/commands";
import type { A2aAgent } from "../../domains/a2a/types";
import { useA2aGateway } from "./useA2aGateway";

vi.mock("../../domains/a2a/commands", () => ({
  a2aCommands: {
    capabilities: vi.fn(),
    list: vi.fn(),
    keys: vi.fn(),
    calls: vi.fn(),
    save: vi.fn(),
    inspect: vi.fn(),
    remove: vi.fn(),
    createKey: vi.fn(),
    revokeKey: vi.fn(),
    revealKey: vi.fn(),
    invoke: vi.fn(),
  },
}));
vi.mock("@douyinfe/semi-ui-19", () => ({
  Toast: { success: vi.fn(), error: vi.fn() },
}));

const agent: A2aAgent = {
  id: "research",
  name: "Research",
  cardUrl: "https://agent.example/card",
  endpoint: "https://agent.example/rpc",
  enabled: true,
  allowPrivateNetwork: false,
  timeoutSeconds: 30,
  hasUpstreamToken: true,
  gatewayPath: "/a2a/research",
  updatedAt: "2026-11-12",
  card: {
    name: "Research",
    skills: [],
    supportedInterfaces: [
      {
        protocolBinding: "JSONRPC",
        protocolVersion: "1.0",
        tenant: "workspace",
      },
    ],
  },
};
function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  return renderHook(() => useA2aGateway(), { wrapper });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(a2aCommands.capabilities).mockResolvedValue({
    acpRegistration: false,
  });
  vi.mocked(a2aCommands.list).mockResolvedValue([agent]);
  vi.mocked(a2aCommands.keys).mockResolvedValue([]);
  vi.mocked(a2aCommands.calls).mockResolvedValue([]);
});

describe("A2A management orchestration", () => {
  it("continues with the returned task and context IDs and sends the declared tenant", async () => {
    vi.mocked(a2aCommands.invoke).mockResolvedValue({
      status: 200,
      body: { result: { task: { id: "task-7", contextId: "context-7" } } },
    });
    const { result } = setup();
    await waitFor(() => expect(result.current.agents.isSuccess).toBe(true));
    act(() => {
      result.current.setSelected(agent);
      result.current.setMessage("first message");
      result.current.setContextId("context-client");
    });
    const first = result.current.rpc("SendMessage") as {
      params: { tenant: string; message: { contextId: string } };
    };
    expect(first.params.tenant).toBe("workspace");
    expect(first.params.message.contextId).toBe("context-client");
    await act(() => result.current.invoke.mutateAsync(first));
    expect(a2aCommands.invoke).toHaveBeenCalledWith("research", first, 30);
    expect(result.current.taskId).toBe("task-7");
    expect(result.current.contextId).toBe("context-7");
    expect(result.current.rpc("GetTask").params).toEqual({
      tenant: "workspace",
      id: "task-7",
    });
    expect(result.current.rpc("SendMessage").params).toMatchObject({
      message: { contextId: "context-7" },
    });
  });
  it("does not fetch or manage separate gateway credentials", async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.agents.isSuccess).toBe(true));
    expect(a2aCommands.keys).not.toHaveBeenCalled();
    expect(a2aCommands.createKey).not.toHaveBeenCalled();
  });
  it("continues paused tasks but never resubmits a completed task ID", async () => {
    const { result } = setup();
    act(() => result.current.setSelected(agent));
    for (const state of ["TASK_STATE_INPUT_REQUIRED", "TASK_STATE_COMPLETED"]) {
      vi.mocked(a2aCommands.invoke).mockResolvedValue({
        status: 200,
        body: {
          result: {
            task: { id: "task-1", contextId: "context-1", status: { state } },
          },
        },
      });
      await act(() =>
        result.current.invoke.mutateAsync(result.current.rpc("SendMessage")),
      );
      const params = result.current.rpc("SendMessage").params;
      const message = "message" in params ? params.message : undefined;
      expect(message).toHaveProperty("contextId", "context-1");
      if (state === "TASK_STATE_INPUT_REQUIRED")
        expect(message).toHaveProperty("taskId", "task-1");
      else expect(message).not.toHaveProperty("taskId");
    }
  });
});
