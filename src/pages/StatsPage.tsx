import React from "react";
import { Actions, Panel, PanelHeader } from "../components/ui";
import { AccountStatsRow } from "../domain";

const KB = 1024;

export function StatsPage({
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
      <Panel>
        <PanelHeader>
          <h3>账号成本与稳定性统计</h3>
          <Actions>
            <button onClick={() => void onRefresh()}>刷新</button>
          </Actions>
        </PanelHeader>
        <p className="hint">
          日志捕获配置（Headers / Body / 脱敏 / 体积上限）已移至 <code>config.json</code>，可直接用编辑器修改。
        </p>
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
                          ? row.last_error.slice(0, 40) + "…"
                          : row.last_error
                        : "-"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Panel>
      <Panel>
        <PanelHeader>
          <h3>智能路由评分（成本/延迟/成功率）</h3>
        </PanelHeader>
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
                {routingScores.map(
                  ([accountId, channelId, latency, successRate, cost], idx) => (
                    <tr key={`${accountId}-${channelId}-${idx}`}>
                      <td>{getAccountName(accountId)}</td>
                      <td>{getChannelName(channelId)}</td>
                      <td>{Math.round(latency)} ms</td>
                      <td>{successRate.toFixed(1)}%</td>
                      <td>{"$"}{cost.toFixed(6)}</td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
