import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Toast } from "@douyinfe/semi-ui-19";
import { accountCommands } from "../../domains/account/commands";
import { mergeDefaultRoutes, modelCommands } from "../../domains/model/commands";
import { queryKeys } from "../../shared/query-keys";
import type { AccountBalanceSnapshot, ChannelAccount } from "../../domains/account/types";
import type { ChannelPreset } from "../../domains/channel/types";
import { useAppPreferences } from "../../app/preferences/AppPreferences";

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
      const saved = await accountCommands.saveAll(accounts);
      const refresh = await refreshSavedAccounts(saved, presets);
      return { saved, ...refresh };
    },
    onSuccess: ({ saved, balanceRequested, modelsRequested, routesUpdated, failures }) => {
      qc.setQueryData(queryKeys.account.list(), saved);
      void refetchAccounts();
      if (balanceRequested) {
        void qc.refetchQueries({ queryKey: queryKeys.usage.latestBalanceSnapshots(), exact: true });
      }
      if (modelsRequested) {
        void qc.refetchQueries({ queryKey: queryKeys.model.channelModels(), exact: true });
      }
      if (routesUpdated) {
        void qc.refetchQueries({ queryKey: queryKeys.model.candidates(), exact: true });
      }
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

  const syncModels = useMutation({
    mutationFn: (accountId: string) => accountCommands.syncModels(accountId),
    onSuccess: () => {
      void qc.refetchQueries({ queryKey: queryKeys.model.channelModels(), exact: true });
    },
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

  return { saveAll, testConnection, syncModels, queryBalance, saveBalanceSnapshot };
}

type AutoRefreshOperation = {
  accountId: string;
  accountName: string;
  kind: "balance" | "models";
  run: () => Promise<void>;
};

type AutoRefreshFailureKind = AutoRefreshOperation["kind"] | "routes";
export type AccountAutoRefreshResult = {
  balanceRequested: boolean;
  modelsRequested: boolean;
  routesUpdated: boolean;
  failures: Array<{ accountId: string; accountName: string; kind: AutoRefreshFailureKind; message: string }>;
};

/**
 * Keep post-save network work outside the Rust persistence command: saving is
 * authoritative even when an upstream balance/model endpoint is temporarily
 * unavailable. Every eligible account is refreshed in parallel, matching the
 * legacy save flow while also restoring the missing model synchronization.
 */
export async function refreshSavedAccounts(
  accounts: ChannelAccount[],
  presets: ChannelPreset[],
): Promise<AccountAutoRefreshResult> {
  const presetById = new Map(presets.map((preset) => [preset.id, preset]));
  const operations: AutoRefreshOperation[] = [];

  for (const account of accounts) {
    if (!account.enabled || !account.api_key.trim()) continue;
    const preset = presetById.get(account.channel_id);
    if (!preset) continue;

    const usesCustomOpenAiEndpoint = Boolean(account.base_url_override?.trim());

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
    if (preset.supports_model_list && !usesCustomOpenAiEndpoint) {
      operations.push({
        accountId: account.id,
        accountName: account.name,
        kind: "models",
        run: async () => {
          const result = await accountCommands.syncModels(account.id);
          if (result.errors.length > 0) throw new Error(result.errors[0]);
        },
      });
    }
  }

  const settled = await Promise.allSettled(operations.map((operation) => operation.run()));
  const failures: AccountAutoRefreshResult["failures"] = settled.flatMap((result, index) => result.status === "rejected" ? [{
    accountId: operations[index].accountId,
    accountName: operations[index].accountName,
    kind: operations[index].kind,
    message: result.reason instanceof Error ? result.reason.message : String(result.reason),
  }] : []);
  const routeAccount = accounts.find((account) => {
    const preset = presetById.get(account.channel_id);
    return account.enabled && Boolean(account.api_key.trim()) && preset?.supports_model_list === true;
  });
  let routesUpdated = false;

  if (routeAccount) {
    try {
      const existingRoutes = await modelCommands.listRouteCandidates();
      const nextRoutes = mergeDefaultRoutes(existingRoutes, accounts, presets);
      if (nextRoutes.length !== existingRoutes.length) {
        await modelCommands.saveRouteCandidates(nextRoutes);
        routesUpdated = true;
      }
    } catch (error) {
      failures.push({
        accountId: routeAccount.id,
        accountName: routeAccount.name,
        kind: "routes",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    balanceRequested: operations.some((operation) => operation.kind === "balance"),
    modelsRequested: operations.some((operation) => operation.kind === "models"),
    routesUpdated,
    failures,
  };
}
