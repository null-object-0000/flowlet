import { ChannelAccount, ProtocolType, RouteCandidate } from "../../domain";

export type ExposedModel = {
  publicModel: string;
  accountIds: string[];
  routeIndexes: number[];
  protocols: ProtocolType[];
  enabled: boolean;
  hasAvailableAccount: boolean;
  underlyingModelCount: number;
  availableAccountCount: number;
};

export function buildExposedModels(routes: RouteCandidate[], accounts: ChannelAccount[] = []): ExposedModel[] {
  const accountMap = new Map(accounts.map((account) => [account.id, account]));
  const groups = new Map<string, { model: ExposedModel; underlying: Set<string>; availableAccounts: Set<string> }>();

  routes.forEach((route, index) => {
    if (!matchesFlowletModel(route.virtual_model_id)) return;
    const current = groups.get(route.virtual_model_id) ?? {
      model: {
        publicModel: route.virtual_model_id,
        accountIds: [],
        routeIndexes: [],
        protocols: [],
        enabled: false,
        hasAvailableAccount: false,
        underlyingModelCount: 0,
        availableAccountCount: 0,
      },
      underlying: new Set<string>(),
      availableAccounts: new Set<string>(),
    };
    current.model.routeIndexes.push(index);
    if (!current.model.accountIds.includes(route.account_id)) current.model.accountIds.push(route.account_id);
    if (!current.model.protocols.includes(route.client_protocol)) current.model.protocols.push(route.client_protocol);
    current.underlying.add(`${route.channel_id}:${route.upstream_model}`);
    const account = accountMap.get(route.account_id);
    if (route.enabled) current.model.enabled = true;
    if (route.enabled && account?.enabled && account.api_key.trim()) {
      current.model.hasAvailableAccount = true;
      current.availableAccounts.add(route.account_id);
    }
    groups.set(route.virtual_model_id, current);
  });

  return [...groups.values()]
    .map(({ model, underlying, availableAccounts }) => ({
      ...model,
      underlyingModelCount: underlying.size,
      availableAccountCount: availableAccounts.size,
    }))
    .sort((a, b) => (a.publicModel === "flowlet-pro" ? -1 : b.publicModel === "flowlet-pro" ? 1 : 0));
}

function matchesFlowletModel(model: string): boolean {
  return model === "flowlet-pro" || model === "flowlet-flash";
}

export function accountCountLabel(count: number): string {
  if (count <= 0) return "未配置账号";
  return `${count} 个账号`;
}