//! 全局凭据库：一个 dotenv 文件 + 元数据 sidecar。
//!
//! 设计约束（与 `docs/credential-cli.md` 保持一致）：
//!
//! - **单一事实源是 `.env` 文本**：任何 Agent 都能直接读，也能被 `source`；
//! - 写入只能经由 CLI（原子写 + 0600），避免 Agent 手改出半截文件或错误引用；
//! - 元数据（`kind` / `note` / 时间）放在 sidecar JSON，不污染 `.env`，
//!   这样 `.env` 保持通用的 dotenv 语义，未来接 UI 时也不怕解析歧义；
//! - `kind` 目前不做语义校验（`api_key` / `cli_token` / `mcp_token` 只是标签），
//!   等具体凭据类型落地后再加各自的格式校验。
//!
//! 目录默认 `config_dir()/flowlet/credentials`，可用 `FLOWLET_CRED_DIR` 覆盖
//! （测试与容器内使用）。

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

pub const ENV_FILE_NAME: &str = "credentials.env";
pub const META_FILE_NAME: &str = "credentials.json";
pub const DIR_ENV_OVERRIDE: &str = "FLOWLET_CRED_DIR";

const ENV_HEADER: &str = "\
# Flowlet 全局凭据库
# 由 `flowlet-cred` 维护；请在 CLI 中增删（原子写 + 0600），不要手工重排此文件。
# 读取：Agent 可 cat 本文件；写入：请用 `flowlet-cred set KEY`。";

/// 一条凭据的元数据（值本身只存在于 `.env`）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CredentialMeta {
    #[serde(default = "default_kind")]
    pub kind: String,
    #[serde(default)]
    pub note: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl CredentialMeta {
    fn new(kind: &str, note: Option<&str>, created_at: &str, updated_at: &str) -> Self {
        Self {
            kind: kind.to_string(),
            note: note.map(str::to_string),
            created_at: created_at.to_string(),
            updated_at: updated_at.to_string(),
        }
    }
}

fn default_kind() -> String {
    "api_key".to_string()
}

/// 列表项：给 CLI / UI 展示用，永远不含明文值。
#[derive(Debug, Clone, Serialize)]
pub struct CredentialEntry {
    pub key: String,
    pub kind: String,
    pub note: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// `.env` 的导出格式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportFormat {
    /// `KEY=VALUE`，可直接 `cat` 或写进别的 dotenv。
    Dotenv,
    /// `export KEY='VALUE'`，可 `eval` 进当前 shell。
    Shell,
    /// `{"KEY":"VALUE"}`。
    Json,
}

#[derive(Debug, Clone)]
enum EnvLine {
    Blank,
    Comment(String),
    Pair { key: String, value: String },
}

#[derive(Debug, Clone)]
pub struct CredentialStore {
    dir: PathBuf,
}

impl CredentialStore {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    /// 默认目录；`FLOWLET_CRED_DIR` 优先，便于测试与容器内固定路径。
    pub fn default_dir() -> Result<PathBuf, String> {
        if let Some(value) = std::env::var_os(DIR_ENV_OVERRIDE) {
            let value = PathBuf::from(value);
            if value.as_os_str().is_empty() {
                return Err(format!("{DIR_ENV_OVERRIDE} 不能为空"));
            }
            return Ok(value);
        }
        let base = dirs::config_dir().ok_or_else(|| "无法定位用户配置目录".to_string())?;
        Ok(base.join("flowlet").join("credentials"))
    }

    pub fn from_default_dir() -> Result<Self, String> {
        Ok(Self::new(Self::default_dir()?))
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn env_path(&self) -> PathBuf {
        self.dir.join(ENV_FILE_NAME)
    }

    pub fn meta_path(&self) -> PathBuf {
        self.dir.join(META_FILE_NAME)
    }

    /// 创建目录与空文件（已存在则保留内容）。
    pub fn init(&self) -> Result<(), String> {
        fs::create_dir_all(&self.dir)
            .map_err(|error| format!("创建凭据目录失败（{}）：{error}", self.dir.display()))?;
        restrict_dir(&self.dir)?;
        if !self.env_path().exists() {
            write_atomic(&self.env_path(), &format!("{ENV_HEADER}\n"))?;
        }
        if !self.meta_path().exists() {
            write_atomic(&self.meta_path(), "{}")?;
        }
        Ok(())
    }

    pub fn exists(&self) -> bool {
        self.env_path().exists()
    }

    /// 按文件顺序返回全部键值对（同名键以最后一次出现为准）。
    pub fn pairs(&self) -> Result<Vec<(String, String)>, String> {
        let text = self.read_env_text()?;
        Ok(coalesce_pairs(parse_env(&text)))
    }

    pub fn list(&self) -> Result<Vec<CredentialEntry>, String> {
        let pairs = self.pairs()?;
        let meta = self.read_meta()?;
        Ok(pairs
            .into_iter()
            .map(|(key, _)| {
                let entry = meta.get(&key);
                CredentialEntry {
                    kind: entry
                        .map(|value| value.kind.clone())
                        .unwrap_or_else(default_kind),
                    note: entry.and_then(|value| value.note.clone()),
                    created_at: entry
                        .map(|value| value.created_at.clone())
                        .unwrap_or_default(),
                    updated_at: entry
                        .map(|value| value.updated_at.clone())
                        .unwrap_or_default(),
                    key,
                }
            })
            .collect())
    }

    pub fn keys(&self) -> Result<Vec<String>, String> {
        Ok(self.pairs()?.into_iter().map(|(key, _)| key).collect())
    }

    pub fn get(&self, key: &str) -> Result<Option<String>, String> {
        validate_key(key)?;
        let pairs = self.pairs()?;
        Ok(pairs
            .into_iter()
            .rev()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value))
    }

    /// 新增或更新一条凭据，返回更新后的元数据。
    pub fn set(
        &self,
        key: &str,
        value: &str,
        kind: Option<&str>,
        note: Option<&str>,
    ) -> Result<CredentialEntry, String> {
        validate_key(key)?;
        let kind = kind.map(str::trim).filter(|v| !v.is_empty());
        if let Some(kind) = kind {
            validate_kind(kind)?;
        }
        self.init()?;
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        let mut lines = parse_env(&self.read_env_text()?);
        upsert_pair(&mut lines, key, value);
        self.write_env(&lines)?;

        let mut meta = self.read_meta()?;
        let entry = match meta.get(key) {
            Some(existing) => CredentialMeta::new(
                kind.unwrap_or(&existing.kind),
                note.or(existing.note.as_deref()),
                &existing.created_at,
                &now,
            ),
            None => CredentialMeta::new(kind.unwrap_or("api_key"), note, &now, &now),
        };
        meta.insert(key.to_string(), entry.clone());
        self.write_meta(&meta)?;

        Ok(CredentialEntry {
            key: key.to_string(),
            kind: entry.kind,
            note: entry.note,
            created_at: entry.created_at,
            updated_at: entry.updated_at,
        })
    }

    /// 删除一条凭据；返回是否真的删掉了。
    pub fn unset(&self, key: &str) -> Result<bool, String> {
        validate_key(key)?;
        if !self.exists() {
            return Ok(false);
        }
        let mut lines = parse_env(&self.read_env_text()?);
        let before = lines.len();
        lines.retain(|line| !matches!(line, EnvLine::Pair { key: name, .. } if name == key));
        let removed = lines.len() != before;
        if removed {
            self.write_env(&lines)?;
        }
        let mut meta = self.read_meta()?;
        if meta.remove(key).is_some() {
            self.write_meta(&meta)?;
        }
        Ok(removed)
    }

    /// 导出为指定格式；`only` 为空表示全部。
    pub fn export(&self, only: &[String], format: ExportFormat) -> Result<String, String> {
        let pairs = self.pairs()?;
        let selected: Vec<(String, String)> = if only.is_empty() {
            pairs
        } else {
            let mut result = Vec::with_capacity(only.len());
            for key in only {
                let value = pairs
                    .iter()
                    .rev()
                    .find(|(name, _)| name == key)
                    .map(|(_, value)| value.clone())
                    .ok_or_else(|| format!("凭据不存在：{key}"))?;
                result.push((key.clone(), value));
            }
            result
        };
        let mut out = String::new();
        match format {
            ExportFormat::Dotenv => {
                for (key, value) in &selected {
                    out.push_str(&format!("{key}={}\n", encode_value(value)));
                }
            }
            ExportFormat::Shell => {
                for (key, value) in &selected {
                    out.push_str(&format!("export {key}={};\n", encode_value(value)));
                }
            }
            ExportFormat::Json => {
                let map: BTreeMap<&str, &str> = selected
                    .iter()
                    .map(|(key, value)| (key.as_str(), value.as_str()))
                    .collect();
                out = serde_json::to_string_pretty(&map).map_err(|error| error.to_string())?;
                out.push('\n');
            }
        }
        Ok(out)
    }

    /// 诊断：路径、权限、重复键、元数据缺失。
    pub fn doctor(&self) -> Result<Vec<String>, String> {
        let mut report = Vec::new();
        report.push(format!("目录：{}", self.dir.display()));
        report.push(format!("环境文件：{}", self.env_path().display()));
        if !self.exists() {
            report.push("状态：尚未初始化（运行 `flowlet-cred init`）".to_string());
            return Ok(report);
        }
        report.push(format!("凭据数：{}", self.pairs()?.len()));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Ok(metadata) = fs::metadata(self.env_path()) {
                let mode = metadata.permissions().mode() & 0o777;
                if mode & 0o077 != 0 {
                    report.push(format!(
                        "警告：环境文件权限为 {mode:o}，其他用户可读，建议 600"
                    ));
                }
            }
        }
        let raw = parse_env(&self.read_env_text()?);
        let mut seen = BTreeMap::new();
        for line in &raw {
            if let EnvLine::Pair { key, .. } = line {
                *seen.entry(key.clone()).or_insert(0usize) += 1;
            }
        }
        let duplicates: Vec<String> = seen
            .into_iter()
            .filter(|(_, count)| *count > 1)
            .map(|(key, _)| key)
            .collect();
        if !duplicates.is_empty() {
            report.push(format!(
                "警告：重复的键（后者生效）：{}",
                duplicates.join(", ")
            ));
        }
        let meta = self.read_meta()?;
        let missing: Vec<String> = self
            .pairs()?
            .into_iter()
            .map(|(key, _)| key)
            .filter(|key| !meta.contains_key(key))
            .collect();
        if !missing.is_empty() {
            report.push(format!("提示：缺少元数据的键：{}", missing.join(", ")));
        }
        Ok(report)
    }

    fn read_env_text(&self) -> Result<String, String> {
        match fs::read_to_string(self.env_path()) {
            Ok(text) => Ok(text),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
            Err(error) => Err(format!(
                "读取凭据文件失败（{}）：{error}",
                self.env_path().display()
            )),
        }
    }

    fn write_env(&self, lines: &[EnvLine]) -> Result<(), String> {
        let mut text = String::from(ENV_HEADER);
        text.push('\n');
        for line in lines {
            match line {
                EnvLine::Blank => text.push('\n'),
                EnvLine::Comment(comment) => {
                    text.push_str(comment);
                    text.push('\n');
                }
                EnvLine::Pair { key, value } => {
                    text.push_str(key);
                    text.push('=');
                    text.push_str(&encode_value(value));
                    text.push('\n');
                }
            }
        }
        write_atomic(&self.env_path(), &text)
    }

    fn read_meta(&self) -> Result<BTreeMap<String, CredentialMeta>, String> {
        match fs::read_to_string(self.meta_path()) {
            Ok(text) if text.trim().is_empty() => Ok(BTreeMap::new()),
            Ok(text) => {
                serde_json::from_str(&text).map_err(|error| format!("解析凭据元数据失败：{error}"))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
            Err(error) => Err(format!("读取凭据元数据失败：{error}")),
        }
    }

    fn write_meta(&self, meta: &BTreeMap<String, CredentialMeta>) -> Result<(), String> {
        let text = serde_json::to_string_pretty(meta)
            .map_err(|error| format!("序列化元数据失败：{error}"))?;
        write_atomic(&self.meta_path(), &format!("{text}\n"))
    }
}

// ─── 解析 / 编码 ────────────────────────────────────────────────────────────

fn parse_env(text: &str) -> Vec<EnvLine> {
    let mut lines = Vec::new();
    for raw in text.lines() {
        let line = raw.trim_end_matches('\r');
        let trimmed = line.trim();
        if trimmed.is_empty() {
            lines.push(EnvLine::Blank);
            continue;
        }
        if trimmed.starts_with('#') {
            lines.push(EnvLine::Comment(trimmed.to_string()));
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            // 非 KEY=VALUE 的行原样保留成注释式内容，避免静默丢数据。
            lines.push(EnvLine::Comment(line.to_string()));
            continue;
        };
        let key = key.trim();
        if key.is_empty() || !is_valid_key(key) {
            lines.push(EnvLine::Comment(line.to_string()));
            continue;
        }
        lines.push(EnvLine::Pair {
            key: key.to_string(),
            value: decode_value(value.trim()),
        });
    }
    lines
}

fn coalesce_pairs(lines: Vec<EnvLine>) -> Vec<(String, String)> {
    let mut order: Vec<String> = Vec::new();
    let mut values: BTreeMap<String, String> = BTreeMap::new();
    for line in lines {
        if let EnvLine::Pair { key, value } = line {
            if !values.contains_key(&key) {
                order.push(key.clone());
            }
            values.insert(key, value);
        }
    }
    order
        .into_iter()
        .filter_map(|key| values.remove(&key).map(|value| (key, value)))
        .collect()
}

fn upsert_pair(lines: &mut Vec<EnvLine>, key: &str, value: &str) {
    let mut found = false;
    for line in lines.iter_mut() {
        if let EnvLine::Pair {
            key: name,
            value: existing,
        } = line
        {
            if name == key {
                *existing = value.to_string();
                found = true;
            }
        }
    }
    if !found {
        lines.push(EnvLine::Pair {
            key: key.to_string(),
            value: value.to_string(),
        });
    }
}

/// dotenv 编码：安全字符直接裸写，其余用单引号并转义内部的单引号。
fn encode_value(value: &str) -> String {
    if value.is_empty() {
        return "''".to_string();
    }
    let safe = value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || "-_./:@%+=,~".contains(ch));
    if safe {
        return value.to_string();
    }
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn decode_value(raw: &str) -> String {
    let raw = raw.trim();
    if raw.len() >= 2 && raw.starts_with('\'') && raw.ends_with('\'') {
        return raw[1..raw.len() - 1].replace("'\\''", "'");
    }
    if raw.len() >= 2 && raw.starts_with('"') && raw.ends_with('"') {
        let inner = &raw[1..raw.len() - 1];
        return inner.replace("\\\"", "\"").replace("\\\\", "\\");
    }
    raw.to_string()
}

pub fn is_valid_key(key: &str) -> bool {
    let mut chars = key.chars();
    match chars.next() {
        Some(first) if first.is_ascii_alphabetic() || first == '_' => {}
        _ => return false,
    }
    chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

fn validate_key(key: &str) -> Result<(), String> {
    if is_valid_key(key) {
        Ok(())
    } else {
        Err(format!(
            "非法的凭据名 `{key}`：只能使用字母、数字和下划线，且不能以数字开头"
        ))
    }
}

fn validate_kind(kind: &str) -> Result<(), String> {
    let valid = !kind.is_empty()
        && kind.len() <= 32
        && kind
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_' || ch == '-');
    if valid {
        Ok(())
    } else {
        Err(format!(
            "非法的凭据类型 `{kind}`：使用小写字母、数字、下划线或连字符（如 api_key / cli_token / mcp_token）"
        ))
    }
}

// ─── 文件系统 ───────────────────────────────────────────────────────────────

fn write_atomic(path: &Path, content: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("路径没有父目录：{}", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("创建目录失败（{}）：{error}", parent.display()))?;
    let temp = parent.join(format!(
        ".{}.tmp-{}",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("credentials"),
        std::process::id()
    ));
    {
        let mut file = fs::File::create(&temp)
            .map_err(|error| format!("创建临时文件失败（{}）：{error}", temp.display()))?;
        restrict_file(&temp)?;
        file.write_all(content.as_bytes())
            .map_err(|error| format!("写入临时文件失败：{error}"))?;
        file.sync_all()
            .map_err(|error| format!("同步临时文件失败：{error}"))?;
    }
    fs::rename(&temp, path).map_err(|error| {
        let _ = fs::remove_file(&temp);
        format!("替换文件失败（{}）：{error}", path.display())
    })
}

#[cfg(unix)]
fn restrict_file(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("设置文件权限失败：{error}"))
}

#[cfg(not(unix))]
fn restrict_file(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(unix)]
fn restrict_dir(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("设置目录权限失败：{error}"))
}

#[cfg(not(unix))]
fn restrict_dir(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    fn temp_store() -> CredentialStore {
        let dir = std::env::temp_dir().join(format!(
            "flowlet-cred-test-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_dir_all(&dir);
        CredentialStore::new(dir)
    }

    #[test]
    fn set_get_list_unset_roundtrip() {
        let store = temp_store();
        store.init().unwrap();
        store
            .set("GITHUB_PAT", "ghp_abc", Some("mcp_token"), Some("github"))
            .unwrap();
        store
            .set("OPENAI_API_KEY", "sk-test-123", None, None)
            .unwrap();

        assert_eq!(store.get("GITHUB_PAT").unwrap().as_deref(), Some("ghp_abc"));
        let entries = store.list().unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].key, "GITHUB_PAT");
        assert_eq!(entries[0].kind, "mcp_token");
        assert_eq!(entries[0].note.as_deref(), Some("github"));
        assert_eq!(entries[1].kind, "api_key");

        assert!(store.unset("GITHUB_PAT").unwrap());
        assert!(store.get("GITHUB_PAT").unwrap().is_none());
        assert!(!store.unset("GITHUB_PAT").unwrap());
        let _ = fs::remove_dir_all(store.dir());
    }

    #[test]
    fn update_preserves_created_at_and_order() {
        let store = temp_store();
        store.set("A_KEY", "one", None, None).unwrap();
        store.set("B_KEY", "two", None, None).unwrap();
        let created = store.list().unwrap()[0].created_at.clone();
        store
            .set("A_KEY", "three", Some("cli_token"), None)
            .unwrap();
        assert_eq!(store.list().unwrap()[0].created_at, created);
        assert_eq!(store.keys().unwrap(), vec!["A_KEY", "B_KEY"]);
        assert_eq!(store.get("A_KEY").unwrap().as_deref(), Some("three"));
        let _ = fs::remove_dir_all(store.dir());
    }

    #[test]
    fn quotes_values_with_spaces_and_special_chars() {
        let store = temp_store();
        store
            .set("TRICKY", "a b $HOME `x` it's", None, None)
            .unwrap();
        assert_eq!(
            store.get("TRICKY").unwrap().as_deref(),
            Some("a b $HOME `x` it's")
        );
        let text = fs::read_to_string(store.env_path()).unwrap();
        assert!(text.contains("TRICKY='a b $HOME `x` it'\\''s'"));
        let _ = fs::remove_dir_all(store.dir());
    }

    #[test]
    fn comments_and_blank_lines_are_preserved() {
        let store = temp_store();
        store.init().unwrap();
        let mut text = fs::read_to_string(store.env_path()).unwrap();
        text.push_str("# 手写注释\n\nKEY_ONE=value\n");
        fs::write(store.env_path(), text).unwrap();
        store.set("KEY_TWO", "v2", None, None).unwrap();
        let text = fs::read_to_string(store.env_path()).unwrap();
        assert!(text.contains("# 手写注释"));
        assert!(text.contains("KEY_ONE=value"));
        assert!(text.contains("KEY_TWO=v2"));
        let _ = fs::remove_dir_all(store.dir());
    }

    #[test]
    fn rejects_invalid_key_and_kind() {
        let store = temp_store();
        assert!(store.set("1BAD", "x", None, None).is_err());
        assert!(store.set("HAS-DASH", "x", None, None).is_err());
        assert!(store.set("OK_KEY", "x", Some("Bad Kind"), None).is_err());
        let _ = fs::remove_dir_all(store.dir());
    }

    #[test]
    fn export_formats() {
        let store = temp_store();
        store.set("A_KEY", "one", None, None).unwrap();
        store.set("B_KEY", "two words", None, None).unwrap();
        let dotenv = store.export(&[], ExportFormat::Dotenv).unwrap();
        assert!(dotenv.contains("A_KEY=one"));
        assert!(dotenv.contains("B_KEY='two words'"));
        let shell = store
            .export(&["B_KEY".to_string()], ExportFormat::Shell)
            .unwrap();
        assert_eq!(shell, "export B_KEY='two words';\n");
        let json = store.export(&[], ExportFormat::Json).unwrap();
        assert!(json.contains("\"A_KEY\": \"one\""));
        assert!(store
            .export(&["MISSING".to_string()], ExportFormat::Dotenv)
            .is_err());
        let _ = fs::remove_dir_all(store.dir());
    }

    #[test]
    fn duplicate_keys_last_wins() {
        let store = temp_store();
        store.init().unwrap();
        fs::write(store.env_path(), "DUP=one\nDUP=two\n").unwrap();
        assert_eq!(store.get("DUP").unwrap().as_deref(), Some("two"));
        let _ = fs::remove_dir_all(store.dir());
    }

    #[cfg(unix)]
    #[test]
    fn files_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let store = temp_store();
        store.set("A_KEY", "one", None, None).unwrap();
        let env_mode = fs::metadata(store.env_path()).unwrap().permissions().mode() & 0o777;
        let meta_mode = fs::metadata(store.meta_path())
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(env_mode, 0o600);
        assert_eq!(meta_mode, 0o600);
        let _ = fs::remove_dir_all(store.dir());
    }

    #[test]
    fn doctor_reports_duplicates() {
        let store = temp_store();
        store.init().unwrap();
        fs::write(store.env_path(), "DUP=one\nDUP=two\n").unwrap();
        let report = store.doctor().unwrap().join("\n");
        assert!(report.contains("重复的键"));
        let _ = fs::remove_dir_all(store.dir());
    }
}
