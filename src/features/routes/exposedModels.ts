import { ChannelAccount, ChannelModel, ChannelPreset, ProtocolType, RouteCandidate } from "../../domain";

export type ExposedModelKind = "aggregate" | "direct";

export type ExposedModel = {
  publicModel: string;
  accountIds: string[];
  routeIndexes: number[];
  protocols: ProtocolType[];
  enabled: boolean;
  hasAvailableAccount: boolean;
  underlyingModelCount: number;
  availableAccountCount: number;
  kind: ExposedModelKind;
  // 直接模型专属：所属渠道 id 与展示名。
  channelId?: string;
  channelName?: string;
};

// 健康账号判断与代理候选池一致：enabled + API Key 非空 + credential_status = healthy。
export function isAccountHealthy(account: ChannelAccount): boolean {
  return account.enabled && !!account.api_key.trim() && account.credential_status !== "invalid_key";
}

export function buildExposedModels(
  routes: RouteCandidate[],
  accounts: ChannelAccount[] = [],
  channels: ChannelPreset[] = [],
  channelModels: ChannelModel[] = []
): ExposedModel[] {
  const accountMap = new Map(accounts.map((account) => [account.id, account]));
  const channelMap = new Map(channels.map((channel) => [channel.id, channel]));
  const groups = new Map<
    string,
    { model: ExposedModel; underlying: Set<string>; availableAccounts: Set<string> }
  >();

  routes.forEach((route, index) => {
    const isAggregate = route.virtual_model_id === "flowlet-pro" || route.virtual_model_id === "flowlet-flash";
    // 直接模型：virtual_model_id === upstream_model（真实模型名）。
    const isDirect = !isAggregate && route.virtual_model_id === route.upstream_model;
    if (!isAggregate && !isDirect) return;

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
        kind: isAggregate ? "aggregate" : "direct",
        channelId: isDirect ? route.channel_id : undefined,
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
    if (route.enabled && account && isAccountHealthy(account)) {
      current.model.hasAvailableAccount = true;
      current.availableAccounts.add(route.account_id);
    }
    groups.set(route.virtual_model_id, current);
  });

  // 补全直接模型的渠道展示名。
  for (const { model } of groups.values()) {
    if (model.kind === "direct" && model.channelId) {
      model.channelName = channelMap.get(model.channelId)?.name ?? model.channelId;
    }
  }

  return [...groups.values()]
    .map(({ model, underlying, availableAccounts }) => ({
      ...model,
      underlyingModelCount: underlying.size,
      availableAccountCount: availableAccounts.size,
    }))
    .sort((a, b) => {
      // 排序：flowlet-pro → flowlet-flash → 其余按名字典序。
      const rank = (m: ExposedModel): number => {
        if (m.kind === "direct") return 2;
        if (m.publicModel === "flowlet-pro") return 0;
        if (m.publicModel === "flowlet-flash") return 1;
        return 2;
      };
      return rank(a) - rank(b) || a.publicModel.localeCompare(b.publicModel);
    });
}

export function accountCountLabel(count: number): string {
  if (count <= 0) return "未配置账号";
  return `${count} 个账号`;
}
