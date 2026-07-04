import { AccountBalanceSnapshot, ChannelAccount, createAccount, genId } from "../../domain";
import { runCommand } from "../../services/flowletApi";
import { ensureDefaultExposedRoutes } from "../routeHelpers";
import { ActionContext } from "./types";

export function createChannelActions({ data, setMessage }: ActionContext) {
  const { channels, accounts, setAccounts, routes, setRoutes, balanceSnapshots, refreshAll } = data;

  async function saveChannels() {
    await runCommand("save_channel_presets", { presets: channels });
    setMessage("渠道模板已保存");
  }

  async function saveAccounts() {
    const filtered = accounts.filter((a) => a.name.trim() && a.channel_id.trim());
    await runCommand("save_channel_accounts", { accounts: filtered });
    setAccounts(filtered);
    setMessage("渠道账号已保存");

    const nextRoutes = ensureDefaultExposedRoutes(channels, filtered, routes);
    if (nextRoutes.length !== routes.length) {
      setRoutes(nextRoutes);
      await runCommand("save_route_candidates", { routes: nextRoutes });
      setMessage("渠道账号已保存，并已自动开放默认模型");
    }
  }

  async function quickSetup(channelId: string, apiKey: string) {
    if (!apiKey.trim()) {
      setMessage("请先填写 API Key");
      return;
    }
    const channel = channels.find((c) => c.id === channelId);
    if (!channel) {
      setMessage("请选择有效渠道");
      return;
    }
    const existing = accounts.filter((account) => account.channel_id === channelId);
    const account: ChannelAccount = {
      ...createAccount(channelId, existing.length),
      name: `${channel.name} 账号`,
      api_key: apiKey.trim(),
      enabled: true,
    };
    const nextAccounts = [...accounts, account];
    const nextRoutes = ensureDefaultExposedRoutes(channels, nextAccounts, routes);

    await runCommand("save_channel_accounts", { accounts: nextAccounts });
    await runCommand("save_route_candidates", { routes: nextRoutes });
    setAccounts(nextAccounts);
    setRoutes(nextRoutes);
    setMessage("渠道账号已保存，默认模型已开放，可以启动代理");
  }

  function addAccount(channelId: string) {
    const existing = accounts.filter((a) => a.channel_id === channelId);
    setAccounts((current) => [...current, createAccount(channelId, existing.length)]);
  }

  async function testConnection(accountId: string) {
    setMessage("正在测试连接...");
    try {
      const result = await runCommand<{
        balance: number | null;
        currency: string | null;
        is_available: boolean;
        error: string | null;
      }>("query_balance", { accountId });
      if (result.error) {
        setMessage(`连接失败: ${result.error}`);
      } else if (result.balance !== null) {
        setMessage(`连接成功！余额: ${result.balance} ${result.currency ?? ""}`);
      } else if (result.is_available) {
        setMessage("连接成功！（无余额信息）");
      } else {
        setMessage("连接失败：请检查 API Key 是否正确");
      }
    } catch (err: unknown) {
      setMessage(`测试失败: ${String(err)}`);
    }
  }

  async function syncModels(accountId: string) {
    setMessage("正在同步模型列表...");
    try {
      const result = await runCommand<{ models_synced: number; errors: string[] }>("sync_models", { accountId });
      if (result.errors.length > 0) {
        setMessage(`同步失败: ${result.errors[0]}`);
      } else {
        setMessage(`同步成功，获取 ${result.models_synced} 个模型`);
      }
    } catch (err: unknown) {
      setMessage(`同步失败: ${String(err)}`);
    }
  }

  function updateAccount(index: number, patch: Partial<ChannelAccount>) {
    setAccounts((current) =>
      current.map((a, i) => (i === index ? { ...a, ...patch, updated_at: new Date().toISOString() } : a))
    );
  }

  function removeAccount(index: number) {
    setAccounts((current) => current.filter((_, i) => i !== index));
  }

  function getChannelName(channelId: string): string {
    return channels.find((c) => c.id === channelId)?.name ?? channelId;
  }

  function getAccountName(accountId: string): string {
    return accounts.find((a) => a.id === accountId)?.name ?? accountId;
  }

  function getBalanceForAccount(accountId: string): AccountBalanceSnapshot | undefined {
    return balanceSnapshots.find((s) => s.account_id === accountId);
  }

  async function addBalanceSnapshot(snapshot: Omit<AccountBalanceSnapshot, "id" | "created_at" | "updated_at">) {
    const now = new Date().toISOString();
    const full: AccountBalanceSnapshot = {
      ...snapshot,
      id: genId("snap"),
      created_at: now,
      updated_at: now,
    };
    await runCommand("save_balance_snapshot", { snapshot: full });
    await refreshAll();
    setMessage("余额快照已保存");
  }

  return {
    saveChannels,
    saveAccounts,
    quickSetup,
    addAccount,
    testConnection,
    syncModels,
    updateAccount,
    removeAccount,
    getChannelName,
    getAccountName,
    getBalanceForAccount,
    addBalanceSnapshot,
  };
}
