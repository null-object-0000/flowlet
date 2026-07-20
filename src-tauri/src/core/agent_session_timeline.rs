use super::config::{
    AgentSessionCostEstimate, AgentSessionNativeUsage, AgentSessionTimeline,
    AgentSessionTimelineEvent, ModelPrice,
};
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OpenFlags};
use serde_json::Value;
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

const MAX_SESSION_ID_BYTES: usize = 512;
const MAX_TIMELINE_FILE_BYTES: usize = 16 * 1024 * 1024;
const MAX_TIMELINE_EVENTS: usize = 300;
const MAX_EVENT_CONTENT_CHARS: usize = 8_000;
pub const AGENT_SUMMARY_PARSER_VERSION: i64 = 3;

#[derive(Debug, Clone)]
pub struct AgentSessionSummaryCheckpoint {
    pub summary: super::config::AgentSessionNativeSummary,
    pub source_offset: u64,
    pub parser_version: i64,
    pub usage_ids: Vec<String>,
    pub cursor_guard: String,
}

#[derive(Debug, Clone)]
pub struct AgentSessionSummaryParseResult {
    pub summary: super::config::AgentSessionNativeSummary,
    pub source_offset: u64,
    pub parser_version: i64,
    pub usage_ids: Vec<String>,
    pub cursor_guard: String,
    pub complete: bool,
    pub incremental: bool,
    pub bytes_processed: u64,
}

pub fn get_native_agent_session_timeline(
    agent_type: &str,
    session_id: &str,
) -> Result<AgentSessionTimeline, String> {
    let agent_type = agent_type.trim();
    let session_id = session_id.trim();
    if session_id.is_empty() || session_id.len() > MAX_SESSION_ID_BYTES {
        return Err("无效的 Agent 会话 ID".to_string());
    }
    match agent_type {
        "opencode" => read_opencode_timeline(session_id),
        "claude-code" => read_claude_timeline(session_id),
        "codex-desktop" | "codex-cli" => read_codex_timeline(agent_type, session_id),
        _ => Err(format!("暂不支持读取 Agent 会话时间线：{agent_type}")),
    }
}

pub fn get_native_agent_session_summary(
    agent_type: &str,
    session_id: &str,
) -> Result<super::config::AgentSessionNativeSummary, String> {
    let timeline = get_native_agent_session_timeline(agent_type, session_id)?;
    Ok(summarize_timeline(timeline))
}

pub fn apply_native_cost_estimate_to_timeline(
    agent_type: &str,
    timeline: &mut AgentSessionTimeline,
    prices: &[ModelPrice],
) {
    if !matches!(agent_type, "codex-desktop" | "codex-cli") {
        return;
    }
    for event in &mut timeline.events {
        if let (Some(model), Some(usage)) = (event.model.as_deref(), event.usage.as_mut()) {
            usage.api_equivalent = Some(estimate_usage_cost(usage, model, prices, "openai-api", 1));
            usage.plan_consumption =
                Some(estimate_usage_cost(usage, model, prices, "codex-native", 1));
        }
    }
    if let Some(usage) = timeline.usage.as_mut() {
        let turns = timeline.turn_count.max(1);
        if timeline.models.len() == 1 {
            usage.api_equivalent = Some(estimate_usage_cost(
                usage,
                &timeline.models[0],
                prices,
                "openai-api",
                turns,
            ));
            usage.plan_consumption = Some(estimate_usage_cost(
                usage,
                &timeline.models[0],
                prices,
                "codex-native",
                turns,
            ));
        } else if !timeline.truncated {
            usage.api_equivalent =
                aggregate_estimates(timeline.events.iter().filter_map(|event| {
                    event
                        .usage
                        .as_ref()
                        .and_then(|usage| usage.api_equivalent.as_ref())
                }));
            usage.plan_consumption =
                aggregate_estimates(timeline.events.iter().filter_map(|event| {
                    event
                        .usage
                        .as_ref()
                        .and_then(|usage| usage.plan_consumption.as_ref())
                }));
        } else {
            usage.api_equivalent = Some(unpriced_estimate(turns));
            usage.plan_consumption = Some(unpriced_estimate(turns));
        }
    }
}

pub fn apply_native_cost_estimate_to_summary(
    agent_type: &str,
    summary: &mut super::config::AgentSessionNativeSummary,
    prices: &[ModelPrice],
) {
    if !matches!(agent_type, "codex-desktop" | "codex-cli") {
        return;
    }
    if let Some(usage) = summary.usage.as_mut() {
        let turns = summary.turn_count.max(1);
        if summary.models.len() == 1 {
            usage.api_equivalent = Some(estimate_usage_cost(
                usage,
                &summary.models[0],
                prices,
                "openai-api",
                turns,
            ));
            usage.plan_consumption = Some(estimate_usage_cost(
                usage,
                &summary.models[0],
                prices,
                "codex-native",
                turns,
            ));
        } else {
            usage.api_equivalent = Some(unpriced_estimate(turns));
            usage.plan_consumption = Some(unpriced_estimate(turns));
        }
    }
}

fn estimate_usage_cost(
    usage: &AgentSessionNativeUsage,
    model: &str,
    prices: &[ModelPrice],
    price_namespace: &str,
    turn_count: i64,
) -> AgentSessionCostEstimate {
    let Some(price) = prices.iter().find(|price| {
        price.channel_id == price_namespace
            && price.upstream_model.eq_ignore_ascii_case(model.trim())
    }) else {
        return unpriced_estimate(turn_count);
    };
    // 按会话总输入 Token 选档；无分级时回退扁平单价。
    let (uncached_price, cached_price, cache_write_price, output_price) =
        price.resolve_prices(Some(usage.input_tokens));
    let cached_input = usage.cached_input_tokens.max(0) as f64;
    let cache_write_input = usage.cache_write_input_tokens.max(0) as f64;
    let uncached_input = usage
        .input_tokens
        .saturating_sub(usage.cached_input_tokens)
        .saturating_sub(usage.cache_write_input_tokens)
        .max(0) as f64;
    let output = usage.output_tokens.max(0) as f64;
    AgentSessionCostEstimate {
        amount: Some(
            (uncached_input * uncached_price
                + cached_input * cached_price
                + cache_write_input * cache_write_price.unwrap_or(uncached_price)
                + output * output_price)
                / 1_000_000.0,
        ),
        currency: Some(price.currency.clone()),
        source_url: price.source_url.clone(),
        price_version: price.price_version.clone(),
        priced_turn_count: turn_count,
        unpriced_turn_count: 0,
    }
}

fn unpriced_estimate(turn_count: i64) -> AgentSessionCostEstimate {
    AgentSessionCostEstimate {
        amount: None,
        currency: None,
        source_url: None,
        price_version: None,
        priced_turn_count: 0,
        unpriced_turn_count: turn_count,
    }
}

fn aggregate_estimates<'a>(
    estimates: impl Iterator<Item = &'a AgentSessionCostEstimate>,
) -> Option<AgentSessionCostEstimate> {
    let estimates = estimates.collect::<Vec<_>>();
    let first = estimates.first()?;
    let priced_turn_count = estimates.iter().map(|item| item.priced_turn_count).sum();
    let unpriced_turn_count = estimates.iter().map(|item| item.unpriced_turn_count).sum();
    let same_currency = estimates.iter().all(|item| item.currency == first.currency);
    let amount = (unpriced_turn_count == 0 && same_currency)
        .then(|| estimates.iter().filter_map(|item| item.amount).sum::<f64>());
    Some(AgentSessionCostEstimate {
        amount,
        currency: same_currency.then(|| first.currency.clone()).flatten(),
        source_url: first.source_url.clone(),
        price_version: first.price_version.clone(),
        priced_turn_count,
        unpriced_turn_count,
    })
}

pub fn get_native_agent_session_summary_incremental(
    agent_type: &str,
    session_id: &str,
    checkpoint: Option<AgentSessionSummaryCheckpoint>,
) -> Result<AgentSessionSummaryParseResult, String> {
    let path = match agent_type {
        "claude-code" => dirs::home_dir().and_then(|home| {
            find_jsonl_by_stem(&home.join(".claude").join("projects"), session_id)
        }),
        "codex-desktop" | "codex-cli" => find_codex_session_file(
            &crate::core::codex_account::codex_home().join("sessions"),
            agent_type,
            session_id,
        ),
        _ => None,
    };
    let Some(path) = path else {
        let summary = get_native_agent_session_summary(agent_type, session_id)?;
        return Ok(AgentSessionSummaryParseResult {
            summary,
            source_offset: 0,
            parser_version: AGENT_SUMMARY_PARSER_VERSION,
            usage_ids: Vec::new(),
            cursor_guard: String::new(),
            complete: true,
            incremental: false,
            bytes_processed: 0,
        });
    };
    let source_size = fs::metadata(&path)
        .map_err(|error| format!("无法读取原生会话文件信息：{error}"))?
        .len();
    let resume_offset = checkpoint.as_ref().and_then(|checkpoint| {
        let current_guard = source_cursor_guard(&path, checkpoint.source_offset).ok()?;
        resumable_offset(checkpoint, source_size, &current_guard)
    });
    let can_resume = resume_offset.is_some();
    let start_offset = resume_offset.unwrap_or(0);
    let seen_usage_ids = checkpoint
        .as_ref()
        .filter(|_| can_resume)
        .map(|checkpoint| checkpoint.usage_ids.iter().cloned().collect())
        .unwrap_or_default();
    let (delta, source_offset, usage_ids) =
        read_jsonl_summary_range(&path, agent_type, start_offset, seen_usage_ids)?;
    let complete = source_offset >= source_size;
    let mut summary = if can_resume {
        merge_incremental_summary(
            agent_type,
            checkpoint.expect("resume checkpoint must exist").summary,
            delta,
        )
    } else {
        delta
    };
    summary.truncated = !complete;
    let mut usage_ids = usage_ids.into_iter().collect::<Vec<_>>();
    usage_ids.sort_unstable();
    let cursor_guard = source_cursor_guard(&path, source_offset)?;
    Ok(AgentSessionSummaryParseResult {
        summary,
        source_offset,
        parser_version: AGENT_SUMMARY_PARSER_VERSION,
        usage_ids,
        cursor_guard,
        complete,
        incremental: can_resume,
        bytes_processed: source_offset.saturating_sub(start_offset),
    })
}

fn resumable_offset(
    checkpoint: &AgentSessionSummaryCheckpoint,
    source_size: u64,
    current_guard: &str,
) -> Option<u64> {
    (checkpoint.parser_version == AGENT_SUMMARY_PARSER_VERSION
        && checkpoint.source_offset > 0
        && checkpoint.source_offset < source_size)
        .then_some(())
        .filter(|_| checkpoint.cursor_guard == current_guard)
        .map(|_| checkpoint.source_offset)
}

fn source_cursor_guard(path: &Path, offset: u64) -> Result<String, String> {
    const GUARD_BYTES: u64 = 4 * 1024;
    let mut file =
        File::open(path).map_err(|error| format!("无法读取原生会话游标校验：{error}"))?;
    let start = offset.saturating_sub(GUARD_BYTES);
    file.seek(SeekFrom::Start(start))
        .map_err(|error| format!("无法定位原生会话游标校验：{error}"))?;
    let mut buffer = vec![0u8; (offset - start) as usize];
    file.read_exact(&mut buffer)
        .map_err(|error| format!("无法读取原生会话游标校验：{error}"))?;
    let hash = buffer.iter().fold(0xcbf29ce484222325u64, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
    });
    Ok(format!("{start}:{offset}:{hash:016x}"))
}

fn summarize_timeline(timeline: AgentSessionTimeline) -> super::config::AgentSessionNativeSummary {
    let turn_count = if timeline.turn_count > 0 {
        timeline.turn_count
    } else {
        let native_turn_count = timeline
            .events
            .iter()
            .filter(|event| event.kind == "turn")
            .count();
        let usage_turn_count = timeline
            .events
            .iter()
            .filter(|event| event.usage.is_some())
            .count();
        if native_turn_count > 0 {
            native_turn_count as i64
        } else if usage_turn_count > 0 {
            usage_turn_count as i64
        } else {
            timeline
                .events
                .iter()
                .filter(|event| event.kind == "user-message")
                .count() as i64
        }
    };
    super::config::AgentSessionNativeSummary {
        source_available: timeline.source_available,
        truncated: timeline.truncated,
        turn_count,
        usage: timeline.usage,
        models: timeline.models,
    }
}

fn empty_timeline() -> AgentSessionTimeline {
    AgentSessionTimeline {
        source_available: false,
        truncated: false,
        turn_count: 0,
        usage: None,
        models: Vec::new(),
        events: Vec::new(),
    }
}

fn read_opencode_timeline(session_id: &str) -> Result<AgentSessionTimeline, String> {
    for database_path in opencode_database_candidates() {
        if !database_path.is_file() {
            continue;
        }
        let connection = match Connection::open_with_flags(
            &database_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        ) {
            Ok(connection) => connection,
            Err(_) => continue,
        };
        let _ = connection.busy_timeout(std::time::Duration::from_millis(750));
        let exists = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM session WHERE id = ?1)",
                params![session_id],
                |row| row.get::<_, bool>(0),
            )
            .unwrap_or(false);
        if !exists {
            continue;
        }
        return read_opencode_timeline_from(&connection, session_id);
    }
    Ok(empty_timeline())
}

fn read_opencode_timeline_from(
    connection: &Connection,
    session_id: &str,
) -> Result<AgentSessionTimeline, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT m.id, m.time_created, m.data, p.id, p.time_created, p.data
            FROM message m
            LEFT JOIN part p ON p.message_id = m.id
            WHERE m.session_id = ?1
            ORDER BY COALESCE(p.time_created, m.time_created), m.id, p.id
            "#,
        )
        .map_err(|error| format!("OpenCode 会话数据结构不兼容：{error}"))?;
    let rows = statement
        .query_map(params![session_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<i64>>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<i64>>(4)?,
                row.get::<_, Option<String>>(5)?,
            ))
        })
        .map_err(|error| format!("读取 OpenCode 会话失败：{error}"))?;

    let mut timeline = AgentSessionTimeline {
        source_available: true,
        truncated: false,
        turn_count: 0,
        usage: read_opencode_session_usage(connection, session_id),
        models: read_opencode_session_models(connection, session_id),
        events: Vec::new(),
    };
    let mut usage_messages = HashSet::new();
    for row in rows {
        let (message_id, message_time, message_json, part_id, part_time, part_json) =
            row.map_err(|error| format!("读取 OpenCode 会话失败：{error}"))?;
        let Ok(message) = serde_json::from_str::<Value>(&message_json) else {
            continue;
        };
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let model = message_model(&message);
        if let Some(model) = model.as_deref() {
            remember_model(&mut timeline, model);
        }
        let Some(part_json) = part_json else {
            continue;
        };
        let Ok(part) = serde_json::from_str::<Value>(&part_json) else {
            continue;
        };
        let event_id = part_id.unwrap_or_else(|| message_id.clone());
        let timestamp = part_time.or(message_time).and_then(format_unix_millis);
        let event_start = timeline.events.len();
        match part.get("type").and_then(Value::as_str) {
            Some("text") => push_event(
                &mut timeline,
                event_id,
                role_kind(role),
                timestamp,
                None,
                string_field(&part, "text"),
                model,
                None,
            ),
            Some("reasoning") => push_event(
                &mut timeline,
                event_id,
                "reasoning",
                timestamp,
                Some("思考摘要".to_string()),
                string_field(&part, "text"),
                model,
                None,
            ),
            Some("tool") => push_opencode_tool_events(&mut timeline, event_id, timestamp, &part),
            _ => {}
        }
        if role == "assistant" && usage_messages.insert(message_id) {
            timeline.turn_count += 1;
            attach_usage_to_first_event(
                &mut timeline,
                event_start,
                usage_from_opencode_message(&message),
            );
        }
    }
    Ok(timeline)
}

fn read_opencode_session_usage(
    connection: &Connection,
    session_id: &str,
) -> Option<AgentSessionNativeUsage> {
    connection
        .query_row(
            r#"
            SELECT tokens_input, tokens_cache_read, tokens_cache_write,
                   tokens_output, tokens_reasoning, cost
            FROM session WHERE id = ?1
            "#,
            params![session_id],
            |row| {
                let input_tokens = row.get::<_, Option<i64>>(0)?.unwrap_or_default();
                let cached_input_tokens = row.get::<_, Option<i64>>(1)?.unwrap_or_default();
                let cache_write_input_tokens = row.get::<_, Option<i64>>(2)?.unwrap_or_default();
                let output_tokens = row.get::<_, Option<i64>>(3)?.unwrap_or_default();
                let reasoning_tokens = row.get::<_, Option<i64>>(4)?.unwrap_or_default();
                Ok(AgentSessionNativeUsage {
                    input_tokens,
                    cached_input_tokens,
                    cache_write_input_tokens,
                    output_tokens,
                    reasoning_tokens,
                    total_tokens: input_tokens + output_tokens + reasoning_tokens,
                    cost: row.get(5)?,
                    cost_currency: Some("USD".to_string()),
                    api_equivalent: None,
                    plan_consumption: None,
                })
            },
        )
        .ok()
}

fn read_opencode_session_models(connection: &Connection, session_id: &str) -> Vec<String> {
    let model = connection
        .query_row(
            "SELECT model FROM session WHERE id = ?1",
            params![session_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten();
    let Some(model) = model else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<Value>(&model) else {
        return vec![model];
    };
    string_field(&value, "id")
        .or_else(|| string_field(&value, "modelID"))
        .into_iter()
        .collect()
}

fn usage_from_opencode_message(message: &Value) -> Option<AgentSessionNativeUsage> {
    let tokens = message.get("tokens")?;
    let cache = tokens.get("cache").unwrap_or(&Value::Null);
    Some(AgentSessionNativeUsage {
        input_tokens: integer_field(tokens, "input"),
        cached_input_tokens: integer_field(cache, "read"),
        cache_write_input_tokens: integer_field(cache, "write"),
        output_tokens: integer_field(tokens, "output"),
        reasoning_tokens: integer_field(tokens, "reasoning"),
        total_tokens: integer_field(tokens, "total"),
        cost: number_field(message, "cost"),
        cost_currency: Some("USD".to_string()),
        api_equivalent: None,
        plan_consumption: None,
    })
}

fn push_opencode_tool_events(
    timeline: &mut AgentSessionTimeline,
    event_id: String,
    timestamp: Option<String>,
    part: &Value,
) {
    let tool = string_field(part, "tool").unwrap_or_else(|| "Tool".to_string());
    let state = part.get("state").unwrap_or(&Value::Null);
    let status = string_field(state, "status");
    if let Some(input) = state.get("input").and_then(render_json_value) {
        push_event(
            timeline,
            format!("{event_id}:call"),
            "tool-call",
            timestamp.clone(),
            Some(tool.clone()),
            Some(input),
            None,
            status.clone(),
        );
    }
    let result = state
        .get("output")
        .and_then(render_json_value)
        .or_else(|| state.get("error").and_then(render_json_value));
    if let Some(result) = result {
        let kind = if state.get("error").is_some() {
            "error"
        } else {
            "tool-result"
        };
        push_event(
            timeline,
            format!("{event_id}:result"),
            kind,
            timestamp,
            Some(tool),
            Some(result),
            None,
            status,
        );
    }
}

fn read_claude_timeline(session_id: &str) -> Result<AgentSessionTimeline, String> {
    let Some(home) = dirs::home_dir() else {
        return Ok(empty_timeline());
    };
    let root = home.join(".claude").join("projects");
    let Some(path) = find_jsonl_by_stem(&root, session_id) else {
        return Ok(empty_timeline());
    };
    read_jsonl_timeline(&path, parse_claude_line)
}

fn parse_claude_line(
    value: &Value,
    index: usize,
    timeline: &mut AgentSessionTimeline,
    seen_usage_ids: &mut HashSet<String>,
) {
    let outer_type = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !matches!(outer_type, "user" | "assistant")
        || value
            .get("isMeta")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    {
        return;
    }
    let Some(message) = value.get("message") else {
        return;
    };
    let timestamp = string_field(value, "timestamp");
    let base_id = string_field(value, "uuid").unwrap_or_else(|| format!("line-{index}"));
    let model = string_field(message, "model");
    if let Some(model) = model.as_deref() {
        remember_model(timeline, model);
    }
    let event_start = timeline.events.len();
    match message.get("content") {
        Some(Value::String(content)) => push_event(
            timeline,
            base_id.clone(),
            role_kind(outer_type),
            timestamp,
            None,
            Some(content.clone()),
            model,
            None,
        ),
        Some(Value::Array(content)) => {
            for (content_index, item) in content.iter().enumerate() {
                let event_id = format!("{base_id}:{content_index}");
                match item.get("type").and_then(Value::as_str) {
                    Some("text") => push_event(
                        timeline,
                        event_id,
                        role_kind(outer_type),
                        timestamp.clone(),
                        None,
                        string_field(item, "text"),
                        model.clone(),
                        None,
                    ),
                    Some("thinking") => push_event(
                        timeline,
                        event_id,
                        "reasoning",
                        timestamp.clone(),
                        Some("思考摘要".to_string()),
                        string_field(item, "thinking"),
                        model.clone(),
                        None,
                    ),
                    Some("tool_use") => push_event(
                        timeline,
                        event_id,
                        "tool-call",
                        timestamp.clone(),
                        string_field(item, "name"),
                        item.get("input").and_then(render_json_value),
                        model.clone(),
                        None,
                    ),
                    Some("tool_result") => {
                        let is_error = item
                            .get("is_error")
                            .and_then(Value::as_bool)
                            .unwrap_or(false);
                        push_event(
                            timeline,
                            event_id,
                            if is_error { "error" } else { "tool-result" },
                            timestamp.clone(),
                            Some("Tool result".to_string()),
                            item.get("content").and_then(render_json_value),
                            model.clone(),
                            None,
                        );
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }
    if outer_type == "assistant" {
        let usage_id = string_field(message, "id").unwrap_or(base_id);
        if seen_usage_ids.insert(usage_id) {
            timeline.turn_count += 1;
            let usage = usage_from_claude_message(message);
            attach_usage_to_first_event(timeline, event_start, usage.clone());
            if let Some(usage) = usage {
                add_usage_to_summary(timeline, &usage);
            }
        }
    }
}

fn read_codex_timeline(agent_type: &str, session_id: &str) -> Result<AgentSessionTimeline, String> {
    let root = crate::core::codex_account::codex_home().join("sessions");
    let Some(path) = find_codex_session_file(&root, agent_type, session_id) else {
        return Ok(empty_timeline());
    };
    read_jsonl_timeline(&path, parse_codex_line)
}

fn parse_codex_line(
    value: &Value,
    index: usize,
    timeline: &mut AgentSessionTimeline,
    _seen_usage_ids: &mut HashSet<String>,
) {
    let top_type = value.get("type").and_then(Value::as_str);
    let payload = value.get("payload").unwrap_or(&Value::Null);
    if top_type == Some("turn_context") {
        if let Some(model) = string_field(payload, "model") {
            remember_model(timeline, &model);
            if let Some(event) =
                timeline.events.iter_mut().rev().find(|event| {
                    event.kind == "turn" && event.status.as_deref() == Some("running")
                })
            {
                event.model = Some(model);
            }
        }
        return;
    }
    if top_type == Some("event_msg") {
        match payload.get("type").and_then(Value::as_str) {
            Some("task_started") => {
                timeline.turn_count += 1;
                let turn_id =
                    string_field(payload, "turn_id").unwrap_or_else(|| format!("turn-{index}"));
                push_event(
                    timeline,
                    turn_id,
                    "turn",
                    string_field(value, "timestamp"),
                    Some("Agent 轮次".to_string()),
                    None,
                    None,
                    Some("running".to_string()),
                );
            }
            Some("task_complete") => {
                let turn_id = string_field(payload, "turn_id");
                if let Some(event) = timeline.events.iter_mut().rev().find(|event| {
                    event.kind == "turn"
                        && (turn_id.is_none() || turn_id.as_deref() == Some(event.id.as_str()))
                }) {
                    event.status = Some("completed".to_string());
                    event.duration_ms = optional_integer_field(payload, "duration_ms");
                    event.time_to_first_token_ms =
                        optional_integer_field(payload, "time_to_first_token_ms");
                }
            }
            Some("task_aborted" | "turn_aborted") => {
                if let Some(event) = timeline.events.iter_mut().rev().find(|event| {
                    event.kind == "turn" && event.status.as_deref() == Some("running")
                }) {
                    event.status = Some("cancelled".to_string());
                }
            }
            Some("token_count") => attach_codex_token_count(payload, timeline),
            _ => {}
        }
        return;
    }
    if top_type != Some("response_item") {
        return;
    }

    fn attach_codex_token_count(payload: &Value, timeline: &mut AgentSessionTimeline) {
        if let Some(info) = payload.get("info") {
            let last_usage = info
                .get("last_token_usage")
                .and_then(usage_from_codex_token_value);
            if let Some(usage) = last_usage {
                if let Some(event) = timeline.events.iter_mut().rev().find(|event| {
                    event.kind == "turn" && event.status.as_deref() == Some("running")
                }) {
                    add_usage(&mut event.usage, &usage);
                }
            }
            if let Some(total_usage) = info
                .get("total_token_usage")
                .and_then(usage_from_codex_token_value)
            {
                timeline.usage = Some(total_usage);
            }
        }
    }
    let timestamp = string_field(value, "timestamp");
    let base_id = string_field(payload, "id").unwrap_or_else(|| format!("line-{index}"));
    match payload.get("type").and_then(Value::as_str) {
        Some("message") => {
            let role = payload
                .get("role")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if !matches!(role, "user" | "assistant") {
                return;
            }
            if let Some(content) = payload.get("content").and_then(Value::as_array) {
                for (content_index, item) in content.iter().enumerate() {
                    if matches!(
                        item.get("type").and_then(Value::as_str),
                        Some("input_text" | "output_text")
                    ) {
                        push_event(
                            timeline,
                            format!("{base_id}:{content_index}"),
                            role_kind(role),
                            timestamp.clone(),
                            None,
                            string_field(item, "text"),
                            None,
                            None,
                        );
                    }
                }
            }
        }
        Some("function_call" | "custom_tool_call") => {
            let call_id = string_field(payload, "call_id").unwrap_or(base_id);
            push_event(
                timeline,
                call_id,
                "tool-call",
                timestamp,
                string_field(payload, "name"),
                payload
                    .get("arguments")
                    .or_else(|| payload.get("input"))
                    .and_then(render_json_value),
                None,
                string_field(payload, "status"),
            );
        }
        Some("function_call_output" | "custom_tool_call_output") => {
            let call_id = string_field(payload, "call_id").unwrap_or(base_id);
            let title = timeline
                .events
                .iter()
                .rev()
                .find(|event| event.kind == "tool-call" && event.id == call_id)
                .and_then(|event| event.title.clone())
                .unwrap_or_else(|| "Tool result".to_string());
            push_event(
                timeline,
                format!("{call_id}:result"),
                "tool-result",
                timestamp,
                Some(title),
                payload.get("output").and_then(render_json_value),
                None,
                string_field(payload, "status"),
            );
        }
        Some("reasoning") => push_event(
            timeline,
            base_id,
            "reasoning",
            timestamp,
            Some("思考摘要".to_string()),
            payload.get("summary").and_then(render_json_value),
            None,
            None,
        ),
        _ => {}
    }
}

fn read_jsonl_timeline(
    path: &Path,
    parser: fn(&Value, usize, &mut AgentSessionTimeline, &mut HashSet<String>),
) -> Result<AgentSessionTimeline, String> {
    let file = File::open(path).map_err(|error| format!("无法读取原生会话文件：{error}"))?;
    let mut timeline = AgentSessionTimeline {
        source_available: true,
        truncated: false,
        turn_count: 0,
        usage: None,
        models: Vec::new(),
        events: Vec::new(),
    };
    let mut bytes_read = 0usize;
    let mut seen_usage_ids = HashSet::new();
    for (index, line) in BufReader::new(file).lines().enumerate() {
        let line = line.map_err(|error| format!("读取原生会话文件失败：{error}"))?;
        bytes_read = bytes_read.saturating_add(line.len());
        if bytes_read > MAX_TIMELINE_FILE_BYTES {
            timeline.truncated = true;
            break;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        parser(&value, index, &mut timeline, &mut seen_usage_ids);
    }
    Ok(timeline)
}

fn read_jsonl_summary_range(
    path: &Path,
    agent_type: &str,
    start_offset: u64,
    mut seen_usage_ids: HashSet<String>,
) -> Result<
    (
        super::config::AgentSessionNativeSummary,
        u64,
        HashSet<String>,
    ),
    String,
> {
    let mut file = File::open(path).map_err(|error| format!("无法读取原生会话文件：{error}"))?;
    file.seek(SeekFrom::Start(start_offset))
        .map_err(|error| format!("无法定位原生会话增量游标：{error}"))?;
    let mut reader = BufReader::new(file);
    let mut summary = super::config::AgentSessionNativeSummary {
        source_available: true,
        truncated: false,
        turn_count: 0,
        usage: None,
        models: Vec::new(),
    };
    let mut bytes_read = 0usize;
    let mut line = String::new();
    loop {
        line.clear();
        let length = reader
            .read_line(&mut line)
            .map_err(|error| format!("读取原生会话文件失败：{error}"))?;
        if length == 0 {
            break;
        }
        bytes_read = bytes_read.saturating_add(length);
        if let Ok(value) = serde_json::from_str::<Value>(&line) {
            parse_jsonl_summary_line(agent_type, &value, &mut summary, &mut seen_usage_ids);
        }
        if bytes_read >= MAX_TIMELINE_FILE_BYTES {
            break;
        }
    }
    let source_offset = reader
        .stream_position()
        .map_err(|error| format!("无法记录原生会话增量游标：{error}"))?;
    Ok((summary, source_offset, seen_usage_ids))
}

fn parse_jsonl_summary_line(
    agent_type: &str,
    value: &Value,
    summary: &mut super::config::AgentSessionNativeSummary,
    seen_usage_ids: &mut HashSet<String>,
) {
    if agent_type == "claude-code" {
        if value.get("type").and_then(Value::as_str) != Some("assistant")
            || value.get("isMeta").and_then(Value::as_bool) == Some(true)
        {
            return;
        }
        let Some(message) = value.get("message") else {
            return;
        };
        if let Some(model) = string_field(message, "model") {
            remember_summary_model(summary, model);
        }
        let usage_id = string_field(message, "id")
            .or_else(|| string_field(value, "uuid"))
            .unwrap_or_default();
        if usage_id.is_empty() || !seen_usage_ids.insert(usage_id) {
            return;
        }
        summary.turn_count += 1;
        if let Some(usage) = usage_from_claude_message(message) {
            add_native_usage(&mut summary.usage, &usage);
        }
        return;
    }

    let top_type = value.get("type").and_then(Value::as_str);
    let payload = value.get("payload").unwrap_or(&Value::Null);
    if top_type == Some("turn_context") {
        if let Some(model) = string_field(payload, "model") {
            remember_summary_model(summary, model);
        }
    } else if top_type == Some("event_msg") {
        match payload.get("type").and_then(Value::as_str) {
            Some("task_started") => summary.turn_count += 1,
            Some("token_count") => {
                if let Some(usage) = payload
                    .get("info")
                    .and_then(|info| info.get("total_token_usage"))
                    .and_then(usage_from_codex_token_value)
                {
                    summary.usage = Some(usage);
                }
            }
            _ => {}
        }
    }
}

fn merge_incremental_summary(
    agent_type: &str,
    mut previous: super::config::AgentSessionNativeSummary,
    delta: super::config::AgentSessionNativeSummary,
) -> super::config::AgentSessionNativeSummary {
    previous.source_available |= delta.source_available;
    previous.turn_count += delta.turn_count;
    for model in delta.models {
        remember_summary_model(&mut previous, model);
    }
    if agent_type == "claude-code" {
        if let Some(usage) = delta.usage {
            add_native_usage(&mut previous.usage, &usage);
        }
    } else if delta.usage.is_some() {
        previous.usage = delta.usage;
    }
    previous
}

fn remember_summary_model(summary: &mut super::config::AgentSessionNativeSummary, model: String) {
    if !model.is_empty() && !summary.models.iter().any(|value| value == &model) {
        summary.models.push(model);
    }
}

fn add_native_usage(target: &mut Option<AgentSessionNativeUsage>, usage: &AgentSessionNativeUsage) {
    let total = target.get_or_insert_with(Default::default);
    total.input_tokens += usage.input_tokens;
    total.cached_input_tokens += usage.cached_input_tokens;
    total.cache_write_input_tokens += usage.cache_write_input_tokens;
    total.output_tokens += usage.output_tokens;
    total.reasoning_tokens += usage.reasoning_tokens;
    total.total_tokens += usage.total_tokens;
}

fn push_event(
    timeline: &mut AgentSessionTimeline,
    id: String,
    kind: &str,
    timestamp: Option<String>,
    title: Option<String>,
    content: Option<String>,
    model: Option<String>,
    status: Option<String>,
) {
    if timeline.events.len() >= MAX_TIMELINE_EVENTS {
        timeline.truncated = true;
        return;
    }
    let content = content
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(|value| truncate_chars(&value, MAX_EVENT_CONTENT_CHARS));
    if content.is_none() && title.is_none() {
        return;
    }
    timeline.events.push(AgentSessionTimelineEvent {
        id,
        kind: kind.to_string(),
        source: "agent-native".to_string(),
        timestamp,
        title,
        content,
        model,
        status,
        duration_ms: None,
        time_to_first_token_ms: None,
        usage: None,
    });
}

fn role_kind(role: &str) -> &'static str {
    if role == "assistant" {
        "assistant-message"
    } else {
        "user-message"
    }
}

fn message_model(value: &Value) -> Option<String> {
    string_field(value, "modelID").or_else(|| {
        value
            .get("model")
            .and_then(|model| string_field(model, "modelID").or_else(|| string_field(model, "id")))
    })
}

fn usage_from_claude_message(message: &Value) -> Option<AgentSessionNativeUsage> {
    let usage = message.get("usage")?;
    let input_tokens = integer_field(usage, "input_tokens");
    let cached_input_tokens = integer_field(usage, "cache_read_input_tokens");
    let cache_write_input_tokens = integer_field(usage, "cache_creation_input_tokens");
    let output_tokens = integer_field(usage, "output_tokens");
    Some(AgentSessionNativeUsage {
        input_tokens,
        cached_input_tokens,
        cache_write_input_tokens,
        output_tokens,
        reasoning_tokens: 0,
        total_tokens: input_tokens + cached_input_tokens + cache_write_input_tokens + output_tokens,
        cost: None,
        cost_currency: None,
        api_equivalent: None,
        plan_consumption: None,
    })
}

fn usage_from_codex_token_value(value: &Value) -> Option<AgentSessionNativeUsage> {
    Some(AgentSessionNativeUsage {
        input_tokens: integer_field(value, "input_tokens"),
        cached_input_tokens: integer_field(value, "cached_input_tokens"),
        cache_write_input_tokens: integer_field(value, "cache_write_input_tokens"),
        output_tokens: integer_field(value, "output_tokens"),
        reasoning_tokens: integer_field(value, "reasoning_output_tokens"),
        total_tokens: integer_field(value, "total_tokens"),
        cost: None,
        cost_currency: None,
        api_equivalent: None,
        plan_consumption: None,
    })
}

fn attach_usage_to_first_event(
    timeline: &mut AgentSessionTimeline,
    event_start: usize,
    usage: Option<AgentSessionNativeUsage>,
) {
    let Some(usage) = usage else {
        return;
    };
    if let Some(event) = timeline.events.get_mut(event_start) {
        event.usage = Some(usage);
    }
}

fn add_usage_to_summary(timeline: &mut AgentSessionTimeline, usage: &AgentSessionNativeUsage) {
    add_usage(&mut timeline.usage, usage);
}

fn add_usage(target: &mut Option<AgentSessionNativeUsage>, usage: &AgentSessionNativeUsage) {
    let summary = target.get_or_insert_with(Default::default);
    summary.input_tokens += usage.input_tokens;
    summary.cached_input_tokens += usage.cached_input_tokens;
    summary.cache_write_input_tokens += usage.cache_write_input_tokens;
    summary.output_tokens += usage.output_tokens;
    summary.reasoning_tokens += usage.reasoning_tokens;
    summary.total_tokens += usage.total_tokens;
}

fn optional_integer_field(value: &Value, field: &str) -> Option<i64> {
    value.get(field).and_then(|value| {
        value
            .as_i64()
            .or_else(|| value.as_u64().and_then(|value| i64::try_from(value).ok()))
            .or_else(|| value.as_f64().map(|value| value.round() as i64))
    })
}

fn remember_model(timeline: &mut AgentSessionTimeline, model: &str) {
    if !model.is_empty() && !timeline.models.iter().any(|value| value == model) {
        timeline.models.push(model.to_string());
    }
}

fn integer_field(value: &Value, field: &str) -> i64 {
    value
        .get(field)
        .and_then(|value| {
            value
                .as_i64()
                .or_else(|| value.as_u64().and_then(|value| i64::try_from(value).ok()))
                .or_else(|| value.as_f64().map(|value| value.round() as i64))
        })
        .unwrap_or_default()
}

fn number_field(value: &Value, field: &str) -> Option<f64> {
    value.get(field).and_then(Value::as_f64)
}

fn render_json_value(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(value) => Some(value.clone()),
        Value::Array(items) => {
            let rendered = items
                .iter()
                .filter_map(|item| {
                    item.as_str()
                        .map(str::to_string)
                        .or_else(|| item.get("text").and_then(Value::as_str).map(str::to_string))
                        .or_else(|| serde_json::to_string_pretty(item).ok())
                })
                .collect::<Vec<_>>()
                .join("\n");
            (!rendered.trim().is_empty()).then_some(rendered)
        }
        _ => serde_json::to_string_pretty(value).ok(),
    }
}

fn string_field(value: &Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    let mut chars = value.chars();
    let prefix = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        format!("{prefix}\n…")
    } else {
        prefix
    }
}

fn format_unix_millis(value: i64) -> Option<String> {
    DateTime::<Utc>::from_timestamp_millis(value).map(|value| value.to_rfc3339())
}

fn collect_jsonl_files(directory: &Path, matches: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            collect_jsonl_files(&path, matches);
        } else if path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("jsonl"))
        {
            matches.push(path);
        }
    }
}

fn find_jsonl_by_stem(root: &Path, session_id: &str) -> Option<PathBuf> {
    let mut paths = Vec::new();
    collect_jsonl_files(root, &mut paths);
    paths.into_iter().find(|path| {
        path.file_stem()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value == session_id)
    })
}

fn find_codex_session_file(root: &Path, agent_type: &str, session_id: &str) -> Option<PathBuf> {
    let mut paths = Vec::new();
    collect_jsonl_files(root, &mut paths);
    paths.into_iter().find(|path| {
        let Some(Ok(line)) = File::open(path)
            .ok()
            .and_then(|file| BufReader::new(file).lines().next())
        else {
            return false;
        };
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            return false;
        };
        let Some(payload) = value.get("payload") else {
            return false;
        };
        let originator = payload.get("originator").and_then(Value::as_str);
        let matches_agent = match agent_type {
            "codex-desktop" => originator == Some("Codex Desktop"),
            "codex-cli" => matches!(originator, Some("codex_cli_rs" | "Codex CLI" | "codex-cli")),
            _ => false,
        };
        matches_agent && string_field(payload, "id").as_deref() == Some(session_id)
    })
}

fn opencode_database_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(home) = dirs::home_dir() {
        candidates.push(
            home.join(".local")
                .join("share")
                .join("opencode")
                .join("opencode.db"),
        );
    }
    if let Some(data) = dirs::data_dir() {
        candidates.push(data.join("opencode").join("opencode.db"));
        candidates.push(data.join("ai.opencode.desktop").join("opencode.db"));
    }
    if let Some(config) = dirs::config_dir() {
        candidates.push(config.join("ai.opencode.desktop").join("opencode.db"));
    }
    let mut seen = HashSet::new();
    candidates.retain(|path| seen.insert(path.clone()));
    candidates
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn reads_claude_messages_and_tool_events_without_persisting_them() {
        let root = std::env::temp_dir().join(format!("flowlet-claude-timeline-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("session.jsonl");
        fs::write(
            &path,
            concat!(
                "{\"type\":\"user\",\"uuid\":\"u1\",\"timestamp\":\"2026-07-19T08:00:00Z\",\"message\":{\"role\":\"user\",\"content\":\"Fix the bug\"}}\n",
                "{\"type\":\"assistant\",\"uuid\":\"a1\",\"timestamp\":\"2026-07-19T08:01:00Z\",\"message\":{\"id\":\"msg-a1\",\"role\":\"assistant\",\"model\":\"claude-test\",\"usage\":{\"input_tokens\":100,\"cache_read_input_tokens\":40,\"cache_creation_input_tokens\":10,\"output_tokens\":25},\"content\":[{\"type\":\"text\",\"text\":\"Working on it\"},{\"type\":\"tool_use\",\"name\":\"Read\",\"input\":{\"path\":\"src/app.ts\"}}]}}\n",
                "{\"type\":\"user\",\"uuid\":\"u2\",\"timestamp\":\"2026-07-19T08:02:00Z\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"content\":\"file content\"}]}}\n"
            ),
        )
        .unwrap();
        let timeline = read_jsonl_timeline(&path, parse_claude_line).unwrap();
        assert_eq!(timeline.events.len(), 4);
        assert_eq!(timeline.events[0].kind, "user-message");
        assert_eq!(timeline.events[2].kind, "tool-call");
        assert_eq!(timeline.events[3].kind, "tool-result");
        assert_eq!(timeline.models, vec!["claude-test"]);
        assert_eq!(timeline.usage.as_ref().unwrap().total_tokens, 175);
        assert_eq!(timeline.events[1].usage.as_ref().unwrap().output_tokens, 25);
        let summary = summarize_timeline(timeline);
        assert_eq!(summary.turn_count, 1);
        assert_eq!(summary.usage.unwrap().total_tokens, 175);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reads_codex_response_items_and_skips_developer_messages() {
        let root = std::env::temp_dir().join(format!("flowlet-codex-timeline-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("session.jsonl");
        fs::write(
            &path,
            concat!(
                "{\"timestamp\":\"2026-07-19T08:00:00Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\",\"turn_id\":\"turn-1\"}}\n",
                "{\"timestamp\":\"2026-07-19T08:00:00Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"developer\",\"content\":[{\"type\":\"input_text\",\"text\":\"secret instructions\"}]}}\n",
                "{\"timestamp\":\"2026-07-19T08:00:30Z\",\"type\":\"turn_context\",\"payload\":{\"turn_id\":\"turn-1\",\"model\":\"gpt-test\"}}\n",
                "{\"timestamp\":\"2026-07-19T08:01:00Z\",\"type\":\"response_item\",\"payload\":{\"id\":\"m1\",\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"Build it\"}]}}\n",
                "{\"timestamp\":\"2026-07-19T08:01:30Z\",\"type\":\"response_item\",\"payload\":{\"id\":\"m2\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"Working\"}]}}\n",
                "{\"timestamp\":\"2026-07-19T08:02:00Z\",\"type\":\"response_item\",\"payload\":{\"id\":\"c1\",\"type\":\"function_call\",\"name\":\"shell\",\"arguments\":\"pwd\"}}\n",
                "{\"timestamp\":\"2026-07-19T08:03:00Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"last_token_usage\":{\"input_tokens\":200,\"cached_input_tokens\":80,\"output_tokens\":30,\"reasoning_output_tokens\":10,\"total_tokens\":230},\"total_token_usage\":{\"input_tokens\":200,\"cached_input_tokens\":80,\"output_tokens\":30,\"reasoning_output_tokens\":10,\"total_tokens\":230}}}}\n",
                "{\"timestamp\":\"2026-07-19T08:04:00Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"last_token_usage\":{\"input_tokens\":300,\"cached_input_tokens\":80,\"output_tokens\":40,\"reasoning_output_tokens\":10,\"total_tokens\":340},\"total_token_usage\":{\"input_tokens\":500,\"cached_input_tokens\":160,\"output_tokens\":70,\"reasoning_output_tokens\":20,\"total_tokens\":570}}}}\n",
                "{\"timestamp\":\"2026-07-19T08:04:01Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\",\"turn_id\":\"turn-1\",\"duration_ms\":241000,\"time_to_first_token_ms\":1200}}\n"
            ),
        )
        .unwrap();
        let timeline = read_jsonl_timeline(&path, parse_codex_line).unwrap();
        assert_eq!(timeline.events.len(), 4);
        assert_eq!(timeline.events[0].kind, "turn");
        assert_eq!(timeline.events[0].status.as_deref(), Some("completed"));
        assert_eq!(timeline.events[0].duration_ms, Some(241000));
        assert_eq!(timeline.events[0].time_to_first_token_ms, Some(1200));
        assert_eq!(timeline.events[0].usage.as_ref().unwrap().total_tokens, 570);
        assert_eq!(timeline.events[1].content.as_deref(), Some("Build it"));
        assert_eq!(timeline.events[3].kind, "tool-call");
        assert_eq!(timeline.models, vec!["gpt-test"]);
        assert_eq!(timeline.usage.as_ref().unwrap().total_tokens, 570);
        assert_eq!(summarize_timeline(timeline).turn_count, 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn keeps_scanning_codex_totals_after_display_event_limit() {
        let root =
            std::env::temp_dir().join(format!("flowlet-codex-event-limit-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("session.jsonl");
        let mut records = String::from(
            "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\",\"turn_id\":\"turn-1\"}}\n\
             {\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt-5.6-sol\"}}\n",
        );
        for index in 0..=MAX_TIMELINE_EVENTS {
            records.push_str(&format!(
                "{{\"type\":\"response_item\",\"payload\":{{\"id\":\"m-{index}\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[{{\"type\":\"output_text\",\"text\":\"event {index}\"}}]}}}}\n"
            ));
        }
        records.push_str(
            "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\",\"turn_id\":\"turn-1\"}}\n\
             {\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\",\"turn_id\":\"turn-2\"}}\n\
             {\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt-5.6-sol\"}}\n\
             {\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":1000,\"cached_input_tokens\":800,\"output_tokens\":100,\"total_tokens\":1100}}}}\n",
        );
        fs::write(&path, records).unwrap();

        let mut timeline = read_jsonl_timeline(&path, parse_codex_line).unwrap();
        assert!(timeline.truncated);
        assert_eq!(timeline.events.len(), MAX_TIMELINE_EVENTS);
        assert_eq!(timeline.turn_count, 2);
        assert_eq!(timeline.usage.as_ref().unwrap().total_tokens, 1100);

        let api_price = ModelPrice {
            channel_id: "openai-api".to_string(),
            upstream_model: "gpt-5.6-sol".to_string(),
            input_uncached_price: 5.0,
            input_cached_price: 0.5,
            output_price: 30.0,
            currency: "USD".to_string(),
            ..Default::default()
        };
        apply_native_cost_estimate_to_timeline("codex-desktop", &mut timeline, &[api_price]);
        let estimate = timeline.usage.unwrap().api_equivalent.unwrap();
        assert_eq!(estimate.priced_turn_count, 2);
        assert!((estimate.amount.unwrap() - 0.0044).abs() < f64::EPSILON);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn estimates_codex_api_value_and_plan_consumption() {
        let plan_price = ModelPrice {
            channel_id: "codex-native".to_string(),
            upstream_model: "gpt-5.6-sol".to_string(),
            input_uncached_price: 125.0,
            input_cached_price: 12.5,
            output_price: 750.0,
            currency: "CREDITS".to_string(),
            source_url: Some("https://learn.chatgpt.com/docs/pricing".to_string()),
            price_version: Some("2026-07-19".to_string()),
            ..Default::default()
        };
        let api_price = ModelPrice {
            channel_id: "openai-api".to_string(),
            upstream_model: "gpt-5.6-sol".to_string(),
            input_uncached_price: 5.0,
            input_cached_price: 0.5,
            input_cache_write_price: Some(6.25),
            output_price: 30.0,
            currency: "USD".to_string(),
            source_url: Some("https://developers.openai.com/api/docs/pricing".to_string()),
            price_version: Some("2026-07-19".to_string()),
            ..Default::default()
        };
        let mut summary = super::super::config::AgentSessionNativeSummary {
            source_available: true,
            truncated: false,
            turn_count: 1,
            usage: Some(AgentSessionNativeUsage {
                input_tokens: 500,
                cached_input_tokens: 160,
                cache_write_input_tokens: 10,
                output_tokens: 70,
                total_tokens: 570,
                ..Default::default()
            }),
            models: vec!["gpt-5.6-sol".to_string()],
        };
        apply_native_cost_estimate_to_summary(
            "codex-desktop",
            &mut summary,
            &[plan_price, api_price],
        );
        let usage = summary.usage.unwrap();
        let api_equivalent = usage.api_equivalent.unwrap();
        assert_eq!(api_equivalent.currency.as_deref(), Some("USD"));
        assert_eq!(api_equivalent.price_version.as_deref(), Some("2026-07-19"));
        assert_eq!(api_equivalent.priced_turn_count, 1);
        assert_eq!(api_equivalent.unpriced_turn_count, 0);
        assert!((api_equivalent.amount.unwrap() - 0.0038925).abs() < f64::EPSILON);

        let plan_consumption = usage.plan_consumption.unwrap();
        assert_eq!(plan_consumption.currency.as_deref(), Some("CREDITS"));
        assert_eq!(plan_consumption.priced_turn_count, 1);
        assert_eq!(plan_consumption.unpriced_turn_count, 0);
        assert!((plan_consumption.amount.unwrap() - 0.097).abs() < f64::EPSILON);
    }

    #[test]
    fn does_not_guess_aggregate_cost_for_multiple_codex_models() {
        let mut summary = super::super::config::AgentSessionNativeSummary {
            source_available: true,
            truncated: false,
            turn_count: 2,
            usage: Some(AgentSessionNativeUsage {
                total_tokens: 100,
                ..Default::default()
            }),
            models: vec!["gpt-a".to_string(), "gpt-b".to_string()],
        };
        apply_native_cost_estimate_to_summary("codex-desktop", &mut summary, &[]);
        let usage = summary.usage.unwrap();
        assert!(usage.cost.is_none());
        let api_equivalent = usage.api_equivalent.unwrap();
        assert!(api_equivalent.amount.is_none());
        assert_eq!(api_equivalent.priced_turn_count, 0);
        assert_eq!(api_equivalent.unpriced_turn_count, 2);
        let plan_consumption = usage.plan_consumption.unwrap();
        assert!(plan_consumption.amount.is_none());
        assert_eq!(plan_consumption.priced_turn_count, 0);
        assert_eq!(plan_consumption.unpriced_turn_count, 2);
    }

    #[test]
    fn incrementally_merges_appended_codex_summary_records() {
        use std::io::Write as _;

        let root = std::env::temp_dir().join(format!("flowlet-codex-cursor-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("session.jsonl");
        fs::write(
            &path,
            concat!(
                "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\",\"turn_id\":\"turn-1\"}}\n",
                "{\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt-a\"}}\n",
                "{\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":80,\"cached_input_tokens\":40,\"output_tokens\":20,\"total_tokens\":100}}}}\n"
            ),
        )
        .unwrap();
        let (first, offset, usage_ids) =
            read_jsonl_summary_range(&path, "codex-desktop", 0, HashSet::new()).unwrap();
        assert_eq!(first.turn_count, 1);
        assert_eq!(first.usage.as_ref().unwrap().total_tokens, 100);

        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(
            concat!(
                "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\",\"turn_id\":\"turn-1\"}}\n",
                "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\",\"turn_id\":\"turn-2\"}}\n",
                "{\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt-b\"}}\n",
                "{\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":200,\"cached_input_tokens\":120,\"output_tokens\":50,\"total_tokens\":250}}}}\n"
            )
            .as_bytes(),
        )
        .unwrap();
        drop(file);

        let (delta, final_offset, _) =
            read_jsonl_summary_range(&path, "codex-desktop", offset, usage_ids).unwrap();
        let merged = merge_incremental_summary("codex-desktop", first, delta);
        assert_eq!(merged.turn_count, 2);
        assert_eq!(merged.models, vec!["gpt-a", "gpt-b"]);
        assert_eq!(merged.usage.as_ref().unwrap().total_tokens, 250);
        assert_eq!(final_offset, fs::metadata(&path).unwrap().len());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn incremental_claude_summary_deduplicates_usage_ids() {
        use std::io::Write as _;

        let root = std::env::temp_dir().join(format!("flowlet-claude-cursor-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("session.jsonl");
        let first_line = "{\"type\":\"assistant\",\"uuid\":\"u1\",\"message\":{\"id\":\"msg-1\",\"model\":\"claude-a\",\"usage\":{\"input_tokens\":100,\"output_tokens\":20}}}\n";
        fs::write(&path, first_line).unwrap();
        let (first, offset, usage_ids) =
            read_jsonl_summary_range(&path, "claude-code", 0, HashSet::new()).unwrap();

        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(first_line.as_bytes()).unwrap();
        file.write_all(b"{\"type\":\"assistant\",\"uuid\":\"u2\",\"message\":{\"id\":\"msg-2\",\"model\":\"claude-b\",\"usage\":{\"input_tokens\":200,\"cache_read_input_tokens\":50,\"output_tokens\":30}}}\n").unwrap();
        drop(file);

        let (delta, _, _) =
            read_jsonl_summary_range(&path, "claude-code", offset, usage_ids).unwrap();
        let merged = merge_incremental_summary("claude-code", first, delta);
        assert_eq!(merged.turn_count, 2);
        assert_eq!(merged.models, vec!["claude-a", "claude-b"]);
        assert_eq!(merged.usage.as_ref().unwrap().total_tokens, 400);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cursor_restarts_after_truncation_or_parser_upgrade() {
        let summary = super::super::config::AgentSessionNativeSummary {
            source_available: true,
            truncated: false,
            turn_count: 1,
            usage: None,
            models: Vec::new(),
        };
        let checkpoint = AgentSessionSummaryCheckpoint {
            summary,
            source_offset: 100,
            parser_version: AGENT_SUMMARY_PARSER_VERSION,
            usage_ids: Vec::new(),
            cursor_guard: "guard".into(),
        };
        assert_eq!(resumable_offset(&checkpoint, 150, "guard"), Some(100));
        assert_eq!(resumable_offset(&checkpoint, 80, "guard"), None);
        assert_eq!(resumable_offset(&checkpoint, 150, "changed"), None);
        let outdated = AgentSessionSummaryCheckpoint {
            parser_version: AGENT_SUMMARY_PARSER_VERSION - 1,
            ..checkpoint
        };
        assert_eq!(resumable_offset(&outdated, 150, "guard"), None);
    }

    #[test]
    fn reads_opencode_parts_in_time_order() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(
            r#"
            CREATE TABLE session (
                id TEXT PRIMARY KEY, model TEXT, cost REAL,
                tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER,
                tokens_cache_read INTEGER, tokens_cache_write INTEGER
            );
            CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
            CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
            INSERT INTO session VALUES ('ses', '{"id":"model-a","providerID":"provider"}', 0.125, 1000, 250, 50, 400, 20);
            INSERT INTO message VALUES ('m1', 'ses', 1000, '{"role":"user"}');
            INSERT INTO part VALUES ('p1', 'm1', 'ses', 1001, '{"type":"text","text":"Hello"}');
            INSERT INTO message VALUES ('m2', 'ses', 2000, '{"role":"assistant","modelID":"model-a","cost":0.025,"tokens":{"input":200,"output":40,"reasoning":10,"total":250,"cache":{"read":80,"write":5}}}');
            INSERT INTO part VALUES ('p2', 'm2', 'ses', 2001, '{"type":"text","text":"Reading"}');
            INSERT INTO part VALUES ('p3', 'm2', 'ses', 2002, '{"type":"tool","tool":"Read","state":{"status":"completed","input":{"path":"a"},"output":"done"}}');
            "#,
        )
        .unwrap();
        let timeline = read_opencode_timeline_from(&connection, "ses").unwrap();
        assert_eq!(timeline.events.len(), 4);
        assert_eq!(timeline.events[0].kind, "user-message");
        assert_eq!(timeline.events[2].kind, "tool-call");
        assert_eq!(timeline.events[3].kind, "tool-result");
        assert_eq!(timeline.models, vec!["model-a"]);
        assert_eq!(timeline.usage.as_ref().unwrap().total_tokens, 1300);
        assert_eq!(timeline.usage.as_ref().unwrap().cost, Some(0.125));
        assert_eq!(timeline.events[1].usage.as_ref().unwrap().total_tokens, 250);
    }
}
