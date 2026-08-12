//! Flowlet headless proxy server
//! Run without Tauri GUI: `cargo run --bin headless`

use flowlet_lib::core::config::ProxyBindConfig;
use flowlet_lib::core::metrics::Metrics;
use flowlet_lib::core::services::FlowletServices;
use flowlet_lib::core::web::{create_web_router, WebState};
use std::sync::Arc;
use tokio::sync::RwLock;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt().with_env_filter("info").init();

    let db_path = std::env::var("FLOWLET_DB_PATH").unwrap_or_else(|_| "flowlet.sqlite".to_string());
    let bind_addr =
        std::env::var("FLOWLET_BIND_ADDR").unwrap_or_else(|_| "127.0.0.1:18640".to_string());
    let web_addr =
        std::env::var("FLOWLET_WEB_ADDR").unwrap_or_else(|_| "127.0.0.1:8080".to_string());
    let admin_token = std::env::var("FLOWLET_ADMIN_TOKEN").ok();

    if admin_token.is_some() {
        tracing::info!("Web console authentication enabled");
    }

    let config_path = std::env::current_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
        .join("config.json");
    tracing::info!("Opening Flowlet services: {db_path}");
    let services = FlowletServices::open(&db_path, &config_path)?;
    let snapshot = services.runtime_config.snapshot();

    tracing::info!(
        "Starting headless proxy: {} channels, {} accounts, {} routes, {} rules",
        snapshot.channels.len(),
        snapshot.accounts.len(),
        snapshot.routes.len(),
        snapshot.rules.len()
    );

    let proxy_running = Arc::new(RwLock::new(true));
    let socket: std::net::SocketAddr = bind_addr.parse()?;
    let current_token = services
        .bind_config
        .lock()
        .map(|config| config.default_client_token.clone())
        .unwrap_or_else(|_| "flowlet-local-token".to_string());
    services.set_bind_config(ProxyBindConfig {
        host: socket.ip().to_string(),
        port: socket.port(),
        allow_lan: !socket.ip().is_loopback(),
        default_client_token: current_token,
    })?;
    services.start_proxy().await?;

    // Start web console
    let web_state = WebState {
        storage: services.storage.clone(),
        proxy_running,
        bind_addr: web_addr.clone(),
        proxy_bind_addr: bind_addr.clone(),
        admin_token,
        metrics: Metrics::new(),
    };
    let web_app = create_web_router(web_state);
    let web_listener = tokio::net::TcpListener::bind(&web_addr).await?;
    tracing::info!("Proxy listening on {bind_addr}");
    tracing::info!("Web console available at http://{web_addr}");
    tracing::info!("Press Ctrl+C to stop");

    tokio::select! {
        _ = axum::serve(web_listener, web_app) => {},
        _ = tokio::signal::ctrl_c() => {
            tracing::info!("Shutting down...");
            services.stop_proxy().await?;
        }
    }

    Ok(())
}
