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
          <button type="button" onClick={onAdd}>新增候选</button>
          <button type="button" onClick={() => void onSave()}>保存配置</button>
        </Actions>
      </PanelHeader>
      <div className="route-list">
        {routes.length === 0 ? (
          <p>暂无路由候选。</p>
        ) : (
          routes.map((route, index) => (
            <div className="route-card" key={route.id}>
              <span className="route-priority">{index + 1}</span>
              <select value={route.virtual_model_id} onChange={(e) => onUpdate(index, { virtual_model_id: e.target.value })}>
                {virtualModels.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
                {virtualModels.length === 0 ? <option value="auto">auto</option> : null}
              </select>
              <select value={route.channel_id} onChange={(e) => onUpdate(index, { channel_id: e.target.value })}>
                {channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <select value={route.account_id} onChange={(e) => onUpdate(index, { account_id: e.target.value })}>
                <option value="">请选择账号</option>
                {accounts.filter((a) => a.channel_id === route.channel_id).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
              <input value={route.upstream_model} placeholder="上游模型名" onChange={(e) => onUpdate(index, { upstream_model: e.target.value })} />
              <select value={route.client_protocol} onChange={(e) => onUpdate(index, { client_protocol: e.target.value as ProtocolType })}>
                <option value="openai">OpenAI-compatible</option>
                <option value="anthropic">Anthropic-compatible</option>
              </select>
              <label className="checkbox-label">
                <input type="checkbox" checked={route.enabled} onChange={(e) => onUpdate(index, { enabled: e.target.checked })} />
                启用
              </label>
              <button type="button" onClick={() => onRemove(index)}>删除</button>
            </div>
          ))
        )}
      </div>
    </DetailsPanel>
  );
}


