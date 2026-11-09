/** 从路由候选、渠道账号与渠道预设推导「Agent 默认模型」可选池。
 *
 *  可用 = 启用路由 + 健康账号（启用、有 API Key、凭证健康）+ 渠道支持该路由协议，
 *  且路由的对外模型与上游模型必须属于同一规范模型（旧聚合路由/非法身份不参与）。
 *  纯函数，便于在接入抽屉与测试中复用。 */

import type { ChannelAccount } from "../../domains/account/types";
import type { ChannelPreset } from "../../domains/channel/types";
import type { RouteCandidate } from "../../domains/model/types";
import { canonicalModelId } from "../../domains/modelCatalog/identity";
import type { AgentAvailableModel, AgentModelProtocol } from "./agentAccessAdapters";

const PROTOCOL_ORDER: AgentModelProtocol[] = ["openai", "anthropic", "responses"];

export function computeAvailableModels(
  routes: readonly RouteCandidate[] | undefined,
  accounts: readonly ChannelAccount[] | undefined,
  channels: readonly ChannelPreset[] | undefined,
): AgentAvailableModel[] {
  const routableAccountIds = new Set(
    (accounts ?? [])
      .filter((account) =>
        account.enabled
        && account.api_key.trim().length > 0
        && account.credential_status === "healthy")
      .map((account) => account.id),
  );
  const channelsById = new Map((channels ?? []).map((channel) => [channel.id, channel]));
  const protocolsByModel = new Map<string, Set<AgentModelProtocol>>();

  for (const route of routes ?? []) {
    if (!route.enabled) continue;
    if (!routableAccountIds.has(route.account_id)) continue;
    const channel = channelsById.get(route.channel_id);
    // Rust 渠道预设实际序列化 `enabled`；前端 ChannelPreset 类型尚未声明该字段，
    // 缺失时按启用处理，避免误判旧数据。
    const channelEnabled = (channel as (ChannelPreset & { enabled?: boolean }) | undefined)?.enabled !== false;
    if (!channel || !channelEnabled || !channel.supported_protocols.includes(route.client_protocol)) continue;
    const model = canonicalModelId(route.virtual_model_id);
    // 对外模型与上游模型必须归一到同一规范模型，否则该路由不参与代理。
    if (!model || model !== canonicalModelId(route.upstream_model)) continue;
    const protocols = protocolsByModel.get(model) ?? new Set<AgentModelProtocol>();
    protocols.add(route.client_protocol);
    protocolsByModel.set(model, protocols);
  }

  return [...protocolsByModel.entries()]
    .map(([model, protocols]) => ({
      model,
      protocols: PROTOCOL_ORDER.filter((protocol) => protocols.has(protocol)),
    }))
    .sort((left, right) => (left.model < right.model ? -1 : left.model > right.model ? 1 : 0));
}
