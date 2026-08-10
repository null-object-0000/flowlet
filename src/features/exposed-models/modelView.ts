import type { ChannelAccount } from "../../domains/account/types";
import type { ChannelPreset } from "../../domains/channel/types";
import type { RouteCandidate } from "../../domains/model/types";

const AGGREGATE_MODEL_IDS = ["flowlet-pro", "flowlet-flash"] as const;

export type OverviewAggregateModel = {
  publicModel: (typeof AGGREGATE_MODEL_IDS)[number];
  availableModelCount: number;
  candidateModelCount: number;
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
    const candidateModels = new Set(modelRoutes.map((route) => route.upstream_model));
    const availableAccounts = new Set<string>();
    const availableModels = new Set<string>();

    for (const route of modelRoutes) {
      const account = accountById.get(route.account_id);
      if (!route.enabled || !account || !isAccountHealthy(account) || !aggregateChannelIds.has(route.channel_id)) continue;
      availableAccounts.add(account.id);
      availableModels.add(route.upstream_model);
    }

    return {
      publicModel,
      availableModelCount: availableModels.size,
      candidateModelCount: candidateModels.size,
      availableAccountCount: availableAccounts.size,
      candidateAccountCount: candidateAccounts.size,
    };
  });
}

function isAccountHealthy(account: ChannelAccount): boolean {
  return account.enabled && Boolean(account.api_key.trim()) && account.credential_status === "healthy";
}
