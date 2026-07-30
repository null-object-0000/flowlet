import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Toast } from "@douyinfe/semi-ui-19";
import { accountCommands } from "../../domains/account/commands";
import { modelCommands, reconcileAccountRoutes, routesDiffer } from "../../domains/model/commands";
import { isQwenTokenPlanAccount } from "../../domains/channel/types";
import { queryKeys } from "../../shared/query-keys";
import type { AccountBalanceSnapshot, ChannelAccount } from "../../domains/account/types";
import type { ChannelPreset } from "../../domains/channel/types";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import { errorMessage } from "../../shared/errors/AppError";

/**
 * Account mutations. After writes, refresh only the affected queries and use
 * the normalized (credential-reset) account list returned by Rust as
 * the source of truth. API keys may only be rendered inside the account editor;
 * overview and management list rows never display them.
 */
export function useAccountActions(presets: ChannelPreset[]) {
  const { t } = useAppPreferences();
  const qc = useQueryClient();

  const refetchAccounts = () =>
    qc.refetchQueries({ queryKey: queryKeys.account.list(), exact: true });

  const saveAll = useMutation({
    mutationFn: async (accounts: ChannelAccount[]) => {
      const previous = qc.getQueryData<ChannelAccount[]>(queryKeys.account.list()) ?? [];
      const refreshAccountIds = changedAccountIds(previous, accounts);
      const saved = await accountCommands.saveAll(accounts);
      const refresh = await refreshSavedAccounts(saved, presets, refreshAccountIds);
      return { saved, ...refresh };
    },
    onSuccess: ({ saved, balanceRequested, routesUpdated, failures }) => {
      qc.setQueryData(queryKeys.account.list(), saved);
      void refetchAccounts();
      if (balanceRequested) {
        void qc.refetchQueries({ queryKey: queryKeys.usage.latestBalanceSnapshots(), exact: true });
      }
      if (routesUpdated) {
        void qc.refetchQueries({ queryKey: queryKeys.model.candidates(), exact: true });
      }
      // 请求日志/用量里的账号名是请求时刻的快照，展示与搜索由 Rust 查询连表
      // channel_accounts 解析当前名。改名保存后失效相关查询，使打开中的日志/
      // 用量页立即按新名重新连表展示。
      void qc.invalidateQueries({ queryKey: queryKeys.requestLog.all });
      void qc.invalidateQueries({ queryKey: queryKeys.usage.all });
      if (failures.length > 0) {
        Toast.warning(t("账号已保存，但自动更新失败：{message}", {
          message: failures.map((failure) => `${failure.accountName}: ${failure.message}`).join("；"),
        }));
      }
    },
  });

  const testConnection = useMutation({
    mutationFn: (input: { channel_id: string; api_key: string; base_url_override?: string | null }) =>
      accountCommands.testConnection(input),
  });

  const queryBalance = useMutation({
    mutationFn: (accountId: string) => accountCommands.queryBalance(accountId),
    onSuccess: () => {
      void qc.refetchQueries({ queryKey: queryKeys.usage.latestBalanceSnapshots(), exact: true });
    },
  });

  const saveBalanceSnapshot = useMutation({
    mutationFn: (snapshot: AccountBalanceSnapshot) => accountCommands.saveBalanceSnapshot(snapshot),
    onSuccess: () => {
      void qc.refetchQueries({ queryKey: queryKeys.usage.latestBalanceSnapshots(), exact: true });
    },
  });

  const scrapeBalance = useMutation({
    mutationFn: (accountId: string) => accountCommands.scrapeBalance(accountId),
    onSuccess: () => {
      void qc.refetchQueries({ queryKey: queryKeys.usage.latestBalanceSnapshots(), exact: true });
    },
  });

  return { saveAll, testConnection, queryBalance, saveBalanceSnapshot, scrapeBalance };
}

type AutoRefreshOperation = {
  accountId: string;
  accountName: string;
  kind: "balance";
  run: () => Promise<void>;
};

type AutoRefreshFailureKind = AutoRefreshOperation["kind"] | "routes";
export type AccountAutoRefreshResult = {
  balanceRequested: boolean;
  routesUpdated: boolean;
  failures: Array<{ accountId: string; accountName: string; kind: AutoRefreshFailureKind; message: string }>;
};

/**
 * Keep post-save network work outside the Rust persistence command: saving is
 * authoritative even when an upstream balance endpoint is temporarily
 * unavailable. Model exposure is NOT synced here — the user pulls /models and
 * selects exposed models explicitly in the account editor; on save we only
 * reconcile routes against each account's selected `exposed_models`.
 */
export async function refreshSavedAccounts(
  accounts: ChannelAccount[],
  presets: ChannelPreset[],
  refreshAccountIds?: ReadonlySet<string>,
): Promise<AccountAutoRefreshResult> {
  const presetById = new Map(presets.map((preset) => [preset.id, preset]));
  const operations: AutoRefreshOperation[] = [];

  for (const account of accounts) {
    if (refreshAccountIds && !refreshAccountIds.has(account.id)) continue;
    if (!account.enabled || !account.api_key.trim()) continue;
    const preset = presetById.get(account.channel_id);
    if (!preset) continue;

    // 千问 Token Plan 账号的 Base URL 覆盖是套餐专属端点（非用户自定义），应参与余额查询；
    // 其余用户自定义 OpenAI 端点账号跳过（无法保证余额接口语义一致）。
    const usesCustomOpenAiEndpoint =
      Boolean(account.base_url_override?.trim()) && !isQwenTokenPlanAccount(account);

    if (preset.supports_balance_query && !usesCustomOpenAiEndpoint) {
      operations.push({
        accountId: account.id,
        accountName: account.name,
        kind: "balance",
        run: async () => {
          const result = await accountCommands.queryBalance(account.id);
          if (result.error) throw new Error(result.error);
        },
      });
    }
  }

  const settled = await Promise.allSettled(operations.map((operation) => operation.run()));
  const failures: AccountAutoRefreshResult["failures"] = settled.flatMap((result, index) => result.status === "rejected" ? [{
    accountId: operations[index].accountId,
    accountName: operations[index].accountName,
    kind: operations[index].kind,
    message: errorMessage(result.reason),
  }] : []);

  // 路由对账：exposed_models 为 null 的账号（尚未用新流程配置）路由保持原样；
  // 已配置的账号按其勾选列表增删路由（保留已有启停/优先级）。
  const configured = accounts.filter((account) => account.exposed_models != null);
  let routesUpdated = false;

  if (configured.length > 0) {
    const anchor = configured[0];
    try {
      const existingRoutes = await modelCommands.listRouteCandidates();
      const nextRoutes = reconcileAccountRoutes(existingRoutes, accounts, presets);
      if (routesDiffer(existingRoutes, nextRoutes)) {
        await modelCommands.saveRouteCandidates(nextRoutes);
        routesUpdated = true;
      }
    } catch (error) {
      failures.push({
        accountId: anchor.id,
        accountName: anchor.name,
        kind: "routes",
        message: errorMessage(error),
      });
    }
  }

  return {
    balanceRequested: operations.length > 0,
    routesUpdated,
    failures,
  };
}

function changedAccountIds(
  previous: ChannelAccount[],
  next: ChannelAccount[],
): ReadonlySet<string> {
  const previousById = new Map(previous.map((account) => [account.id, account]));
  return new Set(next.filter((account) => {
    const existing = previousById.get(account.id);
    return !existing || JSON.stringify(existing) !== JSON.stringify(account);
  }).map((account) => account.id));
}
