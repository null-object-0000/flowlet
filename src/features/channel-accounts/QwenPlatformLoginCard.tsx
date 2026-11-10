import { Button, Tag, Typography } from "@douyinfe/semi-ui-19";
import { IconRefresh } from "@douyinfe/semi-icons";
import styles from "./AccountEditorDrawer.module.css";
import type { UseQwenPlatformLoginResult } from "./useQwenPlatformLogin";
import { formatFullTimestamp } from "../../shared/formatters/datetime";

const { Text } = Typography;

export type QwenPlatformLanguage = "zh-CN" | "en-US";

export type QwenPlatformTranslate = (
  key: string,
  params?: Record<string, string | number> | undefined,
) => string;

/**
 * 千问平台登录卡片（device flow）以及面板共用的两个小片段。
 *
 * 同一套「登录 → 官方 HTTP 同步」能力同时服务两个 Qwen 资源模式：
 * - API 按量付费（`QwenFreeTierPanel`）：余额 + 各模型免费额度；
 * - Token Plan 订阅（`QwenTokenPlanPanel`）：订阅额度窗口 + 重置卡。
 *
 * 两个面板的差异只有说明文案与同步成功提示，因此在这里以 props 注入，
 * 登录状态机（`useQwenPlatformLogin`）与交互保持一致。
 */
export type QwenPlatformLoginCardProps = {
  platform: UseQwenPlatformLoginResult;
  /** 编辑态才允许登录/退出；新建未保存的账号没有服务端 id。 */
  enabled: boolean;
  language: QwenPlatformLanguage;
  t: QwenPlatformTranslate;
  /** 未登录时的说明文案（已翻译）。 */
  loggedOutHint: string;
  /** 已登录时的说明文案（已翻译）。 */
  loggedInHint: string;
};

/** 登录完成的自动同步期间也按已登录处理，避免瞬间闪回 WebView 兜底按钮。 */
function useIsPlatformLoggedIn(platform: UseQwenPlatformLoginResult): boolean {
  return platform.isLoggedIn || platform.isSyncing;
}

/**
 * 顶部来源标签：已登录 = HTTP 同步，未登录 = WebView 抓取。
 * 放在各面板自己的 summary heading 里，保持与既有布局一致。
 */
export function QwenPlatformSyncModeTag({
  platform,
  t,
}: {
  platform: UseQwenPlatformLoginResult;
  t: QwenPlatformTranslate;
}) {
  const isLoggedIn = useIsPlatformLoggedIn(platform);
  return (
    <Tag size="small" color={isLoggedIn ? "green" : "grey"}>
      {t(isLoggedIn ? "HTTP 同步" : "WebView 抓取")}
    </Tag>
  );
}

/**
 * 未登录时的兜底说明：桌面端会说明当前仍走 WebView 控制台抓取，
 * Web Host 则直接提示先登录。已登录时不渲染。
 */
export function QwenPlatformFallbackHint({
  platform,
  desktopCapabilities = true,
  t,
}: {
  platform: UseQwenPlatformLoginResult;
  desktopCapabilities?: boolean;
  t: QwenPlatformTranslate;
}) {
  if (useIsPlatformLoggedIn(platform)) return null;
  return (
    <Text type="tertiary" size="small">
      {t(desktopCapabilities
        ? "未登录千问平台，当前使用 WebView 控制台抓取；登录后可改为 HTTP 同步。"
        : "未登录千问平台，请先登录以获得 HTTP 同步。")}
    </Text>
  );
}

/** 登录/退出/等待授权的卡片本体。 */
export function QwenPlatformLoginCard({
  platform,
  enabled,
  language,
  t,
  loggedOutHint,
  loggedInHint,
}: QwenPlatformLoginCardProps) {
  const isLoggedIn = useIsPlatformLoggedIn(platform);
  const platformAccount = platform.status?.aliyunId ?? platform.status?.email ?? "-";

  return (
    <div className={styles.longCatSummaryCard}>
      <div className={styles.longCatSummaryHeading}>
        <strong>{t("千问平台登录")}</strong>
        {platform.statusLoading ? (
          <Tag size="small" color="grey">{t("正在读取登录状态…")}</Tag>
        ) : isLoggedIn ? (
          <Tag size="small" color="green">{t("已登录")}</Tag>
        ) : (
          <Tag size="small" color="grey">{t("未登录")}</Tag>
        )}
      </div>

      {platform.isPolling ? (
        <div className={styles.scrapeToolbar}>
          <Text>{t("等待浏览器授权…")}</Text>
          <Button size="small" theme="borderless" onClick={platform.cancelLogin}>{t("取消")}</Button>
        </div>
      ) : isLoggedIn ? (
        <div className={styles.qwenPlatformIdentity}>
          <Text>{t("已登录 {account}", { account: platformAccount })}</Text>
          {platform.status?.expiresAt ? (
            <Text type="tertiary" size="small">
              {t("登录有效至 {time}", { time: formatPlatformExpiry(platform.status.expiresAt, language) })}
            </Text>
          ) : null}
          <Text type="tertiary" size="small">{loggedInHint}</Text>
          <div className={styles.qwenPlatformActions}>
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
          </div>
        </div>
      ) : (
        <div className={styles.qwenPlatformIdentity}>
          <Text type="tertiary" size="small">{loggedOutHint}</Text>
          <div className={styles.qwenPlatformActions}>
            <Button
              size="small"
              theme="solid"
              loading={platform.phase === "starting"}
              disabled={!enabled || platform.isSyncing}
              onClick={() => void platform.startLogin()}
            >
              {t("登录千问平台")}
            </Button>
            {!enabled ? (
              <Text type="tertiary" size="small">{t("保存账号后可登录千问平台")}</Text>
            ) : null}
          </div>
        </div>
      )}

      {platform.error && platform.errorScope !== "sync" ? (
        <div className={styles.scrapeError}>{platform.error}</div>
      ) : null}
    </div>
  );
}

/** 千问平台 `expiresAt` 可能是 RFC3339 或数字时间戳字符串（秒/毫秒）；解析失败时
 *  原样展示，不因格式化抛错。 */
function formatPlatformExpiry(value: string, language: QwenPlatformLanguage): string {
  const trimmed = value.trim();
  if (/^\d{9,}$/.test(trimmed)) {
    const numeric = Number(trimmed);
    const ms = trimmed.length >= 13 ? numeric : numeric * 1000;
    const date = new Date(ms);
    if (!Number.isNaN(date.getTime())) return formatFullTimestamp(date.toISOString(), language);
  }
  return formatFullTimestamp(trimmed, language);
}