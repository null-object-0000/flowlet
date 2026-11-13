import { createElement, type ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { a2aCommands } from "../../domains/a2a/commands";
import type { A2aAgent } from "../../domains/a2a/types";
import { useA2aGateway } from "./useA2aGateway";

vi.mock("../../domains/a2a/commands", () => ({
  a2aCommands: {
    list: vi.fn(),
    keys: vi.fn(),
    calls: vi.fn(),
    save: vi.fn(),
    inspect: vi.fn(),
    remove: vi.fn(),
    createKey: vi.fn(),
    revokeKey: vi.fn(),
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
  it("passes explicit key grants and keeps the one-time token only in transient UI state", async () => {
    vi.mocked(a2aCommands.createKey).mockResolvedValue({
      id: "key-1",
      token: "flwa2a_test",
    });
    const { result } = setup();
    act(() => {
      result.current.setKeyName("Hermes");
      result.current.setGrants(["research"]);
    });
    await act(() => result.current.createKey.mutateAsync());
    expect(a2aCommands.createKey).toHaveBeenCalledWith("Hermes", ["research"]);
    expect(result.current.newToken).toBe("flwa2a_test");
    act(() => result.current.setNewToken(""));
    expect(result.current.newToken).toBe("");
  });
});
