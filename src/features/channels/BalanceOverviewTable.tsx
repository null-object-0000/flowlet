import { Table } from "@mantine/core";
import { Panel, TableContainer } from "../../components/ui";
import { AccountBalanceSnapshot } from "../../domain";
import { formatTokenCount } from "./LongCatPackImportDialog";

type BalanceOverviewTableProps = {
  balanceSnapshots: AccountBalanceSnapshot[];
  getAccountName: (accountId: string) => string;
};

export function BalanceOverviewTable({ balanceSnapshots, getAccountName }: BalanceOverviewTableProps) {
  return (
    <Panel className="compact">
      <h3>账号余额概览</h3>
      {balanceSnapshots.length === 0 ? (
        <p>暂无余额快照。点击账号右侧"登记"按钮手动添加。</p>
      ) : (
        <TableContainer>
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>账号</Table.Th>
                <Table.Th>余额</Table.Th>
                <Table.Th>资源包剩余</Table.Th>
                <Table.Th>已消耗</Table.Th>
                <Table.Th>总量</Table.Th>
                <Table.Th>过期时间</Table.Th>
                <Table.Th>更新时间</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {balanceSnapshots.map((snap) => (
                <Table.Tr key={snap.id}>
                  <Table.Td>{getAccountName(snap.account_id)}</Table.Td>
                  <Table.Td>{snap.balance != null ? `${snap.balance} ${snap.currency ?? ""}` : "-"}</Table.Td>
                  <Table.Td>{formatTokenCount(snap.token_pack_remaining)} Tokens</Table.Td>
                  <Table.Td>{formatTokenCount(snap.token_pack_used)} Tokens</Table.Td>
                  <Table.Td>{formatTokenCount(snap.token_pack_total)} Tokens</Table.Td>
                  <Table.Td>{snap.token_pack_expire_at ?? "-"}</Table.Td>
                  <Table.Td>{snap.synced_at ?? snap.updated_at}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </TableContainer>
      )}
    </Panel>
  );
}

