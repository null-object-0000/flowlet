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
    await requestLogCommands.list({ page: 2, pageSize: 50, status: "error", clientId: "cline", channelId: "longcat", accountId: "account-1", search: "/messages", timeRange: "6h", model: "deepseek-v4-pro", modelKind: "public", startAt: "2026-08-03T01:00:00.000Z", endAt: "2026-08-03T04:00:00.000Z", tokenStatus: "unknown" });
    expect(invokeMock).toHaveBeenCalledWith("list_request_logs", { filter: {
      page: 2,
      page_size: 50,
      status: "error",
      client_id: "cline",
      channel_id: "longcat",
      account_id: "account-1",
      search: "/messages",
      time_range: "6h",
      model: "deepseek-v4-pro",
      model_kind: "public",
      start_at: "2026-08-03T01:00:00.000Z",
      end_at: "2026-08-03T04:00:00.000Z",
      token_status: "unknown",
    } });
  });

  it("loads the channel/account filter options through their registered command", async () => {
    await requestLogCommands.channelAccounts();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    // 该命令无参数，因此只断言命令名（避免 vitest 对显式 undefined 实参的严格匹配歧义）。
    expect(invokeMock.mock.calls[0][0]).toBe("list_request_log_channel_accounts");
  });

  it("loads detail and cleanup through their registered commands", async () => {
    await requestLogCommands.detail("request-1");
    expect(invokeMock).toHaveBeenCalledWith("get_request_log_detail", { requestId: "request-1" });
    await requestLogCommands.cleanup(30);
    expect(invokeMock).toHaveBeenCalledWith("cleanup_old_logs", { keepDays: 30 });
  });
});
