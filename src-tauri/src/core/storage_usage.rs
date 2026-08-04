use super::request_capture::{RequestCapturePointer, RequestCaptureRecord};
use super::{Storage, StorageError};
use crate::core::agent_session_identity::from_header_json;
use crate::core::channels_config::{canonical_model_key, official_channel_id_for_model};
use crate::core::config::{
    AccountBalanceSnapshot, AccountStatsRow, AgentNativeUsageSummaryRow, AgentSessionRepairResult,
    AgentSessionRow, AgentSessionsFilter, AgentSessionsPageResult, AgentUsageEvent,
    DeviceUsageBreakdownRow, LogFilterClient, LogsFilter, LogsPageResult, LogsSummary, ModelPrice, RequestLogInput,
    RequestLogModelOptions, RequestLogRow, UsageRecordInput, UsageSummaryRow, UsageTodaySummary,
};
use crate::core::cost_ledger_source_probe::{GatewayProbeSnapshot, GatewayUsageSample};
use crate::core::usage::{extract_captured_stream_usage, extract_response_usage};
use base64::Engine;
use chrono::{DateTime, Datelike, Duration, Local, NaiveDate, TimeZone};
use rusqlite::{params, OptionalExtension};
use std::collections::{HashMap, HashSet};

type AgentSessionKey = (String, String);

#[derive(Debug, Clone)]
struct NativeUsageRepairRequest {
    request_id: String,
    agent_type: String,
    session_id: String,
    started_at_ms: i64,
    duration_ms: i64,
    model: Option<String>,
    channel_id: Option<String>,
    needs_repair: bool,
}

fn invalid_usage_range(message: &str) -> StorageError {
    StorageError::Sqlite(rusqlite::Error::InvalidParameterName(message.to_string()))
}

fn usage_period_bounds(period: &str) -> (Option<String>, Option<String>) {
    let today = Local::now().date_naive();
    let range = match period {
        "today" => Some((today, today + Duration::days(1))),
        "week" => {
            let monday = today - Duration::days(today.weekday().num_days_from_monday() as i64);
            Some((monday, monday + Duration::days(7)))
        }
        "month" => NaiveDate::from_ymd_opt(today.year(), today.month(), 1)
            .and_then(|start| first_day_after_month(start, 1).map(|end| (start, end))),
        "quarter" => {
            let start_month = ((today.month() - 1) / 3) * 3 + 1;
            NaiveDate::from_ymd_opt(today.year(), start_month, 1)
                .and_then(|start| first_day_after_month(start, 3).map(|end| (start, end)))
        }
        "year" => NaiveDate::from_ymd_opt(today.year(), 1, 1).zip(NaiveDate::from_ymd_opt(
            today.year() + 1,
            1,
            1,
        )),
        _ => None,
    };
    let Some((start, end)) = range else {
        return (None, None);
    };
    (local_boundary(start), local_boundary(end))
}

fn first_day_after_month(start: NaiveDate, months: u32) -> Option<NaiveDate> {
    let zero_based = start.month0() + months;
    let year = start.year() + (zero_based / 12) as i32;
    NaiveDate::from_ymd_opt(year, zero_based % 12 + 1, 1)
}

fn local_boundary(date: NaiveDate) -> Option<String> {
    let midnight = date.and_hms_opt(0, 0, 0)?;
    Local
        .from_local_datetime(&midnight)
        .earliest()
        .map(|value| value.to_rfc3339())
}

#[cfg(test)]
mod native_usage_repair_tests {
    use super::*;

    fn request(id: &str, started_at_ms: i64, duration_ms: i64) -> NativeUsageRepairRequest {
        NativeUsageRepairRequest {
            request_id: id.to_string(),
            agent_type: "claude-code".to_string(),
            session_id: "session-1".to_string(),
            started_at_ms,
            duration_ms,
            model: Some("deepseek-v4-flash".to_string()),
            channel_id: Some("deepseek".to_string()),
            needs_repair: true,
        }
    }

    fn event(id: &str, timestamp: &str, output_tokens: i64) -> AgentUsageEvent {
        AgentUsageEvent {
            event_id: id.to_string(),
            event_time: timestamp.to_string(),
            model: Some("deepseek-v4-flash".to_string()),
            input_tokens: 113,
            cached_input_tokens: 116_352,
            cache_write_input_tokens: 0,
            output_tokens,
            reasoning_tokens: 0,
            total_tokens: 116_465 + output_tokens,
        }
    }

    #[test]
    fn assigns_native_event_to_latest_started_adjacent_request() {
        let base = DateTime::parse_from_rfc3339("2026-08-02T06:32:01Z")
            .unwrap()
            .timestamp_millis();
        let requests = vec![
            request("missing", base, 67_016),
            request("next", base + 67_000, 11_043),
        ];
        let events = vec![
            event("message-1", "2026-08-02T06:33:06.834Z", 9_764),
            event("message-2", "2026-08-02T06:33:08.865Z", 2_316),
        ];

        let matched = match_native_usage_events(&requests, &events)
            .into_iter()
            .collect::<HashMap<_, _>>();
        assert_eq!(matched["missing"].output_tokens, 9_764);
        assert_eq!(matched["next"].output_tokens, 2_316);
    }

    #[test]
    fn skips_ambiguous_native_events() {
        let start = DateTime::parse_from_rfc3339("2026-08-02T06:32:01Z")
            .unwrap()
            .timestamp_millis();
        let requests = vec![request("request-1", start, 10_000)];
        let events = vec![
            event("message-1", "2026-08-02T06:32:05Z", 10),
            event("message-2", "2026-08-02T06:32:06Z", 20),
        ];

        assert!(match_native_usage_events(&requests, &events).is_empty());
    }
}

fn match_native_usage_events(
    requests: &[NativeUsageRepairRequest],
    events: &[AgentUsageEvent],
) -> Vec<(String, AgentUsageEvent)> {
    let mut matches: HashMap<String, Vec<&AgentUsageEvent>> = HashMap::new();
    for event in events {
        let Ok(event_time) = DateTime::parse_from_rfc3339(&event.event_time) else {
            continue;
        };
        let event_ms = event_time.timestamp_millis();
        // Assign an event to the latest request that had already started. This
        // disambiguates adjacent calls whose timing windows touch or overlap.
        let candidate = requests
            .iter()
            .filter(|request| {
                request.started_at_ms <= event_ms
                    && event_ms <= request.started_at_ms + request.duration_ms.max(0) + 1_000
                    && match (&request.model, &event.model) {
                        (Some(request_model), Some(event_model)) => {
                            canonical_model_key(request_model) == canonical_model_key(event_model)
                        }
                        _ => true,
                    }
            })
            .max_by_key(|request| request.started_at_ms);
        if let Some(candidate) = candidate {
            matches
                .entry(candidate.request_id.clone())
                .or_default()
                .push(event);
        }
    }

    matches
        .into_iter()
        // Ambiguous mappings are deliberately left unknown.
        .filter_map(|(request_id, events)| {
            (events.len() == 1).then(|| (request_id, events[0].clone()))
        })
        .collect()
}

#[derive(Debug)]
struct StoredCaptureRef {
    pointer: Option<RequestCapturePointer>,
    state: String,
    failure_reason: Option<String>,
}

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
    matching_root_session_keys_by(catalog, |row| session_matches_search(row, search))
}

fn matching_root_session_keys_by(
    catalog: &[AgentSessionRow],
    matches: impl Fn(&AgentSessionRow) -> bool,
) -> HashSet<AgentSessionKey> {
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

    for row in catalog.iter().filter(|row| matches(row)) {
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

fn matches_agent_session_runtime_status(row: &AgentSessionRow, runtime_status: &str) -> bool {
    runtime_status.is_empty() || row.runtime_status == runtime_status
}

/// OpenCode 的 pending permission 是进程内实时状态，优先级高于 SQLite 中
/// “末条 assistant 尚未完成”的运行态推断。PC 列表页（过滤分页前）与设备
/// 同步快照（状态筛选与传输前）必须走同一入口合并，两端运行状态才一致。
fn apply_opencode_pending_sessions(
    catalog: &mut [AgentSessionRow],
    opencode_pending_sessions: &HashSet<String>,
) {
    if opencode_pending_sessions.is_empty() {
        return;
    }
    for row in catalog.iter_mut() {
        row.runtime_status = crate::core::opencode_control::merge_runtime_status(
            &row.agent_type,
            &row.session_id,
            &row.runtime_status,
            opencode_pending_sessions,
        );
    }
    crate::core::agent_session_metadata::aggregate_descendant_runtime_status(catalog);
}

fn build_agent_native_usage_summary(
    catalog: Vec<AgentSessionRow>,
) -> Vec<AgentNativeUsageSummaryRow> {
    let mut rows = catalog
        .into_iter()
        // 根会话避免父子会话累计摘要重复；已观测会话优先使用 Flowlet 请求证据，
        // 原生累计摘要不再叠加，保持保守去重。
        .filter(|row| row.parent_session_id.is_none() && !row.flowlet_observed)
        .filter_map(|row| {
            let summary = row.native_summary?;
            let activity_at = row
                .native_updated_at
                .as_deref()
                .unwrap_or(&row.activity_at)
                .to_string();
            let date = native_usage_local_date(&activity_at)?;
            Some(AgentNativeUsageSummaryRow {
                date,
                activity_at,
                agent_type: row.agent_type,
                session_id: row.session_id,
                turn_count: summary.turn_count,
                models: summary.models,
                truncated: summary.truncated,
                usage: summary.usage,
            })
        })
        .collect::<Vec<_>>();
    rows.sort_by(|left, right| {
        crate::core::agent_session_metadata::session_time_millis(&right.activity_at)
            .cmp(&crate::core::agent_session_metadata::session_time_millis(
                &left.activity_at,
            ))
            .then_with(|| right.session_id.cmp(&left.session_id))
    });
    rows
}

fn native_usage_local_date(value: &str) -> Option<String> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|timestamp| {
            timestamp
                .with_timezone(&chrono::Local)
                .format("%Y-%m-%d")
                .to_string()
        })
        .or_else(|| {
            value
                .get(..10)
                .filter(|date| date.chars().nth(4) == Some('-'))
                .map(str::to_string)
        })
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

/// 单次用量记录的费用估算 breakdown。
#[derive(Debug, Clone, Copy)]
pub struct CostBreakdown {
    pub total: f64,
    pub input_uncached: f64,
    pub input_cached: f64,
    pub input_cache_write: f64,
    pub output: f64,
}

/// 根据内存中的价格表（仅来自 config.json）计算单次用量记录的费用估算。
/// 公式与旧版 SQL 子查询一致：未命中缓存输入 / 命中缓存输入 / 输出，按每百万 token 计价。
/// 返回 breakdown，便于前端 tooltip 展示明细。
fn estimate_cost(
    prices: &[ModelPrice],
    channel_id: Option<&str>,
    upstream_model: Option<&str>,
    input_tokens: Option<i64>,
    input_cached_tokens: Option<i64>,
    input_uncached_tokens: Option<i64>,
    input_cache_write_tokens: Option<i64>,
    output_tokens: Option<i64>,
) -> Option<CostBreakdown> {
    let channel_id = channel_id?;
    let upstream_model = upstream_model?;
    // 别名变体（如 deepseek-v4-flash-0731）按规范模型 ID 匹配价格条目。
    let canonical_model = canonical_model_key(upstream_model);
    // 实际渠道的显式价格优先；自定义渠道没有独立价格时，按模型 ID 回退到
    // 官方归属渠道的基准价格。路由渠道仍原样保留用于渠道/账号维度统计。
    let price = prices
        .iter()
        .find(|p| {
            p.channel_id.eq_ignore_ascii_case(channel_id)
                && p.upstream_model.eq_ignore_ascii_case(&canonical_model)
        })
        .or_else(|| {
            let owner_channel_id = official_channel_id_for_model(&canonical_model)?;
            prices.iter().find(|p| {
                p.channel_id.eq_ignore_ascii_case(owner_channel_id)
                    && p.upstream_model.eq_ignore_ascii_case(&canonical_model)
            })
        })?;

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

    let input_uncached_cost = input_uncached * uncached_price / 1_000_000.0;
    let input_cached_cost = input_cached * cached_price / 1_000_000.0;
    let input_cache_write_cost =
        cache_write * cache_write_price.unwrap_or(uncached_price) / 1_000_000.0;
    let output_cost = output * output_price / 1_000_000.0;

    Some(CostBreakdown {
        total: input_uncached_cost + input_cached_cost + input_cache_write_cost + output_cost,
        input_uncached: input_uncached_cost,
        input_cached: input_cached_cost,
        input_cache_write: input_cache_write_cost,
        output: output_cost,
    })
}

fn session_matches_project_path(row: &AgentSessionRow, project_path: &str) -> bool {
    if project_path.is_empty() {
        return true;
    }
    let Some(session_path) = row.project_path.as_deref() else {
        return false;
    };
    let normalize = |value: &str| {
        value
            .trim()
            .replace('\\', "/")
            .trim_end_matches('/')
            .to_lowercase()
    };
    let project = normalize(project_path);
    let session = normalize(session_path);
    session == project
        || session
            .strip_prefix(&project)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

/// 为未经过 Flowlet 的 Agent 原生事件计算标准公开 API 等价费用。
///
/// 原生事件没有实际路由渠道，因此只接受可解释的价格归属：Flowlet 白名单模型
/// 使用官方渠道基准价；OpenAI/Codex 模型使用 `openai-api` 保留命名空间；其余
/// 模型仅在价格表中存在唯一的非套餐价格时才计价。无法唯一确定时返回 None，
/// 不猜测渠道、不换汇，也不把 Codex credits 当作现金费用。
fn estimate_native_public_cost(
    prices: &[ModelPrice],
    model: &str,
    input_uncached_tokens: i64,
    input_cached_tokens: i64,
    input_cache_write_tokens: i64,
    output_tokens: i64,
) -> Option<(f64, String)> {
    let canonical_model = canonical_model_key(model);
    let official_channel = official_channel_id_for_model(&canonical_model);
    let price = official_channel
        .and_then(|channel_id| {
            prices.iter().find(|price| {
                price.channel_id.eq_ignore_ascii_case(channel_id)
                    && price.upstream_model.eq_ignore_ascii_case(&canonical_model)
            })
        })
        .or_else(|| {
            prices.iter().find(|price| {
                price.channel_id.eq_ignore_ascii_case("openai-api")
                    && price.upstream_model.eq_ignore_ascii_case(&canonical_model)
            })
        })
        .or_else(|| {
            let mut candidates = prices.iter().filter(|price| {
                !price.channel_id.eq_ignore_ascii_case("codex-native")
                    && price.upstream_model.eq_ignore_ascii_case(&canonical_model)
            });
            let first = candidates.next()?;
            candidates.next().is_none().then_some(first)
        })?;

    // 原生日志无法可靠还原每次请求的完整上下文长度，与会话详情一致使用基础价。
    let (uncached_price, cached_price, cache_write_price, output_price) =
        price.resolve_prices(None);
    let amount = input_uncached_tokens.max(0) as f64 * uncached_price / 1_000_000.0
        + input_cached_tokens.max(0) as f64 * cached_price / 1_000_000.0
        + input_cache_write_tokens.max(0) as f64 * cache_write_price.unwrap_or(uncached_price)
            / 1_000_000.0
        + output_tokens.max(0) as f64 * output_price / 1_000_000.0;
    Some((amount, price.currency.clone()))
}

fn native_agent_client_id(agent_type: &str) -> &str {
    match agent_type {
        // Codex Desktop 保持与 UA 归属（client_id = "codex-desktop"）一致；
        // Codex CLI 仍归 "codex"（与 UA 规则 id 一致）。
        "codex-desktop" => "codex-desktop",
        "codex-cli" => "codex",
        other => other,
    }
}

fn native_agent_display_name(agent_type: &str) -> &str {
    match agent_type {
        "claude-code" => "Claude Code",
        "codex-desktop" => "Codex Desktop",
        "codex-cli" => "Codex CLI",
        "opencode" => "OpenCode",
        "pi" => "Pi",
        other => other,
    }
}

#[derive(Debug, Clone, Default)]
struct NativeUsageAnalysisAggregate {
    native_event_count: i64,
    input_uncached_tokens: i64,
    input_cached_tokens: i64,
    input_cache_write_tokens: i64,
    output_tokens: i64,
    total_tokens: i64,
}

/// Codex 的 token_count 事件通常不重复携带 model；模型记录在同一会话的
/// context/session 元数据中。仅当快照能确认唯一模型时才允许回填，避免把
/// 多模型会话的累计 Token 猜给任一模型。
fn unique_snapshot_model(summary_json: &str) -> Option<String> {
    let summary: crate::core::config::AgentSessionNativeSummary =
        serde_json::from_str(summary_json).ok()?;
    let mut models = summary
        .models
        .into_iter()
        .map(|model| model.trim().to_string())
        .filter(|model| !model.is_empty());
    let first = models.next()?;
    let first_key = canonical_model_key(&first);
    models
        .all(|model| canonical_model_key(&model) == first_key)
        .then_some(first)
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
                token_pack_remaining, token_pack_expire_at, token_packs, raw_scraped_json, source,
                synced_at, remark, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
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
                snapshot.raw_scraped_json,
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
                    token_pack_remaining, token_pack_expire_at, token_packs, raw_scraped_json, source,
                    synced_at, remark, created_at, updated_at
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
                raw_scraped_json: row.get(9)?,
                source: row.get(10)?,
                synced_at: row.get(11)?,
                remark: row.get(12)?,
                created_at: row.get(13)?,
                updated_at: row.get(14)?,
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
                    s.token_pack_remaining, s.token_pack_expire_at, s.token_packs, raw_scraped_json, s.source,
                    s.synced_at, s.remark, s.created_at, s.updated_at
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
                raw_scraped_json: row.get(9)?,
                source: row.get(10)?,
                synced_at: row.get(11)?,
                remark: row.get(12)?,
                created_at: row.get(13)?,
                updated_at: row.get(14)?,
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

    pub fn insert_request_log(&self, log: &RequestLogInput) -> Result<String, StorageError> {
        let request_log_id = uuid::Uuid::new_v4().simple().to_string();
        let record = RequestCaptureRecord::from_log(request_log_id.clone(), log);
        {
            // Capture-file and SQLite maintenance always acquire locks in this order.
            // This prevents a segment compaction (writer -> DB) from deadlocking with
            // a request insert (DB -> writer).
            let writer_guard = self.capture_store.lock_writer()?;
            let mut connection = self
                .connection
                .lock()
                .map_err(|_| StorageError::LockFailed)?;
            let transaction = connection.transaction()?;
            transaction.execute(
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
                    ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
                    ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, datetime('now'),
                    ?26, ?27, ?28, ?29, NULL, ?30, NULL, ?31, ?32
                )
                "#,
                params![
                    request_log_id,
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
                    log.res_headers_json,
                    log.is_last_attempt as i64,
                    log.upstream_url,
                ],
            )?;
            transaction.execute(
                r#"INSERT INTO request_capture_refs (
                    request_log_id, state, format_version, req_body_bytes, res_body_bytes,
                    created_at, updated_at
                ) VALUES (?1, 'pending', 1, 0, 0, datetime('now'), datetime('now'))"#,
                [&request_log_id],
            )?;
            match self.capture_store.append_locked(&record, &writer_guard) {
                Ok(pointer) => {
                    transaction.execute(
                        r#"UPDATE request_capture_refs
                           SET storage_key = ?2, frame_offset = ?3, frame_length = ?4,
                               checksum = ?5, format_version = ?6, state = 'ready',
                               failure_reason = NULL, req_body_bytes = ?7, res_body_bytes = ?8,
                               finalized_at = datetime('now'), updated_at = datetime('now')
                           WHERE request_log_id = ?1"#,
                        params![
                            request_log_id,
                            pointer.storage_key,
                            pointer.offset as i64,
                            pointer.length as i64,
                            pointer.checksum,
                            pointer.format_version as i64,
                            pointer.req_body_bytes,
                            pointer.res_body_bytes,
                        ],
                    )?;
                }
                Err(error) => {
                    let reason = error.to_string();
                    transaction.execute(
                        r#"UPDATE request_capture_refs
                           SET state = 'failed', failure_reason = ?2, updated_at = datetime('now')
                           WHERE request_log_id = ?1"#,
                        params![request_log_id, reason],
                    )?;
                    tracing::warn!(request_log_id, "写入请求明细文件失败: {reason}");
                }
            }
            transaction.commit()?;
        }
        Ok(request_log_id)
    }

    fn set_request_capture_ready(
        &self,
        request_log_id: &str,
        pointer: &RequestCapturePointer,
    ) -> Result<(), StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        connection.execute(
            r#"UPDATE request_capture_refs
               SET storage_key = ?2,
                   frame_offset = ?3,
                   frame_length = ?4,
                   checksum = ?5,
                   format_version = ?6,
                   state = 'ready',
                   failure_reason = NULL,
                   req_body_bytes = ?7,
                   res_body_bytes = ?8,
                   finalized_at = datetime('now'),
                   updated_at = datetime('now')
               WHERE request_log_id = ?1"#,
            params![
                request_log_id,
                pointer.storage_key,
                pointer.offset as i64,
                pointer.length as i64,
                pointer.checksum,
                pointer.format_version as i64,
                pointer.req_body_bytes,
                pointer.res_body_bytes,
            ],
        )?;
        Ok(())
    }

    fn set_request_capture_failed(
        &self,
        request_log_id: &str,
        reason: &str,
    ) -> Result<(), StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        connection.execute(
            r#"UPDATE request_capture_refs
               SET state = 'failed', failure_reason = ?2, updated_at = datetime('now')
               WHERE request_log_id = ?1"#,
            params![request_log_id, reason],
        )?;
        Ok(())
    }

    fn request_capture_ref(
        &self,
        request_log_id: &str,
    ) -> Result<Option<StoredCaptureRef>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        connection
            .query_row(
                r#"SELECT storage_key, frame_offset, frame_length, checksum,
                          format_version, state, req_body_bytes, res_body_bytes, failure_reason
                   FROM request_capture_refs
                   WHERE request_log_id = ?1"#,
                [request_log_id],
                |row| {
                    let storage_key: Option<String> = row.get(0)?;
                    let offset: Option<i64> = row.get(1)?;
                    let length: Option<i64> = row.get(2)?;
                    let checksum: Option<String> = row.get(3)?;
                    let format_version: i64 = row.get(4)?;
                    let state: String = row.get(5)?;
                    let req_body_bytes: i64 = row.get(6)?;
                    let res_body_bytes: i64 = row.get(7)?;
                    let failure_reason: Option<String> = row.get(8)?;
                    let pointer = match (storage_key, offset, length, checksum) {
                        (Some(storage_key), Some(offset), Some(length), Some(checksum))
                            if offset >= 0 && length >= 0 =>
                        {
                            Some(RequestCapturePointer {
                                storage_key,
                                offset: offset as u64,
                                length: length as u64,
                                checksum,
                                format_version: format_version as u16,
                                req_body_bytes,
                                res_body_bytes,
                            })
                        }
                        _ => None,
                    };
                    Ok(StoredCaptureRef {
                        pointer,
                        state,
                        failure_reason,
                    })
                },
            )
            .optional()
            .map_err(StorageError::from)
    }

    fn read_request_capture(
        &self,
        request_log_id: &str,
    ) -> Result<Option<RequestCaptureRecord>, StorageError> {
        let writer_guard = self.capture_store.lock_writer()?;
        self.read_request_capture_locked(request_log_id, &writer_guard)
    }

    fn read_request_capture_locked(
        &self,
        request_log_id: &str,
        _writer_guard: &std::sync::MutexGuard<'_, ()>,
    ) -> Result<Option<RequestCaptureRecord>, StorageError> {
        let Some(reference) = self.request_capture_ref(request_log_id)? else {
            return Ok(None);
        };
        if reference.state != "ready" {
            return Ok(None);
        }
        let Some(pointer) = reference.pointer else {
            return Ok(None);
        };
        match self.capture_store.read(&pointer) {
            Ok(record) if record.request_log_id == request_log_id => Ok(Some(record)),
            Ok(_) => {
                self.mark_request_capture_corrupt(request_log_id, "日志 ID 与捕获记录不一致")?;
                Ok(None)
            }
            Err(error) => {
                let reason = error.to_string();
                self.mark_request_capture_corrupt(request_log_id, &reason)?;
                tracing::warn!(request_log_id, "读取请求明细文件失败: {reason}");
                Ok(None)
            }
        }
    }

    fn mark_request_capture_corrupt(
        &self,
        request_log_id: &str,
        reason: &str,
    ) -> Result<(), StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        connection.execute(
            r#"UPDATE request_capture_refs
               SET state = 'corrupt', failure_reason = ?2, updated_at = datetime('now')
               WHERE request_log_id = ?1"#,
            params![request_log_id, reason],
        )?;
        Ok(())
    }

    fn hydrate_request_capture(&self, row: &mut RequestLogRow) -> Result<(), StorageError> {
        if let Some(reference) = self.request_capture_ref(&row.id)? {
            row.capture_state = Some(reference.state);
            row.capture_failure_reason = reference.failure_reason;
        }
        if let Some(record) = self.read_request_capture(&row.id)? {
            row.req_headers_json = row.req_headers_json.take().or(record.req_headers_json);
            row.req_body_b64 = record.req_body_b64;
            row.res_headers_json = row.res_headers_json.take().or(record.res_headers_json);
            row.res_body_b64 = record.res_body_b64;
        } else if row.capture_state.as_deref() == Some("ready") {
            if let Some(reference) = self.request_capture_ref(&row.id)? {
                row.capture_state = Some(reference.state);
                row.capture_failure_reason = reference.failure_reason;
            }
        }
        Ok(())
    }

    pub fn list_agent_sessions(
        &self,
        filter: AgentSessionsFilter,
        opencode_pending_sessions: &std::collections::HashSet<String>,
    ) -> Result<AgentSessionsPageResult, StorageError> {
        let page = filter.page.max(1);
        let page_size = filter.page_size.clamp(1, 500);
        let offset = ((page - 1) * page_size) as usize;
        let search = filter.search.trim().to_lowercase();
        let agent_type = filter.agent_type.trim();
        let runtime_status = filter.runtime_status.trim();
        let project_path = filter.project_path.trim();
        let mut catalog = crate::core::agent_session_metadata::merge_agent_session_catalog(
            self.list_observed_agent_sessions()?,
            self.list_native_agent_sessions(),
        );
        // 实时待确认权限必须在过滤和分页前合并，否则运行状态筛选、总数和分页
        // 都会与实时状态不一致。
        apply_opencode_pending_sessions(&mut catalog, opencode_pending_sessions);
        let matching_roots = matching_root_session_keys(&catalog, &search);
        let project_matching_roots = matching_root_session_keys_by(&catalog, |row| {
            session_matches_project_path(row, project_path)
        });
        catalog.retain(|row| {
            row.parent_session_id.is_none()
                && matching_roots.contains(&agent_session_key(row))
                && project_matching_roots.contains(&agent_session_key(row))
                && matches_agent_session_type(row, agent_type)
                && matches_agent_session_runtime_status(row, runtime_status)
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

    /// 返回用于设备快照的全部根会话。同步层会在此结果上应用
    /// “运行态全保留，其余按最近活跃补足 10 条”的传输规则。
    ///
    /// `opencode_pending_sessions` 是 OpenCode 进程内实时待确认权限的会话集合，
    /// 与 PC 列表页共用同一合并入口；否则移动端快照会把“等待确认”的会话
    /// 固化为 SQLite 推断出的“自动运行中”。
    pub fn list_agent_sessions_for_device_sync(
        &self,
        opencode_pending_sessions: &std::collections::HashSet<String>,
    ) -> Result<Vec<AgentSessionRow>, StorageError> {
        let mut catalog = crate::core::agent_session_metadata::merge_agent_session_catalog(
            self.list_observed_agent_sessions()?,
            self.list_native_agent_sessions(),
        );
        apply_opencode_pending_sessions(&mut catalog, opencode_pending_sessions);
        catalog.retain(|row| row.parent_session_id.is_none());
        catalog.sort_by(|left, right| {
            crate::core::agent_session_metadata::session_time_millis(&right.activity_at)
                .cmp(&crate::core::agent_session_metadata::session_time_millis(
                    &left.activity_at,
                ))
                .then_with(|| right.session_id.cmp(&left.session_id))
        });
        Ok(catalog)
    }

    /// 返回未经过 Flowlet 的根会话累计用量。
    ///
    /// 复用后台 Agent 数据同步写入的 `agent_session_snapshots`，不在用量页面查询时
    /// 重新解析完整会话正文。已被 Flowlet 观测的会话不返回，避免与
    /// `usage_records` 重复统计。
    pub fn agent_native_usage_summary(
        &self,
    ) -> Result<Vec<AgentNativeUsageSummaryRow>, StorageError> {
        // 用量汇总不区分运行状态，无需实时待确认权限集合。
        Ok(build_agent_native_usage_summary(
            self.list_agent_sessions_for_device_sync(&std::collections::HashSet::new())?,
        ))
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
                COALESCE(SUM(ur.estimated_cost), 0),
                COALESCE(SUM(ur.estimated_input_uncached_cost), 0),
                COALESCE(SUM(ur.estimated_input_cached_cost), 0),
                COALESCE(SUM(ur.estimated_input_cache_write_cost), 0),
                COALESCE(SUM(ur.estimated_output_cost), 0)
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
                runtime_status: "unknown".to_string(),
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
                estimated_input_uncached_cost: row.get(18)?,
                estimated_input_cached_cost: row.get(19)?,
                estimated_input_cache_write_cost: row.get(20)?,
                estimated_output_cost: row.get(21)?,
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
                account_id, COALESCE((SELECT name FROM channel_accounts WHERE id = account_id), account_name) AS account_name, client_protocol, upstream_protocol,
                virtual_model, public_model, upstream_model, request_type, method, path,
                status, latency_ms, is_stream, error_message, fallback_count,
                route_reason, created_at,
                ttfb_ms, duration_ms, attempt_seq,
                req_headers_json, req_body_b64, req_body_cleared_at, req_body_cleanup_reason,
                res_headers_json, res_body_b64, res_body_cleared_at, res_body_cleanup_reason,
                is_last_attempt, ttft_ms, upstream_url,
                agent_type, agent_session_id, parent_agent_session_id
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
                req_body_cleared_at: row.get(28)?,
                req_body_cleanup_reason: row.get(29)?,
                res_headers_json: row.get(30)?,
                res_body_b64: row.get(31)?,
                res_body_cleared_at: row.get(32)?,
                res_body_cleanup_reason: row.get(33)?,
                capture_state: None,
                capture_failure_reason: None,
                is_last_attempt: row.get::<_, i64>(34)? != 0,
                ttft_ms: row.get(35)?,
                upstream_url: row.get(36)?,
                input_tokens: None,
                input_cached_tokens: None,
                input_uncached_tokens: None,
                output_tokens: None,
                total_tokens: None,
                estimated_cost: None,
                estimated_input_uncached_cost: None,
                estimated_input_cached_cost: None,
                estimated_input_cache_write_cost: None,
                estimated_output_cost: None,
                agent_type: row.get(37)?,
                agent_session_id: row.get(38)?,
                parent_agent_session_id: row.get(39)?,
            })
        })?;
        let mut logs = Vec::new();
        for row in rows {
            logs.push(row?);
        }
        drop(stmt);
        drop(connection);
        for log in &mut logs {
            self.hydrate_request_capture(log)?;
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

    /// 返回请求日志页模型筛选项：对外模型（public/virtual）与路由目标模型（upstream）分两组。
    /// 前端按分组传回 `model_kind`，选中对外模型只匹配 public/virtual，选中路由模型只匹配 upstream。
    pub fn list_request_log_models(&self) -> Result<RequestLogModelOptions, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;

        let public_models = connection
            .prepare(
                r#"
                SELECT COALESCE(public_model, virtual_model) AS model
                FROM request_logs
                WHERE is_last_attempt = 1
                  AND COALESCE(public_model, virtual_model, '') <> ''
                GROUP BY COALESCE(public_model, virtual_model)
                ORDER BY model
                "#,
            )?
            .query_map([], |row| row.get(0))?
            .collect::<Result<Vec<String>, _>>()?;

        let upstream_models = connection
            .prepare(
                r#"
                SELECT upstream_model AS model
                FROM request_logs
                WHERE is_last_attempt = 1
                  AND upstream_model IS NOT NULL
                  AND upstream_model <> ''
                GROUP BY upstream_model
                ORDER BY model
                "#,
            )?
            .query_map([], |row| row.get(0))?
            .collect::<Result<Vec<String>, _>>()?;

        Ok(RequestLogModelOptions {
            public_models,
            upstream_models,
        })
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
                rl.account_id, COALESCE(ca.name, rl.account_name) AS account_name, rl.client_protocol, rl.upstream_protocol,
                rl.virtual_model, rl.public_model, rl.upstream_model, rl.request_type, rl.method, rl.path,
                rl.status, rl.latency_ms, rl.is_stream, rl.error_message, rl.fallback_count,
                rl.route_reason, rl.created_at,
                rl.ttfb_ms, rl.duration_ms, rl.attempt_seq,
                rl.req_headers_json, rl.req_body_b64, rl.req_body_cleared_at, rl.req_body_cleanup_reason,
                rl.res_headers_json, rl.res_body_b64, rl.res_body_cleared_at, rl.res_body_cleanup_reason,
                rl.is_last_attempt,
                ur.input_tokens, ur.output_tokens,
                COALESCE(ur.total_tokens, ur.input_tokens + ur.output_tokens) AS total_tokens,
                ur.estimated_cost,
                ur.estimated_input_uncached_cost, ur.estimated_input_cached_cost,
                ur.estimated_input_cache_write_cost, ur.estimated_output_cost,
                rl.ttft_ms, ur.input_cached_tokens, ur.input_uncached_tokens, rl.upstream_url,
                rl.agent_type, rl.agent_session_id, rl.parent_agent_session_id
            FROM request_logs rl
            LEFT JOIN usage_records ur ON ur.request_id = rl.request_id
            LEFT JOIN channel_accounts ca ON ca.id = rl.account_id
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
                req_body_cleared_at: row.get(28)?,
                req_body_cleanup_reason: row.get(29)?,
                res_headers_json: row.get(30)?,
                res_body_b64: row.get(31)?,
                res_body_cleared_at: row.get(32)?,
                res_body_cleanup_reason: row.get(33)?,
                capture_state: None,
                capture_failure_reason: None,
                is_last_attempt: row.get::<_, i64>(34)? != 0,
                input_tokens: row.get(35)?,
                output_tokens: row.get(36)?,
                total_tokens: row.get(37)?,
                estimated_cost: row.get(38)?,
                estimated_input_uncached_cost: row.get(39)?,
                estimated_input_cached_cost: row.get(40)?,
                estimated_input_cache_write_cost: row.get(41)?,
                estimated_output_cost: row.get(42)?,
                ttft_ms: row.get(43)?,
                input_cached_tokens: row.get(44)?,
                input_uncached_tokens: row.get(45)?,
                upstream_url: row.get(46)?,
                agent_type: row.get(47)?,
                agent_session_id: row.get(48)?,
                parent_agent_session_id: row.get(49)?,
            })
        })?;
        let mut logs = Vec::new();
        for row in rows {
            logs.push(row?);
        }
        drop(stmt);
        drop(connection);
        for log in &mut logs {
            self.hydrate_request_capture(log)?;
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
        error_message: Option<String>,
        route_reason: Option<String>,
    ) -> Result<(), StorageError> {
        let request_log_id = {
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
                    res_body_b64 = CASE
                        WHEN EXISTS (
                            SELECT 1 FROM request_capture_refs refs
                            WHERE refs.request_log_id = request_logs.id
                        ) THEN NULL
                        ELSE ?6
                    END,
                    res_body_cleared_at = CASE WHEN ?6 IS NOT NULL THEN NULL ELSE res_body_cleared_at END,
                    res_body_cleanup_reason = CASE WHEN ?6 IS NOT NULL THEN NULL ELSE res_body_cleanup_reason END,
                    error_message = COALESCE(?7, error_message),
                    route_reason = COALESCE(?8, route_reason)
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
                    error_message,
                    route_reason,
                ],
            )?;
            connection
                .query_row(
                    r#"SELECT id FROM request_logs
                       WHERE request_id = ?1 AND is_last_attempt = 1 AND is_stream = 1
                       ORDER BY created_at DESC LIMIT 1"#,
                    [request_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
        };

        if let Some(request_log_id) = request_log_id {
            let writer_guard = self.capture_store.lock_writer()?;
            if let Some(mut record) =
                self.read_request_capture_locked(&request_log_id, &writer_guard)?
            {
                record.res_headers_json = res_headers_json;
                record.res_body_b64 = res_body_b64;
                record.error_message = error_message.or(record.error_message);
                record.route_reason = route_reason.or(record.route_reason);
                record.incomplete = false;
                match self.capture_store.append_locked(&record, &writer_guard) {
                    Ok(pointer) => self.set_request_capture_ready(&request_log_id, &pointer)?,
                    Err(error) => {
                        let reason = error.to_string();
                        self.set_request_capture_failed(&request_log_id, &reason)?;
                        tracing::warn!(request_log_id, "补写流式请求明细文件失败: {reason}");
                    }
                }
            }
        }
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
    ///
    /// 同时修复客户端归属：对 `client_id IS NULL` 的记录，按最新 `ua_rules`
    /// 重新识别并写入 `client_id` / `client_name`。已有归属的记录不会被覆盖，
    /// 避免用户手动修改后被修复回退。
    pub fn repair_agent_sessions(
        &self,
        time_range: &str,
        ua_rules: &[crate::core::config::UaClientRule],
    ) -> Result<AgentSessionRepairResult, StorageError> {
        // 先于连接锁之外完成查询，仅把批量更新包装在单个事务中持锁，
        // 避免长时间持锁阻塞请求写入端。
        let rows: Vec<(String, String, Option<String>, Option<String>)> = {
            let connection = self
                .connection
                .lock()
                .map_err(|_| StorageError::LockFailed)?;
            let mut stmt = connection.prepare(&format!(
                r#"
                SELECT request_id, MAX(req_headers_json), MAX(client_id), MAX(client_name)
                FROM request_logs
                WHERE req_headers_json IS NOT NULL
                  AND {}
                GROUP BY request_id
                "#,
                repair_time_clause("created_at", time_range)
            ))?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };

        let scanned_requests = rows.len();
        let mut repaired_requests = 0usize;
        let mut repaired_logs = 0usize;
        let mut repaired_clients = 0usize;
        // 批量更新包装在单个事务中：避免逐行自动提交引发万次 fsync，
        // 历史数据量较大时这是导致前端"点修复后整个应用卡顿"的主因。
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let transaction = connection.transaction()?;
        for (request_id, headers_json, existing_client_id, existing_client_name) in rows {
            // 会话归因修复：从 headers JSON 识别 Agent 会话
            let identity = from_header_json(&headers_json);

            // 客户端归属修复：仅对 client_id 或 client_name 为空的记录重识别
            let new_client = if existing_client_id.is_none() || existing_client_name.is_none() {
                crate::core::proxy::identify_client_from_json(&headers_json, ua_rules)
            } else {
                None
            };

            let has_session = identity.is_some();
            let has_client = new_client.is_some();

            if !has_session && !has_client {
                continue;
            }

            if has_session {
                let identity = identity.unwrap();
                repaired_logs += transaction.execute(
                    r#"
                    UPDATE request_logs
                    SET agent_type = ?2,
                        agent_session_id = ?3,
                        parent_agent_session_id = ?4
                    WHERE request_id = ?1
                    "#,
                    params![
                        request_id,
                        identity.agent_type,
                        identity.session_id,
                        identity.parent_session_id
                    ],
                )?;
            }

            if has_client {
                let (client_id, client_name) = new_client.unwrap();
                transaction.execute(
                    r#"
                    UPDATE request_logs
                    SET client_id = ?2, client_name = ?3
                    WHERE request_id = ?1 AND client_id IS NULL
                    "#,
                    params![request_id, client_id, client_name],
                )?;
                repaired_clients += 1;
            }

            repaired_requests += 1;
        }
        transaction.commit()?;

        Ok(AgentSessionRepairResult {
            scanned_requests,
            repaired_requests,
            repaired_logs,
            skipped_requests: scanned_requests.saturating_sub(repaired_requests),
            repaired_clients,
        })
    }

    /// 回填历史请求的费用分类明细。
    ///
    /// 早期版本只写入 `estimated_cost` 总数，4 个分类列（未缓存输入/缓存命中/
    /// 缓存写入/输出）为 NULL。此函数扫描这些遗留记录，按已存的 token 数与
    /// 渠道/模型单价重算分类明细，使会话费用明细之和与总费用对齐。
    pub fn backfill_cost_breakdown(&self) -> Result<usize, StorageError> {
        let prices = self.prices();
        let rows = {
            let connection = self
                .connection
                .lock()
                .map_err(|_| StorageError::LockFailed)?;
            let mut stmt = connection.prepare(
                r#"
                SELECT
                    id, channel_id, upstream_model,
                    input_tokens, input_cached_tokens, input_uncached_tokens,
                    input_cache_write_tokens, output_tokens
                FROM usage_records
                WHERE estimated_cost IS NOT NULL
                  AND estimated_input_uncached_cost IS NULL
                "#,
            )?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<i64>>(3)?,
                        row.get::<_, Option<i64>>(4)?,
                        row.get::<_, Option<i64>>(5)?,
                        row.get::<_, Option<i64>>(6)?,
                        row.get::<_, Option<i64>>(7)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };

        if rows.is_empty() {
            return Ok(0);
        }

        let mut updates: Vec<(String, Option<f64>, Option<f64>, Option<f64>, Option<f64>)> =
            Vec::new();
        for (
            id,
            channel_id,
            upstream_model,
            input_tokens,
            input_cached_tokens,
            input_uncached_tokens,
            input_cache_write_tokens,
            output_tokens,
        ) in &rows
        {
            let breakdown = estimate_cost(
                &prices,
                channel_id.as_deref(),
                upstream_model.as_deref(),
                *input_tokens,
                *input_cached_tokens,
                *input_uncached_tokens,
                *input_cache_write_tokens,
                *output_tokens,
            );
            let Some(breakdown) = breakdown else { continue };
            updates.push((
                id.clone(),
                Some(breakdown.input_uncached),
                Some(breakdown.input_cached),
                Some(breakdown.input_cache_write),
                Some(breakdown.output),
            ));
        }

        let updated = {
            let mut connection = self
                .connection
                .lock()
                .map_err(|_| StorageError::LockFailed)?;
            let transaction = connection.transaction()?;
            let mut count = 0usize;
            for (id, uncached, cached, cache_write, output) in &updates {
                count += transaction.execute(
                    r#"
                    UPDATE usage_records
                    SET estimated_input_uncached_cost = ?2,
                        estimated_input_cached_cost = ?3,
                        estimated_input_cache_write_cost = ?4,
                        estimated_output_cost = ?5
                    WHERE id = ?1
                    "#,
                    params![id, uncached, cached, cache_write, output],
                )?;
            }
            transaction.commit()?;
            count
        };

        tracing::info!(
            "backfill_cost_breakdown: 扫描 {} 条遗留记录, 回填 {} 条分类明细",
            rows.len(),
            updated
        );
        Ok(updated)
    }

    /// Reparse captured response bodies in the selected period, including
    /// requests that already have known usage. Stream responses require a
    /// complete SSE `[DONE]` marker.
    pub fn reanalyze_captured_usage(&self, time_range: &str) -> Result<usize, StorageError> {
        struct CapturedUsageRow {
            request_log_id: String,
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
            created_at: String,
            is_stream: bool,
            res_body_b64: Option<String>,
        }

        let rows = {
            let connection = self
                .connection
                .lock()
                .map_err(|_| StorageError::LockFailed)?;
            let mut stmt = connection.prepare(&format!(
                r#"
                SELECT
                    rl.id, rl.request_id, rl.client_id, rl.client_name,
                    rl.channel_id, rl.channel_name, rl.account_id, rl.account_name,
                    rl.client_protocol, rl.upstream_protocol,
                    rl.virtual_model, rl.upstream_model, rl.created_at,
                    rl.is_stream, rl.res_body_b64
                FROM request_logs rl
                LEFT JOIN request_capture_refs refs ON refs.request_log_id = rl.id
                WHERE rl.is_last_attempt = 1
                  AND (rl.res_body_b64 IS NOT NULL OR (refs.state = 'ready' AND refs.res_body_bytes > 0))
                  AND lower(rl.path) NOT LIKE '%/messages/count_tokens%'
                  AND {}
                "#,
                repair_time_clause("rl.created_at", time_range)
            ))?;
            let rows = stmt
                .query_map([], |row| {
                    Ok(CapturedUsageRow {
                        request_log_id: row.get(0)?,
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
                        upstream_model: row.get(11)?,
                        created_at: row.get(12)?,
                        is_stream: row.get::<_, i64>(13)? != 0,
                        res_body_b64: row.get(14)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };

        // 先于连接锁之外完成逐行的捕获体读取、base64 解码、SSE/JSON 响应解析，
        // 避免长时间持锁阻塞请求写入端，同时避免在连接锁内嵌套获取捕获体写锁
        // （insert_request_log 先取写锁再取连接锁，反向持锁有死锁风险）。
        // 仅把最终落库阶段放入事务批量提交，否则逐行自动提交同样会引发大量 fsync 造成前端卡顿。
        struct ParsedUsage {
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
            created_at: String,
            input_tokens: Option<i64>,
            input_cached_tokens: Option<i64>,
            input_uncached_tokens: Option<i64>,
            input_cache_write_tokens: Option<i64>,
            output_tokens: Option<i64>,
            total_tokens: Option<i64>,
            estimated_cost: Option<f64>,
            estimated_input_uncached_cost: Option<f64>,
            estimated_input_cached_cost: Option<f64>,
            estimated_input_cache_write_cost: Option<f64>,
            estimated_output_cost: Option<f64>,
        }
        let prices = self.prices();
        let mut parsed_rows: Vec<ParsedUsage> = Vec::new();
        for mut row in rows {
            if row.res_body_b64.is_none() {
                row.res_body_b64 = self
                    .read_request_capture(&row.request_log_id)?
                    .and_then(|record| record.res_body_b64);
            }
            let Some(res_body_b64) = row.res_body_b64.as_deref() else {
                continue;
            };
            let Ok(body) = base64::engine::general_purpose::STANDARD.decode(res_body_b64) else {
                continue;
            };
            let usage = if row.is_stream {
                // 捕获体可能受历史大小上限截断。仅采信带终止标记、带正输出
                // usage 的完整事件，或单条 JSON 响应；message_start 前缀留给
                // Agent 原生会话回退，避免把 output=0 的半条数据覆盖进账本。
                extract_captured_stream_usage(&body)
            } else {
                extract_response_usage(&body)
            };
            let Some(usage) = usage else {
                continue;
            };

            let estimated_cost = estimate_cost(
                &prices,
                row.channel_id.as_deref(),
                row.upstream_model.as_deref(),
                usage.input_tokens,
                usage.input_cached_tokens,
                usage.input_uncached_tokens,
                usage.input_cache_write_tokens,
                usage.output_tokens,
            );
            parsed_rows.push(ParsedUsage {
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
                created_at: row.created_at,
                input_tokens: usage.input_tokens,
                input_cached_tokens: usage.input_cached_tokens,
                input_uncached_tokens: usage.input_uncached_tokens,
                input_cache_write_tokens: usage.input_cache_write_tokens,
                output_tokens: usage.output_tokens,
                total_tokens: usage.total_tokens,
                estimated_cost: estimated_cost.map(|c| c.total),
                estimated_input_uncached_cost: estimated_cost.map(|c| c.input_uncached),
                estimated_input_cached_cost: estimated_cost.map(|c| c.input_cached),
                estimated_input_cache_write_cost: estimated_cost.map(|c| c.input_cache_write),
                estimated_output_cost: estimated_cost.map(|c| c.output),
            });
        }

        let mut connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let transaction = connection.transaction()?;
        let mut parsed = 0usize;
        for row in &parsed_rows {
            let updated = transaction.execute(
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
                    usage_status = 'complete',
                    usage_source = 'captured_response',
                    estimated_cost = ?18,
                    estimated_input_uncached_cost = ?19,
                    estimated_input_cached_cost = ?20,
                    estimated_input_cache_write_cost = ?21,
                    estimated_output_cost = ?22,
                    created_at = ?23,
                    analyzed_at = datetime('now')
                WHERE request_id = ?1
                "#,
                params![
                    row.request_id,
                    row.client_id,
                    row.client_name,
                    row.channel_id,
                    row.channel_name,
                    row.account_id,
                    row.account_name,
                    row.client_protocol,
                    row.upstream_protocol,
                    row.virtual_model,
                    row.upstream_model,
                    row.input_tokens,
                    row.input_cached_tokens,
                    row.input_uncached_tokens,
                    row.input_cache_write_tokens,
                    row.output_tokens,
                    row.total_tokens,
                    row.estimated_cost,
                    row.estimated_input_uncached_cost,
                    row.estimated_input_cached_cost,
                    row.estimated_input_cache_write_cost,
                    row.estimated_output_cost,
                    row.created_at,
                ],
            )?;
            if updated == 0 {
                transaction.execute(
                    r#"
                    INSERT INTO usage_records (
                        id, request_id, client_id, client_name, channel_id, channel_name,
                        account_id, account_name, client_protocol, upstream_protocol,
                        virtual_model, upstream_model, input_tokens, input_cached_tokens,
                        input_uncached_tokens, input_cache_write_tokens, output_tokens, total_tokens,
                        usage_status, usage_source,
                        estimated_cost, estimated_input_uncached_cost, estimated_input_cached_cost,
                        estimated_input_cache_write_cost, estimated_output_cost, analyzed_at, created_at
                    ) VALUES (
                        lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
                        ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17,
                        'complete', 'captured_response', ?18, ?19, ?20, ?21, ?22,
                        datetime('now'), ?23
                    )
                    "#,
                    params![
                        row.request_id,
                        row.client_id,
                        row.client_name,
                        row.channel_id,
                        row.channel_name,
                        row.account_id,
                        row.account_name,
                        row.client_protocol,
                        row.upstream_protocol,
                        row.virtual_model,
                        row.upstream_model,
                        row.input_tokens,
                        row.input_cached_tokens,
                        row.input_uncached_tokens,
                        row.input_cache_write_tokens,
                        row.output_tokens,
                        row.total_tokens,
                        row.estimated_cost,
                        row.estimated_input_uncached_cost,
                        row.estimated_input_cached_cost,
                        row.estimated_input_cache_write_cost,
                        row.estimated_output_cost,
                        row.created_at,
                    ],
                )?;
            }
            parsed += 1;
        }
        transaction.commit()?;

        Ok(parsed)
    }

    /// Recover incomplete proxy usage from the Agent's native message ledger.
    /// Matching is intentionally conservative: same Agent session, compatible
    /// model, and exactly one message event assigned by request start/end time.
    /// Ambiguous rows remain unknown for manual audit.
    pub fn repair_usage_from_native_sessions(
        &self,
        time_range: &str,
    ) -> Result<usize, StorageError> {
        let requests = {
            let connection = self
                .connection
                .lock()
                .map_err(|_| StorageError::LockFailed)?;
            let mut statement = connection.prepare(&format!(
                r#"
                SELECT
                    rl.request_id, rl.agent_type, rl.agent_session_id,
                    unixepoch(rl.created_at) * 1000, COALESCE(rl.duration_ms, 0),
                    rl.upstream_model, rl.channel_id,
                    CASE WHEN NOT EXISTS (
                        SELECT 1 FROM usage_records ur WHERE ur.request_id = rl.request_id
                    ) OR EXISTS (
                        SELECT 1 FROM usage_records ur
                        WHERE ur.request_id = rl.request_id
                          AND (ur.total_tokens IS NULL OR COALESCE(ur.output_tokens, 0) = 0)
                    ) THEN 1 ELSE 0 END
                FROM request_logs rl
                WHERE rl.is_last_attempt = 1
                  AND rl.status BETWEEN 200 AND 299
                  AND rl.agent_type IN ('claude-code', 'opencode', 'pi')
                  AND rl.agent_session_id IS NOT NULL
                  AND lower(rl.path) NOT LIKE '%/messages/count_tokens%'
                  AND {}
                ORDER BY rl.agent_type, rl.agent_session_id, rl.created_at
                "#,
                repair_time_clause("rl.created_at", time_range)
            ))?;
            let rows = statement
                .query_map([], |row| {
                    Ok(NativeUsageRepairRequest {
                        request_id: row.get(0)?,
                        agent_type: row.get(1)?,
                        session_id: row.get(2)?,
                        started_at_ms: row.get(3)?,
                        duration_ms: row.get(4)?,
                        model: row.get(5)?,
                        channel_id: row.get(6)?,
                        needs_repair: row.get::<_, i64>(7)? != 0,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };

        let mut sessions: HashMap<AgentSessionKey, Vec<NativeUsageRepairRequest>> = HashMap::new();
        for request in requests {
            sessions
                .entry((request.agent_type.clone(), request.session_id.clone()))
                .or_default()
                .push(request);
        }

        let prices = self.prices();
        let mut repairs = Vec::new();
        for ((agent_type, session_id), session_requests) in sessions {
            if !session_requests.iter().any(|request| request.needs_repair) {
                continue;
            }
            let Ok(parsed) =
                crate::core::agent_session_timeline::get_native_agent_session_summary_incremental(
                    &agent_type,
                    &session_id,
                    None,
                )
            else {
                continue;
            };
            let repairable = session_requests
                .iter()
                .filter(|request| request.needs_repair)
                .map(|request| request.request_id.as_str())
                .collect::<HashSet<_>>();
            let request_by_id = session_requests
                .iter()
                .map(|request| (request.request_id.as_str(), request))
                .collect::<HashMap<_, _>>();
            for (request_id, event) in
                match_native_usage_events(&session_requests, &parsed.usage_events)
            {
                if !repairable.contains(request_id.as_str()) {
                    continue;
                }
                let Some(request) = request_by_id.get(request_id.as_str()) else {
                    continue;
                };
                let input_uncached = event
                    .input_tokens
                    .saturating_add(event.cache_write_input_tokens);
                let input_tokens = input_uncached.saturating_add(event.cached_input_tokens);
                let cost = estimate_cost(
                    &prices,
                    request.channel_id.as_deref(),
                    request.model.as_deref(),
                    Some(input_tokens),
                    Some(event.cached_input_tokens),
                    Some(input_uncached),
                    Some(event.cache_write_input_tokens),
                    Some(event.output_tokens),
                );
                repairs.push((
                    request_id,
                    input_tokens,
                    event.cached_input_tokens,
                    input_uncached,
                    event.cache_write_input_tokens,
                    event.output_tokens,
                    event.total_tokens,
                    cost,
                ));
            }
        }

        let mut connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let transaction = connection.transaction()?;
        let mut repaired = 0usize;
        for (request_id, input, cached, uncached, cache_write, output, total, cost) in repairs {
            let cost_total = cost.map(|value| value.total);
            let cost_uncached = cost.map(|value| value.input_uncached);
            let cost_cached = cost.map(|value| value.input_cached);
            let cost_cache_write = cost.map(|value| value.input_cache_write);
            let cost_output = cost.map(|value| value.output);
            let updated = transaction.execute(
                r#"
                UPDATE usage_records SET
                    input_tokens=?2, input_cached_tokens=?3, input_uncached_tokens=?4,
                    input_cache_write_tokens=?5, output_tokens=?6, total_tokens=?7,
                    usage_status='complete', usage_source='agent_native',
                    estimated_cost=?8, estimated_input_uncached_cost=?9,
                    estimated_input_cached_cost=?10, estimated_input_cache_write_cost=?11,
                    estimated_output_cost=?12, analyzed_at=datetime('now')
                WHERE request_id=?1
                "#,
                params![
                    request_id,
                    input,
                    cached,
                    uncached,
                    cache_write,
                    output,
                    total,
                    cost_total,
                    cost_uncached,
                    cost_cached,
                    cost_cache_write,
                    cost_output
                ],
            )?;
            if updated == 0 {
                transaction.execute(
                    r#"
                    INSERT INTO usage_records (
                        id, request_id, client_id, client_name, channel_id, channel_name,
                        account_id, account_name, client_protocol, upstream_protocol,
                        virtual_model, upstream_model, input_tokens, input_cached_tokens,
                        input_uncached_tokens, input_cache_write_tokens, output_tokens, total_tokens,
                        usage_status, usage_source,
                        estimated_cost, estimated_input_uncached_cost, estimated_input_cached_cost,
                        estimated_input_cache_write_cost, estimated_output_cost, analyzed_at, created_at
                    )
                    SELECT lower(hex(randomblob(16))), rl.request_id, rl.client_id, rl.client_name,
                        rl.channel_id, rl.channel_name, rl.account_id, rl.account_name,
                        rl.client_protocol, rl.upstream_protocol, rl.virtual_model, rl.upstream_model,
                        ?2, ?3, ?4, ?5, ?6, ?7, 'complete', 'agent_native',
                        ?8, ?9, ?10, ?11, ?12, datetime('now'), rl.created_at
                    FROM request_logs rl
                    WHERE rl.request_id=?1 AND rl.is_last_attempt=1
                    ORDER BY rl.attempt_seq DESC LIMIT 1
                    "#,
                    params![
                        request_id,
                        input,
                        cached,
                        uncached,
                        cache_write,
                        output,
                        total,
                        cost_total,
                        cost_uncached,
                        cost_cached,
                        cost_cache_write,
                        cost_output
                    ],
                )?;
            }
            repaired += 1;
        }
        transaction.commit()?;
        Ok(repaired)
    }

    /// Incrementally moves legacy SQLite Body columns into capture files. The file frame
    /// is written and its checksum/reference committed before the legacy columns become NULL.
    pub fn migrate_legacy_body_data(&self, batch_size: usize) -> Result<usize, StorageError> {
        let batch_size = batch_size.clamp(1, 500) as i64;
        let records = {
            let connection = self
                .connection
                .lock()
                .map_err(|_| StorageError::LockFailed)?;
            let mut stmt = connection.prepare(
                r#"SELECT
                     rl.id, rl.request_id, rl.attempt_seq, rl.created_at,
                     rl.agent_type, rl.agent_session_id, rl.parent_agent_session_id,
                     rl.client_id, rl.client_name, rl.channel_id, rl.channel_name,
                     rl.account_id, rl.account_name, rl.client_protocol, rl.upstream_protocol,
                     rl.virtual_model, rl.public_model, rl.upstream_model, rl.request_type,
                     rl.method, rl.path, rl.upstream_url, rl.status, rl.is_stream,
                     rl.error_message, rl.route_reason, rl.req_headers_json, rl.req_body_b64,
                     rl.res_headers_json, rl.res_body_b64, rl.duration_ms
                   FROM request_logs rl
                   WHERE (rl.req_body_b64 IS NOT NULL OR rl.res_body_b64 IS NOT NULL)
                     AND NOT EXISTS (
                       SELECT 1 FROM request_capture_refs refs WHERE refs.request_log_id = rl.id
                     )
                   ORDER BY rl.created_at ASC
                   LIMIT ?1"#,
            )?;
            let rows = stmt
                .query_map([batch_size], |row| {
                    Ok(RequestCaptureRecord {
                        format_version: 1,
                        request_log_id: row.get(0)?,
                        request_id: row.get(1)?,
                        attempt_seq: row.get(2)?,
                        captured_at: row.get(3)?,
                        agent_type: row.get(4)?,
                        agent_session_id: row.get(5)?,
                        parent_agent_session_id: row.get(6)?,
                        client_id: row.get(7)?,
                        client_name: row.get(8)?,
                        channel_id: row.get(9)?,
                        channel_name: row.get(10)?,
                        account_id: row.get(11)?,
                        account_name: row.get(12)?,
                        client_protocol: row.get(13)?,
                        upstream_protocol: row.get(14)?,
                        virtual_model: row.get(15)?,
                        public_model: row.get(16)?,
                        upstream_model: row.get(17)?,
                        request_type: row.get(18)?,
                        method: row.get(19)?,
                        path: row.get(20)?,
                        upstream_url: row.get(21)?,
                        status: row.get(22)?,
                        is_stream: row.get::<_, i64>(23)? != 0,
                        error_message: row.get(24)?,
                        route_reason: row.get(25)?,
                        req_headers_json: row.get(26)?,
                        req_body_b64: row.get(27)?,
                        res_headers_json: row.get(28)?,
                        res_body_b64: row.get(29)?,
                        incomplete: row.get::<_, Option<i64>>(30)?.is_none()
                            && row.get::<_, i64>(23)? != 0,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };

        let mut migrated = 0usize;
        for record in records {
            let writer_guard = self.capture_store.lock_writer()?;
            let pointer = self.capture_store.append_locked(&record, &writer_guard)?;
            let mut connection = self
                .connection
                .lock()
                .map_err(|_| StorageError::LockFailed)?;
            let transaction = connection.transaction()?;
            let inserted = transaction.execute(
                r#"INSERT OR IGNORE INTO request_capture_refs (
                     request_log_id, storage_key, frame_offset, frame_length, checksum,
                     format_version, state, failure_reason, req_body_bytes, res_body_bytes,
                     finalized_at, created_at, updated_at
                   ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'ready', NULL, ?7, ?8,
                             datetime('now'), datetime('now'), datetime('now'))"#,
                params![
                    record.request_log_id,
                    pointer.storage_key,
                    pointer.offset as i64,
                    pointer.length as i64,
                    pointer.checksum,
                    pointer.format_version as i64,
                    pointer.req_body_bytes,
                    pointer.res_body_bytes,
                ],
            )?;
            if inserted == 1 {
                transaction.execute(
                    "UPDATE request_logs SET req_body_b64 = NULL, res_body_b64 = NULL WHERE id = ?1",
                    [&record.request_log_id],
                )?;
                transaction.commit()?;
                migrated += 1;
            }
        }
        Ok(migrated)
    }

    pub fn analyze_unknown_usage(&self, time_range: &str) -> Result<usize, StorageError> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let transaction = connection.transaction()?;
        // `/messages/count_tokens` 只计算请求上下文长度，不执行模型推理。旧版维护流程
        // 曾为它建立“未知用量”占位，原生会话回填也可能把相邻模型事件误配给它；
        // 保留请求日志，清除该路径下的所有误分类用量。
        let removed_non_billable = transaction.execute(
            &format!(
                r#"
                DELETE FROM usage_records
                WHERE EXISTS (
                      SELECT 1 FROM request_logs
                      WHERE request_logs.request_id = usage_records.request_id
                        AND request_logs.is_last_attempt = 1
                        AND lower(request_logs.path) LIKE '%/messages/count_tokens%'
                        AND {}
                  )
                "#,
                repair_time_clause("request_logs.created_at", time_range)
            ),
            [],
        )?;
        let inserted = transaction.execute(
            &format!(r#"
            INSERT INTO usage_records (
                id, request_id, client_id, client_name, channel_id, channel_name,
                account_id, account_name, client_protocol, upstream_protocol,
                virtual_model, upstream_model, input_tokens, input_cached_tokens,
                input_uncached_tokens, input_cache_write_tokens, output_tokens, total_tokens,
                usage_status, usage_source, estimated_cost, analyzed_at, created_at
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
                'unknown', 'unknown_placeholder', NULL,
                datetime('now'),
                datetime('now')
            FROM request_logs
            WHERE request_logs.is_last_attempt = 1
              AND {}
              AND lower(request_logs.path) NOT LIKE '%/messages/count_tokens%'
              AND NOT EXISTS (
                  SELECT 1 FROM usage_records
                  WHERE usage_records.request_id = request_logs.request_id
              )
            "#, repair_time_clause("request_logs.created_at", time_range)),
            [],
        )?;
        transaction.commit()?;
        Ok(removed_non_billable + inserted)
    }

    pub fn upsert_usage_record(&self, usage: &UsageRecordInput) -> Result<(), StorageError> {
        self.upsert_usage_record_with_metadata(usage, "complete", "upstream_response")
    }

    pub fn upsert_usage_record_with_metadata(
        &self,
        usage: &UsageRecordInput,
        usage_status: &str,
        usage_source: &str,
    ) -> Result<(), StorageError> {
        // 成本在 upsert 当场算掉，避免每次请求都全表 recalc（O(n·m) → O(1)）。
        // 仅在内存价格表有匹配价格时写 estimated_cost，否则留 NULL 稍后由
        // recalculate_usage_costs()（analyze_usage 触发）统一填补。
        // 先于连接锁之外读取价格快照，避免死锁（连接锁与价格锁是两把不同的锁）。
        let prices = self.prices();
        let estimated_cost = (usage_status == "complete")
            .then(|| {
                estimate_cost(
                    &prices,
                    usage.channel_id.as_deref(),
                    usage.upstream_model.as_deref(),
                    usage.input_tokens,
                    usage.input_cached_tokens,
                    usage.input_uncached_tokens,
                    usage.input_cache_write_tokens,
                    usage.output_tokens,
                )
            })
            .flatten();

        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;

        let (total, input_uncached, input_cached, input_cache_write, output) = match estimated_cost
        {
            Some(c) => (
                Some(c.total),
                Some(c.input_uncached),
                Some(c.input_cached),
                Some(c.input_cache_write),
                Some(c.output),
            ),
            None => (None, None, None, None, None),
        };

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
                    usage_status = ?18,
                    usage_source = ?19,
                    estimated_cost = ?20,
                    estimated_input_uncached_cost = ?21,
                    estimated_input_cached_cost = ?22,
                    estimated_input_cache_write_cost = ?23,
                    estimated_output_cost = ?24,
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
                usage_status,
                usage_source,
                total,
                input_uncached,
                input_cached,
                input_cache_write,
                output,
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
                        usage_status, usage_source,
                        estimated_cost, estimated_input_uncached_cost, estimated_input_cached_cost,
                        estimated_input_cache_write_cost, estimated_output_cost, analyzed_at, created_at
                    ) VALUES (
                        lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
                        ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24,
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
                    usage_status,
                    usage_source,
                    total,
                    input_uncached,
                    input_cached,
                    input_cache_write,
                    output,
                ],
            )?;
        }

        Ok(())
    }

    pub fn recalculate_usage_costs(&self, time_range: &str) -> Result<usize, StorageError> {
        // 先于连接锁之外读取价格快照，避免死锁（连接锁与价格锁是两把不同的锁）。
        let prices = self.prices();

        // 先于连接锁之外取出所有待回填的费用记录主键与用量字段，避免长时间持锁阻塞请求写入端。
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
            let connection = self
                .connection
                .lock()
                .map_err(|_| StorageError::LockFailed)?;
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
        // 单事务批量回填费用：避免逐行自动提交造成大量 fsync，
        // 否则历史记录较多时同样会让前端在修复阶段明显卡顿。
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let transaction = connection.transaction()?;
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
            let n = transaction.execute(
                "UPDATE usage_records SET estimated_cost = ?2, estimated_input_uncached_cost = ?3,
                 estimated_input_cached_cost = ?4, estimated_input_cache_write_cost = ?5,
                 estimated_output_cost = ?6, analyzed_at = datetime('now')
                 WHERE request_id = ?1",
                params![
                    row.request_id,
                    cost.total,
                    cost.input_uncached,
                    cost.input_cached,
                    cost.input_cache_write,
                    cost.output
                ],
            )?;
            updated += n;
        }
        transaction.commit()?;
        Ok(updated)
    }

    pub fn usage_summary(
        &self,
        period: &str,
        current_device_id: &str,
    ) -> Result<Vec<UsageSummaryRow>, StorageError> {
        let (start_at, end_at) = usage_period_bounds(period);
        let group_by = if matches!(period, "today" | "week") {
            "hour"
        } else {
            "day"
        };
        self.usage_summary_range(
            start_at.as_deref(),
            end_at.as_deref(),
            group_by,
            current_device_id,
        )
    }

    /// Query usage in an explicit UTC half-open range. Calendar presets are resolved by the
    /// frontend, so historical days/weeks/months and arbitrary date ranges share one contract.
    /// The local request scan keeps timestamp bounds for the created_at index; synchronized
    /// device breakdowns are filtered by their natural local date keys.
    pub fn usage_summary_range(
        &self,
        start_at: Option<&str>,
        end_at: Option<&str>,
        group_by: &str,
        current_device_id: &str,
    ) -> Result<Vec<UsageSummaryRow>, StorageError> {
        let has_range = start_at.is_some() || end_at.is_some();
        let (start_at, end_at, breakdown_start, breakdown_end) = match (start_at, end_at) {
            (None, None) => (None, None, None, None),
            (Some(start), Some(end)) => {
                let start_parsed = DateTime::parse_from_rfc3339(start)
                    .map_err(|_| invalid_usage_range("开始时间不是有效的 RFC3339 时间"))?;
                let end_parsed = DateTime::parse_from_rfc3339(end)
                    .map_err(|_| invalid_usage_range("结束时间不是有效的 RFC3339 时间"))?;
                if start_parsed >= end_parsed {
                    return Err(invalid_usage_range("开始时间必须早于结束时间"));
                }
                let start_date = start_parsed.with_timezone(&Local).date_naive().to_string();
                let end_date = (end_parsed.with_timezone(&Local) - Duration::seconds(1))
                    .date_naive()
                    .to_string();
                (
                    Some(start.to_string()),
                    Some(end.to_string()),
                    Some(start_date),
                    Some(end_date),
                )
            }
            _ => return Err(invalid_usage_range("开始时间和结束时间必须同时提供")),
        };
        let date_expression = match group_by {
            "hour" => "strftime('%Y-%m-%dT%H:00:00', request_logs.created_at, 'localtime')",
            "day" => "strftime('%Y-%m-%d', request_logs.created_at, 'localtime')",
            _ => return Err(invalid_usage_range("不支持的用量分组粒度")),
        };
        let local_range_clause = if has_range {
            "AND request_logs.created_at >= datetime(?3) AND request_logs.created_at < datetime(?4)"
        } else {
            ""
        };
        let breakdown_range_clause = if has_range {
            "AND breakdown_date >= ?5 AND breakdown_date <= ?6"
        } else {
            ""
        };
        let prices = self.prices();
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        // 本机记录（标记 current_device_id）与同步来的维度聚合 UNION ALL，
        // 再按 device_id + 维度二次分组，使设备成为可与模型/渠道账号/客户端并列的维度。
        let sql = format!(
            r#"
            SELECT
                device_id,
                usage_date,
                client_id,
                client_name,
                channel_id,
                channel_name,
                account_id,
                account_name,
                upstream_model,
                sum(request_count) AS request_count,
                sum(known_tokens) AS known_tokens,
                sum(input_tokens) AS input_tokens,
                sum(input_cached_tokens) AS input_cached_tokens,
                sum(input_uncached_tokens) AS input_uncached_tokens,
                sum(cache_measured_input_tokens) AS cache_measured_input_tokens,
                sum(output_tokens) AS output_tokens,
                sum(unknown_count) AS unknown_count,
                sum(estimated_cost) AS estimated_cost,
                max(estimated_cost_currency) AS estimated_cost_currency,
                sum(native_event_count) AS native_event_count,
                sum(elapsed_total_ms) AS elapsed_total_ms,
                sum(elapsed_measured_count) AS elapsed_measured_count,
                sum(generation_total_ms) AS generation_total_ms,
                sum(generation_output_tokens) AS generation_output_tokens
            FROM (
                SELECT
                    ?1 AS device_id,
                    {date_expression} AS usage_date,
                    usage_records.client_id,
                    usage_records.client_name,
                    usage_records.channel_id,
                    usage_records.channel_name,
                    COALESCE(account_links.workspace_account_id, usage_records.account_id) AS account_id,
                    COALESCE(ca.name, usage_records.account_name) AS account_name,
                    usage_records.upstream_model,
                    count(*) AS request_count,
                    coalesce(sum(usage_records.total_tokens), 0) AS known_tokens,
                    coalesce(sum(usage_records.input_tokens), 0) AS input_tokens,
                    coalesce(sum(usage_records.input_cached_tokens), 0) AS input_cached_tokens,
                    coalesce(sum(usage_records.input_uncached_tokens), 0) AS input_uncached_tokens,
                    coalesce(sum(CASE WHEN usage_records.input_cached_tokens IS NOT NULL THEN usage_records.input_tokens ELSE 0 END), 0) AS cache_measured_input_tokens,
                    coalesce(sum(usage_records.output_tokens), 0) AS output_tokens,
                    sum(CASE WHEN usage_records.total_tokens IS NULL THEN 1 ELSE 0 END) AS unknown_count,
                    coalesce(sum(usage_records.estimated_cost), 0) AS estimated_cost,
                    NULL AS estimated_cost_currency,
                    0 AS native_event_count,
                    coalesce(sum(COALESCE(request_logs.duration_ms, request_logs.latency_ms)), 0) AS elapsed_total_ms,
                    sum(CASE WHEN COALESCE(request_logs.duration_ms, request_logs.latency_ms) IS NOT NULL THEN 1 ELSE 0 END) AS elapsed_measured_count,
                    coalesce(sum(CASE WHEN request_logs.duration_ms IS NOT NULL
                                       AND request_logs.ttft_ms IS NOT NULL
                                       AND request_logs.duration_ms > request_logs.ttft_ms
                                 THEN request_logs.duration_ms - request_logs.ttft_ms ELSE 0 END), 0) AS generation_total_ms,
                    sum(CASE WHEN request_logs.duration_ms IS NOT NULL
                              AND request_logs.ttft_ms IS NOT NULL
                              AND request_logs.duration_ms > request_logs.ttft_ms
                        THEN coalesce(usage_records.output_tokens, 0) ELSE 0 END) AS generation_output_tokens
                FROM usage_records
                LEFT JOIN request_logs ON request_logs.request_id = usage_records.request_id
                                      AND request_logs.is_last_attempt = 1
                LEFT JOIN channel_accounts ca ON ca.id = usage_records.account_id
                LEFT JOIN channel_account_workspace_links account_links
                       ON account_links.local_account_id = usage_records.account_id
                WHERE 1 = 1
                {local_range_clause}
                GROUP BY usage_date, usage_records.client_id, usage_records.channel_id,
                         usage_records.account_id, usage_records.upstream_model

                UNION ALL

                SELECT
                    device_id,
                    breakdown_date AS usage_date,
                    client_id,
                    client_name,
                    channel_id,
                    channel_name,
                    account_id,
                    account_name,
                    upstream_model,
                    request_count,
                    known_tokens,
                    input_tokens,
                    input_cached_tokens,
                    input_uncached_tokens,
                    cache_measured_input_tokens,
                    output_tokens,
                    unknown_count,
                    estimated_cost,
                    estimated_cost_currency,
                    native_event_count,
                    elapsed_total_ms,
                    elapsed_measured_count,
                    generation_total_ms,
                    generation_output_tokens
                FROM device_usage_breakdowns
                WHERE device_id != ?2
                {breakdown_range_clause}
            ) combined
            GROUP BY device_id, usage_date, client_id, channel_id, account_id, upstream_model
            ORDER BY usage_date DESC, request_count DESC
            "#,
        );
        let mut stmt = connection.prepare(&sql)?;
        let map_row = Self::map_usage_summary_row;
        let mut summary: Vec<UsageSummaryRow> = if !has_range {
            stmt.query_map(params![current_device_id, current_device_id], map_row)?
        } else {
            stmt.query_map(
                params![
                    current_device_id,
                    current_device_id,
                    start_at.as_deref().unwrap_or_default(),
                    end_at.as_deref().unwrap_or_default(),
                    breakdown_start.unwrap_or_default(),
                    breakdown_end.unwrap_or_default(),
                ],
                map_row,
            )?
        }
        .collect::<Result<Vec<_>, _>>()?;

        // 原生 Agent 用量与代理请求共用同一分析结果，但保持独立来源语义：
        // 只纳入能识别具体模型、且整段会话未被 Flowlet 观测的事件，避免双算。
        // 原生事件没有真实渠道账号，因此使用稳定的虚拟来源维度；费用仅在模型
        // 精确命中公开价格时估算，并把币种随行返回给前端。
        let native_date_expression = match group_by {
            "hour" => "strftime('%Y-%m-%dT%H:00:00', event_time, 'localtime')",
            "day" => "strftime('%Y-%m-%d', event_time, 'localtime')",
            _ => unreachable!("group_by validated above"),
        };
        let native_range_clause = if has_range {
            "AND datetime(event_time) >= datetime(?1) AND datetime(event_time) < datetime(?2)"
        } else {
            ""
        };
        let snapshot_models = {
            let mut snapshot_stmt = connection.prepare(
                "SELECT agent_type, session_id, summary_json FROM agent_session_snapshots",
            )?;
            let rows = snapshot_stmt.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?;
            let mut models = HashMap::new();
            for row in rows {
                let (agent_type, session_id, summary_json) = row?;
                if let Some(model) = unique_snapshot_model(&summary_json) {
                    models.insert((agent_type, session_id), model);
                }
            }
            models
        };
        let native_sql = format!(
            r#"
            SELECT
                {native_date_expression} AS usage_date,
                agent_type,
                session_id,
                nullif(trim(model), '') AS model,
                count(*) AS native_event_count,
                coalesce(sum(CASE
                    WHEN agent_type IN ('codex-desktop', 'codex-cli') THEN
                        max(input_tokens - cached_input_tokens - cache_write_input_tokens, 0)
                    ELSE input_tokens
                END), 0) AS input_uncached_tokens,
                coalesce(sum(cached_input_tokens), 0) AS input_cached_tokens,
                coalesce(sum(cache_write_input_tokens), 0) AS input_cache_write_tokens,
                coalesce(sum(output_tokens), 0) AS output_tokens,
                coalesce(sum(total_tokens), 0) AS total_tokens
            FROM agent_usage_events
            WHERE 1 = 1
              {native_range_clause}
              AND NOT EXISTS (
                  SELECT 1 FROM request_logs
                  WHERE request_logs.agent_type = agent_usage_events.agent_type
                    AND request_logs.agent_session_id = agent_usage_events.session_id
              )
            GROUP BY usage_date, agent_type, session_id, nullif(trim(model), '')
            ORDER BY usage_date DESC, native_event_count DESC
            "#,
        );
        let mut native_stmt = connection.prepare(&native_sql)?;
        let mut native_rows = if !has_range {
            native_stmt.query([])?
        } else {
            native_stmt.query(params![
                start_at.as_deref().unwrap_or_default(),
                end_at.as_deref().unwrap_or_default(),
            ])?
        };
        let mut native_aggregates: HashMap<
            (String, String, String),
            NativeUsageAnalysisAggregate,
        > = HashMap::new();
        while let Some(row) = native_rows.next()? {
            let date = row
                .get::<_, Option<String>>(0)?
                .unwrap_or_else(|| "未知日期".to_string());
            let agent_type: String = row.get(1)?;
            let session_id: String = row.get(2)?;
            let event_model: Option<String> = row.get(3)?;
            let model = event_model.or_else(|| {
                snapshot_models
                    .get(&(agent_type.clone(), session_id))
                    .cloned()
            });
            let Some(model) = model else {
                continue;
            };
            let aggregate = native_aggregates
                .entry((date, agent_type, model))
                .or_default();
            aggregate.native_event_count = aggregate
                .native_event_count
                .saturating_add(row.get::<_, i64>(4)?);
            aggregate.input_uncached_tokens = aggregate
                .input_uncached_tokens
                .saturating_add(row.get::<_, i64>(5)?);
            aggregate.input_cached_tokens = aggregate
                .input_cached_tokens
                .saturating_add(row.get::<_, i64>(6)?);
            aggregate.input_cache_write_tokens = aggregate
                .input_cache_write_tokens
                .saturating_add(row.get::<_, i64>(7)?);
            aggregate.output_tokens = aggregate
                .output_tokens
                .saturating_add(row.get::<_, i64>(8)?);
            aggregate.total_tokens = aggregate
                .total_tokens
                .saturating_add(row.get::<_, i64>(9)?);
        }
        drop(native_rows);
        drop(native_stmt);

        for ((date, agent_type, model), aggregate) in native_aggregates {
            let NativeUsageAnalysisAggregate {
                native_event_count,
                input_uncached_tokens,
                input_cached_tokens,
                input_cache_write_tokens,
                output_tokens,
                total_tokens,
            } = aggregate;
            let input_tokens = input_uncached_tokens
                .saturating_add(input_cached_tokens)
                .saturating_add(input_cache_write_tokens);
            let (estimated_cost, estimated_cost_currency) = estimate_native_public_cost(
                &prices,
                &model,
                input_uncached_tokens,
                input_cached_tokens,
                input_cache_write_tokens,
                output_tokens,
            )
            .map(|(amount, currency)| (amount, Some(currency)))
            .unwrap_or((0.0, None));
            let client_name = native_agent_display_name(&agent_type).to_string();
            summary.push(UsageSummaryRow {
                date,
                client_id: Some(native_agent_client_id(&agent_type).to_string()),
                client_name: Some(client_name.clone()),
                channel_id: Some("agent-native".to_string()),
                channel_name: Some("Agent 原生（未经过 Flowlet）".to_string()),
                account_id: Some(agent_type.clone()),
                account_name: Some(client_name),
                upstream_model: Some(model),
                request_count: 0,
                known_tokens: total_tokens,
                input_tokens,
                input_cached_tokens,
                input_uncached_tokens,
                cache_measured_input_tokens: input_tokens,
                output_tokens,
                unknown_count: 0,
                estimated_cost,
                estimated_cost_currency,
                native_event_count,
                elapsed_total_ms: 0,
                elapsed_measured_count: 0,
                generation_total_ms: 0,
                generation_output_tokens: 0,
                device_id: Some(current_device_id.to_string()),
            });
        }
        summary.sort_by(|left, right| {
            right
                .date
                .cmp(&left.date)
                .then_with(|| right.request_count.cmp(&left.request_count))
                .then_with(|| right.native_event_count.cmp(&left.native_event_count))
        });
        Ok(summary)
    }

    /// 把 usage_summary 结果集的一行映射为 UsageSummaryRow。device_id 在第 0 列，
    /// 其余字段自第 1 列起与 SELECT 顺序一致。
    fn map_usage_summary_row(row: &rusqlite::Row<'_>) -> Result<UsageSummaryRow, rusqlite::Error> {
        Ok(UsageSummaryRow {
            device_id: row.get(0)?,
            date: row.get::<_, Option<String>>(1)?.unwrap_or_else(|| "未知日期".to_string()),
            client_id: row.get(2)?,
            client_name: row.get(3)?,
            channel_id: row.get(4)?,
            channel_name: row.get(5)?,
            account_id: row.get(6)?,
            account_name: row.get(7)?,
            upstream_model: row.get(8)?,
            request_count: row.get(9)?,
            known_tokens: row.get(10)?,
            input_tokens: row.get(11)?,
            input_cached_tokens: row.get(12)?,
            input_uncached_tokens: row.get(13)?,
            cache_measured_input_tokens: row.get(14)?,
            output_tokens: row.get(15)?,
            unknown_count: row.get(16)?,
            estimated_cost: row.get(17)?,
            estimated_cost_currency: row.get(18)?,
            native_event_count: row.get(19)?,
            elapsed_total_ms: row.get(20)?,
            elapsed_measured_count: row.get(21)?,
            generation_total_ms: row.get(22)?,
            generation_output_tokens: row.get(23)?,
        })
    }

    /// 生成供设备同步的 Agent 原生模型用量维度行。数据直接从逐事件账本和
    /// 会话快照动态聚合，因此版本升级后的下一次同步即可补发既有历史，
    /// 不需要先改写历史表或运行数据完整性修复。
    pub(super) fn native_usage_breakdowns_for_sync(
        &self,
        history_days: i64,
    ) -> Result<Vec<DeviceUsageBreakdownRow>, StorageError> {
        let prices = self.prices();
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let snapshot_models = {
            let mut statement = connection.prepare(
                "SELECT agent_type, session_id, summary_json FROM agent_session_snapshots",
            )?;
            let rows = statement.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?;
            let mut models = HashMap::new();
            for row in rows {
                let (agent_type, session_id, summary_json) = row?;
                if let Some(model) = unique_snapshot_model(&summary_json) {
                    models.insert((agent_type, session_id), model);
                }
            }
            models
        };
        let mut statement = connection.prepare(
            r#"
            SELECT
                strftime('%Y-%m-%d', event_time, 'localtime') AS usage_date,
                agent_type,
                session_id,
                nullif(trim(model), '') AS model,
                count(*) AS native_event_count,
                coalesce(sum(CASE
                    WHEN agent_type IN ('codex-desktop', 'codex-cli') THEN
                        max(input_tokens - cached_input_tokens - cache_write_input_tokens, 0)
                    ELSE input_tokens
                END), 0) AS input_uncached_tokens,
                coalesce(sum(cached_input_tokens), 0) AS input_cached_tokens,
                coalesce(sum(cache_write_input_tokens), 0) AS input_cache_write_tokens,
                coalesce(sum(output_tokens), 0) AS output_tokens,
                coalesce(sum(total_tokens), 0) AS total_tokens
            FROM agent_usage_events
            WHERE event_time >= datetime('now', 'localtime', 'start of day', printf('-%d days', ?1), 'utc')
              AND NOT EXISTS (
                  SELECT 1 FROM request_logs
                  WHERE request_logs.agent_type = agent_usage_events.agent_type
                    AND request_logs.agent_session_id = agent_usage_events.session_id
              )
            GROUP BY usage_date, agent_type, session_id, nullif(trim(model), '')
            ORDER BY usage_date ASC
            "#,
        )?;
        let mut rows = statement.query([history_days])?;
        let mut aggregates: HashMap<(String, String, String), NativeUsageAnalysisAggregate> =
            HashMap::new();
        while let Some(row) = rows.next()? {
            let date = row
                .get::<_, Option<String>>(0)?
                .unwrap_or_else(|| "未知日期".to_string());
            let agent_type: String = row.get(1)?;
            let session_id: String = row.get(2)?;
            let model = row.get::<_, Option<String>>(3)?.or_else(|| {
                snapshot_models
                    .get(&(agent_type.clone(), session_id))
                    .cloned()
            });
            let Some(model) = model else {
                continue;
            };
            let aggregate = aggregates
                .entry((date, agent_type, model))
                .or_default();
            aggregate.native_event_count = aggregate
                .native_event_count
                .saturating_add(row.get::<_, i64>(4)?);
            aggregate.input_uncached_tokens = aggregate
                .input_uncached_tokens
                .saturating_add(row.get::<_, i64>(5)?);
            aggregate.input_cached_tokens = aggregate
                .input_cached_tokens
                .saturating_add(row.get::<_, i64>(6)?);
            aggregate.input_cache_write_tokens = aggregate
                .input_cache_write_tokens
                .saturating_add(row.get::<_, i64>(7)?);
            aggregate.output_tokens = aggregate
                .output_tokens
                .saturating_add(row.get::<_, i64>(8)?);
            aggregate.total_tokens = aggregate
                .total_tokens
                .saturating_add(row.get::<_, i64>(9)?);
        }
        drop(rows);
        drop(statement);

        Ok(aggregates
            .into_iter()
            .map(|((date, agent_type, model), aggregate)| {
                let input_tokens = aggregate
                    .input_uncached_tokens
                    .saturating_add(aggregate.input_cached_tokens)
                    .saturating_add(aggregate.input_cache_write_tokens);
                let (estimated_cost, estimated_cost_currency) = estimate_native_public_cost(
                    &prices,
                    &model,
                    aggregate.input_uncached_tokens,
                    aggregate.input_cached_tokens,
                    aggregate.input_cache_write_tokens,
                    aggregate.output_tokens,
                )
                .map(|(amount, currency)| (amount, Some(currency)))
                .unwrap_or((0.0, None));
                let client_name = native_agent_display_name(&agent_type).to_string();
                DeviceUsageBreakdownRow {
                    date,
                    client_id: Some(native_agent_client_id(&agent_type).to_string()),
                    client_name: Some(client_name.clone()),
                    channel_id: Some("agent-native".to_string()),
                    channel_name: Some("Agent 原生（未经过 Flowlet）".to_string()),
                    account_id: Some(agent_type),
                    account_name: Some(client_name),
                    upstream_model: Some(model),
                    request_count: 0,
                    known_tokens: aggregate.total_tokens,
                    input_tokens,
                    input_cached_tokens: aggregate.input_cached_tokens,
                    input_uncached_tokens: aggregate.input_uncached_tokens,
                    cache_measured_input_tokens: input_tokens,
                    output_tokens: aggregate.output_tokens,
                    unknown_count: 0,
                    estimated_cost,
                    estimated_cost_currency,
                    native_event_count: aggregate.native_event_count,
                    elapsed_total_ms: 0,
                    elapsed_measured_count: 0,
                    generation_total_ms: 0,
                    generation_output_tokens: 0,
                }
            })
            .collect())
    }

    /// 今日 Token 消耗单行聚合。口径与用量统计页「日 / 全部设备」一致：
    /// 本机 Flowlet 请求、本机未经过 Flowlet 的 Agent 原生事件，以及同步到本机的
    /// 其他设备日快照。查询只读取今天并返回一行，避免概览页轮询整段历史。
    pub fn usage_today_summary(&self) -> Result<UsageTodaySummary, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let summary = connection.query_row(
            r#"
            WITH today_sources (
                total_tokens,
                input_tokens,
                input_cached_tokens,
                input_uncached_tokens,
                cache_measured_input_tokens,
                output_tokens
            ) AS (
                SELECT
                    coalesce(sum(ur.total_tokens), 0),
                    coalesce(sum(ur.input_tokens), 0),
                    coalesce(sum(ur.input_cached_tokens), 0),
                    coalesce(sum(ur.input_uncached_tokens), 0),
                    coalesce(sum(CASE
                        WHEN ur.input_cached_tokens IS NOT NULL THEN ur.input_tokens ELSE 0
                    END), 0),
                    coalesce(sum(ur.output_tokens), 0)
                FROM usage_records ur
                LEFT JOIN request_logs rl
                       ON rl.request_id = ur.request_id
                      AND rl.is_last_attempt = 1
                WHERE strftime(
                    '%Y-%m-%d',
                    coalesce(rl.created_at, ur.created_at),
                    'localtime'
                ) = date('now', 'localtime')

                UNION ALL

                SELECT
                    coalesce(sum(a.total_tokens), 0),
                    coalesce(sum(CASE
                        WHEN a.agent_type IN ('codex-desktop', 'codex-cli') THEN
                            max(a.input_tokens - a.cached_input_tokens - a.cache_write_input_tokens, 0)
                        ELSE a.input_tokens
                    END), 0)
                        + coalesce(sum(a.cached_input_tokens), 0)
                        + coalesce(sum(a.cache_write_input_tokens), 0),
                    coalesce(sum(a.cached_input_tokens), 0),
                    coalesce(sum(CASE
                        WHEN a.agent_type IN ('codex-desktop', 'codex-cli') THEN
                            max(a.input_tokens - a.cached_input_tokens - a.cache_write_input_tokens, 0)
                        ELSE a.input_tokens
                    END), 0),
                    coalesce(sum(CASE
                        WHEN a.agent_type IN ('codex-desktop', 'codex-cli') THEN
                            max(a.input_tokens - a.cached_input_tokens - a.cache_write_input_tokens, 0)
                        ELSE a.input_tokens
                    END), 0)
                        + coalesce(sum(a.cached_input_tokens), 0)
                        + coalesce(sum(a.cache_write_input_tokens), 0),
                    coalesce(sum(a.output_tokens), 0)
                FROM agent_usage_events a
                WHERE strftime('%Y-%m-%d', a.event_time, 'localtime') = date('now', 'localtime')
                  AND NOT EXISTS (
                      SELECT 1 FROM request_logs rl
                      WHERE rl.agent_type = a.agent_type
                        AND rl.agent_session_id = a.session_id
                  )

                UNION ALL

                SELECT
                    coalesce(sum(d.known_tokens + d.native_total_tokens), 0),
                    coalesce(sum(
                        d.input_tokens + d.native_input_tokens
                        + d.native_cached_input_tokens + d.native_cache_write_input_tokens
                    ), 0),
                    coalesce(sum(d.input_cached_tokens + d.native_cached_input_tokens), 0),
                    coalesce(sum(d.input_uncached_tokens + d.native_input_tokens), 0),
                    coalesce(sum(
                        d.cache_measured_input_tokens + d.native_input_tokens
                        + d.native_cached_input_tokens + d.native_cache_write_input_tokens
                    ), 0),
                    coalesce(sum(d.output_tokens + d.native_output_tokens), 0)
                FROM device_daily_usage d
                WHERE d.usage_date = date('now', 'localtime')
            )
            SELECT
                coalesce(sum(total_tokens), 0),
                coalesce(sum(input_tokens), 0),
                coalesce(sum(input_cached_tokens), 0),
                coalesce(sum(input_uncached_tokens), 0),
                coalesce(sum(cache_measured_input_tokens), 0),
                coalesce(sum(output_tokens), 0)
            FROM today_sources
            "#,
            [],
            |row| {
                Ok(UsageTodaySummary {
                    total_tokens: row.get(0)?,
                    input_tokens: row.get(1)?,
                    input_cached_tokens: row.get(2)?,
                    input_uncached_tokens: row.get(3)?,
                    cache_measured_input_tokens: row.get(4)?,
                    output_tokens: row.get(5)?,
                })
            },
        )?;
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
                COALESCE(ca.name, rl.account_name) AS account_name,
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
            LEFT JOIN channel_accounts ca ON ca.id = rl.account_id
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

        // 模型筛选按用户所选分组匹配对应维度：
        // - "public"：只匹配对外模型（public/virtual）；
        // - "upstream"：只匹配路由目标模型（upstream）；
        // - 空串（兼容旧调用方）：两个维度 OR 匹配。
        let model_clause = if filter.model.is_empty() {
            None
        } else {
            match filter.model_kind.as_str() {
                "public" => {
                    refs.push(&filter.model);
                    Some("COALESCE(rl.public_model, rl.virtual_model) = ?")
                }
                "upstream" => {
                    refs.push(&filter.model);
                    Some("rl.upstream_model = ?")
                }
                _ => {
                    refs.push(&filter.model);
                    refs.push(&filter.model);
                    Some(
                        "(COALESCE(rl.public_model, rl.virtual_model) = ? OR rl.upstream_model = ?)",
                    )
                }
            }
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

        let start_clause = if filter.start_at.is_empty() {
            None
        } else {
            refs.push(&filter.start_at);
            Some("rl.created_at >= datetime(?)")
        };
        let end_clause = if filter.end_at.is_empty() {
            None
        } else {
            refs.push(&filter.end_at);
            Some("rl.created_at < datetime(?)")
        };
        let token_clause = match filter.token_status.as_str() {
            "unknown" => Some("ur.total_tokens IS NULL"),
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
            Some(
                "(rl.path LIKE ? OR rl.request_id = ? OR rl.error_message LIKE ? OR COALESCE(rl.public_model, rl.virtual_model, '') LIKE ? OR COALESCE(ca.name, rl.account_name, rl.account_id, '') LIKE ? OR COALESCE(rl.agent_session_id, '') LIKE ?)",
            )
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
        if let Some(c) = start_clause {
            clauses.push(c);
        }
        if let Some(c) = end_clause {
            clauses.push(c);
        }
        if let Some(c) = token_clause {
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
                COALESCE(SUM(COALESCE(ur.total_tokens, ur.input_tokens + ur.output_tokens)), 0),
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
            LEFT JOIN channel_accounts ca ON ca.id = rl.account_id
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
                rl.account_id, COALESCE(ca.name, rl.account_name) AS account_name, rl.client_protocol, rl.upstream_protocol,
                rl.virtual_model, rl.public_model, rl.upstream_model, rl.request_type, rl.method, rl.path,
                rl.status, rl.latency_ms, rl.is_stream, rl.error_message, rl.fallback_count,
                rl.route_reason, rl.created_at,
                rl.ttfb_ms, rl.duration_ms, rl.attempt_seq,
                rl.is_last_attempt,
                ur.input_tokens, ur.output_tokens,
                COALESCE(ur.total_tokens, ur.input_tokens + ur.output_tokens) AS total_tokens,
                ur.estimated_cost,
                ur.estimated_input_uncached_cost, ur.estimated_input_cached_cost,
                ur.estimated_input_cache_write_cost, ur.estimated_output_cost,
                rl.ttft_ms, ur.input_cached_tokens, ur.input_uncached_tokens, rl.upstream_url,
                rl.agent_type, rl.agent_session_id, rl.parent_agent_session_id
            FROM request_logs rl
            LEFT JOIN usage_records ur ON ur.request_id = rl.request_id
            LEFT JOIN channel_accounts ca ON ca.id = rl.account_id
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
                req_body_cleared_at: None,
                req_body_cleanup_reason: None,
                res_headers_json: None,
                res_body_b64: None,
                res_body_cleared_at: None,
                res_body_cleanup_reason: None,
                capture_state: None,
                capture_failure_reason: None,
                is_last_attempt: row.get::<_, i64>(26)? != 0,
                input_tokens: row.get(27)?,
                output_tokens: row.get(28)?,
                total_tokens: row.get(29)?,
                estimated_cost: row.get(30)?,
                estimated_input_uncached_cost: row.get(31)?,
                estimated_input_cached_cost: row.get(32)?,
                estimated_input_cache_write_cost: row.get(33)?,
                estimated_output_cost: row.get(34)?,
                ttft_ms: row.get(35)?,
                input_cached_tokens: row.get(36)?,
                input_uncached_tokens: row.get(37)?,
                upstream_url: row.get(38)?,
                agent_type: row.get(39)?,
                agent_session_id: row.get(40)?,
                parent_agent_session_id: row.get(41)?,
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
            runtime_status: "unknown".to_string(),
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
            estimated_input_uncached_cost: 0.0,
            estimated_input_cached_cost: 0.0,
            estimated_input_cache_write_cost: 0.0,
            estimated_output_cost: 0.0,
            native_summary: None,
            native_synced_at: None,
        }
    }

    #[test]
    fn filters_sessions_by_agent_type() {
        let codex = session("codex-desktop", false);
        assert!(matches_agent_session_type(&codex, "codex-desktop"));
        assert!(!matches_agent_session_type(&codex, "opencode"));
    }

    #[test]
    fn filters_sessions_by_runtime_status() {
        let mut idle = session("codex-desktop", false);
        idle.runtime_status = "idle".to_string();
        let mut running = session("opencode", true);
        running.runtime_status = "running".to_string();
        let mut waiting = session("opencode", false);
        waiting.runtime_status = "waiting_user".to_string();

        assert!(matches_agent_session_runtime_status(&idle, "idle"));
        assert!(matches_agent_session_runtime_status(&running, "running"));
        assert!(matches_agent_session_runtime_status(
            &waiting,
            "waiting_user"
        ));
        assert!(!matches_agent_session_runtime_status(&idle, "running"));
        assert!(!matches_agent_session_runtime_status(&running, "idle"));
    }

    #[test]
    fn empty_runtime_status_matches_any_session() {
        let idle = session("codex-desktop", false);
        let running = session("opencode", true);
        assert!(matches_agent_session_runtime_status(&idle, ""));
        assert!(matches_agent_session_runtime_status(&running, ""));
    }

    #[test]
    fn project_path_filter_includes_directory_and_descendants_only() {
        let mut row = session("codex-cli", false);
        row.project_path = Some("D:\\work\\flowlet\\src".to_string());
        assert!(session_matches_project_path(&row, "D:\\work\\flowlet"));
        assert!(session_matches_project_path(&row, "d:/work/flowlet/"));
        assert!(!session_matches_project_path(&row, "D:\\work\\flow"));
        assert!(!session_matches_project_path(&row, "D:\\work\\other"));
    }

    #[test]
    fn native_usage_summary_keeps_only_unobserved_root_sessions() {
        let mut native = session("codex-cli", false);
        native.session_id = "native-root".to_string();
        native.native_updated_at = Some("2026-07-20T08:30:00Z".to_string());
        native.native_summary = Some(crate::core::config::AgentSessionNativeSummary {
            source_available: false,
            truncated: false,
            turn_count: 3,
            usage: Some(crate::core::config::AgentSessionNativeUsage {
                input_tokens: 100,
                cached_input_tokens: 40,
                cache_write_input_tokens: 0,
                output_tokens: 20,
                reasoning_tokens: 5,
                total_tokens: 125,
                cost: None,
                cost_currency: None,
                api_equivalent: None,
                plan_consumption: None,
            }),
            models: vec!["gpt-5.6-sol".to_string()],
        });
        let mut observed = native.clone();
        observed.session_id = "observed".to_string();
        observed.flowlet_observed = true;
        let mut child = native.clone();
        child.session_id = "child".to_string();
        child.parent_session_id = Some("native-root".to_string());

        let rows = build_agent_native_usage_summary(vec![observed, child, native]);

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].session_id, "native-root");
        assert_eq!(rows[0].date, "2026-07-20");
        assert_eq!(rows[0].turn_count, 3);
        assert_eq!(
            rows[0].usage.as_ref().map(|usage| usage.total_tokens),
            Some(125)
        );
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

    fn max_preview_price() -> ModelPrice {
        ModelPrice {
            channel_id: "qwen".to_string(),
            upstream_model: "qwen3.8-max-preview".to_string(),
            input_uncached_price: 6.0,
            input_cached_price: 1.2,
            output_price: 24.0,
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

    fn qwen37_max_price() -> ModelPrice {
        ModelPrice {
            channel_id: "qwen".to_string(),
            upstream_model: "qwen3.7-max".to_string(),
            input_uncached_price: 4.0,
            input_cached_price: 0.8,
            output_price: 16.0,
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
        approx(cost.total, 8.4);
    }

    #[test]
    fn custom_channel_falls_back_to_the_models_official_price() {
        let prices = vec![flat_price()];
        let cost = estimate_cost(
            &prices,
            Some("custom"),
            Some("qwen3.6-flash"),
            Some(1_000_000),
            Some(0),
            Some(1_000_000),
            None,
            Some(1_000_000),
        )
        .unwrap();
        approx(cost.total, 8.4);
    }

    #[test]
    fn prices_qwen38_max_preview() {
        let prices = vec![max_preview_price()];
        let cost = estimate_cost(
            &prices,
            Some("qwen"),
            Some("qwen3.8-max-preview"),
            Some(1_000_000),
            Some(400_000),
            Some(600_000),
            None,
            Some(1_000_000),
        )
        .unwrap();
        // 600k uncached * 6.0 + 400k cached * 1.2 + 1M output * 24.0 = 3.6 + 0.48 + 24.0 = 28.08
        approx(cost.total, 28.08);
        approx(cost.input_uncached, 3.6);
        approx(cost.input_cached, 0.48);
        approx(cost.output, 24.0);
    }

    #[test]
    fn prices_qwen37_max() {
        let prices = vec![qwen37_max_price()];
        let cost = estimate_cost(
            &prices,
            Some("qwen"),
            Some("qwen3.7-max"),
            Some(500_000),
            Some(200_000),
            Some(300_000),
            None,
            Some(500_000),
        )
        .unwrap();
        // 300k uncached * 4.0 + 200k cached * 0.8 + 500k output * 16.0 = 1.2 + 0.16 + 8.0 = 9.36
        approx(cost.total, 9.36);
        approx(cost.input_uncached, 1.2);
        approx(cost.input_cached, 0.16);
        approx(cost.output, 8.0);
    }

    #[test]
    fn returns_none_without_matching_price() {
        let prices = vec![flat_price()];
        assert!(
            estimate_cost(
                &prices,
                Some("qwen"),
                Some("qwen3.8-max-preview"),
                Some(10),
                None,
                Some(10),
                None,
                Some(0)
            )
            .is_none()
        );
        assert!(
            estimate_cost(
                &prices,
                None,
                Some("qwen3.6-flash"),
                Some(10),
                None,
                Some(10),
                None,
                Some(0)
            )
            .is_none()
        );
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
        approx(cost.total, 0.224);
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
        approx(cost.total, 2.592);
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
        approx(at_limit.total, 262144.0 * 1.6 / 1_000_000.0);
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
        approx(over_limit.total, 262145.0 * 4.8 / 1_000_000.0);
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
        approx(cost.total, 0.1616);
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
