import { afterEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn<(command: string) => Promise<unknown>>();

vi.mock("../../platform/tauri/client", () => ({
  invokeCommand: (command: string) => invokeMock(command),
  toAppError: (error: unknown, code: string) => ({ code, message: String(error), retryable: true }),
}));

import { getAutostartEnabled, setAutostartEnabled } from "./commands";

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
});

