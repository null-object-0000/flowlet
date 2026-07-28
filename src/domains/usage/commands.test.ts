import { afterEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn((_command: string, _args?: Record<string, unknown>): Promise<unknown> => Promise.resolve(undefined));

vi.mock("../../platform/tauri/client", () => ({
  invokeCommand: (command: string, args?: Record<string, unknown>) => invokeMock(command, args),
  toAppError: (error: unknown, code: string) => ({ code, message: String(error), retryable: true }),
}));

import { usageCommands } from "./commands";

afterEach(() => invokeMock.mockReset());

describe("usageCommands contract", () => {
  it("reads usage summaries through the typed Tauri boundary", async () => {
    invokeMock.mockResolvedValueOnce([]);
    expect(await usageCommands.summary("month")).toEqual([]);
    expect(invokeMock).toHaveBeenCalledWith("usage_summary", { period: "month" });
  });

  it("reads today token summary through the typed Tauri boundary", async () => {
    const summary = {
      total_tokens: 12345,
      input_tokens: 10000,
      input_cached_tokens: 8000,
      input_uncached_tokens: 2000,
      cache_measured_input_tokens: 10000,
      output_tokens: 2345,
    };
    invokeMock.mockResolvedValueOnce(summary);
    expect(await usageCommands.todayTokens()).toEqual(summary);
    expect(invokeMock).toHaveBeenCalledWith("usage_today_tokens", undefined);
  });
});
