import { afterEach, describe, expect, it, vi } from "vitest";
import { accountCommands } from "../../domains/account/commands";
import { modelCommands } from "../../domains/model/commands";
import type { ChannelAccount } from "../../domains/account/types";
import type { ChannelPreset } from "../../domains/channel/types";
import type { RouteCandidate } from "../../domains/model/types";
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
  exposed_models: ["deepseek-v4-flash", "deepseek-v4-pro"],
  synced_models: ["deepseek-v4-flash", "deepseek-v4-pro"],
} as ChannelAccount;

const preset = {
  id: "deepseek",
  supports_balance_query: true,
  supports_model_list: true,
  supported_protocols: ["openai", "anthropic"],
} as ChannelPreset;

function route(upstream: string, protocol: "openai" | "anthropic"): RouteCandidate {
  return {
    id: `route-${upstream}-${protocol}`,
    virtual_model_id: upstream,
    channel_id: "deepseek",
    account_id: account.id,
    upstream_model: upstream,
    client_protocol: protocol,
    priority: 0,
    enabled: true,
    created_at: "old",
    updated_at: "old",
  };
}

afterEach(() => vi.restoreAllMocks());

describe("refreshSavedAccounts", () => {
  it("refreshes balance and reconciles routes from the user-selected exposed_models", async () => {
    const queryBalance = vi.spyOn(accountCommands, "queryBalance").mockResolvedValue({
      balance: 100,
      currency: "CNY",
      is_available: true,
      error: null,
    });
    const fetchChannelModels = vi.spyOn(accountCommands, "fetchChannelModels");
    const listRoutes = vi.spyOn(modelCommands, "listRouteCandidates").mockResolvedValue([]);
    const saveRoutes = vi.spyOn(modelCommands, "saveRouteCandidates").mockResolvedValue();

    const result = await refreshSavedAccounts([account], [preset]);

    expect(queryBalance).toHaveBeenCalledWith(account.id);
    // 模型列表只在编辑器里由用户手动拉取，保存流程绝不自动拉取。
    expect(fetchChannelModels).not.toHaveBeenCalled();
    expect(listRoutes).toHaveBeenCalledOnce();
    // 按白名单 ∩ /models 结果 ∩ 用户勾选生成路由。
    expect(saveRoutes).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ virtual_model_id: "deepseek-v4-pro", account_id: account.id }),
    ]));
    expect(result).toEqual({ balanceRequested: true, routesUpdated: true, failures: [] });
  });

  it("leaves routes untouched for accounts not configured in the new flow (exposed_models = null)", async () => {
    vi.spyOn(accountCommands, "queryBalance").mockResolvedValue({
      balance: null,
      currency: null,
      is_available: false,
      error: null,
    });
    const listRoutes = vi.spyOn(modelCommands, "listRouteCandidates").mockResolvedValue([]);
    const saveRoutes = vi.spyOn(modelCommands, "saveRouteCandidates").mockResolvedValue();

    const result = await refreshSavedAccounts(
      [{ ...account, exposed_models: null }],
      [preset],
    );

    // 余额刷新与对账无关，仍照常执行；但没有任何已配置账号时不触发路由读写。
    expect(listRoutes).not.toHaveBeenCalled();
    expect(saveRoutes).not.toHaveBeenCalled();
    expect(result).toEqual({ balanceRequested: true, routesUpdated: false, failures: [] });
  });

  it("removes routes for models the user deselected", async () => {
    vi.spyOn(accountCommands, "queryBalance").mockResolvedValue({
      balance: null,
      currency: null,
      is_available: false,
      error: null,
    });
    vi.spyOn(modelCommands, "listRouteCandidates").mockResolvedValue([
      route("deepseek-v4-flash", "openai"),
      route("deepseek-v4-flash", "anthropic"),
      route("deepseek-v4-pro", "openai"),
    ]);
    const saveRoutes = vi.spyOn(modelCommands, "saveRouteCandidates").mockResolvedValue();

    const result = await refreshSavedAccounts(
      [{ ...account, exposed_models: ["deepseek-v4-pro"] }],
      [preset],
    );

    expect(saveRoutes).toHaveBeenCalledOnce();
    const saved = saveRoutes.mock.calls[0][0];
    expect(saved.some((item) => item.upstream_model === "deepseek-v4-flash")).toBe(false);
    expect(saved.some((item) => item.upstream_model === "deepseek-v4-pro" && item.client_protocol === "openai")).toBe(true);
    expect(result.routesUpdated).toBe(true);
  });

  it("skips disabled accounts and unsupported capabilities", async () => {
    const queryBalance = vi.spyOn(accountCommands, "queryBalance").mockResolvedValue({
      balance: null,
      currency: null,
      is_available: false,
      error: null,
    });
    const listRoutes = vi.spyOn(modelCommands, "listRouteCandidates").mockResolvedValue([]);
    const saveRoutes = vi.spyOn(modelCommands, "saveRouteCandidates").mockResolvedValue();

    const result = await refreshSavedAccounts(
      [{ ...account, enabled: false }],
      [{ ...preset, supports_balance_query: false, supports_model_list: false }],
    );

    expect(queryBalance).not.toHaveBeenCalled();
    // 已配置（exposed_models 非 null）但停用的账号仍要对账：停用后路由应被清空。
    expect(listRoutes).toHaveBeenCalledOnce();
    expect(saveRoutes).not.toHaveBeenCalled(); // 本来就没有路由，无差异不落库
    expect(result).toEqual({ balanceRequested: false, routesUpdated: false, failures: [] });
  });

  it("keeps the save successful and reports upstream refresh failures", async () => {
    vi.spyOn(accountCommands, "queryBalance").mockRejectedValue(new Error("余额接口超时"));
    vi.spyOn(modelCommands, "listRouteCandidates").mockResolvedValue([]);
    vi.spyOn(modelCommands, "saveRouteCandidates").mockResolvedValue();

    const result = await refreshSavedAccounts([account], [preset]);

    expect(result.failures).toEqual([
      expect.objectContaining({ accountId: account.id, kind: "balance", message: "余额接口超时" }),
    ]);
    expect(result.routesUpdated).toBe(true);
  });
});
