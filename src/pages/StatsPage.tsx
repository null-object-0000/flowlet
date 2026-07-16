import { Button, Table } from "@mantine/core";
import { Actions, DetailsPanel, Panel, PanelHeader, TableContainer } from "../components/ui";
import { AccountStatsRow } from "../domain";

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
    <div className="settings-page">
      <header className="page-header">
        <div>
          <h2>高级设置</h2>
          <p>系统级配置、日志维护与高级路由能力</p>
        </div>
        <Button type="button" onClick={() => void onRefresh()}>刷新</Button>
      </header>

      <section className="settings-grid">
        {[
          ["系统设置", "监听地址、端口、局域网访问、开机自启动等运行参数。"],
          ["日志设置", "请求/响应捕获、脱敏、体积上限与日志保留策略。"],
          ["配置导入导出", "备份、迁移和验证 Flowlet 本地配置文件。"],
          ["运行设置", "代理监听、局域网访问、自启动等运行参数。"],
          ["日志设置", "请求/响应捕获、脱敏、体积上限与日志保留策略。"],
          ["配置维护", "备份、迁移和验证 Flowlet 本地配置文件。"],
          ["数据清理", "按保留周期清理请求日志和用量统计数据。"],
          ["诊断工具", "成本、延迟与成功率评分等诊断能力。"],
          ["实验功能", "保留未来桌面端实验开关的入口。"],
        ].map(([title, body]) => (
          <Panel className="settings-card" key={title}>
            <h3>{title}</h3>
            <p>{body}</p>
          </Panel>
        ))}
      </section>

      <DetailsPanel summary="实验功能：账号成本与稳定性诊断">
        <PanelHeader>
          <h3>账号成本与稳定性统计</h3>
          <Actions><Button type="button" variant="default" onClick={() => void onRefresh()}>刷新统计</Button></Actions>
        </PanelHeader>
        <TableContainer>
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>账号</Table.Th>
                <Table.Th>渠道</Table.Th>
                <Table.Th>请求数</Table.Th>
                <Table.Th>成功</Table.Th>
                <Table.Th>失败</Table.Th>
                <Table.Th>失败率</Table.Th>
                <Table.Th>Fallback</Table.Th>
                <Table.Th>Token</Table.Th>
                <Table.Th>估算成本</Table.Th>
                <Table.Th>最近错误</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.length === 0 ? (
                <Table.Tr><Table.Td colSpan={10}>暂无统计数据</Table.Td></Table.Tr>
              ) : rows.map((row) => (
                <Table.Tr key={row.account_id}>
                  <Table.Td>{row.account_name || row.account_id}</Table.Td>
                  <Table.Td>{row.channel_name || row.channel_id || "-"}</Table.Td>
                  <Table.Td>{row.total_requests}</Table.Td>
                  <Table.Td>{row.success_requests}</Table.Td>
                  <Table.Td>{row.failed_requests}</Table.Td>
                  <Table.Td>{row.failure_rate.toFixed(1)}%</Table.Td>
                  <Table.Td>{row.total_fallbacks}</Table.Td>
                  <Table.Td>{row.known_tokens.toLocaleString()}</Table.Td>
                  <Table.Td>{"$"}{row.estimated_cost.toFixed(6)}</Table.Td>
                  <Table.Td title={row.last_error ?? ""}>{row.last_error ? row.last_error.slice(0, 42) : "-"}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </TableContainer>
      </DetailsPanel>

      <DetailsPanel summary="实验功能：路由评分">
        <PanelHeader><h3>智能路由评分（成本/延迟/成功率）</h3></PanelHeader>
        {routingScores.length === 0 ? <p>暂无评分数据。需要至少 3 条请求记录才能计算。</p> : (
          <TableContainer>
            <Table striped highlightOnHover>
              <Table.Thead><Table.Tr><Table.Th>账号</Table.Th><Table.Th>渠道</Table.Th><Table.Th>平均延迟</Table.Th><Table.Th>成功率</Table.Th><Table.Th>单次成本</Table.Th></Table.Tr></Table.Thead>
              <Table.Tbody>
                {routingScores.map(([accountId, channelId, latency, successRate, cost], idx) => (
                  <Table.Tr key={`${accountId}-${channelId}-${idx}`}>
                    <Table.Td>{getAccountName(accountId)}</Table.Td>
                    <Table.Td>{getChannelName(channelId)}</Table.Td>
                    <Table.Td>{Math.round(latency)} ms</Table.Td>
                    <Table.Td>{successRate.toFixed(1)}%</Table.Td>
                    <Table.Td>{"$"}{cost.toFixed(6)}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </TableContainer>
        )}
      </DetailsPanel>
    </div>
  );
}
