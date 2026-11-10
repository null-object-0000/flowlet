// 渠道预设 / 账号 / 路由 / 模型 / 余额快照 / app_meta 的 SQL 层。
//
// 逐条对照 src-tauri/src/core/storage_config.rs 与 storage_usage.rs（余额快照、app_meta）：
// 同一表名、同一列名、同一 JSON 列编码（serde_json 字符串）、同一排序与默认值。
import type { DatabaseSync } from "node:sqlite";
import type { JsonRow } from "../types.ts";

function toInt(value: unknown): number {
  return Number(value);
}

function toBool(value: unknown): boolean {
  return toInt(value) !== 0;
}

function parseJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseOptionalStringArray(raw: unknown): string[] | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : null;
  } catch {
    return null;
  }
}

function now(): string {
  return new Date().toISOString();
}

// ─── app_meta ────────────────────────────────────────────────────────────────

export function getAppMeta(db: DatabaseSync, key: string): string | null {
  const row = db.prepare("SELECT value FROM app_meta WHERE key = ?1").get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : null;
}

export function setAppMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    `INSERT INTO app_meta (key, value, updated_at) VALUES (?1, ?2, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  ).run(key, value);
}

// ─── Channel presets ─────────────────────────────────────────────────────────

function presetFromRow(row: Record<string, unknown>): JsonRow {
  return {
    id: String(row.id),
    name: String(row.name),
    vendor: String(row.vendor),
    supported_protocols: parseJsonArray(typeof row.supported_protocols === "string" ? row.supported_protocols : null),
    openai_base_url: String(row.openai_base_url),
    anthropic_base_url: String(row.anthropic_base_url),
    openai_auth: row.openai_auth === "x_api_key" ? "x_api_key" : "bearer",
    anthropic_auth: row.anthropic_auth === "x_api_key" ? "x_api_key" : "bearer",
    default_model: String(row.default_model),
    small_model: row.small_model ?? null,
    timeout_seconds: row.timeout_seconds === null ? null : Number(row.timeout_seconds),
    supports_model_list: toBool(row.supports_model_list),
    supports_model_detail: toBool(row.supports_model_detail),
    supports_balance_query: toBool(row.supports_balance_query),
    supports_quota_query: toBool(row.supports_quota_query),
    supports_usage_query: toBool(row.supports_usage_query),
    supports_scrape_balance: toBool(row.supports_scrape_balance),
    supports_files_api: toBool(row.supports_files_api),
    platform_url: row.platform_url ?? null,
    enabled: toBool(row.enabled),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

const PRESET_SELECT = `SELECT id, name, vendor, supported_protocols, openai_base_url, anthropic_base_url,
       openai_auth, anthropic_auth, default_model, small_model, timeout_seconds, supports_model_list,
       supports_model_detail, supports_balance_query,
       supports_quota_query, supports_usage_query, supports_scrape_balance,
       supports_files_api,
       platform_url, enabled, created_at, updated_at
FROM channel_presets ORDER BY id ASC`;

export function listChannelPresets(db: DatabaseSync): JsonRow[] {
  return (db.prepare(PRESET_SELECT).all() as Array<Record<string, unknown>>).map(presetFromRow);
}

function presetProtocolsJson(preset: JsonRow): string {
  return JSON.stringify(
    Array.isArray(preset.supported_protocols)
      ? preset.supported_protocols.map((protocol: unknown) => String(protocol))
      : [],
  );
}

/** Rust save_channel_presets：全量替换（注意 Rust INSERT 未包含 supports_scrape_balance）。 */
export function saveChannelPresets(db: DatabaseSync, presets: JsonRow[]): void {
  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM channel_presets");
    const insert = db.prepare(
      `INSERT INTO channel_presets (
         id, name, vendor, supported_protocols, openai_base_url, anthropic_base_url,
         openai_auth, anthropic_auth, default_model, small_model, timeout_seconds, supports_model_list,
         supports_model_detail, supports_balance_query,
         supports_quota_query, supports_usage_query, supports_files_api,
         platform_url, enabled, created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)`,
    );
    for (const preset of presets) {
      insert.run(
        String(preset.id),
        String(preset.name),
        String(preset.vendor),
        presetProtocolsJson(preset),
        String(preset.openai_base_url ?? ""),
        String(preset.anthropic_base_url ?? ""),
        String(preset.openai_auth ?? "bearer"),
        String(preset.anthropic_auth ?? "bearer"),
        String(preset.default_model ?? ""),
        preset.small_model ?? null,
        preset.timeout_seconds ?? null,
        preset.supports_model_list ? 1 : 0,
        preset.supports_model_detail ? 1 : 0,
        preset.supports_balance_query ? 1 : 0,
        preset.supports_quota_query ? 1 : 0,
        preset.supports_usage_query ? 1 : 0,
        preset.supports_files_api ? 1 : 0,
        preset.platform_url ?? null,
        preset.enabled ? 1 : 0,
        String(preset.created_at ?? ""),
        String(preset.updated_at ?? ""),
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Rust ensure_preset_platform_urls：仅补齐 NULL 的 platform_url。 */
export function ensurePresetPlatformUrls(db: DatabaseSync, presets: JsonRow[]): void {
  const update = db.prepare(
    "UPDATE channel_presets SET platform_url = ?1 WHERE id = ?2 AND platform_url IS NULL",
  );
  for (const preset of presets) {
    const url = typeof preset.platform_url === "string" ? preset.platform_url : "";
    if (!url) continue;
    update.run(url, String(preset.id));
  }
}

/** Rust ensure_missing_presets：追加 SQLite 中缺失的渠道模板。 */
export function ensureMissingPresets(db: DatabaseSync, presets: JsonRow[]): void {
  const exists = db.prepare("SELECT COUNT(*) > 0 AS present FROM channel_presets WHERE id = ?1");
  const insert = db.prepare(
    `INSERT INTO channel_presets (
       id, name, vendor, supported_protocols, openai_base_url, anthropic_base_url,
       openai_auth, anthropic_auth, default_model, small_model, timeout_seconds, supports_model_list,
       supports_model_detail, supports_balance_query,
       supports_quota_query, supports_usage_query, supports_files_api,
       platform_url, created_at, updated_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)`,
  );
  for (const preset of presets) {
    const row = exists.get(String(preset.id)) as { present: number } | undefined;
    if (row && toInt(row.present) !== 0) continue;
    insert.run(
      String(preset.id),
      String(preset.name),
      String(preset.vendor),
      presetProtocolsJson(preset),
      String(preset.openai_base_url ?? ""),
      String(preset.anthropic_base_url ?? ""),
      String(preset.openai_auth ?? "bearer"),
      String(preset.anthropic_auth ?? "bearer"),
      String(preset.default_model ?? ""),
      preset.small_model ?? null,
      preset.timeout_seconds ?? null,
      preset.supports_model_list ? 1 : 0,
      preset.supports_model_detail ? 1 : 0,
      preset.supports_balance_query ? 1 : 0,
      preset.supports_quota_query ? 1 : 0,
      preset.supports_usage_query ? 1 : 0,
      preset.supports_files_api ? 1 : 0,
      preset.platform_url ?? null,
      String(preset.created_at ?? ""),
      String(preset.updated_at ?? ""),
    );
  }
}

/** Rust sync_preset_maintained_config：同步由 Flowlet 维护的渠道字段。 */
export function syncPresetMaintainedConfig(db: DatabaseSync, presets: JsonRow[]): void {
  const update = db.prepare(
    `UPDATE channel_presets
     SET name = ?1, supported_protocols = ?2, openai_base_url = ?3, anthropic_base_url = ?4,
         openai_auth = ?5, anthropic_auth = ?6, updated_at = ?7
     WHERE id = ?8`,
  );
  for (const preset of presets) {
    update.run(
      String(preset.name),
      presetProtocolsJson(preset),
      String(preset.openai_base_url ?? ""),
      String(preset.anthropic_base_url ?? ""),
      String(preset.openai_auth ?? "bearer"),
      String(preset.anthropic_auth ?? "bearer"),
      now(),
      String(preset.id),
    );
  }
}

export function ensurePresetBalanceQuery(db: DatabaseSync, presets: JsonRow[]): void {
  const update = db.prepare("UPDATE channel_presets SET supports_balance_query = ?1 WHERE id = ?2");
  for (const preset of presets) {
    update.run(preset.supports_balance_query ? 1 : 0, String(preset.id));
  }
}

export function ensurePresetScrapeBalance(db: DatabaseSync, presets: JsonRow[]): void {
  const update = db.prepare("UPDATE channel_presets SET supports_scrape_balance = ?1 WHERE id = ?2");
  for (const preset of presets) {
    update.run(preset.supports_scrape_balance ? 1 : 0, String(preset.id));
  }
}

export function ensurePresetFilesApi(db: DatabaseSync, presets: JsonRow[]): void {
  const update = db.prepare("UPDATE channel_presets SET supports_files_api = ?1 WHERE id = ?2");
  for (const preset of presets) {
    update.run(preset.supports_files_api ? 1 : 0, String(preset.id));
  }
}

// ─── Channel accounts ────────────────────────────────────────────────────────

const ACCOUNT_SELECT = `SELECT ca.id, links.workspace_account_id, ca.channel_id, ca.name, ca.api_key, ca.management_key, ca.enabled, ca.priority,
       ca.remark, ca.resource_mode, ca.resource_sync_mode, ca.base_url_override, ca.anthropic_base_url_override,
       defaults.openai_base_url, defaults.anthropic_base_url,
       ca.last_used_at, ca.last_error, ca.credential_status, ca.synced_models, ca.models_synced_at, ca.exposed_models,
       ca.created_at, ca.updated_at, ca.use_upstream_proxy
FROM channel_accounts ca
LEFT JOIN channel_account_workspace_links links ON links.local_account_id = ca.id
LEFT JOIN channel_account_workspace_defaults defaults ON defaults.workspace_account_id = links.workspace_account_id
ORDER BY ca.channel_id ASC, ca.priority ASC, ca.id ASC`;

function accountFromRow(row: Record<string, unknown>): JsonRow {
  return {
    id: String(row.id),
    workspace_account_id: row.workspace_account_id ?? null,
    channel_id: String(row.channel_id),
    name: String(row.name),
    api_key: String(row.api_key),
    management_key: row.management_key ?? null,
    enabled: toBool(row.enabled),
    priority: toInt(row.priority),
    remark: row.remark ?? null,
    resource_mode: row.resource_mode ?? null,
    resource_sync_mode: String(row.resource_sync_mode),
    base_url_override: row.base_url_override ?? null,
    anthropic_base_url_override: row.anthropic_base_url_override ?? null,
    workspace_default_base_url: row.openai_base_url ?? null,
    workspace_default_anthropic_base_url: row.anthropic_base_url ?? null,
    last_used_at: row.last_used_at ?? null,
    last_error: row.last_error ?? null,
    credential_status:
      typeof row.credential_status === "string" && row.credential_status
        ? row.credential_status
        : "healthy",
    synced_models: parseOptionalStringArray(row.synced_models),
    models_synced_at: row.models_synced_at ?? null,
    exposed_models: parseOptionalStringArray(row.exposed_models),
    use_upstream_proxy: row.use_upstream_proxy === null ? null : toBool(row.use_upstream_proxy),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export function listChannelAccounts(db: DatabaseSync): JsonRow[] {
  return (db.prepare(ACCOUNT_SELECT).all() as Array<Record<string, unknown>>).map(accountFromRow);
}

const ACCOUNT_CREDENTIAL_HEALTHY = "healthy";
const ACCOUNT_CREDENTIAL_INVALID_KEY = "invalid_key";

/**
 * Rust save_channel_accounts：全量替换；同一账号未改 key 且原状态 invalid_key 时保留
 * invalid_key（否则重置 healthy 并清空 last_error），并同步 workspace 链接/defaults。
 */
export function saveChannelAccounts(db: DatabaseSync, accounts: JsonRow[]): void {
  db.exec("BEGIN");
  try {
    const previous = new Map<string, { apiKey: string; status: string }>();
    const previousRows = db
      .prepare("SELECT id, api_key, credential_status FROM channel_accounts")
      .all() as Array<Record<string, unknown>>;
    for (const row of previousRows) {
      previous.set(String(row.id), {
        apiKey: String(row.api_key ?? ""),
        status: String(row.credential_status ?? ACCOUNT_CREDENTIAL_HEALTHY),
      });
    }
    db.exec("DELETE FROM channel_accounts");
    const insert = db.prepare(
      `INSERT INTO channel_accounts (
         id, channel_id, name, api_key, management_key, enabled, priority,
         remark, resource_mode, resource_sync_mode, base_url_override,
         anthropic_base_url_override, last_used_at, last_error,
         credential_status, synced_models, models_synced_at, exposed_models,
         created_at, updated_at, use_upstream_proxy
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)`,
    );
    const linkUpsert = db.prepare(
      `INSERT INTO channel_account_workspace_links (
         local_account_id, workspace_account_id, linked_at, updated_at
       ) VALUES (?1, ?2, ?3, ?3)
       ON CONFLICT(local_account_id) DO UPDATE SET
         workspace_account_id = excluded.workspace_account_id,
         updated_at = excluded.updated_at`,
    );
    const defaultsUpsert = db.prepare(
      `INSERT INTO channel_account_workspace_defaults (
         workspace_account_id, openai_base_url, anthropic_base_url, updated_at
       ) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(workspace_account_id) DO UPDATE SET
         openai_base_url = excluded.openai_base_url,
         anthropic_base_url = excluded.anthropic_base_url,
         updated_at = excluded.updated_at`,
    );
    for (const account of accounts) {
      const apiKey = String(account.api_key ?? "");
      const incomingStatus = String(account.credential_status ?? ACCOUNT_CREDENTIAL_HEALTHY);
      const prev = previous.get(String(account.id));
      let credentialStatus = ACCOUNT_CREDENTIAL_HEALTHY;
      let lastError: string | null = null;
      if (
        prev &&
        prev.apiKey === apiKey &&
        prev.status === ACCOUNT_CREDENTIAL_INVALID_KEY &&
        incomingStatus === ACCOUNT_CREDENTIAL_INVALID_KEY
      ) {
        credentialStatus = ACCOUNT_CREDENTIAL_INVALID_KEY;
        lastError = (account.last_error as string | null) ?? null;
      }
      const syncedModelsJson = Array.isArray(account.synced_models)
        ? JSON.stringify(account.synced_models)
        : null;
      const exposedModelsJson = Array.isArray(account.exposed_models)
        ? JSON.stringify(account.exposed_models)
        : null;
      insert.run(
        String(account.id),
        String(account.channel_id),
        String(account.name),
        apiKey,
        account.management_key ?? null,
        account.enabled ? 1 : 0,
        Number(account.priority ?? 0),
        account.remark ?? null,
        account.resource_mode ?? null,
        String(account.resource_sync_mode ?? "manual"),
        account.base_url_override ?? null,
        account.anthropic_base_url_override ?? null,
        account.last_used_at ?? null,
        lastError,
        credentialStatus,
        syncedModelsJson,
        account.models_synced_at ?? null,
        exposedModelsJson,
        String(account.created_at ?? ""),
        String(account.updated_at ?? ""),
        account.use_upstream_proxy === null || account.use_upstream_proxy === undefined
          ? null
          : account.use_upstream_proxy
            ? 1
            : 0,
      );
      const workspaceAccountId =
        typeof account.workspace_account_id === "string"
          ? account.workspace_account_id.trim()
          : "";
      if (workspaceAccountId) {
        linkUpsert.run(String(account.id), workspaceAccountId, String(account.updated_at ?? ""));
        defaultsUpsert.run(
          workspaceAccountId,
          account.workspace_default_base_url ?? null,
          account.workspace_default_anthropic_base_url ?? null,
          String(account.updated_at ?? ""),
        );
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function updateAccountLastUsed(db: DatabaseSync, accountId: string): void {
  db.prepare(
    "UPDATE channel_accounts SET last_used_at = datetime('now'), last_error = NULL WHERE id = ?1",
  ).run(accountId);
}

export function updateAccountLastError(db: DatabaseSync, accountId: string, error: string): void {
  db.prepare(
    "UPDATE channel_accounts SET last_error = ?2, updated_at = datetime('now') WHERE id = ?1",
  ).run(accountId, error);
}

export function updateAccountCredentialStatus(
  db: DatabaseSync,
  accountId: string,
  credentialStatus: string,
): boolean {
  const result = db
    .prepare(
      "UPDATE channel_accounts SET credential_status = ?2, updated_at = datetime('now') WHERE id = ?1",
    )
    .run(accountId, credentialStatus);
  return Number(result.changes) > 0;
}

export function localAccountIdForWorkspace(db: DatabaseSync, workspaceAccountId: string): string | null {
  const row = db
    .prepare(
      "SELECT local_account_id FROM channel_account_workspace_links WHERE workspace_account_id = ?1",
    )
    .get(workspaceAccountId) as { local_account_id: string } | undefined;
  return row ? row.local_account_id : null;
}

// ─── Channel models ──────────────────────────────────────────────────────────

export function listChannelModels(db: DatabaseSync): JsonRow[] {
  const rows = db
    .prepare(
      `SELECT id, channel_id, model, display_name, supported_protocols,
              context_window, max_output_tokens, pricing_json, supports_stream, enabled,
              source, synced_at, created_at, updated_at
       FROM channel_models ORDER BY channel_id ASC, model ASC`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((row) => {
    let pricing: unknown = null;
    if (typeof row.pricing_json === "string") {
      try {
        pricing = JSON.parse(row.pricing_json);
      } catch {
        pricing = null;
      }
    }
    return {
      id: String(row.id),
      channel_id: String(row.channel_id),
      model: String(row.model),
      display_name: row.display_name ?? null,
      supported_protocols: parseJsonArray(
        typeof row.supported_protocols === "string" ? row.supported_protocols : null,
      ),
      context_window: row.context_window === null ? null : Number(row.context_window),
      max_output_tokens: row.max_output_tokens === null ? null : Number(row.max_output_tokens),
      pricing,
      supports_stream: toBool(row.supports_stream),
      enabled: toBool(row.enabled),
      source: String(row.source),
      synced_at: row.synced_at ?? null,
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
  });
}

export function saveChannelModels(db: DatabaseSync, models: JsonRow[]): void {
  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM channel_models");
    const insert = db.prepare(
      `INSERT INTO channel_models (
         id, channel_id, model, display_name, supported_protocols,
         context_window, max_output_tokens, pricing_json, supports_stream, enabled,
         source, synced_at, created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
    );
    for (const model of models) {
      insert.run(
        String(model.id),
        String(model.channel_id),
        String(model.model),
        model.display_name ?? null,
        presetProtocolsJson({ supported_protocols: model.supported_protocols ?? [] }),
        model.context_window ?? null,
        model.max_output_tokens ?? null,
        model.pricing === null || model.pricing === undefined ? null : JSON.stringify(model.pricing),
        model.supports_stream ? 1 : 0,
        model.enabled ? 1 : 0,
        String(model.source ?? "preset"),
        model.synced_at ?? null,
        String(model.created_at ?? ""),
        String(model.updated_at ?? ""),
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

// ─── Virtual models ──────────────────────────────────────────────────────────

export function listVirtualModels(db: DatabaseSync): JsonRow[] {
  const rows = db
    .prepare(
      "SELECT id, name, protocol_type, routing_strategy, enabled, created_at, updated_at FROM virtual_models ORDER BY id ASC",
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    protocol_type:
      row.protocol_type === "anthropic"
        ? "anthropic"
        : row.protocol_type === "responses"
          ? "responses"
          : "openai",
    routing_strategy: String(row.routing_strategy),
    enabled: toBool(row.enabled),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  }));
}

export function saveVirtualModels(db: DatabaseSync, models: JsonRow[]): void {
  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM virtual_models");
    const insert = db.prepare(
      `INSERT INTO virtual_models (id, name, protocol_type, routing_strategy, enabled, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    );
    for (const model of models) {
      insert.run(
        String(model.id),
        String(model.name),
        String(model.protocol_type ?? "openai"),
        String(model.routing_strategy ?? "priority"),
        model.enabled ? 1 : 0,
        String(model.created_at ?? ""),
        String(model.updated_at ?? ""),
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

// ─── Route candidates / rules ─────────────────────────────────────────────────

export function listRouteCandidates(db: DatabaseSync): JsonRow[] {
  const rows = db
    .prepare(
      `SELECT id, virtual_model_id, channel_id, account_id, upstream_model,
              client_protocol, priority, enabled, created_at, updated_at
       FROM virtual_model_routes ORDER BY virtual_model_id ASC, priority ASC, id ASC`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id),
    virtual_model_id: String(row.virtual_model_id),
    channel_id: String(row.channel_id),
    account_id: String(row.account_id),
    upstream_model: String(row.upstream_model),
    client_protocol:
      row.client_protocol === "anthropic"
        ? "anthropic"
        : row.client_protocol === "responses"
          ? "responses"
          : "openai",
    priority: toInt(row.priority),
    enabled: toBool(row.enabled),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  }));
}

export function saveRouteCandidates(db: DatabaseSync, routes: JsonRow[]): void {
  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM virtual_model_routes");
    const insert = db.prepare(
      `INSERT INTO virtual_model_routes (
         id, virtual_model_id, channel_id, account_id, upstream_model,
         client_protocol, priority, enabled, created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    );
    for (const route of routes) {
      insert.run(
        String(route.id),
        String(route.virtual_model_id ?? ""),
        String(route.channel_id ?? ""),
        String(route.account_id ?? ""),
        String(route.upstream_model ?? ""),
        String(route.client_protocol ?? "openai"),
        Number(route.priority ?? 0),
        route.enabled ? 1 : 0,
        String(route.created_at ?? ""),
        String(route.updated_at ?? ""),
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function listRouteRules(db: DatabaseSync): JsonRow[] {
  const rows = db
    .prepare(
      `SELECT id, name, enabled, priority, match_client_id, match_model,
              match_protocol, target_channel_id, target_account_id,
              target_upstream_model, created_at, updated_at
       FROM route_rules ORDER BY priority ASC, id ASC`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    enabled: toBool(row.enabled),
    priority: toInt(row.priority),
    match_client_id: row.match_client_id ?? null,
    match_model: row.match_model ?? null,
    match_protocol:
      row.match_protocol === "anthropic" ? "anthropic" : row.match_protocol === "openai" ? "openai" : null,
    target_channel_id: String(row.target_channel_id),
    target_account_id: String(row.target_account_id),
    target_upstream_model: String(row.target_upstream_model),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  }));
}

export function saveRouteRules(db: DatabaseSync, rules: JsonRow[]): void {
  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM route_rules");
    const insert = db.prepare(
      `INSERT INTO route_rules (
         id, name, enabled, priority, match_client_id, match_model,
         match_protocol, target_channel_id, target_account_id,
         target_upstream_model, created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
    );
    for (const rule of rules) {
      insert.run(
        String(rule.id),
        String(rule.name),
        rule.enabled ? 1 : 0,
        Number(rule.priority ?? 0),
        rule.match_client_id ?? null,
        rule.match_model ?? null,
        rule.match_protocol ?? null,
        String(rule.target_channel_id ?? ""),
        String(rule.target_account_id ?? ""),
        String(rule.target_upstream_model ?? ""),
        String(rule.created_at ?? ""),
        String(rule.updated_at ?? ""),
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

// ─── Balance snapshots ───────────────────────────────────────────────────────

const BALANCE_SELECT = `SELECT s.id, s.account_id, s.balance, s.currency, s.token_pack_total, s.token_pack_used,
       s.token_pack_remaining, s.token_pack_expire_at, s.token_packs, s.raw_scraped_json, s.source,
       s.synced_at, s.remark, s.created_at, s.updated_at`;

function balanceFromRow(row: Record<string, unknown>): JsonRow {
  return {
    id: String(row.id),
    account_id: String(row.account_id),
    balance: row.balance === null ? null : Number(row.balance),
    currency: row.currency ?? null,
    token_pack_total: row.token_pack_total === null ? null : Number(row.token_pack_total),
    token_pack_used: row.token_pack_used === null ? null : Number(row.token_pack_used),
    token_pack_remaining: row.token_pack_remaining === null ? null : Number(row.token_pack_remaining),
    token_pack_expire_at: row.token_pack_expire_at ?? null,
    token_packs: row.token_packs ?? null,
    raw_scraped_json: row.raw_scraped_json ?? null,
    source: String(row.source),
    synced_at: row.synced_at ?? null,
    remark: row.remark ?? null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

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

export function listBalanceSnapshots(db: DatabaseSync, accountId: string): JsonRow[] {
  const rows = db
    .prepare(`${BALANCE_SELECT} FROM account_balance_snapshots s WHERE s.account_id = ?1 ORDER BY s.created_at DESC LIMIT 10`)
    .all(accountId) as Array<Record<string, unknown>>;
  return rows.map(balanceFromRow);
}

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
    .all() as Array<Record<string, unknown>>;
  return rows.map(balanceFromRow);
}

/** Rust cleanup_orphan_balance_snapshots：删除无主账号的余额快照。 */
export function cleanupOrphanBalanceSnapshots(db: DatabaseSync): number {
  const result = db.prepare(
    `DELETE FROM account_balance_snapshots
     WHERE account_id = 'account-default'
        OR NOT EXISTS (
            SELECT 1 FROM channel_accounts WHERE channel_accounts.id = account_balance_snapshots.account_id
        )`,
  ).run();
  return Number(result.changes);
}