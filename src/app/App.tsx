import React from "react";
import { ProxyTopbar, Sidebar } from "../components/layout";
import { useFlowletActions } from "./useFlowletActions";
import { useFlowletData } from "./useFlowletData";
import { runCommand, enableFrontendLogging, disableFrontendLogging } from "../services/flowletApi";
import { LogFilter, View } from "../domain";
import {
  ChannelsPage,
  ClientsPage,
  LogsPage,
  OverviewPage,
  RoutesPage,
  StatsPage,
  UsagePage,
} from "../pages";

// ─── App ─────────────────────────────────────────────────────────────────────

export default function App() {
  const flowlet = useFlowletData();
  const {
    channels,
    accounts,
    routes,
    clients,
    prices,
    channelModels,
    virtualModels,
    usageRows,
    requestLogs,
    logMeta,
    logCaptureConfig,
    balanceSnapshots,
    routeRules,
    accountStats,
    routingScores,
    dbStats,
    autostartEnabled,
    status,
    proxyBindConfig,
    refreshStatus,
    refreshAll,
    refreshChannelModels,
    refreshLogCaptureConfig,
  } = flowlet;
  const [view, setView] = React.useState<View>("overview");
  const [message, setMessage] = React.useState("");
  const {
    startProxy,
    stopProxy,
    restartProxy,
    copy,
    saveAccounts,
    saveRouteCandidates,
    saveRouteRules,
    saveClientTokens,
    savePrices,
    quickSetup,
    regenerateDefaultRoutes,
    refreshUsage,
    refreshLogs,
    fetchLogDetail,
    saveLogCaptureConfig,
    analyzeUsage,
    addAccount,
    testConnection,
    syncModels,
    updateAccount,
    removeAccount,
    addClient,
    updateClient,
    removeClient,
    addPrice,
    updatePrice,
    removePrice,
    addRouteRule,
    updateRouteRule,
    removeRouteRule,
    addRoute,
    updateRoute,
    removeRoute,
    getChannelName,
    getAccountName,
    getBalanceForAccount,
    addBalanceSnapshot,
    toggleAutostart,
    exportConfig,
    saveProxyBindConfig,
    importConfig,
    validateConfig,
    cleanupLogs,
  } = useFlowletActions(flowlet, setMessage);

  const [initializing, setInitializing] = React.useState(true);
  const [initError, setInitError] = React.useState<string | null>(null);

  // 严格模式（React 18+ dev + Tauri 重连）下 useEffect 会被调多次。
  // 用递增 incarnation seq 确保只有一个 run 能 "获胜" — 最近一次 fire 的 run 结果才被应用。
  const initSeq = React.useRef(0);

  React.useEffect(() => {
    const seq = ++initSeq.current;
    setInitializing(true);
    setInitError(null);
    disableFrontendLogging();

    async function doInit() {
      try {
        await runCommand<{ ok?: boolean; pid?: number }>("ipc_ping", undefined, 1_500);
      } catch (err) {
        if (seq !== initSeq.current) return;
        setInitError(err instanceof Error ? err.message : String(err));
        setInitializing(false);
        return;
      }

      await Promise.allSettled([refreshStatus(), refreshAll(), refreshLogCaptureConfig()]);

      // 已经有更新的 init 发起 => 丢弃本次过期结果
      if (seq !== initSeq.current) return;

      setInitializing(false);
      // 首屏初始化完成后再开放前端日志，避免 render 期间触发 invoke 循环
      enableFrontendLogging();
    }
    void doInit();
  }, [refreshStatus, refreshAll, refreshLogCaptureConfig]);

  if (initializing) {
    return (
      <main className="app-shell app-boot">
        <div className="boot-screen">
          <div className="boot-logo">⏳</div>
          <h1>Flowlet</h1>
          <p className="boot-hint">正在初始化代理配置…</p>
          <div className="boot-spinner" />
        </div>
      </main>
    );
  }

  if (initError) {
    return (
      <main className="app-shell app-boot">
        <div className="boot-screen">
          <div className="boot-logo">!</div>
          <h1>Flowlet</h1>
          <p className="boot-hint">Tauri IPC 初始化失败：{initError}</p>
        </div>
      </main>
    );
  }
  return (
    <main className="app-shell">
      <Sidebar view={view} onViewChange={setView} />

      <section className="content">
        <ProxyTopbar
          status={status}
          onStart={() => void startProxy()}
          onStop={() => void stopProxy()}
        />

        {view === "overview" ? (
          <OverviewPage
            status={{ ...status, channels: channels.length, accounts: accounts.length, clients: clients.length }}
            usageRows={usageRows}
            onCopy={copy}
            autostartEnabled={autostartEnabled}
            proxyBindConfig={proxyBindConfig}
            onToggleProxyLanAccess={saveProxyBindConfig}
            onToggleAutostart={toggleAutostart}
            onExportConfig={exportConfig}
            onImportConfig={importConfig}
            onValidateConfig={validateConfig}
            onRefreshAll={() => void refreshAll()}
            dbStats={dbStats}
            onCleanupLogs={cleanupLogs}
            channels={channels}
            hasEnabledAccount={accounts.some((account) => account.enabled && account.api_key.trim())}
            hasEnabledRoute={routes.some((route) => route.enabled)}
            onQuickSetup={(channelId, apiKey) => void quickSetup(channelId, apiKey)}
          />
        ) : null}

        {view === "channels" ? (
          <ChannelsPage
            channels={channels}
            accounts={accounts}
            onAddAccount={addAccount}
            onUpdateAccount={updateAccount}
            onRemoveAccount={removeAccount}
            onSaveAccounts={() => void saveAccounts()}
            onTestConnection={(id) => void testConnection(id)}
            getBalanceForAccount={getBalanceForAccount}
            onAddBalanceSnapshot={(s) => void addBalanceSnapshot(s)}
            proxyRunning={status.running}
            onRestartProxy={() => void restartProxy()}
          />
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
            channelModels={channelModels}
            virtualModels={virtualModels}
            onAdd={addRoute}
            onUpdate={updateRoute}
            onRemove={removeRoute}
            onSave={() => void saveRouteCandidates()}
            onRegenerateDefaultRoutes={() => void regenerateDefaultRoutes()}
            onSyncModels={(accountId) => void syncModels(accountId)}
            onRefreshChannelModels={() => void refreshChannelModels()}
            getChannelName={getChannelName}
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
            logCaptureConfig={logCaptureConfig}
            onSaveLogCaptureConfig={(cfg) => void saveLogCaptureConfig(cfg)}
          />
        ) : null}

        {view === "logs" ? (
          <LogsPage
            logs={requestLogs}
            logMeta={logMeta}
            channels={channels}
            clients={clients}
            onRefresh={(filter, page) => {
              const next: LogFilter | undefined = filter
                ? { ...filter, page: page ?? filter.page }
                : undefined;
              void refreshLogs(next);
            }}
            onOpenDetail={(requestId) => void fetchLogDetail(requestId)}
          />
        ) : null}

        {view === "usage" ? (
          <UsagePage
            rows={usageRows}
            onAnalyze={() => void analyzeUsage()}
            onRefresh={() => void refreshUsage()}
            prices={prices}
            channels={channels}
            onAddPrice={addPrice}
            onUpdatePrice={updatePrice}
            onRemovePrice={removePrice}
            onSavePrices={() => void savePrices()}
          />
        ) : null}

        {message ? <div className="toast">{message}</div> : null}
      </section>
    </main>
  );
}

















