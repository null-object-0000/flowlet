use super::config::{ClientConfig, ModelPrice, ProviderConfig, SecretStorage, VirtualModelRoute};
use rusqlite::{params, Connection};
use serde::Serialize;
use std::{
    path::Path,
    sync::{Arc, Mutex},
};
use thiserror::Error;

#[derive(Debug, Clone)]
pub struct RequestLogMetadata {
    pub request_id: String,
    pub client_id: Option<String>,
    pub provider_id: Option<String>,
    pub public_model: Option<String>,
    pub virtual_model: Option<String>,
    pub upstream_model: Option<String>,
    pub method: String,
    pub path: String,
    pub status: Option<i64>,
    pub latency_ms: Option<i64>,
    pub is_stream: bool,
    pub error_message: Option<String>,
    pub fallback_count: i64,
    pub route_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct UsageSummaryRow {
    pub date: String,
    pub client_id: Option<String>,
    pub provider_id: Option<String>,
    pub upstream_model: Option<String>,
    pub request_count: i64,
    pub known_tokens: i64,
    pub unknown_count: i64,
    pub estimated_cost: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct RequestLogRow {
    pub created_at: String,
    pub client_id: Option<String>,
    pub method: String,
    pub path: String,
    pub provider_id: Option<String>,
    pub public_model: Option<String>,
    pub upstream_model: Option<String>,
    pub status: Option<i64>,
    pub latency_ms: Option<i64>,
    pub is_stream: bool,
    pub fallback_count: i64,
    pub route_reason: Option<String>,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone)]
pub struct UsageRecordInput {
    pub request_id: String,
    pub client_id: Option<String>,
    pub provider_id: Option<String>,
    pub virtual_model: Option<String>,
    pub upstream_model: Option<String>,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub total_tokens: Option<i64>,
}

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("数据库错误: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("数据库状态锁定失败")]
    LockFailed,
}

#[derive(Clone)]
pub struct Storage {
    connection: Arc<Mutex<Connection>>,
}

impl Storage {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StorageError> {
        let connection = Connection::open(path)?;
        let storage = Self {
            connection: Arc::new(Mutex::new(connection)),
        };
        storage.migrate()?;
        Ok(storage)
    }

    pub fn save_provider(&self, provider: &ProviderConfig) -> Result<(), StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        connection.execute(
            r#"
            INSERT INTO providers (
                id, name, protocol_type, base_url, auth_type, api_key, api_key_storage, default_model, upstream_timeout_seconds, enabled, created_at, updated_at
            ) VALUES (
                'default', ?1, 'openai-compatible', ?2, 'bearer', ?3, ?4, ?5, ?6, ?7, datetime('now'), datetime('now')
            )
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                base_url = excluded.base_url,
                api_key = excluded.api_key,
                api_key_storage = excluded.api_key_storage,
                default_model = excluded.default_model,
                upstream_timeout_seconds = excluded.upstream_timeout_seconds,
                enabled = excluded.enabled,
                updated_at = datetime('now')
            "#,
            params![
                provider.name,
                provider.base_url,
                provider.api_key,
                "plaintext",
                provider.default_model,
                provider.upstream_timeout_seconds as i64,
                provider.enabled as i64
            ],
        )?;
        Ok(())
    }

    pub fn get_provider(&self) -> Result<Option<ProviderConfig>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let mut statement = connection.prepare(
            r#"
            SELECT name, base_url, api_key, api_key_storage, default_model, upstream_timeout_seconds, enabled
            FROM providers
            WHERE id = 'default'
            "#,
        )?;
        let mut rows = statement.query([])?;
        let Some(row) = rows.next()? else {
            return Ok(None);
        };

        Ok(Some(ProviderConfig {
            name: row.get(0)?,
            base_url: row.get(1)?,
            api_key: row.get(2)?,
            api_key_storage: match row.get::<_, String>(3)?.as_str() {
                "plaintext" => SecretStorage::Plaintext,
                _ => SecretStorage::Plaintext,
            },
            default_model: row.get(4)?,
            upstream_timeout_seconds: row.get::<_, i64>(5)? as u64,
            enabled: row.get::<_, i64>(6)? != 0,
        }))
    }

    pub fn insert_request_log(&self, log: RequestLogMetadata) -> Result<(), StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        connection.execute(
            r#"
            INSERT INTO request_logs (
                id, request_id, client_id, provider_id, public_model, virtual_model, upstream_model, protocol_type,
                method, path, status, latency_ms, is_stream, error_message,
                fallback_count, route_reason, created_at
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, 'openai-compatible',
                ?8, ?9, ?10, ?11, ?12, ?13,
                ?14, ?15, datetime('now')
            )
            "#,
            params![
                uuid::Uuid::new_v4().to_string(),
                log.request_id,
                log.client_id,
                log.provider_id,
                log.public_model,
                log.virtual_model,
                log.upstream_model,
                log.method,
                log.path,
                log.status,
                log.latency_ms,
                log.is_stream as i64,
                log.error_message,
                log.fallback_count,
                log.route_reason,
            ],
        )?;
        Ok(())
    }

    pub fn save_virtual_model_routes(
        &self,
        routes: &[VirtualModelRoute],
    ) -> Result<(), StorageError> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let transaction = connection.transaction()?;
        transaction.execute(
            "DELETE FROM virtual_model_routes WHERE virtual_model_id = 'auto'",
            [],
        )?;

        for route in routes {
            transaction.execute(
                r#"
                INSERT INTO virtual_model_routes (
                    id, virtual_model_id, provider_id, upstream_model, priority, enabled, created_at, updated_at
                ) VALUES (
                    ?1, ?2, ?3, ?4, ?5, ?6, datetime('now'), datetime('now')
                )
                "#,
                params![
                    route.id,
                    route.virtual_model,
                    route.provider_name,
                    route.upstream_model,
                    route.priority,
                    route.enabled as i64
                ],
            )?;
        }

        transaction.commit()?;
        Ok(())
    }

    pub fn list_virtual_model_routes(&self) -> Result<Vec<VirtualModelRoute>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let mut statement = connection.prepare(
            r#"
            SELECT id, virtual_model_id, provider_id, upstream_model, priority, enabled
            FROM virtual_model_routes
            WHERE virtual_model_id = 'auto'
            ORDER BY priority ASC, id ASC
            "#,
        )?;
        let rows = statement.query_map([], |row| {
            Ok(VirtualModelRoute {
                id: row.get(0)?,
                virtual_model: row.get(1)?,
                provider_name: row.get(2)?,
                upstream_model: row.get(3)?,
                priority: row.get(4)?,
                enabled: row.get::<_, i64>(5)? != 0,
            })
        })?;

        let mut routes = Vec::new();
        for row in rows {
            routes.push(row?);
        }

        Ok(routes)
    }

    pub fn save_clients(&self, clients: &[ClientConfig]) -> Result<(), StorageError> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let transaction = connection.transaction()?;
        transaction.execute("DELETE FROM clients", [])?;

        for client in clients {
            transaction.execute(
                r#"
                INSERT INTO clients (
                    id, name, token, app_type, enabled, created_at, updated_at
                ) VALUES (
                    ?1, ?2, ?3, ?4, ?5, datetime('now'), datetime('now')
                )
                "#,
                params![
                    client.id,
                    client.name,
                    client.token,
                    client.app_type,
                    client.enabled as i64
                ],
            )?;
        }

        transaction.commit()?;
        Ok(())
    }

    pub fn list_clients(&self) -> Result<Vec<ClientConfig>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let mut statement = connection.prepare(
            r#"
            SELECT id, name, token, app_type, enabled
            FROM clients
            ORDER BY created_at ASC, id ASC
            "#,
        )?;
        let rows = statement.query_map([], |row| {
            Ok(ClientConfig {
                id: row.get(0)?,
                name: row.get(1)?,
                token: row.get(2)?,
                app_type: row.get(3)?,
                enabled: row.get::<_, i64>(4)? != 0,
            })
        })?;

        let mut clients = Vec::new();
        for row in rows {
            clients.push(row?);
        }

        Ok(clients)
    }

    pub fn save_model_prices(&self, prices: &[ModelPrice]) -> Result<(), StorageError> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let transaction = connection.transaction()?;
        transaction.execute("DELETE FROM model_prices", [])?;

        for price in prices {
            transaction.execute(
                r#"
                INSERT INTO model_prices (
                    id, provider_id, model, input_price, output_price, currency, unit, created_at, updated_at
                ) VALUES (
                    ?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now'), datetime('now')
                )
                "#,
                params![
                    price.id,
                    price.provider_id,
                    price.model,
                    price.input_price,
                    price.output_price,
                    price.currency,
                    price.unit,
                ],
            )?;
        }

        transaction.commit()?;
        Ok(())
    }

    pub fn list_model_prices(&self) -> Result<Vec<ModelPrice>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let mut statement = connection.prepare(
            r#"
            SELECT id, provider_id, model, input_price, output_price, currency, unit
            FROM model_prices
            ORDER BY provider_id ASC, model ASC
            "#,
        )?;
        let rows = statement.query_map([], |row| {
            Ok(ModelPrice {
                id: row.get(0)?,
                provider_id: row.get(1)?,
                model: row.get(2)?,
                input_price: row.get(3)?,
                output_price: row.get(4)?,
                currency: row.get(5)?,
                unit: row.get(6)?,
            })
        })?;

        let mut prices = Vec::new();
        for row in rows {
            prices.push(row?);
        }

        Ok(prices)
    }

    pub fn analyze_unknown_usage(&self) -> Result<usize, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let inserted = connection.execute(
            r#"
            INSERT INTO usage_records (
                id, request_id, client_id, provider_id, virtual_model, upstream_model,
                input_tokens, output_tokens, total_tokens, estimated_cost, analyzed_at
            )
            SELECT
                lower(hex(randomblob(16))),
                request_logs.request_id,
                request_logs.client_id,
                request_logs.provider_id,
                request_logs.virtual_model,
                request_logs.upstream_model,
                NULL,
                NULL,
                NULL,
                NULL,
                datetime('now')
            FROM request_logs
            LEFT JOIN usage_records ON usage_records.request_id = request_logs.request_id
            WHERE usage_records.id IS NULL
            "#,
            [],
        )?;
        Ok(inserted)
    }

    pub fn upsert_usage_record(&self, usage: UsageRecordInput) -> Result<(), StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let updated = connection.execute(
            r#"
            UPDATE usage_records
            SET
                client_id = ?2,
                provider_id = ?3,
                virtual_model = ?4,
                upstream_model = ?5,
                input_tokens = ?6,
                output_tokens = ?7,
                total_tokens = ?8,
                analyzed_at = datetime('now')
            WHERE request_id = ?1
            "#,
            params![
                usage.request_id,
                usage.client_id,
                usage.provider_id,
                usage.virtual_model,
                usage.upstream_model,
                usage.input_tokens,
                usage.output_tokens,
                usage.total_tokens,
            ],
        )?;

        if updated == 0 {
            connection.execute(
                r#"
                INSERT INTO usage_records (
                    id, request_id, client_id, provider_id, virtual_model, upstream_model,
                    input_tokens, output_tokens, total_tokens, estimated_cost, analyzed_at
                ) VALUES (
                    lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5,
                    ?6, ?7, ?8, NULL, datetime('now')
                )
                "#,
                params![
                    usage.request_id,
                    usage.client_id,
                    usage.provider_id,
                    usage.virtual_model,
                    usage.upstream_model,
                    usage.input_tokens,
                    usage.output_tokens,
                    usage.total_tokens,
                ],
            )?;
        }

        drop(connection);
        self.recalculate_usage_costs()?;
        Ok(())
    }

    pub fn recalculate_usage_costs(&self) -> Result<usize, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let updated = connection.execute(
            r#"
            UPDATE usage_records
            SET estimated_cost = (
                SELECT
                    coalesce(usage_records.input_tokens, 0) * model_prices.input_price / 1000000.0
                    + coalesce(usage_records.output_tokens, 0) * model_prices.output_price / 1000000.0
                FROM model_prices
                WHERE model_prices.provider_id = usage_records.provider_id
                  AND model_prices.model = usage_records.upstream_model
                LIMIT 1
            )
            WHERE total_tokens IS NOT NULL
              AND EXISTS (
                SELECT 1
                FROM model_prices
                WHERE model_prices.provider_id = usage_records.provider_id
                  AND model_prices.model = usage_records.upstream_model
              )
            "#,
            [],
        )?;
        Ok(updated)
    }

    pub fn usage_summary(&self) -> Result<Vec<UsageSummaryRow>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let mut statement = connection.prepare(
            r#"
            SELECT
                date(request_logs.created_at) AS usage_date,
                usage_records.client_id,
                usage_records.provider_id,
                usage_records.upstream_model,
                count(*) AS request_count,
                coalesce(sum(usage_records.total_tokens), 0) AS known_tokens,
                sum(CASE WHEN usage_records.total_tokens IS NULL THEN 1 ELSE 0 END) AS unknown_count,
                coalesce(sum(usage_records.estimated_cost), 0) AS estimated_cost
            FROM usage_records
            LEFT JOIN request_logs ON request_logs.request_id = usage_records.request_id
            GROUP BY usage_date, usage_records.client_id, usage_records.provider_id, usage_records.upstream_model
            ORDER BY usage_date DESC, request_count DESC
            LIMIT 100
            "#,
        )?;
        let rows = statement.query_map([], |row| {
            Ok(UsageSummaryRow {
                date: row
                    .get::<_, Option<String>>(0)?
                    .unwrap_or_else(|| "未知日期".to_string()),
                client_id: row.get(1)?,
                provider_id: row.get(2)?,
                upstream_model: row.get(3)?,
                request_count: row.get(4)?,
                known_tokens: row.get(5)?,
                unknown_count: row.get(6)?,
                estimated_cost: row.get(7)?,
            })
        })?;

        let mut summary = Vec::new();
        for row in rows {
            summary.push(row?);
        }

        Ok(summary)
    }

    pub fn list_request_logs(&self) -> Result<Vec<RequestLogRow>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let mut statement = connection.prepare(
            r#"
            SELECT
                created_at, client_id, method, path, provider_id, public_model, upstream_model,
                status, latency_ms, is_stream, fallback_count, route_reason, error_message
            FROM request_logs
            ORDER BY created_at DESC
            LIMIT 100
            "#,
        )?;
        let rows = statement.query_map([], |row| {
            Ok(RequestLogRow {
                created_at: row.get(0)?,
                client_id: row.get(1)?,
                method: row.get(2)?,
                path: row.get(3)?,
                provider_id: row.get(4)?,
                public_model: row.get(5)?,
                upstream_model: row.get(6)?,
                status: row.get(7)?,
                latency_ms: row.get(8)?,
                is_stream: row.get::<_, i64>(9)? != 0,
                fallback_count: row.get(10)?,
                route_reason: row.get(11)?,
                error_message: row.get(12)?,
            })
        })?;

        let mut logs = Vec::new();
        for row in rows {
            logs.push(row?);
        }

        Ok(logs)
    }

    fn migrate(&self) -> Result<(), StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        connection.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS providers (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                protocol_type TEXT NOT NULL,
                base_url TEXT NOT NULL,
                auth_type TEXT NOT NULL,
                api_key TEXT NOT NULL,
                api_key_storage TEXT NOT NULL DEFAULT 'plaintext',
                default_model TEXT NOT NULL,
                upstream_timeout_seconds INTEGER NOT NULL DEFAULT 120,
                enabled INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS clients (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                token TEXT NOT NULL,
                app_type TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS virtual_models (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                protocol_type TEXT NOT NULL,
                routing_strategy TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS virtual_model_routes (
                id TEXT PRIMARY KEY,
                virtual_model_id TEXT NOT NULL,
                provider_id TEXT NOT NULL,
                profile_id TEXT,
                upstream_model TEXT NOT NULL,
                priority INTEGER NOT NULL,
                cost_weight REAL NOT NULL DEFAULT 0,
                latency_weight REAL NOT NULL DEFAULT 0,
                quality_weight REAL NOT NULL DEFAULT 0,
                free_quota_first INTEGER NOT NULL DEFAULT 0,
                enabled INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS request_logs (
                id TEXT PRIMARY KEY,
                request_id TEXT NOT NULL,
                client_id TEXT,
                provider_id TEXT,
                profile_id TEXT,
                public_model TEXT,
                virtual_model TEXT,
                upstream_model TEXT,
                protocol_type TEXT NOT NULL,
                method TEXT NOT NULL,
                path TEXT NOT NULL,
                status INTEGER,
                latency_ms INTEGER,
                is_stream INTEGER NOT NULL DEFAULT 0,
                request_body_path TEXT,
                response_body_path TEXT,
                error_message TEXT,
                fallback_count INTEGER NOT NULL DEFAULT 0,
                route_reason TEXT,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS usage_records (
                id TEXT PRIMARY KEY,
                request_id TEXT NOT NULL,
                client_id TEXT,
                provider_id TEXT,
                virtual_model TEXT,
                upstream_model TEXT,
                input_tokens INTEGER,
                output_tokens INTEGER,
                total_tokens INTEGER,
                estimated_cost REAL,
                analyzed_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS model_prices (
                id TEXT PRIMARY KEY,
                provider_id TEXT NOT NULL,
                model TEXT NOT NULL,
                input_price REAL NOT NULL,
                output_price REAL NOT NULL,
                currency TEXT NOT NULL,
                unit TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            "#,
        )?;
        add_column_if_missing(
            &connection,
            "request_logs",
            "public_model",
            "ALTER TABLE request_logs ADD COLUMN public_model TEXT",
        )?;
        add_column_if_missing(
            &connection,
            "providers",
            "api_key_storage",
            "ALTER TABLE providers ADD COLUMN api_key_storage TEXT NOT NULL DEFAULT 'plaintext'",
        )?;
        add_column_if_missing(
            &connection,
            "providers",
            "upstream_timeout_seconds",
            "ALTER TABLE providers ADD COLUMN upstream_timeout_seconds INTEGER NOT NULL DEFAULT 120",
        )?;
        Ok(())
    }
}

fn add_column_if_missing(
    connection: &Connection,
    table: &str,
    column: &str,
    sql: &str,
) -> Result<(), StorageError> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = statement.query_map([], |row| row.get::<_, String>(1))?;

    for existing in columns {
        if existing? == column {
            return Ok(());
        }
    }

    connection.execute(sql, [])?;
    Ok(())
}
