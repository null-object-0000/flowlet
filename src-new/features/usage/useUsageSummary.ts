import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { usageCommands } from "../../domains/usage/commands";
import { queryKeys } from "../../shared/query-keys";

export function useUsageSummary() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.usage.summary(),
    queryFn: usageCommands.summary,
    networkMode: "always",
    refetchOnWindowFocus: false,
    retry: false,
  });
  const analyze = useMutation({
    mutationFn: usageCommands.analyze,
    onSuccess: () => void queryClient.refetchQueries({ queryKey: queryKeys.usage.summary(), exact: true }),
  });
  return { query, analyze };
}
