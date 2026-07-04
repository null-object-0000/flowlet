import { Actions, EmptyState, Panel, PanelHeader, ProtocolBadges, StatusPill } from "../../components/ui";
import { ChannelAccount, ProtocolType, RouteCandidate } from "../../domain";

type ExposedModel = {
  publicModel: string;
  channelId: string;
  accountId: string;
  routeIndexes: number[];
  protocols: ProtocolType[];
  enabled: boolean;
};

type ModelServicesPanelProps = {
  routes: RouteCandidate[];
  accounts: ChannelAccount[];
  onUpdate: (index: number, patch: Partial<RouteCandidate>) => void;
  onSave: () => void;
  onRegenerateDefaultRoutes: () => void;
  getChannelName: (channelId: string) => string;
};

function buildExposedModels(routes: RouteCandidate[]): ExposedModel[] {
  return Array.from(
    routes
      .map((route, index) => ({ route, index }))
      .filter(({ route }) => route.channel_id && route.account_id && route.upstream_model)
      .reduce((groups, { route, index }) => {
        const key = `${route.channel_id}:${route.upstream_model}`;
        const current = groups.get(key) ?? {
          publicModel: route.upstream_model,
          channelId: route.channel_id,
          accountId: route.account_id,
          routeIndexes: [] as number[],
          protocols: [] as ProtocolType[],
          enabled: false,
        };
        current.routeIndexes.push(index);
        if (!current.protocols.includes(route.client_protocol)) current.protocols.push(route.client_protocol);
        current.enabled = current.enabled || route.enabled;
        groups.set(key, current);
        return groups;
      }, new Map<string, ExposedModel>())
      .values()
  ).sort((a, b) => a.publicModel.localeCompare(b.publicModel));
}

export function ModelServicesPanel({ routes, accounts, onUpdate, onSave, onRegenerateDefaultRoutes, getChannelName }: ModelServicesPanelProps) {
  const exposedModels = buildExposedModels(routes);

  function setModelEnabled(routeIndexes: number[], enabled: boolean) {
    routeIndexes.forEach((routeIndex) => onUpdate(routeIndex, { enabled }));
  }

  function switchModelAccount(routeIndexes: number[], accountId: string) {
    const account = accounts.find((item) => item.id === accountId);
    if (!account) return;
    routeIndexes.forEach((routeIndex) => onUpdate(routeIndex, { account_id: account.id, channel_id: account.channel_id }));
  }

  return (
    <Panel>
      <PanelHeader>
        <h3>模型服务</h3>
        <Actions>
          <button onClick={onRegenerateDefaultRoutes}>重新生成默认开放模型</button>
          <button onClick={() => void onSave()}>保存模型服务</button>
        </Actions>
      </PanelHeader>
      {exposedModels.length === 0 ? (
        <EmptyState>
          <p>当前没有对外开放模型。</p>
          <p>请先在“渠道账号”添加并启用账号，系统会自动开放该渠道默认模型。</p>
        </EmptyState>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>状态</th>
                <th>对外模型名</th>
                <th>渠道</th>
                <th>默认账号</th>
                <th>协议</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {exposedModels.map((model) => (
                <tr key={`${model.channelId}:${model.publicModel}`}>
                  <td><StatusPill running={model.enabled}>{model.enabled ? "已开放" : "已关闭"}</StatusPill></td>
                  <td>{model.publicModel}</td>
                  <td>{getChannelName(model.channelId)}</td>
                  <td>
                    <select value={model.accountId} onChange={(event) => switchModelAccount(model.routeIndexes, event.target.value)}>
                      {accounts.filter((account) => account.channel_id === model.channelId).map((account) => (
                        <option key={account.id} value={account.id}>{account.name}</option>
                      ))}
                    </select>
                  </td>
                  <td><ProtocolBadges protocols={model.protocols} /></td>
                  <td>
                    <Actions>
                      <button onClick={() => setModelEnabled(model.routeIndexes, !model.enabled)}>{model.enabled ? "关闭" : "开放"}</button>
                    </Actions>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="hint">模型开放/关闭、账号切换保存后代理自动热更新，无需重启。</p>
    </Panel>
  );
}
