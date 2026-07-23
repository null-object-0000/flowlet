use crate::core::config::RequestLogInput;
use chrono::{Datelike, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Cursor, Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
    sync::{Mutex, MutexGuard},
};
use thiserror::Error;

const FRAME_MAGIC: &[u8; 8] = b"FLCAP001";
const FORMAT_VERSION: u16 = 1;
const FRAME_HEADER_BYTES: u64 = 60;
const DEFAULT_SEGMENT_BYTES: u64 = 32 * 1024 * 1024;
const ZSTD_LEVEL: i32 = 3;

#[derive(Debug, Error)]
pub enum RequestCaptureError {
    #[error("文件系统错误: {0}")]
    Io(#[from] std::io::Error),
    #[error("序列化错误: {0}")]
    Json(#[from] serde_json::Error),
    #[error("捕获目录锁定失败")]
    LockFailed,
    #[error("非法捕获文件路径: {0}")]
    InvalidPath(String),
    #[error("捕获帧格式无效: {0}")]
    InvalidFrame(String),
    #[error("捕获帧校验失败")]
    ChecksumMismatch,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RequestCaptureRecord {
    pub format_version: u16,
    pub request_log_id: String,
    pub request_id: String,
    pub attempt_seq: i64,
    pub captured_at: String,
    pub agent_type: Option<String>,
    pub agent_session_id: Option<String>,
    pub parent_agent_session_id: Option<String>,
    pub client_id: Option<String>,
    pub client_name: Option<String>,
    pub channel_id: Option<String>,
    pub channel_name: Option<String>,
    pub account_id: Option<String>,
    pub account_name: Option<String>,
    pub client_protocol: String,
    pub upstream_protocol: String,
    pub virtual_model: Option<String>,
    pub public_model: Option<String>,
    pub upstream_model: Option<String>,
    pub request_type: String,
    pub method: String,
    pub path: String,
    pub upstream_url: Option<String>,
    pub status: Option<i64>,
    pub is_stream: bool,
    pub error_message: Option<String>,
    pub route_reason: Option<String>,
    pub req_headers_json: Option<String>,
    pub req_body_b64: Option<String>,
    pub res_headers_json: Option<String>,
    pub res_body_b64: Option<String>,
    pub incomplete: bool,
}

impl RequestCaptureRecord {
    pub fn from_log(request_log_id: String, log: &RequestLogInput) -> Self {
        Self {
            format_version: FORMAT_VERSION,
            request_log_id,
            request_id: log.request_id.clone(),
            attempt_seq: log.attempt_seq,
            captured_at: Utc::now().to_rfc3339(),
            agent_type: log.agent_type.clone(),
            agent_session_id: log.agent_session_id.clone(),
            parent_agent_session_id: log.parent_agent_session_id.clone(),
            client_id: log.client_id.clone(),
            client_name: log.client_name.clone(),
            channel_id: log.channel_id.clone(),
            channel_name: log.channel_name.clone(),
            account_id: log.account_id.clone(),
            account_name: log.account_name.clone(),
            client_protocol: log.client_protocol.clone(),
            upstream_protocol: log.upstream_protocol.clone(),
            virtual_model: log.virtual_model.clone(),
            public_model: log.public_model.clone(),
            upstream_model: log.upstream_model.clone(),
            request_type: log.request_type.clone(),
            method: log.method.clone(),
            path: log.path.clone(),
            upstream_url: log.upstream_url.clone(),
            status: log.status,
            is_stream: log.is_stream,
            error_message: log.error_message.clone(),
            route_reason: log.route_reason.clone(),
            req_headers_json: log.req_headers_json.clone(),
            req_body_b64: log.req_body_b64.clone(),
            res_headers_json: log.res_headers_json.clone(),
            res_body_b64: log.res_body_b64.clone(),
            incomplete: log.is_stream && log.duration_ms.is_none(),
        }
    }

    pub fn req_body_bytes(&self) -> i64 {
        self.req_body_b64
            .as_ref()
            .map_or(0, |value| value.len() as i64)
    }

    pub fn res_body_bytes(&self) -> i64 {
        self.res_body_b64
            .as_ref()
            .map_or(0, |value| value.len() as i64)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct RequestCapturePointer {
    pub storage_key: String,
    pub offset: u64,
    pub length: u64,
    pub checksum: String,
    pub format_version: u16,
    pub req_body_bytes: i64,
    pub res_body_bytes: i64,
}

#[derive(Debug)]
pub struct RequestCaptureStore {
    root: PathBuf,
    segment_bytes: u64,
    writer_lock: Mutex<()>,
}

impl RequestCaptureStore {
    pub fn for_database(database_path: &Path) -> Self {
        let parent = database_path.parent().unwrap_or_else(|| Path::new("."));
        let root = if cfg!(test) {
            let database_name = database_path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("flowlet-test");
            parent.join(format!(".{database_name}-request-captures"))
        } else {
            parent.join("request-captures")
        };
        Self::new(root, DEFAULT_SEGMENT_BYTES)
    }

    #[cfg(test)]
    pub fn for_test() -> Self {
        Self::new(
            std::env::temp_dir().join(format!("flowlet-request-captures-{}", uuid::Uuid::new_v4())),
            DEFAULT_SEGMENT_BYTES,
        )
    }

    fn new(root: PathBuf, segment_bytes: u64) -> Self {
        Self {
            root,
            segment_bytes,
            writer_lock: Mutex::new(()),
        }
    }

    #[cfg(test)]
    pub fn append(
        &self,
        record: &RequestCaptureRecord,
    ) -> Result<RequestCapturePointer, RequestCaptureError> {
        let guard = self.lock_writer()?;
        self.append_locked(record, &guard)
    }

    pub fn append_locked(
        &self,
        record: &RequestCaptureRecord,
        _writer_guard: &MutexGuard<'_, ()>,
    ) -> Result<RequestCapturePointer, RequestCaptureError> {
        let raw = serde_json::to_vec(record)?;
        let checksum_bytes: [u8; 32] = Sha256::digest(&raw).into();
        let checksum = hex_lower(&checksum_bytes);
        let compressed = zstd::stream::encode_all(Cursor::new(&raw), ZSTD_LEVEL)?;
        let frame_length = FRAME_HEADER_BYTES + compressed.len() as u64;
        let relative_dir = self.relative_directory(record);
        let absolute_dir = self.root.join(&relative_dir);
        fs::create_dir_all(&absolute_dir)?;
        let segment = select_segment(&absolute_dir, self.segment_bytes, frame_length)?;
        let storage_key = relative_dir.join(&segment);
        let path = self.resolve_storage_key(&path_to_storage_key(&storage_key))?;
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .read(true)
            .open(&path)?;
        let offset = file.seek(SeekFrom::End(0))?;
        file.write_all(FRAME_MAGIC)?;
        file.write_all(&FORMAT_VERSION.to_le_bytes())?;
        file.write_all(&0u16.to_le_bytes())?;
        file.write_all(&(compressed.len() as u64).to_le_bytes())?;
        file.write_all(&(raw.len() as u64).to_le_bytes())?;
        file.write_all(&checksum_bytes)?;
        file.write_all(&compressed)?;
        file.flush()?;

        Ok(RequestCapturePointer {
            storage_key: path_to_storage_key(&storage_key),
            offset,
            length: frame_length,
            checksum,
            format_version: FORMAT_VERSION,
            req_body_bytes: record.req_body_bytes(),
            res_body_bytes: record.res_body_bytes(),
        })
    }

    pub fn disk_usage(&self) -> (i64, i64) {
        fn visit(path: &Path, totals: &mut (i64, i64)) {
            let Ok(entries) = fs::read_dir(path) else {
                return;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    visit(&path, totals);
                } else if path.extension().and_then(|value| value.to_str()) == Some("flcap") {
                    totals.0 += 1;
                    totals.1 += entry
                        .metadata()
                        .map(|value| value.len() as i64)
                        .unwrap_or(0);
                }
            }
        }
        let mut totals = (0, 0);
        visit(&self.root, &mut totals);
        totals
    }

    #[cfg(test)]
    pub fn root_path(&self) -> &Path {
        &self.root
    }

    pub fn lock_writer(&self) -> Result<MutexGuard<'_, ()>, RequestCaptureError> {
        self.writer_lock
            .lock()
            .map_err(|_| RequestCaptureError::LockFailed)
    }

    /// Rewrites every live record from one segment into a new side-by-side segment.
    /// The caller must keep `writer_guard` alive while it updates SQLite references and
    /// removes the old segment, preventing concurrent appends from being omitted.
    pub fn rewrite_segment_locked(
        &self,
        storage_key: &str,
        records: &[RequestCaptureRecord],
        _writer_guard: &MutexGuard<'_, ()>,
    ) -> Result<Vec<RequestCapturePointer>, RequestCaptureError> {
        let old_path = self.resolve_storage_key(storage_key)?;
        let relative = Path::new(storage_key);
        let parent = relative
            .parent()
            .ok_or_else(|| RequestCaptureError::InvalidPath(storage_key.to_string()))?;
        let new_name = format!("compacted-{}.flcap", uuid::Uuid::new_v4().simple());
        let new_key_path = parent.join(new_name);
        let new_storage_key = path_to_storage_key(&new_key_path);
        let new_path = self.resolve_storage_key(&new_storage_key)?;
        if let Some(parent) = new_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .read(true)
            .open(&new_path)?;
        let mut pointers = Vec::with_capacity(records.len());
        for record in records {
            let raw = serde_json::to_vec(record)?;
            let checksum_bytes: [u8; 32] = Sha256::digest(&raw).into();
            let compressed = zstd::stream::encode_all(Cursor::new(&raw), ZSTD_LEVEL)?;
            let offset = file.seek(SeekFrom::End(0))?;
            file.write_all(FRAME_MAGIC)?;
            file.write_all(&FORMAT_VERSION.to_le_bytes())?;
            file.write_all(&0u16.to_le_bytes())?;
            file.write_all(&(compressed.len() as u64).to_le_bytes())?;
            file.write_all(&(raw.len() as u64).to_le_bytes())?;
            file.write_all(&checksum_bytes)?;
            file.write_all(&compressed)?;
            pointers.push(RequestCapturePointer {
                storage_key: new_storage_key.clone(),
                offset,
                length: FRAME_HEADER_BYTES + compressed.len() as u64,
                checksum: hex_lower(&checksum_bytes),
                format_version: FORMAT_VERSION,
                req_body_bytes: record.req_body_bytes(),
                res_body_bytes: record.res_body_bytes(),
            });
        }
        file.flush()?;
        file.sync_data()?;
        // Keep the original until SQLite references have committed. The caller removes it
        // with remove_segment_locked; a crash before that point leaves only a harmless orphan.
        if !old_path.is_file() {
            let _ = fs::remove_file(&new_path);
            return Err(RequestCaptureError::InvalidFrame(
                "待整理 segment 不存在".to_string(),
            ));
        }
        Ok(pointers)
    }

    pub fn remove_segment_locked(
        &self,
        storage_key: &str,
        _writer_guard: &MutexGuard<'_, ()>,
    ) -> Result<(), RequestCaptureError> {
        let path = self.resolve_storage_key(storage_key)?;
        match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    pub fn read(
        &self,
        pointer: &RequestCapturePointer,
    ) -> Result<RequestCaptureRecord, RequestCaptureError> {
        let path = self.resolve_storage_key(&pointer.storage_key)?;
        let mut file = File::open(path)?;
        file.seek(SeekFrom::Start(pointer.offset))?;
        let mut header = [0u8; FRAME_HEADER_BYTES as usize];
        file.read_exact(&mut header)?;
        if &header[0..8] != FRAME_MAGIC {
            return Err(RequestCaptureError::InvalidFrame(
                "magic 不匹配".to_string(),
            ));
        }
        let version = u16::from_le_bytes(header[8..10].try_into().unwrap());
        if version != FORMAT_VERSION || version != pointer.format_version {
            return Err(RequestCaptureError::InvalidFrame(format!(
                "不支持的格式版本 {version}"
            )));
        }
        let compressed_length = u64::from_le_bytes(header[12..20].try_into().unwrap());
        let raw_length = u64::from_le_bytes(header[20..28].try_into().unwrap());
        if FRAME_HEADER_BYTES + compressed_length != pointer.length {
            return Err(RequestCaptureError::InvalidFrame(
                "帧长度不匹配".to_string(),
            ));
        }
        let expected_checksum = &header[28..60];
        if hex_lower(expected_checksum) != pointer.checksum {
            return Err(RequestCaptureError::ChecksumMismatch);
        }
        let mut compressed = vec![0u8; compressed_length as usize];
        file.read_exact(&mut compressed)?;
        let raw = zstd::stream::decode_all(Cursor::new(compressed))?;
        if raw.len() as u64 != raw_length || Sha256::digest(&raw).as_slice() != expected_checksum {
            return Err(RequestCaptureError::ChecksumMismatch);
        }
        let record: RequestCaptureRecord = serde_json::from_slice(&raw)?;
        if record.format_version != version {
            return Err(RequestCaptureError::InvalidFrame(
                "记录版本与帧版本不一致".to_string(),
            ));
        }
        Ok(record)
    }

    fn relative_directory(&self, record: &RequestCaptureRecord) -> PathBuf {
        let now = Utc::now();
        if let (Some(agent_type), Some(session_id)) = (
            record
                .agent_type
                .as_deref()
                .filter(|value| !value.is_empty()),
            record
                .agent_session_id
                .as_deref()
                .filter(|value| !value.is_empty()),
        ) {
            let agent_type = safe_path_component(agent_type);
            let session_hash = Sha256::digest(format!("{agent_type}\0{session_id}").as_bytes());
            return PathBuf::from("sessions")
                .join(agent_type)
                .join(format!("{:04}-{:02}", now.year(), now.month()))
                .join(&hex_lower(&session_hash)[..32]);
        }
        let request_hash = Sha256::digest(record.request_id.as_bytes());
        PathBuf::from("unassigned")
            .join(now.format("%Y-%m-%d").to_string())
            .join(&hex_lower(&request_hash)[..2])
    }

    fn resolve_storage_key(&self, storage_key: &str) -> Result<PathBuf, RequestCaptureError> {
        let relative = Path::new(storage_key);
        if relative.as_os_str().is_empty()
            || relative.components().any(|component| {
                matches!(
                    component,
                    Component::ParentDir | Component::RootDir | Component::Prefix(_)
                )
            })
        {
            return Err(RequestCaptureError::InvalidPath(storage_key.to_string()));
        }
        Ok(self.root.join(relative))
    }
}

fn select_segment(
    directory: &Path,
    max_bytes: u64,
    incoming_bytes: u64,
) -> Result<PathBuf, std::io::Error> {
    let mut highest = 0u32;
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("flcap") {
            continue;
        }
        if let Some(number) = path
            .file_stem()
            .and_then(|value| value.to_str())
            .and_then(|value| value.parse::<u32>().ok())
        {
            highest = highest.max(number);
        }
    }
    let current = directory.join(format!("{highest:06}.flcap"));
    if highest == 0 {
        return Ok(PathBuf::from("000001.flcap"));
    }
    let current_bytes = current
        .metadata()
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    if current_bytes > 0 && current_bytes.saturating_add(incoming_bytes) > max_bytes {
        Ok(PathBuf::from(format!("{:06}.flcap", highest + 1)))
    } else {
        Ok(PathBuf::from(format!("{highest:06}.flcap")))
    }
}

fn safe_path_component(value: &str) -> String {
    let filtered = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character
            } else {
                '-'
            }
        })
        .collect::<String>();
    if filtered.is_empty() {
        "unknown".to_string()
    } else {
        filtered
    }
}

fn path_to_storage_key(path: &Path) -> String {
    path.components()
        .filter_map(|component| match component {
            Component::Normal(value) => Some(value.to_string_lossy()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut value = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        value.push(HEX[(byte >> 4) as usize] as char);
        value.push(HEX[(byte & 0x0f) as usize] as char);
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_record(id: &str, session_id: Option<&str>) -> RequestCaptureRecord {
        RequestCaptureRecord {
            format_version: FORMAT_VERSION,
            request_log_id: id.to_string(),
            request_id: format!("request-{id}"),
            attempt_seq: 0,
            captured_at: Utc::now().to_rfc3339(),
            agent_type: session_id.map(|_| "pi".to_string()),
            agent_session_id: session_id.map(str::to_string),
            parent_agent_session_id: None,
            client_id: Some("pi".to_string()),
            client_name: Some("Pi".to_string()),
            channel_id: Some("deepseek".to_string()),
            channel_name: Some("DeepSeek".to_string()),
            account_id: Some("account-1".to_string()),
            account_name: Some("主账号".to_string()),
            client_protocol: "openai".to_string(),
            upstream_protocol: "openai".to_string(),
            virtual_model: Some("flowlet-pro".to_string()),
            public_model: Some("flowlet-pro".to_string()),
            upstream_model: Some("deepseek-v4-pro".to_string()),
            request_type: "chat".to_string(),
            method: "POST".to_string(),
            path: "/v1/chat/completions".to_string(),
            upstream_url: Some("https://example.test/v1/chat/completions".to_string()),
            status: Some(200),
            is_stream: false,
            error_message: None,
            route_reason: Some("direct".to_string()),
            req_headers_json: Some("{\"authorization\":\"[redacted]\"}".to_string()),
            req_body_b64: Some("aGVsbG8=".to_string()),
            res_headers_json: Some("{\"content-type\":\"application/json\"}".to_string()),
            res_body_b64: Some("d29ybGQ=".to_string()),
            incomplete: false,
        }
    }

    #[test]
    fn appends_and_randomly_reads_a_compressed_frame() {
        let root =
            std::env::temp_dir().join(format!("flowlet-capture-test-{}", uuid::Uuid::new_v4()));
        let store = RequestCaptureStore::new(root.clone(), DEFAULT_SEGMENT_BYTES);
        let record = test_record("log-1", Some("session/../../unsafe"));
        let pointer = store.append(&record).unwrap();

        assert!(pointer.storage_key.starts_with("sessions/pi/"));
        assert!(!pointer.storage_key.contains("session/../../unsafe"));
        assert_eq!(store.read(&pointer).unwrap(), record);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rotates_session_segments_at_the_configured_limit() {
        let root =
            std::env::temp_dir().join(format!("flowlet-capture-rotate-{}", uuid::Uuid::new_v4()));
        let store = RequestCaptureStore::new(root.clone(), 1);
        let first = store
            .append(&test_record("log-1", Some("same-session")))
            .unwrap();
        let second = store
            .append(&test_record("log-2", Some("same-session")))
            .unwrap();

        assert!(first.storage_key.ends_with("000001.flcap"));
        assert!(second.storage_key.ends_with("000002.flcap"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_storage_keys_that_escape_the_capture_root() {
        let store = RequestCaptureStore::for_test();
        let pointer = RequestCapturePointer {
            storage_key: "../flowlet.sqlite".to_string(),
            offset: 0,
            length: 0,
            checksum: String::new(),
            format_version: FORMAT_VERSION,
            req_body_bytes: 0,
            res_body_bytes: 0,
        };
        assert!(matches!(
            store.read(&pointer),
            Err(RequestCaptureError::InvalidPath(_))
        ));
    }
}
