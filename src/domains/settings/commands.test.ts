import { afterEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>();

vi.mock("../../platform/tauri/client", () => ({
  invokeCommand: (command: string, args?: Record<string, unknown>) => args === undefined ? invokeMock(command) : invokeMock(command, args),
  toAppError: (error: unknown, code: string) => ({ code, message: String(error), retryable: true }),
}));

import { getAutostartEnabled, getStorageUsage, setAutostartEnabled } from "./commands";

afterEach(() => invokeMock.mockReset());

describe("settings command contract", () => {
  it("reads the operating-system autostart state", async () => {
    invokeMock.mockResolvedValueOnce(true);
    await expect(getAutostartEnabled()).resolves.toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("is_autostart_enabled");
  });

  it("enables autostart and verifies the resulting state", async () => {
    invokeMock.mockResolvedValueOnce(undefined).mockResolvedValueOnce(true);
    await expect(setAutostartEnabled(true)).resolves.toBe(true);
    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual(["enable_autostart", "is_autostart_enabled"]);
  });

  it("disables autostart and verifies the resulting state", async () => {
    invokeMock.mockResolvedValueOnce(undefined).mockResolvedValueOnce(false);
    await expect(setAutostartEnabled(false)).resolves.toBe(false);
    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual(["disable_autostart", "is_autostart_enabled"]);
  });

  it("reads the storage usage summary", async () => {
    const summary = { totalBytes: 1024, categories: [] };
    invokeMock.mockResolvedValueOnce(summary);
    await expect(getStorageUsage("scan-1")).resolves.toBe(summary);
    expect(invokeMock).toHaveBeenCalledWith("storage_usage_summary", { scanId: "scan-1" });
  });
});

