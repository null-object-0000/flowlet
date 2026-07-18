import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Toast } from "@douyinfe/semi-ui-19";
import { modelCommands } from "../../domains/model/commands";
import type { RouteCandidate } from "../../domains/model/types";
import { queryKeys } from "../../shared/query-keys";
import { useAppPreferences } from "../../app/preferences/AppPreferences";

type ToggleInput = {
  routes: RouteCandidate[];
  routeIds: string[];
  modelId: string;
  enabled: boolean;
};

type ReorderInput = {
  routes: RouteCandidate[];
  nextRoutes: RouteCandidate[];
  modelId: string;
};

export function useModelActions() {
  const { t } = useAppPreferences();
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
      Toast.success(t(input.enabled ? "{model} 已开放" : "{model} 已停用", { model: input.modelId }));
    },
    onError: (error, _input, context) => {
      if (context?.previous) queryClient.setQueryData(queryKeys.model.candidates(), context.previous);
      Toast.error(t("模型状态保存失败：{message}", { message: error instanceof Error ? error.message : String(error) }));
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.model.candidates(), exact: true });
    },
  });

  const reorderRoutes = useMutation({
    mutationFn: async ({ nextRoutes }: ReorderInput) => {
      await modelCommands.saveRouteCandidates(nextRoutes);
      return nextRoutes;
    },
    onMutate: async ({ routes, nextRoutes }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.model.candidates(), exact: true });
      const previous = queryClient.getQueryData<RouteCandidate[]>(queryKeys.model.candidates()) ?? routes;
      queryClient.setQueryData<RouteCandidate[]>(queryKeys.model.candidates(), nextRoutes);
      return { previous };
    },
    onSuccess: (nextRoutes) => {
      queryClient.setQueryData(queryKeys.model.candidates(), nextRoutes);
      Toast.success(t("路由优先级已更新"));
    },
    onError: (error, _input, context) => {
      if (context?.previous) queryClient.setQueryData(queryKeys.model.candidates(), context.previous);
      Toast.error(t("路由优先级保存失败：{message}", { message: error instanceof Error ? error.message : String(error) }));
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.model.candidates(), exact: true });
    },
  });

  return { toggleExposedModel, reorderRoutes };
}
