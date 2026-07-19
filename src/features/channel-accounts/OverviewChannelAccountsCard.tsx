import { Button, Tag, Typography } from "@douyinfe/semi-ui-19";
import { IconChevronRight, IconMore, IconPlus } from "@douyinfe/semi-icons";
import type { AccountBalanceSnapshot, ChannelAccount } from "../../domains/account/types";
import { OverviewActionLink } from "../../shared/ui/OverviewActionLink";
import { OverviewModuleCard } from "../../shared/ui/OverviewModuleCard";
import { ChannelBrandLogo } from "./ChannelBrandLogo";
import styles from "./OverviewChannelAccountsCard.module.css";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import { formatCompactNumber } from "../../shared/formatters/number";

const { Text } = Typography;

type Props = {
  accounts: ChannelAccount[];
  snapshots: AccountBalanceSnapshot[];
  onCreate: () => void;
  onViewAll: () => void;
  onEdit: (accountId: string) => void;
};

export function OverviewChannelAccountsCard({ accounts, snapshots, onCreate, onViewAll, onEdit }: Props) {
  const { language, t } = useAppPreferences();
  const snapshotByAccount = new Map(snapshots.map((snapshot) => [snapshot.account_id, snapshot]));

  return (
    <OverviewModuleCard
      title={<span className={styles.cardTitle}>{t("渠道账号")} <em>{t("共 {count} 个账号", { count: accounts.length })}</em></span>}
      headerExtra={(
        <div className={styles.headerActions}>
          <OverviewActionLink leadingIcon={<IconPlus />} onClick={onCreate}>{t("新增账号")}</OverviewActionLink>
          <OverviewActionLink trailingIcon={<IconChevronRight />} onClick={onViewAll}>
            {t("管理账号")}
          </OverviewActionLink>
        </div>
      )}
    >
      <div className={styles.list}>
        {accounts.map((account) => {
          const snapshot = snapshotByAccount.get(account.id);
          const status = accountStatus(account, t);
          return (
            <div className={styles.row} key={account.id}>
              <button className={styles.rowMain} type="button" onClick={() => onEdit(account.id)}>
                <ChannelBrandLogo channelId={account.channel_id} name={account.name} />
                <span className={styles.accountText}>
                  <Text strong>{account.name || account.channel_id}</Text>
                  <Text type="tertiary" size="small">
                    {resourceSummary(account, snapshot, t, language)}{expirySummary(account, snapshot, t)}
                  </Text>
                </span>
              </button>
              <Tag color={status.color}>{status.label}</Tag>
              <Button
                icon={<IconMore />}
                theme="borderless"
                aria-label={t("编辑账号 {name}", { name: account.name || account.channel_id })}
                onClick={() => onEdit(account.id)}
              />
            </div>
          );
        })}
      </div>
    </OverviewModuleCard>
  );
}

function accountStatus(account: ChannelAccount, t: (source: string) => string): { label: string; color: "green" | "red" | "grey" } {
  if (!account.enabled) return { label: t("停用"), color: "grey" };
  if (!account.api_key?.trim()) return { label: t("未配"), color: "grey" };
  if (account.credential_status === "invalid_key") return { label: t("无效"), color: "red" };
  return { label: t("启用"), color: "green" };
}

function resourceSummary(account: ChannelAccount, snapshot: AccountBalanceSnapshot | undefined, t: (source: string, variables?: Record<string, string | number>) => string, language: "zh-CN" | "en-US"): string {
  const tokenPack = (account.resource_mode ?? (account.channel_id === "longcat" ? "token_pack" : "pay_as_you_go")) === "token_pack";
  if (tokenPack) return t("资源包 {value} Tokens", { value: formatCompactNumber(snapshot?.token_pack_remaining, language, { fallback: "-" }) });
  const balance = snapshot?.balance == null ? "-" : snapshot.balance.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return t("余额 {value}", { value: `${balance}${snapshot?.currency ? ` ${snapshot.currency}` : ""}` });
}

function expirySummary(account: ChannelAccount, snapshot: AccountBalanceSnapshot | undefined, t: (source: string, variables?: Record<string, string | number>) => string): string {
  const tokenPack = (account.resource_mode ?? (account.channel_id === "longcat" ? "token_pack" : "pay_as_you_go")) === "token_pack";
  return tokenPack && snapshot?.token_pack_expire_at ? ` · ${t("有效期至 {date}", { date: snapshot.token_pack_expire_at.split("T")[0] })}` : "";
}
