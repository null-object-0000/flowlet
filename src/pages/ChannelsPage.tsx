import React from "react";
import { Button, TextInput } from "@mantine/core";
import { Actions, EmptyState, Panel, PanelHeader } from "../components/ui";
import { AccountBalanceSnapshot, ChannelAccount, ChannelPreset } from "../domain";
import { AccountEditorDrawer, AccountEditorRequest, AccountRow } from "../features/channels";

type ChannelsPageProps = {
  channels: ChannelPreset[];
  accounts: ChannelAccount[];
  onSaveAccounts: (accounts?: ChannelAccount[]) => Promise<void>;
  onTestConnection: (accountId: string) => void;
  getBalanceForAccount: (accountId: string) => AccountBalanceSnapshot | undefined;
  onAddBalanceSnapshot: (snapshot: Omit<AccountBalanceSnapshot, "id" | "created_at" | "updated_at">) => void;
  proxyRunning: boolean;
  onRestartProxy: () => void;
};

export function ChannelsPage({
  channels,
  accounts,
  onSaveAccounts,
  onTestConnection,
  getBalanceForAccount,
  onAddBalanceSnapshot,
  proxyRunning,
  onRestartProxy,
}: ChannelsPageProps) {
  const [editor, setEditor] = React.useState<AccountEditorRequest | null>(null);
  const [search, setSearch] = React.useState("");
  const enabledAccounts = accounts.filter((account) => account.enabled).length;
  const filteredAccounts = accounts
    .map((account, index) => ({ account, index }))
    .filter(({ account }) => {
      const channel = channels.find((item) => item.id === account.channel_id);
      const keyword = search.trim().toLowerCase();
      return !keyword || account.name.toLowerCase().includes(keyword) || channel?.name.toLowerCase().includes(keyword);
    });

  function openCreate(channelId = channels[0]?.id ?? "longcat") {
    setEditor({ mode: "create", channelId });
  }

  return (
    <>
      <section className="channel-account-heading">
        <div><h2>渠道账号</h2><p>管理上游渠道账号，用于模型转发</p></div>
        <Actions>
          {proxyRunning ? <Button variant="default" onClick={() => void onRestartProxy()}>重启代理</Button> : null}
          <Button onClick={() => openCreate()}>＋ 新增账号</Button>
        </Actions>
      </section>

      <section className="channel-account-stats">
        <div><span>账号总数</span><strong>{accounts.length}<small> 个</small></strong></div>
        <div><span>启用中</span><strong>{enabledAccounts}<small> 个</small></strong></div>
        <div><span>已接入渠道</span><strong>{new Set(accounts.map((account) => account.channel_id)).size}<small> 个</small></strong></div>
      </section>

      <Panel className="channel-account-panel">
        <PanelHeader>
          <TextInput value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索账号名称或渠道" aria-label="搜索账号" />
          <span className="hint">共 {filteredAccounts.length} 条</span>
        </PanelHeader>
        {accounts.length === 0 ? (
          <EmptyState>
            <p>你还没有配置渠道账号。</p>
            <p>选择 LongCat 或 DeepSeek，并在侧边栏中填写 API Key 后开始使用。</p>
            <Actions>{channels.map((channel) => <Button variant="default" key={channel.id} onClick={() => openCreate(channel.id)}>新增{channel.name}账号</Button>)}</Actions>
          </EmptyState>
        ) : (
          <div className="account-summary-table">
            <div className="account-summary-head"><span>账号名称</span><span>渠道</span><span>资源状态</span><span>状态</span><span>操作</span></div>
            {filteredAccounts.map(({ account, index }) => (
              <AccountRow
                key={account.id}
                account={account}
                channel={channels.find((item) => item.id === account.channel_id)}
                snapshot={getBalanceForAccount(account.id)}
                onEdit={() => setEditor({ mode: "edit", index })}
              />
            ))}
          </div>
        )}
      </Panel>

      {editor ? (
        <AccountEditorDrawer
          request={editor}
          accounts={accounts}
          channels={channels}
          onClose={() => setEditor(null)}
          onSaveAccounts={(next) => onSaveAccounts(next)}
          onTestConnection={onTestConnection}
          getBalanceForAccount={getBalanceForAccount}
          onAddBalanceSnapshot={onAddBalanceSnapshot}
        />
      ) : null}
    </>
  );
}
