import React from "react";
import { AppShell, Loader } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { Sidebar, WindowControls } from "../components/layout";
import { useFlowletActions } from "./useFlowletActions";
import { useFlowletData } from "./useFlowletData";
import { runCommand, enableFrontendLogging, disableFrontendLogging, logToRust } from "../services/flowletApi";
import { LogFilter, ProxyStatus, View } from "../domain";
import { ensureDefaultExposedRoutes } from "./routeHelpers";
import {
  LogsPage,
  OverviewPage,
  ChannelsPage,
  ClientsPage,
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
    setRoutes,
    clients,
    logClients,
    prices,
    channelModels,
    virtualModels,
    usageRows,
    requestLogs,
    logMeta,
    routeRules,
    accountStats,
    routingScores,
    status,
    proxyBindConfig,
    refreshStatus,
    refreshAll,
    refreshChannelModels,
    exposureMode,
  } = flowlet;
  const [view, setView] = React.useState<View>("overview");
  const [message, setMessage] = React.useState("");
  const {
    startProxy,
    restartProxy,
    testModel,
    copy,
    saveAccounts,
    saveRouteCandidates,
    saveRouteRules,
    saveClientTokens,
    savePrices,
    syncModels,
    regenerateDefaultRoutes,
    refreshUsage,
    refreshLogs,
    analyzeUsage,
    addAccount,
    testConnection,
    syncBalance,
    changeExposureMode,
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
  } = useFlowletActions(flowlet, setMessage);

  const [initializing, setInitializing] = React.useState(true);
  const [initError, setInitError] = React.useState<string | null>(null);
  const [autoStartAttempted, setAutoStartAttempted] = React.useState(false);
  const [proxyStarting, setProxyStarting] = React.useState(false);
  const [proxyStartError, setProxyStartError] = React.useState<string | null>(null);
  const autoStartGuard = React.useRef(false);
  const autoRouteSyncSignature = React.useRef("");

  // 严格模式（React 18+ dev + Tauri 重连）下 useEffect 会被调多次。
  // 用递增 incarnation seq 确保只有一个 run 能 "获胜" — 最近一次 fire 的 run 结果才被应用。
  const initSeq = React.useRef(0);

  React.useEffect(() => {
    if (!message) return;
    notifications.show({ message, color: "dark", autoClose: 2600 });
    const timer = window.setTimeout(() => setMessage(""), 2800);
    return () => window.clearTimeout(timer);
  }, [message]);

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
        const msg = err instanceof Error ? err.message : String(err);
        logToRust("error", `初始化 ping 失败: ${msg}`);
        setInitError(msg);
        setInitializing(false);
        return;
      }

      await Promise.allSettled([refreshStatus(), refreshAll()]);

      const currentStatus = await runCommand<ProxyStatus>("proxy_status").catch(() => null);
      if (!currentStatus?.running && !autoStartGuard.current) {
        autoStartGuard.current = true;
        setAutoStartAttempted(true);
        setProxyStarting(true);
        setProxyStartError(null);
        try {
          await startProxy();
        } catch (err) {
          setProxyStartError(err instanceof Error ? err.message : String(err));
        } finally {
          setProxyStarting(false);
        }
      }

      // 已经有更新的 init 发起 => 丢弃本次过期结果
      if (seq !== initSeq.current) return;

      setInitializing(false);
      // 首屏初始化完成后再开放前端日志，避免 render 期间触发 invoke 循环
      enableFrontendLogging();
    }
    void doInit();
  }, [refreshStatus, refreshAll]);

  React.useEffect(() => {
    if (initializing || initError) return;
    const timer = window.setInterval(() => void refreshStatus().catch(() => undefined), 3000);
    return () => window.clearInterval(timer);
  }, [initializing, initError, refreshStatus]);

  // 整点 +1 秒全量刷新：计算到下一分钟 01 刻的延迟，对齐分钟后 setInterval 保持节奏
  React.useEffect(() => {
    if (initializing || initError) return;
    let timer = 0;
    const scheduleNext = () => {
      const now = new Date();
      const msUntilNext = 60000 - (now.getSeconds() * 1000 + now.getMilliseconds()) + 1000;
      timer = window.setTimeout(async () => {
        try { await Promise.all([refreshStatus(), refreshAll()]); } catch { /* noop */ }
        scheduleNext();
      }, msUntilNext % 60000 || 60000);
    };
    scheduleNext();
    return () => window.clearTimeout(timer);
  }, [initializing, initError, refreshStatus, refreshAll]);
  React.useEffect(() => {
    if (initializing || initError) return;
    const signature = JSON.stringify({
      accounts: accounts.map(({ id, channel_id, enabled, api_key, priority }) => ({ id, channel_id, enabled, hasKey: !!api_key.trim(), priority })),
      channels: channels.map(({ id, supported_protocols }) => ({ id, supported_protocols })),
      models: channelModels.map(({ channel_id, model, enabled }) => ({ channel_id, model, enabled })),
    });
    if (autoRouteSyncSignature.current === signature) return;
    autoRouteSyncSignature.current = signature;
    const nextRoutes = ensureDefaultExposedRoutes(channels, accounts, routes, channelModels, exposureMode);
    if (JSON.stringify(nextRoutes) === JSON.stringify(routes)) return;
    setRoutes(nextRoutes);
    void runCommand("save_route_candidates", { routes: nextRoutes }).catch((err) => {
      const msg = `自动更新 Flowlet 模型池失败: ${String(err)}`;
      setMessage(msg);
      logToRust("error", msg);
    });
  }, [initializing, initError, accounts, channels, channelModels, routes, setRoutes]);
  async function handleStartProxy() {
    setAutoStartAttempted(true);
    setProxyStarting(true);
    setProxyStartError(null);
    try {
      await startProxy();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logToRust("error", `启动代理失败: ${msg}`);
      setProxyStartError(msg);
    } finally {
      setProxyStarting(false);
    }
  }

  async function handleRestartProxy() {
    setProxyStarting(true);
    setProxyStartError(null);
    try {
      await restartProxy();
      await refreshStatus();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logToRust("error", `重启代理失败: ${msg}`);
      setProxyStartError(msg);
    } finally {
      setProxyStarting(false);
    }
  }
  if (initializing) {
    return (
      <main className="app-shell app-boot">
        <div className="boot-screen">
          <div className="boot-logo">F</div>
          <h1>Flowlet</h1>
          <p className="boot-hint">正在初始化代理配置…</p>
          <Loader size="sm" />
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
    <>
      <WindowControls />
      <AppShell
        className="app-shell"
        navbar={{
          width: 168,
          breakpoint: "xs",
          collapsed: { mobile: false },
        }}
        padding={0}
        withBorder
      >
        <AppShell.Navbar className="app-navbar">
          <Sidebar
            view={view}
            status={status}
            onViewChange={setView}
          />
        </AppShell.Navbar>

        <AppShell.Main className="content">
          {view === "overview" ? (
            <OverviewPage
              status={status}
              bindConfig={proxyBindConfig}
              channels={channels}
              accounts={accounts}
              clients={clients}
              routes={routes}
              onCopy={copy}
              onRefreshAll={() => void Promise.all([refreshAll(), refreshStatus()])}
              proxyStarting={proxyStarting}
              proxyStartError={proxyStartError}
              autoStartAttempted={autoStartAttempted}
              onStartProxy={() => void handleStartProxy()}
              onRestartProxy={() => void handleRestartProxy()}
              onSaveAccounts={saveAccounts}
              onTestConnection={(channelId, apiKey, baseUrlOverride) => void testConnection(channelId, apiKey, baseUrlOverride)}
              onSyncBalance={(id) => void syncBalance(id)}
              getBalanceForAccount={getBalanceForAccount}
              onAddBalanceSnapshot={(snapshot) => void addBalanceSnapshot(snapshot)}
              onUpdateRoute={updateRoute}
              onSaveRoutes={() => void saveRouteCandidates()}
              onSyncModels={() => void regenerateDefaultRoutes()}
              onOpenAccounts={() => setView("accounts")}
              onOpenModelServices={() => setView("routes")}
              getChannelName={getChannelName}
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
            onCopyModel={(model) => void copy(model, model + " 已复制")}
            onTestModel={(model) => void testModel(model)}
            exposureMode={exposureMode}
            onChangeExposureMode={(mode) => void changeExposureMode(mode)}
            onOpenAccounts={() => setView("accounts")}
            getChannelName={getChannelName}
            routeRules={routeRules}
            onAddRouteRule={addRouteRule}
            onUpdateRouteRule={updateRouteRule}
            onRemoveRouteRule={removeRouteRule}
            onSaveRouteRules={() => void saveRouteRules()}
            clients={clients}
          />
        ) : null}

        {view === "accounts" ? (
          <>
            <ChannelsPage
              channels={channels}
              accounts={accounts}
              onSaveAccounts={saveAccounts}
              onTestConnection={(channelId, apiKey, baseUrlOverride) => void testConnection(channelId, apiKey, baseUrlOverride)}
              onSyncBalance={(id) => void syncBalance(id)}
              getBalanceForAccount={getBalanceForAccount}
              onAddBalanceSnapshot={(snapshot) => void addBalanceSnapshot(snapshot)}
              proxyRunning={status.running}
              onRestartProxy={() => void restartProxy()}
            />
            <ClientsPage
              clients={clients}
              onAdd={addClient}
              onUpdate={updateClient}
              onRemove={removeClient}
              onSave={() => void saveClientTokens()}
              onCopy={copy}
            />
          </>
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
          <LogsPage
            logs={requestLogs}
            logMeta={logMeta}
            channels={channels}
            logClients={logClients}
            onRefresh={(filter, page) => {
              const next: LogFilter | undefined = filter
                ? { ...filter, page: page ?? filter.page }
                : undefined;
              void refreshLogs(next);
            }}
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

        </AppShell.Main>
      </AppShell>
    </>
  );
}



















