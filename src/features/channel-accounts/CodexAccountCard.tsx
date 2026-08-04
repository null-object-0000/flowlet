import { Tag, Tooltip, Typography } from "@douyinfe/semi-ui-19";
import type { CodexAccountReport, CodexRateLimitResetCredits, CodexUsageWindow } from "../../domains/agent/types";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import { CODEX_ACCOUNT_SYNC_INTERVAL_MS } from "../background-tasks/CodexAccountAutoSync";
import styles from "./CodexAccountSideSheet.module.css";

const { Text } = Typography;

/**
 * Codex 账号卡片：套餐、登录方式、Credits、最后更新（含下次自动刷新预估）、
 * 重置机会明细与订阅用量窗口。从 Agent 接入抽屉迁移至渠道账号侧，
 * 组件本身只读，授权与刷新动作由所在抽屉提供。
 */
export function CodexAccountCard({ account, language }: { account: CodexAccountReport; language: "zh-CN" | "en-US" }) {
  const { t } = useAppPreferences();
  const resetCredits = account.rate_limit_reset_credits;
  const hasResetCreditDetails = Boolean(
    resetCredits?.credits?.some((credit) => typeof credit.expires_at === "number"),
  );
  const updatedAtFormatter = new Intl.DateTimeFormat(language, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const updatedAtMs = new Date(account.updated_at).getTime();
  const updatedAt = updatedAtFormatter.format(new Date(account.updated_at));
  // 自动同步每 5 分钟一轮（见 CodexAccountAutoSync），下次刷新时间按
  // “上次更新 + 同步间隔”估算；手动刷新会提前更新时间但不重置定时器，
  // 因此只是预估值。估算已过期（如应用刚启动、系统休眠）时提示即将刷新。
  const nextRefreshLabel = Number.isNaN(updatedAtMs)
    ? undefined
    : updatedAtMs + CODEX_ACCOUNT_SYNC_INTERVAL_MS <= Date.now()
      ? t("数据即将自动刷新")
      : t("预计下次刷新：{time}", {
          time: updatedAtFormatter.format(new Date(updatedAtMs + CODEX_ACCOUNT_SYNC_INTERVAL_MS)),
        });

  return (
    <div className={styles.codexAccount}>
      <div className={styles.codexAccountHeader}>
        <strong title={account.email || undefined}>{account.email || t("已登录")}</strong>
        <span className={styles.accountTags}>
          {account.stale ? <Tag color="orange">{t("数据已过期")}</Tag> : null}
        </span>
      </div>
      <div className={styles.accountSummary}>
        <div>
          <Text type="tertiary">{t("会员套餐")}</Text>
          <span className={styles.accountValueTags}>
            <Tag color="blue">{formatPlan(account.plan_type, t("未知套餐"))}</Tag>
            {resetCredits && resetCredits.available_count > 0 && !hasResetCreditDetails ? (
              <Tag color="green">{t("重置 {count} 次", { count: resetCredits.available_count })}</Tag>
            ) : null}
          </span>
        </div>
        <div>
          <Text type="tertiary">{t("登录方式")}</Text>
          <span>{formatAuthMode(account.auth_mode, t)}</span>
        </div>
        {account.credits ? (
          <div>
            <Text type="tertiary">Credits</Text>
            <span>{formatCredits(account.credits, t)}</span>
          </div>
        ) : null}
        <div>
          <Text type="tertiary">{t("最后更新")}</Text>
          <Tooltip
            content={nextRefreshLabel ?? ""}
            zIndex={APP_OVERLAY_TOOLTIP_Z_INDEX}
          >
            <span>{updatedAt}</span>
          </Tooltip>
        </div>
      </div>
      {account.error ? <Text className={styles.accountNotice} type="warning">{t("刷新失败：{message}", { message: account.error })}</Text> : null}
      {resetCredits && hasResetCreditDetails ? (
        <ResetCredits credits={resetCredits} language={language} />
      ) : null}
      {account.primary || account.secondary ? (
        <div className={styles.usageWindows}>
          {account.primary ? <UsageWindow window={account.primary} language={language} /> : null}
          {account.secondary ? <UsageWindow window={account.secondary} language={language} /> : null}
        </div>
      ) : (
        <Text className={styles.accountNotice} type="tertiary">{t("当前登录方式未返回订阅用量窗口")}</Text>
      )}
    </div>
  );
}

export function ResetCredits({
  credits,
  language,
}: {
  credits: CodexRateLimitResetCredits;
  language: "zh-CN" | "en-US";
}) {
  const { t } = useAppPreferences();
  const details = credits.credits ?? [];
  const missingDetails = Math.max(0, credits.available_count - details.length);
  const dateFormatter = new Intl.DateTimeFormat(language, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div className={styles.resetCredits}>
      <div className={styles.resetCreditsHeader}>
        <strong>{t("重置机会")}</strong>
        <Tag color={credits.available_count > 0 ? "green" : "grey"}>
          {t("可用 {count} 次", { count: credits.available_count })}
        </Tag>
      </div>
      {details.length ? (
        <div className={styles.resetCreditList}>
          {details.map((credit) => (
            <div className={styles.resetCredit} key={credit.id}>
              <strong>{credit.title || t("用量限额重置")}</strong>
              <Text type="tertiary">
                {typeof credit.expires_at === "number"
                  ? t("将于 {time} 到期", { time: dateFormatter.format(new Date(credit.expires_at * 1000)) })
                  : t("未提供过期时间")}
              </Text>
            </div>
          ))}
        </div>
      ) : null}
      {missingDetails > 0 ? (
        <Text className={styles.resetCreditNotice} type="tertiary">
          {t("另有 {count} 次未返回明细", { count: missingDetails })}
        </Text>
      ) : null}
    </div>
  );
}

function UsageWindow({ window, language }: { window: CodexUsageWindow; language: "zh-CN" | "en-US" }) {
  const { t } = useAppPreferences();
  const used = Math.min(100, Math.max(0, window.used_percent));
  const remaining = Math.max(0, 100 - used);
  const label = window.window_duration_mins <= 360
    ? t("5 小时用量")
    : window.window_duration_mins >= 7 * 24 * 60
      ? t("每周用量")
      : t("{hours} 小时用量", { hours: Math.round(window.window_duration_mins / 60) });
  const reset = new Intl.DateTimeFormat(language, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(window.resets_at * 1000));

  return (
    <div className={styles.usageWindow}>
      <div className={styles.usageHeader}>
        <strong>{label}</strong>
        <span>{t("剩余 {percent}%", { percent: Math.round(remaining) })}</span>
        <Text type="tertiary">{t("重置时间：{time}", { time: reset })}</Text>
      </div>
      <div
        className={styles.usageTrack}
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(remaining)}
      >
        <span style={{ width: `${remaining}%` }} />
      </div>
    </div>
  );
}

export function formatPlan(plan: string | null | undefined, fallback: string) {
  if (!plan) return fallback;
  const labels: Record<string, string> = {
    free: "Free",
    plus: "Plus",
    pro: "Pro",
    prolite: "Pro Lite",
    team: "Team",
    business: "Business",
    enterprise: "Enterprise",
    edu: "Edu",
  };
  return labels[plan.toLowerCase()] || plan;
}

export function formatAuthMode(mode: string | null | undefined, t: (source: string) => string) {
  if (mode === "chatgpt") return "ChatGPT";
  if (mode === "apiKey") return "API Key";
  return mode || t("未知");
}

export function formatCredits(
  credits: NonNullable<CodexAccountReport["credits"]>,
  t: (source: string, variables?: Record<string, string | number>) => string,
) {
  if (credits.unlimited) return t("不限量");
  if (!credits.has_credits) return t("无可用 Credits");
  return credits.balance ? t("余额 {balance}", { balance: credits.balance }) : t("可用");
}

// Tooltip 需高于抽屉层级；与 AgentAccessSideSheet 保持一致（sideSheet + 1）。
import { APP_OVERLAY_Z_INDEX } from "../../shared/ui/overlayLayers";
const APP_OVERLAY_TOOLTIP_Z_INDEX = APP_OVERLAY_Z_INDEX.sideSheet + 1;
