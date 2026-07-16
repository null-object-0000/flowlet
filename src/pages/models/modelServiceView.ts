import type { ChannelAccount } from "../../domains/account/types";
import type { ChannelPreset } from "../../domains/channel/types";
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
    const aggregate = route.virtual_model_id === "flowlet-pro" || route.virtual_model_id === "flowlet-flash";
    const current = groups.get(route.virtual_model_id) ?? {
      item: {
        publicModel: route.virtual_model_id,
        kind: aggregate ? "aggregate" : "direct",
        routeIds: [],
        routes: [],
        routeGroups: [],
        enabled: false,
        available: false,
        availableAccountCount: 0,
        channelId: aggregate ? undefined : route.channel_id,
        channelName: aggregate ? undefined : channelById.get(route.channel_id)?.name ?? route.channel_id,
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
    groups.set(route.virtual_model_id, current);
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
