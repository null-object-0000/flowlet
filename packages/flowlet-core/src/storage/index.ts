// SQLite storage layer. Owner: node-storage.
//
// Contract: docs/migration/node-host.md §5. All SQL stays byte-compatible with
// src-tauri/src/core/storage*.rs (same tables, columns, indexes, PRAGMAs, and
// JSON-encoded TEXT columns). The user's existing database must open as-is.
//
// 实现分模块：schema.ts（建表/迁移）、config.ts（渠道/账号/路由/模型/余额/app_meta）、
// logs.ts（请求日志）、usage.ts（用量聚合/费用）、devices.ts（设备）、sessions.ts（会话）。
// 本文件只做连接生命周期 + 方法门面，签名与 Rust `Storage` 对齐。
import { existsSync, rmSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { JsonRow } from "../types.ts";
import { migrate } from "./schema.ts";
import { RequestCaptureStore } from "./capture-store.ts";
import {
  cleanupExpiredBodyData,
  cleanupOldLogs,
  getTotalBodySizeBytes,
  pruneBalanceSnapshots,
  pruneOldestBodyData,
  pruneOldestBodyDataToGoal,
} from "./maintenance.ts";
import { buildPriceTable } from "./prices.ts";
import {
  deleteServiceCredential,
  getServiceCredential,
  listServiceCredentials,
  updateServiceCredentialVerification,
  upsertServiceCredential,
} from "./credentials.ts";
import {
  deleteCliAuthToken,
  deleteExpiredCliAuthTokens,
  findCliAuthTokenByHash,
  insertCliAuthToken,
  listCliAuthTokens,
  touchCliAuthToken,
} from "./cli-auth.ts";
import {
  cleanupOrphanBalanceSnapshots,
  ensureMissingPresets,
  ensurePresetBalanceQuery,
  ensurePresetFilesApi,
  ensurePresetPlatformUrls,
  ensurePresetScrapeBalance,
  getAppMeta,
  latestBalanceSnapshots,
  listBalanceSnapshots,
  listChannelAccounts,
  listChannelModels,
  listChannelPresets,
  listRouteCandidates,
  listRouteRules,
  listVirtualModels,
  saveBalanceSnapshot,
  saveChannelAccounts,
  saveChannelModels,
  saveChannelPresets,
  saveRouteCandidates,
  saveRouteRules,
  saveVirtualModels,
  setAppMeta,
  syncPresetMaintainedConfig,
  updateAccountCredentialStatus,
  updateAccountLastError,
  updateAccountLastUsed,
} from "./config.ts";
import {
  insertRequestLog,
  listRequestLogChannelAccounts,
  listRequestLogClients,
  listRequestLogModels,
  listRequestLogsByRequestId,
  listRequestLogsPage,
  updateRequestLogTiming,
} from "./logs.ts";
import {
  accountRoutingScores,
  accountStats,
  insertUsageRecord,
  usagePeriodBounds,
  usageSummaryRange,
  usageTodaySummary,
  type ModelPrice,
} from "./usage.ts";
import {
  repairCapturedUsage,
  repairUnknownUsage,
  repairUsageCosts,
} from "./repair.ts";
import { repairAgentSessions, type AgentSessionRepairResult } from "./repair-sessions.ts";
import type { UaClientRule } from "../proxy/identity.ts";
import {
  deviceDailyUsage,
  deviceHourlyUsage,
  knownDevices,
  type DeviceIdentityLike,
} from "./devices.ts";
import {
  agentSessionFlowletUsage,
  listObservedAgentSessionChildren,
  listObservedAgentSessionsPage,
  upsertAgentSessionMetadata,
} from "./sessions.ts";

const ACCOUNT_CREDENTIAL_HEALTHY = "healthy";
const ACCOUNT_CREDENTIAL_INVALID_KEY = "invalid_key";
const UPSTREAM_PROXY_META_KEY = "upstream_proxy_config";

/** 模块级 upsert（代理侧若只有 DatabaseSync、没有 SqliteStorage 门面时可直接用）。 */
export { upsertAgentSessionMetadata } from "./sessions.ts";

export class SqliteStorage {
  #db: DatabaseSync;
  #dbPath: string;
  #prices: ModelPrice[] = [];
  #captureStore: RequestCaptureStore;
  /** `:memory:` 的临时捕获目录（close 时清理，Rust 测试同样用临时目录）。 */
  #temporaryCaptureRoot: boolean;

  constructor(dbPath: string) {
    this.#dbPath = dbPath;
    const isNewDatabase = !existsSync(dbPath) || statSync(dbPath).size === 0;
    this.#db = new DatabaseSync(dbPath);
    if (isNewDatabase) {
      // auto_vacuum 必须在建表前启用（Rust open 同）。
      this.#db.exec("PRAGMA auto_vacuum = INCREMENTAL;");
    }
    this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    migrate(this.#db);
    // Rust RequestCaptureStore::for_database：<db 目录>/request-captures。
    this.#captureStore = RequestCaptureStore.forDatabase(dbPath);
    this.#temporaryCaptureRoot = dbPath === ":memory:";
  }

  /** 当前捕获帧存储（测试/诊断用）。 */
  captureStore(): RequestCaptureStore {
    return this.#captureStore;
  }

  /** 底层连接（仅供同包内需要执行自定义 SQL 的高级场景，web/proxy 不应依赖）。 */
  database(): DatabaseSync {
    return this.#db;
  }

  dbPath(): string {
    return this.#dbPath;
  }

  close(): void {
    this.#db.close();
    if (this.#temporaryCaptureRoot) {
      try {
        rmSync(this.#captureStore.rootPath(), { recursive: true, force: true });
      } catch {
        /* 测试临时目录清理失败不影响关闭 */
      }
    }
  }

  // ─── 价格表（Rust Storage::set_prices；来自 config.json / 模型目录） ─────────

  setPrices(prices: ModelPrice[]): void {
    this.#prices = prices;
  }

  /**
   * Rust `storage_tasks::rebuild_price_table`：models-cn + models.dev + config.json
   * `model_prices` 合并成完整价格表并写入内存（供成本估算）。
   * 返回价格条数（调用方可用于日志）。
   */
  rebuildPriceTable(catalogDir: string, configJson: JsonRow): number {
    const result = buildPriceTable(catalogDir, configJson);
    this.#prices = result.prices;
    return result.count;
  }

  prices(): ModelPrice[] {
    return this.#prices;
  }

  // ─── app_meta ---------------------------------------------------------------

  getAppMeta(key: string): string | null {
    return getAppMeta(this.#db, key);
  }

  setAppMeta(key: string, value: string): void {
    setAppMeta(this.#db, key, value);
  }

  // ─── service credentials（Rust storage_credentials.rs） ---------------------

  /** Rust `list_service_credentials`：ORDER BY created_at ASC, name ASC。 */
  listServiceCredentials(): JsonRow[] {
    return listServiceCredentials(this.#db);
  }

  /** Rust `get_service_credential`。 */
  getServiceCredential(id: string): JsonRow | null {
    return getServiceCredential(this.#db, id);
  }

  /** Rust `upsert_service_credential`（ON CONFLICT(id) DO UPDATE，不覆盖 created_at）。 */
  upsertServiceCredential(row: JsonRow): void {
    upsertServiceCredential(this.#db, row);
  }

  /** Rust `update_service_credential_verification`。 */
  updateServiceCredentialVerification(
    id: string,
    verifiedAt: string | null,
    lastError: string | null,
  ): void {
    updateServiceCredentialVerification(this.#db, id, verifiedAt, lastError);
  }

  /** Rust `delete_service_credential`：返回是否删除成功。 */
  deleteServiceCredential(id: string): boolean {
    return deleteServiceCredential(this.#db, id);
  }

  // ─── CLI 浏览器授权 token（cli_auth_tokens，Node Host 专有） ----------------

  /** 新增一行；token 明文由调用方哈希后传入。 */
  insertCliAuthToken(row: {
    id?: string;
    name: string;
    tokenHash: string;
    scope: string;
    expiresAt: string;
  }): JsonRow {
    return insertCliAuthToken(this.#db, row);
  }

  listCliAuthTokens(): JsonRow[] {
    return listCliAuthTokens(this.#db);
  }

  findCliAuthTokenByHash(tokenHash: string): JsonRow | null {
    return findCliAuthTokenByHash(this.#db, tokenHash);
  }

  touchCliAuthToken(id: string): void {
    touchCliAuthToken(this.#db, id);
  }

  deleteCliAuthToken(id: string): boolean {
    return deleteCliAuthToken(this.#db, id);
  }

  /** 清理过期行，返回删除行数。 */
  deleteExpiredCliAuthTokens(): number {
    return deleteExpiredCliAuthTokens(this.#db);
  }

  // ─── channels / accounts / routes / models ----------------------------------

  listChannelPresets(): JsonRow[] {
    return listChannelPresets(this.#db);
  }

  saveChannelPresets(presets: JsonRow[]): void {
    saveChannelPresets(this.#db, presets);
  }

  ensurePresetPlatformUrls(presets: JsonRow[]): void {
    ensurePresetPlatformUrls(this.#db, presets);
  }

  ensureMissingPresets(presets: JsonRow[]): void {
    ensureMissingPresets(this.#db, presets);
  }

  syncPresetMaintainedConfig(presets: JsonRow[]): void {
    syncPresetMaintainedConfig(this.#db, presets);
  }

  ensurePresetBalanceQuery(presets: JsonRow[]): void {
    ensurePresetBalanceQuery(this.#db, presets);
  }

  ensurePresetScrapeBalance(presets: JsonRow[]): void {
    ensurePresetScrapeBalance(this.#db, presets);
  }

  ensurePresetFilesApi(presets: JsonRow[]): void {
    ensurePresetFilesApi(this.#db, presets);
  }

  /** 返回规范化后的账号列表（Rust save_channel_accounts 之后由 web 回读）。 */
  saveChannelAccounts(accounts: JsonRow[]): JsonRow[] {
    saveChannelAccounts(this.#db, accounts);
    return this.listChannelAccounts();
  }

  listChannelAccounts(): JsonRow[] {
    return listChannelAccounts(this.#db);
  }

  saveRouteCandidates(routes: JsonRow[]): void {
    saveRouteCandidates(this.#db, routes);
  }

  listRouteCandidates(): JsonRow[] {
    return listRouteCandidates(this.#db);
  }

  saveVirtualModels(models: JsonRow[]): void {
    saveVirtualModels(this.#db, models);
  }

  listVirtualModels(): JsonRow[] {
    return listVirtualModels(this.#db);
  }

  saveChannelModels(models: JsonRow[]): void {
    saveChannelModels(this.#db, models);
  }

  listChannelModels(): JsonRow[] {
    return listChannelModels(this.#db);
  }

  listRouteRules(): JsonRow[] {
    return listRouteRules(this.#db);
  }

  saveRouteRules(rules: JsonRow[]): void {
    saveRouteRules(this.#db, rules);
  }

  updateAccountLastUsed(accountId: string): void {
    updateAccountLastUsed(this.#db, accountId);
  }

  updateAccountLastError(accountId: string, error: string): void {
    updateAccountLastError(this.#db, accountId, error);
  }

  updateAccountCredentialStatus(accountId: string, status: string): boolean {
    return updateAccountCredentialStatus(this.#db, accountId, status);
  }

  markAccountCredentialHealthy(accountId: string): void {
    updateAccountCredentialStatus(this.#db, accountId, ACCOUNT_CREDENTIAL_HEALTHY);
  }

  markAccountCredentialInvalid(accountId: string): void {
    updateAccountCredentialStatus(this.#db, accountId, ACCOUNT_CREDENTIAL_INVALID_KEY);
  }

  // ─── balances ---------------------------------------------------------------

  latestBalanceSnapshots(): JsonRow[] {
    return latestBalanceSnapshots(this.#db);
  }

  listBalanceSnapshots(accountId: string): JsonRow[] {
    return listBalanceSnapshots(this.#db, accountId);
  }

  saveBalanceSnapshot(snapshot: JsonRow): void {
    saveBalanceSnapshot(this.#db, snapshot);
  }

  cleanupOrphanBalanceSnapshots(): number {
    return cleanupOrphanBalanceSnapshots(this.#db);
  }

  // ─── request logs / usage ---------------------------------------------------

  listRequestLogsPage(filter: JsonRow): JsonRow {
    return listRequestLogsPage(this.#db, filter);
  }

  listRequestLogsByRequestId(requestId: string): JsonRow[] {
    return listRequestLogsByRequestId(this.#db, this.#captureStore, requestId);
  }

  listRequestLogClients(): JsonRow[] {
    return listRequestLogClients(this.#db);
  }

  listRequestLogModels(): JsonRow {
    return listRequestLogModels(this.#db);
  }

  /** Rust `list_request_log_channel_accounts`：渠道 + 渠道账号筛选项（camelCase）。 */
  listRequestLogChannelAccounts(): JsonRow {
    return listRequestLogChannelAccounts(this.#db);
  }

  /** Rust cleanup_old_logs：返回 [日志行数, 用量行数]。 */
  cleanupOldLogs(keepDays: number): [number, number] {
    return cleanupOldLogs(this.#db, this.#captureStore, keepDays);
  }

  /**
   * 请求/响应 Body 保留策略（Rust cleanup_expired_body_data）。
   * 仅清理已有完整 Token 统计的记录；返回清理行数。
   */
  cleanupExpiredBodyData(retentionDays: number): number {
    return cleanupExpiredBodyData(this.#db, this.#captureStore, retentionDays);
  }

  /** 按体积上限清理最老的一批 Body（帧 + 内联列），返回清理行数。 */
  pruneOldestBodyData(targetBytes: number, pruneRatio: number): number {
    return pruneOldestBodyData(this.#db, this.#captureStore, targetBytes, pruneRatio);
  }

  /** 捕获帧磁盘占用（段数与字节数，Rust `disk_usage`）。 */
  captureDiskUsage(): { segments: number; bytes: number } {
    return this.#captureStore.diskUsage();
  }

  /** 当前 Body 数据总占用字节数（Rust get_total_body_size_bytes）。 */
  getTotalBodySizeBytes(): number {
    return getTotalBodySizeBytes(this.#db);
  }

  /** 按体积上限清理最老 Body（Rust prune_oldest_body_data_to_goal）。 */
  pruneOldestBodyDataToGoal(targetBytes: number, pruneRatio: number, maxRounds = 50): number {
    return pruneOldestBodyDataToGoal(
      this.#db,
      this.#captureStore,
      targetBytes,
      pruneRatio,
      maxRounds,
    );
  }

  /** 余额/资源快照保留（Rust prune_balance_snapshots），返回 [expired, overLimit]。 */
  pruneBalanceSnapshots(retentionDays: number, maxPerAccount: number): [number, number] {
    return pruneBalanceSnapshots(this.#db, retentionDays, maxPerAccount);
  }

  /** id/created_at 由 storage 生成，其余字段由 proxy 传入（snake_case）。 */
  insertRequestLog(row: JsonRow): string {
    return insertRequestLog(this.#db, this.#captureStore, row);
  }

  /** 语义 = Rust update_request_log_timing（最近一条 last_attempt + stream）。 */
  updateRequestLogTiming(requestId: string, patch: JsonRow): void {
    updateRequestLogTiming(this.#db, this.#captureStore, requestId, patch);
  }

  insertUsageRecord(row: JsonRow): void {
    insertUsageRecord(this.#db, this.#prices, row);
  }

  // ─── devices ----------------------------------------------------------------

  /**
   * Rust device_usage::known_devices：传 identity 时当前设备首位 isCurrent:true；
   * 不传只返回已同步设备（web 可自行补当前设备）。
   */
  listKnownDevices(identity?: DeviceIdentityLike): JsonRow[] {
    return knownDevices(this.#db, identity);
  }

  deviceDailyUsage(currentDeviceId: string, deviceId?: string | null): JsonRow[] {
    return deviceDailyUsage(this.#db, currentDeviceId, deviceId);
  }

  deviceHourlyUsage(currentDeviceId: string, deviceId?: string | null): JsonRow[] {
    return deviceHourlyUsage(this.#db, currentDeviceId, deviceId);
  }

  // ─── observed agent sessions ------------------------------------------------

  /**
   * 会话派生元数据 upsert（docs/agent-session-metadata.md §2）。
   *
   * 设计成**同步**方法：代理在请求主链路上调用，行对象只含 4 个键，单条 INSERT…ON CONFLICT
   * 是微秒级操作，没必要为它引入异步边界。写失败（锁表/磁盘）让异常抛给 proxy 侧统一的
   * try/catch 兜底——派生元数据只是展示增强，不能影响转发主链路。
   * 行键（snake_case，与数据库列一致）：agent_type / session_id / title / project_path / source(可选)。
   */
  upsertAgentSessionMetadata(row: JsonRow): void {
    upsertAgentSessionMetadata(this.#db, row);
  }

  listObservedAgentSessionsPage(filter: JsonRow): JsonRow {
    return listObservedAgentSessionsPage(this.#db, filter);
  }

  listObservedAgentSessionChildren(agentType: string, parentSessionId: string): JsonRow[] {
    return listObservedAgentSessionChildren(this.#db, agentType, parentSessionId);
  }

  agentSessionFlowletUsage(agentType: string, sessionId: string): JsonRow | null {
    return agentSessionFlowletUsage(this.#db, agentType, sessionId);
  }

  // ─── analytics --------------------------------------------------------------

  accountRoutingScores(): Array<[string, string, number, number, number]> {
    return accountRoutingScores(this.#db);
  }

  accountStats(): JsonRow[] {
    return accountStats(this.#db);
  }

  usageSummaryRange(
    startAt: string | null,
    endAt: string | null,
    groupBy: string,
    currentDeviceId: string,
  ): JsonRow[] {
    return usageSummaryRange(this.#db, this.#prices, startAt, endAt, groupBy, currentDeviceId);
  }

  usagePeriodBounds(period: string): JsonRow {
    return usagePeriodBounds(period);
  }

  usageTodaySummary(): JsonRow {
    return usageTodaySummary(this.#db);
  }

  // ─── 数据完整性检查（Rust repair_* commands） --------------------------------

  /** Rust `repair_agent_sessions`：按已存 Header 与最新 UA 规则修复会话/客户端归属。 */
  repairAgentSessions(timeRange: string, uaRules: UaClientRule[]): AgentSessionRepairResult {
    return repairAgentSessions(this.#db, timeRange, uaRules);
  }

  /**
   * Rust `repair_captured_usage` 的 Node 等价实现：从响应捕获帧重解析 usage 并回填。
   * Node Host 没有 Agent 原生 transcript 适配器，因此不含 `repair_usage_from_native_sessions`
   * 回退；只含 message_start 前缀的截断捕获会留给 unknown 占位行。
   */
  repairCapturedUsage(timeRange: string): number {
    return repairCapturedUsage(this.#db, this.#prices, this.#captureStore, timeRange);
  }

  /** Rust `analyze_unknown_usage`：为仍无 usage 的请求建立 unknown 占位行。 */
  repairUnknownUsage(timeRange: string): number {
    return repairUnknownUsage(this.#db, timeRange);
  }

  /** Rust `recalculate_usage_costs`：按当前价格表重算 estimated_* 五列。 */
  repairUsageCosts(timeRange: string): number {
    return repairUsageCosts(this.#db, this.#prices, timeRange);
  }

  /** `get_upstream_proxy_config` / `set_upstream_proxy_config` 使用的 app_meta 键。 */
  static readonly UPSTREAM_PROXY_META_KEY = UPSTREAM_PROXY_META_KEY;

  /**
   * 领域模块（`storage/*.ts` 的纯函数）访问底层连接的唯一入口。
   *
   * 桌面命令层的新查询不要继续往本类堆方法（多领域并行开发会互相冲突），
   * 而是在自己的领域模块里导出 `(db: DatabaseSync, ...) => ...` 的纯函数，
   * 通过这里执行。连接仍是单连接串行语义，与 Rust 版一致。
   */
  withDatabase<T>(fn: (db: DatabaseSync) => T): T {
    return fn(this.#db);
  }
}