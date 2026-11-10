// 余额快照存储（桌面命令层的领域纯函数）。
//
// 权威行为：src-tauri/src/core/storage/config.rs 的 `save_balance_snapshot` /
// `list_balance_snapshots`（SQL 与列顺序逐句对照，行映射为 Rust 的 snake_case）。
// 这些函数由 `ctx.storage.withDatabase((db) => ...)` 调用，避免与其它领域争抢
// `storage/index.ts` 的方法列表。
import type { DatabaseSync } from "node:sqlite";
import type { JsonRow } from "../types.ts";

const BALANCE_SELECT = `SELECT s.id, s.account_id, s.balance, s.currency, s.token_pack_total, s.token_pack_used,
       s.token_pack_remaining, s.token_pack_expire_at, s.token_packs, s.raw_scraped_json, s.source,
       s.synced_at, s.remark, s.created_at, s.updated_at`;

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function balanceFromRow(row: JsonRow): JsonRow {
  return {
    id: String(row.id),
    account_id: String(row.account_id),
    balance: nullableNumber(row.balance),
    currency: nullableText(row.currency),
    token_pack_total: nullableNumber(row.token_pack_total),
    token_pack_used: nullableNumber(row.token_pack_used),
    token_pack_remaining: nullableNumber(row.token_pack_remaining),
    token_pack_expire_at: nullableText(row.token_pack_expire_at),
    token_packs: nullableText(row.token_packs),
    raw_scraped_json: nullableText(row.raw_scraped_json),
    source: String(row.source),
    synced_at: nullableText(row.synced_at),
    remark: nullableText(row.remark),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

/** Rust `Storage::save_balance_snapshot`（列顺序与占位符逐字一致）。 */
export function saveBalanceSnapshot(db: DatabaseSync, snapshot: JsonRow): void {
  db.prepare(
    `INSERT INTO account_balance_snapshots (
       id, account_id, balance, currency, token_pack_total, token_pack_used,
       token_pack_remaining, token_pack_expire_at, token_packs, raw_scraped_json, source,
       synced_at, remark, created_at, updated_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`,
  ).run(
    String(snapshot.id),
    String(snapshot.account_id),
    snapshot.balance ?? null,
    snapshot.currency ?? null,
    snapshot.token_pack_total ?? null,
    snapshot.token_pack_used ?? null,
    snapshot.token_pack_remaining ?? null,
    snapshot.token_pack_expire_at ?? null,
    snapshot.token_packs ?? null,
    snapshot.raw_scraped_json ?? null,
    String(snapshot.source ?? ""),
    snapshot.synced_at ?? null,
    snapshot.remark ?? null,
    String(snapshot.created_at ?? ""),
    String(snapshot.updated_at ?? ""),
  );
}

/** Rust `Storage::list_balance_snapshots`：按 created_at DESC 取最近 10 条。 */
export function listBalanceSnapshots(db: DatabaseSync, accountId: string): JsonRow[] {
  const rows = db
    .prepare(
      `${BALANCE_SELECT} FROM account_balance_snapshots s
       WHERE s.account_id = ?1 ORDER BY s.created_at DESC LIMIT 10`,
    )
    .all(accountId) as JsonRow[];
  return rows.map(balanceFromRow);
}

/** Rust `Storage::latest_balance_snapshots`（每个账号一条）。 */
export function latestBalanceSnapshots(db: DatabaseSync): JsonRow[] {
  const rows = db
    .prepare(
      `${BALANCE_SELECT}
       FROM account_balance_snapshots s
       INNER JOIN (
         SELECT account_id, MAX(created_at) AS max_created
         FROM account_balance_snapshots
         GROUP BY account_id
       ) latest ON s.account_id = latest.account_id AND s.created_at = latest.max_created
       ORDER BY s.account_id ASC`,
    )
    .all() as JsonRow[];
  return rows.map(balanceFromRow);
}

/** 账号最近一次快照的 created_at（后台同步诊断用；无快照返回 null）。 */
export function latestSnapshotCreatedAt(db: DatabaseSync, accountId: string): string | null {
  const row = db
    .prepare(
      `SELECT MAX(created_at) AS created_at FROM account_balance_snapshots WHERE account_id = ?1`,
    )
    .get(accountId) as JsonRow | undefined;
  return nullableText(row?.created_at);
}