use super::{Storage, StorageError};
use serde::Serialize;

pub(super) const SCHEDULED_INCREMENTAL_VACUUM_BYTES: i64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseMaintenanceStats {
    pub database_bytes: i64,
    pub page_size: i64,
    pub page_count: i64,
    pub freelist_count: i64,
    pub reclaimable_bytes: i64,
    pub auto_vacuum_mode: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseCompactionResult {
    pub before: DatabaseMaintenanceStats,
    pub after: DatabaseMaintenanceStats,
    pub reclaimed_bytes: i64,
}

impl Storage {
    pub fn database_maintenance_stats(&self) -> Result<DatabaseMaintenanceStats, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        read_maintenance_stats(&connection)
    }

    /// 一次性完整压缩现有数据库，并切换到增量 auto-vacuum。
    ///
    /// SQLite 的 VACUUM 自身具备失败原子性：磁盘不足或执行失败时保留原数据库。
    /// 调用方必须先暂停代理，避免重写数据库期间积压日志写入。
    pub fn compact_database(&self) -> Result<DatabaseCompactionResult, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let before = read_maintenance_stats(&connection)?;

        connection.execute_batch(
            "PRAGMA wal_checkpoint(TRUNCATE);\
             PRAGMA auto_vacuum = INCREMENTAL;\
             VACUUM;\
             PRAGMA wal_checkpoint(TRUNCATE);",
        )?;

        let after = read_maintenance_stats(&connection)?;
        Ok(DatabaseCompactionResult {
            reclaimed_bytes: (before.database_bytes - after.database_bytes).max(0),
            before,
            after,
        })
    }

    /// 在已启用增量 auto-vacuum 的数据库上限量回收空闲页。
    /// 返回本轮数据库页实际缩小的字节数；旧库尚未完整压缩时返回 0。
    pub fn incremental_vacuum(&self, max_bytes: i64) -> Result<i64, StorageError> {
        if max_bytes <= 0 {
            return Ok(0);
        }
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let before = read_maintenance_stats(&connection)?;
        if before.auto_vacuum_mode != 2 || before.freelist_count == 0 {
            return Ok(0);
        }

        let max_pages = ((max_bytes + before.page_size - 1) / before.page_size)
            .max(1)
            .min(before.freelist_count);
        connection.execute_batch(&format!(
            "PRAGMA incremental_vacuum({max_pages}); PRAGMA wal_checkpoint(PASSIVE);"
        ))?;
        let after = read_maintenance_stats(&connection)?;
        Ok((before.database_bytes - after.database_bytes).max(0))
    }
}

fn read_maintenance_stats(
    connection: &rusqlite::Connection,
) -> Result<DatabaseMaintenanceStats, StorageError> {
    let page_size = connection.query_row("PRAGMA page_size", [], |row| row.get::<_, i64>(0))?;
    let page_count = connection.query_row("PRAGMA page_count", [], |row| row.get::<_, i64>(0))?;
    let freelist_count =
        connection.query_row("PRAGMA freelist_count", [], |row| row.get::<_, i64>(0))?;
    let auto_vacuum_mode =
        connection.query_row("PRAGMA auto_vacuum", [], |row| row.get::<_, i64>(0))?;
    Ok(DatabaseMaintenanceStats {
        database_bytes: page_count.saturating_mul(page_size),
        page_size,
        page_count,
        freelist_count,
        reclaimable_bytes: freelist_count.saturating_mul(page_size),
        auto_vacuum_mode,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn remove_database_files(path: &std::path::Path) {
        for suffix in ["", "-wal", "-shm"] {
            let candidate = std::path::PathBuf::from(format!("{}{suffix}", path.display()));
            let _ = std::fs::remove_file(candidate);
        }
    }

    #[test]
    fn new_database_uses_incremental_auto_vacuum() {
        let path = std::env::temp_dir().join(format!(
            "flowlet-auto-vacuum-{}.sqlite",
            uuid::Uuid::new_v4()
        ));
        let storage = Storage::open(&path).unwrap();
        assert_eq!(
            storage
                .database_maintenance_stats()
                .unwrap()
                .auto_vacuum_mode,
            2
        );
        drop(storage);
        remove_database_files(&path);
    }

    #[test]
    fn full_compaction_reclaims_legacy_free_pages_and_enables_incremental_mode() {
        let path =
            std::env::temp_dir().join(format!("flowlet-compact-{}.sqlite", uuid::Uuid::new_v4()));
        {
            let connection = Connection::open(&path).unwrap();
            connection
                .execute_batch(
                    "CREATE TABLE payloads (id INTEGER PRIMARY KEY, body BLOB);\
                     BEGIN;\
                     INSERT INTO payloads(body) VALUES (zeroblob(4194304));\
                     COMMIT;\
                     DELETE FROM payloads;",
                )
                .unwrap();
            assert_eq!(
                connection
                    .query_row("PRAGMA auto_vacuum", [], |row| row.get::<_, i64>(0))
                    .unwrap(),
                0
            );
        }

        let storage = Storage::open(&path).unwrap();
        let result = storage.compact_database().unwrap();
        // Storage::open 的 schema 迁移会复用一部分刚释放的页，因此这里只验证
        // 仍有显著空闲空间且完整压缩确实将其归还给文件系统。
        assert!(result.before.reclaimable_bytes >= 1024 * 1024);
        assert!(result.reclaimed_bytes >= 1024 * 1024);
        assert_eq!(result.after.auto_vacuum_mode, 2);
        assert_eq!(result.after.freelist_count, 0);
        drop(storage);
        remove_database_files(&path);
    }

    #[test]
    fn incremental_vacuum_respects_the_per_run_byte_limit() {
        let path = std::env::temp_dir().join(format!(
            "flowlet-incremental-vacuum-{}.sqlite",
            uuid::Uuid::new_v4()
        ));
        let storage = Storage::open(&path).unwrap();
        {
            let connection = storage.connection.lock().unwrap();
            connection
                .execute_batch(
                    "CREATE TABLE incremental_payloads (id INTEGER PRIMARY KEY, body BLOB);\
                     INSERT INTO incremental_payloads(body) VALUES (zeroblob(4194304));\
                     DELETE FROM incremental_payloads;",
                )
                .unwrap();
        }

        let limit = 1024 * 1024;
        let reclaimed = storage.incremental_vacuum(limit).unwrap();
        let page_size = storage.database_maintenance_stats().unwrap().page_size;
        assert!(reclaimed > 0);
        assert!(reclaimed <= limit + page_size);

        drop(storage);
        remove_database_files(&path);
    }
}
