import { Button, Tag, Typography } from "@douyinfe/semi-ui-19";
import { IconChevronRight, IconMore, IconPlus } from "@douyinfe/semi-icons";
import type { AccountBalanceSnapshot, ChannelAccount } from "../../domains/account/types";
import { isQwenTokenPlanAccount } from "../../domains/channel/types";
import { parseQwenTokenPlanDetails } from "./qwenTokenPlanDetails";
import { OverviewActionLink } from "../../shared/ui/OverviewActionLink";
import { OverviewModuleCard } from "../../shared/ui/OverviewModuleCard";
import { ChannelBrandLogo } from "./ChannelBrandLogo";
import styles from "./OverviewChannelAccountsCard.module.css";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import { formatCompactNumber } from "../../shared/formatters/number";
import { formatTime, parseTimestamp } from "../../shared/formatters/datetime";

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
  const enabledCount = accounts.filter((a) => a.enabled).length;

  return (
    <OverviewModuleCard
      title={<span className={styles.cardTitle}>{t("渠道账号")} <em>{t("已启用 {enabled} / 共 {total} 个账号", { enabled: enabledCount, total: accounts.length })}</em></span>}
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
                  <span className={styles.nameRow}>
                    <Text strong className={styles.nameText}>{account.name || account.channel_id}</Text>
                    {nameLineSummary(account, snapshot, t, language) && (
                      <Text type="tertiary" size="small" className={styles.nameSuffix}>
                        {nameLineSummary(account, snapshot, t, language)}
                      </Text>
                    )}
                  </span>
                  <span className={styles.resourceSummary}>
                    {(() => {
                      const parts = resourceSummary(account, snapshot, t, language);
                      const hasSecondary = Boolean(parts.secondary);
                      return (
                        <>
                          <span className={styles.resourcePrimary} title={parts.primary}>{parts.primary}</span>
                          {hasSecondary && <span className={styles.resourceSeparator}>·</span>}
                          {hasSecondary && <span className={styles.resourceSecondary} title={parts.secondary}>{parts.secondary}</span>}
                        </>
                      );
                    })()}
                  </span>
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

type ResourceSummaryColumn = { primary: string; secondary: string };
function resourceSummary(account: ChannelAccount, snapshot: AccountBalanceSnapshot | undefined, t: (source: string, variables?: Record<string, string | number>) => string, language: "zh-CN" | "en-US"): ResourceSummaryColumn {
  if (isQwenTokenPlanAccount(account)) {
    const details = parseQwenTokenPlanDetails(snapshot?.raw_scraped_json);
    const sevenDay = details?.sevenDay ? t("7天 剩余 {percent}%", { percent: details.sevenDay.remainingPercent.toFixed(1) }) : "";
    const fiveHour = details?.fiveHour ? t("5小时 剩余 {percent}%", { percent: details.fiveHour.remainingPercent.toFixed(1) }) : "";
    return { primary: sevenDay, secondary: fiveHour };
  }
  // LongCat hybrid:主列展示余额，副列展示资源包剩余。
  if (account.channel_id === "longcat") {
    const balance = snapshot?.balance == null ? "" : t("余额 {value}", { value: `${snapshot.balance.toLocaleString(undefined, { maximumFractionDigits: 2 })}${snapshot?.currency ? ` ${snapshot.currency}` : ""}` });
    const packs = snapshot?.token_pack_remaining == null ? "" : t("资源包 {value} Tokens", { value: formatCompactNumber(snapshot?.token_pack_remaining, language, { fallback: "-" }) });
    return { primary: balance, secondary: packs };
  }
  const tokenPack = (account.resource_mode ?? "pay_as_you_go") === "token_pack";
  if (tokenPack) {
    const packs = snapshot?.token_pack_remaining == null ? "" : t("资源包 {value} Tokens", { value: formatCompactNumber(snapshot?.token_pack_remaining, language, { fallback: "-" }) });
    return { primary: "", secondary: packs };
  }
  const balance = snapshot?.balance == null ? "" : snapshot.balance.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return { primary: snapshot?.balance == null ? "" : t("余额 {value}", { value: `${balance}${snapshot?.currency ? ` ${snapshot.currency}` : ""}` }), secondary: "" };
}

function nameLineSummary(account: ChannelAccount, snapshot: AccountBalanceSnapshot | undefined, t: (source: string, variables?: Record<string, string | number>) => string, language: "zh-CN" | "en-US"): string {
  // LongCat hybrid 将资源包有效期放到账号名称行。
  if (account.channel_id === "longcat") {
    if (!snapshot?.token_pack_expire_at) return "";
    // 官方过期时间为当天 23:59:59，若到期日已是当天则展示为 23:59:59。
    if (isToday(snapshot.token_pack_expire_at)) {
      return ` · ${t("有效期至 {time}", { time: END_OF_DAY })}`;
    }
    return ` · ${t("有效期至 {date}", { date: snapshot.token_pack_expire_at.slice(0, 10) })}`;
  }
  // Qwen Token Plan 将 7 天重置时间放到账号名称行。
  if (isQwenTokenPlanAccount(account)) {
    const details = parseQwenTokenPlanDetails(snapshot?.raw_scraped_json);
    if (!details?.sevenDay?.resetAt) return "";
    if (isToday(details.sevenDay.resetAt)) {
      return ` · ${t("七天重置 {time}", { time: formatTime(details.sevenDay.resetAt, language) })}`;
    }
    return ` · ${t("七天重置 {date}", { date: details.sevenDay.resetAt.slice(0, 10) })}`;
  }
  const tokenPack = (account.resource_mode ?? "pay_as_you_go") === "token_pack";
  if (!tokenPack || !snapshot?.token_pack_expire_at) return "";
  if (isToday(snapshot.token_pack_expire_at)) {
    return ` · ${t("有效期至 {time}", { time: END_OF_DAY })}`;
  }
  return ` · ${t("有效期至 {date}", { date: snapshot.token_pack_expire_at.slice(0, 10) })}`;
}

const END_OF_DAY = "23:59:59";

function isToday(iso: string): boolean {
  const date = parseTimestamp(iso);
  if (!date) return false;
  const today = new Date();
  return date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
}
