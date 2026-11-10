// Model entry forwarding: routing → attempt loop → upstream → SSE/buffered.
//
// 权威实现：`src-tauri/src/core/proxy.rs::forward_request` + build_response +
// capture_timed_stream + record_*。所有日志捕获都发生在"最终上游请求"构造之后，
// 不使用客户端入站报文（AGENTS.md §9 硬指标）。
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Readable } from "node:stream";
import type { ProxyBindConfig } from "../types.ts";
import { AnthropicContentBlockRepair } from "./anthropic-compat.ts";
import type { ModelIdentityIndex } from "./catalog.ts";
import {
  addCorsHeaders,
  applyRequestHeaders,
  buildUpstreamUrl,
  buildUpstreamUrlWithoutOpenAiV1,
  classifyRequest,
  contentEncodingValue,
  copyResponseHeaders,
  decompressForCapture,
  ensureAnthropicThinkingPassback,
  ensureReasoningContentPassback,
  extractModel,
  filesApiRequest,
  getHeader,
  identifyClient,
  isModelListRequest,
  isResponsesPath,
  isStreamingResponse,
  modelDetailRequestId,
  requestReferencesFilesApi,
  rewriteModel,
  type HeaderMapLike,
  type HeaderValue,
} from "./http.ts";
import { extractAgentSession, identifyClientFromHeaders } from "./identity.ts";
import {
  captureBody,
  captureHeaders,
  captureResponseBody,
  markAccountInvalid,
  markAccountRecovered,
  readCaptureConfig,
  recordAgentSessionMetadata,
  recordRequestLog,
  recordRequestLogAndWait,
  recordUsage,
  updateStreamLog,
  type LogCaptureConfig,
  type ProxyStorage,
} from "./log.ts";
import { deriveSessionMetadata } from "./session-derive.ts";
import { asChannelModel, buildModelDetailResponse, buildModelListResponse } from "./models.ts";
import {
  ACCOUNT_CREDENTIAL_HEALTHY,
  asAccount,
  asChannel,
  asRoute,
  asRule,
  bodyContainsAccountDeactivated,
  bodyContainsProductNotActivated,
  bodyContainsQuotaExceeded,
  enrichUpstreamErrorLog,
  filesAccount,
  isTransientDeactivatedAccount,
  matchCandidates,
  requestUsesImage,
  shouldInspectFallbackBody,
  shouldTryNextStatus,
  type AccountRow,
  type ChannelRow,
  type RuleRow,
  type RouteRow,
} from "./routing.ts";
import {
  ForwardError,
  modelNetworkError,
  normalizeProxySettings,
  readBodyWithTimeout,
  type UpstreamProxySettings,
  type UpstreamResponse,
  type UpstreamTransport,
} from "./upstream.ts";
import {
  containsSseOutputToken,
  extractResponseUsage,
  extractStreamUsage,
  StreamUsageAccumulator,
  type ResponseUsage,
} from "./usage.ts";
import {
  asArray,
  elapsedMs,
  isRecord,
  randomId,
  RateLimiter,
  secondsToMs,
  type JsonRow,
  type Protocol,
} from "./util.ts";

export const DEFAULT_UPSTREAM_TIMEOUT_SECONDS = 120;
const MAX_USAGE_CAPTURE_BYTES = 1024 * 1024;
const MAX_TTFT_PROBE_BYTES = 64 * 1024;
const MAX_TERMINAL_PROBE_BYTES = 512;
const FILES_UPLOAD_LIMIT_BYTES = 128 * 1024 * 1024 + 1024 * 1024;
/** Node 模型路径沿用 Rust 的"无上限缓冲"（usize::MAX），仅给出实际保护上限。 */
const MODEL_BODY_HARD_LIMIT_BYTES = 1024 * 1024 * 1024;

export class PayloadTooLargeError extends Error {
  constructor() {
    super("payload_too_large");
    this.name = "PayloadTooLargeError";
  }
}

export interface ProxyRuntimeConfigSource {
  snapshot(): JsonRow;
  replace?(snapshot: JsonRow): void;
  update?(mutate: (draft: JsonRow) => void): void;
}

export interface ActivityTrackerLike {
  track(): () => void;
}

export interface ProxyDeps {
  storage: ProxyStorage;
  identity: ModelIdentityIndex;
  runtimeConfig: ProxyRuntimeConfigSource;
  transport: UpstreamTransport;
  /** 每次请求实时读取（bind config 的 token 变更下一次请求即生效）。 */
  bindConfig(): ProxyBindConfig;
  configPath?: string;
  upstreamTimeoutSeconds?: number;
  rateLimiter?: RateLimiter;
  rateLimitEnabled?: boolean;
  roundRobin?: Map<string, number>;
  credentialOverrides?: Map<string, { status: string; lastError: string | null }>;
  activity?: ActivityTrackerLike;
}

interface ResolvedConfig {
  channels: ChannelRow[];
  accounts: AccountRow[];
  routes: RouteRow[];
  rules: RuleRow[];
}

// ─── HTTP helpers ───────────────────────────────────────────────────────────

function writeJsonBody(
  res: ServerResponse,
  status: number,
  body: Buffer,
  extraHeaders: Record<string, HeaderValue> = {},
): void {
  const headers: Record<string, HeaderValue> = {
    ...extraHeaders,
    "content-type": "application/json",
    "content-length": String(body.length),
  };
  addCorsHeaders(headers);
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  extraHeaders: Record<string, HeaderValue> = {},
): void {
  writeJsonBody(res, status, Buffer.from(JSON.stringify(payload), "utf8"), extraHeaders);
}

function sendJsonText(res: ServerResponse, status: number, bodyText: string): void {
  writeJsonBody(res, status, Buffer.from(bodyText, "utf8"));
}

function sendText(res: ServerResponse, status: number, text: string): void {
  const body = Buffer.from(text, "utf8");
  const headers: Record<string, HeaderValue> = {};
  addCorsHeaders(headers);
  res.writeHead(status, headers);
  res.end(body);
}

/** 读取入站请求体（模型路径无上限；Files 路径 129MiB 上限）。 */
export function readIncomingBody(req: IncomingMessage, limit?: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    req.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (limit !== undefined && total > limit) {
        settled = true;
        reject(new PayloadTooLargeError());
        return;
      }
      chunks.push(buffer);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    });
    req.on("aborted", () => {
      if (settled) return;
      settled = true;
      reject(new Error("客户端在请求体读取完成前断开连接"));
    });
  });
}

export async function handleModelRequest(
  deps: ProxyDeps,
  req: IncomingMessage,
  res: ServerResponse,
  initialProtocol: Protocol,
): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();
  const headers = req.headers as HeaderMapLike;
  if (method === "OPTIONS") {
    const requested = getHeader(headers, "access-control-request-headers");
    const cors: Record<string, string> = {};
    addCorsHeaders(cors, requested);
    res.writeHead(204, cors);
    res.end();
    return;
  }

  try {
    const rawUrl = req.url && req.url !== "" ? req.url : "/";
    if (initialProtocol === "anthropic" && filesApiRequest(method, rawUrl) !== null) {
      await forwardFilesApiRequest(deps, req, res, method, rawUrl);
      return;
    }
    await forwardModelRequest(deps, req, res, method, rawUrl, initialProtocol);
  } catch (error) {
    if (res.headersSent) {
      res.destroy(error instanceof Error ? error : undefined);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    sendText(res, 502, message);
  }
}

// ─── Snapshot / credential state ────────────────────────────────────────────

function resolveConfig(deps: ProxyDeps): ResolvedConfig {
  let snapshot: JsonRow = {};
  try {
    snapshot = deps.runtimeConfig.snapshot() ?? {};
  } catch {
    snapshot = {};
  }
  const channels = asArray(snapshot.channels).map(asChannel);
  const accounts = asArray(snapshot.accounts).map(asAccount);
  const routes = asArray(snapshot.routes).map(asRoute);
  const rules = asArray(snapshot.rules).map(asRule);
  for (const account of accounts) {
    const override = deps.credentialOverrides?.get(account.id);
    if (override !== undefined) {
      account.credential_status = override.status;
      account.last_error = override.lastError;
    }
    if (isTransientDeactivatedAccount(account)) {
      account.credential_status = ACCOUNT_CREDENTIAL_HEALTHY;
    }
  }
  return { channels, accounts, routes, rules };
}

function updateSnapshotAccount(
  deps: ProxyDeps,
  accountId: string,
  mutate: (account: JsonRow) => void,
): void {
  const runtime = deps.runtimeConfig;
  try {
    if (typeof runtime.update === "function") {
      runtime.update((draft) => {
        for (const account of asArray(draft.accounts)) {
          if (isRecord(account) && account.id === accountId) mutate(account);
        }
      });
      return;
    }
    if (typeof runtime.replace === "function") {
      const snapshot = JSON.parse(JSON.stringify(runtime.snapshot() ?? {})) as JsonRow;
      for (const account of asArray(snapshot.accounts)) {
        if (isRecord(account) && account.id === accountId) mutate(account);
      }
      runtime.replace(snapshot);
    }
  } catch {
    /* 快照刷新失败不影响代理主链路；本实例内的 override 仍然生效 */
  }
}

function markInvalid(deps: ProxyDeps, accountId: string, message: string): void {
  deps.credentialOverrides?.set(accountId, { status: "invalid_key", lastError: message });
  markAccountInvalid(deps.storage, accountId, message);
  updateSnapshotAccount(deps, accountId, (account) => {
    account.last_error = message;
    account.credential_status = "invalid_key";
  });
}

function markRecovered(deps: ProxyDeps, accountId: string): void {
  deps.credentialOverrides?.set(accountId, {
    status: ACCOUNT_CREDENTIAL_HEALTHY,
    lastError: null,
  });
  markAccountRecovered(deps.storage, accountId);
  updateSnapshotAccount(deps, accountId, (account) => {
    account.last_error = null;
    account.credential_status = ACCOUNT_CREDENTIAL_HEALTHY;
  });
}

/** 全局上游代理：SQLite app_meta 优先，缺省回退 config.json 的 network.upstream_proxy。 */
function readGlobalProxySettings(deps: ProxyDeps): UpstreamProxySettings {
  try {
    const stored = deps.storage.getAppMeta?.("upstream_proxy_config") ?? null;
    if (stored !== null && stored !== "") {
      return normalizeProxySettings(JSON.parse(stored) as unknown);
    }
  } catch {
    /* 回退 config.json */
  }
  if (deps.configPath !== undefined) {
    try {
      const parsed = JSON.parse(readFileSync(deps.configPath, "utf8")) as unknown;
      if (isRecord(parsed) && isRecord(parsed.network)) {
        return normalizeProxySettings(parsed.network.upstream_proxy);
      }
    } catch {
      /* config.json 缺失/损坏时视为未启用 */
    }
  }
  return { enabled: false, url: "" };
}

function channelBaseUrl(channel: ChannelRow, protocol: Protocol): string {
  return protocol === "anthropic" ? channel.anthropic_base_url : channel.openai_base_url;
}

function channelAuthStrategy(channel: ChannelRow, protocol: Protocol): "bearer" | "x_api_key" {
  return protocol === "anthropic" ? channel.anthropic_auth : channel.openai_auth;
}

function accountBaseUrl(account: AccountRow, protocol: Protocol): string {
  if (protocol === "anthropic") {
    return account.anthropic_base_url_override ?? account.workspace_default_anthropic_base_url ?? "";
  }
  return account.base_url_override ?? account.workspace_default_base_url ?? "";
}

/** 智谱 OpenAI 兼容端点路径不带 `/v1`（`channels_config::openai_path_strips_v1`）。 */
function openaiPathStripsV1(channelId: string): boolean {
  return channelId === "zhipu";
}

// ─── Log context ────────────────────────────────────────────────────────────

interface LogContextInit {
  agentType: string | null;
  agentSessionId: string | null;
  parentAgentSessionId: string | null;
  clientId: string | null;
  clientName: string | null;
  channelId: string;
  channelName: string;
  accountId: string;
  accountName: string;
  upstreamModel: string;
  virtualModel: string | null;
  publicModel: string | null;
  requestType: string;
  method: string;
  path: string;
  upstreamUrl: string;
  upstreamProxyUsed: boolean | null;
  clientProtocol: string;
  upstreamProtocol: string;
  sendAt: number;
  reqHeadersJson: string | null;
  reqBodyB64: string | null;
}

class RouteLogContext {
  readonly init: LogContextInit;

  constructor(init: LogContextInit) {
    this.init = init;
  }

  baseLogInput(
    requestId: string,
    status: number | null,
    latencyMs: number | null,
    isStream: boolean,
    errorMessage: string | null,
    fallbackCount: number,
    routeReason: string,
  ): JsonRow {
    const init = this.init;
    return {
      request_id: requestId,
      agent_type: init.agentType,
      agent_session_id: init.agentSessionId,
      parent_agent_session_id: init.parentAgentSessionId,
      client_id: init.clientId,
      client_name: init.clientName,
      channel_id: init.channelId,
      channel_name: init.channelName,
      account_id: init.accountId,
      account_name: init.accountName,
      client_protocol: init.clientProtocol,
      upstream_protocol: init.upstreamProtocol,
      virtual_model: init.virtualModel,
      public_model: init.publicModel,
      upstream_model: init.upstreamModel,
      request_type: init.requestType,
      method: init.method,
      path: init.path,
      upstream_url: init.upstreamUrl,
      upstream_proxy_used: init.upstreamProxyUsed,
      status,
      latency_ms: latencyMs,
      is_stream: isStream,
      error_message: errorMessage,
      fallback_count: fallbackCount,
      route_reason: routeReason,
      ttfb_ms: null,
      duration_ms: null,
      attempt_seq: 0,
      req_headers_json: init.reqHeadersJson,
      req_body_b64: init.reqBodyB64,
      res_headers_json: null,
      res_body_b64: null,
      is_last_attempt: true,
    };
  }

  logFallback(
    requestId: string,
    status: number | null,
    errorMessage: string | null,
    fallbackCount: number,
    routeReason: string,
  ): JsonRow {
    const elapsed = elapsedMs(this.init.sendAt);
    const log = this.baseLogInput(
      requestId,
      status,
      elapsed,
      false,
      errorMessage,
      fallbackCount,
      routeReason,
    );
    log.ttfb_ms = elapsed;
    log.duration_ms = elapsed;
    log.attempt_seq = fallbackCount;
    log.is_last_attempt = false;
    return log;
  }

  logFinalNetworkError(
    requestId: string,
    errorMessage: string,
    fallbackCount: number,
    routeReason: string,
  ): JsonRow {
    const elapsed = elapsedMs(this.init.sendAt);
    const log = this.baseLogInput(requestId, 502, elapsed, false, errorMessage, fallbackCount, routeReason);
    log.ttfb_ms = null;
    log.duration_ms = elapsed;
    log.attempt_seq = fallbackCount;
    return log;
  }

  logSuccessBase(
    requestId: string,
    status: number,
    fallbackCount: number,
    routeReason: string,
    attemptSeq: number,
    isLast: boolean,
  ): JsonRow {
    const log = this.baseLogInput(requestId, status, null, false, null, fallbackCount, routeReason);
    log.attempt_seq = attemptSeq;
    log.is_last_attempt = isLast;
    return log;
  }
}

// ─── Error payloads ─────────────────────────────────────────────────────────

function noCandidatePayload(protocol: Protocol, errorCode: string, errorMessage: string): unknown {
  if (protocol === "anthropic") {
    return { type: "error", error: { type: errorCode, message: errorMessage } };
  }
  return { error: { message: errorMessage, type: errorCode, code: errorCode } };
}

function responsesUnsupportedMethodPayload(): unknown {
  return {
    error: {
      message:
        "Flowlet only supports stateless POST /v1/responses passthrough; stored-response management endpoints (retrieve/delete/input_items) are not supported",
      type: "responses_unsupported_method",
      code: "responses_unsupported_method",
    },
  };
}

function anthropicErrorPayload(errorCode: string, message: string): unknown {
  return { type: "error", error: { type: errorCode, message } };
}

interface SkippedLogOptions {
  requestId: string;
  agentType: string | null;
  agentSessionId: string | null;
  parentAgentSessionId: string | null;
  clientId: string | null;
  clientName: string | null;
  accounts: AccountRow[];
  channels: ChannelRow[];
  publicModel: string | null;
  virtualModel: string | null;
  requestType: string;
  method: string;
  path: string;
  protocol: Protocol;
  skipped: RouteRow[];
  reason: string;
}

function recordSkippedRouteLogs(storage: ProxyStorage, options: SkippedLogOptions): void {
  options.skipped.forEach((candidate, index) => {
    const account = options.accounts.find((item) => item.id === candidate.account_id);
    const channel = options.channels.find((item) => item.id === candidate.channel_id);
    recordRequestLog(storage, {
      request_id: options.requestId,
      agent_type: options.agentType,
      agent_session_id: options.agentSessionId,
      parent_agent_session_id: options.parentAgentSessionId,
      client_id: options.clientId,
      client_name: options.clientName,
      channel_id: candidate.channel_id,
      channel_name: channel?.name ?? null,
      account_id: candidate.account_id,
      account_name: account?.name ?? null,
      client_protocol: options.protocol,
      upstream_protocol: options.protocol,
      virtual_model: options.virtualModel,
      public_model: options.publicModel,
      upstream_model: candidate.upstream_model,
      request_type: options.requestType,
      method: options.method,
      path: options.path,
      upstream_url: null,
      upstream_proxy_used: null,
      status: null,
      latency_ms: 0,
      is_stream: false,
      error_message: null,
      fallback_count: index + 1,
      route_reason: options.reason,
      ttfb_ms: null,
      duration_ms: 0,
      attempt_seq: index,
      req_headers_json: null,
      req_body_b64: null,
      res_headers_json: null,
      res_body_b64: null,
      is_last_attempt: false,
    });
  });
}

/** 丢弃不再读取的响应体：undici BodyReadable destroy 会发 error，需先挂 no-op 监听。 */
function discardResponseBody(body: Readable): void {
  body.on("error", () => {});
  body.destroy();
}

/**
 * 把请求体里能确认的会话标题 / 项目路径写入观测元数据（docs/agent-session-metadata.md）。
 *
 * 只在识别出 `(agent_type, session_id)` 时写：否则元数据无法归属到任何会话行。
 * 两个值可以只命中一个（例如 DSH 的请求体里没有 cwd），此时另一个字段传 null，
 * 由存储层的 COALESCE 保留历史值。
 */
function recordDerivedSessionMetadata(
  storage: ProxyStorage,
  agentSession: ReturnType<typeof extractAgentSession>,
  bodyBytes: Buffer,
): void {
  if (agentSession === null) return;
  const derived = deriveSessionMetadata(agentSession.agent_type, bodyBytes);
  if (derived.title === null && derived.projectPath === null) return;
  recordAgentSessionMetadata(storage, {
    agent_type: agentSession.agent_type,
    session_id: agentSession.session_id,
    title: derived.title,
    project_path: derived.projectPath,
    source: "derived",
  });
}

// ─── Model path ─────────────────────────────────────────────────────────────

async function forwardModelRequest(
  deps: ProxyDeps,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  rawUrl: string,
  initialProtocol: Protocol,
): Promise<void> {
  const requestId = randomId();
  const headers = req.headers as HeaderMapLike;
  const capture = readCaptureConfig(deps.storage, deps.configPath);
  const bodyBytes = await readIncomingBody(req, MODEL_BODY_HARD_LIMIT_BYTES);
  const path = rawUrl;

  let protocol: Protocol = initialProtocol;
  if (isResponsesPath(path)) protocol = "responses";

  if (protocol === "responses" && method !== "POST") {
    sendJson(res, 405, responsesUnsupportedMethodPayload());
    return;
  }

  const agentSession = extractAgentSession(headers);
  const config = resolveConfig(deps);
  const { channels, accounts, routes, rules } = config;

  // 会话标题/项目路径只做观测补充：识别出会话身份就先 upsert，与本次请求是否命中路由无关。
  // 未识别会话身份（如 GET /models）时不会写任何元数据行。
  recordDerivedSessionMetadata(deps.storage, agentSession, bodyBytes);

  if (isModelListRequest(method, path)) {
    const response = buildModelListResponse(routes, accounts, channels, protocol, deps.identity);
    sendJsonText(res, response.status, response.body);
    return;
  }

  const detailId = modelDetailRequestId(method, path);
  if (detailId !== null) {
    const channelModels = (deps.storage.listChannelModels?.() ?? []).map(asChannelModel);
    const response = buildModelDetailResponse(
      detailId,
      routes,
      accounts,
      channels,
      channelModels,
      deps.identity,
    );
    sendJsonText(res, response.status, response.body);
    return;
  }

  const publicModel = extractModel(bodyBytes, protocol);
  const routingModel = publicModel === null ? null : deps.identity.routingModelId(publicModel);
  const requestType = classifyRequest(bodyBytes, protocol);

  const { id: clientId, name: clientName } = identifyClientFromHeaders(headers, deps.configPath);
  const defaultClientToken = deps.bindConfig().default_client_token;
  const tokenClient = identifyClient(headers, defaultClientToken);

  if (
    tokenClient !== null &&
    deps.rateLimitEnabled !== false &&
    deps.rateLimiter !== undefined &&
    !deps.rateLimiter.tryConsume(tokenClient.id)
  ) {
    const retryAfter = deps.rateLimiter.retryAfter(tokenClient.id);
    sendJson(res, 429, { error: "rate limit exceeded" }, { "retry-after": String(retryAfter) });
    return;
  }

  const selection = matchCandidates(
    routes,
    rules,
    accounts,
    routingModel,
    protocol,
    tokenClient?.id ?? null,
    deps.roundRobin ?? new Map(),
    (model) => deps.identity.canonicalKey(model),
  );
  let candidates = selection.matched;
  const skippedForProtocol = candidates.length === 0 ? selection.protocol_skipped : [];

  let skippedForInputModality: RouteRow[] = [];
  if (requestUsesImage(bodyBytes, protocol) && candidates.length > 0) {
    const capable: RouteRow[] = [];
    for (const candidate of candidates) {
      if (deps.identity.supportsImage(candidate.upstream_model)) capable.push(candidate);
      else skippedForInputModality.push(candidate);
    }
    candidates = capable;
  }
  const imageInputUnsupported = skippedForInputModality.length > 0 && candidates.length === 0;
  const protocolUnsupported = skippedForProtocol.length > 0;

  let filesPinReason: string | null = null;
  if (protocol === "anthropic" && requestReferencesFilesApi(headers)) {
    const pinned = filesAccount(channels, accounts);
    if (pinned !== null) {
      if (candidates.some((candidate) => candidate.account_id === pinned.account.id)) {
        candidates = candidates.filter((candidate) => candidate.account_id === pinned.account.id);
        filesPinReason = "files_api_pinned";
      } else {
        filesPinReason = "files_api_pin_missed";
      }
    }
  }

  const skippedTotal = skippedForProtocol.length + skippedForInputModality.length;
  const commonSkipped: Omit<SkippedLogOptions, "skipped" | "reason"> = {
    requestId,
    agentType: agentSession?.agent_type ?? null,
    agentSessionId: agentSession?.session_id ?? null,
    parentAgentSessionId: agentSession?.parent_session_id ?? null,
    clientId,
    clientName,
    accounts,
    channels,
    publicModel,
    virtualModel: routingModel,
    requestType,
    method,
    path,
    protocol,
  };
  if (skippedForProtocol.length > 0) {
    recordSkippedRouteLogs(deps.storage, {
      ...commonSkipped,
      skipped: skippedForProtocol,
      reason: "protocol_unsupported",
    });
  }
  if (skippedForInputModality.length > 0) {
    recordSkippedRouteLogs(deps.storage, {
      ...commonSkipped,
      skipped: skippedForInputModality,
      reason: "input_modality_image_unsupported",
    });
  }

  if (candidates.length === 0) {
    const hasAvailableAccount = accounts.some(
      (account) => account.enabled && account.api_key.trim() !== "",
    );
    const hasExposedModel = routes.some(
      (route) =>
        route.enabled &&
        accounts.some(
          (account) =>
            account.id === route.account_id &&
            account.enabled &&
            account.api_key.trim() !== "",
        ),
    );
    let errorCode: string;
    let errorMessage: string;
    let errorStatus: number;
    if (protocolUnsupported) {
      errorCode = "model_protocol_unsupported";
      errorMessage = "The requested model is not exposed under the requested protocol";
      errorStatus = 404;
    } else if (imageInputUnsupported) {
      errorCode = "model_input_modality_unsupported";
      errorMessage = "No enabled route for the requested model supports image input";
      errorStatus = 400;
    } else if (!hasAvailableAccount) {
      errorCode = "no_available_account";
      errorMessage = "No enabled account with a configured API key is available";
      errorStatus = 404;
    } else if (!hasExposedModel) {
      errorCode = "no_available_model";
      errorMessage = "No model is currently exposed by Flowlet";
      errorStatus = 404;
    } else {
      errorCode = "model_not_exposed";
      errorMessage = "The requested model is not exposed by Flowlet";
      errorStatus = 404;
    }
    const payload = noCandidatePayload(protocol, errorCode, errorMessage);
    const payloadBytes = Buffer.from(JSON.stringify(payload), "utf8");
    const responseHeaders: Record<string, string> = {
      "content-type": "application/json",
      "content-length": String(payloadBytes.length),
    };
    addCorsHeaders(responseHeaders);
    recordRequestLog(deps.storage, {
      request_id: requestId,
      agent_type: agentSession?.agent_type ?? null,
      agent_session_id: agentSession?.session_id ?? null,
      parent_agent_session_id: agentSession?.parent_session_id ?? null,
      client_id: clientId,
      client_name: clientName,
      channel_id: null,
      channel_name: null,
      account_id: null,
      account_name: null,
      client_protocol: protocol,
      upstream_protocol: protocol,
      virtual_model: routingModel,
      public_model: publicModel,
      upstream_model: null,
      request_type: requestType,
      method,
      path,
      upstream_url: null,
      upstream_proxy_used: null,
      status: errorStatus,
      latency_ms: 0,
      is_stream: false,
      error_message: `${errorCode}: ${errorMessage}`,
      fallback_count: skippedTotal,
      route_reason: errorCode,
      ttfb_ms: null,
      duration_ms: null,
      attempt_seq: skippedTotal,
      req_headers_json: captureHeaders(headers, capture, true),
      req_body_b64: captureBody(bodyBytes, capture, true),
      res_headers_json: captureHeaders(responseHeaders, capture, false),
      res_body_b64: captureBody(payloadBytes, capture, false),
      is_last_attempt: true,
    });
    res.writeHead(errorStatus, responseHeaders);
    res.end(payloadBytes);
    return;
  }

  const release = deps.activity?.track?.();
  try {
    await runAttempts({
      deps,
      res,
      method,
      path,
      protocol,
      headers,
      bodyBytes,
      capture,
      requestId,
      requestType,
      publicModel,
      routingModel,
      clientId,
      clientName,
      agentSession,
      candidates,
      channels,
      accounts,
      filesPinReason,
      skippedTotal,
    });
  } finally {
    release?.();
  }
}

interface AttemptParams {
  deps: ProxyDeps;
  res: ServerResponse;
  method: string;
  path: string;
  protocol: Protocol;
  headers: HeaderMapLike;
  bodyBytes: Buffer;
  capture: LogCaptureConfig;
  requestId: string;
  requestType: string;
  publicModel: string | null;
  routingModel: string | null;
  clientId: string | null;
  clientName: string;
  agentSession: ReturnType<typeof extractAgentSession>;
  candidates: RouteRow[];
  channels: ChannelRow[];
  accounts: AccountRow[];
  filesPinReason: string | null;
  skippedTotal: number;
}

async function runAttempts(params: AttemptParams): Promise<void> {
  const {
    deps,
    res,
    method,
    path,
    protocol,
    headers,
    bodyBytes,
    capture,
    requestId,
    requestType,
    publicModel,
    routingModel,
    clientId,
    clientName,
    agentSession,
    candidates,
    channels,
    accounts,
    filesPinReason,
    skippedTotal,
  } = params;

  const protocolStr = protocol;
  let fallbackCount = skippedTotal;
  let lastError: ForwardError | null = null;

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const account = accounts.find((item) => item.id === candidate.account_id);
    const channel = channels.find((item) => item.id === candidate.channel_id);
    if (!account || !channel) continue;

    const effectiveModel = candidate.upstream_model;
    let routedBody = rewriteModel(bodyBytes, effectiveModel, protocol);
    routedBody = ensureReasoningContentPassback(
      routedBody,
      effectiveModel,
      protocol,
      (model) => deps.identity.isDeepseekReasoningModel(model),
    );
    routedBody = ensureAnthropicThinkingPassback(
      routedBody,
      effectiveModel,
      protocol,
      (model) => deps.identity.isDeepseekReasoningModel(model),
    );

    const overrideBase = accountBaseUrl(account, protocol).trim();
    const baseUrl = overrideBase !== "" ? overrideBase : channelBaseUrl(channel, protocol);
    const originalUrl = path;
    const upstreamUrl =
      openaiPathStripsV1(channel.id) && (protocol === "openai" || protocol === "responses")
        ? buildUpstreamUrlWithoutOpenAiV1(baseUrl, originalUrl)
        : buildUpstreamUrl(baseUrl, originalUrl, protocol);
    const timeoutSeconds =
      channel.timeout_seconds ?? deps.upstreamTimeoutSeconds ?? DEFAULT_UPSTREAM_TIMEOUT_SECONDS;

    // 先构造最终上游请求头/体（含鉴权与 model 改写后的字节），再选出口 —— 与 Rust 一致：
    // 即使上游代理配置失败，日志里仍然是"本应发出的最终上游请求"。
    const upstreamHeaders = applyRequestHeaders(
      headers,
      account.api_key,
      channelAuthStrategy(channel, protocol),
    );
    const reqHeadersJson = captureHeaders(upstreamHeaders, capture, true);
    const reqBodyB64 = captureBody(routedBody, capture, true);
    const sendAt = Date.now();

    const context = new RouteLogContext({
      agentType: agentSession?.agent_type ?? null,
      agentSessionId: agentSession?.session_id ?? null,
      parentAgentSessionId: agentSession?.parent_session_id ?? null,
      clientId,
      clientName,
      channelId: candidate.channel_id,
      channelName: channel.name,
      accountId: candidate.account_id,
      accountName: account.name,
      upstreamModel: effectiveModel,
      virtualModel: routingModel,
      publicModel,
      requestType,
      method,
      path,
      upstreamUrl,
      upstreamProxyUsed: null,
      clientProtocol: protocolStr,
      upstreamProtocol: protocolStr,
      sendAt,
      reqHeadersJson,
      reqBodyB64,
    });

    let selected;
    try {
      selected = deps.transport.select(
        { channel_id: candidate.channel_id, use_upstream_proxy: account.use_upstream_proxy },
        readGlobalProxySettings(deps),
        upstreamUrl,
      );
    } catch (error) {
      const forwardError =
        error instanceof ForwardError ? error : ForwardError.proxyConfiguration(String(error));
      if (index + 1 < candidates.length) {
        fallbackCount += 1;
        recordRequestLog(
          deps.storage,
          context.logFallback(
            requestId,
            null,
            forwardError.message,
            fallbackCount,
            `${forwardError.routeReason}_fallback`,
          ),
        );
        continue;
      }
      recordRequestLog(
        deps.storage,
        context.logFinalNetworkError(
          requestId,
          forwardError.message,
          fallbackCount,
          forwardError.routeReason,
        ),
      );
      lastError = forwardError;
      continue;
    }
    context.init.upstreamProxyUsed = selected.proxyUsed;

    let upstream: UpstreamResponse;
    try {
      upstream = await deps.transport.execute({
        method,
        url: upstreamUrl,
        headers: upstreamHeaders,
        body: routedBody,
        dispatcher: selected.dispatcher,
        timeoutSeconds,
        timeoutPhase: "响应头",
        retryConnect: selected.retryConnect,
        channelId: candidate.channel_id,
      });
    } catch (error) {
      const forwardError = error instanceof ForwardError ? error : ForwardError.network(error);
      const errorMessage =
        forwardError.kind === "network"
          ? modelNetworkError(candidate.channel_id, forwardError.causeValue ?? forwardError)
          : forwardError.message;
      if (index + 1 < candidates.length) {
        fallbackCount += 1;
        recordRequestLog(
          deps.storage,
          context.logFallback(
            requestId,
            null,
            errorMessage,
            fallbackCount,
            `${forwardError.routeReason}_fallback`,
          ),
        );
        continue;
      }
      recordRequestLog(
        deps.storage,
        context.logFinalNetworkError(requestId, errorMessage, fallbackCount, forwardError.routeReason),
      );
      lastError = forwardError;
      continue;
    }

    const ttfbMs = elapsedMs(sendAt);
    const status = upstream.statusCode;
    const channelVendor = channel.vendor;
    if (
      status >= 200 &&
      status < 300 &&
      account.last_error !== null &&
      (account.last_error.toLowerCase().includes("account_deactivated") ||
        account.last_error.toLowerCase().includes("api key is disabled"))
    ) {
      markRecovered(deps, account.id);
    }
    if (status === 401) {
      markInvalid(deps, account.id, "upstream returned 401; API Key may be invalid");
    }

    if (shouldTryNextStatus(status, channelVendor) && index + 1 < candidates.length) {
      fallbackCount += 1;
      discardResponseBody(upstream.body);
      recordRequestLog(
        deps.storage,
        context.logFallback(
          requestId,
          status,
          `retryable_status_${status}`,
          fallbackCount,
          "retryable_status",
        ),
      );
      continue;
    }

    const routeReason =
      fallbackCount > 0
        ? "fallback_success"
        : filesPinReason !== null
          ? filesPinReason
          : routingModel === "auto"
            ? "auto"
            : "direct";
    const attemptSeq = fallbackCount;
    const isLast = index + 1 >= candidates.length || !shouldTryNextStatus(status, channelVendor);

    if (shouldInspectFallbackBody(status)) {
      let body: Buffer;
      try {
        body = await readBodyWithTimeout(upstream.body, timeoutSeconds);
      } catch (error) {
        const forwardError = error instanceof ForwardError ? error : ForwardError.network(error);
        if (index + 1 < candidates.length) {
          fallbackCount += 1;
          recordRequestLog(
            deps.storage,
            context.logFallback(
              requestId,
              status,
              forwardError.message,
              fallbackCount,
              `${forwardError.routeReason}_fallback`,
            ),
          );
          continue;
        }
        recordRequestLog(
          deps.storage,
          context.logFinalNetworkError(
            requestId,
            forwardError.message,
            fallbackCount,
            forwardError.routeReason,
          ),
        );
        lastError = forwardError;
        continue;
      }
      const durationMs = elapsedMs(sendAt);
      const hasNextCandidate = index + 1 < candidates.length;
      const resHeadersJson = captureHeaders(upstream.headers, capture, false);
      const encoding = contentEncodingValue(upstream.headers);

      if (bodyContainsAccountDeactivated(body)) {
        const message = "upstream API Key is disabled (account_deactivated)";
        markInvalid(deps, account.id, message);
        if (hasNextCandidate) {
          fallbackCount += 1;
          const log = context.logFallback(
            requestId,
            status,
            message,
            fallbackCount,
            "credential_disabled",
          );
          log.ttfb_ms = ttfbMs;
          log.duration_ms = durationMs;
          log.res_headers_json = resHeadersJson;
          log.res_body_b64 = captureResponseBody(body, encoding, capture);
          recordRequestLog(deps.storage, log);
          continue;
        }
      }
      if (bodyContainsQuotaExceeded(body) && hasNextCandidate) {
        fallbackCount += 1;
        recordRequestLog(
          deps.storage,
          context.logFallback(requestId, status, "quota exceeded", fallbackCount, "quota_exceeded"),
        );
        continue;
      }
      if (bodyContainsProductNotActivated(body) && hasNextCandidate) {
        fallbackCount += 1;
        const log = context.logFallback(
          requestId,
          status,
          "upstream product is not activated",
          fallbackCount,
          "product_not_activated",
        );
        log.ttfb_ms = ttfbMs;
        log.duration_ms = durationMs;
        log.res_headers_json = resHeadersJson;
        log.res_body_b64 = captureResponseBody(body, encoding, capture);
        recordRequestLog(deps.storage, log);
        continue;
      }

      const log = context.logSuccessBase(
        requestId,
        status,
        fallbackCount,
        routeReason,
        attemptSeq,
        isLast,
      );
      log.ttfb_ms = ttfbMs;
      log.duration_ms = durationMs;
      log.res_headers_json = resHeadersJson;
      log.res_body_b64 = captureResponseBody(body, encoding, capture);
      sendBufferedResponse({
        deps,
        res,
        status,
        headers: upstream.headers,
        body,
        log,
        requestId,
        protocol,
        context,
      });
      return;
    }

    await sendResponse({
      deps,
      res,
      upstream,
      context,
      requestId,
      ttfbMs,
      status,
      isLast,
      attemptSeq,
      fallbackCount,
      routeReason,
      protocol,
      capture,
      timeoutSeconds,
    });
    return;
  }

  if (lastError !== null) throw lastError;
  throw new ForwardError("network", "路由", "至少应有一个路由候选");
}

// ─── Buffered / streaming response ─────────────────────────────────────────

interface BufferedResponseParams {
  deps: ProxyDeps;
  res: ServerResponse;
  status: number;
  headers: Record<string, string | string[]>;
  body: Buffer;
  log: JsonRow;
  requestId: string;
  protocol: Protocol;
  context: RouteLogContext;
}

function sendBufferedResponse(params: BufferedResponseParams): void {
  const { deps, res, status, headers, body, log, protocol, context, requestId } = params;
  enrichUpstreamErrorLog(log, status);
  recordRequestLog(deps.storage, log);
  recordBufferedUsage(deps.storage, context, protocol, body, headers, requestId);
  const outgoing: Record<string, HeaderValue> = { ...copyResponseHeaders(headers) };
  addCorsHeaders(outgoing);
  res.writeHead(status, outgoing);
  res.end(body);
}

function recordBufferedUsage(
  storage: ProxyStorage,
  context: RouteLogContext,
  protocol: Protocol,
  body: Buffer,
  headers: Record<string, string | string[]>,
  requestId: string,
): void {
  const encoding = contentEncodingValue(headers);
  const decoded = decodeUsageBody(body, encoding);
  if (decoded === null) return;
  const usage = extractResponseUsage(decoded);
  if (usage === null) return;
  recordUsage(
    storage,
    usageRecordRow(context, protocol, usage, requestId),
    "complete",
    "upstream_response",
  );
}

function decodeUsageBody(body: Buffer, encoding: string | null): Buffer | null {
  if (encoding === null) return body.length <= MAX_USAGE_CAPTURE_BYTES ? body : null;
  const decoded = decompressForCapture(body, encoding, MAX_USAGE_CAPTURE_BYTES + 1);
  return decoded.length <= MAX_USAGE_CAPTURE_BYTES ? decoded : null;
}

interface SendResponseParams {
  deps: ProxyDeps;
  res: ServerResponse;
  upstream: UpstreamResponse;
  context: RouteLogContext;
  requestId: string;
  ttfbMs: number;
  status: number;
  isLast: boolean;
  attemptSeq: number;
  fallbackCount: number;
  routeReason: string;
  protocol: Protocol;
  capture: LogCaptureConfig;
  timeoutSeconds: number;
}

async function sendResponse(params: SendResponseParams): Promise<void> {
  const {
    deps,
    res,
    upstream,
    context,
    requestId,
    ttfbMs,
    status,
    isLast,
    attemptSeq,
    fallbackCount,
    routeReason,
    protocol,
    capture,
    timeoutSeconds,
  } = params;

  const isStream = isStreamingResponse(upstream.headers);
  const resHeadersJson = captureHeaders(upstream.headers, capture, false);
  const log = context.logSuccessBase(requestId, status, fallbackCount, routeReason, attemptSeq, isLast);
  log.is_stream = isStream;
  log.ttfb_ms = ttfbMs;
  log.res_headers_json = resHeadersJson;
  log.res_body_b64 = null;

  if (isStream) {
    log.duration_ms = null;
    await recordRequestLogAndWait(deps.storage, log);

    const contentEncoding = contentEncodingValue(upstream.headers);
    const repairEnabled =
      protocol === "anthropic" && (contentEncoding === null || contentEncoding === "identity");
    const outgoing: Record<string, HeaderValue> = { ...copyResponseHeaders(upstream.headers) };
    if (repairEnabled) delete outgoing["content-length"];
    addCorsHeaders(outgoing);
    res.writeHead(status, outgoing);
    res.flushHeaders();
    res.socket?.setNoDelay(true);

    const done = await pumpStream({
      res,
      upstream,
      capture,
      sendAt: context.init.sendAt,
      contentEncoding,
      repairEnabled,
      timeoutSeconds,
    });

    updateStreamLog(deps.storage, requestId, {
      ttfb_ms: ttfbMs,
      ttft_ms: done.ttft_ms,
      duration_ms: done.duration_ms,
      res_headers_json: resHeadersJson,
      res_body_b64: done.res_body_b64,
      error_message: done.error_message,
      route_reason: done.route_reason,
    });
    if (done.usage !== null) {
      recordUsage(
        deps.storage,
        usageRecordRow(context, protocol, done.usage, requestId),
        done.usage_status ?? "complete",
        done.usage_source ?? "upstream_response",
      );
    }
    return;
  }

  const body = await readBodyWithTimeout(upstream.body, timeoutSeconds);
  const durationMs = elapsedMs(context.init.sendAt);
  log.duration_ms = durationMs;
  log.res_body_b64 = captureResponseBody(body, contentEncodingValue(upstream.headers), capture);
  enrichUpstreamErrorLog(log, status);
  recordRequestLog(deps.storage, log);
  recordBufferedUsage(deps.storage, context, protocol, body, upstream.headers, requestId);
  const outgoing: Record<string, HeaderValue> = { ...copyResponseHeaders(upstream.headers) };
  addCorsHeaders(outgoing);
  res.writeHead(status, outgoing);
  res.end(body);
}

function usageRecordRow(
  context: RouteLogContext,
  protocol: Protocol,
  usage: ResponseUsage,
  requestId: string,
): JsonRow {
  const init = context.init;
  return {
    request_id: requestId,
    client_id: init.clientId,
    client_name: init.clientName,
    channel_id: init.channelId,
    channel_name: init.channelName,
    account_id: init.accountId,
    account_name: init.accountName,
    client_protocol: protocol,
    upstream_protocol: protocol,
    virtual_model: init.virtualModel,
    upstream_model: init.upstreamModel,
    input_tokens: usage.input_tokens,
    input_cached_tokens: usage.input_cached_tokens,
    input_uncached_tokens: usage.input_uncached_tokens,
    input_cache_write_tokens: usage.input_cache_write_tokens,
    output_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens,
  };
}

// ─── Streaming pump ─────────────────────────────────────────────────────────

interface StreamDone {
  duration_ms: number;
  ttft_ms: number | null;
  res_body_b64: string | null;
  usage: ResponseUsage | null;
  usage_status: string | null;
  usage_source: string | null;
  error_message: string | null;
  route_reason: string | null;
}

class TimedStreamState {
  #capture: LogCaptureConfig;
  #requestStartedAt: number;
  #resContentEncoding: string | null;
  #repair: AnthropicContentBlockRepair | null;
  #ttftMs: number | null = null;
  #ttftProbe: Buffer[] = [];
  #ttftProbeLength = 0;
  #resBody: Buffer[] = [];
  #resBodyLength = 0;
  #usageBody: Buffer[] = [];
  #usageBodyLength = 0;
  #usageBodyEnabled = true;
  #accumulator = new StreamUsageAccumulator();
  #terminalSeen = false;
  #terminalProbe = Buffer.alloc(0);

  constructor(options: {
    capture: LogCaptureConfig;
    requestStartedAt: number;
    resContentEncoding: string | null;
    repairEnabled: boolean;
  }) {
    this.#capture = options.capture;
    this.#requestStartedAt = options.requestStartedAt;
    this.#resContentEncoding = options.resContentEncoding;
    this.#repair = options.repairEnabled ? new AnthropicContentBlockRepair() : null;
  }

  /** 观察原始上游字节，返回应写给客户端的字节（可能经过 Anthropic 修复）。 */
  observe(chunk: Buffer): Buffer {
    if (this.#ttftMs === null && this.#ttftProbeLength + chunk.length <= MAX_TTFT_PROBE_BYTES) {
      this.#ttftProbe.push(Buffer.from(chunk));
      this.#ttftProbeLength += chunk.length;
      const probe = Buffer.concat(this.#ttftProbe, this.#ttftProbeLength);
      if (containsSseOutputToken(probe)) {
        this.#ttftMs = elapsedMs(this.#requestStartedAt);
        this.#ttftProbe = [];
        this.#ttftProbeLength = 0;
      }
    }
    if (
      this.#capture.capture_res_body &&
      this.#resBodyLength + chunk.length <= this.#capture.max_body_bytes
    ) {
      this.#resBody.push(Buffer.from(chunk));
      this.#resBodyLength += chunk.length;
    }
    if (this.#usageBodyEnabled) {
      if (this.#usageBodyLength + chunk.length > MAX_USAGE_CAPTURE_BYTES) {
        this.#usageBodyEnabled = false;
        this.#usageBody = [];
        this.#usageBodyLength = 0;
      } else {
        this.#usageBody.push(Buffer.from(chunk));
        this.#usageBodyLength += chunk.length;
      }
    }
    this.#accumulator.push(chunk);
    this.#trackTerminal(chunk);

    if (this.#repair !== null) return this.#repair.push(chunk);
    return chunk;
  }

  /** 流结束时的兼容尾巴（不完整行原样透传，不修复）。 */
  finish(): Buffer {
    return this.#repair === null ? Buffer.alloc(0) : this.#repair.finish();
  }

  get terminalSeen(): boolean {
    return this.#terminalSeen;
  }

  summarize(success: boolean, errorMessage: string | null, routeReason: string | null): StreamDone {
    const durationMs = elapsedMs(this.#requestStartedAt);
    const resBodyB64 = this.#capture.capture_res_body
      ? captureResponseBody(
          Buffer.concat(this.#resBody, this.#resBodyLength),
          this.#resContentEncoding,
          this.#capture,
        )
      : null;

    const parsed = this.#accumulator.finishWithEvidence();
    let usage =
      parsed.usage ??
      (this.#usageBodyEnabled
        ? extractStreamUsage(Buffer.concat(this.#usageBody, this.#usageBodyLength))
        : null);
    const complete = success || parsed.has_completion_evidence;
    if (!complete && usage !== null) {
      usage = { ...usage, output_tokens: null, total_tokens: null };
    }
    let usageStatus: string | null;
    let usageSource: string | null;
    if (usage === null) {
      usageStatus = null;
      usageSource = null;
    } else if (complete) {
      usageStatus = "complete";
      usageSource = success ? "upstream_response" : "upstream_stream_recovered";
    } else {
      usageStatus = "partial";
      usageSource = "upstream_stream_partial";
    }
    return {
      duration_ms: durationMs,
      ttft_ms: this.#ttftMs,
      res_body_b64: resBodyB64,
      usage,
      usage_status: usageStatus,
      usage_source: usageSource,
      error_message: errorMessage,
      route_reason: routeReason,
    };
  }

  #trackTerminal(bytes: Buffer): void {
    if (this.#terminalSeen) return;
    this.#terminalProbe =
      this.#terminalProbe.length === 0
        ? Buffer.from(bytes)
        : Buffer.concat([this.#terminalProbe, bytes]);
    if (this.#terminalProbe.length > MAX_TERMINAL_PROBE_BYTES) {
      this.#terminalProbe = this.#terminalProbe.subarray(
        this.#terminalProbe.length - MAX_TERMINAL_PROBE_BYTES,
      );
    }
    if (containsStreamTerminalMarker(this.#terminalProbe)) {
      this.#terminalSeen = true;
      this.#terminalProbe = Buffer.alloc(0);
    }
  }
}

const STREAM_TERMINAL_MARKERS = [
  Buffer.from("data: [DONE]"),
  Buffer.from("data:[DONE]"),
  Buffer.from('"type":"message_stop"'),
  Buffer.from("event: message_stop"),
  Buffer.from('"type":"response.completed"'),
];

function containsStreamTerminalMarker(bytes: Buffer): boolean {
  return STREAM_TERMINAL_MARKERS.some((marker) => bytes.includes(marker));
}

async function pumpStream(options: {
  res: ServerResponse;
  upstream: UpstreamResponse;
  capture: LogCaptureConfig;
  sendAt: number;
  contentEncoding: string | null;
  repairEnabled: boolean;
  timeoutSeconds: number;
}): Promise<StreamDone> {
  const { res, upstream, capture, sendAt, contentEncoding, repairEnabled, timeoutSeconds } = options;
  const state = new TimedStreamState({
    capture,
    requestStartedAt: sendAt,
    resContentEncoding: contentEncoding,
    repairEnabled,
  });
  const idleTimeoutMs = secondsToMs(timeoutSeconds, DEFAULT_UPSTREAM_TIMEOUT_SECONDS);

  let downstreamClosed = false;
  let idleTimedOut = false;
  let streamError: unknown = null;
  let completed = false;

  const onClose = (): void => {
    if (!res.writableFinished) {
      downstreamClosed = true;
      upstream.body.destroy();
    }
  };
  res.on("close", onClose);

  const iterator = upstream.body[Symbol.asyncIterator]() as AsyncIterator<Buffer>;

  try {
    for (;;) {
      if (downstreamClosed) break;
      const next = await nextChunkWithTimeout(iterator, idleTimeoutMs);
      if (next.kind === "timeout") {
        idleTimedOut = true;
        break;
      }
      if (next.kind === "error") {
        streamError = next.error;
        break;
      }
      if (next.kind === "done") {
        completed = true;
        break;
      }
      const output = state.observe(next.value);
      if (output.length > 0) {
        const writable = res.write(output);
        if (!writable) {
          const drained = await waitForDrainOrClose(res);
          if (!drained) {
            downstreamClosed = true;
            upstream.body.destroy();
            break;
          }
        }
      }
    }

    const tail = state.finish();
    if (tail.length > 0 && !downstreamClosed && !idleTimedOut) res.write(tail);

    if (completed) {
      const done = state.summarize(true, null, null);
      res.end();
      return done;
    }
    if (idleTimedOut) {
      const message = `上游流连续 ${Math.floor(idleTimeoutMs / 1000)} 秒未返回数据，已中止`;
      const done = state.summarize(false, message, "stream_timeout");
      discardResponseBody(upstream.body);
      res.destroy(new Error(message));
      return done;
    }
    if (downstreamClosed) {
      if (state.terminalSeen) return state.summarize(true, null, null);
      return state.summarize(false, "下游客户端在流结束前断开连接", "stream_cancelled");
    }
    const errorMessage =
      streamError instanceof Error ? streamError.message : String(streamError ?? "stream error");
    const done = state.summarize(false, errorMessage, "stream_error");
    res.destroy(streamError instanceof Error ? streamError : undefined);
    return done;
  } finally {
    res.off("close", onClose);
  }
}

type NextChunk =
  | { kind: "chunk"; value: Buffer }
  | { kind: "done" }
  | { kind: "error"; error: unknown }
  | { kind: "timeout" };

function nextChunkWithTimeout(iterator: AsyncIterator<Buffer>, timeoutMs: number): Promise<NextChunk> {
  return new Promise<NextChunk>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ kind: "timeout" });
    }, timeoutMs);
    iterator.next().then(
      (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (result.done) resolve({ kind: "done" });
        else resolve({ kind: "chunk", value: Buffer.from(result.value as Buffer) });
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ kind: "error", error });
      },
    );
  });
}

function waitForDrainOrClose(res: ServerResponse): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const finish = (drained: boolean): void => {
      res.off("drain", onDrain);
      res.off("close", onClose);
      resolve(drained);
    };
    const onDrain = (): void => finish(true);
    const onClose = (): void => finish(false);
    res.on("drain", onDrain);
    res.on("close", onClose);
  });
}

// ─── Files API ──────────────────────────────────────────────────────────────

async function forwardFilesApiRequest(
  deps: ProxyDeps,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
): Promise<void> {
  const requestId = randomId();
  const headers = req.headers as HeaderMapLike;
  const capture = readCaptureConfig(deps.storage, deps.configPath);
  const agentSession = extractAgentSession(headers);
  const { id: clientId, name: clientName } = identifyClientFromHeaders(headers, deps.configPath);

  const log: JsonRow = {
    request_id: requestId,
    agent_type: agentSession?.agent_type ?? null,
    agent_session_id: agentSession?.session_id ?? null,
    parent_agent_session_id: agentSession?.parent_session_id ?? null,
    client_id: clientId,
    client_name: clientName,
    channel_id: null,
    channel_name: null,
    account_id: null,
    account_name: null,
    client_protocol: "anthropic",
    upstream_protocol: "anthropic",
    virtual_model: null,
    public_model: null,
    upstream_model: null,
    request_type: "files",
    method,
    path,
    upstream_url: null,
    upstream_proxy_used: null,
    status: null,
    latency_ms: 0,
    is_stream: false,
    error_message: null,
    fallback_count: 0,
    route_reason: "files_api",
    ttfb_ms: null,
    duration_ms: null,
    attempt_seq: 0,
    req_headers_json: captureHeaders(headers, capture, true),
    req_body_b64: null,
    res_headers_json: null,
    res_body_b64: null,
    is_last_attempt: true,
  };

  let bodyBytes: Buffer;
  try {
    bodyBytes = await readIncomingBody(req, FILES_UPLOAD_LIMIT_BYTES);
  } catch {
    const errorCode = "files_upload_too_large";
    const message = "The uploaded file exceeds Flowlet's 128 MiB passthrough limit";
    log.status = 413;
    log.error_message = `${errorCode}: ${message}`;
    log.route_reason = errorCode;
    recordRequestLog(deps.storage, log);
    sendJson(res, 413, anthropicErrorPayload(errorCode, message));
    return;
  }

  const config = resolveConfig(deps);
  const pinned = filesAccount(config.channels, config.accounts);
  if (pinned === null) {
    const errorCode = "files_account_unavailable";
    const message = "No enabled account on a files-capable channel is available";
    log.status = 503;
    log.error_message = `${errorCode}: ${message}`;
    log.route_reason = errorCode;
    recordRequestLog(deps.storage, log);
    sendJson(res, 503, anthropicErrorPayload(errorCode, message));
    return;
  }

  const { channel, account } = pinned;
  const baseUrl =
    accountBaseUrl(account, "anthropic").trim() !== ""
      ? accountBaseUrl(account, "anthropic")
      : channelBaseUrl(channel, "anthropic");
  const upstreamUrl = buildUpstreamUrl(baseUrl, path, "anthropic");
  const timeoutSeconds =
    channel.timeout_seconds ?? deps.upstreamTimeoutSeconds ?? DEFAULT_UPSTREAM_TIMEOUT_SECONDS;

  let selected;
  try {
    selected = deps.transport.select(
      { channel_id: channel.id, use_upstream_proxy: account.use_upstream_proxy },
      readGlobalProxySettings(deps),
      upstreamUrl,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error_message = `files_api_transport_error: ${message}`;
    log.route_reason = "files_api_transport_error";
    recordRequestLog(deps.storage, log);
    throw error;
  }

  const upstreamHeaders = applyRequestHeaders(
    headers,
    account.api_key,
    channelAuthStrategy(channel, "anthropic"),
  );
  log.channel_id = channel.id;
  log.channel_name = channel.name;
  log.account_id = account.id;
  log.account_name = account.name;
  log.upstream_url = upstreamUrl;
  log.upstream_proxy_used = selected.proxyUsed;

  const startedAt = Date.now();
  let upstream: UpstreamResponse;
  try {
    upstream = await deps.transport.execute({
      method,
      url: upstreamUrl,
      headers: upstreamHeaders,
      body: bodyBytes,
      dispatcher: selected.dispatcher,
      timeoutSeconds,
      timeoutPhase: "Files API 响应头",
      retryConnect: selected.retryConnect,
      channelId: channel.id,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error_message = `files_api_transport_error: ${message}`;
    log.route_reason = "files_api_transport_error";
    log.duration_ms = elapsedMs(startedAt);
    recordRequestLog(deps.storage, log);
    throw error;
  }

  const status = upstream.statusCode;
  const ttfbMs = elapsedMs(startedAt);
  const responseBody = await readBodyWithTimeout(upstream.body, timeoutSeconds);
  log.status = status;
  log.ttfb_ms = ttfbMs;
  log.duration_ms = elapsedMs(startedAt);
  log.res_headers_json = captureHeaders(upstream.headers, capture, false);
  log.res_body_b64 = captureResponseBody(
    responseBody,
    contentEncodingValue(upstream.headers),
    capture,
  );
  // 上游状态一律原样透传：客户端依赖错误原文做配额自愈。
  if (status < 200 || status >= 300) {
    log.error_message = `files_api_upstream_status_${status}`;
    log.route_reason = "upstream_error";
  }
  recordRequestLog(deps.storage, log);

  const outgoing: Record<string, HeaderValue> = { ...copyResponseHeaders(upstream.headers) };
  addCorsHeaders(outgoing);
  res.writeHead(status, outgoing);
  res.end(responseBody);
}