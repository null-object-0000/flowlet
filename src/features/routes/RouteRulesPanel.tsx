import { Button, Checkbox, Select, TextInput } from "@mantine/core";
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
          <Button type="button" variant="default" onClick={onAddRouteRule}>新增规则</Button>
          <Button type="button" onClick={() => void onSaveRouteRules()}>保存规则</Button>
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
              <TextInput value={rule.name} placeholder="规则名称" onChange={(e) => onUpdateRouteRule(index, { name: e.target.value })} />
              <Select value={rule.match_client_id ?? "__all__"} onChange={(value) => onUpdateRouteRule(index, { match_client_id: value === "__all__" || !value ? null : value })} data={[{ value: "__all__", label: "所有客户端" }, ...clients.map((c) => ({ value: c.id, label: c.name }))]} />
              <TextInput value={rule.match_model ?? ""} placeholder="匹配模型（空=全部）" onChange={(e) => onUpdateRouteRule(index, { match_model: e.target.value || null })} />
              <Select value={rule.match_protocol ?? "__all__"} onChange={(value) => onUpdateRouteRule(index, { match_protocol: (value === "__all__" || !value ? null : value) as ProtocolType | null })} data={[{ value: "__all__", label: "所有协议" }, { value: "openai", label: "OpenAI-compatible" }, { value: "anthropic", label: "Anthropic-compatible" }]} />
              <Select value={rule.target_channel_id} onChange={(value) => value && onUpdateRouteRule(index, { target_channel_id: value })} data={channels.map((c) => ({ value: c.id, label: c.name }))} />
              <Select value={rule.target_account_id || "__none__"} onChange={(value) => onUpdateRouteRule(index, { target_account_id: value === "__none__" || !value ? "" : value })} data={[{ value: "__none__", label: "请选择账号" }, ...accounts.filter((a) => a.channel_id === rule.target_channel_id).map((a) => ({ value: a.id, label: a.name }))]} />
              <TextInput value={rule.target_upstream_model} placeholder="上游模型" onChange={(e) => onUpdateRouteRule(index, { target_upstream_model: e.target.value })} />
              <Checkbox label="启用" checked={rule.enabled} onChange={(e) => onUpdateRouteRule(index, { enabled: e.currentTarget.checked })} />
              <Button type="button" variant="subtle" color="red" onClick={() => onRemoveRouteRule(index)}>删除</Button>
            </div>
          ))
        )}
      </div>
    </DetailsPanel>
  );
}


