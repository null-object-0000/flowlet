import type { ChannelAccount } from "../../domains/account/types";
import type { ChannelPreset, ProtocolType } from "../../domains/channel/types";
import type { RouteCandidate } from "../../domains/model/types";

export type ModelServiceItem = {
  publicModel: string;
  kind: "aggregate" | "direct";
  routeIds: string[];
  routes: RouteCandidate[];
  protocols: ProtocolType[];
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

  for (const route of routes) {
    const aggregate = route.virtual_model_id === "flowlet-pro" || route.virtual_model_id === "flowlet-flash";
    const current = groups.get(route.virtual_model_id) ?? {
      item: {
        publicModel: route.virtual_model_id,
        kind: aggregate ? "aggregate" : "direct",
        routeIds: [],
        routes: [],
        protocols: [],
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
    if (!current.item.protocols.includes(route.client_protocol)) current.item.protocols.push(route.client_protocol);
    if (route.enabled) current.item.enabled = true;
    const account = accountById.get(route.account_id);
    if (account && account.enabled && account.api_key.trim() && account.credential_status !== "invalid_key") {
      current.item.available = true;
      current.accountIds.add(account.id);
    }
    groups.set(route.virtual_model_id, current);
  }

  return [...groups.values()]
    .map(({ item, accountIds }) => ({
      ...item,
      availableAccountCount: accountIds.size,
      routes: [...item.routes].sort((a, b) => a.priority - b.priority || a.channel_id.localeCompare(b.channel_id)),
    }))
    .sort((a, b) => modelRank(a.publicModel) - modelRank(b.publicModel) || a.publicModel.localeCompare(b.publicModel));
}

function modelRank(model: string) {
  if (model === "flowlet-pro") return 0;
  if (model === "flowlet-flash") return 1;
  return 2;
}
