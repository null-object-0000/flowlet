import {
  ChannelAccount,
  ChannelPreset,
  ClientConfig,
  ProtocolType,
  RouteCandidate,
  RouteRule,
  VirtualModel,
  protocolLabels
} from "../domain";

export function RoutesPage({
  routes,
  channels,
  accounts,
  virtualModels,
  onAdd,
  onUpdate,
  onRemove,
  onSave,
  onRegenerateDefaultRoutes,
  getChannelName,
  routeRules,
  onAddRouteRule,
  onUpdateRouteRule,
  onRemoveRouteRule,
  onSaveRouteRules,
  clients,
}: {
  routes: RouteCandidate[];
  channels: ChannelPreset[];
  accounts: ChannelAccount[];
  virtualModels: VirtualModel[];
  onAdd: () => void;
  onUpdate: (index: number, patch: Partial<RouteCandidate>) => void;
  onRemove: (index: number) => void;
  onSave: () => void;
  onRegenerateDefaultRoutes: () => void;
  getChannelName: (channelId: string) => string;
  routeRules: RouteRule[];
  onAddRouteRule: () => void;
  onUpdateRouteRule: (index: number, patch: Partial<RouteRule>) => void;
  onRemoveRouteRule: (index: number) => void;
  onSaveRouteRules: () => void;
  clients: ClientConfig[];
}) {
  const exposedModels = Array.from(
    routes
      .reduce((groups, route, index) => {
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
        if (!current.protocols.includes(route.client_protocol)) {
          current.protocols.push(route.client_protocol);
        }
        current.enabled = current.enabled || route.enabled;
        groups.set(key, current);
        return groups;
      }, new Map<string, {
        publicModel: string;
        channelId: string;
        accountId: string;
        routeIndexes: number[];
        protocols: ProtocolType[];
        enabled: boolean;
      }>())
      .values()
  ).sort((a, b) => a.publicModel.localeCompare(b.publicModel));

  function setModelEnabled(routeIndexes: number[], enabled: boolean) {
    routeIndexes.forEach((routeIndex) => onUpdate(routeIndex, { enabled }));
  }

  function switchModelAccount(routeIndexes: number[], accountId: string) {
    const account = accounts.find((item) => item.id === accountId);
    if (!account) return;
    routeIndexes.forEach((routeIndex) =>
      onUpdate(routeIndex, { account_id: account.id, channel_id: account.channel_id })
    );
  }

  return (
    <>
      <section className="panel">
        <div className="panel-title">
          <h3>模型服务</h3>
          <div className="actions">
            <button onClick={onRegenerateDefaultRoutes}>重新生成默认开放模型</button>
            <button onClick={() => void onSave()}>保存模型服务</button>
          </div>
        </div>
        {exposedModels.length === 0 ? (
          <div className="empty-state">
            <p>当前没有对外开放模型。</p>
            <p>请先在“渠道账号”添加并启用账号，系统会自动开放该渠道默认模型。</p>
          </div>
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
                    <td>
                      <span className={model.enabled ? "status running" : "status"}>
                        {model.enabled ? "已开放" : "已关闭"}
                      </span>
                    </td>
                    <td>{model.publicModel}</td>
                    <td>{getChannelName(model.channelId)}</td>
                    <td>
                      <select
                        value={model.accountId}
                        onChange={(event) =>
                          switchModelAccount(model.routeIndexes, event.target.value)
                        }
                      >
                        {accounts
                          .filter((account) => account.channel_id === model.channelId)
                          .map((account) => (
                            <option key={account.id} value={account.id}>
                              {account.name}
                            </option>
                          ))}
                      </select>
                    </td>
                    <td>
                      <div className="channel-protocols">
                        {model.protocols.map((protocol) => (
                          <span className="protocol-badge" key={protocol}>
                            {protocolLabels[protocol]}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td>
                      <div className="actions">
                        <button
                          onClick={() => setModelEnabled(model.routeIndexes, !model.enabled)}
                        >
                          {model.enabled ? "关闭" : "开放"}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="hint">
          对外模型名默认等于上游模型名；默认使用该渠道最先添加且启用的账号，不自动轮询或 fallback。
        </p>
      </section>

      <details className="panel advanced-panel">
        <summary>高级：模型映射与 route candidate</summary>
        <div className="panel-title">
          <h3>Route Candidates</h3>
          <div className="actions">
            <button onClick={onAdd}>新增候选</button>
            <button onClick={() => void onSave()}>保存配置</button>
          </div>
        </div>
        <div className="route-list">
          {routes.length === 0 ? (
            <p>暂无路由候选。</p>
          ) : (
            routes.map((route, index) => (
              <div className="route-card" key={route.id}>
                <span className="route-priority">{index + 1}</span>
                <select
                  value={route.virtual_model_id}
                  onChange={(e) => onUpdate(index, { virtual_model_id: e.target.value })}
                >
                  {virtualModels.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name}
                    </option>
                  ))}
                  {virtualModels.length === 0 ? <option value="auto">auto</option> : null}
                </select>
                <select
                  value={route.channel_id}
                  onChange={(e) => onUpdate(index, { channel_id: e.target.value })}
                >
                  {channels.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <select
                  value={route.account_id}
                  onChange={(e) => onUpdate(index, { account_id: e.target.value })}
                >
                  <option value="">请选择账号</option>
                  {accounts
                    .filter((a) => a.channel_id === route.channel_id)
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                </select>
                <input
                  value={route.upstream_model}
                  placeholder="上游模型名"
                  onChange={(e) => onUpdate(index, { upstream_model: e.target.value })}
                />
                <select
                  value={route.client_protocol}
                  onChange={(e) =>
                    onUpdate(index, { client_protocol: e.target.value as ProtocolType })
                  }
                >
                  <option value="openai">OpenAI-compatible</option>
                  <option value="anthropic">Anthropic-compatible</option>
                </select>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={route.enabled}
                    onChange={(e) => onUpdate(index, { enabled: e.target.checked })}
                  />
                  启用
                </label>
                <button onClick={() => onRemove(index)}>删除</button>
              </div>
            ))
          )}
        </div>
      </details>

      <details className="panel advanced-panel">
        <summary>实验功能：规则路由</summary>
        <div className="panel-title">
          <h3>规则路由（优先于自动路由）</h3>
          <div className="actions">
            <button onClick={onAddRouteRule}>新增规则</button>
            <button onClick={() => void onSaveRouteRules()}>保存规则</button>
          </div>
        </div>
        <p className="hint">
          当请求匹配规则条件时，强制路由到指定渠道账号。规则按优先级排序，首个匹配的规则生效。
        </p>
        <div className="route-list">
          {routeRules.length === 0 ? (
            <p>暂无规则路由。自动路由将按账号优先级和路由候选进行匹配。</p>
          ) : (
            routeRules.map((rule, index) => (
              <div className="route-card" key={rule.id}>
                <span className="route-priority">{index + 1}</span>
                <input
                  value={rule.name}
                  placeholder="规则名称"
                  onChange={(e) => onUpdateRouteRule(index, { name: e.target.value })}
                />
                <select
                  value={rule.match_client_id ?? ""}
                  onChange={(e) =>
                    onUpdateRouteRule(index, {
                      match_client_id: e.target.value || null,
                    })
                  }
                >
                  <option value="">所有客户端</option>
                  {clients.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <input
                  value={rule.match_model ?? ""}
                  placeholder="匹配模型（空=全部）"
                  onChange={(e) =>
                    onUpdateRouteRule(index, {
                      match_model: e.target.value || null,
                    })
                  }
                />
                <select
                  value={rule.match_protocol ?? ""}
                  onChange={(e) =>
                    onUpdateRouteRule(index, {
                      match_protocol: (e.target.value || null) as ProtocolType | null,
                    })
                  }
                >
                  <option value="">所有协议</option>
                  <option value="openai">OpenAI-compatible</option>
                  <option value="anthropic">Anthropic-compatible</option>
                </select>
                <select
                  value={rule.target_channel_id}
                  onChange={(e) =>
                    onUpdateRouteRule(index, { target_channel_id: e.target.value })
                  }
                >
                  {channels.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <select
                  value={rule.target_account_id}
                  onChange={(e) =>
                    onUpdateRouteRule(index, { target_account_id: e.target.value })
                  }
                >
                  {accounts
                    .filter((a) => a.channel_id === rule.target_channel_id)
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                </select>
                <input
                  value={rule.target_upstream_model}
                  placeholder="上游模型"
                  onChange={(e) =>
                    onUpdateRouteRule(index, { target_upstream_model: e.target.value })
                  }
                />
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={rule.enabled}
                    onChange={(e) => onUpdateRouteRule(index, { enabled: e.target.checked })}
                  />
                  启用
                </label>
                <button onClick={() => onRemoveRouteRule(index)}>删除</button>
              </div>
            ))
          )}
        </div>
      </details>
    </>
  );
}
