import { Button } from "@douyinfe/semi-ui-19";
import styles from "./AccountEditorDrawer.module.css";

type Props = {
  isScraping: boolean;
  statusText: string | null;
  needLogin: boolean;
  consoleActionMessage: string | null;
  error: string | null;
  onRetry: () => void;
  showIdleHint?: boolean;
  t: (key: string, params?: Record<string, string | number>) => string;
};

export function ScrapeSyncFeedback({
  isScraping,
  statusText,
  needLogin,
  consoleActionMessage,
  error,
  onRetry,
  showIdleHint = false,
  t,
}: Props) {
  return (
    <>
      {statusText ? <span className={styles.scrapeStatus}>{statusText}</span> : null}
      {needLogin ? (
        <div className={styles.scrapeError}>
          {t("检测到控制台登录页，请在弹出的窗口中完成登录。")}
          <Button size="small" theme="solid" type="primary" loading={isScraping} onClick={onRetry}>
            {t("登录完成,重新抓取")}
          </Button>
        </div>
      ) : null}
      {consoleActionMessage ? (
        <div className={styles.scrapeError}>
          {consoleActionMessage}
          <Button size="small" theme="solid" type="primary" loading={isScraping} onClick={onRetry}>
            {t("重新抓取")}
          </Button>
        </div>
      ) : null}
      {error ? (
        <div className={styles.scrapeError}>
          {t("抓取失败：{message}", { message: error })}
        </div>
      ) : null}
      {showIdleHint && !error ? (
        <span className={styles.scrapeHint}>
          {t("系统每 5 分钟自动同步一次；如登录失效，请点击“立即刷新”完成登录。")}
        </span>
      ) : null}
    </>
  );
}
