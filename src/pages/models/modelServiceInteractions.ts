import type { RouteCandidate } from "../../domains/model/types";
import type { ChannelPreset } from "../../domains/channel/types";
import {
  buildModelRouteGroups,
  type ModelRouteGroup,
  type ModelServiceItem,
} from "./modelServiceView";

export function filterModelServiceItems(
  models: ModelServiceItem[],
  search: string,
  channelId: string,
): ModelServiceItem[] {
  const keyword = search.trim().toLowerCase();
  return models.filter((model) => {
    const channelMatches = channelId === "all"
      || model.routes.some((route) => route.channel_id === channelId);
    const searchMatches = !keyword
      || model.publicModel.toLowerCase().includes(keyword)
      || model.routes.some((route) => route.upstream_model.toLowerCase().includes(keyword));
    return channelMatches && searchMatches;
  });
}

/** 渠道下拉筛选器选项：只展示已有路由（即有账号且配置了 API Key）的渠道。
 *  避免 config.json 里新增但用户还没配账号的渠道提前出现在下拉列表里。
 *  返回 Semi Select optionList 需要的 { value, label } 结构。 */
export function buildChannelFilterOptions(
  models: ModelServiceItem[],
  channels: ChannelPreset[] = [],
): Array<{ value: string; label: string }> {
  const channelNames = new Map(channels.map((channel) => [channel.id, channel.name]));
  const channelIdToName = new Map<string, string>();
  for (const model of models) {
    for (const route of model.routes) {
      if (!channelIdToName.has(route.channel_id)) {
        channelIdToName.set(route.channel_id, channelNames.get(route.channel_id) ?? route.channel_id);
      }
    }
  }
  return [...channelIdToName.entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
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

export type AggregateRouteOption = {
  key: string;
  channelId: string;
  accountId: string;
  upstreamModel: string;
  routeIds: string[];
};

function aggregateRouteOptionKey(group: ModelRouteGroup): string {
  return JSON.stringify([group.channelId, group.accountId, group.upstreamModel]);
}

/** Existing direct channel-model groups that can be explicitly attached to an aggregate. */
export function buildAggregateRouteOptions(
  routes: RouteCandidate[],
  aggregateModelId: string,
): AggregateRouteOption[] {
  const attached = new Set(
    buildModelRouteGroups(routes.filter((route) => route.virtual_model_id === aggregateModelId))
      .map(aggregateRouteOptionKey),
  );
  return buildModelRouteGroups(routes.filter((route) => (
    route.virtual_model_id !== "flowlet-pro"
    && route.virtual_model_id !== "flowlet-flash"
  )))
    .filter((group) => !attached.has(aggregateRouteOptionKey(group)))
    .map((group) => ({
      key: aggregateRouteOptionKey(group),
      channelId: group.channelId,
      accountId: group.accountId,
      upstreamModel: group.upstreamModel,
      routeIds: group.routeIds,
    }));
}

export function addAggregateRouteGroup(
  routes: RouteCandidate[],
  aggregateModelId: string,
  sourceKey: string,
  updatedAt: string,
  createId: () => string,
): RouteCandidate[] {
  const source = buildModelRouteGroups(routes.filter((route) => (
    route.virtual_model_id !== "flowlet-pro"
    && route.virtual_model_id !== "flowlet-flash"
  ))).find((group) => aggregateRouteOptionKey(group) === sourceKey);
  if (!source) return routes;

  const alreadyAttached = buildModelRouteGroups(
    routes.filter((route) => route.virtual_model_id === aggregateModelId),
  ).some((group) => aggregateRouteOptionKey(group) === sourceKey);
  if (alreadyAttached) return routes;

  const aggregateGroups = buildModelRouteGroups(
    routes.filter((route) => route.virtual_model_id === aggregateModelId),
  );
  const priority = aggregateGroups.length;
  const additions = source.routes.map((route) => ({
    ...route,
    id: createId(),
    virtual_model_id: aggregateModelId,
    priority,
    enabled: true,
    created_at: updatedAt,
    updated_at: updatedAt,
  }));
  return [...routes, ...additions];
}

export function removeAggregateRouteGroup(
  routes: RouteCandidate[],
  aggregateModelId: string,
  routeIds: string[],
): RouteCandidate[] {
  const ids = new Set(routeIds);
  const remaining = routes.filter((route) => !(
    route.virtual_model_id === aggregateModelId && ids.has(route.id)
  ));
  const groups = buildModelRouteGroups(
    remaining.filter((route) => route.virtual_model_id === aggregateModelId),
  );
  const priorityById = new Map<string, number>();
  groups.forEach((group, priority) => group.routeIds.forEach((id) => priorityById.set(id, priority)));
  return remaining.map((route) => {
    const priority = priorityById.get(route.id);
    return priority == null ? route : { ...route, priority };
  });
}
