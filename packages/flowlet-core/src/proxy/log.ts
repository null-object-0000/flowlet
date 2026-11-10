// Request-log / usage persistence plumbing for the proxy.
//
// 与 Rust 一致的关键语义：
// - 日志落库失败不得影响主链路（全部 try/catch + warn）；
// - 唯一例外是流式首条日志：await 后再开始向客户端写响应；
// - `request_logs` 的 body 列在 Rust 里恒为 NULL（body 只进 .flcap）。Node MVP 尚未实现
//   .flcap，因此这里把捕获到的 body 作为可选字段交给 storage，由 storage 决定落库方式。
import { existsSync, readFileSync } from "node:fs";
import { prepareCapturedResBody, redactedHeaderKeys, sanitizeHeaders, truncateUtf8, type HeaderMapLike } from "./http.ts";
import { isRecord, type JsonRow } from "./util.ts";

export interface LogCaptureConfig {
  capture_req_headers: boolean;
  capture_req_body: boolean;
  capture_res_headers: boolean;
  capture_res_body: boolean;
  max_body_bytes: number;
  redact_sensitive_headers: boolean;
  body_retention_days: number;
  body_max_size_mb: number;
  body_prune_ratio: number;
}

/** storage 侧供 proxy 使用的方法子集（结构类型，便于测试注入 fake）。 */
export interface ProxyStorage {
  getAppMeta?(key: string): string | null;
  setAppMeta?(key: string, value: string): void;
  listChannelModels?(): JsonRow[];
  insertRequestLog?(row: JsonRow): void;
  insertUsageRecord?(row: JsonRow): void;
  /** 会话标题/项目路径的观测元数据 upsert（docs/agent-session-metadata.md §2）。 */
  upsertAgentSessionMetadata?(row: JsonRow): void;
  updateRequestLogTiming?(requestId: string, patch: JsonRow): void;
  upsertUsageRecordWithMetadata?(row: JsonRow, usageStatus: string, usageSource: string): void;
  updateAccountLastError?(accountId: string, message: string): void;
  markAccountCredentialInvalid?(accountId: string): void;
  markAccountCredentialHealthy?(accountId: string): void;
  updateAccountLastUsed?(accountId: string): void;
}

export function defaultCaptureConfig(): LogCaptureConfig {
  return {
    capture_req_headers: true,
    capture_req_body: true,
    capture_res_headers: true,
    capture_res_body: true,
    max_body_bytes: 1024 * 1024,
    redact_sensitive_headers: false,
    body_retention_days: 3,
    body_max_size_mb: 512,
    body_prune_ratio: 0.1,
  };
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function intOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

export function parseCaptureConfig(value: unknown): LogCaptureConfig {
  const defaults = defaultCaptureConfig();
  if (!isRecord(value)) return defaults;
  return {
    capture_req_headers: boolOr(value.capture_req_headers, defaults.capture_req_headers),
    capture_req_body: boolOr(value.capture_req_body, defaults.capture_req_body),
    capture_res_headers: boolOr(value.capture_res_headers, defaults.capture_res_headers),
    capture_res_body: boolOr(value.capture_res_body, defaults.capture_res_body),
    max_body_bytes: intOr(value.max_body_bytes, defaults.max_body_bytes),
    redact_sensitive_headers: boolOr(
      value.redact_sensitive_headers,
      defaults.redact_sensitive_headers,
    ),
    body_retention_days: intOr(value.body_retention_days, defaults.body_retention_days),
    body_max_size_mb: intOr(value.body_max_size_mb, defaults.body_max_size_mb),
    body_prune_ratio:
      typeof value.body_prune_ratio === "number" && Number.isFinite(value.body_prune_ratio)
        ? value.body_prune_ratio
        : defaults.body_prune_ratio,
  };
}

/**
 * 每请求读取一次捕获配置：SQLite app_meta 优先（设置页保存后下一次请求生效），
 * 其次 config.json 的 log_capture，最后内置默认。
 */
export function readCaptureConfig(
  storage: ProxyStorage,
  configPath: string | undefined,
): LogCaptureConfig {
  try {
    const stored = storage.getAppMeta?.("log_capture_config") ?? null;
    if (stored !== null && stored !== "") {
      return parseCaptureConfig(JSON.parse(stored) as unknown);
    }
  } catch {
    /* 损坏的 app_meta 回退默认值 */
  }
  if (configPath !== undefined && existsSync(configPath)) {
    try {
      const parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
      if (isRecord(parsed)) return parseCaptureConfig(parsed.log_capture);
    } catch {
      /* config.json 损坏时回退默认值 */
    }
  }
  return defaultCaptureConfig();
}

function redactKeys(capture: LogCaptureConfig): string[] {
  return redactedHeaderKeys(capture.redact_sensitive_headers);
}

export function captureHeaders(
  headers: HeaderMapLike,
  capture: LogCaptureConfig,
  request: boolean,
): string | null {
  const enabled = request ? capture.capture_req_headers : capture.capture_res_headers;
  if (!enabled) return null;
  return JSON.stringify(sanitizeHeaders(headers, redactKeys(capture)));
}

export function captureBody(
  body: Buffer,
  capture: LogCaptureConfig,
  request: boolean,
): string | null {
  const enabled = request ? capture.capture_req_body : capture.capture_res_body;
  if (!enabled || body.length === 0) return null;
  return truncateUtf8(body, capture.max_body_bytes).toString("base64");
}

export function captureResponseBody(
  body: Buffer,
  contentEncoding: string | null,
  capture: LogCaptureConfig,
): string | null {
  if (!capture.capture_res_body) return null;
  return prepareCapturedResBody(body, contentEncoding, capture.max_body_bytes);
}

export function recordRequestLog(storage: ProxyStorage, row: JsonRow): void {
  try {
    storage.insertRequestLog?.(row);
  } catch (error) {
    warn("写入请求日志失败", error);
  }
}

/**
 * 写入会话元数据（标题 / 项目路径）。
 *
 * 与请求日志一样属于旁路观测：派生值只是近似值，写失败不得影响模型转发，
 * 因此这里吞掉异常只记 warn。
 */
export function recordAgentSessionMetadata(storage: ProxyStorage, row: JsonRow): void {
  try {
    storage.upsertAgentSessionMetadata?.(row);
  } catch (error) {
    warn("写入会话元数据失败", error);
  }
}

/** 流式首条日志：await 完成后再开始写响应（Rust `record_request_log_and_wait`）。 */
export async function recordRequestLogAndWait(storage: ProxyStorage, row: JsonRow): Promise<void> {
  try {
    storage.insertRequestLog?.(row);
  } catch (error) {
    warn("写入请求日志失败", error);
  }
  // 同步方法：让出一次事件循环，保持与 Rust await 相同的"先落库再转发"顺序语义。
  await Promise.resolve();
}

export function updateStreamLog(
  storage: ProxyStorage,
  requestId: string,
  patch: JsonRow,
): void {
  try {
    if (typeof storage.updateRequestLogTiming === "function") {
      storage.updateRequestLogTiming(requestId, patch);
    }
  } catch (error) {
    warn("补写流式请求日志失败", error);
  }
}

export function recordUsage(
  storage: ProxyStorage,
  row: JsonRow,
  usageStatus: string,
  usageSource: string,
): void {
  try {
    if (typeof storage.upsertUsageRecordWithMetadata === "function") {
      storage.upsertUsageRecordWithMetadata(row, usageStatus, usageSource);
    } else {
      storage.insertUsageRecord?.({ ...row, usage_status: usageStatus, usage_source: usageSource });
    }
  } catch (error) {
    warn("写入 usage 记录失败", error);
  }
}

export function markAccountInvalid(
  storage: ProxyStorage,
  accountId: string,
  message: string,
): void {
  try {
    storage.updateAccountLastError?.(accountId, message);
    storage.markAccountCredentialInvalid?.(accountId);
  } catch (error) {
    warn("更新账号凭证状态失败", error);
  }
}

export function markAccountRecovered(storage: ProxyStorage, accountId: string): void {
  try {
    storage.markAccountCredentialHealthy?.(accountId);
    storage.updateAccountLastUsed?.(accountId);
  } catch (error) {
    warn("更新账号凭证状态失败", error);
  }
}

export function warn(message: string, error?: unknown): void {
  const detail = error instanceof Error ? error.message : error === undefined ? "" : String(error);
  console.warn(detail === "" ? `[proxy] ${message}` : `[proxy] ${message}: ${detail}`);
}

export type { JsonRow };
