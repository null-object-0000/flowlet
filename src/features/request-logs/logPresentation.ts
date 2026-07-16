import type { RequestLogRow } from "../../domains/request-log/types";
import { translate, type AppLanguage } from "../../app/preferences/translations";

const SENSITIVE_KEY = /^(authorization|proxy-authorization|x-api-key|api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?token|cookie|set-cookie|password|secret)$/i;

export function isSuccessfulLog(row: Pick<RequestLogRow, "status" | "error_message">) {
  return row.status != null && row.status >= 200 && row.status < 400 && !row.error_message;
}

export function formatLogTime(value?: string | null, locale = "zh-CN") {
  if (!value) return "-";
  const iso = value.includes("T") || value.endsWith("Z") ? value : `${value.replace(" ", "T")}Z`;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(locale, {
    hour12: false,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function formatDuration(value?: number | null) {
  if (value == null) return "-";
  if (value < 1_000) return `${value} ms`;
  return `${(value / 1_000).toFixed(value < 10_000 ? 2 : 1)} s`;
}

export function calculateOutputTokenRate(
  row: Pick<RequestLogRow, "output_tokens" | "duration_ms" | "ttft_ms">,
) {
  if (row.output_tokens == null || row.duration_ms == null || row.ttft_ms == null) return null;
  const generationMs = row.duration_ms - row.ttft_ms;
  return generationMs > 0 ? row.output_tokens * 1_000 / generationMs : null;
}

export function calculateCacheHitRate(
  row: Pick<RequestLogRow, "input_tokens" | "input_cached_tokens">,
) {
  if (row.input_tokens == null || row.input_tokens <= 0 || row.input_cached_tokens == null) return null;
  return Math.max(0, Math.min(1, row.input_cached_tokens / row.input_tokens));
}

export function formatTokenRate(value?: number | null) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(value < 100 ? 1 : 0)} tok/s`;
}

export function formatPercentage(value?: number | null) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

export function shortRequestId(value: string) {
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

export function safeLogText(value?: string | null) {
  if (!value) return "-";
  return value
    .replace(/(bearer\s+)[^\s,;"']+/gi, "$1••••••")
    .replace(/((?:api[-_ ]?key|token|password|secret)\s*[=:]\s*)[^\s,;"']+/gi, "$1••••••");
}

export function formatCapturedJson(value?: string | null, language: AppLanguage = "zh-CN") {
  if (!value) return `— ${translate(language, "未捕获")}`;
  try {
    return JSON.stringify(redactSensitive(JSON.parse(value)), null, 2);
  } catch {
    return safeLogText(value);
  }
}

export function formatCapturedBody(value?: string | null, language: AppLanguage = "zh-CN") {
  if (!value) return `— ${translate(language, "未捕获")}`;
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    try {
      return JSON.stringify(redactSensitive(JSON.parse(decoded)), null, 2);
    } catch {
      return safeLogText(decoded);
    }
  } catch {
    return `— ${translate(language, "捕获内容无法解码")}`;
  }
}

function redactSensitive(value: unknown, key = ""): unknown {
  if (typeof value === "string") return SENSITIVE_KEY.test(key) ? "••••••" : safeLogText(value);
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, redactSensitive(childValue, childKey)]));
  }
  return value;
}
