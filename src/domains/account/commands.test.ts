import { afterEach, describe, expect, it, vi } from "vitest";

// Contract test: verify the account adapter forwards each concern to the
// correct Tauri command name / argument shape without duplicating the raw
// command strings anywhere else in the UI.

const invokeMock = vi.fn(
  (cmd: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<unknown> => Promise.resolve(undefined),
);

vi.mock("../../platform/tauri/client", () => ({
  invokeCommand: (cmd: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<unknown> =>
    timeoutMs === undefined ? invokeMock(cmd, args) : invokeMock(cmd, args, timeoutMs),
  toAppError: (err: unknown, code: string) => ({ code, message: String(err), retryable: true }),
}));

import { accountCommands } from "./commands";

afterEach(() => invokeMock.mockReset());

describe("accountCommands contract", () => {
  it("list -> list_channel_accounts (no args)", async () => {
    invokeMock.mockResolvedValueOnce([]);
    const out = await accountCommands.list();
    expect(invokeMock).toHaveBeenCalledWith("list_channel_accounts", undefined);
    expect(out).toEqual([]);
  });

  it("saveAll -> save_channel_accounts with { accounts }", async () => {
    invokeMock.mockResolvedValueOnce([]);
    const payload = [{ id: "a1" }];
    await accountCommands.saveAll(payload as never);
    expect(invokeMock).toHaveBeenCalledWith("save_channel_accounts", { accounts: payload });
  });

  it("testConnection -> test_connection with camelCase args", async () => {
    await accountCommands.testConnection({ channel_id: "longcat", api_key: "sk" });
    expect(invokeMock).toHaveBeenCalledWith("test_connection", {
      channelId: "longcat",
      apiKey: "sk",
      baseUrlOverride: null,
    });
  });

  it("syncModels -> sync_models with { accountId }", async () => {
    invokeMock.mockResolvedValueOnce({
      models_synced: 2,
      models: [{ model: "x" }],
      errors: [],
    });
    const r = await accountCommands.syncModels("a1");
    expect(invokeMock).toHaveBeenCalledWith("sync_models", { accountId: "a1" });
    expect(r.models_synced).toBe(2);
  });

  it("queryBalance -> query_balance with { accountId }", async () => {
    invokeMock.mockResolvedValueOnce({ balance: 1, currency: "CNY", is_available: true, error: null });
    await accountCommands.queryBalance("a1");
    expect(invokeMock).toHaveBeenCalledWith("query_balance", { accountId: "a1" });
  });

  it("saveBalanceSnapshot -> save_balance_snapshot with { snapshot }", async () => {
    const snapshot = { id: "snapshot-1", account_id: "a1" };
    await accountCommands.saveBalanceSnapshot(snapshot as never);
    expect(invokeMock).toHaveBeenCalledWith("save_balance_snapshot", { snapshot });
  });

  it("latestBalanceSnapshots -> latest_balance_snapshots (no args)", async () => {
    invokeMock.mockResolvedValueOnce([]);
    await accountCommands.latestBalanceSnapshots();
    expect(invokeMock).toHaveBeenCalledWith("latest_balance_snapshots", undefined);
  });

  it("uses long-running timeouts for WebView probing and scraping", async () => {
    await accountCommands.probeScrapeLogin("account-longcat");
    expect(invokeMock).toHaveBeenLastCalledWith(
      "probe_scrape_login",
      { accountId: "account-longcat", interactive: true },
      45_000,
    );

    await accountCommands.scrapeBalance("account-longcat");
    expect(invokeMock).toHaveBeenLastCalledWith(
      "scrape_balance",
      { accountId: "account-longcat", interactive: true },
      60_000,
    );
  });

  it("runs periodic WebView resource synchronization in non-interactive mode", async () => {
    invokeMock.mockResolvedValueOnce({ started: true, accounts: 1, synced: 1, failed: 0 });
    await accountCommands.syncScrapeBalances("background");
    expect(invokeMock).toHaveBeenCalledWith(
      "sync_scrape_balances",
      { triggerSource: "background" },
      600_000,
    );
  });
});

vi.clearAllMocks();
