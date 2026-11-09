import { afterEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(),
}));

vi.mock("../../platform/web/mode", () => ({ isWebHost: true }));

vi.mock("../../platform/tauri/client", () => ({
  invokeCommand: (command: string, args?: Record<string, unknown>) =>
    args === undefined ? invokeMock(command) : invokeMock(command, args),
  toAppError: (error: unknown, code: string) => ({ code, message: String(error), retryable: true }),
}));

import {
  DEFAULT_USAGE_COST_DISPLAY_CONFIG,
  getUsageCostDisplayConfig,
  parseUsageCostDisplayMeta,
  setUsageCostDisplayConfig,
} from "./commands";

const META_KEY = "usage_cost_display_config";

afterEach(() => invokeMock.mockReset());

describe("usage cost display config on Web Host", () => {
  it("reads the normalized config from SQLite app_meta", async () => {
    invokeMock.mockResolvedValueOnce(JSON.stringify({
      currency_conversion_enabled: true,
      display_currency: "USD",
      usd_to_cny_rate: 7.18,
      exchange_rate_note: " finance rate ",
    }));

    await expect(getUsageCostDisplayConfig()).resolves.toEqual({
      currency_conversion_enabled: true,
      display_currency: "USD",
      usd_to_cny_rate: 7.18,
      exchange_rate_note: "finance rate",
    });
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("read_app_meta", { key: META_KEY });
  });

  it("falls back to defaults when app_meta has no stored value", async () => {
    invokeMock.mockResolvedValueOnce(null);
    await expect(getUsageCostDisplayConfig()).resolves.toEqual(DEFAULT_USAGE_COST_DISPLAY_CONFIG);
    expect(invokeMock).toHaveBeenCalledWith("read_app_meta", { key: META_KEY });
  });

  it("falls back to defaults for an empty stored value", async () => {
    invokeMock.mockResolvedValueOnce("");
    await expect(getUsageCostDisplayConfig()).resolves.toEqual(DEFAULT_USAGE_COST_DISPLAY_CONFIG);
  });

  it("falls back to defaults for malformed app_meta JSON", async () => {
    invokeMock.mockResolvedValueOnce("{not json");
    await expect(getUsageCostDisplayConfig()).resolves.toEqual(DEFAULT_USAGE_COST_DISPLAY_CONFIG);
    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual(["read_app_meta"]);
  });

  it("writes the normalized config through write_app_meta and returns it", async () => {
    invokeMock.mockResolvedValueOnce(undefined);

    const returned = await setUsageCostDisplayConfig({
      currency_conversion_enabled: true,
      display_currency: "USD",
      usd_to_cny_rate: 7.18,
      exchange_rate_note: "  finance rate  ",
    });
    const normalized = {
      currency_conversion_enabled: true,
      display_currency: "USD",
      usd_to_cny_rate: 7.18,
      exchange_rate_note: "finance rate",
    };

    expect(returned).toEqual(normalized);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("write_app_meta", {
      key: META_KEY,
      value: JSON.stringify(normalized),
    });
    expect(invokeMock.mock.calls.map(([command]) => command)).not.toContain("read_config");
    expect(invokeMock.mock.calls.map(([command]) => command)).not.toContain("write_config");
  });

  it("normalizes an invalid rate before persisting", async () => {
    invokeMock.mockResolvedValueOnce(undefined);

    await expect(setUsageCostDisplayConfig({
      currency_conversion_enabled: false,
      display_currency: "CNY",
      usd_to_cny_rate: 0,
      exchange_rate_note: "",
    })).resolves.toEqual({ ...DEFAULT_USAGE_COST_DISPLAY_CONFIG });

    const [, args] = invokeMock.mock.calls[0];
    expect(JSON.parse(args?.value as string)).toEqual(DEFAULT_USAGE_COST_DISPLAY_CONFIG);
  });

  it("treats non-object app_meta payloads as defaults", () => {
    expect(parseUsageCostDisplayMeta("null")).toEqual(DEFAULT_USAGE_COST_DISPLAY_CONFIG);
    expect(parseUsageCostDisplayMeta("[1,2]")).toEqual(DEFAULT_USAGE_COST_DISPLAY_CONFIG);
    expect(parseUsageCostDisplayMeta(undefined)).toEqual(DEFAULT_USAGE_COST_DISPLAY_CONFIG);
  });
});
