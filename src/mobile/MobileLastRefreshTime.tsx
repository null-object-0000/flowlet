import { useAppPreferences } from "../app/preferences/AppPreferences";
import { formatTime } from "../shared/formatters/datetime";
import styles from "./MobileLastRefreshTime.module.css";

/** 移动端页面和弹窗共用的紧凑刷新时间，只展示最近一次成功结果。 */
export function MobileLastRefreshTime({ value }: { value: string | null }) {
  const { language, t } = useAppPreferences();
  return (
    <time className={styles.time} dateTime={value ?? undefined}>
      {value
        ? t("最后刷新：{time}", { time: formatTime(value, language) })
        : t("尚未成功刷新")}
    </time>
  );
}
