use super::config::{AuthStrategy, ConfigBundle, ModelPrice};
use rusqlite::Connection;
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use thiserror::Error;

/// 体积上限是软限制：最近一小时的 Body 始终保留，避免用户刚完成请求就看不到详情。
const BODY_SIZE_PRUNE_MIN_AGE_HOURS: i64 = 1;

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("数据库错误: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("文件系统错误: {0}")]
    Io(#[from] std::io::Error),
    #[error("导入数据库校验失败: {0}")]
    InvalidImport(String),
    #[error("数据库状态锁定失败")]
    LockFailed,
}

#[path = "storage_config.rs"]
mod storage_config;
#[path = "storage_stats.rs"]
mod storage_stats;
#[path = "storage_tasks.rs"]
mod storage_tasks;
#[path = "storage_maintenance.rs"]
mod storage_maintenance;
#[path = "storage_usage.rs"]
mod storage_usage;
pub use storage_stats::{StorageUsageCategory, StorageUsageSummary};
pub use storage_maintenance::{DatabaseCompactionResult, DatabaseMaintenanceStats};
pub use storage_tasks::{
    AgentDataSyncResult, AgentSyncStatusReport, BackgroundJobDetail, BackgroundJobRow,
    BackgroundJobsFilter, BackgroundJobsPage, CleanupBackgroundJobsResult,
};

#[derive(Clone)]
pub struct Storage {
    connection: Arc<Mutex<Connection>>,
    prices: Arc<Mutex<Vec<ModelPrice>>>,
    db_path: Arc<PathBuf>,
}

impl Storage {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StorageError> {
        let is_new_database = std::fs::metadata(path.as_ref())
            .map(|metadata| metadata.len() == 0)
            .unwrap_or(true);
        let connection = Connection::open(path.as_ref())?;
        if is_new_database {
            // auto_vacuum 必须在建表前启用；新库直接使用增量模式，后续清理任务
            // 可以分批归还空闲页，不需要周期性重写整个数据库。
            connection.execute_batch("PRAGMA auto_vacuum = INCREMENTAL;")?;
        }
        connection.execute_batch("PRAGMA journal_mode = WAL;")?;
        let storage = Self {
            connection: Arc::new(Mutex::new(connection)),
            prices: Arc::new(Mutex::new(Vec::new())),
            db_path: Arc::new(path.as_ref().to_path_buf()),
        };
        storage.migrate()?;
        Ok(storage)
    }

    /// 设置运行时模型价格（三段价格）。仅来自 config.json，这是价格的唯一真实来源。
    /// 写入后费用计算直接使用此内存副本，不再读取数据库。
    pub fn set_prices(&self, prices: Vec<ModelPrice>) {
        if let Ok(mut current) = self.prices.lock() {
            *current = prices;
        }
    }

    pub fn prices(&self) -> Vec<ModelPrice> {
        self.prices.lock().map(|p| p.clone()).unwrap_or_default()
    }

    #[cfg(test)]
    pub(crate) fn from_connection_for_test(connection: Connection) -> Self {
        Self {
            connection: Arc::new(Mutex::new(connection)),
            prices: Arc::new(Mutex::new(Vec::new())),
            db_path: Arc::new(PathBuf::from(":memory:")),
        }
    }

    // ─── Config Import/Export ────────────────────────────────────────────────

    /// 导出完整配置为 JSON 字符串
    pub fn export_config(&self) -> Result<String, StorageError> {
        let bundle = ConfigBundle {
            version: "1".to_string(),
            exported_at: chrono::Utc::now().to_rfc3339(),
            channels: self.list_channel_presets()?,
            accounts: self.list_channel_accounts()?,
            routes: self.list_route_candidates()?,
            rules: self.list_route_rules()?,
            prices: self.prices(),
            virtual_models: self.list_virtual_models()?,
        };
        serde_json::to_string_pretty(&bundle)
            .map_err(|e| StorageError::Sqlite(rusqlite::Error::ToSqlConversionFailure(Box::new(e))))
    }

    /// 从 JSON 字符串导入配置（覆盖现有配置）
    pub fn import_config(&self, json: &str) -> Result<(), StorageError> {
        let bundle: ConfigBundle = serde_json::from_str(json).map_err(|e| {
            StorageError::Sqlite(rusqlite::Error::ToSqlConversionFailure(Box::new(e)))
        })?;

        self.save_channel_presets(&bundle.channels)?;
        self.save_channel_accounts(&bundle.accounts)?;
        self.save_route_candidates(&bundle.routes)?;
        self.save_route_rules(&bundle.rules)?;
        self.save_virtual_models(&bundle.virtual_models)?;

        // 价格不再持久化到数据库；配置导入时直接更新内存中的价格副本。
        self.set_prices(bundle.prices);
        Ok(())
    }

    /// 用已经过验证的数据库安全替换当前数据库。
    ///
    /// 整个切换期间持有连接锁，先把导入库复制到目标目录并完成迁移，再关闭旧连接，
    /// 通过同目录 rename 切换文件。打开新库失败时会恢复原文件和连接。
    pub fn replace_database_from(&self, source: impl AsRef<Path>) -> Result<(), StorageError> {
        let target = self.db_path.as_ref();
        let parent = target.parent().unwrap_or_else(|| Path::new("."));
        let nonce = uuid::Uuid::new_v4();
        let staged = parent.join(format!(".flowlet-import-stage-{nonce}.sqlite"));
        let rollback = parent.join(format!(".flowlet-import-rollback-{nonce}.sqlite"));

        std::fs::copy(source.as_ref(), &staged)?;

        let staged_storage = match Storage::open(&staged) {
            Ok(storage) => storage,
            Err(error) => {
                remove_sqlite_files(&staged);
                return Err(error);
            }
        };
        {
            let connection = staged_storage
                .connection
                .lock()
                .map_err(|_| StorageError::LockFailed)?;
            let check: String = connection.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
            if check != "ok" {
                drop(connection);
                drop(staged_storage);
                remove_sqlite_files(&staged);
                return Err(StorageError::InvalidImport(check));
            }
            connection
                .execute_batch("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;")?;
        }
        drop(staged_storage);

        let mut guard = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        guard.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
        let placeholder = Connection::open_in_memory()?;
        let old_connection = std::mem::replace(&mut *guard, placeholder);
        drop(old_connection);
        remove_sqlite_sidecars(target);

        let switch_result = (|| -> Result<Connection, StorageError> {
            if target.exists() {
                std::fs::rename(target, &rollback)?;
            }
            std::fs::rename(&staged, target)?;
            let connection = Connection::open(target)?;
            connection.execute_batch("PRAGMA journal_mode = WAL;")?;
            Ok(connection)
        })();

        match switch_result {
            Ok(connection) => {
                *guard = connection;
                remove_sqlite_files(&rollback);
                Ok(())
            }
            Err(switch_error) => {
                let restore_file_result = if rollback.exists() {
                    remove_sqlite_files(target);
                    std::fs::rename(&rollback, target).map_err(StorageError::Io)
                } else {
                    Ok(())
                };

                let restore_connection_result = Connection::open(target).and_then(|connection| {
                    connection.execute_batch("PRAGMA journal_mode = WAL;")?;
                    Ok(connection)
                });

                remove_sqlite_files(&staged);

                match (restore_file_result, restore_connection_result) {
                    (Ok(()), Ok(connection)) => {
                        *guard = connection;
                        Err(switch_error)
                    }
                    (file_result, connection_result) => {
                        let restore_error = file_result
                            .err()
                            .map(|error| error.to_string())
                            .or_else(|| connection_result.err().map(|error| error.to_string()))
                            .unwrap_or_else(|| "未知恢复错误".to_string());
                        Err(StorageError::InvalidImport(format!(
                            "数据库切换失败（{switch_error}），恢复原数据库也失败（{restore_error}）"
                        )))
                    }
                }
            }
        }
    }

    /// 备份当前数据库到指定路径（使用独立连接，不阻塞主连接和代理请求）
    pub fn backup_to_path(&self, dest: impl AsRef<Path>) -> Result<(), StorageError> {
        // Brief WAL flush on main connection (PASSIVE = non-blocking)
        if let Ok(conn) = self.connection.lock() {
            let _ = conn.execute_batch("PRAGMA wal_checkpoint(PASSIVE);");
        }
        // Open separate connection for backup — the main connection stays free
        // for the proxy to continue logging requests
        let src = Connection::open(self.db_path.as_ref())?;
        let mut dst = Connection::open(dest.as_ref())?;
        let backup = rusqlite::backup::Backup::new(&src, &mut dst).map_err(StorageError::Sqlite)?;
        backup
            .run_to_completion(100, std::time::Duration::from_millis(10), None)
            .map_err(StorageError::Sqlite)?;
        Ok(())
    }

    // ─── Maintenance ─────────────────────────────────────────────────────────

    /// 清理指定天数之前的请求日志和用量记录，返回删除的记录数
    pub fn cleanup_old_logs(&self, keep_days: i64) -> Result<(usize, usize), StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;

        let cutoff = format!("datetime('now', '-{} days')", keep_days);

        let deleted_logs = connection.execute(
            &format!("DELETE FROM request_logs WHERE created_at < {}", cutoff),
            [],
        )?;

        let deleted_usage = connection.execute(
            &format!("DELETE FROM usage_records WHERE created_at < {}", cutoff),
            [],
        )?;

        // 注意：不再在此处执行 VACUUM。VACUUM 会重写整个 DB 文件，大库清理时
        // 会冻结数秒。 SQLite WAL + 空闲页复用已足够回收空间；如需压缩磁盘
        // 可在程序空闲时由外部 sqlite3 命令行手动执行 VACUUM。

        Ok((deleted_logs, deleted_usage))
    }

    /// 清理超过保留天数的请求/响应 Body 数据。
    ///
    /// 仅清除已有完整 Token 用量统计的记录（输入、输出 Token 均已计算），
    /// 确保数据修复（reanalyze_captured_usage）不会因 Body 提前清理而丢失可重解析对象。
    ///
    /// 返回清除 Body 的记录数。
    pub fn cleanup_expired_body_data(&self, retention_days: i64) -> Result<usize, StorageError> {
        if retention_days < 0 {
            // -1 = 永久保留，不做清理
            return Ok(0);
        }
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;

        let cutoff = format!("datetime('now', '-{} days')", retention_days);

        // 仅清理：
        // 1. 超过保留期限
        // 2. req_body_b64 或 res_body_b64 非空
        // 3. 已有完整的 Token 统计（usage_records 的输入、输出 Token 均非空）
        let cleared = connection.execute(
            &format!(
                r#"UPDATE request_logs
                SET req_body_cleared_at = CASE WHEN req_body_b64 IS NOT NULL THEN datetime('now') ELSE req_body_cleared_at END,
                    req_body_cleanup_reason = CASE WHEN req_body_b64 IS NOT NULL THEN 'retention' ELSE req_body_cleanup_reason END,
                    res_body_cleared_at = CASE WHEN res_body_b64 IS NOT NULL THEN datetime('now') ELSE res_body_cleared_at END,
                    res_body_cleanup_reason = CASE WHEN res_body_b64 IS NOT NULL THEN 'retention' ELSE res_body_cleanup_reason END,
                    req_body_b64 = NULL,
                    res_body_b64 = NULL
                WHERE created_at < {}
                  AND (req_body_b64 IS NOT NULL OR res_body_b64 IS NOT NULL)
                  AND EXISTS (
                    SELECT 1 FROM usage_records ur
                    WHERE ur.request_id = request_logs.request_id
                      AND ur.input_tokens IS NOT NULL
                      AND ur.output_tokens IS NOT NULL
                  )"#,
                cutoff
            ),
            [],
        )?;

        Ok(cleared)
    }

    /// 获取当前 Body 数据总占用字节数（req_body_b64 + res_body_b64 的 length 之和）。
    pub fn get_total_body_size_bytes(&self) -> Result<i64, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;

        let size: i64 = connection.query_row(
            r#"SELECT COALESCE(SUM(length(COALESCE(req_body_b64, '')) + length(COALESCE(res_body_b64, ''))), 0)
               FROM request_logs
               WHERE req_body_b64 IS NOT NULL OR res_body_b64 IS NOT NULL"#,
            [],
            |row| row.get(0),
        )?;

        Ok(size)
    }

    /// 按体积上限清理最老的 Body 数据（单次清理，不长期持锁）。
    /// 仅清除至少一小时前、输入与输出 Token 均已计算的记录。
    /// 如果近期 Body 自身超过上限，则允许暂时超限，不牺牲刚完成请求的可排查性。
    ///
    /// 清理策略（按体积而非记录数）：
    /// - 当前体积已低于 target_bytes * (1 - prune_ratio) 时直接返回 0
    /// - 否则按"符合条件记录总数的 prune_ratio"换算成单批数量，一次性删最老的这批
    /// - 若要压到目标以下，由调用方循环多次调用本函数（每次调用只持锁一次）
    ///
    /// 返回实际清理的行数。
    pub fn prune_oldest_body_data(
        &self,
        target_bytes: i64,
        prune_ratio: f64,
    ) -> Result<usize, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;

        let prune_ratio = prune_ratio.clamp(0.0, 1.0);
        if prune_ratio <= 0.0 {
            return Ok(0);
        }

        // 目标：压到 target_bytes * (1 - prune_ratio) 以下
        let goal_bytes = ((target_bytes as f64) * (1.0 - prune_ratio)).max(0.0) as i64;

        // 当前体积
        let current_bytes: i64 = connection.query_row(
            r#"SELECT COALESCE(SUM(length(COALESCE(req_body_b64, '')) + length(COALESCE(res_body_b64, ''))), 0)
               FROM request_logs
               WHERE req_body_b64 IS NOT NULL OR res_body_b64 IS NOT NULL"#,
            [],
            |row| row.get(0),
        )?;
        if current_bytes <= goal_bytes {
            return Ok(0);
        }

        // 符合条件记录总数（决定批大小）
        let total_eligible: i64 = connection.query_row(
            r#"SELECT COUNT(*) FROM request_logs
               WHERE created_at < datetime('now', '-1 hour')
                 AND (req_body_b64 IS NOT NULL OR res_body_b64 IS NOT NULL)
                 AND EXISTS (
                   SELECT 1 FROM usage_records ur
                   WHERE ur.request_id = request_logs.request_id
                     AND ur.input_tokens IS NOT NULL
                     AND ur.output_tokens IS NOT NULL
                 )"#,
            [],
            |row| row.get(0),
        )?;
        if total_eligible == 0 {
            return Ok(0);
        }

        // 批大小：按 prune_ratio 换算成数量（至少 1 条）
        let batch_size = ((total_eligible as f64) * prune_ratio).ceil() as i64;
        let batch_size = std::cmp::max(batch_size, 1);

        // 单次清理最老的这批（不长期持锁）
        let cleared = connection.execute(
            &format!(
                r#"UPDATE request_logs
                SET req_body_cleared_at = CASE WHEN req_body_b64 IS NOT NULL THEN datetime('now') ELSE req_body_cleared_at END,
                    req_body_cleanup_reason = CASE WHEN req_body_b64 IS NOT NULL THEN 'size_limit' ELSE req_body_cleanup_reason END,
                    res_body_cleared_at = CASE WHEN res_body_b64 IS NOT NULL THEN datetime('now') ELSE res_body_cleared_at END,
                    res_body_cleanup_reason = CASE WHEN res_body_b64 IS NOT NULL THEN 'size_limit' ELSE res_body_cleanup_reason END,
                    req_body_b64 = NULL,
                    res_body_b64 = NULL
                WHERE rowid IN (
                  SELECT rl.rowid FROM request_logs rl
                  WHERE rl.created_at < datetime('now', '-{} hours')
                    AND (rl.req_body_b64 IS NOT NULL OR rl.res_body_b64 IS NOT NULL)
                    AND EXISTS (
                      SELECT 1 FROM usage_records ur
                      WHERE ur.request_id = rl.request_id
                        AND ur.input_tokens IS NOT NULL
                        AND ur.output_tokens IS NOT NULL
                    )
                  ORDER BY rl.created_at ASC
                  LIMIT {}
                )"#,
                BODY_SIZE_PRUNE_MIN_AGE_HOURS,
                batch_size
            ),
            [],
        )?;

        Ok(cleared)
    }

    /// 按体积上限循环清理最老的 Body 数据，直到低于目标或无记录可删。
    /// 每次清理都单独持锁（不阻塞其他 DB 操作），带安全兜底上限。
    /// 返回实际清理的总行数。
    pub fn prune_oldest_body_data_to_goal(
        &self,
        target_bytes: i64,
        prune_ratio: f64,
        max_rounds: usize,
    ) -> Result<usize, StorageError> {
        let mut total = 0usize;
        for _ in 0..max_rounds {
            let cleared = self.prune_oldest_body_data(target_bytes, prune_ratio)?;
            if cleared == 0 {
                break;
            }
            total += cleared;
        }
        Ok(total)
    }

    /// 获取数据库统计信息
    pub fn db_stats(&self) -> Result<(i64, i64, i64), StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;

        let logs: i64 =
            connection.query_row("SELECT COUNT(*) FROM request_logs", [], |row| row.get(0))?;

        let usage: i64 =
            connection.query_row("SELECT COUNT(*) FROM usage_records", [], |row| row.get(0))?;

        let file_size: i64 = connection.query_row(
            "SELECT page_count * page_size FROM pragma_page_count(), pragma_page_size()",
            [],
            |row| row.get(0),
        )?;

        Ok((logs, usage, file_size))
    }

    /// 测试辅助：将所有请求日志的 created_at 更新为指定天数前
    #[cfg(test)]
    pub fn test_set_logs_created_at_days_ago(&self, days: i64) -> Result<(), StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        connection.execute(
            &format!(
                "UPDATE request_logs SET created_at = datetime('now', '-{} days')",
                days
            ),
            [],
        )?;
        Ok(())
    }

    /// 测试辅助：将指定 request_id 的 created_at 更新为指定天数前
    #[cfg(test)]
    pub fn test_set_log_created_at_days_ago(
        &self,
        request_id: &str,
        days: i64,
    ) -> Result<(), StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        connection.execute(
            &format!(
                "UPDATE request_logs SET created_at = datetime('now', '-{} days') WHERE request_id = ?1",
                days
            ),
            [request_id],
        )?;
        Ok(())
    }

    // ─── Migration ───────────────────────────────────────────────────────────

    pub(crate) fn migrate(&self) -> Result<(), StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        tracing::debug!("migrate: 建表");
        connection.execute_batch(
            r#"
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
                created_at      TEXT NOT NULL,
                updated_at      TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS channel_accounts (
                id                TEXT PRIMARY KEY,
                channel_id        TEXT NOT NULL,
                name              TEXT NOT NULL,
                api_key           TEXT NOT NULL,
                enabled           INTEGER NOT NULL DEFAULT 1,
                priority          INTEGER NOT NULL DEFAULT 0,
                remark            TEXT,
                resource_mode     TEXT,
                base_url_override TEXT,
                anthropic_base_url_override TEXT,
                last_used_at      TEXT,
                last_error        TEXT,
                credential_status TEXT NOT NULL DEFAULT 'healthy',
                created_at        TEXT NOT NULL,
                updated_at        TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS channel_models (
                id                   TEXT PRIMARY KEY,
                channel_id           TEXT NOT NULL,
                model                TEXT NOT NULL,
                display_name         TEXT,
                supported_protocols  TEXT NOT NULL,
                context_window       INTEGER,
                max_output_tokens    INTEGER,
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
                estimated_cost        REAL,
                analyzed_at           TEXT,
                created_at            TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS app_meta (
                key        TEXT PRIMARY KEY,
                value      TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS agent_session_snapshots (
                agent_type TEXT NOT NULL,
                session_id TEXT NOT NULL,
                fingerprint TEXT NOT NULL,
                summary_json TEXT NOT NULL,
                source_offset INTEGER NOT NULL DEFAULT 0,
                parser_version INTEGER NOT NULL DEFAULT 0,
                usage_ids_json TEXT NOT NULL DEFAULT '[]',
                cursor_guard TEXT NOT NULL DEFAULT '',
                synced_at TEXT NOT NULL,
                PRIMARY KEY (agent_type, session_id)
            );

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
            "#,
        )?;

        add_column_if_missing(
            &connection,
            "background_jobs",
            "cancel_requested",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        add_column_if_missing(
            &connection,
            "agent_session_snapshots",
            "source_offset",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        add_column_if_missing(
            &connection,
            "agent_session_snapshots",
            "parser_version",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        add_column_if_missing(
            &connection,
            "agent_session_snapshots",
            "usage_ids_json",
            "TEXT NOT NULL DEFAULT '[]'",
        )?;
        add_column_if_missing(
            &connection,
            "agent_session_snapshots",
            "cursor_guard",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        connection.execute(
            "DELETE FROM background_job_events WHERE job_id IN (SELECT id FROM background_jobs WHERE status NOT IN ('queued', 'running') AND created_at < datetime('now', '-90 days'))",
            [],
        )?;
        connection.execute(
            "DELETE FROM background_jobs WHERE status NOT IN ('queued', 'running') AND created_at < datetime('now', '-90 days')",
            [],
        )?;

        connection.execute(
            "UPDATE background_jobs SET status = 'interrupted', stage = '应用已重启', finished_at = datetime('now'), updated_at = datetime('now') WHERE status IN ('queued', 'running')",
            [],
        )?;

        normalize_legacy_virtual_model_routes_schema(&connection)?;

        add_column_if_missing(
            &connection,
            "channel_presets",
            "openai_auth",
            "TEXT NOT NULL DEFAULT 'bearer'",
        )?;
        add_column_if_missing(
            &connection,
            "channel_presets",
            "anthropic_auth",
            "TEXT NOT NULL DEFAULT 'bearer'",
        )?;
        add_column_if_missing(&connection, "channel_presets", "small_model", "TEXT")?;
        add_column_if_missing(&connection, "channel_presets", "timeout_seconds", "INTEGER")?;
        add_column_if_missing(
            &connection,
            "virtual_model_routes",
            "virtual_model_id",
            "TEXT NOT NULL DEFAULT 'auto'",
        )?;
        add_column_if_missing(
            &connection,
            "virtual_model_routes",
            "channel_id",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        add_column_if_missing(
            &connection,
            "virtual_model_routes",
            "account_id",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        add_column_if_missing(
            &connection,
            "virtual_model_routes",
            "upstream_model",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        add_column_if_missing(
            &connection,
            "channel_accounts",
            "credential_status",
            "TEXT NOT NULL DEFAULT 'healthy'",
        )?;
        add_column_if_missing(
            &connection,
            "virtual_model_routes",
            "client_protocol",
            "TEXT NOT NULL DEFAULT 'openai'",
        )?;
        add_column_if_missing(
            &connection,
            "virtual_model_routes",
            "priority",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        add_column_if_missing(
            &connection,
            "virtual_model_routes",
            "enabled",
            "INTEGER NOT NULL DEFAULT 1",
        )?;
        add_column_if_missing(
            &connection,
            "virtual_model_routes",
            "created_at",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        add_column_if_missing(
            &connection,
            "virtual_model_routes",
            "updated_at",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        // 渠道模板：补充平台查看地址（API Key 管理页跳转）
        add_column_if_missing(&connection, "channel_presets", "platform_url", "TEXT")?;

        // 余额快照：补充 LongCat 多资源包原始数据（JSON 数组）
        add_column_if_missing(
            &connection,
            "account_balance_snapshots",
            "token_packs",
            "TEXT",
        )?;
        // 余额快照：补充控制台抓取的完整拦截 payload(用于调试/重解析)
        add_column_if_missing(
            &connection,
            "account_balance_snapshots",
            "raw_scraped_json",
            "TEXT",
        )?;
        // 渠道模板：补充控制台抓取能力标志
        add_column_if_missing(
            &connection,
            "channel_presets",
            "supports_scrape_balance",
            "INTEGER NOT NULL DEFAULT 0",
        )?;

        // 渠道账号：补充 Base URL 覆盖字段
        add_column_if_missing(&connection, "channel_accounts", "base_url_override", "TEXT")?;
        let migrate_anthropic_override = !table_has_column(
            &connection,
            "channel_accounts",
            "anthropic_base_url_override",
        )?;
        add_column_if_missing(
            &connection,
            "channel_accounts",
            "anthropic_base_url_override",
            "TEXT",
        )?;
        if migrate_anthropic_override {
            // 旧版单一覆盖地址同时作用于两种协议；首次迁移时复制一份以保持兼容。
            connection.execute(
                "UPDATE channel_accounts SET anthropic_base_url_override = base_url_override WHERE base_url_override IS NOT NULL AND trim(base_url_override) <> ''",
                [],
            )?;
        }
        add_column_if_missing(&connection, "channel_accounts", "resource_mode", "TEXT")?;

        // 旧版本 request_logs 只记录了少量字段；后续索引和日志页面依赖这些基础列。
        add_column_if_missing(
            &connection,
            "request_logs",
            "request_id",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        add_column_if_missing(&connection, "request_logs", "agent_type", "TEXT")?;
        add_column_if_missing(&connection, "request_logs", "agent_session_id", "TEXT")?;
        add_column_if_missing(
            &connection,
            "request_logs",
            "parent_agent_session_id",
            "TEXT",
        )?;
        add_column_if_missing(&connection, "request_logs", "client_id", "TEXT")?;
        add_column_if_missing(&connection, "request_logs", "client_name", "TEXT")?;
        add_column_if_missing(&connection, "request_logs", "channel_id", "TEXT")?;
        add_column_if_missing(&connection, "request_logs", "channel_name", "TEXT")?;
        add_column_if_missing(&connection, "request_logs", "account_id", "TEXT")?;
        add_column_if_missing(&connection, "request_logs", "account_name", "TEXT")?;
        add_column_if_missing(
            &connection,
            "request_logs",
            "client_protocol",
            "TEXT NOT NULL DEFAULT 'openai'",
        )?;
        add_column_if_missing(
            &connection,
            "request_logs",
            "upstream_protocol",
            "TEXT NOT NULL DEFAULT 'openai'",
        )?;
        add_column_if_missing(&connection, "request_logs", "virtual_model", "TEXT")?;
        add_column_if_missing(&connection, "request_logs", "public_model", "TEXT")?;
        add_column_if_missing(&connection, "request_logs", "upstream_model", "TEXT")?;
        add_column_if_missing(
            &connection,
            "request_logs",
            "request_type",
            "TEXT NOT NULL DEFAULT 'unknown'",
        )?;
        add_column_if_missing(
            &connection,
            "request_logs",
            "method",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        add_column_if_missing(
            &connection,
            "request_logs",
            "path",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        add_column_if_missing(&connection, "request_logs", "status", "INTEGER")?;
        add_column_if_missing(&connection, "request_logs", "latency_ms", "INTEGER")?;
        add_column_if_missing(
            &connection,
            "request_logs",
            "is_stream",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        add_column_if_missing(&connection, "request_logs", "error_message", "TEXT")?;
        add_column_if_missing(
            &connection,
            "request_logs",
            "fallback_count",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        add_column_if_missing(&connection, "request_logs", "route_reason", "TEXT")?;
        add_column_if_missing(
            &connection,
            "request_logs",
            "created_at",
            "TEXT NOT NULL DEFAULT ''",
        )?;

        // 请求日志：补充详情字段（TTFB、TTFT、耗时、尝试序号、请求/响应头部与 body、流式摘要）
        add_column_if_missing(&connection, "request_logs", "ttfb_ms", "INTEGER")?;
        add_column_if_missing(&connection, "request_logs", "ttft_ms", "INTEGER")?;
        add_column_if_missing(&connection, "request_logs", "duration_ms", "INTEGER")?;
        add_column_if_missing(&connection, "request_logs", "upstream_url", "TEXT")?;
        add_column_if_missing(
            &connection,
            "request_logs",
            "attempt_seq",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        add_column_if_missing(&connection, "request_logs", "req_headers_json", "TEXT")?;
        add_column_if_missing(&connection, "request_logs", "req_body_b64", "TEXT")?;
        add_column_if_missing(&connection, "request_logs", "req_body_cleared_at", "TEXT")?;
        add_column_if_missing(
            &connection,
            "request_logs",
            "req_body_cleanup_reason",
            "TEXT",
        )?;
        add_column_if_missing(&connection, "request_logs", "res_headers_json", "TEXT")?;
        add_column_if_missing(&connection, "request_logs", "res_body_b64", "TEXT")?;
        add_column_if_missing(&connection, "request_logs", "res_body_cleared_at", "TEXT")?;
        add_column_if_missing(
            &connection,
            "request_logs",
            "res_body_cleanup_reason",
            "TEXT",
        )?;
        add_column_if_missing(
            &connection,
            "request_logs",
            "is_last_attempt",
            "INTEGER NOT NULL DEFAULT 1",
        )?;

        // 旧版本 usage_records 同样可能缺少账号、渠道和模型字段。
        add_column_if_missing(
            &connection,
            "usage_records",
            "request_id",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        add_column_if_missing(&connection, "usage_records", "client_id", "TEXT")?;
        add_column_if_missing(&connection, "usage_records", "client_name", "TEXT")?;
        add_column_if_missing(&connection, "usage_records", "channel_id", "TEXT")?;
        add_column_if_missing(&connection, "usage_records", "channel_name", "TEXT")?;
        add_column_if_missing(&connection, "usage_records", "account_id", "TEXT")?;
        add_column_if_missing(&connection, "usage_records", "account_name", "TEXT")?;
        add_column_if_missing(
            &connection,
            "usage_records",
            "client_protocol",
            "TEXT NOT NULL DEFAULT 'openai'",
        )?;
        add_column_if_missing(
            &connection,
            "usage_records",
            "upstream_protocol",
            "TEXT NOT NULL DEFAULT 'openai'",
        )?;
        add_column_if_missing(&connection, "usage_records", "virtual_model", "TEXT")?;
        add_column_if_missing(&connection, "usage_records", "upstream_model", "TEXT")?;
        add_column_if_missing(&connection, "usage_records", "input_tokens", "INTEGER")?;
        add_column_if_missing(
            &connection,
            "usage_records",
            "input_cached_tokens",
            "INTEGER",
        )?;
        add_column_if_missing(
            &connection,
            "usage_records",
            "input_uncached_tokens",
            "INTEGER",
        )?;
        add_column_if_missing(
            &connection,
            "usage_records",
            "input_cache_write_tokens",
            "INTEGER",
        )?;
        add_column_if_missing(&connection, "usage_records", "output_tokens", "INTEGER")?;
        add_column_if_missing(&connection, "usage_records", "total_tokens", "INTEGER")?;
        add_column_if_missing(&connection, "usage_records", "estimated_cost", "REAL")?;
        add_column_if_missing(&connection, "usage_records", "analyzed_at", "TEXT")?;
        add_column_if_missing(
            &connection,
            "usage_records",
            "created_at",
            "TEXT NOT NULL DEFAULT ''",
        )?;

        // 性能索引（2026-07-04）—— 覆盖 list_request_logs / account_stats /
        // usage_summary / recalculate_usage_costs / cleanup_old_logs 等热点查询
        connection.execute_batch(
            r#"
            CREATE INDEX IF NOT EXISTS idx_request_logs_created_at       ON request_logs(created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_request_logs_request_id       ON request_logs(request_id);
            CREATE INDEX IF NOT EXISTS idx_request_logs_is_last_attempt  ON request_logs(is_last_attempt);
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
            "#,
        )?;
        tracing::info!("migrate: 建表完成, 开始建索引");

        // 性能索引（2026-07-04）—— 覆盖 list_request_logs / account_stats /
        connection.execute(
            "INSERT INTO app_meta (key, value, updated_at) VALUES ('schema_version', '2026.07.19', datetime('now'))
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')",
            [],
        )?;

        // 删除已废弃的 stream_summary 列（流式摘要功能已移除）。
        // DROP COLUMN 要求 SQLite ≥ 3.35；Tauri 自带的 libsqlite3 满足版本。
        if table_has_column(&connection, "request_logs", "stream_summary")? {
            connection.execute("ALTER TABLE request_logs DROP COLUMN stream_summary", [])?;
        }

        tracing::info!("migrate: 完成");
        Ok(())
    }
}

fn add_column_if_missing(
    connection: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), StorageError> {
    let exists: i64 = connection.query_row(
        &format!("SELECT count(*) FROM pragma_table_info('{table}') WHERE name = ?1"),
        [column],
        |row| row.get(0),
    )?;
    if exists == 0 {
        connection.execute(
            &format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"),
            [],
        )?;
    }
    Ok(())
}

fn table_has_column(
    connection: &Connection,
    table: &str,
    column: &str,
) -> Result<bool, StorageError> {
    let exists: i64 = connection.query_row(
        &format!("SELECT count(*) FROM pragma_table_info('{table}') WHERE name = ?1"),
        [column],
        |row| row.get(0),
    )?;
    Ok(exists > 0)
}

fn normalize_legacy_virtual_model_routes_schema(
    connection: &Connection,
) -> Result<(), StorageError> {
    // 旧 schema 可能含 provider_name 或 provider_id 列，任一存在即需迁移。
    if !table_has_column(connection, "virtual_model_routes", "provider_name")?
        && !table_has_column(connection, "virtual_model_routes", "provider_id")?
    {
        return Ok(());
    }

    let column_or = |column: &str, default: &str| -> Result<String, StorageError> {
        if table_has_column(connection, "virtual_model_routes", column)? {
            Ok(format!("COALESCE({column}, {default})"))
        } else {
            Ok(default.to_string())
        }
    };
    let provider_name_exists =
        table_has_column(connection, "virtual_model_routes", "provider_name")?;
    let provider_id_exists = table_has_column(connection, "virtual_model_routes", "provider_id")?;
    let virtual_model_id =
        if table_has_column(connection, "virtual_model_routes", "virtual_model_id")? {
            "COALESCE(virtual_model_id, 'auto')".to_string()
        } else if provider_name_exists {
            "COALESCE(provider_name, 'auto')".to_string()
        } else {
            "'auto'".to_string()
        };
    let channel_id = if table_has_column(connection, "virtual_model_routes", "channel_id")? {
        "COALESCE(channel_id, '')".to_string()
    } else if provider_id_exists {
        "COALESCE(provider_id, '')".to_string()
    } else {
        "''".to_string()
    };
    let upstream_model = if table_has_column(connection, "virtual_model_routes", "upstream_model")?
    {
        "COALESCE(upstream_model, '')".to_string()
    } else if provider_name_exists {
        "COALESCE(provider_name, '')".to_string()
    } else {
        "''".to_string()
    };
    let account_id = column_or("account_id", "''")?;
    let priority = column_or("priority", "0")?;
    let enabled = column_or("enabled", "1")?;
    let created_at = column_or("created_at", "NULL")?;
    let updated_at = column_or("updated_at", "NULL")?;
    let client_protocol =
        if table_has_column(connection, "virtual_model_routes", "client_protocol")? {
            "CASE client_protocol WHEN 'anthropic' THEN 'anthropic' ELSE 'openai' END".to_string()
        } else {
            "'openai'".to_string()
        };

    // 重建表并使用 INSERT…SELECT 保留已有的路由数据。
    // 旧 schema 的 channel_id / account_id / client_protocol 以 '' / 'openai' 为默认，
    // 这里按原样复制；client_protocol 若不是有效协议则回退为 openai。
    // 注意：execute_batch 不支持参数绑定，时间戳直接内联到 SQL 文本中。
    let now = chrono::Utc::now().to_rfc3339();
    let migration_sql = format!(
        r#"
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
            {virtual_model_id},
            {channel_id},
            {account_id},
            {upstream_model},
            {client_protocol},
            {priority},
            {enabled},
            COALESCE({created_at}, '{now}'),
            COALESCE({updated_at}, '{now}')
        FROM virtual_model_routes_legacy_migrate;
        DROP TABLE virtual_model_routes_legacy_migrate;
        "#,
    );
    connection.execute_batch(&migration_sql)?;
    Ok(())
}

fn remove_sqlite_sidecars(path: &Path) {
    let _ = std::fs::remove_file(format!("{}-wal", path.display()));
    let _ = std::fs::remove_file(format!("{}-shm", path.display()));
}

fn remove_sqlite_files(path: &Path) {
    let _ = std::fs::remove_file(path);
    remove_sqlite_sidecars(path);
}

fn parse_auth_strategy(value: &str) -> AuthStrategy {
    match value {
        "x_api_key" => AuthStrategy::XApiKey,
        _ => AuthStrategy::Bearer,
    }
}

#[cfg(test)]
#[path = "storage_tests.rs"]
mod storage_tests;
