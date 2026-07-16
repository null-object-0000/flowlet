import { useQuery } from "@tanstack/react-query";
import { accountCommands } from "../../domains/account/commands";
import { queryKeys } from "../../shared/query-keys";

export function useAccounts() {
  return useQuery({
    queryKey: queryKeys.account.list(),
    queryFn: () => accountCommands.list(),
    networkMode: "always",
    refetchOnWindowFocus: false,
    retry: false,
  });
}
