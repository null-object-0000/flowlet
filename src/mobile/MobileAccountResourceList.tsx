import { IconChevronDown, IconChevronUp } from "@douyinfe/semi-icons";
import { Tag } from "@douyinfe/semi-ui-19";
import { useState } from "react";
import { useAppPreferences } from "../app/preferences/AppPreferences";
import type { SyncedAccountResource } from "../domains/device-sync/types";
import { ChannelBrandLogo } from "../features/channel-accounts/ChannelBrandLogo";
import { formatCompactNumber } from "../shared/formatters/number";
import { formatFullTimestamp } from "../shared/formatters/datetime";
import styles from "./MobileAccountResources.module.css";

export function MobileAccountResourceList({ resources, compact = false }: {
  resources: SyncedAccountResource[];
  compact?: boolean;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const shown = compact ? resources.slice(0, 3) : resources;
  return <div className={styles.list}>{shown.map((resource) => {
    const expanded = !compact && expandedId === resource.accountId;
    const primary = primaryResource(resource);
    return <article className={styles.card} key={resource.accountId}>
      <button
        type="button"
        className={styles.summary}
        aria-expanded={compact ? undefined : expanded}
        onClick={compact ? undefined : () => setExpandedId((current) => current === resource.accountId ? null : resource.accountId)}
      >
        <ChannelBrandLogo channelId={resource.channelId} name={resource.channelName} />
        <span className={styles.identity}>
          <span className={styles.nameLine}><strong>{resource.accountName}</strong>{resource.stale ? <Tag size="small" color="orange">已过期</Tag> : null}</span>
          <small>{resource.channelName}{resource.plan ? ` · ${formatPlan(resource.plan)}` : ""}</small>
        </span>
        <span className={styles.primary}><strong>{primary.value}</strong><small>{primary.label}</small></span>
        {!compact ? <span className={styles.chevron}>{expanded ? <IconChevronUp /> : <IconChevronDown />}</span> : null}
      </button>
      {expanded ? <AccountResourceDetails resource={resource} /> : null}
    </article>;
  })}</div>;
}

function AccountResourceDetails({ resource }: { resource: SyncedAccountResource }) {
  const { language, t } = useAppPreferences();
  return <div className={styles.details}>
    {resource.quotaWindows.map((window) => {
      const remaining = Math.max(0, 100 - window.usedPercent);
      return <div className={styles.quota} key={`${window.label}-${window.resetsAt ?? "none"}`}>
        <div><strong>{t("{period}额度", { period: window.label })}</strong><span>{t("剩余 {percent}%", { percent: Math.round(remaining) })}</span></div>
        <div className={styles.track} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(remaining)}><i style={{ width: `${remaining}%` }} /></div>
        <small>{window.resetsAt ? t("额度重置时间") + `：${formatFullTimestamp(window.resetsAt, language)}` : t("未提供重置时间")}</small>
      </div>;
    })}
    <dl className={styles.metrics}>
      {resource.balance != null || resource.balanceText ? <><dt>{t("账户余额")}</dt><dd>{resource.balanceText ?? `${resource.balance?.toLocaleString(language)}${resource.currency ? ` ${resource.currency}` : ""}`}</dd></> : null}
      {resource.tokenRemaining != null ? <><dt>{t("资源包余量")}</dt><dd>{formatCompactNumber(resource.tokenRemaining, language)} Tokens</dd></> : null}
      {resource.tokenTotal != null ? <><dt>{t("总额度")}</dt><dd>{formatCompactNumber(resource.tokenTotal, language)} Tokens</dd></> : null}
      {resource.expiresAt ? <><dt>{t("有效期")}</dt><dd>{formatFullTimestamp(resource.expiresAt, language)}</dd></> : null}
      <dt>{t("最近同步")}</dt><dd>{formatFullTimestamp(resource.observedAt, language)}</dd>
    </dl>
    {resource.stale ? <p className={styles.warning}>{t("数据同步可能已过期，请在桌面端检查账号登录和自动同步状态。")}</p> : null}
  </div>;
}

export function primaryResource(resource: SyncedAccountResource): { value: string; label: string } {
  const quota = resource.quotaWindows[resource.quotaWindows.length - 1];
  if (quota) return { value: `${Math.round(Math.max(0, 100 - quota.usedPercent))}%`, label: `${quota.label}剩余` };
  if (resource.tokenRemaining != null) return { value: formatCompactNumber(resource.tokenRemaining, "zh-CN"), label: "Tokens 剩余" };
  if (resource.balanceText) return { value: resource.balanceText, label: "Credits" };
  if (resource.balance != null) return { value: `${resource.balance.toLocaleString("zh-CN")}${resource.currency ? ` ${resource.currency}` : ""}`, label: "余额" };
  return { value: "已同步", label: "资源状态" };
}

function formatPlan(plan: string) {
  const key = plan.toLowerCase();
  const known: Record<string, string> = { pay_as_you_go: "按量付费", token_plan: "Token Plan", hybrid: "混合资源", codex: "Codex", prolite: "Pro Lite" };
  return known[key] ?? `${plan.charAt(0).toUpperCase()}${plan.slice(1)}`;
}
