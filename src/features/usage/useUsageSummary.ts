import { useQuery } from "@tanstack/react-query";
import { usageCommands } from "../../domains/usage/commands";
import type { UsagePeriod } from "../../domains/usage/types";
import { queryKeys } from "../../shared/query-keys";

export function useUsageSummary(period: UsagePeriod, autoRefresh: boolean) {
  const query = useQuery({
    queryKey: queryKeys.usage.summary(period),
    queryFn: () => usageCommands.summary(period),
    networkMode: "always",
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: 15_000,
    refetchInterval: autoRefresh ? 30_000 : false,
  });
  return { query };
}

export function useAgentNativeUsageSummary(autoRefresh: boolean, enabled = true) {
  return useQuery({
    queryKey: queryKeys.usage.nativeSummary(),
    queryFn: usageCommands.nativeSummary,
    enabled,
    networkMode: "always",
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: 15_000,
    refetchInterval: autoRefresh ? 30_000 : false,
  });
}
