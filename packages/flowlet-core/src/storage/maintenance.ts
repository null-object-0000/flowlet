// 存储维护：请求/响应 Body 保留策略、捕获帧清理、余额快照保留策略。
// Owner: node-storage（task-11 起接管；Rust 权威实现见 core/storage.rs
// cleanup_expired_body_data / get_total_body_size_bytes / prune_oldest_body_data /
// clear_body_data_by_log_ids / prune_balance_snapshots）。
//
// Body 数据有两份来源，与 Rust 完全一致：
//   1. 历史内联列 request_logs.req_body_b64 / res_body_b64（旧库升级兼容）；
//   2. `.flcap` 外置帧 + request_capture_refs 指针（新数据统一走这里）。
// 清理时先处理帧（重写 segment、更新 refs/state、清空指针），再处理内联列。
import { statSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import type { DatabaseSync } from "node:sqlite";
import type { RequestCapturePointer, RequestCaptureStore } from "./capture-store.ts";
import { rewriteCaptureSegment, type CaptureRewrite, type CaptureRewriteJob } from "./capture-compaction.ts";

/** 与 Rust BODY_SIZE_PRUNE_MIN_AGE_HOURS 一致：至少一小时前的记录才按体积清理。 */
const BODY_SIZE_PRUNE_MIN_AGE_HOURS = 1;

/** 清理后返回的统计（供调度日志）。 */
export interface BodyClearResult {
  cleared: number;
  framesCleared: number;
  segmentsRewritten: number;
}

interface StoredCaptureRef {
  state: string;
  pointer: RequestCapturePointer | null;
  failure_reason: string | null;
}

/** Rust `request_capture_ref`：把指针列解析为可选指针（缺列/负值视为无指针）。 */
export function readCaptureRef(db: DatabaseSync, requestLogId: string): StoredCaptureRef | null {
  const row = db
    .prepare(
      `SELECT storage_key, frame_offset, frame_length, checksum,
              format_version, state, req_body_bytes, res_body_bytes, failure_reason
       FROM request_capture_refs WHERE request_log_id = ?1`,
    )
    .get(requestLogId) as Record<string, unknown> | undefined;
  if (!row) return null;
  const storageKey = typeof row.storage_key === "string" ? row.storage_key : null;
  const offset = typeof row.frame_offset === "number" ? row.frame_offset : null;
  const length = typeof row.frame_length === "number" ? row.frame_length : null;
  const checksum = typeof row.checksum === "string" ? row.checksum : null;
  const pointer =
    storageKey !== null &&
    offset !== null &&
    length !== null &&
    checksum !== null &&
    offset >= 0 &&
    length >= 0
      ? {
          storage_key: storageKey,
          offset,
          length,
          checksum,
          format_version: Number(row.format_version ?? 1),
          req_body_bytes: Number(row.req_body_bytes ?? 0),
          res_body_bytes: Number(row.res_body_bytes ?? 0),
        }
      : null;
  return {
    state: String(row.state ?? ""),
    pointer,
    failure_reason: typeof row.failure_reason === "string" ? row.failure_reason : null,
  };
}

/** Rust `mark_request_capture_corrupt`。 */
export function markCaptureCorrupt(db: DatabaseSync, requestLogId: string, reason: string): void {
  db.prepare(
    `UPDATE request_capture_refs
     SET state = 'corrupt', failure_reason = ?2, updated_at = datetime('now')
     WHERE request_log_id = ?1`,
  ).run(requestLogId, reason);
}

/** Rust `set_request_capture_ready`。 */
export function setCaptureReady(db: DatabaseSync, requestLogId: string, pointer: RequestCapturePointer): void {
  db.prepare(
    `UPDATE request_capture_refs
     SET storage_key = ?2, frame_offset = ?3, frame_length = ?4, checksum = ?5,
         format_version = ?6, state = 'ready', failure_reason = NULL,
         req_body_bytes = ?7, res_body_bytes = ?8,
         finalized_at = datetime('now'), updated_at = datetime('now')
     WHERE request_log_id = ?1`,
  ).run(
    requestLogId,
    pointer.storage_key,
    pointer.offset,
    pointer.length,
    pointer.checksum,
    pointer.format_version,
    pointer.req_body_bytes,
    pointer.res_body_bytes,
  );
}

/** Rust `set_request_capture_failed`。 */
export function setCaptureFailed(db: DatabaseSync, requestLogId: string, reason: string): void {
  db.prepare(
    `UPDATE request_capture_refs
     SET state = 'failed', failure_reason = ?2, updated_at = datetime('now')
     WHERE request_log_id = ?1`,
  ).run(requestLogId, reason);
}

/**
 * Rust `read_request_capture_locked`：仅 state=ready 且有指针时读取；
 * 帧缺失/损坏/记录 ID 不匹配时把 refs 置 corrupt 并返回 null（不抛错）。
 */
export function readCaptureRecord(
  db: DatabaseSync,
  store: RequestCaptureStore,
  requestLogId: string,
): Record<string, unknown> | null {
  const reference = readCaptureRef(db, requestLogId);
  if (!reference || reference.state !== "ready" || !reference.pointer) return null;
  try {
    const record = store.read(reference.pointer) as unknown as Record<string, unknown>;
    if (record.request_log_id !== requestLogId) {
      markCaptureCorrupt(db, requestLogId, "日志 ID 与捕获记录不一致");
      return null;
    }
    return record;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    markCaptureCorrupt(db, requestLogId, reason);
    return null;
  }
}

/** 清空内联 Body 列（Rust `clear_body_data_by_log_ids` 的历史列分支）。 */
function clearInlineBodies(db: DatabaseSync, ids: string[], reason: string): number {
  if (ids.length === 0) return 0;
  const statement = db.prepare(
    `UPDATE request_logs
     SET req_body_cleared_at = CASE WHEN req_body_b64 IS NOT NULL THEN datetime('now') ELSE req_body_cleared_at END,
         req_body_cleanup_reason = CASE WHEN req_body_b64 IS NOT NULL THEN ?2 ELSE req_body_cleanup_reason END,
         res_body_cleared_at = CASE WHEN res_body_b64 IS NOT NULL THEN datetime('now') ELSE res_body_cleared_at END,
         res_body_cleanup_reason = CASE WHEN res_body_b64 IS NOT NULL THEN ?2 ELSE res_body_cleanup_reason END,
         req_body_b64 = NULL, res_body_b64 = NULL
     WHERE id = ?1 AND (req_body_b64 IS NOT NULL OR res_body_b64 IS NOT NULL)`,
  );
  let cleared = 0;
  for (const id of ids) cleared += Number(statement.run(id, reason).changes ?? 0);
  return cleared;
}

/**
 * Rust `clear_body_data_by_log_ids` 的完整移植：
 * 1. 按 storage_key 分组活帧引用，读出段内所有 ready 记录；
 * 2. 目标记录清空 body（保留 headers 等其它字段），整段重写到 `compacted-*.flcap`；
 * 3. 事务更新 refs（目标→cleared，其余→ready 新指针）与 request_logs 清理标记；
 * 4. 删除旧段；失败时回滚并删除新段；
 * 5. 最后清理历史内联列 Body。
 */
export function clearBodyDataByLogIds(
  db: DatabaseSync,
  store: RequestCaptureStore,
  requestLogIds: string[],
  reason: string,
): BodyClearResult {
  const cleanup = clearBodies(db, store, requestLogIds, reason);
  let step = cleanup.next();
  while (!step.done) step = cleanup.next(rewriteCaptureSegment(store, step.value));
  return step.value;
}

function* clearBodies(
  db: DatabaseSync,
  store: RequestCaptureStore,
  requestLogIds: string[],
  reason: string,
): Generator<CaptureRewriteJob, BodyClearResult, CaptureRewrite | null> {
  if (requestLogIds.length === 0) return { cleared: 0, framesCleared: 0, segmentsRewritten: 0 };
  const targets = new Set(requestLogIds);

  // 1. 分组活帧引用。
  const segments = new Map<string, string[]>();
  const segmentStatement = db.prepare(
    `SELECT storage_key FROM request_capture_refs
     WHERE request_log_id = ?1 AND state = 'ready'`,
  );
  for (const requestLogId of requestLogIds) {
    const row = segmentStatement.get(requestLogId) as { storage_key?: string } | undefined;
    const storageKey = typeof row?.storage_key === "string" ? row.storage_key : null;
    if (!storageKey) continue;
    const bucket = segments.get(storageKey);
    if (bucket) bucket.push(requestLogId);
    else segments.set(storageKey, [requestLogId]);
  }

  const cleared = new Set<string>();
  let framesCleared = 0;
  let segmentsRewritten = 0;

  // 2-4. 逐个 segment 重写。
  const liveStatement = db.prepare(
    `SELECT request_log_id, frame_offset, frame_length, checksum,
            format_version, req_body_bytes, res_body_bytes
     FROM request_capture_refs
     WHERE storage_key = ?1 AND state = 'ready'
     ORDER BY frame_offset`,
  );
  const updateRef = db.prepare(
    `UPDATE request_capture_refs
     SET storage_key = ?2, frame_offset = ?3, frame_length = ?4, checksum = ?5,
         format_version = ?6, req_body_bytes = ?7, res_body_bytes = ?8,
         state = ?9, failure_reason = NULL, updated_at = datetime('now')
     WHERE request_log_id = ?1`,
  );
  const markCleared = db.prepare(
    `UPDATE request_logs
     SET req_body_cleared_at = CASE WHEN ?2 THEN datetime('now') ELSE req_body_cleared_at END,
         req_body_cleanup_reason = CASE WHEN ?2 THEN ?4 ELSE req_body_cleanup_reason END,
         res_body_cleared_at = CASE WHEN ?3 THEN datetime('now') ELSE res_body_cleared_at END,
         res_body_cleanup_reason = CASE WHEN ?3 THEN ?4 ELSE res_body_cleanup_reason END,
         req_body_b64 = NULL, res_body_b64 = NULL
     WHERE id = ?1`,
  );
  for (const storageKey of segments.keys()) {
    const liveRows = liveStatement.all(storageKey) as Array<Record<string, unknown>>;
    if (liveRows.length === 0) continue;
    const job: CaptureRewriteJob = {
      storageKey,
      frames: liveRows.map((row) => ({
        id: String(row.request_log_id),
        clear: targets.has(String(row.request_log_id)),
        pointer: {
          storage_key: storageKey,
          offset: Number(row.frame_offset),
          length: Number(row.frame_length),
          checksum: String(row.checksum),
          format_version: Number(row.format_version ?? 1),
          req_body_bytes: Number(row.req_body_bytes ?? 0),
          res_body_bytes: Number(row.res_body_bytes ?? 0),
        },
      })),
    };
    const rewrite = yield job;
    if (!rewrite) {
      for (const id of segments.get(storageKey) ?? []) targets.delete(id);
      continue;
    }
    const { pointers, bodyPresence } = rewrite;
    let transactionStarted = false;
    try {
      db.exec("BEGIN");
      transactionStarted = true;
      for (let index = 0; index < job.frames.length; index += 1) {
        const requestLogId = job.frames[index].id;
        const pointer = pointers[index];
        const presence = bodyPresence[index];
        const isTarget = targets.has(requestLogId);
        updateRef.run(
          requestLogId,
          pointer.storage_key,
          pointer.offset,
          pointer.length,
          pointer.checksum,
          pointer.format_version,
          pointer.req_body_bytes,
          pointer.res_body_bytes,
          isTarget ? "cleared" : "ready",
        );
        if (isTarget) {
          if (presence.req || presence.res) cleared.add(requestLogId);
          if (presence.req) framesCleared += 1;
          markCleared.run(requestLogId, presence.req ? 1 : 0, presence.res ? 1 : 0, reason);
        }
      }
      db.exec("COMMIT");
    } catch (error) {
      if (transactionStarted && db.isTransaction) db.exec("ROLLBACK");
      if (pointers.length > 0) {
        try {
          store.removeSegment(pointers[0].storage_key);
        } catch {
          /* 忽略回滚清理失败（Rust 同样吞掉） */
        }
      }
      throw error;
    }
    segmentsRewritten += 1;
    store.removeSegment(storageKey);
  }

  // 5. 历史内联列 Body。
  const inlineCleared = clearInlineBodies(db, [...targets], reason);
  return {
    cleared: cleared.size + inlineCleared,
    framesCleared,
    segmentsRewritten,
  };
}

const BODY_CANDIDATES = `
  FROM request_logs rl
  LEFT JOIN request_capture_refs refs ON refs.request_log_id = rl.id
  WHERE rl.created_at < datetime('now', ?1)
    AND (
      rl.req_body_b64 IS NOT NULL OR rl.res_body_b64 IS NOT NULL
      OR (refs.state = 'ready' AND (refs.req_body_bytes > 0 OR refs.res_body_bytes > 0))
    )
    AND EXISTS (
      SELECT 1 FROM usage_records ur
      WHERE ur.request_id = rl.request_id
        AND ur.input_tokens IS NOT NULL
        AND ur.output_tokens IS NOT NULL
    )`;

function selectBodyCandidates(db: DatabaseSync, age: string, limit: number): string[] {
  const rows = db.prepare(`
    SELECT rl.id ${BODY_CANDIDATES}
    ORDER BY rl.created_at ASC, rl.id ASC LIMIT ?2
  `).all(age, limit) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

/** 清理超过保留天数的请求/响应 Body（仅针对已有完整 Token 统计的记录）。 */
export function cleanupExpiredBodyData(
  db: DatabaseSync,
  store: RequestCaptureStore,
  retentionDays: number,
): number {
  if (retentionDays < 0) return 0;
  const ids = selectBodyCandidates(db, `-${Math.trunc(retentionDays)} days`, -1);
  return clearBodyDataByLogIds(db, store, ids, "retention").cleared;
}

const CLEANUP_BATCH_SIZE = 250;
const CLEANUP_BATCHES_PER_RUN = 20;
const CLEANUP_SEGMENT_BYTES_PER_RUN = 256n * 1024n * 1024n;

function segmentSnapshot(store: RequestCaptureStore, key: string) {
  const stat = statSync(store.resolveStorageKey(key), { bigint: true, throwIfNoEntry: false });
  return stat && { size: stat.size, identity: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}` };
}

/** 每轮只处理有限数量的候选记录。文件读写与压缩在 worker，发布指针在主线程。 */
export async function cleanupScheduledBodies(
  db: DatabaseSync,
  store: RequestCaptureStore,
  options: { retentionDays: number; maxBytes: number; pruneRatio: number; signal: AbortSignal },
  rewriteSegment: (job: CaptureRewriteJob) => Promise<CaptureRewrite>,
): Promise<{ expiredBodies: number; prunedBodies: number }> {
  let segmentBytes = 0n;
  const currentFrames = db.prepare(`
    SELECT request_log_id AS id, frame_offset AS offset, frame_length AS length, checksum
    FROM request_capture_refs WHERE storage_key = ? AND state = 'ready' ORDER BY frame_offset
  `);

  async function clearBatch(ids: string[], reason: string): Promise<number> {
    const cleanup = clearBodies(db, store, ids, reason);
    let step = cleanup.next();
    while (!step.done && !options.signal.aborted) {
      const job = step.value;
      const { storageKey, frames } = job;
      if (segmentBytes >= CLEANUP_SEGMENT_BYTES_PER_RUN) {
        step = cleanup.next(null);
        continue;
      }
      const snapshot = segmentSnapshot(store, storageKey);
      segmentBytes += snapshot?.size ?? 0n;
      const sameSegment = () => {
        if (snapshot?.identity !== segmentSnapshot(store, storageKey)?.identity) return false;
        const rows = currentFrames.all(storageKey);
        return rows.length === frames.length && rows.every((row, index) => {
          const frame = frames[index];
          return row.id === frame.id && row.offset === frame.pointer.offset
            && row.length === frame.pointer.length && row.checksum === frame.pointer.checksum;
        });
      };
      let result: CaptureRewrite | null = null;
      try {
        result = await rewriteSegment(job);
      } catch (error) {
        if (sameSegment()) throw error;
      }
      // HTTP 可以在 worker 运行期间追加帧或补写流式日志。快照失效时保留原段，
      // 下次重试。验证、更新指针和删除旧段之间不让出主线程。
      if (result && (options.signal.aborted || !sameSegment())) {
        store.removeSegment(result.pointers[0].storage_key);
        result = null;
      }
      if (options.signal.aborted) break;
      step = cleanup.next(result);
    }
    return step.done ? step.value.cleared : 0;
  }

  async function clearBatches(age: string, reason: string, shouldContinue: () => boolean): Promise<number> {
    let total = 0;
    for (let batch = 0; batch < CLEANUP_BATCHES_PER_RUN && segmentBytes < CLEANUP_SEGMENT_BYTES_PER_RUN
      && !options.signal.aborted && shouldContinue(); batch += 1) {
      const ids = selectBodyCandidates(db, age, CLEANUP_BATCH_SIZE);
      if (ids.length === 0) break;
      const cleared = await clearBatch(ids, reason);
      total += cleared;
      if (cleared === 0) break;
      await setImmediate();
    }
    return total;
  }

  const expiredBodies = options.retentionDays < 0 ? 0 : await clearBatches(
    `-${Math.trunc(options.retentionDays)} days`, "retention", () => true,
  );
  const ratio = Math.min(Math.max(options.pruneRatio, 0), 1);
  const goal = options.maxBytes * (1 - ratio);
  const prunedBodies = options.maxBytes <= 0 || ratio <= 0 ? 0 : await clearBatches(
    `-${BODY_SIZE_PRUNE_MIN_AGE_HOURS} hours`, "size_limit", () => getTotalBodySizeBytes(db) > goal,
  );
  return { expiredBodies, prunedBodies };
}

/** 当前 Body 数据总占用字节数（内联列长度 + 已就绪捕获帧声明的字节数）。 */
export function getTotalBodySizeBytes(db: DatabaseSync): number {
  const row = db
    .prepare(
      `SELECT
         COALESCE((
           SELECT SUM(COALESCE(octet_length(req_body_b64), 0) + COALESCE(octet_length(res_body_b64), 0))
           FROM request_logs
           WHERE req_body_b64 IS NOT NULL OR res_body_b64 IS NOT NULL
         ), 0)
         + COALESCE((
           SELECT SUM(req_body_bytes + res_body_bytes)
           FROM request_capture_refs
           WHERE state = 'ready'
         ), 0) AS total`,
    )
    .get() as { total: number } | undefined;
  return Number(row?.total ?? 0);
}

/** 按体积上限清理最老的一批 Body（单次清理；返回清理行数）。 */
export function pruneOldestBodyData(
  db: DatabaseSync,
  store: RequestCaptureStore,
  targetBytes: number,
  pruneRatio: number,
): number {
  const ratio = Math.min(Math.max(pruneRatio, 0), 1);
  if (ratio <= 0) return 0;
  const goalBytes = Math.max(targetBytes * (1 - ratio), 0);
  if (getTotalBodySizeBytes(db) <= goalBytes) return 0;

  const age = `-${BODY_SIZE_PRUNE_MIN_AGE_HOURS} hours`;
  const eligible = db.prepare(`SELECT COUNT(*) AS total ${BODY_CANDIDATES}`).get(age);
  const totalEligible = Number(eligible?.total ?? 0);
  if (totalEligible === 0) return 0;
  const batchSize = Math.max(Math.ceil(totalEligible * ratio), 1);
  return clearBodyDataByLogIds(db, store, selectBodyCandidates(db, age, batchSize), "size_limit").cleared;
}

/** 反复按比例清理，直到压回目标体积或没有可清理记录。 */
export function pruneOldestBodyDataToGoal(
  db: DatabaseSync,
  store: RequestCaptureStore,
  targetBytes: number,
  pruneRatio: number,
  maxRounds = 50,
): number {
  let total = 0;
  for (let round = 0; round < maxRounds; round += 1) {
    const cleared = pruneOldestBodyData(db, store, targetBytes, pruneRatio);
    if (cleared === 0) break;
    total += cleared;
  }
  return total;
}

/** Rust cleanup_old_logs：先清 Body（含帧）再删除两表，返回 (日志数, 用量数)。 */
export function cleanupOldLogs(
  db: DatabaseSync,
  store: RequestCaptureStore,
  keepDays: number,
  reason = "log_retention",
): [number, number] {
  const ids = (
    db
      .prepare(`SELECT id FROM request_logs WHERE created_at < datetime('now', '-${Math.trunc(keepDays)} days')`)
      .all() as Array<{ id: string }>
  ).map((row) => row.id);
  clearBodyDataByLogIds(db, store, ids, reason);
  const deletedLogs = db
    .prepare(`DELETE FROM request_logs WHERE created_at < datetime('now', '-${Math.trunc(keepDays)} days')`)
    .run();
  const deletedUsage = db
    .prepare(`DELETE FROM usage_records WHERE created_at < datetime('now', '-${Math.trunc(keepDays)} days')`)
    .run();
  return [Number(deletedLogs.changes), Number(deletedUsage.changes)];
}

/**
 * 余额/资源快照保留：按天数删除过期快照，并按账号限制条数（保留最新）。
 * Rust 用 `created_at` 判断过期、按 `rowid DESC` 保留最新；返回 [expired, overLimit]。
 */
export function pruneBalanceSnapshots(
  db: DatabaseSync,
  retentionDays: number,
  maxPerAccount: number,
): [number, number] {
  let expired = 0;
  if (retentionDays >= 0) {
    const result = db
      .prepare(
        `DELETE FROM account_balance_snapshots
         WHERE julianday(created_at) < julianday('now', ?)`,
      )
      .run(`-${retentionDays} days`);
    expired = Number(result.changes ?? 0);
  }

  let overLimit = 0;
  if (maxPerAccount > 0) {
    const result = db
      .prepare(
        `DELETE FROM account_balance_snapshots
         WHERE rowid IN (
           SELECT rowid FROM (
             SELECT rowid, ROW_NUMBER() OVER (
               PARTITION BY account_id ORDER BY rowid DESC
             ) AS rank_in_account
             FROM account_balance_snapshots
           )
           WHERE rank_in_account > ?
         )`,
      )
      .run(maxPerAccount);
    overLimit = Number(result.changes ?? 0);
  }
  return [expired, overLimit];
}