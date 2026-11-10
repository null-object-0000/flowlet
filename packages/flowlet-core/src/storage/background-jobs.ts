// 后台任务存储层（Rust core/storage_tasks.rs 的 SQL 等价实现）。
//
// Owner: desktop-observability。只做 SQL 与行映射：
// - 表名 / 列名 / 排序 / clamp 范围逐句对照 Rust，字段命名 camelCase（与 Rust
//   `#[serde(rename_all = "camelCase")]` 输出一致）。
// - 所有函数签名 `(db: DatabaseSync, ...) => ...`，由命令层通过
//   `ctx.storage.withDatabase((db) => ...)` 调用，避免和其它领域争抢
//   `storage/index.ts` 的方法列表。
import type { DatabaseSync } from "node:sqlite";
import type { JsonRow } from "../types.ts";

/** Rust `BackgroundJobRow`（camelCase）。 */
export interface BackgroundJobRow {
  id: string;
  jobType: string;
  title: string;
  triggerSource: string;
  status: string;
  stage: string | null;
  progressCurrent: number;
  progressTotal: number;
  summaryJson: string | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
  cancelRequested: boolean;
}

/** Rust `BackgroundJobEvent`（camelCase）。 */
export interface BackgroundJobEvent {
  id: string;
  jobId: string;
  sequence: number;
  level: string;
  stage: string | null;
  message: string;
  detailJson: string | null;
  createdAt: string;
}

/** Rust `BackgroundJobDetail`（camelCase）。 */
export interface BackgroundJobDetail {
  job: BackgroundJobRow;
  events: BackgroundJobEvent[];
}

/** Rust `BackgroundJobsPage`（camelCase）。 */
export interface BackgroundJobsPage {
  rows: BackgroundJobRow[];
  total: number;
  page: number;
  pageSize: number;
}

/** Rust `CleanupBackgroundJobsResult`（camelCase）。 */
export interface CleanupBackgroundJobsResult {
  deletedJobs: number;
  deletedEvents: number;
}

/** Rust `AgentSourceSyncState`（camelCase）。 */
export interface AgentSourceSyncState {
  agentType: string;
  lastCheckedAt: string | null;
  lastSyncedAt: string | null;
  status: string;
  lastError: string | null;
  scannedCount: number;
  changedCount: number;
  failedCount: number;
}

/** Rust `AgentSyncStatusReport`（camelCase）。 */
export interface AgentSyncStatusReport {
  running: boolean;
  sources: AgentSourceSyncState[];
}

/**
 * Rust `BackgroundJobsFilter`（入参 snake_case，serde 反序列化）。
 * page / page_size 为必填（Rust 无 `#[serde(default)]`），其余缺省空串。
 */
export interface BackgroundJobsFilter {
  page: number;
  pageSize: number;
  status?: string;
  jobType?: string;
  triggerSource?: string;
}

const JOB_COLUMNS =
  "id, job_type, title, trigger_source, status, stage, progress_current, progress_total, summary_json, error_message, created_at, started_at, finished_at, updated_at, cancel_requested";

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function int(value: unknown): number {
  return Number(value ?? 0);
}

function mapJob(row: JsonRow): BackgroundJobRow {
  return {
    id: text(row.id),
    jobType: text(row.job_type),
    title: text(row.title),
    triggerSource: text(row.trigger_source),
    status: text(row.status),
    stage: nullableText(row.stage),
    progressCurrent: int(row.progress_current),
    progressTotal: int(row.progress_total),
    summaryJson: nullableText(row.summary_json),
    errorMessage: nullableText(row.error_message),
    createdAt: text(row.created_at),
    startedAt: nullableText(row.started_at),
    finishedAt: nullableText(row.finished_at),
    updatedAt: text(row.updated_at),
    cancelRequested: Number(row.cancel_requested ?? 0) !== 0,
  };
}

function mapEvent(row: JsonRow): BackgroundJobEvent {
  return {
    id: text(row.id),
    jobId: text(row.job_id),
    sequence: int(row.sequence),
    level: text(row.level),
    stage: nullableText(row.stage),
    message: text(row.message),
    detailJson: nullableText(row.detail_json),
    createdAt: text(row.created_at),
  };
}

/** Rust `Storage::list_background_jobs`：page>=1、page_size clamp(1,50)、created_at DESC。 */
export function listBackgroundJobs(
  db: DatabaseSync,
  filter: BackgroundJobsFilter,
): BackgroundJobsPage {
  const page = Math.max(1, filter.page);
  const pageSize = Math.min(50, Math.max(1, filter.pageSize));
  const offset = (page - 1) * pageSize;
  const status = (filter.status ?? "").trim();
  const jobType = (filter.jobType ?? "").trim();
  const triggerSource = (filter.triggerSource ?? "").trim();
  const total = int(
    db
      .prepare(
        `SELECT COUNT(*) AS total FROM background_jobs
         WHERE (?1 = '' OR status = ?1)
           AND (?2 = '' OR job_type = ?2)
           AND (?3 = '' OR trigger_source = ?3)`,
      )
      .get(status, jobType, triggerSource)?.total,
  );
  const rows = (
    db
      .prepare(
        `SELECT ${JOB_COLUMNS} FROM background_jobs
         WHERE (?1 = '' OR status = ?1)
           AND (?2 = '' OR job_type = ?2)
           AND (?3 = '' OR trigger_source = ?3)
         ORDER BY created_at DESC LIMIT ?4 OFFSET ?5`,
      )
      .all(status, jobType, triggerSource, pageSize, offset) as JsonRow[]
  ).map(mapJob);
  return { rows, total, page, pageSize };
}

/** Rust `Storage::get_background_job_detail`：任务不存在返回 null。 */
export function getBackgroundJobDetail(
  db: DatabaseSync,
  id: string,
): BackgroundJobDetail | null {
  const jobRow = db
    .prepare(`SELECT ${JOB_COLUMNS} FROM background_jobs WHERE id = ?1`)
    .get(id) as JsonRow | undefined;
  if (jobRow === undefined) return null;
  const events = (
    db
      .prepare(
        `SELECT id, job_id, sequence, level, stage, message, detail_json, created_at
         FROM background_job_events WHERE job_id = ?1 ORDER BY sequence`,
      )
      .all(id) as JsonRow[]
  ).map(mapEvent);
  return { job: mapJob(jobRow), events };
}

/**
 * Rust `Storage::request_background_job_cancel`：
 * 只标记 queued / running，写入 stage='正在取消'，返回是否有行被更新。
 */
export function requestBackgroundJobCancel(db: DatabaseSync, id: string): boolean {
  const result = db
    .prepare(
      `UPDATE background_jobs SET cancel_requested=1, stage='正在取消', updated_at=datetime('now')
       WHERE id=?1 AND status IN ('queued', 'running')`,
    )
    .run(id);
  return Number(result.changes ?? 0) > 0;
}

/** Rust `Storage::cleanup_background_jobs`：keep_days clamp(1,3650)，先事件后任务。 */
export function cleanupBackgroundJobs(
  db: DatabaseSync,
  keepDaysInput: number,
): CleanupBackgroundJobsResult {
  const keepDays = Math.min(3650, Math.max(1, keepDaysInput));
  const modifier = `-${keepDays} days`;
  const events = db
    .prepare(
      `DELETE FROM background_job_events WHERE job_id IN (
         SELECT id FROM background_jobs
         WHERE status NOT IN ('queued', 'running') AND created_at < datetime('now', ?1))`,
    )
    .run(modifier);
  const jobs = db
    .prepare(
      `DELETE FROM background_jobs
       WHERE status NOT IN ('queued', 'running') AND created_at < datetime('now', ?1)`,
    )
    .run(modifier);
  return {
    deletedJobs: Number(jobs.changes ?? 0),
    deletedEvents: Number(events.changes ?? 0),
  };
}

/** Rust `Storage::list_agent_source_sync_states`：ORDER BY agent_type。 */
export function listAgentSourceSyncStates(db: DatabaseSync): AgentSourceSyncState[] {
  const rows = db
    .prepare(
      `SELECT agent_type, last_checked_at, last_synced_at, status, last_error,
              scanned_count, changed_count, failed_count
       FROM agent_source_sync_state ORDER BY agent_type`,
    )
    .all() as JsonRow[];
  return rows.map((row) => ({
    agentType: text(row.agent_type),
    lastCheckedAt: nullableText(row.last_checked_at),
    lastSyncedAt: nullableText(row.last_synced_at),
    status: text(row.status),
    lastError: nullableText(row.last_error),
    scannedCount: int(row.scanned_count),
    changedCount: int(row.changed_count),
    failedCount: int(row.failed_count),
  }));
}

/**
 * Rust `Storage::create_job`：插入 running 任务与首条事件（sequence=1）。
 * `createdAt` 允许注入固定时间（Rust 用 datetime('now')；测试/同步链路需要可断言）。
 */
export function createJob(
  db: DatabaseSync,
  input: {
    id: string;
    jobType: string;
    title: string;
    stage: string;
    trigger: string;
    total: number;
    firstEventMessage: string;
    eventId: string;
  },
): void {
  db.prepare(
    `INSERT INTO background_jobs
       (id, job_type, title, trigger_source, status, stage, progress_total,
        created_at, started_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, 'running', ?5, ?6, datetime('now'), datetime('now'), datetime('now'))`,
  ).run(input.id, input.jobType, input.title, input.trigger, input.stage, input.total);
  db.prepare(
    `INSERT INTO background_job_events (id, job_id, sequence, level, stage, message, created_at)
     VALUES (?1, ?2, 1, 'info', ?3, ?4, datetime('now'))`,
  ).run(input.eventId, input.id, input.stage, input.firstEventMessage);
}

/** Rust `Storage::add_job_event`：sequence = MAX(sequence)+1。 */
export function addJobEvent(
  db: DatabaseSync,
  input: { eventId: string; jobId: string; level: string; stage: string; message: string },
): void {
  const seq = int(
    db
      .prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS seq FROM background_job_events WHERE job_id=?1")
      .get(input.jobId)?.seq,
  );
  db.prepare(
    `INSERT INTO background_job_events (id, job_id, sequence, level, stage, message, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now'))`,
  ).run(input.eventId, input.jobId, seq, input.level, input.stage, input.message);
}

/** Rust `Storage::update_job_progress`。 */
export function updateJobProgress(
  db: DatabaseSync,
  id: string,
  current: number,
  total: number,
): void {
  db.prepare(
    `UPDATE background_jobs SET progress_current=?2, progress_total=?3, updated_at=datetime('now')
     WHERE id=?1`,
  ).run(id, current, total);
}

/** Rust `Storage::is_job_cancel_requested`。 */
export function isJobCancelRequested(db: DatabaseSync, id: string): boolean {
  const row = db
    .prepare("SELECT cancel_requested FROM background_jobs WHERE id=?1")
    .get(id) as JsonRow | undefined;
  return Number(row?.cancel_requested ?? 0) !== 0;
}

/** Rust `Storage::finish_job`：status 决定 stage 与事件级别。 */
export function finishJob(
  db: DatabaseSync,
  input: {
    jobId: string;
    status: string;
    summaryJson: string;
    doneMessage: string;
    eventId: string;
  },
): void {
  const stage = input.status === "cancelled" ? "已取消" : "完成";
  db.prepare(
    `UPDATE background_jobs
     SET status=?2, stage=?4, summary_json=?3, finished_at=datetime('now'), updated_at=datetime('now')
     WHERE id=?1`,
  ).run(input.jobId, input.status, input.summaryJson, stage);
  const level =
    input.status === "succeeded" ? "success" : input.status === "cancelled" ? "info" : "warning";
  addJobEvent(db, {
    eventId: input.eventId,
    jobId: input.jobId,
    level,
    stage,
    message: input.doneMessage,
  });
}

/** Rust `Storage::fail_job`。 */
export function failJob(
  db: DatabaseSync,
  input: { jobId: string; error: string; eventId: string },
): void {
  db.prepare(
    `UPDATE background_jobs
     SET status='failed', stage='失败', error_message=?2, finished_at=datetime('now'), updated_at=datetime('now')
     WHERE id=?1`,
  ).run(input.jobId, input.error);
  addJobEvent(db, {
    eventId: input.eventId,
    jobId: input.jobId,
    level: "error",
    stage: "失败",
    message: input.error,
  });
}

/**
 * Rust `Storage::request_background_job_cancel` 的进程内部分（`JobRuntime::request_cancel`）：
 * 只认当前进程持有的活动任务，不碰 SQLite。
 */
export function activeJobIds(db: DatabaseSync): Array<{ id: string; status: string }> {
  const rows = db
    .prepare("SELECT id, status FROM background_jobs WHERE status IN ('queued', 'running')")
    .all() as JsonRow[];
  return rows.map((row) => ({ id: text(row.id), status: text(row.status) }));
}