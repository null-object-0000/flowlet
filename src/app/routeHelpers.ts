import {
  ChannelAccount,
  ChannelPreset,
  RouteCandidate,
  createRouteCandidate,
  getDefaultExposedModels,
} from "../domain";

export function buildDefaultExposedRoutes(
  channels: ChannelPreset[],
  sourceAccounts: ChannelAccount[]
): RouteCandidate[] {
  const enabledAccounts = sourceAccounts
    .filter((account) => account.enabled && account.api_key.trim())
    .sort((a, b) => a.priority - b.priority);
  const firstAccountByChannel = new Map<string, ChannelAccount>();
  for (const account of enabledAccounts) {
    if (!firstAccountByChannel.has(account.channel_id)) {
      firstAccountByChannel.set(account.channel_id, account);
    }
  }
  let priority = 0;
  return channels.flatMap((channel) => {
    const account = firstAccountByChannel.get(channel.id);
    if (!account) return [];
    return getDefaultExposedModels(channel).flatMap((model) =>
      channel.supported_protocols.map((protocol) =>
        createRouteCandidate(model, channel.id, account.id, model, protocol, priority++)
      )
    );
  });
}

export function ensureDefaultExposedRoutes(
  channels: ChannelPreset[],
  sourceAccounts: ChannelAccount[],
  currentRoutes: RouteCandidate[]
): RouteCandidate[] {
  const nextRoutes = [...currentRoutes];
  const enabledAccounts = sourceAccounts
    .filter((account) => account.enabled && account.api_key.trim())
    .sort((a, b) => a.priority - b.priority);
  for (const channel of channels) {
    const firstAccount = enabledAccounts.find((account) => account.channel_id === channel.id);
    if (!firstAccount) continue;
    for (const model of getDefaultExposedModels(channel)) {
      for (const protocol of channel.supported_protocols) {
        const exists = nextRoutes.some(
          (route) =>
            route.upstream_model === model &&
            route.client_protocol === protocol &&
            route.channel_id === channel.id
        );
        if (!exists) {
          nextRoutes.push(
            createRouteCandidate(
              model,
              channel.id,
              firstAccount.id,
              model,
              protocol,
              nextRoutes.length
            )
          );
        }
      }
    }
  }
  return nextRoutes;
}
