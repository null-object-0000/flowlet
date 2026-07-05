import { ChannelAccount, ProtocolType, RouteCandidate } from "../../domain";

export type ExposedModel = {
  publicModel: string;
  upstreamModel: string;
  channelId: string;
  accountId: string;
  accountIds: string[];
  routeIndexes: number[];
  protocols: ProtocolType[];
  enabled: boolean;
  hasAvailableAccount: boolean;
};

export function buildExposedModels(routes: RouteCandidate[], accounts: ChannelAccount[] = []): ExposedModel[] {
  const accountMap = new Map(accounts.map((account) => [account.id, account]));
  return Array.from(
    routes
      .map((route, index) => ({ route, index }))
      .filter(({ route }) => route.channel_id && route.virtual_model_id)
      .reduce((groups, { route, index }) => {
        const key = `${route.channel_id}:${route.virtual_model_id}`;
        const current =
          groups.get(key) ??
          {
            publicModel: route.virtual_model_id,
            upstreamModel: route.upstream_model,
            channelId: route.channel_id,
            accountId: route.account_id,
            accountIds: [] as string[],
            routeIndexes: [] as number[],
            protocols: [] as ProtocolType[],
            enabled: false,
            hasAvailableAccount: false,
          };

        current.routeIndexes.push(index);
        if (route.account_id && !current.accountIds.includes(route.account_id)) {
          current.accountIds.push(route.account_id);
        }
        if (route.enabled) current.enabled = true;
        if (!current.protocols.includes(route.client_protocol)) current.protocols.push(route.client_protocol);
        const account = accountMap.get(route.account_id);
        if (account?.enabled && account.api_key.trim()) current.hasAvailableAccount = true;
        groups.set(key, current);
        return groups;
      }, new Map<string, ExposedModel>())
      .values(),
  ).sort((a, b) => a.publicModel.localeCompare(b.publicModel));
}

export function accountCountLabel(count: number): string {
  if (count <= 0) return "未配置账号";
  return `${count} 个账号`;
}
