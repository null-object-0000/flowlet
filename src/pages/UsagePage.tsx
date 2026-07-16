import { Button, Table } from "@mantine/core";
import { Actions, Panel, PanelHeader } from "../components/ui";
import { TableContainer } from "../components/ui";
import { UsageSummaryRow } from "../domain";

export function UsagePage({
  rows,
  onAnalyze,
  onRefresh,
}: {
  rows: UsageSummaryRow[];
  onAnalyze: () => void;
  onRefresh: () => void;
}) {
  return (
    <>
      <Panel>
        <PanelHeader>
          <h3>用量统计</h3>
          <Actions>
            <Button type="button" variant="default" onClick={() => void onAnalyze()}>执行离线分析</Button>
            <Button type="button" onClick={() => void onRefresh()}>刷新</Button>
          </Actions>
        </PanelHeader>
        <TableContainer>
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>日期</Table.Th>
                <Table.Th>客户端</Table.Th>
                <Table.Th>渠道</Table.Th>
                <Table.Th>账号</Table.Th>
                <Table.Th>上游模型</Table.Th>
                <Table.Th>请求数</Table.Th>
                <Table.Th>已知 Token</Table.Th>
                <Table.Th>未知</Table.Th>
                <Table.Th>估算成本</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.length === 0 ? (
                <Table.Tr><Table.Td colSpan={9}>暂无用量数据</Table.Td></Table.Tr>
              ) : (
                rows.map((row, index) => (
                  <Table.Tr key={`${row.date}-${row.channel_id}-${row.account_id}-${row.upstream_model}-${index}`}>
                    <Table.Td>{row.date}</Table.Td>
                    <Table.Td>{row.client_name || row.client_id || "未知"}</Table.Td>
                    <Table.Td>{row.channel_name || row.channel_id || "-"}</Table.Td>
                    <Table.Td>{row.account_name || row.account_id || "-"}</Table.Td>
                    <Table.Td>{row.upstream_model || "-"}</Table.Td>
                    <Table.Td>{row.request_count}</Table.Td>
                    <Table.Td>{row.known_tokens}</Table.Td>
                    <Table.Td>{row.unknown_count}</Table.Td>
                    <Table.Td>${row.estimated_cost.toFixed(6)}</Table.Td>
                  </Table.Tr>
                ))
              )}
            </Table.Tbody>
          </Table>
        </TableContainer>
      </Panel>
    </>
  );
}
