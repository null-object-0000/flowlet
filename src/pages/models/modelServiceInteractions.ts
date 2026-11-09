import type { RouteCandidate } from "../../domains/model/types";
import type { ChannelPreset } from "../../domains/channel/types";
import {
  buildModelRouteGroups,
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

/** 删除指定模型下的一组路由候选（同一渠道/账号/上游模型的所有协议），
 *  并把剩余候选的优先级压缩为连续值，避免出现优先级空洞。 */
export function removeModelRouteGroup(
  routes: RouteCandidate[],
  modelId: string,
  routeIds: string[],
): RouteCandidate[] {
  const ids = new Set(routeIds);
  const remaining = routes.filter((route) => !(
    route.virtual_model_id === modelId && ids.has(route.id)
  ));
  if (remaining.length === routes.length) return routes;
  const groups = buildModelRouteGroups(
    remaining.filter((route) => route.virtual_model_id === modelId),
  );
  const priorityById = new Map<string, number>();
  groups.forEach((group, priority) => group.routeIds.forEach((id) => priorityById.set(id, priority)));
  return remaining.map((route) => {
    const priority = priorityById.get(route.id);
    return priority == null ? route : { ...route, priority };
  });
}
