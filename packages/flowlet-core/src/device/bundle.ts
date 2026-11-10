// 设备用量快照 / 加密包（bundle）契约。Owner: desktop-device。
//
// 权威实现：src-tauri/src/core/device_identity.rs（DeviceUsageBundle / DeviceUsageSnapshot /
// validate / from_bytes）。字段命名与磁盘 JSON 完全一致（全部 camelCase），因为该 JSON
// 会被其它设备与移动端直接读取；任何字段改名都会让其它设备读不了。
//
// 校验口径必须与 Rust 逐条一致，否则导入端会接受 Rust 会拒绝的文件（或相反）：
// - bundle.format = "flowlet-device-usage"、version = 1；
// - snapshot.schemaVersion ∈ (0, 13]；deviceId 为 UUID；两个时间戳为 RFC3339；
// - days 严格按日期升序且不能重复；hours 必须是整点且严格升序；
// - 除 native_*_tokens 外（Codex 上下文压缩会产生负的累计修正）所有用量计数不得为负；
// - sessions / agents 的标识长度、运行状态、文本长度与控制字符限制。
import { randomUUID } from "node:crypto";

/** Rust `DEVICE_USAGE_SNAPSHOT_SCHEMA_VERSION`。 */
export const DEVICE_USAGE_SNAPSHOT_SCHEMA_VERSION = 13;
export const BUNDLE_FORMAT = "flowlet-device-usage";
export const BUNDLE_VERSION = 1;

const CONTROL_CHARS = /\p{Cc}/u;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const RFC3339_RE =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/;
const NAIVE_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const HOUR_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/;

export interface DailyUsageTotal {
  date: string;
  requestCount: number;
  knownTokens: number;
  inputTokens: number;
  inputCachedTokens: number;
  inputUncachedTokens: number;
  cacheMeasuredInputTokens: number;
  outputTokens: number;
  unknownCount: number;
  estimatedCost: number;
  nativeEventCount: number;
  nativeInputTokens: number;
  nativeCachedInputTokens: number;
  nativeCacheWriteInputTokens: number;
  nativeOutputTokens: number;
  nativeReasoningTokens: number;
  nativeTotalTokens: number;
}

export interface HourlyUsageTotal {
  hour: string;
  requestCount: number;
  knownTokens: number;
  inputTokens: number;
  inputCachedTokens: number;
  cacheMeasuredInputTokens: number;
  outputTokens: number;
  unknownCount: number;
  estimatedCost: number;
  nativeEventCount: number;
  nativeInputTokens: number;
  nativeCachedInputTokens: number;
  nativeCacheWriteInputTokens: number;
  nativeOutputTokens: number;
  nativeReasoningTokens: number;
  nativeTotalTokens: number;
}

export interface SyncedAgentInteractionEvent {
  id: string;
  kind: string;
  timestamp: string | null;
  title: string | null;
  content: string | null;
  model: string | null;
  status: string | null;
}

export interface SyncedAgentInteraction {
  events: SyncedAgentInteractionEvent[];
}

export interface SyncedAgentSession {
  agentType: string;
  sessionId: string;
  parentSessionId: string | null;
  runtimeStatus: string;
  title: string | null;
  clientName: string | null;
  activityAt: string;
  flowletObserved: boolean;
  requestCount: number;
  errorCount: number;
  knownTokens: number;
  nativeTurnCount: number | null;
  nativeTotalTokens: number | null;
  nativeTruncated: boolean;
  lastInteraction: SyncedAgentInteraction | null;
}

export interface SharedAgentSession extends SyncedAgentSession {
  deviceId: string;
  deviceDisplayName: string;
  devicePlatform: string;
}

export interface SyncedAgentInstallation {
  surface: string;
  installMethod: string;
  version: string | null;
}

export interface SyncedAgentProfile {
  agentId: string;
  agentName: string;
  installed: boolean;
  installations: SyncedAgentInstallation[];
  flowletConfigState: string | null;
  flowletObserved: boolean;
}

export interface LanPeerDescriptor {
  protocolVersion: number;
  endpoints: string[];
  authKey: string;
  capabilities: string[];
  startedAt: string;
  expiresAt: string;
}

export interface SyncedAccountQuotaWindow {
  label: string;
  usedPercent: number;
  resetsAt: string | null;
}

export interface SyncedAccountResource {
  accountId: string;
  channelId: string;
  channelName: string;
  accountName: string;
  plan: string | null;
  balance: number | null;
  balanceText: string | null;
  currency: string | null;
  tokenTotal: number | null;
  tokenUsed: number | null;
  tokenRemaining: number | null;
  expiresAt: string | null;
  quotaWindows: SyncedAccountQuotaWindow[];
  observedAt: string;
  stale: boolean;
}

export interface DeviceUsageBreakdownRow {
  date: string;
  clientId: string | null;
  clientName: string | null;
  channelId: string | null;
  channelName: string | null;
  accountId: string | null;
  accountName: string | null;
  upstreamModel: string | null;
  requestCount: number;
  knownTokens: number;
  inputTokens: number;
  inputCachedTokens: number;
  inputUncachedTokens: number;
  cacheMeasuredInputTokens: number;
  outputTokens: number;
  unknownCount: number;
  estimatedCost: number;
  estimatedCostCurrency: string | null;
  nativeEventCount: number;
  elapsedTotalMs: number;
  elapsedMeasuredCount: number;
  generationTotalMs: number;
  generationOutputTokens: number;
}

export interface DeviceUsageSnapshot {
  schemaVersion: number;
  deviceId: string;
  deviceCreatedAt: string;
  displayName: string;
  platform: string;
  appVersion: string;
  generatedAt: string;
  timezoneOffsetMinutes: number;
  days: DailyUsageTotal[];
  hours: HourlyUsageTotal[];
  sessions: SyncedAgentSession[];
  agents: SyncedAgentProfile[];
  lanPeer: LanPeerDescriptor | null;
  usageBreakdowns: DeviceUsageBreakdownRow[];
  accountResources: SyncedAccountResource[];
}

export interface DeviceUsageBundle {
  format: string;
  version: number;
  snapshot: DeviceUsageSnapshot;
}

export interface DeviceUsageImportPreview {
  deviceId: string;
  deviceCreatedAt: string;
  displayName: string;
  platform: string;
  appVersion: string;
  generatedAt: string;
  timezoneOffsetMinutes: number;
  firstDate: string | null;
  lastDate: string | null;
  dayCount: number;
  newDays: number;
  updatedDays: number;
  unchangedDays: number;
  sameAsCurrentDevice: boolean;
}

export interface DeviceUsageImportResult {
  deviceId: string;
  importedDays: number;
  unchangedDays: number;
}

export interface KnownDevice {
  deviceId: string;
  deviceCreatedAt: string;
  displayName: string;
  platform: string;
  appVersion: string;
  isCurrent: boolean;
  timezoneOffsetMinutes: number;
  firstUsageDate: string | null;
  lastUsageDate: string | null;
  dayCount: number;
  requestCount: number;
  knownTokens: number;
  lastSeenAt: string;
}

// ─── 基础校验工具 ────────────────────────────────────────────────────────────

/** Rust `chars().count()`：统计 Unicode 标量值而不是 UTF-16 code unit。 */
export function charCount(value: string): number {
  let count = 0;
  for (const _ of value) count += 1;
  return count;
}

export function hasControlChars(value: string): boolean {
  return CONTROL_CHARS.test(value);
}

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** RFC3339 时间戳（chrono::DateTime::parse_from_rfc3339 口径）。 */
export function isRfc3339(value: string): boolean {
  const match = RFC3339_RE.exec(value);
  if (!match) return false;
  return validDateParts(match[1], match[2], match[3]) && validClockParts(match[4], match[5], match[6]);
}

/** RFC3339 或 `%Y-%m-%d %H:%M:%S`（会话 activityAt 两代格式）。 */
export function isSessionTimestamp(value: string): boolean {
  if (isRfc3339(value)) return true;
  const match = NAIVE_DATETIME_RE.exec(value);
  if (!match) return false;
  return validDateParts(match[1], match[2], match[3]) && validClockParts(match[4], match[5], match[6]);
}

export function isNaiveDate(value: string): boolean {
  const match = DATE_RE.exec(value);
  return match !== null && validDateParts(match[1], match[2], match[3]);
}

export function isHourTimestamp(value: string): boolean {
  const match = HOUR_RE.exec(value);
  if (!match) return false;
  if (match[4] !== "00" || match[5] !== "00") return false;
  return validDateParts(match[1], match[2], match[3]);
}

function validDateParts(year: string, month: string, day: string): boolean {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function validClockParts(hour: string, minute: string, second: string): boolean {
  return Number(hour) <= 23 && Number(minute) <= 59 && Number(second) <= 59;
}

/** RFC3339 时间比较；解析失败返回 null（Rust 只在两段都合法时比较）。 */
export function parseRfc3339Millis(value: string): number | null {
  if (!isRfc3339(value)) return null;
  const millis = Date.parse(value);
  return Number.isNaN(millis) ? null : millis;
}

function invalid(message: string): never {
  throw new Error(message);
}

function asObject(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(`解析设备用量文件失败：${name} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) invalid(`解析设备用量文件失败：${name} 必须是数组`);
  return value;
}

function requiredString(object: Record<string, unknown>, name: string): string {
  const value = object[name];
  if (typeof value !== "string") invalid(`解析设备用量文件失败：${name} 必须是字符串`);
  return value;
}

function optionalString(object: Record<string, unknown>, name: string): string | null {
  const value = object[name];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") invalid(`解析设备用量文件失败：${name} 必须是字符串`);
  return value;
}

function requiredInteger(object: Record<string, unknown>, name: string): number {
  const value = object[name];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    invalid(`解析设备用量文件失败：${name} 必须是整数`);
  }
  return value;
}

function optionalInteger(object: Record<string, unknown>, name: string): number | null {
  const value = object[name];
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    invalid(`解析设备用量文件失败：${name} 必须是整数`);
  }
  return value;
}

function optionalNumber(object: Record<string, unknown>, name: string): number | null {
  const value = object[name];
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || Number.isNaN(value)) {
    invalid(`解析设备用量文件失败：${name} 必须是数字`);
  }
  return value;
}

function requiredBool(object: Record<string, unknown>, name: string): boolean {
  const value = object[name];
  if (typeof value !== "boolean") invalid(`解析设备用量文件失败：${name} 必须是布尔值`);
  return value;
}

function defaultInteger(object: Record<string, unknown>, name: string): number {
  const value = object[name];
  if (value === undefined || value === null) return 0;
  return requiredInteger(object, name);
}

function defaultNumber(object: Record<string, unknown>, name: string): number {
  const value = object[name];
  if (value === undefined || value === null) return 0;
  return requiredNumber(object, name);
}

function requiredNumber(object: Record<string, unknown>, name: string): number {
  const value = object[name];
  if (typeof value !== "number" || Number.isNaN(value)) {
    invalid(`解析设备用量文件失败：${name} 必须是数字`);
  }
  return value;
}

function defaultBool(object: Record<string, unknown>, name: string): boolean {
  const value = object[name];
  if (value === undefined || value === null) return false;
  return requiredBool(object, name);
}

function optionalStringArray(object: Record<string, unknown>, name: string): string[] {
  const value = object[name];
  if (value === undefined || value === null) return [];
  return asArray(value, name).map((item) => {
    if (typeof item !== "string") invalid(`解析设备用量文件失败：${name} 必须是字符串数组`);
    return item;
  });
}

// ─── 结构归一（serde 缺省语义） ──────────────────────────────────────────────

function normalizeDailyUsage(value: unknown): DailyUsageTotal {
  const object = asObject(value, "days[]");
  return {
    date: requiredString(object, "date"),
    requestCount: requiredInteger(object, "requestCount"),
    knownTokens: requiredInteger(object, "knownTokens"),
    inputTokens: requiredInteger(object, "inputTokens"),
    inputCachedTokens: requiredInteger(object, "inputCachedTokens"),
    inputUncachedTokens: requiredInteger(object, "inputUncachedTokens"),
    cacheMeasuredInputTokens: requiredInteger(object, "cacheMeasuredInputTokens"),
    outputTokens: requiredInteger(object, "outputTokens"),
    unknownCount: requiredInteger(object, "unknownCount"),
    estimatedCost: defaultNumber(object, "estimatedCost"),
    nativeEventCount: defaultInteger(object, "nativeEventCount"),
    nativeInputTokens: defaultInteger(object, "nativeInputTokens"),
    nativeCachedInputTokens: defaultInteger(object, "nativeCachedInputTokens"),
    nativeCacheWriteInputTokens: defaultInteger(object, "nativeCacheWriteInputTokens"),
    nativeOutputTokens: defaultInteger(object, "nativeOutputTokens"),
    nativeReasoningTokens: defaultInteger(object, "nativeReasoningTokens"),
    nativeTotalTokens: defaultInteger(object, "nativeTotalTokens"),
  };
}

function normalizeHourlyUsage(value: unknown): HourlyUsageTotal {
  const object = asObject(value, "hours[]");
  return {
    hour: requiredString(object, "hour"),
    requestCount: requiredInteger(object, "requestCount"),
    knownTokens: requiredInteger(object, "knownTokens"),
    inputTokens: defaultInteger(object, "inputTokens"),
    inputCachedTokens: defaultInteger(object, "inputCachedTokens"),
    cacheMeasuredInputTokens: defaultInteger(object, "cacheMeasuredInputTokens"),
    outputTokens: defaultInteger(object, "outputTokens"),
    unknownCount: defaultInteger(object, "unknownCount"),
    estimatedCost: defaultNumber(object, "estimatedCost"),
    nativeEventCount: defaultInteger(object, "nativeEventCount"),
    nativeInputTokens: defaultInteger(object, "nativeInputTokens"),
    nativeCachedInputTokens: defaultInteger(object, "nativeCachedInputTokens"),
    nativeCacheWriteInputTokens: defaultInteger(object, "nativeCacheWriteInputTokens"),
    nativeOutputTokens: defaultInteger(object, "nativeOutputTokens"),
    nativeReasoningTokens: defaultInteger(object, "nativeReasoningTokens"),
    nativeTotalTokens: defaultInteger(object, "nativeTotalTokens"),
  };
}

function normalizeInteractionEvent(value: unknown): SyncedAgentInteractionEvent {
  const object = asObject(value, "lastInteraction.events[]");
  return {
    id: requiredString(object, "id"),
    kind: requiredString(object, "kind"),
    timestamp: optionalString(object, "timestamp"),
    title: optionalString(object, "title"),
    content: optionalString(object, "content"),
    model: optionalString(object, "model"),
    status: optionalString(object, "status"),
  };
}

function normalizeInteraction(value: unknown): SyncedAgentInteraction {
  const object = asObject(value, "lastInteraction");
  return {
    events: asArray(object.events, "lastInteraction.events").map(normalizeInteractionEvent),
  };
}

function normalizeSession(value: unknown): SyncedAgentSession {
  const object = asObject(value, "sessions[]");
  return {
    agentType: requiredString(object, "agentType"),
    sessionId: requiredString(object, "sessionId"),
    parentSessionId: optionalString(object, "parentSessionId"),
    runtimeStatus: requiredString(object, "runtimeStatus"),
    title: optionalString(object, "title"),
    clientName: optionalString(object, "clientName"),
    activityAt: requiredString(object, "activityAt"),
    flowletObserved: requiredBool(object, "flowletObserved"),
    requestCount: requiredInteger(object, "requestCount"),
    errorCount: requiredInteger(object, "errorCount"),
    knownTokens: requiredInteger(object, "knownTokens"),
    nativeTurnCount: optionalInteger(object, "nativeTurnCount"),
    nativeTotalTokens: optionalInteger(object, "nativeTotalTokens"),
    nativeTruncated: defaultBool(object, "nativeTruncated"),
    lastInteraction:
      object.lastInteraction === undefined || object.lastInteraction === null
        ? null
        : normalizeInteraction(object.lastInteraction),
  };
}

function normalizeInstallation(value: unknown): SyncedAgentInstallation {
  const object = asObject(value, "installations[]");
  return {
    surface: requiredString(object, "surface"),
    installMethod: requiredString(object, "installMethod"),
    version: optionalString(object, "version"),
  };
}

function normalizeAgentProfile(value: unknown): SyncedAgentProfile {
  const object = asObject(value, "agents[]");
  return {
    agentId: requiredString(object, "agentId"),
    agentName: requiredString(object, "agentName"),
    installed: requiredBool(object, "installed"),
    installations: asArray(object.installations, "installations").map(normalizeInstallation),
    flowletConfigState: optionalString(object, "flowletConfigState"),
    flowletObserved: requiredBool(object, "flowletObserved"),
  };
}

function normalizeLanPeer(value: unknown): LanPeerDescriptor | null {
  if (value === undefined || value === null) return null;
  const object = asObject(value, "lanPeer");
  return {
    protocolVersion: requiredInteger(object, "protocolVersion"),
    endpoints: optionalStringArray(object, "endpoints"),
    authKey: requiredString(object, "authKey"),
    capabilities: optionalStringArray(object, "capabilities"),
    startedAt: requiredString(object, "startedAt"),
    expiresAt: requiredString(object, "expiresAt"),
  };
}

function normalizeQuotaWindow(value: unknown): SyncedAccountQuotaWindow {
  const object = asObject(value, "quotaWindows[]");
  return {
    label: requiredString(object, "label"),
    usedPercent: requiredNumber(object, "usedPercent"),
    resetsAt: optionalString(object, "resetsAt"),
  };
}

function normalizeAccountResource(value: unknown): SyncedAccountResource {
  const object = asObject(value, "accountResources[]");
  return {
    accountId: requiredString(object, "accountId"),
    channelId: requiredString(object, "channelId"),
    channelName: requiredString(object, "channelName"),
    accountName: requiredString(object, "accountName"),
    plan: optionalString(object, "plan"),
    balance: optionalNumber(object, "balance"),
    balanceText: optionalString(object, "balanceText"),
    currency: optionalString(object, "currency"),
    tokenTotal: optionalInteger(object, "tokenTotal"),
    tokenUsed: optionalInteger(object, "tokenUsed"),
    tokenRemaining: optionalInteger(object, "tokenRemaining"),
    expiresAt: optionalString(object, "expiresAt"),
    quotaWindows: asArray(
      object.quotaWindows === undefined || object.quotaWindows === null
        ? []
        : object.quotaWindows,
      "quotaWindows",
    ).map(normalizeQuotaWindow),
    observedAt: requiredString(object, "observedAt"),
    stale: defaultBool(object, "stale"),
  };
}

function normalizeBreakdown(value: unknown): DeviceUsageBreakdownRow {
  const object = asObject(value, "usageBreakdowns[]");
  return {
    date: requiredString(object, "date"),
    clientId: optionalString(object, "clientId"),
    clientName: optionalString(object, "clientName"),
    channelId: optionalString(object, "channelId"),
    channelName: optionalString(object, "channelName"),
    accountId: optionalString(object, "accountId"),
    accountName: optionalString(object, "accountName"),
    upstreamModel: optionalString(object, "upstreamModel"),
    requestCount: defaultInteger(object, "requestCount"),
    knownTokens: defaultInteger(object, "knownTokens"),
    inputTokens: defaultInteger(object, "inputTokens"),
    inputCachedTokens: defaultInteger(object, "inputCachedTokens"),
    inputUncachedTokens: defaultInteger(object, "inputUncachedTokens"),
    cacheMeasuredInputTokens: defaultInteger(object, "cacheMeasuredInputTokens"),
    outputTokens: defaultInteger(object, "outputTokens"),
    unknownCount: defaultInteger(object, "unknownCount"),
    estimatedCost: defaultNumber(object, "estimatedCost"),
    estimatedCostCurrency: optionalString(object, "estimatedCostCurrency"),
    nativeEventCount: defaultInteger(object, "nativeEventCount"),
    elapsedTotalMs: defaultInteger(object, "elapsedTotalMs"),
    elapsedMeasuredCount: defaultInteger(object, "elapsedMeasuredCount"),
    generationTotalMs: defaultInteger(object, "generationTotalMs"),
    generationOutputTokens: defaultInteger(object, "generationOutputTokens"),
  };
}

function normalizeSnapshot(value: unknown): DeviceUsageSnapshot {
  const object = asObject(value, "snapshot");
  return {
    schemaVersion: requiredInteger(object, "schemaVersion"),
    deviceId: requiredString(object, "deviceId"),
    deviceCreatedAt: requiredString(object, "deviceCreatedAt"),
    displayName: optionalString(object, "displayName") ?? "",
    platform: optionalString(object, "platform") ?? "",
    appVersion: optionalString(object, "appVersion") ?? "",
    generatedAt: requiredString(object, "generatedAt"),
    timezoneOffsetMinutes: requiredInteger(object, "timezoneOffsetMinutes"),
    days: asArray(object.days, "days").map(normalizeDailyUsage),
    hours: asArray(
      object.hours === undefined || object.hours === null ? [] : object.hours,
      "hours",
    ).map(normalizeHourlyUsage),
    sessions: asArray(
      object.sessions === undefined || object.sessions === null ? [] : object.sessions,
      "sessions",
    ).map(normalizeSession),
    agents: asArray(
      object.agents === undefined || object.agents === null ? [] : object.agents,
      "agents",
    ).map(normalizeAgentProfile),
    lanPeer: normalizeLanPeer(object.lanPeer),
    usageBreakdowns: asArray(
      object.usageBreakdowns === undefined || object.usageBreakdowns === null
        ? []
        : object.usageBreakdowns,
      "usageBreakdowns",
    ).map(normalizeBreakdown),
    accountResources: asArray(
      object.accountResources === undefined || object.accountResources === null
        ? []
        : object.accountResources,
      "accountResources",
    ).map(normalizeAccountResource),
  };
}

/** 把任意 JSON 值归一成 bundle（未知字段忽略，缺失的可选字段按 serde 默认值补齐）。 */
export function normalizeBundle(value: unknown): DeviceUsageBundle {
  const object = asObject(value, "根");
  return {
    format: requiredString(object, "format"),
    version: requiredInteger(object, "version"),
    snapshot: normalizeSnapshot(object.snapshot),
  };
}

// ─── 校验（Rust DeviceUsageBundle::validate） ────────────────────────────────

function validateDisplayName(value: string): void {
  const count = charCount(value);
  if (count === 0) invalid("名称不能为空");
  if (count > 64) invalid("名称不能超过 64 个字符");
  if (hasControlChars(value)) invalid("名称不能包含控制字符");
}

function validateNonNegative(value: number, label: string): void {
  if (value < 0) invalid(`设备用量包含负数：${label}`);
}

export function validateBundle(bundle: DeviceUsageBundle): void {
  if (bundle.format !== BUNDLE_FORMAT || bundle.version !== BUNDLE_VERSION) {
    invalid("不支持的 Flowlet 设备用量文件");
  }
  const snapshot = bundle.snapshot;
  if (!isUuid(snapshot.deviceId)) invalid("设备用量文件中的 deviceId 无效");
  if (!isRfc3339(snapshot.deviceCreatedAt)) invalid("设备用量文件的 deviceCreatedAt 无效");
  if (snapshot.displayName !== "") validateDisplayName(snapshot.displayName);
  if (charCount(snapshot.platform) > 32 || hasControlChars(snapshot.platform)) {
    invalid("设备用量文件的 platform 无效");
  }
  if (charCount(snapshot.appVersion) > 64 || hasControlChars(snapshot.appVersion)) {
    invalid("设备用量文件的 appVersion 无效");
  }
  if (snapshot.schemaVersion === 0 || snapshot.schemaVersion > DEVICE_USAGE_SNAPSHOT_SCHEMA_VERSION) {
    invalid(`不支持的设备用量快照版本：${snapshot.schemaVersion}`);
  }
  if (!isRfc3339(snapshot.generatedAt)) invalid("设备用量文件的 generatedAt 无效");
  if (snapshot.timezoneOffsetMinutes < -1440 || snapshot.timezoneOffsetMinutes > 1440) {
    invalid("设备用量文件的 timezoneOffsetMinutes 无效");
  }

  let previousDate: string | null = null;
  for (const day of snapshot.days) {
    if (!isNaiveDate(day.date)) invalid(`设备用量日期无效：${day.date}`);
    if (previousDate !== null && previousDate >= day.date) {
      invalid("设备用量日期必须严格递增且不能重复");
    }
    previousDate = day.date;
    for (const value of [
      day.requestCount,
      day.knownTokens,
      day.inputTokens,
      day.inputCachedTokens,
      day.inputUncachedTokens,
      day.cacheMeasuredInputTokens,
      day.outputTokens,
      day.unknownCount,
      day.nativeEventCount,
    ]) {
      validateNonNegative(value, day.date);
    }
  }

  let previousHour: string | null = null;
  for (const hour of snapshot.hours) {
    if (!isHourTimestamp(hour.hour)) invalid(`设备小时用量时间无效：${hour.hour}`);
    if (previousHour !== null && previousHour >= hour.hour) {
      invalid("设备小时用量必须严格递增且不能重复");
    }
    previousHour = hour.hour;
    for (const value of [
      hour.requestCount,
      hour.knownTokens,
      hour.inputTokens,
      hour.inputCachedTokens,
      hour.cacheMeasuredInputTokens,
      hour.outputTokens,
      hour.unknownCount,
      hour.nativeEventCount,
    ]) {
      if (value < 0) invalid(`设备小时用量不能为负数：${hour.hour}`);
    }
  }

  const sessionKeys = new Set<string>();
  for (const session of snapshot.sessions) {
    if (
      session.agentType.trim() === "" ||
      charCount(session.agentType) > 64 ||
      session.sessionId.trim() === "" ||
      charCount(session.sessionId) > 256
    ) {
      invalid("设备会话摘要包含无效的会话标识");
    }
    const key = `${session.agentType}\0${session.sessionId}`;
    if (sessionKeys.has(key)) invalid("设备会话摘要包含重复会话");
    sessionKeys.add(key);
    if (!["idle", "running", "waiting_user", "unknown"].includes(session.runtimeStatus)) {
      invalid("设备会话摘要包含无效运行状态");
    }
    if (!isSessionTimestamp(session.activityAt)) {
      invalid("设备会话摘要的 activityAt 无效");
    }
    if (
      session.requestCount < 0 ||
      session.errorCount < 0 ||
      session.knownTokens < 0 ||
      (session.nativeTurnCount !== null && session.nativeTurnCount < 0) ||
      (session.nativeTotalTokens !== null && session.nativeTotalTokens < 0)
    ) {
      invalid("设备会话摘要包含负数统计");
    }
    if (
      (session.title !== null &&
        (charCount(session.title) > 512 || hasControlChars(session.title))) ||
      (session.clientName !== null &&
        (charCount(session.clientName) > 128 || hasControlChars(session.clientName)))
    ) {
      invalid("设备会话摘要包含无效文本");
    }
    if (session.lastInteraction !== null) {
      const events = session.lastInteraction.events;
      if (events.length === 0 || !events.some((event) => event.kind === "user-message")) {
        invalid("设备会话最后交互缺少用户输入");
      }
      for (const event of events) {
        if (
          event.id.trim() === "" ||
          charCount(event.id) > 512 ||
          event.kind.trim() === "" ||
          charCount(event.kind) > 64
        ) {
          invalid("设备会话最后交互包含无效事件");
        }
        if (event.timestamp !== null && !isRfc3339(event.timestamp)) {
          invalid("设备会话最后交互包含无效时间");
        }
        if (
          (event.title !== null && charCount(event.title) > 512) ||
          (event.model !== null && charCount(event.model) > 256) ||
          (event.status !== null && charCount(event.status) > 64)
        ) {
          invalid("设备会话最后交互包含无效元数据");
        }
      }
    }
  }

  const agentIds = new Set<string>();
  for (const agent of snapshot.agents) {
    if (
      agent.agentId.trim() === "" ||
      charCount(agent.agentId) > 64 ||
      agent.agentName.trim() === "" ||
      charCount(agent.agentName) > 128 ||
      hasControlChars(agent.agentName)
    ) {
      invalid("设备 Agent 摘要包含无效标识");
    }
    if (agentIds.has(agent.agentId)) invalid("设备 Agent 摘要包含重复 Agent");
    agentIds.add(agent.agentId);
    if (
      agent.flowletConfigState !== null &&
      !["not_configured", "flowlet", "other_gateway", "partial", "invalid"].includes(
        agent.flowletConfigState,
      )
    ) {
      invalid("设备 Agent 摘要包含无效接入状态");
    }
    for (const installation of agent.installations) {
      if (
        !["cli", "desktop"].includes(installation.surface) ||
        installation.installMethod.trim() === "" ||
        charCount(installation.installMethod) > 32 ||
        (installation.version !== null &&
          (charCount(installation.version) > 64 || hasControlChars(installation.version)))
      ) {
        invalid("设备 Agent 摘要包含无效安装信息");
      }
    }
  }
}

/** Rust DeviceUsageBundle::from_bytes：解析 + 校验。 */
export function parseBundleBytes(bytes: Uint8Array): DeviceUsageBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (error) {
    invalid(
      `解析设备用量文件失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const bundle = normalizeBundle(parsed);
  validateBundle(bundle);
  return bundle;
}

// ─── 派生字段 ────────────────────────────────────────────────────────────────

export function resolvedPlatform(snapshot: DeviceUsageSnapshot): string {
  return snapshot.platform.trim() === "" ? "unknown" : snapshot.platform.trim();
}

export function resolvedAppVersion(snapshot: DeviceUsageSnapshot): string {
  return snapshot.appVersion.trim() === "" ? "unknown" : snapshot.appVersion.trim();
}

/**
 * Rust DeviceUsageSnapshot::new。
 *
 * `appVersion` 来自桌面宿主（Rust 是编译期 CARGO_PKG_VERSION）；`timezoneOffsetMinutes`
 * 使用本机本地时区偏移（东八区 +480），与 Rust `Local::now().offset()` 同号。
 */
export function newDeviceUsageSnapshot(input: {
  identity: { device_id: string; created_at: string; display_name: string; platform: string };
  appVersion: string;
  days: DailyUsageTotal[];
  hours: HourlyUsageTotal[];
  sessions: SyncedAgentSession[];
  agents: SyncedAgentProfile[];
}): DeviceUsageSnapshot {
  return {
    schemaVersion: DEVICE_USAGE_SNAPSHOT_SCHEMA_VERSION,
    deviceId: input.identity.device_id,
    deviceCreatedAt: input.identity.created_at,
    displayName: input.identity.display_name,
    platform: input.identity.platform,
    appVersion: input.appVersion,
    generatedAt: new Date().toISOString(),
    timezoneOffsetMinutes: -new Date().getTimezoneOffset(),
    days: input.days,
    hours: input.hours,
    sessions: input.sessions,
    agents: input.agents,
    lanPeer: null,
    usageBreakdowns: [],
    accountResources: [],
  };
}

export function newDeviceUsageBundle(snapshot: DeviceUsageSnapshot): DeviceUsageBundle {
  return { format: BUNDLE_FORMAT, version: BUNDLE_VERSION, snapshot };
}

/** Rust randomUUID 用法：任务/操作 ID。 */
export function newUuid(): string {
  return randomUUID();
}