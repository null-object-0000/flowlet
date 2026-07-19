import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { backgroundTaskCommands } from "../../domains/background-task/commands";
import type { BackgroundJobsFilter } from "../../domains/background-task/types";
import { queryKeys } from "../../shared/query-keys";
import { AGENT_SYNC_SCHEDULE_EVENT, getNextAgentSyncAt } from "./AgentDataAutoSync";

export function useBackgroundTasks(filter: BackgroundJobsFilter) { return useQuery({ queryKey: queryKeys.backgroundTask.list(filter), queryFn: () => backgroundTaskCommands.list(filter), refetchInterval: 10_000 }); }
export function useAgentSyncStatus() { return useQuery({ queryKey: queryKeys.backgroundTask.agentSyncStatus(), queryFn: backgroundTaskCommands.agentSyncStatus, refetchInterval: 15_000 }); }
export function useAgentSyncSchedule() {
  const [nextAt, setNextAt] = useState<number | null>(getNextAgentSyncAt);
  useEffect(() => {
    const update = (event: Event) => setNextAt((event as CustomEvent<number | null>).detail);
    window.addEventListener(AGENT_SYNC_SCHEDULE_EVENT, update);
    return () => window.removeEventListener(AGENT_SYNC_SCHEDULE_EVENT, update);
  }, []);
  return nextAt;
}
export function useBackgroundTaskDetail(jobId: string | null) { return useQuery({ queryKey: queryKeys.backgroundTask.detail(jobId ?? ""), queryFn: () => backgroundTaskCommands.detail(jobId!), enabled: Boolean(jobId), refetchInterval: (query) => query.state.data?.job.status === "running" ? 2_000 : false }); }
export function useAgentDataSync() {
  const client = useQueryClient();
  return useMutation({ mutationFn: ({ force, triggerSource }: { force: boolean; triggerSource: string }) => backgroundTaskCommands.syncAgentData(force, triggerSource), onSuccess: async () => { await Promise.all([client.invalidateQueries({ queryKey: queryKeys.agentSession.all }), client.invalidateQueries({ queryKey: queryKeys.backgroundTask.all })]); } });
}
export function useCancelBackgroundTask() { const client = useQueryClient(); return useMutation({ mutationFn: backgroundTaskCommands.cancel, onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.backgroundTask.all }) }); }
export function useCleanupBackgroundTasks() { const client = useQueryClient(); return useMutation({ mutationFn: backgroundTaskCommands.cleanup, onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.backgroundTask.all }) }); }
