import type { ChannelAccount } from "../../domains/account/types";
import type { ChannelPreset, ProtocolType } from "../../domains/channel/types";
import type { RouteCandidate } from "../../domains/model/types";

const AGGREGATE_MODEL_IDS = ["flowlet-pro", "flowlet-flash"] as const;

export type OverviewAggregateModel = {
  publicModel: (typeof AGGREGATE_MODEL_IDS)[number];
  protocols: ProtocolType[];
  availableAccountCount: number;
  candidateAccountCount: number;
};

/** Build the two stable Flowlet entry points shown on the overview page.
 * Availability mirrors the proxy candidate boundary: the route and account
 * must be enabled, the credential healthy, and the channel must support both
 * OpenAI and Anthropic for aggregate routing. */
export function buildOverviewAggregateModels(
  routes: RouteCandidate[],
  accounts: ChannelAccount[],
  channels: ChannelPreset[],
): OverviewAggregateModel[] {
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const aggregateChannelIds = new Set(
    channels
      .filter((channel) => channel.supported_protocols.includes("openai") && channel.supported_protocols.includes("anthropic"))
      .map((channel) => channel.id),
  );

  return AGGREGATE_MODEL_IDS.map((publicModel) => {
    const modelRoutes = routes.filter((route) => route.virtual_model_id === publicModel);
    const candidateAccounts = new Set(modelRoutes.map((route) => route.account_id));
    const availableAccounts = new Set<string>();
    const protocols = new Set<ProtocolType>();

    for (const route of modelRoutes) {
      const account = accountById.get(route.account_id);
      if (!route.enabled || !account || !isAccountHealthy(account) || !aggregateChannelIds.has(route.channel_id)) continue;
      availableAccounts.add(account.id);
      protocols.add(route.client_protocol);
    }

    return {
      publicModel,
      protocols: [...protocols].sort((a, b) => protocolRank(a) - protocolRank(b)),
      availableAccountCount: availableAccounts.size,
      candidateAccountCount: candidateAccounts.size,
    };
  });
}

function isAccountHealthy(account: ChannelAccount): boolean {
  return account.enabled && Boolean(account.api_key.trim()) && account.credential_status === "healthy";
}

function protocolRank(protocol: ProtocolType): number {
  if (protocol === "openai") return 0;
  if (protocol === "anthropic") return 1;
  return 2;
}
