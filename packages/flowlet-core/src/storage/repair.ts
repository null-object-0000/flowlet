// 数据完整性检查：捕获体重新解析 / 未知用量占位 / 费用重算。
//
// 权威实现：`src-tauri/src/core/storage_usage.rs` 的 `reanalyze_captured_usage` /
// `analyze_unknown_usage` / `recalculate_usage_costs`；捕获体解析语义见
// `src-tauri/src/core/usage.rs`（`extract_captured_stream_usage` / `extract_response_usage`）。
//
// Node 侧只有一条连接、没有 Rust 的连接锁，但保持同一顺序意图：逐行读取捕获帧、base64
// 解码、SSE/JSON 解析全部在事务外完成（Rust 注释：避免长时间持锁阻塞请求写入端，且
// insert_request_log 是先取捕获写锁再取连接锁，反向持锁会死锁）；只有最终落库放进单个
// 事务批量提交，避免逐行自动提交引发大量 fsync 导致前端卡顿。
import type { DatabaseSync } from "node:sqlite";
import {
  extractResponseUsage,
  extractSseResponseUsage,
  type ResponseUsage,
} from "../proxy/usage.ts";
import type { RequestCaptureStore } from "./capture-store.ts";
import { readCaptureRecord } from "./maintenance.ts";
import type { ModelPrice } from "./prices.ts";
import { estimateCostAt } from "./usage.ts";

/** Rust `repair_time_clause`：窗口过滤 SQL 片段（`today` 按本地自然日，其余按 UTC 相对时长）。 */
function repairTimeClause(column: string, timeRange: string): string {
  switch (timeRange) {
    case "1h":
      return `datetime(${column}) >= datetime('now', '-1 hour')`;
    case "6h":
      return `datetime(${column}) >= datetime('now', '-6 hours')`;
    case "today":
      return `datetime(${column}, 'localtime') >= datetime('now', 'localtime', 'start of day')`;
    case "7d":
      return `datetime(${column}) >= datetime('now', '-7 days')`;
    default:
      return "1 = 1";
  }
}

const RFC3339_PREFIX = /^\d{4}-\d{2}-\d{2}T/;

/**
 * Rust `parse_cost_timestamp`：先按 RFC3339 解析，再按 SQLite `YYYY-MM-DD HH:MM:SS`（UTC）。
 * 解析失败返回 undefined（调用方省略 `atMs`，由 `estimateCostAt` 回退到当前时刻，与 Rust
 * `unwrap_or_else(Utc::now)` 一致）。
 */
function costTimestampMs(value: unknown): number | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  if (RFC3339_PREFIX.test(value)) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  const naive = Date.parse(`${value.replace(" ", "T")}Z`);
  return Number.isNaN(naive) ? undefined : naive;
}

/** 捕获体 base64 → bytes（捕获体写入时已按 content-encoding 解压，这里直接解码）。 */
function decodeCapturedBody(bodyB64: string): Buffer | null {
  try {
    const decoded = Buffer.from(bodyB64, "base64");
    // Buffer.from 对非法 base64 是宽松的：非空输入解出空 buffer 视为解码失败（Rust 会 continue）。
    return decoded.length === 0 && bodyB64.trim() !== "" ? null : decoded;
  } catch {
    return null;
  }
}

/**
 * Rust `extract_captured_stream_usage`：捕获体可能被历史大小上限截断，因此
 * 1. 先要求带终止标记（`[DONE]` / `message_stop`）的 SSE；
 * 2. 否则接受「有正 output_tokens」的宽松 SSE 解析（兼容不带终止标记的上游）；
 * 3. 最后回退按单条 JSON 响应解析（`text/event-stream` 但实际是单条 JSON）。
 * 只有 `message_start`（input 有值、output=0）的半条数据会被拒绝，留给 Agent 原生会话回退。
 */
function extractCapturedStreamUsage(body: Buffer): ResponseUsage | null {
  const strict = extractSseResponseUsage(body, true);
  if (strict !== null) return strict;
  const loose = extractSseResponseUsage(body, false);
  if (loose !== null && (loose.output_tokens ?? 0) > 0) return loose;
  return extractResponseUsage(body);
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

interface CapturedUsageRow {
  request_log_id: string;
  request_id: string;
  client_id: string | null;
  client_name: string | null;
  channel_id: string | null;
  channel_name: string | null;
  account_id: string | null;
  account_name: string | null;
  client_protocol: string;
  upstream_protocol: string;
  virtual_model: string | null;
  upstream_model: string | null;
  created_at: string;
  is_stream: boolean;
  res_body_b64: string | null;
}

interface ParsedUsage {
  request_id: string;
  client_id: string | null;
  client_name: string | null;
  channel_id: string | null;
  channel_name: string | null;
  account_id: string | null;
  account_name: string | null;
  client_protocol: string;
  upstream_protocol: string;
  virtual_model: string | null;
  upstream_model: string | null;
  created_at: string;
  input_tokens: number | null;
  input_cached_tokens: number | null;
  input_uncached_tokens: number | null;
  input_cache_write_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  estimated_cost: number | null;
  estimated_input_uncached_cost: number | null;
  estimated_input_cached_cost: number | null;
  estimated_input_cache_write_cost: number | null;
  estimated_output_cost: number | null;
}

/**
 * Rust `reanalyze_captured_usage`（命令名 `repair_captured_usage`）：重解析窗口内的响应体，
 * 回填/覆盖 usage_records。返回写入条数。
 *
 * - 只扫 `is_last_attempt = 1` 且（内联 `res_body_b64` 非空 或 捕获帧 `state='ready'` 且
 *   `res_body_bytes > 0`）的日志；排除 `count_tokens` 与 Files API（它们不是模型推理）。
 * - 日志列没有体内联副本时用 `captureStore` 读捕获帧（等价 Rust `read_request_capture`）。
 * - 已有 usage 行按 request_id UPDATE（金额/用量/元数据全部覆盖），没有则 INSERT；
 *   `created_at` 一律沿用请求日志的原始时间（Rust 明确要求，否则历史记录会落到修复当天）。
 */
export function repairCapturedUsage(
  db: DatabaseSync,
  prices: ModelPrice[],
  captureStore: RequestCaptureStore,
  timeRange: string,
): number {
  const rows = db
    .prepare(
      `SELECT
          rl.id, rl.request_id, rl.client_id, rl.client_name,
          rl.channel_id, rl.channel_name, rl.account_id, rl.account_name,
          rl.client_protocol, rl.upstream_protocol,
          rl.virtual_model, rl.upstream_model, rl.created_at,
          rl.is_stream, rl.res_body_b64
       FROM request_logs rl
       LEFT JOIN request_capture_refs refs ON refs.request_log_id = rl.id
       WHERE rl.is_last_attempt = 1
         AND (rl.res_body_b64 IS NOT NULL OR (refs.state = 'ready' AND refs.res_body_bytes > 0))
         AND lower(rl.path) NOT LIKE '%/messages/count_tokens%'
         AND lower(rl.path) NOT LIKE '%/v1/files%'
         AND ${repairTimeClause("rl.created_at", timeRange)}`,
    )
    .all() as Array<Record<string, unknown>>;

  const parsedRows: ParsedUsage[] = [];
  for (const raw of rows) {
    const row: CapturedUsageRow = {
      request_log_id: String(raw.id),
      request_id: String(raw.request_id),
      client_id: nullableString(raw.client_id),
      client_name: nullableString(raw.client_name),
      channel_id: nullableString(raw.channel_id),
      channel_name: nullableString(raw.channel_name),
      account_id: nullableString(raw.account_id),
      account_name: nullableString(raw.account_name),
      client_protocol: String(raw.client_protocol ?? "openai"),
      upstream_protocol: String(raw.upstream_protocol ?? "openai"),
      virtual_model: nullableString(raw.virtual_model),
      upstream_model: nullableString(raw.upstream_model),
      created_at: String(raw.created_at ?? ""),
      is_stream: Number(raw.is_stream ?? 0) !== 0,
      res_body_b64: nullableString(raw.res_body_b64),
    };

    // 日志列没有体内联副本（新数据统一外置）时从捕获帧读。
    if (row.res_body_b64 === null) {
      const record = readCaptureRecord(db, captureStore, row.request_log_id);
      row.res_body_b64 = record === null ? null : nullableString(record.res_body_b64);
    }
    if (row.res_body_b64 === null) continue;

    const body = decodeCapturedBody(row.res_body_b64);
    if (body === null) continue;

    const usage = row.is_stream ? extractCapturedStreamUsage(body) : extractResponseUsage(body);
    if (usage === null) continue;

    const atMs = costTimestampMs(row.created_at);
    // 费用按请求原始时间解析分时价格（Rust `parse_cost_timestamp(created_at)`）。
    const cost =
      atMs === undefined
        ? estimateCostAt(
            prices,
            row.channel_id,
            row.upstream_model,
            usage.input_tokens,
            usage.input_cached_tokens,
            usage.input_uncached_tokens,
            usage.input_cache_write_tokens,
            usage.output_tokens,
          )
        : estimateCostAt(
            prices,
            row.channel_id,
            row.upstream_model,
            usage.input_tokens,
            usage.input_cached_tokens,
            usage.input_uncached_tokens,
            usage.input_cache_write_tokens,
            usage.output_tokens,
            atMs,
          );
    parsedRows.push({
      request_id: row.request_id,
      client_id: row.client_id,
      client_name: row.client_name,
      channel_id: row.channel_id,
      channel_name: row.channel_name,
      account_id: row.account_id,
      account_name: row.account_name,
      client_protocol: row.client_protocol,
      upstream_protocol: row.upstream_protocol,
      virtual_model: row.virtual_model,
      upstream_model: row.upstream_model,
      created_at: row.created_at,
      input_tokens: usage.input_tokens,
      input_cached_tokens: usage.input_cached_tokens,
      input_uncached_tokens: usage.input_uncached_tokens,
      input_cache_write_tokens: usage.input_cache_write_tokens,
      output_tokens: usage.output_tokens,
      total_tokens: usage.total_tokens,
      estimated_cost: cost === null ? null : cost.total,
      estimated_input_uncached_cost: cost === null ? null : cost.input_uncached,
      estimated_input_cached_cost: cost === null ? null : cost.input_cached,
      estimated_input_cache_write_cost: cost === null ? null : cost.input_cache_write,
      estimated_output_cost: cost === null ? null : cost.output,
    });
  }

  const updateStatement = db.prepare(
    `UPDATE usage_records
     SET
         client_id = ?2,
         client_name = ?3,
         channel_id = ?4,
         channel_name = ?5,
         account_id = ?6,
         account_name = ?7,
         client_protocol = ?8,
         upstream_protocol = ?9,
         virtual_model = ?10,
         upstream_model = ?11,
         input_tokens = ?12,
         input_cached_tokens = ?13,
         input_uncached_tokens = ?14,
         input_cache_write_tokens = ?15,
         output_tokens = ?16,
         total_tokens = ?17,
         usage_status = 'complete',
         usage_source = 'captured_response',
         estimated_cost = ?18,
         estimated_input_uncached_cost = ?19,
         estimated_input_cached_cost = ?20,
         estimated_input_cache_write_cost = ?21,
         estimated_output_cost = ?22,
         created_at = ?23,
         analyzed_at = datetime('now')
     WHERE request_id = ?1`,
  );
  const insertStatement = db.prepare(
    `INSERT INTO usage_records (
         id, request_id, client_id, client_name, channel_id, channel_name,
         account_id, account_name, client_protocol, upstream_protocol,
         virtual_model, upstream_model, input_tokens, input_cached_tokens,
         input_uncached_tokens, input_cache_write_tokens, output_tokens, total_tokens,
         usage_status, usage_source,
         estimated_cost, estimated_input_uncached_cost, estimated_input_cached_cost,
         estimated_input_cache_write_cost, estimated_output_cost, analyzed_at, created_at
     ) VALUES (
         lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
         ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17,
         'complete', 'captured_response', ?18, ?19, ?20, ?21, ?22,
         datetime('now'), ?23
     )`,
  );

  db.exec("BEGIN");
  try {
    let parsed = 0;
    for (const row of parsedRows) {
      const params: Array<string | number | null> = [
        row.request_id,
        row.client_id,
        row.client_name,
        row.channel_id,
        row.channel_name,
        row.account_id,
        row.account_name,
        row.client_protocol,
        row.upstream_protocol,
        row.virtual_model,
        row.upstream_model,
        row.input_tokens,
        row.input_cached_tokens,
        row.input_uncached_tokens,
        row.input_cache_write_tokens,
        row.output_tokens,
        row.total_tokens,
        row.estimated_cost,
        row.estimated_input_uncached_cost,
        row.estimated_input_cached_cost,
        row.estimated_input_cache_write_cost,
        row.estimated_output_cost,
        row.created_at,
      ];
      const updated = updateStatement.run(...params);
      if (Number(updated.changes) === 0) insertStatement.run(...params);
      parsed += 1;
    }
    db.exec("COMMIT");
    return parsed;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Rust `analyze_unknown_usage`（命令名 `repair_unknown_usage`）：
 * 1. 删除窗口内 `count_tokens` 路径的 usage 行（只算上下文长度，不产生用量；旧版维护流程
 *    曾为它建「未知用量」占位，原生会话回填也可能误配相邻模型事件）；
 * 2. 为窗口内仍无 usage 的最终 attempt 插入占位行（token 全 NULL、
 *    `usage_status='unknown'`、`usage_source='unknown_placeholder'`），排除 `count_tokens`
 *    与 Files API。返回「删除数 + 插入数」。
 */
export function repairUnknownUsage(db: DatabaseSync, timeRange: string): number {
  db.exec("BEGIN");
  try {
    const removed = db
      .prepare(
        `DELETE FROM usage_records
         WHERE EXISTS (
               SELECT 1 FROM request_logs
               WHERE request_logs.request_id = usage_records.request_id
                 AND request_logs.is_last_attempt = 1
                 AND lower(request_logs.path) LIKE '%/messages/count_tokens%'
                 AND ${repairTimeClause("request_logs.created_at", timeRange)}
           )`,
      )
      .run();
    const inserted = db
      .prepare(
        `INSERT INTO usage_records (
             id, request_id, client_id, client_name, channel_id, channel_name,
             account_id, account_name, client_protocol, upstream_protocol,
             virtual_model, upstream_model, input_tokens, input_cached_tokens,
             input_uncached_tokens, input_cache_write_tokens, output_tokens, total_tokens,
             usage_status, usage_source, estimated_cost, analyzed_at, created_at
         )
         SELECT
             lower(hex(randomblob(16))),
             request_logs.request_id,
             request_logs.client_id,
             request_logs.client_name,
             request_logs.channel_id,
             request_logs.channel_name,
             request_logs.account_id,
             request_logs.account_name,
             request_logs.client_protocol,
             request_logs.upstream_protocol,
             request_logs.virtual_model,
             request_logs.upstream_model,
             NULL, NULL, NULL, NULL, NULL, NULL,
             'unknown', 'unknown_placeholder', NULL,
             datetime('now'),
             datetime('now')
         FROM request_logs
         WHERE request_logs.is_last_attempt = 1
           AND ${repairTimeClause("request_logs.created_at", timeRange)}
           AND lower(request_logs.path) NOT LIKE '%/messages/count_tokens%'
           -- Files API 请求不是模型推理，没有 token 用量，不能生成「未知用量」占位行。
           AND lower(request_logs.path) NOT LIKE '%/v1/files%'
           AND NOT EXISTS (
               SELECT 1 FROM usage_records
               WHERE usage_records.request_id = request_logs.request_id
           )`,
      )
      .run();
    db.exec("COMMIT");
    return Number(removed.changes ?? 0) + Number(inserted.changes ?? 0);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

interface RecalcRow {
  request_id: string;
  channel_id: string | null;
  upstream_model: string | null;
  input_tokens: number | null;
  input_cached_tokens: number | null;
  input_uncached_tokens: number | null;
  input_cache_write_tokens: number | null;
  output_tokens: number | null;
  created_at: string;
}

/**
 * Rust `recalculate_usage_costs`（命令名 `repair_usage_costs`）：按当前价格表重算窗口内
 * usage 的 `estimated_*` 五列，返回更新行数。
 *
 * 与 Rust 逐条一致：只取 JOIN 到最终 attempt 且 `total_tokens IS NOT NULL` 的记录
 * （Rust 的边界就是这一列，不额外过滤 `usage_status`）；价格按请求 `created_at` 时刻的分时
 * 价格解析，无匹配价格时跳过该行（保留原值）。
 */
export function repairUsageCosts(
  db: DatabaseSync,
  prices: ModelPrice[],
  timeRange: string,
): number {
  const rows = db
    .prepare(
      `SELECT ur.request_id, ur.channel_id, ur.upstream_model, ur.input_tokens,
              ur.input_cached_tokens, ur.input_uncached_tokens, ur.input_cache_write_tokens,
              ur.output_tokens, rl.created_at
       FROM usage_records ur
       INNER JOIN request_logs rl ON rl.request_id = ur.request_id AND rl.is_last_attempt = 1
       WHERE ur.total_tokens IS NOT NULL
         AND ${repairTimeClause("rl.created_at", timeRange)}`,
    )
    .all() as Array<Record<string, unknown>>;

  const recalcRows: RecalcRow[] = rows.map((raw) => ({
    request_id: String(raw.request_id),
    channel_id: nullableString(raw.channel_id),
    upstream_model: nullableString(raw.upstream_model),
    input_tokens: nullableNumber(raw.input_tokens),
    input_cached_tokens: nullableNumber(raw.input_cached_tokens),
    input_uncached_tokens: nullableNumber(raw.input_uncached_tokens),
    input_cache_write_tokens: nullableNumber(raw.input_cache_write_tokens),
    output_tokens: nullableNumber(raw.output_tokens),
    created_at: String(raw.created_at ?? ""),
  }));

  const updateStatement = db.prepare(
    `UPDATE usage_records
     SET estimated_cost = ?2,
         estimated_input_uncached_cost = ?3,
         estimated_input_cached_cost = ?4,
         estimated_input_cache_write_cost = ?5,
         estimated_output_cost = ?6,
         analyzed_at = datetime('now')
     WHERE request_id = ?1`,
  );

  db.exec("BEGIN");
  try {
    let updated = 0;
    for (const row of recalcRows) {
      const atMs = costTimestampMs(row.created_at);
      const cost =
        atMs === undefined
          ? estimateCostAt(
              prices,
              row.channel_id,
              row.upstream_model,
              row.input_tokens,
              row.input_cached_tokens,
              row.input_uncached_tokens,
              row.input_cache_write_tokens,
              row.output_tokens,
            )
          : estimateCostAt(
              prices,
              row.channel_id,
              row.upstream_model,
              row.input_tokens,
              row.input_cached_tokens,
              row.input_uncached_tokens,
              row.input_cache_write_tokens,
              row.output_tokens,
              atMs,
            );
      if (cost === null) continue;
      const result = updateStatement.run(
        row.request_id,
        cost.total,
        cost.input_uncached,
        cost.input_cached,
        cost.input_cache_write,
        cost.output,
      );
      updated += Number(result.changes ?? 0);
    }
    db.exec("COMMIT");
    return updated;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}