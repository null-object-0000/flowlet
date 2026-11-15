use crate::core::device_identity::{
    DeviceUsageBundle, DeviceUsageSnapshot, LanPeerDescriptor, SyncedAgentSession,
};
use crate::core::opencode_control::{OpenCodePermissionDecision, OpenCodePermissionReport};
use crate::core::storage::Storage;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    ChaCha20Poly1305, Nonce,
};
use chrono::Utc;
use hmac::{Hmac, Mac};
use reqwest::{Method, StatusCode};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::Sha256;
use std::{collections::HashMap, time::Duration};

const LAN_PEERS_KEY: &str = "device_lan_peers_v1";
const PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EncryptedPayload {
    nonce: String,
    ciphertext: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionReadInput {
    agent_type: String,
    session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LanSessionSnapshot {
    pub generated_at: String,
    pub session: SyncedAgentSession,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PingResponse {
    device_id: String,
    protocol_version: u32,
    capabilities: Vec<String>,
    server_time: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct PeerRegistry(HashMap<String, LanPeerDescriptor>);

pub fn remember_peer(storage: &Storage, snapshot: &DeviceUsageSnapshot) {
    let Some(descriptor) = snapshot.lan_peer.clone() else {
        return;
    };
    let mut registry = load_peer_registry(storage);
    registry.0.insert(snapshot.device_id.clone(), descriptor);
    if let Ok(raw) = serde_json::to_string(&registry) {
        let _ = storage.set_app_meta(LAN_PEERS_KEY, &raw);
    }
}

pub fn peer_descriptor(storage: &Storage, device_id: &str) -> Option<LanPeerDescriptor> {
    load_peer_registry(storage)
        .0
        .remove(device_id)
        .filter(descriptor_is_fresh)
}

fn load_peer_registry(storage: &Storage) -> PeerRegistry {
    storage
        .get_app_meta(LAN_PEERS_KEY)
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn descriptor_is_fresh(descriptor: &LanPeerDescriptor) -> bool {
    chrono::DateTime::parse_from_rfc3339(&descriptor.expires_at)
        .map(|expires| expires > Utc::now())
        .unwrap_or(false)
        && descriptor.protocol_version == PROTOCOL_VERSION
        && descriptor_key(descriptor).is_ok()
        && descriptor
            .endpoints
            .iter()
            .any(|endpoint| validate_endpoint(endpoint).is_ok())
}

fn sign(
    key: &[u8; 32],
    method: &str,
    path: &str,
    timestamp: &str,
    nonce: &str,
    body: &[u8],
) -> Result<Vec<u8>, String> {
    let mut mac =
        <Hmac<Sha256> as Mac>::new_from_slice(key).map_err(|_| "局域网密钥无效".to_string())?;
    mac.update(&signature_payload(method, path, timestamp, nonce, body));
    Ok(mac.finalize().into_bytes().to_vec())
}

fn signature_payload(
    method: &str,
    path: &str,
    timestamp: &str,
    nonce: &str,
    body: &[u8],
) -> Vec<u8> {
    let mut payload = format!("{method}\n{path}\n{timestamp}\n{nonce}\n").into_bytes();
    payload.extend_from_slice(body);
    payload
}

fn decrypt<T: DeserializeOwned>(
    key: &[u8; 32],
    aad: &[u8],
    payload: EncryptedPayload,
) -> Result<T, String> {
    let nonce = BASE64
        .decode(payload.nonce)
        .map_err(|_| "局域网响应 nonce 无效".to_string())?;
    if nonce.len() != 12 {
        return Err("局域网响应 nonce 长度无效".to_string());
    }
    let ciphertext = BASE64
        .decode(payload.ciphertext)
        .map_err(|_| "局域网响应正文无效".to_string())?;
    let cipher = ChaCha20Poly1305::new_from_slice(key).map_err(|_| "局域网密钥无效".to_string())?;
    let plain = cipher
        .decrypt(
            Nonce::from_slice(&nonce),
            chacha20poly1305::aead::Payload {
                msg: &ciphertext,
                aad,
            },
        )
        .map_err(|_| "局域网响应认证失败".to_string())?;
    serde_json::from_slice(&plain).map_err(|error| format!("解析局域网响应失败：{error}"))
}

/// 签名直连请求的错误分类。探测与状态展示依赖这个区分
/// 「设备不在线」和「连接信息失效」，而不是只给用户一行字符串。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LanProbeErrorKind {
    Unreachable,
    Unauthorized,
    Outdated,
    Invalid,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SignedRequestErrorKind {
    Unreachable,
    Invalid,
}

#[derive(Debug)]
struct SignedRequestError {
    kind: SignedRequestErrorKind,
    message: String,
}

impl SignedRequestError {
    fn unreachable(message: String) -> Self {
        Self {
            kind: SignedRequestErrorKind::Unreachable,
            message,
        }
    }

    fn invalid(message: String) -> Self {
        Self {
            kind: SignedRequestErrorKind::Invalid,
            message,
        }
    }
}

async fn send_signed(
    descriptor: &LanPeerDescriptor,
    endpoint: &str,
    method: Method,
    path: &str,
    body: Vec<u8>,
) -> Result<(reqwest::Response, [u8; 32], String), SignedRequestError> {
    validate_endpoint(endpoint).map_err(SignedRequestError::invalid)?;
    let key = descriptor_key(descriptor).map_err(SignedRequestError::invalid)?;
    let timestamp = Utc::now().timestamp().to_string();
    let nonce = uuid::Uuid::new_v4().to_string();
    let signature = sign(&key, method.as_str(), path, &timestamp, &nonce, &body)
        .map_err(SignedRequestError::invalid)?;
    let url = format!("{}{}", endpoint.trim_end_matches('/'), path);
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_millis(500))
        .timeout(Duration::from_secs(3))
        .build()
        .map_err(|error| SignedRequestError::invalid(error.to_string()))?;
    let response = client
        .request(method, url)
        .header("x-flowlet-timestamp", &timestamp)
        .header("x-flowlet-nonce", &nonce)
        .header("x-flowlet-signature", hex::encode(signature))
        .header("content-type", "application/json")
        .body(body)
        .send()
        .await
        .map_err(|error| SignedRequestError::unreachable(format!("局域网设备不可达：{error}")))?;
    Ok((response, key, nonce))
}

async fn request<T: DeserializeOwned>(
    descriptor: &LanPeerDescriptor,
    endpoint: &str,
    method: Method,
    path: &str,
    body: Vec<u8>,
) -> Result<T, String> {
    let (response, key, nonce) = send_signed(descriptor, endpoint, method, path, body)
        .await
        .map_err(|error| error.message)?;
    if !response.status().is_success() {
        return Err(format!("局域网设备返回 HTTP {}", response.status()));
    }
    let payload = response
        .json::<EncryptedPayload>()
        .await
        .map_err(|error| format!("读取局域网响应失败：{error}"))?;
    decrypt(&key, nonce.as_bytes(), payload)
}

pub async fn fetch_snapshot(descriptor: &LanPeerDescriptor) -> Result<DeviceUsageBundle, String> {
    let mut last_error = "没有可用的局域网端点".to_string();
    for endpoint in &descriptor.endpoints {
        match request(
            descriptor,
            endpoint,
            Method::GET,
            "/flowlet/v1/snapshot",
            Vec::new(),
        )
        .await
        {
            Ok(bundle) => return Ok(bundle),
            Err(error) => last_error = error,
        }
    }
    Err(last_error)
}

pub async fn fetch_session(
    storage: &Storage,
    device_id: &str,
    agent_type: &str,
    session_id: &str,
) -> Result<LanSessionSnapshot, String> {
    let peer = peer_descriptor(storage, device_id)
        .ok_or_else(|| "目标设备没有可用的局域网连接信息".to_string())?;
    let path = "/flowlet/v1/session/read";
    let body = serde_json::to_vec(&SessionReadInput {
        agent_type: agent_type.to_string(),
        session_id: session_id.to_string(),
    })
    .map_err(|error| error.to_string())?;
    let mut last_error = "没有可用的局域网端点".to_string();
    for endpoint in &peer.endpoints {
        match request(&peer, endpoint, Method::POST, path, body.clone()).await {
            Ok(snapshot) => return Ok(snapshot),
            Err(error) => last_error = error,
        }
    }
    Err(last_error)
}
/// 单台设备的直连探测结果。移动端与桌面端共用同一份结构展示
/// 「能不能连上这台设备」。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LanPeerProbe {
    pub device_id: String,
    /// 设备是否在 S3 快照中发布过有效的局域网描述符。
    pub lan_published: bool,
    /// ping 是否成功。发布过但 ping 不通通常意味着不在同一局域网
    /// 或防火墙拦截。
    pub reachable: bool,
    pub latency_ms: Option<u64>,
    pub protocol_version: Option<u32>,
    pub error_kind: Option<LanProbeErrorKind>,
    pub error: Option<String>,
}

pub async fn probe_peer(descriptor: &LanPeerDescriptor, expected_device_id: &str) -> LanPeerProbe {
    let mut probe = LanPeerProbe {
        device_id: expected_device_id.to_string(),
        lan_published: true,
        reachable: false,
        latency_ms: None,
        protocol_version: None,
        error_kind: None,
        error: None,
    };
    let mut last_error: Option<(LanProbeErrorKind, String)> = None;
    for endpoint in &descriptor.endpoints {
        let started = std::time::Instant::now();
        let result = send_signed(
            descriptor,
            endpoint,
            Method::GET,
            "/flowlet/v1/ping",
            Vec::new(),
        )
        .await;
        let (response, key, nonce) = match result {
            Ok(parts) => parts,
            Err(error) => {
                let kind = match error.kind {
                    SignedRequestErrorKind::Unreachable => LanProbeErrorKind::Unreachable,
                    SignedRequestErrorKind::Invalid => LanProbeErrorKind::Invalid,
                };
                last_error = Some((kind, error.message));
                continue;
            }
        };
        let status = response.status();
        if status == StatusCode::UNAUTHORIZED {
            last_error = Some((
                LanProbeErrorKind::Unauthorized,
                "局域网认证失败，连接信息可能已过期".to_string(),
            ));
            continue;
        }
        if status == StatusCode::NOT_FOUND {
            // 旧版本对端没有 ping 端点，只能提示升级。
            last_error = Some((
                LanProbeErrorKind::Outdated,
                "对端版本过旧，缺少 ping 端点".to_string(),
            ));
            continue;
        }
        if !status.is_success() {
            last_error = Some((
                LanProbeErrorKind::Invalid,
                format!("局域网设备返回 HTTP {status}"),
            ));
            continue;
        }
        let payload = match response.json::<EncryptedPayload>().await {
            Ok(payload) => payload,
            Err(error) => {
                last_error = Some((
                    LanProbeErrorKind::Invalid,
                    format!("读取局域网响应失败：{error}"),
                ));
                continue;
            }
        };
        match decrypt::<PingResponse>(&key, nonce.as_bytes(), payload) {
            Ok(pong) => {
                probe.reachable = true;
                probe.latency_ms = Some(started.elapsed().as_millis() as u64);
                probe.protocol_version = Some(pong.protocol_version);
                probe.device_id = pong.device_id;
                return probe;
            }
            Err(error) => {
                last_error = Some((LanProbeErrorKind::Invalid, error));
            }
        }
    }
    if let Some((kind, message)) = last_error {
        probe.error_kind = Some(kind);
        probe.error = Some(message);
    }
    probe
}

/// 对 registry 中全部（或指定）已知 peer 做并发 ping 探测。
/// 未发布有效描述符的设备也返回结果，`lan_published = false`，
/// 这样前端可以区分「对方没开直连」和「开了但连不上」。
pub async fn probe_lan_peers(storage: &Storage, device_id: Option<&str>) -> Vec<LanPeerProbe> {
    let registry = load_peer_registry(storage).0;
    let mut tasks = Vec::new();
    let mut probes = Vec::new();
    for (id, descriptor) in registry {
        if let Some(wanted) = device_id {
            if wanted != id {
                continue;
            }
        }
        if !descriptor_is_fresh(&descriptor) {
            probes.push(LanPeerProbe {
                device_id: id,
                lan_published: false,
                reachable: false,
                latency_ms: None,
                protocol_version: None,
                error_kind: None,
                error: None,
            });
            continue;
        }
        tasks.push(tokio::task::spawn(async move {
            probe_peer(&descriptor, &id).await
        }));
    }
    for task in tasks {
        if let Ok(probe) = task.await {
            probes.push(probe);
        }
    }
    probes.sort_by(|a, b| a.device_id.cmp(&b.device_id));
    probes
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanRefreshResult {
    pub attempted_devices: usize,
    pub refreshed_devices: usize,
    pub failed_devices: usize,
}

pub async fn refresh_known_peers(
    storage: Storage,
    device_id: Option<&str>,
) -> Result<LanRefreshResult, String> {
    let peers = load_peer_registry(&storage)
        .0
        .into_iter()
        .filter(|(id, descriptor)| {
            device_id.is_none_or(|wanted| wanted == id) && descriptor_is_fresh(descriptor)
        })
        .collect::<Vec<_>>();
    let attempted_devices = peers.len();
    let mut bundles = Vec::new();
    let mut failed_devices = 0usize;
    for (expected_device_id, descriptor) in peers {
        match fetch_snapshot(&descriptor).await {
            Ok(bundle)
                if bundle.validate().is_ok() && bundle.snapshot.device_id == expected_device_id =>
            {
                remember_peer(&storage, &bundle.snapshot);
                bundles.push(bundle);
            }
            Ok(_) | Err(_) => failed_devices += 1,
        }
    }
    let refreshed_devices = bundles.len();
    let import_storage = storage.clone();
    tokio::task::spawn_blocking(move || {
        for bundle in bundles {
            let snapshot = bundle.snapshot;
            import_storage
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
        }
        Ok::<_, String>(())
    })
    .await
    .map_err(|error| format!("导入局域网设备快照任务失败：{error}"))??;
    Ok(LanRefreshResult {
        attempted_devices,
        refreshed_devices,
        failed_devices,
    })
}

pub async fn list_remote_permissions(
    storage: &Storage,
    device_id: &str,
    session_id: &str,
) -> Result<OpenCodePermissionReport, String> {
    let peer = peer_descriptor(storage, device_id)
        .ok_or_else(|| "目标设备没有可用的局域网连接信息".to_string())?;
    let path = format!("/flowlet/v1/opencode/permissions/{session_id}");
    // 遍历所有端点，任一成功即可；与 fetch_snapshot / probe_peer 保持一致。
    // 桌面端发布多端点时（多网卡/VPN 场景），首个地址可能手机到不了，
    // 仅取 endpoints.first() 会误报「无法直连」。
    let mut last_error = "没有可用的局域网端点".to_string();
    for endpoint in &peer.endpoints {
        match request(&peer, endpoint, Method::GET, &path, Vec::new()).await {
            Ok(report) => return Ok(report),
            Err(error) => last_error = error,
        }
    }
    Err(last_error)
}

pub async fn reply_remote_permission(
    storage: &Storage,
    device_id: &str,
    permission_id: &str,
    decision: OpenCodePermissionDecision,
) -> Result<(), String> {
    let peer = peer_descriptor(storage, device_id)
        .ok_or_else(|| "目标设备没有可用的局域网连接信息".to_string())?;
    let path = format!("/flowlet/v1/opencode/permissions/{permission_id}/reply");
    // operationId 在循环外生成一次，多端点重试保持幂等。
    let body = serde_json::to_vec(&serde_json::json!({
        "decision": decision,
        "operationId": uuid::Uuid::new_v4().to_string()
    }))
    .map_err(|error| error.to_string())?;
    let mut last_error = "没有可用的局域网端点".to_string();
    for endpoint in &peer.endpoints {
        match request::<Result<(), String>>(&peer, endpoint, Method::POST, &path, body.clone())
            .await
        {
            Ok(Ok(())) => return Ok(()),
            Ok(Err(error)) | Err(error) => last_error = error,
        }
    }
    Err(last_error)
}

const LAN_PROBE_CACHE_KEY: &str = "mobile_lan_probe_cache_v1";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LanProbeCache {
    probed_at: String,
    probes: Vec<LanPeerProbe>,
}

/// 执行全量 LAN 探测并把结果写入 app_meta 缓存，供移动端设备页读取。
/// 探测失败不会阻断缓存写入（空结果也缓存），避免反复发起网络请求。
pub async fn probe_and_cache_lan_peers(storage: &Storage) -> Vec<LanPeerProbe> {
    let probes = probe_lan_peers(storage, None).await;
    let cache = LanProbeCache {
        probed_at: Utc::now().to_rfc3339(),
        probes: probes.clone(),
    };
    if let Ok(raw) = serde_json::to_string(&cache) {
        let _ = storage.set_app_meta(LAN_PROBE_CACHE_KEY, &raw);
    }
    probes
}

/// 读取缓存中的 LAN 探测结果。无缓存时返回空 Vec，不发起网络请求。
pub fn cached_lan_probes(storage: &Storage) -> Vec<LanPeerProbe> {
    storage
        .get_app_meta(LAN_PROBE_CACHE_KEY)
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str::<LanProbeCache>(&raw).ok())
        .map(|cache| cache.probes)
        .unwrap_or_default()
}

fn descriptor_key(descriptor: &LanPeerDescriptor) -> Result<[u8; 32], String> {
    let decoded = BASE64
        .decode(&descriptor.auth_key)
        .map_err(|_| "局域网设备认证材料无效".to_string())?;
    decoded
        .try_into()
        .map_err(|_| "局域网设备认证材料长度无效".to_string())
}

fn validate_endpoint(endpoint: &str) -> Result<(), String> {
    let url = url::Url::parse(endpoint).map_err(|_| "局域网设备端点无效".to_string())?;
    if url.scheme() != "http"
        || url.username() != ""
        || url.password().is_some()
        || url.port().is_none()
    {
        return Err("局域网设备端点格式无效".to_string());
    }
    let address = url
        .host_str()
        .and_then(|host| host.parse::<std::net::IpAddr>().ok())
        .ok_or_else(|| "局域网设备端点必须使用内网 IP".to_string())?;
    let allowed = match address {
        std::net::IpAddr::V4(address) => address.is_private(),
        std::net::IpAddr::V6(address) => {
            let first = address.octets()[0];
            first & 0xfe == 0xfc
        }
    };
    if !allowed || address.is_loopback() || address.is_unspecified() {
        return Err("局域网设备端点不在允许的内网地址范围".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encrypted_peer_response(request: &str, wrong_aad: bool) -> (u16, Vec<u8>) {
        assert!(request.starts_with("GET /flowlet/v1/snapshot HTTP/1.1"));
        let header = |name: &str| {
            request
                .lines()
                .find_map(|line| {
                    let (key, value) = line.split_once(':')?;
                    key.eq_ignore_ascii_case(name).then(|| value.trim())
                })
                .unwrap()
        };
        let timestamp = header("x-flowlet-timestamp");
        let nonce = header("x-flowlet-nonce");
        let signature = hex::decode(header("x-flowlet-signature")).unwrap();
        // Independent peer implementation of the published wire format.
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&[42; 32]).unwrap();
        mac.update(format!("GET\n/flowlet/v1/snapshot\n{timestamp}\n{nonce}\n").as_bytes());
        mac.verify_slice(&signature).unwrap();
        let cipher = ChaCha20Poly1305::new_from_slice(&[42; 32]).unwrap();
        let iv = [7u8; 12];
        let ciphertext = cipher
            .encrypt(
                Nonce::from_slice(&iv),
                chacha20poly1305::aead::Payload {
                    msg: include_bytes!("../../../tests/fixtures/mobile/device-usage-v13.json"),
                    aad: if wrong_aad {
                        b"replayed-response"
                    } else {
                        nonce.as_bytes()
                    },
                },
            )
            .unwrap();
        (200, serde_json::to_vec(&serde_json::json!({"nonce": BASE64.encode(iv), "ciphertext": BASE64.encode(ciphertext)})).unwrap())
    }

    fn wire_request() -> String {
        let timestamp = Utc::now().timestamp().to_string();
        let nonce = uuid::Uuid::new_v4().to_string();
        let signature = sign(
            &[42; 32],
            "GET",
            "/flowlet/v1/snapshot",
            &timestamp,
            &nonce,
            &[],
        )
        .unwrap();
        format!("GET /flowlet/v1/snapshot HTTP/1.1\r\nx-flowlet-timestamp: {timestamp}\r\nx-flowlet-nonce: {nonce}\r\nx-flowlet-signature: {}\r\n\r\n", hex::encode(signature))
    }
    #[test]
    fn mobile_request_signature_and_desktop_encrypted_response_remain_compatible() {
        let request = wire_request();
        let nonce = request
            .lines()
            .find_map(|s| s.strip_prefix("x-flowlet-nonce: "))
            .unwrap();
        let (_, body) = encrypted_peer_response(&request, false);
        let bundle: DeviceUsageBundle = decrypt(
            &[42; 32],
            nonce.as_bytes(),
            serde_json::from_slice(&body).unwrap(),
        )
        .unwrap();
        bundle.validate().unwrap();
        assert_eq!(bundle.snapshot.days[0].known_tokens, 42);
    }
    #[test]
    fn mobile_rejects_encrypted_response_bound_to_a_different_request() {
        let request = wire_request();
        let nonce = request
            .lines()
            .find_map(|s| s.strip_prefix("x-flowlet-nonce: "))
            .unwrap();
        let (_, body) = encrypted_peer_response(&request, true);
        let result: Result<DeviceUsageBundle, _> = decrypt(
            &[42; 32],
            nonce.as_bytes(),
            serde_json::from_slice(&body).unwrap(),
        );
        assert!(result.unwrap_err().contains("响应认证失败"));
    }
    #[test]
    fn lan_endpoint_boundary_still_excludes_public_loopback_and_embedded_credentials() {
        for endpoint in [
            "http://127.0.0.1:80",
            "http://8.8.8.8:80",
            "http://user:pass@192.168.1.2:80",
            "https://192.168.1.2:443",
        ] {
            assert!(validate_endpoint(endpoint).is_err(), "{endpoint}");
        }
        assert!(validate_endpoint("http://192.168.1.2:18641").is_ok());
    }
}
