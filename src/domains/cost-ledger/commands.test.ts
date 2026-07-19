import { afterEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn((_command: string): Promise<unknown> => Promise.resolve(undefined));

vi.mock("../../platform/tauri/client", () => ({
  invokeCommand: (command: string) => invokeMock(command),
  toAppError: (error: unknown, code: string) => ({ code, message: String(error), retryable: true }),
}));

import { costLedgerCommands } from "./commands";

afterEach(() => invokeMock.mockReset());

describe("costLedgerCommands contract", () => {
  it("probes all read-only cost ledger sources through the typed boundary", async () => {
    invokeMock.mockResolvedValueOnce({ reports: [], sessions: [], usage: [], entitlements: [], balances: [] });

    await costLedgerCommands.probeSources();

    expect(invokeMock).toHaveBeenCalledWith("probe_cost_ledger_sources");
  });

  it("maps probe failures into a domain error", async () => {
    invokeMock.mockRejectedValueOnce(new Error("probe failed"));

    await expect(costLedgerCommands.probeSources()).rejects.toMatchObject({
      code: "cost_ledger_source_probe_failed",
    });
  });
});
