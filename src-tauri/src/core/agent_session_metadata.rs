use super::agent_session_sources::{
    collect_jsonl_files, format_unix_millis, format_unix_seconds, hermes_database_candidates,
    opencode_database_candidates, string_field,
};
use super::config::AgentSessionRow;
use chrono::{DateTime, NaiveDateTime, Utc};
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, Metadata};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

const MAX_CLAUDE_TRANSCRIPT_BYTES: usize = 1024 * 1024;
const MAX_RUNTIME_STATUS_BYTES: u64 = 256 * 1024;
const CLAUDE_RUNNING_FRESHNESS_SECS: u64 = 30 * 60;
const CLAUDE_WAITING_USER_FRESHNESS_SECS: u64 = 24 * 60 * 60;
const CODEX_RUNNING_FRESHNESS_SECS: u64 = 30 * 60;
const CODEX_WAITING_USER_FRESHNESS_SECS: u64 = 24 * 60 * 60;
const OPENCODE_EMPTY_ASSISTANT_GRACE_MILLIS: i64 = 30_000;
const EMPTY_SESSION_TIME: &str = "1970-01-01T00:00:00Z";

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct NativeSessionMetadata {
    runtime_status: Option<String>,
    title: Option<String>,
    project_path: Option<String>,
    parent_session_id: Option<String>,
    native_started_at: Option<String>,
    native_updated_at: Option<String>,
}

#[derive(Clone)]
struct CachedClaudeSession {
    file_len: u64,
    modified: Option<SystemTime>,
    metadata: NativeSessionMetadata,
}

static CLAUDE_SESSION_CACHE: OnceLock<Mutex<HashMap<PathBuf, CachedClaudeSession>>> =
    OnceLock::new();

#[derive(Clone, Debug)]
pub struct NativeAgentSourceWatch {
    pub agent_type: String,
    pub path: PathBuf,
    pub recursive: bool,
}

pub fn native_agent_source_watches() -> Vec<NativeAgentSourceWatch> {
    super::agent_session_adapter::session_adapters()
        .flat_map(|adapter| adapter.source_watches())
        .collect()
}

fn raw_native_agent_source_watches() -> Vec<NativeAgentSourceWatch> {
    let mut watches = Vec::new();
    if let Some(home) = dirs::home_dir() {
        let claude_home = home.join(".claude");
        let claude_projects = claude_home.join("projects");
        if claude_projects.is_dir() {
            watches.push(NativeAgentSourceWatch {
                agent_type: "claude-code".into(),
                path: claude_projects,
                recursive: true,
            });
        }
        let claude_live_sessions = claude_home.join("sessions");
        if claude_live_sessions.is_dir() {
            watches.push(NativeAgentSourceWatch {
                agent_type: "claude-code".into(),
                path: claude_live_sessions,
                recursive: false,
            });
        }
        let codex_home = std::env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".codex"));
        let sessions = codex_home.join("sessions");
        if sessions.is_dir() {
            watches.push(NativeAgentSourceWatch {
                agent_type: "codex".into(),
                path: sessions,
                recursive: true,
            });
            watches.push(NativeAgentSourceWatch {
                agent_type: "codex".into(),
                path: codex_home,
                recursive: false,
            });
        }
        // Pi 原生会话存储：`~/.pi/agent/sessions/<编码后的cwd>/<timestamp>_<uuid>.jsonl`。
        // 目录名是 cwd 按规则编码后的结果，这里直接递归扫描所有 .jsonl，无需反推编码。
        let pi_sessions = home.join(".pi").join("agent").join("sessions");
        if pi_sessions.is_dir() {
            watches.push(NativeAgentSourceWatch {
                agent_type: "pi".into(),
                path: pi_sessions,
                recursive: true,
            });
        }
    }
    // Hermes Agent 的会话与消息都持久化在 `state.db`（SQLite），监听其父目录以捕获
    // `state.db` / `state.db-wal` 的变更。
    for database in hermes_database_candidates()
        .into_iter()
        .filter(|path| path.is_file())
    {
        if let Some(parent) = database.parent() {
            watches.push(NativeAgentSourceWatch {
                agent_type: "hermes".into(),
                path: parent.to_path_buf(),
                recursive: false,
            });
        }
    }
    for database in opencode_database_candidates()
        .into_iter()
        .filter(|path| path.is_file())
    {
        if let Some(parent) = database.parent() {
            watches.push(NativeAgentSourceWatch {
                agent_type: "opencode".into(),
                path: parent.to_path_buf(),
                recursive: false,
            });
        }
    }
    let mut seen = HashSet::new();
    watches.retain(|watch| {
        seen.insert((
            watch.agent_type.clone(),
            watch.path.clone(),
            watch.recursive,
        ))
    });
    watches
}

fn source_watches_for(adapter_id: &str) -> Vec<NativeAgentSourceWatch> {
    raw_native_agent_source_watches()
        .into_iter()
        .filter(|watch| match adapter_id {
            "codex" => watch.agent_type == "codex",
            other => watch.agent_type == other,
        })
        .collect()
}

pub(crate) fn claude_source_watches() -> Vec<NativeAgentSourceWatch> {
    source_watches_for("claude-code")
}
pub(crate) fn opencode_source_watches() -> Vec<NativeAgentSourceWatch> {
    source_watches_for("opencode")
}
pub(crate) fn pi_source_watches() -> Vec<NativeAgentSourceWatch> {
    source_watches_for("pi")
}
pub(crate) fn codex_source_watches() -> Vec<NativeAgentSourceWatch> {
    source_watches_for("codex")
}
pub(crate) fn hermes_source_watches() -> Vec<NativeAgentSourceWatch> {
    source_watches_for("hermes")
}

pub fn available_native_agent_types() -> HashSet<String> {
    super::agent_session_adapter::session_adapters()
        .filter(|adapter| !adapter.source_watches().is_empty())
        .flat_map(|adapter| {
            adapter
                .agent_types()
                .iter()
                .map(|value| (*value).to_string())
        })
        .collect()
}

pub fn list_native_agent_sessions() -> Vec<AgentSessionRow> {
    let mut rows = Vec::new();
    let mut seen = HashSet::new();
    for adapter in super::agent_session_adapter::session_adapters() {
        for row in adapter.list_sessions() {
            if seen.insert(session_key(&row)) {
                rows.push(row);
            }
        }
    }
    rows
}

pub fn merge_agent_session_catalog(
    observed_rows: Vec<AgentSessionRow>,
    native_rows: Vec<AgentSessionRow>,
) -> Vec<AgentSessionRow> {
    let mut merged = native_rows
        .into_iter()
        .map(|row| (session_key(&row), row))
        .collect::<HashMap<_, _>>();

    for observed in observed_rows {
        let key = session_key(&observed);
        if let Some(native) = merged.get_mut(&key) {
            native.title = native.title.take().or(observed.title.clone());
            native.project_path = native.project_path.take().or(observed.project_path.clone());
            native.parent_session_id = native
                .parent_session_id
                .take()
                .or(observed.parent_session_id.clone());
            native.client_id = observed.client_id.clone();
            native.client_name = observed.client_name.clone();
            native.started_at = observed.started_at.clone();
            native.updated_at = observed.updated_at.clone();
            native.activity_at =
                later_session_time(&native.activity_at, &observed.activity_at).to_string();
            native.request_count = observed.request_count;
            native.success_count = observed.success_count;
            native.error_count = observed.error_count;
            native.known_tokens = observed.known_tokens;
            native.input_tokens = observed.input_tokens;
            native.input_cached_tokens = observed.input_cached_tokens;
            native.input_uncached_tokens = observed.input_uncached_tokens;
            native.cache_measured_input_tokens = observed.cache_measured_input_tokens;
            native.output_tokens = observed.output_tokens;
            native.unknown_usage_count = observed.unknown_usage_count;
            native.estimated_cost = observed.estimated_cost;
            native.estimated_input_uncached_cost = observed.estimated_input_uncached_cost;
            native.estimated_input_cached_cost = observed.estimated_input_cached_cost;
            native.estimated_input_cache_write_cost = observed.estimated_input_cache_write_cost;
            native.estimated_output_cost = observed.estimated_output_cost;
            native.flowlet_observed = true;
        } else {
            merged.insert(key, observed);
        }
    }
    let mut rows = merged.into_values().collect::<Vec<_>>();
    aggregate_descendant_runtime_status(&mut rows);
    rows
}

/// 根会话是列表与移动端快照的展示单位，因此它的运行状态必须覆盖整棵子会话树。
/// 等待确认比运行中更需要用户注意；空闲或未知子会话不覆盖父会话自身状态。
pub fn aggregate_descendant_runtime_status(catalog: &mut [AgentSessionRow]) {
    let index_by_key = catalog
        .iter()
        .enumerate()
        .map(|(index, row)| (session_key(row), index))
        .collect::<HashMap<_, _>>();
    let parent_by_key = catalog
        .iter()
        .filter_map(|row| {
            row.parent_session_id.as_ref().map(|parent_session_id| {
                (
                    session_key(row),
                    (row.agent_type.clone(), parent_session_id.clone()),
                )
            })
        })
        .collect::<HashMap<_, _>>();
    let active_descendants = catalog
        .iter()
        .filter(|row| runtime_status_priority(&row.runtime_status) > 0)
        .map(|row| (session_key(row), row.runtime_status.clone()))
        .collect::<Vec<_>>();

    for (descendant_key, descendant_status) in active_descendants {
        let mut current = descendant_key;
        let mut visited = HashSet::new();
        while visited.insert(current.clone()) {
            let Some(parent_key) = parent_by_key.get(&current).cloned() else {
                break;
            };
            let Some(parent_index) = index_by_key.get(&parent_key).copied() else {
                break;
            };
            if runtime_status_priority(&descendant_status)
                > runtime_status_priority(&catalog[parent_index].runtime_status)
            {
                catalog[parent_index].runtime_status = descendant_status.clone();
            }
            current = parent_key;
        }
    }
}

fn runtime_status_priority(status: &str) -> u8 {
    match status {
        "waiting_user" => 2,
        "running" => 1,
        _ => 0,
    }
}

pub(crate) fn list_claude_native_sessions() -> Vec<AgentSessionRow> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    let claude_home = home.join(".claude");
    list_claude_native_sessions_from_with_live_status(
        &claude_home.join("projects"),
        Some(&claude_home.join("sessions")),
    )
}

#[cfg(test)]
fn list_claude_native_sessions_from(projects_root: &Path) -> Vec<AgentSessionRow> {
    list_claude_native_sessions_from_with_live_status(projects_root, None)
}

fn list_claude_native_sessions_from_with_live_status(
    projects_root: &Path,
    live_sessions_root: Option<&Path>,
) -> Vec<AgentSessionRow> {
    if !projects_root.is_dir() {
        return Vec::new();
    }
    let live_runtime_statuses = live_sessions_root
        .map(read_claude_live_runtime_statuses)
        .unwrap_or_default();
    let mut paths = Vec::new();
    collect_jsonl_files(projects_root, &mut paths);
    let current_paths = paths.iter().cloned().collect::<HashSet<_>>();
    let cache = CLAUDE_SESSION_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let Ok(mut cache) = cache.lock() else {
        return Vec::new();
    };
    cache.retain(|path, _| !path.starts_with(projects_root) || current_paths.contains(path));

    paths
        .into_iter()
        .filter_map(|path| {
            let (session_id, parent_session_id) =
                classify_claude_session_path(projects_root, &path)?;
            let file_metadata = fs::metadata(&path).ok()?;
            let metadata = cached_claude_metadata(&mut cache, &path, &file_metadata)?;
            let transcript_runtime_status = apply_claude_runtime_freshness(
                metadata.runtime_status.as_deref().unwrap_or("unknown"),
                file_metadata.modified().ok(),
                SystemTime::now(),
            );
            // Claude Code 的 AskUserQuestion/权限确认界面可能在用户作答前不会写入
            // transcript。活动进程会把即时状态写到 ~/.claude/sessions/<pid>.json，
            // 因此该来源优先于只能事后回放的 JSONL；进程记录不存在时再回退。
            let runtime_status = live_runtime_statuses
                .get(&session_id)
                .cloned()
                .unwrap_or(transcript_runtime_status);
            Some(native_row(
                "claude-code",
                session_id,
                parent_session_id.or(metadata.parent_session_id),
                runtime_status,
                metadata.title,
                metadata.project_path,
                metadata.native_started_at,
                metadata.native_updated_at,
            ))
        })
        .collect()
}

fn read_claude_live_runtime_statuses(sessions_root: &Path) -> HashMap<String, String> {
    let Ok(entries) = fs::read_dir(sessions_root) else {
        return HashMap::new();
    };
    let now = SystemTime::now();
    entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                return None;
            }
            let file_metadata = entry.metadata().ok()?;
            if !file_metadata.is_file() || file_metadata.len() > MAX_RUNTIME_STATUS_BYTES {
                return None;
            }
            let mut content = String::new();
            File::open(&path)
                .ok()?
                .take(MAX_RUNTIME_STATUS_BYTES + 1)
                .read_to_string(&mut content)
                .ok()?;
            let value = serde_json::from_str::<Value>(&content).ok()?;
            let session_id = string_field(&value, "sessionId")?;
            let status = infer_claude_live_runtime_status(&value)?;
            let status = apply_claude_runtime_freshness(status, file_metadata.modified().ok(), now);
            Some((session_id, status))
        })
        .collect()
}

fn infer_claude_live_runtime_status(value: &Value) -> Option<&'static str> {
    let status = value.get("status")?.as_str()?;
    let waiting_for = value
        .get("waitingFor")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match (status, waiting_for) {
        ("waiting", "permission prompt" | "user input") => Some("waiting_user"),
        // `tool execution` 表示 Claude 正在等工具或子代理完成，仍属于运行中。
        ("waiting", _) => Some("running"),
        ("working" | "running" | "active" | "busy", _) => Some("running"),
        ("idle" | "stopped", _) => Some("idle"),
        _ => None,
    }
}

fn cached_claude_metadata(
    cache: &mut HashMap<PathBuf, CachedClaudeSession>,
    path: &Path,
    file_metadata: &Metadata,
) -> Option<NativeSessionMetadata> {
    let modified = file_metadata.modified().ok();
    if let Some(cached) = cache.get(path) {
        if cached.file_len == file_metadata.len() && cached.modified == modified {
            return Some(cached.metadata.clone());
        }
    }
    let metadata = read_claude_transcript(path)?;
    cache.insert(
        path.to_path_buf(),
        CachedClaudeSession {
            file_len: file_metadata.len(),
            modified,
            metadata: metadata.clone(),
        },
    );
    Some(metadata)
}

fn classify_claude_session_path(
    projects_root: &Path,
    path: &Path,
) -> Option<(String, Option<String>)> {
    let components = path
        .strip_prefix(projects_root)
        .ok()?
        .components()
        .filter_map(normal_component)
        .collect::<Vec<_>>();
    match components.as_slice() {
        [_project, file] => Some((jsonl_stem(file)?, None)),
        [_project, parent, subagents, file] if subagents == "subagents" => {
            Some((jsonl_stem(file)?, Some(parent.clone())))
        }
        _ => None,
    }
}

fn normal_component(component: Component<'_>) -> Option<String> {
    match component {
        Component::Normal(value) => value.to_str().map(str::to_string),
        _ => None,
    }
}

fn jsonl_stem(file_name: &str) -> Option<String> {
    Path::new(file_name)
        .extension()
        .and_then(|value| value.to_str())
        .filter(|extension| extension.eq_ignore_ascii_case("jsonl"))?;
    Path::new(file_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .map(str::to_string)
}

fn read_claude_transcript(path: &Path) -> Option<NativeSessionMetadata> {
    let file = File::open(path).ok()?;
    let mut metadata = NativeSessionMetadata::default();
    let mut bytes_read = 0;

    for line in BufReader::new(file).lines() {
        let Ok(line) = line else { break };
        bytes_read += line.len();
        if bytes_read > MAX_CLAUDE_TRANSCRIPT_BYTES {
            break;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if metadata.project_path.is_none() {
            metadata.project_path = string_field(&value, "cwd");
        }
        if metadata.native_started_at.is_none() {
            metadata.native_started_at = string_field(&value, "timestamp");
        }
        match value.get("type").and_then(Value::as_str) {
            Some("custom-title") => {
                metadata.title = string_field(&value, "customTitle")
                    .or_else(|| string_field(&value, "title"))
                    .or(metadata.title);
            }
            Some("ai-title") if metadata.title.is_none() => {
                metadata.title =
                    string_field(&value, "aiTitle").or_else(|| string_field(&value, "title"));
            }
            _ => {}
        }
    }

    metadata.native_updated_at = fs::metadata(path)
        .ok()
        .and_then(|value| value.modified().ok())
        .map(DateTime::<Utc>::from)
        .map(|value| value.to_rfc3339());
    metadata.runtime_status = Some(infer_claude_runtime_status(path));
    Some(metadata)
}

fn infer_claude_runtime_status(path: &Path) -> String {
    let mut status = "idle";
    for value in read_jsonl_tail(path) {
        match value.get("type").and_then(Value::as_str) {
            // Claude Code 的斜杠命令等本地命令会在 `system/local_command`
            // 之后写入 `isMeta: true` 的 synthetic user 记录。它不会发起模型轮次，
            // 不能覆盖前一个 end_turn / turn_duration 的空闲状态。
            Some("user") if value.get("isMeta").and_then(Value::as_bool) != Some(true) => {
                status = "running";
            }
            Some("assistant") => {
                let message = value.get("message").unwrap_or(&Value::Null);
                let waiting_for_user = message
                    .get("content")
                    .and_then(Value::as_array)
                    .is_some_and(|blocks| {
                        blocks.iter().any(|block| {
                            block.get("type").and_then(Value::as_str) == Some("tool_use")
                                && block
                                    .get("name")
                                    .and_then(Value::as_str)
                                    .is_some_and(claude_tool_waits_for_user)
                        })
                    });
                status = if waiting_for_user {
                    "waiting_user"
                } else if message.get("stop_reason").and_then(Value::as_str) == Some("tool_use") {
                    "running"
                } else {
                    "idle"
                };
            }
            Some("system")
                if matches!(
                    value.get("subtype").and_then(Value::as_str),
                    Some("turn_duration" | "away_summary" | "local_command")
                ) =>
            {
                status = "idle";
            }
            _ => {}
        }
    }
    apply_claude_runtime_freshness(
        status,
        fs::metadata(path)
            .ok()
            .and_then(|metadata| metadata.modified().ok()),
        SystemTime::now(),
    )
}

fn claude_tool_waits_for_user(tool_name: &str) -> bool {
    matches!(tool_name, "AskUserQuestion" | "ExitPlanMode")
}

fn apply_claude_runtime_freshness(
    status: &str,
    modified_at: Option<SystemTime>,
    now: SystemTime,
) -> String {
    let max_age_secs = match status {
        "running" => CLAUDE_RUNNING_FRESHNESS_SECS,
        "waiting_user" => CLAUDE_WAITING_USER_FRESHNESS_SECS,
        _ => return status.to_string(),
    };
    let is_stale = modified_at
        .and_then(|modified_at| now.duration_since(modified_at).ok())
        .is_some_and(|age| age.as_secs() > max_age_secs);
    if is_stale {
        "idle".to_string()
    } else {
        status.to_string()
    }
}

#[derive(Clone, Debug, Default)]
struct CodexSessionIndexEntry {
    title: Option<String>,
    updated_at: Option<String>,
}

pub(crate) fn list_codex_native_sessions() -> Vec<AgentSessionRow> {
    list_codex_native_sessions_from(&crate::core::codex_account::codex_home())
}

fn list_codex_native_sessions_from(codex_home: &Path) -> Vec<AgentSessionRow> {
    let sessions_root = codex_home.join("sessions");
    if !sessions_root.is_dir() {
        return Vec::new();
    }
    let index = read_codex_session_index(&codex_home.join("session_index.jsonl"));
    let mut paths = Vec::new();
    collect_jsonl_files(&sessions_root, &mut paths);
    paths
        .into_iter()
        .filter_map(|path| read_codex_session(&path, &index))
        .collect()
}

fn read_codex_session_index(path: &Path) -> HashMap<String, CodexSessionIndexEntry> {
    let Ok(file) = File::open(path) else {
        return HashMap::new();
    };
    let mut entries = HashMap::new();
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let Some(session_id) = string_field(&value, "id") else {
            continue;
        };
        entries.insert(
            session_id,
            CodexSessionIndexEntry {
                title: string_field(&value, "thread_name"),
                updated_at: string_field(&value, "updated_at"),
            },
        );
    }
    entries
}

fn read_codex_session(
    path: &Path,
    index: &HashMap<String, CodexSessionIndexEntry>,
) -> Option<AgentSessionRow> {
    let first_line = BufReader::new(File::open(path).ok()?)
        .lines()
        .next()?
        .ok()?;
    let value = serde_json::from_str::<Value>(&first_line).ok()?;
    if value.get("type").and_then(Value::as_str) != Some("session_meta") {
        return None;
    }
    let payload = value.get("payload")?;
    let agent_type = match string_field(payload, "originator")?.as_str() {
        "Codex Desktop" => "codex-desktop",
        // codex_exec：Rust 版 Codex CLI（0.147+）非交互 `codex exec` 写入的 originator；
        // codex_cli_rs / Codex CLI / codex-cli 兼容旧版本与桌面端内嵌 CLI。
        "codex_exec" | "codex_cli_rs" | "Codex CLI" | "codex-cli" => "codex-cli",
        _ => return None,
    };
    let session_id = string_field(payload, "id")?;
    let parent_session_id = string_field(payload, "parent_thread_id").or_else(|| {
        payload
            .get("source")
            .and_then(|source| source.get("subagent"))
            .and_then(|subagent| subagent.get("thread_spawn"))
            .and_then(|spawn| string_field(spawn, "parent_thread_id"))
    });
    let indexed = index.get(&session_id).cloned().unwrap_or_default();
    let title = indexed.title.or_else(|| {
        payload
            .get("source")
            .and_then(|source| source.get("subagent"))
            .and_then(|subagent| subagent.get("thread_spawn"))
            .and_then(|spawn| {
                string_field(spawn, "agent_nickname").or_else(|| string_field(spawn, "agent_path"))
            })
    });
    let file_updated_at = fs::metadata(path)
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .map(DateTime::<Utc>::from)
        .map(|value| value.to_rfc3339());
    let native_updated_at = match (indexed.updated_at, file_updated_at) {
        (Some(indexed), Some(file)) => Some(later_session_time(&indexed, &file).to_string()),
        (indexed, file) => indexed.or(file),
    };

    Some(native_row(
        agent_type,
        session_id,
        parent_session_id,
        infer_codex_runtime_status(path),
        title,
        string_field(payload, "cwd"),
        string_field(payload, "timestamp").or_else(|| string_field(&value, "timestamp")),
        native_updated_at,
    ))
}

fn infer_codex_runtime_status(path: &Path) -> String {
    let mut status = "idle";
    let mut turn_running = false;
    let mut pending_user_input = HashSet::new();
    for value in read_jsonl_tail(path) {
        let top_type = value.get("type").and_then(Value::as_str);
        let payload = value.get("payload").unwrap_or(&Value::Null);
        if top_type == Some("event_msg") {
            match payload.get("type").and_then(Value::as_str) {
                Some("task_started" | "turn_started") => {
                    turn_running = true;
                    pending_user_input.clear();
                    status = "running";
                }
                Some("task_complete" | "turn_complete" | "task_aborted" | "turn_aborted") => {
                    turn_running = false;
                    pending_user_input.clear();
                    status = "idle";
                }
                Some(
                    "exec_approval_request" | "apply_patch_approval_request" | "request_user_input",
                ) if turn_running => status = "waiting_user",
                _ => {}
            }
            continue;
        }
        if top_type != Some("response_item") {
            continue;
        }
        match payload.get("type").and_then(Value::as_str) {
            Some("function_call")
                if string_field(payload, "name").as_deref() == Some("request_user_input") =>
            {
                if let Some(call_id) = string_field(payload, "call_id") {
                    pending_user_input.insert(call_id);
                }
                status = "waiting_user";
            }
            Some("function_call_output" | "custom_tool_call_output") => {
                if let Some(call_id) = string_field(payload, "call_id") {
                    pending_user_input.remove(&call_id);
                }
                status = if pending_user_input.is_empty() {
                    "running"
                } else {
                    "waiting_user"
                };
            }
            Some("function_call" | "custom_tool_call") => {
                status = if pending_user_input.is_empty() {
                    "running"
                } else {
                    "waiting_user"
                };
            }
            _ => {}
        }
    }
    apply_codex_runtime_freshness(
        status,
        fs::metadata(path)
            .ok()
            .and_then(|metadata| metadata.modified().ok()),
        SystemTime::now(),
    )
}

fn apply_codex_runtime_freshness(
    status: &str,
    modified_at: Option<SystemTime>,
    now: SystemTime,
) -> String {
    let max_age_secs = match status {
        "running" => CODEX_RUNNING_FRESHNESS_SECS,
        "waiting_user" => CODEX_WAITING_USER_FRESHNESS_SECS,
        _ => return status.to_string(),
    };
    let is_stale = modified_at
        .and_then(|modified_at| now.duration_since(modified_at).ok())
        .is_some_and(|age| age.as_secs() > max_age_secs);
    if is_stale {
        "idle".to_string()
    } else {
        status.to_string()
    }
}

pub(crate) fn list_opencode_native_sessions() -> Vec<AgentSessionRow> {
    let mut rows = HashMap::new();
    for path in opencode_database_candidates() {
        for row in list_opencode_native_sessions_from(&path) {
            rows.entry(session_key(&row)).or_insert(row);
        }
    }
    rows.into_values().collect()
}

fn list_opencode_native_sessions_from(database_path: &Path) -> Vec<AgentSessionRow> {
    if !database_path.is_file() {
        return Vec::new();
    }
    let Ok(connection) = Connection::open_with_flags(
        database_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) else {
        return Vec::new();
    };
    let _ = connection.busy_timeout(std::time::Duration::from_millis(750));
    let Ok(mut statement) = connection.prepare(
        r#"
        SELECT
            s.id, s.title, s.directory, s.parent_id, s.time_created, s.time_updated,
            lm.data,
            lm.time_updated,
            EXISTS(SELECT 1 FROM part p WHERE p.message_id = lm.id)
        FROM session s
        LEFT JOIN message lm ON lm.id = (
            SELECT latest.id
            FROM message latest
            WHERE latest.session_id = s.id
            ORDER BY latest.time_created DESC
            LIMIT 1
        )
        "#,
    ) else {
        return Vec::new();
    };
    let Ok(mapped) = statement.query_map([], |row| {
        let session_id: String = row.get(0)?;
        let title: Option<String> = row.get(1)?;
        let project_path: Option<String> = row.get(2)?;
        let parent_session_id: Option<String> = row.get(3)?;
        let created_at: Option<i64> = row.get(4)?;
        let updated_at: Option<i64> = row.get(5)?;
        let latest_message: Option<String> = row.get(6)?;
        let latest_message_updated_at: Option<i64> = row.get(7)?;
        let latest_message_has_parts: bool = row.get(8)?;
        Ok(native_row(
            "opencode",
            session_id,
            parent_session_id,
            latest_message
                .as_deref()
                .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
                .map(|message| {
                    infer_opencode_runtime_status(
                        &message,
                        latest_message_has_parts,
                        latest_message_updated_at,
                        Utc::now().timestamp_millis(),
                    )
                })
                .unwrap_or_else(|| "idle".to_string()),
            title,
            project_path,
            created_at.and_then(format_unix_millis),
            updated_at.and_then(format_unix_millis),
        ))
    }) else {
        return Vec::new();
    };
    mapped.flatten().collect()
}

fn infer_opencode_runtime_status(
    message: &Value,
    has_parts: bool,
    updated_at: Option<i64>,
    now_millis: i64,
) -> String {
    match message.get("role").and_then(Value::as_str) {
        Some("user") => "running",
        Some("assistant")
            if message
                .get("time")
                .and_then(|time| time.get("completed"))
                .is_none()
                && message.get("error").is_none() =>
        {
            let empty_assistant_is_recent = updated_at.is_some_and(|updated_at| {
                now_millis.saturating_sub(updated_at) <= OPENCODE_EMPTY_ASSISTANT_GRACE_MILLIS
            });
            if has_parts || empty_assistant_is_recent {
                "running"
            } else {
                "idle"
            }
        }
        Some("assistant") => "idle",
        _ => "unknown",
    }
    .to_string()
}

pub(crate) fn list_pi_native_sessions() -> Vec<AgentSessionRow> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    list_pi_native_sessions_from(&home.join(".pi").join("agent").join("sessions"))
}

pub(crate) fn list_hermes_native_sessions() -> Vec<AgentSessionRow> {
    let mut rows = HashMap::new();
    for path in hermes_database_candidates() {
        for row in list_hermes_native_sessions_from(&path) {
            rows.entry(session_key(&row)).or_insert(row);
        }
    }
    rows.into_values().collect()
}

fn list_hermes_native_sessions_from(database_path: &Path) -> Vec<AgentSessionRow> {
    if !database_path.is_file() {
        return Vec::new();
    }
    let Ok(connection) = Connection::open_with_flags(
        database_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) else {
        return Vec::new();
    };
    let _ = connection.busy_timeout(std::time::Duration::from_millis(750));
    let Ok(mut statement) = connection.prepare(
        r#"
        SELECT s.id, s.title, s.cwd, s.parent_session_id, s.started_at, s.ended_at,
               (SELECT m.role FROM messages m
                 WHERE m.session_id = s.id ORDER BY m.id DESC LIMIT 1)
        FROM sessions s
        "#,
    ) else {
        return Vec::new();
    };
    let Ok(mapped) = statement.query_map([], |row| {
        let session_id: String = row.get(0)?;
        let title: Option<String> = row.get(1)?;
        let project_path: Option<String> = row.get(2)?;
        let parent_session_id: Option<String> = row.get(3)?;
        let started_at: Option<f64> = row.get(4)?;
        let ended_at: Option<f64> = row.get(5)?;
        let last_role: Option<String> = row.get(6)?;
        Ok(native_row(
            "hermes",
            session_id,
            parent_session_id,
            infer_hermes_runtime_status(ended_at, last_role.as_deref()),
            title,
            project_path,
            started_at.and_then(format_unix_seconds),
            ended_at.or(started_at).and_then(format_unix_seconds),
        ))
    }) else {
        return Vec::new();
    };
    mapped.flatten().collect()
}

/// Hermes 会话运行态：已结束恒为 idle；未结束时按最后一条消息角色推断——最后是
/// 用户消息表示 agent 正在处理（running），最后是 assistant 表示等待用户（idle）。
fn infer_hermes_runtime_status(ended_at: Option<f64>, last_role: Option<&str>) -> String {
    if ended_at.is_some() {
        return "idle".to_string();
    }
    match last_role {
        Some("user") => "running",
        Some("assistant") => "idle",
        _ => "unknown",
    }
    .to_string()
}

fn list_pi_native_sessions_from(sessions_root: &Path) -> Vec<AgentSessionRow> {
    if !sessions_root.is_dir() {
        return Vec::new();
    }
    let mut paths = Vec::new();
    collect_jsonl_files(sessions_root, &mut paths);
    paths
        .into_iter()
        .filter_map(|path| read_pi_session_summary(&path))
        .collect()
}

// 扫描 Pi 会话文件时最多读取的字节数。会话文件可能很大，列表页只需头行与标题，
// 无需读完全部内容；超出后回退到文件修改时间作为更新时间。
const MAX_PI_SESSION_SUMMARY_BYTES: usize = 64 * 1024;

fn read_pi_session_summary(path: &Path) -> Option<AgentSessionRow> {
    let file = File::open(path).ok()?;
    let mut session_id = None;
    let mut parent_session_id = None;
    let mut project_path = None;
    let mut native_started_at = None;
    let mut native_updated_at = None;
    let mut title = None;
    let mut first_user_text = None;
    let mut bytes_read = 0;

    for line in BufReader::new(file).lines() {
        let Ok(line) = line else { break };
        bytes_read += line.len();
        if bytes_read > MAX_PI_SESSION_SUMMARY_BYTES {
            break;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        match value.get("type").and_then(Value::as_str) {
            Some("session") => {
                // 头行：id 即会话 UUID（与扩展注入的 x-flowlet-session 值一致），
                // cwd 即项目路径，timestamp 即会话开始时间，parentSession 指向派生来源文件。
                if session_id.is_none() {
                    session_id = string_field(&value, "id");
                }
                if project_path.is_none() {
                    project_path = string_field(&value, "cwd");
                }
                if native_started_at.is_none() {
                    native_started_at = string_field(&value, "timestamp");
                }
                if parent_session_id.is_none() {
                    parent_session_id = string_field(&value, "parentSession")
                        .as_deref()
                        .and_then(pi_parent_session_id);
                }
            }
            Some("session_info") => {
                // 用户通过 /name 设置的名优先作为标题。
                if let Some(name) = string_field(&value, "name") {
                    title = Some(name);
                }
            }
            Some("message") => {
                if let Some(message) = value.get("message") {
                    if message.get("role").and_then(Value::as_str) == Some("user")
                        && first_user_text.is_none()
                    {
                        first_user_text = pi_first_user_text(message);
                    }
                }
            }
            _ => {}
        }
        // 所有 entry 都带 timestamp，取最后一个作为更新时间。
        if let Some(timestamp) = string_field(&value, "timestamp") {
            native_updated_at = Some(timestamp);
        }
    }

    // 回退：扫描被截断或没有有效 entry 时，用文件修改时间作为更新时间。
    if native_updated_at.is_none() {
        native_updated_at = fs::metadata(path)
            .ok()
            .and_then(|metadata| metadata.modified().ok())
            .map(DateTime::<Utc>::from)
            .map(|value| value.to_rfc3339());
    }

    let session_id = session_id?;
    // 无自定义名时，回退到首条用户消息文本作为标题。
    if title.is_none() {
        title = first_user_text;
    }
    Some(native_row(
        "pi",
        session_id,
        parent_session_id,
        infer_pi_runtime_status(path),
        title,
        project_path,
        native_started_at,
        native_updated_at,
    ))
}

fn infer_pi_runtime_status(path: &Path) -> String {
    let mut status = "idle";
    for value in read_jsonl_tail(path) {
        if value.get("type").and_then(Value::as_str) != Some("message") {
            continue;
        }
        let message = value.get("message").unwrap_or(&Value::Null);
        status = match message.get("role").and_then(Value::as_str) {
            Some("user" | "toolResult") => "running",
            Some("assistant")
                if message.get("stopReason").and_then(Value::as_str) == Some("toolUse") =>
            {
                "running"
            }
            Some("assistant") => "idle",
            _ => status,
        };
    }
    status.to_string()
}

// 从派生会话的 parentSession 文件路径中提取来源会话的 UUID。
// parentSession 形如 `.../<timestamp>_<uuid>.jsonl`，uuid 即文件名主干最后一个 `_` 之后的部分。
fn pi_parent_session_id(parent_session: &str) -> Option<String> {
    let stem = Path::new(parent_session)
        .file_stem()
        .and_then(|stem| stem.to_str())?;
    let (_, uuid) = stem.rsplit_once('_')?;
    (!uuid.is_empty()).then(|| uuid.to_string())
}

// 取 Pi 用户消息的首段文本（content 可能是字符串或 TextContent 数组），
// 截断后作为会话标题回退。
fn pi_first_user_text(message: &Value) -> Option<String> {
    let content = message.get("content")?;
    let text = match content {
        Value::String(text) => text.trim().to_string(),
        Value::Array(blocks) => blocks
            .iter()
            .filter_map(|block| {
                if block.get("type").and_then(Value::as_str) == Some("text") {
                    block.get("text").and_then(Value::as_str)
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join(" ")
            .trim()
            .to_string(),
        _ => String::new(),
    };
    (!text.is_empty()).then(|| truncate_session_title(&text, 80))
}

fn truncate_session_title(text: &str, max_chars: usize) -> String {
    let mut chars = text.chars();
    let prefix = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        format!("{prefix}…")
    } else {
        prefix
    }
}

fn native_row(
    agent_type: &str,
    session_id: String,
    parent_session_id: Option<String>,
    runtime_status: String,
    title: Option<String>,
    project_path: Option<String>,
    native_started_at: Option<String>,
    native_updated_at: Option<String>,
) -> AgentSessionRow {
    let activity_at = native_updated_at
        .clone()
        .or_else(|| native_started_at.clone())
        .unwrap_or_else(|| EMPTY_SESSION_TIME.to_string());
    AgentSessionRow {
        agent_type: agent_type.to_string(),
        session_id,
        runtime_status,
        title,
        project_path,
        parent_session_id,
        client_id: None,
        client_name: None,
        native_started_at,
        native_updated_at,
        activity_at: activity_at.clone(),
        flowlet_observed: false,
        started_at: activity_at.clone(),
        updated_at: activity_at,
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

fn read_jsonl_tail(path: &Path) -> Vec<Value> {
    let Ok(mut file) = File::open(path) else {
        return Vec::new();
    };
    let Ok(length) = file.metadata().map(|metadata| metadata.len()) else {
        return Vec::new();
    };
    let start = length.saturating_sub(MAX_RUNTIME_STATUS_BYTES);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return Vec::new();
    }
    let mut bytes = Vec::with_capacity((length - start) as usize);
    if file.read_to_end(&mut bytes).is_err() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&bytes);
    let mut lines = text.lines();
    if start > 0 {
        lines.next();
    }
    lines
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect()
}

fn session_key(row: &AgentSessionRow) -> (String, String) {
    (row.agent_type.clone(), row.session_id.clone())
}

fn later_session_time<'a>(left: &'a str, right: &'a str) -> &'a str {
    if parse_session_time(right) > parse_session_time(left) {
        right
    } else {
        left
    }
}

pub fn session_time_millis(value: &str) -> i64 {
    parse_session_time(value)
}

fn parse_session_time(value: &str) -> i64 {
    DateTime::parse_from_rfc3339(value)
        .map(|value| value.timestamp_millis())
        .or_else(|_| {
            NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S")
                .map(|value| value.and_utc().timestamp_millis())
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn catalog_test_row(
        session_id: &str,
        parent_session_id: Option<&str>,
        runtime_status: &str,
    ) -> AgentSessionRow {
        native_row(
            "claude-code",
            session_id.to_string(),
            parent_session_id.map(str::to_string),
            runtime_status.to_string(),
            None,
            None,
            Some("2026-08-01T00:00:00Z".to_string()),
            Some("2026-08-01T00:01:00Z".to_string()),
        )
    }

    #[test]
    fn aggregates_descendant_runtime_status_into_root_session() {
        let rows = merge_agent_session_catalog(
            Vec::new(),
            vec![
                catalog_test_row("root", None, "idle"),
                catalog_test_row("running-child", Some("root"), "running"),
                catalog_test_row("waiting-grandchild", Some("running-child"), "waiting_user"),
            ],
        );
        let status = |session_id: &str| {
            rows.iter()
                .find(|row| row.session_id == session_id)
                .map(|row| row.runtime_status.as_str())
        };
        assert_eq!(status("waiting-grandchild"), Some("waiting_user"));
        assert_eq!(status("running-child"), Some("waiting_user"));
        assert_eq!(status("root"), Some("waiting_user"));
    }

    #[test]
    fn descendant_runtime_aggregation_tolerates_parent_cycles() {
        let mut rows = vec![
            catalog_test_row("cycle-a", Some("cycle-b"), "running"),
            catalog_test_row("cycle-b", Some("cycle-a"), "idle"),
        ];
        aggregate_descendant_runtime_status(&mut rows);
        assert!(rows.iter().all(|row| row.runtime_status == "running"));
    }

    #[test]
    fn infers_codex_running_waiting_and_idle_runtime_states() {
        let path =
            std::env::temp_dir().join(format!("flowlet-codex-state-{}.jsonl", Uuid::new_v4()));
        fs::write(
            &path,
            concat!(
                "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\"}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"custom_tool_call\",\"call_id\":\"tool-1\",\"name\":\"exec\"}}\n"
            ),
        )
        .unwrap();
        assert_eq!(infer_codex_runtime_status(&path), "running");

        fs::write(
            &path,
            concat!(
                "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\"}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"call_id\":\"question-1\",\"name\":\"request_user_input\"}}\n"
            ),
        )
        .unwrap();
        assert_eq!(infer_codex_runtime_status(&path), "waiting_user");

        fs::write(
            &path,
            concat!(
                "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\"}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"call_id\":\"question-1\",\"name\":\"request_user_input\"}}\n",
                "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call_output\",\"call_id\":\"question-1\"}}\n",
                "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\"}}\n"
            ),
        )
        .unwrap();
        assert_eq!(infer_codex_runtime_status(&path), "idle");
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn expires_stale_codex_running_and_waiting_states() {
        let now = SystemTime::now();
        assert_eq!(
            apply_codex_runtime_freshness(
                "running",
                Some(now - std::time::Duration::from_secs(CODEX_RUNNING_FRESHNESS_SECS + 1)),
                now,
            ),
            "idle"
        );
        assert_eq!(
            apply_codex_runtime_freshness(
                "waiting_user",
                Some(now - std::time::Duration::from_secs(CODEX_WAITING_USER_FRESHNESS_SECS + 1),),
                now,
            ),
            "idle"
        );
        assert_eq!(
            apply_codex_runtime_freshness(
                "running",
                Some(now - std::time::Duration::from_secs(CODEX_RUNNING_FRESHNESS_SECS - 1)),
                now,
            ),
            "running"
        );
        assert_eq!(
            apply_codex_runtime_freshness(
                "waiting_user",
                Some(now - std::time::Duration::from_secs(CODEX_WAITING_USER_FRESHNESS_SECS - 1),),
                now,
            ),
            "waiting_user"
        );
    }

    #[test]
    fn infers_claude_interaction_tools_without_treating_normal_tool_as_confirmation() {
        let path =
            std::env::temp_dir().join(format!("flowlet-claude-state-{}.jsonl", Uuid::new_v4()));
        fs::write(
            &path,
            "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"stop_reason\":\"tool_use\",\"content\":[{\"type\":\"tool_use\",\"name\":\"Read\"}]}}\n",
        )
        .unwrap();
        assert_eq!(infer_claude_runtime_status(&path), "running");

        fs::write(
            &path,
            "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"stop_reason\":\"tool_use\",\"content\":[{\"type\":\"tool_use\",\"name\":\"AskUserQuestion\"}]}}\n",
        )
        .unwrap();
        assert_eq!(infer_claude_runtime_status(&path), "waiting_user");

        fs::write(
            &path,
            "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"stop_reason\":\"tool_use\",\"content\":[{\"type\":\"tool_use\",\"name\":\"ExitPlanMode\"}]}}\n",
        )
        .unwrap();
        assert_eq!(infer_claude_runtime_status(&path), "waiting_user");

        fs::write(
            &path,
            "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"stop_reason\":\"tool_use\",\"content\":[{\"type\":\"tool_use\",\"name\":\"ExitPlanMode\"}]}}\n{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"tool-plan\",\"content\":\"User has approved your plan.\"}]}}\n",
        )
        .unwrap();
        assert_eq!(infer_claude_runtime_status(&path), "running");
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn keeps_claude_idle_after_local_command_meta_user_record() {
        let path =
            std::env::temp_dir().join(format!("flowlet-claude-local-{}.jsonl", Uuid::new_v4()));
        fs::write(
            &path,
            concat!(
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"stop_reason\":\"end_turn\",\"content\":[]}}\n",
                "{\"type\":\"system\",\"subtype\":\"turn_duration\"}\n",
                "{\"type\":\"system\",\"subtype\":\"local_command\",\"content\":\"local command\"}\n",
                "{\"type\":\"user\",\"isMeta\":true,\"message\":{\"role\":\"user\",\"content\":\"local result\"}}\n"
            ),
        )
        .unwrap();

        assert_eq!(infer_claude_runtime_status(&path), "idle");
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn maps_claude_live_wait_reasons_to_user_or_tool_waiting() {
        assert_eq!(
            infer_claude_live_runtime_status(&serde_json::json!({
                "status": "waiting",
                "waitingFor": "permission prompt"
            })),
            Some("waiting_user")
        );
        assert_eq!(
            infer_claude_live_runtime_status(&serde_json::json!({
                "status": "waiting",
                "waitingFor": "user input"
            })),
            Some("waiting_user")
        );
        assert_eq!(
            infer_claude_live_runtime_status(&serde_json::json!({
                "status": "waiting",
                "waitingFor": "tool execution"
            })),
            Some("running")
        );
        assert_eq!(
            infer_claude_live_runtime_status(&serde_json::json!({"status": "idle"})),
            Some("idle")
        );
    }

    #[test]
    fn live_claude_process_status_overrides_unflushed_transcript_state() {
        let root =
            std::env::temp_dir().join(format!("flowlet-claude-live-session-{}", Uuid::new_v4()));
        let projects = root.join("projects");
        let project = projects.join("encoded-project");
        let sessions = root.join("sessions");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&sessions).unwrap();
        fs::write(
            project.join("session-live.jsonl"),
            "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"stop_reason\":\"end_turn\",\"content\":[]}}\n",
        )
        .unwrap();
        fs::write(
            sessions.join("123.json"),
            "{\"pid\":123,\"sessionId\":\"session-live\",\"status\":\"waiting\",\"waitingFor\":\"permission prompt\"}",
        )
        .unwrap();

        let rows = list_claude_native_sessions_from_with_live_status(&projects, Some(&sessions));
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].runtime_status, "waiting_user");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn marks_claude_idle_after_failed_local_command() {
        let path = std::env::temp_dir().join(format!(
            "flowlet-claude-local-failure-{}.jsonl",
            Uuid::new_v4()
        ));
        fs::write(
            &path,
            concat!(
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"/compact\"}}\n",
                "{\"type\":\"system\",\"subtype\":\"local_command\",\"content\":\"Error during compaction\"}\n"
            ),
        )
        .unwrap();

        assert_eq!(infer_claude_runtime_status(&path), "idle");
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn keeps_claude_idle_when_away_summary_follows_unanswered_user_record() {
        let path =
            std::env::temp_dir().join(format!("flowlet-claude-away-{}.jsonl", Uuid::new_v4()));
        fs::write(
            &path,
            concat!(
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"follow up\"}}\n",
                "{\"type\":\"system\",\"subtype\":\"away_summary\"}\n"
            ),
        )
        .unwrap();

        assert_eq!(infer_claude_runtime_status(&path), "idle");
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn expires_stale_claude_running_and_waiting_states() {
        let now = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(200_000);
        assert_eq!(
            apply_claude_runtime_freshness(
                "running",
                Some(now - std::time::Duration::from_secs(CLAUDE_RUNNING_FRESHNESS_SECS + 1)),
                now,
            ),
            "idle"
        );
        assert_eq!(
            apply_claude_runtime_freshness(
                "waiting_user",
                Some(now - std::time::Duration::from_secs(CLAUDE_WAITING_USER_FRESHNESS_SECS + 1,)),
                now,
            ),
            "idle"
        );
        assert_eq!(
            apply_claude_runtime_freshness(
                "running",
                Some(now - std::time::Duration::from_secs(CLAUDE_RUNNING_FRESHNESS_SECS - 1)),
                now,
            ),
            "running"
        );
        assert_eq!(
            apply_claude_runtime_freshness(
                "waiting_user",
                Some(now - std::time::Duration::from_secs(CLAUDE_WAITING_USER_FRESHNESS_SECS - 1,)),
                now,
            ),
            "waiting_user"
        );
    }

    #[test]
    fn infers_opencode_completion_and_pi_tool_execution() {
        assert_eq!(
            infer_opencode_runtime_status(
                &serde_json::json!({
                    "role": "assistant",
                    "time": {"created": 1}
                }),
                false,
                Some(1),
                100_000
            ),
            "idle"
        );
        assert_eq!(
            infer_opencode_runtime_status(
                &serde_json::json!({
                    "role": "assistant",
                    "time": {"created": 1}
                }),
                false,
                Some(90_000),
                100_000
            ),
            "running"
        );
        assert_eq!(
            infer_opencode_runtime_status(
                &serde_json::json!({
                    "role": "assistant",
                    "time": {"created": 1}
                }),
                true,
                Some(1),
                100_000
            ),
            "running"
        );
        assert_eq!(
            infer_opencode_runtime_status(
                &serde_json::json!({
                    "role": "assistant",
                    "time": {"created": 1, "completed": 2}
                }),
                true,
                Some(2),
                100_000
            ),
            "idle"
        );

        let path = std::env::temp_dir().join(format!("flowlet-pi-state-{}.jsonl", Uuid::new_v4()));
        fs::write(
            &path,
            "{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"stopReason\":\"toolUse\"}}\n",
        )
        .unwrap();
        assert_eq!(infer_pi_runtime_status(&path), "running");
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn lists_claude_root_and_subagent_sessions_without_message_content() {
        let root = std::env::temp_dir().join(format!("flowlet-claude-session-{}", Uuid::new_v4()));
        let project = root.join("encoded-project");
        let subagents = project.join("session-1").join("subagents");
        fs::create_dir_all(&subagents).unwrap();
        fs::write(
            project.join("session-1.jsonl"),
            concat!(
                "{\"type\":\"user\",\"cwd\":\"D:\\\\work\\\\flowlet\",\"timestamp\":\"2026-07-18T08:00:00Z\",\"message\":{\"content\":\"secret\"}}\n",
                "{\"type\":\"ai-title\",\"aiTitle\":\"Repair model routing\"}\n",
                "{\"type\":\"custom-title\",\"customTitle\":\"Flowlet routing fix\"}\n"
            ),
        )
        .unwrap();
        fs::write(
            subagents.join("agent-child.jsonl"),
            "{\"type\":\"user\",\"cwd\":\"D:\\\\work\\\\flowlet\",\"timestamp\":\"2026-07-18T08:05:00Z\"}\n",
        )
        .unwrap();

        let rows = list_claude_native_sessions_from(&root);
        assert_eq!(rows.len(), 2);
        let main = rows
            .iter()
            .find(|row| row.session_id == "session-1")
            .unwrap();
        assert_eq!(main.title.as_deref(), Some("Flowlet routing fix"));
        assert_eq!(main.project_path.as_deref(), Some("D:\\work\\flowlet"));
        assert_eq!(main.parent_session_id, None);
        assert!(!main.flowlet_observed);
        let child = rows
            .iter()
            .find(|row| row.session_id == "agent-child")
            .unwrap();
        assert_eq!(child.parent_session_id.as_deref(), Some("session-1"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reads_all_opencode_sessions_in_read_only_mode() {
        let root =
            std::env::temp_dir().join(format!("flowlet-opencode-session-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let database = root.join("opencode.db");
        let connection = Connection::open(&database).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE session (
                    id TEXT PRIMARY KEY, title TEXT, directory TEXT, parent_id TEXT,
                    time_created INTEGER, time_updated INTEGER
                );
                CREATE TABLE message (
                    id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
                    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
                    data TEXT NOT NULL
                );
                CREATE TABLE part (
                    id TEXT PRIMARY KEY, message_id TEXT NOT NULL
                );
                INSERT INTO session VALUES (
                    'ses_main', 'Native title', 'D:\\work\\flowlet', NULL,
                    1752825600000, 1752829200000
                );
                INSERT INTO session VALUES (
                    'ses_child', 'Child title', 'D:\\work\\flowlet', 'ses_main',
                    1752825700000, 1752829300000
                );
                INSERT INTO message VALUES (
                    'msg_main', 'ses_main', 1752829200000, 1752829200000,
                    '{\"role\":\"assistant\",\"time\":{\"created\":1752829200000}}'
                );
                INSERT INTO message VALUES (
                    'msg_child', 'ses_child', 1752829300000, 1752829400000,
                    '{\"role\":\"assistant\",\"time\":{\"created\":1752829300000,\"completed\":1752829400000}}'
                );
                INSERT INTO part VALUES ('part_main', 'msg_main');",
            )
            .unwrap();
        drop(connection);

        let rows = list_opencode_native_sessions_from(&database);
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().all(|row| !row.flowlet_observed));
        assert_eq!(
            rows.iter()
                .find(|row| row.session_id == "ses_child")
                .and_then(|row| row.parent_session_id.as_deref()),
            Some("ses_main")
        );
        assert_eq!(
            rows.iter()
                .find(|row| row.session_id == "ses_main")
                .map(|row| row.runtime_status.as_str()),
            Some("running")
        );
        assert_eq!(
            rows.iter()
                .find(|row| row.session_id == "ses_child")
                .map(|row| row.runtime_status.as_str()),
            Some("idle")
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn lists_active_codex_desktop_and_cli_sessions_as_distinct_surfaces() {
        let root = std::env::temp_dir().join(format!("flowlet-codex-session-{}", Uuid::new_v4()));
        let sessions = root.join("sessions").join("2026").join("07").join("19");
        fs::create_dir_all(&sessions).unwrap();
        fs::write(
            root.join("session_index.jsonl"),
            concat!(
                "{\"id\":\"codex-root\",\"thread_name\":\"Support Codex Desktop\",\"updated_at\":\"2026-07-19T09:00:00Z\"}\n",
                "{\"id\":\"codex-root\",\"thread_name\":\"Support Codex Desktop sessions\",\"updated_at\":\"2026-07-19T10:00:00Z\"}\n"
            ),
        )
        .unwrap();
        fs::write(
            sessions.join("rollout-root.jsonl"),
            "{\"timestamp\":\"2026-07-19T08:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"codex-root\",\"timestamp\":\"2026-07-19T08:00:00Z\",\"originator\":\"Codex Desktop\",\"cwd\":\"D:\\\\work\\\\flowlet\",\"source\":\"vscode\",\"thread_source\":\"user\"}}\n{\"type\":\"event_msg\",\"payload\":{\"message\":\"secret\"}}\n",
        )
        .unwrap();
        fs::write(
            sessions.join("rollout-child.jsonl"),
            "{\"timestamp\":\"2026-07-19T08:05:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"codex-child\",\"timestamp\":\"2026-07-19T08:05:00Z\",\"originator\":\"Codex Desktop\",\"cwd\":\"D:\\\\work\\\\flowlet\",\"source\":{\"subagent\":{\"thread_spawn\":{\"parent_thread_id\":\"codex-root\",\"agent_nickname\":\"Pascal\"}}},\"thread_source\":\"subagent\"}}\n",
        )
        .unwrap();
        fs::write(
            sessions.join("rollout-cli.jsonl"),
            "{\"timestamp\":\"2026-07-19T08:10:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"codex-cli\",\"timestamp\":\"2026-07-19T08:10:00Z\",\"originator\":\"codex_cli_rs\",\"cwd\":\"D:\\\\work\\\\flowlet\"}}\n",
        )
        .unwrap();

        let rows = list_codex_native_sessions_from(&root);
        assert_eq!(rows.len(), 3);
        let main = rows
            .iter()
            .find(|row| row.session_id == "codex-root")
            .unwrap();
        assert_eq!(
            main.title.as_deref(),
            Some("Support Codex Desktop sessions")
        );
        assert_eq!(main.agent_type, "codex-desktop");
        assert_eq!(main.project_path.as_deref(), Some("D:\\work\\flowlet"));
        assert_eq!(
            main.native_started_at.as_deref(),
            Some("2026-07-19T08:00:00Z")
        );
        assert!(
            session_time_millis(main.native_updated_at.as_deref().unwrap())
                >= session_time_millis("2026-07-19T10:00:00Z")
        );
        let child = rows
            .iter()
            .find(|row| row.session_id == "codex-child")
            .unwrap();
        assert_eq!(child.parent_session_id.as_deref(), Some("codex-root"));
        assert_eq!(child.title.as_deref(), Some("Pascal"));
        let cli = rows
            .iter()
            .find(|row| row.session_id == "codex-cli")
            .unwrap();
        assert_eq!(cli.agent_type, "codex-cli");
        assert_eq!(cli.parent_session_id, None);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn lists_codex_exec_cli_sessions_from_rollout_files() {
        // Rust 版 Codex CLI（0.147+）`codex exec` 写入的 session_meta originator 是
        // `codex_exec`（文件名为 rollout-<时间戳>-<会话id>.jsonl，按年/月/日分目录）。
        // 必须能被识别为 codex-cli，否则任务执行后的会话在列表与时间线中都不可见。
        let root = std::env::temp_dir().join(format!("flowlet-codex-exec-{}", Uuid::new_v4()));
        let sessions = root.join("sessions").join("2026").join("08").join("09");
        fs::create_dir_all(&sessions).unwrap();
        fs::write(
            sessions.join("rollout-2026-08-09T17-59-52-019fe5f6-eb7c-72d3-8ebc-f1be1d251993.jsonl"),
            concat!(
                "{\"timestamp\":\"2026-08-09T09:59:52.511Z\",\"type\":\"session_meta\",\"payload\":{\"session_id\":\"019fe5f6-eb7c-72d3-8ebc-f1be1d251993\",\"id\":\"019fe5f6-eb7c-72d3-8ebc-f1be1d251993\",\"timestamp\":\"2026-08-09T09:59:52.511Z\",\"cwd\":\"D:\\\\flowlet\",\"originator\":\"codex_exec\",\"cli_version\":\"0.147.0\",\"source\":\"exec\",\"thread_source\":\"user\"}}\n",
                "{\"timestamp\":\"2026-08-09T10:00:17.240Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"id\":\"msg_1\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"任务正文\"}]}}\n"
            ),
        )
        .unwrap();

        let rows = list_codex_native_sessions_from(&root);
        assert_eq!(rows.len(), 1);
        let exec = &rows[0];
        assert_eq!(exec.agent_type, "codex-cli");
        assert_eq!(exec.session_id, "019fe5f6-eb7c-72d3-8ebc-f1be1d251993");
        assert_eq!(exec.project_path.as_deref(), Some("D:\\flowlet"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn lists_pi_native_sessions_from_session_file() {
        let root = std::env::temp_dir().join(format!("flowlet-pi-session-{}", Uuid::new_v4()));
        let project_dir = root.join("--Users-dev-my-app--");
        fs::create_dir_all(&project_dir).unwrap();
        // 头行 id 即会话 UUID；session_info 提供标题；首条 user 消息作为标题回退。
        fs::write(
            project_dir.join("1701600000000_550e8400-e29b-41d4-a716-446655440000.jsonl"),
            concat!(
                "{\"type\":\"session\",\"version\":3,\"id\":\"550e8400-e29b-41d4-a716-446655440000\",\"timestamp\":\"2024-12-03T14:00:00.000Z\",\"cwd\":\"/Users/dev/my-app\"}\n",
                "{\"type\":\"message\",\"id\":\"a1\",\"parentId\":null,\"timestamp\":\"2024-12-03T14:00:01.000Z\",\"message\":{\"role\":\"user\",\"content\":\"帮我重构鉴权模块\"}}\n",
                "{\"type\":\"session_info\",\"id\":\"s1\",\"parentId\":\"a1\",\"timestamp\":\"2024-12-03T14:00:02.000Z\",\"name\":\"Refactor auth\"}\n",
                "{\"type\":\"message\",\"id\":\"a2\",\"parentId\":\"s1\",\"timestamp\":\"2024-12-03T14:00:05.000Z\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"Working\"}]}}\n"
            ),
        )
        .unwrap();
        // 派生会话：parentSession 指向来源文件，应提取来源 UUID 作为 parent_session_id。
        fs::write(
            project_dir.join("1701600100000_660e8400-e29b-41d4-a716-446655440000.jsonl"),
            concat!(
                "{\"type\":\"session\",\"version\":3,\"id\":\"660e8400-e29b-41d4-a716-446655440000\",\"timestamp\":\"2024-12-03T14:01:00.000Z\",\"cwd\":\"/Users/dev/my-app\",\"parentSession\":\"1701600000000_550e8400-e29b-41d4-a716-446655440000.jsonl\"}\n",
                "{\"type\":\"message\",\"id\":\"b1\",\"parentId\":null,\"timestamp\":\"2024-12-03T14:01:01.000Z\",\"message\":{\"role\":\"user\",\"content\":\"另一个思路\"}}\n"
            ),
        )
        .unwrap();

        let rows = list_pi_native_sessions_from(&root);
        assert_eq!(rows.len(), 2);
        let main = rows
            .iter()
            .find(|row| row.session_id == "550e8400-e29b-41d4-a716-446655440000")
            .unwrap();
        assert_eq!(main.title.as_deref(), Some("Refactor auth"));
        assert_eq!(main.project_path.as_deref(), Some("/Users/dev/my-app"));
        assert_eq!(
            main.native_started_at.as_deref(),
            Some("2024-12-03T14:00:00.000Z")
        );
        assert_eq!(
            main.native_updated_at.as_deref(),
            Some("2024-12-03T14:00:05.000Z")
        );
        assert_eq!(main.parent_session_id, None);
        assert!(!main.flowlet_observed);
        let child = rows
            .iter()
            .find(|row| row.session_id == "660e8400-e29b-41d4-a716-446655440000")
            .unwrap();
        // 无 session_info 名时，回退到首条用户消息文本。
        assert_eq!(child.title.as_deref(), Some("另一个思路"));
        assert_eq!(
            child.parent_session_id.as_deref(),
            Some("550e8400-e29b-41d4-a716-446655440000")
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn merges_flowlet_metrics_into_native_session_identity() {
        let native = native_row(
            "opencode",
            "ses_main".to_string(),
            None,
            "running".to_string(),
            Some("Native title".to_string()),
            Some("D:\\work\\flowlet".to_string()),
            Some("2026-07-18T08:00:00Z".to_string()),
            Some("2026-07-18T09:00:00Z".to_string()),
        );
        let mut observed = native.clone();
        observed.title = None;
        observed.project_path = None;
        observed.native_started_at = None;
        observed.native_updated_at = None;
        observed.activity_at = "2026-07-18 08:30:00".to_string();
        observed.flowlet_observed = true;
        observed.started_at = "2026-07-18 08:10:00".to_string();
        observed.updated_at = "2026-07-18 08:30:00".to_string();
        observed.request_count = 3;
        observed.known_tokens = 120;

        let rows = merge_agent_session_catalog(vec![observed], vec![native]);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].title.as_deref(), Some("Native title"));
        assert_eq!(rows[0].request_count, 3);
        assert_eq!(rows[0].known_tokens, 120);
        assert!(rows[0].flowlet_observed);
        assert_eq!(rows[0].activity_at, "2026-07-18T09:00:00Z");
    }
}
