import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { requestLogCommands } from "../../domains/request-log/commands";
import type { RequestLogFilter } from "../../domains/request-log/types";
import { queryKeys } from "../../shared/query-keys";

export function useRequestLogs(filter: RequestLogFilter, autoRefresh: boolean) {
  return useQuery({
    queryKey: queryKeys.requestLog.list(filter),
    queryFn: () => requestLogCommands.list(filter),
    placeholderData: keepPreviousData,
    refetchInterval: autoRefresh ? 5_000 : false,
  });
}

export function useRequestLogClients() {
  return useQuery({
    queryKey: queryKeys.requestLog.clients(),
    queryFn: () => requestLogCommands.clients(),
    staleTime: 5 * 60_000,
  });
}

export function useRequestLogModels() {
  return useQuery({
    queryKey: queryKeys.requestLog.models(),
    queryFn: () => requestLogCommands.models(),
    staleTime: 5 * 60_000,
  });
}

export function useRequestLogDetail(requestId: string | null) {
  return useQuery({
    queryKey: queryKeys.requestLog.detail(requestId ?? ""),
    queryFn: () => requestLogCommands.detail(requestId!),
    enabled: Boolean(requestId),
  });
}

export function useRequestLogActions() {
  const queryClient = useQueryClient();
  const cleanup = useMutation({
    mutationFn: (keepDays: number) => requestLogCommands.cleanup(keepDays),
    onSuccess: () => Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.requestLog.all }),
      queryClient.invalidateQueries({ queryKey: queryKeys.usage.all }),
      queryClient.invalidateQueries({ queryKey: queryKeys.agentSession.all }),
    ]),
  });
  return { cleanup };
}
