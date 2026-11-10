import { useEffect, useRef, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Progress, Tag, Toast, Typography } from "@douyinfe/semi-ui-19";
import { IconRefresh } from "@douyinfe/semi-icons";

import type { AccountBalanceSnapshot, ChannelAccount } from "../../domains/account/types";
import { isQwenPayAsYouGoAccount, isQwenTokenPlanAccount } from "../../domains/channel/types";
import type { ScrapeBalanceResult } from "../../domains/account/commands";
import { formatFullTimestamp } from "../../shared/formatters/datetime";
import { queryKeys } from "../../shared/query-keys";
import styles from "./AccountEditorDrawer.module.css";
import { ScrapeSyncFeedback } from "./ScrapeSyncFeedback";
import {
  QwenPlatformFallbackHint,
  QwenPlatformLoginCard,
  QwenPlatformSyncModeTag,
} from "./QwenPlatformLoginCard";
import { useQwenPlatformLogin } from "./useQwenPlatformLogin";
import { useScrapeConsole } from "./useScrapeConsole";
import { parseQwenFreeTierDetails } from "./qwenFreetierDetails";
import {
  isQwenSubscriptionActive,
  parseQwenTokenPlanDetails,
  qwenSubscriptionInactiveKind,
  type QwenQuotaWindow,
  type QwenTokenPlanDetails,
} from "./qwenTokenPlanDetails";

const { Text } = Typography;

type Translate = (k: string, params?: Record<string, string | number> | undefined) => string;

export type QwenAccountPanelProps = {
  account: ChannelAccount;
  /** 编辑态才允许登录/退出与同步；新建未保存的账号没有服务端 id。 */
  enabled: boolean;
  /** Web Host 没有 WebView 兜底，说明文案据此区分。 */
  desktopCapabilities?: boolean;
  snapshot?: AccountBalanceSnapshot;
  onScrape?: (accountId: string) => Promise<ScrapeBalanceResult>;
  language: "zh-CN" | "en-US";
  t: Translate;
};

/**
 * 千问账号统一资源面板。
 *
 * 同一个千问平台账号的「按量付费余额/免费额度」与「Token Plan 订阅额度」由同一次
 * 平台同步返回（同一个 `rawScrapedJson`），但**每个 Flowlet 账号只展示自己资源模式的
 * 那部分数据**：按量付费账号显示余额/免费额度，Token Plan 账号显示订阅额度。
 * 两条账号记录因此不会长得一模一样，面板也不会无谓变高。
 * - 登录卡与同步控件各只有一份（登录按平台账号共享），已登录走官方 HTTP 同步，
 *   未登录回退 WebView 抓取。
 */
export function QwenAccountPanel({
  account,
  enabled,
  desktopCapabilities = true,
  snapshot,
  onScrape,
  language,
  t,
}: QwenAccountPanelProps) {
  const queryClient = useQueryClient();
  const platform = useQwenPlatformLogin({
    accountId: account.id,
    enabled,
    // 与余额抓取/账号保存后的失效方式一致：刷新余额快照并失效账号列表。
    onSynced: () => {
      void queryClient.refetchQueries({ queryKey: queryKeys.usage.latestBalanceSnapshots(), exact: true });
      void queryClient.invalidateQueries({ queryKey: queryKeys.account.list() });
    },
  });
  const {
    startScrape,
    retryScrape,
    lastResult,
    isScraping,
    needLogin,
    consoleActionMessage,
    error: scrapeError,
    statusText,
  } = useScrapeConsole(onScrape);

  // 登录完成的自动同步期间也按已登录处理，避免瞬间闪回 WebView 兜底按钮。
  const isLoggedIn = platform.isLoggedIn || platform.isSyncing;
  // 两条数据来源（HTTP / WebView）的 bundle 同构，解析器无需区分来源。
  const rawScrapedJson = platform.lastSync?.rawScrapedJson
    ?? lastResult?.raw_scraped_json
    ?? snapshot?.raw_scraped_json;
  const syncedAt = platform.lastSync?.syncedAt ?? lastResult?.synced_at ?? snapshot?.synced_at;
  // 同一个千问平台账号的两种资源模式由同一次同步返回（合并 bundle），但界面上
  // 每个 Flowlet 账号只展示自己那种模式的数据：按量付费看余额/免费额度，
  // Token Plan 看订阅额度。否则两条账号记录会长得一模一样，且面板无谓变高。
  const isPayAsYouGoAccount = isQwenPayAsYouGoAccount(account);
  const isTokenPlanAccount = isQwenTokenPlanAccount(account);
  const freeTier = isPayAsYouGoAccount ? parseQwenFreeTierDetails(rawScrapedJson) : null;
  const subscription = isTokenPlanAccount ? parseQwenTokenPlanDetails(rawScrapedJson) : null;
  const hasAnyData = isPayAsYouGoAccount ? freeTier !== null : subscription !== null;
  const showFreeHints = isPayAsYouGoAccount && freeTier !== null;
  const refreshLoading = isLoggedIn ? platform.isSyncing : isScraping;

  // 旧版本在 Web Host 保存账号时会写一条没有 raw_scraped_json 的 manual 余额快照，
  // 把免费额度/订阅明细顶掉（最新快照只有余额）。打开面板时如果已登录、但这份快照
  // 里没有任何千问平台槽位，就自动补一次 HTTP 同步恢复数据；每个账号只尝试一次。
  const autoSyncAttemptedRef = useRef<string | null>(null);
  const syncNowRef = useRef(platform.syncNow);
  useEffect(() => {
    syncNowRef.current = platform.syncNow;
  });
  useEffect(() => {
    if (!enabled || !platform.isLoggedIn || platform.isSyncing) return;
    let hasPlatformSlots = false;
    try {
      const bundle = snapshot?.raw_scraped_json ? JSON.parse(snapshot.raw_scraped_json) : null;
      hasPlatformSlots = Boolean(bundle && (bundle.fq_instance || bundle.subscription));
    } catch {
      hasPlatformSlots = false;
    }
    if (hasPlatformSlots) return;
    if (autoSyncAttemptedRef.current === account.id) return;
    autoSyncAttemptedRef.current = account.id;
    void syncNowRef.current();
  }, [account.id, enabled, platform.isLoggedIn, platform.isSyncing, snapshot?.raw_scraped_json]);

  // 登录状态收进资源卡片底部一行（不再单独占一张卡），面板高度明显收敛。
  const loginRow = (
    <QwenPlatformLoginCard
      platform={platform}
      enabled={enabled}
      language={language}
      t={t}
      inline
      showActions={false}
      loggedOutHint={t("通过千问平台登录后，余额、免费额度与订阅额度由官方 HTTP 接口同步，无需打开 WebView。")}
      loggedInHint={t("余额、免费额度与订阅额度由官方 HTTP 接口同步，无需打开 WebView。")}
    />
  );

  async function handleRefresh() {
    if (isLoggedIn) {
      const result = await platform.syncNow();
      if (result) Toast.success(t("已通过 HTTP 同步千问平台资源"));
      return;
    }
    await startScrape(account.id);
  }

  async function handleRetry() {
    await retryScrape(account.id);
  }

  return (
    <div className={styles.longCatResourcePanel}>
      {isPayAsYouGoAccount ? (
        <QwenFreeTierSummary
          freeTier={freeTier}
          syncedAt={syncedAt}
          platform={platform}
          showFreeHints={showFreeHints}
          showEmptyHint={!hasAnyData}
          footer={loginRow}
          language={language}
          t={t}
        />
      ) : null}

      {isTokenPlanAccount ? (
        subscription ? (
          <QwenSubscriptionCard details={subscription} syncedAt={syncedAt} footer={loginRow} language={language} t={t} />
        ) : (
          <div className={styles.longCatSummaryCard}>
            <div className={styles.longCatSummaryHeading}>
              <strong>{t("Token Plan 订阅信息")}</strong>
              <QwenPlatformSyncModeTag platform={platform} t={t} />
            </div>
            <Text type="tertiary" size="small">
              {isLoggedIn ? t("尚未同步到订阅信息，点击“立即刷新”重试。") : t("登录千问平台后自动同步订阅额度。")}
            </Text>
            <div className={styles.qwenCardFooter}>{loginRow}</div>
          </div>
        )
      ) : null}

      <div className={styles.longCatSyncSection}>
        <div className={styles.longCatSyncControls}>
          <div className={styles.qwenSyncActions}>
          <Button
            icon={<IconRefresh />}
            loading={refreshLoading}
            disabled={!enabled}
            onClick={() => void handleRefresh()}
          >
            {t("立即刷新")}
          </Button>
          {isLoggedIn ? (
            <>
              <Button
                size="small"
                theme="borderless"
                icon={<IconRefresh />}
                disabled={!enabled || platform.isSyncing}
                onClick={() => void platform.startLogin()}
              >
                {t("重新登录")}
              </Button>
              <Button
                size="small"
                type="danger"
                theme="borderless"
                disabled={!enabled || platform.isSyncing}
                onClick={() => void platform.logout()}
              >
                {t("退出登录")}
              </Button>
            </>
          ) : (
            <Button
              size="small"
              theme="solid"
              loading={platform.phase === "starting"}
              disabled={!enabled || platform.isSyncing}
              onClick={() => void platform.startLogin()}
            >
              {t("登录千问平台")}
            </Button>
          )}
          </div>
          <div className={styles.qwenSyncFeedback}>
          {isLoggedIn ? (
            <Text type="tertiary" size="small">
              {platform.isSyncing
                ? t("正在同步千问平台资源…")
                : platform.phase === "success"
                  ? t("已通过 HTTP 同步千问平台资源")
                  : t("HTTP 同步")}
            </Text>
          ) : (
            <ScrapeSyncFeedback
              isScraping={isScraping}
              statusText={statusText}
              needLogin={needLogin}
              consoleActionMessage={consoleActionMessage}
              error={scrapeError}
              onRetry={() => void handleRetry()}
              showIdleHint={!hasAnyData}
              t={t}
            />
          )}
          </div>
        </div>
        {platform.error && platform.errorScope === "sync" ? (
          <div className={styles.scrapeError}>{platform.error}</div>
        ) : null}
        <QwenPlatformFallbackHint
          platform={platform}
          desktopCapabilities={desktopCapabilities}
          t={t}
        />
      </div>
    </div>
  );
}

/** 平台账户摘要：余额 / 未结清 / 本月账单只渲染有真实数据的行，再补免费额度模型数。 */
function QwenFreeTierSummary({
  freeTier,
  syncedAt,
  platform,
  showFreeHints,
  showEmptyHint,
  footer,
  language,
  t,
}: {
  freeTier: ReturnType<typeof parseQwenFreeTierDetails>;
  syncedAt?: string | null;
  platform: ReturnType<typeof useQwenPlatformLogin>;
  showFreeHints: boolean;
  showEmptyHint: boolean;
  footer?: ReactNode;
  language: "zh-CN" | "en-US";
  t: Translate;
}) {
  const freeModelCount = freeTier?.validInstances.length ?? 0;
  return (
    <div className={styles.longCatSummaryCard}>
      <div className={styles.longCatSummaryHeading}>
        <strong>{t("千问平台资源")}</strong>
        <QwenPlatformSyncModeTag platform={platform} t={t} />
      </div>
      <div className={`${styles.longCatSummaryGrid} ${styles.qwenAccountSummaryGrid}`}>
        {freeTier?.balance != null ? (
          <div>
            <small>{t("账户余额")}</small>
            <strong>{formatMoney(freeTier.balance, language)} {freeTier.currency ?? ""}</strong>
          </div>
        ) : null}
        {freeTier?.unsettledAmount != null ? (
          <div>
            <small>{t("未结清")}</small>
            <strong>{formatMoney(freeTier.unsettledAmount, language)}</strong>
          </div>
        ) : null}
        {freeTier?.settleBillTotal != null ? (
          <div>
            <small>{freeTier.settleBillCycle ? t("账单 {cycle}", { cycle: freeTier.settleBillCycle }) : t("本月账单")}</small>
            <strong>{formatMoney(freeTier.settleBillTotal, language)}</strong>
          </div>
        ) : null}
        <div className={styles.qwenTimeSummary}>
          <span>
            <small>{t("最近同步")}</small>
            <strong>{syncedAt ? formatFullTimestamp(syncedAt, language) : "-"}</strong>
          </span>
          {showFreeHints && freeModelCount > 0 ? (
            <Text type="tertiary" size="small">
              {t("免费额度 {count} 个模型", { count: freeModelCount })}
            </Text>
          ) : null}
          {showFreeHints ? (
            <Text type="tertiary" size="small">{t("免费模型见下方开放模型列表")}</Text>
          ) : null}
        </div>
      </div>
      {showEmptyHint ? (
        <Text type="tertiary" size="small">{t("尚未同步账户余额与免费额度")}</Text>
      ) : null}
      {footer ? <div className={styles.qwenCardFooter}>{footer}</div> : null}
    </div>
  );
}

/** Token Plan 订阅卡：只在 bundle 带订阅槽位时渲染；过期/未订阅只显示状态占位。 */
function QwenSubscriptionCard({
  details,
  syncedAt,
  footer,
  language,
  t,
}: {
  details: QwenTokenPlanDetails;
  syncedAt?: string | null;
  footer?: ReactNode;
  language: "zh-CN" | "en-US";
  t: Translate;
}) {
  const planName = `${details.specCode.charAt(0).toUpperCase()}${details.specCode.slice(1)}`;
  // 套餐过期/未订阅：显示真实状态占位，不渲染额度进度条与重置卡。
  const subscriptionActive = isQwenSubscriptionActive(details);
  const inactiveKind = qwenSubscriptionInactiveKind(details);
  const fiveHour = subscriptionActive ? details.fiveHour : null;
  const primaryQuota = subscriptionActive ? details.primary : null;
  // 上游控制台改版后不再返回 5 小时用量（usage 只有 per1MonthPercentage），旧写法会留下
  // 「5 小时 - / 总量 - / 额度重置时间 -」三个空占位。只渲染真正有数据的额度窗口。
  const quotaWindows: QwenQuotaWindow[] = [];
  if (fiveHour && fiveHour.key !== primaryQuota?.key) quotaWindows.push(fiveHour);
  if (primaryQuota) quotaWindows.push(primaryQuota);
  const resetCards = subscriptionActive ? details.resetCards : null;

  return (
    <>
      <div className={styles.longCatSummaryCard}>
        <div className={styles.longCatSummaryHeading}>
          <strong>{t("个人版 {name} 套餐", { name: planName })}</strong>
          {subscriptionActive ? (
            <Tag size="small" color="green">{t("自动同步")}</Tag>
          ) : (
            <Tag size="small" color="red">{t(inactiveKind === "expired" ? "套餐已过期" : "未订阅套餐")}</Tag>
          )}
        </div>
        <div className={`${styles.longCatSummaryGrid} ${styles.qwenSummaryGrid}`}>
          {subscriptionActive ? (
            <>
              {quotaWindows.map((window) => (
                <QwenQuotaProgress
                  key={window.key}
                  period={t(window.label)}
                  quota={window}
                  spanAll={quotaWindows.length === 1}
                  language={language}
                  t={t}
                />
              ))}
            </>
          ) : (
            <div className={styles.qwenTimeSummary}>
              <span>
                <small>{t("订阅状态")}</small>
                <strong>{t(inactiveKind === "expired" ? "套餐已过期" : "未订阅套餐")}</strong>
              </span>
            </div>
          )}
          <div className={styles.qwenTimeSummary}>
            <span>
              <small>{t("套餐到期")}</small>
              <strong>{details.expireAt ? formatFullTimestamp(details.expireAt, language) : "-"}</strong>
            </span>
            <span>
              <small>{t("最近同步")}</small>
              <strong>{syncedAt ? formatFullTimestamp(syncedAt, language) : "-"}</strong>
            </span>
          </div>
        </div>
        {footer ? <div className={styles.qwenCardFooter}>{footer}</div> : null}
      </div>

      {resetCards ? (
        <div className={styles.qwenResetCards}>
          <div className={styles.qwenResetCardsHeader}>
            <strong>{t("重置机会")}</strong>
            <Tag color="green">{t("可用 {count} 次", { count: resetCards.available_count })}</Tag>
          </div>
          {resetCards.credits?.length ? (
            <div className={styles.qwenResetCardList}>
              {resetCards.credits.map((card) => {
                const typeLabel = card.reset_type === "RESET_1W"
                  ? t("周额度重置")
                  : card.reset_type || t("用量限额重置");
                return (
                  <div className={styles.qwenResetCard} key={card.id}>
                    <strong>{typeLabel}</strong>
                    <Text type="tertiary">
                      {typeof card.expires_at === "number"
                        ? t("将于 {time} 到期", { time: formatResetCardExpiry(card.expires_at, language) })
                        : t("未提供过期时间")}
                    </Text>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function QwenQuotaProgress({
  period,
  quota,
  spanAll,
  language,
  t,
}: {
  period: string;
  quota: QwenQuotaWindow;
  spanAll: boolean;
  language: "zh-CN" | "en-US";
  t: Translate;
}) {
  // 只在窗口确实有数据时才渲染（调用方已过滤），因此这里不再需要「-」占位分支。
  const percent = Math.round(quota.remainingPercent * 10) / 10;
  return (
    <div className={`${styles.qwenProgress} ${spanAll ? styles.qwenProgressSpanAll : ""}`}>
      <div className={styles.qwenProgressHeading}>
        <strong>
          {t("{period} {percent}%", { period, percent: percent.toFixed(1) })}
        </strong>
        <small>{t("总量")} {formatQuotaCredits(quota.total, language)}</small>
      </div>
      <Progress
        aria-label={t("{period}额度", { period })}
        percent={percent}
        size="small"
        showInfo={false}
      />
      <small className={styles.qwenResetTime}>
        {t("额度重置时间")} <b>{quota.resetAt ? formatFullTimestamp(quota.resetAt, language) : "-"}</b>
      </small>
    </div>
  );
}

function formatMoney(value: number, language: "zh-CN" | "en-US") {
  return value.toLocaleString(language, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatQuotaCredits(value: number, language: "zh-CN" | "en-US") {
  return `${Math.max(0, value).toLocaleString(language, { maximumFractionDigits: 0 })} Credits`;
}

function formatResetCardExpiry(epochMs: number, language: "zh-CN" | "en-US") {
  return new Intl.DateTimeFormat(language, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(epochMs));
}