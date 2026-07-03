import {
  ChannelAccount,
  ChannelPreset,
  ClientConfig,
  ModelPrice,
  ProtocolType,
  RouteCandidate,
  RouteRule,
  VirtualModel
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
  getChannelName,
  getAccountName,
  prices,
  onAddPrice,
  onUpdatePrice,
  onRemovePrice,
  onSavePrices,
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
  getChannelName: (channelId: string) => string;
  getAccountName: (accountId: string) => string;
  prices: ModelPrice[];
  onAddPrice: () => void;
  onUpdatePrice: (index: number, patch: Partial<ModelPrice>) => void;
  onRemovePrice: (index: number) => void;
  onSavePrices: () => void;
  routeRules: RouteRule[];
  onAddRouteRule: () => void;
  onUpdateRouteRule: (index: number, patch: Partial<RouteRule>) => void;
  onRemoveRouteRule: (index: number) => void;
  onSaveRouteRules: () => void;
  clients: ClientConfig[];
}) {
  return (
    <>
      <section className="panel">
        <div className="panel-title">
          <h3>路由配置 (虚拟模型: auto)</h3>
          <div className="actions">
            <button onClick={onAdd}>新增候选</button>
            <button onClick={() => void onSave()}>保存配置</button>
          </div>
        </div>
        <div className="route-list">
          {routes.length === 0 ? (
            <div className="empty-state">
              <p>你还没有配置路由。</p>
              <p>请先新增渠道账号，然后将账号加入 auto 路由。</p>
              <div className="actions">
                <button onClick={onAdd}>新增路由</button>
              </div>
            </div>
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
      </section>
      <section className="panel">
        <div className="panel-title">
          <h3>模型价格表（三段价格）</h3>
          <div className="actions">
            <button onClick={onAddPrice}>新增价格</button>
            <button onClick={() => void onSavePrices()}>保存价格</button>
          </div>
        </div>
        <div className="price-list">
          {prices.length === 0 ? (
            <p>暂无模型价格</p>
          ) : (
            prices.map((price, index) => (
              <div className="price-row-3" key={price.id}>
                <select
                  value={price.channel_id}
                  onChange={(e) => onUpdatePrice(index, { channel_id: e.target.value })}
                >
                  {channels.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <input
                  value={price.upstream_model}
                  placeholder="模型名"
                  onChange={(e) => onUpdatePrice(index, { upstream_model: e.target.value })}
                />
                <input
                  type="number"
                  min="0"
                  step="0.000001"
                  value={price.input_uncached_price}
                  placeholder="输入(未命中缓存)"
                  onChange={(e) =>
                    onUpdatePrice(index, { input_uncached_price: Number(e.target.value) })
                  }
                />
                <input
                  type="number"
                  min="0"
                  step="0.000001"
                  value={price.input_cached_price}
                  placeholder="输入(命中缓存)"
                  onChange={(e) =>
                    onUpdatePrice(index, { input_cached_price: Number(e.target.value) })
                  }
                />
                <input
                  type="number"
                  min="0"
                  step="0.000001"
                  value={price.output_price}
                  placeholder="输出"
                  onChange={(e) => onUpdatePrice(index, { output_price: Number(e.target.value) })}
                />
                <button onClick={() => onRemovePrice(index)}>删除</button>
              </div>
            ))
          )}
        </div>
      </section>
      <section className="panel">
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
      </section>
    </>
  );
}
