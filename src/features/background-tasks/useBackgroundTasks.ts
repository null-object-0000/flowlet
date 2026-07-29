import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { backgroundTaskCommands } from "../../domains/background-task/commands";
import type { BackgroundJobsFilter } from "../../domains/background-task/types";
import { queryKeys } from "../../shared/query-keys";
import { AGENT_SYNC_SCHEDULE_EVENT, getNextAgentSyncAt } from "./AgentDataAutoSync";

export function useBackgroundTasks(filter: BackgroundJobsFilter, autoRefresh: boolean) { return useQuery({ queryKey: queryKeys.backgroundTask.list(filter), queryFn: () => backgroundTaskCommands.list(filter), refetchInterval: autoRefresh ? 10_000 : false }); }
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
  return useMutation({ mutationFn: ({ force, triggerSource }: { force: boolean; triggerSource: string }) => backgroundTaskCommands.syncAgentData(force, triggerSource), onSuccess: async () => { await Promise.all([client.invalidateQueries({ queryKey: queryKeys.agentSession.all }), client.invalidateQueries({ queryKey: queryKeys.usage.nativeSummary() }), client.invalidateQueries({ queryKey: queryKeys.backgroundTask.all })]); } });
}
export function useCancelBackgroundTask() { const client = useQueryClient(); return useMutation({ mutationFn: backgroundTaskCommands.cancel, onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.backgroundTask.all }) }); }
export function useCleanupBackgroundTasks() { const client = useQueryClient(); return useMutation({ mutationFn: backgroundTaskCommands.cleanup, onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.backgroundTask.all }) }); }
/**
 * 手动触发模型目录同步（models-cn 国内官方价 + models.dev 国际官方价，双源并发）。
 * 两个源相互独立：单个源失败不影响另一个，全部失败才算 mutation 失败。
 * 结束后刷新 model-catalog 缓存：既让 ModelServicesPage 的目录内容重拉，
 * 也让 useModelPriceCurrencies 的币种映射（共用同一 queryKey）一并更新，
 * 避免"同步完成后前端仍以为本地无数据、需要重启"的问题。
 */
export function useModelCatalogsSync() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (params: { modelsCnUrl: string; modelsDevUrl: string; triggerSource: string }) => {
      const [cn, dev] = await Promise.allSettled([
        backgroundTaskCommands.syncModelsCnCatalog(params.modelsCnUrl, params.triggerSource),
        backgroundTaskCommands.syncModelsDevCatalog(params.modelsDevUrl, params.triggerSource),
      ]);
      if (cn.status === "rejected" && dev.status === "rejected") {
        throw cn.reason ?? dev.reason;
      }
      return {
        modelsCn: cn.status === "fulfilled" ? cn.value : null,
        modelsDev: dev.status === "fulfilled" ? dev.value : null,
        failedSource: cn.status === "rejected" ? "models-cn" : dev.status === "rejected" ? "models.dev" : null,
      };
    },
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.modelCatalog.all }),
  });
}
