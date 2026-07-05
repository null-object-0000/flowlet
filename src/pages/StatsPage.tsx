import { Actions, DetailsPanel, Panel, PanelHeader } from "../components/ui";
import {
  AccountStatsRow,
  ChannelAccount,
  ChannelPreset,
  ClientConfig,
  RouteCandidate,
  RouteRule,
  VirtualModel,
} from "../domain";
import { RouteCandidatesPanel, RouteRulesPanel } from "../features/routes";

export function StatsPage({
  rows,
  onRefresh,
  routingScores,
  getAccountName,
  getChannelName,
  routes,
  channels,
  accounts,
  virtualModels,
  onAddRoute,
  onUpdateRoute,
  onRemoveRoute,
  onSaveRoutes,
  routeRules,
  clients,
  onAddRouteRule,
  onUpdateRouteRule,
  onRemoveRouteRule,
  onSaveRouteRules,
}: {
  rows: AccountStatsRow[];
  onRefresh: () => void;
  routingScores: Array<[string, string, number, number, number]>;
  getAccountName: (accountId: string) => string;
  getChannelName: (channelId: string) => string;
  routes: RouteCandidate[];
  channels: ChannelPreset[];
  accounts: ChannelAccount[];
  virtualModels: VirtualModel[];
  onAddRoute: () => void;
  onUpdateRoute: (index: number, patch: Partial<RouteCandidate>) => void;
  onRemoveRoute: (index: number) => void;
  onSaveRoutes: () => void;
  routeRules: RouteRule[];
  clients: ClientConfig[];
  onAddRouteRule: () => void;
  onUpdateRouteRule: (index: number, patch: Partial<RouteRule>) => void;
  onRemoveRouteRule: (index: number) => void;
  onSaveRouteRules: () => void;
}) {
  return (
    <div className="settings-page">
      <header className="page-header">
        <div>
          <h2>高级设置</h2>
          <p>系统级配置、日志维护与高级路由能力</p>
        </div>
        <button type="button" className="primary" onClick={() => void onRefresh()}>刷新</button>
      </header>

      <section className="settings-grid">
        {[
          ["系统设置", "监听地址、端口、局域网访问、开机自启动等运行参数。"],
          ["日志设置", "请求/响应捕获、脱敏、体积上限与日志保留策略。"],
          ["配置导入导出", "备份、迁移和验证 Flowlet 本地配置文件。"],
          ["高级路由 / 模型映射", "维护 route candidate、上游模型映射和路由优先级。"],
          ["规则路由", "按客户端、协议或模型将请求强制路由到指定账号。"],
          ["实验功能", "成本、延迟与成功率评分等诊断能力。"],
        ].map(([title, body]) => (
          <Panel className="settings-card" key={title}>
            <h3>{title}</h3>
            <p>{body}</p>
          </Panel>
        ))}
      </section>

      <RouteCandidatesPanel
        routes={routes}
        channels={channels}
        accounts={accounts}
        virtualModels={virtualModels}
        onAdd={onAddRoute}
        onUpdate={onUpdateRoute}
        onRemove={onRemoveRoute}
        onSave={onSaveRoutes}
      />

      <RouteRulesPanel
        routeRules={routeRules}
        channels={channels}
        accounts={accounts}
        clients={clients}
        onAddRouteRule={onAddRouteRule}
        onUpdateRouteRule={onUpdateRouteRule}
        onRemoveRouteRule={onRemoveRouteRule}
        onSaveRouteRules={onSaveRouteRules}
      />

      <DetailsPanel summary="实验功能：账号成本与稳定性诊断">
        <PanelHeader>
          <h3>账号成本与稳定性统计</h3>
          <Actions><button type="button" onClick={() => void onRefresh()}>刷新统计</button></Actions>
        </PanelHeader>
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
                <tr><td colSpan={10}>暂无统计数据</td></tr>
              ) : rows.map((row) => (
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
                  <td title={row.last_error ?? ""}>{row.last_error ? row.last_error.slice(0, 42) : "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </DetailsPanel>

      <DetailsPanel summary="实验功能：路由评分">
        <PanelHeader><h3>智能路由评分（成本/延迟/成功率）</h3></PanelHeader>
        {routingScores.length === 0 ? <p>暂无评分数据。需要至少 3 条请求记录才能计算。</p> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>账号</th><th>渠道</th><th>平均延迟</th><th>成功率</th><th>单次成本</th></tr></thead>
              <tbody>
                {routingScores.map(([accountId, channelId, latency, successRate, cost], idx) => (
                  <tr key={`${accountId}-${channelId}-${idx}`}>
                    <td>{getAccountName(accountId)}</td>
                    <td>{getChannelName(channelId)}</td>
                    <td>{Math.round(latency)} ms</td>
                    <td>{successRate.toFixed(1)}%</td>
                    <td>{"$"}{cost.toFixed(6)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </DetailsPanel>
    </div>
  );
}
