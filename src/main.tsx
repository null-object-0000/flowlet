import React from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import "./styles.css";

type ProxyStatus = {
  running: boolean;
  bind_addr: string;
};

type ProviderConfig = {
  name: string;
  base_url: string;
  api_key: string;
  api_key_storage?: "Plaintext";
  default_model: string;
  upstream_timeout_seconds: number;
  enabled: boolean;
};

type VirtualModelRoute = {
  id: string;
  virtual_model: string;
  provider_name: string;
  upstream_model: string;
  priority: number;
  enabled: boolean;
};

type ClientConfig = {
  id: string;
  name: string;
  token: string;
  app_type: string;
  enabled: boolean;
};

type ModelPrice = {
  id: string;
  provider_id: string;
  model: string;
  input_price: number;
  output_price: number;
  currency: string;
  unit: string;
};

type UsageSummaryRow = {
  date: string;
  client_id: string | null;
  provider_id: string | null;
  upstream_model: string | null;
  request_count: number;
  known_tokens: number;
  unknown_count: number;
  estimated_cost: number;
};

type RequestLogRow = {
  created_at: string;
  client_id: string | null;
  method: string;
  path: string;
  provider_id: string | null;
  public_model: string | null;
  upstream_model: string | null;
  status: number | null;
  latency_ms: number | null;
  is_stream: boolean;
  fallback_count: number;
  route_reason: string | null;
  error_message: string | null;
};

type View = "overview" | "provider" | "clients" | "models" | "logs" | "usage";

type ChannelId = "longcat" | "deepseek";

type ChannelPreset = {
  id: ChannelId;
  name: string;
  mark: string;
  description: string;
  baseUrl: string;
  defaultModel: string;
};

const views: Array<{ id: View; label: string }> = [
  { id: "overview", label: "概览" },
  { id: "provider", label: "渠道账号" },
  { id: "clients", label: "Client Token" },
  { id: "models", label: "虚拟模型" },
  { id: "logs", label: "请求日志" },
  { id: "usage", label: "用量统计" },
];

const channelPresets: ChannelPreset[] = [
  {
    id: "longcat",
    name: "LongCat",
    mark: "LC",
    description: "LongCat 大模型服务",
    baseUrl: "https://api.longcat.chat/openai",
    defaultModel: "LongCat-2.0",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    mark: "DS",
    description: "深度求索大模型服务",
    baseUrl: "https://api.deepseek.com",
    defaultModel: "deepseek-chat",
  },
];

function channelForProvider(provider: ProviderConfig): ChannelPreset {
  return provider.base_url.includes("deepseek") ? channelPresets[1] : channelPresets[0];
}

const 默认Provider: ProviderConfig = {
  name: "LongCat 主账号",
  base_url: "https://api.longcat.chat/openai",
  api_key: "",
  default_model: "LongCat-2.0",
  upstream_timeout_seconds: 120,
  enabled: true,
};

function createAutoRoute(model: string, priority: number): VirtualModelRoute {
  return {
    id: `auto-${priority}-${model || "model"}`,
    virtual_model: "auto",
    provider_name: "default",
    upstream_model: model,
    priority,
    enabled: true,
  };
}

function createClient(index: number): ClientConfig {
  return {
    id: `client-${Date.now()}-${index}`,
    name: "新客户端",
    token: `flowlet-client-${Date.now()}`,
    app_type: "custom",
    enabled: true,
  };
}

function createModelPrice(index: number): ModelPrice {
  return {
    id: `price-${Date.now()}-${index}`,
    provider_id: "default",
    model: "",
    input_price: 0,
    output_price: 0,
    currency: "USD",
    unit: "1M tokens",
  };
}

function App() {
  const [status, setStatus] = React.useState<ProxyStatus>({
    running: false,
    bind_addr: "127.0.0.1:11434",
  });
  const [provider, setProvider] = React.useState<ProviderConfig>(默认Provider);
  const [routes, setRoutes] = React.useState<VirtualModelRoute[]>([
    createAutoRoute(默认Provider.default_model, 0),
  ]);
  const [usageRows, setUsageRows] = React.useState<UsageSummaryRow[]>([]);
  const [requestLogs, setRequestLogs] = React.useState<RequestLogRow[]>([]);
  const [clients, setClients] = React.useState<ClientConfig[]>([]);
  const [prices, setPrices] = React.useState<ModelPrice[]>([]);
  const [view, setView] = React.useState<View>("overview");
  const [message, setMessage] = React.useState("");
  const [accountDraft, setAccountDraft] = React.useState<ProviderConfig | null>(null);
  const [accountMode, setAccountMode] = React.useState<"add" | "edit">("add");

  const refreshStatus = React.useCallback(async () => {
    const next = await invoke<ProxyStatus>("proxy_status");
    setStatus(next);
  }, []);

  React.useEffect(() => {
    refreshStatus().catch(() => setMessage("读取代理状态失败"));
    invoke<ProviderConfig>("get_provider")
      .then(setProvider)
      .catch(() => setProvider(默认Provider));
    invoke<VirtualModelRoute[]>("list_virtual_model_routes")
      .then((next) => {
        if (next.length > 0) {
          setRoutes(next);
        }
      })
      .catch(() => setRoutes([createAutoRoute(默认Provider.default_model, 0)]));
    invoke<ClientConfig[]>("list_clients")
      .then(setClients)
      .catch(() => setClients([]));
    invoke<ModelPrice[]>("list_model_prices")
      .then(setPrices)
      .catch(() => setPrices([]));
    refreshUsage().catch(() => setUsageRows([]));
    refreshLogs().catch(() => setRequestLogs([]));
  }, [refreshStatus]);

  async function startProxy() {
    await invoke("save_provider", { provider });
    await invoke("save_virtual_model_routes", { routes: normalizeRoutes(routes, provider.default_model) });
    await invoke("start_proxy");
    await refreshStatus();
    setMessage("本地代理已启动");
  }

  function openAddAccount() {
    const preset = channelPresets[0];
    setAccountMode("add");
    setAccountDraft({
      ...默认Provider,
      name: `${preset.name} 主账号`,
      base_url: preset.baseUrl,
      default_model: preset.defaultModel,
      api_key: "",
    });
  }

  function openEditAccount() {
    setAccountMode("edit");
    setAccountDraft({ ...provider });
  }

  async function saveAccount() {
    if (!accountDraft) return;
    if (!accountDraft.name.trim() || !accountDraft.api_key.trim()) {
      setMessage("请填写账号名称和 API Key");
      return;
    }
    await invoke("save_provider", { provider: accountDraft });
    setProvider(accountDraft);
    setRoutes((current) => normalizeRoutes(current, accountDraft.default_model));
    setAccountDraft(null);
    setMessage(accountMode === "add" ? "渠道账号已添加" : "渠道账号已更新");
  }

  async function stopProxy() {
    await invoke("stop_proxy");
    await refreshStatus();
    setMessage("本地代理已停止");
  }

  async function copy(text: string, done: string) {
    await navigator.clipboard.writeText(text);
    setMessage(done);
  }

  async function saveRoutes() {
    const next = normalizeRoutes(routes, provider.default_model);
    await invoke("save_virtual_model_routes", { routes: next });
    setRoutes(next);
    setMessage("虚拟模型路由已保存");
  }

  async function saveClientTokens() {
    const next = clients.filter((client) => client.name.trim() && client.token.trim());
    await invoke("save_clients", { clients: next });
    setClients(next);
    setMessage("Client Token 已保存");
  }

  function addClient() {
    setClients((current) => [...current, createClient(current.length)]);
  }

  function updateClient(index: number, patch: Partial<ClientConfig>) {
    setClients((current) =>
      current.map((client, clientIndex) =>
        clientIndex === index
          ? {
              ...client,
              ...patch,
            }
          : client,
      ),
    );
  }

  function removeClient(index: number) {
    setClients((current) => current.filter((_, clientIndex) => clientIndex !== index));
  }

  async function savePrices() {
    const next = prices.filter((price) => price.model.trim());
    await invoke("save_model_prices", { prices: next });
    setPrices(next);
    setMessage("模型价格已保存");
  }

  function addPrice() {
    setPrices((current) => [...current, createModelPrice(current.length)]);
  }

  function updatePrice(index: number, patch: Partial<ModelPrice>) {
    setPrices((current) =>
      current.map((price, priceIndex) =>
        priceIndex === index
          ? {
              ...price,
              ...patch,
            }
          : price,
      ),
    );
  }

  function removePrice(index: number) {
    setPrices((current) => current.filter((_, priceIndex) => priceIndex !== index));
  }

  async function refreshUsage() {
    const rows = await invoke<UsageSummaryRow[]>("usage_summary");
    setUsageRows(rows);
  }

  async function refreshLogs() {
    const rows = await invoke<RequestLogRow[]>("list_request_logs");
    setRequestLogs(rows);
  }

  async function analyzeUsage() {
    const count = await invoke<number>("analyze_usage");
    await refreshUsage();
    await refreshLogs();
    setMessage(`离线分析完成，新增 ${count} 条 unknown 用量记录`);
  }

  function updateRoute(index: number, model: string) {
    setRoutes((current) =>
      current.map((route, routeIndex) =>
        routeIndex === index
          ? {
              ...route,
              id: route.id || `auto-${routeIndex}-${model || "model"}`,
              upstream_model: model,
            }
          : route,
      ),
    );
  }

  function addRoute() {
    setRoutes((current) => [...current, createAutoRoute("", current.length)]);
  }

  function removeRoute(index: number) {
    setRoutes((current) =>
      normalizeRoutes(
        current.filter((_, routeIndex) => routeIndex !== index),
        provider.default_model,
      ),
    );
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div>
          <h1>Flowlet</h1>
          <p>本地 AI 请求路由客户端</p>
        </div>
        <nav>
          {views.map((item) => (
            <button
              className={view === item.id ? "nav-item active" : "nav-item"}
              key={item.id}
              onClick={() => setView(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </aside>

      <section className="content">
        <header className="topbar">
          <div>
            <h2>代理服务</h2>
            <p>{status.running ? "正在监听本地请求" : "代理服务未启动"}</p>
          </div>
          <div className="topbar-actions">
            <button onClick={startProxy} disabled={status.running}>
              启动
            </button>
            <button onClick={stopProxy} disabled={!status.running}>
              停止
            </button>
            <div className={status.running ? "status running" : "status"}>
              {status.running ? "运行中" : "已停止"}
            </div>
          </div>
        </header>

        {view === "overview" ? (
        <section className="panel">
          <div className="panel-title">
            <h3>接入信息</h3>
            <div className="actions">
              <button onClick={() => copy("http://127.0.0.1:11434/v1", "Base URL 已复制")}>
                复制 Base URL
              </button>
              <button onClick={() => copy("Bearer flowlet-local-token", "Client Token 已复制")}>
                复制 Client Token
              </button>
            </div>
          </div>
          <div className="info-grid">
            <label>
              Base URL
              <input readOnly value="http://127.0.0.1:11434/v1" />
            </label>
            <label>
              健康检查
              <input readOnly value="http://127.0.0.1:11434/health" />
            </label>
          </div>
        </section>
        ) : null}

        {view === "clients" ? (
        <section className="panel">
          <div className="panel-title">
            <h3>Client Token</h3>
            <div className="actions">
              <button onClick={addClient}>新增客户端</button>
              <button onClick={saveClientTokens}>保存 Token</button>
            </div>
          </div>
          <div className="client-list">
            {clients.length === 0 ? (
              <p>暂无客户端 Token</p>
            ) : (
              clients.map((client, index) => (
                <div className="client-row" key={client.id}>
                  <input
                    value={client.name}
                    placeholder="客户端名称"
                    onChange={(event) => updateClient(index, { name: event.target.value })}
                  />
                  <input
                    value={client.token}
                    placeholder="Client Token"
                    onChange={(event) => updateClient(index, { token: event.target.value })}
                  />
                  <button onClick={() => copy(`Bearer ${client.token}`, "Client Token 已复制")}>
                    复制
                  </button>
                  <button onClick={() => removeClient(index)}>删除</button>
                </div>
              ))
            )}
          </div>
        </section>
        ) : null}

        {view === "provider" ? (
          <>
            <section className="account-heading">
              <div>
                <h2>渠道账号</h2>
                <p>管理上游渠道账号，用于模型转发</p>
              </div>
              <button className="primary-button" onClick={openAddAccount}>＋ 新增账号</button>
            </section>

            <section className="account-stats">
              <div className="stat-card">
                <span>渠道总数</span>
                <strong>1 <small>个</small></strong>
              </div>
              <div className="stat-card">
                <span>启用中</span>
                <strong>{provider.enabled ? 1 : 0} <small>个</small></strong>
              </div>
              <div className="stat-card stat-wide">
                <span>当前上游</span>
                <strong>{channelForProvider(provider).name}</strong>
              </div>
            </section>

            <section className="account-table-card">
              <div className="account-toolbar">
                <div className="search-box">⌕ <input aria-label="搜索账号" placeholder="搜索账号名称或渠道" /></div>
                <span>共 1 条</span>
              </div>
              <div className="account-table-head">
                <span>账号名称</span><span>渠道</span><span>默认模型</span><span>状态</span><span>操作</span>
              </div>
              <div className="account-table-row">
                <div className="account-name-cell">
                  <span className={`channel-logo ${channelForProvider(provider).id}`}>{channelForProvider(provider).mark}</span>
                  <div><strong>{provider.name}</strong><small>OpenAI-compatible</small></div>
                </div>
                <strong>{channelForProvider(provider).name}</strong>
                <span>{provider.default_model}</span>
                <span className={provider.enabled ? "enabled-pill" : "disabled-pill"}>{provider.enabled ? "启用" : "已停用"}</span>
                <button className="text-button" onClick={openEditAccount}>编辑</button>
              </div>
            </section>
          </>
        ) : null}

        {view === "models" ? (
        <section className="panel">
          <div className="panel-title">
            <h3>虚拟模型 auto</h3>
            <div className="actions">
              <button onClick={addRoute}>新增候选</button>
              <button onClick={saveRoutes}>保存路由</button>
            </div>
          </div>
          <div className="route-list">
            {routes.map((route, index) => (
              <div className="route-row" key={`${route.id}-${index}`}>
                <span>{index + 1}</span>
                <input
                  value={route.upstream_model}
                  placeholder="上游模型名，例如 gpt-4o-mini"
                  onChange={(event) => updateRoute(index, event.target.value)}
                />
                <button onClick={() => removeRoute(index)} disabled={routes.length <= 1}>
                  删除
                </button>
              </div>
            ))}
          </div>
        </section>
        ) : null}

        {view === "models" ? (
        <section className="panel">
          <div className="panel-title">
            <h3>模型价格表</h3>
            <div className="actions">
              <button onClick={addPrice}>新增价格</button>
              <button onClick={savePrices}>保存价格</button>
            </div>
          </div>
          <div className="price-list">
            {prices.length === 0 ? (
              <p>暂无模型价格</p>
            ) : (
              prices.map((price, index) => (
                <div className="price-row" key={price.id}>
                  <input
                    value={price.model}
                    placeholder="模型名"
                    onChange={(event) => updatePrice(index, { model: event.target.value })}
                  />
                  <input
                    type="number"
                    min="0"
                    step="0.000001"
                    value={price.input_price}
                    placeholder="输入价格"
                    onChange={(event) =>
                      updatePrice(index, { input_price: Number(event.target.value) })
                    }
                  />
                  <input
                    type="number"
                    min="0"
                    step="0.000001"
                    value={price.output_price}
                    placeholder="输出价格"
                    onChange={(event) =>
                      updatePrice(index, { output_price: Number(event.target.value) })
                    }
                  />
                  <input
                    value={price.currency}
                    placeholder="币种"
                    onChange={(event) => updatePrice(index, { currency: event.target.value })}
                  />
                  <button onClick={() => removePrice(index)}>删除</button>
                </div>
              ))
            )}
          </div>
        </section>
        ) : null}

        {view === "overview" ? (
        <section className="panel compact">
          <h3>当前阶段</h3>
          <p>
            已建立桌面端骨架、本地代理 Core、SQLite 基础存储、auto 顺序路由和离线用量分析雏形。
          </p>
        </section>
        ) : null}

        {view === "usage" ? (
        <section className="panel">
          <div className="panel-title">
            <h3>基础用量统计</h3>
            <div className="actions">
              <button onClick={analyzeUsage}>执行离线分析</button>
              <button onClick={refreshUsage}>刷新</button>
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>日期</th>
                  <th>客户端</th>
                  <th>Provider</th>
                  <th>上游模型</th>
                  <th>请求数</th>
                  <th>已知 Token</th>
                  <th>未知</th>
                  <th>估算成本</th>
                </tr>
              </thead>
              <tbody>
                {usageRows.length === 0 ? (
                  <tr>
                    <td colSpan={8}>暂无用量数据</td>
                  </tr>
                ) : (
                  usageRows.map((row, index) => (
                    <tr key={`${row.date}-${row.provider_id}-${row.upstream_model}-${index}`}>
                      <td>{row.date}</td>
                      <td>{row.client_id || "未知"}</td>
                      <td>{row.provider_id || "未知"}</td>
                      <td>{row.upstream_model || "未知"}</td>
                      <td>{row.request_count}</td>
                      <td>{row.known_tokens}</td>
                      <td>{row.unknown_count}</td>
                      <td>{row.estimated_cost.toFixed(6)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
        ) : null}

        {view === "logs" ? (
        <section className="panel">
          <div className="panel-title">
            <h3>请求日志</h3>
            <div className="actions">
              <button onClick={refreshLogs}>刷新</button>
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>时间</th>
                  <th>客户端</th>
                  <th>方法</th>
                  <th>路径</th>
                  <th>公开模型</th>
                  <th>上游模型</th>
                  <th>状态</th>
                  <th>耗时</th>
                  <th>流式</th>
                  <th>降级</th>
                  <th>原因</th>
                </tr>
              </thead>
              <tbody>
                {requestLogs.length === 0 ? (
                  <tr>
                    <td colSpan={11}>暂无请求日志</td>
                  </tr>
                ) : (
                  requestLogs.map((row, index) => (
                    <tr key={`${row.created_at}-${row.path}-${index}`}>
                      <td>{row.created_at}</td>
                      <td>{row.client_id || "未知"}</td>
                      <td>{row.method}</td>
                      <td>{row.path}</td>
                      <td>{row.public_model || "未记录"}</td>
                      <td>{row.upstream_model || "未记录"}</td>
                      <td>{row.status ?? "无"}</td>
                      <td>{row.latency_ms == null ? "未知" : `${row.latency_ms} ms`}</td>
                      <td>{row.is_stream ? "是" : "否"}</td>
                      <td>{row.fallback_count}</td>
                      <td>{row.route_reason || row.error_message || "无"}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
        ) : null}

        {message ? <div className="toast">{message}</div> : null}
      </section>

      {accountDraft ? (
        <AccountDrawer
          mode={accountMode}
          value={accountDraft}
          onChange={setAccountDraft}
          onClose={() => setAccountDraft(null)}
          onSave={saveAccount}
          onTest={() => setMessage("配置格式正确，保存并启动代理后即可验证连接")}
        />
      ) : null}
    </main>
  );
}

type AccountDrawerProps = {
  mode: "add" | "edit";
  value: ProviderConfig;
  onChange: (value: ProviderConfig) => void;
  onClose: () => void;
  onSave: () => void;
  onTest: () => void;
};

function AccountDrawer({ mode, value, onChange, onClose, onSave, onTest }: AccountDrawerProps) {
  const [showKey, setShowKey] = React.useState(false);
  const [showAdvanced, setShowAdvanced] = React.useState(false);
  const activeChannel = channelForProvider(value);

  function selectChannel(preset: ChannelPreset) {
    onChange({
      ...value,
      name: mode === "add" ? `${preset.name} 主账号` : value.name,
      base_url: preset.baseUrl,
      default_model: preset.defaultModel,
    });
  }

  return (
    <div className="drawer-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="account-drawer" role="dialog" aria-modal="true" aria-labelledby="account-drawer-title">
        <header className="drawer-header">
          <div>
            <h2 id="account-drawer-title">{mode === "add" ? "新增渠道账号" : "编辑渠道账号"}</h2>
            <p>{mode === "add" ? "添加 LongCat 或 DeepSeek 账号，用于上游模型转发" : `更新 ${value.name} 的连接配置`}</p>
          </div>
          <button className="close-button" aria-label="关闭" onClick={onClose}>×</button>
        </header>

        <div className="drawer-body">
          <section className="form-section">
            <h3>基础信息</h3>
            <label>选择渠道</label>
            <div className="channel-options">
              {channelPresets.map((preset) => (
                <button
                  key={preset.id}
                  className={activeChannel.id === preset.id ? "channel-option selected" : "channel-option"}
                  onClick={() => selectChannel(preset)}
                >
                  <span className={`channel-logo ${preset.id}`}>{preset.mark}</span>
                  <span><strong>{preset.name}</strong><small>{preset.description}</small></span>
                  <i>{activeChannel.id === preset.id ? "✓" : ""}</i>
                </button>
              ))}
            </div>

            <label htmlFor="account-name">账号名称</label>
            <div className="input-with-count">
              <input id="account-name" maxLength={50} value={value.name} onChange={(event) => onChange({ ...value, name: event.target.value })} />
              <span>{value.name.length} / 50</span>
            </div>

            <label htmlFor="api-key">API Key</label>
            <div className="secret-input">
              <input id="api-key" type={showKey ? "text" : "password"} placeholder="请输入渠道 API Key" value={value.api_key} onChange={(event) => onChange({ ...value, api_key: event.target.value })} />
              <button onClick={() => setShowKey((current) => !current)}>{showKey ? "隐藏" : "显示"}</button>
              <button onClick={() => navigator.clipboard.readText().then((text) => onChange({ ...value, api_key: text }))}>粘贴</button>
            </div>

            <div className="switch-row">
              <div><strong>启用状态</strong><small>停用后，该账号不会参与请求转发</small></div>
              <button className={value.enabled ? "switch on" : "switch"} role="switch" aria-checked={value.enabled} onClick={() => onChange({ ...value, enabled: !value.enabled })}><span /></button>
              <span>{value.enabled ? "已启用" : "已停用"}</span>
            </div>
          </section>

          <section className="advanced-section">
            <button className="advanced-toggle" onClick={() => setShowAdvanced((current) => !current)}>
              <span><strong>高级设置</strong><small>自定义连接地址、模型和超时时间</small></span>
              <b>{showAdvanced ? "⌃" : "⌄"}</b>
            </button>
            {showAdvanced ? (
              <div className="advanced-fields">
                <label>Base URL<input value={value.base_url} onChange={(event) => onChange({ ...value, base_url: event.target.value })} /></label>
                <label>默认模型<input value={value.default_model} onChange={(event) => onChange({ ...value, default_model: event.target.value })} /></label>
                <label>上游超时（秒）<input type="number" min="1" value={value.upstream_timeout_seconds} onChange={(event) => onChange({ ...value, upstream_timeout_seconds: Math.max(1, Number(event.target.value) || 120) })} /></label>
              </div>
            ) : null}
          </section>
        </div>

        <footer className="drawer-footer">
          <button onClick={onClose}>取消</button>
          <button onClick={onTest}>⌁ 测试连接</button>
          <button className="primary-button" onClick={onSave}>{mode === "add" ? "保存账号" : "保存修改"}</button>
        </footer>
      </aside>
    </div>
  );
}

function normalizeRoutes(routes: VirtualModelRoute[], fallbackModel: string): VirtualModelRoute[] {
  const normalized = routes
    .map((route, index) => ({
      ...route,
      id: route.id || `auto-${index}-${route.upstream_model || "model"}`,
      virtual_model: "auto",
      provider_name: "default",
      priority: index,
      enabled: true,
      upstream_model: route.upstream_model.trim(),
    }))
    .filter((route) => route.upstream_model.length > 0);

  return normalized.length > 0 ? normalized : [createAutoRoute(fallbackModel, 0)];
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
