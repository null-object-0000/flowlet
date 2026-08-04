import { Button, Input, Progress, Tag, Typography } from "@douyinfe/semi-ui-19";
import { IconRefresh } from "@douyinfe/semi-icons";
import type { CodexAccountReport, CodexUsageWindow } from "../../domains/agent/types";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import { formatFullTimestamp } from "../../shared/formatters/datetime";
import { ResetCredits, formatAuthMode, formatCredits, formatPlan } from "./CodexAccountCard";
import styles from "./CodexAccountSideSheet.module.css";

const { Text } = Typography;

type Props = {
  account: CodexAccountReport;
  language: "zh-CN" | "en-US";
  refreshing: boolean;
  error?: string | null;
  onRefresh: () => void;
};

/**
 * Codex 账号编辑页（Qwen Token Plan 风格，只读）。
 * 无 API Key、无开放模型、无高级设置；账号名称只读。
 * 结构：基础信息 → 资源模式（订阅额度自动同步）→ 账号信息（套餐/登录方式/Credits/重置机会）。
 */
export function CodexAccountEditor({ account, language, refreshing, error, onRefresh }: Props) {
  const { t } = useAppPreferences();
  const fiveHour = pickWindow(account, (window) => window.window_duration_mins <= 360);
  const sevenDay = pickWindow(account, (window) => window.window_duration_mins >= 7 * 24 * 60);
  const hasFive = Boolean(fiveHour);
  const hasSeven = Boolean(sevenDay);

  return (
    <div className={styles.editor}>
      <section className={styles.editorSection}>
        <h3>{t("基础信息")}</h3>
        <div className={styles.basicFields}>
          <div className={styles.field}>
            <span>{t("账号名称")}</span>
            <Input aria-label={t("账号名称")} value={account.email || ""} disabled />
          </div>
          <div className={styles.field}>
            <span>{t("启用状态")}</span>
            <Text>{t("已启用")}</Text>
          </div>
        </div>
      </section>

      <section className={styles.editorSection}>
        <div className={styles.resourceModeHeading}>
          <span><h3>{t("资源模式")}</h3><small>{t("订阅额度自动同步")}</small></span>
        </div>
        <div className={styles.quotaSummaryCard}>
          <div className={styles.quotaSummaryHeading}>
            <strong>{t("Codex 账户用量")}</strong>
            <Tag size="small" color="green">{t("自动同步")}</Tag>
          </div>
          <div className={styles.quotaSummaryGrid}>
            {hasFive ? <CodexQuotaProgress period={t("5 小时")} window={fiveHour} spanAll={!hasSeven} language={language} t={t} /> : null}
            {hasSeven ? <CodexQuotaProgress period={t("7 天")} window={sevenDay} spanAll={!hasFive} language={language} t={t} /> : null}
            {!hasFive && !hasSeven ? <CodexQuotaProgress period={t("用量")} window={account.primary ?? account.secondary ?? null} spanAll language={language} t={t} /> : null}
            <div className={styles.timeSummary}>
              <span>
                <small>{t("最近同步")}</small>
                <strong>{account.updated_at ? formatFullTimestamp(account.updated_at, language) : "-"}</strong>
              </span>
            </div>
          </div>
        </div>

        <div className={styles.syncSection}>
          <div className={styles.syncControls}>
            <Button icon={<IconRefresh />} loading={refreshing} onClick={onRefresh}>{t("立即刷新")}</Button>
          </div>
          {error ? <Text className={styles.syncError} type="danger">{t("刷新失败：{message}", { message: error })}</Text> : null}
        </div>
      </section>

      <section className={styles.editorSection}>
        <h3>{t("账号信息")}</h3>
        <div className={styles.accountInfo}>
          <div>
            <Text type="tertiary">{t("会员套餐")}</Text>
            <span>{formatPlan(account.plan_type, t("未知套餐"))}</span>
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
        </div>
        {account.rate_limit_reset_credits ? (
          <ResetCredits credits={account.rate_limit_reset_credits} language={language} />
        ) : null}
      </section>
    </div>
  );
}

/** 从 primary/secondary 中选取符合周期条件的窗口。 */
function pickWindow(
  account: CodexAccountReport,
  match: (window: CodexUsageWindow) => boolean,
): CodexUsageWindow | null {
  if (account.primary && match(account.primary)) return account.primary;
  if (account.secondary && match(account.secondary)) return account.secondary;
  return null;
}

/** 镜像 Qwen Token Plan 的配额进度模块：剩余百分比 + 进度条 + 重置时间。 */
function CodexQuotaProgress({
  period,
  window,
  spanAll,
  language,
  t,
}: {
  period: string;
  window: CodexUsageWindow | null;
  spanAll: boolean;
  language: "zh-CN" | "en-US";
  t: (k: string, params?: Record<string, string | number> | undefined) => string;
}) {
  const remaining = window ? Math.max(0, Math.round(100 - window.used_percent)) : null;
  const resetAt = window?.resets_at
    ? formatFullTimestamp(new Date(window.resets_at * 1000).toISOString(), language)
    : "-";
  return (
    <div className={`${styles.quotaProgress} ${spanAll ? styles.quotaSpanAll : ""}`}>
      <div className={styles.quotaProgressHeading}>
        <strong>
          {remaining == null
            ? t("{period} -", { period })
            : t("{period} {percent}%", { period, percent: remaining })}
        </strong>
      </div>
      <Progress
        aria-label={t("{period}额度", { period })}
        percent={remaining ?? 0}
        size="small"
        showInfo={false}
      />
      <small className={styles.quotaResetTime}>
        {t("额度重置时间")} <b>{resetAt}</b>
      </small>
    </div>
  );
}