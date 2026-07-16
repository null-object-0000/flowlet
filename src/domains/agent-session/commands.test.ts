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
    await agentSessionCommands.list({ page: 2, pageSize: 25, search: "ses_test" });
    expect(invokeMock).toHaveBeenCalledWith("list_agent_sessions", {
      filter: { page: 2, page_size: 25, search: "ses_test" },
    });
  });
});
