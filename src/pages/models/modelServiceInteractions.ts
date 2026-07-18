import type { RouteCandidate } from "../../domains/model/types";
import { buildModelRouteGroups, type ModelServiceItem } from "./modelServiceView";

export type ModelStatusFilter = "all" | "enabled" | "disabled";

export function filterModelServiceItems(
  models: ModelServiceItem[],
  search: string,
  status: ModelStatusFilter,
  channelId: string,
): ModelServiceItem[] {
  const keyword = search.trim().toLowerCase();
  return models.filter((model) => {
    const statusMatches = status === "all" || (status === "enabled" ? model.enabled : !model.enabled);
    const channelMatches = channelId === "all"
      || model.routes.some((route) => route.channel_id === channelId);
    const searchMatches = !keyword
      || model.publicModel.toLowerCase().includes(keyword)
      || model.routes.some((route) => route.upstream_model.toLowerCase().includes(keyword));
    return statusMatches && channelMatches && searchMatches;
  });
}

export function reorderModelRouteGroups(
  routes: RouteCandidate[],
  modelId: string,
  sourceKey: string,
  targetKey: string,
  updatedAt: string,
): RouteCandidate[] {
  const groups = buildModelRouteGroups(
    routes.filter((route) => route.virtual_model_id === modelId),
  );
  const sourceIndex = groups.findIndex((group) => group.key === sourceKey);
  const targetIndex = groups.findIndex((group) => group.key === targetKey);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return routes;

  const ordered = [...groups];
  const [moved] = ordered.splice(sourceIndex, 1);
  ordered.splice(targetIndex, 0, moved);

  const priorityByRouteId = new Map<string, number>();
  ordered.forEach((group, priority) => {
    group.routeIds.forEach((routeId) => priorityByRouteId.set(routeId, priority));
  });

  return routes.map((route) => {
    const priority = priorityByRouteId.get(route.id);
    return priority == null ? route : { ...route, priority, updated_at: updatedAt };
  });
}
