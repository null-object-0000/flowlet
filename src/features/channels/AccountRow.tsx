import { Badge, Button } from "@mantine/core";
import { AccountBalanceSnapshot, ChannelAccount, ChannelPreset } from "../../domain";

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

function resourceSummary(account: ChannelAccount, snapshot?: AccountBalanceSnapshot): string {
  if (!snapshot) return "暂无资源信息";
  if (account.channel_id === "longcat") return `${snapshot.token_pack_remaining?.toLocaleString() ?? "-"} Tokens`;
  return snapshot.balance == null ? "余额待同步" : `${snapshot.balance} ${snapshot.currency ?? ""}`.trim();
}

export function AccountRow({ account, channel, snapshot, onEdit }: AccountRowProps) {
  const status = accountStatus(account);
  const mark = account.channel_id === "longcat" ? "LC" : account.channel_id === "deepseek" ? "DS" : account.channel_id.slice(0, 2).toUpperCase();

  return (
    <div className="account-summary-row">
      <div className="account-summary-name">
        <span className={`provider-mark channel-${account.channel_id}`}>{mark}</span>
        <div><strong>{account.name}</strong><small>{channel?.supported_protocols.join(" / ") ?? account.channel_id}</small></div>
      </div>
      <strong>{channel?.name ?? account.channel_id}</strong>
      <span>{resourceSummary(account, snapshot)}</span>
      <Badge variant="light" color={status.color} size="sm">{status.label}</Badge>
      <Button variant="subtle" onClick={onEdit}>编辑</Button>
    </div>
  );
}
