// SQLite schema + migrations, byte-compatible with src-tauri/src/core/storage.rs.
//
// Rust 没有 `PRAGMA user_version`：每次启动执行「CREATE TABLE IF NOT EXISTS +
// 幂等补列 + 重建表迁移 + 一次性数据归一」。这里逐条照搬，索引/列/默认值不改。
//
// 例外：`agent_session_metadata`（docs/agent-session-metadata.md §2）当前仅由 Node Host
// 写入（服务端从请求体派生标题/项目路径）。表结构仍按同一契约维护、只增不改，桌面 Rust
// 旧版本读到未知表会忽略；后续 Rust 侧补建时字段必须与本文件完全一致。
import type { DatabaseSync } from "node:sqlite";
import { modelCatalog, type ModelIdentity } from "../catalog/index.ts";

export const SCHEMA_VERSION = "2026.08.02";

/** 建表 + 基础索引（Rust `migrate()` 的第一个 execute_batch）。 */
const BASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS channel_presets (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    vendor          TEXT NOT NULL,
    supported_protocols TEXT NOT NULL,
    openai_base_url TEXT NOT NULL,
    anthropic_base_url TEXT NOT NULL,
    openai_auth    TEXT NOT NULL DEFAULT 'bearer',
    anthropic_auth TEXT NOT NULL DEFAULT 'bearer',
    default_model   TEXT NOT NULL,
    small_model     TEXT,
    timeout_seconds INTEGER,
    supports_model_list    INTEGER NOT NULL DEFAULT 0,
    supports_model_detail  INTEGER NOT NULL DEFAULT 0,
    supports_price_sync    INTEGER NOT NULL DEFAULT 0,
    supports_balance_query INTEGER NOT NULL DEFAULT 0,
    supports_quota_query   INTEGER NOT NULL DEFAULT 0,
    supports_usage_query   INTEGER NOT NULL DEFAULT 0,
    enabled         INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_accounts (
    id                TEXT PRIMARY KEY,
    channel_id        TEXT NOT NULL,
    name              TEXT NOT NULL,
    api_key           TEXT NOT NULL,
    management_key    TEXT,
    enabled           INTEGER NOT NULL DEFAULT 1,
    priority          INTEGER NOT NULL DEFAULT 0,
    remark            TEXT,
    resource_mode     TEXT,
    resource_sync_mode TEXT NOT NULL DEFAULT 'manual',
    base_url_override TEXT,
    anthropic_base_url_override TEXT,
    last_used_at      TEXT,
    last_error        TEXT,
    credential_status TEXT NOT NULL DEFAULT 'healthy',
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_account_workspace_links (
    local_account_id     TEXT PRIMARY KEY,
    workspace_account_id TEXT NOT NULL,
    linked_at            TEXT NOT NULL,
    updated_at           TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_account_workspace_links_workspace
    ON channel_account_workspace_links(workspace_account_id);

CREATE TABLE IF NOT EXISTS channel_account_workspace_defaults (
    workspace_account_id TEXT PRIMARY KEY,
    openai_base_url       TEXT,
    anthropic_base_url    TEXT,
    updated_at            TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_models (
    id                   TEXT PRIMARY KEY,
    channel_id           TEXT NOT NULL,
    model                TEXT NOT NULL,
    display_name         TEXT,
    supported_protocols  TEXT NOT NULL,
    context_window       INTEGER,
    max_output_tokens    INTEGER,
    pricing_json         TEXT,
    supports_stream      INTEGER NOT NULL DEFAULT 1,
    enabled              INTEGER NOT NULL DEFAULT 1,
    source               TEXT NOT NULL DEFAULT 'preset',
    synced_at            TEXT,
    created_at           TEXT NOT NULL,
    updated_at           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS virtual_models (
    id               TEXT PRIMARY KEY,
    name             TEXT NOT NULL UNIQUE,
    protocol_type    TEXT NOT NULL,
    routing_strategy TEXT NOT NULL,
    enabled          INTEGER NOT NULL DEFAULT 1,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS virtual_model_routes (
    id               TEXT PRIMARY KEY,
    virtual_model_id TEXT NOT NULL,
    channel_id       TEXT NOT NULL,
    account_id       TEXT NOT NULL,
    upstream_model   TEXT NOT NULL,
    client_protocol  TEXT NOT NULL,
    priority         INTEGER NOT NULL,
    enabled          INTEGER NOT NULL DEFAULT 1,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS route_rules (
    id                    TEXT PRIMARY KEY,
    name                  TEXT NOT NULL,
    enabled               INTEGER NOT NULL DEFAULT 1,
    priority              INTEGER NOT NULL DEFAULT 0,
    match_client_id       TEXT,
    match_model           TEXT,
    match_protocol        TEXT,
    target_channel_id     TEXT NOT NULL,
    target_account_id     TEXT NOT NULL,
    target_upstream_model TEXT NOT NULL,
    created_at            TEXT NOT NULL,
    updated_at            TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS account_balance_snapshots (
    id                   TEXT PRIMARY KEY,
    account_id           TEXT NOT NULL,
    balance              REAL,
    currency             TEXT,
    token_pack_total     INTEGER,
    token_pack_used      INTEGER,
    token_pack_remaining INTEGER,
    token_pack_expire_at TEXT,
    source               TEXT NOT NULL,
    synced_at            TEXT,
    remark               TEXT,
    created_at           TEXT NOT NULL,
    updated_at           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS request_logs (
    id                TEXT PRIMARY KEY,
    request_id        TEXT NOT NULL,
    agent_type        TEXT,
    agent_session_id  TEXT,
    parent_agent_session_id TEXT,
    client_id         TEXT,
    client_name       TEXT,
    channel_id        TEXT,
    channel_name      TEXT,
    account_id        TEXT,
    account_name      TEXT,
    client_protocol   TEXT NOT NULL,
    upstream_protocol TEXT NOT NULL,
    virtual_model     TEXT,
    public_model      TEXT,
    upstream_model    TEXT,
    request_type      TEXT NOT NULL DEFAULT 'unknown',
    method            TEXT NOT NULL,
    path              TEXT NOT NULL,
    status            INTEGER,
    latency_ms        INTEGER,
    is_stream         INTEGER NOT NULL DEFAULT 0,
    error_message     TEXT,
    fallback_count    INTEGER NOT NULL DEFAULT 0,
    route_reason      TEXT,
    created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_records (
    id                    TEXT PRIMARY KEY,
    request_id            TEXT NOT NULL,
    client_id             TEXT,
    client_name           TEXT,
    channel_id            TEXT,
    channel_name          TEXT,
    account_id            TEXT,
    account_name          TEXT,
    client_protocol       TEXT NOT NULL,
    upstream_protocol     TEXT NOT NULL,
    virtual_model         TEXT,
    upstream_model        TEXT,
    input_tokens          INTEGER,
    input_cached_tokens   INTEGER,
    input_uncached_tokens INTEGER,
    input_cache_write_tokens INTEGER,
    output_tokens         INTEGER,
    total_tokens          INTEGER,
    usage_status          TEXT NOT NULL DEFAULT 'complete',
    usage_source          TEXT NOT NULL DEFAULT 'upstream_response',
    estimated_cost        REAL,
    estimated_input_uncached_cost  REAL,
    estimated_input_cached_cost    REAL,
    estimated_input_cache_write_cost REAL,
    estimated_output_cost          REAL,
    analyzed_at           TEXT,
    created_at            TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS request_capture_refs (
    request_log_id   TEXT PRIMARY KEY,
    storage_key      TEXT,
    frame_offset     INTEGER,
    frame_length     INTEGER,
    checksum         TEXT,
    format_version   INTEGER NOT NULL DEFAULT 1,
    state            TEXT NOT NULL DEFAULT 'pending',
    failure_reason   TEXT,
    req_body_bytes   INTEGER NOT NULL DEFAULT 0,
    res_body_bytes   INTEGER NOT NULL DEFAULT 0,
    finalized_at     TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    FOREIGN KEY (request_log_id) REFERENCES request_logs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS app_meta (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- 三方服务凭据（Rust credentials 提交新增；旧库由 IF NOT EXISTS 直接补表）。
CREATE TABLE IF NOT EXISTS service_credentials (
    id                 TEXT PRIMARY KEY,
    name               TEXT NOT NULL,
    provider           TEXT NOT NULL,
    base_url           TEXT NOT NULL,
    secret_ciphertext  TEXT NOT NULL,
    secret_hint        TEXT NOT NULL,
    kind               TEXT NOT NULL DEFAULT 'cli_token',
    note               TEXT,
    env_prefix         TEXT,
    username           TEXT,
    enabled            INTEGER NOT NULL DEFAULT 1,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL,
    last_verified_at   TEXT,
    last_error         TEXT
);

CREATE INDEX IF NOT EXISTS idx_service_credentials_provider
    ON service_credentials(provider, enabled);

-- CLI 浏览器授权签发的凭据同步 token（flowlet login）：只存 SHA-256 哈希，
-- 作用域固定 credentials:read，仅允许 export_service_credentials。
CREATE TABLE IF NOT EXISTS cli_auth_tokens (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL DEFAULT '',
    token_hash   TEXT NOT NULL UNIQUE,
    scope        TEXT NOT NULL DEFAULT 'credentials:read',
    created_at   TEXT NOT NULL,
    expires_at   TEXT NOT NULL,
    last_used_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_cli_auth_tokens_expires
    ON cli_auth_tokens(expires_at);

CREATE TABLE IF NOT EXISTS known_devices (
    device_id               TEXT PRIMARY KEY,
    device_created_at       TEXT NOT NULL,
    display_name            TEXT NOT NULL DEFAULT '',
    platform                TEXT NOT NULL DEFAULT 'unknown',
    app_version             TEXT NOT NULL DEFAULT 'unknown',
    timezone_offset_minutes INTEGER NOT NULL,
    profile_generated_at    TEXT NOT NULL DEFAULT '',
    first_seen_at           TEXT NOT NULL,
    last_seen_at            TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS device_daily_usage (
    device_id                   TEXT NOT NULL,
    usage_date                  TEXT NOT NULL,
    request_count               INTEGER NOT NULL,
    known_tokens                INTEGER NOT NULL,
    input_tokens                INTEGER NOT NULL,
    input_cached_tokens         INTEGER NOT NULL,
    input_uncached_tokens       INTEGER NOT NULL,
    cache_measured_input_tokens INTEGER NOT NULL,
    output_tokens               INTEGER NOT NULL,
    unknown_count               INTEGER NOT NULL,
    estimated_cost              REAL NOT NULL DEFAULT 0,
    snapshot_generated_at       TEXT NOT NULL,
    imported_at                 TEXT NOT NULL,
    PRIMARY KEY (device_id, usage_date),
    FOREIGN KEY (device_id) REFERENCES known_devices(device_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS device_hourly_usage (
    device_id             TEXT NOT NULL,
    usage_hour            TEXT NOT NULL,
    request_count         INTEGER NOT NULL,
    known_tokens          INTEGER NOT NULL,
    input_tokens          INTEGER NOT NULL DEFAULT 0,
    input_cached_tokens   INTEGER NOT NULL DEFAULT 0,
    cache_measured_input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens         INTEGER NOT NULL DEFAULT 0,
    unknown_count         INTEGER NOT NULL DEFAULT 0,
    estimated_cost        REAL NOT NULL DEFAULT 0,
    native_input_tokens   INTEGER NOT NULL DEFAULT 0,
    native_cached_input_tokens INTEGER NOT NULL DEFAULT 0,
    native_cache_write_input_tokens INTEGER NOT NULL DEFAULT 0,
    native_output_tokens  INTEGER NOT NULL DEFAULT 0,
    native_reasoning_tokens INTEGER NOT NULL DEFAULT 0,
    snapshot_generated_at TEXT NOT NULL,
    imported_at           TEXT NOT NULL,
    PRIMARY KEY (device_id, usage_hour),
    FOREIGN KEY (device_id) REFERENCES known_devices(device_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS device_agent_sessions (
    device_id             TEXT NOT NULL,
    agent_type            TEXT NOT NULL,
    session_id            TEXT NOT NULL,
    runtime_status        TEXT NOT NULL,
    activity_at           TEXT NOT NULL,
    session_json          TEXT NOT NULL,
    snapshot_generated_at TEXT NOT NULL,
    imported_at           TEXT NOT NULL,
    PRIMARY KEY (device_id, agent_type, session_id),
    FOREIGN KEY (device_id) REFERENCES known_devices(device_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_device_agent_sessions_activity
    ON device_agent_sessions(device_id, activity_at DESC);

CREATE TABLE IF NOT EXISTS device_agent_profiles (
    device_id             TEXT NOT NULL,
    agent_id              TEXT NOT NULL,
    profile_json          TEXT NOT NULL,
    snapshot_generated_at TEXT NOT NULL,
    imported_at           TEXT NOT NULL,
    PRIMARY KEY (device_id, agent_id),
    FOREIGN KEY (device_id) REFERENCES known_devices(device_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS device_account_resources (
    device_id             TEXT NOT NULL,
    account_id            TEXT NOT NULL,
    resource_json         TEXT NOT NULL,
    observed_at           TEXT NOT NULL,
    snapshot_generated_at TEXT NOT NULL,
    imported_at           TEXT NOT NULL,
    PRIMARY KEY (device_id, account_id),
    FOREIGN KEY (device_id) REFERENCES known_devices(device_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_device_account_resources_latest
    ON device_account_resources(account_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS device_usage_breakdowns (
    device_id                    TEXT NOT NULL,
    breakdown_date               TEXT NOT NULL,
    client_id                    TEXT,
    client_name                  TEXT,
    channel_id                   TEXT,
    channel_name                 TEXT,
    account_id                   TEXT,
    account_name                 TEXT,
    upstream_model               TEXT,
    request_count                INTEGER NOT NULL DEFAULT 0,
    known_tokens                 INTEGER NOT NULL DEFAULT 0,
    input_tokens                 INTEGER NOT NULL DEFAULT 0,
    input_cached_tokens          INTEGER NOT NULL DEFAULT 0,
    input_uncached_tokens        INTEGER NOT NULL DEFAULT 0,
    cache_measured_input_tokens  INTEGER NOT NULL DEFAULT 0,
    output_tokens                INTEGER NOT NULL DEFAULT 0,
    unknown_count                INTEGER NOT NULL DEFAULT 0,
    estimated_cost               REAL    NOT NULL DEFAULT 0,
    estimated_cost_currency      TEXT,
    native_event_count           INTEGER NOT NULL DEFAULT 0,
    elapsed_total_ms             INTEGER NOT NULL DEFAULT 0,
    elapsed_measured_count       INTEGER NOT NULL DEFAULT 0,
    generation_total_ms          INTEGER NOT NULL DEFAULT 0,
    generation_output_tokens     INTEGER NOT NULL DEFAULT 0,
    imported_at                  TEXT NOT NULL,
    PRIMARY KEY (device_id, breakdown_date, client_id, channel_id, account_id, upstream_model)
);

CREATE TABLE IF NOT EXISTS agent_session_snapshots (
    agent_type TEXT NOT NULL,
    session_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    summary_json TEXT NOT NULL,
    session_json TEXT,
    source_offset INTEGER NOT NULL DEFAULT 0,
    parser_version INTEGER NOT NULL DEFAULT 0,
    usage_ids_json TEXT NOT NULL DEFAULT '[]',
    cursor_guard TEXT NOT NULL DEFAULT '',
    synced_at TEXT NOT NULL,
    PRIMARY KEY (agent_type, session_id)
);

CREATE TABLE IF NOT EXISTS agent_session_metadata (
    -- 会话派生元数据（docs/agent-session-metadata.md §2）：Node Host 从模型请求体派生
    -- 标题/项目路径并 upsert；老库启动时由 IF NOT EXISTS 自动补建，不建额外索引
    -- （主键已覆盖会话聚合的 LEFT JOIN）。
    agent_type   TEXT NOT NULL,
    session_id   TEXT NOT NULL,
    title        TEXT,
    project_path TEXT,
    -- 'derived' = 服务端近似派生（非用户手工命名）；后续更可信来源用优先级覆盖。
    source       TEXT NOT NULL DEFAULT 'derived',
    updated_at   TEXT NOT NULL,
    PRIMARY KEY (agent_type, session_id)
);

CREATE TABLE IF NOT EXISTS agent_usage_events (
    agent_type               TEXT NOT NULL,
    session_id               TEXT NOT NULL,
    event_id                 TEXT NOT NULL,
    event_time               TEXT NOT NULL,
    model                    TEXT,
    input_tokens             INTEGER NOT NULL DEFAULT 0,
    cached_input_tokens      INTEGER NOT NULL DEFAULT 0,
    cache_write_input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens            INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens         INTEGER NOT NULL DEFAULT 0,
    total_tokens             INTEGER NOT NULL DEFAULT 0,
    synced_at                TEXT NOT NULL,
    PRIMARY KEY (agent_type, session_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_usage_events_time
    ON agent_usage_events(event_time);

CREATE TABLE IF NOT EXISTS agent_source_sync_state (
    agent_type TEXT PRIMARY KEY,
    last_checked_at TEXT,
    last_synced_at TEXT,
    status TEXT NOT NULL DEFAULT 'idle',
    last_error TEXT,
    scanned_count INTEGER NOT NULL DEFAULT 0,
    changed_count INTEGER NOT NULL DEFAULT 0,
    failed_count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS background_jobs (
    id TEXT PRIMARY KEY,
    job_type TEXT NOT NULL,
    title TEXT NOT NULL,
    trigger_source TEXT NOT NULL,
    status TEXT NOT NULL,
    stage TEXT,
    progress_current INTEGER NOT NULL DEFAULT 0,
    progress_total INTEGER NOT NULL DEFAULT 0,
    summary_json TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS background_job_events (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    level TEXT NOT NULL,
    stage TEXT,
    message TEXT NOT NULL,
    detail_json TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_background_jobs_created_at
    ON background_jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_background_job_events_job
    ON background_job_events(job_id, sequence);
`;

/** 幂等补列（Rust `add_column_if_missing` 调用，逐条照搬）。 */
const ADDED_COLUMNS: ReadonlyArray<readonly [string, string, string]> = [
  ["device_usage_breakdowns", "estimated_cost_currency", "TEXT"],
  ["device_usage_breakdowns", "native_event_count", "INTEGER NOT NULL DEFAULT 0"],
  ["background_jobs", "cancel_requested", "INTEGER NOT NULL DEFAULT 0"],
  ["agent_session_snapshots", "session_json", "TEXT"],
  ["agent_session_snapshots", "source_offset", "INTEGER NOT NULL DEFAULT 0"],
  ["agent_session_snapshots", "parser_version", "INTEGER NOT NULL DEFAULT 0"],
  ["agent_session_snapshots", "usage_ids_json", "TEXT NOT NULL DEFAULT '[]'"],
  ["agent_session_snapshots", "cursor_guard", "TEXT NOT NULL DEFAULT ''"],
  ["device_daily_usage", "estimated_cost", "REAL NOT NULL DEFAULT 0"],
  ["device_hourly_usage", "input_tokens", "INTEGER NOT NULL DEFAULT 0"],
  ["device_hourly_usage", "input_cached_tokens", "INTEGER NOT NULL DEFAULT 0"],
  ["device_hourly_usage", "cache_measured_input_tokens", "INTEGER NOT NULL DEFAULT 0"],
  ["device_hourly_usage", "output_tokens", "INTEGER NOT NULL DEFAULT 0"],
  ["device_hourly_usage", "unknown_count", "INTEGER NOT NULL DEFAULT 0"],
  ["device_hourly_usage", "estimated_cost", "REAL NOT NULL DEFAULT 0"],
  ["device_hourly_usage", "native_event_count", "INTEGER NOT NULL DEFAULT 0"],
  ["device_hourly_usage", "native_input_tokens", "INTEGER NOT NULL DEFAULT 0"],
  ["device_hourly_usage", "native_cached_input_tokens", "INTEGER NOT NULL DEFAULT 0"],
  ["device_hourly_usage", "native_cache_write_input_tokens", "INTEGER NOT NULL DEFAULT 0"],
  ["device_hourly_usage", "native_output_tokens", "INTEGER NOT NULL DEFAULT 0"],
  ["device_hourly_usage", "native_reasoning_tokens", "INTEGER NOT NULL DEFAULT 0"],
  ["device_hourly_usage", "native_total_tokens", "INTEGER NOT NULL DEFAULT 0"],
  ["channel_presets", "openai_auth", "TEXT NOT NULL DEFAULT 'bearer'"],
  ["channel_models", "pricing_json", "TEXT"],
  ["channel_presets", "anthropic_auth", "TEXT NOT NULL DEFAULT 'bearer'"],
  ["channel_presets", "small_model", "TEXT"],
  ["channel_presets", "timeout_seconds", "INTEGER"],
  ["virtual_model_routes", "virtual_model_id", "TEXT NOT NULL DEFAULT 'auto'"],
  ["virtual_model_routes", "channel_id", "TEXT NOT NULL DEFAULT ''"],
  ["virtual_model_routes", "account_id", "TEXT NOT NULL DEFAULT ''"],
  ["virtual_model_routes", "upstream_model", "TEXT NOT NULL DEFAULT ''"],
  ["channel_accounts", "credential_status", "TEXT NOT NULL DEFAULT 'healthy'"],
  ["channel_accounts", "management_key", "TEXT"],
  ["virtual_model_routes", "client_protocol", "TEXT NOT NULL DEFAULT 'openai'"],
  ["virtual_model_routes", "priority", "INTEGER NOT NULL DEFAULT 0"],
  ["virtual_model_routes", "enabled", "INTEGER NOT NULL DEFAULT 1"],
  ["virtual_model_routes", "created_at", "TEXT NOT NULL DEFAULT ''"],
  ["virtual_model_routes", "updated_at", "TEXT NOT NULL DEFAULT ''"],
  ["channel_presets", "platform_url", "TEXT"],
  ["known_devices", "display_name", "TEXT NOT NULL DEFAULT ''"],
  ["known_devices", "platform", "TEXT NOT NULL DEFAULT 'unknown'"],
  ["known_devices", "app_version", "TEXT NOT NULL DEFAULT 'unknown'"],
  ["known_devices", "profile_generated_at", "TEXT NOT NULL DEFAULT ''"],
  ["account_balance_snapshots", "token_packs", "TEXT"],
  ["account_balance_snapshots", "raw_scraped_json", "TEXT"],
  ["channel_presets", "supports_scrape_balance", "INTEGER NOT NULL DEFAULT 0"],
  ["channel_presets", "supports_files_api", "INTEGER NOT NULL DEFAULT 0"],
  ["channel_accounts", "base_url_override", "TEXT"],
  ["channel_accounts", "use_upstream_proxy", "INTEGER"],
  ["channel_accounts", "anthropic_base_url_override", "TEXT"],
  ["channel_accounts", "resource_mode", "TEXT"],
  ["channel_accounts", "resource_sync_mode", "TEXT NOT NULL DEFAULT 'manual'"],
  ["channel_accounts", "synced_models", "TEXT"],
  ["channel_accounts", "models_synced_at", "TEXT"],
  ["channel_accounts", "exposed_models", "TEXT"],
  ["request_logs", "request_id", "TEXT NOT NULL DEFAULT ''"],
  ["request_logs", "agent_type", "TEXT"],
  ["request_logs", "agent_session_id", "TEXT"],
  ["request_logs", "parent_agent_session_id", "TEXT"],
  ["request_logs", "client_id", "TEXT"],
  ["request_logs", "client_name", "TEXT"],
  ["request_logs", "channel_id", "TEXT"],
  ["request_logs", "channel_name", "TEXT"],
  ["request_logs", "account_id", "TEXT"],
  ["request_logs", "account_name", "TEXT"],
  ["request_logs", "client_protocol", "TEXT NOT NULL DEFAULT 'openai'"],
  ["request_logs", "upstream_protocol", "TEXT NOT NULL DEFAULT 'openai'"],
  ["request_logs", "virtual_model", "TEXT"],
  ["request_logs", "public_model", "TEXT"],
  ["request_logs", "upstream_model", "TEXT"],
  ["request_logs", "request_type", "TEXT NOT NULL DEFAULT 'unknown'"],
  ["request_logs", "method", "TEXT NOT NULL DEFAULT ''"],
  ["request_logs", "path", "TEXT NOT NULL DEFAULT ''"],
  ["request_logs", "status", "INTEGER"],
  ["request_logs", "latency_ms", "INTEGER"],
  ["request_logs", "is_stream", "INTEGER NOT NULL DEFAULT 0"],
  ["request_logs", "error_message", "TEXT"],
  ["request_logs", "fallback_count", "INTEGER NOT NULL DEFAULT 0"],
  ["request_logs", "route_reason", "TEXT"],
  ["request_logs", "upstream_proxy_used", "INTEGER"],
  ["request_logs", "created_at", "TEXT NOT NULL DEFAULT ''"],
  ["request_logs", "ttfb_ms", "INTEGER"],
  ["request_logs", "ttft_ms", "INTEGER"],
  ["request_logs", "duration_ms", "INTEGER"],
  ["request_logs", "upstream_url", "TEXT"],
  ["request_logs", "attempt_seq", "INTEGER NOT NULL DEFAULT 0"],
  ["request_logs", "req_headers_json", "TEXT"],
  ["request_logs", "req_body_b64", "TEXT"],
  ["request_logs", "req_body_cleared_at", "TEXT"],
  ["request_logs", "req_body_cleanup_reason", "TEXT"],
  ["request_logs", "res_headers_json", "TEXT"],
  ["request_logs", "res_body_b64", "TEXT"],
  ["request_logs", "res_body_cleared_at", "TEXT"],
  ["request_logs", "res_body_cleanup_reason", "TEXT"],
  ["request_logs", "is_last_attempt", "INTEGER NOT NULL DEFAULT 1"],
  ["usage_records", "request_id", "TEXT NOT NULL DEFAULT ''"],
  ["usage_records", "client_id", "TEXT"],
  ["usage_records", "client_name", "TEXT"],
  ["usage_records", "channel_id", "TEXT"],
  ["usage_records", "channel_name", "TEXT"],
  ["usage_records", "account_id", "TEXT"],
  ["usage_records", "account_name", "TEXT"],
  ["usage_records", "client_protocol", "TEXT NOT NULL DEFAULT 'openai'"],
  ["usage_records", "upstream_protocol", "TEXT NOT NULL DEFAULT 'openai'"],
  ["usage_records", "virtual_model", "TEXT"],
  ["usage_records", "upstream_model", "TEXT"],
  ["usage_records", "input_tokens", "INTEGER"],
  ["usage_records", "input_cached_tokens", "INTEGER"],
  ["usage_records", "input_uncached_tokens", "INTEGER"],
  ["usage_records", "input_cache_write_tokens", "INTEGER"],
  ["usage_records", "output_tokens", "INTEGER"],
  ["usage_records", "total_tokens", "INTEGER"],
  ["usage_records", "usage_status", "TEXT NOT NULL DEFAULT 'complete'"],
  ["usage_records", "usage_source", "TEXT NOT NULL DEFAULT 'upstream_response'"],
  ["usage_records", "estimated_cost", "REAL"],
  ["usage_records", "estimated_input_uncached_cost", "REAL"],
  ["usage_records", "estimated_input_cached_cost", "REAL"],
  ["usage_records", "estimated_input_cache_write_cost", "REAL"],
  ["usage_records", "estimated_output_cost", "REAL"],
  ["usage_records", "analyzed_at", "TEXT"],
  ["channel_presets", "enabled", "INTEGER NOT NULL DEFAULT 1"],
  ["usage_records", "created_at", "TEXT NOT NULL DEFAULT ''"],
  ["service_credentials", "env_prefix", "TEXT"],
  ["service_credentials", "username", "TEXT"],
];

/** Rust 里 `for column in [...]` 循环补的 device_daily_usage 原生列。 */
const DEVICE_DAILY_NATIVE_COLUMNS = [
  "native_event_count",
  "native_input_tokens",
  "native_cached_input_tokens",
  "native_cache_write_input_tokens",
  "native_output_tokens",
  "native_reasoning_tokens",
  "native_total_tokens",
];

export function tableHasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const row = db
    .prepare(`SELECT count(*) AS total FROM pragma_table_info('${table}') WHERE name = ?1`)
    .get(column) as { total: number } | undefined;
  return (row?.total ?? 0) > 0;
}

export function addColumnIfMissing(
  db: DatabaseSync,
  table: string,
  column: string,
  definition: string,
): void {
  if (tableHasColumn(db, table, column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function nowRfc3339(): string {
  return new Date().toISOString();
}

/** Rust `normalize_legacy_virtual_model_routes_schema`（provider_name/provider_id 旧列重建）。 */
function normalizeLegacyVirtualModelRoutesSchema(db: DatabaseSync): void {
  if (
    !tableHasColumn(db, "virtual_model_routes", "provider_name") &&
    !tableHasColumn(db, "virtual_model_routes", "provider_id")
  ) {
    return;
  }
  const columnOr = (column: string, fallback: string): string =>
    tableHasColumn(db, "virtual_model_routes", column) ? `COALESCE(${column}, ${fallback})` : fallback;
  const providerNameExists = tableHasColumn(db, "virtual_model_routes", "provider_name");
  const providerIdExists = tableHasColumn(db, "virtual_model_routes", "provider_id");
  const virtualModelId = tableHasColumn(db, "virtual_model_routes", "virtual_model_id")
    ? "COALESCE(virtual_model_id, 'auto')"
    : providerNameExists
      ? "COALESCE(provider_name, 'auto')"
      : "'auto'";
  const channelId = tableHasColumn(db, "virtual_model_routes", "channel_id")
    ? "COALESCE(channel_id, '')"
    : providerIdExists
      ? "COALESCE(provider_id, '')"
      : "''";
  const upstreamModel = tableHasColumn(db, "virtual_model_routes", "upstream_model")
    ? "COALESCE(upstream_model, '')"
    : providerNameExists
      ? "COALESCE(provider_name, '')"
      : "''";
  const accountId = columnOr("account_id", "''");
  const priority = columnOr("priority", "0");
  const enabled = columnOr("enabled", "1");
  const createdAt = columnOr("created_at", "NULL");
  const updatedAt = columnOr("updated_at", "NULL");
  const clientProtocol = tableHasColumn(db, "virtual_model_routes", "client_protocol")
    ? "CASE client_protocol WHEN 'anthropic' THEN 'anthropic' ELSE 'openai' END"
    : "'openai'";
  const now = nowRfc3339();
  db.exec(`
    DROP TABLE IF EXISTS virtual_model_routes_legacy_migrate;
    ALTER TABLE virtual_model_routes RENAME TO virtual_model_routes_legacy_migrate;
    CREATE TABLE virtual_model_routes (
        id               TEXT PRIMARY KEY,
        virtual_model_id TEXT NOT NULL,
        channel_id       TEXT NOT NULL DEFAULT '',
        account_id       TEXT NOT NULL DEFAULT '',
        upstream_model   TEXT NOT NULL,
        client_protocol  TEXT NOT NULL DEFAULT 'openai',
        priority         INTEGER NOT NULL DEFAULT 0,
        enabled          INTEGER NOT NULL DEFAULT 1,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL
    );
    INSERT INTO virtual_model_routes (
        id, virtual_model_id, channel_id, account_id, upstream_model,
        client_protocol, priority, enabled, created_at, updated_at
    )
    SELECT
        id,
        ${virtualModelId},
        ${channelId},
        ${accountId},
        ${upstreamModel},
        ${clientProtocol},
        ${priority},
        ${enabled},
        COALESCE(${createdAt}, '${now}'),
        COALESCE(${updatedAt}, '${now}')
    FROM virtual_model_routes_legacy_migrate;
    DROP TABLE virtual_model_routes_legacy_migrate;
  `);
}

interface StoredRoute {
  id: string;
  virtual_model_id: string;
  channel_id: string;
  account_id: string;
  upstream_model: string;
  client_protocol: string;
  priority: number;
  enabled: boolean;
  created_at: string;
}

function routeOrder(left: StoredRoute, right: StoredRoute): number {
  if (left.priority !== right.priority) return left.priority - right.priority;
  const byCreated = left.created_at.localeCompare(right.created_at);
  return byCreated !== 0 ? byCreated : left.id.localeCompare(right.id);
}

/** 旧聚合模型路由 → 直接模型路由（Rust `migrate_legacy_aggregate_routes`）。 */
function migrateLegacyAggregateRoutes(
  db: DatabaseSync,
  findModel: (name: string) => ModelIdentity | null,
): void {
  const LEGACY_AGGREGATE_MODEL_IDS = new Set(["flowlet-pro", "flowlet-flash"]);
  const rows = db
    .prepare(
      `SELECT id, virtual_model_id, channel_id, account_id, upstream_model,
              client_protocol, priority, enabled, created_at
       FROM virtual_model_routes ORDER BY id ASC`,
    )
    .all() as Array<Record<string, unknown>>;
  const routes: StoredRoute[] = rows.map((row) => ({
    id: String(row.id),
    virtual_model_id: String(row.virtual_model_id),
    channel_id: String(row.channel_id),
    account_id: String(row.account_id),
    upstream_model: String(row.upstream_model),
    client_protocol: String(row.client_protocol),
    priority: Number(row.priority),
    enabled: Number(row.enabled) !== 0,
    created_at: String(row.created_at),
  }));
  const original = routes.map((route) => ({ ...route }));
  const migrated = routes.map(() => false);
  routes.forEach((route, index) => {
    const legacyId = route.virtual_model_id.trim().toLowerCase();
    if (!LEGACY_AGGREGATE_MODEL_IDS.has(legacyId)) return;
    const identity = findModel(route.upstream_model.trim());
    if (!identity) return;
    route.virtual_model_id = identity.id;
    migrated[index] = true;
  });
  if (!migrated.some(Boolean)) return;

  const groups = new Map<string, number[]>();
  routes.forEach((route, index) => {
    const key = [
      route.virtual_model_id,
      route.channel_id,
      route.account_id,
      route.upstream_model,
      route.client_protocol,
    ].join("\0");
    const bucket = groups.get(key);
    if (bucket) bucket.push(index);
    else groups.set(key, [index]);
  });
  const dropped = routes.map(() => false);
  const affectedGroups = new Set<string>();
  for (const indices of groups.values()) {
    if (!indices.some((index) => migrated[index])) continue;
    const representative = indices.reduce((best, index) =>
      routeOrder(routes[best], routes[index]) <= 0 ? best : index,
    );
    affectedGroups.add(
      `${routes[representative].virtual_model_id}\0${routes[representative].client_protocol}`,
    );
    if (indices.length < 2) continue;
    const anyEnabled = indices.some((index) => routes[index].enabled);
    for (const index of indices) {
      if (index === representative) routes[representative].enabled = anyEnabled;
      else dropped[index] = true;
    }
  }

  const priorities = new Map<number, number>();
  for (const groupKey of affectedGroups) {
    const [virtualModelId, clientProtocol] = groupKey.split("\0");
    const indices = routes
      .map((_, index) => index)
      .filter(
        (index) =>
          !dropped[index] &&
          routes[index].virtual_model_id === virtualModelId &&
          routes[index].client_protocol === clientProtocol,
      )
      .sort((left, right) => routeOrder(routes[left], routes[right]));
    indices.forEach((index, position) => priorities.set(index, position));
  }

  const now = nowRfc3339();
  db.exec("BEGIN");
  try {
    routes.forEach((route, index) => {
      if (dropped[index]) {
        db.prepare("DELETE FROM virtual_model_routes WHERE id = ?1").run(route.id);
        return;
      }
      const priority = priorities.get(index);
      if (priority === undefined) return;
      const before = original[index];
      if (
        before.virtual_model_id === route.virtual_model_id &&
        before.priority === priority &&
        before.enabled === route.enabled
      ) {
        return;
      }
      db.prepare(
        `UPDATE virtual_model_routes SET virtual_model_id = ?1, priority = ?2,
                enabled = ?3, updated_at = ?4 WHERE id = ?5`,
      ).run(route.virtual_model_id, priority, route.enabled ? 1 : 0, now, route.id);
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Rust `remove_legacy_aggregate_virtual_models`。 */
function removeLegacyAggregateVirtualModels(db: DatabaseSync): void {
  db.prepare(
    "DELETE FROM virtual_models WHERE lower(trim(id)) IN (?1, ?2)",
  ).run("flowlet-pro", "flowlet-flash");
}

/** Rust `drop_project_management_schema`（先关外键再按子→父顺序删表）。 */
function dropProjectManagementSchema(db: DatabaseSync): void {
  const foreignKeys = (db.prepare("PRAGMA foreign_keys").get() as { foreign_keys?: number } | undefined)
    ?.foreign_keys;
  db.exec("PRAGMA foreign_keys = OFF;");
  let failure: unknown = null;
  try {
    db.exec(`
      DROP TABLE IF EXISTS project_tasks;
      DROP TABLE IF EXISTS projects;
      DROP TABLE IF EXISTS recurring_task_runs;
      DROP TABLE IF EXISTS recurring_tasks;
      DROP TABLE IF EXISTS device_projects;
      DELETE FROM background_job_events
          WHERE job_id IN (
              SELECT id FROM background_jobs
              WHERE job_type IN ('project-task-run', 'recurring-task-run', 'project-workspace-sync')
          );
      DELETE FROM background_jobs
          WHERE job_type IN ('project-task-run', 'recurring-task-run', 'project-workspace-sync');
      DELETE FROM app_meta
          WHERE key IN ('task_review_notification_enabled', 'project_workspace_etags_v1');
    `);
  } catch (error) {
    failure = error;
  }
  if (foreignKeys) db.exec("PRAGMA foreign_keys = ON;");
  if (failure) throw failure;
}

export interface MigrateOptions {
  /** 旧聚合路由归一使用的模型目录查找（默认全局 model-catalog 单例）。 */
  findModel?: (name: string) => ModelIdentity | null;
}

/** 完整迁移：建表/索引 → 补列 → 重建表 → 数据归一 → 一次性修复 → 清理过期任务。 */
export function migrate(db: DatabaseSync, options: MigrateOptions = {}): void {
  db.exec(BASE_SCHEMA);

  addColumnIfMissing(db, "device_usage_breakdowns", "estimated_cost_currency", "TEXT");
  addColumnIfMissing(db, "device_usage_breakdowns", "native_event_count", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "background_jobs", "cancel_requested", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "device_daily_usage", "estimated_cost", "REAL NOT NULL DEFAULT 0");
  for (const column of DEVICE_DAILY_NATIVE_COLUMNS) {
    addColumnIfMissing(db, "device_daily_usage", column, "INTEGER NOT NULL DEFAULT 0");
  }

  // 启动时清理：90 天前完成的后台任务与其事件；把 queued/running 改为 interrupted。
  db.prepare(
    `DELETE FROM background_job_events WHERE job_id IN (
       SELECT id FROM background_jobs
       WHERE status NOT IN ('queued', 'running') AND created_at < datetime('now', '-90 days')
     )`,
  ).run();
  db.prepare(
    `DELETE FROM background_jobs
     WHERE status NOT IN ('queued', 'running') AND created_at < datetime('now', '-90 days')`,
  ).run();
  db.prepare(
    `UPDATE background_jobs SET status = 'interrupted', stage = '应用已重启',
            finished_at = datetime('now'), updated_at = datetime('now')
     WHERE status IN ('queued', 'running')`,
  ).run();

  normalizeLegacyVirtualModelRoutesSchema(db);

  // 一次性迁移的判断必须发生在补列之前（Rust 先 table_has_column 再 add_column_if_missing）。
  const needsAnthropicOverrideMigration = !tableHasColumn(
    db,
    "channel_accounts",
    "anthropic_base_url_override",
  );
  const needsUsageStatusMigration = !tableHasColumn(db, "usage_records", "usage_status");
  const needsUsageSourceMigration = !tableHasColumn(db, "usage_records", "usage_source");

  for (const [table, column, definition] of ADDED_COLUMNS) {
    addColumnIfMissing(db, table, column, definition);
  }

  // 旧版单一覆盖地址同时作用于两种协议：首次补列时复制一份以保持兼容。
  if (needsAnthropicOverrideMigration) {
    db.prepare(
      `UPDATE channel_accounts SET anthropic_base_url_override = base_url_override
       WHERE base_url_override IS NOT NULL AND trim(base_url_override) <> ''`,
    ).run();
  }

  // 数据归一（每次启动幂等执行）。
  db.prepare("UPDATE channel_accounts SET resource_mode = 'hybrid' WHERE channel_id = 'longcat'").run();
  db.prepare(
    "UPDATE channel_accounts SET resource_sync_mode = 'auto' WHERE channel_id = 'qwen' AND resource_mode = 'token_plan'",
  ).run();
  db.prepare(
    "UPDATE channel_accounts SET resource_sync_mode = 'auto' WHERE channel_id = 'qwen' AND resource_mode = 'pay_as_you_go'",
  ).run();
  db.prepare("UPDATE channel_accounts SET resource_sync_mode = 'auto' WHERE channel_id = 'zhipu'").run();
  db.prepare(
    "UPDATE channel_accounts SET resource_sync_mode = 'manual' WHERE channel_id = 'openai-api' AND resource_sync_mode = 'auto'",
  ).run();

  // usage_status / usage_source 首次补列时按 token 列推断 / 标记 legacy（判断在补列前）。
  if (needsUsageStatusMigration) {
    db.prepare(
      `UPDATE usage_records
       SET usage_status = CASE
           WHEN total_tokens IS NOT NULL THEN 'complete'
           WHEN input_tokens IS NOT NULL OR input_cached_tokens IS NOT NULL
             OR input_uncached_tokens IS NOT NULL OR input_cache_write_tokens IS NOT NULL
             OR output_tokens IS NOT NULL THEN 'partial'
           ELSE 'unknown'
       END`,
    ).run();
  }
  if (needsUsageSourceMigration) {
    db.prepare("UPDATE usage_records SET usage_source = 'legacy'").run();
  }

  // 性能索引（2026-07-04）。
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_request_logs_created_at       ON request_logs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_request_logs_request_id       ON request_logs(request_id);
    CREATE INDEX IF NOT EXISTS idx_request_logs_is_last_attempt  ON request_logs(is_last_attempt);
    CREATE INDEX IF NOT EXISTS idx_request_logs_usage_summary    ON request_logs(request_id, is_last_attempt, created_at);
    CREATE INDEX IF NOT EXISTS idx_request_logs_page             ON request_logs(is_last_attempt, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_request_logs_client           ON request_logs(client_id);
    CREATE INDEX IF NOT EXISTS idx_request_logs_account          ON request_logs(account_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_request_logs_agent_session    ON request_logs(agent_type, agent_session_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_request_logs_session_cover    ON request_logs(
        is_last_attempt, agent_type, agent_session_id, created_at DESC, request_id,
        parent_agent_session_id, client_id, client_name, status, error_message
    );
    CREATE INDEX IF NOT EXISTS idx_usage_records_request_id     ON usage_records(request_id);
    CREATE INDEX IF NOT EXISTS idx_usage_records_created_at     ON usage_records(created_at);
    CREATE INDEX IF NOT EXISTS idx_usage_channel_upstream_model ON usage_records(channel_id, upstream_model);
    CREATE INDEX IF NOT EXISTS idx_request_capture_refs_state  ON request_capture_refs(state, updated_at);
  `);

  db.prepare(
    `INSERT INTO app_meta (key, value, updated_at) VALUES ('schema_version', ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  ).run(SCHEMA_VERSION);

  // 删除已废弃的 stream_summary 列（流式摘要功能已移除）。
  if (tableHasColumn(db, "request_logs", "stream_summary")) {
    db.exec("ALTER TABLE request_logs DROP COLUMN stream_summary");
  }

  dropProjectManagementSchema(db);

  // 聚合模型移除（2026-11）：旧 flowlet-pro/flowlet-flash 路由改写为直接模型路由。
  const findModel =
    options.findModel ?? ((name: string): ModelIdentity | null => modelCatalog().find(name));
  migrateLegacyAggregateRoutes(db, findModel);
  removeLegacyAggregateVirtualModels(db);
}