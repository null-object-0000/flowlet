use chrono::{Local, Timelike, Utc};
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use thiserror::Error;

const DEVICE_IDENTITY_FILE: &str = "flowlet-device.json";
const DEVICE_IDENTITY_SCHEMA_VERSION: u32 = 1;
pub const DEVICE_USAGE_SNAPSHOT_SCHEMA_VERSION: u32 = 2;

#[derive(Debug, Error)]
pub enum DeviceIdentityError {
    #[error("读写设备身份文件失败: {0}")]
    Io(#[from] std::io::Error),
    #[error("设备身份文件格式无效: {0}")]
    Json(#[from] serde_json::Error),
    #[error("不支持的设备身份版本: {0}")]
    UnsupportedVersion(u32),
    #[error("设备 ID 无效: {0}")]
    InvalidDeviceId(String),
    #[error("设备名称无效: {0}")]
    InvalidDisplayName(String),
}

/// 安装实例身份。它保存在 SQLite 之外，因此配置导入和数据库替换不会复制
/// 其它设备的身份。普通 Flowlet Bundle 也不得包含这个文件。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceIdentity {
    pub schema_version: u32,
    pub device_id: String,
    pub created_at: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub platform: String,
}

impl DeviceIdentity {
    pub fn load_or_create(data_dir: &Path) -> Result<Self, DeviceIdentityError> {
        fs::create_dir_all(data_dir)?;
        let path = data_dir.join(DEVICE_IDENTITY_FILE);
        if path.exists() {
            return Self::read_and_validate(&path);
        }

        let device_id = uuid::Uuid::new_v4().to_string();
        let platform = current_platform().to_string();
        let identity = Self {
            schema_version: DEVICE_IDENTITY_SCHEMA_VERSION,
            display_name: default_display_name(&platform, &device_id),
            device_id,
            created_at: Utc::now().to_rfc3339(),
            platform,
        };
        identity.persist_new(&path)
    }

    fn read_and_validate(path: &Path) -> Result<Self, DeviceIdentityError> {
        let mut identity: Self = serde_json::from_slice(&fs::read(path)?)?;
        if identity.schema_version != DEVICE_IDENTITY_SCHEMA_VERSION {
            return Err(DeviceIdentityError::UnsupportedVersion(
                identity.schema_version,
            ));
        }
        uuid::Uuid::parse_str(&identity.device_id)
            .map_err(|_| DeviceIdentityError::InvalidDeviceId(identity.device_id.clone()))?;
        if identity.platform.trim().is_empty() {
            identity.platform = current_platform().to_string();
        }
        if identity.display_name.trim().is_empty() {
            identity.display_name = default_display_name(&identity.platform, &identity.device_id);
        }
        validate_display_name(&identity.display_name)?;
        Ok(identity)
    }

    fn persist_new(&self, path: &Path) -> Result<Self, DeviceIdentityError> {
        let parent = path.parent().unwrap_or_else(|| Path::new("."));
        let temp_path = parent.join(format!(
            ".flowlet-device-{}.tmp",
            uuid::Uuid::new_v4().simple()
        ));
        let bytes = serde_json::to_vec_pretty(self)?;

        let write_result = (|| -> Result<(), std::io::Error> {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temp_path)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            fs::rename(&temp_path, path)?;
            Ok(())
        })();

        if let Err(error) = write_result {
            let _ = fs::remove_file(&temp_path);
            // 两个进程同时首次启动时，采用先成功落盘的身份。
            if path.exists() {
                return Self::read_and_validate(path);
            }
            return Err(DeviceIdentityError::Io(error));
        }
        Ok(self.clone())
    }

    pub fn update_display_name(
        &mut self,
        data_dir: &Path,
        display_name: &str,
    ) -> Result<(), DeviceIdentityError> {
        let display_name = display_name.trim();
        validate_display_name(display_name)?;

        let path = data_dir.join(DEVICE_IDENTITY_FILE);
        let temporary = data_dir.join(format!(
            ".flowlet-device-{}.tmp",
            uuid::Uuid::new_v4().simple()
        ));
        let backup = data_dir.join(format!(
            ".flowlet-device-{}.backup",
            uuid::Uuid::new_v4().simple()
        ));
        let mut updated = self.clone();
        updated.display_name = display_name.to_string();
        let bytes = serde_json::to_vec_pretty(&updated)?;

        let write_result = (|| -> Result<(), std::io::Error> {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)?;
            file.write_all(&bytes)?;
            file.sync_all()
        })();
        if let Err(error) = write_result {
            let _ = fs::remove_file(&temporary);
            return Err(DeviceIdentityError::Io(error));
        }

        if path.exists() {
            if let Err(error) = fs::rename(&path, &backup) {
                let _ = fs::remove_file(&temporary);
                return Err(DeviceIdentityError::Io(error));
            }
        }
        match fs::rename(&temporary, &path) {
            Ok(()) => {
                let _ = fs::remove_file(&backup);
                *self = updated;
                Ok(())
            }
            Err(error) => {
                let _ = fs::remove_file(&temporary);
                if backup.exists() {
                    let _ = fs::rename(&backup, &path);
                }
                Err(DeviceIdentityError::Io(error))
            }
        }
    }

    #[cfg(test)]
    fn file_path(data_dir: &Path) -> std::path::PathBuf {
        data_dir.join(DEVICE_IDENTITY_FILE)
    }
}

/// 单台设备按其本地自然日计算的最小用量汇总。不包含费用、账号、Header 或 Body。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DailyUsageTotal {
    pub date: String,
    pub request_count: i64,
    pub known_tokens: i64,
    pub input_tokens: i64,
    pub input_cached_tokens: i64,
    pub input_uncached_tokens: i64,
    pub cache_measured_input_tokens: i64,
    pub output_tokens: i64,
    pub unknown_count: i64,
}

/// 单台设备按其本地自然小时计算的最小 Token 汇总。只同步最近 180 天，
/// 供移动端周视图展示真实的 7×24 小时热力图。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HourlyUsageTotal {
    pub hour: String,
    pub request_count: i64,
    pub known_tokens: i64,
}

/// 设备同步中携带的最小会话摘要。只包含列表展示与后续远程寻址所需字段，
/// 不同步消息正文、提示词、工具调用或本地项目路径。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncedAgentSession {
    pub agent_type: String,
    pub session_id: String,
    pub runtime_status: String,
    pub title: Option<String>,
    pub client_name: Option<String>,
    pub activity_at: String,
    pub flowlet_observed: bool,
    pub request_count: i64,
    pub error_count: i64,
    pub known_tokens: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SharedAgentSession {
    pub device_id: String,
    pub device_display_name: String,
    pub device_platform: String,
    #[serde(flatten)]
    pub session: SyncedAgentSession,
}

/// 供本地导出和未来同步传输共同使用的最小快照契约。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceUsageSnapshot {
    pub schema_version: u32,
    pub device_id: String,
    pub device_created_at: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub platform: String,
    #[serde(default)]
    pub app_version: String,
    pub generated_at: String,
    pub timezone_offset_minutes: i32,
    pub days: Vec<DailyUsageTotal>,
    #[serde(default)]
    pub hours: Vec<HourlyUsageTotal>,
    #[serde(default)]
    pub sessions: Vec<SyncedAgentSession>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceUsageBundle {
    pub format: String,
    pub version: u32,
    pub snapshot: DeviceUsageSnapshot,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceUsageImportPreview {
    pub device_id: String,
    pub device_created_at: String,
    pub display_name: String,
    pub platform: String,
    pub app_version: String,
    pub generated_at: String,
    pub timezone_offset_minutes: i32,
    pub first_date: Option<String>,
    pub last_date: Option<String>,
    pub day_count: usize,
    pub new_days: usize,
    pub updated_days: usize,
    pub unchanged_days: usize,
    pub same_as_current_device: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceUsageImportResult {
    pub device_id: String,
    pub imported_days: usize,
    pub unchanged_days: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownDevice {
    pub device_id: String,
    pub device_created_at: String,
    pub display_name: String,
    pub platform: String,
    pub app_version: String,
    pub is_current: bool,
    pub timezone_offset_minutes: i32,
    pub first_usage_date: Option<String>,
    pub last_usage_date: Option<String>,
    pub day_count: i64,
    pub request_count: i64,
    pub known_tokens: i64,
    pub last_seen_at: String,
}

impl DeviceUsageSnapshot {
    pub fn new(
        identity: &DeviceIdentity,
        days: Vec<DailyUsageTotal>,
        hours: Vec<HourlyUsageTotal>,
        sessions: Vec<SyncedAgentSession>,
    ) -> Self {
        Self {
            schema_version: DEVICE_USAGE_SNAPSHOT_SCHEMA_VERSION,
            device_id: identity.device_id.clone(),
            device_created_at: identity.created_at.clone(),
            display_name: identity.display_name.clone(),
            platform: identity.platform.clone(),
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            generated_at: Utc::now().to_rfc3339(),
            timezone_offset_minutes: Local::now().offset().local_minus_utc() / 60,
            days,
            hours,
            sessions,
        }
    }
}

impl DeviceUsageBundle {
    pub fn new(snapshot: DeviceUsageSnapshot) -> Self {
        Self {
            format: "flowlet-device-usage".to_string(),
            version: 1,
            snapshot,
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.format != "flowlet-device-usage" || self.version != 1 {
            return Err("不支持的 Flowlet 设备用量文件".to_string());
        }
        uuid::Uuid::parse_str(&self.snapshot.device_id)
            .map_err(|_| "设备用量文件中的 deviceId 无效".to_string())?;
        chrono::DateTime::parse_from_rfc3339(&self.snapshot.device_created_at)
            .map_err(|_| "设备用量文件的 deviceCreatedAt 无效".to_string())?;
        if !self.snapshot.display_name.is_empty() {
            validate_display_name(&self.snapshot.display_name)
                .map_err(|error| error.to_string())?;
        }
        if self.snapshot.platform.chars().count() > 32
            || self.snapshot.platform.chars().any(char::is_control)
        {
            return Err("设备用量文件的 platform 无效".to_string());
        }
        if self.snapshot.app_version.chars().count() > 64
            || self.snapshot.app_version.chars().any(char::is_control)
        {
            return Err("设备用量文件的 appVersion 无效".to_string());
        }
        if self.snapshot.schema_version == 0
            || self.snapshot.schema_version > DEVICE_USAGE_SNAPSHOT_SCHEMA_VERSION
        {
            return Err(format!(
                "不支持的设备用量快照版本：{}",
                self.snapshot.schema_version
            ));
        }
        chrono::DateTime::parse_from_rfc3339(&self.snapshot.generated_at)
            .map_err(|_| "设备用量文件的 generatedAt 无效".to_string())?;
        if !(-24 * 60..=24 * 60).contains(&self.snapshot.timezone_offset_minutes) {
            return Err("设备用量文件的 timezoneOffsetMinutes 无效".to_string());
        }
        let mut previous_date: Option<&str> = None;
        for day in &self.snapshot.days {
            chrono::NaiveDate::parse_from_str(&day.date, "%Y-%m-%d")
                .map_err(|_| format!("设备用量日期无效：{}", day.date))?;
            if previous_date.is_some_and(|previous| previous >= day.date.as_str()) {
                return Err("设备用量日期必须严格递增且不能重复".to_string());
            }
            previous_date = Some(day.date.as_str());
            if [
                day.request_count,
                day.known_tokens,
                day.input_tokens,
                day.input_cached_tokens,
                day.input_uncached_tokens,
                day.cache_measured_input_tokens,
                day.output_tokens,
                day.unknown_count,
            ]
            .iter()
            .any(|value| *value < 0)
            {
                return Err(format!("设备用量包含负数：{}", day.date));
            }
        }
        let mut previous_hour: Option<&str> = None;
        for hour in &self.snapshot.hours {
            let parsed_hour =
                chrono::NaiveDateTime::parse_from_str(&hour.hour, "%Y-%m-%dT%H:%M:%S")
                    .map_err(|_| format!("设备小时用量时间无效：{}", hour.hour))?;
            if parsed_hour.minute() != 0
                || parsed_hour.second() != 0
                || parsed_hour.nanosecond() != 0
            {
                return Err(format!("设备小时用量时间无效：{}", hour.hour));
            }
            if previous_hour.is_some_and(|previous| previous >= hour.hour.as_str()) {
                return Err("设备小时用量必须严格递增且不能重复".to_string());
            }
            previous_hour = Some(hour.hour.as_str());
            if hour.request_count < 0 || hour.known_tokens < 0 {
                return Err(format!("设备小时用量不能为负数：{}", hour.hour));
            }
        }
        let mut session_keys = std::collections::HashSet::new();
        for session in &self.snapshot.sessions {
            if session.agent_type.trim().is_empty()
                || session.agent_type.chars().count() > 64
                || session.session_id.trim().is_empty()
                || session.session_id.chars().count() > 256
            {
                return Err("设备会话摘要包含无效的会话标识".to_string());
            }
            if !session_keys.insert((&session.agent_type, &session.session_id)) {
                return Err("设备会话摘要包含重复会话".to_string());
            }
            if !matches!(
                session.runtime_status.as_str(),
                "idle" | "running" | "waiting_user" | "unknown"
            ) {
                return Err("设备会话摘要包含无效运行状态".to_string());
            }
            let valid_activity_at = chrono::DateTime::parse_from_rfc3339(&session.activity_at)
                .is_ok()
                || chrono::NaiveDateTime::parse_from_str(&session.activity_at, "%Y-%m-%d %H:%M:%S")
                    .is_ok();
            if !valid_activity_at {
                return Err("设备会话摘要的 activityAt 无效".to_string());
            }
            if session.request_count < 0 || session.error_count < 0 || session.known_tokens < 0 {
                return Err("设备会话摘要包含负数统计".to_string());
            }
            if session.title.as_ref().is_some_and(|value| {
                value.chars().count() > 512 || value.chars().any(char::is_control)
            }) || session.client_name.as_ref().is_some_and(|value| {
                value.chars().count() > 128 || value.chars().any(char::is_control)
            }) {
                return Err("设备会话摘要包含无效文本".to_string());
            }
        }
        Ok(())
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self, String> {
        let bundle: Self = serde_json::from_slice(bytes)
            .map_err(|error| format!("解析设备用量文件失败：{error}"))?;
        bundle.validate()?;
        Ok(bundle)
    }
}

impl DeviceUsageSnapshot {
    pub fn resolved_display_name(&self) -> String {
        resolve_device_display_name(
            &self.display_name,
            &self.resolved_platform(),
            &self.device_id,
        )
    }

    pub fn resolved_platform(&self) -> String {
        if self.platform.trim().is_empty() {
            "unknown".to_string()
        } else {
            self.platform.trim().to_string()
        }
    }

    pub fn resolved_app_version(&self) -> String {
        if self.app_version.trim().is_empty() {
            "unknown".to_string()
        } else {
            self.app_version.trim().to_string()
        }
    }
}

pub fn resolve_device_display_name(display_name: &str, platform: &str, device_id: &str) -> String {
    if display_name.trim().is_empty() {
        default_display_name(platform, device_id)
    } else {
        display_name.trim().to_string()
    }
}

fn current_platform() -> &'static str {
    match std::env::consts::OS {
        "windows" => "windows",
        "macos" => "macos",
        "linux" => "linux",
        _ => "unknown",
    }
}

fn default_display_name(platform: &str, device_id: &str) -> String {
    let platform_label = match platform {
        "windows" => "Windows",
        "macos" => "macOS",
        "linux" => "Linux",
        _ => "Flowlet",
    };
    let suffix = device_id
        .chars()
        .filter(|character| *character != '-')
        .take(4)
        .collect::<String>()
        .to_uppercase();
    format!("{platform_label} · {suffix}")
}

fn validate_display_name(display_name: &str) -> Result<(), DeviceIdentityError> {
    let count = display_name.chars().count();
    if count == 0 {
        return Err(DeviceIdentityError::InvalidDisplayName(
            "名称不能为空".to_string(),
        ));
    }
    if count > 64 {
        return Err(DeviceIdentityError::InvalidDisplayName(
            "名称不能超过 64 个字符".to_string(),
        ));
    }
    if display_name.chars().any(char::is_control) {
        return Err(DeviceIdentityError::InvalidDisplayName(
            "名称不能包含控制字符".to_string(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_identity_is_stable_across_reloads() {
        let directory =
            std::env::temp_dir().join(format!("flowlet-device-identity-{}", uuid::Uuid::new_v4()));

        let first = DeviceIdentity::load_or_create(&directory).expect("create device identity");
        let second = DeviceIdentity::load_or_create(&directory).expect("reload device identity");

        assert_eq!(first, second);
        assert!(DeviceIdentity::file_path(&directory).is_file());
        uuid::Uuid::parse_str(&first.device_id).expect("valid UUID device id");
        assert!(!first.display_name.is_empty());
        assert!(!first.platform.is_empty());

        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn device_display_name_is_persisted_without_changing_identity() {
        let directory =
            std::env::temp_dir().join(format!("flowlet-device-rename-{}", uuid::Uuid::new_v4()));
        let mut identity =
            DeviceIdentity::load_or_create(&directory).expect("create device identity");
        let device_id = identity.device_id.clone();

        identity
            .update_display_name(&directory, "公司笔记本")
            .expect("rename device");
        let reloaded = DeviceIdentity::load_or_create(&directory).expect("reload renamed device");

        assert_eq!(reloaded.device_id, device_id);
        assert_eq!(reloaded.display_name, "公司笔记本");
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn legacy_identity_gets_safe_readable_defaults() {
        let directory =
            std::env::temp_dir().join(format!("flowlet-device-legacy-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            DeviceIdentity::file_path(&directory),
            r#"{"schemaVersion":1,"deviceId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","createdAt":"2026-07-28T00:00:00Z"}"#,
        )
        .unwrap();

        let identity = DeviceIdentity::load_or_create(&directory).expect("load legacy identity");
        assert!(identity.display_name.ends_with("AAAA"));
        assert!(!identity.platform.is_empty());
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn invalid_existing_identity_is_not_silently_replaced() {
        let directory = std::env::temp_dir().join(format!(
            "flowlet-invalid-device-identity-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            DeviceIdentity::file_path(&directory),
            r#"{"schemaVersion":1,"deviceId":"not-a-uuid","createdAt":"2026-07-28T00:00:00Z"}"#,
        )
        .unwrap();

        let error = DeviceIdentity::load_or_create(&directory).unwrap_err();
        assert!(matches!(error, DeviceIdentityError::InvalidDeviceId(_)));

        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn legacy_device_bundle_without_sessions_remains_supported() {
        let bundle = DeviceUsageBundle::from_bytes(
            br#"{
                "format":"flowlet-device-usage",
                "version":1,
                "snapshot":{
                    "schemaVersion":1,
                    "deviceId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                    "deviceCreatedAt":"2026-07-28T00:00:00Z",
                    "displayName":"Legacy PC",
                    "platform":"windows",
                    "appVersion":"0.1.0",
                    "generatedAt":"2026-07-29T00:00:00Z",
                    "timezoneOffsetMinutes":480,
                    "days":[]
                }
            }"#,
        )
        .expect("parse legacy bundle");
        assert!(bundle.snapshot.sessions.is_empty());
    }

    #[test]
    fn device_bundle_accepts_generated_local_hour_values() {
        let bundle = DeviceUsageBundle::from_bytes(
            br#"{
                "format":"flowlet-device-usage",
                "version":1,
                "snapshot":{
                    "schemaVersion":2,
                    "deviceId":"1411a7d7-55d8-4024-8363-95858788aa91",
                    "deviceCreatedAt":"2026-07-21T00:00:00Z",
                    "displayName":"Home PC",
                    "platform":"windows",
                    "appVersion":"0.1.0",
                    "generatedAt":"2026-07-29T13:04:42Z",
                    "timezoneOffsetMinutes":480,
                    "days":[],
                    "hours":[
                        {"hour":"2026-07-21T21:00:00","requestCount":1,"knownTokens":42}
                    ],
                    "sessions":[]
                }
            }"#,
        )
        .expect("parse the local hour format emitted by hourly_usage_totals");

        assert_eq!(bundle.snapshot.hours[0].hour, "2026-07-21T21:00:00");
    }

    #[test]
    fn device_bundle_rejects_non_hour_aligned_usage_values() {
        let error = DeviceUsageBundle::from_bytes(
            br#"{
                "format":"flowlet-device-usage",
                "version":1,
                "snapshot":{
                    "schemaVersion":2,
                    "deviceId":"1411a7d7-55d8-4024-8363-95858788aa91",
                    "deviceCreatedAt":"2026-07-21T00:00:00Z",
                    "displayName":"Home PC",
                    "platform":"windows",
                    "appVersion":"0.1.0",
                    "generatedAt":"2026-07-29T13:04:42Z",
                    "timezoneOffsetMinutes":480,
                    "days":[],
                    "hours":[
                        {"hour":"2026-07-21T21:30:00","requestCount":1,"knownTokens":42}
                    ],
                    "sessions":[]
                }
            }"#,
        )
        .expect_err("reject a value that is not aligned to the start of an hour");

        assert_eq!(error, "设备小时用量时间无效：2026-07-21T21:30:00");
    }
}
