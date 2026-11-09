import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { authorizeAntigravityAccount, deleteAntigravityAccount, queryAntigravityAccounts, type AntigravityAccountsReport } from "../../domains/agent/antigravity";
import { queryKeys } from "../../shared/query-keys";

/** Observation does not depend on having proxy accounts or exposed models. */
export function useAntigravityAccounts() {
  return useQuery({
    queryKey: queryKeys.agent.antigravityAccounts(),
    queryFn: queryAntigravityAccounts,
    networkMode: "always",
    staleTime: 60_000,
    refetchInterval: 120_000,
    retry: false,
  });
}

export function useAntigravityAccountActions() {
  const client = useQueryClient();
  const key = queryKeys.agent.antigravityAccounts();
  const authorize = useMutation({
    mutationFn: authorizeAntigravityAccount,
    onSuccess: async (report) => {
      await client.cancelQueries({ queryKey: key });
      client.setQueryData<AntigravityAccountsReport>(key, (old) => ({
        accounts: [...(old?.accounts ?? []).filter((a) => a.account_id !== report.account_id
          && a.email?.toLowerCase() !== report.email?.toLowerCase()), report],
      }));
    },
  });
  const remove = useMutation({
    mutationFn: deleteAntigravityAccount,
    onSuccess: async (_, accountId) => {
      await client.cancelQueries({ queryKey: key });
      client.setQueryData<AntigravityAccountsReport>(key, (old) => ({
        accounts: (old?.accounts ?? []).filter((a) => a.account_id !== accountId),
      }));
    },
  });
  return { authorize, remove };
}
