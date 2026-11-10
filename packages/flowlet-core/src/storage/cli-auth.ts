// CLI 浏览器授权签发的凭据同步 token（`cli_auth_tokens` 表）。Owner: node-storage.
//
// 背景：Docker/Web Host 可以只开 OIDC 登录（`FLOWLET_ADMIN_ALLOW_TOKEN_LOGIN=0`），
// 此时管理 API 不接受任何 Bearer，`flowlet pull --token=…` 无法工作。`flowlet login`
// 走已登录的浏览器会话换取一把**只读服务凭据**的 token，本表存它的 SHA-256 哈希。
//
// 与 service_credentials 的差异：明文 token 不落库、不需要 secret.key（哈希不可逆），
// 因此读取路径不经过 SecretBox。作用域目前只有 `credentials:read`。
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { JsonRow } from "../types.ts";

/** `cli_auth_tokens` 行（snake_case，与库内列一致）。 */
export interface CliAuthTokenRow {
  id: string;
  name: string;
  token_hash: string;
  scope: string;
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
}

const SELECT_COLUMNS = `id, name, token_hash, scope, created_at, expires_at, last_used_at`;

function rowFromRecord(row: Record<string, unknown>): JsonRow {
  return {
    id: String(row.id),
    name: String(row.name),
    token_hash: String(row.token_hash),
    scope: String(row.scope),
    created_at: String(row.created_at),
    expires_at: String(row.expires_at),
    last_used_at: row.last_used_at ?? null,
  };
}

/** 秒级 RFC3339 UTC（与 service_credentials / 其它业务时间戳一致）。 */
export function cliAuthTimestamp(now: Date = new Date()): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** SHA-256 十六进制；token 明文永不入库。 */
export function hashCliAuthToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** 新增一行（id 由调用方决定；返回写入的行）。 */
export function insertCliAuthToken(
  db: DatabaseSync,
  row: { id?: string; name: string; tokenHash: string; scope: string; expiresAt: string },
  now: Date = new Date(),
): JsonRow {
  const id = row.id ?? randomUUID();
  const createdAt = cliAuthTimestamp(now);
  db.prepare(
    `INSERT INTO cli_auth_tokens (id, name, token_hash, scope, created_at, expires_at, last_used_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL)`,
  ).run(id, row.name, row.tokenHash, row.scope, createdAt, row.expiresAt);
  return {
    id,
    name: row.name,
    token_hash: row.tokenHash,
    scope: row.scope,
    created_at: createdAt,
    expires_at: row.expiresAt,
    last_used_at: null,
  };
}

/** 全部 token（`ORDER BY created_at ASC, id ASC`；不含明文，只有哈希）。 */
export function listCliAuthTokens(db: DatabaseSync): JsonRow[] {
  const rows = db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM cli_auth_tokens ORDER BY created_at ASC, id ASC`)
    .all() as Array<Record<string, unknown>>;
  return rows.map(rowFromRecord);
}

/** 按 token 哈希查一行；调用方负责判断过期。 */
export function findCliAuthTokenByHash(db: DatabaseSync, tokenHash: string): JsonRow | null {
  const row = db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM cli_auth_tokens WHERE token_hash = ?1`)
    .get(tokenHash) as Record<string, unknown> | undefined;
  return row ? rowFromRecord(row) : null;
}

/** 记录最近使用时间（RFC3339 秒级）。 */
export function touchCliAuthToken(db: DatabaseSync, id: string, now: Date = new Date()): void {
  db.prepare(`UPDATE cli_auth_tokens SET last_used_at = ?2 WHERE id = ?1`).run(
    id,
    cliAuthTimestamp(now),
  );
}

/** 删除一行；返回是否真的删除。 */
export function deleteCliAuthToken(db: DatabaseSync, id: string): boolean {
  const result = db.prepare(`DELETE FROM cli_auth_tokens WHERE id = ?1`).run(id);
  return Number(result.changes ?? 0) > 0;
}

/** 清理过期行（`expires_at <= now`），返回删除行数。 */
export function deleteExpiredCliAuthTokens(db: DatabaseSync, now: Date = new Date()): number {
  const result = db
    .prepare(`DELETE FROM cli_auth_tokens WHERE expires_at <= ?1`)
    .run(cliAuthTimestamp(now));
  return Number(result.changes ?? 0);
}

/** 对外视图（camelCase，无 token_hash）。 */
export function toCliAuthTokenView(row: JsonRow): JsonRow {
  return {
    id: row.id,
    name: row.name,
    scope: row.scope,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at ?? null,
  };
}
