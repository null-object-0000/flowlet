import React from "react";
import {
  AccountBalanceSnapshot,
  AccountStatsRow,
  ChannelAccount,
  ChannelModel,
  ChannelPreset,
  ClientConfig,
  LogCaptureConfig,
  ModelPrice,
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
  const [logDetail, setLogDetail] = React.useState<RequestLogRow[] | null>(null);
  const [logCaptureConfig, setLogCaptureConfig] = React.useState<LogCaptureConfig | null>(null);
  const [balanceSnapshots, setBalanceSnapshots] = React.useState<AccountBalanceSnapshot[]>([]);
  const [routeRules, setRouteRules] = React.useState<RouteRule[]>([]);
  const [accountStats, setAccountStats] = React.useState<AccountStatsRow[]>([]);
  const [routingScores, setRoutingScores] = React.useState<Array<[string, string, number, number, number]>>([]);
  const [dbStats, setDbStats] = React.useState<[number, number, number] | null>(null);
  const [autostartEnabled, setAutostartEnabled] = React.useState(false);
  const [status, setStatus] = React.useState<ProxyStatus>({
    running: false,
    bind_addr: "127.0.0.1:18640",
  });

  const refreshStatus = React.useCallback(async () => {
    const next = await runCommand<ProxyStatus>("proxy_status");
    setStatus(next);
  }, []);

  const refreshChannelModels = React.useCallback(async () => {
    const models = await runCommand<ChannelModel[]>("list_channel_models").catch(() => [] as ChannelModel[]);
    setChannelModels(models);
  }, []);

  const refreshLogCaptureConfig = React.useCallback(async () => {
    const cfg = await runCommand<LogCaptureConfig>("get_log_capture_config").catch(() => null);
    setLogCaptureConfig(cfg);
  }, []);

  const refreshAll = React.useCallback(async () => {
    const [ch, ac, ro, cl, pr, cm, vm, usage, logs, snapshots, stats, rules, scores, db] = await Promise.all([
      runCommand<ChannelPreset[]>("list_channel_presets").catch(() => [] as ChannelPreset[]),
      runCommand<ChannelAccount[]>("list_channel_accounts").catch(() => [] as ChannelAccount[]),
      runCommand<RouteCandidate[]>("list_route_candidates").catch(() => [] as RouteCandidate[]),
      runCommand<ClientConfig[]>("list_clients").catch(() => [] as ClientConfig[]),
      runCommand<ModelPrice[]>("list_model_prices").catch(() => [] as ModelPrice[]),
      runCommand<ChannelModel[]>("list_channel_models").catch(() => [] as ChannelModel[]),
      runCommand<VirtualModel[]>("list_virtual_models").catch(() => [] as VirtualModel[]),
      runCommand<UsageSummaryRow[]>("usage_summary").catch(() => [] as UsageSummaryRow[]),
      runCommand<RequestLogRow[]>("list_request_logs").catch(() => [] as RequestLogRow[]),
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

    runCommand<boolean>("is_autostart_enabled")
      .then(setAutostartEnabled)
      .catch(() => setAutostartEnabled(false));

    setChannels(ch);
    setAccounts(ac);
    setRoutes(ro);
    setClients(cl);
    setPrices(pr);
    setChannelModels(cm);
    setVirtualModels(vm);
    setUsageRows(usage);
    setRequestLogs(logs);
    setBalanceSnapshots(snapshots);
    setAccountStats(stats);
    setRouteRules(rules);
    setRoutingScores(scores);
    setDbStats(db);
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
    logDetail,
    setLogDetail,
    logCaptureConfig,
    setLogCaptureConfig,
    balanceSnapshots,
    routeRules,
    setRouteRules,
    accountStats,
    routingScores,
    dbStats,
    autostartEnabled,
    setAutostartEnabled,
    status,
    refreshStatus,
    refreshAll,
    refreshChannelModels,
    refreshLogCaptureConfig,
  };
}
