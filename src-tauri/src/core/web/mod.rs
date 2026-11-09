//! Authenticated management API for the browser host. Desktop-only commands are
//! deliberately absent: an HTTP caller cannot invoke arbitrary Tauri commands.
mod auth;
mod commands;
use super::{device_identity::DeviceIdentity, services::FlowletServices};
pub use auth::{AdminAuth, AdminAuthConfig};
use axum::{
    extract::{DefaultBodyLimit, Path, State},
    http::StatusCode,
    middleware,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tower_http::services::{ServeDir, ServeFile};

#[derive(Clone)]
pub struct WebState {
    pub services: FlowletServices,
    pub auth: Arc<AdminAuth>,
    pub static_dir: PathBuf,
    pub public_proxy_url: String,
    pub device_identity: Arc<Mutex<DeviceIdentity>>,
}

pub fn create_web_router(state: WebState) -> Router {
    let assets = ServeDir::new(&state.static_dir)
        .not_found_service(ServeFile::new(state.static_dir.join("index.html")));
    let state = Arc::new(state);
    let public = Router::new()
        .route("/api/auth/config", get(auth::config_handler))
        .route("/api/auth/login", get(auth::login_handler))
        .route("/api/auth/callback", get(auth::callback_handler));
    let api = Router::new()
        .route("/api/session", get(auth::session_handler))
        .route("/api/auth/logout", post(auth::logout_handler))
        .route("/api/commands/{command}", post(command))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth::authenticate_middleware,
        ))
        .layer(DefaultBodyLimit::max(4 * 1024 * 1024));
    Router::new()
        .merge(public)
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
