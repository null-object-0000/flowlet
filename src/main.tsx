import React from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import "./styles.css";

// ─── Types ───────────────────────────────────────────────────────────────────

type ProtocolType = "openai" | "anthropic";

type ProxyStatus = {
  running: boolean;
  bind_addr: string;
};

type ChannelPreset = {
  id: string;
  name: string;
  vendor: string;
  supported_protocols: ProtocolType[];
  openai_base_url: string;
  anthropic_base_url: string;
  default_model: string;
  supports_model_list: boolean;
  supports_balance_query: boolean;
  small_model: string | null;
  created_at: string;
  updated_at: string;
};

type ChannelAccount = {
  id: string;
  channel_id: string;
  name: string;
  api_key: string;
  enabled: boolean;
  priority: number;
  remark?: string;
  last_used_at?: string;
  last_error?: string;
  created_at: string;
  updated_at: string;
};

type RouteCandidate = {
  id: string;
  virtual_model_id: string;
  channel_id: string;
  account_id: string;
  upstream_model: string;
  client_protocol: ProtocolType;
  priority: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

type ClientConfig = {
  id: string;
  name: string;
  token: string;
  app_type: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

type ModelPrice = {
  id: string;
  channel_id: string;
  upstream_model: string;
  input_uncached_price: number;
  input_cached_price: number;
  output_price: number;
  currency: string;
  unit: string;
  source: string;
  synced_at?: string;
  created_at: string;
  updated_at: string;
};

type VirtualModel = {
  id: string;
  name: string;
  protocol_type: ProtocolType;
  routing_strategy: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

type UsageSummaryRow = {
  date: string;
  client_id: string | null;
  client_name: string | null;
  channel_id: string | null;
  channel_name: string | null;
  account_id: string | null;
  account_name: string | null;
  upstream_model: string | null;
  request_count: number;
  known_tokens: number;
  unknown_count: number;
  estimated_cost: number;
};

type RequestLogRow = {
  id: string;
  request_id: string;
  client_id: string | null;
  client_name: string | null;
  channel_id: string | null;
  channel_name: string | null;
  account_id: string | null;
  account_name: string | null;
  client_protocol: string;
  upstream_protocol: string;
  virtual_model: string | null;
  public_model: string | null;
  upstream_model: string | null;
  request_type: string;
  method: string;
  path: string;
  status: number | null;
  latency_ms: number | null;
  is_stream: boolean;
  error_message: string | null;
  fallback_count: number;
  route_reason: string | null;
  created_at: string;
};

type AccountBalanceSnapshot = {
  id: string;
  account_id: string;
  balance: number | null;
  currency: string | null;
  token_pack_total: number | null;
  token_pack_used: number | null;
  token_pack_remaining: number | null;
  token_pack_expire_at: string | null;
  source: string;
  synced_at: string | null;
  remark: string | null;
  created_at: string;
  updated_at: string;
};

type RouteRule = {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  match_client_id: string | null;
  match_model: string | null;
  match_protocol: ProtocolType | null;
  target_channel_id: string;
  target_account_id: string;
  target_upstream_model: string;
  created_at: string;
  updated_at: string;
};

type AccountStatsRow = {
  account_id: string;
  account_name: string | null;
  channel_id: string | null;
  channel_name: string | null;
  total_requests: number;
  success_requests: number;
  failed_requests: number;
  failure_rate: number;
  total_fallbacks: number;
  known_tokens: number;
  estimated_cost: number;
  last_error: string | null;
  last_error_at: string | null;
  last_used_at: string | null;
};

type View = "overview" | "channels" | "claude" | "clients" | "routes" | "logs" | "usage" | "stats";

const views: Array<{ id: View; label: string }> = [
  { id: "overview", label: "概览" },
  { id: "channels", label: "渠道账号" },
  { id: "claude", label: "Claude Code" },
  { id: "clients", label: "客户端 Token" },
  { id: "routes", label: "路由配置" },
  { id: "stats", label: "账号统计" },
  { id: "logs", label: "请求日志" },
  { id: "usage", label: "用量统计" },
];

const protocolLabels: Record<ProtocolType, string> = {
  openai: "OpenAI-compatible",
  anthropic: "Anthropic-compatible",
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createAccount(channelId: string, index: number): ChannelAccount {
  const now = new Date().toISOString();
  return {
    id: genId("account"),
    channel_id: channelId,
    name: `账号 ${index + 1}`,
    api_key: "",
    enabled: true,
    priority: index,
    remark: "",
    last_used_at: undefined,
    last_error: undefined,
    created_at: now,
    updated_at: now,
  };
}

function createClient(index: number): ClientConfig {
  const now = new Date().toISOString();
  return {
    id: genId("client"),
    name: "新客户端",
    token: `flowlet-${genId("token").slice(-12)}`,
    app_type: "custom",
    enabled: true,
    created_at: now,
    updated_at: now,
  };
}

function createModelPrice(channelId: string, index: number): ModelPrice {
  const now = new Date().toISOString();
  return {
    id: genId("price"),
    channel_id: channelId,
    upstream_model: "",
    input_uncached_price: 0,
    input_cached_price: 0,
    output_price: 0,
    currency: "USD",
    unit: "1M tokens",
    source: "preset",
    synced_at: undefined,
    created_at: now,
    updated_at: now,
  };
}

function createRouteCandidate(
  virtualModelId: string,
  channelId: string,
  accountId: string,
  upstreamModel: string,
  protocol: ProtocolType,
  priority: number
): RouteCandidate {
  const now = new Date().toISOString();
  return {
    id: genId("route"),
    virtual_model_id: virtualModelId,
    channel_id: channelId,
    account_id: accountId,
    upstream_model: upstreamModel,
    client_protocol: protocol,
    priority,
    enabled: true,
    created_at: now,
    updated_at: now,
  };
}

// ─── App ─────────────────────────────────────────────────────────────────────

function App() {
  const [channels, setChannels] = React.useState<ChannelPreset[]>([]);
  const [accounts, setAccounts] = React.useState<ChannelAccount[]>([]);
  const [routes, setRoutes] = React.useState<RouteCandidate[]>([]);
  const [clients, setClients] = React.useState<ClientConfig[]>([]);
  const [prices, setPrices] = React.useState<ModelPrice[]>([]);
  const [virtualModels, setVirtualModels] = React.useState<VirtualModel[]>([]);
  const [usageRows, setUsageRows] = React.useState<UsageSummaryRow[]>([]);
  const [requestLogs, setRequestLogs] = React.useState<RequestLogRow[]>([]);
  const [balanceSnapshots, setBalanceSnapshots] = React.useState<AccountBalanceSnapshot[]>([]);
  const [routeRules, setRouteRules] = React.useState<RouteRule[]>([]);
  const [accountStats, setAccountStats] = React.useState<AccountStatsRow[]>([]);
  const [routingScores, setRoutingScores] = React.useState<Array<[string, string, number, number, number]>>([]);
  const [dbStats, setDbStats] = React.useState<[number, number, number] | null>(null);
  const [autostartEnabled, setAutostartEnabled] = React.useState(false);
  const [status, setStatus] = React.useState<ProxyStatus>({
    running: false,
    bind_addr: "127.0.0.1:11434",
  });
  const [view, setView] = React.useState<View>("overview");
  const [message, setMessage] = React.useState("");

  const refreshStatus = React.useCallback(async () => {
    const next = await invoke<ProxyStatus>("proxy_status");
    setStatus(next);
  }, []);

  const refreshAll = React.useCallback(async () => {
    const [ch, ac, ro, cl, pr, vm, usage, logs, snapshots, stats, rules, scores, db] = await Promise.all([
      invoke<ChannelPreset[]>("list_channel_presets").catch(() => [] as ChannelPreset[]),
      invoke<ChannelAccount[]>("list_channel_accounts").catch(() => [] as ChannelAccount[]),
      invoke<RouteCandidate[]>("list_route_candidates").catch(() => [] as RouteCandidate[]),
      invoke<ClientConfig[]>("list_clients").catch(() => [] as ClientConfig[]),
      invoke<ModelPrice[]>("list_model_prices").catch(() => [] as ModelPrice[]),
      invoke<VirtualModel[]>("list_virtual_models").catch(() => [] as VirtualModel[]),
      invoke<UsageSummaryRow[]>("usage_summary").catch(() => [] as UsageSummaryRow[]),
      invoke<RequestLogRow[]>("list_request_logs").catch(() => [] as RequestLogRow[]),
      invoke<AccountBalanceSnapshot[]>("latest_balance_snapshots").catch(
        () => [] as AccountBalanceSnapshot[]
      ),
      invoke<AccountStatsRow[]>("account_stats").catch(() => [] as AccountStatsRow[]),
      invoke<RouteRule[]>("list_route_rules").catch(() => [] as RouteRule[]),
      invoke<Array<[string, string, number, number, number]>>("account_routing_scores").catch(
        () => [] as Array<[string, string, number, number, number]>
      ),
      invoke<[number, number, number]>("db_stats").catch(() => [0, 0, 0] as [number, number, number]),
    ]);
    // 检查自启动状态
    invoke<boolean>("is_autostart_enabled")
      .then(setAutostartEnabled)
      .catch(() => setAutostartEnabled(false));
    setChannels(ch);
    setAccounts(ac);
    setRoutes(ro);
    setClients(cl);
    setPrices(pr);
    setVirtualModels(vm);
    setUsageRows(usage);
    setRequestLogs(logs);
    setBalanceSnapshots(snapshots);
    setAccountStats(stats);
    setRouteRules(rules);
    setRoutingScores(scores);
    setDbStats(db);
  }, []);

  React.useEffect(() => {
    refreshStatus().catch(() => setMessage("读取代理状态失败"));
    refreshAll().catch(() => setMessage("初始化数据加载失败"));
  }, [refreshStatus, refreshAll]);

  function startProxy() {
    return invoke("start_proxy")
      .then(async () => {
        await refreshStatus();
        setMessage("本地代理已启动");
      })
      .catch((err: unknown) => setMessage(`启动失败: ${String(err)}`));
  }

  function stopProxy() {
    return invoke("stop_proxy")
      .then(async () => {
        await refreshStatus();
        setMessage("本地代理已停止");
      })
      .catch((err: unknown) => setMessage(`停止失败: ${String(err)}`));
  }

  async function copy(text: string, done: string) {
    await navigator.clipboard.writeText(text);
    setMessage(done);
  }

  async function saveChannels() {
    await invoke("save_channel_presets", { presets: channels });
    setMessage("渠道模板已保存");
  }

  async function saveAccounts() {
    const filtered = accounts.filter(
      (a) => a.name.trim() && a.channel_id.trim()
    );
    await invoke("save_channel_accounts", { accounts: filtered });
    setAccounts(filtered);
    setMessage("渠道账号已保存");
  }

  async function saveRouteCandidates() {
    await invoke("save_route_candidates", { routes });
    setMessage("路由配置已保存");
  }

  async function saveRouteRules() {
    const filtered = routeRules.filter((r) => r.name.trim() && r.target_channel_id.trim());
    await invoke("save_route_rules", { rules: filtered });
    setRouteRules(filtered);
    setMessage("路由规则已保存");
  }

  async function saveClientTokens() {
    const filtered = clients.filter((c) => c.name.trim() && c.token.trim());
    await invoke("save_clients", { clients: filtered });
    setClients(filtered);
    setMessage("客户端 Token 已保存");
  }

  async function savePrices() {
    const filtered = prices.filter((p) => p.upstream_model.trim() && p.channel_id.trim());
    await invoke("save_model_prices", { prices: filtered });
    setPrices(filtered);
    setMessage("价格表已保存");
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
    setMessage(`离线分析完成，新增 ${count} 条用量记录`);
  }

  function addAccount(channelId: string) {
    const existing = accounts.filter((a) => a.channel_id === channelId);
    setAccounts((current) => [...current, createAccount(channelId, existing.length)]);
  }

  async function testConnection(accountId: string) {
    setMessage("正在测试连接...");
    try {
      const result = await invoke<{ balance: number | null; currency: string | null; is_available: boolean; error: string | null }>(
        "query_balance",
        { accountId }
      );
      if (result.error) {
        setMessage(`连接失败: ${result.error}`);
      } else if (result.balance !== null) {
        setMessage(`连接成功！余额: ${result.balance} ${result.currency ?? ""}`);
      } else if (result.is_available) {
        setMessage("连接成功！（无余额信息）");
      } else {
        setMessage("连接失败：请检查 API Key 是否正确");
      }
    } catch (err: unknown) {
      setMessage(`测试失败: ${String(err)}`);
    }
  }

  async function syncModels(accountId: string) {
    setMessage("正在同步模型列表...");
    try {
      const result = await invoke<{ models_synced: number; errors: string[] }>("sync_models", {
        accountId,
      });
      if (result.errors.length > 0) {
        setMessage(`同步失败: ${result.errors[0]}`);
      } else {
        setMessage(`同步成功，获取 ${result.models_synced} 个模型`);
      }
    } catch (err: unknown) {
      setMessage(`同步失败: ${String(err)}`);
    }
  }

  function updateAccount(index: number, patch: Partial<ChannelAccount>) {
    setAccounts((current) =>
      current.map((a, i) => (i === index ? { ...a, ...patch, updated_at: new Date().toISOString() } : a))
    );
  }

  function removeAccount(index: number) {
    setAccounts((current) => current.filter((_, i) => i !== index));
  }

  function addClient() {
    setClients((current) => [...current, createClient(current.length)]);
  }

  function updateClient(index: number, patch: Partial<ClientConfig>) {
    setClients((current) =>
      current.map((c, i) => (i === index ? { ...c, ...patch, updated_at: new Date().toISOString() } : c))
    );
  }

  function removeClient(index: number) {
    setClients((current) => current.filter((_, i) => i !== index));
  }

  function addPrice() {
    const channelId = channels[0]?.id ?? "longcat";
    setPrices((current) => [...current, createModelPrice(channelId, current.length)]);
  }

  function updatePrice(index: number, patch: Partial<ModelPrice>) {
    setPrices((current) =>
      current.map((p, i) => (i === index ? { ...p, ...patch, updated_at: new Date().toISOString() } : p))
    );
  }

  function removePrice(index: number) {
    setPrices((current) => current.filter((_, i) => i !== index));
  }

  function createRouteRule(): RouteRule {
    const now = new Date().toISOString();
    return {
      id: genId("rule"),
      name: "新规则",
      enabled: true,
      priority: 0,
      match_client_id: null,
      match_model: null,
      match_protocol: null,
      target_channel_id: channels[0]?.id ?? "longcat",
      target_account_id: accounts.find((a) => a.channel_id === (channels[0]?.id ?? "longcat"))?.id ?? "",
      target_upstream_model: channels[0]?.default_model ?? "",
      created_at: now,
      updated_at: now,
    };
  }

  function addRouteRule() {
    setRouteRules((current) => [...current, createRouteRule()]);
  }

  function updateRouteRule(index: number, patch: Partial<RouteRule>) {
    setRouteRules((current) =>
      current.map((r, i) => (i === index ? { ...r, ...patch, updated_at: new Date().toISOString() } : r))
    );
  }

  function removeRouteRule(index: number) {
    setRouteRules((current) => current.filter((_, i) => i !== index));
  }

  function addRoute() {
    const channelId = channels[0]?.id ?? "longcat";
    const accountId = accounts.find((a) => a.channel_id === channelId)?.id ?? "";
    const upstreamModel = channels[0]?.default_model ?? "";
    setRoutes((current) => [
      ...current,
      createRouteCandidate("auto", channelId, accountId, upstreamModel, "openai", current.length),
    ]);
  }

  function updateRoute(index: number, patch: Partial<RouteCandidate>) {
    setRoutes((current) =>
      current.map((r, i) => (i === index ? { ...r, ...patch, updated_at: new Date().toISOString() } : r))
    );
  }

  function removeRoute(index: number) {
    setRoutes((current) => current.filter((_, i) => i !== index));
  }

  function getChannelName(channelId: string): string {
    return channels.find((c) => c.id === channelId)?.name ?? channelId;
  }

  function getAccountName(accountId: string): string {
    return accounts.find((a) => a.id === accountId)?.name ?? accountId;
  }

  function getChannelAccounts(channelId: string): ChannelAccount[] {
    return accounts
      .filter((a) => a.channel_id === channelId && a.enabled)
      .sort((a, b) => a.priority - b.priority);
  }

  function getBalanceForAccount(accountId: string): AccountBalanceSnapshot | undefined {
    return balanceSnapshots.find((s) => s.account_id === accountId);
  }

  async function addBalanceSnapshot(snapshot: Omit<AccountBalanceSnapshot, "id" | "created_at" | "updated_at">) {
    const now = new Date().toISOString();
    const full: AccountBalanceSnapshot = {
      ...snapshot,
      id: genId("snap"),
      created_at: now,
      updated_at: now,
    };
    await invoke("save_balance_snapshot", { snapshot: full });
    await refreshAll();
    setMessage("余额快照已保存");
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
            <button onClick={() => void startProxy()} disabled={status.running}>
              启动
            </button>
            <button onClick={() => void stopProxy()} disabled={!status.running}>
              停止
            </button>
            <div className={status.running ? "status running" : "status"}>
              {status.running ? "运行中" : "已停止"}
            </div>
          </div>
        </header>

        {view === "overview" ? (
          <OverviewPanel
            status={{ ...status, channels: channels.length, accounts: accounts.length, clients: clients.length }}
            usageRows={usageRows}
            onCopy={copy}
            autostartEnabled={autostartEnabled}
            onToggleAutostart={() => {
              const fn = autostartEnabled ? "disable_autostart" : "enable_autostart";
              invoke(fn)
                .then(async () => {
                  const enabled = await invoke<boolean>("is_autostart_enabled");
                  setAutostartEnabled(enabled);
                  setMessage(enabled ? "已启用开机自启动" : "已禁用开机自启动");
                })
                .catch((err: unknown) => setMessage(`自启动设置失败: ${String(err)}`));
            }}
            onExportConfig={() => {
              invoke<string>("export_config")
                .then((json) => {
                  const blob = new Blob([json], { type: "application/json" });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = `flowlet-config-${new Date().toISOString().slice(0, 10)}.json`;
                  a.click();
                  URL.revokeObjectURL(url);
                  setMessage("配置已导出");
                })
                .catch((err: unknown) => setMessage(`导出失败: ${String(err)}`));
            }}
            onImportConfig={() => {
              const input = document.createElement("input");
              input.type = "file";
              input.accept = ".json";
              input.onchange = () => {
                const file = input.files?.[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = () => {
                  const json = reader.result as string;
                  invoke("import_config", { json })
                    .then(async () => {
                      await refreshAll();
                      setMessage("配置已导入");
                    })
                    .catch((err: unknown) => setMessage(`导入失败: ${String(err)}`));
                };
                reader.readAsText(file);
              };
              input.click();
            }}
            onValidateConfig={() => {
              invoke<string[]>("validate_config")
                .then((errors) => {
                  if (errors.length === 0) {
                    setMessage("✅ 配置验证通过");
                  } else {
                    setMessage(`⚠️ 发现 ${errors.length} 个问题: ${errors.slice(0, 3).join("; ")}${errors.length > 3 ? "..." : ""}`);
                  }
                })
                .catch((err: unknown) => setMessage(`验证失败: ${String(err)}`));
            }}
            onRefreshAll={() => void refreshAll()}
            dbStats={dbStats}
            onCleanupLogs={(keepDays) => {
              invoke<[number, number]>("cleanup_old_logs", { keepDays })
                .then(([logs, usage]) => {
                  setMessage(`已清理 ${logs} 条日志、${usage} 条用量记录`);
                  void refreshAll();
                })
                .catch((err: unknown) => setMessage(`清理失败: ${String(err)}`));
            }}
          />
        ) : null}

        {view === "channels" ? (
          <ChannelsPanel
            channels={channels}
            accounts={accounts}
            onAddAccount={addAccount}
            onUpdateAccount={updateAccount}
            onRemoveAccount={removeAccount}
            onSaveChannels={() => void saveChannels()}
            onSaveAccounts={() => void saveAccounts()}
            onTestConnection={(id) => void testConnection(id)}
            onSyncModels={(id) => void syncModels(id)}
            getChannelName={getChannelName}
            getBalanceForAccount={getBalanceForAccount}
            onAddBalanceSnapshot={(s) => void addBalanceSnapshot(s)}
            balanceSnapshots={balanceSnapshots}
            getAccountName={getAccountName}
          />
        ) : null}

        {view === "claude" ? (
          <ClaudeCodePanel clients={clients} onCopy={copy} />
        ) : null}

        {view === "clients" ? (
          <ClientsPanel
            clients={clients}
            onAdd={addClient}
            onUpdate={updateClient}
            onRemove={removeClient}
            onSave={() => void saveClientTokens()}
            onCopy={copy}
          />
        ) : null}

        {view === "routes" ? (
          <RoutesPanel
            routes={routes}
            channels={channels}
            accounts={accounts}
            virtualModels={virtualModels}
            onAdd={addRoute}
            onUpdate={updateRoute}
            onRemove={removeRoute}
            onSave={() => void saveRouteCandidates()}
            getChannelName={getChannelName}
            getAccountName={getAccountName}
            prices={prices}
            onAddPrice={addPrice}
            onUpdatePrice={updatePrice}
            onRemovePrice={removePrice}
            onSavePrices={() => void savePrices()}
            routeRules={routeRules}
            onAddRouteRule={addRouteRule}
            onUpdateRouteRule={updateRouteRule}
            onRemoveRouteRule={removeRouteRule}
            onSaveRouteRules={() => void saveRouteRules()}
            clients={clients}
          />
        ) : null}

        {view === "stats" ? (
          <StatsPanel
            rows={accountStats}
            onRefresh={() => void refreshAll()}
            routingScores={routingScores}
            getAccountName={getAccountName}
            getChannelName={getChannelName}
          />
        ) : null}

        {view === "logs" ? (
          <LogsPanel logs={requestLogs} onRefresh={() => void refreshLogs()} />
        ) : null}

        {view === "usage" ? (
          <UsagePanel
            rows={usageRows}
            onAnalyze={() => void analyzeUsage()}
            onRefresh={() => void refreshUsage()}
          />
        ) : null}

        {message ? <div className="toast">{message}</div> : null}
      </section>
    </main>
  );
}

// ─── Overview Panel ──────────────────────────────────────────────────────────

function OverviewPanel({
  status,
  usageRows,
  onCopy,
  autostartEnabled,
  onToggleAutostart,
  onExportConfig,
  onImportConfig,
  onValidateConfig,
  onRefreshAll,
  dbStats,
  onCleanupLogs,
}: {
  status: ProxyStatus & { channels: number; accounts: number; clients: number };
  usageRows: UsageSummaryRow[];
  onCopy: (text: string, done: string) => Promise<void>;
  autostartEnabled: boolean;
  onToggleAutostart: () => void;
  onExportConfig: () => void;
  onImportConfig: () => void;
  onValidateConfig: () => void;
  onRefreshAll: () => void;
  dbStats: [number, number, number] | null;
  onCleanupLogs: (keepDays: number) => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const todayRows = usageRows.filter((r) => r.date === today);
  const todayRequests = todayRows.reduce((sum, r) => sum + r.request_count, 0);
  const todayTokens = todayRows.reduce((sum, r) => sum + r.known_tokens, 0);
  const todayCost = todayRows.reduce((sum, r) => sum + r.estimated_cost, 0);

  return (
    <>
      <section className="panel">
        <div className="panel-title">
          <h3>接入信息</h3>
          <div className="actions">
            <button onClick={() => void onCopy("http://127.0.0.1:11434/v1", "OpenAI Base URL 已复制")}>
              复制 OpenAI Base URL
            </button>
            <button
              onClick={() =>
                void onCopy("http://127.0.0.1:11434/anthropic", "Anthropic Base URL 已复制")
              }
            >
              复制 Anthropic Base URL
            </button>
            <button onClick={() => void onCopy("Bearer flowlet-local-token", "Client Token 已复制")}>
              复制 Client Token
            </button>
          </div>
        </div>
        <div className="info-grid">
          <label>
            OpenAI-compatible 入口
            <input readOnly value="http://127.0.0.1:11434/v1" />
          </label>
          <label>
            Anthropic-compatible 入口
            <input readOnly value="http://127.0.0.1:11434/anthropic" />
          </label>
          <label>
            健康检查
            <input readOnly value="http://127.0.0.1:11434/health" />
          </label>
          <label>
            客户端 Token
            <input readOnly value="Bearer flowlet-local-token" />
          </label>
        </div>
      </section>
      <section className="panel compact">
        <h3>当前阶段</h3>
        <p>
          已建立 Channel / Account / Model 三层架构，支持 LongCat + DeepSeek 双渠道、OpenAI-compatible
          与 Anthropic-compatible 双协议透明转发。
        </p>
        <p>
          渠道: {status.channels} | 账号: {status.accounts} | 客户端: {status.clients} | 今日请求:{" "}
          {todayRequests} | Token: {todayTokens} | 成本: ${todayCost.toFixed(6)}
        </p>
      </section>
      <section className="panel compact">
        <div className="panel-title">
          <h3>系统设置</h3>
        </div>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={autostartEnabled}
            onChange={onToggleAutostart}
          />
          开机自启动 Flowlet
        </label>
      </section>
      <section className="panel compact">
        <div className="panel-title">
          <h3>配置管理</h3>
        </div>
        <div className="actions">
          <button onClick={() => void onValidateConfig()}>验证配置</button>
          <button onClick={() => void onExportConfig()}>导出配置</button>
          <button onClick={() => void onImportConfig()}>导入配置</button>
        </div>
        <p className="hint">验证配置完整性（渠道、账号、API Key、路由引用），导出为 JSON 文件备份，或从文件导入。</p>
      </section>
      <section className="panel compact">
        <div className="panel-title">
          <h3>数据库维护</h3>
        </div>
        {dbStats ? (
          <p>
            请求日志: {dbStats[0].toLocaleString()} 条 | 用量记录: {dbStats[1].toLocaleString()} 条 | 文件大小: {(dbStats[2] / 1024).toFixed(1)} KB
          </p>
        ) : (
          <p>加载中...</p>
        )}
        <div className="actions">
          <button
            onClick={() => {
              if (confirm("清理 30 天前的日志？此操作不可撤销。")) {
                onCleanupLogs(30);
              }
            }}
          >
            清理 30 天前日志
          </button>
          <button onClick={() => void onRefreshAll()}>刷新统计</button>
        </div>
      </section>
    </>
  );
}

// ─── Channels Panel ──────────────────────────────────────────────────────────

function ChannelsPanel({
  channels,
  accounts,
  onAddAccount,
  onUpdateAccount,
  onRemoveAccount,
  onSaveChannels,
  onSaveAccounts,
  onTestConnection,
  onSyncModels,
  getChannelName,
  getBalanceForAccount,
  onAddBalanceSnapshot,
  balanceSnapshots,
  getAccountName,
}: {
  channels: ChannelPreset[];
  accounts: ChannelAccount[];
  onAddAccount: (channelId: string) => void;
  onUpdateAccount: (index: number, patch: Partial<ChannelAccount>) => void;
  onRemoveAccount: (index: number) => void;
  onSaveChannels: () => void;
  onSaveAccounts: () => void;
  onTestConnection: (accountId: string) => void;
  onSyncModels: (accountId: string) => void;
  getChannelName: (channelId: string) => string;
  getBalanceForAccount: (accountId: string) => AccountBalanceSnapshot | undefined;
  onAddBalanceSnapshot: (
    snapshot: Omit<AccountBalanceSnapshot, "id" | "created_at" | "updated_at">
  ) => void;
  balanceSnapshots: AccountBalanceSnapshot[];
  getAccountName: (accountId: string) => string;
}) {
  const [editingChannel, setEditingChannel] = React.useState<string | null>(null);
  const [snapshotAccountId, setSnapshotAccountId] = React.useState<string | null>(null);
  const [snapshotBalance, setSnapshotBalance] = React.useState("");
  const [snapshotCurrency, setSnapshotCurrency] = React.useState("CNY");
  const [snapshotTokenTotal, setSnapshotTokenTotal] = React.useState("");
  const [snapshotTokenExpire, setSnapshotTokenExpire] = React.useState("");
  const [snapshotRemark, setSnapshotRemark] = React.useState("");

  const totalAccounts = accounts.length;
  const enabledAccounts = accounts.filter((a) => a.enabled).length;

  return (
    <>
      <section className="panel">
        <div className="panel-title">
          <h3>渠道模板</h3>
          <div className="actions">
            <button onClick={() => void onSaveChannels()}>保存渠道</button>
          </div>
        </div>
        <div className="channel-grid">
          {channels.map((channel) => (
            <div className="channel-card" key={channel.id}>
              <div className="channel-header">
                <strong>{channel.name}</strong>
                <span className="channel-vendor">{channel.vendor}</span>
              </div>
              <div className="channel-protocols">
                {channel.supported_protocols.map((p) => (
                  <span className="protocol-badge" key={p}>
                    {protocolLabels[p]}
                  </span>
                ))}
              </div>
              <button
                className="link-button"
                onClick={() =>
                  setEditingChannel(editingChannel === channel.id ? null : channel.id)
                }
              >
                {editingChannel === channel.id ? "收起详情" : "查看配置"}
              </button>
              {editingChannel === channel.id ? (
                <div className="channel-detail">
                  <label>
                    OpenAI Base URL
                    <input
                      value={channel.openai_base_url}
                      onChange={(e) => {
                        const idx = channels.findIndex((c) => c.id === channel.id);
                        if (idx >= 0) {
                          const updated = [...channels];
                          updated[idx] = { ...updated[idx], openai_base_url: e.target.value };
                          // State update handled by parent
                        }
                      }}
                    />
                  </label>
                  <label>
                    Anthropic Base URL
                    <input value={channel.anthropic_base_url} readOnly />
                  </label>
                  <label>
                    默认模型
                    <input value={channel.default_model} readOnly />
                  </label>
                  <label>
                    小模型（简单请求自动路由）
                    <input
                      value={channel.small_model ?? ""}
                      placeholder="留空则不使用小模型路由"
                      onChange={(e) => {
                        const idx = channels.findIndex((c) => c.id === channel.id);
                        if (idx >= 0) {
                          const updated = [...channels];
                          updated[idx] = {
                            ...updated[idx],
                            small_model: e.target.value || null,
                          };
                          // State update handled by parent
                        }
                      }}
                    />
                  </label>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </section>
      <section className="panel">
        <div className="panel-title">
          <h3>
            渠道账号 ({enabledAccounts}/{totalAccounts})
          </h3>
          <div className="actions">
            {channels.length > 0 ? (
              <button onClick={() => onAddAccount(channels[0].id)}>新增账号</button>
            ) : null}
            <button onClick={() => void onSaveAccounts()}>保存账号</button>
          </div>
        </div>
        <div className="account-list">
          {accounts.length === 0 ? (
            <p>暂无账号，请先新增</p>
          ) : (
            accounts.map((account, index) => (
              <div className="account-row" key={account.id}>
                <span className="account-channel">{getChannelName(account.channel_id)}</span>
                <input
                  value={account.name}
                  placeholder="账号名称"
                  onChange={(e) => onUpdateAccount(index, { name: e.target.value })}
                />
                <input
                  type="password"
                  value={account.api_key}
                  placeholder="API Key"
                  onChange={(e) => onUpdateAccount(index, { api_key: e.target.value })}
                />
                <input
                  type="number"
                  min="0"
                  value={account.priority}
                  placeholder="优先级"
                  onChange={(e) =>
                    onUpdateAccount(index, { priority: Math.max(0, Number(e.target.value) || 0) })
                  }
                />
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={account.enabled}
                    onChange={(e) => onUpdateAccount(index, { enabled: e.target.checked })}
                  />
                  启用
                </label>
                <div className="account-actions">
                  {account.channel_id === "deepseek" ? (
                    <button onClick={() => void onTestConnection(account.id)} title="查询余额">
                      余额
                    </button>
                  ) : null}
                  {account.channel_id === "deepseek" ? (
                    <button onClick={() => void onSyncModels(account.id)} title="同步模型列表">
                      同步
                    </button>
                  ) : null}
                  <button
                    onClick={() => {
                      setSnapshotAccountId(account.id);
                      const bal = getBalanceForAccount(account.id);
                      if (bal) {
                        setSnapshotBalance(bal.balance?.toString() ?? "");
                        setSnapshotCurrency(bal.currency ?? "CNY");
                        setSnapshotTokenTotal(bal.token_pack_total?.toString() ?? "");
                        setSnapshotTokenExpire(bal.token_pack_expire_at ?? "");
                        setSnapshotRemark(bal.remark ?? "");
                      }
                    }}
                    title="登记余额快照"
                  >
                    登记
                  </button>
                  <button onClick={() => onRemoveAccount(index)}>删除</button>
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      {snapshotAccountId ? (
        <section className="panel">
          <div className="panel-title">
            <h3>登记余额 / 资源包快照</h3>
            <div className="actions">
              <button onClick={() => setSnapshotAccountId(null)}>取消</button>
            </div>
          </div>
          <div className="form-grid">
            <label>
              余额数值
              <input
                type="number"
                min="0"
                step="0.01"
                value={snapshotBalance}
                placeholder="例如 100.50"
                onChange={(e) => setSnapshotBalance(e.target.value)}
              />
            </label>
            <label>
              货币
              <input
                value={snapshotCurrency}
                placeholder="CNY"
                onChange={(e) => setSnapshotCurrency(e.target.value)}
              />
            </label>
            <label>
              Token 资源包总量
              <input
                type="number"
                min="0"
                value={snapshotTokenTotal}
                placeholder="可选，例如 1000000"
                onChange={(e) => setSnapshotTokenTotal(e.target.value)}
              />
            </label>
            <label>
              资源包过期时间
              <input
                type="date"
                value={snapshotTokenExpire}
                onChange={(e) => setSnapshotTokenExpire(e.target.value)}
              />
            </label>
            <label>
              备注
              <input
                value={snapshotRemark}
                placeholder="可选备注"
                onChange={(e) => setSnapshotRemark(e.target.value)}
              />
            </label>
          </div>
          <div className="actions">
            <button
              onClick={() => {
                const balance = snapshotBalance.trim() ? Number(snapshotBalance) : null;
                const total = snapshotTokenTotal.trim() ? Number(snapshotTokenTotal) : null;
                onAddBalanceSnapshot({
                  account_id: snapshotAccountId,
                  balance,
                  currency: snapshotCurrency.trim() || null,
                  token_pack_total: total,
                  token_pack_used: null,
                  token_pack_remaining: total,
                  token_pack_expire_at: snapshotTokenExpire || null,
                  source: "manual",
                  synced_at: null,
                  remark: snapshotRemark.trim() || null,
                });
                setSnapshotAccountId(null);
                setSnapshotBalance("");
                setSnapshotCurrency("CNY");
                setSnapshotTokenTotal("");
                setSnapshotTokenExpire("");
                setSnapshotRemark("");
              }}
            >
              保存快照
            </button>
          </div>
        </section>
      ) : null}

      <section className="panel compact">
        <h3>账号余额概览</h3>
        {balanceSnapshots.length === 0 ? (
          <p>暂无余额快照。点击账号右侧"登记"按钮手动添加。</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>账号</th>
                  <th>余额</th>
                  <th>Token 资源包</th>
                  <th>过期时间</th>
                  <th>登记时间</th>
                </tr>
              </thead>
              <tbody>
                {balanceSnapshots.map((snap) => (
                  <tr key={snap.id}>
                    <td>{getAccountName(snap.account_id)}</td>
                    <td>
                      {snap.balance != null
                        ? `${snap.balance} ${snap.currency ?? ""}`
                        : "-"}
                    </td>
                    <td>
                      {snap.token_pack_remaining != null
                        ? `${snap.token_pack_remaining.toLocaleString()} tokens`
                        : "-"}
                    </td>
                    <td>{snap.token_pack_expire_at ?? "-"}</td>
                    <td>{snap.created_at}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

// ─── Claude Code Panel ───────────────────────────────────────────────────────

function ClaudeCodePanel({
  clients,
  onCopy,
}: {
  clients: ClientConfig[];
  onCopy: (text: string, done: string) => Promise<void>;
}) {
  const defaultClient = clients.find((c) => c.id === "client-default") ?? clients[0];
  const token = defaultClient?.token ?? "flowlet-local-token";

  return (
    <section className="panel">
      <div className="panel-title">
        <h3>Claude Code 接入向导</h3>
      </div>
      <p>
        Claude Code 通过 Anthropic-compatible 协议接入 Flowlet。请在 Claude Code 环境中设置以下变量：
      </p>
      <div className="info-grid">
        <label>
          ANTHROPIC_BASE_URL
          <input readOnly value="http://127.0.0.1:11434/anthropic" />
        </label>
        <label>
          ANTHROPIC_AUTH_TOKEN
          <input readOnly value={token} />
        </label>
      </div>
      <div className="actions">
        <button
          onClick={() =>
            void onCopy(
              "export ANTHROPIC_BASE_URL=http://127.0.0.1:11434/anthropic",
              "已复制 BASE_URL"
            )
          }
        >
          复制 BASE_URL
        </button>
        <button
          onClick={() =>
            void onCopy(
              `export ANTHROPIC_AUTH_TOKEN=${token}`,
              "已复制 AUTH_TOKEN"
            )
          }
        >
          复制 AUTH_TOKEN
        </button>
        <button
          onClick={() =>
            void onCopy(
              `export ANTHROPIC_BASE_URL=http://127.0.0.1:11434/anthropic\nexport ANTHROPIC_AUTH_TOKEN=${token}`,
              "已复制完整配置"
            )
          }
        >
          复制完整配置
        </button>
      </div>
      <p className="hint">
        X-Api-Key 方式：将 <code>ANTHROPIC_AUTH_TOKEN</code> 替换为{" "}
        <code>ANTHROPIC_API_KEY</code>，Flowlet 同样支持。
      </p>
    </section>
  );
}

// ─── Clients Panel ───────────────────────────────────────────────────────────

function ClientsPanel({
  clients,
  onAdd,
  onUpdate,
  onRemove,
  onSave,
  onCopy,
}: {
  clients: ClientConfig[];
  onAdd: () => void;
  onUpdate: (index: number, patch: Partial<ClientConfig>) => void;
  onRemove: (index: number) => void;
  onSave: () => void;
  onCopy: (text: string, done: string) => Promise<void>;
}) {
  return (
    <section className="panel">
      <div className="panel-title">
        <h3>客户端 Token</h3>
        <div className="actions">
          <button onClick={onAdd}>新增客户端</button>
          <button onClick={() => void onSave()}>保存 Token</button>
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
                onChange={(e) => onUpdate(index, { name: e.target.value })}
              />
              <input
                value={client.token}
                placeholder="Client Token"
                onChange={(e) => onUpdate(index, { token: e.target.value })}
              />
              <select
                value={client.app_type}
                onChange={(e) => onUpdate(index, { app_type: e.target.value })}
              >
                <option value="local">本机</option>
                <option value="claude-code">Claude Code</option>
                <option value="cursor">Cursor</option>
                <option value="cline">Cline</option>
                <option value="open-webui">Open WebUI</option>
                <option value="cherry-studio">Cherry Studio</option>
                <option value="continue">Continue</option>
                <option value="custom">自定义</option>
              </select>
              <button onClick={() => void onCopy(`Bearer ${client.token}`, "Client Token 已复制")}>
                复制
              </button>
              <button onClick={() => onRemove(index)}>删除</button>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

// ─── Routes Panel ────────────────────────────────────────────────────────────

function RoutesPanel({
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
  const autoVirtualModel = virtualModels.find((v) => v.name === "auto");

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
            <p>暂无路由候选</p>
          ) : (
            routes.map((route, index) => (
              <div className="route-card" key={route.id}>
                <span className="route-priority">{index + 1}</span>
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

// ─── Stats Panel ─────────────────────────────────────────────────────────────

function StatsPanel({
  rows,
  onRefresh,
  routingScores,
  getAccountName,
  getChannelName,
}: {
  rows: AccountStatsRow[];
  onRefresh: () => void;
  routingScores: Array<[string, string, number, number, number]>;
  getAccountName: (accountId: string) => string;
  getChannelName: (channelId: string) => string;
}) {
  return (
    <>
    <section className="panel">
      <div className="panel-title">
        <h3>账号成本与稳定性统计</h3>
        <div className="actions">
          <button onClick={() => void onRefresh()}>刷新</button>
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>账号</th>
              <th>渠道</th>
              <th>请求数</th>
              <th>成功</th>
              <th>失败</th>
              <th>失败率</th>
              <th>Fallback</th>
              <th>Token</th>
              <th>估算成本</th>
              <th>最近错误</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={10}>暂无统计数据</td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.account_id}>
                  <td>{row.account_name || row.account_id}</td>
                  <td>{row.channel_name || row.channel_id || "-"}</td>
                  <td>{row.total_requests}</td>
                  <td>{row.success_requests}</td>
                  <td>{row.failed_requests}</td>
                  <td>{row.failure_rate.toFixed(1)}%</td>
                  <td>{row.total_fallbacks}</td>
                  <td>{row.known_tokens.toLocaleString()}</td>
                  <td>{"$"}{row.estimated_cost.toFixed(6)}</td>
                  <td title={row.last_error ?? ""}>
                    {row.last_error
                      ? row.last_error.length > 40
                        ? row.last_error.slice(0, 40) + "..."
                        : row.last_error
                      : "-"}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
    <section className="panel">
      <div className="panel-title">
        <h3>智能路由评分（成本/延迟/成功率）</h3>
      </div>
      <p className="hint">
        综合调度算法：得分 = 0.4×归一化成本 + 0.3×归一化延迟 + 0.3×失败率。得分越低优先级越高。
      </p>
      {routingScores.length === 0 ? (
        <p>暂无评分数据。需要至少 3 条请求记录才能计算。</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>账号</th>
                <th>渠道</th>
                <th>平均延迟</th>
                <th>成功率</th>
                <th>单次成本</th>
              </tr>
            </thead>
            <tbody>
              {routingScores.map(([accountId, channelId, latency, successRate, cost], idx) => (
                <tr key={`${accountId}-${channelId}-${idx}`}>
                  <td>{getAccountName(accountId)}</td>
                  <td>{getChannelName(channelId)}</td>
                  <td>{Math.round(latency)} ms</td>
                  <td>{successRate.toFixed(1)}%</td>
                  <td>${cost.toFixed(6)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
    </>
  );
}

// ─── Logs Panel ──────────────────────────────────────────────────────────────

function LogsPanel({
  logs,
  onRefresh,
}: {
  logs: RequestLogRow[];
  onRefresh: () => void;
}) {
  return (
    <section className="panel">
      <div className="panel-title">
        <h3>请求日志</h3>
        <div className="actions">
          <button onClick={() => void onRefresh()}>刷新</button>
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>时间</th>
              <th>客户端</th>
              <th>渠道</th>
              <th>账号</th>
              <th>协议</th>
              <th>类型</th>
              <th>公开模型</th>
              <th>上游模型</th>
              <th>状态</th>
              <th>耗时</th>
              <th>降级</th>
              <th>原因</th>
            </tr>
          </thead>
          <tbody>
            {logs.length === 0 ? (
              <tr>
                <td colSpan={11}>暂无请求日志</td>
              </tr>
            ) : (
              logs.map((row) => (
                <tr key={`${row.created_at}-${row.path}-${row.id}`}>
                  <td>{row.created_at}</td>
                  <td>{row.client_name || row.client_id || "未知"}</td>
                  <td>{row.channel_name || row.channel_id || "-"}</td>
                  <td>{row.account_name || row.account_id || "-"}</td>
                  <td>{row.client_protocol}</td>
                  <td>
                    <span className={`request-type-badge request-type-${row.request_type}`}>
                      {row.request_type}
                    </span>
                  </td>
                  <td>{row.public_model || "-"}</td>
                  <td>{row.upstream_model || "-"}</td>
                  <td>{row.status ?? "-"}</td>
                  <td>{row.latency_ms == null ? "-" : `${row.latency_ms} ms`}</td>
                  <td>{row.fallback_count}</td>
                  <td>{row.route_reason || row.error_message || "-"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ─── Usage Panel ─────────────────────────────────────────────────────────────

function UsagePanel({
  rows,
  onAnalyze,
  onRefresh,
}: {
  rows: UsageSummaryRow[];
  onAnalyze: () => void;
  onRefresh: () => void;
}) {
  return (
    <section className="panel">
      <div className="panel-title">
        <h3>用量统计</h3>
        <div className="actions">
          <button onClick={() => void onAnalyze()}>执行离线分析</button>
          <button onClick={() => void onRefresh()}>刷新</button>
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>日期</th>
              <th>客户端</th>
              <th>渠道</th>
              <th>账号</th>
              <th>上游模型</th>
              <th>请求数</th>
              <th>已知 Token</th>
              <th>未知</th>
              <th>估算成本</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={9}>暂无用量数据</td>
              </tr>
            ) : (
              rows.map((row, index) => (
                <tr
                  key={`${row.date}-${row.channel_id}-${row.account_id}-${row.upstream_model}-${index}`}
                >
                  <td>{row.date}</td>
                  <td>{row.client_name || row.client_id || "未知"}</td>
                  <td>{row.channel_name || row.channel_id || "-"}</td>
                  <td>{row.account_name || row.account_id || "-"}</td>
                  <td>{row.upstream_model || "-"}</td>
                  <td>{row.request_count}</td>
                  <td>{row.known_tokens}</td>
                  <td>{row.unknown_count}</td>
                  <td>${row.estimated_cost.toFixed(6)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ─── Mount ───────────────────────────────────────────────────────────────────

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
