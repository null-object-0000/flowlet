use super::{Storage, StorageError};
use rusqlite::Connection;
use serde::Serialize;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageUsageCategory {
    pub key: String,
    pub row_count: i64,
    pub allocated_bytes: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageUsageSummary {
    pub total_bytes: i64,
    pub database_bytes: i64,
    pub wal_bytes: i64,
    pub shared_memory_bytes: i64,
    pub config_bytes: i64,
    pub categorized_bytes: i64,
    pub categories: Vec<StorageUsageCategory>,
}

impl Storage {
    /// 返回真实文件占用和按 SQLite 数据页归类的业务占用。
    ///
    /// 文件数据库使用独立只读连接读取 dbstat，不占用代理写日志所用的主连接锁，也不
    /// 遍历请求正文。SQLite 的空闲页和内部结构无法拆分到业务分类；`total_bytes` 来自
    /// 数据库及其 WAL/SHM 文件和 config.json。
    pub fn storage_usage_summary(
        &self,
        config_bytes: i64,
    ) -> Result<StorageUsageSummary, StorageError> {
        self.storage_usage_summary_with_progress(config_bytes, |_| {})
    }

    pub fn storage_usage_summary_with_progress<F>(
        &self,
        config_bytes: i64,
        mut on_progress: F,
    ) -> Result<StorageUsageSummary, StorageError>
    where
        F: FnMut(StorageUsageSummary),
    {
        let main_file_bytes = file_size(self.db_path.as_ref());
        let wal_bytes = file_size(&sidecar_path(self.db_path.as_ref(), "-wal"));
        let shared_memory_bytes = file_size(&sidecar_path(self.db_path.as_ref(), "-shm"));
        let config_bytes = config_bytes.max(0);

        if self.db_path.as_os_str() == ":memory:" {
            let connection = self
                .connection
                .lock()
                .map_err(|_| StorageError::LockFailed)?;
            summarize_connection(
                &connection,
                main_file_bytes,
                wal_bytes,
                shared_memory_bytes,
                config_bytes,
                &mut on_progress,
            )
        } else {
            let connection = Connection::open_with_flags(
                self.db_path.as_ref(),
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
                    | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )?;
            summarize_connection(
                &connection,
                main_file_bytes,
                wal_bytes,
                shared_memory_bytes,
                config_bytes,
                &mut on_progress,
            )
        }
    }
}

type TablePageStats = HashMap<String, (i64, i64)>;

fn summarize_connection<F>(
    connection: &Connection,
    main_file_bytes: i64,
    wal_bytes: i64,
    shared_memory_bytes: i64,
    config_bytes: i64,
    on_progress: &mut F,
) -> Result<StorageUsageSummary, StorageError>
where
    F: FnMut(StorageUsageSummary),
{
    let allocated_database_bytes: i64 = connection.query_row(
        "SELECT page_count * page_size FROM pragma_page_count(), pragma_page_size()",
        [],
        |row| row.get(0),
    )?;
    let database_bytes = main_file_bytes.max(allocated_database_bytes);
    let table_stats = read_table_page_stats(connection, |partial_stats| {
        on_progress(build_summary(
            partial_stats,
            database_bytes,
            wal_bytes,
            shared_memory_bytes,
            config_bytes,
            false,
        ));
    })?;
    let summary = build_summary(
        &table_stats,
        database_bytes,
        wal_bytes,
        shared_memory_bytes,
        config_bytes,
        true,
    );
    on_progress(summary.clone());
    Ok(summary)
}

fn read_table_page_stats<F>(
    connection: &Connection,
    mut on_progress: F,
) -> Result<TablePageStats, StorageError>
where
    F: FnMut(&TablePageStats),
{
    let mut statement = connection.prepare(
        r#"
        SELECT schema.tbl_name, stat.name, stat.pagetype, stat.ncell, stat.pgsize
        FROM dbstat AS stat
        JOIN sqlite_schema AS schema ON schema.name = stat.name
        WHERE schema.type IN ('table', 'index')
        "#,
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, i64>(4)?,
        ))
    })?;
    let mut stats = HashMap::new();
    let mut last_progress = Instant::now();
    for row in rows {
        let (table, object, page_type, cells, page_bytes) = row?;
        let totals = stats.entry(table.clone()).or_insert((0, 0));
        totals.1 += page_bytes;
        if object == table && page_type == "leaf" {
            totals.0 += cells;
        }
        if last_progress.elapsed() >= Duration::from_millis(50) {
            on_progress(&stats);
            last_progress = Instant::now();
        }
    }
    Ok(stats)
}

fn build_summary(
    table_stats: &TablePageStats,
    database_bytes: i64,
    wal_bytes: i64,
    shared_memory_bytes: i64,
    config_bytes: i64,
    completed: bool,
) -> StorageUsageSummary {
    let mut categories = vec![
        summarize_category(
            table_stats,
            "configuration",
            &[
                "channel_presets",
                "channel_accounts",
                "channel_models",
                "virtual_models",
                "virtual_model_routes",
                "route_rules",
                "app_meta",
            ],
        ),
        summarize_category(table_stats, "requestLogs", &["request_logs"]),
        summarize_category(
            table_stats,
            "usage",
            &["usage_records", "account_balance_snapshots"],
        ),
        summarize_category(
            table_stats,
            "agentSessions",
            &["agent_session_snapshots", "agent_source_sync_state"],
        ),
        summarize_category(
            table_stats,
            "backgroundTasks",
            &["background_jobs", "background_job_events"],
        ),
    ];
    categories[0].allocated_bytes += config_bytes;
    let categorized_bytes = categories.iter().map(|item| item.allocated_bytes).sum();
    StorageUsageSummary {
        total_bytes: if completed {
            database_bytes + wal_bytes + shared_memory_bytes + config_bytes
        } else {
            categorized_bytes
        },
        database_bytes,
        wal_bytes,
        shared_memory_bytes,
        config_bytes,
        categorized_bytes,
        categories,
    }
}

fn summarize_category(
    table_stats: &TablePageStats,
    key: &str,
    tables: &[&str],
) -> StorageUsageCategory {
    let (row_count, allocated_bytes) = tables.iter().fold((0, 0), |totals, table| {
        let current = table_stats.get(*table).copied().unwrap_or_default();
        (totals.0 + current.0, totals.1 + current.1)
    });
    StorageUsageCategory {
        key: key.to_string(),
        row_count,
        allocated_bytes,
    }
}

fn sidecar_path(path: &Path, suffix: &str) -> PathBuf {
    PathBuf::from(format!("{}{suffix}", path.to_string_lossy()))
}

fn file_size(path: &Path) -> i64 {
    std::fs::metadata(path)
        .map(|metadata| metadata.len().min(i64::MAX as u64) as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{sync::mpsc, time::Duration};

    #[test]
    fn summarizes_storage_by_business_dimension() {
        let storage = Storage::from_connection_for_test(Connection::open_in_memory().unwrap());
        storage.migrate().unwrap();
        storage
            .set_app_meta("storage-test", &"x".repeat(128))
            .unwrap();
        {
            let connection = storage.connection.lock().unwrap();
            connection
                .execute(
                    "INSERT INTO request_logs (id, request_id, client_protocol, upstream_protocol, method, path, created_at) VALUES ('log-1', 'request-1', 'openai', 'openai', 'POST', '/v1/chat/completions', '2026-01-01T00:00:00Z')",
                    [],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO usage_records (id, request_id, client_protocol, upstream_protocol, created_at) VALUES ('usage-1', 'request-1', 'openai', 'openai', '2026-01-01T00:00:00Z')",
                    [],
                )
                .unwrap();
        }

        let mut progress_updates = Vec::new();
        let summary = storage
            .storage_usage_summary_with_progress(256, |progress| progress_updates.push(progress))
            .unwrap();

        assert!(summary.total_bytes > summary.config_bytes);
        assert_eq!(summary.config_bytes, 256);
        assert_eq!(summary.categories.len(), 5);
        let request_logs = summary
            .categories
            .iter()
            .find(|category| category.key == "requestLogs")
            .unwrap();
        assert_eq!(request_logs.row_count, 1);
        assert!(request_logs.allocated_bytes > 0);
        let usage = summary
            .categories
            .iter()
            .find(|category| category.key == "usage")
            .unwrap();
        assert_eq!(usage.row_count, 1);
        assert!(summary.categorized_bytes > summary.config_bytes);
        assert_eq!(
            progress_updates.last().unwrap().total_bytes,
            summary.total_bytes
        );
    }

    #[test]
    fn file_statistics_do_not_wait_for_the_primary_connection_lock() {
        let path = std::env::temp_dir().join(format!(
            "flowlet-storage-stats-{}.sqlite",
            uuid::Uuid::new_v4()
        ));
        let storage = Storage::open(&path).unwrap();
        let primary_connection = storage.connection.lock().unwrap();
        let reader = storage.clone();
        let (sender, receiver) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let _ = sender.send(reader.storage_usage_summary(0));
        });

        let result = receiver.recv_timeout(Duration::from_secs(2));
        drop(primary_connection);
        worker.join().unwrap();
        drop(storage);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(sidecar_path(&path, "-wal"));
        let _ = std::fs::remove_file(sidecar_path(&path, "-shm"));

        assert!(
            result.is_ok(),
            "storage statistics waited for the primary connection lock"
        );
        assert!(result.unwrap().is_ok());
    }
}
