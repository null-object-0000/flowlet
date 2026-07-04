import { AccountBalanceSnapshot, ChannelAccount, ChannelPreset } from "../../domain";

type AccountRowProps = {
  account: ChannelAccount;
  index: number;
  channels: ChannelPreset[];
  onUpdate: (index: number, patch: Partial<ChannelAccount>) => void;
  onRemove: (index: number) => void;
  onTestConnection: (accountId: string) => void;
  getBalanceForAccount: (accountId: string) => AccountBalanceSnapshot | undefined;
  onEditSnapshot: (accountId: string) => void;
};

function snapshotSummary(account: ChannelAccount, snapshot?: AccountBalanceSnapshot): string | null {
  if (!snapshot) return null;
  if (account.channel_id === "longcat" && snapshot.token_pack_remaining != null) {
    return `资源包剩余：${snapshot.token_pack_remaining.toLocaleString()} Tokens`;
  }
  if (snapshot.balance != null) {
    return `余额：${snapshot.balance} ${snapshot.currency ?? ""}`.trim();
  }
  return null;
}

export function AccountRow({
  account,
  index,
  channels,
  onUpdate,
  onRemove,
  onTestConnection,
  getBalanceForAccount,
  onEditSnapshot,
}: AccountRowProps) {
  const summary = snapshotSummary(account, getBalanceForAccount(account.id));

  return (
    <div className="account-row">
      <select value={account.channel_id} onChange={(e) => onUpdate(index, { channel_id: e.target.value })}>
        {channels.map((channel) => (
          <option key={channel.id} value={channel.id}>
            {channel.name}
          </option>
        ))}
      </select>
      <input value={account.name} placeholder="账号名称" onChange={(e) => onUpdate(index, { name: e.target.value })} />
      <input
        type="password"
        value={account.api_key}
        placeholder="API Key"
        onChange={(e) => onUpdate(index, { api_key: e.target.value })}
      />
      <input
        type="number"
        min="0"
        value={account.priority}
        placeholder="优先级"
        onChange={(e) => onUpdate(index, { priority: Math.max(0, Number(e.target.value) || 0) })}
      />
      <input
        value={account.remark ?? ""}
        placeholder="备注"
        onChange={(e) => onUpdate(index, { remark: e.target.value })}
      />
      <label className="checkbox-label">
        <input type="checkbox" checked={account.enabled} onChange={(e) => onUpdate(index, { enabled: e.target.checked })} />
        启用
      </label>
      <div className="account-actions">
        {summary ? <span className="account-snapshot">{summary}</span> : null}
        {account.channel_id === "deepseek" ? (
          <button onClick={() => void onTestConnection(account.id)} title="自动同步余额">
            余额
          </button>
        ) : null}
        {account.channel_id === "longcat" ? (
          <button
            onClick={() => onEditSnapshot(account.id)}
            title="登记 Token 资源包快照"
          >
            登记资源包
          </button>
        ) : null}
        <button onClick={() => onRemove(index)}>删除</button>
      </div>
    </div>
  );
}
