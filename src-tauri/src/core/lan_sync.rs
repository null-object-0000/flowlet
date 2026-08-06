use crate::core::device_identity::{
    DeviceIdentity, DeviceUsageBundle, DeviceUsageSnapshot, LanPeerDescriptor, SyncedAgentSession,
};
use crate::core::opencode_control::{OpenCodePermissionDecision, OpenCodePermissionReport};
use crate::core::storage::{ProjectTask, Storage};
use axum::{
    body::Bytes,
    extract::{ConnectInfo, Path, State},
    http::{HeaderMap, Method, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    ChaCha20Poly1305, Nonce,
};
use chrono::{Duration as ChronoDuration, Utc};
use hmac::{Hmac, Mac};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::Sha256;
use std::{
    collections::{HashMap, VecDeque},
    net::SocketAddr,
    sync::{Arc, Mutex},
    time::Duration,
};

const LAN_DESCRIPTOR_KEY: &str = "device_lan_descriptor_v1";
const LAN_PEERS_KEY: &str = "device_lan_peers_v1";
const AUTH_WINDOW_SECONDS: i64 = 30;
const MAX_AUTH_NONCES: usize = 2048;
const PROTOCOL_VERSION: u32 = 1;
/// 入站请求只保留最近若干条，用于桌面端「局域网直连」卡片展示
/// 连接来源与时间，不持久化、不影响转发路径。
const MAX_INBOUND_EVENTS: usize = 50;

#[derive(Clone)]
struct LanServerState {
    storage: Storage,
    identity: DeviceIdentity,
    auth_key: [u8; 32],
    nonces: Arc<Mutex<HashMap<String, i64>>>,
    inbound: Arc<Mutex<VecDeque<LanInboundEvent>>>,
}

/// 一条入站直连请求记录。来源地址取 TCP 对端 IP，
/// 不要求客户端上报身份，因此旧版本客户端的连接同样可见。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LanInboundEvent {
    pub remote_addr: String,
    pub path: String,
    pub at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EncryptedPayload {
    nonce: String,
    ciphertext: String,
}

/// 桌面端 LAN 服务的运行状态，供「局域网直连」卡片展示。
/// 监听失败不影响代理与 S3 同步，因此失败原因也保存在这里，
/// 前端无需读取日志即可展示。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanServerStatus {
    pub running: bool,
    pub endpoints: Vec<String>,
    pub started_at: Option<String>,
    pub error: Option<String>,
}

impl Default for LanServerStatus {
    fn default() -> Self {
        Self {
            running: false,
            endpoints: Vec::new(),
            started_at: None,
            error: None,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PermissionReplyInput {
    decision: OpenCodePermissionDecision,
    operation_id: String,
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

/// 移动端通过 LAN 直连向目标设备提交任务。
/// `project_id` 是工作区项目 id（移动端从设备快照的 projects 目录获得）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSubmitInput {
    pub project_id: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "default_task_type")]
    pub task_type: String,
    #[serde(default = "default_task_priority")]
    pub priority: String,
    #[serde(default = "default_agent_profile")]
    pub agent_profile: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSubmitResult {
    pub task_id: String,
    pub status: String,
}

fn default_task_type() -> String {
    "code".to_string()
}

fn default_task_priority() -> String {
    "p2".to_string()
}

fn default_agent_profile() -> String {
    "Claude Code".to_string()
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

pub fn current_descriptor(storage: &Storage) -> Option<LanPeerDescriptor> {
    let mut descriptor = storage
        .get_app_meta(LAN_DESCRIPTOR_KEY)
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .filter(descriptor_is_fresh)?;
    #[cfg(desktop)]
    if let Some(port) = descriptor
        .endpoints
        .first()
        .and_then(|endpoint| url::Url::parse(endpoint).ok())
        .and_then(|endpoint| endpoint.port())
    {
        let endpoints: Vec<String> = candidate_lan_addresses()
            .into_iter()
            .map(|address| format!("http://{address}:{port}"))
            .filter(|endpoint| validate_endpoint(endpoint).is_ok())
            .collect();
        if !endpoints.is_empty() {
            descriptor.endpoints = endpoints;
        }
    }
    descriptor.expires_at = (Utc::now() + ChronoDuration::minutes(20)).to_rfc3339();
    if let Ok(raw) = serde_json::to_string(&descriptor) {
        let _ = storage.set_app_meta(LAN_DESCRIPTOR_KEY, &raw);
    }
    Some(descriptor)
}

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

#[cfg(desktop)]
pub async fn start_server(
    storage: Storage,
    identity: DeviceIdentity,
    status: Arc<Mutex<LanServerStatus>>,
    inbound: Arc<Mutex<VecDeque<LanInboundEvent>>>,
) -> Result<LanPeerDescriptor, String> {
    let listener = tokio::net::TcpListener::bind("0.0.0.0:0")
        .await
        .map_err(|error| format!("启动局域网同步服务失败：{error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("读取局域网同步端口失败：{error}"))?
        .port();
    let addresses = candidate_lan_addresses();
    let endpoints: Vec<String> = addresses
        .into_iter()
        .map(|address| format!("http://{address}:{port}"))
        .filter(|endpoint| validate_endpoint(endpoint).is_ok())
        .collect();
    if endpoints.is_empty() {
        return Err("未找到可发布的局域网地址".to_string());
    }
    // 发布信息的有效期长于常规定时同步周期；每次生成并上传快照时都会刷新。
    let now = Utc::now();
    let auth_key = random_key();
    let descriptor = LanPeerDescriptor {
        protocol_version: PROTOCOL_VERSION,
        endpoints,
        auth_key: BASE64.encode(auth_key),
        capabilities: current_capabilities(),
        started_at: now.to_rfc3339(),
        expires_at: (now + ChronoDuration::minutes(20)).to_rfc3339(),
    };
    storage
        .set_app_meta(
            LAN_DESCRIPTOR_KEY,
            &serde_json::to_string(&descriptor).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;

    if let Ok(mut guard) = status.lock() {
        guard.running = true;
        guard.endpoints = descriptor.endpoints.clone();
        guard.started_at = Some(descriptor.started_at.clone());
        guard.error = None;
    }

    let state = LanServerState {
        storage,
        identity,
        auth_key,
        nonces: Arc::new(Mutex::new(HashMap::new())),
        inbound,
    };
    let app = Router::new()
        .route("/flowlet/v1/ping", get(ping_handler))
        .route("/flowlet/v1/snapshot", get(snapshot_handler))
        .route("/flowlet/v1/session/read", post(session_read_handler))
        .route(
            "/flowlet/v1/opencode/permissions/{session_id}",
            get(permission_list_handler),
        )
        .route(
            "/flowlet/v1/opencode/permissions/{permission_id}/reply",
            post(permission_reply_handler),
        )
        .route("/flowlet/v1/task/submit", post(task_submit_handler))
        .route("/flowlet/v1/task/status", post(task_status_handler))
        .with_state(state);
    tokio::spawn(async move {
        if let Err(error) = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        {
            tracing::warn!(%error, "局域网同步服务已停止");
        }
    });
    Ok(descriptor)
}

/// 启动失败时记录原因，前端可以展示「未开启」而不是空白。
#[cfg(desktop)]
pub fn record_start_failure(status: &Arc<Mutex<LanServerStatus>>, error: &str) {
    if let Ok(mut guard) = status.lock() {
        guard.running = false;
        guard.error = Some(error.to_string());
    }
}

/// 桌面端 LAN 服务的完整报告：运行状态 + 最近入站请求。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanServerReport {
    pub status: LanServerStatus,
    pub inbound: Vec<LanInboundEvent>,
}

pub fn read_server_report(
    status: &Arc<Mutex<LanServerStatus>>,
    inbound: &Arc<Mutex<VecDeque<LanInboundEvent>>>,
) -> LanServerReport {
    let status = status.lock().map(|guard| guard.clone()).unwrap_or_default();
    let inbound = inbound
        .lock()
        .map(|guard| guard.iter().rev().cloned().collect())
        .unwrap_or_default();
    LanServerReport { status, inbound }
}

#[cfg(desktop)]
fn is_private_or_unique_local(addr: &std::net::IpAddr) -> bool {
    match addr {
        std::net::IpAddr::V4(v4) => v4.is_private(),
        std::net::IpAddr::V6(v6) => v6.is_unique_local(),
    }
}

/// 返回所有可用于局域网直连的本机地址候选。
///
/// 1. 先枚举所有处于 UP 状态、非 loopback 的接口，收集其中的 IPv4 私有地址
///    和 IPv6 Unique Local 地址。
/// 2. 再用 UDP routing 启发式询问 OS：访问公网地址时会用哪个源地址。
///    这个地址通常是能和手机互通的物理 LAN/Wi-Fi 地址，因此排在最前面。
/// 3. 如果路由启发式返回非内网地址（VPN 等场景），则只保留枚举到的内网地址。
#[cfg(desktop)]
fn candidate_lan_addresses() -> Vec<std::net::IpAddr> {
    let mut candidates = Vec::new();
    if let Ok(interfaces) = if_addrs::get_if_addrs() {
        for interface in interfaces {
            if !interface.is_oper_up() || interface.is_loopback() {
                continue;
            }
            let addr = interface.ip();
            if addr.is_unspecified() || !is_private_or_unique_local(&addr) {
                continue;
            }
            candidates.push(addr);
        }
    }

    let routed = (|| {
        let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
        // 1.1.1.1:53 只是为了让 OS 选择默认路由接口，不会真正发送数据。
        socket.connect("1.1.1.1:53").ok()?;
        let addr = socket.local_addr().ok()?.ip();
        if is_private_or_unique_local(&addr) && !addr.is_loopback() && !addr.is_unspecified() {
            Some(addr)
        } else {
            None
        }
    })();

    if let Some(first) = routed {
        candidates.retain(|addr| *addr != first);
        candidates.insert(0, first);
    }

    candidates
}

fn record_inbound(state: &LanServerState, remote: Option<&SocketAddr>, path: &str) {
    let Some(remote) = remote else {
        return;
    };
    if let Ok(mut guard) = state.inbound.lock() {
        if guard.len() >= MAX_INBOUND_EVENTS {
            guard.pop_front();
        }
        guard.push_back(LanInboundEvent {
            remote_addr: remote.ip().to_string(),
            path: path.to_string(),
            at: Utc::now().to_rfc3339(),
        });
    }
}

async fn ping_handler(
    State(state): State<LanServerState>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if let Err(error) = authorize(&state, &Method::GET, "/flowlet/v1/ping", &headers, &[]) {
        return (StatusCode::UNAUTHORIZED, error).into_response();
    }
    record_inbound(&state, Some(&remote), "/flowlet/v1/ping");
    let capabilities = current_capabilities();
    encrypted_response(
        &state.auth_key,
        &headers,
        &PingResponse {
            device_id: state.identity.device_id.clone(),
            protocol_version: PROTOCOL_VERSION,
            capabilities,
            server_time: Utc::now().to_rfc3339(),
        },
    )
}

fn current_capabilities() -> Vec<String> {
    vec![
        "snapshot.read".to_string(),
        "session.read".to_string(),
        "opencode.permission.read".to_string(),
        "opencode.permission.reply".to_string(),
        "task.submit".to_string(),
        "task.status".to_string(),
    ]
}

async fn snapshot_handler(
    State(state): State<LanServerState>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if let Err(error) = authorize(&state, &Method::GET, "/flowlet/v1/snapshot", &headers, &[]) {
        return (StatusCode::UNAUTHORIZED, error).into_response();
    }
    record_inbound(&state, Some(&remote), "/flowlet/v1/snapshot");
    match crate::core::device_sync::build_device_snapshot(
        state.storage.clone(),
        state.identity.clone(),
    )
    .await
    {
        Ok(snapshot) => {
            encrypted_response(&state.auth_key, &headers, &DeviceUsageBundle::new(snapshot))
        }
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, error).into_response(),
    }
}

async fn session_read_handler(
    State(state): State<LanServerState>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    const PATH: &str = "/flowlet/v1/session/read";
    if let Err(error) = authorize(&state, &Method::POST, PATH, &headers, &body) {
        return (StatusCode::UNAUTHORIZED, error).into_response();
    }
    let input = match serde_json::from_slice::<SessionReadInput>(&body) {
        Ok(input) if !input.agent_type.trim().is_empty() && !input.session_id.trim().is_empty() => {
            input
        }
        _ => return (StatusCode::BAD_REQUEST, "无效的会话读取参数").into_response(),
    };
    record_inbound(&state, Some(&remote), PATH);
    match crate::core::device_sync::build_synced_agent_session(
        state.storage.clone(),
        &input.agent_type,
        &input.session_id,
    )
    .await
    {
        Ok(Some(session)) => encrypted_response(
            &state.auth_key,
            &headers,
            &LanSessionSnapshot {
                generated_at: Utc::now().to_rfc3339(),
                session,
            },
        ),
        Ok(None) => (StatusCode::NOT_FOUND, "未找到会话").into_response(),
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, error).into_response(),
    }
}

async fn permission_list_handler(
    State(state): State<LanServerState>,
    Path(session_id): Path<String>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let path = format!("/flowlet/v1/opencode/permissions/{session_id}");
    if let Err(error) = authorize(&state, &Method::GET, &path, &headers, &[]) {
        return (StatusCode::UNAUTHORIZED, error).into_response();
    }
    record_inbound(&state, Some(&remote), &path);
    let report = crate::core::opencode_control::list_session_permissions(&session_id).await;
    encrypted_response(&state.auth_key, &headers, &report)
}

async fn permission_reply_handler(
    State(state): State<LanServerState>,
    Path(permission_id): Path<String>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    let path = format!("/flowlet/v1/opencode/permissions/{permission_id}/reply");
    if let Err(error) = authorize(&state, &Method::POST, &path, &headers, &body) {
        return (StatusCode::UNAUTHORIZED, error).into_response();
    }
    record_inbound(&state, Some(&remote), &path);
    let input = match serde_json::from_slice::<PermissionReplyInput>(&body) {
        Ok(input) if !input.operation_id.trim().is_empty() => input,
        _ => return (StatusCode::BAD_REQUEST, "无效的确认操作").into_response(),
    };
    let result =
        crate::core::opencode_control::reply_permission(&permission_id, input.decision).await;
    encrypted_response(&state.auth_key, &headers, &result)
}

/// 移动端通过签名 LAN 通道向目标设备提交任务。任务默认以 `draft`（草稿待提交）
/// 状态创建，与 PC 看板一致；由移动端通过「提交」动作（LAN 直连）转成 `submitted`
/// 后，目标设备本机调度器才会领取执行（只领取已绑定目录的项目）。
async fn task_submit_handler(
    State(state): State<LanServerState>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    const PATH: &str = "/flowlet/v1/task/submit";
    if let Err(error) = authorize(&state, &Method::POST, PATH, &headers, &body) {
        return (StatusCode::UNAUTHORIZED, error).into_response();
    }
    let input = match serde_json::from_slice::<TaskSubmitInput>(&body) {
        Ok(input)
            if !input.project_id.trim().is_empty()
                && !input.title.trim().is_empty()
                && matches!(input.task_type.as_str(), "code" | "readonly")
                && matches!(input.priority.as_str(), "p0" | "p1" | "p2") =>
        {
            input
        }
        _ => return (StatusCode::BAD_REQUEST, "无效的任务提交参数").into_response(),
    };
    record_inbound(&state, Some(&remote), PATH);

    let local_project = match state
        .storage
        .get_project_by_workspace_id(&input.project_id.trim())
        .map_err(|error| error.to_string())
    {
        Ok(Some(project)) => project,
        Ok(None) => {
            return (StatusCode::NOT_FOUND, "目标设备上没有该项目").into_response();
        }
        Err(error) => return (StatusCode::INTERNAL_SERVER_ERROR, error).into_response(),
    };
    if local_project.directory_path.is_none() {
        return (
            StatusCode::CONFLICT,
            "目标设备尚未绑定该项目目录，无法执行任务",
        )
            .into_response();
    }

    let now = Utc::now().to_rfc3339();
    let task_id = uuid::Uuid::new_v4().to_string();
    let task = ProjectTask {
        id: task_id.clone(),
        project_id: local_project.id.clone(),
        title: input.title.trim().to_string(),
        description: input.description.trim().to_string(),
        status: "draft".to_string(),
        task_type: input.task_type.clone(),
        agent_profile: input.agent_profile.trim().to_string(),
        priority: input.priority.clone(),
        base_task_id: None,
        last_job_id: None,
        rejection_reason: None,
        execution_history: None,
        created_at: now.clone(),
        updated_at: now,
        claimed_by: None,
        claimed_at: None,
        deleted: false,
    };
    if let Err(error) = state.storage.save_project_task(&task) {
        return (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response();
    }
    // 即时推送工作区，让其他设备尽快看到新任务。
    crate::core::project_workspace_sync::notify_project_changed(
        state.storage.clone(),
        &local_project.id,
    );
    encrypted_response(
        &state.auth_key,
        &headers,
        &TaskSubmitResult {
            task_id,
            status: "draft".to_string(),
        },
    )
}

/// 移动端通过签名 LAN 通道提交 / 撤回任务的入参（草稿 ↔ 已提交）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStatusInput {
    pub task_id: String,
    pub status: String,
}

/// 移动端通过签名 LAN 通道变更任务状态（提交 / 撤回）。
/// 与桌面端审核状态机一致：只允许「草稿 → 已提交」与「已提交 → 草稿」，
/// 其余迁移（含把进行中撤销）由执行器内部管理，这里一律拒绝。
async fn task_status_handler(
    State(state): State<LanServerState>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    const PATH: &str = "/flowlet/v1/task/status";
    if let Err(error) = authorize(&state, &Method::POST, PATH, &headers, &body) {
        return (StatusCode::UNAUTHORIZED, error).into_response();
    }
    let input = match serde_json::from_slice::<TaskStatusInput>(&body) {
        Ok(input)
            if !input.task_id.trim().is_empty()
                && matches!(input.status.as_str(), "draft" | "submitted") =>
        {
            input
        }
        _ => return (StatusCode::BAD_REQUEST, "无效的任务状态参数").into_response(),
    };
    record_inbound(&state, Some(&remote), PATH);

    let task_id = input.task_id.trim().to_string();
    let current = match state.storage.get_task_status(&task_id) {
        Ok(status) => status,
        Err(error) => return (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response(),
    };
    let allowed = matches!(
        (current.as_deref(), input.status.as_str()),
        (Some("draft"), "submitted") | (Some("submitted"), "draft")
    );
    if !allowed {
        return (StatusCode::CONFLICT, "当前任务状态不允许此操作").into_response();
    }
    if let Err(error) = state.storage.set_task_status(&task_id, &input.status) {
        return (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response();
    }
    // 状态变更即时推送工作区，其他设备尽快看到提交 / 撤回结果。
    if let Ok(Some(project_id)) = state.storage.get_task_project(&task_id) {
        crate::core::project_workspace_sync::notify_project_changed(
            state.storage.clone(),
            &project_id,
        );
    }
    encrypted_response(
        &state.auth_key,
        &headers,
        &TaskSubmitResult {
            task_id,
            status: input.status,
        },
    )
}

fn authorize(
    state: &LanServerState,
    method: &Method,
    path: &str,
    headers: &HeaderMap,
    body: &[u8],
) -> Result<(), String> {
    let timestamp = header(headers, "x-flowlet-timestamp")?;
    let timestamp_value = timestamp
        .parse::<i64>()
        .map_err(|_| "认证时间无效".to_string())?;
    let now = Utc::now().timestamp();
    if (now - timestamp_value).abs() > AUTH_WINDOW_SECONDS {
        return Err("局域网认证已过期".to_string());
    }
    let nonce = header(headers, "x-flowlet-nonce")?;
    let signature = header(headers, "x-flowlet-signature")?;
    verify_signature(
        &state.auth_key,
        method.as_str(),
        path,
        timestamp,
        nonce,
        body,
        signature,
    )?;
    let mut nonces = state
        .nonces
        .lock()
        .map_err(|_| "局域网认证状态不可用".to_string())?;
    nonces.retain(|_, seen_at| now - *seen_at <= AUTH_WINDOW_SECONDS);
    if nonces.contains_key(nonce) {
        return Err("局域网请求已重复".to_string());
    }
    if nonces.len() >= MAX_AUTH_NONCES {
        nonces.clear();
    }
    nonces.insert(nonce.to_string(), now);
    Ok(())
}

fn header<'a>(headers: &'a HeaderMap, name: &str) -> Result<&'a str, String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| format!("缺少 {name}"))
}

fn verify_signature(
    key: &[u8; 32],
    method: &str,
    path: &str,
    timestamp: &str,
    nonce: &str,
    body: &[u8],
    signature: &str,
) -> Result<(), String> {
    let supplied = hex::decode(signature).map_err(|_| "局域网签名无效".to_string())?;
    let mut mac =
        <Hmac<Sha256> as Mac>::new_from_slice(key).map_err(|_| "局域网密钥无效".to_string())?;
    mac.update(&signature_payload(method, path, timestamp, nonce, body));
    mac.verify_slice(&supplied)
        .map_err(|_| "局域网签名不匹配".to_string())
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

fn encrypted_response<T: Serialize>(
    key: &[u8; 32],
    headers: &HeaderMap,
    value: &T,
) -> axum::response::Response {
    let result = (|| {
        let request_nonce = header(headers, "x-flowlet-nonce")?;
        encrypt(key, request_nonce.as_bytes(), value)
    })();
    match result {
        Ok(payload) => (StatusCode::OK, Json(payload)).into_response(),
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, error).into_response(),
    }
}

fn encrypt<T: Serialize>(
    key: &[u8; 32],
    aad: &[u8],
    value: &T,
) -> Result<EncryptedPayload, String> {
    let bytes = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    let random = uuid::Uuid::new_v4();
    let nonce_bytes = &random.as_bytes()[..12];
    let cipher = ChaCha20Poly1305::new_from_slice(key).map_err(|_| "局域网密钥无效".to_string())?;
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(nonce_bytes),
            chacha20poly1305::aead::Payload { msg: &bytes, aad },
        )
        .map_err(|_| "局域网响应加密失败".to_string())?;
    Ok(EncryptedPayload {
        nonce: BASE64.encode(nonce_bytes),
        ciphertext: BASE64.encode(ciphertext),
    })
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

/// 通过签名 LAN 通道向目标设备提交任务（移动端 → 桌面端）。
/// 目标设备离线或未绑定项目目录时返回明确错误。
pub async fn submit_task(
    storage: &Storage,
    device_id: &str,
    input: &TaskSubmitInput,
) -> Result<TaskSubmitResult, String> {
    let peer = peer_descriptor(storage, device_id)
        .ok_or_else(|| "目标设备没有可用的局域网连接信息".to_string())?;
    if !peer.capabilities.iter().any(|cap| cap == "task.submit") {
        return Err("目标设备版本过旧，不支持任务提交".to_string());
    }
    let path = "/flowlet/v1/task/submit";
    let body = serde_json::to_vec(input).map_err(|error| error.to_string())?;
    let mut last_error = "没有可用的局域网端点".to_string();
    for endpoint in &peer.endpoints {
        match request(&peer, endpoint, Method::POST, path, body.clone()).await {
            Ok(result) => return Ok(result),
            Err(error) => last_error = error,
        }
    }
    Err(last_error)
}

/// 通过签名 LAN 通道提交 / 撤回任务（移动端 → 桌面端，草稿 ↔ 已提交）。
/// 目标设备离线或版本过旧时返回明确错误。
pub async fn set_task_status(
    storage: &Storage,
    device_id: &str,
    task_id: &str,
    status: &str,
) -> Result<TaskSubmitResult, String> {
    let peer = peer_descriptor(storage, device_id)
        .ok_or_else(|| "目标设备没有可用的局域网连接信息".to_string())?;
    if !peer.capabilities.iter().any(|cap| cap == "task.status") {
        return Err("目标设备版本过旧，不支持任务提交与撤回".to_string());
    }
    let path = "/flowlet/v1/task/status";
    let body = serde_json::to_vec(&TaskStatusInput {
        task_id: task_id.to_string(),
        status: status.to_string(),
    })
    .map_err(|error| error.to_string())?;
    let mut last_error = "没有可用的局域网端点".to_string();
    for endpoint in &peer.endpoints {
        match request(&peer, endpoint, Method::POST, path, body.clone()).await {
            Ok(result) => return Ok(result),
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
        tasks.push(tauri::async_runtime::spawn(async move {
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
    tauri::async_runtime::spawn_blocking(move || {
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
                .import_device_projects(&snapshot.device_id, &snapshot.generated_at, &snapshot.projects)
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
        match request::<Result<(), String>>(
            &peer,
            endpoint,
            Method::POST,
            &path,
            body.clone(),
        )
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

fn random_key() -> [u8; 32] {
    let first = uuid::Uuid::new_v4();
    let second = uuid::Uuid::new_v4();
    let mut key = [0u8; 32];
    key[..16].copy_from_slice(first.as_bytes());
    key[16..].copy_from_slice(second.as_bytes());
    key
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

    #[test]
    fn encrypted_payload_round_trips_and_is_bound_to_request_nonce() {
        let key = [7u8; 32];
        let payload = encrypt(&key, b"request-a", &vec!["one", "two"]).unwrap();
        let decoded: Vec<String> = decrypt(&key, b"request-a", payload.clone()).unwrap();
        assert_eq!(decoded, vec!["one", "two"]);
        assert!(decrypt::<Vec<String>>(&key, b"request-b", payload).is_err());
    }

    #[test]
    fn permission_reply_result_must_be_decoded_as_result() {
        let key = [9u8; 32];
        let payload = encrypt(&key, b"permission-reply", &Ok::<(), String>(())).unwrap();
        assert!(decrypt::<()>(&key, b"permission-reply", payload.clone()).is_err());
        let decoded = decrypt::<Result<(), String>>(&key, b"permission-reply", payload).unwrap();
        assert_eq!(decoded, Ok(()));
    }

    #[test]
    fn only_private_ip_endpoints_are_accepted() {
        assert!(validate_endpoint("http://192.168.1.8:17878").is_ok());
        assert!(validate_endpoint("http://10.0.0.2:17878").is_ok());
        assert!(validate_endpoint("http://127.0.0.1:17878").is_err());
        assert!(validate_endpoint("http://169.254.169.254:80").is_err());
        assert!(validate_endpoint("https://192.168.1.8:17878").is_err());
        assert!(validate_endpoint("http://example.com:17878").is_err());
    }

    fn test_state() -> (
        LanServerState,
        DeviceIdentity,
        [u8; 32],
        Arc<Mutex<VecDeque<LanInboundEvent>>>,
    ) {
        let storage =
            Storage::from_connection_for_test(rusqlite::Connection::open_in_memory().unwrap());
        let identity = DeviceIdentity {
            schema_version: 1,
            device_id: "11111111-2222-3333-4444-555555555555".to_string(),
            created_at: Utc::now().to_rfc3339(),
            display_name: "Test PC".to_string(),
            platform: "windows".to_string(),
        };
        let auth_key = [42u8; 32];
        let inbound = Arc::new(Mutex::new(VecDeque::new()));
        let state = LanServerState {
            storage,
            identity: identity.clone(),
            auth_key,
            nonces: Arc::new(Mutex::new(HashMap::new())),
            inbound: inbound.clone(),
        };
        (state, identity, auth_key, inbound)
    }

    fn signed_headers(key: &[u8; 32], method: &str, path: &str) -> (HeaderMap, String) {
        let timestamp = Utc::now().timestamp().to_string();
        let nonce = uuid::Uuid::new_v4().to_string();
        let signature = sign(key, method, path, &timestamp, &nonce, &[]).unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("x-flowlet-timestamp", timestamp.parse().unwrap());
        headers.insert("x-flowlet-nonce", nonce.parse().unwrap());
        headers.insert(
            "x-flowlet-signature",
            hex::encode(signature).parse().unwrap(),
        );
        (headers, nonce)
    }

    fn signed_headers_with_body(
        key: &[u8; 32],
        method: &str,
        path: &str,
        body: &[u8],
    ) -> (HeaderMap, String) {
        let timestamp = Utc::now().timestamp().to_string();
        let nonce = uuid::Uuid::new_v4().to_string();
        let signature = sign(key, method, path, &timestamp, &nonce, body).unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("x-flowlet-timestamp", timestamp.parse().unwrap());
        headers.insert("x-flowlet-nonce", nonce.parse().unwrap());
        headers.insert(
            "x-flowlet-signature",
            hex::encode(signature).parse().unwrap(),
        );
        (headers, nonce)
    }

    fn seed_project_and_task(storage: &Storage, task_status: &str) {
        storage.migrate().unwrap();
        let now = Utc::now().to_rfc3339();
        storage
            .save_project(&crate::core::storage::Project {
                id: "project-1".to_string(),
                name: "demo".to_string(),
                directory_path: Some("C:\\demo".to_string()),
                workspace_project_id: Some("ws-1".to_string()),
                workspace_archived: false,
                created_at: now.clone(),
                updated_at: now.clone(),
            })
            .unwrap();
        storage
            .save_project_task(&ProjectTask {
                id: "task-1".to_string(),
                project_id: "project-1".to_string(),
                title: "demo task".to_string(),
                description: String::new(),
                status: task_status.to_string(),
                task_type: "code".to_string(),
                agent_profile: "Claude Code".to_string(),
                priority: "p2".to_string(),
                base_task_id: None,
                last_job_id: None,
                rejection_reason: None,
                execution_history: None,
                created_at: now.clone(),
                updated_at: now.clone(),
                claimed_by: None,
                claimed_at: None,
                deleted: false,
            })
            .unwrap();
    }

    #[tokio::test]
    async fn task_status_handler_submits_and_withdraws_draft() {
        let (state, _, auth_key, _) = test_state();
        seed_project_and_task(&state.storage, "draft");
        let remote = SocketAddr::from(([192, 168, 1, 23], 9100));

        // 提交：draft → submitted
        let body = serde_json::to_vec(&TaskStatusInput {
            task_id: "task-1".to_string(),
            status: "submitted".to_string(),
        })
        .unwrap();
        let (headers, nonce) = signed_headers_with_body(&auth_key, "POST", "/flowlet/v1/task/status", &body);
        let response = task_status_handler(State(state.clone()), ConnectInfo(remote), headers, body.into())
            .await
            .into_response();
        assert_eq!(response.status(), StatusCode::OK);
        let payload: EncryptedPayload =
            serde_json::from_slice(&axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap();
        let result: TaskSubmitResult = decrypt(&auth_key, nonce.as_bytes(), payload).unwrap();
        assert_eq!(result.task_id, "task-1");
        assert_eq!(result.status, "submitted");
        assert_eq!(
            state.storage.get_task_status("task-1").unwrap().as_deref(),
            Some("submitted")
        );

        // 撤回：submitted → draft
        let body = serde_json::to_vec(&TaskStatusInput {
            task_id: "task-1".to_string(),
            status: "draft".to_string(),
        })
        .unwrap();
        let (headers, nonce) = signed_headers_with_body(&auth_key, "POST", "/flowlet/v1/task/status", &body);
        let response = task_status_handler(State(state.clone()), ConnectInfo(remote), headers, body.into())
            .await
            .into_response();
        assert_eq!(response.status(), StatusCode::OK);
        let payload: EncryptedPayload =
            serde_json::from_slice(&axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap();
        let result: TaskSubmitResult = decrypt(&auth_key, nonce.as_bytes(), payload).unwrap();
        assert_eq!(result.status, "draft");
        assert_eq!(
            state.storage.get_task_status("task-1").unwrap().as_deref(),
            Some("draft")
        );
    }

    #[tokio::test]
    async fn task_status_handler_rejects_illegal_transition() {
        let (state, _, auth_key, _) = test_state();
        seed_project_and_task(&state.storage, "in_progress");
        let remote = SocketAddr::from(([192, 168, 1, 23], 9100));

        // 进行中任务不允许撤回为草稿
        let body = serde_json::to_vec(&TaskStatusInput {
            task_id: "task-1".to_string(),
            status: "draft".to_string(),
        })
        .unwrap();
        let (headers, _) = signed_headers_with_body(&auth_key, "POST", "/flowlet/v1/task/status", &body);
        let response = task_status_handler(State(state.clone()), ConnectInfo(remote), headers, body.into())
            .await
            .into_response();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        assert_eq!(
            state.storage.get_task_status("task-1").unwrap().as_deref(),
            Some("in_progress")
        );
    }

    #[tokio::test]
    async fn ping_returns_device_info_and_records_inbound() {
        let (state, identity, auth_key, inbound) = test_state();
        let remote = SocketAddr::from(([192, 168, 1, 23], 9100));
        let (headers, nonce) = signed_headers(&auth_key, "GET", "/flowlet/v1/ping");

        let response = ping_handler(State(state), ConnectInfo(remote), headers)
            .await
            .into_response();
        assert_eq!(response.status(), StatusCode::OK);

        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let payload: EncryptedPayload = serde_json::from_slice(&body).unwrap();
        let pong: PingResponse = decrypt(&auth_key, nonce.as_bytes(), payload).unwrap();
        assert_eq!(pong.device_id, identity.device_id);
        assert_eq!(pong.protocol_version, PROTOCOL_VERSION);
        assert!(pong.capabilities.contains(&"snapshot.read".to_string()));
        assert!(pong.capabilities.contains(&"session.read".to_string()));

        let events = inbound.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].remote_addr, "192.168.1.23");
        assert_eq!(events[0].path, "/flowlet/v1/ping");
    }

    #[tokio::test]
    async fn ping_rejects_unsigned_request_and_does_not_record() {
        let (state, _, _, inbound) = test_state();
        let remote = SocketAddr::from(([192, 168, 1, 24], 9101));

        let response = ping_handler(State(state), ConnectInfo(remote), HeaderMap::new())
            .await
            .into_response();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert!(inbound.lock().unwrap().is_empty());
    }

    #[test]
    fn inbound_ring_buffer_keeps_only_recent_events() {
        let (state, _, _, inbound) = test_state();
        let remote = SocketAddr::from(([10, 0, 0, 8], 9000));
        for index in 0..(MAX_INBOUND_EVENTS + 7) {
            record_inbound(&state, Some(&remote), &format!("/test/{index}"));
        }
        let events = inbound.lock().unwrap();
        assert_eq!(events.len(), MAX_INBOUND_EVENTS);
        // 最旧的事件被淘汰，最新保留。
        assert_eq!(events.front().unwrap().path, "/test/7");
        assert_eq!(
            events.back().unwrap().path,
            format!("/test/{}", MAX_INBOUND_EVENTS + 6)
        );
    }

    #[test]
    fn server_report_reads_status_and_newest_first_inbound() {
        let status = Arc::new(Mutex::new(LanServerStatus {
            running: true,
            endpoints: vec!["http://192.168.1.8:17878".to_string()],
            started_at: Some("2026-07-30T08:00:00Z".to_string()),
            error: None,
        }));
        let inbound = Arc::new(Mutex::new(VecDeque::from([
            LanInboundEvent {
                remote_addr: "192.168.1.23".to_string(),
                path: "/flowlet/v1/ping".to_string(),
                at: "2026-07-30T08:01:00Z".to_string(),
            },
            LanInboundEvent {
                remote_addr: "192.168.1.24".to_string(),
                path: "/flowlet/v1/snapshot".to_string(),
                at: "2026-07-30T08:02:00Z".to_string(),
            },
        ])));
        let report = read_server_report(&status, &inbound);
        assert!(report.status.running);
        assert_eq!(report.inbound.len(), 2);
        assert_eq!(report.inbound[0].remote_addr, "192.168.1.24");
        assert_eq!(report.inbound[1].remote_addr, "192.168.1.23");
    }
}
