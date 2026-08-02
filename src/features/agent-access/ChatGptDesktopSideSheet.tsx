import { useEffect, useRef, useState } from "react";
import { Button, Select, SideSheet, Tabs, Tag, Tooltip, Typography } from "@douyinfe/semi-ui-19";
import { IconCopy, IconPlus, IconRefresh } from "@douyinfe/semi-icons";
import type { AgentEnvironmentReport, AgentGlobalConfigReport, AgentSurface, CodexAccountReport, CodexAccountsReport, CodexRateLimitResetCredits, CodexUsageWindow } from "../../domains/agent/types";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import { APP_OVERLAY_Z_INDEX } from "../../shared/ui/overlayLayers";
import { CODEX_ACCOUNT_SYNC_INTERVAL_MS } from "../background-tasks/CodexAccountAutoSync";
// ConfigRow 使用本文件内的局部版本（与本抽屉其它行的视觉一致）；
// 状态标签与只读状态行复用 Agent 接入共享组件。
import { StatusRow, globalConfigTag } from "./globalConfigPresentation";
import styles from "./AgentAccessSideSheet.module.css";

const { Text, Title } = Typography;
type Copy = (value: string, message: string) => Promise<void>;

type Props = {
  visible: boolean;
  environment?: AgentEnvironmentReport;
  loading?: boolean;
  error?: string;
  onRefresh: () => void;
  /** 一键接入 Flowlet 的全局配置状态（~/.codex/config.toml + auth.json）。 */
  clientToken?: string | null;
  globalConfig?: AgentGlobalConfigReport;
  globalConfigLoading?: boolean;
  globalConfigBusy?: boolean;
  globalConfigError?: string;
  onRefreshGlobalConfig?: () => void;
  onApplyGlobalConfig?: () => Promise<void>;
  onRestoreGlobalConfig?: () => Promise<void>;
  accounts?: CodexAccountsReport;
  accountLoading?: boolean;
  accountError?: string;
  onRefreshAccount: () => void;
  accountAuthorizationBusy?: boolean;
  onAuthorizeAccount: () => void;
  onClose: () => void;
  onCopy: Copy;
};

export function ChatGptDesktopSideSheet({
  visible,
  environment,
  loading = false,
  error,
  onRefresh,
  clientToken,
  globalConfig,
  globalConfigLoading = false,
  globalConfigBusy = false,
  globalConfigError,
  onRefreshGlobalConfig,
  onApplyGlobalConfig,
  onRestoreGlobalConfig,
  accounts,
  accountLoading = false,
  accountError,
  onRefreshAccount,
  accountAuthorizationBusy = false,
  onAuthorizeAccount,
  onClose,
  onCopy,
}: Props) {
  const { language, t } = useAppPreferences();
  const [surface, setSurface] = useState<AgentSurface>("desktop");
  const bodyRef = useRef<HTMLDivElement>(null);
  const installations = environment?.installations.filter((item) => item.surface === surface) ?? [];

  useEffect(() => {
    if (visible) {
      setSurface("desktop");
    }
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const scrollContainer = bodyRef.current?.closest<HTMLElement>(".semi-sidesheet-body");
    if (scrollContainer) scrollContainer.scrollTop = 0;
  }, [surface, visible]);

  return (
    <SideSheet
      visible={visible}
      motion={false}
      zIndex={APP_OVERLAY_Z_INDEX.sideSheet}
      title={
        <Tabs
          className={`${styles.titleTabs} ${styles.chatGptTitleTabs}`}
          activeKey={surface}
          onChange={(key) => setSurface(key as AgentSurface)}
          tabList={[
            { tab: <span className={styles.titleTabLabel}>{t("ChatGPT (Codex) CLI 接入")}</span>, itemKey: "cli" },
            { tab: <span className={styles.titleTabLabel}>{t("ChatGPT (Codex) Desktop 接入")}</span>, itemKey: "desktop" },
          ]}
        />
      }
      headerStyle={{ paddingBottom: 0 }}
      width="min(760px, 96vw)"
      onCancel={onClose}
      bodyStyle={{ padding: 0 }}
    >
      <div ref={bodyRef} className={styles.body}>
        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <div>
              <Title heading={5}>{t("接入 Flowlet")}</Title>
              <Text type="tertiary" size="small">
                {t("一次写入即覆盖 Codex CLI、ChatGPT 桌面端与 VS Code Codex 插件（共享 ~/.codex/config.toml），经 Responses 协议访问 Flowlet。")}
              </Text>
            </div>
            <Button
              icon={<IconRefresh spin={globalConfigLoading} />}
              loading={globalConfigLoading}
              theme="borderless"
              onClick={onRefreshGlobalConfig}
            >
              {t("重新读取")}
            </Button>
          </div>

          {globalConfigError ? (
            <Text className={styles.environmentMessage} type="danger">
              {t("读取全局配置失败：{message}", { message: globalConfigError })}
            </Text>
          ) : null}
          {globalConfig ? (
            <div className={styles.globalConfig}>
              <div className={styles.globalConfigStatus}>
                <span>{t("当前状态")}</span>
                <Tag color={globalConfigTag(globalConfig.state).color}>{t(globalConfigTag(globalConfig.state).label)}</Tag>
              </div>
              <ConfigRow
                label={t("配置文件")}
                value={globalConfig.settings_path}
                onCopy={() => onCopy(globalConfig.settings_path, t("{label} 已复制", { label: t("配置文件") }))}
              />
              {globalConfig.credentials_path ? (
                <ConfigRow
                  label={t("凭据文件")}
                  value={globalConfig.credentials_path}
                  onCopy={() => onCopy(globalConfig.credentials_path || "", t("{label} 已复制", { label: t("凭据文件") }))}
                />
              ) : null}
              {globalConfig.base_url ? <StatusRow label="Base URL" value={globalConfig.base_url} /> : null}
              <StatusRow label="Client Token" value={t(globalConfig.auth_token_configured ? "已配置（内容已隐藏）" : "未配置")} />
              <StatusRow label={t("主模型")} value={globalConfig.primary_model || "-"} />
              {globalConfig.error ? <Text type="danger">{globalConfig.error}</Text> : null}
              {globalConfig.state === "other_gateway" ? (
                <Text className={styles.configNotice} type="warning">
                  {t("当前配置指向其他网关。接入 Flowlet 前会备份原值，之后可以恢复。")}
                </Text>
              ) : null}
              <Text className={styles.configNotice} type="tertiary">
                {t("写入后 Codex 切换为 apikey 鉴权（使用 Flowlet Client Token）并关闭响应存储；恢复后还原此前的登录方式与配置。")}
              </Text>
              <div className={styles.configActions}>
                <Button
                  type="primary"
                  theme="solid"
                  loading={globalConfigBusy}
                  disabled={globalConfig.state === "invalid" || !clientToken}
                  onClick={() => void onApplyGlobalConfig?.()}
                >
                  {t(globalConfig.state === "flowlet" ? "重新写入 Flowlet 配置" : globalConfig.state === "other_gateway" ? "覆盖并接入 Flowlet" : "全局接入 Flowlet")}
                </Button>
                {globalConfig.backup_available ? (
                  <Button disabled={globalConfigBusy} onClick={() => void onRestoreGlobalConfig?.()}>{t("恢复接入前配置")}</Button>
                ) : null}
              </div>
              {!clientToken ? (
                <Text type="tertiary" size="small">{t("当前未配置默认 Client Token，请先在客户端设置中完成配置。")}</Text>
              ) : null}
            </div>
          ) : null}
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <div>
              <Title heading={5}>{t("本机环境")}</Title>
              <Text type="tertiary">{t(surface === "cli" ? "识别 PATH 与官方常见安装位置中的 Codex CLI" : "仅识别统一后的新版 ChatGPT Desktop")}</Text>
            </div>
            <Button icon={<IconRefresh />} loading={loading} onClick={onRefresh}>
              {t("重新检测")}
            </Button>
          </div>

          {error ? (
            <Text className={styles.environmentMessage} type="danger">
              {t("检测失败：{message}", { message: error })}
            </Text>
          ) : !installations.length ? (
            <Text className={styles.environmentMessage} type="tertiary">
              {loading ? t("正在检测…") : t(surface === "cli" ? "未检测到 Codex CLI" : "未检测到 ChatGPT Desktop")}
            </Text>
          ) : (
            installations.map((installation) => (
            <div className={styles.installation} key={installation.executable_path}>
              <div className={styles.installationHeader}>
                <strong>{codexInstallationTitle(surface, installation.version, t)}</strong>
                {!installation.version && <Tag color="green">{t("已安装")}</Tag>}
              </div>
              <InstallationPathRow
                executablePath={installation.executable_path}
                installDir={installation.install_dir}
                onCopy={onCopy}
              />
            </div>
            ))
          )}
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <div>
              <Title heading={5}>{t("Codex 账号与用量")}</Title>
              <Text type="tertiary">{t("Codex 账号凭据仅保存在本机")}</Text>
            </div>
            <div className={styles.sectionActions}>
              <Button
                aria-label={t("添加 / 重新授权账号")}
                icon={<IconPlus />}
                loading={accountAuthorizationBusy}
                onClick={onAuthorizeAccount}
              >
                {accountAuthorizationBusy ? t("等待浏览器授权…") : t("添加 / 重新授权账号")}
              </Button>
              <Button icon={<IconRefresh />} loading={accountLoading} disabled={accountAuthorizationBusy} onClick={onRefreshAccount}>
                {t("刷新用量")}
              </Button>
            </div>
          </div>

          {accountLoading && accounts?.accounts.length ? (
            <Text className={styles.accountRefreshNotice} type="warning">
              {t("正在刷新，当前展示上次更新的数据")}
            </Text>
          ) : null}
          {accountError && accounts?.accounts.length ? (
            <Text className={styles.accountRefreshNotice} type="warning">
              {t("刷新失败，当前展示上次更新的数据：{message}", { message: accountError })}
            </Text>
          ) : null}

          {accountError && !accounts?.accounts.length ? (
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

function codexInstallationTitle(
  surface: AgentSurface,
  version: string | null | undefined,
  t: (source: string, variables?: Record<string, string | number>) => string,
) {
  if (version) {
    return surface === "cli"
      ? t("Codex CLI {version}", { version })
      : t("ChatGPT Desktop {version}", { version });
  }
  return t(surface === "cli" ? "Codex CLI 已安装" : "ChatGPT Desktop 已安装");
}

function CodexAccountCard({ account, language }: { account: CodexAccountReport; language: "zh-CN" | "en-US" }) {
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
            zIndex={APP_OVERLAY_Z_INDEX.sideSheet + 1}
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

function ResetCredits({
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

function InstallationPathRow({
  executablePath,
  installDir,
  onCopy,
}: {
  executablePath: string;
  installDir: string;
  onCopy: Copy;
}) {
  const { t } = useAppPreferences();
  const [kind, setKind] = useState<"executable" | "directory">("executable");
  const label = t(kind === "executable" ? "可执行文件" : "安装目录");
  const value = kind === "executable" ? executablePath : installDir;
  return (
    <div className={styles.configRow}>
      <Select
        aria-label={t("路径类型")}
        className={styles.pathKindSelector}
        zIndex={APP_OVERLAY_Z_INDEX.sideSheet + 1}
        value={kind}
        optionList={[
          { label: t("可执行文件"), value: "executable" },
          { label: t("安装目录"), value: "directory" },
        ]}
        onChange={(nextKind) => setKind(nextKind as "executable" | "directory")}
      />
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
