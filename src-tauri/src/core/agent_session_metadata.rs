use super::config::AgentSessionRow;
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OpenFlags};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

const MAX_CLAUDE_TRANSCRIPT_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct NativeSessionMetadata {
    title: Option<String>,
    project_path: Option<String>,
    parent_session_id: Option<String>,
    native_started_at: Option<String>,
    native_updated_at: Option<String>,
}

pub fn enrich_agent_sessions(rows: &mut [AgentSessionRow]) {
    let claude_ids = session_ids(rows, "claude-code");
    let opencode_ids = session_ids(rows, "opencode");
    let claude = read_claude_sessions(&claude_ids);
    let opencode = read_opencode_sessions(&opencode_ids);

    for row in rows {
        let metadata = match row.agent_type.as_str() {
            "claude-code" => claude.get(&row.session_id),
            "opencode" => opencode.get(&row.session_id),
            _ => None,
        };
        let Some(metadata) = metadata else { continue };
        row.title = metadata.title.clone();
        row.project_path = metadata.project_path.clone();
        row.native_started_at = metadata.native_started_at.clone();
        row.native_updated_at = metadata.native_updated_at.clone();
        if row.parent_session_id.is_none() {
            row.parent_session_id = metadata.parent_session_id.clone();
        }
    }
}

fn session_ids(rows: &[AgentSessionRow], agent_type: &str) -> HashSet<String> {
    rows.iter()
        .filter(|row| row.agent_type == agent_type)
        .map(|row| row.session_id.clone())
        .collect()
}

fn read_claude_sessions(ids: &HashSet<String>) -> HashMap<String, NativeSessionMetadata> {
    let Some(home) = dirs::home_dir() else {
        return HashMap::new();
    };
    read_claude_sessions_from(&home.join(".claude").join("projects"), ids)
}

fn read_claude_sessions_from(
    projects_root: &Path,
    ids: &HashSet<String>,
) -> HashMap<String, NativeSessionMetadata> {
    if ids.is_empty() || !projects_root.is_dir() {
        return HashMap::new();
    }
    let targets = ids
        .iter()
        .map(|id| (format!("{id}.jsonl"), id.as_str()))
        .collect::<HashMap<_, _>>();
    let mut paths = Vec::new();
    collect_matching_files(projects_root, &targets, &mut paths);
    paths
        .into_iter()
        .filter_map(|(session_id, path)| {
            read_claude_transcript(&path).map(|metadata| (session_id, metadata))
        })
        .collect()
}

fn collect_matching_files(
    directory: &Path,
    targets: &HashMap<String, &str>,
    matches: &mut Vec<(String, PathBuf)>,
) {
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
            collect_matching_files(&path, targets, matches);
        } else if let Some(file_name) = path.file_name().and_then(|value| value.to_str()) {
            if let Some(session_id) = targets.get(file_name) {
                matches.push(((*session_id).to_string(), path));
            }
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
            metadata.project_path = string_field(&value, "cwd")
        }
        if metadata.native_started_at.is_none() {
            metadata.native_started_at = string_field(&value, "timestamp")
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

fn read_opencode_sessions(ids: &HashSet<String>) -> HashMap<String, NativeSessionMetadata> {
    if ids.is_empty() {
        return HashMap::new();
    }
    let mut sessions = HashMap::new();
    for path in opencode_database_candidates() {
        for (id, metadata) in read_opencode_sessions_from(&path, ids) {
            sessions.entry(id).or_insert(metadata);
        }
        if sessions.len() == ids.len() {
            break;
        }
    }
    sessions
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

fn read_opencode_sessions_from(
    database_path: &Path,
    ids: &HashSet<String>,
) -> HashMap<String, NativeSessionMetadata> {
    if !database_path.is_file() {
        return HashMap::new();
    }
    let Ok(connection) = Connection::open_with_flags(
        database_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) else {
        return HashMap::new();
    };
    let _ = connection.busy_timeout(std::time::Duration::from_millis(750));
    let Ok(mut statement) = connection.prepare(
        "SELECT title, directory, parent_id, time_created, time_updated FROM session WHERE id = ?1",
    ) else {
        return HashMap::new();
    };

    ids.iter()
        .filter_map(|id| {
            statement
                .query_row(params![id], |row| {
                    let created_at: Option<i64> = row.get(3)?;
                    let updated_at: Option<i64> = row.get(4)?;
                    Ok(NativeSessionMetadata {
                        title: row.get(0)?,
                        project_path: row.get(1)?,
                        parent_session_id: row.get(2)?,
                        native_started_at: created_at.and_then(format_unix_millis),
                        native_updated_at: updated_at.and_then(format_unix_millis),
                    })
                })
                .ok()
                .map(|metadata| (id.clone(), metadata))
        })
        .collect()
}

fn format_unix_millis(value: i64) -> Option<String> {
    DateTime::<Utc>::from_timestamp_millis(value).map(|value| value.to_rfc3339())
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn reads_claude_title_and_project_without_reading_message_content() {
        let root = std::env::temp_dir().join(format!("flowlet-claude-session-{}", Uuid::new_v4()));
        let project = root.join("encoded-project");
        fs::create_dir_all(&project).unwrap();
        fs::write(
            project.join("session-1.jsonl"),
            concat!(
                "{\"type\":\"user\",\"cwd\":\"D:\\\\work\\\\flowlet\",\"timestamp\":\"2026-07-18T08:00:00Z\",\"message\":{\"content\":\"secret\"}}\n",
                "{\"type\":\"ai-title\",\"aiTitle\":\"Repair model routing\"}\n",
                "{\"type\":\"custom-title\",\"customTitle\":\"Flowlet routing fix\"}\n"
            ),
        ).unwrap();

        let result = read_claude_sessions_from(&root, &HashSet::from(["session-1".to_string()]));
        let metadata = result.get("session-1").unwrap();
        assert_eq!(metadata.title.as_deref(), Some("Flowlet routing fix"));
        assert_eq!(metadata.project_path.as_deref(), Some("D:\\work\\flowlet"));
        assert_eq!(
            metadata.native_started_at.as_deref(),
            Some("2026-07-18T08:00:00Z")
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reads_opencode_session_database_in_read_only_mode() {
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
                'ses_test', 'Native title', 'D:\\work\\flowlet', 'ses_parent',
                1752825600000, 1752829200000
            );",
            )
            .unwrap();
        drop(connection);

        let result =
            read_opencode_sessions_from(&database, &HashSet::from(["ses_test".to_string()]));
        let metadata = result.get("ses_test").unwrap();
        assert_eq!(metadata.title.as_deref(), Some("Native title"));
        assert_eq!(metadata.parent_session_id.as_deref(), Some("ses_parent"));
        assert!(metadata.native_started_at.is_some());
        fs::remove_dir_all(root).unwrap();
    }
}
