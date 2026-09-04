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

/// Hermes Agent 的会话数据库候选路径：默认 Profile + `HERMES_HOME` 覆盖，
/// 以及 `~/.hermes/profiles/<name>/state.db` 下每个命名 Profile 的独立库。
///
/// 飞书/gateway、cron、delegation（子 Agent）会话都持久化在各自的 `state.db`
/// （SQLite，WAL），命名 Profile 会另起一份独立库，必须一并扫描，否则这些入口的
/// 会话在 Flowlet 会话管理里不可见。时间戳为 Unix epoch 浮点秒。
pub(crate) fn hermes_database_candidates() -> Vec<PathBuf> {
    let mut homes = Vec::new();
    if let Some(home) = std::env::var_os("HERMES_HOME").map(PathBuf::from) {
        homes.push(home);
    }
    if let Some(home) = dirs::home_dir() {
        homes.push(home.join(".hermes"));
    }
    hermes_database_candidates_from(&homes)
}

fn hermes_database_candidates_from(homes: &[PathBuf]) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    for home in homes {
        candidates.push(home.join("state.db"));
        // 命名 Profile：每个子目录是一份独立 HERMES_HOME，拥有自己的 state.db。
        if let Ok(entries) = fs::read_dir(home.join("profiles")) {
            for entry in entries.flatten() {
                if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                    candidates.push(entry.path().join("state.db"));
                }
            }
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hermes_candidates_include_named_profile_databases() {
        let root = std::env::temp_dir().join(format!("flowlet-hermes-db-{}", uuid::Uuid::new_v4()));
        let profiles = root.join("profiles");
        std::fs::create_dir_all(profiles.join("myvault")).unwrap();
        std::fs::create_dir_all(profiles.join("workvault")).unwrap();
        std::fs::write(root.join("state.db"), b"").unwrap();
        std::fs::write(profiles.join("myvault").join("state.db"), b"").unwrap();
        std::fs::write(profiles.join("workvault").join("state.db"), b"").unwrap();
        // 非目录条目（如文件）不应被当作 profile。
        std::fs::write(profiles.join("README.txt"), b"").unwrap();

        let candidates = hermes_database_candidates_from(&[root.clone()]);
        assert!(candidates.contains(&root.join("state.db")));
        assert!(candidates.contains(&profiles.join("myvault").join("state.db")));
        assert!(candidates.contains(&profiles.join("workvault").join("state.db")));
        // 文件不被当成 profile 目录；不产生对 README.txt 的错误候选。
        assert!(!candidates.contains(&profiles.join("README.txt").join("state.db")));
        // 去重：同一 home 不重复。
        let unique: std::collections::HashSet<_> = candidates.iter().collect();
        assert_eq!(unique.len(), candidates.len());

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn hermes_candidates_dedup_across_homes() {
        let root = std::env::temp_dir().join(format!("flowlet-hermes-dedup-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("profiles").join("p")).unwrap();
        std::fs::write(root.join("state.db"), b"").unwrap();

        let candidates = hermes_database_candidates_from(&[root.clone(), root.clone()]);
        assert_eq!(candidates.len(), 2); // state.db + profiles/p/state.db，各一次

        std::fs::remove_dir_all(root).unwrap();
    }
}
