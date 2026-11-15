use crate::core::device_identity::DeviceUsageBundle;
use crate::core::storage::Storage;
use reqwest::{Client, Response};
use rusty_s3::actions::{ListObjectsV2, S3Action as _};
use rusty_s3::{Bucket, Credentials, UrlStyle};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::time::Duration;
use url::Url;

const CONFIG_KEY: &str = "device_sync_s3_config_v1";
const STATUS_KEY: &str = "device_sync_s3_status_v1";
const KEYRING_SERVICE: &str = "Flowlet Device Sync";
const MAX_REMOTE_BUNDLE_BYTES: u64 = 64 * 1024 * 1024;
const SIGNED_URL_TTL: Duration = Duration::from_secs(60);
pub const AUTO_SYNC_INITIAL_DELAY: Duration = Duration::from_secs(5);
/// 移动端后台 S3-only 拉取周期。与桌面端 15 分钟上传周期独立；
/// 移动端不做 LAN 直连，只做云端拉取。
pub const MOBILE_AUTO_SYNC_INTERVAL: Duration = Duration::from_secs(5 * 60);
pub const SYNC_ALREADY_RUNNING_ERROR: &str = "设备用量同步正在运行";

fn acquire_sync_lease(
    jobs: &crate::core::job_runtime::JobRuntime,
    definition: &'static crate::core::job_runtime::JobDefinition,
) -> Result<crate::core::job_runtime::JobLease, String> {
    jobs.try_acquire_definition(definition)
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRefreshResult {
    pub source: String,
    pub refreshed_devices: usize,
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

    pub(crate) fn credential_username(&self) -> String {
        let mut digest = Sha256::new();
        digest.update(self.endpoint.as_bytes());
        digest.update(b"\0");
        digest.update(self.bucket.as_bytes());
        digest.update(b"\0");
        digest.update(self.access_key_id.as_bytes());
        format!("s3-{}", hex::encode(digest.finalize()))
    }
}

pub(crate) struct S3Store {
    bucket: Bucket,
    credentials: Credentials,
    client: Client,
}

impl S3Store {
    async fn head_bucket(&self) -> Result<(), String> {
        let url = self
            .bucket
            .head_bucket(Some(&self.credentials))
            .sign(SIGNED_URL_TTL);
        checked_response(self.client.head(url).send().await, "检查 Bucket").await?;
        Ok(())
    }

    pub(crate) fn new(config: &S3SyncConfig, secret: &str) -> Result<Self, String> {
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
        })
    }

    pub(crate) async fn list(&self, prefix: &str) -> Result<Vec<RemoteObject>, String> {
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
                size: object.size,
            }));
            continuation = parsed.next_continuation_token;
            if continuation.is_none() {
                break;
            }
        }
        Ok(objects)
    }

    pub(crate) async fn get(&self, key: &str) -> Result<Vec<u8>, String> {
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
}

pub(crate) struct RemoteObject {
    pub(crate) key: String,
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

pub(crate) fn read_secret(config: &S3SyncConfig) -> Result<String, String> {
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

pub async fn pull_device_usage(
    storage: Storage,
    prefer_lan: bool,
) -> Result<S3DevicePullResult, String> {
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
            // prefer_lan = false 时跳过局域网直连，仅使用 S3 快照；
            // 手动刷新等用户主动场景才允许 LAN 优先。
            if prefer_lan {
                bundles.push(prefer_lan_bundle(&storage, bundle).await);
            } else {
                bundles.push(bundle);
            }
        } else {
            failure_details.push(format!("{object_label}：快照 deviceId 与对象路径不一致"));
        }
    }

    let import_storage = storage.clone();
    let import_result = tokio::task::spawn_blocking(move || {
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
            if let Err(error) = import_storage.import_device_usage_breakdowns(
                &snapshot.device_id,
                &snapshot.generated_at,
                &snapshot.usage_breakdowns,
            ) {
                tracing::warn!(device_id = %snapshot.device_id, %error, "failed to import S3 device breakdowns");
            }
            if let Err(error) = import_storage.import_device_account_resources(
                &snapshot.device_id,
                &snapshot.generated_at,
                &snapshot.account_resources,
            ) {
                tracing::warn!(device_id = %snapshot.device_id, %error, "failed to import S3 account resources");
                import_failures.push(format!("{device_label}：账号资源导入失败：{error}"));
            }
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

async fn pull_device_usage_for_device(
    storage: Storage,
    device_id: &str,
) -> Result<S3DevicePullResult, String> {
    let device_id = device_id.trim();
    if device_id.is_empty() {
        return Err("设备 ID 不能为空".to_string());
    }
    let config = load_config(&storage)?.ok_or_else(|| "尚未配置 S3 同步".to_string())?;
    let secret = read_secret(&config)?;
    let store = S3Store::new(&config, &secret)?;
    let object_key = config.snapshot_key(device_id);
    let bytes = store.get(&object_key).await?;
    let bundle = DeviceUsageBundle::from_bytes(&bytes)?;
    if bundle.snapshot.device_id != device_id
        || config.snapshot_key(&bundle.snapshot.device_id) != object_key
    {
        return Err("S3 快照 deviceId 与当前设备不一致".to_string());
    }
    crate::core::lan_sync::remember_peer(&storage, &bundle.snapshot);
    let snapshot = bundle.snapshot;
    let import_storage = storage.clone();
    let pull_result = tokio::task::spawn_blocking(move || {
        let result = import_storage
            .import_device_usage(
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
            )
            .map_err(|error| error.to_string())?;
        import_storage
            .import_device_usage_breakdowns(
                &snapshot.device_id,
                &snapshot.generated_at,
                &snapshot.usage_breakdowns,
            )
            .map_err(|error| error.to_string())?;
        import_storage
            .import_device_account_resources(
                &snapshot.device_id,
                &snapshot.generated_at,
                &snapshot.account_resources,
            )
            .map_err(|error| error.to_string())?;
        Ok::<_, String>(result)
    })
    .await
    .map_err(|_| "导入指定设备 S3 快照任务失败".to_string())??;
    Ok(S3DevicePullResult {
        remote_devices: 1,
        imported_devices: 1,
        imported_days: pull_result.imported_days,
        unchanged_days: pull_result.unchanged_days,
        failed_objects: 0,
        failure_details: Vec::new(),
    })
}

/// 移动端页面的指定设备刷新：先直接请求该设备的 LAN 快照；只有直连没有
/// 成功更新时才读取该设备唯一的 S3 对象，不列举或下载其他设备。
pub async fn refresh_device(
    storage: Storage,
    jobs: &crate::core::job_runtime::JobRuntime,
    device_id: &str,
) -> Result<DeviceRefreshResult, String> {
    let device_id = device_id.trim();
    if device_id.is_empty() {
        return Err("设备 ID 不能为空".to_string());
    }
    let lan = crate::core::lan_sync::refresh_known_peers(storage.clone(), Some(device_id)).await?;
    if lan.refreshed_devices > 0 {
        return Ok(DeviceRefreshResult {
            source: "lan".to_string(),
            refreshed_devices: lan.refreshed_devices,
        });
    }

    let _lease = acquire_sync_lease(jobs, &crate::core::job_runtime::DEVICE_S3_PULL)?;
    let result = pull_device_usage_for_device(storage, device_id).await?;
    Ok(DeviceRefreshResult {
        source: "s3".to_string(),
        refreshed_devices: result.imported_devices,
    })
}

fn snapshot_object_label(key: &str) -> String {
    key.strip_suffix("/snapshot.json")
        .and_then(|prefix| prefix.rsplit('/').next())
        .filter(|device_id| !device_id.is_empty())
        .map(|device_id| format!("设备 {device_id}"))
        .unwrap_or_else(|| "未知设备快照".to_string())
}

pub async fn run_configured_pull(
    storage: Storage,
    jobs: &crate::core::job_runtime::JobRuntime,
    prefer_lan: bool,
) -> Result<S3DevicePullResult, String> {
    let _lease = acquire_sync_lease(jobs, &crate::core::job_runtime::DEVICE_S3_PULL)?;
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

    match pull_device_usage(storage.clone(), prefer_lan).await {
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

pub fn save_status(storage: &Storage, status: &S3SyncStatus) {
    if let Ok(raw) = serde_json::to_string(status) {
        let _ = storage.set_app_meta(STATUS_KEY, &raw);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn mobile_s3_client_only_reads_signed_bucket_list_and_snapshot() {
        let (endpoint, server) = crate::core::test_http::serve(3, |request| {
            let line = request.lines().next().unwrap();
            assert!(line.to_lowercase().contains("x-amz-signature="));
            if line.starts_with("HEAD ") {
                return (200, Vec::new());
            }
            assert!(line.starts_with("GET "), "mobile S3 must not write: {line}");
            if line.contains("snapshot.json") {
                (
                    200,
                    include_bytes!("../../../tests/fixtures/mobile/device-usage-v13.json").to_vec(),
                )
            } else {
                (200, br#"<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>mobile-test</Name><Prefix>flowlet/v1/devices/</Prefix><KeyCount>1</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated><Contents><Key>flowlet/v1/devices/1411a7d7-55d8-4024-8363-95858788aa91/snapshot.json</Key><LastModified>2026-11-15T00:00:00Z</LastModified><ETag>"test"</ETag><Size>1024</Size><StorageClass>STANDARD</StorageClass></Contents></ListBucketResult>"#.to_vec())
            }
        });
        let config = S3SyncConfig::from_input(&input(&endpoint)).unwrap();
        let store = S3Store::new(&config, "fixture-secret").unwrap();
        store.head_bucket().await.unwrap();
        let objects = store.list("flowlet/v1/devices/").await.unwrap();
        assert_eq!(objects.len(), 1);
        let raw = store.get(&objects[0].key).await.unwrap();
        let bundle = DeviceUsageBundle::from_bytes(&raw).unwrap();
        assert_eq!(bundle.snapshot.days[0].known_tokens, 42);
        server.join().unwrap();
    }

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
        assert!(S3SyncConfig::from_input(&valid).is_ok());
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
    fn sync_runtime_rejects_overlap_and_recovers_after_drop() {
        let jobs = crate::core::job_runtime::JobRuntime::default();
        let first = acquire_sync_lease(&jobs, &crate::core::job_runtime::DEVICE_S3_PULL).unwrap();
        assert_eq!(
            acquire_sync_lease(&jobs, &crate::core::job_runtime::DEVICE_S3_PULL).unwrap_err(),
            SYNC_ALREADY_RUNNING_ERROR
        );
        drop(first);
        assert!(acquire_sync_lease(&jobs, &crate::core::job_runtime::DEVICE_S3_PULL).is_ok());
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
    fn imported_account_resources_merge_devices_by_latest_observation() {
        use crate::core::device_identity::SyncedAccountResource;

        let storage =
            Storage::from_connection_for_test(rusqlite::Connection::open_in_memory().unwrap());
        storage.migrate().unwrap();
        let resource = |balance: f64, observed_at: &str| SyncedAccountResource {
            account_id: "workspace-account-1".to_string(),
            channel_id: "deepseek".to_string(),
            channel_name: "DeepSeek".to_string(),
            account_name: "共享账号".to_string(),
            plan: Some("pay_as_you_go".to_string()),
            balance: Some(balance),
            balance_text: None,
            currency: Some("CNY".to_string()),
            token_total: None,
            token_used: None,
            token_remaining: None,
            expires_at: None,
            quota_windows: vec![],
            observed_at: observed_at.to_string(),
            stale: false,
        };
        for (device_id, generated_at) in [
            (
                "8d58734f-0b71-49ea-b5a4-115b389a9ae7",
                "2026-08-12T10:00:00Z",
            ),
            (
                "bc1a66f9-7281-4cf8-b64c-20a449394a2b",
                "2026-08-12T10:05:00Z",
            ),
        ] {
            storage
                .import_device_usage(
                    13,
                    device_id,
                    "2026-08-01T00:00:00Z",
                    device_id,
                    "windows",
                    "0.1.0",
                    generated_at,
                    480,
                    &[],
                    &[],
                    &[],
                    &[],
                )
                .unwrap();
        }
        storage
            .import_device_account_resources(
                "8d58734f-0b71-49ea-b5a4-115b389a9ae7",
                "2026-08-12T10:00:00Z",
                &[resource(10.0, "2026-08-12T09:00:00Z")],
            )
            .unwrap();
        storage
            .import_device_account_resources(
                "bc1a66f9-7281-4cf8-b64c-20a449394a2b",
                "2026-08-12T10:05:00Z",
                &[resource(20.0, "2026-08-12T09:30:00Z")],
            )
            .unwrap();

        let merged = storage.imported_account_resources().unwrap();
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].balance, Some(20.0));
    }

    #[test]
    fn imported_codex_resources_merge_different_ids_by_normalized_email() {
        use crate::core::device_identity::{SyncedAccountQuotaWindow, SyncedAccountResource};

        let storage =
            Storage::from_connection_for_test(rusqlite::Connection::open_in_memory().unwrap());
        storage.migrate().unwrap();
        let resource = |account_id: &str, email: &str, remaining: f64, observed_at: &str| {
            SyncedAccountResource {
                account_id: account_id.to_string(),
                channel_id: "chatgpt".to_string(),
                channel_name: "ChatGPT".to_string(),
                account_name: email.to_string(),
                plan: Some("plus".to_string()),
                balance: None,
                balance_text: None,
                currency: None,
                token_total: None,
                token_used: None,
                token_remaining: None,
                expires_at: None,
                quota_windows: vec![SyncedAccountQuotaWindow {
                    label: "7 天".to_string(),
                    used_percent: 100.0 - remaining,
                    resets_at: None,
                }],
                observed_at: observed_at.to_string(),
                stale: false,
            }
        };
        for (device_id, generated_at) in [
            ("device-a", "2026-08-12T10:00:00Z"),
            ("device-b", "2026-08-12T10:05:00Z"),
        ] {
            storage
                .import_device_usage(
                    13,
                    device_id,
                    "2026-08-01T00:00:00Z",
                    device_id,
                    "windows",
                    "0.1.0",
                    generated_at,
                    480,
                    &[],
                    &[],
                    &[],
                    &[],
                )
                .unwrap();
        }
        storage
            .import_device_account_resources(
                "device-a",
                "2026-08-12T10:00:00Z",
                &[resource(
                    "codex:oauth-id",
                    "User@Example.com",
                    19.0,
                    "2026-08-12T09:00:00Z",
                )],
            )
            .unwrap();
        storage
            .import_device_account_resources(
                "device-b",
                "2026-08-12T10:05:00Z",
                &[resource(
                    "codex:app-server-id",
                    " user@example.com ",
                    37.0,
                    "2026-08-12T09:30:00Z",
                )],
            )
            .unwrap();

        let merged = storage.imported_account_resources().unwrap();
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].account_id, "codex:app-server-id");
        assert_eq!(merged[0].quota_windows[0].used_percent, 63.0);
    }
}
