import { Button, Space, Tag, Typography } from "@douyinfe/semi-ui-19";
import { IconChevronRight, IconMore, IconPlus } from "@douyinfe/semi-icons";
import type { AccountBalanceSnapshot, ChannelAccount } from "../../domains/account/types";
import { OverviewActionLink } from "../../shared/ui/OverviewActionLink";
import { OverviewModuleCard } from "../../shared/ui/OverviewModuleCard";
import { ChannelBrandLogo } from "./ChannelBrandLogo";
import styles from "./OverviewChannelAccountsCard.module.css";

const { Text } = Typography;

type Props = {
  accounts: ChannelAccount[];
  snapshots: AccountBalanceSnapshot[];
  onCreate: () => void;
  onViewAll: () => void;
  onEdit: (accountId: string) => void;
};

export function OverviewChannelAccountsCard({ accounts, snapshots, onCreate, onViewAll, onEdit }: Props) {
  const snapshotByAccount = new Map(snapshots.map((snapshot) => [snapshot.account_id, snapshot]));

  return (
    <OverviewModuleCard
      title={<span className={styles.cardTitle}>渠道账号 <em>共 {accounts.length} 个账号</em></span>}
      headerExtra={(
        <Space className={styles.headerActions} spacing="tight" align="center">
          <OverviewActionLink leadingIcon={<IconPlus />} onClick={onCreate}>新增账号</OverviewActionLink>
          <OverviewActionLink trailingIcon={<IconChevronRight />} onClick={onViewAll}>
            管理账号
          </OverviewActionLink>
        </Space>
      )}
    >
      <div className={styles.list}>
        {accounts.map((account) => {
          const snapshot = snapshotByAccount.get(account.id);
          const status = accountStatus(account);
          return (
            <div className={styles.row} key={account.id}>
              <button className={styles.rowMain} type="button" onClick={() => onEdit(account.id)}>
                <ChannelBrandLogo channelId={account.channel_id} name={account.name} />
                <span className={styles.accountText}>
                  <Text strong>{account.name || account.channel_id}</Text>
                  <Text type="tertiary" size="small">
                    {resourceSummary(account, snapshot)}{expirySummary(account, snapshot)}
                  </Text>
                </span>
              </button>
              <Tag color={status.color}>{status.label}</Tag>
              <Button
                icon={<IconMore />}
                theme="borderless"
                aria-label={`编辑账号 ${account.name || account.channel_id}`}
                onClick={() => onEdit(account.id)}
              />
            </div>
          );
        })}
      </div>
    </OverviewModuleCard>
  );
}

function accountStatus(account: ChannelAccount): { label: string; color: "green" | "red" | "grey" } {
  if (!account.enabled) return { label: "停用", color: "grey" };
  if (!account.api_key?.trim()) return { label: "未配", color: "grey" };
  if (account.credential_status === "invalid_key") return { label: "无效", color: "red" };
  return { label: "启用", color: "green" };
}

function resourceSummary(account: ChannelAccount, snapshot?: AccountBalanceSnapshot): string {
  const tokenPack = (account.resource_mode ?? (account.channel_id === "longcat" ? "token_pack" : "pay_as_you_go")) === "token_pack";
  if (tokenPack) return `资源包 ${formatTokenCount(snapshot?.token_pack_remaining)} Tokens`;
  const balance = snapshot?.balance == null ? "-" : snapshot.balance.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return `余额 ${balance}${snapshot?.currency ? ` ${snapshot.currency}` : ""}`;
}

function expirySummary(account: ChannelAccount, snapshot?: AccountBalanceSnapshot): string {
  const tokenPack = (account.resource_mode ?? (account.channel_id === "longcat" ? "token_pack" : "pay_as_you_go")) === "token_pack";
  return tokenPack && snapshot?.token_pack_expire_at ? `　·　有效期至 ${snapshot.token_pack_expire_at.split("T")[0]}` : "";
}

function formatTokenCount(value?: number | null): string {
  if (value == null) return "-";
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1)}亿`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(1)}万`;
  return String(value);
}
