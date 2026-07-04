mod commands;
pub mod core;

use core::config::{
    ChannelAccount, ChannelPreset, ClientConfig, ModelPrice, ProtocolType, RouteCandidate,
    RouteRule, VirtualModel,
};
use core::presets::builtin_model_prices;
use core::proxy::ProxyController;
use core::storage::Storage;
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
    clients: Arc<Mutex<Vec<ClientConfig>>>,
    prices: Arc<Mutex<Vec<ModelPrice>>>,
    virtual_models: Arc<Mutex<Vec<VirtualModel>>>,
    rules: Arc<Mutex<Vec<RouteRule>>>,
    storage: Storage,
    upstream_timeout_seconds: u64,
    tray: Arc<Mutex<Option<TrayIcon>>>,
}

struct ProxyStartupConfig {
    shared: core::proxy::ProxySharedConfig,
    storage: Storage,
    timeout: u64,
}

impl AppState {
    fn proxy_startup_config(&self) -> Result<ProxyStartupConfig, String> {
        // 启动时传入 Arc 引用，而非 clone 数据副本 — 代理运行中与 UI 共享同一份配置
        Ok(ProxyStartupConfig {
            shared: core::proxy::ProxySharedConfig {
                channels: Arc::clone(&self.channels),
                accounts: Arc::clone(&self.accounts),
                clients: Arc::clone(&self.clients),
                routes: Arc::clone(&self.routes),
                rules: Arc::clone(&self.rules),
                scores: Arc::new(Mutex::new(Vec::new())),
            },
            storage: self.storage.clone(),
            timeout: self.upstream_timeout_seconds,
        })
    }

    async fn start_configured_proxy(&self) -> Result<(), String> {
        start_proxy_internal(self.proxy.clone(), self.proxy_startup_config()?).await
    }
}

// ─── Config Validation ────────────────────────────────────────────────────

fn validate_config_values(
    channels: &[ChannelPreset],
    accounts: &[ChannelAccount],
    routes: &[RouteCandidate],
    clients: &[ClientConfig],
) -> Vec<String> {
    let mut errors = Vec::new();

    if channels.is_empty() {
        errors.push("至少需要一个渠道".to_string());
    }

    let enabled_accounts: Vec<&ChannelAccount> =
        accounts.iter().filter(|account| account.enabled).collect();
    let enabled_routes: Vec<&RouteCandidate> =
        routes.iter().filter(|route| route.enabled).collect();

    if enabled_accounts.is_empty() {
        errors.push("请先新增并启用至少一个渠道账号".to_string());
    }
    if enabled_routes.is_empty() {
        errors.push("请至少开放一个模型".to_string());
    }

    for account in enabled_accounts {
        if account.api_key.trim().is_empty() {
            errors.push(format!("账号 '{}' 未配置 API Key", account.name));
        }
        if !channels.iter().any(|c| c.id == account.channel_id) {
            errors.push(format!(
                "账号 '{}' 引用了不存在的渠道 '{}'",
                account.name, account.channel_id
            ));
        }
    }

    for route in enabled_routes {
        if !channels.iter().any(|c| c.id == route.channel_id) {
            errors.push(format!(
                "对外开放模型 '{}' 找不到可用渠道",
                route.upstream_model
            ));
        }
        match accounts.iter().find(|a| a.id == route.account_id) {
            Some(account) => {
                if !account.enabled {
                    errors.push(format!(
                        "对外开放模型 '{}' 使用的账号 '{}' 未启用",
                        route.upstream_model, account.name
                    ));
                }
                if account.api_key.trim().is_empty() {
                    errors.push(format!(
                        "对外开放模型 '{}' 使用的账号 '{}' 未配置 API Key",
                        route.upstream_model, account.name
                    ));
                }
                if account.channel_id != route.channel_id {
                    errors.push(format!(
                        "对外开放模型 '{}' 的来源渠道与账号所属渠道不一致",
                        route.upstream_model
                    ));
                }
            }
            None => errors.push(format!(
                "对外开放模型 '{}' 找不到可用账号",
                route.upstream_model
            )),
        }
    }

    // 检查客户端 Token
    for client in clients.iter().filter(|c| c.enabled) {
        if client.token.trim().is_empty() {
            errors.push(format!("客户端 '{}' 未配置 Token", client.name));
        }
    }

    errors
}

// ─── App Entry ──────────────────────────────────────────────────────────────

fn build_app_state(db_path: std::path::PathBuf) -> AppState {
    let storage = Storage::open(db_path).expect("初始化 SQLite 存储失败");

    // 初始化渠道模板
    let channels = storage.list_channel_presets().expect("读取渠道模板失败");
    let channels = if channels.is_empty() {
        let now = chrono::Utc::now().to_rfc3339();
        let mut longcat = ChannelPreset::longcat();
        longcat.created_at = now.clone();
        longcat.updated_at = now.clone();
        let mut deepseek = ChannelPreset::deepseek();
        deepseek.created_at = now.clone();
        deepseek.updated_at = now;
        let presets = vec![longcat, deepseek];
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

    // 初始化虚拟模型
    let virtual_models = storage.list_virtual_models().expect("读取虚拟模型失败");
    let virtual_models = if virtual_models.is_empty() {
        let now = chrono::Utc::now().to_rfc3339();
        let auto_model = VirtualModel {
            id: "auto".to_string(),
            name: "auto".to_string(),
            protocol_type: ProtocolType::OpenAi,
            routing_strategy: "priority".to_string(),
            enabled: true,
            created_at: now.clone(),
            updated_at: now,
        };
        let models = vec![auto_model];
        storage
            .save_virtual_models(models.as_slice())
            .expect("保存默认虚拟模型失败");
        models
    } else {
        virtual_models
    };

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
    storage
        .cleanup_orphan_balance_snapshots()
        .expect("清理孤儿余额快照失败");

    // 初始化客户端
    let clients = storage.list_clients().expect("读取客户端配置失败");
    let clients = if clients.is_empty() {
        let now = chrono::Utc::now().to_rfc3339();
        let default_client = ClientConfig {
            id: "client-default".to_string(),
            name: "本机默认客户端".to_string(),
            token: "flowlet-local-token".to_string(),
            app_type: "local".to_string(),
            enabled: true,
            created_at: now.clone(),
            updated_at: now,
        };
        let clients = vec![default_client];
        storage
            .save_clients(clients.as_slice())
            .expect("保存默认客户端失败");
        clients
    } else {
        clients
    };

    // 初始化价格预设
    let prices = storage.list_model_prices().expect("读取价格配置失败");
    let prices = if prices.is_empty() {
        let all_prices: Vec<ModelPrice> = channels
            .iter()
            .flat_map(|c| builtin_model_prices(&c.id))
            .collect();
        if !all_prices.is_empty() {
            storage
                .save_model_prices(all_prices.as_slice())
                .expect("保存默认价格失败");
        }
        all_prices
    } else {
        prices
    };

    // 初始化路由规则
    let rules = storage.list_route_rules().expect("读取路由规则失败");

    AppState {
        proxy: ProxyController::default(),
        channels: Arc::new(Mutex::new(channels)),
        accounts: Arc::new(Mutex::new(accounts)),
        routes: Arc::new(Mutex::new(routes)),
        clients: Arc::new(Mutex::new(clients)),
        prices: Arc::new(Mutex::new(prices)),
        virtual_models: Arc::new(Mutex::new(virtual_models)),
        rules: Arc::new(Mutex::new(rules)),
        storage,
        upstream_timeout_seconds: 120,
        tray: Arc::new(Mutex::new(None)),
    }
}

fn app_database_path(app: &tauri::App) -> std::path::PathBuf {
    let app_data_dir = app.path().app_data_dir().expect("获取应用数据目录失败");
    std::fs::create_dir_all(&app_data_dir).expect("创建应用数据目录失败");

    let db_path = app_data_dir.join("flowlet.sqlite");
    migrate_legacy_database(&db_path);
    db_path
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
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            let state = build_app_state(app_database_path(app));
            app.manage(state.clone());

            let app_handle = app.handle();

            // 关闭窗口时隐藏到托盘，而非退出
            if let Some(window) = app.get_webview_window("main") {
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
            let start_item =
                MenuItem::with_id(app_handle, "start_proxy", "启动代理", true, None::<&str>)?;
            let stop_item =
                MenuItem::with_id(app_handle, "stop_proxy", "停止代理", true, None::<&str>)?;
            let quit = MenuItem::with_id(app_handle, "quit", "退出 Flowlet", true, None::<&str>)?;
            let menu = Menu::with_items(app_handle, &[&toggle, &start_item, &stop_item, &quit])?;

            // 创建系统托盘
            let tray = TrayIconBuilder::with_id("main-tray")
                .tooltip("Flowlet - 代理已停止 ⏹")
                .icon(app_handle.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app: &AppHandle, event| match event.id().as_ref() {
                    "toggle" => {
                        if let Some(window) = app.get_webview_window("main") {
                            if window.is_visible().unwrap_or(false) {
                                let _ = window.hide();
                            } else {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    }
                    "start_proxy" => {
                        if let Some(state) = app.try_state::<AppState>() {
                            let state = state.inner().clone();
                            let app_clone = app.clone();
                            tauri::async_runtime::spawn(async move {
                                match state.start_configured_proxy().await {
                                    Ok(()) => update_tray_tooltip(&app_clone, true),
                                    Err(_) => update_tray_tooltip(&app_clone, false),
                                }
                            });
                        }
                    }
                    "stop_proxy" => {
                        if let Some(state) = app.try_state::<AppState>() {
                            let proxy = state.proxy.clone();
                            let app_clone = app.clone();
                            tauri::async_runtime::spawn(async move {
                                let _ = proxy.stop().await;
                                update_tray_tooltip(&app_clone, false);
                            });
                        }
                    }
                    "quit" => {
                        app.exit(0);
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
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            if window.is_visible().unwrap_or(false) {
                                let _ = window.hide();
                            } else {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    }
                })
                .build(app_handle)?;

            // 保存 tray 引用到 state
            if let Ok(mut tray_guard) = state.tray.lock() {
                *tray_guard = Some(tray);
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::start_proxy,
            commands::stop_proxy,
            commands::proxy_status,
            commands::list_channel_presets,
            commands::save_channel_presets,
            commands::list_channel_accounts,
            commands::save_channel_accounts,
            commands::list_route_candidates,
            commands::save_route_candidates,
            commands::list_clients,
            commands::save_clients,
            commands::list_model_prices,
            commands::save_model_prices,
            commands::list_channel_models,
            commands::list_virtual_models,
            commands::save_virtual_models,
            commands::analyze_usage,
            commands::usage_summary,
            commands::list_request_logs,
            commands::query_balance,
            commands::sync_models,
            commands::save_balance_snapshot,
            commands::list_balance_snapshots,
            commands::latest_balance_snapshots,
            commands::account_stats,
            commands::is_autostart_enabled,
            commands::enable_autostart,
            commands::disable_autostart,
            commands::list_route_rules,
            commands::save_route_rules,
            commands::account_routing_scores,
            commands::export_config,
            commands::import_config,
            commands::db_stats,
            commands::cleanup_old_logs,
        ])
        .run(tauri::generate_context!())
        .expect("启动 Flowlet 失败");
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
    } = config;

    // 校验当前配置是否合法
    let channels = shared.channels.lock().map_err(|_| "锁失败".to_string())?.clone();
    let accounts = shared.accounts.lock().map_err(|_| "锁失败".to_string())?.clone();
    let routes = shared.routes.lock().map_err(|_| "锁失败".to_string())?.clone();
    let clients = shared.clients.lock().map_err(|_| "锁失败".to_string())?.clone();

    let validation_errors = validate_config_values(&channels, &accounts, &routes, &clients);
    if !validation_errors.is_empty() {
        return Err(validation_errors.join("\n"));
    }

    // 传入 shared（持有 Arc 引用），代理运行中会锁定读取最新配置
    proxy
        .start(shared, storage, timeout)
        .await
        .map_err(|err| err.to_string())
}
