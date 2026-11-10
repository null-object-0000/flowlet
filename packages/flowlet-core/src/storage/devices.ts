// 设备目录 / 日用量 / 小时用量（Rust storage_device_usage.rs + device_usage.rs）。
//
// 与 Rust 一致的口径：
// - 本机 = usage_records（代理） + agent_usage_events（原生）；
// - 全部设备 = 本机 + 已导入的 device_daily_usage / device_hourly_usage 快照；
// - 已同步设备目录来自 known_devices + 其日用量聚合。
//
// 注意字段命名：Rust `KnownDevice` / `DailyUsageTotal` / `HourlyUsageTotal` 全部
// `#[serde(rename_all = "camelCase")]`，这里返回 camelCase（daily/hourly 的 SQL 列名仍是 snake_case）。
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { JsonRow } from "../types.ts";

function reqNum(value: unknown): number {
  return Number(value ?? 0);
}

// ─── 平台显示名（Rust device_identity.rs） ───────────────────────────────────

const PLATFORM_LABELS: Record<string, string> = {
  windows: "Windows",
  macos: "macOS",
  darwin: "macOS",
  linux: "Linux",
  ubuntu: "Ubuntu",
  debian: "Debian",
  fedora: "Fedora",
  arch: "Arch",
  manjaro: "Manjaro",
  linuxmint: "Linux Mint",
  centos: "CentOS",
  rhel: "RHEL",
  alpine: "Alpine",
  opensuse: "openSUSE",
  "opensuse-leap": "openSUSE",
  "opensuse-tumbleweed": "openSUSE",
  android: "Android",
  ios: "iOS",
  "": "Flowlet",
  unknown: "Flowlet",
};

function platformLabel(platform: string): string {
  const known = PLATFORM_LABELS[platform];
  if (known) return known;
  if (!platform) return "Flowlet";
  return platform.charAt(0).toUpperCase() + platform.slice(1);
}

/**
 * Rust device_identity::current_platform：Linux 读取 /etc/os-release 的 ID（如 ubuntu），
 * macOS/Windows 返回 "...os" 的规范键，其余 unknown。
 */
export function detectPlatform(): string {
  const os = process.platform;
  if (os === "linux") {
    try {
      const contents = readFileSync("/etc/os-release", "utf8");
      for (const line of contents.split("\n")) {
        if (!line.startsWith("ID=")) continue;
        const id = line.slice(3).trim().replace(/^"|"$/g, "");
        if (id && !/\p{Cc}/u.test(id)) return id;
      }
    } catch {
      /* 回退 linux */
    }
    return "linux";
  }
  if (os === "darwin") return "macos";
  if (os === "win32") return "windows";
  return "unknown";
}

/** Rust device_identity::resolve_platform：平台键与当前系统收敛（含 linux → 发行版升级）。 */
export function resolvePlatform(existing: string, detected: string, os: string): string {
  const matchesOs = (platform: string): boolean => {
    if (os === "windows") return platform === "windows";
    if (os === "macos") return platform === "macos";
    if (os === "linux") {
      return !["", "unknown", "windows", "macos", "android", "ios"].includes(platform);
    }
    return false;
  };
  if (existing.trim() === "" || !matchesOs(existing)) return detected;
  if (os === "linux" && existing === "linux") return detected;
  return existing;
}

/** 当前系统族（对齐 Rust std::env::consts::OS）。 */
export function currentOsFamily(): string {
  return process.platform === "darwin" ? "macos" : process.platform;
}

/** Rust device_identity::resolve_device_display_name。 */
export function resolveDeviceDisplayName(
  displayName: string,
  platform: string,
  deviceId: string,
): string {
  if (displayName.trim()) return displayName.trim();
  const suffix = deviceId
    .split("")
    .filter((character) => character !== "-")
    .slice(0, 4)
    .join("")
    .toUpperCase();
  return `${platformLabel(platform)} · ${suffix}`;
}

// ─── DailyUsageTotal / HourlyUsageTotal 映射（camelCase 输出） ────────────────

const DAILY_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ["requestCount", "request_count"],
  ["knownTokens", "known_tokens"],
  ["inputTokens", "input_tokens"],
  ["inputCachedTokens", "input_cached_tokens"],
  ["inputUncachedTokens", "input_uncached_tokens"],
  ["cacheMeasuredInputTokens", "cache_measured_input_tokens"],
  ["outputTokens", "output_tokens"],
  ["unknownCount", "unknown_count"],
  ["estimatedCost", "estimated_cost"],
  ["nativeEventCount", "native_event_count"],
  ["nativeInputTokens", "native_input_tokens"],
  ["nativeCachedInputTokens", "native_cached_input_tokens"],
  ["nativeCacheWriteInputTokens", "native_cache_write_input_tokens"],
  ["nativeOutputTokens", "native_output_tokens"],
  ["nativeReasoningTokens", "native_reasoning_tokens"],
  ["nativeTotalTokens", "native_total_tokens"],
];

const HOURLY_FIELDS: ReadonlyArray<readonly [string, string]> = DAILY_FIELDS.filter(
  ([camel]) => camel !== "inputUncachedTokens",
);

export function emptyDailyUsage(date: string): JsonRow {
  const total: JsonRow = { date };
  for (const [camel] of DAILY_FIELDS) total[camel] = 0;
  return total;
}

export function emptyHourlyUsage(hour: string): JsonRow {
  const total: JsonRow = { hour };
  for (const [camel] of HOURLY_FIELDS) total[camel] = 0;
  return total;
}

function mapDailyRow(row: Record<string, unknown>): JsonRow {
  const total = emptyDailyUsage(String(row.usage_date ?? "unknown"));
  for (const [camel, snake] of DAILY_FIELDS) total[camel] = reqNum(row[snake]);
  return total;
}

function mapHourlyRow(row: Record<string, unknown>): JsonRow {
  const total = emptyHourlyUsage(String(row.usage_hour ?? "unknown"));
  for (const [camel, snake] of HOURLY_FIELDS) total[camel] = reqNum(row[snake]);
  return total;
}

function mergeTotals(items: JsonRow[], keyField: string, fields: ReadonlyArray<readonly [string, string]>): JsonRow[] {
  const byKey = new Map<string, JsonRow>();
  for (const item of items) {
    const key = String(item[keyField]);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...item });
      continue;
    }
    for (const [camel] of fields) existing[camel] = reqNum(existing[camel]) + reqNum(item[camel]);
  }
  return [...byKey.values()].sort((left, right) =>
    String(left[keyField]).localeCompare(String(right[keyField])),
  );
}

/** Rust merge_daily_usage_totals（按日期升序合并多个来源）。 */
export function mergeDailyUsageTotals(items: JsonRow[]): JsonRow[] {
  return mergeTotals(items, "date", DAILY_FIELDS);
}

/** Rust merge_hourly_usage_totals（按小时升序合并多个来源）。 */
export function mergeHourlyUsageTotals(items: JsonRow[]): JsonRow[] {
  return mergeTotals(items, "hour", HOURLY_FIELDS);
}

// ─── 本机聚合 ────────────────────────────────────────────────────────────────

/** Rust daily_usage_totals：本机代理用量按本地自然日聚合。 */
export function dailyUsageTotals(db: DatabaseSync): JsonRow[] {
  const rows = db
    .prepare(
      `SELECT
          strftime('%Y-%m-%d', COALESCE(request_logs.created_at, usage_records.created_at), 'localtime') AS usage_date,
          count(*) AS request_count,
          coalesce(sum(usage_records.total_tokens), 0) AS known_tokens,
          coalesce(sum(usage_records.input_tokens), 0) AS input_tokens,
          coalesce(sum(usage_records.input_cached_tokens), 0) AS input_cached_tokens,
          coalesce(sum(usage_records.input_uncached_tokens), 0) AS input_uncached_tokens,
          coalesce(sum(CASE WHEN usage_records.input_cached_tokens IS NOT NULL THEN usage_records.input_tokens ELSE 0 END), 0) AS cache_measured_input_tokens,
          coalesce(sum(usage_records.output_tokens), 0) AS output_tokens,
          sum(CASE WHEN usage_records.total_tokens IS NULL THEN 1 ELSE 0 END) AS unknown_count,
          coalesce(sum(usage_records.estimated_cost), 0) AS estimated_cost
      FROM usage_records
      LEFT JOIN request_logs ON request_logs.request_id = usage_records.request_id
                             AND request_logs.is_last_attempt = 1
      GROUP BY usage_date
      ORDER BY usage_date ASC`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map(mapDailyRow);
}

/** Rust agent_native_daily_usage_totals：未经过 Flowlet 的原生事件按日聚合。 */
export function agentNativeDailyUsageTotals(db: DatabaseSync): JsonRow[] {
  const rows = db
    .prepare(
      `SELECT
          strftime('%Y-%m-%d', event_time, 'localtime') AS usage_date,
          count(*) AS native_event_count,
          coalesce(sum(CASE WHEN agent_type IN ('codex-desktop', 'codex-cli')
              THEN max(input_tokens - cached_input_tokens - cache_write_input_tokens, 0)
              ELSE input_tokens END), 0) AS native_input_tokens,
          coalesce(sum(cached_input_tokens), 0) AS native_cached_input_tokens,
          coalesce(sum(cache_write_input_tokens), 0) AS native_cache_write_input_tokens,
          coalesce(sum(output_tokens), 0) AS native_output_tokens,
          coalesce(sum(reasoning_tokens), 0) AS native_reasoning_tokens,
          coalesce(sum(total_tokens), 0) AS native_total_tokens
      FROM agent_usage_events
      WHERE NOT EXISTS (
          SELECT 1 FROM request_logs
          WHERE request_logs.agent_type = agent_usage_events.agent_type
            AND request_logs.agent_session_id = agent_usage_events.session_id
      )
      GROUP BY usage_date
      ORDER BY usage_date ASC`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map(mapDailyRow);
}

/** Rust local_daily_usage_totals_with_native：本机代理 + 原生合并。 */
export function localDailyUsageTotalsWithNative(db: DatabaseSync): JsonRow[] {
  return mergeDailyUsageTotals([...dailyUsageTotals(db), ...agentNativeDailyUsageTotals(db)]);
}

/** Rust hourly_usage_totals：最近 180 天本机代理小时聚合。 */
export function hourlyUsageTotals(db: DatabaseSync): JsonRow[] {
  const rows = db
    .prepare(
      `SELECT
          strftime('%Y-%m-%dT%H:00:00', COALESCE(request_logs.created_at, usage_records.created_at), 'localtime') AS usage_hour,
          count(*) AS request_count,
          coalesce(sum(usage_records.total_tokens), 0) AS known_tokens,
          coalesce(sum(usage_records.input_tokens), 0) AS input_tokens,
          coalesce(sum(usage_records.input_cached_tokens), 0) AS input_cached_tokens,
          coalesce(sum(CASE
              WHEN usage_records.input_cached_tokens IS NOT NULL
                OR usage_records.input_uncached_tokens IS NOT NULL
                OR usage_records.input_tokens IS NOT NULL
              THEN coalesce(usage_records.input_tokens,
                  coalesce(usage_records.input_cached_tokens, 0) + coalesce(usage_records.input_uncached_tokens, 0))
              ELSE 0 END), 0) AS cache_measured_input_tokens,
          coalesce(sum(usage_records.output_tokens), 0) AS output_tokens,
          sum(CASE WHEN usage_records.total_tokens IS NULL THEN 1 ELSE 0 END) AS unknown_count,
          coalesce(sum(usage_records.estimated_cost), 0) AS estimated_cost
      FROM usage_records
      LEFT JOIN request_logs ON request_logs.request_id = usage_records.request_id
                             AND request_logs.is_last_attempt = 1
      WHERE COALESCE(request_logs.created_at, usage_records.created_at)
            >= datetime('now', 'localtime', 'start of day', '-180 days', 'utc')
      GROUP BY usage_hour
      ORDER BY usage_hour ASC`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map(mapHourlyRow);
}

/** Rust agent_native_hourly_usage_totals：最近 180 天原生事件小时聚合。 */
export function agentNativeHourlyUsageTotals(db: DatabaseSync): JsonRow[] {
  const rows = db
    .prepare(
      `SELECT
          strftime('%Y-%m-%dT%H:00:00', event_time, 'localtime') AS usage_hour,
          count(*) AS native_event_count,
          coalesce(sum(CASE WHEN agent_type IN ('codex-desktop', 'codex-cli')
              THEN max(input_tokens - cached_input_tokens - cache_write_input_tokens, 0)
              ELSE input_tokens END), 0) AS native_input_tokens,
          coalesce(sum(cached_input_tokens), 0) AS native_cached_input_tokens,
          coalesce(sum(cache_write_input_tokens), 0) AS native_cache_write_input_tokens,
          coalesce(sum(output_tokens), 0) AS native_output_tokens,
          coalesce(sum(reasoning_tokens), 0) AS native_reasoning_tokens,
          coalesce(sum(total_tokens), 0) AS native_total_tokens
      FROM agent_usage_events
      WHERE event_time >= datetime('now', 'localtime', 'start of day', '-180 days', 'utc')
        AND NOT EXISTS (
            SELECT 1 FROM request_logs
            WHERE request_logs.agent_type = agent_usage_events.agent_type
              AND request_logs.agent_session_id = agent_usage_events.session_id
        )
      GROUP BY usage_hour
      ORDER BY usage_hour ASC`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map(mapHourlyRow);
}

/** Rust local_hourly_usage_totals_with_native：本机代理 + 原生合并。 */
export function localHourlyUsageTotalsWithNative(db: DatabaseSync): JsonRow[] {
  return mergeHourlyUsageTotals([...hourlyUsageTotals(db), ...agentNativeHourlyUsageTotals(db)]);
}

// ─── 已导入设备 ──────────────────────────────────────────────────────────────

/** Rust imported_known_devices：known_devices + 其日用量聚合（KnownDevice camelCase）。 */
export function importedKnownDevices(db: DatabaseSync): JsonRow[] {
  const rows = db
    .prepare(
      `SELECT d.device_id, d.device_created_at, d.display_name, d.platform, d.app_version,
              d.timezone_offset_minutes,
              min(u.usage_date) AS first_usage_date, max(u.usage_date) AS last_usage_date,
              count(u.usage_date) AS day_count,
              coalesce(sum(u.request_count), 0) AS request_count,
              coalesce(sum(u.known_tokens), 0) AS known_tokens,
              d.last_seen_at
       FROM known_devices d
       LEFT JOIN device_daily_usage u ON u.device_id = d.device_id
       GROUP BY d.device_id
       ORDER BY d.last_seen_at DESC`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    deviceId: String(row.device_id),
    deviceCreatedAt: String(row.device_created_at),
    displayName: resolveDeviceDisplayName(
      String(row.display_name ?? ""),
      String(row.platform ?? "unknown"),
      String(row.device_id),
    ),
    platform: String(row.platform ?? "unknown"),
    appVersion: String(row.app_version ?? "unknown"),
    isCurrent: false,
    timezoneOffsetMinutes: reqNum(row.timezone_offset_minutes),
    firstUsageDate: row.first_usage_date ?? null,
    lastUsageDate: row.last_usage_date ?? null,
    dayCount: reqNum(row.day_count),
    requestCount: reqNum(row.request_count),
    knownTokens: reqNum(row.known_tokens),
    lastSeenAt: String(row.last_seen_at ?? ""),
  }));
}

/** Rust imported_daily_usage：按日汇总已导入快照（deviceId 为空时汇总全部设备）。 */
export function importedDailyUsage(db: DatabaseSync, deviceId?: string | null): JsonRow[] {
  const sql = `SELECT usage_date, sum(request_count) AS request_count, sum(known_tokens) AS known_tokens,
                      sum(input_tokens) AS input_tokens, sum(input_cached_tokens) AS input_cached_tokens,
                      sum(input_uncached_tokens) AS input_uncached_tokens,
                      sum(cache_measured_input_tokens) AS cache_measured_input_tokens,
                      sum(output_tokens) AS output_tokens, sum(unknown_count) AS unknown_count,
                      sum(native_event_count) AS native_event_count,
                      sum(native_input_tokens) AS native_input_tokens,
                      sum(native_cached_input_tokens) AS native_cached_input_tokens,
                      sum(native_cache_write_input_tokens) AS native_cache_write_input_tokens,
                      sum(native_output_tokens) AS native_output_tokens,
                      sum(native_reasoning_tokens) AS native_reasoning_tokens,
                      sum(native_total_tokens) AS native_total_tokens,
                      sum(estimated_cost) AS estimated_cost
               FROM device_daily_usage
               ${deviceId ? "WHERE device_id = ?1" : ""}
               GROUP BY usage_date ORDER BY usage_date`;
  const rows = (
    deviceId ? db.prepare(sql).all(deviceId) : db.prepare(sql).all()
  ) as Array<Record<string, unknown>>;
  return rows.map(mapDailyRow);
}

/** Rust imported_hourly_usage：按小时汇总已导入快照。 */
export function importedHourlyUsage(db: DatabaseSync, deviceId?: string | null): JsonRow[] {
  const sql = `SELECT usage_hour, sum(request_count) AS request_count, sum(known_tokens) AS known_tokens,
                      sum(input_tokens) AS input_tokens, sum(input_cached_tokens) AS input_cached_tokens,
                      sum(cache_measured_input_tokens) AS cache_measured_input_tokens,
                      sum(output_tokens) AS output_tokens, sum(unknown_count) AS unknown_count,
                      sum(estimated_cost) AS estimated_cost,
                      sum(native_event_count) AS native_event_count,
                      sum(native_input_tokens) AS native_input_tokens,
                      sum(native_cached_input_tokens) AS native_cached_input_tokens,
                      sum(native_cache_write_input_tokens) AS native_cache_write_input_tokens,
                      sum(native_output_tokens) AS native_output_tokens,
                      sum(native_reasoning_tokens) AS native_reasoning_tokens,
                      sum(native_total_tokens) AS native_total_tokens
               FROM device_hourly_usage
               ${deviceId ? "WHERE device_id = ?1" : ""}
               GROUP BY usage_hour ORDER BY usage_hour`;
  const rows = (
    deviceId ? db.prepare(sql).all(deviceId) : db.prepare(sql).all()
  ) as Array<Record<string, unknown>>;
  return rows.map(mapHourlyRow);
}

// ─── device_usage.rs 等价入口（web 命令直接调用） ─────────────────────────────

export interface DeviceIdentityLike {
  device_id: string;
  device_created_at?: string;
  created_at?: string;
  display_name?: string;
  platform?: string;
  app_version?: string;
}

/**
 * Rust device_usage::known_devices：当前设备固定首位并标记 isCurrent，其余来自同步快照。
 * 未提供 identity 时只返回已同步设备。
 */
export function knownDevices(db: DatabaseSync, identity?: DeviceIdentityLike): JsonRow[] {
  if (!identity) return importedKnownDevices(db);
  const currentDays = dailyUsageTotals(db);
  const devices = importedKnownDevices(db).filter(
    (device) => String(device.deviceId) !== identity.device_id,
  );
  // Rust DeviceIdentity::read_and_validate 每次加载都会把平台键收敛到当前系统检测值，
  // 因此 known_devices 的当前设备行必须使用 resolvePlatform，而不是文件里的原始值
  // （例如身份文件中的 "linux" 在 Ubuntu 上应显示为 "ubuntu"）。
  const resolvedPlatform = resolvePlatform(
    identity.platform ?? "",
    detectPlatform(),
    currentOsFamily(),
  );
  devices.unshift({
    deviceId: identity.device_id,
    deviceCreatedAt: identity.device_created_at ?? identity.created_at ?? "",
    displayName: identity.display_name?.trim()
      ? identity.display_name.trim()
      : resolveDeviceDisplayName("", resolvedPlatform, identity.device_id),
    platform: resolvedPlatform,
    appVersion: identity.app_version ?? "node-host-0.1.0",
    isCurrent: true,
    timezoneOffsetMinutes: Math.round(-new Date().getTimezoneOffset()),
    firstUsageDate: currentDays.length > 0 ? currentDays[0].date : null,
    lastUsageDate: currentDays.length > 0 ? currentDays[currentDays.length - 1].date : null,
    dayCount: currentDays.length,
    requestCount: currentDays.reduce((sum, day) => sum + reqNum(day.requestCount), 0),
    knownTokens: currentDays.reduce((sum, day) => sum + reqNum(day.knownTokens), 0),
    lastSeenAt: new Date().toISOString(),
  });
  return devices;
}

/** Rust device_usage::daily_usage。 */
export function deviceDailyUsage(
  db: DatabaseSync,
  currentDeviceId: string,
  deviceId?: string | null,
): JsonRow[] {
  if (deviceId === currentDeviceId) return localDailyUsageTotalsWithNative(db);
  if (deviceId) return importedDailyUsage(db, deviceId);
  return mergeDailyUsageTotals([
    ...localDailyUsageTotalsWithNative(db),
    ...importedDailyUsage(db, null),
  ]);
}

/** Rust device_usage::hourly_usage。 */
export function deviceHourlyUsage(
  db: DatabaseSync,
  currentDeviceId: string,
  deviceId?: string | null,
): JsonRow[] {
  if (deviceId === currentDeviceId) return localHourlyUsageTotalsWithNative(db);
  if (deviceId) return importedHourlyUsage(db, deviceId);
  return mergeHourlyUsageTotals([
    ...localHourlyUsageTotalsWithNative(db),
    ...importedHourlyUsage(db, null),
  ]);
}