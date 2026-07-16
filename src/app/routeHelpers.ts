import {
  ChannelAccount,
  ChannelModel,
  ChannelPreset,
  ModelExposureMode,
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

// 所有可用底层模型（默认 + 同步），不再过滤档位。
// 用于生成直接模型路由（virtual_model_id === upstream_model），
// 即使档位是 "none" 也可作为直接底层模型开放。
function allUsableModelsForChannel(channel: ChannelPreset, channelModels: ChannelModel[]): string[] {
  const synced = channelModels
    .filter((model) => model.channel_id === channel.id
      && model.enabled
      && model.supported_protocols.includes("openai")
      && model.supported_protocols.includes("anthropic"))
    .map((model) => model.model);
  return [...new Set([...getDefaultExposedModels(channel), ...synced])];
}

// 仅参与聚合模型池的底层模型（档位 !== none）。
function aggregateModelsForChannel(channel: ChannelPreset, channelModels: ChannelModel[]): string[] {
  return allUsableModelsForChannel(channel, channelModels)
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
  channelModels: ChannelModel[] = [],
  mode: ModelExposureMode = "all"
): RouteCandidate[] {
  return ensureDefaultExposedRoutes(channels, sourceAccounts, [], channelModels, mode);
}

export function ensureDefaultExposedRoutes(
  channels: ChannelPreset[],
  sourceAccounts: ChannelAccount[],
  currentRoutes: RouteCandidate[],
  channelModels: ChannelModel[] = [],
  mode: ModelExposureMode = "all"
): RouteCandidate[] {
  const managedRoutes = currentRoutes.filter((route) => FLOWLET_MODEL_IDS.has(route.virtual_model_id));
  // 直接模型路由：virtual_model_id === upstream_model（真实模型名），用户可自行为每个模型启停。
  const directRoutes = currentRoutes.filter(
    (route) => !FLOWLET_MODEL_IDS.has(route.virtual_model_id) && route.virtual_model_id === route.upstream_model
  );
  // 其余自定义路由（例如 legacy "auto"）：原样保留。
  const customRoutes = currentRoutes.filter(
    (route) => !FLOWLET_MODEL_IDS.has(route.virtual_model_id) && route.virtual_model_id !== route.upstream_model
  );
  const availableAccounts = sourceAccounts.filter((account) => account.enabled && account.api_key.trim());

  // 按 "渠道:账号:协议:模型" 索引已有的直接模型路由，便于保留用户启停与排序设置。
  const directRouteIndex = new Map<string, RouteCandidate>();
  for (const route of directRoutes) {
    directRouteIndex.set(`${route.channel_id}:${route.account_id}:${route.client_protocol}:${route.virtual_model_id}`, route);
  }

  // 开放模式决定新增直接路由的默认开关：
  // - flowlet_only：全部直接模型不对外开放（enabled=false）
  // - all / custom：新增默认对外开放（enabled=true）
  const directEnabledDefault = mode === "flowlet_only" ? false : true;

  const nextDirect: RouteCandidate[] = [];
  const nextManaged: RouteCandidate[] = [];

  for (const channel of channels) {
    const accounts = availableAccounts
      .filter((account) => account.channel_id === channel.id)
      .sort((a, b) => a.priority - b.priority || a.created_at.localeCompare(b.created_at));
    if (accounts.length === 0) continue;

    const protocols = channel.supported_protocols;

    // 直接模型路由：所有可用底层模型 × 账号 × 协议，virtual_model_id === upstream_model。
    for (const upstreamModel of allUsableModelsForChannel(channel, channelModels)) {
      for (const account of accounts) {
        for (const protocol of protocols) {
          const existing = directRouteIndex.get(`${channel.id}:${account.id}:${protocol}:${upstreamModel}`);
          if (existing) {
            // 保留用户设置；all 模式强制开放，flowlet_only 强制关闭，custom 保留用户选择。
            const enabled = mode === "all" ? true : mode === "flowlet_only" ? false : existing.enabled;
            nextDirect.push({ ...existing, enabled });
          } else {
            nextDirect.push({
              ...createRouteCandidate(upstreamModel, channel.id, account.id, upstreamModel, protocol, 0),
              enabled: directEnabledDefault,
            });
          }
        }
      }
    }

    // 聚合模型路由：仅双协议渠道，且底层模型档位 !== none。
    if (!supportsBothProtocols(channel)) continue;
    for (const upstreamModel of aggregateModelsForChannel(channel, channelModels)) {
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

  return [...customRoutes, ...nextDirect, ...nextManaged];
}