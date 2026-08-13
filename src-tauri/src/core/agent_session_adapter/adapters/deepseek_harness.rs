use super::super::*;
use crate::core::config::{
    AgentSessionNativeSummary, AgentSessionNativeUsage, AgentSessionTimelineEvent,
};
use chrono::{DateTime, Utc};
use serde_json::Value;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

pub(super) struct DeepSeekHarnessSessionAdapter;

impl AgentSessionAdapter for DeepSeekHarnessSessionAdapter {
    fn id(&self) -> &'static str {
        "deepseek-harness"
    }
    fn agent_types(&self) -> &'static [&'static str] {
        &["deepseek-harness"]
    }
    fn source_watches(&self) -> Vec<NativeAgentSourceWatch> {
        dsh_sessions_root()
            .filter(|path| path.is_dir())
            .map(|path| {
                vec![NativeAgentSourceWatch {
                    agent_type: "deepseek-harness".to_string(),
                    path,
                    recursive: true,
                }]
            })
            .unwrap_or_default()
    }
    fn list_sessions(&self) -> Vec<AgentSessionRow> {
        let mut rows = session_files()
            .into_iter()
            .filter_map(|path| session_row(&path).ok())
            .collect::<Vec<_>>();
        rows.sort_by(|a, b| b.activity_at.cmp(&a.activity_at));
        rows
    }
    fn timeline(
        &self,
        _agent_type: &str,
        session_id: &str,
    ) -> Result<AgentSessionTimeline, String> {
        let path = find_session_file(session_id)
            .ok_or_else(|| format!("未找到 DeepSeek Harness 会话 {session_id}"))?;
        read_timeline(&path)
    }
    fn last_interaction(
        &self,
        _agent_type: &str,
        session_id: &str,
    ) -> Result<Option<AgentSessionTimeline>, String> {
        let Some(path) = find_session_file(session_id) else {
            return Ok(None);
        };
        let mut timeline = read_timeline(&path)?;
        if let Some(index) = timeline
            .events
            .iter()
            .rposition(|event| event.kind == "user-message")
        {
            timeline.events = timeline.events.split_off(index);
        }
        Ok(Some(timeline))
    }
}

fn dsh_sessions_root() -> Option<PathBuf> {
    std::env::var_os("DSH_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".dsh")))
        .map(|home| home.join("sessions"))
}

fn session_files() -> Vec<PathBuf> {
    let Some(root) = dsh_sessions_root() else {
        return Vec::new();
    };
    let mut pending = vec![root];
    let mut files = Vec::new();
    while let Some(dir) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if path.is_dir() {
                pending.push(path);
            } else if matches!(
                path.file_name().and_then(|v| v.to_str()),
                Some("session.jsonl" | "session.jsonl.zstd")
            ) {
                files.push(path);
            }
        }
    }
    files
}

fn read_records(path: &Path) -> Result<Vec<Value>, String> {
    let file =
        File::open(path).map_err(|e| format!("读取 DSH 会话 {} 失败：{e}", path.display()))?;
    let mut text = String::new();
    if path.extension().and_then(|value| value.to_str()) == Some("zstd") {
        zstd::stream::read::Decoder::new(file)
            .map_err(|e| format!("打开 DSH Zstandard 会话失败：{e}"))?
            .read_to_string(&mut text)
            .map_err(|e| format!("解压 DSH 会话失败：{e}"))?;
    } else {
        std::io::BufReader::new(file)
            .read_to_string(&mut text)
            .map_err(|e| format!("读取 DSH 会话失败：{e}"))?;
    }
    text.lines()
        .enumerate()
        .filter(|(_, line)| !line.trim().is_empty())
        .map(|(index, line)| {
            serde_json::from_str(line).map_err(|error| {
                format!(
                    "解析 DSH 会话 {} 第 {} 行失败：{error}",
                    path.display(),
                    index + 1
                )
            })
        })
        .collect()
}

fn find_session_file(session_id: &str) -> Option<PathBuf> {
    session_files().into_iter().find(|path| {
        read_records(path)
            .ok()
            .and_then(|records| {
                records
                    .first()
                    .and_then(|v| v.get("id"))
                    .and_then(Value::as_str)
                    .map(|id| id == session_id)
            })
            .unwrap_or(false)
    })
}

fn millis_time(value: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(value)
        .unwrap_or(DateTime::<Utc>::UNIX_EPOCH)
        .to_rfc3339()
}

fn session_row(path: &Path) -> Result<AgentSessionRow, String> {
    let records = read_records(path)?;
    let header = records
        .first()
        .ok_or_else(|| "DSH 会话缺少 header".to_string())?;
    if header.get("type").and_then(Value::as_str) != Some("session")
        || header.get("version").and_then(Value::as_i64) != Some(0)
    {
        return Err("DSH 会话格式不是 Flowlet 当前支持的预发布 v0".to_string());
    }
    let session_id = header
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "DSH 会话 header 缺少 id".to_string())?
        .to_string();
    let created = millis_time(
        header
            .get("createdAt")
            .and_then(Value::as_i64)
            .unwrap_or_default(),
    );
    let updated = std::fs::metadata(path)
        .ok()
        .and_then(|meta| meta.modified().ok())
        .map(DateTime::<Utc>::from)
        .map(|time| time.to_rfc3339())
        .unwrap_or_else(|| created.clone());
    let timeline = read_timeline_records(&records)?;
    let completed = records
        .iter()
        .rev()
        .find(|value| value.get("type").and_then(Value::as_str) == Some("turn/end"))
        .and_then(|value| value.pointer("/data/reason/kind"))
        .and_then(Value::as_str)
        == Some("completed");
    Ok(AgentSessionRow {
        agent_type: "deepseek-harness".to_string(),
        session_id,
        runtime_status: if completed { "completed" } else { "unknown" }.to_string(),
        title: first_user_text(&records),
        project_path: header
            .get("cwd")
            .and_then(Value::as_str)
            .map(str::to_string),
        parent_session_id: header
            .get("parentSession")
            .and_then(Value::as_str)
            .map(str::to_string),
        client_id: None,
        client_name: Some("DeepSeek Harness".to_string()),
        native_started_at: Some(created.clone()),
        native_updated_at: Some(updated.clone()),
        activity_at: updated.clone(),
        flowlet_observed: false,
        started_at: created,
        updated_at: updated,
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
        native_summary: Some(AgentSessionNativeSummary {
            source_available: true,
            truncated: false,
            turn_count: timeline.turn_count,
            usage: timeline.usage.clone(),
            models: timeline.models.clone(),
        }),
        native_synced_at: None,
    })
}

fn first_user_text(records: &[Value]) -> Option<String> {
    records
        .iter()
        .find(|v| v.get("type").and_then(Value::as_str) == Some("user/message"))
        .and_then(|v| message_text(v.get("data")?))
        .map(|text| text.chars().take(120).collect())
}

fn read_timeline(path: &Path) -> Result<AgentSessionTimeline, String> {
    read_timeline_records(&read_records(path)?)
}

fn read_timeline_records(records: &[Value]) -> Result<AgentSessionTimeline, String> {
    let header = records
        .first()
        .ok_or_else(|| "DSH 会话缺少 header".to_string())?;
    if header.get("version").and_then(Value::as_i64) != Some(0) {
        return Err("DSH 会话格式不是 Flowlet 当前支持的预发布 v0".to_string());
    }
    let mut timeline = AgentSessionTimeline {
        source_available: true,
        truncated: false,
        turn_count: 0,
        usage: None,
        models: Vec::new(),
        events: Vec::new(),
        event_limit: None,
        content_limit: None,
    };
    let mut total = AgentSessionNativeUsage::default();
    for value in records.iter().skip(1) {
        let kind = value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let seq = value.get("seq").and_then(Value::as_i64).unwrap_or_default();
        let timestamp = value.get("time").and_then(Value::as_i64).map(millis_time);
        let data = value.get("data").unwrap_or(&Value::Null);
        match kind {
            "user/message" => push_event(
                &mut timeline,
                seq,
                "user-message",
                timestamp,
                None,
                message_text(data),
                None,
                None,
            ),
            "assistant/message" => {
                let message = data.get("message").unwrap_or(&Value::Null);
                let model = message
                    .pointer("/source/model")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                if let Some(model) = model
                    .as_ref()
                    .filter(|model| !timeline.models.contains(model))
                {
                    timeline.models.push(model.clone());
                }
                let usage = native_usage(data.get("usage"));
                if let Some(value) = &usage {
                    add_usage(&mut total, value);
                }
                push_event(
                    &mut timeline,
                    seq,
                    "assistant-message",
                    timestamp,
                    None,
                    message_text(message),
                    model,
                    usage,
                );
                timeline.turn_count += 1;
            }
            "tool/call" => push_event(
                &mut timeline,
                seq,
                "tool-call",
                timestamp,
                data.get("name").and_then(Value::as_str).map(str::to_string),
                data.get("arguments")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                None,
                None,
            ),
            "tool/result" => push_event(
                &mut timeline,
                seq,
                "tool-result",
                timestamp,
                data.pointer("/message/toolName")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                data.get("message").and_then(message_text),
                None,
                None,
            ),
            _ => {}
        }
    }
    if total.total_tokens > 0 {
        timeline.usage = Some(total);
    }
    Ok(timeline)
}

fn push_event(
    timeline: &mut AgentSessionTimeline,
    seq: i64,
    kind: &str,
    timestamp: Option<String>,
    title: Option<String>,
    content: Option<String>,
    model: Option<String>,
    usage: Option<AgentSessionNativeUsage>,
) {
    timeline.events.push(AgentSessionTimelineEvent {
        id: format!("dsh-{seq}"),
        kind: kind.to_string(),
        source: "deepseek-harness".to_string(),
        timestamp,
        title,
        content,
        model,
        status: None,
        duration_ms: None,
        time_to_first_token_ms: None,
        usage,
    });
}

fn message_text(value: &Value) -> Option<String> {
    value
        .get("content")
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(|block| {
                    block
                        .get("text")
                        .and_then(Value::as_str)
                        .or_else(|| block.get("content").and_then(Value::as_str))
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .filter(|text| !text.is_empty())
}

fn native_usage(value: Option<&Value>) -> Option<AgentSessionNativeUsage> {
    let value = value?;
    let input = value
        .get("inputTokens")
        .or_else(|| value.get("input"))
        .and_then(Value::as_i64)
        .unwrap_or_default();
    let cached = value
        .get("cacheReadTokens")
        .or_else(|| value.get("cacheRead"))
        .and_then(Value::as_i64)
        .unwrap_or_default();
    let write = value
        .get("cacheWriteTokens")
        .or_else(|| value.get("cacheWrite"))
        .and_then(Value::as_i64)
        .unwrap_or_default();
    let output = value
        .get("outputTokens")
        .or_else(|| value.get("output"))
        .and_then(Value::as_i64)
        .unwrap_or_default();
    let reasoning = value
        .get("reasoningTokens")
        .or_else(|| value.get("reasoning"))
        .and_then(Value::as_i64)
        .unwrap_or_default();
    // DSH TokenUsage 将 uncached input、cache read、cache write 分开计数；reasoning
    // 是 output 的细分，不再额外叠加到总量。
    let total_tokens = input + cached + write + output;
    (total_tokens > 0 || cached > 0 || write > 0).then_some(AgentSessionNativeUsage {
        input_tokens: input,
        cached_input_tokens: cached,
        cache_write_input_tokens: write,
        output_tokens: output,
        reasoning_tokens: reasoning,
        total_tokens,
        cost: None,
        cost_currency: None,
        api_equivalent: None,
    })
}

fn add_usage(total: &mut AgentSessionNativeUsage, value: &AgentSessionNativeUsage) {
    total.input_tokens += value.input_tokens;
    total.cached_input_tokens += value.cached_input_tokens;
    total.cache_write_input_tokens += value.cache_write_input_tokens;
    total.output_tokens += value.output_tokens;
    total.reasoning_tokens += value.reasoning_tokens;
    total.total_tokens += value.total_tokens;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_committed_messages_tools_and_disjoint_usage() {
        let records = vec![
            serde_json::json!({"type":"session","version":0,"id":"session-1","createdAt":1_700_000_000_000i64,"cwd":"C:/repo","delegationDepth":0}),
            serde_json::json!({"type":"user/message","seq":0,"time":1_700_000_000_001i64,"data":{"role":"user","content":[{"type":"text","text":"inspect the repo"}]}}),
            serde_json::json!({"type":"tool/call","seq":1,"time":1_700_000_000_002i64,"data":{"name":"read_file","arguments":"{\"path\":\"README.md\"}"}}),
            serde_json::json!({"type":"assistant/message","seq":2,"time":1_700_000_000_003i64,"data":{"message":{"role":"assistant","source":{"provider":"flowlet","model":"flowlet-pro"},"content":[{"type":"text","text":"done"}]},"usage":{"inputTokens":10,"cacheReadTokens":20,"cacheWriteTokens":3,"outputTokens":5,"reasoningTokens":2}}}),
        ];

        let timeline = read_timeline_records(&records).unwrap();
        assert_eq!(timeline.turn_count, 1);
        assert_eq!(timeline.models, vec!["flowlet-pro"]);
        assert_eq!(timeline.events.len(), 3);
        assert_eq!(
            timeline.events[0].content.as_deref(),
            Some("inspect the repo")
        );
        assert_eq!(timeline.events[1].kind, "tool-call");
        let usage = timeline.usage.unwrap();
        assert_eq!(usage.input_tokens, 10);
        assert_eq!(usage.cached_input_tokens, 20);
        assert_eq!(usage.cache_write_input_tokens, 3);
        assert_eq!(usage.output_tokens, 5);
        assert_eq!(usage.reasoning_tokens, 2);
        assert_eq!(usage.total_tokens, 38);
    }

    #[test]
    fn rejects_foreign_prerelease_session_format() {
        let records = vec![
            serde_json::json!({"type":"session","version":1,"id":"future","createdAt":0,"delegationDepth":0}),
        ];
        assert!(read_timeline_records(&records)
            .unwrap_err()
            .contains("预发布 v0"));
    }
}
