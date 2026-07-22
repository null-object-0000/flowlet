mod commands;
pub mod core;

use core::channels_config::{ChannelsConfig, DEFAULT_CONFIG_JSON};
use core::config::{
    ChannelAccount, ChannelPreset, LogCaptureConfig, ProtocolType, ProxyBindConfig, RouteCandidate,
    RouteRule, VirtualModel,
};
use core::presets::builtin_channel_presets;
use core::proxy::ProxyController;
use core::storage::Storage;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

#[derive(Clone)]
struct AppState {
    proxy: ProxyController,
    channels: Arc<Mutex<Vec<ChannelPreset>>>,
    accounts: Arc<Mutex<Vec<ChannelAccount>>>,
    routes: Arc<Mutex<Vec<RouteCandidate>>>,
    virtual_models: Arc<Mutex<Vec<VirtualModel>>>,
    rules: Arc<Mutex<Vec<RouteRule>>>,
    storage: Storage,
    upstream_timeout_seconds: u64,
    capture: Arc<Mutex<LogCaptureConfig>>,
    bind_config: Arc<Mutex<ProxyBindConfig>>,
    tray: Arc<Mutex<Option<TrayIcon>>>,
    config_path: std::path::PathBuf,
    codex_accounts_dir: std::path::PathBuf,
    channels_config: Arc<Mutex<ChannelsConfig>>,
    agent_source_watcher: Arc<Mutex<Option<notify::RecommendedWatcher>>>,
    /// per-account 后台抓取 webview,key=account_id。webview 自身即会话容器。
    scrape_webviews: Arc<Mutex<std::collections::HashMap<String, tauri::WebviewWindow>>>,
    /// per-account 待处理拦截响应缓冲(抓取过程中临时存放)。
    scrape_pending: Arc<Mutex<std::collections::HashMap<String, Vec<(String, String)>>>>,
}

struct ProxyStartupConfig {
    shared: core::proxy::ProxySharedConfig,
    storage: Storage,
    timeout: u64,
    capture: LogCaptureConfig,
    bind_addr: String,
    config_path: std::path::PathBuf,
}

impl AppState {
    fn proxy_startup_config(&self) -> Result<ProxyStartupConfig, String> {
        // 启动时传入 Arc 引用，而非 clone 数据副本 — 代理运行中与 UI 共享同一份配置
        let capture = self
            .capture
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default();
        let bind_addr = self
            .bind_config
            .lock()
            .map(|guard| guard.clone().normalized().bind_addr())
            .unwrap_or_else(|_| ProxyBindConfig::default().bind_addr());
        Ok(ProxyStartupConfig {
            shared: core::proxy::ProxySharedConfig {
                channels: Arc::clone(&self.channels),
                accounts: Arc::clone(&self.accounts),
                routes: Arc::clone(&self.routes),
                rules: Arc::clone(&self.rules),
                scores: Arc::new(Mutex::new(Vec::new())),
                round_robin: Arc::new(Mutex::new(std::collections::HashMap::new())),
            },
            storage: self.storage.clone(),
            timeout: self.upstream_timeout_seconds,
            capture,
            bind_addr,
            config_path: self.config_path.clone(),
        })
    }

    async fn start_configured_proxy(&self) -> Result<(), String> {
        start_proxy_internal(self.proxy.clone(), self.proxy_startup_config()?).await
    }
}

// ─── App Entry ──────────────────────────────────────────────────────────────

fn build_app_state(db_path: std::path::PathBuf, config_path: std::path::PathBuf) -> AppState {
    let _t0 = std::time::Instant::now();
    let codex_accounts_dir = db_path
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."))
        .join("codex-accounts");

    tracing::info!(db_path = %db_path.display(), t_ms = _t0.elapsed().as_millis() as u64, "初始化 Storage");

    // 从 config.json 顶层 channels_config 字段解析渠道配置
    let channels_config = match load_channels_config_from(&config_path) {
        Ok(cfg) => {
            tracing::info!(
                channels = cfg.presets.len(),
                prices = cfg.prices.len(),
                "从 config.json 加载渠道配置"
            );
            let merged = merge_builtin_config(cfg);
            Arc::new(merged)
        }
        Err(e) => {
            tracing::error!(error = %e, "加载渠道配置失败");
            panic!("无法加载渠道配置: {e}");
        }
    };

    let storage = match Storage::open(&db_path) {
        Ok(s) => s,
        Err(e) => {
            tracing::error!(error = %e, "Storage::open 失败");
            panic!("初始化 SQLite 存储失败: {e}");
        }
    };

    storage
        .ensure_preset_platform_urls(&channels_config.presets)
        .expect("补全渠道模板平台地址失败");

    // 将内置默认渠道中外部配置可能缺失的渠道补入 SQLite（升级迁移）。
    let mut migration_presets = channels_config.presets.clone();
    let builtin = builtin_channel_presets();
    for bp in &builtin {
        if !migration_presets.iter().any(|p| p.id == bp.id) {
            migration_presets.push(bp.clone());
        }
    }

    storage
        .ensure_missing_presets(&migration_presets)
        .expect("追加新增渠道模板失败");

    storage
        .sync_preset_protocol_config(&migration_presets)
        .expect("同步渠道协议配置失败");

    storage
        .ensure_preset_balance_query(&migration_presets)
        .expect("同步渠道余额查询标志失败");

    storage
        .ensure_preset_scrape_balance(&migration_presets)
        .expect("同步渠道控制台抓取标志失败");

    tracing::info!(
        t_ms = _t0.elapsed().as_millis() as u64,
        "Storage 初始化完成, 开始加载渠道模板"
    );

    // 初始化渠道模板：优先从 config.json 加载，SQLite 为空时写入
    let channels = storage.list_channel_presets().expect("读取渠道模板失败");
    tracing::trace!(
        t_ms = _t0.elapsed().as_millis() as u64,
        count = channels.len(),
        "渠道模板加载完成"
    );
    let channels = if channels.is_empty() {
        let presets = channels_config.presets.clone();
        storage
            .save_channel_presets(presets.as_slice())
            .expect("保存默认渠道模板失败");
        presets
    } else {
        channels
    };

    // 账号必须由用户自行创建。清理早期版本生成的空默认账号。
    let mut accounts = storage.list_channel_accounts().expect("读取账号配置失败");
    let cleaned_accounts: Vec<ChannelAccount> = accounts
        .iter()
        .filter(|account| !(account.id == "account-default" && account.api_key.trim().is_empty()))
        .cloned()
        .collect();
    if cleaned_accounts.len() != accounts.len() {
        storage
            .save_channel_accounts(cleaned_accounts.as_slice())
            .expect("清理默认账号失败");
        accounts = cleaned_accounts;
    }

    // 固定 Flowlet 对外模型；旧自定义模型保留供高级模式使用。
    let mut virtual_models = storage.list_virtual_models().expect("读取虚拟模型失败");
    let now = chrono::Utc::now().to_rfc3339();
    for (id, name) in [
        ("flowlet-pro", "Flowlet Pro"),
        ("flowlet-flash", "Flowlet Flash"),
    ] {
        if !virtual_models.iter().any(|model| model.id == id) {
            virtual_models.push(VirtualModel {
                id: id.to_string(),
                name: name.to_string(),
                protocol_type: ProtocolType::OpenAi,
                routing_strategy: "model_order_then_round_robin".to_string(),
                enabled: true,
                created_at: now.clone(),
                updated_at: now.clone(),
            });
        }
    }
    storage
        .save_virtual_models(virtual_models.as_slice())
        .expect("保存固定 Flowlet 模型失败");
    // 清理旧版本遗留的默认路由和已经无法服务的孤儿路由。
    let mut routes = storage.list_route_candidates().expect("读取路由配置失败");
    let cleaned_routes: Vec<RouteCandidate> = routes
        .iter()
        .filter(|route| {
            if route.id == "route-auto-default" || route.account_id == "account-default" {
                return false;
            }
            if !route.enabled {
                return true;
            }
            if route.upstream_model.trim().is_empty()
                || route.channel_id.trim().is_empty()
                || route.account_id.trim().is_empty()
            {
                return false;
            }
            if !channels
                .iter()
                .any(|channel| channel.id == route.channel_id)
            {
                return false;
            }
            accounts.iter().any(|account| {
                account.id == route.account_id
                    && account.channel_id == route.channel_id
                    && account.enabled
                    && !account.api_key.trim().is_empty()
            })
        })
        .cloned()
        .collect();
    if cleaned_routes.len() != routes.len() {
        storage
            .save_route_candidates(cleaned_routes.as_slice())
            .expect("清理默认路由失败");
        routes = cleaned_routes;
    }
    let merged_routes = channels_config.merge_default_routes(&routes, &accounts, &channels);
    if merged_routes.len() != routes.len() {
        storage
            .save_route_candidates(merged_routes.as_slice())
            .expect("补齐默认路由失败");
        routes = merged_routes;
    }
    storage
        .cleanup_orphan_balance_snapshots()
        .expect("清理孤儿余额快照失败");
    tracing::trace!(
        t_ms = _t0.elapsed().as_millis() as u64,
        "step: routes + balance cleanup"
    );

    // 初始化价格预设：仅从 config.json 加载到内存，作为费用的唯一真实来源。
    // 不再写入数据库——价格表已移除，费用计算直接在内存中完成。
    let prices = channels_config.prices.clone();
    storage.set_prices(prices);
    tracing::trace!(
        t_ms = _t0.elapsed().as_millis() as u64,
        count = channels_config.prices.len(),
        "step: prices loaded from config"
    );

    // 初始化路由规则
    tracing::trace!(
        t_ms = _t0.elapsed().as_millis() as u64,
        "step: loading rules"
    );
    let rules = storage.list_route_rules().expect("读取路由规则失败");
    tracing::trace!(
        t_ms = _t0.elapsed().as_millis() as u64,
        count = rules.len(),
        "step: rules loaded"
    );

    // 从 config.json 顶层 log_capture 读取
    let capture = if let Some(json_str) = core::proxy::read_config_raw(&config_path) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&json_str) {
            core::proxy::extract_log_capture(&value)
        } else {
            LogCaptureConfig::default()
        }
    } else {
        LogCaptureConfig::default()
    };

    // Body 清理全部交给 setup 里的定时任务（启动后 15 分钟触发第一次）。
    // 启动时不做任何清理动作，避免阻塞主界面。
    let _ = capture;

    // 优先从 config.json 顶层 bind 读取；缺失时回退到 SQLite app_meta 旧配置
    let bind_config = if let Some(json_str) = core::proxy::read_config_raw(&config_path) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&json_str) {
            if let Some(obj) = value.as_object() {
                if let Some(bind) = obj.get("bind").and_then(|v| v.as_object()) {
                    let host = bind
                        .get("host")
                        .and_then(|v| v.as_str())
                        .unwrap_or("127.0.0.1")
                        .to_string();
                    let port = bind.get("port").and_then(|v| v.as_u64()).unwrap_or(18640) as u16;
                    let allow_lan = host == "0.0.0.0";
                    let default_client_token = bind
                        .get("default_client_token")
                        .and_then(|v| v.as_str())
                        .unwrap_or("flowlet-local-token")
                        .to_string();
                    ProxyBindConfig {
                        host,
                        port,
                        allow_lan,
                        default_client_token,
                    }
                    .normalized()
                } else {
                    load_bind_config_from_sqlite(&storage)
                }
            } else {
                load_bind_config_from_sqlite(&storage)
            }
        } else {
            load_bind_config_from_sqlite(&storage)
        }
    } else {
        load_bind_config_from_sqlite(&storage)
    };

    let state = AppState {
        proxy: ProxyController {
            inner: Arc::new(Mutex::new(core::proxy::ProxyRuntime::default())),
            bind_config: Arc::new(Mutex::new(bind_config.clone())),
        },
        channels: Arc::new(Mutex::new(channels)),
        accounts: Arc::new(Mutex::new(accounts)),
        routes: Arc::new(Mutex::new(routes)),
        virtual_models: Arc::new(Mutex::new(virtual_models)),
        rules: Arc::new(Mutex::new(rules)),
        storage,
        upstream_timeout_seconds: 120,
        capture: Arc::new(Mutex::new(capture)),
        bind_config: Arc::new(Mutex::new(bind_config)),
        tray: Arc::new(Mutex::new(None)),
        config_path,
        codex_accounts_dir,
        channels_config: Arc::new(Mutex::new((*channels_config).clone())),
        agent_source_watcher: Arc::new(Mutex::new(None)),
        scrape_webviews: Arc::new(Mutex::new(std::collections::HashMap::new())),
        scrape_pending: Arc::new(Mutex::new(std::collections::HashMap::new())),
    };
    tracing::info!(
        t_ms = _t0.elapsed().as_millis() as u64,
        "build_app_state 全部完成"
    );
    state
}

pub(crate) fn load_bind_config_from_sqlite(storage: &Storage) -> ProxyBindConfig {
    storage
        .get_app_meta("proxy_bind_config")
        .unwrap_or_default()
        .and_then(|json| serde_json::from_str::<ProxyBindConfig>(&json).ok())
        .unwrap_or_default()
        .normalized()
}

/// 数据库路径：始终放在 exe 同级目录下，与程序完全自包含。
/// 不再区分「安装/便携」模式 — SQLite 和日志都在 exe 旁。
fn app_database_path(_app: &tauri::App) -> std::path::PathBuf {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."));

    let app_data_dir = exe_dir;
    std::fs::create_dir_all(&app_data_dir).expect("创建应用数据目录失败");

    let db_path = app_data_dir.join("flowlet.sqlite");
    migrate_legacy_database(&db_path);
    db_path
}

/// 从指定 config.json 文件解析其中的 channels_config 字段
pub fn load_channels_config_from(config_path: &std::path::Path) -> Result<ChannelsConfig, String> {
    let external_result = std::fs::read_to_string(config_path)
        .map_err(|e| format!("读取 config.json 失败 ({}): {}", config_path.display(), e))
        .and_then(|content| parse_channels_config(&content, &config_path.display().to_string()));

    match external_result {
        Ok(config) => Ok(config),
        Err(external_error) => {
            tracing::warn!(
                path = %config_path.display(),
                error = %external_error,
                "外部 config.json 无法提供渠道配置，回退到应用内置默认配置"
            );
            parse_channels_config(DEFAULT_CONFIG_JSON, "应用内置 config.json").map_err(
                |fallback_error| {
                    format!(
                        "外部渠道配置不可用: {external_error}; 内置渠道配置也不可用: {fallback_error}"
                    )
                },
            )
        }
    }
}

/// 将内置 config.json 中外部配置可能缺失的渠道、价格、端点合并进运行时配置。
pub(crate) fn merge_builtin_config(mut external: ChannelsConfig) -> ChannelsConfig {
    let builtin = match parse_channels_config(DEFAULT_CONFIG_JSON, "应用内置 config.json") {
        Ok(cfg) => cfg,
        Err(e) => {
            tracing::warn!(error = %e, "解析内置渠道配置失败，跳过合并");
            return external;
        }
    };

    for bp in &builtin.presets {
        if !external.presets.iter().any(|p| p.id == bp.id) {
            external.presets.push(bp.clone());
        }
    }

    for bp in &builtin.prices {
        if !external
            .prices
            .iter()
            .any(|p| p.channel_id == bp.channel_id && p.upstream_model == bp.upstream_model)
        {
            external.prices.push(bp.clone());
        }
    }

    for (channel_id, channel_endpoints) in &builtin.endpoints {
        external
            .endpoints
            .entry(channel_id.clone())
            .or_insert_with(|| channel_endpoints.clone());
    }

    for (channel_id, models) in &builtin.default_exposed_models {
        external
            .default_exposed_models
            .entry(channel_id.clone())
            .or_insert_with(|| models.clone());
    }

    for (channel_id, tiers) in &builtin.flowlet_tiers {
        external
            .flowlet_tiers
            .entry(channel_id.clone())
            .or_insert_with(|| tiers.clone());
    }

    external
}

fn parse_channels_config(content: &str, source: &str) -> Result<ChannelsConfig, String> {
    let json: serde_json::Value =
        serde_json::from_str(content).map_err(|e| format!("解析 {source} 失败: {e}"))?;
    ChannelsConfig::from_config_json(&json)
}

#[cfg(test)]
mod app_config_tests {
    use super::*;

    #[test]
    fn old_config_without_channels_uses_embedded_defaults() {
        let path =
            std::env::temp_dir().join(format!("flowlet-old-config-{}.json", uuid::Uuid::new_v4()));
        std::fs::write(&path, r#"{"ua_rules": []}"#).unwrap();

        let config = load_channels_config_from(&path).unwrap();
        let _ = std::fs::remove_file(path);

        assert!(config.presets.iter().any(|channel| channel.id == "longcat"));
        assert!(config
            .presets
            .iter()
            .any(|channel| channel.id == "deepseek"));
        assert!(config.presets.iter().any(|channel| channel.id == "kimi"));
        assert!(config.presets.iter().any(|channel| channel.id == "qwen"));
    }

    #[test]
    fn missing_external_config_uses_embedded_defaults() {
        let path = std::env::temp_dir().join(format!(
            "flowlet-missing-config-{}.json",
            uuid::Uuid::new_v4()
        ));

        let config = load_channels_config_from(&path).unwrap();

        assert!(!config.presets.is_empty());
    }
}

fn migrate_legacy_database(db_path: &std::path::Path) {
    if db_path.exists() {
        return;
    }

    let legacy_db_path = std::env::current_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
        .join("flowlet.sqlite");
    if !legacy_db_path.exists() {
        return;
    }

    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent).expect("创建数据库迁移目录失败");
    }

    std::fs::copy(&legacy_db_path, db_path).expect("迁移 SQLite 数据库失败");
    for suffix in ["-wal", "-shm"] {
        let legacy_sidecar = legacy_db_path.with_file_name(format!(
            "{}{}",
            legacy_db_path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("flowlet.sqlite"),
            suffix
        ));
        if legacy_sidecar.exists() {
            let target_sidecar = db_path.with_file_name(format!("flowlet.sqlite{}", suffix));
            let _ = std::fs::copy(legacy_sidecar, target_sidecar);
        }
    }
}

pub fn run() {
    // main.rs 会更早调用；保留这里可保证 flowlet_lib 被其他宿主直接调用时也有日志。
    let _ = crate::core::logging::init_file_logging();
    crate::core::logging::install_panic_hook();
    let start_hidden = std::env::args().any(|arg| arg == "--hidden" || arg == "--minimized");
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            let setup_t0 = std::time::Instant::now();
            tracing::info!("tauri setup 开始");

            let config_path = app.path().resource_dir()?.join("config.json");
            let state = build_app_state(app_database_path(app), config_path);
            app.manage(state.clone());
            let state_for_tray = state.clone();
            tracing::info!(
                t_ms = setup_t0.elapsed().as_millis() as u64,
                "setup: state managed"
            );

            let app_handle = app.handle();
            match core::agent_source_watcher::start_agent_source_watcher(app_handle.clone()) {
                Ok(watcher) => {
                    if let Ok(mut guard) = state.agent_source_watcher.lock() {
                        *guard = Some(watcher);
                    }
                }
                Err(error) => {
                    tracing::warn!(%error, "Agent 数据源文件监听未启用，将继续使用定时轮询")
                }
            }

            // 关闭窗口时隐藏到托盘，而非退出。自启动传入 --hidden 时保持后台托盘模式。
            if let Some(window) = app.get_webview_window("main") {
                if !start_hidden {
                    let _ = window.show();
                    let _ = window.set_focus();
                }

                let window_label = window.label().to_string();
                let app_handle_for_window = app_handle.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        if let Some(w) = app_handle_for_window.get_webview_window(&window_label) {
                            let _ = w.hide();
                        }
                        api.prevent_close();
                    }
                });
            }

            // 构建托盘菜单
            let toggle = MenuItem::with_id(app_handle, "toggle", "显示/隐藏", true, None::<&str>)?;
            let start_item = MenuItem::with_id(
                app_handle,
                "start_proxy",
                "重启代理服务",
                true,
                None::<&str>,
            )?;
            let quit = MenuItem::with_id(app_handle, "quit", "退出 Flowlet", true, None::<&str>)?;
            let menu = Menu::with_items(app_handle, &[&toggle, &start_item, &quit])?;

            // 创建系统托盘（使用项目 icons/tray.png，保留菜单与点击事件）
            let tray_icon = tauri::include_image!("icons/tray.png");
            let tray = TrayIconBuilder::with_id("main-tray")
                .tooltip("Flowlet - 代理已停止 ⏹")
                .icon(tray_icon)
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app: &AppHandle, event| match event.id().as_ref() {
                    "toggle" => {
                        toggle_window_to_front(app);
                    }
                    "start_proxy" => {
                        if let Some(state) = app.try_state::<AppState>() {
                            let state = state.inner().clone();
                            let app_clone = app.clone();
                            tauri::async_runtime::spawn(async move {
                                if state.proxy.status().running {
                                    let _ = state.proxy.stop().await;
                                }
                                match state.start_configured_proxy().await {
                                    Ok(()) => update_tray_tooltip(&app_clone, true),
                                    Err(_) => update_tray_tooltip(&app_clone, false),
                                }
                            });
                        }
                    }
                    "quit" => {
                        let app_clone = app.clone();
                        let proxy = app.try_state::<AppState>().map(|state| state.proxy.clone());
                        tauri::async_runtime::spawn(async move {
                            if let Some(proxy) = proxy {
                                let _ = proxy.stop().await;
                            }
                            app_clone.exit(0);
                        });
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle_window_to_front(tray.app_handle());
                    }
                })
                .build(app_handle)?;

            // 保存 tray 引用到 state
            if let Ok(mut tray_guard) = state_for_tray.tray.lock() {
                *tray_guard = Some(tray);
            }

            // 定时 Body 清理：启动后 15 分钟触发第一次，之后每 15 分钟跑一次。
            // 启动时不做任何清理动作，全部交给定时任务。
            // 每次清理在 spawn_blocking 中执行（不阻塞主线程），结果写入 background_jobs。
            let timer_storage = state.storage.clone();
            let timer_config_path = state.config_path.clone();
            tauri::async_runtime::spawn(async move {
                let period = std::time::Duration::from_secs(15 * 60);
                let mut interval =
                    tokio::time::interval_at(tokio::time::Instant::now() + period, period);
                interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
                loop {
                    interval.tick().await;
                    let storage = timer_storage.clone();
                    let cfg_path = timer_config_path.clone();
                    let result = tauri::async_runtime::spawn_blocking(move || {
                        storage.run_scheduled_body_cleanup_job(&cfg_path)
                    })
                    .await;
                    match result {
                        Ok(Ok((job_id, expired, pruned, before, after))) => {
                            let before_mb = before as f64 / 1048576.0;
                            let after_mb = after as f64 / 1048576.0;
                            tracing::info!(
                                job_id = %job_id,
                                expired,
                                pruned,
                                before_mb = format!("{before_mb:.1}"),
                                after_mb = format!("{after_mb:.1}"),
                                "scheduled body cleanup finished"
                            );
                        }
                        Ok(Err(error)) => {
                            tracing::warn!(error = %error, "scheduled body cleanup job failed");
                        }
                        Err(error) => {
                            tracing::warn!(error = %error, "scheduled body cleanup task panicked");
                        }
                    }
                }
            });

            tracing::info!(
                t_ms = setup_t0.elapsed().as_millis() as u64,
                "✅ setup 完成 — invoke_handler + Tauri event loop 接管"
            );

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::detect_agent_environment,
            commands::list_cached_codex_accounts,
            commands::query_codex_accounts,
            commands::sync_codex_accounts,
            commands::authorize_codex_account,
            commands::inspect_agent_global_config,
            commands::apply_agent_global_config,
            commands::restore_agent_global_config,
            commands::start_proxy,
            commands::stop_proxy,
            commands::proxy_status,
            commands::test_connection,
            commands::get_proxy_bind_config,
            commands::set_proxy_bind_config,
            commands::list_channel_presets,
            commands::save_channel_presets,
            commands::list_channel_accounts,
            commands::save_channel_accounts,
            commands::list_route_candidates,
            commands::save_route_candidates,
            commands::list_channel_models,
            commands::list_virtual_models,
            commands::save_virtual_models,
            commands::analyze_usage,
            commands::repair_agent_sessions,
            commands::repair_captured_usage,
            commands::repair_unknown_usage,
            commands::repair_usage_costs,
            commands::usage_summary,
            commands::list_request_logs,
            commands::list_agent_sessions,
            commands::list_agent_session_children,
            commands::get_agent_session_timeline,
            commands::get_agent_session_native_summary,
            commands::sync_agent_data,
            commands::list_background_jobs,
            commands::get_background_job_detail,
            commands::get_agent_sync_status,
            commands::cancel_background_job,
            commands::cleanup_background_jobs,
            commands::probe_cost_ledger_sources,
            commands::list_agent_session_clients,
            commands::list_request_log_clients,
            commands::list_request_log_models,
            commands::get_request_log_detail,
            commands::get_log_capture_config,
            commands::set_log_capture_config,
            commands::query_balance,
            commands::sync_models,
            commands::save_balance_snapshot,
            commands::list_balance_snapshots,
            commands::latest_balance_snapshots,
            commands::open_scrape_console,
            commands::close_scrape_console,
            commands::handle_intercepted_response,
            commands::probe_scrape_login,
            commands::scrape_balance,
            commands::account_stats,
            commands::is_autostart_enabled,
            commands::enable_autostart,
            commands::disable_autostart,
            commands::list_route_rules,
            commands::save_route_rules,
            commands::account_routing_scores,
            commands::export_config,
            commands::import_config,
            commands::export_all_data,
            commands::import_all_data,
            commands::db_stats,
            commands::storage_usage_summary,
            commands::read_app_meta,
            commands::write_app_meta,
            commands::cleanup_old_logs,
            commands::cleanup_expired_body_data,
            commands::prune_oldest_body_data,
            commands::get_total_body_size_bytes,
            commands::read_config,
            commands::write_config,
            commands::ipc_ping,
            commands::log_from_frontend,
        ])
        .run(tauri::generate_context!())
        .expect("启动 Flowlet 失败");
}

/// 切换主窗口显示/隐藏。显示时确保窗口被恢复到前台焦点状态。
/// 仅 show + set_focus 可能无法把窗口带到前台，因此额外做 unminimize
/// 和短暂置顶再取消的操作覆盖 Windows 等场景。
fn toggle_window_to_front(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
            return;
        }
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_always_on_top(true);
        let _ = window.set_focus();
        let _ = window.set_always_on_top(false);
    }
}

/// 更新托盘 tooltip 显示代理状态
fn update_tray_tooltip(app: &AppHandle, running: bool) {
    let tooltip = if running {
        "Flowlet - 代理运行中 ✅"
    } else {
        "Flowlet - 代理已停止 ⏹"
    };
    let state = app.state::<AppState>();
    let tray_guard = match state.tray.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    if let Some(ref t) = *tray_guard {
        let _ = t.set_tooltip(Some(tooltip));
    }
}

/// 内部启动代理逻辑（供托盘菜单调用）
async fn start_proxy_internal(
    proxy: ProxyController,
    config: ProxyStartupConfig,
) -> Result<(), String> {
    let ProxyStartupConfig {
        shared,
        storage,
        timeout,
        capture,
        bind_addr,
        config_path,
    } = config;

    // 传入 shared（持有 Arc 引用），代理运行中会锁定读取最新配置
    proxy
        .start_with_bind(
            shared,
            storage,
            timeout,
            capture,
            &bind_addr,
            core::rate_limiter::RateLimiter::new(600),
            config_path,
        )
        .await
        .map_err(|err| err.to_string())
}
