import { afterEach, describe, expect, it, vi } from "vitest";
import { accountCommands } from "../../domains/account/commands";
import type { ChannelAccount } from "../../domains/account/types";
import type { ChannelPreset } from "../../domains/channel/types";
import { refreshSavedAccounts } from "./useAccountActions";

vi.mock("lottie-web", () => ({
  default: { loadAnimation: vi.fn(() => ({ destroy: vi.fn() })) },
}));

const account = {
  id: "account-deepseek",
  channel_id: "deepseek",
  name: "DeepSeek 主账号",
  api_key: "sk-test",
  enabled: true,
} as ChannelAccount;

const preset = {
  id: "deepseek",
  supports_balance_query: true,
  supports_model_list: true,
} as ChannelPreset;

afterEach(() => vi.restoreAllMocks());

describe("refreshSavedAccounts", () => {
  it("refreshes balance and models after an eligible account is saved", async () => {
    const queryBalance = vi.spyOn(accountCommands, "queryBalance").mockResolvedValue({
      balance: 100,
      currency: "CNY",
      is_available: true,
      error: null,
    });
    const syncModels = vi.spyOn(accountCommands, "syncModels").mockResolvedValue({
      models_synced: 2,
      models: [],
      errors: [],
    });

    const result = await refreshSavedAccounts([account], [preset]);

    expect(queryBalance).toHaveBeenCalledWith(account.id);
    expect(syncModels).toHaveBeenCalledWith(account.id);
    expect(result).toEqual({ balanceRequested: true, modelsRequested: true, failures: [] });
  });

  it("skips disabled accounts and unsupported capabilities", async () => {
    const queryBalance = vi.spyOn(accountCommands, "queryBalance").mockResolvedValue({
      balance: null,
      currency: null,
      is_available: false,
      error: null,
    });
    const syncModels = vi.spyOn(accountCommands, "syncModels").mockResolvedValue({
      models_synced: 0,
      models: [],
      errors: [],
    });

    const result = await refreshSavedAccounts(
      [{ ...account, enabled: false }],
      [{ ...preset, supports_balance_query: false, supports_model_list: false }],
    );

    expect(queryBalance).not.toHaveBeenCalled();
    expect(syncModels).not.toHaveBeenCalled();
    expect(result).toEqual({ balanceRequested: false, modelsRequested: false, failures: [] });
  });

  it("keeps the save successful and reports upstream refresh failures", async () => {
    vi.spyOn(accountCommands, "queryBalance").mockRejectedValue(new Error("余额接口超时"));
    vi.spyOn(accountCommands, "syncModels").mockResolvedValue({
      models_synced: 0,
      models: [],
      errors: ["模型接口不可用"],
    });

    const result = await refreshSavedAccounts([account], [preset]);

    expect(result.failures).toEqual([
      expect.objectContaining({ accountId: account.id, kind: "balance", message: "余额接口超时" }),
      expect.objectContaining({ accountId: account.id, kind: "models", message: "模型接口不可用" }),
    ]);
  });
});
