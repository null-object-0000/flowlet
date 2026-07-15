import { useMutation, useQueryClient } from "@tanstack/react-query";
import { accountCommands } from "../../domains/account/commands";
import { queryKeys } from "../../shared/query-keys";
import type { ChannelAccount } from "../../domains/account/types";

/**
 * Account mutations. All writes return void; on success we refetch the
 * account list so the normalized (credential-reset) result from Rust becomes
 * the source of truth. We never optimistically replace api_key locally
 * (the full key never flows back into list rows anyway).
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
  });

  return { saveAll, testConnection, syncModels, queryBalance };
}
