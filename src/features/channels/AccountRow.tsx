import { Badge, Button } from "@mantine/core";
import { AccountBalanceSnapshot, ChannelAccount, ChannelPreset } from "../../domain";
import { ChannelLogo } from "../../components/ChannelLogo";

function accountStatus(account: ChannelAccount): { label: string; color: "green" | "red" | "gray" } {
  if (!account.enabled) return { label: "已停用", color: "gray" };
  if (account.credential_status === "invalid_key") return { label: "API Key 无效", color: "red" };
  return { label: "正常", color: "green" };
}

type AccountRowProps = {
  account: ChannelAccount;
  channel?: ChannelPreset;
  snapshot?: AccountBalanceSnapshot;
  onEdit: () => void;
};

function resourceSummary(_account: ChannelAccount, snapshot?: AccountBalanceSnapshot): string {
  if (!snapshot) return "暂无资源信息";
  return snapshot.balance == null ? "余额待维护" : `${snapshot.balance} ${snapshot.currency ?? ""}`.trim();
}

export function AccountRow({ account, channel, snapshot, onEdit }: AccountRowProps) {
  const status = accountStatus(account);

  return (
    <div className="account-summary-row">
      <div className="account-summary-name">
        <ChannelLogo channelId={account.channel_id} channelName={channel?.name} size={24} variant="avatar" />
        <div><strong>{account.name}</strong><small>{channel?.supported_protocols.join(" / ") ?? account.channel_id}</small></div>
      </div>
      <span className="account-channel-cell">
        <ChannelLogo channelId={account.channel_id} channelName={channel?.name} size={20} variant="color" />
        <strong>{channel?.name ?? account.channel_id}</strong>
      </span>
      <span>{resourceSummary(account, snapshot)}</span>
      <Badge variant="light" color={status.color} size="sm">{status.label}</Badge>
      <Button variant="subtle" onClick={onEdit}>编辑</Button>
    </div>
  );
}
