import type { ChannelAccount } from "../../domains/account/types";
import {
  canonicalModelId,
  officialChannelIdForModel,
  type ChannelPreset,
} from "../../domains/channel/types";
import type { RouteCandidate } from "../../domains/model/types";

export type ModelRouteGroup = {
  key: string;
  routeIds: string[];
  routes: RouteCandidate[];
  channelId: string;
  accountId: string;
  upstreamModel: string;
  priority: number;
  enabled: boolean;
};

export type ModelServiceItem = {
  publicModel: string;
  kind: "aggregate" | "direct";
  routeIds: string[];
  routes: RouteCandidate[];
  routeGroups: ModelRouteGroup[];
  enabled: boolean;
  available: boolean;
  availableAccountCount: number;
  channelId?: string;
  channelName?: string;
};

/** 渠道模型(直接模型)被聚合模型引用的一条关系:
 *  聚合模型的某个路由组以上游模型名指向该渠道模型。 */
export type ModelAggregateRelation = {
  aggregateModel: string;
  routeGroupKey: string;
  priority: number;
  enabled: boolean;
};

/** 与 buildModelServiceItems 的 publicModel 归一化保持一致:
 *  官方规范化 ID 优先,否则 trim,统一小写作为分组/匹配键。 */
export function normalizePublicModelKey(modelId: string): string {
  return (canonicalModelId(modelId) ?? modelId.trim()).toLowerCase();
}

/** 汇总所有聚合模型(flowlet-pro/flowlet-flash)的路由引用关系,
 *  返回 key 为规范化渠道模型 ID 的映射,供「路由关系」视图和筛选使用。 */
export function buildAggregateRelations(
  models: ModelServiceItem[],
): Map<string, ModelAggregateRelation[]> {
  const relations = new Map<string, ModelAggregateRelation[]>();
  for (const model of models) {
    if (model.kind !== "aggregate") continue;
    model.routeGroups.forEach((group, index) => {
      const key = normalizePublicModelKey(group.upstreamModel);
      const list = relations.get(key) ?? [];
      list.push({
        aggregateModel: model.publicModel,
        routeGroupKey: group.key,
        priority: index + 1,
        enabled: group.enabled,
      });
      relations.set(key, list);
    });
  }
  return relations;
}

export function buildModelServiceItems(
  routes: RouteCandidate[],
  accounts: ChannelAccount[],
  channels: ChannelPreset[],
): ModelServiceItem[] {
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const channelById = new Map(channels.map((channel) => [channel.id, channel]));
  const groups = new Map<string, { item: ModelServiceItem; accountIds: Set<string> }>();

  for (const publicModel of ["flowlet-pro", "flowlet-flash"]) {
    groups.set(publicModel, {
      item: {
        publicModel,
        kind: "aggregate",
        routeIds: [],
        routes: [],
        routeGroups: [],
        enabled: false,
        available: false,
        availableAccountCount: 0,
      },
      accountIds: new Set<string>(),
    });
  }

  for (const route of routes) {
    const normalizedPublicModel = route.virtual_model_id.trim().toLowerCase();
    const aggregate = normalizedPublicModel === "flowlet-pro" || normalizedPublicModel === "flowlet-flash";
    const publicModel = aggregate
      ? normalizedPublicModel
      : canonicalModelId(route.virtual_model_id) ?? route.virtual_model_id.trim();
    const groupKey = normalizePublicModelKey(route.virtual_model_id);
    const ownerChannelId = officialChannelIdForModel(publicModel) ?? route.channel_id;
    const current = groups.get(groupKey) ?? {
      item: {
        publicModel,
        kind: aggregate ? "aggregate" : "direct",
        routeIds: [],
        routes: [],
        routeGroups: [],
        enabled: false,
        available: false,
        availableAccountCount: 0,
        channelId: aggregate ? undefined : ownerChannelId,
        channelName: aggregate ? undefined : channelById.get(ownerChannelId)?.name ?? ownerChannelId,
      },
      accountIds: new Set<string>(),
    };
    current.item.routeIds.push(route.id);
    current.item.routes.push(route);
    if (route.enabled) current.item.enabled = true;
    const account = accountById.get(route.account_id);
    if (account && account.enabled && account.api_key.trim() && account.credential_status !== "invalid_key") {
      current.item.available = true;
      current.accountIds.add(account.id);
    }
    groups.set(groupKey, current);
  }

  return [...groups.values()]
    .map(({ item, accountIds }) => {
      const routeGroups = buildModelRouteGroups(item.routes);
      return {
        ...item,
        enabled: routeGroups.some((group) => group.enabled),
        availableAccountCount: accountIds.size,
        routes: [...item.routes].sort((a, b) => a.priority - b.priority || a.channel_id.localeCompare(b.channel_id)),
        routeGroups,
      };
    })
    .sort((a, b) => modelRank(a.publicModel) - modelRank(b.publicModel) || a.publicModel.localeCompare(b.publicModel));
}

export function buildModelRouteGroups(routes: RouteCandidate[]): ModelRouteGroup[] {
  const groups = new Map<string, RouteCandidate[]>();
  for (const route of routes) {
    const key = [route.channel_id, route.account_id, route.upstream_model].join("\u0000");
    groups.set(key, [...(groups.get(key) ?? []), route]);
  }

  return [...groups.entries()]
    .map(([key, groupedRoutes]) => ({
      key,
      routeIds: groupedRoutes.map((route) => route.id),
      routes: groupedRoutes,
      channelId: groupedRoutes[0].channel_id,
      accountId: groupedRoutes[0].account_id,
      upstreamModel: groupedRoutes[0].upstream_model,
      priority: Math.min(...groupedRoutes.map((route) => route.priority)),
      enabled: groupedRoutes.every((route) => route.enabled),
    }))
    .sort((a, b) => a.priority - b.priority || a.channelId.localeCompare(b.channelId) || a.accountId.localeCompare(b.accountId));
}

function modelRank(model: string) {
  if (model === "flowlet-pro") return 0;
  if (model === "flowlet-flash") return 1;
  return 2;
}
