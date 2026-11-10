// 存储维护：请求/响应 Body 保留策略与余额快照保留策略。
// Owner: lead（迁移集成阶段补齐；Rust 权威实现见 core/storage.rs
// cleanup_expired_body_data / get_total_body_size_bytes / prune_oldest_body_data /
// prune_balance_snapshots）。
//
// 与 Rust 的差异：Node Host 尚未实现 `.flcap` 外置捕获帧，Body 直接落
// request_logs.req_body_b64 / res_body_b64；因此这里只清理内联列，不触碰
// request_capture_refs（旧库中的帧文件保持原样，不删除）。
import type { DatabaseSync } from "node:sqlite";

/** 与 Rust BODY_SIZE_PRUNE_MIN_AGE_HOURS 一致：至少一小时前的记录才按体积清理。 */
const BODY_SIZE_PRUNE_MIN_AGE_HOURS = 1;

function clearBodies(db: DatabaseSync, ids: string[], reason: string): number {
  if (ids.length === 0) return 0;
  const statement = db.prepare(
    `UPDATE request_logs
        SET req_body_cleared_at = CASE WHEN req_body_b64 IS NOT NULL THEN datetime('now') ELSE req_body_cleared_at END,
            req_body_cleanup_reason = CASE WHEN req_body_b64 IS NOT NULL THEN ?2 ELSE req_body_cleanup_reason END,
            res_body_cleared_at = CASE WHEN res_body_b64 IS NOT NULL THEN datetime('now') ELSE res_body_cleared_at END,
            res_body_cleanup_reason = CASE WHEN res_body_b64 IS NOT NULL THEN ?2 ELSE res_body_cleanup_reason END,
            req_body_b64 = NULL,
            res_body_b64 = NULL
      WHERE id = ?1 AND (req_body_b64 IS NOT NULL OR res_body_b64 IS NOT NULL)`,
  );
  let cleared = 0;
  for (const id of ids) {
    const result = statement.run(id, reason);
    cleared += Number(result.changes ?? 0);
  }
  return cleared;
}

/** 清理超过保留天数的请求/响应 Body（仅针对已有完整 Token 统计的记录）。 */
export function cleanupExpiredBodyData(db: DatabaseSync, retentionDays: number): number {
  if (retentionDays < 0) return 0; // -1 = 永久保留
  const rows = db
    .prepare(
      `SELECT rl.id
         FROM request_logs rl
         WHERE rl.created_at < datetime('now', ?)
           AND (rl.req_body_b64 IS NOT NULL OR rl.res_body_b64 IS NOT NULL)
           AND EXISTS (
             SELECT 1 FROM usage_records ur
             WHERE ur.request_id = rl.request_id
               AND ur.input_tokens IS NOT NULL
               AND ur.output_tokens IS NOT NULL
           )`,
    )
    .all(`-${retentionDays} days`) as Array<{ id: string }>;
  return clearBodies(db, rows.map((row) => row.id), "retention");
}

/** 当前 Body 数据总占用字节数（内联列长度 + 已就绪捕获帧声明的字节数）。 */
export function getTotalBodySizeBytes(db: DatabaseSync): number {
  const row = db
    .prepare(
      `SELECT
         COALESCE((
           SELECT SUM(length(COALESCE(req_body_b64, '')) + length(COALESCE(res_body_b64, '')))
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
export function pruneOldestBodyData(db: DatabaseSync, targetBytes: number, pruneRatio: number): number {
  const ratio = Math.min(Math.max(pruneRatio, 0), 1);
  if (ratio <= 0) return 0;
  const goalBytes = Math.max(targetBytes * (1 - ratio), 0);
  if (getTotalBodySizeBytes(db) <= goalBytes) return 0;

  const eligibleRow = db
    .prepare(
      `SELECT COUNT(*) AS total
         FROM request_logs rl
         WHERE rl.created_at < datetime('now', '-${BODY_SIZE_PRUNE_MIN_AGE_HOURS} hours')
           AND (rl.req_body_b64 IS NOT NULL OR rl.res_body_b64 IS NOT NULL)
           AND EXISTS (
             SELECT 1 FROM usage_records ur
             WHERE ur.request_id = rl.request_id
               AND ur.input_tokens IS NOT NULL
               AND ur.output_tokens IS NOT NULL
           )`,
    )
    .get() as { total: number } | undefined;
  const totalEligible = Number(eligibleRow?.total ?? 0);
  if (totalEligible === 0) return 0;
  const batchSize = Math.max(Math.ceil(totalEligible * ratio), 1);

  const rows = db
    .prepare(
      `SELECT rl.id
         FROM request_logs rl
         WHERE rl.created_at < datetime('now', '-${BODY_SIZE_PRUNE_MIN_AGE_HOURS} hours')
           AND (rl.req_body_b64 IS NOT NULL OR rl.res_body_b64 IS NOT NULL)
           AND EXISTS (
             SELECT 1 FROM usage_records ur
             WHERE ur.request_id = rl.request_id
               AND ur.input_tokens IS NOT NULL
               AND ur.output_tokens IS NOT NULL
           )
         ORDER BY rl.created_at ASC
         LIMIT ?`,
    )
    .all(batchSize) as Array<{ id: string }>;
  return clearBodies(db, rows.map((row) => row.id), "size_limit");
}

/** 反复按比例清理，直到压回目标体积或没有可清理记录。 */
export function pruneOldestBodyDataToGoal(
  db: DatabaseSync,
  targetBytes: number,
  pruneRatio: number,
  maxRounds = 50,
): number {
  let total = 0;
  for (let round = 0; round < maxRounds; round += 1) {
    const cleared = pruneOldestBodyData(db, targetBytes, pruneRatio);
    if (cleared === 0) break;
    total += cleared;
  }
  return total;
}

/**
 * 余额/资源快照保留：按天数删除过期快照，并按账号限制条数（保留最新）。
 * 返回 [expired, overLimit]。
 */
export function pruneBalanceSnapshots(
  db: DatabaseSync,
  retentionDays: number,
  maxPerAccount: number,
): [number, number] {
  let expired = 0;
  if (retentionDays >= 0) {
    // PostgreSQL 风格时间戳比较：兼容 `Z` 与 `+00:00` 两种历史写法，统一用 julianday。
    const result = db
      .prepare(
        `DELETE FROM account_balance_snapshots
          WHERE julianday(synced_at) < julianday('now', ?)`,
      )
      .run(`-${retentionDays} days`);
    expired = Number(result.changes ?? 0);
  }

  let overLimit = 0;
  if (maxPerAccount > 0) {
    const accounts = db
      .prepare(`SELECT DISTINCT account_id FROM account_balance_snapshots`)
      .all() as Array<{ account_id: string }>;
    const remove = db.prepare(
      `DELETE FROM account_balance_snapshots
        WHERE id IN (
          SELECT id FROM account_balance_snapshots
           WHERE account_id = ?
           ORDER BY julianday(synced_at) DESC, id DESC
           LIMIT -1 OFFSET ?
        )`,
    );
    for (const account of accounts) {
      const result = remove.run(account.account_id, maxPerAccount);
      overLimit += Number(result.changes ?? 0);
    }
  }
  return [expired, overLimit];
}
