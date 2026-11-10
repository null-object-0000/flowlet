// Usage extraction for buffered and streaming upstream responses.
// 逐段对照 `src-tauri/src/core/usage.rs`（不含测试）。
import { isRecord, parseJson, type JsonRow } from "./util.ts";

export interface ResponseUsage {
  input_tokens: number | null;
  input_cached_tokens: number | null;
  input_uncached_tokens: number | null;
  input_cache_write_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
}

export interface StreamUsageResult {
  usage: ResponseUsage | null;
  /** 终止标记或正数 output usage 等可认定 usage 完整的上游证据。 */
  has_completion_evidence: boolean;
}

const MAX_STREAM_USAGE_LINE_BYTES = 8 * 1024 * 1024;

function intValue(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function record(value: unknown): JsonRow | null {
  return isRecord(value) ? value : null;
}

/**
 * Incrementally extracts usage from an SSE stream without retaining the whole
 * response. Memory is bounded by one SSE line.
 */
export class StreamUsageAccumulator {
  #pendingLine: Buffer[] = [];
  #pendingLength = 0;
  #discardingOversizedLine = false;
  #usage: ResponseUsage | null = null;
  #sawTerminalMarker = false;
  #sawPositiveOutputUsage = false;

  push(chunk: Buffer): void {
    let remaining = chunk;
    for (;;) {
      const newline = remaining.indexOf(0x0a);
      if (newline < 0) break;
      this.#pushLineFragment(remaining.subarray(0, newline));
      this.#finishLine();
      remaining = remaining.subarray(newline + 1);
    }
    this.#pushLineFragment(remaining);
  }

  finishWithEvidence(): StreamUsageResult {
    if (this.#pendingLength > 0 || this.#discardingOversizedLine) this.#finishLine();
    return {
      usage: this.#usage,
      has_completion_evidence: this.#sawTerminalMarker || this.#sawPositiveOutputUsage,
    };
  }

  #pushLineFragment(fragment: Buffer): void {
    if (this.#discardingOversizedLine) return;
    if (this.#pendingLength + fragment.length > MAX_STREAM_USAGE_LINE_BYTES) {
      this.#pendingLine = [];
      this.#pendingLength = 0;
      this.#discardingOversizedLine = true;
      return;
    }
    this.#pendingLine.push(Buffer.from(fragment));
    this.#pendingLength += fragment.length;
  }

  #finishLine(): void {
    if (this.#discardingOversizedLine) {
      this.#discardingOversizedLine = false;
      this.#pendingLine = [];
      this.#pendingLength = 0;
      return;
    }
    const line = Buffer.concat(this.#pendingLine).toString("utf8").trim();
    this.#pendingLine = [];
    this.#pendingLength = 0;
    if (!line.startsWith("data:")) return;
    const data = line.slice("data:".length).trim();
    if (data === "[DONE]") {
      this.#sawTerminalMarker = true;
      return;
    }
    if (data === "") return;
    const value = parseJson(data);
    if (!isRecord(value)) return;
    if (value.type === "message_stop") this.#sawTerminalMarker = true;
    if (data.includes('"usage"')) {
      const usage = extractUsageFromValue(value);
      if (usage !== null) {
        if ((usage.output_tokens ?? 0) > 0) this.#sawPositiveOutputUsage = true;
        this.#usage = this.#usage === null ? usage : mergeUsage(this.#usage, usage);
      }
    }
  }
}

export function extractResponseUsage(body: Buffer): ResponseUsage | null {
  const value = parseJson(body);
  return isRecord(value) ? extractUsageFromValue(value) : null;
}

/**
 * Parse a completed OpenAI/Anthropic SSE body. `requireDoneMarker=true` keeps a
 * truncated prefix from being mistaken for a complete capture.
 */
export function extractSseResponseUsage(
  body: Buffer,
  requireDoneMarker: boolean,
): ResponseUsage | null {
  const text = body.toString("utf8");
  let sawDone = false;
  let latest: ResponseUsage | null = null;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const data = line.slice("data:".length).trim();
    if (data === "[DONE]") {
      sawDone = true;
      continue;
    }
    const value = parseJson(data);
    if (!isRecord(value)) continue;
    if (value.type === "message_stop") sawDone = true;
    const usage = extractUsageFromValue(value);
    if (usage !== null) latest = latest === null ? usage : mergeUsage(latest, usage);
  }
  if (requireDoneMarker) return sawDone ? latest : null;
  return latest;
}

/** 兼容标准 SSE 与「text/event-stream 但实际是单条 JSON」的上游。 */
export function extractStreamUsage(body: Buffer): ResponseUsage | null {
  return extractSseResponseUsage(body, false) ?? extractResponseUsage(body);
}

/** 已完成 SSE 行是否包含真实输出（metadata 事件不计入 TTFT）。 */
export function containsSseOutputToken(body: Buffer): boolean {
  const text = body.toString("utf8");
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const data = line.slice("data:".length).trim();
    if (data === "" || data === "[DONE]") continue;
    const value = parseJson(data);
    if (isRecord(value) && valueContainsOutputToken(value)) return true;
  }
  return false;
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value !== "";
}

function valueContainsOutputToken(value: JsonRow): boolean {
  if (
    nonEmptyString(value.delta) ||
    nonEmptyString(value.completion) ||
    nonEmptyString(value.delta?.text) ||
    nonEmptyString(value.delta?.thinking) ||
    nonEmptyString(value.content_block?.text) ||
    nonEmptyString(value.content_block?.thinking)
  ) {
    return true;
  }
  if (Array.isArray(value.choices)) {
    return value.choices.some(
      (choice: unknown) =>
        isRecord(choice) &&
        (nonEmptyString(choice.text) ||
          nonEmptyString(choice.delta?.content) ||
          nonEmptyString(choice.delta?.reasoning_content) ||
          nonEmptyString(choice.delta?.text)),
    );
  }
  return false;
}

function extractUsageFromValue(value: unknown): ResponseUsage | null {
  if (!isRecord(value)) return null;
  const usage = isRecord(value.usage)
    ? value.usage
    : isRecord(value.message) && isRecord(value.message.usage)
      ? value.message.usage
      : isRecord(value.response) && isRecord(value.response.usage)
        ? value.response.usage
        : null;
  if (usage === null) return null;

  const rawInput = intValue(usage.prompt_tokens) ?? intValue(usage.input_tokens);
  // Anthropic 形状的未缓存基值：input_tokens 优先（漏出的 prompt_tokens 会重复计缓存读）。
  const anthropicRawInput = intValue(usage.input_tokens) ?? intValue(usage.prompt_tokens);
  const output = intValue(usage.completion_tokens) ?? intValue(usage.output_tokens);
  const cacheRead = intValue(usage.cache_read_input_tokens);
  const cacheCreation = intValue(usage.cache_creation_input_tokens);
  const hasAnthropicCacheFields =
    usage.cache_read_input_tokens !== undefined || usage.cache_creation_input_tokens !== undefined;

  let input: number | null;
  let cached: number | null;
  let uncached: number | null;
  let cacheWrite: number | null;

  if (hasAnthropicCacheFields) {
    cacheWrite = cacheCreation;
    uncached =
      anthropicRawInput !== null && cacheCreation !== null
        ? anthropicRawInput + cacheCreation
        : anthropicRawInput !== null
          ? anthropicRawInput
          : cacheCreation;
    input =
      uncached !== null && cacheRead !== null
        ? uncached + cacheRead
        : uncached !== null
          ? uncached
          : cacheRead;
    cached = cacheRead;
  } else {
    cached =
      intValue(usage.effectiveCachedTokens) ??
      intValue(usage.prompt_tokens_details?.cached_tokens) ??
      intValue(usage.input_tokens_details?.cached_tokens) ??
      intValue(usage.cache_read_tokens) ??
      intValue(usage.cached_tokens);
    input = rawInput;
    uncached = rawInput !== null && cached !== null ? Math.max(rawInput - cached, 0) : null;
    cacheWrite = null;
  }

  const total =
    intValue(usage.total_tokens) ??
    (input !== null && output !== null ? input + output : null);

  if (input === null && output === null && total === null) return null;

  return {
    input_tokens: input,
    input_cached_tokens: cached,
    input_uncached_tokens: uncached,
    input_cache_write_tokens: cacheWrite,
    output_tokens: output,
    total_tokens: total,
  };
}

function mergeUsage(current: ResponseUsage, next: ResponseUsage): ResponseUsage {
  const input = next.input_tokens ?? current.input_tokens;
  const cached = next.input_cached_tokens ?? current.input_cached_tokens;
  const uncached = next.input_uncached_tokens ?? current.input_uncached_tokens;
  const cacheWrite = next.input_cache_write_tokens ?? current.input_cache_write_tokens;
  const output = next.output_tokens ?? current.output_tokens;
  const total =
    input !== null && output !== null ? input + output : next.total_tokens ?? current.total_tokens;
  return {
    input_tokens: input,
    input_cached_tokens: cached,
    input_uncached_tokens: uncached,
    input_cache_write_tokens: cacheWrite,
    output_tokens: output,
    total_tokens: total,
  };
}