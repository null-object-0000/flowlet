use chrono::Timelike;
use serde::{Deserialize, Serialize};

use crate::core::config::DeviceUsageBreakdownRow;

pub const DEVICE_USAGE_SNAPSHOT_SCHEMA_VERSION: u32 = 13;

/// 单台设备按其本地自然日计算的最小用量汇总。不包含账号、Header 或 Body。
/// `estimated_cost` 仅包含经过 Flowlet 代理且已成功计价的请求费用。
/// `native_*` 字段（schema v6 起）承载未经过 Flowlet 代理的 Agent 原生会话用量，
/// 与代理口径字段相互独立，合计由展示层计算。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
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
    #[serde(default)]
    pub estimated_cost: f64,
    /// 原生带用量消息事件数（不是 HTTP 请求数）。
    #[serde(default)]
    pub native_event_count: i64,
    /// 标准化后的原生未缓存输入；Codex 原始 input_tokens 含缓存，聚合时已扣除。
    #[serde(default)]
    pub native_input_tokens: i64,
    #[serde(default)]
    pub native_cached_input_tokens: i64,
    #[serde(default)]
    pub native_cache_write_input_tokens: i64,
    #[serde(default)]
    pub native_output_tokens: i64,
    #[serde(default)]
    pub native_reasoning_tokens: i64,
    #[serde(default)]
    pub native_total_tokens: i64,
}

/// 单台设备按其本地自然小时计算的最小 Token 汇总。只同步最近 180 天，
/// 供移动端周视图展示真实的 7×24 小时热力图。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HourlyUsageTotal {
    pub hour: String,
    pub request_count: i64,
    pub known_tokens: i64,
    #[serde(default)]
    pub input_tokens: i64,
    #[serde(default)]
    pub input_cached_tokens: i64,
    #[serde(default)]
    pub cache_measured_input_tokens: i64,
    #[serde(default)]
    pub output_tokens: i64,
    #[serde(default)]
    pub unknown_count: i64,
    #[serde(default)]
    pub estimated_cost: f64,
    #[serde(default)]
    pub native_event_count: i64,
    /// 标准化后的原生未缓存输入；Codex 原始 input_tokens 含缓存，聚合时已扣除。
    #[serde(default)]
    pub native_input_tokens: i64,
    #[serde(default)]
    pub native_cached_input_tokens: i64,
    #[serde(default)]
    pub native_cache_write_input_tokens: i64,
    #[serde(default)]
    pub native_output_tokens: i64,
    #[serde(default)]
    pub native_reasoning_tokens: i64,
    #[serde(default)]
    pub native_total_tokens: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncedAgentInteractionEvent {
    pub id: String,
    pub kind: String,
    pub timestamp: Option<String>,
    pub title: Option<String>,
    pub content: Option<String>,
    pub model: Option<String>,
    pub status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncedAgentInteraction {
    pub events: Vec<SyncedAgentInteractionEvent>,
}

/// 设备同步中携带的会话摘要。除列表寻址字段外，版本 4 起还可携带最后一个
/// 用户回合的完整输入及其后的全部输出事件；不携带本地项目路径。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncedAgentSession {
    pub agent_type: String,
    pub session_id: String,
    #[serde(default)]
    pub parent_session_id: Option<String>,
    pub runtime_status: String,
    pub title: Option<String>,
    pub client_name: Option<String>,
    pub activity_at: String,
    pub flowlet_observed: bool,
    pub request_count: i64,
    pub error_count: i64,
    pub known_tokens: i64,
    /// Agent 原生会话摘要中的累计轮次。`None` 表示尚未生成或数据源不可读，
    /// 不能按 0 展示。
    #[serde(default)]
    pub native_turn_count: Option<i64>,
    /// Agent 原生会话摘要中的累计 Token。与 Flowlet 观测口径保持独立，
    /// 移动端只在 `flowlet_observed = false` 时用它展示原生指标。
    #[serde(default)]
    pub native_total_tokens: Option<i64>,
    #[serde(default)]
    pub native_truncated: bool,
    #[serde(default)]
    pub last_interaction: Option<SyncedAgentInteraction>,
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

/// 设备快照中携带的 Agent 安装摘要。刻意不包含可执行文件路径和安装目录。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncedAgentInstallation {
    pub surface: String,
    pub install_method: String,
    pub version: Option<String>,
}

/// 设备快照中携带的 Agent 接入摘要。配置状态来自同步发生时的本机检查；
/// `flowlet_observed` 只表示同步的会话摘要中存在经过 Flowlet 的记录。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncedAgentProfile {
    pub agent_id: String,
    pub agent_name: String,
    pub installed: bool,
    pub installations: Vec<SyncedAgentInstallation>,
    pub flowlet_config_state: Option<String>,
    pub flowlet_observed: bool,
}

/// 由桌面端写入 S3 设备快照的局域网发现信息。认证材料是设备本次启动
/// 随机生成的能力密钥，不包含或派生自 S3 凭据。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LanPeerDescriptor {
    pub protocol_version: u32,
    pub endpoints: Vec<String>,
    /// 32-byte random capability key encoded as base64. It is only distributed
    /// through the already-sensitive S3 device snapshot and is never sent over LAN.
    pub auth_key: String,
    pub capabilities: Vec<String>,
    pub started_at: String,
    pub expires_at: String,
}

/// 可安全共享到移动端的账号资源窗口。只保留展示额度所需的聚合值，
/// 不携带上游响应、Cookie、请求头或任何凭据。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SyncedAccountQuotaWindow {
    pub label: String,
    pub used_percent: f64,
    pub resets_at: Option<String>,
}

/// 工作区级账号资源只读摘要。普通渠道账号必须使用 workspace_account_id，
/// 从而让接收端能将多台桌面对同一账号的观测合并为最新一条。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SyncedAccountResource {
    pub account_id: String,
    pub channel_id: String,
    pub channel_name: String,
    pub account_name: String,
    pub plan: Option<String>,
    pub balance: Option<f64>,
    pub balance_text: Option<String>,
    pub currency: Option<String>,
    pub token_total: Option<i64>,
    pub token_used: Option<i64>,
    pub token_remaining: Option<i64>,
    pub expires_at: Option<String>,
    #[serde(default)]
    pub quota_windows: Vec<SyncedAccountQuotaWindow>,
    pub observed_at: String,
    #[serde(default)]
    pub stale: bool,
}

/// 供本地导出和未来同步传输共同使用的最小快照契约。
///
/// 兼容性说明：本结构不启用 `deny_unknown_fields`，因此旧版本写入、
/// 仍带有 `projects` 字段的快照 JSON 依然可以反序列化（未知字段被忽略），
/// 不需要额外的 `#[serde(default)]` 占位字段。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
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
    #[serde(default)]
    pub agents: Vec<SyncedAgentProfile>,
    #[serde(default)]
    pub lan_peer: Option<LanPeerDescriptor>,
    /// 本机按 (日期, 客户端, 渠道, 账号, 模型) 聚合的最近用量，附带在快照中
    /// 发给其他设备。接收端导入 `device_usage_breakdowns`，供用量分析页按设备汇总。
    #[serde(default)]
    pub usage_breakdowns: Vec<DeviceUsageBreakdownRow>,
    /// 去敏后的工作区账号资源观测。接收端按 account_id 选择 observed_at 最新值，
    /// 来源设备仅参与冲突处理，不进入常规移动端界面。
    #[serde(default)]
    pub account_resources: Vec<SyncedAccountResource>,
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

impl DeviceUsageBundle {
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
                day.native_event_count,
            ]
            .iter()
            .any(|value| *value < 0)
            {
                return Err(format!("设备用量包含负数：{}", day.date));
            }
            // native_*_tokens 不做非负校验：Codex 上下文压缩会让累计用量回退，
            // 账本会记录负的修正事件，按天求和后仍可能为负，但这属于真实账目。
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
            if hour.request_count < 0
                || hour.known_tokens < 0
                || hour.input_tokens < 0
                || hour.input_cached_tokens < 0
                || hour.cache_measured_input_tokens < 0
                || hour.output_tokens < 0
                || hour.unknown_count < 0
                || hour.native_event_count < 0
            {
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
            if session.request_count < 0
                || session.error_count < 0
                || session.known_tokens < 0
                || session.native_turn_count.is_some_and(|value| value < 0)
                || session.native_total_tokens.is_some_and(|value| value < 0)
            {
                return Err("设备会话摘要包含负数统计".to_string());
            }
            if session.title.as_ref().is_some_and(|value| {
                value.chars().count() > 512 || value.chars().any(char::is_control)
            }) || session.client_name.as_ref().is_some_and(|value| {
                value.chars().count() > 128 || value.chars().any(char::is_control)
            }) {
                return Err("设备会话摘要包含无效文本".to_string());
            }
            if let Some(interaction) = &session.last_interaction {
                if interaction.events.is_empty()
                    || !interaction
                        .events
                        .iter()
                        .any(|event| event.kind == "user-message")
                {
                    return Err("设备会话最后交互缺少用户输入".to_string());
                }
                for event in &interaction.events {
                    if event.id.trim().is_empty()
                        || event.id.chars().count() > 512
                        || event.kind.trim().is_empty()
                        || event.kind.chars().count() > 64
                    {
                        return Err("设备会话最后交互包含无效事件".to_string());
                    }
                    if event.timestamp.as_ref().is_some_and(|timestamp| {
                        chrono::DateTime::parse_from_rfc3339(timestamp).is_err()
                    }) {
                        return Err("设备会话最后交互包含无效时间".to_string());
                    }
                    if event
                        .title
                        .as_ref()
                        .is_some_and(|value| value.chars().count() > 512)
                        || event
                            .model
                            .as_ref()
                            .is_some_and(|value| value.chars().count() > 256)
                        || event
                            .status
                            .as_ref()
                            .is_some_and(|value| value.chars().count() > 64)
                    {
                        return Err("设备会话最后交互包含无效元数据".to_string());
                    }
                }
            }
        }
        let mut agent_ids = std::collections::HashSet::new();
        for agent in &self.snapshot.agents {
            if agent.agent_id.trim().is_empty()
                || agent.agent_id.chars().count() > 64
                || agent.agent_name.trim().is_empty()
                || agent.agent_name.chars().count() > 128
                || agent.agent_name.chars().any(char::is_control)
            {
                return Err("设备 Agent 摘要包含无效标识".to_string());
            }
            if !agent_ids.insert(&agent.agent_id) {
                return Err("设备 Agent 摘要包含重复 Agent".to_string());
            }
            if agent.flowlet_config_state.as_deref().is_some_and(|state| {
                !matches!(
                    state,
                    "not_configured" | "flowlet" | "other_gateway" | "partial" | "invalid"
                )
            }) {
                return Err("设备 Agent 摘要包含无效接入状态".to_string());
            }
            for installation in &agent.installations {
                if !matches!(installation.surface.as_str(), "cli" | "desktop")
                    || installation.install_method.trim().is_empty()
                    || installation.install_method.chars().count() > 32
                    || installation.version.as_ref().is_some_and(|version| {
                        version.chars().count() > 64 || version.chars().any(char::is_control)
                    })
                {
                    return Err("设备 Agent 摘要包含无效安装信息".to_string());
                }
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

fn default_display_name(platform: &str, device_id: &str) -> String {
    let suffix = device_id
        .chars()
        .filter(|character| *character != '-')
        .take(4)
        .collect::<String>()
        .to_uppercase();
    format!("{} · {suffix}", platform_label(platform))
}

/// 与前端 `src/shared/formatters/platform.ts` 保持一致的平台标签映射。
fn platform_label(platform: &str) -> String {
    match platform {
        "windows" => "Windows".to_string(),
        "macos" | "darwin" => "macOS".to_string(),
        "linux" => "Linux".to_string(),
        "ubuntu" => "Ubuntu".to_string(),
        "debian" => "Debian".to_string(),
        "fedora" => "Fedora".to_string(),
        "arch" => "Arch".to_string(),
        "manjaro" => "Manjaro".to_string(),
        "linuxmint" => "Linux Mint".to_string(),
        "centos" => "CentOS".to_string(),
        "rhel" => "RHEL".to_string(),
        "alpine" => "Alpine".to_string(),
        "opensuse" | "opensuse-leap" | "opensuse-tumbleweed" => "openSUSE".to_string(),
        "android" => "Android".to_string(),
        "ios" => "iOS".to_string(),
        "" | "unknown" => "Flowlet".to_string(),
        other => {
            let mut chars = other.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => "Flowlet".to_string(),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(bundle.snapshot.agents.is_empty());
    }

    /// 项目/任务同步能力已整体移除，但旧版本写入的快照仍带 `projects` 字段。
    /// 本测试固定向后兼容契约：未知字段被忽略，快照其余字段照常读取，
    /// 重新序列化时不再输出已移除的字段。
    #[test]
    fn legacy_bundle_with_removed_projects_field_remains_parseable() {
        let bundle = DeviceUsageBundle::from_bytes(
            br#"{
                "format":"flowlet-device-usage",
                "version":1,
                "snapshot":{
                    "schemaVersion":13,
                    "deviceId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                    "deviceCreatedAt":"2026-07-28T00:00:00Z",
                    "displayName":"Legacy PC",
                    "platform":"windows",
                    "appVersion":"0.1.0",
                    "generatedAt":"2026-07-29T00:00:00Z",
                    "timezoneOffsetMinutes":480,
                    "days":[],
                    "projects":[{
                        "projectId":"proj-1",
                        "name":"legacy project",
                        "archived":false,
                        "updatedAt":"2026-07-29T00:00:00Z",
                        "hasLocalBinding":true,
                        "tasks":[{
                            "id":"task-1",
                            "title":"legacy task",
                            "status":"draft",
                            "priority":"p2",
                            "executionCount":0,
                            "updatedAt":"2026-07-29T00:00:00Z"
                        }]
                    }]
                }
            }"#,
        )
        .expect("parse legacy bundle with removed projects field");

        assert_eq!(
            bundle.snapshot.device_id,
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        );
        assert!(bundle.snapshot.days.is_empty());

        let json = serde_json::to_string(&bundle.snapshot).unwrap();
        assert!(!json.contains("\"projects\""));
    }

    #[test]
    fn version_three_bundle_accepts_agent_installation_summary() {
        let bundle = DeviceUsageBundle::from_bytes(
            br#"{
                "format":"flowlet-device-usage",
                "version":1,
                "snapshot":{
                    "schemaVersion":3,
                    "deviceId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                    "deviceCreatedAt":"2026-07-28T00:00:00Z",
                    "displayName":"Agent PC",
                    "platform":"windows",
                    "appVersion":"0.1.0",
                    "generatedAt":"2026-07-30T00:00:00Z",
                    "timezoneOffsetMinutes":480,
                    "days":[],
                    "hours":[],
                    "sessions":[],
                    "agents":[{
                        "agentId":"claude-code",
                        "agentName":"Claude Code",
                        "installed":true,
                        "installations":[{"surface":"cli","installMethod":"npm","version":"1.2.3"}],
                        "flowletConfigState":"flowlet",
                        "flowletObserved":true
                    }]
                }
            }"#,
        )
        .expect("parse version three bundle");

        assert_eq!(bundle.snapshot.agents.len(), 1);
        assert_eq!(bundle.snapshot.agents[0].agent_id, "claude-code");
    }

    #[test]
    fn version_four_bundle_accepts_a_complete_last_interaction() {
        let bundle = DeviceUsageBundle::from_bytes(
            br#"{
                "format":"flowlet-device-usage",
                "version":1,
                "snapshot":{
                    "schemaVersion":4,
                    "deviceId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                    "deviceCreatedAt":"2026-07-28T00:00:00Z",
                    "displayName":"Session PC",
                    "platform":"windows",
                    "appVersion":"0.1.0",
                    "generatedAt":"2026-07-30T00:00:00Z",
                    "timezoneOffsetMinutes":480,
                    "days":[],
                    "hours":[],
                    "sessions":[{
                        "agentType":"codex-cli",
                        "sessionId":"session-child",
                        "parentSessionId":"session-root",
                        "runtimeStatus":"idle",
                        "title":"Latest turn",
                        "clientName":"Codex CLI",
                        "activityAt":"2026-07-30T00:00:00Z",
                        "flowletObserved":true,
                        "requestCount":2,
                        "errorCount":0,
                        "knownTokens":42,
                        "lastInteraction":{"events":[
                            {"id":"user-1","kind":"user-message","timestamp":"2026-07-30T00:00:00Z","title":null,"content":"complete input","model":null,"status":null},
                            {"id":"assistant-1","kind":"assistant-message","timestamp":"2026-07-30T00:00:01Z","title":null,"content":"first output","model":"gpt-5","status":null},
                            {"id":"assistant-2","kind":"assistant-message","timestamp":"2026-07-30T00:00:02Z","title":null,"content":"second output","model":"gpt-5","status":null}
                        ]}
                    }],
                    "agents":[]
                }
            }"#,
        )
        .expect("parse version four bundle");

        let session = &bundle.snapshot.sessions[0];
        assert_eq!(session.parent_session_id.as_deref(), Some("session-root"));
        assert_eq!(
            session
                .last_interaction
                .as_ref()
                .expect("last interaction")
                .events
                .len(),
            3
        );
    }

    #[test]
    fn version_six_bundle_carries_native_usage_fields() {
        let bundle = DeviceUsageBundle::from_bytes(
            br#"{
                "format":"flowlet-device-usage",
                "version":1,
                "snapshot":{
                    "schemaVersion":6,
                    "deviceId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                    "deviceCreatedAt":"2026-07-28T00:00:00Z",
                    "displayName":"Native PC",
                    "platform":"windows",
                    "appVersion":"0.1.0",
                    "generatedAt":"2026-07-31T00:00:00Z",
                    "timezoneOffsetMinutes":480,
                    "days":[{
                        "date":"2026-07-30",
                        "requestCount":4,
                        "knownTokens":30,
                        "inputTokens":20,
                        "inputCachedTokens":5,
                        "inputUncachedTokens":15,
                        "cacheMeasuredInputTokens":20,
                        "outputTokens":10,
                        "unknownCount":0,
                        "nativeEventCount":3,
                        "nativeInputTokens":50,
                        "nativeCachedInputTokens":20,
                        "nativeCacheWriteInputTokens":5,
                        "nativeOutputTokens":27,
                        "nativeReasoningTokens":2,
                        "nativeTotalTokens":77
                    }],
                    "hours":[{
                        "hour":"2026-07-30T12:00:00",
                        "requestCount":4,
                        "knownTokens":30,
                        "nativeEventCount":2,
                        "nativeTotalTokens":70
                    }],
                    "sessions":[],
                    "agents":[]
                }
            }"#,
        )
        .expect("parse version six bundle");
        bundle.validate().expect("version six bundle is valid");

        let day = &bundle.snapshot.days[0];
        assert_eq!(day.known_tokens, 30);
        assert_eq!(day.native_event_count, 3);
        assert_eq!(day.native_total_tokens, 77);
        let hour = &bundle.snapshot.hours[0];
        assert_eq!(hour.native_event_count, 2);
        assert_eq!(hour.native_total_tokens, 70);
    }

    #[test]
    fn older_bundles_default_native_usage_fields_to_zero() {
        let bundle = DeviceUsageBundle::from_bytes(
            br#"{
                "format":"flowlet-device-usage",
                "version":1,
                "snapshot":{
                    "schemaVersion":5,
                    "deviceId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                    "deviceCreatedAt":"2026-07-28T00:00:00Z",
                    "displayName":"Legacy PC",
                    "platform":"windows",
                    "appVersion":"0.1.0",
                    "generatedAt":"2026-07-31T00:00:00Z",
                    "timezoneOffsetMinutes":480,
                    "days":[{
                        "date":"2026-07-30",
                        "requestCount":4,
                        "knownTokens":30,
                        "inputTokens":20,
                        "inputCachedTokens":5,
                        "inputUncachedTokens":15,
                        "cacheMeasuredInputTokens":20,
                        "outputTokens":10,
                        "unknownCount":0
                    }],
                    "hours":[{
                        "hour":"2026-07-30T12:00:00",
                        "requestCount":4,
                        "knownTokens":30
                    }],
                    "sessions":[],
                    "agents":[]
                }
            }"#,
        )
        .expect("parse version five bundle");
        bundle.validate().expect("version five bundle is valid");

        assert_eq!(bundle.snapshot.days[0].native_total_tokens, 0);
        assert_eq!(bundle.snapshot.days[0].native_event_count, 0);
        assert_eq!(bundle.snapshot.days[0].estimated_cost, 0.0);
        assert_eq!(bundle.snapshot.hours[0].native_total_tokens, 0);
        assert_eq!(bundle.snapshot.hours[0].unknown_count, 0);
        assert_eq!(bundle.snapshot.hours[0].input_tokens, 0);
        assert_eq!(bundle.snapshot.hours[0].estimated_cost, 0.0);
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

    #[test]
    fn platform_label_maps_distro_ids() {
        assert_eq!(platform_label("ubuntu"), "Ubuntu");
        assert_eq!(platform_label("linux"), "Linux");
        assert_eq!(platform_label("windows"), "Windows");
        assert_eq!(platform_label("macos"), "macOS");
        assert_eq!(platform_label("nixos"), "Nixos");
        assert_eq!(platform_label("unknown"), "Flowlet");
    }

    #[test]
    fn default_display_name_uses_distro_label() {
        let name = default_display_name("ubuntu", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
        assert!(
            name.starts_with("Ubuntu · "),
            "unexpected default name: {name}"
        );
    }
}

fn validate_display_name(display_name: &str) -> Result<(), String> {
    let count = display_name.chars().count();
    if count == 0 {
        return Err("设备名称无效: 名称不能为空".to_string());
    }
    if count > 64 {
        return Err("设备名称无效: 名称不能超过 64 个字符".to_string());
    }
    if display_name.chars().any(char::is_control) {
        return Err("设备名称无效: 名称不能包含控制字符".to_string());
    }
    Ok(())
}
