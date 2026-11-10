// 请求日志 / 用量记录的读写 SQL 层。
//
// 逐条对照 src-tauri/src/core/storage_usage.rs：
// - list_request_logs_page：筛选条件、汇总口径、列表 SQL 与 Rust 完全一致；
// - list_request_logs_by_request_id：按 attempt_seq/created_at 升序取全部 attempt；
// - insert_request_log / update_request_log_timing。
//
// 捕获帧（`.flcap`）MVP 不实现：req/res body 直接落 request_logs 列，capture_state 来自
// request_capture_refs（旧库/Rust 写入的行仍可读状态，但不 hydrate 外置帧内容）。
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { JsonRow } from "../types.ts";

export const LOG_FILTER_CLIENT_UNKNOWN = "__unknown__";

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

function reqNum(value: unknown): number {
  return Number(value ?? 0);
}

function bool(value: unknown): boolean {
  return Number(value) !== 0;
}

function captureState(db: DatabaseSync, logId: string): { state: string | null; reason: string | null } {
  const row = db
    .prepare(
      "SELECT state, failure_reason FROM request_capture_refs WHERE request_log_id = ?1",
    )
    .get(logId) as { state?: string; failure_reason?: string | null } | undefined;
  if (!row) return { state: null, reason: null };
  return { state: row.state ?? null, reason: row.failure_reason ?? null };
}

interface BaseRowOptions {
  /** 列表查询不返回四个大字段（Rust 同）。 */
  includeBodies: boolean;
}

function requestLogRow(
  db: DatabaseSync,
  row: Record<string, unknown>,
  columns: Record<string, boolean>,
  options: BaseRowOptions,
): JsonRow {
  const result: JsonRow = {
    id: String(row.id),
    request_id: String(row.request_id),
    client_id: row.client_id ?? null,
    client_name: row.client_name ?? null,
    channel_id: row.channel_id ?? null,
    channel_name: row.channel_name ?? null,
    account_id: row.account_id ?? null,
    account_name: row.account_name ?? null,
    client_protocol: String(row.client_protocol ?? "openai"),
    upstream_protocol: String(row.upstream_protocol ?? "openai"),
    virtual_model: row.virtual_model ?? null,
    public_model: row.public_model ?? null,
    upstream_model: row.upstream_model ?? null,
    request_type: String(row.request_type ?? "unknown"),
    method: String(row.method ?? ""),
    path: String(row.path ?? ""),
    upstream_url: row.upstream_url ?? null,
    upstream_proxy_used:
      row.upstream_proxy_used === null || row.upstream_proxy_used === undefined
        ? null
        : bool(row.upstream_proxy_used),
    status: num(row.status),
    latency_ms: num(row.latency_ms),
    is_stream: bool(row.is_stream),
    error_message: row.error_message ?? null,
    fallback_count: reqNum(row.fallback_count),
    route_reason: row.route_reason ?? null,
    created_at: String(row.created_at ?? ""),
    ttfb_ms: num(row.ttfb_ms),
    ttft_ms: num(row.ttft_ms),
    duration_ms: num(row.duration_ms),
    attempt_seq: reqNum(row.attempt_seq),
    req_headers_json: row.req_headers_json ?? null,
    req_body_b64: options.includeBodies ? (row.req_body_b64 ?? null) : null,
    req_body_cleared_at: row.req_body_cleared_at ?? null,
    req_body_cleanup_reason: row.req_body_cleanup_reason ?? null,
    res_headers_json: row.res_headers_json ?? null,
    res_body_b64: options.includeBodies ? (row.res_body_b64 ?? null) : null,
    res_body_cleared_at: row.res_body_cleared_at ?? null,
    res_body_cleanup_reason: row.res_body_cleanup_reason ?? null,
    capture_state: null,
    capture_failure_reason: null,
    is_last_attempt: bool(row.is_last_attempt),
    input_tokens: columns.input_tokens ? num(row.input_tokens) : null,
    input_cached_tokens: columns.input_cached_tokens ? num(row.input_cached_tokens) : null,
    input_uncached_tokens: columns.input_uncached_tokens ? num(row.input_uncached_tokens) : null,
    output_tokens: columns.output_tokens ? num(row.output_tokens) : null,
    total_tokens: columns.total_tokens ? num(row.total_tokens) : null,
    estimated_cost: columns.estimated_cost ? num(row.estimated_cost) : null,
    estimated_input_uncached_cost: columns.estimated_input_uncached_cost
      ? num(row.estimated_input_uncached_cost)
      : null,
    estimated_input_cached_cost: columns.estimated_input_cached_cost
      ? num(row.estimated_input_cached_cost)
      : null,
    estimated_input_cache_write_cost: columns.estimated_input_cache_write_cost
      ? num(row.estimated_input_cache_write_cost)
      : null,
    estimated_output_cost: columns.estimated_output_cost ? num(row.estimated_output_cost) : null,
    agent_type: row.agent_type ?? null,
    agent_session_id: row.agent_session_id ?? null,
    parent_agent_session_id: row.parent_agent_session_id ?? null,
  };
  if (options.includeBodies) {
    const capture = captureState(db, result.id as string);
    result.capture_state = capture.state;
    result.capture_failure_reason = capture.reason;
  }
  return result;
}

const LIST_COLUMNS = {
  input_tokens: true,
  input_cached_tokens: true,
  input_uncached_tokens: true,
  output_tokens: true,
  total_tokens: true,
  estimated_cost: true,
  estimated_input_uncached_cost: true,
  estimated_input_cached_cost: true,
  estimated_input_cache_write_cost: true,
  estimated_output_cost: true,
};

/** Rust list_request_logs_page（分页 + 筛选 + 汇总）。 */
export function listRequestLogsPage(db: DatabaseSync, filter: JsonRow): JsonRow {
  const page = Math.max(1, Number(filter.page ?? 1));
  const pageSize = Math.min(200, Math.max(8, Number(filter.page_size ?? 50)));
  const status: string = String(filter.status ?? "");
  const clientId: string = String(filter.client_id ?? "");
  const channelId: string = String(filter.channel_id ?? "");
  const search: string = String(filter.search ?? "");
  const timeRange: string = String(filter.time_range ?? "");
  const model: string = String(filter.model ?? "");
  const modelKind: string = String(filter.model_kind ?? "");
  const startAt: string = String(filter.start_at ?? "");
  const endAt: string = String(filter.end_at ?? "");
  const tokenStatus: string = String(filter.token_status ?? "");

  const clauses: string[] = ["rl.is_last_attempt = 1"];
  const params: Array<string | number> = [];

  if (status === "success") {
    clauses.push("(rl.status >= 200 AND rl.status < 400 AND rl.error_message IS NULL)");
  } else if (status === "error") {
    clauses.push("(rl.status IS NULL OR rl.status >= 400 OR rl.error_message IS NOT NULL)");
  }

  if (clientId !== "") {
    if (clientId === LOG_FILTER_CLIENT_UNKNOWN) {
      clauses.push("rl.client_id IS NULL");
    } else {
      clauses.push("rl.client_id = ?");
      params.push(clientId);
    }
  }
  if (channelId !== "") {
    clauses.push("rl.channel_id = ?");
    params.push(channelId);
  }
  if (model !== "") {
    if (modelKind === "public") {
      clauses.push("COALESCE(rl.public_model, rl.virtual_model) = ?");
      params.push(model);
    } else if (modelKind === "upstream") {
      clauses.push("rl.upstream_model = ?");
      params.push(model);
    } else {
      clauses.push("(COALESCE(rl.public_model, rl.virtual_model) = ? OR rl.upstream_model = ?)");
      params.push(model, model);
    }
  }
  if (timeRange === "1h") {
    clauses.push("rl.created_at >= datetime('now', '-1 hour')");
  } else if (timeRange === "6h") {
    clauses.push("rl.created_at >= datetime('now', '-6 hours')");
  } else if (timeRange === "today") {
    clauses.push("rl.created_at >= datetime('now', 'localtime', 'start of day', 'utc')");
  } else if (timeRange === "7d") {
    clauses.push("rl.created_at >= datetime('now', '-7 days')");
  }
  if (startAt !== "") {
    clauses.push("rl.created_at >= datetime(?)");
    params.push(startAt);
  }
  if (endAt !== "") {
    clauses.push("rl.created_at < datetime(?)");
    params.push(endAt);
  }
  if (tokenStatus === "unknown") {
    clauses.push("ur.total_tokens IS NULL");
  }
  if (search !== "") {
    const like = `%${search}%`;
    clauses.push(
      `(rl.path LIKE ? OR rl.request_id = ? OR rl.error_message LIKE ?
        OR COALESCE(rl.public_model, rl.virtual_model, '') LIKE ?
        OR COALESCE(ca.name, rl.account_name, rl.account_id, '') LIKE ?
        OR COALESCE(rl.agent_session_id, '') LIKE ?)`,
    );
    params.push(like, search, like, like, like, like);
  }

  const whereSql = `WHERE ${clauses.join(" AND ")}`;
  const summarySql = `
    SELECT
        COUNT(*) AS request_count,
        COALESCE(SUM(CASE WHEN rl.status >= 200 AND rl.status < 400 AND rl.error_message IS NULL THEN 1 ELSE 0 END), 0) AS success_count,
        COALESCE(SUM(CASE WHEN rl.status IS NULL OR rl.status >= 400 OR rl.error_message IS NOT NULL THEN 1 ELSE 0 END), 0) AS error_count,
        AVG(COALESCE(rl.duration_ms, rl.latency_ms)) AS average_duration_ms,
        AVG(rl.ttft_ms) AS average_ttft_ms,
        AVG(CASE
            WHEN ur.output_tokens IS NOT NULL
             AND rl.ttft_ms IS NOT NULL
             AND rl.duration_ms > rl.ttft_ms
            THEN 1000.0 * ur.output_tokens / (rl.duration_ms - rl.ttft_ms)
        END) AS average_output_tokens_per_second,
        COALESCE(SUM(COALESCE(ur.total_tokens, ur.input_tokens + ur.output_tokens)), 0) AS known_tokens,
        COALESCE(SUM(ur.input_tokens), 0) AS input_tokens,
        COALESCE(SUM(ur.input_cached_tokens), 0) AS input_cached_tokens,
        COALESCE(SUM(ur.input_uncached_tokens), 0) AS input_uncached_tokens,
        CASE
            WHEN SUM(CASE WHEN ur.input_cached_tokens IS NOT NULL THEN ur.input_tokens ELSE 0 END) > 0
            THEN 1.0 * SUM(ur.input_cached_tokens)
                 / SUM(CASE WHEN ur.input_cached_tokens IS NOT NULL THEN ur.input_tokens ELSE 0 END)
        END AS cache_hit_rate,
        COALESCE(SUM(ur.estimated_cost), 0) AS estimated_cost
    FROM request_logs rl
    LEFT JOIN usage_records ur ON ur.request_id = rl.request_id
    LEFT JOIN channel_accounts ca ON ca.id = rl.account_id
    ${whereSql}
  `;
  const summaryRow = db.prepare(summarySql).get(...params) as Record<string, unknown> | undefined;
  const requestCount = reqNum(summaryRow?.request_count);
  const summary: JsonRow = {
    requestCount,
    successCount: reqNum(summaryRow?.success_count),
    errorCount: reqNum(summaryRow?.error_count),
    averageDurationMs: num(summaryRow?.average_duration_ms),
    averageTtftMs: num(summaryRow?.average_ttft_ms),
    averageOutputTokensPerSecond: num(summaryRow?.average_output_tokens_per_second),
    knownTokens: reqNum(summaryRow?.known_tokens),
    inputTokens: reqNum(summaryRow?.input_tokens),
    inputCachedTokens: reqNum(summaryRow?.input_cached_tokens),
    inputUncachedTokens: reqNum(summaryRow?.input_uncached_tokens),
    cacheHitRate: num(summaryRow?.cache_hit_rate),
    estimatedCost: reqNum(summaryRow?.estimated_cost),
  };

  const offset = (page - 1) * pageSize;
  const listSql = `
    SELECT
        rl.id, rl.request_id, rl.client_id, rl.client_name, rl.channel_id, rl.channel_name,
        rl.account_id, COALESCE(ca.name, rl.account_name) AS account_name, rl.client_protocol, rl.upstream_protocol,
        rl.virtual_model, rl.public_model, rl.upstream_model, rl.request_type, rl.method, rl.path,
        rl.status, rl.latency_ms, rl.is_stream, rl.error_message, rl.fallback_count,
        rl.route_reason, rl.created_at,
        rl.ttfb_ms, rl.duration_ms, rl.attempt_seq,
        rl.is_last_attempt,
        ur.input_tokens, ur.output_tokens,
        COALESCE(ur.total_tokens, ur.input_tokens + ur.output_tokens) AS total_tokens,
        ur.estimated_cost,
        ur.estimated_input_uncached_cost, ur.estimated_input_cached_cost,
        ur.estimated_input_cache_write_cost, ur.estimated_output_cost,
        rl.ttft_ms, ur.input_cached_tokens, ur.input_uncached_tokens, rl.upstream_url,
        rl.agent_type, rl.agent_session_id, rl.parent_agent_session_id, rl.upstream_proxy_used
    FROM request_logs rl
    LEFT JOIN usage_records ur ON ur.request_id = rl.request_id
    LEFT JOIN channel_accounts ca ON ca.id = rl.account_id
    ${whereSql}
    ORDER BY rl.created_at DESC
    LIMIT ? OFFSET ?
  `;
  const rows = db.prepare(listSql).all(...params, pageSize, offset) as Array<Record<string, unknown>>;
  const logRows = rows.map((row) =>
    requestLogRow(db, row, LIST_COLUMNS, { includeBodies: false }),
  );
  return { rows: logRows, total: requestCount, page, pageSize, summary };
}

/** Rust list_request_logs_by_request_id（详情抽屉：全部 attempt + 完整 body）。 */
export function listRequestLogsByRequestId(db: DatabaseSync, requestId: string): JsonRow[] {
  const rows = db
    .prepare(
      `SELECT
          rl.id, rl.request_id, rl.client_id, rl.client_name, rl.channel_id, rl.channel_name,
          rl.account_id, COALESCE(ca.name, rl.account_name) AS account_name, rl.client_protocol, rl.upstream_protocol,
          rl.virtual_model, rl.public_model, rl.upstream_model, rl.request_type, rl.method, rl.path,
          rl.status, rl.latency_ms, rl.is_stream, rl.error_message, rl.fallback_count,
          rl.route_reason, rl.created_at,
          rl.ttfb_ms, rl.duration_ms, rl.attempt_seq,
          rl.req_headers_json, rl.req_body_b64, rl.req_body_cleared_at, rl.req_body_cleanup_reason,
          rl.res_headers_json, rl.res_body_b64, rl.res_body_cleared_at, rl.res_body_cleanup_reason,
          rl.is_last_attempt,
          ur.input_tokens, ur.output_tokens,
          COALESCE(ur.total_tokens, ur.input_tokens + ur.output_tokens) AS total_tokens,
          ur.estimated_cost,
          ur.estimated_input_uncached_cost, ur.estimated_input_cached_cost,
          ur.estimated_input_cache_write_cost, ur.estimated_output_cost,
          rl.ttft_ms, ur.input_cached_tokens, ur.input_uncached_tokens, rl.upstream_url,
          rl.agent_type, rl.agent_session_id, rl.parent_agent_session_id, rl.upstream_proxy_used
       FROM request_logs rl
       LEFT JOIN usage_records ur ON ur.request_id = rl.request_id
       LEFT JOIN channel_accounts ca ON ca.id = rl.account_id
       WHERE rl.request_id = ?1
       ORDER BY rl.attempt_seq ASC, rl.created_at ASC`,
    )
    .all(requestId) as Array<Record<string, unknown>>;
  return rows.map((row) => requestLogRow(db, row, LIST_COLUMNS, { includeBodies: true }));
}

/** Rust list_request_log_clients（筛选项：未知客户端用空 id + "未知"）。 */
export function listRequestLogClients(db: DatabaseSync): JsonRow[] {
  const rows = db
    .prepare(
      `SELECT COALESCE(client_id, '') AS client_id, COALESCE(client_name, '未知') AS client_name
       FROM request_logs
       WHERE is_last_attempt = 1
       GROUP BY COALESCE(client_id, ''), COALESCE(client_name, '未知')
       ORDER BY client_name = '未知', client_name, client_id`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((row) => ({ id: String(row.client_id), name: String(row.client_name) }));
}

/** Rust list_request_log_models（camelCase：public_models / upstream_models）。 */
export function listRequestLogModels(db: DatabaseSync): JsonRow {
  const publicModels = (
    db
      .prepare(
        `SELECT COALESCE(public_model, virtual_model) AS model
         FROM request_logs
         WHERE is_last_attempt = 1
           AND COALESCE(public_model, virtual_model, '') <> ''
         GROUP BY COALESCE(public_model, virtual_model)
         ORDER BY model`,
      )
      .all() as Array<Record<string, unknown>>
  ).map((row) => String(row.model));
  const upstreamModels = (
    db
      .prepare(
        `SELECT upstream_model AS model
         FROM request_logs
         WHERE is_last_attempt = 1
           AND upstream_model IS NOT NULL
           AND upstream_model <> ''
         GROUP BY upstream_model
         ORDER BY model`,
      )
      .all() as Array<Record<string, unknown>>
  ).map((row) => String(row.model));
  return { publicModels, upstreamModels };
}

/** Rust insert_request_log：id 由 storage 生成，created_at = datetime('now')。 */
export function insertRequestLog(db: DatabaseSync, log: JsonRow): string {
  const requestLogId = randomUUID().replace(/-/g, "");
  db.prepare(
    `INSERT INTO request_logs (
        id, request_id, agent_type, agent_session_id, parent_agent_session_id,
        client_id, client_name, channel_id, channel_name,
        account_id, account_name, client_protocol, upstream_protocol,
        virtual_model, public_model, upstream_model, request_type, method, path,
        status, latency_ms, is_stream, error_message, fallback_count,
        route_reason, created_at,
        ttfb_ms, duration_ms, attempt_seq, req_headers_json, req_body_b64,
        res_headers_json, res_body_b64, is_last_attempt, upstream_url, upstream_proxy_used
    ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
        ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, datetime('now'),
        ?26, ?27, ?28, ?29, ?30, ?31, ?32, ?33, ?34, ?35
    )`,
  ).run(
    requestLogId,
    String(log.request_id ?? ""),
    log.agent_type ?? null,
    log.agent_session_id ?? null,
    log.parent_agent_session_id ?? null,
    log.client_id ?? null,
    log.client_name ?? null,
    log.channel_id ?? null,
    log.channel_name ?? null,
    log.account_id ?? null,
    log.account_name ?? null,
    String(log.client_protocol ?? "openai"),
    String(log.upstream_protocol ?? "openai"),
    log.virtual_model ?? null,
    log.public_model ?? null,
    log.upstream_model ?? null,
    String(log.request_type ?? "unknown"),
    String(log.method ?? ""),
    String(log.path ?? ""),
    log.status ?? null,
    log.latency_ms ?? null,
    log.is_stream ? 1 : 0,
    log.error_message ?? null,
    Number(log.fallback_count ?? 0),
    log.route_reason ?? null,
    log.ttfb_ms ?? null,
    log.duration_ms ?? null,
    Number(log.attempt_seq ?? 0),
    log.req_headers_json ?? null,
    log.req_body_b64 ?? null,
    log.res_headers_json ?? null,
    log.res_body_b64 ?? null,
    log.is_last_attempt === false ? 0 : 1,
    log.upstream_url ?? null,
    log.upstream_proxy_used === null || log.upstream_proxy_used === undefined
      ? null
      : log.upstream_proxy_used
        ? 1
        : 0,
  );
  return requestLogId;
}

/**
 * Rust update_request_log_timing：只更新最近一条 last_attempt + stream 的日志。
 * `patch` 支持 ttfb_ms / ttft_ms / duration_ms / res_headers_json / res_body_b64 /
 * error_message / route_reason；未传的键保持原值（= Rust 语义）。
 */
export function updateRequestLogTiming(db: DatabaseSync, requestId: string, patch: JsonRow): void {
  const has = (key: string): boolean => Object.prototype.hasOwnProperty.call(patch, key) && patch[key] !== undefined;
  const ttfbMs = has("ttfb_ms") ? Number(patch.ttfb_ms) : null;
  const ttftMs = has("ttft_ms") ? patch.ttft_ms : null;
  const durationMs = has("duration_ms") ? Number(patch.duration_ms) : null;
  const resHeadersJson = has("res_headers_json") ? patch.res_headers_json : null;
  const resBodyB64 = has("res_body_b64") ? patch.res_body_b64 : null;
  const errorMessage = has("error_message") ? patch.error_message : null;
  const routeReason = has("route_reason") ? patch.route_reason : null;

  db.prepare(
    `UPDATE request_logs
     SET ttfb_ms = COALESCE(?2, ttfb_ms),
         ttft_ms = COALESCE(?3, ttft_ms),
         duration_ms = COALESCE(?4, duration_ms),
         res_headers_json = COALESCE(?5, res_headers_json),
         res_body_b64 = CASE
             WHEN EXISTS (
                 SELECT 1 FROM request_capture_refs refs
                 WHERE refs.request_log_id = request_logs.id
             ) THEN NULL
             ELSE COALESCE(?6, res_body_b64)
         END,
         res_body_cleared_at = CASE WHEN ?6 IS NOT NULL THEN NULL ELSE res_body_cleared_at END,
         res_body_cleanup_reason = CASE WHEN ?6 IS NOT NULL THEN NULL ELSE res_body_cleanup_reason END,
         error_message = COALESCE(?7, error_message),
         route_reason = COALESCE(?8, route_reason)
     WHERE request_id = ?1
       AND is_last_attempt = 1
       AND is_stream = 1`,
  ).run(requestId, ttfbMs, ttftMs, durationMs, resHeadersJson, resBodyB64, errorMessage, routeReason);
}

/** Rust cleanup_old_logs：先清 Body 再删除两表，返回 (日志数, 用量数)。 */
export function cleanupOldLogs(
  db: DatabaseSync,
  keepDays: number,
  reason = "log_retention",
): [number, number] {
  const ids = (
    db
      .prepare(`SELECT id FROM request_logs WHERE created_at < datetime('now', '-${Math.trunc(keepDays)} days')`)
      .all() as Array<{ id: string }>
  ).map((row) => row.id);
  if (ids.length > 0) {
    const clear = db.prepare(
      `UPDATE request_logs
       SET req_body_cleared_at = CASE WHEN req_body_b64 IS NOT NULL THEN datetime('now') ELSE req_body_cleared_at END,
           req_body_cleanup_reason = CASE WHEN req_body_b64 IS NOT NULL THEN ?2 ELSE req_body_cleanup_reason END,
           res_body_cleared_at = CASE WHEN res_body_b64 IS NOT NULL THEN datetime('now') ELSE res_body_cleared_at END,
           res_body_cleanup_reason = CASE WHEN res_body_b64 IS NOT NULL THEN ?2 ELSE res_body_cleanup_reason END,
           req_body_b64 = NULL, res_body_b64 = NULL
       WHERE id = ?1 AND (req_body_b64 IS NOT NULL OR res_body_b64 IS NOT NULL)`,
    );
    for (const id of ids) clear.run(id, reason);
  }
  const deletedLogs = db
    .prepare(`DELETE FROM request_logs WHERE created_at < datetime('now', '-${Math.trunc(keepDays)} days')`)
    .run();
  const deletedUsage = db
    .prepare(`DELETE FROM usage_records WHERE created_at < datetime('now', '-${Math.trunc(keepDays)} days')`)
    .run();
  return [Number(deletedLogs.changes), Number(deletedUsage.changes)];
}