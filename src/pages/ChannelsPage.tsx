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
  const [snapshotTokenUsed, setSnapshotTokenUsed] = React.useState("");
  const [snapshotTokenRemaining, setSnapshotTokenRemaining] = React.useState("");
  const [snapshotTokenExpire, setSnapshotTokenExpire] = React.useState("");
  const [snapshotRemark, setSnapshotRemark] = React.useState("");

  const totalAccounts = accounts.length;
  const enabledAccounts = accounts.filter((a) => a.enabled).length;
  const snapshotAccount = accounts.find((account) => account.id === snapshotAccountId);
  const isLongCatSnapshot = snapshotAccount?.channel_id === "longcat";

  function resetSnapshotForm() {
    setSnapshotAccountId(null);
    setSnapshotBalance("");
    setSnapshotCurrency("CNY");
    setSnapshotTokenTotal("");
    setSnapshotTokenUsed("");
    setSnapshotTokenRemaining("");
    setSnapshotTokenExpire("");
    setSnapshotRemark("");
  }

  function parseToken(value: string): number | null {
    if (!value.trim()) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : null;
  }

  function setTokenTotal(value: string) {
    setSnapshotTokenTotal(value);
    const total = parseToken(value);
    const used = parseToken(snapshotTokenUsed);
    const remaining = parseToken(snapshotTokenRemaining);
    if (total == null) return;
    if (used != null) {
      setSnapshotTokenRemaining(Math.max(0, total - used).toString());
    } else if (remaining != null) {
      setSnapshotTokenUsed(Math.max(0, total - remaining).toString());
    }
  }

  function setTokenUsed(value: string) {
    setSnapshotTokenUsed(value);
    const total = parseToken(snapshotTokenTotal);
    const used = parseToken(value);
    if (total != null && used != null) {
      setSnapshotTokenRemaining(Math.max(0, total - used).toString());
    }
  }

  function setTokenRemaining(value: string) {
    setSnapshotTokenRemaining(value);
    const total = parseToken(snapshotTokenTotal);
    const remaining = parseToken(value);
    if (total != null && remaining != null) {
      setSnapshotTokenUsed(Math.max(0, total - remaining).toString());
    }
  }

  function snapshotSummary(account: ChannelAccount): string | null {
    const snapshot = getBalanceForAccount(account.id);
    if (!snapshot) return null;
    if (account.channel_id === "longcat" && snapshot.token_pack_remaining != null) {
      return `资源包剩余：${snapshot.token_pack_remaining.toLocaleString()} Tokens`;
    }
    if (snapshot.balance != null) {
      return `余额：${snapshot.balance} ${snapshot.currency ?? ""}`.trim();
    }
    return null;
  }

  return (
    <>
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
            <div className="empty-state">
              <p>你还没有配置渠道账号。</p>
              <p>请选择 LongCat 或 DeepSeek，并填写 API Key 后开始使用。</p>
              <div className="actions">
                {channels.map((channel) => (
                  <button key={channel.id} onClick={() => onAddAccount(channel.id)}>
                    新增{channel.name}账号
                  </button>
                ))}
              </div>
            </div>
          ) : (
            accounts.map((account, index) => (
              <div className="account-row" key={account.id}>
                <select
                  value={account.channel_id}
                  onChange={(e) => onUpdateAccount(index, { channel_id: e.target.value })}
                >
                  {channels.map((channel) => (
                    <option key={channel.id} value={channel.id}>
                      {channel.name}
                    </option>
                  ))}
                </select>
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
                <input
                  value={account.remark ?? ""}
                  placeholder="备注"
                  onChange={(e) => onUpdateAccount(index, { remark: e.target.value })}
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
                  {snapshotSummary(account) ? (
                    <span className="account-snapshot">{snapshotSummary(account)}</span>
                  ) : null}
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
                        setSnapshotTokenUsed(bal.token_pack_used?.toString() ?? "");
                        setSnapshotTokenRemaining(bal.token_pack_remaining?.toString() ?? "");
                        setSnapshotTokenExpire(bal.token_pack_expire_at ?? "");
                        setSnapshotRemark(bal.remark ?? "");
                      } else {
                        setSnapshotBalance("");
                        setSnapshotCurrency("CNY");
                        setSnapshotTokenTotal("");
                        setSnapshotTokenUsed("");
                        setSnapshotTokenRemaining("");
                        setSnapshotTokenExpire("");
                        setSnapshotRemark("");
                      }
                    }}
                    title={account.channel_id === "longcat" ? "登记 Token 资源包快照" : "登记余额快照"}
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

      <details className="panel advanced-panel">
        <summary>高级设置：渠道模板</summary>
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
              <button onClick={() => onAddAccount(channel.id)}>新增{channel.name}账号</button>
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
                      onChange={() => {
                        // 渠道模板编辑在后续高级设置中统一完善。
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
                    <input value={channel.small_model ?? ""} placeholder="留空则不使用小模型路由" readOnly />
                  </label>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </details>

      {snapshotAccountId ? (
        <section className="panel">
          <div className="panel-title">
            <h3>{isLongCatSnapshot ? "登记 Token 资源包快照" : "登记余额快照"}</h3>
            <div className="actions">
              <button onClick={resetSnapshotForm}>取消</button>
            </div>
          </div>
          <div className="form-grid">
            {!isLongCatSnapshot ? (
              <>
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
              </>
            ) : null}
            {isLongCatSnapshot ? (
              <>
                <label>
                  Token 资源包总量
                  <input
                    type="number"
                    min="0"
                    value={snapshotTokenTotal}
                    placeholder="可选，例如 1000000"
                    onChange={(e) => setTokenTotal(e.target.value)}
                  />
                </label>
                <label>
                  已消耗 Token
                  <input
                    type="number"
                    min="0"
                    value={snapshotTokenUsed}
                    placeholder="例如 250000"
                    onChange={(e) => setTokenUsed(e.target.value)}
                  />
                </label>
                <label>
                  剩余 Token
                  <input
                    type="number"
                    min="0"
                    value={snapshotTokenRemaining}
                    placeholder="例如 750000"
                    onChange={(e) => setTokenRemaining(e.target.value)}
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
              </>
            ) : null}
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
                const used = snapshotTokenUsed.trim() ? Number(snapshotTokenUsed) : null;
                const remaining = snapshotTokenRemaining.trim()
                  ? Number(snapshotTokenRemaining)
                  : null;
                if (
                  [total, used, remaining].some((value) => value != null && value < 0) ||
                  (total != null && used != null && used > total) ||
                  (total != null && remaining != null && remaining > total)
                ) {
                  return;
                }
                onAddBalanceSnapshot({
                  account_id: snapshotAccountId,
                  balance: isLongCatSnapshot ? null : balance,
                  currency: isLongCatSnapshot ? null : snapshotCurrency.trim() || null,
                  token_pack_total: isLongCatSnapshot ? total : null,
                  token_pack_used: isLongCatSnapshot ? used : null,
                  token_pack_remaining: isLongCatSnapshot ? remaining : null,
                  token_pack_expire_at: isLongCatSnapshot ? snapshotTokenExpire || null : null,
                  source: "manual",
                  synced_at: new Date().toISOString(),
                  remark: snapshotRemark.trim() || null,
                });
                resetSnapshotForm();
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
                    <td>
                      {snap.balance != null
                        ? `${snap.balance} ${snap.currency ?? ""}`
                        : "-"}
                    </td>
                    <td>
                      {snap.token_pack_remaining != null
                        ? `${snap.token_pack_remaining.toLocaleString()} Tokens`
                        : "-"}
                    </td>
                    <td>
                      {snap.token_pack_used != null
                        ? `${snap.token_pack_used.toLocaleString()} Tokens`
                        : "-"}
                    </td>
                    <td>
                      {snap.token_pack_total != null
                        ? `${snap.token_pack_total.toLocaleString()} Tokens`
                        : "-"}
                    </td>
                    <td>{snap.token_pack_expire_at ?? "-"}</td>
                    <td>{snap.synced_at ?? snap.updated_at}</td>
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
