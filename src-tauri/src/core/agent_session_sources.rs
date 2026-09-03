use chrono::{DateTime, Utc};
use serde_json::Value;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

pub(crate) fn collect_jsonl_files(directory: &Path, matches: &mut Vec<PathBuf>) {
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

pub(crate) fn opencode_database_candidates() -> Vec<PathBuf> {
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

/// Hermes Agent 的会话数据库候选路径（默认 Profile + `HERMES_HOME` 覆盖）。
/// 会话与消息都存在 `state.db`（SQLite，WAL），时间戳为 Unix epoch 浮点秒。
pub(crate) fn hermes_database_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(home) = std::env::var_os("HERMES_HOME").map(PathBuf::from) {
        candidates.push(home.join("state.db"));
    }
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join(".hermes").join("state.db"));
    }
    let mut seen = HashSet::new();
    candidates.retain(|path| seen.insert(path.clone()));
    candidates
}

pub(crate) fn format_unix_millis(value: i64) -> Option<String> {
    DateTime::<Utc>::from_timestamp_millis(value).map(|value| value.to_rfc3339())
}

/// Hermes Agent 的 `sessions.started_at` / `messages.timestamp` 是 Unix epoch 浮点秒，
/// 与 OpenCode/Codex 的毫秒整型不同，需要单独换算为 RFC3339。
pub(crate) fn format_unix_seconds(value: f64) -> Option<String> {
    let millis = (value * 1000.0).round();
    if !millis.is_finite() || millis < 0.0 || millis > i64::MAX as f64 {
        return None;
    }
    DateTime::<Utc>::from_timestamp_millis(millis as i64).map(|value| value.to_rfc3339())
}

pub(crate) fn string_field(value: &Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}
