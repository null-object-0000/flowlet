import type { ChannelAccount } from "../../domains/account/types";
import type { ChannelPreset } from "../../domains/channel/types";
import { canonicalModelId, officialChannelIdForModel } from "../../domains/channel/types";
import type { RouteCandidate } from "../../domains/model/types";

export type OverviewExposedModel = {
  publicModel: string;
  channelId: string | null;
  channelName: string | null;
  availableModelCount: number;
  candidateModelCount: number;
  availableAccountCount: number;
  candidateAccountCount: number;
};

/** 概览页「开放模型」列表：按规范模型 ID 合并全部路由候选，
 *  可用性镜像代理候选边界——路由与账号启用、凭据健康、渠道支持该协议。 */
export function buildOverviewExposedModels(
  routes: RouteCandidate[],
  accounts: ChannelAccount[],
  channels: ChannelPreset[],
): OverviewExposedModel[] {
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const channelById = new Map(channels.map((channel) => [channel.id, channel]));

  const grouped = new Map<string, { publicModel: string; routes: RouteCandidate[] }>();
  for (const route of routes) {
    const publicModel = canonicalModelId(route.virtual_model_id);
    if (!publicModel) continue;
    const key = publicModel.toLowerCase();
    const group = grouped.get(key) ?? { publicModel, routes: [] };
    group.routes.push(route);
    grouped.set(key, group);
  }

  return [...grouped.values()]
    .map(({ publicModel, routes: modelRoutes }) => {
      const candidateAccounts = new Set(modelRoutes.map((route) => route.account_id));
      const candidateModels = new Set(modelRoutes.map((route) => route.upstream_model));
      const availableAccounts = new Set<string>();
      const availableModels = new Set<string>();

      for (const route of modelRoutes) {
        const account = accountById.get(route.account_id);
        const channel = channelById.get(route.channel_id);
        if (!route.enabled || !account || !isAccountUsable(account) || !channel?.supported_protocols.includes(route.client_protocol)) continue;
        availableAccounts.add(account.id);
        availableModels.add(route.upstream_model);
      }

      const ownerChannelId = officialChannelIdForModel(publicModel) ?? modelRoutes[0]?.channel_id ?? null;
      return {
        publicModel,
        channelId: ownerChannelId,
        channelName: ownerChannelId ? channelById.get(ownerChannelId)?.name ?? ownerChannelId : null,
        availableModelCount: availableModels.size,
        candidateModelCount: candidateModels.size,
        availableAccountCount: availableAccounts.size,
        candidateAccountCount: candidateAccounts.size,
      };
    })
    .sort((a, b) => a.publicModel.localeCompare(b.publicModel));
}

function isAccountUsable(account: ChannelAccount): boolean {
  return account.enabled && Boolean(account.api_key.trim()) && account.credential_status !== "invalid_key";
}
