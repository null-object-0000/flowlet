import { AccountBalanceSnapshot, ChannelAccount, ChannelModel, createAccount, genId } from "../../domain";
import { runCommand, logToRust } from "../../services/flowletApi";
import { ensureDefaultExposedRoutes } from "../routeHelpers";
import { ActionContext } from "./types";

export function createChannelActions({ data, setMessage }: ActionContext) {
  const { channels, accounts, setAccounts, routes, setRoutes, channelModels, balanceSnapshots, refreshAll, exposureMode } = data;

  async function saveAccounts(nextAccounts?: ChannelAccount[]) {
    const sourceAccounts = nextAccounts ?? accounts;
    const filtered = sourceAccounts.filter((a) => a.name.trim() && a.channel_id.trim());
    // 后端返回规范化后的账号列表（API Key 变化时 credential_status 已被重置为 healthy），
    // 以此作为状态真源，保证 SQLite / 共享内存 / React State 一致。
    const saved = await runCommand<ChannelAccount[]>("save_channel_accounts", { accounts: filtered });
    setAccounts(saved);
    setMessage("渠道账号已保存，代理配置已热更新");

    const nextRoutes = ensureDefaultExposedRoutes(channels, saved, routes, channelModels, exposureMode);
    if (JSON.stringify(nextRoutes) !== JSON.stringify(routes)) {
      setRoutes(nextRoutes);
      try {
        await runCommand("save_route_candidates", { routes: nextRoutes });
      } catch (err) {
        const msg = `保存路由候选失败: ${String(err)}`;
        logToRust("error", msg);
        setMessage(msg);
        return;
      }
      setMessage("渠道账号已保存，已自动开放默认模型，代理配置已热更新");
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
      credential_status: "healthy",
    };
    const nextAccounts = [...accounts, account];
    const nextRoutes = ensureDefaultExposedRoutes(channels, nextAccounts, routes, channelModels, exposureMode);

    const saved = await runCommand<ChannelAccount[]>("save_channel_accounts", { accounts: nextAccounts });
    try {
      await runCommand("save_route_candidates", { routes: nextRoutes });
    } catch (err) {
      const msg = `保存路由候选失败: ${String(err)}`;
      logToRust("error", msg);
      setMessage(msg);
      return;
    }
    setAccounts(saved);
    setRoutes(nextRoutes);
    setMessage("渠道账号已保存，Flowlet Pro / Flash 模型池已自动更新");
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
      // 测试连接会修改 credential_status，刷新账号列表以保持前端状态与后端一致。
      await refreshAll();
    } catch (err: unknown) {
      setMessage(`测试失败: ${String(err)}`);
    }
  }

  async function syncModels(accountId: string) {
    setMessage("正在同步模型列表...");
    try {
      const result = await runCommand<{ models_synced: number; errors: string[]; models: ChannelModel[] }>("sync_models", { accountId });
      if (result.errors.length > 0) {
        setMessage(`同步失败: ${result.errors[0]}`);
      } else {
        const account = accounts.find((item) => item.id === accountId);
        const mergedModels = account
          ? [...channelModels.filter((model) => model.channel_id !== account.channel_id), ...result.models]
          : channelModels;
        const nextRoutes = ensureDefaultExposedRoutes(channels, accounts, routes, mergedModels, exposureMode);
        try {
          await runCommand("save_route_candidates", { routes: nextRoutes });
        } catch (err) {
          const msg = `保存路由候选失败: ${String(err)}`;
          logToRust("error", msg);
          setMessage(msg);
          return;
        }
        setRoutes(nextRoutes);
        setMessage(`同步成功，获取 ${result.models_synced} 个模型，Flowlet 模型池已热更新`);
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
