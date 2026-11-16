import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { A2aPage } from "./A2aPage";
import { a2aCommands } from "../../domains/a2a/commands";
vi.mock("../../platform/web/mode", () => ({ isWebHost: true }));
vi.mock("../../platform/desktop/mode", () => ({
  isDesktopHost: false,
  isDesktopClient: false,
}));
vi.mock("../../shared/ui/PageHeader", () => ({
  PageHeader: ({ title, children }: any) => (
    <header>
      {title}
      {children}
    </header>
  ),
}));
vi.mock("./A2aOverlays", () => ({ A2aOverlays: () => null }));
vi.mock("./AgentGatewayAccess", () => ({ AgentGatewayAccess: () => null }));
vi.mock("../../domains/a2a/commands", () => ({
  a2aCommands: {
    capabilities: vi.fn(async () => ({ acpRegistration: false })),
    list: vi.fn(async () => [
      {
        id: "research",
        name: "研究助手",
        enabled: true,
        protocol: "a2a",
        card: { description: "研究和分析", skills: [] },
      },
    ]),
    keys: vi.fn(async () => []),
    revealKey: vi.fn(async () => ({ id: "new-key", token: "flwa2a_test" })),
    calls: vi.fn(async () => [
      {
        id: "call",
        agentId: "research",
        keyId: "admin-test",
        method: "SendMessage",
        startedAt: "2026-11-16T00:00:00Z",
        durationMs: 20,
        httpStatus: 200,
        state: "TASK_STATE_SUBMITTED",
        latestTaskState: "TASK_STATE_COMPLETED",
        taskId: "task",
        error: null,
      },
    ]),
  },
}));
describe("Agent gateway workspace", () => {
  it("keeps credentials out of the Agent view and hides successful polling by default", async () => {
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <A2aPage />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("研究助手")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "创建调用密钥" }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      within(screen.getByRole("navigation")).getByRole("button", {
        name: "调用记录",
      }),
    );
    expect(await screen.findByText("请求成功")).toBeInTheDocument();
    expect(screen.getByText("已完成")).toBeInTheDocument();
    expect(screen.getByText("管理台测试")).toBeInTheDocument();
    await waitFor(() =>
      expect(a2aCommands.calls).toHaveBeenCalledWith(undefined, true),
    );
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() =>
      expect(a2aCommands.calls).toHaveBeenCalledWith(undefined, false),
    );
    expect(
      within(screen.getByRole("navigation")).queryByRole("button", {
        name: /调用密钥/,
      }),
    ).not.toBeInTheDocument();
  });
});
