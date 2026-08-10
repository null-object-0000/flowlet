import { useEffect, useRef, useState } from "react";
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

/** 自动轮询时 `isFetching` 持续超过该时长才进入 loading，避免高频刷新时图标闪烁。 */
const LOADING_DELAY_MS = 500;
/** 手动点击刷新后 loading 至少保留的时长，保证点击有明确的视觉反馈。 */
const MANUAL_FEEDBACK_MS = 600;

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
 *
 * 刷新 icon 的 loading 态做了防闪烁处理：自动轮询的 refetch 通常只需几十毫秒，
 * 若直接跟随 `isFetching`，一秒一刷的页面会让图标每轮都闪进 loading 状态。
 * 因此只有 `isFetching` 持续超过 `LOADING_DELAY_MS`（真正的慢查询）才显示 loading；
 * 手动点击则立即显示并至少保留 `MANUAL_FEEDBACK_MS`，保证用户操作有反馈。
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
  // `isFetching` 持续超过阈值才置 true，短促的轮询刷新不触发 loading。
  const [delayedFetching, setDelayedFetching] = useState(false);
  // 手动点击刷新后至少旋转 MANUAL_FEEDBACK_MS，保证点击反馈可见。
  const [manualFeedback, setManualFeedback] = useState(false);
  const debounceRef = useRef<number | null>(null);
  const feedbackRef = useRef<number | null>(null);

  useEffect(() => {
    if (isFetching) {
      debounceRef.current = window.setTimeout(() => setDelayedFetching(true), LOADING_DELAY_MS);
    } else {
      if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
      setDelayedFetching(false);
    }
    return () => {
      if (debounceRef.current != null) window.clearTimeout(debounceRef.current);
    };
  }, [isFetching]);

  useEffect(() => () => {
    if (feedbackRef.current != null) window.clearTimeout(feedbackRef.current);
  }, []);

  const handleRefresh = () => {
    setManualFeedback(true);
    if (feedbackRef.current != null) window.clearTimeout(feedbackRef.current);
    feedbackRef.current = window.setTimeout(() => setManualFeedback(false), MANUAL_FEEDBACK_MS);
    onRefresh();
  };

  const loading = delayedFetching || manualFeedback;
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
          loading={loading}
          onClick={handleRefresh}
        />
      </Tooltip>
      <span className={styles.timing} aria-live="polite">
        {t("上次 {time}", { time: lastLabel })}
        {nextLabel ? ` · ${t("下次 {time}", { time: nextLabel })}` : ""}
      </span>
    </div>
  );
}
