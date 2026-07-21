export type TimestampLanguage = "zh-CN" | "en-US";

/**
 * Parse a backend timestamp into a Date.
 * ISO 8601 strings pass through unchanged; legacy SQLite values shaped like
 * "YYYY-MM-DD HH:MM:SS" are treated as UTC and normalized. Returns null when
 * the value cannot be parsed.
 */
export function parseTimestamp(value: string): Date | null {
  const iso = value.includes("T") || value.endsWith("Z") ? value : `${value.replace(" ", "T")}Z`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Unified short timestamp for list and table cells: month/day plus 24-hour
 * time down to seconds, no year (e.g. "07/21 14:05:09" in zh-CN). Shared by
 * the request log, agent session and task log list views. Unparseable values
 * pass through unchanged.
 */
export function formatTimestamp(value: string, language: TimestampLanguage): string {
  const date = parseTimestamp(value);
  if (!date) return value;
  return date.toLocaleString(language, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}
