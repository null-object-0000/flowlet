import { useQuery } from "@tanstack/react-query";
import { usageCommands } from "../../domains/usage/commands";
import { queryKeys } from "../../shared/query-keys";

export function useUsageSummary(autoRefresh: boolean) {
  const query = useQuery({
    queryKey: queryKeys.usage.summary(),
    queryFn: usageCommands.summary,
    networkMode: "always",
    refetchOnWindowFocus: false,
    retry: false,
    refetchInterval: autoRefresh ? 30_000 : false,
  });
  return { query };
}
