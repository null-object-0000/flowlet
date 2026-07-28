import type { RouteCandidate } from "../../domains/model/types";
import type { ChannelPreset } from "../../domains/channel/types";
import { buildModelRouteGroups, type ModelAggregateRelation, type ModelServiceItem } from "./modelServiceView";

export type ModelStatusFilter = "all" | "available" | "enabled" | "not-routed";

/** 「未加入路由」= 渠道模型(直接模型)未被任何聚合模型引用。
 *  聚合模型本身是路由容器,不参与该筛选。 */
export function filterModelServiceItems(
  models: ModelServiceItem[],
  search: string,
  status: ModelStatusFilter,
  channelId: string,
  relations: Map<string, ModelAggregateRelation[]> = new Map(),
): ModelServiceItem[] {
  const keyword = search.trim().toLowerCase();
  return models.filter((model) => {
    const statusMatches = status === "all"
      || (status === "available" ? model.available
        : status === "enabled" ? model.enabled
        : model.kind === "direct" && (relations.get(model.publicModel.toLowerCase()) ?? []).length === 0);
    const channelMatches = channelId === "all"
      || model.routes.some((route) => route.channel_id === channelId);
    const searchMatches = !keyword
      || model.publicModel.toLowerCase().includes(keyword)
      || model.routes.some((route) => route.upstream_model.toLowerCase().includes(keyword));
    return statusMatches && channelMatches && searchMatches;
  });
}

/** 渠道下拉筛选器选项：只展示已有路由（即有账号且配置了 API Key）的渠道。
 *  避免 config.json 里新增但用户还没配账号的渠道提前出现在下拉列表里。 */
export function buildChannelFilterOptions(
  models: ModelServiceItem[],
  channels: ChannelPreset[] = [],
): Array<{ id: string; name: string }> {
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
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
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
