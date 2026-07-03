use super::config::{
    AccountBalanceSnapshot, AuthStrategy, ChannelAccount, ChannelModel, ChannelPreset,
    ClientConfig, ConfigBundle, ModelPrice, ProtocolType, RequestLogInput, RouteCandidate,
    UsageRecordInput, UsageSummaryRow, VirtualModel,
};
use rusqlite::{params, Connection};
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

    // ─── Channel Presets ─────────────────────────────────────────────────────

    pub fn save_channel_presets(&self, presets: &[ChannelPreset]) -> Result<(), StorageError> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let tx = connection.transaction()?;
        tx.execute("DELETE FROM channel_presets", [])?;
        for preset in presets {
            let protocols = serde_json::to_string(&preset.supported_protocols).unwrap_or_default();
            tx.execute(
                r#"
                INSERT INTO channel_presets (
                    id, name, vendor, supported_protocols, openai_base_url, anthropic_base_url,
                    openai_auth, anthropic_auth, default_model, small_model, timeout_seconds, supports_model_list,
                    supports_model_detail, supports_price_sync, supports_balance_query,
                    supports_quota_query, supports_usage_query, created_at, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)
                "#,
                params![
                    preset.id,
                    preset.name,
                    preset.vendor,
                    protocols,
                    preset.openai_base_url,
                    preset.anthropic_base_url,
                    preset.openai_auth.as_str(),
                    preset.anthropic_auth.as_str(),
                    preset.default_model,
                    preset.small_model,
                    preset.timeout_seconds,
                    preset.supports_model_list as i64,
                    preset.supports_model_detail as i64,
                    preset.supports_price_sync as i64,
                    preset.supports_balance_query as i64,
                    preset.supports_quota_query as i64,
                    preset.supports_usage_query as i64,
                    preset.created_at,
                    preset.updated_at,
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn list_channel_presets(&self) -> Result<Vec<ChannelPreset>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let mut stmt = connection.prepare(
            "SELECT id, name, vendor, supported_protocols, openai_base_url, anthropic_base_url,
                    openai_auth, anthropic_auth, default_model, small_model, timeout_seconds, supports_model_list,
                    supports_model_detail, supports_price_sync, supports_balance_query,
                    supports_quota_query, supports_usage_query, created_at, updated_at
             FROM channel_presets ORDER BY id ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            let protocols_raw: String = row.get(3)?;
            let protocols: Vec<ProtocolType> =
                serde_json::from_str(&protocols_raw).unwrap_or_default();
            Ok(ChannelPreset {
                id: row.get(0)?,
                name: row.get(1)?,
                vendor: row.get(2)?,
                supported_protocols: protocols,
                openai_base_url: row.get(4)?,
                anthropic_base_url: row.get(5)?,
                openai_auth: parse_auth_strategy(row.get::<_, String>(6)?.as_str()),
                anthropic_auth: parse_auth_strategy(row.get::<_, String>(7)?.as_str()),
                default_model: row.get(8)?,
                small_model: row.get(9)?,
                timeout_seconds: row.get(10)?,
                supports_model_list: row.get::<_, i64>(11)? != 0,
                supports_model_detail: row.get::<_, i64>(12)? != 0,
                supports_price_sync: row.get::<_, i64>(13)? != 0,
                supports_balance_query: row.get::<_, i64>(14)? != 0,
                supports_quota_query: row.get::<_, i64>(15)? != 0,
                supports_usage_query: row.get::<_, i64>(16)? != 0,
                created_at: row.get(17)?,
                updated_at: row.get(18)?,
            })
        })?;
        let mut presets = Vec::new();
        for row in rows {
            presets.push(row?);
        }
        Ok(presets)
    }

    // ─── Channel Accounts ────────────────────────────────────────────────────

    pub fn save_channel_accounts(&self, accounts: &[ChannelAccount]) -> Result<(), StorageError> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let tx = connection.transaction()?;
        tx.execute("DELETE FROM channel_accounts", [])?;
        for account in accounts {
            tx.execute(
                r#"
                INSERT INTO channel_accounts (
                    id, channel_id, name, api_key, enabled, priority,
                    remark, last_used_at, last_error, created_at, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                "#,
                params![
                    account.id,
                    account.channel_id,
                    account.name,
                    account.api_key,
                    account.enabled as i64,
                    account.priority,
                    account.remark,
                    account.last_used_at,
                    account.last_error,
                    account.created_at,
                    account.updated_at,
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn list_channel_accounts(&self) -> Result<Vec<ChannelAccount>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let mut stmt = connection.prepare(
            "SELECT id, channel_id, name, api_key, enabled, priority,
                    remark, last_used_at, last_error, created_at, updated_at
             FROM channel_accounts ORDER BY channel_id ASC, priority ASC, id ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(ChannelAccount {
                id: row.get(0)?,
                channel_id: row.get(1)?,
                name: row.get(2)?,
                api_key: row.get(3)?,
                enabled: row.get::<_, i64>(4)? != 0,
                priority: row.get(5)?,
                remark: row.get(6)?,
                last_used_at: row.get(7)?,
                last_error: row.get(8)?,
                created_at: row.get(9)?,
                updated_at: row.get(10)?,
            })
        })?;
        let mut accounts = Vec::new();
        for row in rows {
            accounts.push(row?);
        }
        Ok(accounts)
    }

    pub fn update_account_last_used(&self, account_id: &str) -> Result<(), StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        connection.execute(
            "UPDATE channel_accounts SET last_used_at = datetime('now'), last_error = NULL WHERE id = ?1",
            params![account_id],
        )?;
        Ok(())
    }

    pub fn update_account_last_error(
        &self,
        account_id: &str,
        error: &str,
    ) -> Result<(), StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        connection.execute(
            "UPDATE channel_accounts SET last_error = ?2, updated_at = datetime('now') WHERE id = ?1",
            params![account_id, error],
        )?;
        Ok(())
    }

    // ─── Channel Models ──────────────────────────────────────────────────────

    pub fn save_channel_models(&self, models: &[ChannelModel]) -> Result<(), StorageError> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let tx = connection.transaction()?;
        tx.execute("DELETE FROM channel_models", [])?;
        for model in models {
            let protocols = serde_json::to_string(&model.supported_protocols).unwrap_or_default();
            tx.execute(
                r#"
                INSERT INTO channel_models (
                    id, channel_id, model, display_name, supported_protocols,
                    context_window, max_output_tokens, supports_stream, enabled,
                    source, synced_at, created_at, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
                "#,
                params![
                    model.id,
                    model.channel_id,
                    model.model,
                    model.display_name,
                    protocols,
                    model.context_window,
                    model.max_output_tokens,
                    model.supports_stream as i64,
                    model.enabled as i64,
                    model.source,
                    model.synced_at,
                    model.created_at,
                    model.updated_at,
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn list_channel_models(&self) -> Result<Vec<ChannelModel>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let mut stmt = connection.prepare(
            "SELECT id, channel_id, model, display_name, supported_protocols,
                    context_window, max_output_tokens, supports_stream, enabled,
                    source, synced_at, created_at, updated_at
             FROM channel_models ORDER BY channel_id ASC, model ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            let protocols_raw: String = row.get(4)?;
            let protocols: Vec<ProtocolType> =
                serde_json::from_str(&protocols_raw).unwrap_or_default();
            Ok(ChannelModel {
                id: row.get(0)?,
                channel_id: row.get(1)?,
                model: row.get(2)?,
                display_name: row.get(3)?,
                supported_protocols: protocols,
                context_window: row.get(5)?,
                max_output_tokens: row.get(6)?,
                supports_stream: row.get::<_, i64>(7)? != 0,
                enabled: row.get::<_, i64>(8)? != 0,
                source: row.get(9)?,
                synced_at: row.get(10)?,
                created_at: row.get(11)?,
                updated_at: row.get(12)?,
            })
        })?;
        let mut models = Vec::new();
        for row in rows {
            models.push(row?);
        }
        Ok(models)
    }

    // ─── Clients ─────────────────────────────────────────────────────────────

    pub fn save_clients(&self, clients: &[ClientConfig]) -> Result<(), StorageError> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let tx = connection.transaction()?;
        tx.execute("DELETE FROM clients", [])?;
        for client in clients {
            tx.execute(
                r#"
                INSERT INTO clients (id, name, token, app_type, enabled, created_at, updated_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                "#,
                params![
                    client.id,
                    client.name,
                    client.token,
                    client.app_type,
                    client.enabled as i64,
                    client.created_at,
                    client.updated_at,
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn list_clients(&self) -> Result<Vec<ClientConfig>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let mut stmt = connection.prepare(
            "SELECT id, name, token, app_type, enabled, created_at, updated_at
             FROM clients ORDER BY created_at ASC, id ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(ClientConfig {
                id: row.get(0)?,
                name: row.get(1)?,
                token: row.get(2)?,
                app_type: row.get(3)?,
                enabled: row.get::<_, i64>(4)? != 0,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
            })
        })?;
        let mut clients = Vec::new();
        for row in rows {
            clients.push(row?);
        }
        Ok(clients)
    }

    // ─── Virtual Models ──────────────────────────────────────────────────────

    pub fn save_virtual_models(&self, models: &[VirtualModel]) -> Result<(), StorageError> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let tx = connection.transaction()?;
        tx.execute("DELETE FROM virtual_models", [])?;
        for model in models {
            tx.execute(
                r#"
                INSERT INTO virtual_models (id, name, protocol_type, routing_strategy, enabled, created_at, updated_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                "#,
                params![
                    model.id,
                    model.name,
                    model.protocol_type.as_str(),
                    model.routing_strategy,
                    model.enabled as i64,
                    model.created_at,
                    model.updated_at,
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn list_virtual_models(&self) -> Result<Vec<VirtualModel>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let mut stmt = connection.prepare(
            "SELECT id, name, protocol_type, routing_strategy, enabled, created_at, updated_at
             FROM virtual_models ORDER BY id ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            let protocol_raw: String = row.get(2)?;
            let protocol = match protocol_raw.as_str() {
                "anthropic" => ProtocolType::Anthropic,
                _ => ProtocolType::OpenAi,
            };
            Ok(VirtualModel {
                id: row.get(0)?,
                name: row.get(1)?,
                protocol_type: protocol,
                routing_strategy: row.get(3)?,
                enabled: row.get::<_, i64>(4)? != 0,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
            })
        })?;
        let mut models = Vec::new();
        for row in rows {
            models.push(row?);
        }
        Ok(models)
    }

    // ─── Route Candidates ────────────────────────────────────────────────────

    pub fn save_route_rules(&self, rules: &[super::config::RouteRule]) -> Result<(), StorageError> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let tx = connection.transaction()?;
        tx.execute("DELETE FROM route_rules", [])?;
        for rule in rules {
            tx.execute(
                r#"
                INSERT INTO route_rules (
                    id, name, enabled, priority, match_client_id, match_model,
                    match_protocol, target_channel_id, target_account_id,
                    target_upstream_model, created_at, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
                "#,
                params![
                    rule.id,
                    rule.name,
                    rule.enabled as i64,
                    rule.priority,
                    rule.match_client_id,
                    rule.match_model,
                    rule.match_protocol.as_ref().map(|p| p.as_str()),
                    rule.target_channel_id,
                    rule.target_account_id,
                    rule.target_upstream_model,
                    rule.created_at,
                    rule.updated_at,
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn list_route_rules(&self) -> Result<Vec<super::config::RouteRule>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let mut stmt = connection.prepare(
            "SELECT id, name, enabled, priority, match_client_id, match_model,
                    match_protocol, target_channel_id, target_account_id,
                    target_upstream_model, created_at, updated_at
             FROM route_rules ORDER BY priority ASC, id ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            let protocol_raw: Option<String> = row.get(6)?;
            let match_protocol = protocol_raw.and_then(|p| match p.as_str() {
                "anthropic" => Some(ProtocolType::Anthropic),
                "openai" => Some(ProtocolType::OpenAi),
                _ => None,
            });
            Ok(super::config::RouteRule {
                id: row.get(0)?,
                name: row.get(1)?,
                enabled: row.get::<_, i64>(2)? != 0,
                priority: row.get(3)?,
                match_client_id: row.get(4)?,
                match_model: row.get(5)?,
                match_protocol,
                target_channel_id: row.get(7)?,
                target_account_id: row.get(8)?,
                target_upstream_model: row.get(9)?,
                created_at: row.get(10)?,
                updated_at: row.get(11)?,
            })
        })?;
        let mut rules = Vec::new();
        for row in rows {
            rules.push(row?);
        }
        Ok(rules)
    }

    pub fn save_route_candidates(&self, candidates: &[RouteCandidate]) -> Result<(), StorageError> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let tx = connection.transaction()?;
        tx.execute("DELETE FROM virtual_model_routes", [])?;
        for candidate in candidates {
            tx.execute(
                r#"
                INSERT INTO virtual_model_routes (
                    id, virtual_model_id, channel_id, account_id, upstream_model,
                    client_protocol, priority, enabled, created_at, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                "#,
                params![
                    candidate.id,
                    candidate.virtual_model_id,
                    candidate.channel_id,
                    candidate.account_id,
                    candidate.upstream_model,
                    candidate.client_protocol.as_str(),
                    candidate.priority,
                    candidate.enabled as i64,
                    candidate.created_at,
                    candidate.updated_at,
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn list_route_candidates(&self) -> Result<Vec<RouteCandidate>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let mut stmt = connection.prepare(
            "SELECT id, virtual_model_id, channel_id, account_id, upstream_model,
                    client_protocol, priority, enabled, created_at, updated_at
             FROM virtual_model_routes ORDER BY virtual_model_id ASC, priority ASC, id ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            let protocol_raw: String = row.get(5)?;
            let protocol = match protocol_raw.as_str() {
                "anthropic" => ProtocolType::Anthropic,
                _ => ProtocolType::OpenAi,
            };
            Ok(RouteCandidate {
                id: row.get(0)?,
                virtual_model_id: row.get(1)?,
                channel_id: row.get(2)?,
                account_id: row.get(3)?,
                upstream_model: row.get(4)?,
                client_protocol: protocol,
                priority: row.get(6)?,
                enabled: row.get::<_, i64>(7)? != 0,
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
            })
        })?;
        let mut candidates = Vec::new();
        for row in rows {
            candidates.push(row?);
        }
        Ok(candidates)
    }

    // ─── Model Prices (三段价格) ─────────────────────────────────────────────

    pub fn save_model_prices(&self, prices: &[ModelPrice]) -> Result<(), StorageError> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let tx = connection.transaction()?;
        tx.execute("DELETE FROM model_prices", [])?;
        for price in prices {
            tx.execute(
                r#"
                INSERT INTO model_prices (
                    id, channel_id, upstream_model, input_uncached_price, input_cached_price,
                    output_price, currency, unit, source, synced_at, created_at, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
                "#,
                params![
                    price.id,
                    price.channel_id,
                    price.upstream_model,
                    price.input_uncached_price,
                    price.input_cached_price,
                    price.output_price,
                    price.currency,
                    price.unit,
                    price.source.as_str(),
                    price.synced_at,
                    price.created_at,
                    price.updated_at,
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn list_model_prices(&self) -> Result<Vec<ModelPrice>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let mut stmt = connection.prepare(
            "SELECT id, channel_id, upstream_model, input_uncached_price, input_cached_price,
                    output_price, currency, unit, source, synced_at, created_at, updated_at
             FROM model_prices ORDER BY channel_id ASC, upstream_model ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            let source_raw: String = row.get(8)?;
            let source = match source_raw.as_str() {
                "synced" => crate::core::config::PriceSource::Synced,
                "manual" => crate::core::config::PriceSource::Manual,
                _ => crate::core::config::PriceSource::Preset,
            };
            Ok(ModelPrice {
                id: row.get(0)?,
                channel_id: row.get(1)?,
                upstream_model: row.get(2)?,
                input_uncached_price: row.get(3)?,
                input_cached_price: row.get(4)?,
                output_price: row.get(5)?,
                currency: row.get(6)?,
                unit: row.get(7)?,
                source,
                synced_at: row.get(9)?,
                created_at: row.get(10)?,
                updated_at: row.get(11)?,
            })
        })?;
        let mut prices = Vec::new();
        for row in rows {
            prices.push(row?);
        }
        Ok(prices)
    }

    // ─── Account Balance Snapshots ───────────────────────────────────────────

    pub fn save_balance_snapshot(
        &self,
        snapshot: &AccountBalanceSnapshot,
    ) -> Result<(), StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        connection.execute(
            r#"
            INSERT INTO account_balance_snapshots (
                id, account_id, balance, currency, token_pack_total, token_pack_used,
                token_pack_remaining, token_pack_expire_at, source, synced_at, remark,
                created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
            "#,
            params![
                snapshot.id,
                snapshot.account_id,
                snapshot.balance,
                snapshot.currency,
                snapshot.token_pack_total,
                snapshot.token_pack_used,
                snapshot.token_pack_remaining,
                snapshot.token_pack_expire_at,
                snapshot.source,
                snapshot.synced_at,
                snapshot.remark,
                snapshot.created_at,
                snapshot.updated_at,
            ],
        )?;
        Ok(())
    }

    pub fn list_balance_snapshots(
        &self,
        account_id: &str,
    ) -> Result<Vec<AccountBalanceSnapshot>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let mut stmt = connection.prepare(
            "SELECT id, account_id, balance, currency, token_pack_total, token_pack_used,
                    token_pack_remaining, token_pack_expire_at, source, synced_at, remark,
                    created_at, updated_at
             FROM account_balance_snapshots
             WHERE account_id = ?1
             ORDER BY created_at DESC
             LIMIT 10",
        )?;
        let rows = stmt.query_map([account_id], |row| {
            Ok(AccountBalanceSnapshot {
                id: row.get(0)?,
                account_id: row.get(1)?,
                balance: row.get(2)?,
                currency: row.get(3)?,
                token_pack_total: row.get(4)?,
                token_pack_used: row.get(5)?,
                token_pack_remaining: row.get(6)?,
                token_pack_expire_at: row.get(7)?,
                source: row.get(8)?,
                synced_at: row.get(9)?,
                remark: row.get(10)?,
                created_at: row.get(11)?,
                updated_at: row.get(12)?,
            })
        })?;
        let mut snapshots = Vec::new();
        for row in rows {
            snapshots.push(row?);
        }
        Ok(snapshots)
    }

    /// 获取所有账号的最新余额快照（每个账号仅一条最新记录）
    pub fn latest_balance_snapshots(&self) -> Result<Vec<AccountBalanceSnapshot>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let mut stmt = connection.prepare(
            "SELECT s.id, s.account_id, s.balance, s.currency, s.token_pack_total, s.token_pack_used,
                    s.token_pack_remaining, s.token_pack_expire_at, s.source, s.synced_at, s.remark,
                    s.created_at, s.updated_at
             FROM account_balance_snapshots s
             INNER JOIN (
                 SELECT account_id, MAX(created_at) AS max_created
                 FROM account_balance_snapshots
                 GROUP BY account_id
             ) latest ON s.account_id = latest.account_id AND s.created_at = latest.max_created
             ORDER BY s.account_id ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(AccountBalanceSnapshot {
                id: row.get(0)?,
                account_id: row.get(1)?,
                balance: row.get(2)?,
                currency: row.get(3)?,
                token_pack_total: row.get(4)?,
                token_pack_used: row.get(5)?,
                token_pack_remaining: row.get(6)?,
                token_pack_expire_at: row.get(7)?,
                source: row.get(8)?,
                synced_at: row.get(9)?,
                remark: row.get(10)?,
                created_at: row.get(11)?,
                updated_at: row.get(12)?,
            })
        })?;
        let mut snapshots = Vec::new();
        for row in rows {
            snapshots.push(row?);
        }
        Ok(snapshots)
    }

    // ─── Request Logs ────────────────────────────────────────────────────────

    pub fn insert_request_log(&self, log: &RequestLogInput) -> Result<(), StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        connection.execute(
            r#"
            INSERT INTO request_logs (
                id, request_id, client_id, client_name, channel_id, channel_name,
                account_id, account_name, client_protocol, upstream_protocol,
                virtual_model, public_model, upstream_model, request_type, method, path,
                status, latency_ms, is_stream, error_message, fallback_count,
                route_reason, created_at
            ) VALUES (
                lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
                ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, datetime('now')
            )
            "#,
            params![
                log.request_id,
                log.client_id,
                log.client_name,
                log.channel_id,
                log.channel_name,
                log.account_id,
                log.account_name,
                log.client_protocol,
                log.upstream_protocol,
                log.virtual_model,
                log.public_model,
                log.upstream_model,
                log.request_type,
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

    pub fn list_request_logs(&self) -> Result<Vec<super::config::RequestLogRow>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let mut stmt = connection.prepare(
            r#"
            SELECT
                id, request_id, client_id, client_name, channel_id, channel_name,
                account_id, account_name, client_protocol, upstream_protocol,
                virtual_model, public_model, upstream_model, request_type, method, path,
                status, latency_ms, is_stream, error_message, fallback_count,
                route_reason, created_at
            FROM request_logs
            ORDER BY created_at DESC
            LIMIT 100
            "#,
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(super::config::RequestLogRow {
                id: row.get(0)?,
                request_id: row.get(1)?,
                client_id: row.get(2)?,
                client_name: row.get(3)?,
                channel_id: row.get(4)?,
                channel_name: row.get(5)?,
                account_id: row.get(6)?,
                account_name: row.get(7)?,
                client_protocol: row.get(8)?,
                upstream_protocol: row.get(9)?,
                virtual_model: row.get(10)?,
                public_model: row.get(11)?,
                upstream_model: row.get(12)?,
                request_type: row.get(13)?,
                method: row.get(14)?,
                path: row.get(15)?,
                status: row.get(16)?,
                latency_ms: row.get(17)?,
                is_stream: row.get::<_, i64>(18)? != 0,
                error_message: row.get(19)?,
                fallback_count: row.get(20)?,
                route_reason: row.get(21)?,
                created_at: row.get(22)?,
            })
        })?;
        let mut logs = Vec::new();
        for row in rows {
            logs.push(row?);
        }
        Ok(logs)
    }

    // ─── Usage Records ───────────────────────────────────────────────────────

    pub fn analyze_unknown_usage(&self) -> Result<usize, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let inserted = connection.execute(
            r#"
            INSERT INTO usage_records (
                id, request_id, client_id, client_name, channel_id, channel_name,
                account_id, account_name, client_protocol, upstream_protocol,
                virtual_model, upstream_model, input_tokens, input_cached_tokens,
                input_uncached_tokens, output_tokens, total_tokens, estimated_cost, analyzed_at, created_at
            )
            SELECT
                lower(hex(randomblob(16))),
                request_logs.request_id,
                request_logs.client_id,
                request_logs.client_name,
                request_logs.channel_id,
                request_logs.channel_name,
                request_logs.account_id,
                request_logs.account_name,
                request_logs.client_protocol,
                request_logs.upstream_protocol,
                request_logs.virtual_model,
                request_logs.upstream_model,
                NULL, NULL, NULL, NULL, NULL, NULL,
                datetime('now'),
                datetime('now')
            FROM request_logs
            LEFT JOIN usage_records ON usage_records.request_id = request_logs.request_id
            WHERE usage_records.id IS NULL
            "#,
            [],
        )?;
        Ok(inserted)
    }

    pub fn upsert_usage_record(&self, usage: &UsageRecordInput) -> Result<(), StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let updated = connection.execute(
            r#"
            UPDATE usage_records
            SET
                client_id = ?2,
                client_name = ?3,
                channel_id = ?4,
                channel_name = ?5,
                account_id = ?6,
                account_name = ?7,
                client_protocol = ?8,
                upstream_protocol = ?9,
                virtual_model = ?10,
                upstream_model = ?11,
                input_tokens = ?12,
                input_cached_tokens = ?13,
                input_uncached_tokens = ?14,
                output_tokens = ?15,
                total_tokens = ?16,
                analyzed_at = datetime('now')
            WHERE request_id = ?1
            "#,
            params![
                usage.request_id,
                usage.client_id,
                usage.client_name,
                usage.channel_id,
                usage.channel_name,
                usage.account_id,
                usage.account_name,
                usage.client_protocol,
                usage.upstream_protocol,
                usage.virtual_model,
                usage.upstream_model,
                usage.input_tokens,
                usage.input_cached_tokens,
                usage.input_uncached_tokens,
                usage.output_tokens,
                usage.total_tokens,
            ],
        )?;

        if updated == 0 {
            connection.execute(
                r#"
                INSERT INTO usage_records (
                    id, request_id, client_id, client_name, channel_id, channel_name,
                    account_id, account_name, client_protocol, upstream_protocol,
                    virtual_model, upstream_model, input_tokens, input_cached_tokens,
                    input_uncached_tokens, output_tokens, total_tokens, estimated_cost, analyzed_at, created_at
                ) VALUES (
                    lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
                    ?10, ?11, ?12, ?13, ?14, ?15, ?16, NULL, datetime('now'), datetime('now')
                )
                "#,
                params![
                    usage.request_id,
                    usage.client_id,
                    usage.client_name,
                    usage.channel_id,
                    usage.channel_name,
                    usage.account_id,
                    usage.account_name,
                    usage.client_protocol,
                    usage.upstream_protocol,
                    usage.virtual_model,
                    usage.upstream_model,
                    usage.input_tokens,
                    usage.input_cached_tokens,
                    usage.input_uncached_tokens,
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
                    coalesce(usage_records.input_uncached_tokens, usage_records.input_tokens, 0)
                        * model_prices.input_uncached_price / 1000000.0
                    + coalesce(usage_records.input_cached_tokens, 0)
                        * model_prices.input_cached_price / 1000000.0
                    + coalesce(usage_records.output_tokens, 0)
                        * model_prices.output_price / 1000000.0
                FROM model_prices
                WHERE model_prices.channel_id = usage_records.channel_id
                  AND model_prices.upstream_model = usage_records.upstream_model
                LIMIT 1
            )
            WHERE total_tokens IS NOT NULL
              AND EXISTS (
                SELECT 1
                FROM model_prices
                WHERE model_prices.channel_id = usage_records.channel_id
                  AND model_prices.upstream_model = usage_records.upstream_model
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
        let mut stmt = connection.prepare(
            r#"
            SELECT
                date(request_logs.created_at) AS usage_date,
                usage_records.client_id,
                usage_records.client_name,
                usage_records.channel_id,
                usage_records.channel_name,
                usage_records.account_id,
                usage_records.account_name,
                usage_records.upstream_model,
                count(*) AS request_count,
                coalesce(sum(usage_records.total_tokens), 0) AS known_tokens,
                sum(CASE WHEN usage_records.total_tokens IS NULL THEN 1 ELSE 0 END) AS unknown_count,
                coalesce(sum(usage_records.estimated_cost), 0) AS estimated_cost
            FROM usage_records
            LEFT JOIN request_logs ON request_logs.request_id = usage_records.request_id
            GROUP BY usage_date, usage_records.client_id, usage_records.channel_id,
                     usage_records.account_id, usage_records.upstream_model
            ORDER BY usage_date DESC, request_count DESC
            LIMIT 100
            "#,
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(UsageSummaryRow {
                date: row
                    .get::<_, Option<String>>(0)?
                    .unwrap_or_else(|| "未知日期".to_string()),
                client_id: row.get(1)?,
                client_name: row.get(2)?,
                channel_id: row.get(3)?,
                channel_name: row.get(4)?,
                account_id: row.get(5)?,
                account_name: row.get(6)?,
                upstream_model: row.get(7)?,
                request_count: row.get(8)?,
                known_tokens: row.get(9)?,
                unknown_count: row.get(10)?,
                estimated_cost: row.get(11)?,
            })
        })?;
        let mut summary = Vec::new();
        for row in rows {
            summary.push(row?);
        }
        Ok(summary)
    }

    // ─── Account Stats ───────────────────────────────────────────────────────

    pub fn account_stats(&self) -> Result<Vec<super::config::AccountStatsRow>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let mut stmt = connection.prepare(
            r#"
            SELECT
                rl.account_id,
                rl.account_name,
                rl.channel_id,
                rl.channel_name,
                count(*) AS total_requests,
                sum(CASE WHEN rl.status >= 200 AND rl.status < 400 THEN 1 ELSE 0 END) AS success_requests,
                sum(CASE WHEN rl.status >= 400 OR rl.error_message IS NOT NULL THEN 1 ELSE 0 END) AS failed_requests,
                CASE
                    WHEN count(*) = 0 THEN 0.0
                    ELSE round(
                        100.0 * sum(CASE WHEN rl.status >= 400 OR rl.error_message IS NOT NULL THEN 1 ELSE 0 END)
                        / count(*), 2)
                END AS failure_rate,
                coalesce(sum(rl.fallback_count), 0) AS total_fallbacks,
                coalesce(sum(ur.total_tokens), 0) AS known_tokens,
                coalesce(sum(ur.estimated_cost), 0) AS estimated_cost,
                (
                    SELECT rl2.error_message
                    FROM request_logs rl2
                    WHERE rl2.account_id = rl.account_id
                      AND rl2.error_message IS NOT NULL
                    ORDER BY rl2.created_at DESC
                    LIMIT 1
                ) AS last_error,
                (
                    SELECT rl3.created_at
                    FROM request_logs rl3
                    WHERE rl3.account_id = rl.account_id
                      AND rl3.error_message IS NOT NULL
                    ORDER BY rl3.created_at DESC
                    LIMIT 1
                ) AS last_error_at,
                max(rl.created_at) AS last_used_at
            FROM request_logs rl
            LEFT JOIN usage_records ur ON ur.request_id = rl.request_id
            WHERE rl.account_id IS NOT NULL
            GROUP BY rl.account_id
            ORDER BY total_requests DESC
            "#,
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(super::config::AccountStatsRow {
                account_id: row.get(0)?,
                account_name: row.get(1)?,
                channel_id: row.get(2)?,
                channel_name: row.get(3)?,
                total_requests: row.get(4)?,
                success_requests: row.get(5)?,
                failed_requests: row.get(6)?,
                failure_rate: row.get(7)?,
                total_fallbacks: row.get(8)?,
                known_tokens: row.get(9)?,
                estimated_cost: row.get(10)?,
                last_error: row.get(11)?,
                last_error_at: row.get(12)?,
                last_used_at: row.get(13)?,
            })
        })?;
        let mut stats = Vec::new();
        for row in rows {
            stats.push(row?);
        }
        Ok(stats)
    }

    // ─── Smart Routing Scores ────────────────────────────────────────────────

    /// 返回每个账号的综合评分（成本、延迟、成功率）
    /// 返回: Vec<(account_id, channel_id, avg_latency_ms, success_rate, estimated_cost_per_1k)>
    pub fn account_routing_scores(
        &self,
    ) -> Result<Vec<(String, String, f64, f64, f64)>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let mut stmt = connection.prepare(
            r#"
            SELECT
                rl.account_id,
                rl.channel_id,
                avg(coalesce(rl.latency_ms, 0)) AS avg_latency,
                100.0 * (1.0 - cast(sum(CASE WHEN rl.status >= 400 OR rl.error_message IS NOT NULL THEN 1 ELSE 0 END) AS REAL) / count(*)) AS success_rate,
                coalesce(sum(ur.estimated_cost), 0) / count(*) * 1000 AS cost_per_1k
            FROM request_logs rl
            LEFT JOIN usage_records ur ON ur.request_id = rl.request_id
            WHERE rl.account_id IS NOT NULL
              AND rl.created_at > datetime('now', '-7 days')
            GROUP BY rl.account_id, rl.channel_id
            HAVING count(*) >= 3
            "#,
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, f64>(2)?,
                row.get::<_, f64>(3)?,
                row.get::<_, f64>(4)?,
            ))
        })?;
        let mut results = Vec::new();
        for row in rows {
            results.push(row?);
        }
        Ok(results)
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

fn parse_auth_strategy(value: &str) -> AuthStrategy {
    match value {
        "x_api_key" => AuthStrategy::XApiKey,
        _ => AuthStrategy::Bearer,
    }
}

// 为 PriceSource 添加 as_str 方法
impl crate::core::config::PriceSource {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Preset => "preset",
            Self::Synced => "synced",
            Self::Manual => "manual",
        }
    }
}
