import React from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import {
  AccountBalanceSnapshot,
  AccountStatsRow,
  ChannelAccount,
  ChannelPreset,
  ClientConfig,
  ModelPrice,
  ProxyStatus,
  RequestLogRow,
  RouteCandidate,
  RouteRule,
  UsageSummaryRow,
  View,
  VirtualModel,
  createAccount,
  createClient,
  createModelPrice,
  createRouteCandidate,
  genId,
  views,
} from "./domain";
import {
  ChannelsPage,
  ClaudeCodePage,
  ClientsPage,
  LogsPage,
  OverviewPage,
  RoutesPage,
  StatsPage,
  UsagePage,
} from "./pages";
import "./styles.css";

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
          <OverviewPage
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
          <ChannelsPage
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
          <ClaudeCodePage clients={clients} onCopy={copy} />
        ) : null}

        {view === "clients" ? (
          <ClientsPage
            clients={clients}
            onAdd={addClient}
            onUpdate={updateClient}
            onRemove={removeClient}
            onSave={() => void saveClientTokens()}
            onCopy={copy}
          />
        ) : null}

        {view === "routes" ? (
          <RoutesPage
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
          <StatsPage
            rows={accountStats}
            onRefresh={() => void refreshAll()}
            routingScores={routingScores}
            getAccountName={getAccountName}
            getChannelName={getChannelName}
          />
        ) : null}

        {view === "logs" ? (
          <LogsPage logs={requestLogs} onRefresh={() => void refreshLogs()} />
        ) : null}

        {view === "usage" ? (
          <UsagePage
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

// ─── Mount ───────────────────────────────────────────────────────────────────

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
