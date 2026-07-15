import { useMutation, useQueryClient } from "@tanstack/react-query";
import { accountCommands } from "../../domains/account/commands";
import { queryKeys } from "../../shared/query-keys";
import type { AccountBalanceSnapshot, ChannelAccount } from "../../domains/account/types";

/**
 * Account mutations. All writes return void; on success we refetch the
 * account list so the normalized (credential-reset) result from Rust becomes
 * the source of truth. API keys may only be rendered inside the account editor;
 * overview and management list rows never display them.
 */
export function useAccountActions() {
  const qc = useQueryClient();

  const refetchAccounts = () =>
    qc.refetchQueries({ queryKey: queryKeys.account.list(), exact: true });

  const saveAll = useMutation({
    mutationFn: (accounts: ChannelAccount[]) => accountCommands.saveAll(accounts),
    onSuccess: () => {
      void refetchAccounts();
    },
  });

  const testConnection = useMutation({
    mutationFn: (input: { channel_id: string; api_key: string; base_url_override?: string | null }) =>
      accountCommands.testConnection(input),
  });

  const syncModels = useMutation({
    mutationFn: (accountId: string) => accountCommands.syncModels(accountId),
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
