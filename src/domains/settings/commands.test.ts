import { afterEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>();

vi.mock("../../platform/tauri/client", () => ({
  invokeCommand: (command: string, args?: Record<string, unknown>) => args === undefined ? invokeMock(command) : invokeMock(command, args),
  toAppError: (error: unknown, code: string) => ({ code, message: String(error), retryable: true }),
}));

import { compactDatabase, getAutostartEnabled, getModelPriceCurrencies, getStorageUsage, getTaskReviewNotificationEnabled, getUpstreamProxyConfig, getUsageCostDisplayConfig, parseModelPriceCurrencies, parseUpstreamProxyConfig, parseUsageCostDisplayConfig, setAutostartEnabled, setTaskReviewNotificationEnabled, setUpstreamProxyConfig, setUsageCostDisplayConfig } from "./commands";

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

  it("reads the task-review system notification setting", async () => {
    invokeMock.mockResolvedValueOnce(true);
    await expect(getTaskReviewNotificationEnabled()).resolves.toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("get_task_review_notification_enabled");
  });

  it("writes the task-review system notification setting", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await expect(setTaskReviewNotificationEnabled(false)).resolves.toBe(false);
    expect(invokeMock).toHaveBeenCalledWith("set_task_review_notification_enabled", { enabled: false });
  });

  it("reads model price currencies through the read_config command", async () => {
    const raw = JSON.stringify({ channels_config: { model_prices: [{ channel_id: "kimi", upstream_model: "kimi-k3", currency: "CNY" }] } });
    invokeMock.mockResolvedValueOnce(raw);
    await expect(getModelPriceCurrencies()).resolves.toEqual([{ channel_id: "kimi", upstream_model: "kimi-k3", currency: "CNY" }]);
    expect(invokeMock).toHaveBeenCalledWith("read_config");
  });

  it("reads and normalizes the usage cost display configuration", async () => {
    invokeMock.mockResolvedValueOnce(JSON.stringify({
      usage_cost: {
        currency_conversion_enabled: true,
        display_currency: "USD",
        usd_to_cny_rate: 7.18,
        exchange_rate_note: " finance rate ",
      },
    }));
    await expect(getUsageCostDisplayConfig()).resolves.toEqual({
      currency_conversion_enabled: true,
      display_currency: "USD",
      usd_to_cny_rate: 7.18,
      exchange_rate_note: "finance rate",
    });
  });

  it("updates only usage_cost while preserving the rest of config.json", async () => {
    invokeMock.mockResolvedValueOnce(JSON.stringify({ bind: { port: 18640 }, channels_config: { channels: ["kept"] } }));
    invokeMock.mockResolvedValueOnce(undefined);
    await setUsageCostDisplayConfig({
      currency_conversion_enabled: true,
      display_currency: "CNY",
      usd_to_cny_rate: 7.2,
      exchange_rate_note: "manual",
    });
    const [, args] = invokeMock.mock.calls[1];
    const written = JSON.parse(args?.content as string);
    expect(written.bind.port).toBe(18640);
    expect(written.channels_config.channels).toEqual(["kept"]);
    expect(written.usage_cost).toEqual({
      currency_conversion_enabled: true,
      display_currency: "CNY",
      usd_to_cny_rate: 7.2,
      exchange_rate_note: "manual",
    });
  });
});

describe("parseModelPriceCurrencies", () => {
  it("extracts currencies from channels_config.model_prices and skips malformed entries", () => {
    const raw = JSON.stringify({
      channels_config: {
        model_prices: [
          { channel_id: "longcat", upstream_model: "LongCat-2.0", currency: "CNY" },
          { channel_id: "openai-api", upstream_model: "gpt-5.5", currency: "USD" },
          { channel_id: "broken" },
          "garbage",
        ],
      },
    });
    expect(parseModelPriceCurrencies(raw)).toEqual([
      { channel_id: "longcat", upstream_model: "LongCat-2.0", currency: "CNY" },
      { channel_id: "openai-api", upstream_model: "gpt-5.5", currency: "USD" },
    ]);
  });

  it("returns no currencies for malformed or empty config json", () => {
    expect(parseModelPriceCurrencies("{oops")).toEqual([]);
    expect(parseModelPriceCurrencies("{}")).toEqual([]);
    expect(parseModelPriceCurrencies(JSON.stringify({ model_prices: "nope" }))).toEqual([]);
  });
});

describe("parseUsageCostDisplayConfig", () => {
  it("falls back safely for missing or invalid values", () => {
    expect(parseUsageCostDisplayConfig("{}")).toEqual({
      currency_conversion_enabled: false,
      display_currency: "CNY",
      usd_to_cny_rate: 7.2,
      exchange_rate_note: "",
    });
    expect(parseUsageCostDisplayConfig(JSON.stringify({ usage_cost: { usd_to_cny_rate: -1 } })).usd_to_cny_rate).toBe(7.2);
  });
});

describe("upstream proxy setting", () => {
  it("reads the upstream proxy config through the typed command", async () => {
    const config = { enabled: true, url: "http://127.0.0.1:7890", no_proxy: "localhost" };
    invokeMock.mockResolvedValueOnce(config);
    await expect(getUpstreamProxyConfig()).resolves.toEqual(config);
    expect(invokeMock).toHaveBeenCalledWith("get_upstream_proxy_config");
  });

  it("writes the upstream proxy config through the typed command", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    const config = { enabled: true, url: " http://127.0.0.1:7890 ", no_proxy: " localhost " };
    await expect(setUpstreamProxyConfig(config)).resolves.toEqual({
      enabled: true,
      url: "http://127.0.0.1:7890",
      no_proxy: "localhost",
    });
    expect(invokeMock).toHaveBeenCalledWith("set_upstream_proxy_config", {
      config: { enabled: true, url: "http://127.0.0.1:7890", no_proxy: "localhost" },
    });
  });

  it("normalizes empty url to disabled and tolerates invalid shapes", () => {
    expect(parseUpstreamProxyConfig({ enabled: true, url: "  ", no_proxy: "" })).toEqual({
      enabled: false,
      url: "",
      no_proxy: "",
    });
    expect(parseUpstreamProxyConfig(null)).toEqual({ enabled: false, url: "", no_proxy: "" });
    expect(parseUpstreamProxyConfig("nope")).toEqual({ enabled: false, url: "", no_proxy: "" });
  });
});

