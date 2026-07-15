import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Toast } from "@douyinfe/semi-ui-19";
import { modelCommands } from "../../domains/model/commands";
import type { RouteCandidate } from "../../domains/model/types";
import { queryKeys } from "../../shared/query-keys";

type ToggleInput = {
  routes: RouteCandidate[];
  routeIds: string[];
  modelId: string;
  enabled: boolean;
};

export function useModelActions() {
  const queryClient = useQueryClient();

  const toggleExposedModel = useMutation({
    mutationFn: async ({ routes, routeIds, enabled }: ToggleInput) => {
      const routeIdSet = new Set(routeIds);
      const now = new Date().toISOString();
      const next = routes.map((route) => routeIdSet.has(route.id) ? { ...route, enabled, updated_at: now } : route);
      await modelCommands.saveRouteCandidates(next);
      return next;
    },
    onMutate: async ({ routes, routeIds, enabled }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.model.candidates(), exact: true });
      const previous = queryClient.getQueryData<RouteCandidate[]>(queryKeys.model.candidates()) ?? routes;
      const routeIdSet = new Set(routeIds);
      queryClient.setQueryData<RouteCandidate[]>(
        queryKeys.model.candidates(),
        previous.map((route) => routeIdSet.has(route.id) ? { ...route, enabled } : route),
      );
      return { previous };
    },
    onSuccess: (next, input) => {
      queryClient.setQueryData(queryKeys.model.candidates(), next);
      Toast.success(`${input.modelId} 已${input.enabled ? "开放" : "停用"}`);
    },
    onError: (error, _input, context) => {
      if (context?.previous) queryClient.setQueryData(queryKeys.model.candidates(), context.previous);
      Toast.error(`模型状态保存失败：${error instanceof Error ? error.message : String(error)}`);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.model.candidates(), exact: true });
    },
  });

  return { toggleExposedModel };
}
