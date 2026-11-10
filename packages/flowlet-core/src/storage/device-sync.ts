// 跨设备同步存储域：导入设备快照、维度用量、账号资源，以及 S3 同步状态 / 后台任务。
// Owner: desktop-device。
//
// 权威实现：src-tauri/src/core/storage_device_usage.rs（preview_device_usage_import /
// import_device_usage / import_device_usage_breakdowns / import_device_account_resources /
// usage_breakdown_for_sync）与 storage_tasks.rs（create_job / add_job_event / finish_job）。
// 全部为纯函数，签名 `(db: DatabaseSync, ...)`；命令层通过 `ctx.storage.withDatabase` 调用。
import type { DatabaseSync } from "node:sqlite";

import type {
  DailyUsageTotal,
  DeviceUsageBreakdownRow,
  DeviceUsageImportPreview,
  DeviceUsageImportResult,
  HourlyUsageTotal,
  SharedAgentSession,
  SyncedAccountResource,
  SyncedAgentProfile,
  SyncedAgentSession,
} from "../device/bundle.ts";
import { resolveDeviceDisplayName } from "./devices.ts";
import { getAppMeta, setAppMeta } from "./config.ts";
import { listObservedAgentSessions, sessionTimeMillis } from "./sessions.ts";

export const S3_STATUS_KEY = "device_sync_s3_status_v1";
export const S3_CURRENT_ETAG_KEY = "device_sync_s3_current_etag_v1";
export const S3_REMOTE_ETAGS_KEY = "device_sync_s3_remote_etags_v1";

const MIN_SYNCED_RECENT_SESSIONS = 10;

// ─── S3 设置 / 状态 ─────────────────────────────────────────────────────────

export interface S3SyncStatus {
  status: string;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  message: string;
  remoteDevices: number;
  importedDevices: number;
  importedDays: number;
  failedObjects: number;
  failureDetails: string[];
}

export interface CurrentEtagState {
  endpoint: string;
  bucket: string;
  key: string;
  etag: string;
}

export interface RemoteEtagsState {
  endpoint: string;
  bucket: string;
  etags: Record<string, string>;
}

export function defaultS3SyncStatus(): S3SyncStatus {
  return {
    status: "never",
    lastAttemptAt: null,
    lastSuccessAt: null,
    message: "尚未同步",
    remoteDevices: 0,
    importedDevices: 0,
    importedDays: 0,
    failedObjects: 0,
    failureDetails: [],
  };
}

export function loadS3Status(db: DatabaseSync): S3SyncStatus {
  const raw = getAppMeta(db, S3_STATUS_KEY);
  if (raw === null) return defaultS3SyncStatus();
  try {
    const parsed = JSON.parse(raw) as Partial<S3SyncStatus>;
    return {
      status: typeof parsed.status === "string" ? parsed.status : "never",
      lastAttemptAt: parsed.lastAttemptAt ?? null,
      lastSuccessAt: parsed.lastSuccessAt ?? null,
      message: typeof parsed.message === "string" ? parsed.message : "",
      remoteDevices: Number(parsed.remoteDevices ?? 0),
      importedDevices: Number(parsed.importedDevices ?? 0),
      importedDays: Number(parsed.importedDays ?? 0),
      failedObjects: Number(parsed.failedObjects ?? 0),
      failureDetails: Array.isArray(parsed.failureDetails)
        ? parsed.failureDetails.map((item) => String(item))
        : [],
    };
  } catch {
    return defaultS3SyncStatus();
  }
}

/**
 * Rust `save_status` 使用 `let _ = set_app_meta`：状态写失败不阻断同步主流程。
 * 这里同样尽力而為，但数据库错误仍由调用方按需记录。
 */
export function saveS3Status(db: DatabaseSync, status: S3SyncStatus): void {
  setAppMeta(db, S3_STATUS_KEY, JSON.stringify(status));
}

export function loadCurrentEtag(db: DatabaseSync): CurrentEtagState | null {
  const raw = getAppMeta(db, S3_CURRENT_ETAG_KEY);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as CurrentEtagState;
  } catch {
    return null;
  }
}

export function saveCurrentEtag(db: DatabaseSync, state: CurrentEtagState): void {
  setAppMeta(db, S3_CURRENT_ETAG_KEY, JSON.stringify(state));
}

export function loadRemoteEtags(
  db: DatabaseSync,
  endpoint: string,
  bucket: string,
): RemoteEtagsState {
  const raw = getAppMeta(db, S3_REMOTE_ETAGS_KEY);
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as RemoteEtagsState;
      if (parsed.endpoint === endpoint && parsed.bucket === bucket && parsed.etags) {
        return parsed;
      }
    } catch {
      /* 缓存损坏时按空缓存处理 */
    }
  }
  return { endpoint, bucket, etags: {} };
}

export function saveRemoteEtags(db: DatabaseSync, state: RemoteEtagsState): void {
  setAppMeta(db, S3_REMOTE_ETAGS_KEY, JSON.stringify(state));
}

// ─── 已导入设备的会话 ───────────────────────────────────────────────────────

/** Rust `imported_device_sessions`。 */
export function importedDeviceSessions(
  db: DatabaseSync,
  deviceId?: string | null,
): SharedAgentSession[] {
  const filter = deviceId !== undefined && deviceId !== null ? "WHERE s.device_id = ?1" : "";
  const rows = db
    .prepare(
      `SELECT s.device_id, d.display_name, d.platform, s.session_json
       FROM device_agent_sessions s
       JOIN known_devices d ON d.device_id = s.device_id
       ${filter}
       ORDER BY CASE s.runtime_status
                  WHEN 'running' THEN 0
                  WHEN 'waiting_user' THEN 1
                  ELSE 2
                END,
                s.activity_at DESC`,
    )
    .all(...(filter === "" ? [] : [deviceId as string])) as Array<Record<string, unknown>>;
  return rows.map((row) => {
    const session = JSON.parse(String(row.session_json)) as SyncedAgentSession;
    const sessionDeviceId = String(row.device_id);
    const platform = String(row.platform ?? "unknown");
    return {
      deviceId: sessionDeviceId,
      deviceDisplayName: resolveDeviceDisplayName(
        String(row.display_name ?? ""),
        platform,
        sessionDeviceId,
      ),
      devicePlatform: platform,
      ...session,
    };
  });
}

// ─── 当前设备会话快照 ───────────────────────────────────────────────────────

/** Rust `sanitize_session_text`：控制字符替换为空格、截断、trim、空串转 None。 */
function sanitizeSessionText(value: string | null, maxChars: number): string | null {
  if (value === null) return null;
  let result = "";
  let count = 0;
  for (const character of value) {
    if (count >= maxChars) break;
    result += /\p{Cc}/u.test(character) ? " " : character;
    count += 1;
  }
  const trimmed = result.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * 本机设备同步会话列表。
 *
 * 权威实现 `list_agent_sessions_for_device_sync` 会先合并 Agent 原生会话目录再过滤根会话；
 * Node 版目前只有 SQLite 请求观测目录（原生目录解析属于 observability 领域），因此：
 * - 只输出 flowletObserved=true 的观测会话；
 * - 原生摘要字段（nativeTurnCount / nativeTotalTokens / nativeTruncated / lastInteraction）
 *   保持 null / false / null，与 Rust 在「未解析到原生会话」时的输出一致；
 * - OpenCode 实时待确认权限仍会覆盖 runtimeStatus（见 opencode-control.pendingSessionIds）。
 */
export function listAgentSessionsForDeviceSync(
  db: DatabaseSync,
  opencodePendingSessions: ReadonlySet<string>,
): SyncedAgentSession[] {
  const catalog = listObservedAgentSessions(db);
  const sessions: SyncedAgentSession[] = catalog.map((row) => {
    const agentType = String(row.agentType);
    const sessionId = String(row.sessionId);
    const pending = agentType === "opencode" && opencodePendingSessions.has(sessionId);
    return {
      agentType,
      sessionId,
      parentSessionId:
        row.parentSessionId === null || row.parentSessionId === undefined
          ? null
          : String(row.parentSessionId),
      runtimeStatus: pending ? "waiting_user" : String(row.runtimeStatus),
      title: sanitizeSessionText(
        row.title === null || row.title === undefined ? null : String(row.title),
        512,
      ),
      clientName: sanitizeSessionText(
        row.clientName === null || row.clientName === undefined ? null : String(row.clientName),
        128,
      ),
      activityAt: String(row.activityAt),
      flowletObserved: true,
      requestCount: Number(row.requestCount ?? 0),
      errorCount: Number(row.errorCount ?? 0),
      knownTokens: Number(row.knownTokens ?? 0),
      nativeTurnCount: null,
      nativeTotalTokens: null,
      nativeTruncated: false,
      lastInteraction: null,
    };
  });
  return selectSessionsForSync(sessions.filter((session) => session.parentSessionId === null));
}

/** Rust `select_sessions_for_sync`：活跃会话优先，不足 10 条时按最近活动补足。 */
export function selectSessionsForSync(sessions: SyncedAgentSession[]): SyncedAgentSession[] {
  sessions.sort((left, right) => {
    const byActivity = sessionTimeMillis(right.activityAt) - sessionTimeMillis(left.activityAt);
    if (byActivity !== 0) return byActivity;
    return right.sessionId.localeCompare(left.sessionId);
  });
  const active: SyncedAgentSession[] = [];
  const inactive: SyncedAgentSession[] = [];
  for (const session of sessions) {
    if (session.runtimeStatus === "running" || session.runtimeStatus === "waiting_user") {
      active.push(session);
    } else {
      inactive.push(session);
    }
  }
  if (active.length < MIN_SYNCED_RECENT_SESSIONS) {
    active.push(...inactive.slice(0, MIN_SYNCED_RECENT_SESSIONS - active.length));
  }
  return active;
}

// ─── 导入预览 / 导入 ─────────────────────────────────────────────────────────

const DAILY_COLUMNS = [
  "request_count",
  "known_tokens",
  "input_tokens",
  "input_cached_tokens",
  "input_uncached_tokens",
  "cache_measured_input_tokens",
  "output_tokens",
  "unknown_count",
  "native_event_count",
  "native_input_tokens",
  "native_cached_input_tokens",
  "native_cache_write_input_tokens",
  "native_output_tokens",
  "native_reasoning_tokens",
  "native_total_tokens",
  "estimated_cost",
] as const;

function dailyFromRow(date: string, row: Record<string, unknown>): DailyUsageTotal {
  return {
    date,
    requestCount: Number(row.request_count),
    knownTokens: Number(row.known_tokens),
    inputTokens: Number(row.input_tokens),
    inputCachedTokens: Number(row.input_cached_tokens),
    inputUncachedTokens: Number(row.input_uncached_tokens),
    cacheMeasuredInputTokens: Number(row.cache_measured_input_tokens),
    outputTokens: Number(row.output_tokens),
    unknownCount: Number(row.unknown_count),
    nativeEventCount: Number(row.native_event_count),
    nativeInputTokens: Number(row.native_input_tokens),
    nativeCachedInputTokens: Number(row.native_cached_input_tokens),
    nativeCacheWriteInputTokens: Number(row.native_cache_write_input_tokens),
    nativeOutputTokens: Number(row.native_output_tokens),
    nativeReasoningTokens: Number(row.native_reasoning_tokens),
    nativeTotalTokens: Number(row.native_total_tokens),
    estimatedCost: Number(row.estimated_cost),
  };
}

function dailyEquals(left: DailyUsageTotal, right: DailyUsageTotal): boolean {
  return (
    left.date === right.date &&
    left.requestCount === right.requestCount &&
    left.knownTokens === right.knownTokens &&
    left.inputTokens === right.inputTokens &&
    left.inputCachedTokens === right.inputCachedTokens &&
    left.inputUncachedTokens === right.inputUncachedTokens &&
    left.cacheMeasuredInputTokens === right.cacheMeasuredInputTokens &&
    left.outputTokens === right.outputTokens &&
    left.unknownCount === right.unknownCount &&
    left.nativeEventCount === right.nativeEventCount &&
    left.nativeInputTokens === right.nativeInputTokens &&
    left.nativeCachedInputTokens === right.nativeCachedInputTokens &&
    left.nativeCacheWriteInputTokens === right.nativeCacheWriteInputTokens &&
    left.nativeOutputTokens === right.nativeOutputTokens &&
    left.nativeReasoningTokens === right.nativeReasoningTokens &&
    left.nativeTotalTokens === right.nativeTotalTokens &&
    left.estimatedCost === right.estimatedCost
  );
}

export interface DeviceUsageImportProfile {
  deviceId: string;
  deviceCreatedAt: string;
  displayName: string;
  platform: string;
  appVersion: string;
  generatedAt: string;
  timezoneOffsetMinutes: number;
}

/** Rust `preview_device_usage_import`。 */
export function previewDeviceUsageImport(
  db: DatabaseSync,
  currentDeviceId: string,
  profile: DeviceUsageImportProfile,
  days: DailyUsageTotal[],
): DeviceUsageImportPreview {
  const statement = db.prepare(
    `SELECT ${DAILY_COLUMNS.join(", ")}, snapshot_generated_at
     FROM device_daily_usage WHERE device_id = ?1 AND usage_date = ?2`,
  );
  let newDays = 0;
  let updatedDays = 0;
  let unchangedDays = 0;
  for (const day of days) {
    const existing = statement.get(profile.deviceId, day.date) as
      | Record<string, unknown>
      | undefined;
    if (existing === undefined) {
      newDays += 1;
      continue;
    }
    const existingGeneratedAt = String(existing.snapshot_generated_at);
    if (existingGeneratedAt > profile.generatedAt) {
      unchangedDays += 1;
      continue;
    }
    const existingDay = dailyFromRow(day.date, existing);
    if (dailyEquals(existingDay, day)) unchangedDays += 1;
    else updatedDays += 1;
  }
  return {
    deviceId: profile.deviceId,
    deviceCreatedAt: profile.deviceCreatedAt,
    displayName: profile.displayName,
    platform: profile.platform,
    appVersion: profile.appVersion,
    generatedAt: profile.generatedAt,
    timezoneOffsetMinutes: profile.timezoneOffsetMinutes,
    firstDate: days.length > 0 ? days[0].date : null,
    lastDate: days.length > 0 ? days[days.length - 1].date : null,
    dayCount: days.length,
    newDays,
    updatedDays,
    unchangedDays,
    sameAsCurrentDevice: currentDeviceId === profile.deviceId,
  };
}

function withTransaction<T>(db: DatabaseSync, run: () => T): T {
  db.exec("BEGIN");
  try {
    const result = run();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* 回滚失败时保留原始错误 */
    }
    throw error;
  }
}

/** Rust `import_device_usage`：写 known_devices / 日 / 小时 / 会话 / Agent 摘要。 */
export function importDeviceUsage(
  db: DatabaseSync,
  snapshotSchemaVersion: number,
  profile: DeviceUsageImportProfile,
  days: DailyUsageTotal[],
  hours: HourlyUsageTotal[],
  sessions: SyncedAgentSession[],
  agents: SyncedAgentProfile[],
): DeviceUsageImportResult {
  const preview = previewDeviceUsageImport(db, "", profile, days);
  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO known_devices (
          device_id, device_created_at, display_name, platform, app_version,
          timezone_offset_minutes, profile_generated_at, first_seen_at, last_seen_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now'), ?7)
       ON CONFLICT(device_id) DO UPDATE SET
          device_created_at = excluded.device_created_at,
          display_name = excluded.display_name,
          platform = excluded.platform,
          app_version = excluded.app_version,
          timezone_offset_minutes = excluded.timezone_offset_minutes,
          profile_generated_at = excluded.profile_generated_at,
          last_seen_at = excluded.last_seen_at
       WHERE excluded.profile_generated_at >= known_devices.profile_generated_at`,
    ).run(
      profile.deviceId,
      profile.deviceCreatedAt,
      profile.displayName,
      profile.platform,
      profile.appVersion,
      profile.timezoneOffsetMinutes,
      profile.generatedAt,
    );
    const newest = db
      .prepare("SELECT profile_generated_at FROM known_devices WHERE device_id = ?1")
      .get(profile.deviceId) as { profile_generated_at: string } | undefined;
    const importSnapshotDetails =
      newest !== undefined && String(newest.profile_generated_at) <= profile.generatedAt;

    const dailyStatement = db.prepare(
      `INSERT INTO device_daily_usage (
          device_id, usage_date, request_count, known_tokens, input_tokens,
          input_cached_tokens, input_uncached_tokens, cache_measured_input_tokens,
          output_tokens, unknown_count,
          native_event_count, native_input_tokens, native_cached_input_tokens,
          native_cache_write_input_tokens, native_output_tokens,
          native_reasoning_tokens, native_total_tokens,
          estimated_cost,
          snapshot_generated_at, imported_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, datetime('now'))
       ON CONFLICT(device_id, usage_date) DO UPDATE SET
          request_count = excluded.request_count,
          known_tokens = excluded.known_tokens,
          input_tokens = excluded.input_tokens,
          input_cached_tokens = excluded.input_cached_tokens,
          input_uncached_tokens = excluded.input_uncached_tokens,
          cache_measured_input_tokens = excluded.cache_measured_input_tokens,
          output_tokens = excluded.output_tokens,
          unknown_count = excluded.unknown_count,
          native_event_count = excluded.native_event_count,
          native_input_tokens = excluded.native_input_tokens,
          native_cached_input_tokens = excluded.native_cached_input_tokens,
          native_cache_write_input_tokens = excluded.native_cache_write_input_tokens,
          native_output_tokens = excluded.native_output_tokens,
          native_reasoning_tokens = excluded.native_reasoning_tokens,
          native_total_tokens = excluded.native_total_tokens,
          estimated_cost = excluded.estimated_cost,
          snapshot_generated_at = excluded.snapshot_generated_at,
          imported_at = datetime('now')
       WHERE excluded.snapshot_generated_at >= device_daily_usage.snapshot_generated_at`,
    );
    for (const day of days) {
      dailyStatement.run(
        profile.deviceId,
        day.date,
        day.requestCount,
        day.knownTokens,
        day.inputTokens,
        day.inputCachedTokens,
        day.inputUncachedTokens,
        day.cacheMeasuredInputTokens,
        day.outputTokens,
        day.unknownCount,
        day.nativeEventCount,
        day.nativeInputTokens,
        day.nativeCachedInputTokens,
        day.nativeCacheWriteInputTokens,
        day.nativeOutputTokens,
        day.nativeReasoningTokens,
        day.nativeTotalTokens,
        day.estimatedCost,
        profile.generatedAt,
      );
    }

    if (importSnapshotDetails && snapshotSchemaVersion >= 2) {
      db.prepare("DELETE FROM device_hourly_usage WHERE device_id = ?1").run(profile.deviceId);
      const hourlyStatement = db.prepare(
        `INSERT INTO device_hourly_usage (
            device_id, usage_hour, request_count, known_tokens,
            input_tokens, input_cached_tokens, cache_measured_input_tokens,
            output_tokens, unknown_count, estimated_cost,
            native_event_count, native_input_tokens, native_cached_input_tokens,
            native_cache_write_input_tokens, native_output_tokens,
            native_reasoning_tokens, native_total_tokens,
            snapshot_generated_at, imported_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, datetime('now'))`,
      );
      for (const hour of hours) {
        hourlyStatement.run(
          profile.deviceId,
          hour.hour,
          hour.requestCount,
          hour.knownTokens,
          hour.inputTokens,
          hour.inputCachedTokens,
          hour.cacheMeasuredInputTokens,
          hour.outputTokens,
          hour.unknownCount,
          hour.estimatedCost,
          hour.nativeEventCount,
          hour.nativeInputTokens,
          hour.nativeCachedInputTokens,
          hour.nativeCacheWriteInputTokens,
          hour.nativeOutputTokens,
          hour.nativeReasoningTokens,
          hour.nativeTotalTokens,
          profile.generatedAt,
        );
      }
    }

    if (importSnapshotDetails) {
      db.prepare("DELETE FROM device_agent_sessions WHERE device_id = ?1").run(profile.deviceId);
      const sessionStatement = db.prepare(
        `INSERT INTO device_agent_sessions (
            device_id, agent_type, session_id, runtime_status, activity_at,
            session_json, snapshot_generated_at, imported_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now'))`,
      );
      for (const session of sessions) {
        sessionStatement.run(
          profile.deviceId,
          session.agentType,
          session.sessionId,
          session.runtimeStatus,
          session.activityAt,
          JSON.stringify(session),
          profile.generatedAt,
        );
      }
      db.prepare("DELETE FROM device_agent_profiles WHERE device_id = ?1").run(profile.deviceId);
      const agentStatement = db.prepare(
        `INSERT INTO device_agent_profiles (
            device_id, agent_id, profile_json, snapshot_generated_at, imported_at
         ) VALUES (?1, ?2, ?3, ?4, datetime('now'))`,
      );
      for (const agent of agents) {
        agentStatement.run(
          profile.deviceId,
          agent.agentId,
          JSON.stringify(agent),
          profile.generatedAt,
        );
      }
    }
  });
  return {
    deviceId: profile.deviceId,
    importedDays: preview.newDays + preview.updatedDays,
    unchangedDays: preview.unchangedDays,
  };
}

/** Rust `import_device_usage_breakdowns`：先删该设备旧行再整体写入。 */
export function importDeviceUsageBreakdowns(
  db: DatabaseSync,
  deviceId: string,
  generatedAt: string,
  breakdowns: DeviceUsageBreakdownRow[],
): number {
  return withTransaction(db, () => {
    const newest = db
      .prepare("SELECT profile_generated_at FROM known_devices WHERE device_id = ?1")
      .get(deviceId) as { profile_generated_at: string } | undefined;
    if (newest !== undefined && String(newest.profile_generated_at) > generatedAt) return 0;
    db.prepare("DELETE FROM device_usage_breakdowns WHERE device_id = ?1").run(deviceId);
    let imported = 0;
    const statement = db.prepare(
      `INSERT INTO device_usage_breakdowns (
          device_id, breakdown_date, client_id, client_name, channel_id, channel_name,
          account_id, account_name, upstream_model, request_count, known_tokens,
          input_tokens, input_cached_tokens, input_uncached_tokens,
          cache_measured_input_tokens, output_tokens, unknown_count, estimated_cost,
          estimated_cost_currency, native_event_count,
          elapsed_total_ms, elapsed_measured_count, generation_total_ms,
          generation_output_tokens, imported_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
                 ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, datetime('now'))
       ON CONFLICT(device_id, breakdown_date, client_id, channel_id, account_id, upstream_model)
       DO UPDATE SET
          client_name = excluded.client_name,
          channel_name = excluded.channel_name,
          account_name = excluded.account_name,
          request_count = excluded.request_count,
          known_tokens = excluded.known_tokens,
          input_tokens = excluded.input_tokens,
          input_cached_tokens = excluded.input_cached_tokens,
          input_uncached_tokens = excluded.input_uncached_tokens,
          cache_measured_input_tokens = excluded.cache_measured_input_tokens,
          output_tokens = excluded.output_tokens,
          unknown_count = excluded.unknown_count,
          estimated_cost = excluded.estimated_cost,
          estimated_cost_currency = excluded.estimated_cost_currency,
          native_event_count = excluded.native_event_count,
          elapsed_total_ms = excluded.elapsed_total_ms,
          elapsed_measured_count = excluded.elapsed_measured_count,
          generation_total_ms = excluded.generation_total_ms,
          generation_output_tokens = excluded.generation_output_tokens,
          imported_at = datetime('now')`,
    );
    for (const breakdown of breakdowns) {
      // 历史兼容：旧版发送端可能把 Codex Desktop 原生用量存成聚合别名模型名。
      const legacyAggregateAlias =
        breakdown.requestCount === 0 &&
        breakdown.nativeEventCount > 0 &&
        breakdown.upstreamModel !== null &&
        ["flowlet-pro", "flowlet-flash"].includes(
          breakdown.upstreamModel.trim().toLowerCase(),
        );
      if (legacyAggregateAlias) continue;
      // 历史兼容：旧版发送端把 Codex Desktop 原生用量写成 client_id = "codex"。
      const clientId =
        breakdown.clientId === "codex" &&
        breakdown.clientName !== null &&
        breakdown.clientName.toLowerCase() === "codex desktop"
          ? "codex-desktop"
          : breakdown.clientId;
      statement.run(
        deviceId,
        breakdown.date,
        clientId,
        breakdown.clientName,
        breakdown.channelId,
        breakdown.channelName,
        breakdown.accountId,
        breakdown.accountName,
        breakdown.upstreamModel,
        breakdown.requestCount,
        breakdown.knownTokens,
        breakdown.inputTokens,
        breakdown.inputCachedTokens,
        breakdown.inputUncachedTokens,
        breakdown.cacheMeasuredInputTokens,
        breakdown.outputTokens,
        breakdown.unknownCount,
        breakdown.estimatedCost,
        breakdown.estimatedCostCurrency,
        breakdown.nativeEventCount,
        breakdown.elapsedTotalMs,
        breakdown.elapsedMeasuredCount,
        breakdown.generationTotalMs,
        breakdown.generationOutputTokens,
      );
      imported += 1;
    }
    return imported;
  });
}

/** Rust `import_device_account_resources`：整体替换该设备的账号资源观测。 */
export function importDeviceAccountResources(
  db: DatabaseSync,
  deviceId: string,
  generatedAt: string,
  resources: SyncedAccountResource[],
): number {
  return withTransaction(db, () => {
    const newest = db
      .prepare("SELECT profile_generated_at FROM known_devices WHERE device_id = ?1")
      .get(deviceId) as { profile_generated_at: string } | undefined;
    if (newest !== undefined && String(newest.profile_generated_at) > generatedAt) return 0;
    db.prepare("DELETE FROM device_account_resources WHERE device_id = ?1").run(deviceId);
    let imported = 0;
    const statement = db.prepare(
      `INSERT INTO device_account_resources (
          device_id, account_id, resource_json, observed_at,
          snapshot_generated_at, imported_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))`,
    );
    for (const resource of resources) {
      if (resource.accountId.trim() === "" || resource.channelId.trim() === "") continue;
      statement.run(
        deviceId,
        resource.accountId,
        JSON.stringify(resource),
        resource.observedAt,
        generatedAt,
      );
      imported += 1;
    }
    return imported;
  });
}

// ─── 本机维度用量（随快照发送） ─────────────────────────────────────────────

/**
 * Rust `usage_breakdown_for_sync` 的代理账本部分：最近 `historyDays` 天按
 * (日期, 客户端, 渠道, workspace 账号, 上游模型) 聚合。
 *
 * 缺口：Rust 还会合并 `native_usage_breakdowns_for_sync`（Agent 原生事件 + 价格估算 +
 * 模型归一），Node 侧原生用量账本尚未迁移，先只发代理账本，并在汇报中标注。
 */
export function usageBreakdownForSync(
  db: DatabaseSync,
  historyDays: number,
): DeviceUsageBreakdownRow[] {
  const rows = db
    .prepare(
      `SELECT
          strftime('%Y-%m-%d', request_logs.created_at, 'localtime') AS breakdown_date,
          usage_records.client_id,
          usage_records.client_name,
          usage_records.channel_id,
          usage_records.channel_name,
          COALESCE(account_links.workspace_account_id, usage_records.account_id) AS account_id,
          COALESCE(ca.name, usage_records.account_name) AS account_name,
          usage_records.upstream_model,
          count(*) AS request_count,
          coalesce(sum(usage_records.total_tokens), 0) AS known_tokens,
          coalesce(sum(usage_records.input_tokens), 0) AS input_tokens,
          coalesce(sum(usage_records.input_cached_tokens), 0) AS input_cached_tokens,
          coalesce(sum(usage_records.input_uncached_tokens), 0) AS input_uncached_tokens,
          coalesce(sum(CASE WHEN usage_records.input_cached_tokens IS NOT NULL THEN usage_records.input_tokens ELSE 0 END), 0) AS cache_measured_input_tokens,
          coalesce(sum(usage_records.output_tokens), 0) AS output_tokens,
          sum(CASE WHEN usage_records.total_tokens IS NULL THEN 1 ELSE 0 END) AS unknown_count,
          coalesce(sum(usage_records.estimated_cost), 0) AS estimated_cost,
          coalesce(sum(COALESCE(request_logs.duration_ms, request_logs.latency_ms)), 0) AS elapsed_total_ms,
          sum(CASE WHEN COALESCE(request_logs.duration_ms, request_logs.latency_ms) IS NOT NULL THEN 1 ELSE 0 END) AS elapsed_measured_count,
          coalesce(sum(CASE WHEN request_logs.duration_ms IS NOT NULL
                             AND request_logs.ttft_ms IS NOT NULL
                             AND request_logs.duration_ms > request_logs.ttft_ms
                       THEN request_logs.duration_ms - request_logs.ttft_ms ELSE 0 END), 0) AS generation_total_ms,
          sum(CASE WHEN request_logs.duration_ms IS NOT NULL
                    AND request_logs.ttft_ms IS NOT NULL
                    AND request_logs.duration_ms > request_logs.ttft_ms
              THEN coalesce(usage_records.output_tokens, 0) ELSE 0 END) AS generation_output_tokens
       FROM usage_records
       LEFT JOIN request_logs ON request_logs.request_id = usage_records.request_id
                             AND request_logs.is_last_attempt = 1
       LEFT JOIN channel_accounts ca ON ca.id = usage_records.account_id
       LEFT JOIN channel_account_workspace_links account_links
              ON account_links.local_account_id = usage_records.account_id
       WHERE request_logs.created_at >= datetime('now', 'localtime', 'start of day', printf('-%d days', ?1), 'utc')
       GROUP BY breakdown_date, usage_records.client_id, usage_records.channel_id,
                COALESCE(account_links.workspace_account_id, usage_records.account_id), usage_records.upstream_model
       ORDER BY breakdown_date ASC`,
    )
    .all(historyDays) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    date: String(row.breakdown_date ?? ""),
    clientId: row.client_id === null || row.client_id === undefined ? null : String(row.client_id),
    clientName:
      row.client_name === null || row.client_name === undefined
        ? null
        : String(row.client_name),
    channelId:
      row.channel_id === null || row.channel_id === undefined ? null : String(row.channel_id),
    channelName:
      row.channel_name === null || row.channel_name === undefined
        ? null
        : String(row.channel_name),
    accountId:
      row.account_id === null || row.account_id === undefined ? null : String(row.account_id),
    accountName:
      row.account_name === null || row.account_name === undefined
        ? null
        : String(row.account_name),
    upstreamModel:
      row.upstream_model === null || row.upstream_model === undefined
        ? null
        : String(row.upstream_model),
    requestCount: Number(row.request_count ?? 0),
    knownTokens: Number(row.known_tokens ?? 0),
    inputTokens: Number(row.input_tokens ?? 0),
    inputCachedTokens: Number(row.input_cached_tokens ?? 0),
    inputUncachedTokens: Number(row.input_uncached_tokens ?? 0),
    cacheMeasuredInputTokens: Number(row.cache_measured_input_tokens ?? 0),
    outputTokens: Number(row.output_tokens ?? 0),
    unknownCount: Number(row.unknown_count ?? 0),
    estimatedCost: Number(row.estimated_cost ?? 0),
    estimatedCostCurrency: null,
    nativeEventCount: 0,
    elapsedTotalMs: Number(row.elapsed_total_ms ?? 0),
    elapsedMeasuredCount: Number(row.elapsed_measured_count ?? 0),
    generationTotalMs: Number(row.generation_total_ms ?? 0),
    generationOutputTokens: Number(row.generation_output_tokens ?? 0),
  }));
}

