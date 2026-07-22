import { Button, Tooltip } from "@douyinfe/semi-ui-19";
import { IconRefresh } from "@douyinfe/semi-icons";
import { formatTime } from "../formatters/datetime";
import styles from "./RefreshControl.module.css";

type Translate = (source: string, variables?: Record<string, string | number>) => string;

interface RefreshControlProps {
  autoRefresh: boolean;
  onToggleAutoRefresh: () => void;
  isFetching: boolean;
  lastUpdatedAt: number | undefined;
  intervalMs: number;
  onRefresh: () => void;
  language: "zh-CN" | "en-US";
  t: Translate;
}

/**
 * Shared refresh toolbar control used by the request-log, agent-session,
 * task-log and usage-cost pages. Renders, in a single row:
 *   1. An auto-refresh toggle pill (green/grey dot + status label).
 *   2. A manual refresh button (loading spinner while a refetch is in flight).
 *   3. Timing info: "上次 {time}" always, plus " · 下次 {time}" while
 *      auto-refresh is on.
 *
 * Purely presentational — all state is owned by the page via useRefreshControl
 * and the TanStack Query result.
 */
export function RefreshControl({
  autoRefresh,
  onToggleAutoRefresh,
  isFetching,
  lastUpdatedAt,
  intervalMs,
  onRefresh,
  language,
  t,
}: RefreshControlProps) {
  const lastLabel = lastUpdatedAt
    ? formatTime(new Date(lastUpdatedAt).toISOString(), language)
    : "—";
  const nextTimestamp = autoRefresh && lastUpdatedAt ? lastUpdatedAt + intervalMs : undefined;
  const nextLabel = nextTimestamp
    ? formatTime(new Date(nextTimestamp).toISOString(), language)
    : undefined;

  return (
    <div className={styles.cluster}>
      <button
        type="button"
        className={`${styles.toggle} ${autoRefresh ? styles.live : ""}`}
        onClick={onToggleAutoRefresh}
        aria-pressed={autoRefresh}
        aria-label={t(autoRefresh ? "实时更新中" : "实时更新已暂停")}
      >
        <i />
        {t(autoRefresh ? "实时更新中" : "实时更新已暂停")}
      </button>
      <Tooltip content={t("刷新数据")}>
        <Button
          aria-label={t("刷新数据")}
          icon={<IconRefresh />}
          type="tertiary"
          theme="borderless"
          loading={isFetching}
          onClick={onRefresh}
        />
      </Tooltip>
      <span className={styles.timing} aria-live="polite">
        {t("上次 {time}", { time: lastLabel })}
        {nextLabel ? ` · ${t("下次 {time}", { time: nextLabel })}` : ""}
      </span>
    </div>
  );
}
