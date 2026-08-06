import type { BackgroundJobRow } from "../../domains/background-task/types";

export function formatJobDuration(
  job: BackgroundJobRow,
  now: number,
  language: "zh-CN" | "en-US",
) {
  const summaryDuration = parseSummaryDuration(job.summaryJson);
  if (job.status !== "running" && summaryDuration != null) {
    return formatElapsed(summaryDuration, language);
  }
  const startedAt = parseDateMillis(job.startedAt);
  if (startedAt == null) return "—";
  const endedAt = job.status === "running"
    ? now
    : parseDateMillis(job.finishedAt) ?? parseDateMillis(job.updatedAt);
  return endedAt == null
    ? "—"
    : formatElapsed(Math.max(0, endedAt - startedAt), language);
}

function parseSummaryDuration(value: string | null) {
  if (!value) return null;
  try {
    const duration = (JSON.parse(value) as { durationMs?: unknown }).durationMs;
    return typeof duration === "number" && Number.isFinite(duration) ? duration : null;
  } catch {
    return null;
  }
}

export function formatElapsed(milliseconds: number, language: "zh-CN" | "en-US") {
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  const seconds = milliseconds / 1000;
  if (seconds < 60) {
    return `${new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(seconds)} s`;
  }
  const minutes = seconds / 60;
  if (minutes < 60) {
    return `${new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(minutes)} min`;
  }
  return `${new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(minutes / 60)} h`;
}

/** 看板卡片实时耗时（等待 / 执行）的具体到秒呈现：`8m 36s`、`24s`。
 *  用于待处理等待时长与进行中执行时长等持续增长的计时；已定耗时仍用 formatElapsed。 */
export function formatElapsedSeconds(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${totalSeconds}s`;
}

function parseDateMillis(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  const milliseconds = date.getTime();
  return Number.isNaN(milliseconds) ? null : milliseconds;
}
