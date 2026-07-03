import React from "react";
import {
  AccountBalanceSnapshot,
  ChannelAccount,
  ChannelPreset,
  protocolLabels
} from "../domain";

export function ChannelsPage({
  channels,
  accounts,
  onAddAccount,
  onUpdateAccount,
  onRemoveAccount,
  onSaveChannels,
  onSaveAccounts,
  onTestConnection,
  onSyncModels,
  getChannelName,
  getBalanceForAccount,
  onAddBalanceSnapshot,
  balanceSnapshots,
  getAccountName,
}: {
  channels: ChannelPreset[];
  accounts: ChannelAccount[];
  onAddAccount: (channelId: string) => void;
  onUpdateAccount: (index: number, patch: Partial<ChannelAccount>) => void;
  onRemoveAccount: (index: number) => void;
  onSaveChannels: () => void;
  onSaveAccounts: () => void;
  onTestConnection: (accountId: string) => void;
  onSyncModels: (accountId: string) => void;
  getChannelName: (channelId: string) => string;
  getBalanceForAccount: (accountId: string) => AccountBalanceSnapshot | undefined;
  onAddBalanceSnapshot: (
    snapshot: Omit<AccountBalanceSnapshot, "id" | "created_at" | "updated_at">
  ) => void;
  balanceSnapshots: AccountBalanceSnapshot[];
  getAccountName: (accountId: string) => string;
}) {
  const [editingChannel, setEditingChannel] = React.useState<string | null>(null);
  const [snapshotAccountId, setSnapshotAccountId] = React.useState<string | null>(null);
  const [snapshotBalance, setSnapshotBalance] = React.useState("");
  const [snapshotCurrency, setSnapshotCurrency] = React.useState("CNY");
  const [snapshotTokenTotal, setSnapshotTokenTotal] = React.useState("");
  const [snapshotTokenExpire, setSnapshotTokenExpire] = React.useState("");
  const [snapshotRemark, setSnapshotRemark] = React.useState("");

  const totalAccounts = accounts.length;
  const enabledAccounts = accounts.filter((a) => a.enabled).length;

  return (
    <>
      <section className="panel">
        <div className="panel-title">
          <h3>渠道模板</h3>
          <div className="actions">
            <button onClick={() => void onSaveChannels()}>保存渠道</button>
          </div>
        </div>
        <div className="channel-grid">
          {channels.map((channel) => (
            <div className="channel-card" key={channel.id}>
              <div className="channel-header">
                <strong>{channel.name}</strong>
                <span className="channel-vendor">{channel.vendor}</span>
              </div>
              <div className="channel-protocols">
                {channel.supported_protocols.map((p) => (
                  <span className="protocol-badge" key={p}>
                    {protocolLabels[p]}
                  </span>
                ))}
              </div>
              <button
                className="link-button"
                onClick={() =>
                  setEditingChannel(editingChannel === channel.id ? null : channel.id)
                }
              >
                {editingChannel === channel.id ? "收起详情" : "查看配置"}
              </button>
              {editingChannel === channel.id ? (
                <div className="channel-detail">
                  <label>
                    OpenAI Base URL
                    <input
                      value={channel.openai_base_url}
                      onChange={(e) => {
                        const idx = channels.findIndex((c) => c.id === channel.id);
                        if (idx >= 0) {
                          const updated = [...channels];
                          updated[idx] = { ...updated[idx], openai_base_url: e.target.value };
                          // State update handled by parent
                        }
                      }}
                    />
                  </label>
                  <label>
                    Anthropic Base URL
                    <input value={channel.anthropic_base_url} readOnly />
                  </label>
                  <label>
                    默认模型
                    <input value={channel.default_model} readOnly />
                  </label>
                  <label>
                    小模型（简单请求自动路由）
                    <input
                      value={channel.small_model ?? ""}
                      placeholder="留空则不使用小模型路由"
                      onChange={(e) => {
                        const idx = channels.findIndex((c) => c.id === channel.id);
                        if (idx >= 0) {
                          const updated = [...channels];
                          updated[idx] = {
                            ...updated[idx],
                            small_model: e.target.value || null,
                          };
                          // State update handled by parent
                        }
                      }}
                    />
                  </label>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </section>
      <section className="panel">
        <div className="panel-title">
          <h3>
            渠道账号 ({enabledAccounts}/{totalAccounts})
          </h3>
          <div className="actions">
            {channels.length > 0 ? (
              <button onClick={() => onAddAccount(channels[0].id)}>新增账号</button>
            ) : null}
            <button onClick={() => void onSaveAccounts()}>保存账号</button>
          </div>
        </div>
        <div className="account-list">
          {accounts.length === 0 ? (
            <p>暂无账号，请先新增</p>
          ) : (
            accounts.map((account, index) => (
              <div className="account-row" key={account.id}>
                <span className="account-channel">{getChannelName(account.channel_id)}</span>
                <input
                  value={account.name}
                  placeholder="账号名称"
                  onChange={(e) => onUpdateAccount(index, { name: e.target.value })}
                />
                <input
                  type="password"
                  value={account.api_key}
                  placeholder="API Key"
                  onChange={(e) => onUpdateAccount(index, { api_key: e.target.value })}
                />
                <input
                  type="number"
                  min="0"
                  value={account.priority}
                  placeholder="优先级"
                  onChange={(e) =>
                    onUpdateAccount(index, { priority: Math.max(0, Number(e.target.value) || 0) })
                  }
                />
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={account.enabled}
                    onChange={(e) => onUpdateAccount(index, { enabled: e.target.checked })}
                  />
                  启用
                </label>
                <div className="account-actions">
                  {account.channel_id === "deepseek" ? (
                    <button onClick={() => void onTestConnection(account.id)} title="查询余额">
                      余额
                    </button>
                  ) : null}
                  {account.channel_id === "deepseek" ? (
                    <button onClick={() => void onSyncModels(account.id)} title="同步模型列表">
                      同步
                    </button>
                  ) : null}
                  <button
                    onClick={() => {
                      setSnapshotAccountId(account.id);
                      const bal = getBalanceForAccount(account.id);
                      if (bal) {
                        setSnapshotBalance(bal.balance?.toString() ?? "");
                        setSnapshotCurrency(bal.currency ?? "CNY");
                        setSnapshotTokenTotal(bal.token_pack_total?.toString() ?? "");
                        setSnapshotTokenExpire(bal.token_pack_expire_at ?? "");
                        setSnapshotRemark(bal.remark ?? "");
                      }
                    }}
                    title="登记余额快照"
                  >
                    登记
                  </button>
                  <button onClick={() => onRemoveAccount(index)}>删除</button>
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      {snapshotAccountId ? (
        <section className="panel">
          <div className="panel-title">
            <h3>登记余额 / 资源包快照</h3>
            <div className="actions">
              <button onClick={() => setSnapshotAccountId(null)}>取消</button>
            </div>
          </div>
          <div className="form-grid">
            <label>
              余额数值
              <input
                type="number"
                min="0"
                step="0.01"
                value={snapshotBalance}
                placeholder="例如 100.50"
                onChange={(e) => setSnapshotBalance(e.target.value)}
              />
            </label>
            <label>
              货币
              <input
                value={snapshotCurrency}
                placeholder="CNY"
                onChange={(e) => setSnapshotCurrency(e.target.value)}
              />
            </label>
            <label>
              Token 资源包总量
              <input
                type="number"
                min="0"
                value={snapshotTokenTotal}
                placeholder="可选，例如 1000000"
                onChange={(e) => setSnapshotTokenTotal(e.target.value)}
              />
            </label>
            <label>
              资源包过期时间
              <input
                type="date"
                value={snapshotTokenExpire}
                onChange={(e) => setSnapshotTokenExpire(e.target.value)}
              />
            </label>
            <label>
              备注
              <input
                value={snapshotRemark}
                placeholder="可选备注"
                onChange={(e) => setSnapshotRemark(e.target.value)}
              />
            </label>
          </div>
          <div className="actions">
            <button
              onClick={() => {
                const balance = snapshotBalance.trim() ? Number(snapshotBalance) : null;
                const total = snapshotTokenTotal.trim() ? Number(snapshotTokenTotal) : null;
                onAddBalanceSnapshot({
                  account_id: snapshotAccountId,
                  balance,
                  currency: snapshotCurrency.trim() || null,
                  token_pack_total: total,
                  token_pack_used: null,
                  token_pack_remaining: total,
                  token_pack_expire_at: snapshotTokenExpire || null,
                  source: "manual",
                  synced_at: null,
                  remark: snapshotRemark.trim() || null,
                });
                setSnapshotAccountId(null);
                setSnapshotBalance("");
                setSnapshotCurrency("CNY");
                setSnapshotTokenTotal("");
                setSnapshotTokenExpire("");
                setSnapshotRemark("");
              }}
            >
              保存快照
            </button>
          </div>
        </section>
      ) : null}

      <section className="panel compact">
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
                  <th>Token 资源包</th>
                  <th>过期时间</th>
                  <th>登记时间</th>
                </tr>
              </thead>
              <tbody>
                {balanceSnapshots.map((snap) => (
                  <tr key={snap.id}>
                    <td>{getAccountName(snap.account_id)}</td>
                    <td>
                      {snap.balance != null
                        ? `${snap.balance} ${snap.currency ?? ""}`
                        : "-"}
                    </td>
                    <td>
                      {snap.token_pack_remaining != null
                        ? `${snap.token_pack_remaining.toLocaleString()} tokens`
                        : "-"}
                    </td>
                    <td>{snap.token_pack_expire_at ?? "-"}</td>
                    <td>{snap.created_at}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
