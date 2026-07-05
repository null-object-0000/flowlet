import { Actions, DetailsPanel, PanelHeader } from "../../components/ui";
import { ChannelAccount, ChannelPreset, ClientConfig, ProtocolType, RouteRule } from "../../domain";

type RouteRulesPanelProps = {
  routeRules: RouteRule[];
  channels: ChannelPreset[];
  accounts: ChannelAccount[];
  clients: ClientConfig[];
  onAddRouteRule: () => void;
  onUpdateRouteRule: (index: number, patch: Partial<RouteRule>) => void;
  onRemoveRouteRule: (index: number) => void;
  onSaveRouteRules: () => void;
};

export function RouteRulesPanel({ routeRules, channels, accounts, clients, onAddRouteRule, onUpdateRouteRule, onRemoveRouteRule, onSaveRouteRules }: RouteRulesPanelProps) {
  return (
    <DetailsPanel summary="实验功能：规则路由">
      <PanelHeader>
        <h3>规则路由（优先于自动路由）</h3>
        <Actions>
          <button type="button" onClick={onAddRouteRule}>新增规则</button>
          <button type="button" onClick={() => void onSaveRouteRules()}>保存规则</button>
        </Actions>
      </PanelHeader>
      <p className="hint">当请求匹配规则条件时，强制路由到指定渠道账号。规则按优先级排序，首个匹配的规则生效。</p>
      <div className="route-list">
        {routeRules.length === 0 ? (
          <p>暂无规则路由。自动路由将按账号优先级和路由候选进行匹配。</p>
        ) : (
          routeRules.map((rule, index) => (
            <div className="route-card" key={rule.id}>
              <span className="route-priority">{index + 1}</span>
              <input value={rule.name} placeholder="规则名称" onChange={(e) => onUpdateRouteRule(index, { name: e.target.value })} />
              <select value={rule.match_client_id ?? ""} onChange={(e) => onUpdateRouteRule(index, { match_client_id: e.target.value || null })}>
                <option value="">所有客户端</option>
                {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <input value={rule.match_model ?? ""} placeholder="匹配模型（空=全部）" onChange={(e) => onUpdateRouteRule(index, { match_model: e.target.value || null })} />
              <select value={rule.match_protocol ?? ""} onChange={(e) => onUpdateRouteRule(index, { match_protocol: (e.target.value || null) as ProtocolType | null })}>
                <option value="">所有协议</option>
                <option value="openai">OpenAI-compatible</option>
                <option value="anthropic">Anthropic-compatible</option>
              </select>
              <select value={rule.target_channel_id} onChange={(e) => onUpdateRouteRule(index, { target_channel_id: e.target.value })}>
                {channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <select value={rule.target_account_id} onChange={(e) => onUpdateRouteRule(index, { target_account_id: e.target.value })}>
                {accounts.filter((a) => a.channel_id === rule.target_channel_id).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
              <input value={rule.target_upstream_model} placeholder="上游模型" onChange={(e) => onUpdateRouteRule(index, { target_upstream_model: e.target.value })} />
              <label className="checkbox-label">
                <input type="checkbox" checked={rule.enabled} onChange={(e) => onUpdateRouteRule(index, { enabled: e.target.checked })} />
                启用
              </label>
              <button type="button" onClick={() => onRemoveRouteRule(index)}>删除</button>
            </div>
          ))
        )}
      </div>
    </DetailsPanel>
  );
}


