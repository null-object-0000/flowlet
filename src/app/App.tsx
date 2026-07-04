import React from "react";
import { ProxyTopbar, Sidebar } from "../components/layout";
import { useFlowletActions } from "./useFlowletActions";
import { useFlowletData } from "./useFlowletData";
import { View } from "../domain";
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
    balanceSnapshots,
    routeRules,
    accountStats,
    routingScores,
    dbStats,
    autostartEnabled,
    status,
    refreshStatus,
    refreshAll,
    refreshChannelModels,
  } = flowlet;
  const [view, setView] = React.useState<View>("overview");
  const [message, setMessage] = React.useState("");
  const {
    startProxy,
    stopProxy,
    copy,
    saveChannels,
    saveAccounts,
    saveRouteCandidates,
    saveRouteRules,
    saveClientTokens,
    savePrices,
    quickSetup,
    regenerateDefaultRoutes,
    refreshUsage,
    refreshLogs,
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
    importConfig,
    validateConfig,
    cleanupLogs,
  } = useFlowletActions(flowlet, setMessage);

  React.useEffect(() => {
    refreshStatus().catch(() => setMessage("读取代理状态失败"));
    refreshAll().catch(() => setMessage("初始化数据加载失败"));
  }, [refreshStatus, refreshAll]);

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
            onSaveChannels={() => void saveChannels()}
            onSaveAccounts={() => void saveAccounts()}
            onTestConnection={(id) => void testConnection(id)}
            getBalanceForAccount={getBalanceForAccount}
            onAddBalanceSnapshot={(s) => void addBalanceSnapshot(s)}
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














