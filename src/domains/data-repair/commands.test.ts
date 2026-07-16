import { afterEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn((_command: string): Promise<unknown> => Promise.resolve(undefined));

vi.mock("../../platform/tauri/client", () => ({
  invokeCommand: (command: string) => invokeMock(command),
  toAppError: (error: unknown, code: string) => ({ code, message: String(error), retryable: true }),
}));

import { dataRepairCommands } from "./commands";

afterEach(() => invokeMock.mockReset());

describe("dataRepairCommands contract", () => {
  it("exposes each repair stage through the typed Tauri boundary", async () => {
    invokeMock
      .mockResolvedValueOnce({ scannedRequests: 2, repairedRequests: 1, repairedLogs: 2, skippedRequests: 1 })
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(5);

    await dataRepairCommands.repairSessions();
    await dataRepairCommands.repairCapturedUsage();
    await dataRepairCommands.repairUnknownUsage();
    await dataRepairCommands.repairCosts();

    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual([
      "repair_opencode_sessions",
      "repair_captured_usage",
      "repair_unknown_usage",
      "repair_usage_costs",
    ]);
  });
});
