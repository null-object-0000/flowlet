// Agent 原生会话 / 用量存储层（Rust core/storage_usage.rs + storage_tasks.rs 的读路径）。
//
// Owner: desktop-observability。只做 SQL 与 JSON 解码：
// - `agent_session_snapshots` 是后台 Agent 数据同步写入的原生会话快照。桌面读路径
//   （用量页「原生用量」、会话详情摘要、成本账本探测）都从这里读，不重新解析完整会话。
// - `request_logs` 用于判定「该会话已经由 Flowlet 代理观测」，避免与 usage_records 重复统计。
//
// 字段命名：返回结构体方面，Rust `AgentNativeUsageSummaryRow` / `LogFilterClient`
// 分别是 camelCase / id+name，逐字段对齐。
import type { DatabaseSync } from "node:sqlite";
import type { JsonRow } from "../types.ts";

// ─── 会话客户端筛选项 ────────────────────────────────────────────────────────

/** Rust `LogFilterClient`（snake_case 结构体，字段就是 id/name）。 */
export interface LogFilterClient {
  id: string;
  name: string;
}

/** Rust `Storage::list_agent_session_clients`：只统计带会话标识的末次 attempt。 */
export function listAgentSessionClients(db: DatabaseSync): LogFilterClient[] {
  const rows = db
    .prepare(
      `SELECT COALESCE(client_id, '') AS id, COALESCE(MAX(client_name), '未知') AS display_name
       FROM request_logs
       WHERE is_last_attempt = 1
         AND agent_session_id IS NOT NULL
       GROUP BY COALESCE(client_id, '')
       ORDER BY display_name = '未知', display_name, client_id`,
    )
    .all() as JsonRow[];
  return rows.map((row) => ({ id: String(row.id ?? ""), name: String(row.display_name ?? "未知") }));
}

// ─── 原生用量汇总 ────────────────────────────────────────────────────────────

/** Rust `AgentSessionNativeUsage`（camelCase）。 */
export interface AgentSessionNativeUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  cost: number | null;
  costCurrency: string | null;
  apiEquivalent?: AgentSessionCostEstimate | null;
}

/** Rust `AgentSessionCostEstimate`（camelCase）。 */
export interface AgentSessionCostEstimate {
  amount: number | null;
  inputUncachedAmount?: number | null;
  inputCachedAmount?: number | null;
  inputCacheWriteAmount?: number | null;
  outputAmount?: number | null;
  currency: string | null;
  sourceUrl: string | null;
  priceVersion: string | null;
  pricedTurnCount: number;
  unpricedTurnCount: number;
}

/** Rust `AgentSessionNativeSummary`（camelCase）。 */
export interface AgentSessionNativeSummary {
  sourceAvailable: boolean;
  truncated: boolean;
  turnCount: number;
  usage: AgentSessionNativeUsage | null;
  models: string[];
}

/** Rust `AgentNativeUsageSummaryRow`（camelCase）。 */
export interface AgentNativeUsageSummaryRow {
  date: string;
  activityAt: string;
  agentType: string;
  sessionId: string;
  turnCount: number;
  models: string[];
  truncated: boolean;
  usage: AgentSessionNativeUsage | null;
}

function num(value: unknown): number {
  return Number(value ?? 0);
}

function optNum(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function optText(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** 解析 Rust serde 输出的 `AgentSessionNativeSummary`；失败返回 null（Rust 同样跳过坏行）。 */
export function parseNativeSummary(json: string | null): AgentSessionNativeSummary | null {
  if (json === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as JsonRow;
  const usageRaw = row.usage;
  let usage: AgentSessionNativeUsage | null = null;
  if (usageRaw !== null && usageRaw !== undefined && typeof usageRaw === "object") {
    const item = usageRaw as JsonRow;
    usage = {
      inputTokens: num(item.inputTokens),
      cachedInputTokens: num(item.cachedInputTokens),
      cacheWriteInputTokens: num(item.cacheWriteInputTokens),
      outputTokens: num(item.outputTokens),
      reasoningTokens: num(item.reasoningTokens),
      totalTokens: num(item.totalTokens),
      cost: optNum(item.cost),
      costCurrency: optText(item.costCurrency),
      apiEquivalent: null,
    };
  }
  return {
    sourceAvailable: row.sourceAvailable === true,
    truncated: row.truncated === true,
    turnCount: num(row.turnCount),
    usage,
    models: Array.isArray(row.models) ? row.models.filter((m): m is string => typeof m === "string") : [],
  };
}

/** Rust `native_usage_local_date`：RFC3339 → 本地日期，失败时回退前 10 个字符。 */
export function nativeUsageLocalDate(value: string): string | null {
  const parsed = Date.parse(value);
  if (!Number.isNaN(parsed)) {
    const date = new Date(parsed);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  return value.length >= 10 && value[4] === "-" ? value.slice(0, 10) : null;
}

/** 会话时间毫秒（Rust `agent_session_metadata::session_time_millis`）。 */
export function sessionTimeMillis(value: string): number {
  const rfc = Date.parse(value);
  if (!Number.isNaN(rfc)) return rfc;
  const naive = Date.parse(`${value.replace(" ", "T")}Z`);
  return Number.isNaN(naive) ? 0 : naive;
}

/** request_logs 中出现过会话归属标记的 (agent_type, session_id) 集合。 */
export function observedAgentSessionKeys(db: DatabaseSync): Set<string> {
  const rows = db
    .prepare(
      `SELECT DISTINCT agent_type, agent_session_id FROM request_logs
       WHERE agent_type IS NOT NULL AND agent_session_id IS NOT NULL`,
    )
    .all() as JsonRow[];
  const keys = new Set<string>();
  for (const row of rows) keys.add(`${String(row.agent_type)}\0${String(row.agent_session_id)}`);
  return keys;
}

interface SnapshotRow {
  agentType: string;
  sessionId: string;
  summaryJson: string;
  sessionJson: string | null;
  syncedAt: string;
}

function listSnapshotRows(db: DatabaseSync): SnapshotRow[] {
  const rows = db
    .prepare(
      `SELECT agent_type, session_id, summary_json, session_json, synced_at
       FROM agent_session_snapshots ORDER BY agent_type, session_id`,
    )
    .all() as JsonRow[];
  return rows.map((row) => ({
    agentType: String(row.agent_type),
    sessionId: String(row.session_id),
    summaryJson: String(row.summary_json ?? ""),
    sessionJson: optText(row.session_json),
    syncedAt: String(row.synced_at ?? ""),
  }));
}

function parseSessionRow(json: string | null): JsonRow | null {
  if (json === null) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JsonRow)
      : null;
  } catch {
    return null;
  }
}

/**
 * Rust `Storage::agent_native_usage_summary`（按快照读取的等价实现）。
 *
 * 数据来源是后台同步写入的 `agent_session_snapshots`；只取根会话、且未被 Flowlet
 * 代理观测过的会话。`date` 取最近活动日（本地时区）。
 *
 * 与 Rust 的差异（已在交付汇报中标注）：Rust 会先合并本机实时解析的原生会话目录；
 * 这里只读快照表，因此未执行过 `sync_agent_data` 的会话不会出现在结果里。
 */
export function agentNativeUsageSummary(db: DatabaseSync): AgentNativeUsageSummaryRow[] {
  const observed = observedAgentSessionKeys(db);
  const rows: AgentNativeUsageSummaryRow[] = [];
  for (const snapshot of listSnapshotRows(db)) {
    const key = `${snapshot.agentType}\0${snapshot.sessionId}`;
    if (observed.has(key)) continue;
    const summary = parseNativeSummary(snapshot.summaryJson);
    if (summary === null) continue;
    const session = parseSessionRow(snapshot.sessionJson);
    const parentSessionId =
      session !== null && typeof session.parentSessionId === "string"
        ? session.parentSessionId
        : null;
    if (parentSessionId !== null) continue;
    const nativeUpdatedAt =
      session !== null && typeof session.nativeUpdatedAt === "string"
        ? session.nativeUpdatedAt
        : null;
    const activityAt = nativeUpdatedAt ?? snapshot.syncedAt;
    const date = nativeUsageLocalDate(activityAt);
    if (date === null) continue;
    rows.push({
      date,
      activityAt,
      agentType: snapshot.agentType,
      sessionId: snapshot.sessionId,
      turnCount: summary.turnCount,
      models: summary.models,
      truncated: summary.truncated,
      usage: summary.usage,
    });
  }
  rows.sort((left, right) => {
    const byActivity = sessionTimeMillis(right.activityAt) - sessionTimeMillis(left.activityAt);
    if (byActivity !== 0) return byActivity;
    return right.sessionId.localeCompare(left.sessionId);
  });
  return rows;
}

// ─── 快照读写（sync_agent_data 用） ──────────────────────────────────────────

export interface AgentSessionSnapshot {
  agentType: string;
  sessionId: string;
  fingerprint: string;
  summaryJson: string;
  sessionJson: string;
  sourceOffset: number;
  parserVersion: number;
  usageIdsJson: string;
  cursorGuard: string;
  syncedAt: string;
}

/** 快照存在性与 fingerprint/parserVersion（Rust `needs_agent_snapshot_refresh` 输入）。 */
export function getAgentSnapshotMeta(
  db: DatabaseSync,
  agentType: string,
  sessionId: string,
): { fingerprint: string; parserVersion: number; summaryJson: string } | null {
  const row = db
    .prepare(
      `SELECT fingerprint, parser_version, summary_json FROM agent_session_snapshots
       WHERE agent_type=?1 AND session_id=?2`,
    )
    .get(agentType, sessionId) as JsonRow | undefined;
  if (row === undefined) return null;
  return {
    fingerprint: String(row.fingerprint ?? ""),
    parserVersion: num(row.parser_version),
    summaryJson: String(row.summary_json ?? ""),
  };
}

/** Rust `save_agent_snapshot`。 */
export function saveAgentSnapshot(db: DatabaseSync, snapshot: AgentSessionSnapshot): void {
  db.prepare(
    `INSERT INTO agent_session_snapshots
       (agent_type, session_id, fingerprint, summary_json, session_json, source_offset,
        parser_version, usage_ids_json, cursor_guard, synced_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, datetime('now'))
     ON CONFLICT(agent_type, session_id) DO UPDATE SET
       fingerprint=excluded.fingerprint,
       summary_json=excluded.summary_json,
       session_json=excluded.session_json,
       source_offset=excluded.source_offset,
       parser_version=excluded.parser_version,
       usage_ids_json=excluded.usage_ids_json,
       cursor_guard=excluded.cursor_guard,
       synced_at=excluded.synced_at`,
  ).run(
    snapshot.agentType,
    snapshot.sessionId,
    snapshot.fingerprint,
    snapshot.summaryJson,
    snapshot.sessionJson,
    snapshot.sourceOffset,
    snapshot.parserVersion,
    snapshot.usageIdsJson,
    snapshot.cursorGuard,
  );
}

/** Rust `mark_agent_snapshot_source_deleted`：把 source_available 改成 false。 */
export function markAgentSnapshotSourceDeleted(
  db: DatabaseSync,
  agentType: string,
  sessionId: string,
): void {
  const row = db
    .prepare(
      "SELECT summary_json FROM agent_session_snapshots WHERE agent_type=?1 AND session_id=?2",
    )
    .get(agentType, sessionId) as JsonRow | undefined;
  if (row === undefined) return;
  const summary = parseNativeSummary(String(row.summary_json ?? ""));
  if (summary === null) return;
  summary.sourceAvailable = false;
  db.prepare(
    "UPDATE agent_session_snapshots SET summary_json=?3 WHERE agent_type=?1 AND session_id=?2",
  ).run(agentType, sessionId, JSON.stringify(summary));
}

/** Rust `Storage::agent_session_snapshots`：全量快照键与 summary（同步 diff 用）。 */
export function listAgentSnapshotSummaries(
  db: DatabaseSync,
): Array<{ agentType: string; sessionId: string; summary: AgentSessionNativeSummary | null }> {
  return listSnapshotRows(db).map((row) => ({
    agentType: row.agentType,
    sessionId: row.sessionId,
    summary: parseNativeSummary(row.summaryJson),
  }));
}

/** 原生会话快照（成本账本探测用：含 session_json 的会话元数据）。 */
export function listAgentSnapshotDetails(db: DatabaseSync): Array<{
  agentType: string;
  sessionId: string;
  summary: AgentSessionNativeSummary | null;
  session: JsonRow | null;
  syncedAt: string;
}> {
  return listSnapshotRows(db).map((row) => ({
    agentType: row.agentType,
    sessionId: row.sessionId,
    summary: parseNativeSummary(row.summaryJson),
    session: parseSessionRow(row.sessionJson),
    syncedAt: row.syncedAt,
  }));
}

// ─── 消息级用量账本（agent_usage_events） ────────────────────────────────────

export interface AgentUsageEventRow {
  eventId: string;
  eventTime: string;
  model: string | null;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

/** Rust `save_agent_usage_events`：全量重解析先清旧行，增量解析只 INSERT OR IGNORE。 */
export function saveAgentUsageEvents(
  db: DatabaseSync,
  agentType: string,
  sessionId: string,
  events: AgentUsageEventRow[],
  incremental: boolean,
): void {
  if (!incremental) {
    db.prepare("DELETE FROM agent_usage_events WHERE agent_type=?1 AND session_id=?2").run(
      agentType,
      sessionId,
    );
  }
  const statement = db.prepare(
    `INSERT OR IGNORE INTO agent_usage_events (
       agent_type, session_id, event_id, event_time, model,
       input_tokens, cached_input_tokens, cache_write_input_tokens,
       output_tokens, reasoning_tokens, total_tokens, synced_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, datetime('now'))`,
  );
  for (const event of events) {
    statement.run(
      agentType,
      sessionId,
      event.eventId,
      event.eventTime,
      event.model,
      event.inputTokens,
      event.cachedInputTokens,
      event.cacheWriteInputTokens,
      event.outputTokens,
      event.reasoningTokens,
      event.totalTokens,
    );
  }
}

/** Rust `Storage::delete_agent_usage_events`。 */
export function deleteAgentUsageEvents(
  db: DatabaseSync,
  agentType: string,
  sessionId: string,
): void {
  db.prepare("DELETE FROM agent_usage_events WHERE agent_type=?1 AND session_id=?2").run(
    agentType,
    sessionId,
  );
}

// ─── 成本账本：网关探测快照（Rust `cost_ledger_gateway_probe_snapshot`） ──────

export interface GatewayUsageSample {
  requestId: string;
  agentType: string | null;
  sessionId: string | null;
  parentSessionId: string | null;
  clientId: string | null;
  accountId: string | null;
  model: string | null;
  occurredAt: string;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  uncachedInputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  estimatedCost: number | null;
  status: number | null;
  errorMessage: string | null;
}

export interface GatewayProbeSnapshot {
  recordCount: number;
  timeRangeStart: string | null;
  timeRangeEnd: string | null;
  samples: GatewayUsageSample[];
}

/** 网关 SQLite 数据源探测：只读末次 attempt + 最新一条 usage_records。 */
export function costLedgerGatewayProbeSnapshot(
  db: DatabaseSync,
  sampleLimit: number,
): GatewayProbeSnapshot {
  const head = db
    .prepare(
      `SELECT COUNT(*) AS total, MIN(created_at) AS range_start, MAX(created_at) AS range_end
       FROM request_logs WHERE is_last_attempt = 1`,
    )
    .get() as JsonRow | undefined;
  const rows = db
    .prepare(
      `SELECT
          rl.request_id, rl.agent_type, rl.agent_session_id,
          rl.parent_agent_session_id, rl.client_id, rl.account_id,
          rl.upstream_model, rl.created_at,
          ur.input_tokens, ur.input_cached_tokens, ur.input_uncached_tokens,
          ur.output_tokens, ur.total_tokens, ur.estimated_cost,
          rl.status, rl.error_message
       FROM request_logs rl
       LEFT JOIN usage_records ur ON ur.id = (
         SELECT ur2.id FROM usage_records ur2
         WHERE ur2.request_id = rl.request_id
         ORDER BY ur2.analyzed_at DESC, ur2.created_at DESC, ur2.id DESC
         LIMIT 1
       )
       WHERE rl.is_last_attempt = 1
       ORDER BY rl.created_at DESC, rl.request_id DESC
       LIMIT ?1`,
    )
    .all(sampleLimit) as JsonRow[];
  return {
    recordCount: num(head?.total),
    timeRangeStart: optText(head?.range_start),
    timeRangeEnd: optText(head?.range_end),
    samples: rows.map((row) => ({
      requestId: String(row.request_id),
      agentType: optText(row.agent_type),
      sessionId: optText(row.agent_session_id),
      parentSessionId: optText(row.parent_agent_session_id),
      clientId: optText(row.client_id),
      accountId: optText(row.account_id),
      model: optText(row.upstream_model),
      occurredAt: String(row.created_at ?? ""),
      inputTokens: optNum(row.input_tokens),
      cachedInputTokens: optNum(row.input_cached_tokens),
      uncachedInputTokens: optNum(row.input_uncached_tokens),
      outputTokens: optNum(row.output_tokens),
      totalTokens: optNum(row.total_tokens),
      estimatedCost: optNum(row.estimated_cost),
      status: optNum(row.status),
      errorMessage: optText(row.error_message),
    })),
  };
}