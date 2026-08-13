use super::config::{AuthStrategy, ConfigBundle, ModelPrice};
use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use thiserror::Error;

#[path = "request_capture.rs"]
mod request_capture;
use request_capture::RequestCaptureStore;

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
    #[error("后台任务运行冲突: {0}")]
    JobRuntime(String),
    #[error("请求明细存储错误: {0}")]
    RequestCapture(#[from] request_capture::RequestCaptureError),
}

#[path = "storage_config.rs"]
mod storage_config;
#[path = "storage_device_usage.rs"]
mod storage_device_usage;
#[path = "storage_maintenance.rs"]
mod storage_maintenance;
#[path = "storage_projects.rs"]
mod storage_projects;
#[path = "storage_recurring_tasks.rs"]
mod storage_recurring_tasks;
#[path = "storage_stats.rs"]
mod storage_stats;
#[path = "storage_tasks.rs"]
pub(crate) mod storage_tasks;
#[path = "storage_usage.rs"]
mod storage_usage;
pub use storage_maintenance::{DatabaseCompactionResult, DatabaseMaintenanceStats};
pub use storage_projects::{Project, ProjectTask};
pub use storage_recurring_tasks::{RecurringTask, RecurringTaskRun};
pub use storage_stats::{StorageUsageCategory, StorageUsageSummary};
pub use storage_tasks::{
    AgentDataSyncResult, AgentSyncStatusReport, BackgroundJobDetail, BackgroundJobRow,
    BackgroundJobsFilter, BackgroundJobsPage, CatalogSyncResult, CleanupBackgroundJobsResult,
};

#[derive(Clone)]
pub struct Storage {
    connection: Arc<Mutex<Connection>>,
    prices: Arc<Mutex<Vec<ModelPrice>>>,
    db_path: Arc<PathBuf>,
    capture_store: Arc<RequestCaptureStore>,
}

impl Storage {
    pub(crate) fn database_path(&self) -> &Path {
        self.db_path.as_path()
    }

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
        connection.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")?;
        let storage = Self {
            connection: Arc::new(Mutex::new(connection)),
            prices: Arc::new(Mutex::new(Vec::new())),
            db_path: Arc::new(path.as_ref().to_path_buf()),
            capture_store: Arc::new(RequestCaptureStore::for_database(path.as_ref())),
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
            capture_store: Arc::new(RequestCaptureStore::for_test()),
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
            connection.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")?;
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
                    connection
                        .execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")?;
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
        let cutoff = format!("datetime('now', '-{} days')", keep_days);

        let request_log_ids = {
            let connection = self
                .connection
                .lock()
                .map_err(|_| StorageError::LockFailed)?;
            let mut stmt = connection.prepare(&format!(
                "SELECT id FROM request_logs WHERE created_at < {cutoff}"
            ))?;
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        // 先从捕获 segment 中移除敏感 Body，再删除 SQLite 索引。日志清理失败时
        // 最多保留不含 Body 的明细，不会出现数据库已删但文件仍保留原始报文。
        self.clear_body_data_by_log_ids(&request_log_ids, "log_retention")?;

        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;

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
        let cutoff = format!("datetime('now', '-{} days')", retention_days);
        let ids = {
            let connection = self
                .connection
                .lock()
                .map_err(|_| StorageError::LockFailed)?;
            let mut stmt = connection.prepare(&format!(
                r#"SELECT rl.id
                   FROM request_logs rl
                   LEFT JOIN request_capture_refs refs ON refs.request_log_id = rl.id
                   WHERE rl.created_at < {}
                     AND (
                       rl.req_body_b64 IS NOT NULL OR rl.res_body_b64 IS NOT NULL
                       OR (refs.state = 'ready' AND (refs.req_body_bytes > 0 OR refs.res_body_bytes > 0))
                     )
                     AND EXISTS (
                       SELECT 1 FROM usage_records ur
                       WHERE ur.request_id = rl.request_id
                         AND ur.input_tokens IS NOT NULL
                         AND ur.output_tokens IS NOT NULL
                     )"#,
                cutoff
            ))?;
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        self.clear_body_data_by_log_ids(&ids, "retention")
    }

    /// 获取当前 Body 数据总占用字节数（req_body_b64 + res_body_b64 的 length 之和）。
    pub fn get_total_body_size_bytes(&self) -> Result<i64, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;

        let size: i64 = connection.query_row(
            r#"SELECT
                 COALESCE((
                   SELECT SUM(length(COALESCE(req_body_b64, '')) + length(COALESCE(res_body_b64, '')))
                   FROM request_logs
                   WHERE req_body_b64 IS NOT NULL OR res_body_b64 IS NOT NULL
                 ), 0)
                 + COALESCE((
                   SELECT SUM(req_body_bytes + res_body_bytes)
                   FROM request_capture_refs
                   WHERE state = 'ready'
                 ), 0)"#,
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
        let prune_ratio = prune_ratio.clamp(0.0, 1.0);
        if prune_ratio <= 0.0 {
            return Ok(0);
        }

        // 目标：压到 target_bytes * (1 - prune_ratio) 以下
        let goal_bytes = ((target_bytes as f64) * (1.0 - prune_ratio)).max(0.0) as i64;

        // 当前体积
        let current_bytes = self.get_total_body_size_bytes()?;
        if current_bytes <= goal_bytes {
            return Ok(0);
        }

        // 符合条件记录总数（决定批大小）
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let total_eligible: i64 = connection.query_row(
            r#"SELECT COUNT(*) FROM request_logs rl
               LEFT JOIN request_capture_refs refs ON refs.request_log_id = rl.id
               WHERE rl.created_at < datetime('now', '-1 hour')
                 AND (rl.req_body_b64 IS NOT NULL OR rl.res_body_b64 IS NOT NULL
                      OR (refs.state = 'ready' AND (refs.req_body_bytes > 0 OR refs.res_body_bytes > 0)))
                 AND EXISTS (
                   SELECT 1 FROM usage_records ur
                   WHERE ur.request_id = rl.request_id
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

        let ids = {
            let mut stmt = connection.prepare(&format!(
                r#"SELECT rl.id FROM request_logs rl
                   LEFT JOIN request_capture_refs refs ON refs.request_log_id = rl.id
                   WHERE rl.created_at < datetime('now', '-{} hours')
                     AND (rl.req_body_b64 IS NOT NULL OR rl.res_body_b64 IS NOT NULL
                          OR (refs.state = 'ready' AND (refs.req_body_bytes > 0 OR refs.res_body_bytes > 0)))
                     AND EXISTS (
                       SELECT 1 FROM usage_records ur
                       WHERE ur.request_id = rl.request_id
                         AND ur.input_tokens IS NOT NULL
                         AND ur.output_tokens IS NOT NULL
                     )
                   ORDER BY rl.created_at ASC
                   LIMIT {}"#,
                BODY_SIZE_PRUNE_MIN_AGE_HOURS, batch_size
            ))?;
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        drop(connection);
        self.clear_body_data_by_log_ids(&ids, "size_limit")
    }

    fn clear_body_data_by_log_ids(
        &self,
        request_log_ids: &[String],
        reason: &str,
    ) -> Result<usize, StorageError> {
        if request_log_ids.is_empty() {
            return Ok(0);
        }
        let targets = request_log_ids.iter().cloned().collect::<HashSet<_>>();
        let mut segments = HashMap::<String, Vec<String>>::new();
        {
            let connection = self
                .connection
                .lock()
                .map_err(|_| StorageError::LockFailed)?;
            for request_log_id in request_log_ids {
                let storage_key = connection
                    .query_row(
                        r#"SELECT storage_key FROM request_capture_refs
                           WHERE request_log_id = ?1 AND state = 'ready'"#,
                        [request_log_id],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()?;
                if let Some(storage_key) = storage_key {
                    segments
                        .entry(storage_key)
                        .or_default()
                        .push(request_log_id.clone());
                }
            }
        }

        let mut cleared = HashSet::<String>::new();
        for storage_key in segments.keys() {
            let writer_guard = self.capture_store.lock_writer()?;
            let live = {
                let connection = self
                    .connection
                    .lock()
                    .map_err(|_| StorageError::LockFailed)?;
                let mut stmt = connection.prepare(
                    r#"SELECT request_log_id, frame_offset, frame_length, checksum,
                              format_version, req_body_bytes, res_body_bytes
                       FROM request_capture_refs
                       WHERE storage_key = ?1 AND state = 'ready'
                       ORDER BY frame_offset"#,
                )?;
                let rows = stmt
                    .query_map([storage_key], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            request_capture::RequestCapturePointer {
                                storage_key: storage_key.clone(),
                                offset: row.get::<_, i64>(1)? as u64,
                                length: row.get::<_, i64>(2)? as u64,
                                checksum: row.get(3)?,
                                format_version: row.get::<_, i64>(4)? as u16,
                                req_body_bytes: row.get(5)?,
                                res_body_bytes: row.get(6)?,
                            },
                        ))
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                rows
            };
            let mut records = Vec::with_capacity(live.len());
            let mut ids = Vec::with_capacity(live.len());
            let mut body_presence = Vec::with_capacity(live.len());
            for (request_log_id, pointer) in &live {
                let mut record = self.capture_store.read(pointer)?;
                let had_req_body = record.req_body_b64.is_some();
                let had_res_body = record.res_body_b64.is_some();
                if targets.contains(request_log_id) && (had_req_body || had_res_body) {
                    record.req_body_b64 = None;
                    record.res_body_b64 = None;
                    cleared.insert(request_log_id.clone());
                }
                ids.push(request_log_id.clone());
                body_presence.push((had_req_body, had_res_body));
                records.push(record);
            }
            if records.is_empty() {
                continue;
            }
            let pointers =
                self.capture_store
                    .rewrite_segment_locked(storage_key, &records, &writer_guard)?;
            let update_result = (|| -> Result<(), StorageError> {
                let mut connection = self
                    .connection
                    .lock()
                    .map_err(|_| StorageError::LockFailed)?;
                let transaction = connection.transaction()?;
                for ((request_log_id, (had_req_body, had_res_body)), pointer) in
                    ids.iter().zip(body_presence.iter()).zip(pointers.iter())
                {
                    transaction.execute(
                        r#"UPDATE request_capture_refs
                           SET storage_key = ?2, frame_offset = ?3, frame_length = ?4,
                               checksum = ?5, format_version = ?6,
                               req_body_bytes = ?7, res_body_bytes = ?8,
                               state = ?9, failure_reason = NULL, updated_at = datetime('now')
                           WHERE request_log_id = ?1"#,
                        rusqlite::params![
                            request_log_id,
                            pointer.storage_key,
                            pointer.offset as i64,
                            pointer.length as i64,
                            pointer.checksum,
                            pointer.format_version as i64,
                            pointer.req_body_bytes,
                            pointer.res_body_bytes,
                            if targets.contains(request_log_id) {
                                "cleared"
                            } else {
                                "ready"
                            },
                        ],
                    )?;
                    if targets.contains(request_log_id) {
                        transaction.execute(
                            r#"UPDATE request_logs
                               SET req_body_cleared_at = CASE WHEN ?2 THEN datetime('now') ELSE req_body_cleared_at END,
                                   req_body_cleanup_reason = CASE WHEN ?2 THEN ?4 ELSE req_body_cleanup_reason END,
                                   res_body_cleared_at = CASE WHEN ?3 THEN datetime('now') ELSE res_body_cleared_at END,
                                   res_body_cleanup_reason = CASE WHEN ?3 THEN ?4 ELSE res_body_cleanup_reason END,
                                   req_body_b64 = NULL, res_body_b64 = NULL
                               WHERE id = ?1"#,
                            rusqlite::params![
                                request_log_id,
                                had_req_body,
                                had_res_body,
                                reason,
                            ],
                        )?;
                    }
                }
                transaction.commit()?;
                Ok(())
            })();
            if let Err(error) = update_result {
                if let Some(pointer) = pointers.first() {
                    let _ = self
                        .capture_store
                        .remove_segment_locked(&pointer.storage_key, &writer_guard);
                }
                return Err(error);
            }
            self.capture_store
                .remove_segment_locked(storage_key, &writer_guard)?;
        }

        // Historical rows without file references remain supported during migration.
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        for request_log_id in request_log_ids {
            let changed = connection.execute(
                r#"UPDATE request_logs
                   SET req_body_cleared_at = CASE WHEN req_body_b64 IS NOT NULL THEN datetime('now') ELSE req_body_cleared_at END,
                       req_body_cleanup_reason = CASE WHEN req_body_b64 IS NOT NULL THEN ?2 ELSE req_body_cleanup_reason END,
                       res_body_cleared_at = CASE WHEN res_body_b64 IS NOT NULL THEN datetime('now') ELSE res_body_cleared_at END,
                       res_body_cleanup_reason = CASE WHEN res_body_b64 IS NOT NULL THEN ?2 ELSE res_body_cleanup_reason END,
                       req_body_b64 = NULL, res_body_b64 = NULL
                   WHERE id = ?1 AND (req_body_b64 IS NOT NULL OR res_body_b64 IS NOT NULL)"#,
                rusqlite::params![request_log_id, reason],
            )?;
            if changed > 0 {
                cleared.insert(request_log_id.clone());
            }
        }
        Ok(cleared.len())
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

            CREATE TABLE IF NOT EXISTS projects (
                id                  TEXT PRIMARY KEY,
                name                TEXT NOT NULL,
                directory_path      TEXT,
                workspace_project_id TEXT,
                workspace_archived  INTEGER NOT NULL DEFAULT 0,
                created_at          TEXT NOT NULL,
                updated_at          TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS project_tasks (
                id            TEXT PRIMARY KEY,
                project_id    TEXT NOT NULL,
                title         TEXT NOT NULL,
                description   TEXT NOT NULL DEFAULT '',
                status        TEXT NOT NULL DEFAULT 'draft'
                              CHECK (status IN ('draft', 'submitted', 'in_progress', 'review', 'done')),
                task_type     TEXT NOT NULL DEFAULT 'code'
                              CHECK (task_type IN ('code', 'readonly')),
                agent_profile TEXT NOT NULL DEFAULT '',
                priority      TEXT NOT NULL DEFAULT 'p2'
                              CHECK (priority IN ('p0', 'p1', 'p2')),
                base_task_id  TEXT,
                claimed_by    TEXT,
                claimed_at    TEXT,
                queue_boosted_at TEXT,
                deleted       INTEGER NOT NULL DEFAULT 0,
                created_at    TEXT NOT NULL,
                updated_at    TEXT NOT NULL,
                FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_project_tasks_project_status_updated
                ON project_tasks(project_id, status, updated_at DESC);

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

            -- 跨设备同步来的轻量项目目录：移动端据此发现「哪台设备能执行哪个项目」
            -- 并只读查看任务状态。`project_id` 是工作区项目 id。整表只读共享区。
            CREATE TABLE IF NOT EXISTS device_projects (
                device_id             TEXT NOT NULL,
                project_id            TEXT NOT NULL,
                project_name          TEXT NOT NULL,
                has_local_binding     INTEGER NOT NULL DEFAULT 0,
                tasks_json            TEXT NOT NULL DEFAULT '[]',
                updated_at            TEXT NOT NULL DEFAULT '',
                snapshot_generated_at TEXT NOT NULL,
                imported_at           TEXT NOT NULL,
                PRIMARY KEY (device_id, project_id),
                FOREIGN KEY (device_id) REFERENCES known_devices(device_id) ON DELETE CASCADE
            );

            -- 各桌面设备发布的去敏账号资源观测。查询时按稳定账号 ID 选取
            -- observed_at 最新的一条，避免同一工作区账号按设备重复展示。
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

            -- 跨设备同步来的维度用量聚合：每台设备在快照中附带自身按
            -- (日期, 客户端, 渠道, 账号, 模型) 聚合的用量，导入后落库，供用量分析页
            -- 按设备维度汇总。主键含 device_id，与本机 usage_summary 行互不冲突。
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

            -- Agent 原生会话逐事件用量账本：未经过 Flowlet 代理的 Token，
            -- 按消息级时间戳落库，供按天/小时精确归集（见 AgentUsageEvent）。
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
            "#,
        )?;

        add_column_if_missing(
            &connection,
            "device_usage_breakdowns",
            "estimated_cost_currency",
            "TEXT",
        )?;
        add_column_if_missing(
            &connection,
            "device_usage_breakdowns",
            "native_event_count",
            "INTEGER NOT NULL DEFAULT 0",
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
            "session_json",
            "TEXT",
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
        for column in [
            "native_event_count",
            "native_input_tokens",
            "native_cached_input_tokens",
            "native_cache_write_input_tokens",
            "native_output_tokens",
            "native_reasoning_tokens",
            "native_total_tokens",
        ] {
            add_column_if_missing(
                &connection,
                "device_daily_usage",
                column,
                "INTEGER NOT NULL DEFAULT 0",
            )?;
        }
        add_column_if_missing(
            &connection,
            "device_daily_usage",
            "estimated_cost",
            "REAL NOT NULL DEFAULT 0",
        )?;
        add_column_if_missing(
            &connection,
            "device_hourly_usage",
            "input_tokens",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        add_column_if_missing(
            &connection,
            "device_hourly_usage",
            "input_cached_tokens",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        add_column_if_missing(
            &connection,
            "device_hourly_usage",
            "cache_measured_input_tokens",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        add_column_if_missing(
            &connection,
            "device_hourly_usage",
            "output_tokens",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        add_column_if_missing(
            &connection,
            "device_hourly_usage",
            "unknown_count",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        add_column_if_missing(
            &connection,
            "device_hourly_usage",
            "estimated_cost",
            "REAL NOT NULL DEFAULT 0",
        )?;
        add_column_if_missing(
            &connection,
            "device_hourly_usage",
            "native_event_count",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        add_column_if_missing(
            &connection,
            "device_hourly_usage",
            "native_input_tokens",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        add_column_if_missing(
            &connection,
            "device_hourly_usage",
            "native_cached_input_tokens",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        add_column_if_missing(
            &connection,
            "device_hourly_usage",
            "native_cache_write_input_tokens",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        add_column_if_missing(
            &connection,
            "device_hourly_usage",
            "native_output_tokens",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        add_column_if_missing(
            &connection,
            "device_hourly_usage",
            "native_reasoning_tokens",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        add_column_if_missing(
            &connection,
            "device_hourly_usage",
            "native_total_tokens",
            "INTEGER NOT NULL DEFAULT 0",
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
        add_column_if_missing(&connection, "channel_models", "pricing_json", "TEXT")?;
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
        // OpenRouter Management Key：只用于账户 Credits 查询，不参与代理路由。
        add_column_if_missing(&connection, "channel_accounts", "management_key", "TEXT")?;
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
        add_column_if_missing(
            &connection,
            "known_devices",
            "display_name",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        add_column_if_missing(
            &connection,
            "known_devices",
            "platform",
            "TEXT NOT NULL DEFAULT 'unknown'",
        )?;
        add_column_if_missing(
            &connection,
            "known_devices",
            "app_version",
            "TEXT NOT NULL DEFAULT 'unknown'",
        )?;
        add_column_if_missing(
            &connection,
            "known_devices",
            "profile_generated_at",
            "TEXT NOT NULL DEFAULT ''",
        )?;

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
        add_column_if_missing(
            &connection,
            "channel_accounts",
            "resource_sync_mode",
            "TEXT NOT NULL DEFAULT 'manual'",
        )?;
        // 渠道账号：最近一次 /models 拉取的候选池（synced_models + 时间），
        // 以及用户显式勾选要开放的模型列表（exposed_models）。
        add_column_if_missing(&connection, "channel_accounts", "synced_models", "TEXT")?;
        add_column_if_missing(&connection, "channel_accounts", "models_synced_at", "TEXT")?;
        add_column_if_missing(&connection, "channel_accounts", "exposed_models", "TEXT")?;

        // LongCat 统一为 hybrid 模式(同时抓取 token 资源包与按量余额)。
        // 把旧值 token_pack / pay_as_you_go / null 统一迁移为 hybrid。
        connection.execute(
            "UPDATE channel_accounts SET resource_mode = 'hybrid' WHERE channel_id = 'longcat'",
            [],
        )?;
        // Qwen Token Plan 的额度只允许从官方控制台自动同步，不再保留手动维护模式。
        // 每次启动都执行该幂等归一化，兼容历史数据库和外部配置导入的旧值。
        connection.execute(
            "UPDATE channel_accounts SET resource_sync_mode = 'auto' WHERE channel_id = 'qwen' AND resource_mode = 'token_plan'",
            [],
        )?;

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
        let migrate_usage_status = !table_has_column(&connection, "usage_records", "usage_status")?;
        let migrate_usage_source = !table_has_column(&connection, "usage_records", "usage_source")?;
        add_column_if_missing(
            &connection,
            "usage_records",
            "usage_status",
            "TEXT NOT NULL DEFAULT 'complete'",
        )?;
        add_column_if_missing(
            &connection,
            "usage_records",
            "usage_source",
            "TEXT NOT NULL DEFAULT 'upstream_response'",
        )?;
        if migrate_usage_status {
            connection.execute(
                r#"UPDATE usage_records
                   SET usage_status = CASE
                       WHEN total_tokens IS NOT NULL THEN 'complete'
                       WHEN input_tokens IS NOT NULL OR input_cached_tokens IS NOT NULL
                         OR input_uncached_tokens IS NOT NULL OR input_cache_write_tokens IS NOT NULL
                         OR output_tokens IS NOT NULL THEN 'partial'
                       ELSE 'unknown'
                   END"#,
                [],
            )?;
        }
        if migrate_usage_source {
            // 历史行无法再可靠区分实时响应、捕获重解析或 Agent 原生回填，明确标为 legacy，
            // 避免伪造比现有证据更具体的来源。
            connection.execute("UPDATE usage_records SET usage_source = 'legacy'", [])?;
        }
        add_column_if_missing(&connection, "usage_records", "estimated_cost", "REAL")?;
        add_column_if_missing(
            &connection,
            "usage_records",
            "estimated_input_uncached_cost",
            "REAL",
        )?;
        add_column_if_missing(
            &connection,
            "usage_records",
            "estimated_input_cached_cost",
            "REAL",
        )?;
        add_column_if_missing(
            &connection,
            "usage_records",
            "estimated_input_cache_write_cost",
            "REAL",
        )?;
        add_column_if_missing(
            &connection,
            "usage_records",
            "estimated_output_cost",
            "REAL",
        )?;
        add_column_if_missing(&connection, "usage_records", "analyzed_at", "TEXT")?;
        add_column_if_missing(
            &connection,
            "channel_presets",
            "enabled",
            "INTEGER NOT NULL DEFAULT 1",
        )?;
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
            "#,
        )?;
        tracing::info!("migrate: 建表完成, 开始建索引");

        // 性能索引（2026-07-04）—— 覆盖 list_request_logs / account_stats /
        connection.execute(
            "INSERT INTO app_meta (key, value, updated_at) VALUES ('schema_version', '2026.08.02', datetime('now'))
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')",
            [],
        )?;

        // 删除已废弃的 stream_summary 列（流式摘要功能已移除）。
        // DROP COLUMN 要求 SQLite ≥ 3.35；Tauri 自带的 libsqlite3 满足版本。
        if table_has_column(&connection, "request_logs", "stream_summary")? {
            connection.execute("ALTER TABLE request_logs DROP COLUMN stream_summary", [])?;
        }

        // 项目任务表新增任务类型 / Agent Profile / 优先级（2026-08-04）。
        // 旧库用 ADD COLUMN 补齐；status 的 CHECK 约束需要包含 review，必须重建表。
        migrate_project_tasks_schema(&connection)?;
        // 早期版本会把启动前校验 / CreateProcess 失败误记为执行轮次；保留 job 日志，
        // 但从任务执行历史与最近执行指针中移除，避免占用轮次编号。
        prune_unstarted_task_executions(&connection)?;
        // 修复早期版本执行历史从未落库的任务（见 backfill_task_execution_history 注释）。
        backfill_task_execution_history(&connection)?;
        // 为已有执行历史补执行耗时（无需重建任务，从 background_jobs 回填 finishedAt / executionMs）。
        backfill_task_execution_durations(&connection)?;
        // 多设备同步（2026-08）：目录可空化 + 工作区归属 + 任务领取租约字段。
        migrate_projects_workspace_schema(&connection)?;
        migrate_recurring_tasks_schema(&connection)?;

        tracing::info!("migrate: 完成");
        Ok(())
    }
}

fn migrate_recurring_tasks_schema(connection: &Connection) -> Result<(), StorageError> {
    connection.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS recurring_tasks (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            title TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            task_type TEXT NOT NULL CHECK (task_type IN ('code', 'readonly')),
            agent_profile TEXT NOT NULL,
            schedule_kind TEXT NOT NULL DEFAULT 'manual' CHECK (schedule_kind IN ('manual', 'daily')),
            daily_time TEXT,
            timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
            enabled INTEGER NOT NULL DEFAULT 0,
            session_policy TEXT NOT NULL DEFAULT 'fresh' CHECK (session_policy IN ('fresh', 'continue')),
            source_task_id TEXT,
            next_run_at TEXT,
            last_scheduled_for TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_recurring_tasks_due
            ON recurring_tasks(enabled, schedule_kind, next_run_at);
        CREATE TABLE IF NOT EXISTS recurring_task_runs (
            id TEXT PRIMARY KEY,
            recurring_task_id TEXT NOT NULL,
            project_id TEXT NOT NULL,
            trigger_source TEXT NOT NULL CHECK (trigger_source IN ('manual', 'scheduled', 'test', 'retry')),
            status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted')),
            scheduled_for TEXT,
            title_snapshot TEXT NOT NULL,
            description_snapshot TEXT NOT NULL DEFAULT '',
            task_type_snapshot TEXT NOT NULL,
            agent_profile_snapshot TEXT NOT NULL,
            session_policy_snapshot TEXT NOT NULL,
            job_id TEXT,
            session_id TEXT,
            error_message TEXT,
            started_at TEXT,
            finished_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (recurring_task_id) REFERENCES recurring_tasks(id) ON DELETE CASCADE,
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_recurring_task_runs_task_created
            ON recurring_task_runs(recurring_task_id, created_at DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_recurring_task_runs_scheduled_once
            ON recurring_task_runs(recurring_task_id, scheduled_for)
            WHERE trigger_source = 'scheduled' AND scheduled_for IS NOT NULL;
        "#,
    )?;
    Ok(())
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

/// 项目任务表结构迁移：补齐 task_type / agent_profile / priority 三列，
/// 并保证 status 的 CHECK 含 'draft'（草稿/已提交拆分）、priority 的 CHECK 不含 'p3'（已移除 P3 档）。
/// SQLite 修改 CHECK 需重建表；判断依据是 status CHECK 是否已含 'draft'、priority 是否仍含 'p3'。
fn migrate_project_tasks_schema(connection: &Connection) -> Result<(), StorageError> {
    for (column, definition) in [
        ("task_type", "TEXT NOT NULL DEFAULT 'code'"),
        ("agent_profile", "TEXT NOT NULL DEFAULT ''"),
        ("priority", "TEXT NOT NULL DEFAULT 'p2'"),
        ("base_task_id", "TEXT"),
        ("last_job_id", "TEXT"),
        ("rejection_reason", "TEXT"),
        ("execution_history", "TEXT"),
        // 队列置顶时间（RFC3339）：已提交待执行任务被用户「置顶」提到队列最前。
        // 设备本地字段，不参与工作区同步；任务被领取执行时清空。
        ("queue_boosted_at", "TEXT"),
    ] {
        add_column_if_missing(connection, "project_tasks", column, definition)?;
    }

    // status CHECK 是否已含 'draft'、priority 是否已移除 'p3' 且默认值已是 'p2'
    //（都满足则新 schema 已生效，无需重建）。
    let sql: String = connection.query_row(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'project_tasks'",
        [],
        |row| row.get(0),
    )?;
    if !sql.contains("'draft'") || sql.contains("'p3'") || sql.contains("DEFAULT 'p1'") {
        connection.execute_batch(
            "BEGIN;
             ALTER TABLE project_tasks RENAME TO project_tasks_legacy;
             CREATE TABLE project_tasks (
                 id            TEXT PRIMARY KEY,
                 project_id    TEXT NOT NULL,
                 title         TEXT NOT NULL,
                 description   TEXT NOT NULL DEFAULT '',
                 status        TEXT NOT NULL DEFAULT 'draft'
                               CHECK (status IN ('draft', 'submitted', 'in_progress', 'review', 'done')),
                 task_type     TEXT NOT NULL DEFAULT 'code'
                               CHECK (task_type IN ('code', 'readonly')),
                 agent_profile TEXT NOT NULL DEFAULT '',
                 priority      TEXT NOT NULL DEFAULT 'p2'
                               CHECK (priority IN ('p0', 'p1', 'p2')),
                 base_task_id  TEXT,
                 last_job_id   TEXT,
                 rejection_reason TEXT,
                 execution_history TEXT,
                 claimed_by    TEXT,
                 claimed_at    TEXT,
                 queue_boosted_at TEXT,
                 deleted       INTEGER NOT NULL DEFAULT 0,
                 created_at    TEXT NOT NULL,
                 updated_at    TEXT NOT NULL,
                 FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
             );
             INSERT INTO project_tasks (id, project_id, title, description, status, task_type, agent_profile, priority, base_task_id, last_job_id, rejection_reason, execution_history, claimed_by, claimed_at, queue_boosted_at, deleted, created_at, updated_at)
                 SELECT id, project_id, title, description,
                        CASE WHEN status = 'todo' THEN 'draft' ELSE status END,
                        COALESCE(task_type, 'code'), COALESCE(agent_profile, ''), COALESCE(priority, 'p1'), base_task_id, last_job_id, rejection_reason, execution_history, NULL, NULL, NULL, 0, created_at, updated_at
                 FROM project_tasks_legacy;
             DROP TABLE project_tasks_legacy;
             CREATE INDEX IF NOT EXISTS idx_project_tasks_project_status_updated
                 ON project_tasks(project_id, status, updated_at DESC);
             COMMIT;",
        )?;
    }

    Ok(())
}

/// 多设备同步迁移（2026-08）：
/// - `projects.directory_path` 由 NOT NULL 改为可空（远端项目未绑定本机目录）；
/// - `projects` 增加 `workspace_project_id` / `workspace_archived`（工作区归属与墓碑）；
/// - `project_tasks` 增加 `claimed_by` / `claimed_at`（跨设备领取租约）。
/// SQLite 修改列约束需重建表；`add_column_if_missing` 处理只加列的情况。
fn migrate_projects_workspace_schema(connection: &Connection) -> Result<(), StorageError> {
    // 任务表：只加列即可（新库已在建表 SQL 中声明）。
    for (column, definition) in [
        ("claimed_by", "TEXT"),
        ("claimed_at", "TEXT"),
        ("deleted", "INTEGER NOT NULL DEFAULT 0"),
    ] {
        add_column_if_missing(connection, "project_tasks", column, definition)?;
    }

    // 项目表：判断是否需要重建。旧库 directory_path 带 NOT NULL，或缺失工作区列。
    let sql: Option<String> = connection
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'projects'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    let needs_rebuild = match sql {
        Some(sql) => {
            sql.contains("directory_path TEXT NOT NULL")
                || !sql.contains("workspace_project_id")
                || !sql.contains("workspace_archived")
        }
        None => false,
    };
    if needs_rebuild {
        // 重建 projects 会连带改写 project_tasks 的外键引用（RENAME 会把引用更新为
        // legacy 名）。因此必须连同 project_tasks 一起重建，保证外键最终指向新的
        // projects 表。期间临时关闭外键强制，避免 RENAME / DROP 在级联检查上出错。
        connection.execute_batch("PRAGMA foreign_keys = OFF;")?;
        let result = connection.execute_batch(
            "BEGIN;
             ALTER TABLE project_tasks RENAME TO project_tasks_legacy;
             ALTER TABLE projects RENAME TO projects_legacy;
             CREATE TABLE projects (
                 id                   TEXT PRIMARY KEY,
                 name                 TEXT NOT NULL,
                 directory_path       TEXT,
                 workspace_project_id TEXT,
                 workspace_archived   INTEGER NOT NULL DEFAULT 0,
                 created_at           TEXT NOT NULL,
                 updated_at           TEXT NOT NULL
             );
             INSERT INTO projects (id, name, directory_path, workspace_project_id, workspace_archived, created_at, updated_at)
                 SELECT id, name, directory_path, NULL, 0, created_at, updated_at
                 FROM projects_legacy;
             DROP TABLE projects_legacy;
             CREATE TABLE project_tasks (
                 id            TEXT PRIMARY KEY,
                 project_id    TEXT NOT NULL,
                 title         TEXT NOT NULL,
                 description   TEXT NOT NULL DEFAULT '',
                 status        TEXT NOT NULL DEFAULT 'draft'
                               CHECK (status IN ('draft', 'submitted', 'in_progress', 'review', 'done')),
                 task_type     TEXT NOT NULL DEFAULT 'code'
                               CHECK (task_type IN ('code', 'readonly')),
                 agent_profile TEXT NOT NULL DEFAULT '',
                 priority      TEXT NOT NULL DEFAULT 'p2'
                               CHECK (priority IN ('p0', 'p1', 'p2')),
                 base_task_id  TEXT,
                 last_job_id   TEXT,
                 rejection_reason TEXT,
                 execution_history TEXT,
                 claimed_by    TEXT,
                 claimed_at    TEXT,
                 queue_boosted_at TEXT,
                 deleted       INTEGER NOT NULL DEFAULT 0,
                 created_at    TEXT NOT NULL,
                 updated_at    TEXT NOT NULL,
                 FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
             );
             INSERT INTO project_tasks (id, project_id, title, description, status, task_type, agent_profile, priority, base_task_id, last_job_id, rejection_reason, execution_history, claimed_by, claimed_at, queue_boosted_at, deleted, created_at, updated_at)
                 SELECT id, project_id, title, description, status, task_type, agent_profile, priority, base_task_id, last_job_id, rejection_reason, execution_history, claimed_by, claimed_at, queue_boosted_at, deleted, created_at, updated_at
                 FROM project_tasks_legacy;
             DROP TABLE project_tasks_legacy;
             CREATE INDEX IF NOT EXISTS idx_project_tasks_project_status_updated
                 ON project_tasks(project_id, status, updated_at DESC);
             COMMIT;",
        );
        let _ = connection.execute_batch("PRAGMA foreign_keys = ON;");
        result?;
    }
    // 新库缺列时兜底（与重建同一目标，幂等）。
    for (column, definition) in [
        ("workspace_project_id", "TEXT"),
        ("workspace_archived", "INTEGER NOT NULL DEFAULT 0"),
    ] {
        add_column_if_missing(connection, "projects", column, definition)?;
    }

    Ok(())
}

/// 判断历史 job 是否在 Agent 子进程成功创建前失败。
///
/// 这些错误都发生在 `spawn_agent` 返回成功之前，属于启动诊断而非执行轮次。
/// 只匹配 Flowlet 自己生成的明确错误前缀，避免误删 Agent 进程启动后的普通失败。
fn is_unstarted_agent_job_error(error: &str) -> bool {
    let error = error.trim();
    error.starts_with("无法启动 ")
        || error.starts_with("项目未绑定本机目录")
        || error.starts_with("项目绑定的本机目录不存在或不是文件夹")
        || error.starts_with("无法确定 Pi 原生会话目录")
        || error.starts_with("无法生成 Pi 会话 id")
}

/// 清理旧版本误记的“未启动轮次”。background_jobs 与事件日志完整保留，只修正任务上的
/// `execution_history` / `last_job_id` 派生索引。幂等：再次运行时已没有对应条目。
fn prune_unstarted_task_executions(connection: &Connection) -> Result<(), StorageError> {
    let mut task_stmt = connection.prepare(
        "SELECT id, execution_history FROM project_tasks
         WHERE execution_history IS NOT NULL AND trim(execution_history) != ''",
    )?;
    let tasks: Vec<(String, String)> = task_stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<Result<_, _>>()?;
    drop(task_stmt);

    for (task_id, history) in tasks {
        let Ok(entries) = serde_json::from_str::<Vec<serde_json::Value>>(&history) else {
            continue;
        };
        let original_len = entries.len();
        let mut retained = Vec::with_capacity(entries.len());
        for entry in entries {
            let remove = if let Some(job_id) = entry.get("jobId").and_then(Value::as_str) {
                let error: Option<String> = connection
                    .query_row(
                        "SELECT error_message FROM background_jobs WHERE id = ?1",
                        [job_id],
                        |row| row.get(0),
                    )
                    .optional()?
                    .flatten();
                error.as_deref().is_some_and(is_unstarted_agent_job_error)
            } else {
                false
            };
            if !remove {
                retained.push(entry);
            }
        }
        let entries = retained;
        if entries.len() == original_len {
            continue;
        }

        let last_job_id = entries
            .last()
            .and_then(|entry| entry.get("jobId"))
            .and_then(Value::as_str);
        let serialized = if entries.is_empty() {
            None
        } else {
            Some(
                serde_json::to_string(&entries)
                    .map_err(|error| StorageError::InvalidImport(error.to_string()))?,
            )
        };
        connection.execute(
            "UPDATE project_tasks SET execution_history = ?1, last_job_id = ?2 WHERE id = ?3",
            rusqlite::params![serialized, last_job_id, task_id],
        )?;
    }
    Ok(())
}

/// 任务执行历史修复（2026-08-05）：早期版本 `append_task_execution` 对 NULL 的
/// `execution_history` 用 `row.get::<_, String>()` 读取会报 `InvalidColumnType`，
/// 导致执行历史从未落库（只有 last_job_id 被记录）。这里对「有 last_job_id 但
/// execution_history 为空」的任务，按 `background_jobs` 中同名的 project-task-run
/// 记录重建历史。幂等：只补空，填充后条件不再命中；job 已清理的任务保持原样，
/// 由前端 `lastJobId` 兜底展示最近一次。
fn backfill_task_execution_history(connection: &Connection) -> Result<(), StorageError> {
    let mut task_stmt = connection.prepare(
        "SELECT id, title, last_job_id FROM project_tasks
         WHERE last_job_id IS NOT NULL
           AND (execution_history IS NULL OR trim(execution_history) = '')",
    )?;
    let tasks: Vec<(String, String, String)> = task_stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
        .collect::<Result<_, _>>()?;
    drop(task_stmt);

    for (task_id, title, current_last_job_id) in tasks {
        let job_title = format!("任务执行：{title}");
        let mut job_stmt = connection.prepare(
            "SELECT id, COALESCE(started_at, created_at), finished_at, error_message FROM background_jobs
             WHERE job_type = 'project-task-run' AND title = ?1
             ORDER BY created_at ASC, rowid ASC",
        )?;
        let jobs: Vec<(String, String, Option<String>, Option<String>)> = job_stmt
            .query_map(rusqlite::params![job_title], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            })?
            .filter_map(|row| match row {
                Ok(job) if !job.3.as_deref().is_some_and(is_unstarted_agent_job_error) => {
                    Some(Ok(job))
                }
                Ok(_) => None,
                Err(error) => Some(Err(error)),
            })
            .collect::<Result<_, _>>()?;
        drop(job_stmt);
        if jobs.is_empty() {
            let last_error: Option<String> = connection
                .query_row(
                    "SELECT error_message FROM background_jobs WHERE id = ?1",
                    [&current_last_job_id],
                    |row| row.get(0),
                )
                .optional()?
                .flatten();
            if last_error
                .as_deref()
                .is_some_and(is_unstarted_agent_job_error)
            {
                connection.execute(
                    "UPDATE project_tasks SET last_job_id = NULL WHERE id = ?1",
                    [&task_id],
                )?;
            }
            continue;
        }
        let last_job_id = jobs.last().map(|job| job.0.clone());
        let entries: Vec<serde_json::Value> = jobs
            .into_iter()
            .map(|(job_id, started_at, finished_at, _)| {
                // 历史任务无法恢复每轮进入待处理的时刻 → submittedAt 空、waitingMs 0；
                // 执行耗时从 background_jobs 的真实结束时刻推算。
                let execution_ms = finished_at
                    .as_deref()
                    .and_then(parse_epoch_millis)
                    .zip(parse_epoch_millis(&started_at))
                    .map(|(finished, started)| (finished - started).max(0));
                serde_json::json!({
                    "jobId": job_id,
                    "startedAt": started_at,
                    "submittedAt": Value::Null,
                    "finishedAt": finished_at,
                    "waitingMs": 0,
                    "executionMs": execution_ms,
                    "rejected": false,
                    "rejectionReason": null,
                    "rejectedAt": null,
                })
            })
            .collect();
        let serialized = serde_json::to_string(&entries)
            .map_err(|error| StorageError::InvalidImport(error.to_string()))?;
        connection.execute(
            "UPDATE project_tasks SET execution_history = ?1, last_job_id = ?2 WHERE id = ?3",
            rusqlite::params![serialized, last_job_id, task_id],
        )?;
    }
    Ok(())
}

/// 执行耗时回填（2026-08-05）：为「已有 execution_history 但记录缺少执行耗时」的历史任务，
/// 从 `background_jobs` 按 jobId 补上 `finishedAt` 与 `executionMs`。
/// 幂等：已有 executionMs 且 finishedAt 的记录不覆盖；job 已清理 / 仍在运行（无 finished_at）
/// 的记录保持原样，由前端实时或现有兜底逻辑处理。
fn backfill_task_execution_durations(connection: &Connection) -> Result<(), StorageError> {
    let mut task_stmt = connection.prepare(
        "SELECT id, execution_history FROM project_tasks
         WHERE execution_history IS NOT NULL AND trim(execution_history) != ''",
    )?;
    let tasks: Vec<(String, String)> = task_stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<Result<_, _>>()?;
    drop(task_stmt);

    for (task_id, history) in tasks {
        let mut entries: Vec<serde_json::Value> =
            serde_json::from_str(&history).unwrap_or_default();
        let mut changed = false;
        for entry in &mut entries {
            // 已有 executionMs 且 finishedAt → 真实值已记录，不覆盖。
            if entry.get("executionMs").is_some()
                && entry.get("finishedAt").and_then(Value::as_str).is_some()
            {
                continue;
            }
            let Some(job_id) = entry.get("jobId").and_then(Value::as_str) else {
                continue;
            };
            let Some(started_ms) = entry
                .get("startedAt")
                .and_then(Value::as_str)
                .and_then(parse_epoch_millis)
            else {
                continue;
            };
            let finished_at: Option<String> = connection
                .query_row(
                    "SELECT finished_at FROM background_jobs WHERE id = ?1",
                    [job_id],
                    |row| row.get(0),
                )
                .optional()?;
            let Some(finished_at) = finished_at else {
                continue;
            };
            let Some(finished_ms) = parse_epoch_millis(&finished_at) else {
                continue;
            };
            entry["finishedAt"] = json!(finished_at);
            entry["executionMs"] = json!((finished_ms - started_ms).max(0));
            changed = true;
        }
        if changed {
            let serialized = serde_json::to_string(&entries)
                .map_err(|error| StorageError::InvalidImport(error.to_string()))?;
            connection.execute(
                "UPDATE project_tasks SET execution_history = ?1 WHERE id = ?2",
                rusqlite::params![serialized, task_id],
            )?;
        }
    }
    Ok(())
}

/// 解析时间戳为 Unix 毫秒。支持 ISO 8601（RFC3339）与 SQLite `datetime('now')`
/// 产出的 `YYYY-MM-DD HH:MM:SS`（UTC 无时区标记）。
fn parse_epoch_millis(value: &str) -> Option<i64> {
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(value) {
        return Some(dt.timestamp_millis());
    }
    chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S")
        .ok()
        .map(|dt| dt.and_utc().timestamp_millis())
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
