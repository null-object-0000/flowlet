import { useQuery } from "@tanstack/react-query";
import { accountCommands } from "../../domains/account/commands";
import { queryKeys } from "../../shared/query-keys";

export function useLatestBalanceSnapshots(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.usage.latestBalanceSnapshots(),
    queryFn: () => accountCommands.latestBalanceSnapshots(),
    enabled,
    networkMode: "always",
    refetchOnWindowFocus: false,
    retry: false,
  });
}
