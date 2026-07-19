use super::config::AgentSessionRow;
use chrono::{DateTime, NaiveDateTime, Utc};
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, Metadata};
use std::io::{BufRead, BufReader};
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

const MAX_CLAUDE_TRANSCRIPT_BYTES: usize = 1024 * 1024;
const EMPTY_SESSION_TIME: &str = "1970-01-01T00:00:00Z";

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct NativeSessionMetadata {
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

pub fn list_native_agent_sessions() -> Vec<AgentSessionRow> {
    let mut rows = list_claude_native_sessions();
    let mut seen = rows
        .iter()
        .map(session_key)
        .collect::<HashSet<(String, String)>>();
    for row in list_opencode_native_sessions() {
        if seen.insert(session_key(&row)) {
            rows.push(row);
        }
    }
    for row in list_codex_native_sessions() {
        if seen.insert(session_key(&row)) {
            rows.push(row);
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
            native.estimated_cost = observed.estimated_cost;
            native.flowlet_observed = true;
        } else {
            merged.insert(key, observed);
        }
    }
    merged.into_values().collect()
}

fn list_claude_native_sessions() -> Vec<AgentSessionRow> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    list_claude_native_sessions_from(&home.join(".claude").join("projects"))
}

fn list_claude_native_sessions_from(projects_root: &Path) -> Vec<AgentSessionRow> {
    if !projects_root.is_dir() {
        return Vec::new();
    }
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
            Some(native_row(
                "claude-code",
                session_id,
                parent_session_id.or(metadata.parent_session_id),
                metadata.title,
                metadata.project_path,
                metadata.native_started_at,
                metadata.native_updated_at,
            ))
        })
        .collect()
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
    Some(metadata)
}

fn string_field(value: &Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

#[derive(Clone, Debug, Default)]
struct CodexSessionIndexEntry {
    title: Option<String>,
    updated_at: Option<String>,
}

fn list_codex_native_sessions() -> Vec<AgentSessionRow> {
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
        "codex_cli_rs" | "Codex CLI" | "codex-cli" => "codex-cli",
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
        title,
        string_field(payload, "cwd"),
        string_field(payload, "timestamp").or_else(|| string_field(&value, "timestamp")),
        native_updated_at,
    ))
}

fn list_opencode_native_sessions() -> Vec<AgentSessionRow> {
    let mut rows = HashMap::new();
    for path in opencode_database_candidates() {
        for row in list_opencode_native_sessions_from(&path) {
            rows.entry(session_key(&row)).or_insert(row);
        }
    }
    rows.into_values().collect()
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
    let Ok(mut statement) = connection
        .prepare("SELECT id, title, directory, parent_id, time_created, time_updated FROM session")
    else {
        return Vec::new();
    };
    let Ok(mapped) = statement.query_map([], |row| {
        let session_id: String = row.get(0)?;
        let title: Option<String> = row.get(1)?;
        let project_path: Option<String> = row.get(2)?;
        let parent_session_id: Option<String> = row.get(3)?;
        let created_at: Option<i64> = row.get(4)?;
        let updated_at: Option<i64> = row.get(5)?;
        Ok(native_row(
            "opencode",
            session_id,
            parent_session_id,
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

fn native_row(
    agent_type: &str,
    session_id: String,
    parent_session_id: Option<String>,
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
        estimated_cost: 0.0,
    }
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

fn format_unix_millis(value: i64) -> Option<String> {
    DateTime::<Utc>::from_timestamp_millis(value).map(|value| value.to_rfc3339())
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

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
                INSERT INTO session VALUES (
                    'ses_main', 'Native title', 'D:\\work\\flowlet', NULL,
                    1752825600000, 1752829200000
                );
                INSERT INTO session VALUES (
                    'ses_child', 'Child title', 'D:\\work\\flowlet', 'ses_main',
                    1752825700000, 1752829300000
                );",
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
        assert_eq!(
            main.native_updated_at.as_deref(),
            Some("2026-07-19T10:00:00Z")
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
    fn merges_flowlet_metrics_into_native_session_identity() {
        let native = native_row(
            "opencode",
            "ses_main".to_string(),
            None,
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
