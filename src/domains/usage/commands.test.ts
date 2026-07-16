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
    expect(await usageCommands.summary()).toEqual([]);
    expect(invokeMock).toHaveBeenCalledWith("usage_summary", undefined);
  });

  it("runs offline usage analysis", async () => {
    invokeMock.mockResolvedValueOnce(4);
    expect(await usageCommands.analyze()).toBe(4);
    expect(invokeMock).toHaveBeenCalledWith("analyze_usage", undefined);
  });
});
