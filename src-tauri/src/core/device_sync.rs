use crate::core::device_identity::{DeviceIdentity, DeviceUsageBundle, DeviceUsageSnapshot};
use crate::core::storage::Storage;
use reqwest::{Client, Response, StatusCode};
use rusty_s3::actions::{ListObjectsV2, S3Action as _};
use rusty_s3::{Bucket, Credentials, UrlStyle};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use url::Url;

const CONFIG_KEY: &str = "device_sync_s3_config_v1";
const STATUS_KEY: &str = "device_sync_s3_status_v1";
const CURRENT_ETAG_KEY: &str = "device_sync_s3_current_etag_v1";
const KEYRING_SERVICE: &str = "Flowlet Device Sync";
const MAX_REMOTE_BUNDLE_BYTES: u64 = 4 * 1024 * 1024;
const SIGNED_URL_TTL: Duration = Duration::from_secs(60);
static SYNC_RUNNING: AtomicBool = AtomicBool::new(false);

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
        .map_err(|_| "设备用量同步正在运行".to_string())
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

#[derive(Deserialize)]
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
            && !matches!(endpoint_url.host_str(), Some("localhost" | "127.0.0.1" | "::1"))
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
}

impl S3Store {
    fn new(config: &S3SyncConfig, secret: &str) -> Result<Self, String> {
        let endpoint = Url::parse(&config.endpoint).map_err(|_| "S3 Endpoint 格式无效".to_string())?;
        let style = if config.path_style {
            UrlStyle::Path
        } else {
            UrlStyle::VirtualHost
        };
        let bucket = Bucket::new(endpoint, style, config.bucket.clone(), config.region.clone())
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
            return Err("远端设备快照超过 4 MB 限制".to_string());
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|_| "读取远端设备快照失败".to_string())?;
        if bytes.len() as u64 > MAX_REMOTE_BUNDLE_BYTES {
            return Err("远端设备快照超过 4 MB 限制".to_string());
        }
        Ok(bytes.to_vec())
    }

    async fn head_etag(&self, key: &str) -> Result<Option<String>, String> {
        let url = self
            .bucket
            .head_object(Some(&self.credentials), key)
            .sign(SIGNED_URL_TTL);
        let response = checked_response(self.client.head(url).send().await, "读取对象元信息").await?;
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
        let mut action = self.bucket.put_object(Some(&self.credentials), key);
        action
            .headers_mut()
            .insert("content-type", "application/json");
        if let Some(etag) = etag {
            action.headers_mut().insert("if-match", etag.to_string());
        }
        let url = action.sign(SIGNED_URL_TTL);
        let mut request = self
            .client
            .put(url)
            .header("content-type", "application/json")
            .body(body);
        if let Some(etag) = etag {
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
    Err(format!("{action}失败（HTTP {}）", response.status().as_u16()))
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

pub async fn test_connection(
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
    store.head_bucket().await?;
    let test_prefix = if config.prefix.is_empty() {
        "flowlet/v1/tests/".to_string()
    } else {
        format!("{}/flowlet/v1/tests/", config.prefix)
    };
    store.list(&test_prefix).await?;
    let test_key = format!(
        "{}{}.json",
        test_prefix,
        uuid::Uuid::new_v4()
    );
    store.put(&test_key, b"{}".to_vec(), None).await?;
    let downloaded = store.get(&test_key).await;
    let deleted = store.delete(&test_key).await;
    downloaded?;
    deleted?;
    Ok(S3ConnectionTestResult {
        message: "连接、列举、写入、读取和删除权限均正常".to_string(),
    })
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
            return Err(
                "远端当前设备快照已被另一个写入者修改，可能存在重复设备 ID".to_string(),
            );
        }
    }
    let remote_objects = objects
        .into_iter()
        .filter(|object| {
            object.key != current_key
                && object.key.ends_with("/snapshot.json")
        })
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
                bundles.push(bundle)
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
                    &snapshot.device_id,
                    &snapshot.device_created_at,
                    &snapshot.resolved_display_name(),
                    &snapshot.resolved_platform(),
                    &snapshot.resolved_app_version(),
                    &snapshot.generated_at,
                    snapshot.timezone_offset_minutes,
                    &snapshot.days,
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

    let days_storage = storage.clone();
    let days = tauri::async_runtime::spawn_blocking(move || days_storage.daily_usage_totals())
        .await
        .map_err(|_| "生成当前设备快照任务失败".to_string())?
        .map_err(|error| error.to_string())?;
    let bundle = DeviceUsageBundle::new(DeviceUsageSnapshot::new(&identity, days));
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
    fn persisted_config_never_contains_secret_access_key() {
        let config = S3SyncConfig::from_input(&input("https://example.com")).unwrap();
        let serialized = serde_json::to_string(&config).unwrap();
        assert!(!serialized.contains("secret"));
        assert!(!serialized.contains("secretAccessKey"));
    }
}
