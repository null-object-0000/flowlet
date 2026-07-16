import type { ChannelAccount } from "../../domains/account/types";
import type { ChannelPreset, ProtocolType } from "../../domains/channel/types";
import type { RouteCandidate } from "../../domains/model/types";

export type OverviewExposedModel = {
  publicModel: string;
  routeIds: string[];
  protocols: ProtocolType[];
  enabled: boolean;
  hasAvailableAccount: boolean;
  availableAccountCount: number;
  channelId?: string;
  channelName?: string;
  kind: "aggregate" | "direct";
};

export function buildOverviewExposedModels(
  routes: RouteCandidate[],
  accounts: ChannelAccount[],
  channels: ChannelPreset[],
): OverviewExposedModel[] {
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const channelById = new Map(channels.map((channel) => [channel.id, channel]));
  const groups = new Map<string, { model: OverviewExposedModel; availableAccounts: Set<string> }>();

  for (const route of routes) {
    const aggregate = route.virtual_model_id === "flowlet-pro" || route.virtual_model_id === "flowlet-flash";
    const direct = !aggregate && route.virtual_model_id === route.upstream_model;
    if (!aggregate && !direct) continue;

    const current = groups.get(route.virtual_model_id) ?? {
      model: {
        publicModel: route.virtual_model_id,
        routeIds: [],
        protocols: [],
        enabled: false,
        hasAvailableAccount: false,
        availableAccountCount: 0,
        channelId: direct ? route.channel_id : undefined,
        channelName: direct ? channelById.get(route.channel_id)?.name ?? route.channel_id : undefined,
        kind: aggregate ? "aggregate" : "direct",
      },
      availableAccounts: new Set<string>(),
    };

    current.model.routeIds.push(route.id);
    if (!current.model.protocols.includes(route.client_protocol)) current.model.protocols.push(route.client_protocol);
    if (route.enabled) current.model.enabled = true;
    const account = accountById.get(route.account_id);
    // Account availability describes whether this model has a usable upstream
    // account. It must not disappear merely because external exposure is off.
    if (account && isAccountHealthy(account)) {
      current.model.hasAvailableAccount = true;
      current.availableAccounts.add(account.id);
    }
    groups.set(route.virtual_model_id, current);
  }

  return [...groups.values()]
    .map(({ model, availableAccounts }) => ({ ...model, availableAccountCount: availableAccounts.size }))
    .sort((a, b) => modelRank(a) - modelRank(b) || a.publicModel.localeCompare(b.publicModel));
}

function isAccountHealthy(account: ChannelAccount): boolean {
  return account.enabled && Boolean(account.api_key.trim()) && account.credential_status !== "invalid_key";
}

function modelRank(model: OverviewExposedModel): number {
  if (model.publicModel === "flowlet-pro") return 0;
  if (model.publicModel === "flowlet-flash") return 1;
  return 2;
}
