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

function formatElapsed(milliseconds: number, language: "zh-CN" | "en-US") {
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

function parseDateMillis(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  const milliseconds = date.getTime();
  return Number.isNaN(milliseconds) ? null : milliseconds;
}
