//! Authenticated management API for the browser host. Desktop-only commands are
//! deliberately absent: an HTTP caller cannot invoke arbitrary Tauri commands.
mod commands;
use super::{device_identity::DeviceIdentity, services::FlowletServices};
use axum::{
    extract::{DefaultBodyLimit, Path, State},
    http::{header, HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::Sha256;
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tower_http::services::{ServeDir, ServeFile};

#[derive(Clone)]
pub struct WebState {
    pub services: FlowletServices,
    pub admin_token: String,
    pub static_dir: PathBuf,
    pub public_proxy_url: String,
    pub device_identity: Arc<Mutex<DeviceIdentity>>,
}

fn check_auth(headers: &HeaderMap, expected: &str) -> bool {
    let Some(token) = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
    else {
        return false;
    };
    let mut expected_mac =
        Hmac::<Sha256>::new_from_slice(b"flowlet-web-admin").expect("valid HMAC key");
    expected_mac.update(expected.as_bytes());
    let mut actual_mac =
        Hmac::<Sha256>::new_from_slice(b"flowlet-web-admin").expect("valid HMAC key");
    actual_mac.update(token.as_bytes());
    !expected.is_empty()
        && actual_mac
            .verify_slice(&expected_mac.finalize().into_bytes())
            .is_ok()
}

async fn authenticate(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    request: axum::extract::Request,
    next: Next,
) -> Response {
    if !check_auth(&headers, &state.admin_token) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({"code":"unauthorized","message":"管理凭据无效，请重新登录"})),
        )
            .into_response();
    }
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
}

pub fn create_web_router(state: WebState) -> Router {
    let assets = ServeDir::new(&state.static_dir)
        .not_found_service(ServeFile::new(state.static_dir.join("index.html")));
    let state = Arc::new(state);
    let api = Router::new()
        .route(
            "/api/session",
            get(|| async { Json(json!({"authenticated":true})) }),
        )
        .route("/api/commands/{command}", post(command))
        .layer(middleware::from_fn_with_state(state.clone(), authenticate))
        .layer(DefaultBodyLimit::max(4 * 1024 * 1024));
    Router::new()
        .merge(api)
        .route("/health", get(|| async { Json(json!({"status":"ok"})) }))
        // A missing API is an API error, never a successful SPA document.
        .route(
            "/api/{*path}",
            get(|| async { StatusCode::NOT_FOUND }).post(|| async { StatusCode::NOT_FOUND }),
        )
        .fallback_service(assets)
        .with_state(state)
}

async fn command(
    State(state): State<Arc<WebState>>,
    Path(command): Path<String>,
    Json(args): Json<Value>,
) -> Response {
    match commands::dispatch(&state, &command, args).await {
        Ok(value) => Json(value).into_response(),
        Err(error) => (error.0, Json(json!({"code":error.1,"message":error.2}))).into_response(),
    }
}

#[cfg(test)]
mod tests;
