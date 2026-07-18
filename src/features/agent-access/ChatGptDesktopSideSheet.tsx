import { Button, SideSheet, Tabs, Tag, Typography } from "@douyinfe/semi-ui-19";
import { IconCopy, IconRefresh } from "@douyinfe/semi-icons";
import type { AgentEnvironmentReport, CodexAccountReport, CodexAccountsReport, CodexUsageWindow } from "../../domains/agent/types";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import { APP_OVERLAY_Z_INDEX } from "../../shared/ui/overlayLayers";
import styles from "./AgentAccessSideSheet.module.css";

const { Paragraph, Text, Title } = Typography;
type Copy = (value: string, message: string) => Promise<void>;

type Props = {
  visible: boolean;
  environment?: AgentEnvironmentReport;
  loading?: boolean;
  error?: string;
  onRefresh: () => void;
  accounts?: CodexAccountsReport;
  accountLoading?: boolean;
  accountError?: string;
  onRefreshAccount: () => void;
  onClose: () => void;
  onCopy: Copy;
};

export function ChatGptDesktopSideSheet({
  visible,
  environment,
  loading = false,
  error,
  onRefresh,
  accounts,
  accountLoading = false,
  accountError,
  onRefreshAccount,
  onClose,
  onCopy,
}: Props) {
  const { language, t } = useAppPreferences();
  const installation = environment?.installations.find((item) => item.surface === "desktop");

  return (
    <SideSheet
      visible={visible}
      motion={false}
      zIndex={APP_OVERLAY_Z_INDEX.sideSheet}
      title={
        <Tabs
          className={`${styles.titleTabs} ${styles.chatGptTitleTabs}`}
          activeKey="desktop"
          tabList={[
            { tab: <span className={styles.titleTabLabel}>{t("ChatGPT (Codex) CLI 接入")}</span>, itemKey: "cli", disabled: true },
            { tab: <span className={styles.titleTabLabel}>{t("ChatGPT (Codex) Desktop 接入")}</span>, itemKey: "desktop" },
          ]}
        />
      }
      headerStyle={{ paddingBottom: 0 }}
      width={680}
      onCancel={onClose}
      bodyStyle={{ padding: 0 }}
    >
      <div className={styles.body}>
        <section className={styles.intro}>
          <Tag color="blue">Desktop</Tag>
          <Paragraph type="tertiary">
            {t("检测新版 ChatGPT Desktop 的安装版本和位置。")}
          </Paragraph>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <div>
              <Title heading={5}>{t("本机环境")}</Title>
              <Text type="tertiary">{t("仅识别统一后的新版 ChatGPT Desktop")}</Text>
            </div>
            <Button icon={<IconRefresh />} loading={loading} onClick={onRefresh}>
              {t("重新检测")}
            </Button>
          </div>

          {error ? (
            <Text className={styles.environmentMessage} type="danger">
              {t("检测失败：{message}", { message: error })}
            </Text>
          ) : !installation ? (
            <Text className={styles.environmentMessage} type="tertiary">
              {loading ? t("正在检测…") : t("未检测到 ChatGPT Desktop")}
            </Text>
          ) : (
            <div className={styles.installation}>
              <div className={styles.installationHeader}>
                <strong>
                  {installation.version
                    ? t("ChatGPT Desktop {version}", { version: installation.version })
                    : t("ChatGPT Desktop 已安装")}
                </strong>
                {!installation.version && <Tag color="green">{t("已安装")}</Tag>}
              </div>
              <ConfigRow label={t("应用路径")} value={installation.executable_path} onCopy={onCopy} />
              <ConfigRow label={t("安装目录")} value={installation.install_dir} onCopy={onCopy} />
            </div>
          )}
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <div>
              <Title heading={5}>{t("Codex 账号与用量")}</Title>
              <Text type="tertiary">{t("切换 Codex 账号后刷新即可保留；登录凭据仅保存在本机查询目录")}</Text>
            </div>
            <Button icon={<IconRefresh />} loading={accountLoading} onClick={onRefreshAccount}>
              {t("刷新用量")}
            </Button>
          </div>

          {accountError ? (
            <Text className={styles.environmentMessage} type="danger">
              {t("账号信息查询失败：{message}", { message: accountError })}
            </Text>
          ) : accountLoading && !accounts ? (
            <Text className={styles.environmentMessage} type="tertiary">{t("正在查询 Codex 账号与用量…")}</Text>
          ) : !accounts?.accounts.length ? (
            <Text className={styles.environmentMessage} type="tertiary">{t("未检测到 Codex 登录账号")}</Text>
          ) : (
            <div className={styles.codexAccountList}>
              {accounts.accounts.map((account) => (
                <CodexAccountCard key={account.account_id} account={account} language={language} />
              ))}
            </div>
          )}
        </section>
      </div>
    </SideSheet>
  );
}

function CodexAccountCard({ account, language }: { account: CodexAccountReport; language: "zh-CN" | "en-US" }) {
  const { t } = useAppPreferences();
  const updatedAt = new Intl.DateTimeFormat(language, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(account.updated_at));

  return (
    <div className={styles.codexAccount}>
      <div className={styles.codexAccountHeader}>
        <strong title={account.email || undefined}>{account.email || t("已登录")}</strong>
        <span className={styles.accountTags}>
          {account.is_current ? <Tag color="green">{t("当前账号")}</Tag> : null}
          {account.stale ? <Tag color="orange">{t("数据已过期")}</Tag> : null}
        </span>
      </div>
      <div className={styles.accountSummary}>
        <div>
          <Text type="tertiary">{t("会员套餐")}</Text>
          <Tag color="blue">{formatPlan(account.plan_type, t("未知套餐"))}</Tag>
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
          <span>{updatedAt}</span>
        </div>
      </div>
      {account.error ? <Text className={styles.accountNotice} type="warning">{t("刷新失败：{message}", { message: account.error })}</Text> : null}
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
      <Text type="tertiary">{t("重置时间：{time}", { time: reset })}</Text>
    </div>
  );
}

function formatPlan(plan: string | null | undefined, fallback: string) {
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

function formatAuthMode(mode: string | null | undefined, t: (source: string) => string) {
  if (mode === "chatgpt") return "ChatGPT";
  if (mode === "apiKey") return "API Key";
  return mode || t("未知");
}

function formatCredits(
  credits: NonNullable<CodexAccountReport["credits"]>,
  t: (source: string, variables?: Record<string, string | number>) => string,
) {
  if (credits.unlimited) return t("不限量");
  if (!credits.has_credits) return t("无可用 Credits");
  return credits.balance ? t("余额 {balance}", { balance: credits.balance }) : t("可用");
}

function ConfigRow({ label, value, onCopy }: { label: string; value: string; onCopy: Copy }) {
  const { t } = useAppPreferences();
  return (
    <div className={styles.configRow}>
      <Text type="tertiary">{label}</Text>
      <code title={value}>{value}</code>
      <Button
        theme="borderless"
        type="primary"
        icon={<IconCopy />}
        aria-label={t("复制 {label}", { label })}
        onClick={() => void onCopy(value, t("{label} 已复制", { label }))}
      />
    </div>
  );
}
