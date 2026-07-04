use super::config::{AuthStrategy, ConfigBundle};
use rusqlite::Connection;
use std::{
    path::Path,
    sync::{Arc, Mutex},
};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("数据库错误: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("数据库状态锁定失败")]
    LockFailed,
}

#[path = "storage_config.rs"]
mod storage_config;
#[path = "storage_usage.rs"]
mod storage_usage;

#[derive(Clone)]
pub struct Storage {
    connection: Arc<Mutex<Connection>>,
}

impl Storage {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StorageError> {
        let connection = Connection::open(path)?;
        connection.execute_batch("PRAGMA journal_mode = WAL;")?;
        let storage = Self {
            connection: Arc::new(Mutex::new(connection)),
        };
        storage.migrate()?;
        Ok(storage)
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
            clients: self.list_clients()?,
            rules: self.list_route_rules()?,
            prices: self.list_model_prices()?,
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
        self.save_clients(&bundle.clients)?;
        self.save_route_rules(&bundle.rules)?;
        self.save_model_prices(&bundle.prices)?;
        self.save_virtual_models(&bundle.virtual_models)?;
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

        // 回收空间
        connection.execute_batch("VACUUM")?;

        Ok((deleted_logs, deleted_usage))
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

    // ─── Migration ───────────────────────────────────────────────────────────

    fn migrate(&self) -> Result<(), StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
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
                id           TEXT PRIMARY KEY,
                channel_id   TEXT NOT NULL,
                name         TEXT NOT NULL,
                api_key      TEXT NOT NULL,
                enabled      INTEGER NOT NULL DEFAULT 1,
                priority     INTEGER NOT NULL DEFAULT 0,
                remark       TEXT,
                last_used_at TEXT,
                last_error   TEXT,
                created_at   TEXT NOT NULL,
                updated_at   TEXT NOT NULL
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

            CREATE TABLE IF NOT EXISTS clients (
                id         TEXT PRIMARY KEY,
                name       TEXT NOT NULL,
                token      TEXT NOT NULL,
                app_type   TEXT NOT NULL,
                enabled    INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
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

            CREATE TABLE IF NOT EXISTS model_prices (
                id                    TEXT PRIMARY KEY,
                channel_id            TEXT NOT NULL,
                upstream_model        TEXT NOT NULL,
                input_uncached_price  REAL NOT NULL DEFAULT 0,
                input_cached_price    REAL NOT NULL DEFAULT 0,
                output_price          REAL NOT NULL DEFAULT 0,
                currency              TEXT NOT NULL,
                unit                  TEXT NOT NULL,
                source                TEXT NOT NULL DEFAULT 'preset',
                synced_at             TEXT,
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
            "#,
        )?;

        normalize_legacy_virtual_model_routes_schema(&connection)?;
        normalize_legacy_model_prices_schema(&connection)?;

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
        add_column_if_missing(
            &connection,
            "model_prices",
            "channel_id",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        add_column_if_missing(
            &connection,
            "model_prices",
            "upstream_model",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        add_column_if_missing(
            &connection,
            "model_prices",
            "input_uncached_price",
            "REAL NOT NULL DEFAULT 0",
        )?;
        add_column_if_missing(
            &connection,
            "model_prices",
            "input_cached_price",
            "REAL NOT NULL DEFAULT 0",
        )?;
        add_column_if_missing(
            &connection,
            "model_prices",
            "output_price",
            "REAL NOT NULL DEFAULT 0",
        )?;
        add_column_if_missing(
            &connection,
            "model_prices",
            "currency",
            "TEXT NOT NULL DEFAULT 'CNY'",
        )?;
        add_column_if_missing(
            &connection,
            "model_prices",
            "unit",
            "TEXT NOT NULL DEFAULT '1M tokens'",
        )?;
        add_column_if_missing(
            &connection,
            "model_prices",
            "source",
            "TEXT NOT NULL DEFAULT 'preset'",
        )?;
        add_column_if_missing(&connection, "model_prices", "synced_at", "TEXT")?;
        add_column_if_missing(
            &connection,
            "model_prices",
            "created_at",
            "TEXT NOT NULL DEFAULT ''",
        )?;
        add_column_if_missing(
            &connection,
            "model_prices",
            "updated_at",
            "TEXT NOT NULL DEFAULT ''",
        )?;

        // 渠道账号：补充 Base URL 覆盖字段
        add_column_if_missing(
            &connection,
            "channel_accounts",
            "base_url_override",
            "TEXT",
        )?;

        // 请求日志：补充详情字段（TTFB、耗时、尝试序号、请求/响应头部与 body、流式摘要）
        add_column_if_missing(&connection, "request_logs", "ttfb_ms", "INTEGER")?;
        add_column_if_missing(&connection, "request_logs", "duration_ms", "INTEGER")?;
        add_column_if_missing(
            &connection,
            "request_logs",
            "attempt_seq",
            "INTEGER NOT NULL DEFAULT 0",
        )?;
        add_column_if_missing(&connection, "request_logs", "req_headers_json", "TEXT")?;
        add_column_if_missing(&connection, "request_logs", "req_body_b64", "TEXT")?;
        add_column_if_missing(&connection, "request_logs", "res_headers_json", "TEXT")?;
        add_column_if_missing(&connection, "request_logs", "res_body_b64", "TEXT")?;
        add_column_if_missing(&connection, "request_logs", "stream_summary", "TEXT")?;
        add_column_if_missing(
            &connection,
            "request_logs",
            "is_last_attempt",
            "INTEGER NOT NULL DEFAULT 1",
        )?;

        // 写入 schema 版本
        connection.execute(
            "INSERT OR IGNORE INTO app_meta (key, value, updated_at) VALUES ('schema_version', '2026.07.01', datetime('now'))",
            [],
        )?;

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
    if !table_has_column(connection, "virtual_model_routes", "provider_name")? {
        return Ok(());
    }

    connection.execute_batch(
        r#"
        DROP TABLE IF EXISTS virtual_model_routes_legacy_migrate;
        ALTER TABLE virtual_model_routes RENAME TO virtual_model_routes_legacy_migrate;
        CREATE TABLE virtual_model_routes (
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
        DROP TABLE virtual_model_routes_legacy_migrate;
        "#,
    )?;
    Ok(())
}

fn normalize_legacy_model_prices_schema(connection: &Connection) -> Result<(), StorageError> {
    if !table_has_column(connection, "model_prices", "provider_id")? {
        return Ok(());
    }

    connection.execute_batch(
        r#"
        DROP TABLE IF EXISTS model_prices_legacy_migrate;
        ALTER TABLE model_prices RENAME TO model_prices_legacy_migrate;
        CREATE TABLE model_prices (
            id                    TEXT PRIMARY KEY,
            channel_id            TEXT NOT NULL,
            upstream_model        TEXT NOT NULL,
            input_uncached_price  REAL NOT NULL DEFAULT 0,
            input_cached_price    REAL NOT NULL DEFAULT 0,
            output_price          REAL NOT NULL DEFAULT 0,
            currency              TEXT NOT NULL,
            unit                  TEXT NOT NULL,
            source                TEXT NOT NULL DEFAULT 'preset',
            synced_at             TEXT,
            created_at            TEXT NOT NULL,
            updated_at            TEXT NOT NULL
        );
        DROP TABLE model_prices_legacy_migrate;
        "#,
    )?;
    Ok(())
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


