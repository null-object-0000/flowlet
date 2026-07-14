import React from "react";
import { ActionIcon, Button, Group, Text, Tooltip } from "@mantine/core";
import { IconChevronRight, IconDotsVertical } from "@tabler/icons-react";
import { AccountBalanceSnapshot, ChannelAccount, ChannelPreset } from "../../domain";
import { ChannelLogo } from "../../components/ChannelLogo";
import { Panel, PanelHeader, StatusPill } from "../../components/ui";
import { formatAmount, formatIsoDateTime, formatTokenCount } from "./formatters";

type ChannelAccountsPanelProps = {
  accounts: ChannelAccount[];
  channels: ChannelPreset[];
  getBalanceForAccount: (accountId: string) => AccountBalanceSnapshot | undefined;
  getChannelName: (channelId: string) => string;
  onCreateAccount: () => void;
  onOpenManagementDrawer: (focusIndex?: number) => void;
  onEditAccount: (index: number) => void;
};

function accountState(account: ChannelAccount): string {
  if (!account.api_key.trim()) return "未配";
  return account.enabled ? "启用" : "停用";
}

function accountResource(account: ChannelAccount, snapshot?: AccountBalanceSnapshot): string {
  const resourceMode = account.resource_mode ?? (account.channel_id === "longcat" ? "token_pack" : "pay_as_you_go");
  if (resourceMode === "token_pack") {
    return `${formatTokenCount(snapshot?.token_pack_remaining)} Tokens`;
  }
  if (snapshot?.balance != null) {
    return `${formatAmount(snapshot.balance)} ${snapshot.currency ?? ""}`;
  }
  return "-";
}

export function ChannelAccountsPanel({
  accounts,
  channels,
  getBalanceForAccount,
  getChannelName,
  onCreateAccount,
  onOpenManagementDrawer,
  onEditAccount,
}: ChannelAccountsPanelProps) {
  return (
    <Panel className="overview-section-card overview-section-card--grow">
      <PanelHeader>
        <div>
          <h3>渠道账号　共 {accounts.length} 个账号</h3>
        </div>
        <Group gap="xs">
          <Button className="overview-view-all" variant="subtle" onClick={onCreateAccount}>+ 新增账号</Button>
          <Button className="overview-view-all" variant="subtle" rightSection={<IconChevronRight size={15} />} onClick={() => onOpenManagementDrawer()}>查看全部</Button>
        </Group>
      </PanelHeader>
      <div className="overview-list">
        {accounts.map((account, index) => (
          <button
            type="button"
            className="overview-account-row"
            key={account.id}
            onClick={() => onOpenManagementDrawer(index)}
            aria-label={`管理账号 ${account.name || getChannelName(account.channel_id)}`}
          >
            <Tooltip label={getChannelName(account.channel_id)} withArrow position="top">
              <ChannelLogo channelId={account.channel_id} channelName={getChannelName(account.channel_id)} size={32} variant="avatar" />
            </Tooltip>
            <div className="row-main">
              <strong>{account.name || getChannelName(account.channel_id)}</strong>
              <span className="row-resource">
                {account.channel_id === "longcat" ? `资源包 ${accountResource(account, getBalanceForAccount(account.id))}` : `余额 ${accountResource(account, getBalanceForAccount(account.id))}`}
                {(account.resource_mode ?? (account.channel_id === "longcat" ? "token_pack" : "pay_as_you_go")) === "token_pack" && getBalanceForAccount(account.id)?.token_pack_expire_at ? (
                  <>　·　有效期至 {formatIsoDateTime(getBalanceForAccount(account.id)?.token_pack_expire_at).split(" ")[0]}</>
                ) : null}
                {!account.api_key.trim() ? <span className="warn">　·　未配置</span> : !account.enabled ? <span className="warn">　·　停用</span> : null}
              </span>
            </div>
            <StatusPill running={account.enabled && !!account.api_key.trim()}>{accountState(account)}</StatusPill>
            <ActionIcon variant="subtle" aria-label="编辑账号" onClick={(event) => {
              event.stopPropagation();
              onEditAccount(index);
            }}><IconDotsVertical size={17} /></ActionIcon>
          </button>
        ))}
      </div>
    </Panel>
  );
}
