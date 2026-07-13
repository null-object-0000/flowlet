import React from "react";
import {
  AccountBalanceSnapshot,
  AccountStatsRow,
  ChannelAccount,
  ChannelModel,
  ChannelPreset,
  ClientConfig,
  LogMeta,
  ModelExposureMode,
  ModelPrice,
  ProxyBindConfig,
  ProxyStatus,
  RequestLogRow,
  RouteCandidate,
  RouteRule,
  UsageSummaryRow,
  VirtualModel,
} from "../domain";
import { runCommand } from "../services/flowletApi";

export function useFlowletData() {
  const [channels, setChannels] = React.useState<ChannelPreset[]>([]);
  const [accounts, setAccounts] = React.useState<ChannelAccount[]>([]);
  const [routes, setRoutes] = React.useState<RouteCandidate[]>([]);
  const [clients, setClients] = React.useState<ClientConfig[]>([]);
  const [prices, setPrices] = React.useState<ModelPrice[]>([]);
  const [channelModels, setChannelModels] = React.useState<ChannelModel[]>([]);
  const [virtualModels, setVirtualModels] = React.useState<VirtualModel[]>([]);
  const [usageRows, setUsageRows] = React.useState<UsageSummaryRow[]>([]);
  const [requestLogs, setRequestLogs] = React.useState<RequestLogRow[]>([]);
  const [logMeta, setLogMeta] = React.useState<LogMeta>({
    total: 0,
    page: 1,
    pageSize: 50,
    lastFetchedAt: 0,
  });
  const [logDetail, setLogDetail] = React.useState<RequestLogRow[] | null>(null);
  const [balanceSnapshots, setBalanceSnapshots] = React.useState<AccountBalanceSnapshot[]>([]);
  const [routeRules, setRouteRules] = React.useState<RouteRule[]>([]);
  const [accountStats, setAccountStats] = React.useState<AccountStatsRow[]>([]);
  const [routingScores, setRoutingScores] = React.useState<Array<[string, string, number, number, number]>>([]);
  const [exposureMode, setExposureMode] = React.useState<ModelExposureMode>("all");
  const [dbStats, setDbStats] = React.useState<[number, number, number] | null>(null);
  const [autostartEnabled, setAutostartEnabled] = React.useState(false);
  const [proxyBindConfig, setProxyBindConfig] = React.useState<ProxyBindConfig>({
    host: "127.0.0.1",
    port: 18640,
    allow_lan: false,
  });
  const [status, setStatus] = React.useState<ProxyStatus>({
    running: false,
    bind_addr: "127.0.0.1:18640",
    started_at: null,
  });

  const refreshStatus = React.useCallback(async () => {
    const next = await runCommand<ProxyStatus>("proxy_status");
    setStatus(next);
  }, []);

  const refreshChannelModels = React.useCallback(async () => {
    const models = await runCommand<ChannelModel[]>("list_channel_models").catch(() => [] as ChannelModel[]);
    setChannelModels(models);
  }, []);

  // 并发防护 token。用「最新版本号」避免老请求覆盖新请求的结果。
  // 在 React 18 + Tauri 的 mount 阶段时有概率因 StrictMode 或重连触发两次 refreshAll，
  // 不加防护会导致 race condition：后发的请求先回、先发请求后回时覆盖 => 用户刚加的 account 行消失。
  const refreshTokenRef = React.useRef(0);

  const refreshAll = React.useCallback(async () => {
    const token = ++refreshTokenRef.current;
    const [ch, ac, ro, cl, pr, cm, vm, usage, logs, snapshots, stats, rules, scores, db] = await Promise.all([
      runCommand<ChannelPreset[]>("list_channel_presets").catch(() => [] as ChannelPreset[]),
      runCommand<ChannelAccount[]>("list_channel_accounts").catch(() => [] as ChannelAccount[]),
      runCommand<RouteCandidate[]>("list_route_candidates").catch(() => [] as RouteCandidate[]),
      runCommand<ClientConfig[]>("list_clients").catch(() => [] as ClientConfig[]),
      runCommand<ModelPrice[]>("list_model_prices").catch(() => [] as ModelPrice[]),
      runCommand<ChannelModel[]>("list_channel_models").catch(() => [] as ChannelModel[]),
      runCommand<VirtualModel[]>("list_virtual_models").catch(() => [] as VirtualModel[]),
      runCommand<UsageSummaryRow[]>("usage_summary").catch(() => [] as UsageSummaryRow[]),
      runCommand<{ rows: RequestLogRow[]; total: number; page: number; pageSize: number }>(
        "list_request_logs",
        {
          filter: { page: 1, page_size: 50, status: "all", client_id: "", channel_id: "", search: "" },
        }
      ).catch(() => ({ rows: [], total: 0, page: 1, pageSize: 50 })),
      runCommand<AccountBalanceSnapshot[]>("latest_balance_snapshots").catch(
        () => [] as AccountBalanceSnapshot[]
      ),
      runCommand<AccountStatsRow[]>("account_stats").catch(() => [] as AccountStatsRow[]),
      runCommand<RouteRule[]>("list_route_rules").catch(() => [] as RouteRule[]),
      runCommand<Array<[string, string, number, number, number]>>("account_routing_scores").catch(
        () => [] as Array<[string, string, number, number, number]>
      ),
      runCommand<[number, number, number]>("db_stats").catch(() => [0, 0, 0] as [number, number, number]),
    ]);

    // 已有更新的 refreshAll 发起 => 丢弃本次过期结果
    if (token !== refreshTokenRef.current) return;

    runCommand<boolean>("is_autostart_enabled")
      .then(setAutostartEnabled)
      .catch(() => setAutostartEnabled(false));
    runCommand<ProxyBindConfig>("get_proxy_bind_config")
      .then(setProxyBindConfig)
      .catch(() => undefined);

    setChannels(ch);
    setAccounts(ac);
    setRoutes(ro);
    setClients(cl);
    setPrices(pr);
    setChannelModels(cm);
    setVirtualModels(vm);
    setUsageRows(usage);
    setRequestLogs(logs.rows);
    setLogMeta({
      total: logs.total,
      page: logs.page,
      pageSize: logs.pageSize,
      lastFetchedAt: Date.now(),
    });
    setBalanceSnapshots(snapshots);
    setAccountStats(stats);
    setRouteRules(rules);
    setRoutingScores(scores);
    setDbStats(db);
    // 模型开放范围（默认全部开放）。缺失记录时保持 "all"。
    runCommand<string>("read_app_meta", { key: "model_exposure_mode" })
      .then((value) => setExposureMode((value ?? "all") as ModelExposureMode))
      .catch(() => setExposureMode("all"));
  }, []);

  return {
    channels,
    setChannels,
    accounts,
    setAccounts,
    routes,
    setRoutes,
    clients,
    setClients,
    prices,
    setPrices,
    channelModels,
    virtualModels,
    usageRows,
    setUsageRows,
    requestLogs,
    setRequestLogs,
    logMeta,
    setLogMeta,
    logDetail,
    setLogDetail,
    balanceSnapshots,
    routeRules,
    setRouteRules,
    accountStats,
    routingScores,
    dbStats,
    autostartEnabled,
    setAutostartEnabled,
    exposureMode,
    setExposureMode,
    proxyBindConfig,
    setProxyBindConfig,
    status,
    refreshStatus,
    refreshAll,
    refreshChannelModels,
  };
}




