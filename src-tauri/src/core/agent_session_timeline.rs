use super::agent_session_sources::{
    collect_jsonl_files, format_unix_millis, format_unix_seconds, hermes_database_candidates,
    opencode_database_candidates, string_field,
};
use super::config::{
    AgentSessionCostEstimate, AgentSessionNativeUsage, AgentSessionTimeline,
    AgentSessionTimelineEvent, ModelPrice,
};
use rusqlite::{params, Connection, OpenFlags};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

mod adapters;

const MAX_SESSION_ID_BYTES: usize = 512;
const MAX_TIMELINE_FILE_BYTES: usize = 16 * 1024 * 1024;
const MAX_TIMELINE_EVENTS: usize = 300;
const MAX_EVENT_CONTENT_CHARS: usize = 8_000;
// 版本 4：解析结果新增逐事件用量（usage_events），用于 agent_usage_events 账本。
// 升级后所有 checkpoint 失效，触发一次全量重解析以回填完整历史账本。
pub const AGENT_SUMMARY_PARSER_VERSION: i64 = 4;

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
    /// 本次解析新产生的消息级用量事件（agent_usage_events 账本写入来源）。
    /// 增量解析只含新事件；全量重解析含会话全部事件（调用方负责先清旧行）。
    pub usage_events: Vec<super::config::AgentUsageEvent>,
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
    super::agent_session_adapter::adapter_for_agent_type(agent_type)
        .ok_or_else(|| format!("暂不支持读取 Agent 会话时间线：{agent_type}"))?
        .timeline(agent_type, session_id)
}

/// 按任务执行时间窗裁剪累积的 Agent 原生会话。
/// 退回重跑会复用同一个 session id，因此以 user-message 为边界整组保留本轮的输入、
/// 思考、工具调用和回复，避免每个执行轮次都返回、渲染完整历史。
pub fn slice_native_agent_session_timeline(
    mut timeline: AgentSessionTimeline,
    started_at: Option<&str>,
    ended_at: Option<&str>,
) -> Result<AgentSessionTimeline, String> {
    let started_ms = parse_timeline_bound(started_at, "开始时间")?;
    let ended_ms = parse_timeline_bound(ended_at, "结束时间")?;
    if let (Some(started), Some(ended)) = (started_ms, ended_ms) {
        if ended < started {
            return Err("会话时间线结束时间早于开始时间".to_string());
        }
    }
    if started_ms.is_none() && ended_ms.is_none() {
        return Ok(timeline);
    }

    let mut interactions: Vec<Vec<AgentSessionTimelineEvent>> = Vec::new();
    let mut current: Vec<AgentSessionTimelineEvent> = Vec::new();
    for event in std::mem::take(&mut timeline.events) {
        if event.kind == "user-message" && current.iter().any(|item| item.kind == "user-message") {
            interactions.push(std::mem::take(&mut current));
        }
        current.push(event);
    }
    if !current.is_empty() {
        interactions.push(current);
    }

    timeline.events = interactions
        .into_iter()
        .filter(|interaction| {
            let timestamp = interaction
                .iter()
                .find(|event| event.kind == "user-message")
                .and_then(|event| event.timestamp.as_deref())
                .or_else(|| {
                    interaction
                        .iter()
                        .find_map(|event| event.timestamp.as_deref())
                })
                .and_then(parse_timeline_timestamp);
            timestamp.is_some_and(|timestamp| {
                started_ms.map_or(true, |started| timestamp >= started)
                    && ended_ms.map_or(true, |ended| timestamp < ended)
            })
        })
        .flatten()
        .collect();

    timeline.turn_count = timeline
        .events
        .iter()
        .filter(|event| event.kind == "user-message")
        .count() as i64;
    timeline.models.clear();
    timeline.usage = None;
    for event in &timeline.events {
        if let Some(model) = event.model.as_deref() {
            if !model.is_empty() && !timeline.models.iter().any(|value| value == model) {
                timeline.models.push(model.to_string());
            }
        }
        if let Some(usage) = event.usage.as_ref() {
            add_usage(&mut timeline.usage, usage);
        }
    }
    Ok(timeline)
}

fn parse_timeline_bound(value: Option<&str>, label: &str) -> Result<Option<i64>, String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            parse_timeline_timestamp(value)
                .ok_or_else(|| format!("无效的会话时间线{label}：{value}"))
        })
        .transpose()
}

fn parse_timeline_timestamp(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|timestamp| timestamp.timestamp_millis())
}

/// 流式读取会话原生数据，只保留最后一个真实用户输入、所属轮次状态及其后的全部事件。
/// 该路径不应用历史浏览的事件数和正文长度上限，供详情页和设备同步完整读取最后一轮。
pub fn get_native_agent_session_last_interaction(
    agent_type: &str,
    session_id: &str,
) -> Result<Option<AgentSessionTimeline>, String> {
    let agent_type = agent_type.trim();
    let session_id = session_id.trim();
    if session_id.is_empty() || session_id.len() > MAX_SESSION_ID_BYTES {
        return Err("无效的 Agent 会话 ID".to_string());
    }
    let timeline = super::agent_session_adapter::adapter_for_agent_type(agent_type)
        .ok_or_else(|| format!("暂不支持读取 Agent 会话最后交互：{agent_type}"))?
        .last_interaction(agent_type, session_id)?;
    Ok(timeline.filter(|timeline| {
        timeline
            .events
            .iter()
            .any(|event| event.kind == "user-message")
    }))
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
        } else if !timeline.truncated {
            usage.api_equivalent =
                aggregate_estimates(timeline.events.iter().filter_map(|event| {
                    event
                        .usage
                        .as_ref()
                        .and_then(|usage| usage.api_equivalent.as_ref())
                }));
        } else {
            usage.api_equivalent = Some(unpriced_estimate(turns));
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
        } else {
            usage.api_equivalent = Some(unpriced_estimate(turns));
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
    // 原生会话记录无法还原单次 API 调用的上下文大小，按 docs/config.md 的约定
    // 统一使用标准基础价（第一档），不按会话累计输入越级到长上下文高档。
    let (uncached_price, cached_price, cache_write_price, output_price) =
        price.resolve_prices(None);
    // Codex 的 input_tokens 是含缓存命中与缓存写入的总输入，未缓存部分必须扣减，
    // 避免缓存命中既按未缓存价、又按缓存命中价重复计费。
    let uncached_input = usage
        .input_tokens
        .saturating_sub(usage.cached_input_tokens)
        .saturating_sub(usage.cache_write_input_tokens)
        .max(0) as f64;
    let cached_input = usage.cached_input_tokens.max(0) as f64;
    let cache_write_input = usage.cache_write_input_tokens.max(0) as f64;
    let output = usage.output_tokens.max(0) as f64;
    let input_uncached_amount = uncached_input * uncached_price / 1_000_000.0;
    let input_cached_amount = cached_input * cached_price / 1_000_000.0;
    let input_cache_write_amount =
        cache_write_input * cache_write_price.unwrap_or(uncached_price) / 1_000_000.0;
    let output_amount = output * output_price / 1_000_000.0;
    AgentSessionCostEstimate {
        amount: Some(
            input_uncached_amount + input_cached_amount + input_cache_write_amount + output_amount,
        ),
        input_uncached_amount: Some(input_uncached_amount),
        input_cached_amount: Some(input_cached_amount),
        input_cache_write_amount: Some(input_cache_write_amount),
        output_amount: Some(output_amount),
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
        input_uncached_amount: None,
        input_cached_amount: None,
        input_cache_write_amount: None,
        output_amount: None,
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
    let fully_priced = unpriced_turn_count == 0 && same_currency;
    let sum_component = |value: fn(&AgentSessionCostEstimate) -> Option<f64>| {
        fully_priced.then(|| estimates.iter().filter_map(|item| value(item)).sum::<f64>())
    };
    Some(AgentSessionCostEstimate {
        amount: sum_component(|item| item.amount),
        input_uncached_amount: sum_component(|item| item.input_uncached_amount),
        input_cached_amount: sum_component(|item| item.input_cached_amount),
        input_cache_write_amount: sum_component(|item| item.input_cache_write_amount),
        output_amount: sum_component(|item| item.output_amount),
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
    let adapter = super::agent_session_adapter::adapter_for_agent_type(agent_type)
        .ok_or_else(|| format!("暂不支持读取 Agent 会话时间线：{agent_type}"))?;
    let path = adapter.incremental_source(agent_type, session_id);
    let Some(path) = path else {
        let (summary, usage_events) =
            get_native_agent_session_summary_with_events(agent_type, session_id)?;
        return Ok(AgentSessionSummaryParseResult {
            summary,
            source_offset: 0,
            parser_version: AGENT_SUMMARY_PARSER_VERSION,
            usage_ids: Vec::new(),
            cursor_guard: String::new(),
            complete: true,
            incremental: false,
            bytes_processed: 0,
            usage_events,
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
    // Codex 的 token_count 是累计值：增量续跑时以上次解析的最终累计为基线，
    // 逐行求差分写入账本。全量解析时基线为 None，首行差分即其累计值。
    let codex_cumulative_baseline = checkpoint
        .as_ref()
        .filter(|_| can_resume)
        .and_then(|checkpoint| checkpoint.summary.usage.clone());
    let (delta, source_offset, usage_ids, usage_events) = read_jsonl_summary_range(
        &path,
        agent_type,
        start_offset,
        seen_usage_ids,
        codex_cumulative_baseline,
    )?;
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
        usage_events,
    })
}

/// 全量解析时间线并在解析过程中同步采集消息级用量事件（Pi / OpenCode 路径）。
/// 时间线路径完整读取（不设事件/正文上限），用量事件自然覆盖整段会话，长会话不会低估。
fn get_native_agent_session_summary_with_events(
    agent_type: &str,
    session_id: &str,
) -> Result<
    (
        super::config::AgentSessionNativeSummary,
        Vec<super::config::AgentUsageEvent>,
    ),
    String,
> {
    let mut usage_events = Vec::new();
    let timeline = super::agent_session_adapter::adapter_for_agent_type(agent_type)
        .ok_or_else(|| format!("暂不支持读取 Agent 会话时间线：{agent_type}"))?
        .timeline_with_usage_events(agent_type, session_id, &mut usage_events)?;
    Ok((summarize_timeline(timeline), usage_events))
}

/// 将原生时间戳规范化为 UTC RFC3339；无法解析时返回 None（该事件不入账本）。
fn normalize_event_time(value: &str) -> Option<String> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|timestamp| timestamp.with_timezone(&chrono::Utc).to_rfc3339())
}

fn agent_usage_event(
    event_id: String,
    event_time: Option<String>,
    model: Option<String>,
    usage: &AgentSessionNativeUsage,
) -> Option<super::config::AgentUsageEvent> {
    let event_time = event_time.and_then(|value| normalize_event_time(&value))?;
    if event_id.is_empty() {
        return None;
    }
    Some(super::config::AgentUsageEvent {
        event_id,
        event_time,
        model,
        input_tokens: usage.input_tokens,
        cached_input_tokens: usage.cached_input_tokens,
        cache_write_input_tokens: usage.cache_write_input_tokens,
        output_tokens: usage.output_tokens,
        reasoning_tokens: usage.reasoning_tokens,
        total_tokens: usage.total_tokens,
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
    timeline_with_limits(Some(MAX_TIMELINE_EVENTS), Some(MAX_EVENT_CONTENT_CHARS))
}

fn complete_timeline() -> AgentSessionTimeline {
    timeline_with_limits(None, None)
}

fn timeline_with_limits(
    event_limit: Option<usize>,
    content_limit: Option<usize>,
) -> AgentSessionTimeline {
    AgentSessionTimeline {
        source_available: false,
        truncated: false,
        turn_count: 0,
        usage: None,
        models: Vec::new(),
        events: Vec::new(),
        event_limit,
        content_limit,
    }
}

pub(crate) fn read_opencode_timeline(session_id: &str) -> Result<AgentSessionTimeline, String> {
    adapters::opencode::read_timeline(session_id)
}

pub(crate) fn read_opencode_timeline_with_events(
    session_id: &str,
    usage_events: &mut Vec<super::config::AgentUsageEvent>,
) -> Result<AgentSessionTimeline, String> {
    adapters::opencode::read_timeline_with_events(session_id, usage_events)
}

pub(crate) fn read_opencode_last_interaction(
    session_id: &str,
) -> Result<AgentSessionTimeline, String> {
    adapters::opencode::read_last_interaction(session_id)
}

#[cfg(test)]
use adapters::opencode::read_timeline_from as read_opencode_timeline_from;

pub(crate) fn read_claude_timeline(session_id: &str) -> Result<AgentSessionTimeline, String> {
    adapters::claude_code::read_timeline(session_id)
}

pub(crate) fn claude_session_file(session_id: &str) -> Option<PathBuf> {
    adapters::claude_code::session_file(session_id)
}

pub(crate) fn read_claude_last_interaction(
    session_id: &str,
) -> Result<Option<AgentSessionTimeline>, String> {
    adapters::claude_code::read_last_interaction(session_id)
}

pub(crate) fn read_codex_timeline(
    agent_type: &str,
    session_id: &str,
) -> Result<AgentSessionTimeline, String> {
    adapters::codex::read_timeline(agent_type, session_id)
}

pub(crate) fn codex_session_file(agent_type: &str, session_id: &str) -> Option<PathBuf> {
    adapters::codex::session_file(agent_type, session_id)
}

pub(crate) fn read_codex_last_interaction(
    agent_type: &str,
    session_id: &str,
) -> Result<Option<AgentSessionTimeline>, String> {
    adapters::codex::read_last_interaction(agent_type, session_id)
}

#[cfg(test)]
use adapters::claude_code::parse_line as parse_claude_line;
#[cfg(test)]
use adapters::codex::parse_line as parse_codex_line;

pub(crate) fn read_pi_timeline(session_id: &str) -> Result<AgentSessionTimeline, String> {
    adapters::pi::read_timeline(session_id)
}

pub(crate) fn read_pi_timeline_with_events(
    session_id: &str,
    usage_events: &mut Vec<super::config::AgentUsageEvent>,
) -> Result<AgentSessionTimeline, String> {
    adapters::pi::read_timeline_with_events(session_id, usage_events)
}

pub(crate) fn read_pi_last_interaction(
    session_id: &str,
) -> Result<Option<AgentSessionTimeline>, String> {
    adapters::pi::read_last_interaction(session_id)
}

pub(crate) fn read_hermes_timeline(
    agent_type: &str,
    session_id: &str,
) -> Result<AgentSessionTimeline, String> {
    adapters::hermes::read_timeline(agent_type, session_id)
}

pub(crate) fn read_hermes_last_interaction(
    agent_type: &str,
    session_id: &str,
) -> Result<Option<AgentSessionTimeline>, String> {
    adapters::hermes::read_last_interaction(agent_type, session_id)
}

#[cfg(test)]
use adapters::pi::read_timeline_from as read_pi_timeline_from;

fn read_jsonl_timeline(
    path: &Path,
    parser: fn(&Value, usize, &mut AgentSessionTimeline, &mut HashSet<String>),
) -> Result<AgentSessionTimeline, String> {
    let file = File::open(path).map_err(|error| format!("无法读取原生会话文件：{error}"))?;
    // 完整时间线不设事件/正文/文件字节上限：任务「会话」Tab 需要展示整段会话，不截断。
    let mut timeline = complete_timeline();
    timeline.source_available = true;
    let mut seen_usage_ids = HashSet::new();
    for (index, line) in BufReader::new(file).lines().enumerate() {
        let line = line.map_err(|error| format!("读取原生会话文件失败：{error}"))?;
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        parser(&value, index, &mut timeline, &mut seen_usage_ids);
    }
    Ok(timeline)
}

fn read_jsonl_last_interaction(
    path: &Path,
    parser: fn(&Value, usize, &mut AgentSessionTimeline, &mut HashSet<String>),
) -> Result<AgentSessionTimeline, String> {
    let file = File::open(path).map_err(|error| format!("无法读取原生会话文件：{error}"))?;
    let mut timeline = complete_timeline();
    timeline.source_available = true;
    let mut seen_usage_ids = HashSet::new();
    for (index, line) in BufReader::new(file).lines().enumerate() {
        let line = line.map_err(|error| format!("读取原生会话文件失败：{error}"))?;
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let event_start = timeline.events.len();
        parser(&value, index, &mut timeline, &mut seen_usage_ids);
        if timeline.events[event_start..]
            .iter()
            .any(|event| event.kind == "user-message")
        {
            let active_turn = timeline.events[..event_start]
                .iter()
                .rev()
                .find(|event| event.kind == "turn")
                .cloned();
            let mut latest = timeline.events.split_off(event_start);
            if let Some(turn) = active_turn {
                latest.insert(0, turn);
            }
            timeline.events = latest;
        }
    }
    Ok(timeline)
}

fn read_jsonl_summary_range(
    path: &Path,
    agent_type: &str,
    start_offset: u64,
    mut seen_usage_ids: HashSet<String>,
    codex_cumulative_baseline: Option<AgentSessionNativeUsage>,
) -> Result<
    (
        super::config::AgentSessionNativeSummary,
        u64,
        HashSet<String>,
        Vec<super::config::AgentUsageEvent>,
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
    let mut usage_events = Vec::new();
    // Codex 差分链：本次扫描内上一条 token_count 的累计值，初始为续跑基线。
    let mut codex_last_cumulative = codex_cumulative_baseline;
    let mut bytes_read = 0usize;
    let mut line = String::new();
    loop {
        line.clear();
        let line_start = reader
            .stream_position()
            .map_err(|error| format!("无法记录原生会话行游标：{error}"))?;
        let length = reader
            .read_line(&mut line)
            .map_err(|error| format!("读取原生会话文件失败：{error}"))?;
        if length == 0 {
            break;
        }
        bytes_read = bytes_read.saturating_add(length);
        if let Ok(value) = serde_json::from_str::<Value>(&line) {
            parse_jsonl_summary_line(
                agent_type,
                &value,
                line_start,
                &mut summary,
                &mut seen_usage_ids,
                &mut usage_events,
                &mut codex_last_cumulative,
            );
        }
        if bytes_read >= MAX_TIMELINE_FILE_BYTES {
            break;
        }
    }
    let source_offset = reader
        .stream_position()
        .map_err(|error| format!("无法记录原生会话增量游标：{error}"))?;
    Ok((summary, source_offset, seen_usage_ids, usage_events))
}

#[allow(clippy::too_many_arguments)]
fn parse_jsonl_summary_line(
    agent_type: &str,
    value: &Value,
    line_offset: u64,
    summary: &mut super::config::AgentSessionNativeSummary,
    seen_usage_ids: &mut HashSet<String>,
    usage_events: &mut Vec<super::config::AgentUsageEvent>,
    codex_last_cumulative: &mut Option<AgentSessionNativeUsage>,
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
        let model = string_field(message, "model");
        if let Some(model) = model.as_deref() {
            remember_summary_model(summary, model.to_string());
        }
        let usage_id = string_field(message, "id")
            .or_else(|| string_field(value, "uuid"))
            .unwrap_or_default();
        if usage_id.is_empty() || !seen_usage_ids.insert(usage_id.clone()) {
            return;
        }
        summary.turn_count += 1;
        if let Some(usage) = usage_from_claude_message(message) {
            if let Some(event) =
                agent_usage_event(usage_id, string_field(value, "timestamp"), model, &usage)
            {
                usage_events.push(event);
            }
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
                if let Some(cumulative) = payload
                    .get("info")
                    .and_then(|info| info.get("total_token_usage"))
                    .and_then(usage_from_codex_token_value)
                {
                    // token_count 报告的是会话累计用量：与上一条求差分得到本段增量，
                    // 使账本可按时间精确归集；累计回退（上下文压缩）时保留负差分。
                    let delta = codex_last_cumulative
                        .as_ref()
                        .map(|last| subtract_native_usage(&cumulative, last))
                        .unwrap_or_else(|| cumulative.clone());
                    *codex_last_cumulative = Some(cumulative.clone());
                    if let Some(event) = agent_usage_event(
                        format!("codex-tc:{line_offset}"),
                        string_field(value, "timestamp"),
                        None,
                        &delta,
                    ) {
                        usage_events.push(event);
                    }
                    summary.usage = Some(cumulative);
                }
            }
            _ => {}
        }
    }
}

fn subtract_native_usage(
    current: &AgentSessionNativeUsage,
    previous: &AgentSessionNativeUsage,
) -> AgentSessionNativeUsage {
    AgentSessionNativeUsage {
        input_tokens: current.input_tokens - previous.input_tokens,
        cached_input_tokens: current.cached_input_tokens - previous.cached_input_tokens,
        cache_write_input_tokens: current.cache_write_input_tokens
            - previous.cache_write_input_tokens,
        output_tokens: current.output_tokens - previous.output_tokens,
        reasoning_tokens: current.reasoning_tokens - previous.reasoning_tokens,
        total_tokens: current.total_tokens - previous.total_tokens,
        cost: None,
        cost_currency: None,
        api_equivalent: None,
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
    if timeline
        .event_limit
        .is_some_and(|limit| timeline.events.len() >= limit)
    {
        timeline.truncated = true;
        return;
    }
    let content_limit = timeline.content_limit;
    let content = content
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(|value| {
            content_limit
                .map(|limit| truncate_chars(&value, limit))
                .unwrap_or(value)
        });
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
        trace: None,
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
    // cost 为可选字段（部分 Agent/Provider 不报告），仅在双方均有值时累加。
    if let (Some(total), Some(delta)) = (summary.cost, usage.cost) {
        summary.cost = Some(total + delta);
    } else if summary.cost.is_none() {
        summary.cost = usage.cost;
    }
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

fn optional_number_field(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_i64().map(|value| value as f64))
        .or_else(|| value.as_u64().map(|value| value as f64))
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

fn truncate_chars(value: &str, max_chars: usize) -> String {
    let mut chars = value.chars();
    let prefix = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        format!("{prefix}\n…")
    } else {
        prefix
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
            // codex_exec：Rust 版 Codex CLI（0.147+）非交互 `codex exec` 写入的 originator。
            "codex-cli" => matches!(
                originator,
                Some("codex_exec" | "codex_cli_rs" | "Codex CLI" | "codex-cli")
            ),
            _ => false,
        };
        matches_agent && string_field(payload, "id").as_deref() == Some(session_id)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn slices_reused_session_into_execution_windows() {
        let root = std::env::temp_dir().join(format!("flowlet-round-window-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("session.jsonl");
        fs::write(
            &path,
            concat!(
                "{\"type\":\"user\",\"uuid\":\"u1\",\"timestamp\":\"2026-08-08T10:00:01Z\",\"message\":{\"role\":\"user\",\"content\":\"First task\"}}\n",
                "{\"type\":\"assistant\",\"uuid\":\"a1\",\"timestamp\":\"2026-08-08T10:00:02Z\",\"message\":{\"id\":\"msg-a1\",\"role\":\"assistant\",\"model\":\"claude-first\",\"usage\":{\"input_tokens\":10,\"output_tokens\":5},\"content\":\"First result\"}}\n",
                "{\"type\":\"user\",\"uuid\":\"u2\",\"timestamp\":\"2026-08-08T10:10:01Z\",\"message\":{\"role\":\"user\",\"content\":\"Second task\"}}\n",
                "{\"type\":\"assistant\",\"uuid\":\"a2\",\"timestamp\":\"2026-08-08T10:10:02Z\",\"message\":{\"id\":\"msg-a2\",\"role\":\"assistant\",\"model\":\"claude-second\",\"usage\":{\"input_tokens\":20,\"output_tokens\":7},\"content\":\"Second result\"}}\n"
            ),
        )
        .unwrap();

        let timeline = read_jsonl_timeline(&path, parse_claude_line).unwrap();
        let first = slice_native_agent_session_timeline(
            timeline.clone(),
            Some("2026-08-08T10:00:00Z"),
            Some("2026-08-08T10:05:00Z"),
        )
        .unwrap();
        assert_eq!(first.events.len(), 2);
        assert_eq!(first.events[0].content.as_deref(), Some("First task"));
        assert_eq!(first.events[1].content.as_deref(), Some("First result"));
        assert_eq!(first.turn_count, 1);
        assert_eq!(first.models, vec!["claude-first"]);
        assert_eq!(first.usage.as_ref().unwrap().total_tokens, 15);

        let second =
            slice_native_agent_session_timeline(timeline, Some("2026-08-08T10:10:00Z"), None)
                .unwrap();
        assert_eq!(second.events.len(), 2);
        assert_eq!(second.events[0].content.as_deref(), Some("Second task"));
        assert_eq!(second.events[1].content.as_deref(), Some("Second result"));
        assert_eq!(second.turn_count, 1);
        assert_eq!(second.models, vec!["claude-second"]);
        assert_eq!(second.usage.as_ref().unwrap().total_tokens, 27);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn last_interaction_keeps_complete_input_and_all_following_outputs() {
        let root =
            std::env::temp_dir().join(format!("flowlet-last-interaction-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("session.jsonl");
        let complete_input = "x".repeat(MAX_EVENT_CONTENT_CHARS + 321);
        let records = [
            serde_json::json!({"type":"user","uuid":"u1","timestamp":"2026-07-30T08:00:00Z","message":{"role":"user","content":"old input"}}),
            serde_json::json!({"type":"assistant","uuid":"a1","timestamp":"2026-07-30T08:00:01Z","message":{"id":"m1","role":"assistant","content":"old output"}}),
            serde_json::json!({"type":"user","uuid":"u2","timestamp":"2026-07-30T08:01:00Z","message":{"role":"user","content":complete_input}}),
            serde_json::json!({"type":"assistant","uuid":"a2","timestamp":"2026-07-30T08:01:01Z","message":{"id":"m2","role":"assistant","content":"first output"}}),
            serde_json::json!({"type":"assistant","uuid":"a3","timestamp":"2026-07-30T08:01:02Z","message":{"id":"m3","role":"assistant","content":"second output"}}),
        ];
        fs::write(
            &path,
            records
                .iter()
                .map(serde_json::Value::to_string)
                .collect::<Vec<_>>()
                .join("\n"),
        )
        .unwrap();

        let timeline = read_jsonl_last_interaction(&path, parse_claude_line).unwrap();
        assert_eq!(timeline.events.len(), 3);
        assert_eq!(timeline.events[0].id, "u2");
        assert_eq!(
            timeline.events[0].content.as_deref(),
            Some(complete_input.as_str())
        );
        assert_eq!(timeline.events[1].content.as_deref(), Some("first output"));
        assert_eq!(timeline.events[2].content.as_deref(), Some("second output"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn codex_last_interaction_keeps_its_turn_status() {
        let root = std::env::temp_dir().join(format!("flowlet-codex-last-turn-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("session.jsonl");
        fs::write(
            &path,
            concat!(
                "{\"timestamp\":\"2026-07-30T08:00:00Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\",\"turn_id\":\"turn-1\"}}\n",
                "{\"timestamp\":\"2026-07-30T08:00:01Z\",\"type\":\"response_item\",\"payload\":{\"id\":\"m1\",\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"Build it\"}]}}\n",
                "{\"timestamp\":\"2026-07-30T08:00:02Z\",\"type\":\"response_item\",\"payload\":{\"id\":\"r1\",\"type\":\"reasoning\",\"summary\":[{\"type\":\"summary_text\",\"text\":\"Checking\"}]}}\n"
            ),
        )
        .unwrap();

        let timeline = read_jsonl_last_interaction(&path, parse_codex_line).unwrap();
        assert_eq!(timeline.events.len(), 3);
        assert_eq!(timeline.events[0].kind, "turn");
        assert_eq!(timeline.events[0].status.as_deref(), Some("running"));
        assert_eq!(timeline.events[1].kind, "user-message");
        assert_eq!(timeline.events[2].kind, "reasoning");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reads_pi_branch_from_leaf_with_usage_and_tool_result() {
        let root = std::env::temp_dir().join(format!("flowlet-pi-timeline-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("1701600000000_550e8400-e29b-41d4-a716-446655440000.jsonl");
        // 树状结构：user(a1) -> assistant(a2) -> user(a3) 为主干；a2 另有一个分支
        // a4(thinking) 与 a5。叶子 a5 与 a3 中，a5 时间戳更晚，故活动分支经 a5。
        fs::write(
            &path,
            concat!(
                "{\"type\":\"session\",\"version\":3,\"id\":\"550e8400-e29b-41d4-a716-446655440000\",\"timestamp\":\"2024-12-03T14:00:00.000Z\",\"cwd\":\"/Users/dev/my-app\"}\n",
                "{\"type\":\"message\",\"id\":\"a1\",\"parentId\":null,\"timestamp\":\"2024-12-03T14:00:01.000Z\",\"message\":{\"role\":\"user\",\"content\":\"Fix the bug\"}}\n",
                "{\"type\":\"message\",\"id\":\"a2\",\"parentId\":\"a1\",\"timestamp\":\"2024-12-03T14:00:02.000Z\",\"message\":{\"role\":\"assistant\",\"model\":\"claude-sonnet-4-5\",\"usage\":{\"input\":100,\"output\":25,\"cacheRead\":40,\"cacheWrite\":10,\"totalTokens\":175,\"cost\":{\"input\":1,\"output\":2,\"cacheRead\":0,\"cacheWrite\":0,\"total\":3}},\"content\":[{\"type\":\"text\",\"text\":\"Working on it\"},{\"type\":\"toolCall\",\"name\":\"bash\",\"arguments\":{\"command\":\"ls\"}}]}}\n",
                "{\"type\":\"message\",\"id\":\"a3\",\"parentId\":\"a2\",\"timestamp\":\"2024-12-03T14:00:03.000Z\",\"message\":{\"role\":\"toolResult\",\"toolCallId\":\"c1\",\"toolName\":\"bash\",\"content\":[{\"type\":\"text\",\"text\":\"src/\"}],\"isError\":false}}\n",
                "{\"type\":\"message\",\"id\":\"a4\",\"parentId\":\"a2\",\"timestamp\":\"2024-12-03T14:00:04.000Z\",\"message\":{\"role\":\"assistant\",\"model\":\"claude-sonnet-4-5\",\"usage\":{\"input\":80,\"output\":10,\"cacheRead\":0,\"cacheWrite\":0,\"totalTokens\":90,\"cost\":{\"input\":1,\"output\":1,\"cacheRead\":0,\"cacheWrite\":0,\"total\":2}},\"content\":[{\"type\":\"thinking\",\"thinking\":\"maybe refactor\"}]}}\n",
                "{\"type\":\"message\",\"id\":\"a5\",\"parentId\":\"a4\",\"timestamp\":\"2024-12-03T14:00:05.000Z\",\"message\":{\"role\":\"user\",\"content\":\"Go ahead\"}}\n"
            ),
        )
        .unwrap();
        let mut usage_events = Vec::new();
        let timeline = read_pi_timeline_from(&path, Some(&mut usage_events)).unwrap();
        assert!(timeline.source_available);
        // 活动分支应为 a1 -> a2 -> a4 -> a5（叶子 a5 时间戳晚于 a3）。
        let kinds: Vec<&str> = timeline.events.iter().map(|e| e.kind.as_str()).collect();
        assert_eq!(
            kinds,
            vec![
                "user-message",
                "assistant-message",
                "tool-call",
                "reasoning",
                "user-message",
            ]
        );
        assert_eq!(timeline.models, vec!["claude-sonnet-4-5"]);
        // 仅 a2 计入 turn（a4 无 toolResult 配对但仍为 assistant，按 assistant 消息计 turn）。
        assert_eq!(timeline.turn_count, 2);
        assert_eq!(timeline.usage.as_ref().unwrap().total_tokens, 265);
        assert_eq!(timeline.usage.as_ref().unwrap().cost, Some(5.0));
        // 账本事件：活动分支上两条带用量的 assistant 消息（a2、a4），被弃分支 a3 不计入。
        assert_eq!(usage_events.len(), 2);
        assert_eq!(usage_events[0].event_id, "a2");
        assert_eq!(usage_events[0].total_tokens, 175);
        assert_eq!(usage_events[0].cached_input_tokens, 40);
        assert_eq!(usage_events[0].event_time, "2024-12-03T14:00:02+00:00");
        assert_eq!(usage_events[1].event_id, "a4");
        assert_eq!(usage_events[1].total_tokens, 90);
        fs::remove_dir_all(root).unwrap();
    }

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
    fn finds_codex_exec_session_file_and_reads_timeline() {
        // Rust 版 Codex CLI `codex exec` 的会话文件 originator 是 codex_exec（0.147+）。
        // find_codex_session_file 必须能找到该文件，read_codex_timeline 才能读出对话，
        // 否则任务详情「会话」Tab 与「最近一轮」都会显示无可读内容。
        let root = std::env::temp_dir().join(format!("flowlet-codex-exec-tl-{}", Uuid::new_v4()));
        let sessions = root.join("sessions").join("2026").join("08").join("09");
        fs::create_dir_all(&sessions).unwrap();
        let path =
            sessions.join("rollout-2026-08-09T17-59-52-019fe5f6-eb7c-72d3-8ebc-f1be1d251993.jsonl");
        fs::write(
            &path,
            concat!(
                "{\"timestamp\":\"2026-08-09T09:59:52.511Z\",\"type\":\"session_meta\",\"payload\":{\"session_id\":\"019fe5f6-eb7c-72d3-8ebc-f1be1d251993\",\"id\":\"019fe5f6-eb7c-72d3-8ebc-f1be1d251993\",\"originator\":\"codex_exec\",\"cwd\":\"D:\\\\flowlet\"}}\n",
                "{\"timestamp\":\"2026-08-09T09:59:52.682Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\",\"turn_id\":\"turn-1\"}}\n",
                "{\"timestamp\":\"2026-08-09T10:00:00Z\",\"type\":\"response_item\",\"payload\":{\"id\":\"m1\",\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"任务正文\"}]}}\n",
                "{\"timestamp\":\"2026-08-09T10:00:17Z\",\"type\":\"response_item\",\"payload\":{\"id\":\"m2\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"执行完成\"}]}}\n",
                "{\"timestamp\":\"2026-08-09T10:00:20Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\",\"turn_id\":\"turn-1\"}}\n"
            ),
        )
        .unwrap();

        let found = find_codex_session_file(
            &sessions,
            "codex-cli",
            "019fe5f6-eb7c-72d3-8ebc-f1be1d251993",
        );
        assert_eq!(found.as_deref(), Some(path.as_path()));
        // 直接对临时文件跑解析器（read_codex_timeline 固定读 codex_home，不做端到端依赖）。
        let timeline = read_jsonl_timeline(&path, parse_codex_line).unwrap();
        assert_eq!(timeline.turn_count, 1);
        let contents: Vec<String> = timeline
            .events
            .iter()
            .filter_map(|event| event.content.clone())
            .collect();
        assert_eq!(contents, vec!["任务正文", "执行完成"]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reads_complete_codex_timeline_with_totals() {
        let root = std::env::temp_dir().join(format!("flowlet-codex-complete-{}", Uuid::new_v4()));
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

        // 完整时间线不做展示截断：超过旧事件上限的全部事件都保留，truncated 恒为 false。
        let mut timeline = read_jsonl_timeline(&path, parse_codex_line).unwrap();
        assert!(!timeline.truncated);
        assert_eq!(timeline.events.len(), MAX_TIMELINE_EVENTS + 3);
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
    fn claude_timeline_returns_full_session_without_truncation() {
        let root = std::env::temp_dir().join(format!("flowlet-claude-full-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("session.jsonl");
        // 长会话（远超旧事件上限）：任务「会话」Tab 需要完整会话，时间线不做任何截断，
        // 首条用户消息与全部助手消息都保留。
        let mut records = String::from(
            "{\"type\":\"user\",\"uuid\":\"u0\",\"timestamp\":\"2026-07-30T08:00:00Z\",\"message\":{\"role\":\"user\",\"content\":\"task prompt\"}}\n",
        );
        for index in 0..(MAX_TIMELINE_EVENTS + 10) {
            records.push_str(&format!(
                "{{\"type\":\"assistant\",\"uuid\":\"a-{index}\",\"timestamp\":\"2026-07-30T08:01:00Z\",\"message\":{{\"id\":\"m-{index}\",\"role\":\"assistant\",\"usage\":{{\"input_tokens\":100,\"output_tokens\":20}},\"content\":\"event {index}\"}}}}\n"
            ));
        }
        fs::write(&path, records).unwrap();

        let timeline = read_jsonl_timeline(&path, parse_claude_line).unwrap();
        assert!(!timeline.truncated);
        assert_eq!(timeline.events.len(), MAX_TIMELINE_EVENTS + 11);
        let first = timeline.events.first().unwrap();
        let last = timeline.events.last().unwrap();
        assert_eq!(first.kind, "user-message");
        assert_eq!(first.content.as_deref(), Some("task prompt"));
        assert_eq!(last.kind, "assistant-message");
        assert_eq!(last.content.as_deref(), Some("event 309"));
        // 用量归属仍准确：每个 assistant 事件都带所属消息的用量。
        assert_eq!(last.usage.as_ref().unwrap().total_tokens, 120);
        assert_eq!(timeline.turn_count, (MAX_TIMELINE_EVENTS + 10) as i64);
        assert_eq!(
            timeline.usage.as_ref().unwrap().total_tokens,
            (MAX_TIMELINE_EVENTS + 10) as i64 * 120
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn estimates_codex_api_equivalent_value() {
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
        apply_native_cost_estimate_to_summary("codex-desktop", &mut summary, &[api_price]);
        let usage = summary.usage.unwrap();
        let api_equivalent = usage.api_equivalent.unwrap();
        assert_eq!(api_equivalent.currency.as_deref(), Some("USD"));
        assert_eq!(api_equivalent.price_version.as_deref(), Some("2026-07-19"));
        assert_eq!(api_equivalent.priced_turn_count, 1);
        assert_eq!(api_equivalent.unpriced_turn_count, 0);
        assert!((api_equivalent.amount.unwrap() - 0.0038925).abs() < f64::EPSILON);
        assert!((api_equivalent.input_uncached_amount.unwrap() - 0.00165).abs() < f64::EPSILON);
        assert!((api_equivalent.input_cached_amount.unwrap() - 0.00008).abs() < f64::EPSILON);
        assert!(
            (api_equivalent.input_cache_write_amount.unwrap() - 0.0000625).abs() < f64::EPSILON
        );
        assert!((api_equivalent.output_amount.unwrap() - 0.0021).abs() < f64::EPSILON);
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
                "{\"type\":\"event_msg\",\"timestamp\":\"2026-07-30T08:00:00Z\",\"payload\":{\"type\":\"task_started\",\"turn_id\":\"turn-1\"}}\n",
                "{\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt-a\"}}\n",
                "{\"type\":\"event_msg\",\"timestamp\":\"2026-07-30T08:05:00Z\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":80,\"cached_input_tokens\":40,\"output_tokens\":20,\"total_tokens\":100}}}}\n"
            ),
        )
        .unwrap();
        let (first, offset, usage_ids, first_events) =
            read_jsonl_summary_range(&path, "codex-desktop", 0, HashSet::new(), None).unwrap();
        assert_eq!(first.turn_count, 1);
        assert_eq!(first.usage.as_ref().unwrap().total_tokens, 100);
        // 全量解析：首条 token_count 的差分即其累计值。
        assert_eq!(first_events.len(), 1);
        assert_eq!(first_events[0].total_tokens, 100);
        assert_eq!(first_events[0].cached_input_tokens, 40);
        assert_eq!(first_events[0].event_time, "2026-07-30T08:05:00+00:00");

        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(
            concat!(
                "{\"type\":\"event_msg\",\"timestamp\":\"2026-07-30T09:00:00Z\",\"payload\":{\"type\":\"task_complete\",\"turn_id\":\"turn-1\"}}\n",
                "{\"type\":\"event_msg\",\"timestamp\":\"2026-07-30T09:10:00Z\",\"payload\":{\"type\":\"task_started\",\"turn_id\":\"turn-2\"}}\n",
                "{\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt-b\"}}\n",
                "{\"type\":\"event_msg\",\"timestamp\":\"2026-07-30T09:15:00Z\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":200,\"cached_input_tokens\":120,\"output_tokens\":50,\"total_tokens\":250}}}}\n"
            )
            .as_bytes(),
        )
        .unwrap();
        drop(file);

        // 增量续跑：以 first.usage 为基线求差分。
        let (delta, final_offset, _, delta_events) = read_jsonl_summary_range(
            &path,
            "codex-desktop",
            offset,
            usage_ids,
            first.usage.clone(),
        )
        .unwrap();
        assert_eq!(delta_events.len(), 1);
        assert_eq!(delta_events[0].total_tokens, 150);
        assert_eq!(delta_events[0].cached_input_tokens, 80);
        assert_eq!(delta_events[0].event_time, "2026-07-30T09:15:00+00:00");
        let merged = merge_incremental_summary("codex-desktop", first, delta);
        assert_eq!(merged.turn_count, 2);
        assert_eq!(merged.models, vec!["gpt-a", "gpt-b"]);
        assert_eq!(merged.usage.as_ref().unwrap().total_tokens, 250);
        assert_eq!(final_offset, fs::metadata(&path).unwrap().len());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn codex_usage_events_allow_negative_delta_on_compaction() {
        let root = std::env::temp_dir().join(format!("flowlet-codex-delta-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("session.jsonl");
        fs::write(
            &path,
            concat!(
                "{\"type\":\"event_msg\",\"timestamp\":\"2026-07-30T08:05:00Z\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":80,\"output_tokens\":20,\"total_tokens\":100}}}}\n",
                "{\"type\":\"event_msg\",\"timestamp\":\"2026-07-30T09:05:00Z\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":30,\"output_tokens\":10,\"total_tokens\":40}}}}\n"
            ),
        )
        .unwrap();
        let (_, _, _, events) =
            read_jsonl_summary_range(&path, "codex-desktop", 0, HashSet::new(), None).unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].total_tokens, 100);
        // 累计回退（上下文压缩）时保留负差分，保证账本合计 ≡ 会话最终总量。
        assert_eq!(events[1].total_tokens, -60);
        assert_eq!(events[1].input_tokens, -50);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn incremental_claude_summary_deduplicates_usage_ids() {
        use std::io::Write as _;

        let root = std::env::temp_dir().join(format!("flowlet-claude-cursor-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("session.jsonl");
        let first_line = "{\"type\":\"assistant\",\"uuid\":\"u1\",\"timestamp\":\"2026-07-30T08:00:01Z\",\"message\":{\"id\":\"msg-1\",\"model\":\"claude-a\",\"usage\":{\"input_tokens\":100,\"output_tokens\":20}}}\n";
        fs::write(&path, first_line).unwrap();
        let (first, offset, usage_ids, first_events) =
            read_jsonl_summary_range(&path, "claude-code", 0, HashSet::new(), None).unwrap();
        assert_eq!(first_events.len(), 1);
        assert_eq!(first_events[0].event_id, "msg-1");
        assert_eq!(first_events[0].total_tokens, 120);
        assert_eq!(first_events[0].model.as_deref(), Some("claude-a"));

        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(first_line.as_bytes()).unwrap();
        file.write_all(b"{\"type\":\"assistant\",\"uuid\":\"u2\",\"timestamp\":\"2026-07-30T08:10:01Z\",\"message\":{\"id\":\"msg-2\",\"model\":\"claude-b\",\"usage\":{\"input_tokens\":200,\"cache_read_input_tokens\":50,\"output_tokens\":30}}}\n").unwrap();
        drop(file);

        let (delta, _, _, delta_events) =
            read_jsonl_summary_range(&path, "claude-code", offset, usage_ids, None).unwrap();
        // 重复行不再产生账本事件；只追加新消息的增量事件。
        assert_eq!(delta_events.len(), 1);
        assert_eq!(delta_events[0].event_id, "msg-2");
        assert_eq!(delta_events[0].cached_input_tokens, 50);
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
        let mut usage_events = Vec::new();
        let timeline =
            read_opencode_timeline_from(&connection, "ses", Some(&mut usage_events)).unwrap();
        assert_eq!(timeline.events.len(), 4);
        assert_eq!(timeline.events[0].kind, "user-message");
        assert_eq!(timeline.events[2].kind, "tool-call");
        assert_eq!(timeline.events[3].kind, "tool-result");
        assert_eq!(timeline.models, vec!["model-a"]);
        assert_eq!(timeline.usage.as_ref().unwrap().total_tokens, 1300);
        assert_eq!(timeline.usage.as_ref().unwrap().cost, Some(0.125));
        assert_eq!(timeline.events[1].usage.as_ref().unwrap().total_tokens, 250);
        // 账本事件：assistant 消息 m2 的逐消息用量（event_time 取消息 time_created）。
        assert_eq!(usage_events.len(), 1);
        assert_eq!(usage_events[0].event_id, "m2");
        assert_eq!(usage_events[0].total_tokens, 250);
        assert_eq!(usage_events[0].cached_input_tokens, 80);
        assert_eq!(usage_events[0].model.as_deref(), Some("model-a"));
        assert_eq!(usage_events[0].event_time, "1970-01-01T00:00:02+00:00");
    }
}
