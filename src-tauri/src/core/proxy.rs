use super::config::{
    classify_request, ChannelAccount, ChannelPreset, ClientConfig, LogCaptureConfig,
    ProtocolType, RequestLogInput, RouteCandidate, RouteRule, UsageRecordInput,
};
use super::rate_limiter::RateLimiter;
use super::storage::Storage;
use axum::{
    body::Body,
    extract::{Request, State},
    http::{HeaderMap, Method, StatusCode},
    response::Response,
    routing::any,
    Router,
};
use bytes::Bytes;
use futures_util::{Stream, StreamExt};
use reqwest::Client;
use serde::Serialize;
use std::{
    net::SocketAddr,
    pin::Pin,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use thiserror::Error;
use tokio::sync::oneshot;

// ─── Shared Config (hot-reloadable) ─────────────────────────────────────────
// 代理运行中与 AppState 共用这些 Arc<Mutex<_>>，UI 保存配置后代理无需重启即可生效。

#[derive(Clone)]
pub struct ProxySharedConfig {
    pub channels: Arc<Mutex<Vec<ChannelPreset>>>,
    pub accounts: Arc<Mutex<Vec<ChannelAccount>>>,
    pub clients: Arc<Mutex<Vec<ClientConfig>>>,
    pub routes: Arc<Mutex<Vec<RouteCandidate>>>,
    pub rules: Arc<Mutex<Vec<RouteRule>>>,
    pub scores: Arc<Mutex<Vec<(String, String, f64, f64, f64)>>>,
}

const DEFAULT_BIND_ADDR: &str = "127.0.0.1:18640";
const MAX_USAGE_CAPTURE_BYTES: usize = 1024 * 1024;

#[path = "proxy_http.rs"]
mod proxy_http;
// Re-export 给 lib.rs 用（proxy_http mod 本身是私有的，需要手动暴露）
pub use proxy_http::extract_log_capture;

// config.json 读写 — 暴露给 commands.rs / lib.rs 调用
pub fn read_config_raw(path: &std::path::Path) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

pub fn write_config_raw(path: &std::path::Path, content: &str) -> Result<(), String> {
    let parsed: serde_json::Value =
        serde_json::from_str(content).map_err(|e| format!("JSON 解析失败: {e}"))?;
    if !(parsed.is_object() || parsed.is_array()) {
        return Err("config.json 顶层必须是对象或数组".to_string());
    }
    std::fs::write(path, content).map_err(|e| format!("写入失败: {e}"))?;
    Ok(())
}

#[path = "proxy_routing.rs"]
mod proxy_routing;

use proxy_http::{
    add_cors_headers, apply_request_headers, build_model_list_response, build_upstream_url,
    copy_response_headers, cors_preflight_response, encode_body_base64, ensure_config_file as ensure_ua_rules_file,
    extract_model, identify_client, identify_client_by_ua, is_model_list_request,
    is_streaming_response, load_ua_rules, rewrite_model, sanitize_headers,
};
use proxy_routing::{
    body_contains_quota_exceeded, enrich_upstream_error_log, match_candidates,
    network_error_route_reason, resolve_small_model,
    should_check_quota_body_status, should_try_next_status,
};
#[derive(Debug, Error)]
pub enum ProxyError {
    #[error("代理服务已经在运行")]
    AlreadyRunning,
    #[error("代理服务未运行")]
    NotRunning,
    #[error("监听地址无效: {0}")]
    InvalidBindAddr(String),
    #[error("启动代理失败: {0}")]
    StartFailed(String),
}

#[derive(Debug, Clone, Serialize)]
pub struct ProxyStatus {
    pub running: bool,
    pub bind_addr: String,
}

#[derive(Clone)]
pub struct ProxyController {
    inner: Arc<Mutex<ProxyRuntime>>,
}

impl Default for ProxyController {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(ProxyRuntime::default())),
        }
    }
}

struct ProxyRuntime {
    shutdown: Option<oneshot::Sender<()>>,
    bind_addr: String,
}

impl Default for ProxyRuntime {
    fn default() -> Self {
        Self {
            shutdown: None,
            bind_addr: DEFAULT_BIND_ADDR.to_string(),
        }
    }
}

#[derive(Clone)]
struct ProxyAppState {
    pub shared: ProxySharedConfig,
    pub client: Client,
    pub storage: Storage,
    #[allow(dead_code)]
    pub upstream_timeout_seconds: u64,
    pub rate_limiter: RateLimiter,
    pub capture: LogCaptureConfig,
    /// 本地 config.json 文件路径，每次请求热读 UA rules 用
    pub config_path: std::path::PathBuf,
}


impl ProxyController {
    pub async fn start(
        &self,
        shared: ProxySharedConfig,
        storage: Storage,
        upstream_timeout_seconds: u64,
        config_path: std::path::PathBuf,
    ) -> Result<(), ProxyError> {
        self.start_with_bind(
            shared,
            storage,
            upstream_timeout_seconds,
            LogCaptureConfig::default(),
            DEFAULT_BIND_ADDR,
            RateLimiter::new(600), // 默认 600 请求/分钟
            config_path,
        )
        .await
    }

    pub async fn start_with_capture(
        &self,
        shared: ProxySharedConfig,
        storage: Storage,
        upstream_timeout_seconds: u64,
        capture: LogCaptureConfig,
        config_path: std::path::PathBuf,
    ) -> Result<(), ProxyError> {
        self.start_with_bind(
            shared,
            storage,
            upstream_timeout_seconds,
            capture,
            DEFAULT_BIND_ADDR,
            RateLimiter::new(600),
            config_path,
        )
        .await
    }

    /// 启动代理并指定监听地址
    pub async fn start_with_bind(
        &self,
        shared: ProxySharedConfig,
        storage: Storage,
        upstream_timeout_seconds: u64,
        capture: LogCaptureConfig,
        bind_addr_str: &str,
        rate_limiter: RateLimiter,
        config_path: std::path::PathBuf,
    ) -> Result<(), ProxyError> {
        let mut runtime = self
            .inner
            .lock()
            .map_err(|_| ProxyError::StartFailed("代理状态锁定失败".to_string()))?;
        if runtime.shutdown.is_some() {
            return Err(ProxyError::AlreadyRunning);
        }

        let bind_addr: SocketAddr = bind_addr_str
            .parse()
            .map_err(|_| ProxyError::InvalidBindAddr(bind_addr_str.to_string()))?;
        let listener = std::net::TcpListener::bind(bind_addr)
            .map_err(|err| ProxyError::StartFailed(err.to_string()))?;
        listener
            .set_nonblocking(true)
            .map_err(|err| ProxyError::StartFailed(err.to_string()))?;
        let listener = tokio::net::TcpListener::from_std(listener)
            .map_err(|err| ProxyError::StartFailed(err.to_string()))?;

        // 首次启动时写入默认 config.json（UA 识别规则），用户可直接编辑
        ensure_ua_rules_file(&config_path);

        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        runtime.bind_addr = bind_addr_str.to_string();
        runtime.shutdown = Some(shutdown_tx);
        drop(runtime);

        let app = Router::new()
            .route("/health", any(health))
            .route("/v1/{*path}", any(forward_openai_compatible))
            .route("/openai/v1/{*path}", any(forward_openai_compatible))
            .route("/anthropic/v1/{*path}", any(forward_anthropic_compatible))
            .with_state(ProxyAppState {
                shared,
                client: Client::builder()
                    .timeout(Duration::from_secs(upstream_timeout_seconds))
                    .build()
                    .map_err(|err| ProxyError::StartFailed(err.to_string()))?,
                storage,
                upstream_timeout_seconds,
                rate_limiter,
                capture,
                config_path,
            });

        tokio::spawn(async move {
            let server = axum::serve(listener, app).with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            });
            if let Err(err) = server.await {
                tracing::error!("代理服务异常退出: {err}");
            }
        });

        Ok(())
    }

    pub async fn stop(&self) -> Result<(), ProxyError> {
        let mut runtime = self
            .inner
            .lock()
            .map_err(|_| ProxyError::StartFailed("代理状态锁定失败".to_string()))?;
        let shutdown = runtime.shutdown.take().ok_or(ProxyError::NotRunning)?;
        let _ = shutdown.send(());
        Ok(())
    }

    pub fn status(&self) -> ProxyStatus {
        let (running, bind_addr) = self
            .inner
            .lock()
            .map(|runtime| (runtime.shutdown.is_some(), runtime.bind_addr.clone()))
            .unwrap_or_else(|_| (false, DEFAULT_BIND_ADDR.to_string()));

        ProxyStatus { running, bind_addr }
    }
}

// ─── Health Check ────────────────────────────────────────────────────────────

async fn health(request: Request) -> Response {
    if request.method() == Method::OPTIONS {
        return cors_preflight_response(request.headers());
    }

    let mut response = Response::new(Body::from("ok"));
    *response.status_mut() = StatusCode::OK;
    add_cors_headers(response.headers_mut(), None);
    response
}

// ─── OpenAI-compatible Forward ──────────────────────────────────────────────

async fn forward_openai_compatible(
    State(state): State<ProxyAppState>,
    request: Request,
) -> Response {
    if request.method() == Method::OPTIONS {
        return cors_preflight_response(request.headers());
    }

    match forward_request(state, request, ProtocolType::OpenAi).await {
        Ok(mut response) => {
            add_cors_headers(response.headers_mut(), None);
            response
        }
        Err(err) => {
            let mut response = Response::new(Body::from(err.to_string()));
            *response.status_mut() = StatusCode::BAD_GATEWAY;
            add_cors_headers(response.headers_mut(), None);
            response
        }
    }
}

// ─── Anthropic-compatible Forward ───────────────────────────────────────────

async fn forward_anthropic_compatible(
    State(state): State<ProxyAppState>,
    request: Request,
) -> Response {
    if request.method() == Method::OPTIONS {
        return cors_preflight_response(request.headers());
    }

    match forward_request(state, request, ProtocolType::Anthropic).await {
        Ok(mut response) => {
            add_cors_headers(response.headers_mut(), None);
            response
        }
        Err(err) => {
            let mut response = Response::new(Body::from(err.to_string()));
            *response.status_mut() = StatusCode::BAD_GATEWAY;
            add_cors_headers(response.headers_mut(), None);
            response
        }
    }
}

// ─── Core Forward Logic ────────────────────────────────────────────────────

async fn forward_request(
    state: ProxyAppState,
    request: Request,
    detected_protocol: ProtocolType,
) -> Result<Response, reqwest::Error> {
    let request_id = uuid::Uuid::new_v4().to_string();
    let (parts, body) = request.into_parts();
    let body_bytes = axum::body::to_bytes(body, usize::MAX)
        .await
        .unwrap_or_default();

    let path = parts
        .uri
        .path_and_query()
        .map(|value| value.as_str().to_string())
        .unwrap_or_else(|| "/".to_string());

    let method = parts.method.to_string();

    // 热更新：从共享锁读取最新配置
    let routes = state.shared.routes.lock().unwrap().clone();
    let accounts = state.shared.accounts.lock().unwrap().clone();
    let channels = state.shared.channels.lock().unwrap().clone();
    let clients_shared = state.shared.clients.lock().unwrap().clone();
    let rules = state.shared.rules.lock().unwrap().clone();
    let scores = state.shared.scores.lock().unwrap().clone();

    if is_model_list_request(&parts.method, &path) {
        return Ok(build_model_list_response(
            &routes,
            &accounts,
            &channels,
            &detected_protocol,
        ));
    }

    let public_model = extract_model(&body_bytes, &detected_protocol);

    // token 身份：仅用于鉴权、路由匹配、限流 key，不再写日志/用量
    let token_client = identify_client(&parts.headers, &clients_shared);
    let token_client_id = token_client.as_ref().map(|(id, _)| id.clone());

    // 客户端身份：仅由本地 config.json 决定，与 token 解耦；不命中即"未知"，不降级
    let ua_rules = load_ua_rules(&state.config_path);
    let (client_id, client_name) = match identify_client_by_ua(&parts.headers, &ua_rules) {
        Some((id, name)) => (Some(id), Some(name)),
        None => (None, Some("未知".to_string()))
    };

    // 速率限制检查（key 仍用 token 身份，避免多 UA 共用一 token 时互相影响）
    if let Some(ref cid) = token_client_id {
        if !state.rate_limiter.try_consume(cid).await {
            let retry_after = state.rate_limiter.retry_after(cid).await;
            let mut response = Response::new(Body::from(
                serde_json::json!({"error": "rate limit exceeded"}).to_string(),
            ));
            *response.status_mut() = StatusCode::TOO_MANY_REQUESTS;
            response
                .headers_mut()
                .insert("Retry-After", retry_after.to_string().parse().unwrap());
            response
                .headers_mut()
                .insert("Content-Type", "application/json".parse().unwrap());
            return Ok(response);
        }
    }

    // 匹配路由候选（用 token 身份，保证现有多 UA 共用一 token 的规则不破坏）
    let candidates = match_candidates(
        &routes,
        &rules,
        &scores,
        public_model.as_deref(),
        &detected_protocol,
        token_client_id.as_deref(),
        &accounts,
        &channels,
    );

    // 识别请求类型
    let request_type = classify_request(&body_bytes, &detected_protocol);

    if candidates.is_empty() {
        let has_available_account = accounts
            .iter()
            .any(|account| account.enabled && !account.api_key.trim().is_empty());
        let has_exposed_model = routes.iter().any(|route| {
            route.enabled
                && accounts.iter().any(|account| {
                    account.id == route.account_id
                        && account.enabled
                        && !account.api_key.trim().is_empty()
                })
        });
        let (error_code, error_message) = if !has_available_account {
            ("no_available_account", "No enabled account with a configured API key is available")
        } else if !has_exposed_model {
            ("no_available_model", "No model is currently exposed by Flowlet")
        } else {
            ("model_not_exposed", "The requested model is not exposed by Flowlet")
        };
        let log = RequestLogInput {
            request_id: request_id.clone(),
            client_id,
            client_name,
            channel_id: None,
            channel_name: None,
            account_id: None,
            account_name: None,
            client_protocol: detected_protocol.as_str().to_string(),
            upstream_protocol: detected_protocol.as_str().to_string(),
            virtual_model: public_model.clone(),
            public_model,
            upstream_model: None,
            request_type: request_type.as_str().to_string(),
            method,
            path,
            status: Some(404),
            latency_ms: Some(0),
            is_stream: false,
            error_message: Some(format!("{error_code}: {error_message}")),
            fallback_count: 0,
            route_reason: Some(error_code.to_string()),
            ttfb_ms: None,
            duration_ms: None,
            attempt_seq: 0,
            req_headers_json: None,
            req_body_b64: None,
            res_headers_json: None,
            res_body_b64: None,
            stream_summary: None,
            is_last_attempt: true,
        };
        record_request_log(state.storage, log);
        let payload = match detected_protocol {
            ProtocolType::OpenAi => serde_json::json!({
                "error": { "message": error_message, "type": error_code, "code": error_code }
            }),
            ProtocolType::Anthropic => serde_json::json!({
                "type": "error",
                "error": { "type": error_code, "message": error_message }
            }),
        };
        let mut response = Response::new(Body::from(payload.to_string()));
        *response.status_mut() = StatusCode::NOT_FOUND;
        response.headers_mut().insert(
            axum::http::header::CONTENT_TYPE,
            "application/json".parse().unwrap(),
        );
        return Ok(response);
    }
    // 循环外一次性捕获请求级 head/body，各候选共享
    let req_headers_json = if state.capture.capture_req_headers {
        let keys = if state.capture.redact_sensitive_headers {
            LogCaptureConfig::redacted_header_keys()
        } else {
            &[]
        };
        Some(sanitize_headers(&parts.headers, keys).to_string())
    } else {
        None
    };
    let req_body_b64 = if state.capture.capture_req_body && !body_bytes.is_empty() {
        let mut bytes: Vec<u8> = body_bytes.to_vec();
        proxy_http::truncate_utf8(&mut bytes, state.capture.max_body_bytes);
        Some(encode_body_base64(&bytes))
    } else {
        None
    };

    let mut last_network_error: Option<reqwest::Error> = None;
    let mut fallback_count = 0;

    // accounts / channels 已在上面从共享锁 clone，直接复用
    let storage = state.storage.clone();
    let http_client = state.client.clone();
    let protocol_str = detected_protocol.as_str().to_string();
    let method_clone = method.clone();
    let path_clone = path.clone();
    let public_model_for_routing = public_model.clone();
    let request_id_for_routing = request_id.clone();
    let client_id_for_routing = client_id;
    let client_name_for_routing = client_name;
    let request_type_str = request_type.as_str().to_string();

    for (index, candidate) in candidates.iter().enumerate() {
        let account = accounts.iter().find(|a| a.id == candidate.account_id);
        let channel = channels.iter().find(|c| c.id == candidate.channel_id);
        let (Some(account), Some(channel)) = (account, channel) else {
            continue;
        };

        // 小模型路由判断：简单短聊天请求使用渠道配置的小模型
        let effective_model = resolve_small_model(&candidate.upstream_model);
        let routed_body = rewrite_model(&body_bytes, &effective_model, &detected_protocol);

        // 账号级 Base URL 覆盖：如果账号配置了 base_url_override 则优先使用
        let base_url = account
            .base_url_override
            .as_deref()
            .filter(|url| !url.trim().is_empty())
            .unwrap_or_else(|| channel.base_url_for(&detected_protocol));
        let upstream_url = build_upstream_url(
            base_url,
            &parts.uri,
            &detected_protocol,
        );
        let mut builder = http_client.request(parts.method.clone(), upstream_url);

        // 应用渠道级别超时（如果配置了的话）
        let timeout = channel
            .timeout_seconds
            .unwrap_or(state.upstream_timeout_seconds);
        builder = builder.timeout(Duration::from_secs(timeout));

        builder = apply_request_headers(
            builder,
            &parts.headers,
            &account.api_key,
            &detected_protocol,
            channel.auth_strategy_for(&detected_protocol),
        );

        // 为当前候选准备日志上下文（send_at = 此刻，T0 真实起点）
        let log_context = RouteLogContext {
            client_id: client_id_for_routing.clone(),
            client_name: client_name_for_routing.clone(),
            channel_id: candidate.channel_id.clone(),
            channel_name: channel.name.clone(),
            account_id: candidate.account_id.clone(),
            account_name: account.name.clone(),
            upstream_model: effective_model.clone(),
            virtual_model: public_model_for_routing.clone(),
            public_model: public_model_for_routing.clone(),
            request_type: request_type_str.clone(),
            method: method_clone.clone(),
            path: path_clone.clone(),
            client_protocol: protocol_str.clone(),
            upstream_protocol: protocol_str.clone(),
            send_at: Instant::now(),
            req_headers_json: req_headers_json.clone(),
            req_body_b64: req_body_b64.clone(),
        };

        match builder.body(routed_body).send().await {
            Ok(upstream_response) => {
                // send() 返回即表明收到响应头；此时可记录真实 TTFB
                let ttfb_ms = log_context.send_at.elapsed().as_millis() as i64;
                let status = upstream_response.status();
                let channel_vendor = channel.vendor.clone();

                if should_try_next_status(status, &channel_vendor) && index + 1 < candidates.len() {
                    fallback_count += 1;
                    record_request_log(
                        storage.clone(),
                        log_context.log_fallback(
                            uuid::Uuid::new_v4().to_string(),
                            Some(status.as_u16() as i64),
                            Some(format!("retryable_status_{}", status.as_u16())),
                            fallback_count,
                            "retryable_status".to_string(),
                        ),
                    );
                    continue;
                }

                let route_reason = if fallback_count > 0 {
                    "fallback_success".to_string()
                } else if public_model_for_routing.as_deref() == Some("auto") {
                    "auto".to_string()
                } else {
                    "direct".to_string()
                };
                let attempt_seq = fallback_count;
                let is_last = index + 1 == candidates.len();

                if should_check_quota_body_status(status) && index + 1 < candidates.len() {
                    let headers = upstream_response.headers().clone();
                    let body = upstream_response.bytes().await?;
                    let duration_ms = log_context.send_at.elapsed().as_millis() as i64;
                    if body_contains_quota_exceeded(&body) {
                        fallback_count += 1;
                        record_request_log(
                            storage.clone(),
                            log_context.log_fallback(
                                uuid::Uuid::new_v4().to_string(),
                                Some(status.as_u16() as i64),
                                Some("quota exceeded".to_string()),
                                fallback_count,
                                "quota_exceeded".to_string(),
                            ),
                        );
                        continue;
                    }

                    // 非 2xx 不会 fallback 的 buffered 分支
                    let res_headers_json = if state.capture.capture_res_headers {
                        let keys = if state.capture.redact_sensitive_headers {
                            LogCaptureConfig::redacted_header_keys()
                        } else {
                            &[]
                        };
                        Some(sanitize_headers(&headers, keys).to_string())
                    } else {
                        None
                    };
                    let mut body_for_log: Vec<u8> = body.to_vec();
                    let res_body_b64 = if state.capture.capture_res_body {
                        proxy_http::truncate_utf8(&mut body_for_log, state.capture.max_body_bytes);
                        Some(encode_body_base64(&body_for_log))
                    } else {
                        None
                    };

                    let mut log = log_context.log_success_base(
                        request_id_for_routing.clone(),
                        status.as_u16() as i64,
                        fallback_count,
                        route_reason,
                        attempt_seq,
                        is_last,
                    );
                    log.ttfb_ms = Some(ttfb_ms);
                    log.duration_ms = Some(duration_ms);
                    log.res_headers_json = res_headers_json;
                    log.res_body_b64 = res_body_b64;

                    return build_buffered_response(storage.clone(), status, headers, body, log, &detected_protocol);
                }

                // 默认路径：流式 or 短响应交给 build_response
                return build_response(
                    storage.clone(),
                    upstream_response,
                    log_context,
                    ttfb_ms,
                    status.as_u16() as i64,
                    attempt_seq,
                    is_last,
                    request_id_for_routing.clone(),
                    fallback_count,
                    route_reason,
                    &detected_protocol,
                    &state.capture,
                )
                .await;
            }
            Err(err) => {
                let route_reason = network_error_route_reason(&err);
                let error_msg = err.to_string();

                if index + 1 < candidates.len() {
                    fallback_count += 1;
                    record_request_log(
                        storage.clone(),
                        log_context.log_fallback(
                            uuid::Uuid::new_v4().to_string(),
                            None,
                            Some(error_msg),
                            fallback_count,
                            format!("{route_reason}_fallback"),
                        ),
                    );
                    continue;
                }

                record_request_log(
                    storage.clone(),
                    log_context.log_final_network_error(
                        request_id_for_routing.clone(),
                        error_msg,
                        fallback_count,
                        route_reason.to_string(),
                    ),
                );
                last_network_error = Some(err);
            }
        }
    }

    Err(last_network_error.expect("至少应有一个路由候选"))
}

// ─── Route Log Context ──────────────────────────────────────────────────────
//
// Timing: send_at 是「开始向上游发请求」的 Instant。真正的 TTFB 在 send()
// 返回后计算（= send_at.elapsed()），真正的 duration 在 body 收齐后计算
// （buffered 的 bytes().await 之后；streaming 的 stream 结束回调之后）。
// 不再把 constructed 时刻的 elapsed() 作为 latency_ms——那只是代理本地排队
// 耗时而非上游往返耗时。

struct RouteLogContext {
    client_id: Option<String>,
    client_name: Option<String>,
    channel_id: String,
    channel_name: String,
    account_id: String,
    account_name: String,
    upstream_model: String,
    virtual_model: Option<String>,
    public_model: Option<String>,
    request_type: String,
    method: String,
    path: String,
    client_protocol: String,
    upstream_protocol: String,
    /// 本次候选 send 开始的时刻，用于后续计算 TTFB 与 duration
    send_at: Instant,
    /// 请求级头部（在请求循环外一次性捕获）
    req_headers_json: Option<String>,
    req_body_b64: Option<String>,
}

impl RouteLogContext {
    fn base_log_input(
        &self,
        request_id: String,
        status: Option<i64>,
        latency_ms: Option<i64>,
        is_stream: bool,
        error_message: Option<String>,
        fallback_count: i64,
        route_reason: String,
    ) -> RequestLogInput {
        RequestLogInput {
            request_id,
            client_id: self.client_id.clone(),
            client_name: self.client_name.clone(),
            channel_id: Some(self.channel_id.clone()),
            channel_name: Some(self.channel_name.clone()),
            account_id: Some(self.account_id.clone()),
            account_name: Some(self.account_name.clone()),
            client_protocol: self.client_protocol.clone(),
            upstream_protocol: self.upstream_protocol.clone(),
            virtual_model: self.virtual_model.clone(),
            public_model: self.public_model.clone(),
            upstream_model: Some(self.upstream_model.clone()),
            request_type: self.request_type.clone(),
            method: self.method.clone(),
            path: self.path.clone(),
            status,
            latency_ms,
            is_stream,
            error_message,
            fallback_count,
            route_reason: Some(route_reason),
            ttfb_ms: None,
            duration_ms: None,
            attempt_seq: 0,
            req_headers_json: self.req_headers_json.clone(),
            req_body_b64: self.req_body_b64.clone(),
            res_headers_json: None,
            res_body_b64: None,
            stream_summary: None,
            is_last_attempt: true,
        }
    }

    /// 构建日志项（retryable_status / quota_exceeded / network_error_fallback）：
    /// ttfb=duration=attempt_elapsed 仍然视为该 attempt 的代理耗时兜底，
    /// 真实 TTFB 由 Ok(send) 路径填充。
    fn log_fallback(
        &self,
        request_id: String,
        status: Option<i64>,
        error_message: Option<String>,
        fallback_count: i64,
        route_reason: String,
    ) -> RequestLogInput {
        let elapsed = self.send_at.elapsed();
        let ms = Some(elapsed.as_millis() as i64);
        let mut log = self.base_log_input(
            request_id,
            status,
            ms,
            false,
            error_message,
            fallback_count,
            route_reason,
        );
        log.ttfb_ms = ms;
        log.duration_ms = ms;
        log.attempt_seq = fallback_count;
        log.is_last_attempt = false;
        log
    }

    /// 构建失败（最后一次 network_error）的日志项。
    fn log_final_network_error(
        &self,
        request_id: String,
        error_message: String,
        fallback_count: i64,
        route_reason: String,
    ) -> RequestLogInput {
        let elapsed = self.send_at.elapsed();
        let ms = Some(elapsed.as_millis() as i64);
        let mut log = self.base_log_input(
            request_id,
            Some(StatusCode::BAD_GATEWAY.as_u16() as i64),
            ms,
            false,
            Some(error_message),
            fallback_count,
            route_reason,
        );
        // 网络错误下 TTFB 无意义（send 都没成功返回），duration 用代理侧耗时占位
        log.ttfb_ms = None;
        log.duration_ms = ms;
        log.attempt_seq = fallback_count;
        log
    }

    /// 构建 success 调用的低层日志项入口，
    /// 由 response builder 进一步回填 ttfb/duration/res_*。
    fn log_success_base(
        &self,
        request_id: String,
        status: i64,
        fallback_count: i64,
        route_reason: String,
        attempt_seq: i64,
        is_last: bool,
    ) -> RequestLogInput {
        let mut log =
            self.base_log_input(request_id, Some(status), None, false, None, fallback_count, route_reason);
        log.attempt_seq = attempt_seq;
        log.is_last_attempt = is_last;
        log
    }

}

// ─── Response Builders ──────────────────────────────────────────────────────

async fn build_response(
    storage: Storage,
    upstream_response: reqwest::Response,
    log_context: RouteLogContext,
    ttfb_ms: i64,
    status_code: i64,
    attempt_seq: i64,
    is_last: bool,
    // 由调用方持有的逐请求信息（不在 log_context 里因为 log_context 是 per-candidate 的副本）
    request_id: String,
    fallback_count: i64,
    route_reason: String,
    protocol: &ProtocolType,
    capture: &LogCaptureConfig,
) -> Result<Response, reqwest::Error> {
    let status = upstream_response.status();
    let headers = upstream_response.headers().clone();
    let is_stream = is_streaming_response(&headers);

    let res_headers_json = if capture.capture_res_headers {
        let keys = if capture.redact_sensitive_headers {
            LogCaptureConfig::redacted_header_keys()
        } else {
            &[]
        };
        Some(sanitize_headers(&headers, keys).to_string())
    } else {
        None
    };

    let mut log = log_context.log_success_base(
        request_id.clone(),
        status_code,
        fallback_count,
        route_reason,
        attempt_seq,
        is_last,
    );
    log.is_stream = is_stream;
    log.ttfb_ms = Some(ttfb_ms);
    log.res_headers_json = res_headers_json.clone();
    log.res_body_b64 = None;
    log.stream_summary = None;

    if is_stream {
        // 流式：先发一条日志（duration 暂按 ttfb 兜底），再注册 stream 结束回调
        // 补 duration / res_body_b64 / stream_summary。
        log.duration_ms = log.duration_ms.or(Some(ttfb_ms));
        record_request_log(storage.clone(), log);

        let (tx_done, rx_done) = tokio::sync::oneshot::channel::<StreamDone>();
        let stream = capture_timed_stream(
            upstream_response.bytes_stream(),
            tx_done,
            capture,
        );

        let request_id_for_update = request_id.clone();
        let ttfb_for_update = ttfb_ms;
        let res_headers_for_update = res_headers_json;
        tokio::spawn(async move {
            let done = rx_done.await.unwrap_or(StreamDone {
                duration_ms: ttfb_for_update,
                res_body_b64: None,
                stream_summary: None,
            });
            update_stream_log(
                storage,
                request_id_for_update,
                ttfb_for_update,
                done.duration_ms,
                res_headers_for_update,
                done.res_body_b64,
                done.stream_summary,
            );
        });

        let mut response = Response::new(Body::from_stream(stream));
        *response.status_mut() = status;
        copy_response_headers(&headers, response.headers_mut());
        return Ok(response);
    }

    // 非流式（走 streaming 判断但非 SSE）— 视为 buffered，收完 body 计 duration
    let body = upstream_response.bytes().await?;
    let duration_ms = log_context.send_at.elapsed().as_millis() as i64;
    log.duration_ms = Some(duration_ms);
    let mut body_for_log: Vec<u8> = body.to_vec();
    if capture.capture_res_body {
        proxy_http::truncate_utf8(&mut body_for_log, capture.max_body_bytes);
        log.res_body_b64 = Some(encode_body_base64(&body_for_log));
    }

    enrich_upstream_error_log(status, &mut log);
    record_request_log(storage.clone(), log);

    let usage_capture = UsageCapture {
        storage: storage.clone(),
        request_id,
        client_id: log_context.client_id.clone(),
        client_name: log_context.client_name.clone(),
        channel_id: Some(log_context.channel_id.clone()),
        channel_name: Some(log_context.channel_name.clone()),
        account_id: Some(log_context.account_id.clone()),
        account_name: Some(log_context.account_name.clone()),
        client_protocol: protocol.as_str().to_string(),
        upstream_protocol: protocol.as_str().to_string(),
        virtual_model: log_context.virtual_model.clone(),
        upstream_model: Some(log_context.upstream_model.clone()),
        enabled: body.len() <= MAX_USAGE_CAPTURE_BYTES,
        body: body.to_vec(),
    };
    record_response_usage(usage_capture);

    let mut response = Response::new(Body::from(body));
    *response.status_mut() = status;
    copy_response_headers(&headers, response.headers_mut());
    Ok(response)
}

fn build_buffered_response(
    storage: Storage,
    status: reqwest::StatusCode,
    headers: HeaderMap,
    body: Bytes,
    mut log: RequestLogInput,
    protocol: &ProtocolType,
) -> Result<Response, reqwest::Error> {
    log.is_stream = false;
    enrich_upstream_error_log(status, &mut log);
    let usage_capture = UsageCapture {
        storage: storage.clone(),
        request_id: log.request_id.clone(),
        client_id: log.client_id.clone(),
        client_name: log.client_name.clone(),
        channel_id: log.channel_id.clone(),
        channel_name: log.channel_name.clone(),
        account_id: log.account_id.clone(),
        account_name: log.account_name.clone(),
        client_protocol: protocol.as_str().to_string(),
        upstream_protocol: protocol.as_str().to_string(),
        virtual_model: log.virtual_model.clone(),
        upstream_model: log.upstream_model.clone(),
        enabled: body.len() <= MAX_USAGE_CAPTURE_BYTES,
        body: body.to_vec(),
    };
    record_request_log(storage, log);
    record_response_usage(usage_capture);

    let mut response = Response::new(Body::from(body));
    *response.status_mut() = status;
    copy_response_headers(&headers, response.headers_mut());
    Ok(response)
}

// ─── Routing ────────────────────────────────────────────────────────────────

// ─── Usage Capture ──────────────────────────────────────────────────────────

struct UsageCapture {
    storage: Storage,
    request_id: String,
    client_id: Option<String>,
    client_name: Option<String>,
    channel_id: Option<String>,
    channel_name: Option<String>,
    account_id: Option<String>,
    account_name: Option<String>,
    client_protocol: String,
    upstream_protocol: String,
    virtual_model: Option<String>,
    upstream_model: Option<String>,
    enabled: bool,
    body: Vec<u8>,
}

#[allow(dead_code)]
fn capture_usage_stream(
    stream: impl Stream<Item = Result<Bytes, reqwest::Error>> + Send + 'static,
    capture: Option<UsageCapture>,
) -> impl Stream<Item = Result<Bytes, std::io::Error>> {
    let stream = Box::pin(stream);
    futures_util::stream::unfold((stream, capture), |(mut stream, mut capture)| async move {
        match stream.next().await {
            Some(Ok(bytes)) => {
                if let Some(current) = capture.as_mut() {
                    if current.enabled
                        && current.body.len().saturating_add(bytes.len()) <= MAX_USAGE_CAPTURE_BYTES
                    {
                        current.body.extend_from_slice(&bytes);
                    } else {
                        current.enabled = false;
                        current.body.clear();
                    }
                }
                Some((Ok(bytes), (stream, capture)))
            }
            Some(Err(err)) => Some((Err(std::io::Error::other(err)), (stream, capture))),
            None => {
                if let Some(current) = capture {
                    record_response_usage(current);
                }
                None
            }
        }
    })
}

fn record_response_usage(capture: UsageCapture) {
    if !capture.enabled {
        return;
    }
    let Some(usage) = extract_response_usage(&capture.body) else {
        return;
    };

    tokio::task::spawn_blocking(move || {
        let input = UsageRecordInput {
            request_id: capture.request_id,
            client_id: capture.client_id,
            client_name: capture.client_name,
            channel_id: capture.channel_id,
            channel_name: capture.channel_name,
            account_id: capture.account_id,
            account_name: capture.account_name,
            client_protocol: capture.client_protocol,
            upstream_protocol: capture.upstream_protocol,
            virtual_model: capture.virtual_model,
            upstream_model: capture.upstream_model,
            input_tokens: usage.input_tokens,
            input_cached_tokens: None,
            input_uncached_tokens: None,
            output_tokens: usage.output_tokens,
            total_tokens: usage.total_tokens,
        };
        if let Err(err) = capture.storage.upsert_usage_record(&input) {
            tracing::warn!("写入 usage 记录失败: {err}");
        }
    });
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ResponseUsage {
    input_tokens: Option<i64>,
    output_tokens: Option<i64>,
    total_tokens: Option<i64>,
}

fn extract_response_usage(body: &[u8]) -> Option<ResponseUsage> {
    let value: serde_json::Value = serde_json::from_slice(body).ok()?;

    // OpenAI style: response.usage.prompt_tokens / completion_tokens / total_tokens
    if let Some(usage) = value.get("usage") {
        let input_tokens = usage
            .get("prompt_tokens")
            .or_else(|| usage.get("input_tokens"))
            .and_then(|tokens| tokens.as_i64());
        let output_tokens = usage
            .get("completion_tokens")
            .or_else(|| usage.get("output_tokens"))
            .and_then(|tokens| tokens.as_i64());
        let total_tokens = usage
            .get("total_tokens")
            .and_then(|tokens| tokens.as_i64())
            .or_else(|| match (input_tokens, output_tokens) {
                (Some(input), Some(output)) => Some(input + output),
                _ => None,
            });

        if input_tokens.is_none() && output_tokens.is_none() && total_tokens.is_none() {
            return None;
        }

        return Some(ResponseUsage {
            input_tokens,
            output_tokens,
            total_tokens,
        });
    }

    // Anthropic style: response.usage.input_tokens / output_tokens
    if let Some(usage) = value.get("usage") {
        let input_tokens = usage.get("input_tokens").and_then(|t| t.as_i64());
        let output_tokens = usage.get("output_tokens").and_then(|t| t.as_i64());
        let total_tokens = match (input_tokens, output_tokens) {
            (Some(i), Some(o)) => Some(i + o),
            _ => None,
        };

        if input_tokens.is_none() && output_tokens.is_none() {
            return None;
        }

        return Some(ResponseUsage {
            input_tokens,
            output_tokens,
            total_tokens,
        });
    }

    None
}

fn record_request_log(storage: Storage, log: RequestLogInput) {
    tokio::task::spawn_blocking(move || {
        if let Err(err) = storage.insert_request_log(&log) {
            tracing::warn!("写入请求日志失败: {err}");
        }
    });
}

// ─── Streaming response body capture ────────────────────────────────────────

#[derive(Debug)]
struct StreamDone {
    pub duration_ms: i64,
    pub res_body_b64: Option<String>,
    pub stream_summary: Option<String>,
}

/// 包装上游 body 字节流：捕获最多 capture.max_body_bytes 的响应体字节
/// 与 SSE 首尾片段文本摘要；流结束时通过 tx_done 回写 StreamDone。
fn capture_timed_stream(
    inner: impl Stream<Item = Result<Bytes, reqwest::Error>> + Send + 'static,
    tx_done: tokio::sync::oneshot::Sender<StreamDone>,
    capture: &LogCaptureConfig,
) -> impl Stream<Item = Result<Bytes, std::io::Error>> {
    let inner = Box::pin(inner);
    let state = TimedStreamState {
        inner,
        done_sent: false,
        started_at: Instant::now(),
        res_body_buf: Vec::new(),
        res_body_max: capture.max_body_bytes,
        capture_res_body: capture.capture_res_body,
        first_line: None,
        last_line: None,
        line_count: 0,
    };
    let tx_done = std::sync::Arc::new(std::sync::Mutex::new(Some(tx_done)));
    futures_util::stream::unfold((state, tx_done), move |(mut state, tx_done)| async move {
        match state.inner.next().await {
            Some(Ok(bytes)) => {
                if state.capture_res_body
                    && state
                        .res_body_buf
                        .len()
                        .saturating_add(bytes.len())
                        <= state.res_body_max
                {
                    state.res_body_buf.extend_from_slice(&bytes);
                }
                let piece = String::from_utf8_lossy(&bytes);
                for line in piece.split('\n') {
                    let trimmed = line.trim_end_matches('\r');
                    if trimmed.is_empty() {
                        continue;
                    }
                    if state.first_line.is_none() {
                        state.first_line = Some(trimmed.to_string());
                    }
                    state.last_line = Some(trimmed.to_string());
                    state.line_count += 1;
                }
                Some((Ok(bytes), (state, tx_done)))
            }
            Some(Err(err)) => {
                send_stream_done(&mut state, &tx_done, false);
                Some((Err(std::io::Error::other(err)), (state, tx_done)))
            }
            None => {
                send_stream_done(&mut state, &tx_done, true);
                None
            }
        }
    })
}

fn send_stream_done(
    state: &mut TimedStreamState,
    tx_done: &std::sync::Arc<std::sync::Mutex<Option<tokio::sync::oneshot::Sender<StreamDone>>>>,
    _success: bool,
) {
    if state.done_sent {
        return;
    }
    state.done_sent = true;
    let duration_ms = state.started_at.elapsed().as_millis() as i64;
    let res_body_b64 = if state.res_body_buf.is_empty() || !state.capture_res_body {
        None
    } else {
        Some(encode_body_base64(&state.res_body_buf))
    };
    let stream_summary = build_stream_summary(
        state.first_line.as_deref(),
        state.last_line.as_deref(),
        state.line_count,
    );
    let _ = tx_done.lock().unwrap().take().map(|tx| {
        tx.send(StreamDone {
            duration_ms,
            res_body_b64,
            stream_summary,
        })
    });
}

struct TimedStreamState {
    inner: Pin<Box<dyn Stream<Item = Result<Bytes, reqwest::Error>> + Send>>,
    done_sent: bool,
    started_at: Instant,
    res_body_buf: Vec<u8>,
    res_body_max: usize,
    capture_res_body: bool,
    first_line: Option<String>,
    last_line: Option<String>,
    line_count: usize,
}

fn build_stream_summary(first: Option<&str>, last: Option<&str>, line_count: usize) -> Option<String> {
    let first = first?;
    let last = last.unwrap_or(first);
    if first == last {
        return Some(format!("lines: {}\n{}", line_count, first));
    }
    Some(format!("lines: {}\nfirst: {}\nlast:  {}", line_count, first, last))
}

/// 流式响应结束后由 spawn task 调用，补写 duration / res_body_b64 / stream_summary
/// 到最近一条 is_last_attempt=1 且 is_stream=1 的日志行。
fn update_stream_log(
    storage: Storage,
    request_id: String,
    ttfb_ms: i64,
    duration_ms: i64,
    res_headers_json: Option<String>,
    res_body_b64: Option<String>,
    stream_summary: Option<String>,
) {
    tokio::task::spawn_blocking(move || {
        if let Err(err) = storage.update_request_log_timing(
            &request_id,
            ttfb_ms,
            duration_ms,
            res_headers_json,
            res_body_b64,
            stream_summary,
        ) {
            tracing::warn!("补写流式请求日志失败: {err}");
        }
    });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
#[path = "proxy_tests.rs"]
mod proxy_tests;







