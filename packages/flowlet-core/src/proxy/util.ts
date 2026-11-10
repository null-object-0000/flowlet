// Shared primitives for the model proxy. Owner: node-proxy.
//
// Kept free of Node-only imports so the pure routing/usage logic stays easy to
// unit-test. Behaviour mirrors `src-tauri/src/core/**`.

export type JsonRow = Record<string, any>;
export type Protocol = "openai" | "anthropic" | "responses";

export const PROTOCOL_OPENAI: Protocol = "openai";
export const PROTOCOL_ANTHROPIC: Protocol = "anthropic";
export const PROTOCOL_RESPONSES: Protocol = "responses";

export function isRecord(value: unknown): value is JsonRow {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asArray<T = JsonRow>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function nullableStr(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Parse a UTF-8 JSON body; returns null for invalid JSON (Rust `serde_json`). */
export function parseJson(body: Buffer | string | null | undefined): unknown {
  if (body === null || body === undefined) return null;
  try {
    const text = typeof body === "string" ? body : body.toString("utf8");
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/**
 * serde_json 默认使用 BTreeMap，序列化时对象键按字典序输出。Node 的
 * `JSON.stringify` 保留插入顺序，因此回写被改写的请求体（model 改写、受控补字段）
 * 时需要显式递归排序，才能贴近 Rust 的字节输出。
 */
export function stringifySorted(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (isRecord(value)) {
    const out: JsonRow = {};
    for (const key of Object.keys(value).sort()) out[key] = sortValue(value[key]);
    return out;
  }
  return value;
}

export function nowMs(): number {
  return Date.now();
}

/** 与 Rust `Instant::elapsed().as_millis() as i64` 对齐的整数毫秒。 */
export function elapsedMs(startedAtMs: number): number {
  return Date.now() - startedAtMs;
}

export function secondsToMs(seconds: number | undefined, fallbackSeconds: number): number {
  const value = seconds === undefined || seconds === null || seconds <= 0 ? fallbackSeconds : seconds;
  return value * 1000;
}

export function randomId(): string {
  return crypto.randomUUID();
}

/** Token bucket，等价 `core/rate_limiter.rs`（容量 rpm，按整秒补充）。 */
export class RateLimiter {
  #buckets = new Map<string, { tokens: number; lastRefillMs: number }>();
  #maxTokens: number;
  #refillPerSecond: number;

  constructor(requestsPerMinute: number) {
    this.#maxTokens = requestsPerMinute;
    this.#refillPerSecond = Math.floor(requestsPerMinute / 60);
  }

  tryConsume(clientId: string): boolean {
    const now = Date.now();
    let bucket = this.#buckets.get(clientId);
    if (!bucket) {
      bucket = { tokens: this.#maxTokens, lastRefillMs: now };
      this.#buckets.set(clientId, bucket);
    }
    const elapsedSeconds = Math.floor((now - bucket.lastRefillMs) / 1000);
    const refill = Math.min(elapsedSeconds * this.#refillPerSecond, this.#maxTokens);
    bucket.tokens = Math.min(bucket.tokens + refill, this.#maxTokens);
    bucket.lastRefillMs = now;
    if (bucket.tokens > 0) {
      bucket.tokens -= 1;
      return true;
    }
    return false;
  }

  retryAfter(clientId: string): number {
    const bucket = this.#buckets.get(clientId);
    if (bucket && bucket.tokens === 0) {
      const rate = Math.max(this.#refillPerSecond, 1);
      return Math.ceil(1 / rate);
    }
    return 0;
  }
}

/** 解析 RFC3339 / 纯数字时间戳为 Unix 秒（Rust `parse_unix_seconds`）。 */
export function parseUnixSeconds(raw: string): number {
  if (!raw) return 0;
  const asNumber = Number.parseInt(raw, 10);
  if (!Number.isNaN(asNumber) && String(asNumber) === raw) return asNumber;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? 0 : Math.floor(parsed / 1000);
}
