import { Button, Checkbox, Select, TextInput } from "@mantine/core";
import { Actions, DetailsPanel, PanelHeader } from "../../components/ui";
import { ChannelAccount, ChannelPreset, ProtocolType, RouteCandidate, VirtualModel } from "../../domain";

type RouteCandidatesPanelProps = {
  routes: RouteCandidate[];
  channels: ChannelPreset[];
  accounts: ChannelAccount[];
  virtualModels: VirtualModel[];
  onAdd: () => void;
  onUpdate: (index: number, patch: Partial<RouteCandidate>) => void;
  onRemove: (index: number) => void;
  onSave: () => void;
};

export function RouteCandidatesPanel({ routes, channels, accounts, virtualModels, onAdd, onUpdate, onRemove, onSave }: RouteCandidatesPanelProps) {
  return (
    <DetailsPanel summary="高级：模型映射与 route candidate">
      <PanelHeader>
        <h3>Route Candidates</h3>
        <Actions>
          <Button type="button" variant="default" onClick={onAdd}>新增候选</Button>
          <Button type="button" onClick={() => void onSave()}>保存配置</Button>
        </Actions>
      </PanelHeader>
      <div className="route-list">
        {routes.length === 0 ? (
          <p>暂无路由候选。</p>
        ) : (
          routes.map((route, index) => (
            <div className="route-card" key={route.id}>
              <span className="route-priority">{index + 1}</span>
              <Select value={route.virtual_model_id} onChange={(value) => onUpdate(index, { virtual_model_id: value ?? "auto" })} data={virtualModels.length ? virtualModels.map((model) => ({ value: model.id, label: model.name })) : [{ value: "auto", label: "auto" }]} />
              <Select value={route.channel_id} onChange={(value) => value && onUpdate(index, { channel_id: value })} data={channels.map((c) => ({ value: c.id, label: c.name }))} />
              <Select
                value={route.account_id || "__none__"}
                onChange={(value) => onUpdate(index, { account_id: value === "__none__" || !value ? "" : value })}
                data={[{ value: "__none__", label: "请选择账号" }, ...accounts.filter((a) => a.channel_id === route.channel_id).map((a) => ({ value: a.id, label: a.name }))]}
              />
              <TextInput value={route.upstream_model} placeholder="上游模型名" onChange={(e) => onUpdate(index, { upstream_model: e.target.value })} />
              <Select value={route.client_protocol} onChange={(value) => value && onUpdate(index, { client_protocol: value as ProtocolType })} data={[{ value: "openai", label: "OpenAI-compatible" }, { value: "anthropic", label: "Anthropic-compatible" }]} />
              <Checkbox label="启用" checked={route.enabled} onChange={(e) => onUpdate(index, { enabled: e.currentTarget.checked })} />
              <Button type="button" variant="subtle" color="red" onClick={() => onRemove(index)}>删除</Button>
            </div>
          ))
        )}
      </div>
    </DetailsPanel>
  );
}


