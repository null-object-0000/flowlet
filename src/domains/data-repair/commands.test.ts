import { afterEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn((_command: string, _args?: Record<string, unknown>): Promise<unknown> => Promise.resolve(undefined));

vi.mock("../../platform/tauri/client", () => ({
  invokeCommand: (command: string, args?: Record<string, unknown>) => invokeMock(command, args),
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

    await dataRepairCommands.repairSessions("7d");
    await dataRepairCommands.repairCapturedUsage("7d");
    await dataRepairCommands.repairUnknownUsage("7d");
    await dataRepairCommands.repairCosts("7d");

    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual([
      "repair_agent_sessions",
      "repair_captured_usage",
      "repair_unknown_usage",
      "repair_usage_costs",
    ]);
    expect(invokeMock.mock.calls.every(([, args]) => args?.timeRange === "7d")).toBe(true);
  });
});
