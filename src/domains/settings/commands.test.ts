import { afterEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>();

vi.mock("../../platform/tauri/client", () => ({
  invokeCommand: (command: string, args?: Record<string, unknown>) => args === undefined ? invokeMock(command) : invokeMock(command, args),
  toAppError: (error: unknown, code: string) => ({ code, message: String(error), retryable: true }),
}));

import { compactDatabase, getAutostartEnabled, getModelPriceCurrencies, getStorageUsage, parseModelPriceCurrencies, setAutostartEnabled } from "./commands";

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

  it("runs database compaction through the typed settings boundary", async () => {
    const result = { before: { databaseBytes: 2048 }, after: { databaseBytes: 1024 }, reclaimedBytes: 1024 };
    invokeMock.mockResolvedValueOnce(result);
    await expect(compactDatabase()).resolves.toBe(result);
    expect(invokeMock).toHaveBeenCalledWith("compact_database");
  });

  it("reads model price currencies through the read_config command", async () => {
    const raw = JSON.stringify({ channels_config: { model_prices: [{ channel_id: "kimi", upstream_model: "kimi-k3", currency: "CNY" }] } });
    invokeMock.mockResolvedValueOnce(raw);
    await expect(getModelPriceCurrencies()).resolves.toEqual([{ channel_id: "kimi", upstream_model: "kimi-k3", currency: "CNY" }]);
    expect(invokeMock).toHaveBeenCalledWith("read_config");
  });
});

describe("parseModelPriceCurrencies", () => {
  it("extracts currencies from channels_config.model_prices and skips malformed entries", () => {
    const raw = JSON.stringify({
      channels_config: {
        model_prices: [
          { channel_id: "longcat", upstream_model: "LongCat-2.0", currency: "CNY" },
          { channel_id: "openai-api", upstream_model: "gpt-5.5", currency: "USD" },
          { channel_id: "codex-native", upstream_model: "gpt-5.5" },
          { channel_id: "broken" },
          "garbage",
        ],
      },
    });
    expect(parseModelPriceCurrencies(raw)).toEqual([
      { channel_id: "longcat", upstream_model: "LongCat-2.0", currency: "CNY" },
      { channel_id: "openai-api", upstream_model: "gpt-5.5", currency: "USD" },
      { channel_id: "codex-native", upstream_model: "gpt-5.5", currency: null },
    ]);
  });

  it("returns no currencies for malformed or empty config json", () => {
    expect(parseModelPriceCurrencies("{oops")).toEqual([]);
    expect(parseModelPriceCurrencies("{}")).toEqual([]);
    expect(parseModelPriceCurrencies(JSON.stringify({ model_prices: "nope" }))).toEqual([]);
  });
});

