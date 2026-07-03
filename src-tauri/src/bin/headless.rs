//! Flowlet headless proxy server
//! Run without Tauri GUI: `cargo run --bin headless`

use flowlet_lib::core::metrics::Metrics;
use flowlet_lib::core::proxy::ProxyController;
use flowlet_lib::core::rate_limiter::RateLimiter;
use flowlet_lib::core::storage::Storage;
use flowlet_lib::core::web::{create_web_router, WebState};
use std::sync::Arc;
use tokio::sync::RwLock;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt().with_env_filter("info").init();

    let db_path = std::env::var("FLOWLET_DB_PATH").unwrap_or_else(|_| "flowlet.sqlite".to_string());
    let bind_addr =
        std::env::var("FLOWLET_BIND_ADDR").unwrap_or_else(|_| "127.0.0.1:11434".to_string());
    let web_addr =
        std::env::var("FLOWLET_WEB_ADDR").unwrap_or_else(|_| "127.0.0.1:8080".to_string());
    let admin_token = std::env::var("FLOWLET_ADMIN_TOKEN").ok();

    if admin_token.is_some() {
        tracing::info!("Web console authentication enabled");
    }

    tracing::info!("Opening database: {db_path}");
    let storage = Storage::open(&db_path)?;

    let channels = storage.list_channel_presets()?;
    let accounts = storage.list_channel_accounts()?;
    let routes = storage.list_route_candidates()?;
    let clients = storage.list_clients()?;
    let rules = storage.list_route_rules()?;
    let scores = storage.account_routing_scores()?;

    if channels.is_empty() {
        tracing::error!(
            "No channels configured. Please set up channels via the desktop app first."
        );
        std::process::exit(1);
    }
    if accounts.is_empty() {
        tracing::error!(
            "No accounts configured. Please set up accounts via the desktop app first."
        );
        std::process::exit(1);
    }

    tracing::info!(
        "Starting headless proxy: {} channels, {} accounts, {} routes, {} rules",
        channels.len(),
        accounts.len(),
        routes.len(),
        rules.len()
    );

    let proxy_running = Arc::new(RwLock::new(true));
    let proxy = ProxyController::default();
    let rate_limiter = RateLimiter::new(600); // 600 请求/分钟/客户端
    proxy
        .start_with_bind(
            channels,
            accounts,
            clients,
            routes,
            rules,
            scores,
            storage.clone(),
            120,
            &bind_addr,
            rate_limiter,
        )
        .await?;

    // Start web console
    let web_state = WebState {
        storage,
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
            proxy.stop().await?;
        }
    }

    Ok(())
}
