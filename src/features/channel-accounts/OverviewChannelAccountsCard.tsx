import { useEffect, useState } from "react";
import { Badge, Button, Dropdown, Switch, Tag, Tooltip, Typography } from "@douyinfe/semi-ui-19";
import { IconDelete, IconEdit, IconMore, IconPlay, IconPlus, IconStop } from "@douyinfe/semi-icons";
import type { AccountBalanceSnapshot, ChannelAccount } from "../../domains/account/types";
import { CHATGPT_CHANNEL_ID, isQwenTokenPlanAccount, isChatGptAccount } from "../../domains/channel/types";
import type { ChannelPreset } from "../../domains/channel/types";
import type { CodexAccountReport } from "../../domains/agent/types";
import { parseQwenTokenPlanDetails } from "./qwenTokenPlanDetails";
import {
  codexAccountToPseudoChannelAccount,
  getCodexUsageDisplay,
  getCodexNameSummary,
  isObservableCodexAccount,
} from "./codexPseudoAccount";
import { OverviewActionLink } from "../../shared/ui/OverviewActionLink";
import { OverviewModuleCard } from "../../shared/ui/OverviewModuleCard";
import { ChannelBrandLogo } from "./ChannelBrandLogo";
import styles from "./OverviewChannelAccountsCard.module.css";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import { formatCompactNumber } from "../../shared/formatters/number";
import { formatFullTimestamp, formatTime, parseTimestamp } from "../../shared/formatters/datetime";
import { accountSyncStatus, codexSyncStatus, type AccountSyncStatus } from "./accountSyncStatus";

const { Text } = Typography;

type Props = {
  accounts: ChannelAccount[];
  channels: ChannelPreset[];
  snapshots: AccountBalanceSnapshot[];
  codexAccounts?: CodexAccountReport[];
  onCreate: (channelId: string) => void;
  onEdit: (accountId: string) => void;
  onToggle?: (accountId: string, enabled: boolean) => void;
  onDelete?: (accountId: string) => void;
  onOpenCodexAgent?: (accountId: string) => void;
  busy?: boolean;
};

export function OverviewChannelAccountsCard({ accounts, channels, snapshots, codexAccounts, onCreate, onEdit, onToggle = () => undefined, onDelete = () => undefined, onOpenCodexAgent, busy = false }: Props) {
  const { language, t } = useAppPreferences();
  const [showDisabledAccounts, setShowDisabledAccounts] = useState(false);
  const snapshotByAccount = new Map(snapshots.map((snapshot) => [snapshot.account_id, snapshot]));
  const presetByChannelId = new Map(channels.map((preset) => [preset.id, preset]));
  const enabledCount = accounts.filter((a) => a.enabled).length;
  const hasDisabledAccounts = enabledCount < accounts.length;
  // 自动同步失败时不刷新快照查询，过期提示需要按当前时间周期性重算，
  // 否则应用空闲时 Logo 上的状态点不会在超出两轮同步周期后转为黄色。
  const [, setSyncTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setSyncTick((value) => value + 1), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  // 将 Codex 账号转为伪渠道账号，排在所有正常账号后面。
  const codexPseudoAccounts = (codexAccounts ?? [])
    .filter(isObservableCodexAccount)
    .map((report, index) => codexAccountToPseudoChannelAccount(report, index));
  const allAccounts = [...accounts, ...codexPseudoAccounts];
  const visibleAccounts = showDisabledAccounts
    ? allAccounts
    : allAccounts.filter((account) => isChatGptAccount(account) || account.enabled);

  return (
    <OverviewModuleCard
      title={<span className={styles.cardTitle}>{t("渠道账号")} <em>{t("已启用 {enabled} / 共 {total} 个账号", { enabled: enabledCount, total: accounts.length })}</em></span>}
      headerExtra={allAccounts.length > 0 ? (
        <div className={styles.headerActions}>
          {hasDisabledAccounts ? (
            <div className={styles.disabledFilter}>
              <span>{t("显示停用账号")}</span>
              <Switch
                size="small"
                checked={showDisabledAccounts}
                aria-label={t("显示停用账号")}
                onChange={setShowDisabledAccounts}
              />
            </div>
          ) : null}
          <OverviewActionLink leadingIcon={<IconPlus />} onClick={() => onCreate("longcat")}>{t("新增账号")}</OverviewActionLink>
        </div>
      ) : undefined}
    >
      {allAccounts.length > 0 ? visibleAccounts.length > 0 ? <div className={styles.list}>
        {visibleAccounts.map((account) => {
          const snapshot = snapshotByAccount.get(account.id);
          const isCodex = isChatGptAccount(account);
          const codexReport = isCodex
            ? codexAccounts?.find((r) => `codex-${r.account_id}` === account.id)
            : undefined;
          const status = isCodex
            ? { label: "", color: "green" as const }
            : accountStatus(account, t);
          const syncStatus = isCodex
            ? codexReport
              ? codexSyncStatus(codexReport)
              : null
            : accountSyncStatus(account, snapshot, presetByChannelId.get(account.channel_id));
          const nameSummary = isCodex && codexReport
            ? getCodexNameSummary(codexReport)
            : nameLineSummary(account, snapshot, t, language);
          const accountName = account.name || account.channel_id;
          return (
            <div className={styles.row} key={account.id}>
              {isCodex ? (
                <button
                  className={styles.rowMain}
                  type="button"
                  onClick={() => onOpenCodexAgent?.(codexReport?.account_id ?? "")}
                >
                  <AccountLogo
                    channelId={account.channel_id}
                    name={account.name}
                    syncStatus={syncStatus}
                    tooltip={syncStatus === "stale" && codexReport?.error ? codexReport.error : undefined}
                  />
                  <span className={styles.accountText}>
                    <span className={styles.nameRow}>
                      <span className={styles.codexNameWrapper}>
                        <Text strong title={accountName}>{accountName}</Text>
                        {nameSummary && <span className={styles.resourceSeparator}>·</span>}
                        {nameSummary && <span className={styles.nameSecondary}>{nameSummary}</span>}
                      </span>
                    </span>
                    <span className={styles.resourceSummary}>
                      {(() => {
                        const usageParts = codexReport
                          ? getCodexUsageDisplay(codexReport, t, language)
                          : { value: "", secondary: "", resetAt: null };
                        const parts = {
                          label: "",
                          value: usageParts.value,
                          secondary: [usageParts.secondary, usageParts.resetAt].filter(Boolean).join(" · "),
                        };
                        const hasSecondary = Boolean(parts.secondary);
                        return (
                          <>
                            <span className={styles.resourcePrimary}>
                              {parts.label && <span className={styles.resourceLabel}>{parts.label}</span>}
                              {parts.value && <span className={styles.resourceValue} title={parts.value}>{parts.value}</span>}
                            </span>
                            {hasSecondary && <span className={styles.resourceSeparator}>·</span>}
                            {hasSecondary && <span className={styles.resourceSecondary} title={parts.secondary}>{parts.secondary}</span>}
                          </>
                        );
                      })()}
                    </span>
                  </span>
                </button>
              ) : (
                <button className={styles.rowMain} type="button" onClick={() => onEdit(account.id)}>
                  <AccountLogo channelId={account.channel_id} name={account.name} syncStatus={syncStatus} />
                  <span className={styles.accountText}>
                    <span className={styles.nameRow}>
                      <Text strong className={nameSummary ? styles.namePrimary : styles.nameText} title={accountName}>
                        {accountName}
                      </Text>
                      {nameSummary && <span className={styles.resourceSeparator}>·</span>}
                      {nameSummary && <span className={styles.nameSecondary} title={nameSummary}>{nameSummary}</span>}
                    </span>
                    <span className={styles.resourceSummary}>
                      {(() => {
                        const parts = resourceSummary(account, snapshot, t, language);
                        const hasSecondary = Boolean(parts.secondary);
                        return (
                          <>
                            <span className={styles.resourcePrimary}>
                              {parts.label && <span className={styles.resourceLabel}>{parts.label}</span>}
                              {parts.value && <span className={styles.resourceValue} title={parts.value}>{parts.value}</span>}
                            </span>
                            {hasSecondary && <span className={styles.resourceSeparator}>·</span>}
                            {hasSecondary && <span className={styles.resourceSecondary} title={parts.secondary}>{parts.secondary}</span>}
                          </>
                        );
                      })()}
                    </span>
                  </span>
                </button>
              )}
              {status.label ? <Tag color={status.color}>{status.label}</Tag> : <span className={styles.rowSpacer} aria-hidden="true" />}
              {isCodex ? (
                <span className={styles.rowSpacer} aria-hidden="true" />
              ) : (
                <Dropdown
                  trigger="click"
                  position="bottomRight"
                  render={(
                    <Dropdown.Menu>
                      <Dropdown.Item icon={<IconEdit />} onClick={() => onEdit(account.id)}>{t("编辑账号")}</Dropdown.Item>
                      <Dropdown.Item
                        disabled={busy}
                        icon={account.enabled ? <IconStop /> : <IconPlay />}
                        onClick={() => onToggle(account.id, !account.enabled)}
                      >
                        {t(account.enabled ? "停用账号" : "启用账号")}
                      </Dropdown.Item>
                      <Dropdown.Divider />
                      <Dropdown.Item type="danger" icon={<IconDelete />} onClick={() => onDelete(account.id)}>{t("删除账号")}</Dropdown.Item>
                    </Dropdown.Menu>
                  )}
                >
                  <Button
                    icon={<IconMore />}
                    theme="borderless"
                    aria-label={t("账号操作：{name}", { name: accountName })}
                  />
                </Dropdown>
              )}
            </div>
          );
        })}
      </div> : (
        <div className={styles.filteredEmpty}>
          <strong>{t("暂无启用账号")}</strong>
          <span>{t("开启“显示停用账号”即可查看全部账号。")}</span>
        </div>
      ) : (
        <div className={styles.emptyState}>
          <div className={styles.emptyCopy}>
            <strong>{t("选择一个渠道添加首个账号")}</strong>
            <span>{t("API Key 仅保存在本机，保存前可以先测试连接。")}</span>
          </div>
          <div className={styles.channelOptions}>
            {EMPTY_CHANNEL_OPTIONS.map((channel) => (
              <button
                key={channel.id}
                type="button"
                className={styles.channelOption}
                aria-label={t(channel.actionLabel)}
                onClick={() => onCreate(channel.id)}
              >
                <ChannelBrandLogo channelId={channel.id} name={channel.name} />
                <span><strong>{channel.name}</strong><small>{t("添加账号")}</small></span>
                <IconPlus aria-hidden="true" />
              </button>
            ))}
          </div>
        </div>
      )}
    </OverviewModuleCard>
  );
}

/** 渠道 Logo。参与自动同步的账号在 Logo 右上角展示 Badge dot：
 *  数据正常（两轮同步周期内更新成功）为绿色，过期为黄色。
 *  `tooltip` 可覆盖悬浮文案（如 Codex 刷新失败的详细错误）。 */
function AccountLogo({ channelId, name, syncStatus, tooltip }: { channelId: string; name: string; syncStatus: AccountSyncStatus | null; tooltip?: string }) {
  const { t } = useAppPreferences();
  const logo = <ChannelBrandLogo channelId={channelId} name={name} />;
  if (!syncStatus) return logo;
  const content = tooltip ?? (syncStatus === "stale" ? t("数据同步可能已过期") : t("数据同步正常"));
  return (
    <Tooltip content={content}>
      <Badge dot type={syncStatus === "stale" ? "warning" : "success"}>
        {logo}
      </Badge>
    </Tooltip>
  );
}

const EMPTY_CHANNEL_OPTIONS = [
  { id: "longcat", name: "LongCat", actionLabel: "添加 LongCat" },
  { id: "deepseek", name: "DeepSeek", actionLabel: "添加 DeepSeek" },
  { id: "kimi", name: "Kimi", actionLabel: "添加 Kimi" },
  { id: "qwen", name: "Qwen", actionLabel: "添加 Qwen" },
  { id: "zhipu", name: "Z.AI", actionLabel: "添加 Z.AI" },
  { id: CHATGPT_CHANNEL_ID, name: "ChatGPT", actionLabel: "ChatGPT 授权登录" },
];

function accountStatus(account: ChannelAccount, t: (source: string) => string): { label: string; color: "green" | "red" | "grey" } {
  if (!account.enabled) return { label: t("停用"), color: "grey" };
  if (!account.api_key?.trim()) return { label: t("未配"), color: "grey" };
  if (account.credential_status === "invalid_key") return { label: t("无效"), color: "red" };
  return { label: t("启用"), color: "green" };
}

type ResourceSummaryColumn = { label: string; value: string; secondary: string };
function formatBalance(value: number, currency: string | null | undefined, language: "zh-CN" | "en-US"): string {
  return value.toLocaleString(language === "en-US" ? "en-US" : "zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function resourceSummary(account: ChannelAccount, snapshot: AccountBalanceSnapshot | undefined, t: (source: string, variables?: Record<string, string | number>) => string, language: "zh-CN" | "en-US"): ResourceSummaryColumn {
  if (isQwenTokenPlanAccount(account)) {
    const details = parseQwenTokenPlanDetails(snapshot?.raw_scraped_json);
    const sevenDay = details?.sevenDay ? t("7天剩余 {percent}%", { percent: details.sevenDay.remainingPercent.toFixed(1) }) : "";
    const resetAt = details?.sevenDay?.resetAt
      ? formatFullTimestamp(details.sevenDay.resetAt, language)
      : "";
    return { label: "", value: sevenDay, secondary: resetAt };
  }
  // LongCat hybrid:主列展示余额，副列展示资源包剩余。
  if (account.channel_id === "longcat") {
    const balanceText = snapshot?.balance == null ? "" : `${formatBalance(snapshot.balance, snapshot.currency, language)}${snapshot.currency ? ` ${snapshot.currency}` : ""}`;
    const packs = snapshot?.token_pack_remaining == null ? "" : t("资源包 {value} Tokens", { value: formatCompactNumber(snapshot?.token_pack_remaining, language, { fallback: "-" }) });
    return { label: t("余额"), value: balanceText, secondary: packs };
  }
  const tokenPack = (account.resource_mode ?? "pay_as_you_go") === "token_pack";
  if (tokenPack) {
    const packs = snapshot?.token_pack_remaining == null ? "" : t("资源包 {value} Tokens", { value: formatCompactNumber(snapshot?.token_pack_remaining, language, { fallback: "-" }) });
    return { label: "", value: "", secondary: packs };
  }
  const balanceText = snapshot?.balance == null ? "" : `${formatBalance(snapshot.balance, snapshot.currency, language)}${snapshot.currency ? ` ${snapshot.currency}` : ""}`;
  return { label: snapshot?.balance == null ? "" : t("余额"), value: balanceText, secondary: "" };
}

function nameLineSummary(account: ChannelAccount, snapshot: AccountBalanceSnapshot | undefined, t: (source: string, variables?: Record<string, string | number>) => string, language: "zh-CN" | "en-US"): string {
  // LongCat hybrid 将资源包有效期放到账号名称行。
  if (account.channel_id === "longcat") {
    if (!snapshot?.token_pack_expire_at) return "";
    if (isToday(snapshot.token_pack_expire_at)) {
      return t("有效期至 {time}", { time: formatTime(snapshot.token_pack_expire_at, language) });
    }
    return t("有效期至 {date}", { date: snapshot.token_pack_expire_at.slice(0, 10) });
  }
  // Qwen Token Plan 名称行展示具体套餐；7 天重置时间与剩余额度放在资源行。
  if (isQwenTokenPlanAccount(account)) {
    const details = parseQwenTokenPlanDetails(snapshot?.raw_scraped_json);
    if (!details) return "";
    const planName = `${details.specCode.charAt(0).toUpperCase()}${details.specCode.slice(1)}`;
    return t("个人版 {name} 套餐", { name: planName });
  }
  const tokenPack = (account.resource_mode ?? "pay_as_you_go") === "token_pack";
  if (!tokenPack || !snapshot?.token_pack_expire_at) return "";
  if (isToday(snapshot.token_pack_expire_at)) {
    return t("有效期至 {time}", { time: END_OF_DAY });
  }
  return t("有效期至 {date}", { date: snapshot.token_pack_expire_at.slice(0, 10) });
}

const END_OF_DAY = "23:59:59";

function isToday(iso: string): boolean {
  const date = parseTimestamp(iso);
  if (!date) return false;
  const today = new Date();
  return date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
}
