// HTTP surface helpers: CORS, path detection, upstream URL building, header
// rewriting, model-field rewriting and capture encoding.
//
// 逐段对照 `src-tauri/src/core/proxy_http.rs`。
import zlib from "node:zlib";
import {
  asArray,
  isRecord,
  parseJson,
  stringifySorted,
  type JsonRow,
  type Protocol,
} from "./util.ts";

export type HeaderValue = string | string[];
export type HeaderMapLike = Record<string, HeaderValue | undefined>;

export type AuthStrategy = "bearer" | "x_api_key";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export function isHopByHop(name: string): boolean {
  return HOP_BY_HOP.has(name.toLowerCase());
}

export function getHeader(headers: HeaderMapLike, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== target || value === undefined) continue;
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

export function getAllHeader(headers: HeaderMapLike, name: string): string[] {
  const target = name.toLowerCase();
  const out: string[] = [];
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== target || value === undefined) continue;
    if (Array.isArray(value)) out.push(...value);
    else out.push(value);
  }
  return out;
}

export function hasHeader(headers: HeaderMapLike, name: string): boolean {
  const target = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === target);
}

// ─── CORS ───────────────────────────────────────────────────────────────────

export const CORS_DEFAULT_ALLOW_HEADERS =
  "authorization,content-type,x-api-key,anthropic-version,anthropic-beta";

export function addCorsHeaders(headers: HeaderMapLike, requestedHeaders?: string): void {
  headers["access-control-allow-origin"] = "*";
  headers["access-control-allow-methods"] = "GET,POST,PUT,PATCH,DELETE,OPTIONS";
  headers["access-control-allow-headers"] = requestedHeaders || CORS_DEFAULT_ALLOW_HEADERS;
  headers["access-control-expose-headers"] = "content-type,x-request-id";
  headers["access-control-max-age"] = "86400";
}

export function corsHeaders(requestedHeaders?: string): Record<string, string> {
  const headers: HeaderMapLike = {};
  addCorsHeaders(headers, requestedHeaders);
  return headers as Record<string, string>;
}

// ─── Path detection ─────────────────────────────────────────────────────────

export function pathWithoutQuery(rawUrl: string): string {
  const index = rawUrl.indexOf("?");
  return index >= 0 ? rawUrl.slice(0, index) : rawUrl;
}

/** `ProtocolType::from_path` 粗分类（入站 handler 选择）。 */
export function protocolFromPath(path: string): Protocol | null {
  const p = path.replace(/^\/+/, "");
  if (p.startsWith("anthropic/")) return "anthropic";
  if (p.startsWith("v1/") || p.startsWith("openai/") || p === "v1" || p === "openai") {
    return "openai";
  }
  return null;
}

/** `ProtocolType::is_responses_path`（三种入口前缀）。 */
export function isResponsesPath(rawUrl: string): boolean {
  const p = pathWithoutQuery(rawUrl).replace(/^\/+/, "");
  return (
    p === "v1/responses" ||
    p === "openai/v1/responses" ||
    p === "responses" ||
    p.startsWith("v1/responses/") ||
    p.startsWith("openai/v1/responses/") ||
    p.startsWith("responses/")
  );
}

export function isModelListRequest(method: string, rawUrl: string): boolean {
  if (method.toUpperCase() !== "GET") return false;
  const path = pathWithoutQuery(rawUrl);
  return path === "/v1/models" || path === "/openai/v1/models" || path === "/anthropic/v1/models";
}

export function modelDetailRequestId(method: string, rawUrl: string): string | null {
  if (method.toUpperCase() !== "GET") return null;
  const path = pathWithoutQuery(rawUrl);
  let id: string | undefined;
  if (path.startsWith("/v1/models/")) id = path.slice("/v1/models/".length);
  else if (path.startsWith("/openai/v1/models/")) id = path.slice("/openai/v1/models/".length);
  if (id === undefined || id === "" || id.includes("/")) return null;
  return id;
}

export type FilesApiOp =
  | { kind: "upload" }
  | { kind: "list" }
  | { kind: "retrieve"; id: string }
  | { kind: "delete"; id: string };

/** 只认 Anthropic 入口的四个 Files API 操作（`proxy_http.rs::files_api_request`）。 */
export function filesApiRequest(method: string, rawPath: string): FilesApiOp | null {
  const path = pathWithoutQuery(rawPath);
  const withoutAnthropic = path.startsWith("/anthropic") ? path.slice("/anthropic".length) : null;
  if (withoutAnthropic === null || !withoutAnthropic.startsWith("/v1/files")) return null;
  const tail = withoutAnthropic.slice("/v1/files".length);
  const upper = method.toUpperCase();
  const fileId = (value: string): string | null => {
    if (!value.startsWith("/")) return null;
    const id = value.slice(1);
    return id !== "" && !id.includes("/") ? id : null;
  };
  if (upper === "POST" && tail === "") return { kind: "upload" };
  if (upper === "GET" && tail === "") return { kind: "list" };
  if (upper === "GET") {
    const id = fileId(tail);
    return id === null ? null : { kind: "retrieve", id };
  }
  if (upper === "DELETE") {
    const id = fileId(tail);
    return id === null ? null : { kind: "delete", id };
  }
  return null;
}

/** `/messages` 是否引用 Files API 资源（`anthropic-beta: files-api-*`）。 */
export function requestReferencesFilesApi(headers: HeaderMapLike): boolean {
  return getAllHeader(headers, "anthropic-beta").some((value) =>
    value.split(",").some((token) => token.trim().startsWith("files-api-")),
  );
}

// ─── Upstream URL building ──────────────────────────────────────────────────

function trimPrefixAll(path: string, prefix: string): string {
  let result = path;
  while (result.startsWith(prefix)) result = result.slice(prefix.length);
  return result;
}

/** base_url 自带 /v1 时去掉重复（dashscope / moonshot / token plan 等）。 */
function stripDuplicateV1(base: string, path: string): string {
  if (path.startsWith("/v1/") || path === "/v1") {
    return base.endsWith("/v1") ? base.slice(0, -"/v1".length) : base;
  }
  return base;
}

export function buildUpstreamUrl(baseUrl: string, rawUrl: string, protocol: Protocol): string {
  const base = baseUrl.replace(/\/+$/, "");
  const path = rawUrl === "" ? "/" : rawUrl;
  if (protocol === "openai" || protocol === "responses") {
    // 保留 /v1 与 /openai/v1 前缀：base_url 已包含 /openai 或 /v1 的入口前缀。
    const stripped = trimPrefixAll(path, "/openai");
    return stripDuplicateV1(base, stripped) + stripped;
  }
  const stripped = trimPrefixAll(path, "/anthropic");
  return stripDuplicateV1(base, stripped) + stripped;
}

/** 智谱 OpenAI 兼容端点无 `/v1`（`proxy_http.rs::build_upstream_url_without_openai_v1`）。 */
export function buildUpstreamUrlWithoutOpenAiV1(baseUrl: string, rawUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const path = rawUrl === "" ? "/" : rawUrl;
  let stripped = trimPrefixAll(path, "/openai");
  stripped = trimPrefixAll(stripped, "/v1");
  return base + stripped;
}

// ─── Header rewriting ───────────────────────────────────────────────────────

const CONTEXT_1M_BETA = "context-1m-2025-08-07";

function filterAnthropicBeta(value: string | string[]): string | null {
  const raw = Array.isArray(value) ? value.join(",") : value;
  const kept = raw
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token !== "" && token.toLowerCase() !== CONTEXT_1M_BETA);
  return kept.length === 0 ? null : kept.join(",");
}

/**
 * 构造最终上游请求头：剥 hop-by-hop/host/content-length/客户端凭据/Flowlet 保留头，
 * 过滤 context-1m beta，最后按渠道鉴权策略写入上游 Key。
 * 注意 `x-deepseek-harness-session-id` 必须原样透传。
 */
export function applyRequestHeaders(
  headers: HeaderMapLike,
  apiKey: string,
  authStrategy: AuthStrategy,
): Record<string, HeaderValue> {
  const out: Record<string, HeaderValue> = {};
  for (const [rawName, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const name = rawName.toLowerCase();
    if (
      isHopByHop(name) ||
      name === "host" ||
      name === "content-length" ||
      name === "authorization" ||
      name === "x-api-key" ||
      name === "x-flowlet-client" ||
      name === "x-flowlet-session"
    ) {
      continue;
    }
    if (name === "anthropic-beta") {
      const filtered = filterAnthropicBeta(value);
      if (filtered !== null) out[name] = filtered;
      continue;
    }
    out[name] = value;
  }

  const key = apiKey.trim();
  if (key !== "") {
    if (authStrategy === "x_api_key") out["x-api-key"] = key;
    else out.authorization = `Bearer ${key}`;
  }
  return out;
}

/** 响应头原样复制，仅去掉 hop-by-hop（保留多值，尤其 set-cookie）。 */
export function copyResponseHeaders(source: HeaderMapLike): Record<string, HeaderValue> {
  const out: Record<string, HeaderValue> = {};
  for (const [rawName, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const name = rawName.toLowerCase();
    if (isHopByHop(name)) continue;
    out[name] = value;
  }
  return out;
}

// ─── Client identification / sanitization ──────────────────────────────────

/** 通过 Host client token 识别调用方（精确字符串比较）。 */
export function identifyClient(
  headers: HeaderMapLike,
  defaultToken: string,
): { id: string; name: string } | null {
  const authorization = getHeader(headers, "authorization");
  if (authorization !== undefined && authorization.startsWith("Bearer ")) {
    if (authorization.slice("Bearer ".length).trim() === defaultToken) {
      return { id: "default", name: "默认客户端" };
    }
  }
  const apiKey = getHeader(headers, "x-api-key");
  if (apiKey !== undefined && apiKey.trim() === defaultToken) {
    return { id: "default", name: "默认客户端" };
  }
  return null;
}

const REDACTED_HEADERS = new Set(["authorization", "x-api-key", "cookie", "set-cookie", "x-auth-token"]);

/** HeaderMap → JSON 对象（快照时写日志；按配置脱敏）。 */
export function sanitizeHeaders(headers: HeaderMapLike, redact: string[]): JsonRow {
  const redactKeys = new Set(redact.map((key) => key.toLowerCase()));
  const map: JsonRow = {};
  for (const [rawName, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const key = rawName.toLowerCase();
    if (isHopByHop(key)) continue;
    if (redactKeys.has(key)) {
      map[key] = "[redacted]";
      continue;
    }
    map[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return map;
}

export function redactedHeaderKeys(redact: boolean): string[] {
  return redact ? [...REDACTED_HEADERS] : [];
}

// ─── Model name extraction / rewriting ─────────────────────────────────────

/** Claude Code `[1m]` 长上下文后缀防御性剥离。 */
export function stripLongContextSuffix(model: string): string {
  return model.toLowerCase().endsWith("[1m]") ? model.slice(0, -4) : model;
}

export function extractModel(body: Buffer, _protocol: Protocol): string | null {
  const value = parseJson(body);
  if (!isRecord(value)) return null;
  const model = value.model;
  if (typeof model !== "string") return null;
  return stripLongContextSuffix(model);
}

/**
 * 把请求体里的 `model` 改成上游模型名。
 * 优先文本替换（保留原始字节与键序），失败再整体重序列化（键按字典序，贴近 serde）。
 * 无法解析或没有 model 时原样返回。
 */
export function rewriteModel(body: Buffer, upstreamModel: string, _protocol: Protocol): Buffer {
  const value = parseJson(body);
  if (!isRecord(value) || typeof value.model !== "string") return body;
  const originalModel = value.model;
  value.model = upstreamModel;

  const text = body.toString("utf8");
  for (const [search, replacement] of [
    [`"model":"${originalModel}"`, `"model":"${upstreamModel}"`],
    [`"model": "${originalModel}"`, `"model": "${upstreamModel}"`],
  ]) {
    const position = text.indexOf(search);
    if (position >= 0) {
      return Buffer.from(
        text.slice(0, position) + replacement + text.slice(position + search.length),
        "utf8",
      );
    }
  }
  return Buffer.from(stringifySorted(value), "utf8");
}

/**
 * DeepSeek 推理模型要求 assistant 消息回传 `reasoning_content`。仅 OpenAI 协议 +
 * DeepSeek 推理模型；只给缺失字段的消息补空串，已有值（含 null）不动。
 */
export function ensureReasoningContentPassback(
  body: Buffer,
  upstreamModel: string,
  protocol: Protocol,
  isDeepseekReasoning: (model: string) => boolean,
): Buffer {
  if (protocol !== "openai" || !isDeepseekReasoning(upstreamModel)) return body;
  const value = parseJson(body);
  if (!isRecord(value) || !Array.isArray(value.messages)) return body;
  let changed = false;
  for (const message of asArray(value.messages)) {
    if (!isRecord(message)) continue;
    if (message.role !== "assistant") continue;
    if (Object.prototype.hasOwnProperty.call(message, "reasoning_content")) continue;
    message.reasoning_content = "";
    changed = true;
  }
  if (!changed) return body;
  return Buffer.from(stringifySorted(value), "utf8");
}

/**
 * DeepSeek Anthropic Messages 端点在 thinking 模式下要求当前用户轮内每条 assistant
 * 消息都回传 thinking 块。只追加、不改写已有块与 signature，已完成轮次不动。
 */
export function ensureAnthropicThinkingPassback(
  body: Buffer,
  upstreamModel: string,
  protocol: Protocol,
  isDeepseekReasoning: (model: string) => boolean,
): Buffer {
  if (protocol !== "anthropic" || !isDeepseekReasoning(upstreamModel)) return body;
  const value = parseJson(body);
  if (!isRecord(value) || !Array.isArray(value.messages)) return body;
  const thinking = value.thinking;
  if (!isRecord(thinking) || thinking.type !== "enabled") return body;

  const isTextUserMessage = (message: JsonRow): boolean => {
    if (message.role !== "user") return false;
    const content = message.content;
    if (typeof content === "string") return true;
    if (!Array.isArray(content)) return false;
    return asArray(content).some((block) => isRecord(block) && block.type === "text");
  };
  let turnStart = 0;
  for (let index = value.messages.length - 1; index >= 0; index -= 1) {
    if (isTextUserMessage(value.messages[index])) {
      turnStart = index + 1;
      break;
    }
  }
  let changed = false;
  for (let index = turnStart; index < value.messages.length; index += 1) {
    const message = value.messages[index];
    if (!isRecord(message) || message.role !== "assistant") continue;
    if (!Array.isArray(message.content)) continue;
    const blocks = message.content;
    if (blocks.some((block: unknown) => isRecord(block) && block.type === "thinking")) continue;
    blocks.unshift({ type: "thinking", thinking: "" });
    changed = true;
  }
  if (!changed) return body;
  return Buffer.from(stringifySorted(value), "utf8");
}

// ─── Responses 回放兼容：input[*].status 归一 ────────────────────────────────

/**
 * 部分上游返回的 Responses item（`reasoning` / `message` 等）带 `"status": null`
 *（或空串、未知取值），客户端会把这些 item 原样塞回下一轮 `input`，校验严格的
 * 上游直接 400：`The parameter `input.status` specified in the request are not valid:
 * unknown status: .`
 *
 * 这是「客户端忠实回放、上游校验口径不一致」的兼容问题；候选池跨上游时 A 家吐出的
 * item 会被回放到 B 家，所以必须在网关归一。规则：只把 `input[*].status` 的非法值改成
 * `"completed"`、清掉 `encrypted_content: null`；合法 status、`input` 为字符串、非
 * Responses 协议一律原样透传，无修改时不重序列化。逐段对照 Rust
 * `proxy_http::normalize_responses_input_items`。
 */
export function normalizeResponsesInputItems(body: Buffer, protocol: Protocol): Buffer {
  if (protocol !== "responses") return body;
  const value = parseJson(body);
  if (!isRecord(value) || !Array.isArray(value.input)) return body;

  const validStatuses = new Set(["in_progress", "completed", "incomplete"]);
  let changed = false;
  for (const item of asArray(value.input)) {
    if (!isRecord(item)) continue;
    if (Object.prototype.hasOwnProperty.call(item, "status")) {
      if (typeof item.status !== "string" || !validStatuses.has(item.status)) {
        item.status = "completed";
        changed = true;
      }
    }
    if (
      Object.prototype.hasOwnProperty.call(item, "encrypted_content") &&
      item.encrypted_content === null
    ) {
      delete item.encrypted_content;
      changed = true;
    }
  }
  if (!changed) return body;
  return Buffer.from(stringifySorted(value), "utf8");
}

// ─── Response body capture helpers ──────────────────────────────────────────

export function contentEncodingValue(headers: HeaderMapLike): string | null {
  const raw = getHeader(headers, "content-encoding");
  if (raw === undefined) return null;
  const first = raw.split(",")[0]?.trim().toLowerCase() ?? "";
  return first === "" ? null : first;
}

export function truncateUtf8(body: Buffer, max: number): Buffer {
  if (body.length <= max) return body;
  let cut = max;
  while (cut > 0 && (body[cut] & 0b1100_0000) === 0b1000_0000) cut -= 1;
  return body.subarray(0, cut);
}

/**
 * 按 content-encoding 对捕获体做一次性解压（gzip/deflate/br），上限 maxOut。
 * 无法识别或失败时回退原字节（日志可见性优先）。
 */
export function decompressForCapture(
  body: Buffer,
  contentEncoding: string | null,
  maxOut: number,
): Buffer {
  if (contentEncoding === null) return body;
  try {
    switch (contentEncoding) {
      case "gzip":
      case "x-gzip":
        return zlib.gunzipSync(body, { maxOutputLength: Math.max(1, maxOut + 1) });
      case "deflate":
        return zlib.inflateSync(body, { maxOutputLength: Math.max(1, maxOut + 1) });
      case "br":
        return zlib.brotliDecompressSync(body, { maxOutputLength: Math.max(1, maxOut + 1) });
      default:
        return body;
    }
  } catch {
    return body;
  }
}

/** 捕获响应体统一入口：解压 → UTF-8 边界截断 → base64；空体 null。 */
export function prepareCapturedResBody(
  body: Buffer,
  contentEncoding: string | null,
  maxBytes: number,
): string | null {
  if (body.length === 0) return null;
  const decompressed = decompressForCapture(body, contentEncoding, maxBytes);
  const truncated = truncateUtf8(decompressed, maxBytes);
  return truncated.toString("base64");
}

export function isStreamingResponse(headers: HeaderMapLike): boolean {
  const contentType = getHeader(headers, "content-type");
  return contentType !== undefined && contentType.includes("text/event-stream");
}

// ─── Request classification ─────────────────────────────────────────────────

export type RequestType = "chat" | "code" | "reasoning" | "long_context" | "tool_use" | "unknown";

function hasToolUseContent(json: JsonRow): boolean {
  for (const message of asArray(json.messages)) {
    if (!isRecord(message)) continue;
    if (message.tool_calls !== undefined) return true;
    for (const block of asArray(message.content)) {
      if (isRecord(block) && block.type === "tool_use") return true;
    }
  }
  return false;
}

/** `config.rs::classify_request` 的等价实现。 */
export function classifyRequest(body: Buffer, _protocol: Protocol): RequestType {
  const parsed = parseJson(body);
  if (!isRecord(parsed)) return "unknown";
  if (parsed.tools !== undefined || parsed.tool_choice !== undefined || hasToolUseContent(parsed)) {
    return "tool_use";
  }
  const messages = asArray(parsed.messages).filter(isRecord);
  const contentStrings = messages
    .map((message) => (typeof message.content === "string" ? message.content : null))
    .filter((value): value is string => value !== null);
  const totalChars = contentStrings.reduce((sum, value) => sum + value.length, 0);
  const maxSingle = contentStrings.reduce((max, value) => Math.max(max, value.length), 0);
  if (totalChars > 20_000 || maxSingle > 10_000) return "long_context";

  const allText = contentStrings.join(" ").toLowerCase();
  const codeIndicators = [
    "```", "function", "class ", "def ", "import ", "const ", "let ", "public ",
    "private ", "impl ", "fn ", "func ", "coding", "代码", "implement", "refactor",
    "debug", "compile",
  ];
  const codeHits = codeIndicators.filter((indicator) => allText.includes(indicator)).length;
  if (codeHits >= 2) return "code";

  const reasoningIndicators = [
    "analyze", "reasoning", "step by step", "complex", "difficult", "think carefully",
    "reasoning", "分析", "推理", "详细", "思考", "explain why", "compare", "evaluate",
  ];
  const reasoningHits = reasoningIndicators.filter((indicator) => allText.includes(indicator)).length;
  if (reasoningHits >= 1 && totalChars > 2000) return "reasoning";

  const system = messages.find((message) => message.role === "system");
  if (system && typeof system.content === "string") {
    const lower = system.content.toLowerCase();
    if (lower.includes("code") || lower.includes("programming") || lower.includes("代码")) {
      return "code";
    }
    if (lower.includes("reason") || lower.includes("analyze") || lower.includes("分析")) {
      return "reasoning";
    }
  }
  return "chat";
}
