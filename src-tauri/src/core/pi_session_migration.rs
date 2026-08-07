use serde_json::Value;
use std::fs::File;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};

const MAX_HEADER_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Default, PartialEq, Eq)]
pub struct PiSessionMigrationReport {
    pub migrated: usize,
    pub skipped_existing: usize,
    pub skipped_invalid: usize,
    pub failed: usize,
}

/// 把旧版 Flowlet 用 `--session-dir ~/.flowlet/pi-task-sessions/<project_id>` 创建的
/// Pi 会话迁入 Pi 原生目录。迁移按文件头中的 cwd 计算目标目录，与 Pi 自身规则一致；
/// 目标已存在时绝不覆盖，因此可在每次启动时安全、幂等地执行。
pub fn migrate_legacy_pi_task_sessions() -> PiSessionMigrationReport {
    let Some(home) = dirs::home_dir() else {
        return PiSessionMigrationReport::default();
    };
    migrate_legacy_pi_task_sessions_from(
        &home.join(".flowlet").join("pi-task-sessions"),
        &home.join(".pi").join("agent").join("sessions"),
    )
}

fn migrate_legacy_pi_task_sessions_from(
    legacy_root: &Path,
    native_root: &Path,
) -> PiSessionMigrationReport {
    let mut report = PiSessionMigrationReport::default();
    if !legacy_root.is_dir() {
        return report;
    }

    let mut files = Vec::new();
    collect_jsonl_files(legacy_root, &mut files, &mut report.failed);
    for source in files {
        let Some(cwd) = read_pi_session_cwd(&source) else {
            report.skipped_invalid += 1;
            continue;
        };
        let Some(file_name) = source.file_name() else {
            report.skipped_invalid += 1;
            continue;
        };
        let target_dir = native_root.join(pi_encoded_cwd(&cwd));
        let target = target_dir.join(file_name);
        if target.exists() {
            report.skipped_existing += 1;
            continue;
        }
        if std::fs::create_dir_all(&target_dir).is_err() {
            report.failed += 1;
            continue;
        }
        match std::fs::rename(&source, &target) {
            Ok(()) => report.migrated += 1,
            Err(_) => report.failed += 1,
        }
    }
    report
}

fn collect_jsonl_files(root: &Path, files: &mut Vec<PathBuf>, failures: &mut usize) {
    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(_) => {
            *failures += 1;
            return;
        }
    };
    for entry in entries {
        let Ok(entry) = entry else {
            *failures += 1;
            continue;
        };
        let path = entry.path();
        if path.is_dir() {
            collect_jsonl_files(&path, files, failures);
        } else if path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("jsonl"))
        {
            files.push(path);
        }
    }
}

fn read_pi_session_cwd(path: &Path) -> Option<String> {
    let file = File::open(path).ok()?;
    let mut reader = BufReader::new(file.take(MAX_HEADER_BYTES));
    let mut first_line = String::new();
    reader.read_line(&mut first_line).ok()?;
    let header: Value = serde_json::from_str(first_line.trim()).ok()?;
    if header.get("type").and_then(Value::as_str) != Some("session") {
        return None;
    }
    header
        .get("cwd")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|cwd| !cwd.is_empty())
        .map(str::to_string)
}

/// 与 Pi `getDefaultSessionDirPath` 保持一致：去掉一个开头路径分隔符，
/// 将 `/`、`\`、`:` 替换为 `-`，再用 `--` 包裹。
fn pi_encoded_cwd(cwd: &str) -> String {
    let cwd = cwd
        .strip_prefix('/')
        .or_else(|| cwd.strip_prefix('\\'))
        .unwrap_or(cwd);
    let safe: String = cwd
        .chars()
        .map(|character| match character {
            '/' | '\\' | ':' => '-',
            other => other,
        })
        .collect();
    format!("--{safe}--")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("flowlet-{label}-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn encodes_pi_native_cwd_like_pi() {
        assert_eq!(pi_encoded_cwd(r"E:\flowlet"), "--E--flowlet--");
        assert_eq!(
            pi_encoded_cwd("/home/user/project"),
            "--home-user-project--"
        );
    }

    #[test]
    fn migrates_legacy_sessions_by_header_cwd_without_overwrite() {
        let root = temp_root("pi-session-migration");
        let legacy = root.join("legacy");
        let native = root.join("native");
        let project = legacy.join("project-id");
        std::fs::create_dir_all(&project).unwrap();

        let migrated_name = "2026-08-07T00-00-00-000Z_session-1.jsonl";
        let migrated_source = project.join(migrated_name);
        std::fs::write(
            &migrated_source,
            "{\"type\":\"session\",\"id\":\"session-1\",\"cwd\":\"E:\\\\flowlet\"}\n",
        )
        .unwrap();

        let existing_name = "2026-08-07T00-00-01-000Z_session-2.jsonl";
        let existing_source = project.join(existing_name);
        std::fs::write(
            &existing_source,
            "{\"type\":\"session\",\"id\":\"session-2\",\"cwd\":\"E:\\\\flowlet\"}\n",
        )
        .unwrap();
        let target_dir = native.join("--E--flowlet--");
        std::fs::create_dir_all(&target_dir).unwrap();
        std::fs::write(target_dir.join(existing_name), "existing").unwrap();

        let invalid_source = project.join("invalid.jsonl");
        std::fs::write(&invalid_source, "{\"type\":\"message\"}\n").unwrap();

        let report = migrate_legacy_pi_task_sessions_from(&legacy, &native);
        assert_eq!(report.migrated, 1);
        assert_eq!(report.skipped_existing, 1);
        assert_eq!(report.skipped_invalid, 1);
        assert_eq!(report.failed, 0);
        assert!(!migrated_source.exists());
        assert!(target_dir.join(migrated_name).is_file());
        assert_eq!(
            std::fs::read_to_string(target_dir.join(existing_name)).unwrap(),
            "existing"
        );
        assert!(existing_source.is_file());

        let second = migrate_legacy_pi_task_sessions_from(&legacy, &native);
        assert_eq!(second.migrated, 0);
        assert_eq!(second.skipped_existing, 1);
        assert_eq!(second.skipped_invalid, 1);
        let _ = std::fs::remove_dir_all(root);
    }
}
