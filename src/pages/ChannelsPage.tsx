import React from "react";
import { Actions, EmptyState, Panel, PanelHeader } from "../components/ui";
import { AccountBalanceSnapshot, ChannelAccount, ChannelPreset } from "../domain";
import {
  AccountRow,
  BalanceSnapshotEditor,
} from "../features/channels";

type ChannelsPageProps = {
  channels: ChannelPreset[];
  accounts: ChannelAccount[];
  onAddAccount: (channelId: string) => void;
  onUpdateAccount: (index: number, patch: Partial<ChannelAccount>) => void;
  onRemoveAccount: (index: number) => void;
  onSaveAccounts: () => void;
  onTestConnection: (accountId: string) => void;
  getBalanceForAccount: (accountId: string) => AccountBalanceSnapshot | undefined;
  onAddBalanceSnapshot: (snapshot: Omit<AccountBalanceSnapshot, "id" | "created_at" | "updated_at">) => void;
  proxyRunning: boolean;
  onRestartProxy: () => void;
};

export function ChannelsPage({
  channels,
  accounts,
  onAddAccount,
  onUpdateAccount,
  onRemoveAccount,
  onSaveAccounts,
  onTestConnection,
  getBalanceForAccount,
  onAddBalanceSnapshot,
  proxyRunning,
  onRestartProxy,
}: ChannelsPageProps) {
  const [snapshotAccountId, setSnapshotAccountId] = React.useState<string | null>(null);
  const totalAccounts = accounts.length;
  const enabledAccounts = accounts.filter((a) => a.enabled).length;
  const snapshotAccount = accounts.find((account) => account.id === snapshotAccountId);

  function saveBalanceSnapshot(snapshot: Omit<AccountBalanceSnapshot, "id" | "created_at" | "updated_at">) {
    onAddBalanceSnapshot(snapshot);
    setSnapshotAccountId(null);
  }

  function getBaseUrl(channelId: string): string {
    const channel = channels.find((c) => c.id === channelId);
    if (!channel) return "";
    return channel.openai_base_url;
  }

  return (
    <>
      <Panel>
        <PanelHeader>
          <h3>
            渠道账号 ({enabledAccounts}/{totalAccounts})
          </h3>
          <Actions>
            {channels.length > 0 ? <button onClick={() => onAddAccount(channels[0].id)}>新增账号</button> : null}
            <button onClick={() => void onSaveAccounts()}>保存账号</button>
            {proxyRunning ? <button onClick={() => void onRestartProxy()}>重启代理</button> : null}
          </Actions>
        </PanelHeader>
        <p className="hint">
          保存账号后代理自动热更新配置。若修改未生效，可点击「重启代理」。
        </p>
        <div className="account-list">
          {accounts.length === 0 ? (
            <EmptyState>
              <p>你还没有配置渠道账号。</p>
              <p>请选择 LongCat 或 DeepSeek，并填写 API Key 后开始使用。</p>
              <Actions>
                {channels.map((channel) => (
                  <button key={channel.id} onClick={() => onAddAccount(channel.id)}>
                    新增{channel.name}账号
                  </button>
                ))}
              </Actions>
            </EmptyState>
          ) : (
            accounts.map((account, index) => (
              <AccountRow
                account={account}
                index={index}
                channels={channels}
                key={account.id}
                onUpdate={onUpdateAccount}
                onRemove={onRemoveAccount}
                onTestConnection={onTestConnection}
                getBalanceForAccount={getBalanceForAccount}
                onEditSnapshot={setSnapshotAccountId}
                getBaseUrl={getBaseUrl}
              />
            ))
          )}
        </div>
      </Panel>

      {snapshotAccount ? (
        <BalanceSnapshotEditor
          account={snapshotAccount}
          initialSnapshot={getBalanceForAccount(snapshotAccount.id)}
          onCancel={() => setSnapshotAccountId(null)}
          onSave={saveBalanceSnapshot}
        />
      ) : null}
    </>
  );
}
