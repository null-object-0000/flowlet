// 三方服务凭据的持久化（`service_credentials` 表）：Rust `core/storage_credentials.rs` 等价。
//
// 只做 SQL 读写；校验、加密与业务编排在 web/host 层（对应 Rust `core/service_credentials.rs`）。
// 行结构保持 Rust `ServiceCredentialRow` 的 snake_case 字段；`enabled` 在库内是 INTEGER，
// 读取时转 boolean。
import type { DatabaseSync } from "node:sqlite";
import type { JsonRow } from "../types.ts";

/** 与 Rust `ServiceCredentialRow` 逐字段一致（snake_case）。 */
export interface ServiceCredentialRow {
  id: string;
  name: string;
  provider: string;
  base_url: string;
  secret_ciphertext: string;
  secret_hint: string;
  kind: string;
  note: string | null;
  /** 第二期：环境变量前缀（大写）；旧行为 NULL，读取时按 provider 默认解析。 */
  env_prefix: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  last_verified_at: string | null;
  last_error: string | null;
}

const SELECT_COLUMNS = `id, name, provider, base_url, secret_ciphertext, secret_hint, kind, note,
       env_prefix, enabled, created_at, updated_at, last_verified_at, last_error`;

function rowFromRecord(row: Record<string, unknown>): JsonRow {
  return {
    id: String(row.id),
    name: String(row.name),
    provider: String(row.provider),
    base_url: String(row.base_url),
    secret_ciphertext: String(row.secret_ciphertext),
    secret_hint: String(row.secret_hint),
    kind: String(row.kind),
    note: row.note ?? null,
    env_prefix: typeof row.env_prefix === "string" ? row.env_prefix : null,
    enabled: Number(row.enabled) !== 0,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    last_verified_at: row.last_verified_at ?? null,
    last_error: row.last_error ?? null,
  };
}

/** 凭证业务使用的时间戳格式：秒级 RFC3339 UTC（Rust SecondsFormat::Secs, true）。 */
export function credentialTimestamp(now: Date = new Date()): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Rust `list_service_credentials`：`ORDER BY created_at ASC, name ASC`。 */
export function listServiceCredentials(db: DatabaseSync): JsonRow[] {
  const rows = db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM service_credentials ORDER BY created_at ASC, name ASC`)
    .all() as Array<Record<string, unknown>>;
  return rows.map(rowFromRecord);
}

/** Rust `get_service_credential`。 */
export function getServiceCredential(db: DatabaseSync, id: string): JsonRow | null {
  const row = db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM service_credentials WHERE id = ?1`)
    .get(id) as Record<string, unknown> | undefined;
  return row ? rowFromRecord(row) : null;
}

/**
 * Rust `upsert_service_credential`：INSERT … ON CONFLICT(id) DO UPDATE。
 * `created_at` 只在首次插入时写入（冲突更新不覆盖）。
 */
export function upsertServiceCredential(db: DatabaseSync, row: JsonRow): void {
  db.prepare(
    `INSERT INTO service_credentials (
        id, name, provider, base_url, secret_ciphertext, secret_hint, kind, note,
        env_prefix, enabled, created_at, updated_at, last_verified_at, last_error
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
     ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        provider = excluded.provider,
        base_url = excluded.base_url,
        secret_ciphertext = excluded.secret_ciphertext,
        secret_hint = excluded.secret_hint,
        kind = excluded.kind,
        note = excluded.note,
        env_prefix = excluded.env_prefix,
        enabled = excluded.enabled,
        updated_at = excluded.updated_at,
        last_verified_at = excluded.last_verified_at,
        last_error = excluded.last_error`,
  ).run(
    String(row.id),
    String(row.name),
    String(row.provider),
    String(row.base_url),
    String(row.secret_ciphertext),
    String(row.secret_hint),
    String(row.kind ?? "cli_token"),
    row.note ?? null,
    typeof row.env_prefix === "string" && row.env_prefix !== "" ? row.env_prefix : null,
    row.enabled === false ? 0 : 1,
    String(row.created_at),
    String(row.updated_at),
    row.last_verified_at ?? null,
    row.last_error ?? null,
  );
}

/**
 * Rust `update_service_credential_verification`：
 * `last_verified_at = COALESCE(?2, last_verified_at)`、`last_error = ?3`、
 * `updated_at = now`（秒级 RFC3339）；`verifiedAt=null` 表示保持旧值，`lastError=null` 表示清空。
 */
export function updateServiceCredentialVerification(
  db: DatabaseSync,
  id: string,
  verifiedAt: string | null,
  lastError: string | null,
): void {
  db.prepare(
    `UPDATE service_credentials
     SET last_verified_at = COALESCE(?2, last_verified_at),
         last_error = ?3,
         updated_at = ?4
     WHERE id = ?1`,
  ).run(id, verifiedAt, lastError, credentialTimestamp());
}

/** Rust `delete_service_credential`：返回是否真的删除了一行。 */
export function deleteServiceCredential(db: DatabaseSync, id: string): boolean {
  const result = db.prepare("DELETE FROM service_credentials WHERE id = ?1").run(id);
  return Number(result.changes ?? 0) > 0;
}

/** Rust `service_credentials::mask_secret`：保留末 4 位，其余圆点；≤4 位时不泄露。 */
export function maskSecret(secret: string): string {
  const chars = [...secret];
  if (chars.length <= 4) return "••••";
  return `••••${chars.slice(chars.length - 4).join("")}`;
}

/**
 * Rust `service_credentials::default_env_prefix` 的存储层副本（仅用于 to_view 的旧行兜底）。
 * 业务校验路径以 web/credentials.ts 为准，避免 storage 反向依赖 web 层。
 */
function defaultEnvPrefix(provider: unknown): string {
  if (provider === "gitlab") return "GITLAB";
  if (provider === "dockhand") return "DOCKHAND";
  return String(provider ?? "").trim().toUpperCase();
}

/** Rust `service_credentials::to_view`：列表视图（camelCase，不含密文）。 */
export function toServiceCredentialView(row: JsonRow): JsonRow {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    baseUrl: row.base_url,
    envPrefix:
      typeof row.env_prefix === "string" && row.env_prefix !== ""
        ? row.env_prefix
        : defaultEnvPrefix(row.provider),
    kind: row.kind,
    note: row.note ?? null,
    enabled: row.enabled,
    secretHint: row.secret_hint,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastVerifiedAt: row.last_verified_at ?? null,
    lastError: row.last_error ?? null,
  };
}