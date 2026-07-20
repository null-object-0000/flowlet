use super::{Storage, StorageError};
use crate::core::config::{
    AccountBalanceSnapshot, AccountStatsRow, AgentSessionRepairResult, AgentSessionRow,
    AgentSessionsFilter, AgentSessionsPageResult, LogFilterClient, LogsFilter, LogsPageResult,
    LogsSummary, ModelPrice, RequestLogInput, RequestLogRow, UsageRecordInput, UsageSummaryRow,
};
use crate::core::cost_ledger_source_probe::{GatewayProbeSnapshot, GatewayUsageSample};
use crate::core::usage::{extract_response_usage, extract_sse_response_usage};
use base64::Engine;
use rusqlite::params;
use std::collections::{HashMap, HashSet};

const MAX_AGENT_SESSION_ID_BYTES: usize = 512;
type AgentSessionKey = (String, String);

fn agent_session_key(row: &AgentSessionRow) -> AgentSessionKey {
    (row.agent_type.clone(), row.session_id.clone())
}

fn matching_root_session_keys(
    catalog: &[AgentSessionRow],
    search: &str,
) -> HashSet<AgentSessionKey> {
    if search.is_empty() {
        return catalog
            .iter()
            .filter(|row| row.parent_session_id.is_none())
            .map(agent_session_key)
            .collect();
    }
    let parent_by_key = catalog
        .iter()
        .filter_map(|row| {
            row.parent_session_id.as_ref().map(|parent| {
                (
                    agent_session_key(row),
                    (row.agent_type.clone(), parent.clone()),
                )
            })
        })
        .collect::<HashMap<_, _>>();
    let known_keys = catalog
        .iter()
        .map(agent_session_key)
        .collect::<HashSet<_>>();
    let mut roots = HashSet::new();

    for row in catalog
        .iter()
        .filter(|row| session_matches_search(row, search))
    {
        let mut current = agent_session_key(row);
        let mut visited = HashSet::new();
        while visited.insert(current.clone()) {
            let Some(parent) = parent_by_key.get(&current) else {
                if known_keys.contains(&current) {
                    roots.insert(current);
                }
                break;
            };
            current = parent.clone();
        }
    }
    roots
}

fn session_matches_search(row: &AgentSessionRow, search: &str) -> bool {
    row.session_id.to_lowercase().contains(search)
        || row
            .title
            .as_deref()
            .is_some_and(|value| value.to_lowercase().contains(search))
        || row
            .project_path
            .as_deref()
            .is_some_and(|value| value.to_lowercase().contains(search))
}

fn matches_agent_session_type(row: &AgentSessionRow, agent_type: &str) -> bool {
    agent_type.is_empty() || row.agent_type == agent_type
}

fn matches_agent_session_flowlet_status(row: &AgentSessionRow, flowlet_status: &str) -> bool {
    match flowlet_status {
        "" => true,
        "observed" => row.flowlet_observed,
        "native" => !row.flowlet_observed,
        _ => false,
    }
}

fn repair_time_clause(column: &str, time_range: &str) -> String {
    let condition = match time_range {
        "1h" => "datetime({column}) >= datetime('now', '-1 hour')",
        "6h" => "datetime({column}) >= datetime('now', '-6 hours')",
        "today" => {
            "datetime({column}, 'localtime') >= datetime('now', 'localtime', 'start of day')"
        }
        "7d" => "datetime({column}) >= datetime('now', '-7 days')",
        _ => "1 = 1",
    };
    condition.replace("{column}", column)
}

fn agent_session_from_json(headers_json: &str) -> Option<(String, String, Option<String>)> {
    let parsed = serde_json::from_str::<serde_json::Value>(headers_json).ok()?;
    let headers = parsed
        .as_object()?
        .iter()
        .filter_map(|(key, value)| {
            value
                .as_str()
                .map(|value| (key.to_ascii_lowercase(), value))
        })
        .collect::<std::collections::HashMap<_, _>>();
    let valid = |name: &str| {
        headers.get(name).and_then(|value| {
            let value = value.trim();
            (!value.is_empty()
                && value != "[redacted]"
                && value.len() <= MAX_AGENT_SESSION_ID_BYTES)
                .then(|| value.to_string())
        })
    };
    if let Some(session_id) = valid("x-claude-code-session-id") {
        return Some(("claude-code".to_string(), session_id, None));
    }
    let is_opencode = valid("x-opencode-session").is_some()
        || headers
            .get("user-agent")
            .is_some_and(|value| value.to_ascii_lowercase().contains("opencode/"));
    if !is_opencode {
        return None;
    }
    let session_id = valid("x-opencode-session")
        .or_else(|| valid("x-session-id"))
        .or_else(|| valid("x-session-affinity"))?;
    Some((
        "opencode".to_string(),
        session_id,
        valid("x-parent-session-id"),
    ))
}

/// 根据内存中的价格表（仅来自 config.json）计算单次用量记录的费用估算。
/// 公式与旧版 SQL 子查询一致：未命中缓存输入 / 命中缓存输入 / 输出，按每百万 token 计价。
fn estimate_cost(
    prices: &[ModelPrice],
    channel_id: Option<&str>,
    upstream_model: Option<&str>,
    input_tokens: Option<i64>,
    input_cached_tokens: Option<i64>,
    input_uncached_tokens: Option<i64>,
    input_cache_write_tokens: Option<i64>,
    output_tokens: Option<i64>,
) -> Option<f64> {
    let channel_id = channel_id?;
    let upstream_model = upstream_model?;
    let price = prices
        .iter()
        .find(|p| p.channel_id == channel_id && p.upstream_model == upstream_model)?;

    // 按请求总输入 Token 选档；无分级时回退扁平单价。
    let (uncached_price, cached_price, cache_write_price, output_price) =
        price.resolve_prices(input_tokens);

    // input_uncached_tokens 沿用旧口径（含缓存写入），计价时扣减缓存写入，
    // 避免缓存写入既按未缓存价、又按缓存写入价重复计费。
    let cache_write = input_cache_write_tokens.unwrap_or(0).max(0) as f64;
    let input_uncached =
        (input_uncached_tokens.or(input_tokens).unwrap_or(0).max(0) as f64 - cache_write).max(0.0);
    let input_cached = input_cached_tokens.unwrap_or(0).max(0) as f64;
    let output = output_tokens.unwrap_or(0).max(0) as f64;

    let cost = input_uncached * uncached_price / 1_000_000.0
        + input_cached * cached_price / 1_000_000.0
        + cache_write * cache_write_price.unwrap_or(uncached_price) / 1_000_000.0
        + output * output_price / 1_000_000.0;

    Some(cost)
}

impl Storage {
    pub(crate) fn cost_ledger_gateway_probe_snapshot(
        &self,
        sample_limit: usize,
    ) -> Result<GatewayProbeSnapshot, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let (record_count, time_range_start, time_range_end) = connection.query_row(
            r#"
            SELECT COUNT(*), MIN(created_at), MAX(created_at)
            FROM request_logs
            WHERE is_last_attempt = 1
            "#,
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        let mut statement = connection.prepare(
            r#"
            SELECT
                rl.request_id, rl.agent_type, rl.agent_session_id,
                rl.parent_agent_session_id, rl.client_id, rl.account_id,
                rl.upstream_model, rl.created_at,
                ur.input_tokens, ur.input_cached_tokens, ur.input_uncached_tokens,
                ur.output_tokens, ur.total_tokens, ur.estimated_cost,
                rl.status, rl.error_message
            FROM request_logs rl
            LEFT JOIN usage_records ur ON ur.id = (
                SELECT ur2.id
                FROM usage_records ur2
                WHERE ur2.request_id = rl.request_id
                ORDER BY ur2.analyzed_at DESC, ur2.created_at DESC, ur2.id DESC
                LIMIT 1
            )
            WHERE rl.is_last_attempt = 1
            ORDER BY rl.created_at DESC, rl.request_id DESC
            LIMIT ?1
            "#,
        )?;
        let rows = statement.query_map(params![sample_limit as i64], |row| {
            Ok(GatewayUsageSample {
                request_id: row.get(0)?,
                agent_type: row.get(1)?,
                session_id: row.get(2)?,
                parent_session_id: row.get(3)?,
                client_id: row.get(4)?,
                account_id: row.get(5)?,
                project_path: None,
                model: row.get(6)?,
                occurred_at: row.get(7)?,
                input_tokens: row.get(8)?,
                cached_input_tokens: row.get(9)?,
                uncached_input_tokens: row.get(10)?,
                output_tokens: row.get(11)?,
                total_tokens: row.get(12)?,
                estimated_cost: row.get(13)?,
                status: row.get(14)?,
                error_message: row.get(15)?,
            })
        })?;
        let samples = rows.collect::<Result<Vec<_>, _>>()?;
        Ok(GatewayProbeSnapshot {
            record_count,
            time_range_start,
            time_range_end,
            samples,
        })
    }

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
                token_pack_remaining, token_pack_expire_at, token_packs, source, synced_at, remark,
                created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
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
                snapshot.token_packs,
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
                    token_pack_remaining, token_pack_expire_at, token_packs, source, synced_at, remark,
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
                token_packs: row.get(8)?,
                source: row.get(9)?,
                synced_at: row.get(10)?,
                remark: row.get(11)?,
                created_at: row.get(12)?,
                updated_at: row.get(13)?,
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
                    s.token_pack_remaining, s.token_pack_expire_at, s.token_packs, s.source, s.synced_at, s.remark,
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
                token_packs: row.get(8)?,
                source: row.get(9)?,
                synced_at: row.get(10)?,
                remark: row.get(11)?,
                created_at: row.get(12)?,
                updated_at: row.get(13)?,
            })
        })?;
        let mut snapshots = Vec::new();
        for row in rows {
            snapshots.push(row?);
        }
        Ok(snapshots)
    }

    pub fn cleanup_orphan_balance_snapshots(&self) -> Result<usize, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let deleted = connection.execute(
            r#"
            DELETE FROM account_balance_snapshots
            WHERE account_id = 'account-default'
               OR NOT EXISTS (
                   SELECT 1
                   FROM channel_accounts
                   WHERE channel_accounts.id = account_balance_snapshots.account_id
               )
            "#,
            [],
        )?;
        Ok(deleted)
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
                id, request_id, agent_type, agent_session_id, parent_agent_session_id,
                client_id, client_name, channel_id, channel_name,
                account_id, account_name, client_protocol, upstream_protocol,
                virtual_model, public_model, upstream_model, request_type, method, path,
                status, latency_ms, is_stream, error_message, fallback_count,
                route_reason, created_at,
                ttfb_ms, duration_ms, attempt_seq, req_headers_json, req_body_b64,
                res_headers_json, res_body_b64, is_last_attempt, upstream_url
            ) VALUES (
                lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
                ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, datetime('now'),
                ?25, ?26, ?27, ?28, ?29, ?30, ?31, ?32, ?33
            )
            "#,
            params![
                log.request_id,
                log.agent_type,
                log.agent_session_id,
                log.parent_agent_session_id,
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
                log.ttfb_ms,
                log.duration_ms,
                log.attempt_seq,
                log.req_headers_json,
                log.req_body_b64,
                log.res_headers_json,
                log.res_body_b64,
                log.is_last_attempt as i64,
                log.upstream_url,
            ],
        )?;
        Ok(())
    }

    pub fn list_agent_sessions(
        &self,
        filter: AgentSessionsFilter,
    ) -> Result<AgentSessionsPageResult, StorageError> {
        let page = filter.page.max(1);
        let page_size = filter.page_size.clamp(1, 8);
        let offset = ((page - 1) * page_size) as usize;
        let search = filter.search.trim().to_lowercase();
        let agent_type = filter.agent_type.trim();
        let flowlet_status = filter.flowlet_status.trim();
        let mut catalog = crate::core::agent_session_metadata::merge_agent_session_catalog(
            self.list_observed_agent_sessions()?,
            self.list_native_agent_sessions(),
        );
        let matching_roots = matching_root_session_keys(&catalog, &search);
        catalog.retain(|row| {
            row.parent_session_id.is_none()
                && matching_roots.contains(&agent_session_key(row))
                && matches_agent_session_type(row, agent_type)
                && matches_agent_session_flowlet_status(row, flowlet_status)
        });
        catalog.sort_by(|left, right| {
            crate::core::agent_session_metadata::session_time_millis(&right.activity_at)
                .cmp(&crate::core::agent_session_metadata::session_time_millis(
                    &left.activity_at,
                ))
                .then_with(|| right.session_id.cmp(&left.session_id))
        });
        let total = catalog.len() as i64;
        let rows = catalog
            .into_iter()
            .skip(offset)
            .take(page_size as usize)
            .collect();
        Ok(AgentSessionsPageResult {
            rows,
            total,
            page,
            page_size,
        })
    }

    pub fn list_agent_session_children(
        &self,
        agent_type: &str,
        parent_session_id: &str,
    ) -> Result<Vec<AgentSessionRow>, StorageError> {
        let agent_type = agent_type.trim();
        let parent_session_id = parent_session_id.trim();
        if agent_type.is_empty() || parent_session_id.is_empty() {
            return Ok(Vec::new());
        }
        let mut rows = crate::core::agent_session_metadata::merge_agent_session_catalog(
            self.list_observed_agent_sessions()?,
            self.list_native_agent_sessions(),
        )
        .into_iter()
        .filter(|row| {
            row.agent_type == agent_type
                && row.parent_session_id.as_deref() == Some(parent_session_id)
        })
        .collect::<Vec<_>>();
        rows.sort_by(|left, right| {
            crate::core::agent_session_metadata::session_time_millis(&right.activity_at).cmp(
                &crate::core::agent_session_metadata::session_time_millis(&left.activity_at),
            )
        });
        Ok(rows)
    }

    fn list_observed_agent_sessions(&self) -> Result<Vec<AgentSessionRow>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let mut stmt = connection.prepare(
            r#"
            SELECT
                rl.agent_type,
                rl.agent_session_id,
                MAX(rl.parent_agent_session_id),
                MAX(rl.client_id),
                MAX(rl.client_name),
                MIN(rl.created_at),
                MAX(rl.created_at),
                COUNT(DISTINCT rl.request_id),
                SUM(CASE WHEN rl.status BETWEEN 200 AND 399 AND rl.error_message IS NULL THEN 1 ELSE 0 END),
                SUM(CASE WHEN rl.status BETWEEN 200 AND 399 AND rl.error_message IS NULL THEN 0 ELSE 1 END),
                COALESCE(SUM(ur.total_tokens), 0),
                COALESCE(SUM(ur.input_tokens), 0),
                COALESCE(SUM(ur.input_cached_tokens), 0),
                COALESCE(SUM(ur.input_uncached_tokens), 0),
                COALESCE(SUM(CASE WHEN ur.input_cached_tokens IS NOT NULL THEN ur.input_tokens ELSE 0 END), 0),
                COALESCE(SUM(ur.output_tokens), 0),
                SUM(CASE WHEN ur.total_tokens IS NULL THEN 1 ELSE 0 END),
                COALESCE(SUM(ur.estimated_cost), 0)
            FROM request_logs rl
            LEFT JOIN usage_records ur ON ur.request_id = rl.request_id
            WHERE rl.is_last_attempt = 1
              AND rl.agent_session_id IS NOT NULL
            GROUP BY rl.agent_type, rl.agent_session_id
            "#,
        )?;
        let rows = stmt.query_map([], |row| {
            let started_at: String = row.get(5)?;
            let updated_at: String = row.get(6)?;
            Ok(AgentSessionRow {
                agent_type: row.get(0)?,
                session_id: row.get(1)?,
                title: None,
                project_path: None,
                parent_session_id: row.get(2)?,
                client_id: row.get(3)?,
                client_name: row.get(4)?,
                native_started_at: None,
                native_updated_at: None,
                activity_at: updated_at.clone(),
                flowlet_observed: true,
                started_at,
                updated_at,
                request_count: row.get(7)?,
                success_count: row.get(8)?,
                error_count: row.get(9)?,
                known_tokens: row.get(10)?,
                input_tokens: row.get(11)?,
                input_cached_tokens: row.get(12)?,
                input_uncached_tokens: row.get(13)?,
                cache_measured_input_tokens: row.get(14)?,
                output_tokens: row.get(15)?,
                unknown_usage_count: row.get(16)?,
                estimated_cost: row.get(17)?,
                native_summary: None,
                native_synced_at: None,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    fn list_native_agent_sessions(&self) -> Vec<AgentSessionRow> {
        if self.db_path.as_ref() == std::path::Path::new(":memory:") {
            Vec::new()
        } else {
            self.enrich_native_agent_sessions(
                crate::core::agent_session_metadata::list_native_agent_sessions(),
            )
        }
    }

    pub fn list_agent_session_clients(&self) -> Result<Vec<LogFilterClient>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let mut stmt = connection.prepare(
            r#"
            SELECT COALESCE(client_id, ''), COALESCE(MAX(client_name), '未知') AS display_name
            FROM request_logs
            WHERE is_last_attempt = 1
              AND agent_session_id IS NOT NULL
            GROUP BY COALESCE(client_id, '')
            ORDER BY display_name = '未知', display_name, client_id
            "#,
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(LogFilterClient {
                id: row.get(0)?,
                name: row.get(1)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn list_request_logs(&self) -> Result<Vec<RequestLogRow>, StorageError> {
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
                route_reason, created_at,
                ttfb_ms, duration_ms, attempt_seq,
                req_headers_json, req_body_b64, res_headers_json, res_body_b64,
                is_last_attempt, ttft_ms, upstream_url
            FROM request_logs
            WHERE is_last_attempt = 1
            ORDER BY created_at DESC
            LIMIT 100
            "#,
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(RequestLogRow {
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
                ttfb_ms: row.get(23)?,
                duration_ms: row.get(24)?,
                attempt_seq: row.get(25)?,
                req_headers_json: row.get(26)?,
                req_body_b64: row.get(27)?,
                res_headers_json: row.get(28)?,
                res_body_b64: row.get(29)?,
                is_last_attempt: row.get::<_, i64>(30)? != 0,
                ttft_ms: row.get(31)?,
                upstream_url: row.get(32)?,
                input_tokens: None,
                input_cached_tokens: None,
                input_uncached_tokens: None,
                output_tokens: None,
                total_tokens: None,
                estimated_cost: None,
            })
        })?;
        let mut logs = Vec::new();
        for row in rows {
            logs.push(row?);
        }
        Ok(logs)
    }

    /// 返回请求日志中实际出现的客户端身份（client_id, client_name）。
    /// 仅前台归因：未命中 UA 规则的请求 client_id 为 NULL，以空 id + "未知" 落盘。
    /// 用空串 id 表示"未知"，便于前端作为筛选项（后端按 client_id IS NULL 过滤）。
    pub fn list_request_log_clients(&self) -> Result<Vec<LogFilterClient>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let mut stmt = connection.prepare(
            r#"
            SELECT COALESCE(client_id, '') AS client_id, COALESCE(client_name, '未知') AS client_name
            FROM request_logs
            WHERE is_last_attempt = 1
            GROUP BY COALESCE(client_id, ''), COALESCE(client_name, '未知')
            ORDER BY client_name = '未知', client_name, client_id
            "#,
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(LogFilterClient {
                id: row.get(0)?,
                name: row.get(1)?,
            })
        })?;
        let mut clients: Vec<LogFilterClient> = Vec::new();
        for row in rows {
            clients.push(row?);
        }
        Ok(clients)
    }

    /// 返回请求日志中出现过的对外模型，供日志页模型筛选使用。
    pub fn list_request_log_models(&self) -> Result<Vec<String>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let mut stmt = connection.prepare(
            r#"
            SELECT COALESCE(public_model, virtual_model) AS model
            FROM request_logs
            WHERE is_last_attempt = 1
              AND COALESCE(public_model, virtual_model, '') <> ''
            GROUP BY COALESCE(public_model, virtual_model)
            ORDER BY model
            "#,
        )?;
        let rows = stmt.query_map([], |row| row.get(0))?;
        let mut models = Vec::new();
        for row in rows {
            models.push(row?);
        }
        Ok(models)
    }

    pub fn list_request_logs_by_request_id(
        &self,
        request_id: &str,
    ) -> Result<Vec<RequestLogRow>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let mut stmt = connection.prepare(
            r#"
            SELECT
                rl.id, rl.request_id, rl.client_id, rl.client_name, rl.channel_id, rl.channel_name,
                rl.account_id, rl.account_name, rl.client_protocol, rl.upstream_protocol,
                rl.virtual_model, rl.public_model, rl.upstream_model, rl.request_type, rl.method, rl.path,
                rl.status, rl.latency_ms, rl.is_stream, rl.error_message, rl.fallback_count,
                rl.route_reason, rl.created_at,
                rl.ttfb_ms, rl.duration_ms, rl.attempt_seq,
                rl.req_headers_json, rl.req_body_b64, rl.res_headers_json, rl.res_body_b64,
                rl.is_last_attempt,
                ur.input_tokens, ur.output_tokens, ur.total_tokens, ur.estimated_cost,
                rl.ttft_ms, ur.input_cached_tokens, ur.input_uncached_tokens, rl.upstream_url
            FROM request_logs rl
            LEFT JOIN usage_records ur ON ur.request_id = rl.request_id
            WHERE rl.request_id = ?1
            ORDER BY rl.attempt_seq ASC, rl.created_at ASC
            "#,
        )?;
        let rows = stmt.query_map([request_id], |row| {
            Ok(RequestLogRow {
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
                ttfb_ms: row.get(23)?,
                duration_ms: row.get(24)?,
                attempt_seq: row.get(25)?,
                req_headers_json: row.get(26)?,
                req_body_b64: row.get(27)?,
                res_headers_json: row.get(28)?,
                res_body_b64: row.get(29)?,
                is_last_attempt: row.get::<_, i64>(30)? != 0,
                input_tokens: row.get(31)?,
                output_tokens: row.get(32)?,
                total_tokens: row.get(33)?,
                estimated_cost: row.get(34)?,
                ttft_ms: row.get(35)?,
                input_cached_tokens: row.get(36)?,
                input_uncached_tokens: row.get(37)?,
                upstream_url: row.get(38)?,
            })
        })?;
        let mut logs = Vec::new();
        for row in rows {
            logs.push(row?);
        }
        Ok(logs)
    }

    pub fn update_request_log_timing(
        &self,
        request_id: &str,
        ttfb_ms: i64,
        ttft_ms: Option<i64>,
        duration_ms: i64,
        res_headers_json: Option<String>,
        res_body_b64: Option<String>,
    ) -> Result<(), StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        connection.execute(
            r#"
            UPDATE request_logs
            SET ttfb_ms = ?2,
                ttft_ms = ?3,
                duration_ms = ?4,
                res_headers_json = ?5,
                res_body_b64 = ?6
            WHERE request_id = ?1
              AND is_last_attempt = 1
              AND is_stream = 1
            "#,
            params![
                request_id,
                ttfb_ms,
                ttft_ms,
                duration_ms,
                res_headers_json,
                res_body_b64,
            ],
        )?;
        Ok(())
    }

    pub fn get_app_meta(&self, key: &str) -> Result<Option<String>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let mut stmt = connection.prepare("SELECT value FROM app_meta WHERE key = ?1")?;
        let mut rows = stmt.query_map([key], |row| row.get::<_, String>(0))?;
        Ok(rows.next().transpose()?)
    }

    pub fn set_app_meta(&self, key: &str, value: &str) -> Result<(), StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        connection.execute(
            r#"
            INSERT INTO app_meta (key, value, updated_at)
            VALUES (?1, ?2, datetime('now'))
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
            "#,
            [key, value],
        )?;
        Ok(())
    }

    // ─── Usage Records ───────────────────────────────────────────────────────

    /// Repair historical Claude Code and OpenCode session attribution from
    /// captured request headers. Requests without captured headers cannot be recovered.
    pub fn repair_agent_sessions(
        &self,
        time_range: &str,
    ) -> Result<AgentSessionRepairResult, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let rows: Vec<(String, String)> = {
            let mut stmt = connection.prepare(&format!(
                r#"
                SELECT request_id, MAX(req_headers_json)
                FROM request_logs
                WHERE req_headers_json IS NOT NULL
                  AND {}
                GROUP BY request_id
                "#,
                repair_time_clause("created_at", time_range)
            ))?;
            let rows = stmt
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };

        let scanned_requests = rows.len();
        let mut repaired_requests = 0usize;
        let mut repaired_logs = 0usize;
        for (request_id, headers_json) in rows {
            let Some((agent_type, session_id, parent_session_id)) =
                agent_session_from_json(&headers_json)
            else {
                continue;
            };
            repaired_logs += connection.execute(
                r#"
                UPDATE request_logs
                SET agent_type = ?2,
                    agent_session_id = ?3,
                    parent_agent_session_id = ?4
                WHERE request_id = ?1
                "#,
                params![request_id, agent_type, session_id, parent_session_id],
            )?;
            repaired_requests += 1;
        }

        Ok(AgentSessionRepairResult {
            scanned_requests,
            repaired_requests,
            repaired_logs,
            skipped_requests: scanned_requests.saturating_sub(repaired_requests),
        })
    }

    /// Reparse captured response bodies in the selected period, including
    /// requests that already have known usage. Stream responses require a
    /// complete SSE `[DONE]` marker.
    pub fn reanalyze_captured_usage(&self, time_range: &str) -> Result<usize, StorageError> {
        struct CapturedUsageRow {
            request_id: String,
            client_id: Option<String>,
            client_name: Option<String>,
            channel_id: Option<String>,
            channel_name: Option<String>,
            account_id: Option<String>,
            account_name: Option<String>,
            client_protocol: String,
            upstream_protocol: String,
            virtual_model: Option<String>,
            upstream_model: Option<String>,
            is_stream: bool,
            res_body_b64: String,
        }

        let rows = {
            let connection = self
                .connection
                .lock()
                .map_err(|_| StorageError::LockFailed)?;
            let mut stmt = connection.prepare(&format!(
                r#"
                SELECT
                    rl.request_id, rl.client_id, rl.client_name,
                    rl.channel_id, rl.channel_name, rl.account_id, rl.account_name,
                    rl.client_protocol, rl.upstream_protocol,
                    rl.virtual_model, rl.upstream_model, rl.is_stream, rl.res_body_b64
                FROM request_logs rl
                WHERE rl.is_last_attempt = 1
                  AND rl.res_body_b64 IS NOT NULL
                  AND {}
                "#,
                repair_time_clause("rl.created_at", time_range)
            ))?;
            let rows = stmt
                .query_map([], |row| {
                    Ok(CapturedUsageRow {
                        request_id: row.get(0)?,
                        client_id: row.get(1)?,
                        client_name: row.get(2)?,
                        channel_id: row.get(3)?,
                        channel_name: row.get(4)?,
                        account_id: row.get(5)?,
                        account_name: row.get(6)?,
                        client_protocol: row.get(7)?,
                        upstream_protocol: row.get(8)?,
                        virtual_model: row.get(9)?,
                        upstream_model: row.get(10)?,
                        is_stream: row.get::<_, i64>(11)? != 0,
                        res_body_b64: row.get(12)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };

        let mut parsed = 0usize;
        for row in rows {
            let Ok(body) = base64::engine::general_purpose::STANDARD.decode(&row.res_body_b64)
            else {
                continue;
            };
            let usage = if row.is_stream {
                extract_sse_response_usage(&body)
            } else {
                extract_response_usage(&body)
            };
            let Some(usage) = usage else {
                continue;
            };

            self.upsert_usage_record(&UsageRecordInput {
                request_id: row.request_id,
                client_id: row.client_id,
                client_name: row.client_name,
                channel_id: row.channel_id,
                channel_name: row.channel_name,
                account_id: row.account_id,
                account_name: row.account_name,
                client_protocol: row.client_protocol,
                upstream_protocol: row.upstream_protocol,
                virtual_model: row.virtual_model,
                upstream_model: row.upstream_model,
                input_tokens: usage.input_tokens,
                input_cached_tokens: usage.input_cached_tokens,
                input_uncached_tokens: usage.input_uncached_tokens,
                input_cache_write_tokens: usage.input_cache_write_tokens,
                output_tokens: usage.output_tokens,
                total_tokens: usage.total_tokens,
            })?;
            parsed += 1;
        }

        Ok(parsed)
    }

    pub fn analyze_unknown_usage(&self, time_range: &str) -> Result<usize, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let inserted = connection.execute(
            &format!(r#"
            INSERT INTO usage_records (
                id, request_id, client_id, client_name, channel_id, channel_name,
                account_id, account_name, client_protocol, upstream_protocol,
                virtual_model, upstream_model, input_tokens, input_cached_tokens,
                input_uncached_tokens, input_cache_write_tokens, output_tokens, total_tokens, estimated_cost, analyzed_at, created_at
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
                NULL, NULL, NULL, NULL, NULL, NULL, NULL,
                datetime('now'),
                datetime('now')
            FROM request_logs
            WHERE request_logs.is_last_attempt = 1
              AND {}
              AND NOT EXISTS (
                  SELECT 1 FROM usage_records
                  WHERE usage_records.request_id = request_logs.request_id
              )
            "#, repair_time_clause("request_logs.created_at", time_range)),
            [],
        )?;
        Ok(inserted)
    }

    pub fn upsert_usage_record(&self, usage: &UsageRecordInput) -> Result<(), StorageError> {
        // 成本在 upsert 当场算掉，避免每次请求都全表 recalc（O(n·m) → O(1)）。
        // 仅在内存价格表有匹配价格时写 estimated_cost，否则留 NULL 稍后由
        // recalculate_usage_costs()（analyze_usage 触发）统一填补。
        // 先于连接锁之外读取价格快照，避免死锁（连接锁与价格锁是两把不同的锁）。
        let prices = self.prices();
        let estimated_cost = estimate_cost(
            &prices,
            usage.channel_id.as_deref(),
            usage.upstream_model.as_deref(),
            usage.input_tokens,
            usage.input_cached_tokens,
            usage.input_uncached_tokens,
            usage.input_cache_write_tokens,
            usage.output_tokens,
        );

        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;

        let updated = connection.execute(
            &format!(
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
                    input_cache_write_tokens = ?15,
                    output_tokens = ?16,
                    total_tokens = ?17,
                    estimated_cost = ?18,
                    analyzed_at = datetime('now')
                WHERE request_id = ?1
                "#,
            ),
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
                usage.input_cache_write_tokens,
                usage.output_tokens,
                usage.total_tokens,
                estimated_cost,
            ],
        )?;

        if updated == 0 {
            connection.execute(
                &format!(
                    r#"
                    INSERT INTO usage_records (
                        id, request_id, client_id, client_name, channel_id, channel_name,
                        account_id, account_name, client_protocol, upstream_protocol,
                        virtual_model, upstream_model, input_tokens, input_cached_tokens,
                        input_uncached_tokens, input_cache_write_tokens, output_tokens, total_tokens,
                        estimated_cost, analyzed_at, created_at
                    ) VALUES (
                        lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
                        ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18,
                        datetime('now'), datetime('now')
                    )
                    "#,
                ),
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
                    usage.input_cache_write_tokens,
                    usage.output_tokens,
                    usage.total_tokens,
                    estimated_cost,
                ],
            )?;
        }

        Ok(())
    }

    pub fn recalculate_usage_costs(&self, time_range: &str) -> Result<usize, StorageError> {
        // 先于连接锁之外读取价格快照，避免死锁（连接锁与价格锁是两把不同的锁）。
        let prices = self.prices();

        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;

        // 取出所有待回填的费用记录主键与用量字段，在锁外完成定价以避免长时间持锁。
        struct RecalcRow {
            request_id: String,
            channel_id: Option<String>,
            upstream_model: Option<String>,
            input_tokens: Option<i64>,
            input_cached_tokens: Option<i64>,
            input_uncached_tokens: Option<i64>,
            input_cache_write_tokens: Option<i64>,
            output_tokens: Option<i64>,
        }
        let rows: Vec<RecalcRow> = {
            let mut stmt = connection.prepare(&format!(
                "SELECT ur.request_id, ur.channel_id, ur.upstream_model, ur.input_tokens,
                        ur.input_cached_tokens, ur.input_uncached_tokens, ur.input_cache_write_tokens, ur.output_tokens
                 FROM usage_records ur
                 INNER JOIN request_logs rl ON rl.request_id = ur.request_id AND rl.is_last_attempt = 1
                 WHERE ur.total_tokens IS NOT NULL AND {}",
                repair_time_clause("rl.created_at", time_range)
            ))?;
            let rows = stmt
                .query_map([], |row| {
                    Ok(RecalcRow {
                        request_id: row.get(0)?,
                        channel_id: row.get(1)?,
                        upstream_model: row.get(2)?,
                        input_tokens: row.get(3)?,
                        input_cached_tokens: row.get(4)?,
                        input_uncached_tokens: row.get(5)?,
                        input_cache_write_tokens: row.get(6)?,
                        output_tokens: row.get(7)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };

        let mut updated = 0usize;
        for row in rows {
            let Some(cost) = estimate_cost(
                &prices,
                row.channel_id.as_deref(),
                row.upstream_model.as_deref(),
                row.input_tokens,
                row.input_cached_tokens,
                row.input_uncached_tokens,
                row.input_cache_write_tokens,
                row.output_tokens,
            ) else {
                continue;
            };
            let n = connection.execute(
                "UPDATE usage_records SET estimated_cost = ?2, analyzed_at = datetime('now')
                 WHERE request_id = ?1",
                params![row.request_id, cost],
            )?;
            updated += n;
        }
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
                strftime('%Y-%m-%d', request_logs.created_at, 'localtime') AS usage_date,
                usage_records.client_id,
                usage_records.client_name,
                usage_records.channel_id,
                usage_records.channel_name,
                usage_records.account_id,
                usage_records.account_name,
                usage_records.upstream_model,
                count(*) AS request_count,
                coalesce(sum(usage_records.total_tokens), 0) AS known_tokens,
                coalesce(sum(usage_records.input_tokens), 0) AS input_tokens,
                coalesce(sum(usage_records.input_cached_tokens), 0) AS input_cached_tokens,
                coalesce(sum(usage_records.input_uncached_tokens), 0) AS input_uncached_tokens,
                coalesce(sum(CASE WHEN usage_records.input_cached_tokens IS NOT NULL THEN usage_records.input_tokens ELSE 0 END), 0) AS cache_measured_input_tokens,
                coalesce(sum(usage_records.output_tokens), 0) AS output_tokens,
                sum(CASE WHEN usage_records.total_tokens IS NULL THEN 1 ELSE 0 END) AS unknown_count,
                coalesce(sum(usage_records.estimated_cost), 0) AS estimated_cost
            FROM usage_records
            LEFT JOIN request_logs ON request_logs.request_id = usage_records.request_id
                                  AND request_logs.is_last_attempt = 1
            GROUP BY usage_date, usage_records.client_id, usage_records.channel_id,
                     usage_records.account_id, usage_records.upstream_model
            ORDER BY usage_date DESC, request_count DESC
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
                input_tokens: row.get(10)?,
                input_cached_tokens: row.get(11)?,
                input_uncached_tokens: row.get(12)?,
                cache_measured_input_tokens: row.get(13)?,
                output_tokens: row.get(14)?,
                unknown_count: row.get(15)?,
                estimated_cost: row.get(16)?,
            })
        })?;
        let mut summary = Vec::new();
        for row in rows {
            summary.push(row?);
        }
        Ok(summary)
    }

    // ─── Account Stats ───────────────────────────────────────────────────────

    pub fn account_stats(&self) -> Result<Vec<AccountStatsRow>, StorageError> {
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
            Ok(AccountStatsRow {
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

    /// 分页 + 筛选查询请求日志（仅最后一条尝试记录）。返回分页结果 + 总数。
    ///
    /// 注意：列表查询有意排除 `req_headers_json` / `req_body_b64` / `res_headers_json` / `res_body_b64`
    /// 四个大字段（单条最多 1MB+），避免首次加载数百毫秒 ～ 数秒的卡顿。这些大字段仅在详情抽屉
    /// 通过 `list_request_logs_by_request_id` 单独拉取。
    pub fn list_request_logs_page(
        &self,
        filter: LogsFilter,
    ) -> Result<LogsPageResult, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;

        let page = filter.page.max(1);
        let page_size = filter.page_size.clamp(8, 200);

        // 收集筛选条件 + 查询参数（用 Vec<&dyn ToSql> 避免 Clone 问题）
        let mut raw_params: Vec<String> = Vec::new(); // 持有字符串生命周期（LIKE）
        let mut refs: Vec<&dyn rusqlite::ToSql> = Vec::new();

        let status_clause = match filter.status.as_str() {
            "success" => {
                Some("(rl.status >= 200 AND rl.status < 400 AND rl.error_message IS NULL)")
            }
            "error" => {
                Some("(rl.status IS NULL OR rl.status >= 400 OR rl.error_message IS NOT NULL)")
            }
            _ => None,
        };

        // 客户端筛选：空串 = 不过滤；LOG_FILTER_CLIENT_UNKNOWN = 匹配 client_id IS NULL（未知）。
        let client_clause = if filter.client_id.is_empty() {
            None
        } else if filter.client_id == crate::core::config::LOG_FILTER_CLIENT_UNKNOWN {
            Some("rl.client_id IS NULL")
        } else {
            refs.push(&filter.client_id);
            Some("rl.client_id = ?")
        };

        let channel_clause = if filter.channel_id.is_empty() {
            None
        } else {
            refs.push(&filter.channel_id);
            Some("rl.channel_id = ?")
        };

        let model_clause = if filter.model.is_empty() {
            None
        } else {
            refs.push(&filter.model);
            Some("COALESCE(rl.public_model, rl.virtual_model) = ?")
        };

        let time_clause = match filter.time_range.as_str() {
            // created_at 由 SQLite datetime('now') 统一写成 UTC 的可排序文本。
            // 不在列上套 datetime()，让 (is_last_attempt, created_at) 索引能做范围扫描。
            "1h" => Some("rl.created_at >= datetime('now', '-1 hour')"),
            "6h" => Some("rl.created_at >= datetime('now', '-6 hours')"),
            "today" => Some("rl.created_at >= datetime('now', 'localtime', 'start of day', 'utc')"),
            "7d" => Some("rl.created_at >= datetime('now', '-7 days')"),
            _ => None,
        };

        let search_clause = if filter.search.is_empty() {
            None
        } else {
            let like = format!("%{}%", filter.search);
            raw_params.push(like.clone()); // LIKE for path
            raw_params.push(filter.search.clone()); // exact request_id
            raw_params.push(like.clone()); // LIKE for error_message
            raw_params.push(like.clone()); // LIKE for model
            raw_params.push(like.clone()); // LIKE for account
            raw_params.push(like); // LIKE for Agent session
            let base = raw_params.len() - 6;
            for value in &raw_params[base..base + 6] {
                refs.push(value);
            }
            Some("(rl.path LIKE ? OR rl.request_id = ? OR rl.error_message LIKE ? OR COALESCE(rl.public_model, rl.virtual_model, '') LIKE ? OR COALESCE(rl.account_name, rl.account_id, '') LIKE ? OR COALESCE(rl.agent_session_id, '') LIKE ?)")
        };

        let mut clauses: Vec<&str> = vec!["rl.is_last_attempt = 1"];
        if let Some(c) = status_clause {
            clauses.push(c);
        }
        if let Some(c) = client_clause {
            clauses.push(c);
        }
        if let Some(c) = channel_clause {
            clauses.push(c);
        }
        if let Some(c) = model_clause {
            clauses.push(c);
        }
        if let Some(c) = time_clause {
            clauses.push(c);
        }
        if let Some(c) = search_clause {
            clauses.push(c);
        }

        let where_sql = format!("WHERE {}", clauses.join(" AND "));

        let summary_sql = format!(
            r#"
            SELECT
                COUNT(*),
                COALESCE(SUM(CASE WHEN rl.status >= 200 AND rl.status < 400 AND rl.error_message IS NULL THEN 1 ELSE 0 END), 0),
                COALESCE(SUM(CASE WHEN rl.status IS NULL OR rl.status >= 400 OR rl.error_message IS NOT NULL THEN 1 ELSE 0 END), 0),
                AVG(COALESCE(rl.duration_ms, rl.latency_ms)),
                AVG(rl.ttft_ms),
                AVG(CASE
                    WHEN ur.output_tokens IS NOT NULL
                     AND rl.ttft_ms IS NOT NULL
                     AND rl.duration_ms > rl.ttft_ms
                    THEN 1000.0 * ur.output_tokens / (rl.duration_ms - rl.ttft_ms)
                END),
                COALESCE(SUM(ur.total_tokens), 0),
                COALESCE(SUM(ur.input_tokens), 0),
                COALESCE(SUM(ur.input_cached_tokens), 0),
                COALESCE(SUM(ur.input_uncached_tokens), 0),
                CASE
                    WHEN SUM(CASE WHEN ur.input_cached_tokens IS NOT NULL THEN ur.input_tokens ELSE 0 END) > 0
                    THEN 1.0 * SUM(ur.input_cached_tokens)
                         / SUM(CASE WHEN ur.input_cached_tokens IS NOT NULL THEN ur.input_tokens ELSE 0 END)
                END,
                COALESCE(SUM(ur.estimated_cost), 0)
            FROM request_logs rl
            LEFT JOIN usage_records ur ON ur.request_id = rl.request_id
            {where_sql}
            "#,
        );
        let summary = connection.query_row(
            &summary_sql,
            rusqlite::params_from_iter(refs.iter()),
            |row| {
                Ok(LogsSummary {
                    request_count: row.get(0)?,
                    success_count: row.get(1)?,
                    error_count: row.get(2)?,
                    average_duration_ms: row.get(3)?,
                    average_ttft_ms: row.get(4)?,
                    average_output_tokens_per_second: row.get(5)?,
                    known_tokens: row.get(6)?,
                    input_tokens: row.get(7)?,
                    input_cached_tokens: row.get(8)?,
                    input_uncached_tokens: row.get(9)?,
                    cache_hit_rate: row.get(10)?,
                    estimated_cost: row.get(11)?,
                })
            },
        )?;
        // 汇总查询的 COUNT(*) 与分页总数使用完全相同的筛选条件，不再重复扫描一次日志表。
        let total = summary.request_count;

        // 分页查询
        let offset = (page as i64 - 1) * page_size as i64;
        let page_psize = page_size as i64;

        let list_sql = format!(
            r#"
            SELECT
                rl.id, rl.request_id, rl.client_id, rl.client_name, rl.channel_id, rl.channel_name,
                rl.account_id, rl.account_name, rl.client_protocol, rl.upstream_protocol,
                rl.virtual_model, rl.public_model, rl.upstream_model, rl.request_type, rl.method, rl.path,
                rl.status, rl.latency_ms, rl.is_stream, rl.error_message, rl.fallback_count,
                rl.route_reason, rl.created_at,
                rl.ttfb_ms, rl.duration_ms, rl.attempt_seq,
                rl.is_last_attempt,
                ur.input_tokens, ur.output_tokens, ur.total_tokens, ur.estimated_cost,
                rl.ttft_ms, ur.input_cached_tokens, ur.input_uncached_tokens, rl.upstream_url
            FROM request_logs rl
            LEFT JOIN usage_records ur ON ur.request_id = rl.request_id
            {where_sql}
            ORDER BY rl.created_at DESC
            LIMIT ? OFFSET ?
            "#,
        );

        let mut stmt = connection.prepare(&list_sql)?;

        // 追加 LIMIT/OFFSET
        let mut list_refs = refs.clone();
        list_refs.push(&page_psize);
        list_refs.push(&offset);

        let list_start = std::time::Instant::now();
        let rows = stmt.query_map(rusqlite::params_from_iter(list_refs.iter()), |row| {
            Ok(RequestLogRow {
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
                ttfb_ms: row.get(23)?,
                duration_ms: row.get(24)?,
                attempt_seq: row.get(25)?,
                // 列表不拉四个大字段 — 详情抽屉用 list_request_logs_by_request_id 单独拉
                req_headers_json: None,
                req_body_b64: None,
                res_headers_json: None,
                res_body_b64: None,
                is_last_attempt: row.get::<_, i64>(26)? != 0,
                input_tokens: row.get(27)?,
                output_tokens: row.get(28)?,
                total_tokens: row.get(29)?,
                estimated_cost: row.get(30)?,
                ttft_ms: row.get(31)?,
                input_cached_tokens: row.get(32)?,
                input_uncached_tokens: row.get(33)?,
                upstream_url: row.get(34)?,
            })
        })?;

        let mut results = Vec::new();
        for row in rows {
            results.push(row?);
        }
        let list_ms = list_start.elapsed().as_millis();
        if list_ms > 500 {
            tracing::warn!(
                list_ms,
                row_count = results.len(),
                "request_logs 分页查询慢"
            );
        }

        Ok(LogsPageResult {
            rows: results,
            total,
            page,
            page_size,
            summary,
        })
    }
}

#[cfg(test)]
mod agent_session_filter_tests {
    use super::*;

    fn session(agent_type: &str, flowlet_observed: bool) -> AgentSessionRow {
        AgentSessionRow {
            agent_type: agent_type.to_string(),
            session_id: "session-1".to_string(),
            title: None,
            project_path: None,
            parent_session_id: None,
            client_id: None,
            client_name: None,
            native_started_at: None,
            native_updated_at: None,
            activity_at: "2026-07-19T00:00:00Z".to_string(),
            flowlet_observed,
            started_at: "2026-07-19T00:00:00Z".to_string(),
            updated_at: "2026-07-19T00:00:00Z".to_string(),
            request_count: 0,
            success_count: 0,
            error_count: 0,
            known_tokens: 0,
            input_tokens: 0,
            input_cached_tokens: 0,
            input_uncached_tokens: 0,
            cache_measured_input_tokens: 0,
            output_tokens: 0,
            unknown_usage_count: 0,
            estimated_cost: 0.0,
            native_summary: None,
            native_synced_at: None,
        }
    }

    #[test]
    fn filters_native_sessions_by_agent_type_independently_from_flowlet_status() {
        let codex = session("codex-desktop", false);
        assert!(matches_agent_session_type(&codex, "codex-desktop"));
        assert!(matches_agent_session_flowlet_status(&codex, "native"));
        assert!(!matches_agent_session_flowlet_status(&codex, "observed"));
        assert!(!matches_agent_session_type(&codex, "opencode"));
    }

    #[test]
    fn supports_all_observed_and_native_flowlet_filters() {
        let observed = session("opencode", true);
        let native = session("opencode", false);
        assert!(matches_agent_session_flowlet_status(&observed, ""));
        assert!(matches_agent_session_flowlet_status(&native, ""));
        assert!(matches_agent_session_flowlet_status(&observed, "observed"));
        assert!(matches_agent_session_flowlet_status(&native, "native"));
    }
}

#[cfg(test)]
mod estimate_cost_tests {
    use super::*;
    use crate::core::config::ModelPriceTier;

    fn flat_price() -> ModelPrice {
        ModelPrice {
            channel_id: "qwen".to_string(),
            upstream_model: "qwen3.6-flash".to_string(),
            input_uncached_price: 1.2,
            input_cached_price: 0.0,
            output_price: 7.2,
            ..Default::default()
        }
    }

    fn tiered_price() -> ModelPrice {
        ModelPrice {
            channel_id: "qwen".to_string(),
            upstream_model: "qwen3.7-plus".to_string(),
            input_uncached_price: 1.6,
            input_cached_price: 0.32,
            output_price: 6.4,
            tiers: vec![
                ModelPriceTier {
                    up_to_input_tokens: Some(262144),
                    input_uncached_price: 1.6,
                    input_cached_price: 0.32,
                    input_cache_write_price: Some(2.0),
                    output_price: 6.4,
                },
                ModelPriceTier {
                    up_to_input_tokens: None,
                    input_uncached_price: 4.8,
                    input_cached_price: 0.96,
                    input_cache_write_price: Some(6.0),
                    output_price: 19.2,
                },
            ],
            ..Default::default()
        }
    }

    fn approx(actual: f64, expected: f64) {
        assert!(
            (actual - expected).abs() < 1e-9,
            "expected {expected}, got {actual}"
        );
    }

    #[test]
    fn uses_flat_price_when_no_tiers() {
        let prices = vec![flat_price()];
        let cost = estimate_cost(
            &prices,
            Some("qwen"),
            Some("qwen3.6-flash"),
            Some(1_000_000),
            Some(0),
            Some(1_000_000),
            None,
            Some(1_000_000),
        )
        .unwrap();
        // 1M uncached * 1.2 + 1M output * 7.2 = 1.2 + 7.2
        approx(cost, 8.4);
    }

    #[test]
    fn returns_none_without_matching_price() {
        let prices = vec![flat_price()];
        assert!(estimate_cost(
            &prices,
            Some("qwen"),
            Some("qwen3.8-max-preview"),
            Some(10),
            None,
            Some(10),
            None,
            Some(0)
        )
        .is_none());
        assert!(estimate_cost(
            &prices,
            None,
            Some("qwen3.6-flash"),
            Some(10),
            None,
            Some(10),
            None,
            Some(0)
        )
        .is_none());
    }

    #[test]
    fn selects_lower_tier_within_input_limit() {
        let prices = vec![tiered_price()];
        let cost = estimate_cost(
            &prices,
            Some("qwen"),
            Some("qwen3.7-plus"),
            Some(100_000),
            Some(0),
            Some(100_000),
            None,
            Some(10_000),
        )
        .unwrap();
        // tier ≤256k: 100k*1.6/1e6 + 10k*6.4/1e6 = 0.16 + 0.064
        approx(cost, 0.224);
    }

    #[test]
    fn selects_upper_tier_beyond_input_limit() {
        let prices = vec![tiered_price()];
        let cost = estimate_cost(
            &prices,
            Some("qwen"),
            Some("qwen3.7-plus"),
            Some(500_000),
            Some(0),
            Some(500_000),
            None,
            Some(10_000),
        )
        .unwrap();
        // tier >256k: 500k*4.8/1e6 + 10k*19.2/1e6 = 2.4 + 0.192
        approx(cost, 2.592);
    }

    #[test]
    fn tier_boundary_is_inclusive() {
        let prices = vec![tiered_price()];
        let at_limit = estimate_cost(
            &prices,
            Some("qwen"),
            Some("qwen3.7-plus"),
            Some(262144),
            Some(0),
            Some(262144),
            None,
            Some(0),
        )
        .unwrap();
        approx(at_limit, 262144.0 * 1.6 / 1_000_000.0);
        let over_limit = estimate_cost(
            &prices,
            Some("qwen"),
            Some("qwen3.7-plus"),
            Some(262145),
            Some(0),
            Some(262145),
            None,
            Some(0),
        )
        .unwrap();
        approx(over_limit, 262145.0 * 4.8 / 1_000_000.0);
    }

    #[test]
    fn prices_cache_write_separately_and_deducts_from_uncached() {
        let prices = vec![tiered_price()];
        // 总输入 100k（≤256k 档）；未缓存口径含写入 50k，其中写入 20k，缓存读取 30k，输出 10k。
        // 有效未缓存 = 50k - 20k = 30k。
        // 费用 = 30k*1.6 + 30k*0.32 + 20k*2.0 + 10k*6.4（每 1M）= 0.048 + 0.0096 + 0.04 + 0.064
        let cost = estimate_cost(
            &prices,
            Some("qwen"),
            Some("qwen3.7-plus"),
            Some(100_000),
            Some(30_000),
            Some(50_000),
            Some(20_000),
            Some(10_000),
        )
        .unwrap();
        approx(cost, 0.1616);
    }

    #[test]
    fn resolve_prices_falls_back_to_flat_without_tiers() {
        let price = flat_price();
        let (uncached, cached, cache_write, output) = price.resolve_prices(Some(999_999));
        approx(uncached, 1.2);
        approx(cached, 0.0);
        assert!(cache_write.is_none());
        approx(output, 7.2);
    }
}
