// 桌面跨设备同步命令（批次 3）。Owner: desktop-device。
//
// 负责 23 条命令：device_usage_snapshot / list_shared_devices / shared_device_daily_usage /
// shared_device_hourly_usage / list_shared_device_sessions / refresh_shared_device /
// rename_current_device / get_s3_sync_settings / export_s3_connection_config /
// save_s3_sync_config / test_s3_sync_connection / test_s3_read_connection /
// sync_device_usage_s3 / recover_current_device_sync / refresh_shared_device_usage_s3 /
// list_remote_opencode_permissions / reply_remote_opencode_permission /
// refresh_shared_device_usage_lan / lan_server_status / probe_lan_peers /
// export_device_usage_bundle / preview_device_usage_import / import_device_usage_bundle。
//
// 权威行为：src-tauri/src/commands/device_sync.rs 与 core/device_sync.rs、core/lan_sync.rs。
// 约束：
// - S3 Secret 只走宿主凭据库（channel keyring.*），绝不写 SQLite / 明文文件；
// - 字段风格与 Rust 逐字段一致（这些结构体全部 `#[serde(rename_all = "camelCase")]`）；
// - 新增 SQL 在 ../storage/device-sync.ts、../storage/lan.ts，通过 withDatabase 调用。
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { CommandError } from "../types.ts";
import type { JsonRow } from "../types.ts";
import type { DeviceIdentity } from "../types.ts";
import type { DesktopContext, DesktopHandlerMap } from "./types.ts";
import {
  argObject,
  argOptionalString,
  argString,
  argsObject,
  invalidType,
  requireFields,
} from "../web/errors.ts";
import {
  newDeviceUsageBundle,
  newDeviceUsageSnapshot,
  parseBundleBytes,
  resolvedAppVersion,
  resolvedPlatform,
  type DailyUsageTotal,
  type DeviceUsageBundle,
  type DeviceUsageImportPreview,
  type DeviceUsageSnapshot,
  type HourlyUsageTotal,
  type KnownDevice,
  type LanPeerDescriptor,
} from "../device/bundle.ts";
import {
  deviceObjectPrefix,
  parseS3ConfigInput,
  S3Store,
  s3CredentialUsername,
  type RemoteObject,
  type S3SyncConfig,
  type S3SyncConfigInput,
} from "../services/s3.ts";
import {
  exportS3ConnectionConfig,
  loadS3Config as loadStoredS3Config,
  saveS3Config as saveStoredS3Config,
} from "../services/account-workspace.ts";
import { hasSecret, readSecret } from "../device/keyring.ts";
import { updateDisplayName } from "../device/identity.ts";
import {
  candidateLanAddresses,
  descriptorIsFresh,
  DESCRIPTOR_TTL_MINUTES,
  endpointPort,
  ensureLanServer,
  fetchLanSnapshot,
  fetchRemotePermissions,
  probeLanPeer,
  readLanServerReport,
  recordLanStartFailure,
  replyRemotePermission,
  validateLanEndpoint,
  type LanPeerProbe,
} from "../device/lan.ts";
import {
  listSessionPermissions as listOpenCodeSessionPermissions,
  pendingSessionIds,
  replyPermission as replyOpenCodePermission,
} from "../device/opencode-control.ts";
import * as lanStore from "../storage/lan.ts";
import {
  importDeviceAccountResources,
  importDeviceUsage,
  importDeviceUsageBreakdowns,
  listAgentSessionsForDeviceSync,
  loadCurrentEtag,
  loadRemoteEtags,
  loadS3Status,
  previewDeviceUsageImport,
  saveCurrentEtag,
  saveRemoteEtags,
  saveS3Status,
  usageBreakdownForSync,
  importedDeviceSessions,
} from "../storage/device-sync.ts";
import {
  importedDailyUsage,
  importedHourlyUsage,
  importedKnownDevices,
  localDailyUsageTotalsWithNative,
  localHourlyUsageTotalsWithNative,
  resolveDeviceDisplayName,
} from "../storage/devices.ts";

const MAX_BUNDLE_BYTES = 4 * 1024 * 1024;
const SYNC_ALREADY_RUNNING_ERROR = "设备用量同步正在运行";

// ─── 通用小工具 ──────────────────────────────────────────────────────────────

function badRequest(error: unknown): CommandError {
  if (error instanceof CommandError) return error;
  return CommandError.badRequest(error instanceof Error ? error.message : String(error));
}

function identityRecord(ctx: DesktopContext): DeviceIdentity {
  return ctx.deviceIdentity;
}

function currentDeviceId(ctx: DesktopContext): string {
  return String(identityRecord(ctx).device_id ?? "");
}

function requireConfig(config: S3SyncConfig | null): S3SyncConfig {
  if (config === null) throw new Error("尚未配置 S3 同步");
  return config;
}

function requireNonEmptyDeviceId(deviceId: string): string {
  const trimmed = deviceId.trim();
  if (trimmed === "") throw new Error("设备 ID 不能为空");
  return trimmed;
}

function structString(object: JsonRow, field: string): string {
  const value = object[field];
  if (typeof value !== "string") throw invalidType(value, "a string", "config");
  return value;
}

function structOptionalString(object: JsonRow, field: string): string | null {
  const value = object[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw invalidType(value, "a string", "config");
  return value;
}

function structBool(object: JsonRow, field: string): boolean {
  const value = object[field];
  if (typeof value !== "boolean") throw invalidType(value, "a boolean", "config");
  return value;
}

/** Rust `S3SyncConfigInput` 的 serde 反序列化（secretAccessKey 为 Option，可缺省）。 */
function parseS3ConfigArgument(rawArgs: JsonRow): S3SyncConfigInput {
  const object = argObject(rawArgs, "config", "S3SyncConfigInput");
  requireFields(object, "config", [
    "endpoint",
    "region",
    "bucket",
    "prefix",
    "accessKeyId",
    "pathStyle",
  ]);
  return {
    endpoint: structString(object, "endpoint"),
    region: structString(object, "region"),
    bucket: structString(object, "bucket"),
    prefix: structString(object, "prefix"),
    accessKeyId: structString(object, "accessKeyId"),
    secretAccessKey: structOptionalString(object, "secretAccessKey"),
    pathStyle: structBool(object, "pathStyle"),
  };
}

function snapshotKey(config: S3SyncConfig, deviceId: string): string {
  return `${deviceObjectPrefix(config)}${deviceId}/snapshot.json`;
}

/**
 * ETag 规范化：Rust 版在 app_meta 与比较中都使用带引号的原始 ETag（rusty-s3 解析保留引号），
 * 而 services/s3.ts 的 ListObjectsV2 解析会去掉引号。为了与 Rust 版共用 app_meta 缓存、
 * 并给 PutObject 的 If-Match 发送合法带引号值，本层统一成 `"xxx"` 形式后持久化/比较。
 */
function canonicalEtag(etag: string): string {
  const bare = etag.trim().replace(/^"|"$/g, "");
  return `"${bare}"`;
}

function etagEquals(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return left === right;
  return canonicalEtag(left) === canonicalEtag(right);
}

function normalizeRemoteObjects(objects: RemoteObject[]): RemoteObject[] {
  return objects.map((object) => ({ ...object, etag: canonicalEtag(object.etag) }));
}

/** Rust `snapshot_object_label`。 */
function snapshotObjectLabel(key: string): string {
  const suffix = "/snapshot.json";
  if (!key.endsWith(suffix)) return "未知设备快照";
  const prefix = key.slice(0, key.length - suffix.length);
  const deviceId = prefix.slice(prefix.lastIndexOf("/") + 1);
  return deviceId === "" ? "未知设备快照" : `设备 ${deviceId}`;
}

function rfc3339Now(): string {
  return new Date().toISOString();
}

/** Rust `prefer_lan_bundle` 的新旧比较（两段都必须是 RFC3339）。 */
function snapshotIsNewer(candidate: string, fallback: string): boolean {
  const candidateMillis = Date.parse(candidate);
  const fallbackMillis = Date.parse(fallback);
  if (Number.isNaN(candidateMillis) || Number.isNaN(fallbackMillis)) return false;
  return candidateMillis > fallbackMillis;
}

// ─── 同步互斥（Rust JobRuntime 的 device-sync scope） ─────────────────────────

let activeSync: { scope: string } | null = null;

function acquireSyncLease(scope: string): { release(): void } {
  if (activeSync !== null) throw new Error(SYNC_ALREADY_RUNNING_ERROR);
  activeSync = { scope };
  return {
    release(): void {
      if (activeSync !== null && activeSync.scope === scope) activeSync = null;
    },
  };
}

/** 测试用：清空进程内互斥状态。 */
export function resetSyncLeaseForTests(): void {
  activeSync = null;
}

// ─── 快照构建 ────────────────────────────────────────────────────────────────

function snapshotProfile(ctx: DesktopContext): {
  identity: DeviceIdentity;
  appVersion: string;
} {
  return { identity: identityRecord(ctx), appVersion: ctx.desktop.appVersion };
}

async function buildDeviceSnapshot(ctx: DesktopContext): Promise<DeviceUsageSnapshot> {
  const pending = await pendingSessionIds();
  const collected = ctx.storage.withDatabase((db) => ({
    days: localDailyUsageTotalsWithNative(db) as unknown as DailyUsageTotal[],
    hours: localHourlyUsageTotalsWithNative(db) as unknown as HourlyUsageTotal[],
    sessions: listAgentSessionsForDeviceSync(db, pending),
    usageBreakdowns: usageBreakdownForSync(db, 90),
  }));
  const snapshot = newDeviceUsageSnapshot({
    identity: identityRecord(ctx),
    appVersion: ctx.desktop.appVersion,
    days: collected.days,
    hours: collected.hours,
    sessions: collected.sessions,
    agents: [],
  });
  snapshot.usageBreakdowns = collected.usageBreakdowns;
  snapshot.lanPeer = await refreshCurrentDescriptor(ctx);
  return snapshot;
}

/** Rust `current_descriptor`：刷新端点/有效期并回写 app_meta（不负责启动服务）。 */
async function refreshCurrentDescriptor(
  ctx: DesktopContext,
): Promise<DeviceUsageBundle["snapshot"]["lanPeer"]> {
  const stored = ctx.storage.withDatabase((db) => lanStore.loadLanDescriptor(db));
  if (stored === null || !descriptorIsFresh(stored)) return null;
  const descriptor = { ...stored };
  const port = descriptor.endpoints
    .map((endpoint) => endpointPort(endpoint))
    .find((value) => value !== null);
  if (port !== null && port !== undefined) {
    const endpoints = (await candidateLanAddresses())
      .map((address) => `http://${address}:${port}`)
      .filter((endpoint) => {
        try {
          validateLanEndpoint(endpoint);
          return true;
        } catch {
          return false;
        }
      });
    if (endpoints.length > 0) descriptor.endpoints = endpoints;
  }
  descriptor.expiresAt = new Date(
    Date.now() + DESCRIPTOR_TTL_MINUTES * 60_000,
  ).toISOString();
  ctx.storage.withDatabase((db) => lanStore.saveLanDescriptor(db, descriptor));
  return descriptor;
}

function lanDependencies(ctx: DesktopContext) {
  return {
    deviceId: currentDeviceId(ctx),
    publishDescriptor: (descriptor: LanPeerDescriptor) => {
      ctx.storage.withDatabase((db) => lanStore.saveLanDescriptor(db, descriptor));
    },
    buildSnapshot: async () => newDeviceUsageBundle(await buildDeviceSnapshot(ctx)),
    buildSession: async (agentType: string, sessionId: string) => {
      const pending = await pendingSessionIds();
      const sessions = ctx.storage.withDatabase((db) =>
        listAgentSessionsForDeviceSync(db, pending),
      );
      return (
        sessions.find(
          (session) =>
            session.agentType === agentType && session.sessionId === sessionId,
        ) ?? null
      );
    },
    listPermissions: (sessionId: string) => listOpenCodeSessionPermissions(sessionId),
    replyPermission: (permissionId: string, decision: "allow_once" | "reject") =>
      replyOpenCodePermission(permissionId, decision),
  };
}

/** 惰性启动 LAN 服务；启动失败只记录状态，不阻断设备同步/快照。 */
async function ensureLanForContext(ctx: DesktopContext): Promise<void> {
  try {
    await ensureLanServer(lanDependencies(ctx));
  } catch (error) {
    recordLanStartFailure(error instanceof Error ? error.message : String(error));
  }
}

// ─── 局域网刷新 ──────────────────────────────────────────────────────────────

function loadPeerDescriptor(ctx: DesktopContext, deviceId: string) {
  const registry = ctx.storage.withDatabase((db) => lanStore.loadPeerRegistry(db));
  const descriptor = registry[deviceId];
  if (!descriptorIsFresh(descriptor)) return null;
  return descriptor;
}

/**
 * Rust `refresh_known_peers`：对已知 peer 拉取 LAN 快照并导入。
 * 返回 attempted / refreshed / failed 三个计数。
 */
async function refreshKnownPeers(
  ctx: DesktopContext,
  deviceId: string | null,
): Promise<{ attemptedDevices: number; refreshedDevices: number; failedDevices: number }> {
  const registry = ctx.storage.withDatabase((db) => lanStore.loadPeerRegistry(db));
  const peers = Object.entries(registry).filter(
    ([id, descriptor]) =>
      (deviceId === null || deviceId === id) && descriptorIsFresh(descriptor),
  );
  const attemptedDevices = peers.length;
  const bundles: Array<{ expectedDeviceId: string; bundle: DeviceUsageBundle }> = [];
  let failedDevices = 0;
  for (const [expectedDeviceId, descriptor] of peers) {
    try {
      const bundle = await fetchLanSnapshot(descriptor);
      if (!validateLanBundle(bundle) || bundle.snapshot.deviceId !== expectedDeviceId) {
        failedDevices += 1;
        continue;
      }
      ctx.storage.withDatabase((db) =>
        lanStore.rememberPeer(db, bundle.snapshot.deviceId, bundle.snapshot.lanPeer),
      );
      bundles.push({ expectedDeviceId, bundle });
    } catch {
      failedDevices += 1;
    }
  }
  const refreshedDevices = bundles.length;
  for (const { bundle } of bundles) {
    importBundleSnapshot(ctx, bundle);
  }
  return { attemptedDevices, refreshedDevices, failedDevices };
}

function validateLanBundle(bundle: DeviceUsageBundle): boolean {
  try {
    // 局域网快照必须通过与文件导入一致的校验（Rust `bundle.validate()`）。
    parseBundleBytes(Buffer.from(JSON.stringify(bundle), "utf8"));
    return true;
  } catch {
    return false;
  }
}

function importBundleSnapshot(ctx: DesktopContext, bundle: DeviceUsageBundle): void {
  const snapshot = bundle.snapshot;
  const profile = {
    deviceId: snapshot.deviceId,
    deviceCreatedAt: snapshot.deviceCreatedAt,
    displayName: resolveDeviceDisplayName(
      snapshot.displayName,
      resolvedPlatform(snapshot),
      snapshot.deviceId,
    ),
    platform: resolvedPlatform(snapshot),
    appVersion: resolvedAppVersion(snapshot),
    generatedAt: snapshot.generatedAt,
    timezoneOffsetMinutes: snapshot.timezoneOffsetMinutes,
  };
  ctx.storage.withDatabase((db) => {
    importDeviceUsage(
      db,
      snapshot.schemaVersion,
      profile,
      snapshot.days,
      snapshot.hours,
      snapshot.sessions,
      snapshot.agents,
    );
    importDeviceUsageBreakdowns(db, snapshot.deviceId, snapshot.generatedAt, snapshot.usageBreakdowns);
    importDeviceAccountResources(
      db,
      snapshot.deviceId,
      snapshot.generatedAt,
      snapshot.accountResources,
    );
  });
}

// ─── S3 同步 / 拉取 ─────────────────────────────────────────────────────────

interface PullResult {
  remoteDevices: number;
  importedDevices: number;
  importedDays: number;
  unchangedDays: number;
  failedObjects: number;
  failureDetails: string[];
}

async function loadStore(ctx: DesktopContext): Promise<{ config: S3SyncConfig; store: S3Store }> {
  const config = requireConfig(loadStoredS3Config(ctx.storage));
  const secret = await readSecret(ctx.desktop.host, s3CredentialUsername(config));
  return { config, store: new S3Store(config, secret) };
}

/** Rust `prefer_lan_bundle`：LAN 快照更新时优先使用，否则回退 S3。 */
async function preferLanBundle(
  ctx: DesktopContext,
  fallback: DeviceUsageBundle,
): Promise<DeviceUsageBundle> {
  const descriptor = fallback.snapshot.lanPeer;
  if (descriptor === null) return fallback;
  try {
    const bundle = await fetchLanSnapshot(descriptor);
    if (
      validateLanBundle(bundle) &&
      bundle.snapshot.deviceId === fallback.snapshot.deviceId &&
      snapshotIsNewer(bundle.snapshot.generatedAt, fallback.snapshot.generatedAt)
    ) {
      ctx.storage.withDatabase((db) =>
        lanStore.rememberPeer(db, bundle.snapshot.deviceId, bundle.snapshot.lanPeer),
      );
      return bundle;
    }
    return fallback;
  } catch {
    return fallback;
  }
}

/** Rust `pull_device_usage`。 */
async function pullDeviceUsage(
  ctx: DesktopContext,
  preferLan: boolean,
): Promise<PullResult> {
  const { config, store } = await loadStore(ctx);
  const objects = await store.list(deviceObjectPrefix(config));
  const remoteObjects = objects.filter((object) => object.key.endsWith("/snapshot.json"));
  const bundles: DeviceUsageBundle[] = [];
  const failureDetails: string[] = [];
  for (const object of remoteObjects) {
    const label = snapshotObjectLabel(object.key);
    if (object.size > 64 * 1024 * 1024) {
      failureDetails.push(`${label}：快照超过 64 MB 限制`);
      continue;
    }
    let bundle: DeviceUsageBundle;
    try {
      bundle = parseBundleBytes(await store.get(object.key));
    } catch (error) {
      failureDetails.push(
        `${label}：${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    if (snapshotKey(config, bundle.snapshot.deviceId) === object.key) {
      ctx.storage.withDatabase((db) =>
        lanStore.rememberPeer(db, bundle.snapshot.deviceId, bundle.snapshot.lanPeer),
      );
      bundles.push(preferLan ? await preferLanBundle(ctx, bundle) : bundle);
    } else {
      failureDetails.push(`${label}：快照 deviceId 与对象路径不一致`);
    }
  }

  let importedDevices = 0;
  let importedDays = 0;
  let unchangedDays = 0;
  for (const bundle of bundles) {
    const snapshot = bundle.snapshot;
    const deviceLabel = resolveDeviceDisplayName(
      snapshot.displayName,
      resolvedPlatform(snapshot),
      snapshot.deviceId,
    );
    try {
      const result = ctx.storage.withDatabase((db) =>
        importDeviceUsage(
          db,
          snapshot.schemaVersion,
          {
            deviceId: snapshot.deviceId,
            deviceCreatedAt: snapshot.deviceCreatedAt,
            displayName: deviceLabel,
            platform: resolvedPlatform(snapshot),
            appVersion: resolvedAppVersion(snapshot),
            generatedAt: snapshot.generatedAt,
            timezoneOffsetMinutes: snapshot.timezoneOffsetMinutes,
          },
          snapshot.days,
          snapshot.hours,
          snapshot.sessions,
          snapshot.agents,
        ),
      );
      try {
        // Rust 对 breakdown 导入失败只 tracing::warn，不计入 failedObjects。
        ctx.storage.withDatabase((db) =>
          importDeviceUsageBreakdowns(
            db,
            snapshot.deviceId,
            snapshot.generatedAt,
            snapshot.usageBreakdowns,
          ),
        );
      } catch {
        /* 与 Rust 一致：维度用量失败只告警，不影响设备导入结果 */
      }
      try {
        ctx.storage.withDatabase((db) =>
          importDeviceAccountResources(
            db,
            snapshot.deviceId,
            snapshot.generatedAt,
            snapshot.accountResources,
          ),
        );
      } catch (error) {
        failureDetails.push(
          `${deviceLabel}：账号资源导入失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
      importedDevices += 1;
      importedDays += result.importedDays;
      unchangedDays += result.unchangedDays;
    } catch (error) {
      failureDetails.push(
        `${deviceLabel}：导入失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return {
    remoteDevices: remoteObjects.length,
    importedDevices,
    importedDays,
    unchangedDays,
    failedObjects: failureDetails.length,
    failureDetails,
  };
}

/** Rust `pull_device_usage_for_device`（指定设备只读唯一对象，不列举其它）。 */
async function pullDeviceUsageForDevice(
  ctx: DesktopContext,
  deviceId: string,
): Promise<PullResult> {
  const { config, store } = await loadStore(ctx);
  const objectKey = snapshotKey(config, deviceId);
  const bundle = parseBundleBytes(await store.get(objectKey));
  if (
    bundle.snapshot.deviceId !== deviceId ||
    snapshotKey(config, bundle.snapshot.deviceId) !== objectKey
  ) {
    throw new Error("S3 快照 deviceId 与当前设备不一致");
  }
  ctx.storage.withDatabase((db) =>
    lanStore.rememberPeer(db, bundle.snapshot.deviceId, bundle.snapshot.lanPeer),
  );
  const snapshot = bundle.snapshot;
  const result = ctx.storage.withDatabase((db) =>
    importDeviceUsage(
      db,
      snapshot.schemaVersion,
      {
        deviceId: snapshot.deviceId,
        deviceCreatedAt: snapshot.deviceCreatedAt,
        displayName: resolveDeviceDisplayName(
          snapshot.displayName,
          resolvedPlatform(snapshot),
          snapshot.deviceId,
        ),
        platform: resolvedPlatform(snapshot),
        appVersion: resolvedAppVersion(snapshot),
        generatedAt: snapshot.generatedAt,
        timezoneOffsetMinutes: snapshot.timezoneOffsetMinutes,
      },
      snapshot.days,
      snapshot.hours,
      snapshot.sessions,
      snapshot.agents,
    ),
  );
  ctx.storage.withDatabase((db) => {
    importDeviceUsageBreakdowns(
      db,
      snapshot.deviceId,
      snapshot.generatedAt,
      snapshot.usageBreakdowns,
    );
    importDeviceAccountResources(
      db,
      snapshot.deviceId,
      snapshot.generatedAt,
      snapshot.accountResources,
    );
  });
  return {
    remoteDevices: 1,
    importedDevices: 1,
    importedDays: result.importedDays,
    unchangedDays: result.unchangedDays,
    failedObjects: 0,
    failureDetails: [],
  };
}

async function runConfiguredPull(
  ctx: DesktopContext,
  preferLan: boolean,
): Promise<PullResult> {
  const lease = acquireSyncLease("device-s3-pull");
  try {
    const now = rfc3339Now();
    const previous = ctx.storage.withDatabase((db) => loadS3Status(db));
    ctx.storage.withDatabase((db) =>
      saveS3Status(db, {
        status: "running",
        lastAttemptAt: now,
        lastSuccessAt: previous.lastSuccessAt,
        message: "正在读取远端设备用量",
        remoteDevices: previous.remoteDevices,
        importedDevices: 0,
        importedDays: 0,
        failedObjects: 0,
        failureDetails: [],
      }),
    );
    try {
      const result = await pullDeviceUsage(ctx, preferLan);
      const status = result.failedObjects === 0 ? "success" : "partial";
      const failureSuffix =
        result.failedObjects === 0 ? "" : `；${result.failedObjects} 个对象失败`;
      ctx.storage.withDatabase((db) =>
        saveS3Status(db, {
          status,
          lastAttemptAt: now,
          lastSuccessAt: rfc3339Now(),
          message: `刷新完成：读取 ${result.remoteDevices} 台设备，更新 ${result.importedDevices} 台，新增或更新 ${result.importedDays} 天，${result.unchangedDays} 天未变化${failureSuffix}`,
          remoteDevices: result.remoteDevices,
          importedDevices: result.importedDevices,
          importedDays: result.importedDays,
          failedObjects: result.failedObjects,
          failureDetails: [...result.failureDetails],
        }),
      );
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.storage.withDatabase((db) =>
        saveS3Status(db, {
          status: "failed",
          lastAttemptAt: now,
          lastSuccessAt: previous.lastSuccessAt,
          message,
          remoteDevices: previous.remoteDevices,
          importedDevices: 0,
          importedDays: 0,
          failedObjects: 0,
          failureDetails: [],
        }),
      );
      throw error;
    }
  } finally {
    lease.release();
  }
}

interface S3DeviceSyncResult {
  remoteDevices: number;
  importedDevices: number;
  importedDays: number;
  unchangedDays: number;
  failedObjects: number;
  uploadedKey: string;
  uploadedBytes: number;
  downloadedBytes: number;
  skippedObjects: number;
  listMs: number;
  downloadMs: number;
  importMs: number;
  snapshotMs: number;
  uploadMs: number;
}

/** Rust `sync_device_usage`：先拉取其它设备，再上传本机快照（含 ETag 冲突检查）。 */
async function syncDeviceUsage(ctx: DesktopContext): Promise<S3DeviceSyncResult> {
  const { config, store } = await loadStore(ctx);
  const prefix = deviceObjectPrefix(config);
  const identity = identityRecord(ctx);
  const currentKey = snapshotKey(config, identity.device_id);

  const listStarted = Date.now();
  const objects = normalizeRemoteObjects(await store.list(prefix));
  const listMs = Date.now() - listStarted;

  const currentEtag = objects.find((object) => object.key === currentKey)?.etag ?? null;
  const savedEtag = ctx.storage.withDatabase((db) => loadCurrentEtag(db));
  const scopedSavedEtag =
    savedEtag !== null &&
    savedEtag.endpoint === config.endpoint &&
    savedEtag.bucket === config.bucket &&
    savedEtag.key === currentKey
      ? { ...savedEtag, etag: canonicalEtag(savedEtag.etag) }
      : null;
  if (
    scopedSavedEtag !== null &&
    currentEtag !== null &&
    !etagEquals(scopedSavedEtag.etag, currentEtag)
  ) {
    throw new Error("远端当前设备快照已被另一个写入者修改，可能存在重复设备 ID");
  }

  const remoteObjects = objects.filter(
    (object) => object.key !== currentKey && object.key.endsWith("/snapshot.json"),
  );
  const remoteEtags = ctx.storage.withDatabase((db) =>
    loadRemoteEtags(db, config.endpoint, config.bucket),
  );
  for (const key of Object.keys(remoteEtags.etags)) {
    if (!remoteObjects.some((object) => object.key === key)) delete remoteEtags.etags[key];
    else remoteEtags.etags[key] = canonicalEtag(remoteEtags.etags[key]);
  }
  const skippedObjects = remoteObjects.filter((object) =>
    etagEquals(remoteEtags.etags[object.key] ?? null, object.etag),
  ).length;

  const bundles: Array<{ objectKey: string; etag: string; bundle: DeviceUsageBundle }> = [];
  let failedObjects = 0;
  let downloadedBytes = 0;
  const downloadStarted = Date.now();
  for (const object of remoteObjects) {
    if (etagEquals(remoteEtags.etags[object.key] ?? null, object.etag)) continue;
    if (object.size > 64 * 1024 * 1024) {
      failedObjects += 1;
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = await store.get(object.key);
    } catch {
      failedObjects += 1;
      continue;
    }
    downloadedBytes += bytes.byteLength;
    let bundle: DeviceUsageBundle;
    try {
      bundle = parseBundleBytes(bytes);
    } catch {
      failedObjects += 1;
      continue;
    }
    if (
      bundle.snapshot.deviceId !== identity.device_id &&
      snapshotKey(config, bundle.snapshot.deviceId) === object.key
    ) {
      ctx.storage.withDatabase((db) =>
        lanStore.rememberPeer(db, bundle.snapshot.deviceId, bundle.snapshot.lanPeer),
      );
      bundles.push({
        objectKey: object.key,
        etag: object.etag,
        bundle: await preferLanBundle(ctx, bundle),
      });
    } else {
      failedObjects += 1;
    }
  }
  const downloadMs = Date.now() - downloadStarted;

  const importStarted = Date.now();
  let importedDevices = 0;
  let importedDays = 0;
  let unchangedDays = 0;
  let importFailures = 0;
  const importedEtags: Array<[string, string]> = [];
  for (const entry of bundles) {
    const snapshot = entry.bundle.snapshot;
    const failuresBefore = importFailures;
    let result: { importedDays: number; unchangedDays: number };
    try {
      result = ctx.storage.withDatabase((db) =>
        importDeviceUsage(
          db,
          snapshot.schemaVersion,
          {
            deviceId: snapshot.deviceId,
            deviceCreatedAt: snapshot.deviceCreatedAt,
            displayName: resolveDeviceDisplayName(
              snapshot.displayName,
              resolvedPlatform(snapshot),
              snapshot.deviceId,
            ),
            platform: resolvedPlatform(snapshot),
            appVersion: resolvedAppVersion(snapshot),
            generatedAt: snapshot.generatedAt,
            timezoneOffsetMinutes: snapshot.timezoneOffsetMinutes,
          },
          snapshot.days,
          snapshot.hours,
          snapshot.sessions,
          snapshot.agents,
        ),
      );
    } catch {
      importFailures += 1;
      continue;
    }
    try {
      ctx.storage.withDatabase((db) =>
        importDeviceUsageBreakdowns(
          db,
          snapshot.deviceId,
          snapshot.generatedAt,
          snapshot.usageBreakdowns,
        ),
      );
    } catch {
      importFailures += 1;
    }
    try {
      ctx.storage.withDatabase((db) =>
        importDeviceAccountResources(
          db,
          snapshot.deviceId,
          snapshot.generatedAt,
          snapshot.accountResources,
        ),
      );
    } catch {
      importFailures += 1;
    }
    importedDevices += 1;
    importedDays += result.importedDays;
    unchangedDays += result.unchangedDays;
    if (importFailures === failuresBefore) {
      importedEtags.push([entry.objectKey, entry.etag]);
    }
  }
  const importMs = Date.now() - importStarted;
  for (const [key, etag] of importedEtags) remoteEtags.etags[key] = etag;
  ctx.storage.withDatabase((db) => saveRemoteEtags(db, remoteEtags));

  const snapshotStarted = Date.now();
  const snapshot = await buildDeviceSnapshot(ctx);
  const bundle = newDeviceUsageBundle(snapshot);
  const bytes = Buffer.from(JSON.stringify(bundle), "utf8");
  const uploadedBytes = bytes.byteLength;
  const snapshotMs = Date.now() - snapshotStarted;
  const expectedEtag = scopedSavedEtag?.etag ?? currentEtag;
  const uploadStarted = Date.now();
  const uploadedRaw =
    (await store.put(currentKey, bytes, expectedEtag)) ?? (await store.headEtag(currentKey));
  const uploadedEtag = uploadedRaw === null ? null : canonicalEtag(uploadedRaw);
  const uploadMs = Date.now() - uploadStarted;
  if (uploadedEtag !== null) {
    ctx.storage.withDatabase((db) =>
      saveCurrentEtag(db, {
        endpoint: config.endpoint,
        bucket: config.bucket,
        key: currentKey,
        etag: uploadedEtag,
      }),
    );
  }
  return {
    remoteDevices: remoteObjects.length,
    importedDevices,
    importedDays,
    unchangedDays,
    failedObjects: failedObjects + importFailures,
    uploadedKey: currentKey,
    uploadedBytes,
    downloadedBytes,
    skippedObjects,
    listMs,
    downloadMs,
    importMs,
    snapshotMs,
    uploadMs,
  };
}

/** Rust `run_configured_sync`：状态持久化 + 进程内互斥。 */
async function runConfiguredSync(
  ctx: DesktopContext,
  triggerSource: string,
): Promise<S3DeviceSyncResult> {
  const lease = acquireSyncLease("device-s3-sync");
  try {
    // 后台任务行（background_jobs）由 desktop-observability 领域统一落库；本批命令先不写。
    void triggerSource;
    const now = rfc3339Now();
    const previous = ctx.storage.withDatabase((db) => loadS3Status(db));
    ctx.storage.withDatabase((db) =>
      saveS3Status(db, {
        status: "running",
        lastAttemptAt: now,
        lastSuccessAt: previous.lastSuccessAt,
        message: "正在同步设备用量",
        remoteDevices: previous.remoteDevices,
        importedDevices: 0,
        importedDays: 0,
        failedObjects: 0,
        failureDetails: [],
      }),
    );
    try {
      const result = await syncDeviceUsage(ctx);
      const status = result.failedObjects === 0 ? "success" : "partial";
      ctx.storage.withDatabase((db) =>
        saveS3Status(db, {
          status,
          lastAttemptAt: now,
          lastSuccessAt: rfc3339Now(),
          message: `同步完成：发现 ${result.remoteDevices} 台远端设备，导入 ${result.importedDays} 天，失败 ${result.failedObjects} 个对象`,
          remoteDevices: result.remoteDevices,
          importedDevices: result.importedDevices,
          importedDays: result.importedDays,
          failedObjects: result.failedObjects,
          failureDetails: [],
        }),
      );
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.storage.withDatabase((db) =>
        saveS3Status(db, {
          status: "failed",
          lastAttemptAt: now,
          lastSuccessAt: previous.lastSuccessAt,
          message,
          remoteDevices: previous.remoteDevices,
          importedDevices: 0,
          importedDays: 0,
          failedObjects: 0,
          failureDetails: [],
        }),
      );
      throw error;
    }
  } finally {
    lease.release();
  }
}

// ─── 本地用量包（导入/导出） ────────────────────────────────────────────────

function readDeviceUsageBundle(filePath: string): DeviceUsageBundle {
  let metadata;
  try {
    metadata = statSync(filePath);
  } catch (error) {
    throw new Error(
      `读取导入文件失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (metadata.size > MAX_BUNDLE_BYTES) throw new Error("设备用量文件超过 4 MB 限制");
  let bytes: Buffer;
  try {
    bytes = readFileSync(filePath);
  } catch (error) {
    throw new Error(
      `读取导入文件失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseBundleBytes(bytes);
}

function snapshotImportProfile(snapshot: DeviceUsageSnapshot) {
  return {
    deviceId: snapshot.deviceId,
    deviceCreatedAt: snapshot.deviceCreatedAt,
    displayName: resolveDeviceDisplayName(
      snapshot.displayName,
      resolvedPlatform(snapshot),
      snapshot.deviceId,
    ),
    platform: resolvedPlatform(snapshot),
    appVersion: resolvedAppVersion(snapshot),
    generatedAt: snapshot.generatedAt,
    timezoneOffsetMinutes: snapshot.timezoneOffsetMinutes,
  };
}

// ─── 命令注册 ────────────────────────────────────────────────────────────────

export const handlers: DesktopHandlerMap = {
  // ─── 设备目录 / 用量 ──────────────────────────────────────────────────────

  device_usage_snapshot: async (ctx) => {
    try {
      await ensureLanForContext(ctx);
      return await buildDeviceSnapshot(ctx);
    } catch (error) {
      throw badRequest(error);
    }
  },

  list_shared_devices: (ctx) => {
    try {
      return ctx.storage.withDatabase((db) => importedKnownDevices(db)) as unknown as KnownDevice[];
    } catch (error) {
      throw badRequest(error);
    }
  },

  shared_device_daily_usage: (ctx, rawArgs) => {
    const args = argsObject(rawArgs);
    const deviceId = argOptionalString(args, "deviceId");
    try {
      return ctx.storage.withDatabase((db) =>
        importedDailyUsage(db, deviceId ?? undefined),
      ) as unknown as DailyUsageTotal[];
    } catch (error) {
      throw badRequest(error);
    }
  },

  shared_device_hourly_usage: (ctx, rawArgs) => {
    const args = argsObject(rawArgs);
    const deviceId = argOptionalString(args, "deviceId");
    try {
      return ctx.storage.withDatabase((db) =>
        importedHourlyUsage(db, deviceId ?? undefined),
      ) as unknown as HourlyUsageTotal[];
    } catch (error) {
      throw badRequest(error);
    }
  },

  list_shared_device_sessions: (ctx, rawArgs) => {
    const args = argsObject(rawArgs);
    const deviceId = argOptionalString(args, "deviceId");
    try {
      return ctx.storage.withDatabase((db) =>
        importedDeviceSessions(db, deviceId),
      ) as unknown as JsonRow[];
    } catch (error) {
      throw badRequest(error);
    }
  },

  refresh_shared_device: async (ctx, rawArgs) => {
    const args = argsObject(rawArgs);
    const deviceId = requireNonEmptyDeviceId(argString(args, "deviceId"));
    try {
      const lan = await refreshKnownPeers(ctx, deviceId);
      if (lan.refreshedDevices > 0) {
        return { source: "lan", refreshedDevices: lan.refreshedDevices };
      }
      const lease = acquireSyncLease("device-s3-pull");
      try {
        const result = await pullDeviceUsageForDevice(ctx, deviceId);
        return { source: "s3", refreshedDevices: result.importedDevices };
      } finally {
        lease.release();
      }
    } catch (error) {
      throw badRequest(error);
    }
  },

  rename_current_device: async (ctx, rawArgs) => {
    const args = argsObject(rawArgs);
    const displayName = argString(args, "displayName");
    try {
      updateDisplayName(ctx.desktop.dataDir, identityRecord(ctx), displayName);
      return null;
    } catch (error) {
      throw badRequest(error);
    }
  },

  // ─── S3 配置 / 测试 ───────────────────────────────────────────────────────

  get_s3_sync_settings: async (ctx) => {
    try {
      const stored = loadStoredS3Config(ctx.storage);
      const status = ctx.storage.withDatabase((db) => loadS3Status(db));
      if (stored === null) return { config: null, status };
      const secretConfigured = await hasSecret(
        ctx.desktop.host,
        s3CredentialUsername(stored),
      );
      return { config: { ...stored, secretConfigured }, status };
    } catch (error) {
      throw badRequest(error);
    }
  },

  export_s3_connection_config: async (ctx) => {
    try {
      const config = requireConfig(loadStoredS3Config(ctx.storage));
      return await exportS3ConnectionConfig(
        { storage: ctx.storage, host: ctx.desktop.host },
        config,
      );
    } catch (error) {
      throw badRequest(error);
    }
  },

  save_s3_sync_config: async (ctx, rawArgs) => {
    const args = argsObject(rawArgs);
    const input = parseS3ConfigArgument(args);
    try {
      const config = await saveStoredS3Config(
        { storage: ctx.storage, host: ctx.desktop.host },
        input,
      );
      const status = ctx.storage.withDatabase((db) => loadS3Status(db));
      const secretConfigured = await hasSecret(
        ctx.desktop.host,
        s3CredentialUsername(config),
      );
      return { config: { ...config, secretConfigured }, status };
    } catch (error) {
      throw badRequest(error);
    }
  },

  test_s3_sync_connection: async (ctx, rawArgs) => {
    const args = argsObject(rawArgs);
    const input = parseS3ConfigArgument(args);
    try {
      const config = parseS3ConfigInput(input);
      const provided = input.secretAccessKey?.trim() ?? "";
      const secret =
        provided !== ""
          ? provided
          : await readSecret(ctx.desktop.host, s3CredentialUsername(config));
      const store = new S3Store(config, secret);
      try {
        await store.headBucket();
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}；请确认已授予 Bucket 级 oss:HeadBucket 权限`,
        );
      }
      const testPrefix =
        config.prefix === "" ? "flowlet/v1/tests/" : `${config.prefix}/flowlet/v1/tests/`;
      await store.list(testPrefix);
      const testKey = `${testPrefix}${randomUUID()}.json`;
      await store.put(testKey, Buffer.from("{}", "utf8"), null);
      await store.get(testKey);
      await store.delete(testKey);
      return { message: "连接、列举、写入、读取和删除权限均正常" };
    } catch (error) {
      throw badRequest(error);
    }
  },

  test_s3_read_connection: async (ctx, rawArgs) => {
    const args = argsObject(rawArgs);
    const input = parseS3ConfigArgument(args);
    try {
      const config = parseS3ConfigInput(input);
      const provided = input.secretAccessKey?.trim() ?? "";
      const secret =
        provided !== ""
          ? provided
          : await readSecret(ctx.desktop.host, s3CredentialUsername(config));
      const store = new S3Store(config, secret);
      try {
        await store.headBucket();
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}；请确认已授予 Bucket 级读取权限`,
        );
      }
      const objects = await store.list(deviceObjectPrefix(config));
      const snapshotObject = objects.find((object) => object.key.endsWith("/snapshot.json"));
      if (snapshotObject !== undefined) {
        parseBundleBytes(await store.get(snapshotObject.key));
        return { message: "Bucket、列举和快照读取权限均正常" };
      }
      return { message: "Bucket 和列举权限正常；当前还没有设备快照可验证读取权限" };
    } catch (error) {
      throw badRequest(error);
    }
  },

  // ─── S3 同步 / 拉取 / 恢复 ────────────────────────────────────────────────

  sync_device_usage_s3: async (ctx) => {
    try {
      await ensureLanForContext(ctx);
      return await runConfiguredSync(ctx, "manual");
    } catch (error) {
      throw badRequest(error);
    }
  },

  recover_current_device_sync: async (ctx) => {
    try {
      const { config, store } = await loadStore(ctx);
      const identity = identityRecord(ctx);
      const currentKey = snapshotKey(config, identity.device_id);
      const remote = (await store.list(deviceObjectPrefix(config))).find(
        (object) => object.key === currentKey,
      );
      if (remote === undefined) {
        throw new Error("远端不存在当前设备快照，请直接执行同步");
      }
      const bundle = parseBundleBytes(await store.get(currentKey));
      if (
        bundle.snapshot.deviceId !== identity.device_id ||
        bundle.snapshot.deviceCreatedAt !== identity.created_at
      ) {
        throw new Error(
          "远端快照与本机身份文件不一致，拒绝恢复；请保留现有数据并检查设备 ID",
        );
      }
      ctx.storage.withDatabase((db) =>
        saveCurrentEtag(db, {
          endpoint: config.endpoint,
          bucket: config.bucket,
          key: currentKey,
          etag: remote.etag,
        }),
      );
      return { message: "已恢复当前设备的云端同步所有权" };
    } catch (error) {
      throw badRequest(error);
    }
  },

  refresh_shared_device_usage_s3: async (ctx) => {
    try {
      return await runConfiguredPull(ctx, true);
    } catch (error) {
      throw badRequest(error);
    }
  },

  // ─── 远端 OpenCode 权限 ───────────────────────────────────────────────────

  list_remote_opencode_permissions: async (ctx, rawArgs) => {
    const args = argsObject(rawArgs);
    const deviceId = argString(args, "deviceId");
    const sessionId = argString(args, "sessionId");
    try {
      const descriptor = loadPeerDescriptor(ctx, deviceId);
      if (descriptor === null) {
        throw new Error("目标设备没有可用的局域网连接信息");
      }
      return await fetchRemotePermissions<JsonRow>(descriptor, sessionId);
    } catch (error) {
      throw badRequest(error);
    }
  },

  reply_remote_opencode_permission: async (ctx, rawArgs) => {
    const args = argsObject(rawArgs);
    const deviceId = argString(args, "deviceId");
    const permissionId = argString(args, "permissionId");
    const rawDecision = args.decision;
    if (rawDecision !== "allow_once" && rawDecision !== "reject") {
      throw CommandError.badRequest(
        `参数 decision: unknown variant \`${String(rawDecision)}\`, expected \`allow_once\` or \`reject\``,
      );
    }
    try {
      const descriptor = loadPeerDescriptor(ctx, deviceId);
      if (descriptor === null) {
        throw new Error("目标设备没有可用的局域网连接信息");
      }
      await replyRemotePermission(descriptor, permissionId, rawDecision);
      return null;
    } catch (error) {
      throw badRequest(error);
    }
  },

  // ─── 局域网刷新 / 状态 / 探测 ─────────────────────────────────────────────

  refresh_shared_device_usage_lan: async (ctx, rawArgs) => {
    const args = argsObject(rawArgs);
    const deviceId = argOptionalString(args, "deviceId");
    try {
      return await refreshKnownPeers(ctx, deviceId);
    } catch (error) {
      throw badRequest(error);
    }
  },

  lan_server_status: async (ctx) => {
    await ensureLanForContext(ctx);
    return readLanServerReport();
  },

  probe_lan_peers: async (ctx, rawArgs) => {
    const args = argsObject(rawArgs);
    const deviceId = argOptionalString(args, "deviceId");
    try {
      const registry = ctx.storage.withDatabase((db) => lanStore.loadPeerRegistry(db));
      const probes: LanPeerProbe[] = [];
      const pending: Array<Promise<LanPeerProbe>> = [];
      for (const [id, descriptor] of Object.entries(registry)) {
        if (deviceId !== null && deviceId !== id) continue;
        if (!descriptorIsFresh(descriptor)) {
          probes.push({
            deviceId: id,
            lanPublished: false,
            reachable: false,
            latencyMs: null,
            protocolVersion: null,
            errorKind: null,
            error: null,
          });
          continue;
        }
        pending.push(probeLanPeer(descriptor, id));
      }
      probes.push(...(await Promise.all(pending)));
      probes.sort((left, right) =>
        left.deviceId < right.deviceId ? -1 : left.deviceId > right.deviceId ? 1 : 0,
      );
      return probes;
    } catch (error) {
      throw badRequest(error);
    }
  },

  // ─── 本地用量文件导出 / 预览 / 导入 ───────────────────────────────────────

  export_device_usage_bundle: async (ctx, rawArgs) => {
    const args = argsObject(rawArgs);
    const target = argString(args, "path");
    try {
      const snapshot = await buildDeviceSnapshot(ctx);
      const bytes = Buffer.from(
        JSON.stringify(newDeviceUsageBundle(snapshot), null, 2),
        "utf8",
      );
      const resolvedTarget = path.resolve(target);
      const parent = path.dirname(resolvedTarget);
      mkdirSync(parent, { recursive: true });
      const temporary = path.join(parent, `.flowlet-usage-${randomUUID().replace(/-/g, "")}.tmp`);
      writeFileSync(temporary, bytes);
      const backup = path.join(parent, `.flowlet-usage-${randomUUID().replace(/-/g, "")}.backup`);
      const targetExists = existsSync(resolvedTarget);
      if (targetExists) {
        renameSync(resolvedTarget, backup);
      }
      try {
        renameSync(temporary, resolvedTarget);
      } catch (error) {
        try {
          rmSync(temporary, { force: true });
          if (targetExists) renameSync(backup, resolvedTarget);
        } catch {
          /* 恢复失败时保留备份 */
        }
        throw new Error(
          `保存设备用量文件失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (targetExists) {
        try {
          rmSync(backup, { force: true });
        } catch {
          /* 备份清理失败不影响导出结果 */
        }
      }
      return null;
    } catch (error) {
      throw badRequest(error);
    }
  },

  preview_device_usage_import: (ctx, rawArgs) => {
    const args = argsObject(rawArgs);
    const filePath = argString(args, "path");
    try {
      const bundle = readDeviceUsageBundle(filePath);
      const preview: DeviceUsageImportPreview = ctx.storage.withDatabase((db) =>
        previewDeviceUsageImport(
          db,
          currentDeviceId(ctx),
          snapshotImportProfile(bundle.snapshot),
          bundle.snapshot.days,
        ),
      );
      return preview;
    } catch (error) {
      throw badRequest(error);
    }
  },

  import_device_usage_bundle: (ctx, rawArgs) => {
    const args = argsObject(rawArgs);
    const filePath = argString(args, "path");
    try {
      const bundle = readDeviceUsageBundle(filePath);
      const snapshot = bundle.snapshot;
      if (snapshot.deviceId === currentDeviceId(ctx)) {
        throw new Error("不能把当前设备的用量重新导入为远程设备");
      }
      const profile = snapshotImportProfile(snapshot);
      ctx.storage.withDatabase((db) => {
        importDeviceUsage(
          db,
          snapshot.schemaVersion,
          profile,
          snapshot.days,
          snapshot.hours,
          snapshot.sessions,
          snapshot.agents,
        );
        importDeviceUsageBreakdowns(
          db,
          snapshot.deviceId,
          snapshot.generatedAt,
          snapshot.usageBreakdowns,
        );
        importDeviceAccountResources(
          db,
          snapshot.deviceId,
          snapshot.generatedAt,
          snapshot.accountResources,
        );
      });
      // Rust 命令固定返回 0/0（导入明细由 preview 提供），保持一致。
      return { deviceId: snapshot.deviceId, importedDays: 0, unchangedDays: 0 };
    } catch (error) {
      throw badRequest(error);
    }
  },
};

/** 保留给其它桌面领域复用的导入/导出辅助（不注册为命令）。 */
export const deviceSyncInternals = {
  buildDeviceSnapshot,
  importBundleSnapshot,
  snapshotImportProfile,
};