import React from "react";
import { Button, PasswordInput, Select, Switch, TextInput } from "@mantine/core";
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
  getBaseUrl: (channelId: string) => string;
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
  getBaseUrl,
}: AccountRowProps) {
  const [showAdvanced, setShowAdvanced] = React.useState(false);
  const summary = snapshotSummary(account, getBalanceForAccount(account.id));
  const hasOverride = account.base_url_override != null && account.base_url_override.trim().length > 0;

  return (
    <div className="account-row">
      <Select
        value={account.channel_id}
        onChange={(value) => value && onUpdate(index, { channel_id: value })}
        data={channels.map((channel) => ({ value: channel.id, label: channel.name }))}
        aria-label="渠道"
      />
      <TextInput value={account.name} placeholder="账号名称" onChange={(e) => onUpdate(index, { name: e.target.value })} />
      <PasswordInput
        value={account.api_key}
        placeholder="API Key"
        onChange={(e) => onUpdate(index, { api_key: e.target.value })}
      />
      <Switch label="启用" checked={account.enabled} onChange={(e) => onUpdate(index, { enabled: e.currentTarget.checked })} />
      <div className="account-actions">
        {summary ? <span className="account-snapshot">{summary}</span> : null}
        {account.channel_id === "deepseek" ? (
          <Button type="button" variant="default" onClick={() => void onTestConnection(account.id)} title="自动同步余额">
            余额
          </Button>
        ) : null}
        {account.channel_id === "longcat" ? (
          <Button type="button"
            variant="default"
            onClick={() => onEditSnapshot(account.id)}
            title="登记 Token 资源包快照"
          >
            登记资源包
          </Button>
        ) : null}
        <Button type="button"
          variant={hasOverride ? "light" : "default"}
          onClick={() => setShowAdvanced(!showAdvanced)}
          title="账号高级配置（Base URL）"
        >
          高级配置
        </Button>
        <Button type="button" variant="subtle" color="red" onClick={() => onRemove(index)}>删除</Button>
      </div>
      {showAdvanced ? (
        <div className="account-advanced">
          <TextInput
            label="Base URL 覆盖（留空则使用渠道默认）"
            value={account.base_url_override ?? ""}
            placeholder={getBaseUrl(account.channel_id)}
            onChange={(e) => onUpdate(index, { base_url_override: e.target.value || null })}
          />
          {hasOverride ? (
            <Button type="button" variant="subtle" onClick={() => onUpdate(index, { base_url_override: null })}>
              恢复渠道默认
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
