use crate::core::agent_environment::{AgentInstallMethod, AgentSurface};
use crate::core::agent_global_config::AgentGlobalConfigState;
use crate::core::config::ProxyBindConfig;
use crate::core::device_identity::{
    DeviceIdentity, DeviceUsageBundle, DeviceUsageSnapshot, SyncedAgentInstallation,
    SyncedAgentInteraction, SyncedAgentInteractionEvent, SyncedAgentProfile, SyncedAgentSession,
};
use crate::core::storage::Storage;
use reqwest::{Client, Response, StatusCode};
use rusty_s3::actions::{ListObjectsV2, S3Action as _};
use rusty_s3::{Bucket, Credentials, UrlStyle};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use url::Url;

const CONFIG_KEY: &str = "device_sync_s3_config_v1";
const STATUS_KEY: &str = "device_sync_s3_status_v1";
const CURRENT_ETAG_KEY: &str = "device_sync_s3_current_etag_v1";
const KEYRING_SERVICE: &str = "Flowlet Device Sync";
const MAX_REMOTE_BUNDLE_BYTES: u64 = 64 * 1024 * 1024;
const SIGNED_URL_TTL: Duration = Duration::from_secs(60);
pub const AUTO_SYNC_INITIAL_DELAY: Duration = Duration::from_secs(5);
pub const AUTO_SYNC_INTERVAL: Duration = Duration::from_secs(15 * 60);
pub const SYNC_ALREADY_RUNNING_ERROR: &str = "设备用量同步正在运行";
static SYNC_RUNNING: AtomicBool = AtomicBool::new(false);
const MIN_SYNCED_RECENT_SESSIONS: usize = 10;

#[derive(Debug)]
pub struct DeviceSyncGuard;

impl Drop for DeviceSyncGuard {
    fn drop(&mut self) {
        SYNC_RUNNING.store(false, Ordering::Release);
    }
}

pub fn acquire_sync_guard() -> Result<DeviceSyncGuard, String> {
    SYNC_RUNNING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map(|_| DeviceSyncGuard)
        .map_err(|_| SYNC_ALREADY_RUNNING_ERROR.to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct S3SyncConfig {
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    pub prefix: String,
    pub access_key_id: String,
    pub path_style: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct S3SyncConfigInput {
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    pub prefix: String,
    pub access_key_id: String,
    pub secret_access_key: Option<String>,
    pub path_style: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct S3SyncConfigView {
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    pub prefix: String,
    pub access_key_id: String,
    pub path_style: bool,
    pub secret_configured: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct S3SyncStatus {
    pub status: String,
    pub last_attempt_at: Option<String>,
    pub last_success_at: Option<String>,
    pub message: String,
    pub remote_devices: usize,
    pub imported_devices: usize,
    pub imported_days: usize,
    pub failed_objects: usize,
    #[serde(default)]
    pub failure_details: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct S3SyncSettings {
    pub config: Option<S3SyncConfigView>,
    pub status: S3SyncStatus,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct S3ConnectionTestResult {
    pub message: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct S3DeviceSyncResult {
    pub remote_devices: usize,
    pub imported_devices: usize,
    pub imported_days: usize,
    pub unchanged_days: usize,
    pub failed_objects: usize,
    pub uploaded_key: String,
}

pub async fn build_device_snapshot(
    storage: Storage,
    identity: DeviceIdentity,
) -> Result<DeviceUsageSnapshot, String> {
    let snapshot_storage = storage.clone();
    let (days, hours, sessions) = tauri::async_runtime::spawn_blocking(move || {
        let days = snapshot_storage
            .daily_usage_totals()
            .map_err(|error| error.to_string())?;
        let hours = snapshot_storage
            .hourly_usage_totals()
            .map_err(|error| error.to_string())?;
        let sessions = snapshot_storage
            .list_agent_sessions_for_device_sync()
            .map_err(|error| error.to_string())?
            .into_iter()
            .map(|row| SyncedAgentSession {
                agent_type: row.agent_type,
                session_id: row.session_id,
                parent_session_id: row.parent_session_id,
                runtime_status: row.runtime_status,
                title: sanitize_session_text(row.title, 512),
                client_name: sanitize_session_text(row.client_name, 128),
                activity_at: row.activity_at,
                flowlet_observed: row.flowlet_observed,
                request_count: row.request_count,
                error_count: row.error_count,
                known_tokens: row.known_tokens,
                last_interaction: None,
            })
            .collect::<Vec<_>>();
        let mut sessions = select_sessions_for_sync(sessions);
        for session in &mut sessions {
            match crate::core::agent_session_timeline::get_native_agent_session_last_interaction(
                &session.agent_type,
                &session.session_id,
            ) {
                Ok(Some(timeline)) => {
                    session.last_interaction = Some(SyncedAgentInteraction {
                        events: timeline
                            .events
                            .into_iter()
                            .map(|event| SyncedAgentInteractionEvent {
                                id: event.id,
                                kind: event.kind,
                                timestamp: event.timestamp,
                                title: event.title,
                                content: event.content,
                                model: event.model,
                                status: event.status,
                            })
                            .collect(),
                    });
                }
                Ok(None) => {}
                Err(error) => tracing::warn!(
                    agent_type = session.agent_type,
                    session_id = session.session_id,
                    error,
                    "读取设备同步会话最后交互失败"
                ),
            }
        }
        Ok::<_, String>((days, hours, sessions))
    })
    .await
    .map_err(|_| "生成设备用量快照任务失败".to_string())??;
    let agents = build_synced_agent_profiles(&storage, &sessions).await?;
    let mut snapshot = DeviceUsageSnapshot::new(&identity, days, hours, sessions, agents);
    snapshot.lan_peer = crate::core::lan_sync::current_descriptor(&storage);
    Ok(snapshot)
}

async fn build_synced_agent_profiles(
    storage: &Storage,
    sessions: &[SyncedAgentSession],
) -> Result<Vec<SyncedAgentProfile>, String> {
    let (claude, opencode, pi, chatgpt) = tokio::join!(
        crate::core::agent_environment::detect_agent_environment("claude-code"),
        crate::core::agent_environment::detect_agent_environment("opencode"),
        crate::core::agent_environment::detect_agent_environment("pi"),
        crate::core::agent_environment::detect_agent_environment("chatgpt-desktop"),
    );
    let environments = [claude?, opencode?, pi?, chatgpt?];
    let config_storage = storage.clone();
    let config_states = tauri::async_runtime::spawn_blocking(move || {
        let bind = config_storage
            .get_app_meta("proxy_bind_config")
            .unwrap_or_default()
            .and_then(|json| serde_json::from_str::<ProxyBindConfig>(&json).ok())
            .unwrap_or_default()
            .normalized();
        [
            (
                "claude-code",
                format!("http://127.0.0.1:{}/anthropic", bind.port),
            ),
            ("opencode", format!("http://127.0.0.1:{}/v1", bind.port)),
            ("pi", format!("http://127.0.0.1:{}/v1", bind.port)),
        ]
        .into_iter()
        .map(|(agent_id, base_url)| {
            let state =
                crate::core::agent_global_config::inspect_agent_global_config(agent_id, &base_url)
                    .ok()
                    .map(|report| global_config_state_name(&report.state).to_string());
            (agent_id.to_string(), state)
        })
        .collect::<std::collections::HashMap<_, _>>()
    })
    .await
    .map_err(|_| "检测 Agent 接入状态任务失败".to_string())?;

    Ok(environments
        .into_iter()
        .map(|environment| SyncedAgentProfile {
            flowlet_observed: sessions.iter().any(|session| {
                session.flowlet_observed
                    && session_matches_agent(&session.agent_type, &environment.agent_id)
            }),
            flowlet_config_state: config_states.get(&environment.agent_id).cloned().flatten(),
            agent_id: environment.agent_id,
            agent_name: environment.agent_name,
            installed: environment.installed,
            installations: environment
                .installations
                .into_iter()
                .map(|installation| SyncedAgentInstallation {
                    surface: agent_surface_name(&installation.surface).to_string(),
                    install_method: agent_install_method_name(&installation.install_method)
                        .to_string(),
                    version: installation.version,
                })
                .collect(),
        })
        .collect())
}

fn global_config_state_name(state: &AgentGlobalConfigState) -> &'static str {
    match state {
        AgentGlobalConfigState::NotConfigured => "not_configured",
        AgentGlobalConfigState::Flowlet => "flowlet",
        AgentGlobalConfigState::OtherGateway => "other_gateway",
        AgentGlobalConfigState::Partial => "partial",
        AgentGlobalConfigState::Invalid => "invalid",
    }
}

fn agent_surface_name(surface: &AgentSurface) -> &'static str {
    match surface {
        AgentSurface::Cli => "cli",
        AgentSurface::Desktop => "desktop",
    }
}

fn agent_install_method_name(method: &AgentInstallMethod) -> &'static str {
    match method {
        AgentInstallMethod::Native => "native",
        AgentInstallMethod::Winget => "winget",
        AgentInstallMethod::Npm => "npm",
        AgentInstallMethod::Bun => "bun",
        AgentInstallMethod::LegacyNpm => "legacy_npm",
        AgentInstallMethod::Homebrew => "homebrew",
        AgentInstallMethod::SystemPackage => "system_package",
        AgentInstallMethod::Desktop => "desktop",
        AgentInstallMethod::Unknown => "unknown",
    }
}

fn session_matches_agent(agent_type: &str, agent_id: &str) -> bool {
    match agent_id {
        "chatgpt-desktop" => matches!(agent_type, "codex-cli" | "codex-desktop"),
        _ => agent_type == agent_id,
    }
}

fn sanitize_session_text(value: Option<String>, max_chars: usize) -> Option<String> {
    let value = value?;
    let sanitized = value
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .take(max_chars)
        .collect::<String>();
    let sanitized = sanitized.trim();
    (!sanitized.is_empty()).then(|| sanitized.to_string())
}

fn select_sessions_for_sync(mut sessions: Vec<SyncedAgentSession>) -> Vec<SyncedAgentSession> {
    sessions.sort_by(|left, right| {
        crate::core::agent_session_metadata::session_time_millis(&right.activity_at)
            .cmp(&crate::core::agent_session_metadata::session_time_millis(
                &left.activity_at,
            ))
            .then_with(|| right.session_id.cmp(&left.session_id))
    });
    let (mut active, inactive): (Vec<_>, Vec<_>) = sessions
        .into_iter()
        .partition(|session| matches!(session.runtime_status.as_str(), "running" | "waiting_user"));
    if active.len() < MIN_SYNCED_RECENT_SESSIONS {
        active.extend(
            inactive
                .into_iter()
                .take(MIN_SYNCED_RECENT_SESSIONS - active.len()),
        );
    }
    active
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct S3DevicePullResult {
    pub remote_devices: usize,
    pub imported_devices: usize,
    pub imported_days: usize,
    pub unchanged_days: usize,
    pub failed_objects: usize,
    pub failure_details: Vec<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CurrentEtagState {
    endpoint: String,
    bucket: String,
    key: String,
    etag: String,
}

impl Default for S3SyncStatus {
    fn default() -> Self {
        Self {
            status: "never".to_string(),
            last_attempt_at: None,
            last_success_at: None,
            message: "尚未同步".to_string(),
            remote_devices: 0,
            imported_devices: 0,
            imported_days: 0,
            failed_objects: 0,
            failure_details: Vec::new(),
        }
    }
}

impl S3SyncConfig {
    pub fn from_input(input: &S3SyncConfigInput) -> Result<Self, String> {
        let endpoint = input.endpoint.trim().trim_end_matches('/').to_string();
        let endpoint_url = Url::parse(&endpoint).map_err(|_| "S3 Endpoint 格式无效".to_string())?;
        if !matches!(endpoint_url.scheme(), "http" | "https") || endpoint_url.host_str().is_none() {
            return Err("S3 Endpoint 必须是有效的 HTTP 或 HTTPS 地址".to_string());
        }
        if endpoint_url.scheme() == "http"
            && !matches!(
                endpoint_url.host_str(),
                Some("localhost" | "127.0.0.1" | "::1")
            )
        {
            return Err("远程 S3 Endpoint 必须使用 HTTPS；HTTP 仅允许本机 MinIO".to_string());
        }
        let bucket = input.bucket.trim().to_string();
        if !(3..=63).contains(&bucket.len()) || bucket.chars().any(char::is_whitespace) {
            return Err("S3 Bucket 长度必须为 3–63 个字符且不能包含空白".to_string());
        }
        let access_key_id = input.access_key_id.trim().to_string();
        if access_key_id.is_empty() || access_key_id.chars().count() > 256 {
            return Err("Access Key ID 不能为空且不能超过 256 个字符".to_string());
        }
        let region = input.region.trim().to_string();
        if region.is_empty() || region.chars().count() > 64 {
            return Err("S3 Region 不能为空且不能超过 64 个字符".to_string());
        }
        let endpoint_host = endpoint_url
            .host_str()
            .unwrap_or_default()
            .to_ascii_lowercase();
        if endpoint_host.ends_with(".aliyuncs.com")
            && endpoint_host.starts_with(&format!("{}.", bucket.to_ascii_lowercase()))
        {
            return Err(
                "阿里云 OSS Endpoint 不应包含 Bucket 名；上海地域请填写 https://s3.oss-cn-shanghai.aliyuncs.com"
                    .to_string(),
            );
        }
        if endpoint_host.ends_with(".aliyuncs.com") && !endpoint_host.starts_with("s3.oss-") {
            return Err(
                "阿里云 OSS 必须使用 S3-compatible Endpoint；上海地域请填写 https://s3.oss-cn-shanghai.aliyuncs.com"
                    .to_string(),
            );
        }
        if endpoint_host.ends_with(".aliyuncs.com") && region.eq_ignore_ascii_case("auto") {
            return Err("阿里云 OSS Region 不能使用 auto；上海地域请填写 cn-shanghai".to_string());
        }
        let prefix = input
            .prefix
            .trim()
            .trim_matches('/')
            .split('/')
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("/");
        if prefix.chars().count() > 256 || prefix.split('/').any(|part| part == "..") {
            return Err("S3 路径前缀无效".to_string());
        }
        Ok(Self {
            endpoint,
            region,
            bucket,
            prefix,
            access_key_id,
            path_style: input.path_style,
        })
    }

    fn object_prefix(&self) -> String {
        if self.prefix.is_empty() {
            "flowlet/v1/devices/".to_string()
        } else {
            format!("{}/flowlet/v1/devices/", self.prefix)
        }
    }

    fn snapshot_key(&self, device_id: &str) -> String {
        format!("{}{device_id}/snapshot.json", self.object_prefix())
    }

    fn supports_conditional_put(&self) -> bool {
        Url::parse(&self.endpoint)
            .ok()
            .and_then(|url| url.host_str().map(str::to_ascii_lowercase))
            .is_none_or(|host| !host.ends_with(".aliyuncs.com"))
    }

    fn credential_username(&self) -> String {
        let mut digest = Sha256::new();
        digest.update(self.endpoint.as_bytes());
        digest.update(b"\0");
        digest.update(self.bucket.as_bytes());
        digest.update(b"\0");
        digest.update(self.access_key_id.as_bytes());
        format!("s3-{}", hex::encode(digest.finalize()))
    }
}

struct S3Store {
    bucket: Bucket,
    credentials: Credentials,
    client: Client,
    supports_conditional_put: bool,
}

impl S3Store {
    fn new(config: &S3SyncConfig, secret: &str) -> Result<Self, String> {
        let endpoint =
            Url::parse(&config.endpoint).map_err(|_| "S3 Endpoint 格式无效".to_string())?;
        let style = if config.path_style {
            UrlStyle::Path
        } else {
            UrlStyle::VirtualHost
        };
        let bucket = Bucket::new(
            endpoint,
            style,
            config.bucket.clone(),
            config.region.clone(),
        )
        .map_err(|_| "无法构造 S3 Bucket 地址".to_string())?;
        let client = Client::builder()
            .timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| "初始化 S3 网络客户端失败".to_string())?;
        Ok(Self {
            bucket,
            credentials: Credentials::new(&config.access_key_id, secret),
            client,
            supports_conditional_put: config.supports_conditional_put(),
        })
    }

    async fn head_bucket(&self) -> Result<(), String> {
        let url = self
            .bucket
            .head_bucket(Some(&self.credentials))
            .sign(SIGNED_URL_TTL);
        checked_response(self.client.head(url).send().await, "检查 Bucket").await?;
        Ok(())
    }

    async fn list(&self, prefix: &str) -> Result<Vec<RemoteObject>, String> {
        let mut objects = Vec::new();
        let mut continuation: Option<String> = None;
        loop {
            let mut action = self.bucket.list_objects_v2(Some(&self.credentials));
            action.with_prefix(prefix.to_string());
            if let Some(token) = continuation.clone() {
                action.with_continuation_token(token);
            }
            let url = action.sign(SIGNED_URL_TTL);
            let response = checked_response(self.client.get(url).send().await, "列举对象").await?;
            let body = response
                .text()
                .await
                .map_err(|_| "读取 S3 对象列表失败".to_string())?;
            let parsed = ListObjectsV2::parse_response(&body)
                .map_err(|_| "解析 S3 对象列表失败".to_string())?;
            objects.extend(parsed.contents.into_iter().map(|object| RemoteObject {
                key: object.key,
                etag: object.etag,
                size: object.size,
            }));
            continuation = parsed.next_continuation_token;
            if continuation.is_none() {
                break;
            }
        }
        Ok(objects)
    }

    async fn get(&self, key: &str) -> Result<Vec<u8>, String> {
        let url = self
            .bucket
            .get_object(Some(&self.credentials), key)
            .sign(SIGNED_URL_TTL);
        let response = checked_response(self.client.get(url).send().await, "下载对象").await?;
        if response.content_length().unwrap_or(0) > MAX_REMOTE_BUNDLE_BYTES {
            return Err("远端设备快照超过 64 MB 限制".to_string());
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|_| "读取远端设备快照失败".to_string())?;
        if bytes.len() as u64 > MAX_REMOTE_BUNDLE_BYTES {
            return Err("远端设备快照超过 64 MB 限制".to_string());
        }
        Ok(bytes.to_vec())
    }

    async fn head_etag(&self, key: &str) -> Result<Option<String>, String> {
        let url = self
            .bucket
            .head_object(Some(&self.credentials), key)
            .sign(SIGNED_URL_TTL);
        let response =
            checked_response(self.client.head(url).send().await, "读取对象元信息").await?;
        Ok(response
            .headers()
            .get("etag")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string))
    }

    async fn put(
        &self,
        key: &str,
        body: Vec<u8>,
        etag: Option<&str>,
    ) -> Result<Option<String>, String> {
        // Alibaba Cloud OSS accepts S3-compatible PutObject requests but does
        // not support If-Match on PutObject. The caller already compares the
        // saved and current remote ETags before reaching this write, so OSS
        // keeps that best-effort conflict check and omits only the unsupported
        // conditional request header.
        let conditional_etag = etag.filter(|_| self.supports_conditional_put);
        let mut action = self.bucket.put_object(Some(&self.credentials), key);
        action
            .headers_mut()
            .insert("content-type", "application/json");
        if let Some(etag) = conditional_etag {
            action.headers_mut().insert("if-match", etag.to_string());
        }
        let url = action.sign(SIGNED_URL_TTL);
        let mut request = self
            .client
            .put(url)
            .header("content-type", "application/json")
            .body(body);
        if let Some(etag) = conditional_etag {
            request = request.header("if-match", etag);
        }
        let response = request
            .send()
            .await
            .map_err(|_| "上传 S3 设备快照时网络请求失败".to_string())?;
        if response.status() == StatusCode::PRECONDITION_FAILED {
            return Err("远端设备快照已被其他写入者修改，可能存在重复设备 ID".to_string());
        }
        let response = checked_response(Ok(response), "上传设备快照").await?;
        Ok(response
            .headers()
            .get("etag")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string))
    }

    async fn delete(&self, key: &str) -> Result<(), String> {
        let url = self
            .bucket
            .delete_object(Some(&self.credentials), key)
            .sign(SIGNED_URL_TTL);
        checked_response(self.client.delete(url).send().await, "删除测试对象").await?;
        Ok(())
    }
}

struct RemoteObject {
    key: String,
    etag: String,
    size: u64,
}

async fn checked_response(
    response: Result<Response, reqwest::Error>,
    action: &str,
) -> Result<Response, String> {
    let response = response.map_err(|_| format!("{action}时网络请求失败"))?;
    if response.status().is_success() {
        return Ok(response);
    }
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    let detail = s3_error_detail(&body);
    Err(format!(
        "{action}失败（HTTP {}{}）",
        status.as_u16(),
        detail
    ))
}

fn s3_error_detail(body: &str) -> String {
    let code = xml_element(body, "Code");
    let request_id = xml_element(body, "RequestId");
    match (code, request_id) {
        (Some(code), Some(request_id)) => {
            format!("，Code: {code}，RequestId: {request_id}")
        }
        (Some(code), None) => format!("，Code: {code}"),
        (None, Some(request_id)) => format!("，RequestId: {request_id}"),
        (None, None) => String::new(),
    }
}

fn xml_element<'a>(body: &'a str, name: &str) -> Option<&'a str> {
    let start_tag = format!("<{name}>");
    let end_tag = format!("</{name}>");
    let start = body.find(&start_tag)? + start_tag.len();
    let end = body[start..].find(&end_tag)? + start;
    let value = body[start..end].trim();
    (!value.is_empty() && value.chars().count() <= 256 && !value.chars().any(char::is_control))
        .then_some(value)
}

fn credential_entry(config: &S3SyncConfig) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, &config.credential_username())
        .map_err(|_| "无法访问系统凭据库".to_string())
}

fn read_secret(config: &S3SyncConfig) -> Result<String, String> {
    credential_entry(config)?
        .get_password()
        .map_err(|_| "未找到 S3 Secret Access Key，请重新填写并保存".to_string())
}

fn has_secret(config: &S3SyncConfig) -> bool {
    read_secret(config).is_ok()
}

pub fn load_config(storage: &Storage) -> Result<Option<S3SyncConfig>, String> {
    storage
        .get_app_meta(CONFIG_KEY)
        .map_err(|error| error.to_string())?
        .map(|raw| serde_json::from_str(&raw).map_err(|_| "S3 同步配置格式无效".to_string()))
        .transpose()
}

pub fn load_status(storage: &Storage) -> S3SyncStatus {
    storage
        .get_app_meta(STATUS_KEY)
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn load_settings(storage: &Storage) -> Result<S3SyncSettings, String> {
    let config = load_config(storage)?;
    Ok(S3SyncSettings {
        config: config.as_ref().map(|config| S3SyncConfigView {
            endpoint: config.endpoint.clone(),
            region: config.region.clone(),
            bucket: config.bucket.clone(),
            prefix: config.prefix.clone(),
            access_key_id: config.access_key_id.clone(),
            path_style: config.path_style,
            secret_configured: has_secret(config),
        }),
        status: load_status(storage),
    })
}

pub fn export_connection_config(storage: &Storage) -> Result<S3SyncConfigInput, String> {
    let config = load_config(storage)?.ok_or_else(|| "尚未配置 S3 同步".to_string())?;
    let secret_access_key = read_secret(&config)?;
    Ok(S3SyncConfigInput {
        endpoint: config.endpoint,
        region: config.region,
        bucket: config.bucket,
        prefix: config.prefix,
        access_key_id: config.access_key_id,
        secret_access_key: Some(secret_access_key),
        path_style: config.path_style,
    })
}

pub fn save_config(storage: &Storage, input: &S3SyncConfigInput) -> Result<(), String> {
    let previous = load_config(storage)?;
    let config = S3SyncConfig::from_input(input)?;
    if let Some(secret) = input
        .secret_access_key
        .as_deref()
        .map(str::trim)
        .filter(|secret| !secret.is_empty())
    {
        credential_entry(&config)?
            .set_password(secret)
            .map_err(|_| "保存 S3 Secret Access Key 到系统凭据库失败".to_string())?;
    } else {
        read_secret(&config)?;
    }
    let raw = serde_json::to_string(&config).map_err(|_| "序列化 S3 同步配置失败".to_string())?;
    storage
        .set_app_meta(CONFIG_KEY, &raw)
        .map_err(|error| error.to_string())?;
    if let Some(previous) = previous {
        if previous.credential_username() != config.credential_username() {
            if let Ok(entry) = credential_entry(&previous) {
                let _ = entry.delete_credential();
            }
        }
    }
    Ok(())
}

pub async fn test_connection(input: &S3SyncConfigInput) -> Result<S3ConnectionTestResult, String> {
    let config = S3SyncConfig::from_input(input)?;
    let provided_secret = input
        .secret_access_key
        .as_deref()
        .map(str::trim)
        .filter(|secret| !secret.is_empty())
        .map(str::to_string);
    let secret = match provided_secret {
        Some(secret) => secret,
        None => read_secret(&config)?,
    };
    let store = S3Store::new(&config, &secret)?;
    store
        .head_bucket()
        .await
        .map_err(|error| format!("{error}；请确认已授予 Bucket 级 oss:HeadBucket 权限"))?;
    let test_prefix = if config.prefix.is_empty() {
        "flowlet/v1/tests/".to_string()
    } else {
        format!("{}/flowlet/v1/tests/", config.prefix)
    };
    store.list(&test_prefix).await?;
    let test_key = format!("{}{}.json", test_prefix, uuid::Uuid::new_v4());
    store.put(&test_key, b"{}".to_vec(), None).await?;
    let downloaded = store.get(&test_key).await;
    let deleted = store.delete(&test_key).await;
    downloaded?;
    deleted?;
    Ok(S3ConnectionTestResult {
        message: "连接、列举、写入、读取和删除权限均正常".to_string(),
    })
}

pub async fn test_read_connection(
    input: &S3SyncConfigInput,
) -> Result<S3ConnectionTestResult, String> {
    let config = S3SyncConfig::from_input(input)?;
    let provided_secret = input
        .secret_access_key
        .as_deref()
        .map(str::trim)
        .filter(|secret| !secret.is_empty())
        .map(str::to_string);
    let secret = match provided_secret {
        Some(secret) => secret,
        None => read_secret(&config)?,
    };
    let store = S3Store::new(&config, &secret)?;
    store
        .head_bucket()
        .await
        .map_err(|error| format!("{error}；请确认已授予 Bucket 级读取权限"))?;
    let objects = store.list(&config.object_prefix()).await?;
    if let Some(object) = objects
        .iter()
        .find(|object| object.key.ends_with("/snapshot.json"))
    {
        let bytes = store.get(&object.key).await?;
        DeviceUsageBundle::from_bytes(&bytes)?;
        return Ok(S3ConnectionTestResult {
            message: "Bucket、列举和快照读取权限均正常".to_string(),
        });
    }
    Ok(S3ConnectionTestResult {
        message: "Bucket 和列举权限正常；当前还没有设备快照可验证读取权限".to_string(),
    })
}

pub async fn pull_device_usage(storage: Storage) -> Result<S3DevicePullResult, String> {
    let config = load_config(&storage)?.ok_or_else(|| "尚未配置 S3 同步".to_string())?;
    let secret = read_secret(&config)?;
    let store = S3Store::new(&config, &secret)?;
    let objects = store.list(&config.object_prefix()).await?;
    let remote_objects = objects
        .into_iter()
        .filter(|object| object.key.ends_with("/snapshot.json"))
        .collect::<Vec<_>>();

    let mut bundles = Vec::new();
    let mut failure_details = Vec::new();
    for object in &remote_objects {
        let object_label = snapshot_object_label(&object.key);
        if object.size > MAX_REMOTE_BUNDLE_BYTES {
            failure_details.push(format!("{object_label}：快照超过 64 MB 限制"));
            continue;
        }
        let bundle = match store.get(&object.key).await {
            Ok(bytes) => match DeviceUsageBundle::from_bytes(&bytes) {
                Ok(bundle) => bundle,
                Err(error) => {
                    tracing::warn!(object_key = %object.key, %error, "failed to parse S3 device snapshot");
                    failure_details.push(format!("{object_label}：{error}"));
                    continue;
                }
            },
            Err(error) => {
                tracing::warn!(object_key = %object.key, %error, "failed to download S3 device snapshot");
                failure_details.push(format!("{object_label}：{error}"));
                continue;
            }
        };
        if config.snapshot_key(&bundle.snapshot.device_id) == object.key {
            crate::core::lan_sync::remember_peer(&storage, &bundle.snapshot);
            bundles.push(prefer_lan_bundle(&storage, bundle).await);
        } else {
            failure_details.push(format!("{object_label}：快照 deviceId 与对象路径不一致"));
        }
    }

    let import_storage = storage.clone();
    let import_result = tauri::async_runtime::spawn_blocking(move || {
        let mut imported_devices = 0usize;
        let mut imported_days = 0usize;
        let mut unchanged_days = 0usize;
        let mut import_failures = Vec::new();
        for bundle in bundles {
            let snapshot = bundle.snapshot;
            let device_label = snapshot.resolved_display_name();
            let result = match import_storage.import_device_usage(
                snapshot.schema_version,
                &snapshot.device_id,
                &snapshot.device_created_at,
                &snapshot.resolved_display_name(),
                &snapshot.resolved_platform(),
                &snapshot.resolved_app_version(),
                &snapshot.generated_at,
                snapshot.timezone_offset_minutes,
                &snapshot.days,
                &snapshot.hours,
                &snapshot.sessions,
                &snapshot.agents,
            ) {
                Ok(result) => result,
                Err(error) => {
                    tracing::warn!(device_id = %snapshot.device_id, %error, "failed to import S3 device snapshot");
                    import_failures.push(format!("{device_label}：导入失败：{error}"));
                    continue;
                }
            };
            imported_devices += 1;
            imported_days += result.imported_days;
            unchanged_days += result.unchanged_days;
        }
        (
            imported_devices,
            imported_days,
            unchanged_days,
            import_failures,
        )
    })
    .await
    .map_err(|_| "导入远端设备快照任务失败".to_string())?;

    failure_details.extend(import_result.3);
    Ok(S3DevicePullResult {
        remote_devices: remote_objects.len(),
        imported_devices: import_result.0,
        imported_days: import_result.1,
        unchanged_days: import_result.2,
        failed_objects: failure_details.len(),
        failure_details,
    })
}

fn snapshot_object_label(key: &str) -> String {
    key.strip_suffix("/snapshot.json")
        .and_then(|prefix| prefix.rsplit('/').next())
        .filter(|device_id| !device_id.is_empty())
        .map(|device_id| format!("设备 {device_id}"))
        .unwrap_or_else(|| "未知设备快照".to_string())
}

pub async fn run_configured_pull(storage: Storage) -> Result<S3DevicePullResult, String> {
    let _guard = acquire_sync_guard()?;
    let now = chrono::Utc::now().to_rfc3339();
    let previous = load_status(&storage);
    save_status(
        &storage,
        &S3SyncStatus {
            status: "running".to_string(),
            last_attempt_at: Some(now.clone()),
            last_success_at: previous.last_success_at.clone(),
            message: "正在读取远端设备用量".to_string(),
            remote_devices: previous.remote_devices,
            imported_devices: 0,
            imported_days: 0,
            failed_objects: 0,
            failure_details: Vec::new(),
        },
    );

    match pull_device_usage(storage.clone()).await {
        Ok(result) => {
            let status = if result.failed_objects == 0 {
                "success"
            } else {
                "partial"
            };
            save_status(
                &storage,
                &S3SyncStatus {
                    status: status.to_string(),
                    last_attempt_at: Some(now),
                    last_success_at: Some(chrono::Utc::now().to_rfc3339()),
                    message: format!(
                        "刷新完成：读取 {} 台设备，更新 {} 台，新增或更新 {} 天，{} 天未变化{}",
                        result.remote_devices,
                        result.imported_devices,
                        result.imported_days,
                        result.unchanged_days,
                        if result.failed_objects == 0 {
                            String::new()
                        } else {
                            format!("；{} 个对象失败", result.failed_objects)
                        }
                    ),
                    remote_devices: result.remote_devices,
                    imported_devices: result.imported_devices,
                    imported_days: result.imported_days,
                    failed_objects: result.failed_objects,
                    failure_details: result.failure_details.clone(),
                },
            );
            Ok(result)
        }
        Err(error) => {
            save_status(
                &storage,
                &S3SyncStatus {
                    status: "failed".to_string(),
                    last_attempt_at: Some(now),
                    last_success_at: previous.last_success_at,
                    message: error.clone(),
                    remote_devices: previous.remote_devices,
                    imported_devices: 0,
                    imported_days: 0,
                    failed_objects: 0,
                    failure_details: Vec::new(),
                },
            );
            Err(error)
        }
    }
}

pub async fn sync_device_usage(
    storage: Storage,
    identity: DeviceIdentity,
) -> Result<S3DeviceSyncResult, String> {
    let config = load_config(&storage)?.ok_or_else(|| "尚未配置 S3 同步".to_string())?;
    let secret = read_secret(&config)?;
    let store = S3Store::new(&config, &secret)?;
    let prefix = config.object_prefix();
    let current_key = config.snapshot_key(&identity.device_id);
    let objects = store.list(&prefix).await?;
    let current_etag = objects
        .iter()
        .find(|object| object.key == current_key)
        .map(|object| object.etag.clone());
    let saved_etag = storage
        .get_app_meta(CURRENT_ETAG_KEY)
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str::<CurrentEtagState>(&raw).ok())
        .filter(|state| {
            state.endpoint == config.endpoint
                && state.bucket == config.bucket
                && state.key == current_key
        });
    if let (Some(saved), Some(remote)) = (saved_etag.as_ref(), current_etag.as_ref()) {
        if saved.etag != *remote {
            return Err("远端当前设备快照已被另一个写入者修改，可能存在重复设备 ID".to_string());
        }
    }
    let remote_objects = objects
        .into_iter()
        .filter(|object| object.key != current_key && object.key.ends_with("/snapshot.json"))
        .collect::<Vec<_>>();

    let mut bundles = Vec::new();
    let mut failed_objects = 0usize;
    for object in &remote_objects {
        if object.size > MAX_REMOTE_BUNDLE_BYTES {
            failed_objects += 1;
            continue;
        }
        match store
            .get(&object.key)
            .await
            .and_then(|bytes| DeviceUsageBundle::from_bytes(&bytes))
        {
            Ok(bundle)
                if bundle.snapshot.device_id != identity.device_id
                    && config.snapshot_key(&bundle.snapshot.device_id) == object.key =>
            {
                crate::core::lan_sync::remember_peer(&storage, &bundle.snapshot);
                bundles.push(prefer_lan_bundle(&storage, bundle).await)
            }
            Ok(_) => failed_objects += 1,
            Err(_) => failed_objects += 1,
        }
    }

    let import_storage = storage.clone();
    let import_result = tauri::async_runtime::spawn_blocking(move || {
        let mut imported_devices = 0usize;
        let mut imported_days = 0usize;
        let mut unchanged_days = 0usize;
        let mut import_failures = 0usize;
        for bundle in bundles {
            let snapshot = bundle.snapshot;
            let result = match import_storage.import_device_usage(
                snapshot.schema_version,
                &snapshot.device_id,
                &snapshot.device_created_at,
                &snapshot.resolved_display_name(),
                &snapshot.resolved_platform(),
                &snapshot.resolved_app_version(),
                &snapshot.generated_at,
                snapshot.timezone_offset_minutes,
                &snapshot.days,
                &snapshot.hours,
                &snapshot.sessions,
                &snapshot.agents,
            ) {
                Ok(result) => result,
                Err(_) => {
                    import_failures += 1;
                    continue;
                }
            };
            imported_devices += 1;
            imported_days += result.imported_days;
            unchanged_days += result.unchanged_days;
        }
        Ok::<_, String>((
            imported_devices,
            imported_days,
            unchanged_days,
            import_failures,
        ))
    })
    .await
    .map_err(|_| "导入远端设备快照任务失败".to_string())??;

    let snapshot = build_device_snapshot(storage.clone(), identity.clone()).await?;
    let bundle = DeviceUsageBundle::new(snapshot);
    let bytes =
        serde_json::to_vec_pretty(&bundle).map_err(|_| "序列化当前设备快照失败".to_string())?;
    let expected_etag = saved_etag
        .as_ref()
        .map(|state| state.etag.as_str())
        .or(current_etag.as_deref());
    let uploaded_etag = match store.put(&current_key, bytes, expected_etag).await? {
        Some(etag) => Some(etag),
        None => store.head_etag(&current_key).await?,
    };
    if let Some(etag) = uploaded_etag {
        let etag_state = CurrentEtagState {
            endpoint: config.endpoint.clone(),
            bucket: config.bucket.clone(),
            key: current_key.clone(),
            etag,
        };
        if let Ok(raw) = serde_json::to_string(&etag_state) {
            let _ = storage.set_app_meta(CURRENT_ETAG_KEY, &raw);
        }
    }

    Ok(S3DeviceSyncResult {
        remote_devices: remote_objects.len(),
        imported_devices: import_result.0,
        imported_days: import_result.1,
        unchanged_days: import_result.2,
        failed_objects: failed_objects + import_result.3,
        uploaded_key: current_key,
    })
}

async fn prefer_lan_bundle(storage: &Storage, fallback: DeviceUsageBundle) -> DeviceUsageBundle {
    let Some(descriptor) = fallback.snapshot.lan_peer.as_ref() else {
        return fallback;
    };
    match crate::core::lan_sync::fetch_snapshot(descriptor).await {
        Ok(bundle)
            if bundle.validate().is_ok()
                && bundle.snapshot.device_id == fallback.snapshot.device_id
                && snapshot_is_newer(
                    &bundle.snapshot.generated_at,
                    &fallback.snapshot.generated_at,
                ) =>
        {
            crate::core::lan_sync::remember_peer(storage, &bundle.snapshot);
            tracing::debug!(device_id = %bundle.snapshot.device_id, "使用局域网直连设备快照");
            bundle
        }
        Ok(_) => fallback,
        Err(error) => {
            tracing::debug!(device_id = %fallback.snapshot.device_id, %error, "局域网快照不可用，回退 S3");
            fallback
        }
    }
}

fn snapshot_is_newer(candidate: &str, fallback: &str) -> bool {
    match (
        chrono::DateTime::parse_from_rfc3339(candidate),
        chrono::DateTime::parse_from_rfc3339(fallback),
    ) {
        (Ok(candidate), Ok(fallback)) => candidate > fallback,
        _ => false,
    }
}

pub async fn run_configured_sync(
    storage: Storage,
    identity: DeviceIdentity,
    trigger_source: &str,
) -> Result<S3DeviceSyncResult, String> {
    let _guard = acquire_sync_guard()?;
    let started_at = Instant::now();
    let job_id = create_sync_job(&storage, trigger_source)?;
    let now = chrono::Utc::now().to_rfc3339();
    let previous = load_status(&storage);
    save_status(
        &storage,
        &S3SyncStatus {
            status: "running".to_string(),
            last_attempt_at: Some(now.clone()),
            last_success_at: previous.last_success_at.clone(),
            message: "正在同步设备用量".to_string(),
            remote_devices: previous.remote_devices,
            imported_devices: 0,
            imported_days: 0,
            failed_objects: 0,
            failure_details: Vec::new(),
        },
    );

    match sync_device_usage(storage.clone(), identity).await {
        Ok(result) => {
            let status = if result.failed_objects == 0 {
                "success"
            } else {
                "partial"
            };
            save_status(
                &storage,
                &S3SyncStatus {
                    status: status.to_string(),
                    last_attempt_at: Some(now),
                    last_success_at: Some(chrono::Utc::now().to_rfc3339()),
                    message: format!(
                        "同步完成：发现 {} 台远端设备，导入 {} 天，失败 {} 个对象",
                        result.remote_devices, result.imported_days, result.failed_objects
                    ),
                    remote_devices: result.remote_devices,
                    imported_devices: result.imported_devices,
                    imported_days: result.imported_days,
                    failed_objects: result.failed_objects,
                    failure_details: Vec::new(),
                },
            );
            let duration_ms = started_at.elapsed().as_millis() as u64;
            let summary = serde_json::json!({
                "remoteDevices": result.remote_devices,
                "importedDevices": result.imported_devices,
                "importedDays": result.imported_days,
                "unchangedDays": result.unchanged_days,
                "failedObjects": result.failed_objects,
                "uploadedKey": result.uploaded_key,
                "durationMs": duration_ms,
            })
            .to_string();
            let job_status = if result.failed_objects == 0 {
                "succeeded"
            } else {
                "succeeded_with_warnings"
            };
            let _ = storage.update_job_progress(&job_id, 1, 1);
            if let Err(error) = storage.finish_job(
                &job_id,
                job_status,
                &summary,
                &format!(
                    "S3 设备同步完成：发现 {} 台远端设备，导入 {} 天，失败 {} 个对象",
                    result.remote_devices, result.imported_days, result.failed_objects
                ),
            ) {
                tracing::warn!(%error, job_id = %job_id, "failed to finish S3 device sync task log");
            }
            Ok(result)
        }
        Err(error) => {
            save_status(
                &storage,
                &S3SyncStatus {
                    status: "failed".to_string(),
                    last_attempt_at: Some(now),
                    last_success_at: previous.last_success_at,
                    message: error.clone(),
                    remote_devices: previous.remote_devices,
                    imported_devices: 0,
                    imported_days: 0,
                    failed_objects: 0,
                    failure_details: Vec::new(),
                },
            );
            if let Err(job_error) = storage.fail_job(&job_id, &error) {
                tracing::warn!(error = %job_error, job_id = %job_id, "failed to record S3 device sync task failure");
            }
            Err(error)
        }
    }
}

fn create_sync_job(storage: &Storage, trigger_source: &str) -> Result<String, String> {
    let job_id = uuid::Uuid::new_v4().to_string();
    storage
        .create_job(
            &job_id,
            "device-s3-sync",
            "S3 设备同步",
            "同步设备用量",
            trigger_source,
            1,
            "开始上传当前设备快照并读取其它设备快照",
        )
        .map_err(|error| format!("创建 S3 设备同步任务失败：{error}"))?;
    Ok(job_id)
}

pub fn save_status(storage: &Storage, status: &S3SyncStatus) {
    if let Ok(raw) = serde_json::to_string(status) {
        let _ = storage.set_app_meta(STATUS_KEY, &raw);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(endpoint: &str) -> S3SyncConfigInput {
        S3SyncConfigInput {
            endpoint: endpoint.to_string(),
            region: "auto".to_string(),
            bucket: "flowlet-sync".to_string(),
            prefix: "/users/demo/".to_string(),
            access_key_id: "access-key".to_string(),
            secret_access_key: Some("secret".to_string()),
            path_style: true,
        }
    }

    fn synced_session(id: usize, status: &str) -> SyncedAgentSession {
        SyncedAgentSession {
            agent_type: "codex-cli".to_string(),
            session_id: format!("session-{id:02}"),
            parent_session_id: None,
            runtime_status: status.to_string(),
            title: Some(format!("Session {id}")),
            client_name: Some("Codex CLI".to_string()),
            activity_at: format!("2026-07-29T12:{id:02}:00Z"),
            flowlet_observed: true,
            request_count: id as i64,
            error_count: 0,
            known_tokens: id as i64 * 100,
            last_interaction: None,
        }
    }

    #[test]
    fn normalizes_prefix_and_builds_per_device_key() {
        let config = S3SyncConfig::from_input(&input("https://example.com")).unwrap();
        assert_eq!(config.prefix, "users/demo");
        assert_eq!(
            config.snapshot_key("device-1"),
            "users/demo/flowlet/v1/devices/device-1/snapshot.json"
        );
    }

    #[test]
    fn rejects_insecure_remote_endpoint() {
        let error = S3SyncConfig::from_input(&input("http://example.com")).unwrap_err();
        assert!(error.contains("HTTPS"));
        assert!(S3SyncConfig::from_input(&input("http://127.0.0.1:9000")).is_ok());
    }

    #[test]
    fn explains_aliyun_oss_endpoint_and_region_requirements() {
        let bucket_endpoint =
            S3SyncConfig::from_input(&input("https://flowlet-sync.oss-cn-shanghai.aliyuncs.com"))
                .unwrap_err();
        assert!(bucket_endpoint.contains("不应包含 Bucket 名"));

        let auto_region =
            S3SyncConfig::from_input(&input("https://s3.oss-cn-shanghai.aliyuncs.com"))
                .unwrap_err();
        assert!(auto_region.contains("不能使用 auto"));

        let non_s3_endpoint =
            S3SyncConfig::from_input(&input("https://oss-cn-shanghai.aliyuncs.com")).unwrap_err();
        assert!(non_s3_endpoint.contains("S3-compatible Endpoint"));

        let mut valid = input("https://s3.oss-cn-shanghai.aliyuncs.com");
        valid.region = "cn-shanghai".to_string();
        valid.path_style = false;
        let config = S3SyncConfig::from_input(&valid).unwrap();
        assert!(!config.supports_conditional_put());
        assert!(
            S3SyncConfig::from_input(&input("https://example.com"))
                .unwrap()
                .supports_conditional_put()
        );
    }

    #[test]
    fn extracts_safe_s3_error_identifiers() {
        let body = "<Error><Code>InvalidArgument</Code><Message>unsupported header</Message><RequestId>abc-123</RequestId><AccessKeyId>do-not-copy</AccessKeyId></Error>";
        let detail = s3_error_detail(body);
        assert_eq!(detail, "，Code: InvalidArgument，RequestId: abc-123");
        assert!(!detail.contains("AccessKeyId"));
        assert!(!detail.contains("unsupported header"));
    }

    #[test]
    fn sync_guard_rejects_overlap_and_recovers_after_drop() {
        let first = acquire_sync_guard().unwrap();
        assert_eq!(
            acquire_sync_guard().unwrap_err(),
            SYNC_ALREADY_RUNNING_ERROR
        );
        drop(first);
        assert!(acquire_sync_guard().is_ok());
    }

    #[test]
    fn creates_device_sync_task_log_with_trigger_source() {
        let storage =
            Storage::from_connection_for_test(rusqlite::Connection::open_in_memory().unwrap());
        storage.migrate().unwrap();
        let job_id = create_sync_job(&storage, "background").unwrap();
        let detail = storage.get_background_job_detail(&job_id).unwrap().unwrap();
        assert_eq!(detail.job.job_type, "device-s3-sync");
        assert_eq!(detail.job.title, "S3 设备同步");
        assert_eq!(detail.job.trigger_source, "background");
        assert_eq!(detail.job.status, "running");
        assert_eq!(detail.job.progress_total, 1);
        assert_eq!(detail.events.len(), 1);
    }

    #[test]
    fn persisted_config_never_contains_secret_access_key() {
        let config = S3SyncConfig::from_input(&input("https://example.com")).unwrap();
        let serialized = serde_json::to_string(&config).unwrap();
        assert!(!serialized.contains("secret"));
        assert!(!serialized.contains("secretAccessKey"));
    }

    #[test]
    fn old_sync_status_deserializes_without_failure_details() {
        let status: S3SyncStatus = serde_json::from_value(serde_json::json!({
            "status": "partial",
            "lastAttemptAt": "2026-07-29T19:20:54Z",
            "lastSuccessAt": "2026-07-29T19:20:54Z",
            "message": "刷新完成",
            "remoteDevices": 2,
            "importedDevices": 1,
            "importedDays": 0,
            "failedObjects": 1
        }))
        .unwrap();
        assert!(status.failure_details.is_empty());
        assert_eq!(
            snapshot_object_label("users/demo/flowlet/v1/devices/device-1/snapshot.json"),
            "设备 device-1"
        );
    }

    #[test]
    fn session_snapshot_keeps_all_active_when_more_than_ten() {
        let sessions = (0..12)
            .map(|index| {
                synced_session(
                    index,
                    if index % 2 == 0 {
                        "running"
                    } else {
                        "waiting_user"
                    },
                )
            })
            .chain((12..18).map(|index| synced_session(index, "idle")))
            .collect();
        let selected = select_sessions_for_sync(sessions);
        assert_eq!(selected.len(), 12);
        assert!(
            selected
                .iter()
                .all(|row| matches!(row.runtime_status.as_str(), "running" | "waiting_user"))
        );
    }

    #[test]
    fn session_snapshot_fills_active_sessions_to_ten_by_recency() {
        let sessions = (0..3)
            .map(|index| synced_session(index, "running"))
            .chain((3..15).map(|index| synced_session(index, "idle")))
            .collect();
        let selected = select_sessions_for_sync(sessions);
        assert_eq!(selected.len(), 10);
        assert_eq!(
            selected
                .iter()
                .filter(|row| row.runtime_status == "running")
                .count(),
            3
        );
        let idle_ids = selected
            .iter()
            .filter(|row| row.runtime_status == "idle")
            .map(|row| row.session_id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            idle_ids,
            vec![
                "session-14",
                "session-13",
                "session-12",
                "session-11",
                "session-10",
                "session-09",
                "session-08",
            ]
        );
    }
}
