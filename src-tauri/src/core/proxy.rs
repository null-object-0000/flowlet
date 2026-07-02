use super::config::{ClientConfig, ProviderConfig, VirtualModelRoute};
use super::storage::{RequestLogMetadata, Storage, UsageRecordInput};
use axum::{
    body::Body,
    extract::{Request, State},
    http::{header, HeaderMap, HeaderValue, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::{any, get},
    Router,
};
use bytes::Bytes;
use futures_util::{Stream, StreamExt};
use reqwest::Client;
use serde::Serialize;
use std::{
    net::SocketAddr,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::async_runtime;
use thiserror::Error;
use tokio::sync::oneshot;

const DEFAULT_BIND_ADDR: &str = "127.0.0.1:11434";
const MAX_USAGE_CAPTURE_BYTES: usize = 1024 * 1024;

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

#[derive(Default)]
struct ProxyRuntime {
    shutdown: Option<oneshot::Sender<()>>,
}

#[derive(Clone)]
struct ProxyAppState {
    provider: ProviderConfig,
    routes: Vec<VirtualModelRoute>,
    clients: Vec<ClientConfig>,
    client: Client,
    storage: Storage,
}

impl ProxyController {
    pub async fn start(
        &self,
        provider: ProviderConfig,
        routes: Vec<VirtualModelRoute>,
        clients: Vec<ClientConfig>,
        storage: Storage,
    ) -> Result<(), ProxyError> {
        if !provider.enabled {
            return Err(ProxyError::StartFailed("Provider 未启用".to_string()));
        }

        let mut runtime = self
            .inner
            .lock()
            .map_err(|_| ProxyError::StartFailed("代理状态锁定失败".to_string()))?;
        if runtime.shutdown.is_some() {
            return Err(ProxyError::AlreadyRunning);
        }

        let bind_addr: SocketAddr = DEFAULT_BIND_ADDR
            .parse()
            .map_err(|_| ProxyError::InvalidBindAddr(DEFAULT_BIND_ADDR.to_string()))?;
        let listener = std::net::TcpListener::bind(bind_addr)
            .map_err(|err| ProxyError::StartFailed(err.to_string()))?;
        listener
            .set_nonblocking(true)
            .map_err(|err| ProxyError::StartFailed(err.to_string()))?;
        let listener = tokio::net::TcpListener::from_std(listener)
            .map_err(|err| ProxyError::StartFailed(err.to_string()))?;

        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        runtime.shutdown = Some(shutdown_tx);
        drop(runtime);

        let upstream_timeout = provider.upstream_timeout_seconds;
        let app = Router::new()
            .route("/health", get(health))
            .route("/v1/{*path}", any(forward_openai_compatible))
            .with_state(ProxyAppState {
                provider,
                routes,
                clients,
                client: Client::builder()
                    .timeout(Duration::from_secs(upstream_timeout))
                    .build()
                    .map_err(|err| ProxyError::StartFailed(err.to_string()))?,
                storage,
            });

        async_runtime::spawn(async move {
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
        let running = self
            .inner
            .lock()
            .map(|runtime| runtime.shutdown.is_some())
            .unwrap_or(false);

        ProxyStatus {
            running,
            bind_addr: DEFAULT_BIND_ADDR.to_string(),
        }
    }
}

async fn health() -> impl IntoResponse {
    (StatusCode::OK, "ok")
}

async fn forward_openai_compatible(
    State(state): State<ProxyAppState>,
    request: Request,
) -> Response {
    match forward_request(state.clone(), request).await {
        Ok(response) => response,
        Err(err) => {
            let mut response = Response::new(Body::from(err.to_string()));
            *response.status_mut() = StatusCode::BAD_GATEWAY;
            response
        }
    }
}

async fn forward_request(
    state: ProxyAppState,
    request: Request,
) -> Result<Response, reqwest::Error> {
    let started_at = Instant::now();
    let request_id = uuid::Uuid::new_v4().to_string();
    let (parts, body) = request.into_parts();
    let upstream_uri = build_upstream_uri(&state.provider.base_url, &parts.uri);
    let method = parts.method.to_string();
    let path = parts
        .uri
        .path_and_query()
        .map(|value| value.as_str().to_string())
        .unwrap_or_else(|| "/".to_string());
    let body_bytes = axum::body::to_bytes(body, usize::MAX)
        .await
        .unwrap_or_default();

    let public_model = extract_model(&body_bytes);
    let client_id = identify_client(&parts.headers, &state.clients);
    let candidates = route_candidates(&state.provider, &state.routes, public_model.as_deref());
    let mut last_network_error: Option<reqwest::Error> = None;
    let mut fallback_count = 0;

    for (index, candidate) in candidates.iter().enumerate() {
        let routed_body = rewrite_model(&body_bytes, candidate);
        let mut builder = state
            .client
            .request(parts.method.clone(), upstream_uri.clone());
        builder = apply_headers(builder, &parts.headers, &state.provider.api_key);

        match builder.body(routed_body).send().await {
            Ok(upstream_response) => {
                let status = upstream_response.status();
                if should_try_next_status(status) && index + 1 < candidates.len() {
                    fallback_count += 1;
                    record_request_metadata(
                        state.storage.clone(),
                        RequestLogMetadata {
                            request_id: uuid::Uuid::new_v4().to_string(),
                            client_id: client_id.clone(),
                            provider_id: Some("default".to_string()),
                            public_model: public_model.clone(),
                            virtual_model: public_model.clone().filter(|model| model == "auto"),
                            upstream_model: Some(candidate.clone()),
                            method: method.clone(),
                            path: path.clone(),
                            status: Some(status.as_u16() as i64),
                            latency_ms: Some(started_at.elapsed().as_millis() as i64),
                            is_stream: false,
                            error_message: None,
                            fallback_count,
                            route_reason: Some("retryable_status".to_string()),
                        },
                    );
                    continue;
                }

                if should_check_quota_body_status(status) && index + 1 < candidates.len() {
                    let headers = upstream_response.headers().clone();
                    let body = upstream_response.bytes().await?;
                    if body_contains_quota_exceeded(&body) {
                        fallback_count += 1;
                        record_request_metadata(
                            state.storage.clone(),
                            RequestLogMetadata {
                                request_id: uuid::Uuid::new_v4().to_string(),
                                client_id: client_id.clone(),
                                provider_id: Some("default".to_string()),
                                public_model: public_model.clone(),
                                virtual_model: public_model.clone().filter(|model| model == "auto"),
                                upstream_model: Some(candidate.clone()),
                                method: method.clone(),
                                path: path.clone(),
                                status: Some(status.as_u16() as i64),
                                latency_ms: Some(started_at.elapsed().as_millis() as i64),
                                is_stream: false,
                                error_message: Some("quota exceeded".to_string()),
                                fallback_count,
                                route_reason: Some("quota_exceeded".to_string()),
                            },
                        );
                        continue;
                    }

                    return build_buffered_response(
                        state,
                        status,
                        headers,
                        body,
                        RequestLogMetadata {
                            request_id,
                            client_id: client_id.clone(),
                            provider_id: Some("default".to_string()),
                            public_model: public_model.clone(),
                            virtual_model: public_model.clone().filter(|model| model == "auto"),
                            upstream_model: Some(candidate.clone()),
                            method,
                            path,
                            status: Some(status.as_u16() as i64),
                            latency_ms: Some(started_at.elapsed().as_millis() as i64),
                            is_stream: false,
                            error_message: None,
                            fallback_count,
                            route_reason: if fallback_count > 0 {
                                Some("fallback_success".to_string())
                            } else if public_model.as_deref() == Some("auto") {
                                Some("auto".to_string())
                            } else {
                                Some("direct".to_string())
                            },
                        },
                    );
                }

                return build_response(
                    state,
                    upstream_response,
                    RequestLogMetadata {
                        request_id,
                        client_id: client_id.clone(),
                        provider_id: Some("default".to_string()),
                        public_model: public_model.clone(),
                        virtual_model: public_model.clone().filter(|model| model == "auto"),
                        upstream_model: Some(candidate.clone()),
                        method,
                        path,
                        status: Some(status.as_u16() as i64),
                        latency_ms: Some(started_at.elapsed().as_millis() as i64),
                        is_stream: false,
                        error_message: None,
                        fallback_count,
                        route_reason: if fallback_count > 0 {
                            Some("fallback_success".to_string())
                        } else if public_model.as_deref() == Some("auto") {
                            Some("auto".to_string())
                        } else {
                            Some("direct".to_string())
                        },
                    },
                )
                .await;
            }
            Err(err) => {
                let route_reason = network_error_route_reason(&err);
                if index + 1 < candidates.len() {
                    fallback_count += 1;
                    record_request_metadata(
                        state.storage.clone(),
                        RequestLogMetadata {
                            request_id: uuid::Uuid::new_v4().to_string(),
                            client_id: client_id.clone(),
                            provider_id: Some("default".to_string()),
                            public_model: public_model.clone(),
                            virtual_model: public_model.clone().filter(|model| model == "auto"),
                            upstream_model: Some(candidate.clone()),
                            method: method.clone(),
                            path: path.clone(),
                            status: None,
                            latency_ms: Some(started_at.elapsed().as_millis() as i64),
                            is_stream: false,
                            error_message: Some(err.to_string()),
                            fallback_count,
                            route_reason: Some(format!("{route_reason}_fallback")),
                        },
                    );
                    continue;
                }
                record_request_metadata(
                    state.storage.clone(),
                    RequestLogMetadata {
                        request_id: uuid::Uuid::new_v4().to_string(),
                        client_id: client_id.clone(),
                        provider_id: Some("default".to_string()),
                        public_model: public_model.clone(),
                        virtual_model: public_model.clone().filter(|model| model == "auto"),
                        upstream_model: Some(candidate.clone()),
                        method: method.clone(),
                        path: path.clone(),
                        status: Some(StatusCode::BAD_GATEWAY.as_u16() as i64),
                        latency_ms: Some(started_at.elapsed().as_millis() as i64),
                        is_stream: false,
                        error_message: Some(err.to_string()),
                        fallback_count,
                        route_reason: Some(route_reason.to_string()),
                    },
                );
                last_network_error = Some(err);
            }
        }
    }

    Err(last_network_error.expect("至少应有一个路由候选"))
}

async fn build_response(
    state: ProxyAppState,
    upstream_response: reqwest::Response,
    mut log: RequestLogMetadata,
) -> Result<Response, reqwest::Error> {
    let status = upstream_response.status();
    let headers = upstream_response.headers().clone();
    let is_stream = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.contains("text/event-stream"))
        .unwrap_or(false);
    log.is_stream = is_stream;
    let usage_capture = (!is_stream).then(|| UsageCapture {
        storage: state.storage.clone(),
        request_id: log.request_id.clone(),
        client_id: log.client_id.clone(),
        provider_id: log.provider_id.clone(),
        virtual_model: log.virtual_model.clone(),
        upstream_model: log.upstream_model.clone(),
        enabled: true,
        body: Vec::new(),
    });
    enrich_upstream_error_log(status, &mut log);
    record_request_metadata(state.storage.clone(), log);
    let stream = capture_usage_stream(upstream_response.bytes_stream(), usage_capture);
    let mut response = Response::new(Body::from_stream(stream));
    *response.status_mut() = status;
    copy_response_headers(&headers, response.headers_mut());
    Ok(response)
}

fn build_buffered_response(
    state: ProxyAppState,
    status: reqwest::StatusCode,
    headers: HeaderMap,
    body: Bytes,
    mut log: RequestLogMetadata,
) -> Result<Response, reqwest::Error> {
    log.is_stream = false;
    enrich_upstream_error_log(status, &mut log);
    let usage_capture = UsageCapture {
        storage: state.storage.clone(),
        request_id: log.request_id.clone(),
        client_id: log.client_id.clone(),
        provider_id: log.provider_id.clone(),
        virtual_model: log.virtual_model.clone(),
        upstream_model: log.upstream_model.clone(),
        enabled: body.len() <= MAX_USAGE_CAPTURE_BYTES,
        body: body.to_vec(),
    };
    record_request_metadata(state.storage.clone(), log);
    record_response_usage(usage_capture);

    let mut response = Response::new(Body::from(body));
    *response.status_mut() = status;
    copy_response_headers(&headers, response.headers_mut());
    Ok(response)
}

fn enrich_upstream_error_log(status: reqwest::StatusCode, log: &mut RequestLogMetadata) {
    if !status.is_client_error() && !status.is_server_error() {
        return;
    }

    if log.error_message.is_none() {
        log.error_message = Some(format!("upstream status {}", status.as_u16()));
    }
    if log.route_reason.as_deref() == Some("direct") || log.route_reason.as_deref() == Some("auto")
    {
        log.route_reason = Some("upstream_error".to_string());
    }
}

struct UsageCapture {
    storage: Storage,
    request_id: String,
    client_id: Option<String>,
    provider_id: Option<String>,
    virtual_model: Option<String>,
    upstream_model: Option<String>,
    enabled: bool,
    body: Vec<u8>,
}

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

    async_runtime::spawn_blocking(move || {
        if let Err(err) = capture.storage.upsert_usage_record(UsageRecordInput {
            request_id: capture.request_id,
            client_id: capture.client_id,
            provider_id: capture.provider_id,
            virtual_model: capture.virtual_model,
            upstream_model: capture.upstream_model,
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            total_tokens: usage.total_tokens,
        }) {
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
    let usage = value.get("usage")?;
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

    Some(ResponseUsage {
        input_tokens,
        output_tokens,
        total_tokens,
    })
}

fn route_candidates(
    provider: &ProviderConfig,
    routes: &[VirtualModelRoute],
    public_model: Option<&str>,
) -> Vec<String> {
    if public_model != Some("auto") {
        return vec![public_model
            .filter(|model| !model.trim().is_empty())
            .unwrap_or(&provider.default_model)
            .to_string()];
    }

    let mut candidates: Vec<String> = routes
        .iter()
        .filter(|route| route.enabled && route.virtual_model == "auto")
        .map(|route| route.upstream_model.clone())
        .filter(|model| !model.trim().is_empty())
        .collect();

    if candidates.is_empty() {
        candidates.push(provider.default_model.clone());
    }

    candidates
}

fn extract_model(body: &[u8]) -> Option<String> {
    let value: serde_json::Value = serde_json::from_slice(body).ok()?;
    value
        .get("model")
        .and_then(|model| model.as_str())
        .map(|model| model.to_string())
}

fn identify_client(headers: &HeaderMap, clients: &[ClientConfig]) -> Option<String> {
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)?;

    clients
        .iter()
        .find(|client| client.enabled && client.token == token)
        .map(|client| client.id.clone())
}

fn rewrite_model(body: &[u8], upstream_model: &str) -> Vec<u8> {
    let Ok(mut value) = serde_json::from_slice::<serde_json::Value>(body) else {
        return body.to_vec();
    };
    let Some(model) = value.get_mut("model") else {
        return body.to_vec();
    };

    if model.as_str() == Some("auto") {
        *model = serde_json::Value::String(upstream_model.to_string());
        serde_json::to_vec(&value).unwrap_or_else(|_| body.to_vec())
    } else {
        body.to_vec()
    }
}

fn should_try_next_status(status: reqwest::StatusCode) -> bool {
    status == reqwest::StatusCode::TOO_MANY_REQUESTS || status.is_server_error()
}

fn should_check_quota_body_status(status: reqwest::StatusCode) -> bool {
    status == reqwest::StatusCode::PAYMENT_REQUIRED || status == reqwest::StatusCode::FORBIDDEN
}

fn body_contains_quota_exceeded(body: &[u8]) -> bool {
    let text = String::from_utf8_lossy(body).to_ascii_lowercase();
    text.contains("quota exceeded")
        || text.contains("insufficient quota")
        || text.contains("exceeded your current quota")
        || text.contains("billing quota")
}

fn network_error_route_reason(err: &reqwest::Error) -> &'static str {
    if err.is_timeout() {
        "timeout"
    } else {
        "network_error"
    }
}

fn record_request_metadata(storage: Storage, log: RequestLogMetadata) {
    async_runtime::spawn_blocking(move || {
        if let Err(err) = storage.insert_request_log(log) {
            tracing::warn!("写入请求日志失败: {err}");
        }
    });
}

fn build_upstream_uri(base_url: &str, original_uri: &Uri) -> String {
    let base = base_url.trim_end_matches('/');
    let path_and_query = original_uri
        .path_and_query()
        .map(|value| value.as_str())
        .unwrap_or("/");
    format!("{base}{path_and_query}")
}

fn apply_headers(
    mut builder: reqwest::RequestBuilder,
    headers: &HeaderMap,
    api_key: &str,
) -> reqwest::RequestBuilder {
    for (name, value) in headers {
        if is_hop_by_hop(name.as_str()) || name == header::HOST || name == header::AUTHORIZATION {
            continue;
        }
        builder = builder.header(name, value);
    }

    if !api_key.trim().is_empty() {
        builder = builder.bearer_auth(api_key.trim());
    }

    builder
}

fn copy_response_headers(source: &HeaderMap, target: &mut HeaderMap<HeaderValue>) {
    for (name, value) in source {
        if is_hop_by_hop(name.as_str()) {
            continue;
        }
        target.append(name, value.clone());
    }
}

fn is_hop_by_hop(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::routing::post;
    use std::path::PathBuf;

    #[test]
    fn rewrite_model_only_changes_auto() {
        let body = br#"{"model":"auto","messages":[]}"#;
        let rewritten = rewrite_model(body, "qwen-plus");
        let value: serde_json::Value = serde_json::from_slice(&rewritten).unwrap();

        assert_eq!(value["model"], "qwen-plus");
        assert_eq!(value["messages"], serde_json::json!([]));
    }

    #[test]
    fn rewrite_model_keeps_non_auto_body() {
        let body = br#"{"model":"deepseek-chat","messages":[]}"#;
        let rewritten = rewrite_model(body, "qwen-plus");

        assert_eq!(rewritten, body);
    }

    #[test]
    fn route_candidates_uses_auto_routes_in_order() {
        let provider = ProviderConfig::default();
        let routes = vec![
            VirtualModelRoute {
                id: "auto-1".to_string(),
                virtual_model: "auto".to_string(),
                provider_name: "default".to_string(),
                upstream_model: "model-a".to_string(),
                priority: 0,
                enabled: true,
            },
            VirtualModelRoute {
                id: "auto-2".to_string(),
                virtual_model: "auto".to_string(),
                provider_name: "default".to_string(),
                upstream_model: "model-b".to_string(),
                priority: 1,
                enabled: true,
            },
        ];

        assert_eq!(
            route_candidates(&provider, &routes, Some("auto")),
            vec!["model-a".to_string(), "model-b".to_string()]
        );
    }

    #[test]
    fn retry_only_for_rate_limit_and_server_errors() {
        assert!(should_try_next_status(
            reqwest::StatusCode::TOO_MANY_REQUESTS
        ));
        assert!(should_try_next_status(reqwest::StatusCode::BAD_GATEWAY));
        assert!(!should_try_next_status(reqwest::StatusCode::BAD_REQUEST));
        assert!(!should_try_next_status(
            reqwest::StatusCode::PAYLOAD_TOO_LARGE
        ));
    }

    #[test]
    fn upstream_timeout_is_configured() {
        assert_eq!(ProviderConfig::default().upstream_timeout_seconds, 120);
    }

    #[test]
    fn checks_quota_body_only_for_quota_candidate_statuses() {
        assert!(should_check_quota_body_status(
            reqwest::StatusCode::PAYMENT_REQUIRED
        ));
        assert!(should_check_quota_body_status(
            reqwest::StatusCode::FORBIDDEN
        ));
        assert!(!should_check_quota_body_status(
            reqwest::StatusCode::BAD_REQUEST
        ));
    }

    #[test]
    fn detects_quota_exceeded_messages() {
        assert!(body_contains_quota_exceeded(
            br#"{"error":{"message":"You exceeded your current quota"}}"#
        ));
        assert!(body_contains_quota_exceeded(
            br#"{"error":"insufficient quota"}"#
        ));
        assert!(!body_contains_quota_exceeded(
            br#"{"error":"context length exceeded"}"#
        ));
    }

    #[test]
    fn identifies_enabled_client_from_bearer_token() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer token-a"),
        );
        let clients = vec![
            ClientConfig {
                id: "client-a".to_string(),
                name: "客户端 A".to_string(),
                token: "token-a".to_string(),
                app_type: "test".to_string(),
                enabled: true,
            },
            ClientConfig {
                id: "client-b".to_string(),
                name: "客户端 B".to_string(),
                token: "token-b".to_string(),
                app_type: "test".to_string(),
                enabled: false,
            },
        ];

        assert_eq!(
            identify_client(&headers, &clients),
            Some("client-a".to_string())
        );
    }

    #[test]
    fn enriches_final_upstream_error_metadata_without_body_rewrite() {
        let mut log = RequestLogMetadata {
            request_id: "req".to_string(),
            client_id: Some("client-default".to_string()),
            provider_id: Some("default".to_string()),
            public_model: Some("gpt-test".to_string()),
            virtual_model: None,
            upstream_model: Some("gpt-test".to_string()),
            method: "POST".to_string(),
            path: "/v1/chat/completions".to_string(),
            status: Some(400),
            latency_ms: Some(1),
            is_stream: false,
            error_message: None,
            fallback_count: 0,
            route_reason: Some("direct".to_string()),
        };

        enrich_upstream_error_log(reqwest::StatusCode::BAD_REQUEST, &mut log);

        assert_eq!(log.error_message, Some("upstream status 400".to_string()));
        assert_eq!(log.route_reason, Some("upstream_error".to_string()));
    }

    #[test]
    fn extracts_openai_usage() {
        let usage = extract_response_usage(
            br#"{"id":"chatcmpl","usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}}"#,
        )
        .unwrap();

        assert_eq!(
            usage,
            ResponseUsage {
                input_tokens: Some(11),
                output_tokens: Some(7),
                total_tokens: Some(18),
            }
        );
    }

    #[test]
    fn extracts_input_output_usage_and_computes_total() {
        let usage =
            extract_response_usage(br#"{"usage":{"input_tokens":5,"output_tokens":8}}"#).unwrap();

        assert_eq!(
            usage,
            ResponseUsage {
                input_tokens: Some(5),
                output_tokens: Some(8),
                total_tokens: Some(13),
            }
        );
    }

    #[test]
    fn ignores_response_without_usage() {
        assert!(extract_response_usage(br#"{"id":"chatcmpl"}"#).is_none());
    }

    #[tokio::test]
    async fn forwards_status_headers_body_and_replaces_authorization() {
        let captured_auth = Arc::new(Mutex::new(None::<String>));
        let captured_auth_state = captured_auth.clone();
        let upstream = Router::new()
            .route(
                "/v1/chat/completions",
                post(
                    |State(captured): State<Arc<Mutex<Option<String>>>>,
                     headers: HeaderMap,
                     body: Bytes| async move {
                        let auth = headers
                            .get(header::AUTHORIZATION)
                            .and_then(|value| value.to_str().ok())
                            .map(|value| value.to_string());
                        *captured.lock().unwrap() = auth;
                        (StatusCode::CREATED, [("x-upstream", "ok")], body)
                    },
                ),
            )
            .with_state(captured_auth_state);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, upstream).await.unwrap();
        });

        let storage = Storage::open(temp_db_path()).unwrap();
        let state = ProxyAppState {
            provider: ProviderConfig {
                name: "测试 Provider".to_string(),
                base_url: format!("http://{upstream_addr}"),
                api_key: "upstream-secret".to_string(),
                api_key_storage: Default::default(),
                default_model: "gpt-test".to_string(),
                upstream_timeout_seconds: 120,
                enabled: true,
            },
            routes: vec![],
            clients: vec![ClientConfig {
                id: "client-test".to_string(),
                name: "测试客户端".to_string(),
                token: "client-token".to_string(),
                app_type: "test".to_string(),
                enabled: true,
            }],
            client: Client::new(),
            storage,
        };
        let request = Request::builder()
            .method("POST")
            .uri("/v1/chat/completions")
            .header(header::AUTHORIZATION, "Bearer client-token")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(r#"{"model":"gpt-test","messages":[]}"#))
            .unwrap();

        let response = forward_request(state, request).await.unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        assert_eq!(
            response
                .headers()
                .get("x-upstream")
                .unwrap()
                .to_str()
                .unwrap(),
            "ok"
        );
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(body, r#"{"model":"gpt-test","messages":[]}"#);
        assert_eq!(
            captured_auth.lock().unwrap().as_deref(),
            Some("Bearer upstream-secret")
        );
    }

    fn temp_db_path() -> PathBuf {
        std::env::temp_dir().join(format!("flowlet-test-{}.sqlite", uuid::Uuid::new_v4()))
    }
}
