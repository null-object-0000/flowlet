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

/** 一个开放模型（按规范模型 ID 分组）及其全部路由候选。
 *  路由候选来自不同渠道/账号/上游模型变体，组内按优先级排序与失败降级。 */
export type ModelServiceItem = {
  publicModel: string;
  routeIds: string[];
  routes: RouteCandidate[];
  routeGroups: ModelRouteGroup[];
  enabled: boolean;
  available: boolean;
  availableAccountCount: number;
  channelId?: string;
  channelName?: string;
};

/** 与 buildModelServiceItems 的 publicModel 归一化保持一致:
 *  官方规范化 ID 优先,否则 trim,统一小写作为分组/匹配键。 */
export function normalizePublicModelKey(modelId: string): string {
  return (canonicalModelId(modelId) ?? modelId.trim()).toLowerCase();
}

export function buildModelServiceItems(
  routes: RouteCandidate[],
  accounts: ChannelAccount[],
  channels: ChannelPreset[],
): ModelServiceItem[] {
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const channelById = new Map(channels.map((channel) => [channel.id, channel]));
  const groups = new Map<string, { item: ModelServiceItem; accountIds: Set<string> }>();

  for (const route of routes) {
    // 路由只按规范模型身份参与展示：目录里查不到的对外模型名（含历史聚合模型
    // 别名）是无效路由，不参与路由、不对外暴露。
    const publicModel = canonicalModelId(route.virtual_model_id);
    if (!publicModel) continue;
    const groupKey = normalizePublicModelKey(route.virtual_model_id);
    const ownerChannelId = officialChannelIdForModel(publicModel) ?? route.channel_id;
    const current = groups.get(groupKey) ?? {
      item: {
        publicModel,
        routeIds: [],
        routes: [],
        routeGroups: [],
        enabled: false,
        available: false,
        availableAccountCount: 0,
        channelId: ownerChannelId,
        channelName: channelById.get(ownerChannelId)?.name ?? ownerChannelId,
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
    .sort((a, b) => a.publicModel.localeCompare(b.publicModel));
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
