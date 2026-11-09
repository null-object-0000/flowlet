//! Standalone Flowlet host: no Tauri, display server or desktop libraries.
use flowlet_lib::core::{
    account_balance::sync_official_balances,
    channels_config::DEFAULT_CONFIG_JSON,
    config::ProxyBindConfig,
    device_identity::DeviceIdentity,
    host_scheduler,
    services::FlowletServices,
    web::{create_web_router, AdminAuth, WebState},
};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

/// 首次余额同步延迟：避开启动阶段的渠道与代理初始化。
const BALANCE_SYNC_FIRST_DELAY: Duration = Duration::from_secs(30);
/// 与桌面端 `ChannelResourceAutoSync` 保持一致的 5 分钟新鲜度周期。
const BALANCE_SYNC_INTERVAL: Duration = Duration::from_secs(5 * 60);

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();
    let auth = AdminAuth::from_env()?;
    let db_path = PathBuf::from(
        std::env::var("FLOWLET_DB_PATH").unwrap_or_else(|_| "flowlet-data/flowlet.sqlite".into()),
    );
    let data_dir = db_path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| std::path::Path::new("."));
    std::fs::create_dir_all(data_dir)?;
    // 设备身份属于 Host 级持久化状态：放在数据卷目录，重启后设备 ID 保持不变。
    let device_identity = DeviceIdentity::load_or_create(data_dir)
        .map_err(|error| format!("初始化设备身份失败（{}）：{error}", data_dir.display()))?;
    let config_path = std::env::var_os("FLOWLET_CONFIG_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| data_dir.join("config.json"));
    if !config_path.exists() {
        std::fs::write(&config_path, DEFAULT_CONFIG_JSON)?;
    }
    let services = FlowletServices::open(&db_path, &config_path)?.with_client_auth();
    let bind_addr = std::env::var("FLOWLET_BIND_ADDR").unwrap_or_else(|_| "127.0.0.1:18640".into());
    let web_addr = std::env::var("FLOWLET_WEB_ADDR").unwrap_or_else(|_| "127.0.0.1:8080".into());
    let socket: std::net::SocketAddr = bind_addr.parse()?;
    // The data volume is authoritative across restarts, even when config.json has a bind default.
    let saved_bind = services
        .storage
        .get_app_meta("proxy_bind_config")?
        .map(|raw| serde_json::from_str::<ProxyBindConfig>(&raw))
        .transpose()?;
    let current = saved_bind
        .map(|config| config.default_client_token)
        .unwrap_or_else(|| {
            services
                .bind_config
                .lock()
                .expect("bind config")
                .default_client_token
                .clone()
        });
    let client_token = std::env::var("FLOWLET_CLIENT_TOKEN")
        .ok()
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| {
            if current.is_empty() || current == "flowlet-local-token" {
                uuid::Uuid::new_v4().to_string()
            } else {
                current
            }
        });
    if auth.static_token() == Some(client_token.as_str()) {
        return Err("管理凭据与模型调用密钥必须不同".into());
    }
    let config = ProxyBindConfig {
        host: socket.ip().to_string(),
        port: socket.port(),
        allow_lan: !socket.ip().is_loopback(),
        default_client_token: client_token,
    };
    services
        .storage
        .set_app_meta("proxy_bind_config", &serde_json::to_string(&config)?)?;
    services.set_bind_config(config)?;
    services.start_proxy().await?;
    let static_dir =
        PathBuf::from(std::env::var("FLOWLET_STATIC_DIR").unwrap_or_else(|_| "dist-web".into()));
    if !static_dir.join("index.html").is_file() {
        services.stop_proxy().await?;
        return Err("找不到 Web 界面，请运行 npm run build:web 或设置 FLOWLET_STATIC_DIR".into());
    }
    let public_proxy_url = std::env::var("FLOWLET_PUBLIC_PROXY_URL").unwrap_or_default();
    let app = create_web_router(WebState {
        services: services.clone(),
        auth,
        static_dir,
        public_proxy_url,
        device_identity: Arc::new(Mutex::new(device_identity)),
    });
    let listener = tokio::net::TcpListener::bind(&web_addr).await?;
    spawn_official_balance_sync(services.clone());
    spawn_scheduled_storage_cleanup(services.clone());
    spawn_scheduled_catalog_sync(services.clone());
    tracing::info!(%web_addr,%bind_addr,"Flowlet Web 已启动");
    let result = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown())
        .await;
    services.stop_proxy().await?;
    result?;
    Ok(())
}
/// 服务端周期同步官方余额。
///
/// 桌面端由前端 `ChannelResourceAutoSync` 驱动（其中控制台渠道依赖隐藏 WebView）；
/// Web Host 没有桌面能力，因此这里只同步官方余额 API 渠道，由宿主自身周期驱动，
/// 不依赖管理页面是否打开。单个任务串行执行，不会产生重叠轮次。
fn spawn_official_balance_sync(services: FlowletServices) {
    tokio::spawn(async move {
        tokio::time::sleep(BALANCE_SYNC_FIRST_DELAY).await;
        loop {
            let outcome = sync_official_balances(&services).await;
            if outcome.attempted > 0 {
                tracing::info!(
                    attempted = outcome.attempted,
                    succeeded = outcome.succeeded,
                    failed = outcome.failed,
                    "服务端官方余额同步完成"
                );
            }
            tokio::time::sleep(BALANCE_SYNC_INTERVAL).await;
        }
    });
}

/// 与桌面端一致的定时存储清理：启动 15 分钟后首次，之后每 15 分钟一次。
///
/// 覆盖请求/响应 Body 的过期与超限清理，以及派生的余额/快照保留策略；没有这个任务时
/// Docker 数据卷会按捕获量无限增长，`log_capture` / `usage_retention` 也不生效。
fn spawn_scheduled_storage_cleanup(services: FlowletServices) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval_at(
            tokio::time::Instant::now() + host_scheduler::STORAGE_CLEANUP_FIRST_DELAY,
            host_scheduler::STORAGE_CLEANUP_INTERVAL,
        );
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            host_scheduler::run_storage_cleanup_once(
                services.storage.clone(),
                services.config_path.clone(),
                services.jobs.clone(),
            )
            .await;
        }
    });
}

/// 与桌面端一致的模型目录同步：启动 1 小时后首次，之后每 1 小时一次。
///
/// Docker 没有前端常驻进程，缺少这个任务时 models-cn / models.dev 只在迁移时同步过一次，
/// 模型规格、能力与基准价格会持续过期。
fn spawn_scheduled_catalog_sync(services: FlowletServices) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval_at(
            tokio::time::Instant::now() + host_scheduler::CATALOG_SYNC_FIRST_DELAY,
            host_scheduler::CATALOG_SYNC_INTERVAL,
        );
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            host_scheduler::run_catalog_sync_once(
                services.storage.clone(),
                services.config_path.clone(),
                services.jobs.clone(),
            )
            .await;
        }
    });
}

async fn shutdown() {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("注册 SIGTERM");
        tokio::select! { _=tokio::signal::ctrl_c()=>{}, _=terminate.recv()=>{} }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
