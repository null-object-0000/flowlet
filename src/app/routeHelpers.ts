import {
  ChannelAccount,
  ChannelModel,
  ChannelPreset,
  RouteCandidate,
  createRouteCandidate,
  flowletModelIdForTier,
  getDefaultExposedModels,
  getFlowletTier,
} from "../domain";

const FLOWLET_MODEL_IDS = new Set(["flowlet-pro", "flowlet-flash"]);

function supportsBothProtocols(channel: ChannelPreset): boolean {
  return channel.supported_protocols.includes("openai") && channel.supported_protocols.includes("anthropic");
}

function modelsForChannel(channel: ChannelPreset, channelModels: ChannelModel[]): string[] {
  const synced = channelModels
    .filter((model) => model.channel_id === channel.id
      && model.enabled
      && model.supported_protocols.includes("openai")
      && model.supported_protocols.includes("anthropic"))
    .map((model) => model.model);
  return [...new Set([...getDefaultExposedModels(channel), ...synced])]
    .filter((model) => getFlowletTier(channel.id, model) !== "none");
}

function defaultModelPriority(channelId: string, model: string): number {
  const tier = getFlowletTier(channelId, model);
  const normalized = model.toLowerCase();
  if (tier === "flash") return normalized.includes("deepseek") ? 0 : 50;
  if (normalized.includes("deepseek")) return 0;
  if (normalized.includes("longcat")) return 10;
  return 50;
}

export function buildDefaultExposedRoutes(
  channels: ChannelPreset[],
  sourceAccounts: ChannelAccount[],
  channelModels: ChannelModel[] = []
): RouteCandidate[] {
  return ensureDefaultExposedRoutes(channels, sourceAccounts, [], channelModels);
}

export function ensureDefaultExposedRoutes(
  channels: ChannelPreset[],
  sourceAccounts: ChannelAccount[],
  currentRoutes: RouteCandidate[],
  channelModels: ChannelModel[] = []
): RouteCandidate[] {
  const legacyRoutes = currentRoutes.filter((route) => !FLOWLET_MODEL_IDS.has(route.virtual_model_id));
  const managedRoutes = currentRoutes.filter((route) => FLOWLET_MODEL_IDS.has(route.virtual_model_id));
  const availableAccounts = sourceAccounts.filter((account) => account.enabled && account.api_key.trim());
  const nextManaged: RouteCandidate[] = [];

  for (const channel of channels.filter(supportsBothProtocols)) {
    const accounts = availableAccounts
      .filter((account) => account.channel_id === channel.id)
      .sort((a, b) => a.priority - b.priority || a.created_at.localeCompare(b.created_at));
    if (accounts.length === 0) continue;

    for (const upstreamModel of modelsForChannel(channel, channelModels)) {
      const tier = getFlowletTier(channel.id, upstreamModel);
      const publicModel = flowletModelIdForTier(tier);
      if (!publicModel) continue;
      const modelSetting = managedRoutes.find(
        (route) => route.virtual_model_id === publicModel
          && route.channel_id === channel.id
          && route.upstream_model === upstreamModel
      );
      const priority = modelSetting?.priority ?? defaultModelPriority(channel.id, upstreamModel);
      const enabled = modelSetting?.enabled ?? true;

      for (const account of accounts) {
        for (const protocol of ["openai", "anthropic"] as const) {
          const existing = managedRoutes.find(
            (route) => route.virtual_model_id === publicModel
              && route.channel_id === channel.id
              && route.account_id === account.id
              && route.upstream_model === upstreamModel
              && route.client_protocol === protocol
          );
          nextManaged.push(existing
            ? { ...existing, priority, enabled }
            : { ...createRouteCandidate(publicModel, channel.id, account.id, upstreamModel, protocol, priority), enabled });
        }
      }
    }
  }

  return [...legacyRoutes, ...nextManaged];
}