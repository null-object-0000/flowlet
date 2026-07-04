import { Actions, EmptyState, Panel, PanelHeader, ProtocolBadges, StatusPill } from "../../components/ui";
import { AccountBalanceSnapshot } from "../../domain";

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
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>账号</th>
                <th>余额</th>
                <th>资源包剩余</th>
                <th>已消耗</th>
                <th>总量</th>
                <th>过期时间</th>
                <th>更新时间</th>
              </tr>
            </thead>
            <tbody>
              {balanceSnapshots.map((snap) => (
                <tr key={snap.id}>
                  <td>{getAccountName(snap.account_id)}</td>
                  <td>{snap.balance != null ? `${snap.balance} ${snap.currency ?? ""}` : "-"}</td>
                  <td>{snap.token_pack_remaining != null ? `${snap.token_pack_remaining.toLocaleString()} Tokens` : "-"}</td>
                  <td>{snap.token_pack_used != null ? `${snap.token_pack_used.toLocaleString()} Tokens` : "-"}</td>
                  <td>{snap.token_pack_total != null ? `${snap.token_pack_total.toLocaleString()} Tokens` : "-"}</td>
                  <td>{snap.token_pack_expire_at ?? "-"}</td>
                  <td>{snap.synced_at ?? snap.updated_at}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

