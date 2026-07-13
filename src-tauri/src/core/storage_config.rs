use super::{parse_auth_strategy, Storage, StorageError};
use crate::core::config::{
    ChannelAccount, ChannelModel, ChannelPreset, ClientConfig, ModelPrice, ProtocolType,
    RouteCandidate, RouteRule, VirtualModel, ACCOUNT_CREDENTIAL_HEALTHY,
    ACCOUNT_CREDENTIAL_INVALID_KEY,
};
use rusqlite::params;

impl Storage {
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

        // 读取已有的 API Key，用于检测用户是否修改了密钥。
        let mut prev_stmt =
            tx.prepare("SELECT id, api_key, credential_status FROM channel_accounts")?;
        let prev = prev_stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
            })?
            .filter_map(|row| row.ok())
            .collect::<Vec<(String, String, String)>>();
        let previous: std::collections::HashMap<String, (String, String)> = prev
            .into_iter()
            .map(|(id, key, status)| (id, (key, status)))
            .collect();
        drop(prev_stmt);

        tx.execute("DELETE FROM channel_accounts", [])?;
        for account in accounts {
            // 用户修改 API Key 后，原 invalid_key 状态不再适用，重置为 healthy 并清除错误。
            let (credential_status, last_error) = match previous.get(&account.id) {
                Some((old_key, old_status))
                    if old_key == account.api_key.as_str()
                        && old_status == ACCOUNT_CREDENTIAL_INVALID_KEY =>
                {
                    (ACCOUNT_CREDENTIAL_INVALID_KEY.to_string(), account.last_error.clone())
                }
                _ => (ACCOUNT_CREDENTIAL_HEALTHY.to_string(), None),
            };
            tx.execute(
                r#"
                INSERT INTO channel_accounts (
                    id, channel_id, name, api_key, enabled, priority,
                    remark, base_url_override, last_used_at, last_error, credential_status, created_at, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
                "#,
                params![
                    account.id,
                    account.channel_id,
                    account.name,
                    account.api_key,
                    account.enabled as i64,
                    account.priority,
                    account.remark,
                    account.base_url_override,
                    account.last_used_at,
                    last_error,
                    credential_status,
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
                    remark, base_url_override, last_used_at, last_error, credential_status, created_at, updated_at
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
                base_url_override: row.get(7)?,
                last_used_at: row.get(8)?,
                last_error: row.get(9)?,
                credential_status: row.get::<_, String>(10).unwrap_or_else(|_| "healthy".to_string()),
                created_at: row.get(11)?,
                updated_at: row.get(12)?,
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

    /// 更新账号凭证状态。返回 true 表示账号存在且已更新。
    pub fn update_account_credential_status(
        &self,
        account_id: &str,
        credential_status: &str,
    ) -> Result<bool, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let changed = connection.execute(
            "UPDATE channel_accounts SET credential_status = ?2, updated_at = datetime('now') WHERE id = ?1",
            params![account_id, credential_status],
        )?;
        Ok(changed > 0)
    }

    /// 重置账号凭证状态为 healthy（修改 API Key 或测试连接成功时调用）。
    pub fn mark_account_credential_healthy(&self, account_id: &str) -> Result<(), StorageError> {
        self.update_account_credential_status(
            account_id,
            crate::core::config::ACCOUNT_CREDENTIAL_HEALTHY,
        )
        .map(|_| ())
    }

    /// 将账号标记为 invalid_key（上游 401 或测试连接认证失败时调用）。
    pub fn mark_account_credential_invalid(&self, account_id: &str) -> Result<(), StorageError> {
        self.update_account_credential_status(
            account_id,
            crate::core::config::ACCOUNT_CREDENTIAL_INVALID_KEY,
        )
        .map(|_| ())
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

    pub fn save_route_rules(&self, rules: &[RouteRule]) -> Result<(), StorageError> {
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

    pub fn list_route_rules(&self) -> Result<Vec<RouteRule>, StorageError> {
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
            Ok(RouteRule {
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
}
