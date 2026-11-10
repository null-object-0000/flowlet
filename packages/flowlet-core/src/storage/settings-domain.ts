// 设置 / 存储维护领域的 SQL 纯函数（桌面命令批次 2）。Owner: desktop-maintenance。
//
// 逐条对照 Rust `src-tauri/src/core/storage.rs::db_stats`、
// `core/storage_maintenance.rs`（DatabaseMaintenanceStats / compact_database）与
// `core/storage_stats.rs`（StorageUsageSummary）。SQL 与返回字段保持一致：
// `db_stats` 返回元组数组，其余两个结构体是 `#[serde(rename_all = "camelCase")]`。
//
// 这些函数只接收 `DatabaseSync`，由命令层通过 `ctx.storage.withDatabase(...)` 调用，
// 不往 `storage/index.ts` 添加方法（多领域并行开发，由 Lead 统一收口）。
import type { DatabaseSync } from "node:sqlite";

import type { JsonRow } from "../types.ts";

/** Rust `db_stats`：返回 (日志数, 用量行数, 数据库字节)，JSON 为三元组数组。 */
export function dbStats(db: DatabaseSync): [number, number, number] {
  const logs = db.prepare("SELECT COUNT(*) AS count FROM request_logs").get() as
    | { count: number }
    | undefined;
  const usage = db.prepare("SELECT COUNT(*) AS count FROM usage_records").get() as
    | { count: number }
    | undefined;
  const fileSize = db
    .prepare("SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()")
    .get() as { bytes: number } | undefined;
  return [Number(logs?.count ?? 0), Number(usage?.count ?? 0), Number(fileSize?.bytes ?? 0)];
}

/** Rust `DatabaseMaintenanceStats`（camelCase）。 */
export interface DatabaseMaintenanceStats {
  databaseBytes: number;
  pageSize: number;
  pageCount: number;
  freelistCount: number;
  reclaimableBytes: number;
  autoVacuumMode: number;
}

/** Rust `DatabaseCompactionResult`（camelCase）。 */
export interface DatabaseCompactionResult {
  before: DatabaseMaintenanceStats;
  after: DatabaseMaintenanceStats;
  reclaimedBytes: number;
}

function readMaintenanceStats(db: DatabaseSync): DatabaseMaintenanceStats {
  const pageSize = Number(
    (db.prepare("PRAGMA page_size").get() as { page_size: number } | undefined)?.page_size ?? 0,
  );
  const pageCount = Number(
    (db.prepare("PRAGMA page_count").get() as { page_count: number } | undefined)?.page_count ?? 0,
  );
  const freelistCount = Number(
    (db.prepare("PRAGMA freelist_count").get() as { freelist_count: number } | undefined)
      ?.freelist_count ?? 0,
  );
  const autoVacuumMode = Number(
    (db.prepare("PRAGMA auto_vacuum").get() as { auto_vacuum: number } | undefined)?.auto_vacuum ??
      0,
  );
  return {
    databaseBytes: pageCount * pageSize,
    pageSize,
    pageCount,
    freelistCount,
    reclaimableBytes: freelistCount * pageSize,
    autoVacuumMode,
  };
}

/**
 * Rust `Storage::compact_database`：完整 VACUUM 并切到增量 auto-vacuum。
 * SQLite 的 VACUUM 自身具备失败原子性；调用方必须先暂停代理。
 */
export function compactDatabase(db: DatabaseSync): DatabaseCompactionResult {
  const before = readMaintenanceStats(db);
  db.exec(
    "PRAGMA wal_checkpoint(TRUNCATE);" +
      "PRAGMA auto_vacuum = INCREMENTAL;" +
      "VACUUM;" +
      "PRAGMA wal_checkpoint(TRUNCATE);",
  );
  const after = readMaintenanceStats(db);
  return {
    before,
    after,
    reclaimedBytes: Math.max(0, before.databaseBytes - after.databaseBytes),
  };
}

/** Rust `StorageUsageCategory`（camelCase）。 */
export interface StorageUsageCategory {
  key: string;
  rowCount: number;
  allocatedBytes: number;
}

/** Rust `StorageUsageSummary`（camelCase）。 */
export interface StorageUsageSummary {
  totalBytes: number;
  databaseBytes: number;
  reclaimableBytes: number;
  autoVacuumMode: number;
  walBytes: number;
  sharedMemoryBytes: number;
  configBytes: number;
  captureBytes: number;
  categorizedBytes: number;
  categories: StorageUsageCategory[];
}

/** 命令层采集的 SQLite 主文件 / sidecar / config.json / 捕获帧文件占用。 */
export interface StorageUsageFileMetrics {
  mainFileBytes: number;
  walBytes: number;
  sharedMemoryBytes: number;
  configBytes: number;
  captureFiles: number;
  captureBytes: number;
}

type TablePageStats = Map<string, { cells: number; bytes: number }>;

function readTablePageStats(db: DatabaseSync): TablePageStats {
  const stats: TablePageStats = new Map();
  const rows = db
    .prepare(
      `SELECT schema.tbl_name AS table_name, stat.name AS object_name,
              stat.pagetype AS page_type, stat.ncell AS cells, stat.pgsize AS page_bytes
       FROM dbstat AS stat
       JOIN sqlite_schema AS schema ON schema.name = stat.name
       WHERE schema.type IN ('table', 'index')`,
    )
    .all() as Array<Record<string, unknown>>;
  for (const row of rows) {
    const table = String(row.table_name);
    const current = stats.get(table) ?? { cells: 0, bytes: 0 };
    current.bytes += Number(row.page_bytes ?? 0);
    if (row.object_name === row.table_name && row.page_type === "leaf") {
      current.cells += Number(row.cells ?? 0);
    }
    stats.set(table, current);
  }
  return stats;
}

function summarizeCategory(
  tableStats: TablePageStats,
  key: string,
  tables: string[],
): StorageUsageCategory {
  let rowCount = 0;
  let allocatedBytes = 0;
  for (const table of tables) {
    const current = tableStats.get(table);
    if (current === undefined) continue;
    rowCount += current.cells;
    allocatedBytes += current.bytes;
  }
  return { key, rowCount, allocatedBytes };
}

function pragmaInt(db: DatabaseSync, statement: string, column: string): number {
  const row = db.prepare(statement).get() as Record<string, unknown> | undefined;
  return Number(row?.[column] ?? 0);
}

/**
 * Rust `Storage::storage_usage_summary`（文件数据库路径）。
 *
 * 分类表清单与 Rust 一致；`configuration` 分类额外计入 config.json 文件大小。
 */
export function storageUsageSummary(
  db: DatabaseSync,
  metrics: StorageUsageFileMetrics,
): StorageUsageSummary {
  const allocatedDatabaseBytes = pragmaInt(
    db,
    "SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()",
    "bytes",
  );
  const databaseBytes = Math.max(metrics.mainFileBytes, allocatedDatabaseBytes);
  const tableStats = readTablePageStats(db);

  const categories: StorageUsageCategory[] = [
    summarizeCategory(tableStats, "configuration", [
      "channel_presets",
      "channel_accounts",
      "channel_models",
      "virtual_models",
      "virtual_model_routes",
      "route_rules",
      "app_meta",
    ]),
    summarizeCategory(tableStats, "requestLogs", ["request_logs", "request_capture_refs"]),
    summarizeCategory(tableStats, "usage", [
      "usage_records",
      "account_balance_snapshots",
      "known_devices",
      "device_daily_usage",
    ]),
    summarizeCategory(tableStats, "agentSessions", [
      "agent_session_snapshots",
      "agent_source_sync_state",
      "device_agent_sessions",
    ]),
    summarizeCategory(tableStats, "backgroundTasks", [
      "background_jobs",
      "background_job_events",
    ]),
  ];
  categories[0].allocatedBytes += metrics.configBytes;
  categories.push({
    key: "requestCaptures",
    rowCount: metrics.captureFiles,
    allocatedBytes: metrics.captureBytes,
  });

  // Body 数据单独统计：直接查询内联列与捕获引用的实际字节数。
  const body = db
    .prepare(
      `SELECT
         COALESCE((SELECT SUM(length(COALESCE(req_body_b64, '')) + length(COALESCE(res_body_b64, ''))) FROM request_logs), 0)
           + COALESCE((SELECT SUM(req_body_bytes + res_body_bytes) FROM request_capture_refs WHERE state = 'ready'), 0) AS body_bytes,
         (SELECT COUNT(*) FROM request_logs WHERE req_body_b64 IS NOT NULL OR res_body_b64 IS NOT NULL)
           + (SELECT COUNT(*) FROM request_capture_refs WHERE state = 'ready' AND (req_body_bytes > 0 OR res_body_bytes > 0)) AS body_rows`,
    )
    .get() as { body_bytes: number; body_rows: number } | undefined;
  const bodyBytes = Number(body?.body_bytes ?? 0);
  if (bodyBytes > 0) {
    categories.push({
      key: "bodyData",
      rowCount: Number(body?.body_rows ?? 0),
      allocatedBytes: bodyBytes,
    });
  }

  const categorizedBytes = categories.reduce((total, item) => total + item.allocatedBytes, 0);
  return {
    totalBytes:
      databaseBytes +
      metrics.walBytes +
      metrics.sharedMemoryBytes +
      metrics.configBytes +
      metrics.captureBytes,
    databaseBytes,
    reclaimableBytes: pragmaInt(
      db,
      "SELECT freelist_count * page_size AS bytes FROM pragma_freelist_count(), pragma_page_size()",
      "bytes",
    ),
    autoVacuumMode: pragmaInt(db, "PRAGMA auto_vacuum", "auto_vacuum"),
    walBytes: metrics.walBytes,
    sharedMemoryBytes: metrics.sharedMemoryBytes,
    configBytes: metrics.configBytes,
    captureBytes: metrics.captureBytes,
    categorizedBytes,
    categories,
  };
}

/** 供测试与诊断使用的原始分类（未加 config/capture）。 */
export function storageUsageTableStats(db: DatabaseSync): JsonRow {
  const result: JsonRow = {};
  for (const [table, stat] of readTablePageStats(db)) {
    result[table] = { row_count: stat.cells, allocated_bytes: stat.bytes };
  }
  return result;
}