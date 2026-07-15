import { afterEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn((_command: string, _args?: Record<string, unknown>): Promise<unknown> => Promise.resolve(undefined));

vi.mock("../../platform/tauri/client", () => ({
  invokeCommand: (command: string, args?: Record<string, unknown>) => invokeMock(command, args),
  toAppError: (error: unknown, code: string) => ({ code, message: String(error), retryable: true }),
}));

import { requestLogCommands } from "./commands";

afterEach(() => invokeMock.mockReset());

describe("requestLogCommands contract", () => {
  it("maps the UI filter to the Rust LogsFilter shape", async () => {
    await requestLogCommands.list({ page: 2, pageSize: 50, status: "error", clientId: "cline", channelId: "longcat", search: "/messages" });
    expect(invokeMock).toHaveBeenCalledWith("list_request_logs", { filter: {
      page: 2,
      page_size: 50,
      status: "error",
      client_id: "cline",
      channel_id: "longcat",
      search: "/messages",
    } });
  });

  it("loads detail and cleanup through their registered commands", async () => {
    await requestLogCommands.detail("request-1");
    expect(invokeMock).toHaveBeenCalledWith("get_request_log_detail", { requestId: "request-1" });
    await requestLogCommands.cleanup(30);
    expect(invokeMock).toHaveBeenCalledWith("cleanup_old_logs", { keepDays: 30 });
  });
});
