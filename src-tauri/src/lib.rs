pub mod core;

use core::config::{
    AccountBalanceSnapshot, AccountStatsRow, ChannelAccount, ChannelPreset, ClientConfig,
    ModelPrice, ProtocolType, RequestLogRow, RouteCandidate, RouteRule, UsageSummaryRow,
    VirtualModel,
};
use core::presets::{builtin_model_prices, BalanceQueryResult, ModelSyncResult};
use core::proxy::{ProxyController, ProxyStatus};
use core::storage::Storage;
use core::sync::{query_deepseek_balance, sync_deepseek_models};
use std::sync::{Arc, Mutex};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::ManagerExt;

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

// ─── Proxy Commands ──────────────────────────────────────────────────────────

#[tauri::command]
async fn start_proxy(app: AppHandle, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let channels = state
        .channels
        .lock()
        .map_err(|_| "读取渠道配置失败".to_string())?
        .clone();
    let accounts = state
        .accounts
        .lock()
        .map_err(|_| "读取账号配置失败".to_string())?
        .clone();
    let routes = state
        .routes
        .lock()
        .map_err(|_| "读取路由配置失败".to_string())?
        .clone();
    let clients = state
        .clients
        .lock()
        .map_err(|_| "读取客户端配置失败".to_string())?
        .clone();

    if channels.is_empty() {
        return Err("请先配置至少一个渠道".to_string());
    }
    if accounts.is_empty() {
        return Err("请先配置至少一个账号".to_string());
    }

    let rules = state
        .rules
        .lock()
        .map_err(|_| "读取规则失败".to_string())?
        .clone();
    let scores = state.storage.account_routing_scores().unwrap_or_default();
    state
        .proxy
        .start(
            channels,
            accounts,
            clients,
            routes,
            rules,
            scores,
            state.storage.clone(),
            state.upstream_timeout_seconds,
        )
        .await
        .map_err(|err| err.to_string())?;

    // 更新托盘 tooltip
    update_tray_tooltip(&app, true);
    Ok(())
}

#[tauri::command]
async fn stop_proxy(app: AppHandle, state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.proxy.stop().await.map_err(|err| err.to_string())?;
    // 更新托盘 tooltip
    update_tray_tooltip(&app, false);
    Ok(())
}

#[tauri::command]
fn proxy_status(state: tauri::State<'_, AppState>) -> ProxyStatus {
    state.proxy.status()
}

// ─── Channel Presets Commands ────────────────────────────────────────────────

#[tauri::command]
fn list_channel_presets(state: tauri::State<'_, AppState>) -> Result<Vec<ChannelPreset>, String> {
    state
        .channels
        .lock()
        .map(|channels| channels.clone())
        .map_err(|_| "读取渠道模板失败".to_string())
}

#[tauri::command]
fn save_channel_presets(
    state: tauri::State<'_, AppState>,
    presets: Vec<ChannelPreset>,
) -> Result<(), String> {
    state
        .storage
        .save_channel_presets(&presets)
        .map_err(|err| err.to_string())?;

    let mut current = state
        .channels
        .lock()
        .map_err(|_| "保存渠道模板失败".to_string())?;
    *current = presets;
    Ok(())
}

// ─── Channel Accounts Commands ──────────────────────────────────────────────

#[tauri::command]
fn list_channel_accounts(state: tauri::State<'_, AppState>) -> Result<Vec<ChannelAccount>, String> {
    state
        .accounts
        .lock()
        .map(|accounts| accounts.clone())
        .map_err(|_| "读取账号配置失败".to_string())
}

#[tauri::command]
fn save_channel_accounts(
    state: tauri::State<'_, AppState>,
    accounts: Vec<ChannelAccount>,
) -> Result<(), String> {
    state
        .storage
        .save_channel_accounts(&accounts)
        .map_err(|err| err.to_string())?;

    let mut current = state
        .accounts
        .lock()
        .map_err(|_| "保存账号配置失败".to_string())?;
    *current = accounts;
    Ok(())
}

// ─── Route Candidates Commands ──────────────────────────────────────────────

#[tauri::command]
fn list_route_candidates(state: tauri::State<'_, AppState>) -> Result<Vec<RouteCandidate>, String> {
    state
        .routes
        .lock()
        .map(|routes| routes.clone())
        .map_err(|_| "读取路由配置失败".to_string())
}

#[tauri::command]
fn save_route_candidates(
    state: tauri::State<'_, AppState>,
    routes: Vec<RouteCandidate>,
) -> Result<(), String> {
    state
        .storage
        .save_route_candidates(&routes)
        .map_err(|err| err.to_string())?;

    let mut current = state
        .routes
        .lock()
        .map_err(|_| "保存路由配置失败".to_string())?;
    *current = routes;
    Ok(())
}

// ─── Clients Commands ────────────────────────────────────────────────────────

#[tauri::command]
fn list_clients(state: tauri::State<'_, AppState>) -> Result<Vec<ClientConfig>, String> {
    state
        .clients
        .lock()
        .map(|clients| clients.clone())
        .map_err(|_| "读取客户端配置失败".to_string())
}

#[tauri::command]
fn save_clients(
    state: tauri::State<'_, AppState>,
    clients: Vec<ClientConfig>,
) -> Result<(), String> {
    state
        .storage
        .save_clients(&clients)
        .map_err(|err| err.to_string())?;

    let mut current = state
        .clients
        .lock()
        .map_err(|_| "保存客户端配置失败".to_string())?;
    *current = clients;
    Ok(())
}

// ─── Model Prices Commands ──────────────────────────────────────────────────

#[tauri::command]
fn list_model_prices(state: tauri::State<'_, AppState>) -> Result<Vec<ModelPrice>, String> {
    state
        .prices
        .lock()
        .map(|prices| prices.clone())
        .map_err(|_| "读取价格配置失败".to_string())
}

#[tauri::command]
fn save_model_prices(
    state: tauri::State<'_, AppState>,
    prices: Vec<ModelPrice>,
) -> Result<(), String> {
    state
        .storage
        .save_model_prices(&prices)
        .map_err(|err| err.to_string())?;

    let mut current = state
        .prices
        .lock()
        .map_err(|_| "保存价格配置失败".to_string())?;
    *current = prices;
    Ok(())
}

// ─── Virtual Models Commands ────────────────────────────────────────────────

#[tauri::command]
fn list_virtual_models(state: tauri::State<'_, AppState>) -> Result<Vec<VirtualModel>, String> {
    state
        .virtual_models
        .lock()
        .map(|models| models.clone())
        .map_err(|_| "读取虚拟模型失败".to_string())
}

#[tauri::command]
fn save_virtual_models(
    state: tauri::State<'_, AppState>,
    models: Vec<VirtualModel>,
) -> Result<(), String> {
    state
        .storage
        .save_virtual_models(&models)
        .map_err(|err| err.to_string())?;

    let mut current = state
        .virtual_models
        .lock()
        .map_err(|_| "保存虚拟模型失败".to_string())?;
    *current = models;
    Ok(())
}

// ─── Usage & Logs Commands ──────────────────────────────────────────────────

#[tauri::command]
fn analyze_usage(state: tauri::State<'_, AppState>) -> Result<usize, String> {
    let inserted = state
        .storage
        .analyze_unknown_usage()
        .map_err(|err| err.to_string())?;
    state
        .storage
        .recalculate_usage_costs()
        .map_err(|err| err.to_string())?;
    Ok(inserted)
}

#[tauri::command]
fn usage_summary(state: tauri::State<'_, AppState>) -> Result<Vec<UsageSummaryRow>, String> {
    state.storage.usage_summary().map_err(|err| err.to_string())
}

#[tauri::command]
fn list_request_logs(state: tauri::State<'_, AppState>) -> Result<Vec<RequestLogRow>, String> {
    state
        .storage
        .list_request_logs()
        .map_err(|err| err.to_string())
}

// ─── Sync Commands ──────────────────────────────────────────────────────────

#[tauri::command]
async fn query_balance(
    state: tauri::State<'_, AppState>,
    account_id: String,
) -> Result<BalanceQueryResult, String> {
    let account = {
        let accounts = state
            .accounts
            .lock()
            .map_err(|_| "读取账号失败".to_string())?;
        accounts
            .iter()
            .find(|a| a.id == account_id)
            .ok_or("账号不存在")?
            .clone()
    };

    // 目前仅支持 DeepSeek 余额查询
    if account.channel_id != "deepseek" {
        return Ok(BalanceQueryResult {
            balance: None,
            currency: None,
            is_available: false,
            error: Some("当前仅 DeepSeek 支持余额查询".to_string()),
        });
    }

    // 在 spawn_blocking 中执行 HTTP 调用，避免 Send 问题
    let result = tauri::async_runtime::spawn_blocking(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap_or_else(|_| panic!("创建运行时失败"));
        rt.block_on(query_deepseek_balance(&account))
    })
    .await
    .map_err(|e| format!("任务执行失败: {e}"))?;

    // 更新账号最后错误信息
    if let Some(ref err) = result.error {
        let _ = state.storage.update_account_last_error(&account_id, err);
    }

    Ok(result)
}

#[tauri::command]
async fn sync_models(
    state: tauri::State<'_, AppState>,
    account_id: String,
) -> Result<ModelSyncResult, String> {
    let account = {
        let accounts = state
            .accounts
            .lock()
            .map_err(|_| "读取账号失败".to_string())?;
        accounts
            .iter()
            .find(|a| a.id == account_id)
            .ok_or("账号不存在")?
            .clone()
    };

    if account.channel_id != "deepseek" {
        return Ok(ModelSyncResult {
            models_synced: 0,
            errors: vec!["当前仅 DeepSeek 支持模型列表同步".to_string()],
        });
    }

    let result = tauri::async_runtime::spawn_blocking(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap_or_else(|_| panic!("创建运行时失败"));
        rt.block_on(sync_deepseek_models(&account))
    })
    .await
    .map_err(|e| format!("任务执行失败: {e}"))?;

    if result.errors.is_empty() {
        let _ = state.storage.update_account_last_used(&account_id);
    } else if let Some(first_err) = result.errors.first() {
        let _ = state
            .storage
            .update_account_last_error(&account_id, first_err);
    }

    Ok(result)
}

// ─── Balance Snapshot Commands ──────────────────────────────────────────────

#[tauri::command]
fn save_balance_snapshot(
    state: tauri::State<'_, AppState>,
    snapshot: AccountBalanceSnapshot,
) -> Result<(), String> {
    state
        .storage
        .save_balance_snapshot(&snapshot)
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn list_balance_snapshots(
    state: tauri::State<'_, AppState>,
    account_id: String,
) -> Result<Vec<AccountBalanceSnapshot>, String> {
    state
        .storage
        .list_balance_snapshots(&account_id)
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn latest_balance_snapshots(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<AccountBalanceSnapshot>, String> {
    state
        .storage
        .latest_balance_snapshots()
        .map_err(|err| err.to_string())
}

// ─── Account Stats Commands ────────────────────────────────────────────────

#[tauri::command]
fn account_stats(state: tauri::State<'_, AppState>) -> Result<Vec<AccountStatsRow>, String> {
    state.storage.account_stats().map_err(|err| err.to_string())
}

// ─── Route Rules Commands ──────────────────────────────────────────────────

#[tauri::command]
fn list_route_rules(state: tauri::State<'_, AppState>) -> Result<Vec<RouteRule>, String> {
    state
        .rules
        .lock()
        .map(|rules| rules.clone())
        .map_err(|_| "读取路由规则失败".to_string())
}

#[tauri::command]
fn save_route_rules(
    state: tauri::State<'_, AppState>,
    rules: Vec<RouteRule>,
) -> Result<(), String> {
    state
        .storage
        .save_route_rules(&rules)
        .map_err(|err| err.to_string())?;

    let mut current = state
        .rules
        .lock()
        .map_err(|_| "保存路由规则失败".to_string())?;
    *current = rules;
    Ok(())
}

// ─── Config Validation ────────────────────────────────────────────────────

#[tauri::command]
fn validate_config(state: tauri::State<'_, AppState>) -> Result<Vec<String>, String> {
    let mut errors = Vec::new();

    let channels = state.channels.lock().map_err(|_| "锁失败".to_string())?;
    let accounts = state.accounts.lock().map_err(|_| "锁失败".to_string())?;
    let routes = state.routes.lock().map_err(|_| "锁失败".to_string())?;
    let clients = state.clients.lock().map_err(|_| "锁失败".to_string())?;

    if channels.is_empty() {
        errors.push("至少需要一个渠道".to_string());
    }
    if accounts.is_empty() {
        errors.push("至少需要一个账号".to_string());
    }

    // 检查渠道是否有对应账号
    for channel in channels.iter() {
        let has_account = accounts
            .iter()
            .any(|a| a.channel_id == channel.id && a.enabled);
        if !has_account {
            errors.push(format!("渠道 '{}' 没有启用的账号", channel.name));
        }
    }

    // 检查账号 API Key
    for account in accounts.iter().filter(|a| a.enabled) {
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

    // 检查路由引用有效性
    for route in routes.iter().filter(|r| r.enabled) {
        if !channels.iter().any(|c| c.id == route.channel_id) {
            errors.push(format!("路由 '{}' 引用了不存在的渠道", route.id));
        }
        if !accounts.iter().any(|a| a.id == route.account_id) {
            errors.push(format!("路由 '{}' 引用了不存在的账号", route.id));
        }
    }

    // 检查客户端 Token
    for client in clients.iter().filter(|c| c.enabled) {
        if client.token.trim().is_empty() {
            errors.push(format!("客户端 '{}' 未配置 Token", client.name));
        }
    }

    Ok(errors)
}

// ─── Maintenance Commands ─────────────────────────────────────────────────

#[tauri::command]
fn db_stats(state: tauri::State<'_, AppState>) -> Result<(i64, i64, i64), String> {
    state.storage.db_stats().map_err(|err| err.to_string())
}

#[tauri::command]
fn cleanup_old_logs(
    state: tauri::State<'_, AppState>,
    keep_days: i64,
) -> Result<(usize, usize), String> {
    state
        .storage
        .cleanup_old_logs(keep_days)
        .map_err(|err| err.to_string())
}

// ─── Config Import/Export Commands ────────────────────────────────────────

#[tauri::command]
fn export_config(state: tauri::State<'_, AppState>) -> Result<String, String> {
    state.storage.export_config().map_err(|err| err.to_string())
}

#[tauri::command]
fn import_config(state: tauri::State<'_, AppState>, json: String) -> Result<(), String> {
    state
        .storage
        .import_config(&json)
        .map_err(|err| err.to_string())?;

    // 重新加载内存状态
    let channels = state
        .storage
        .list_channel_presets()
        .map_err(|e| e.to_string())?;
    let accounts = state
        .storage
        .list_channel_accounts()
        .map_err(|e| e.to_string())?;
    let routes = state
        .storage
        .list_route_candidates()
        .map_err(|e| e.to_string())?;
    let clients = state.storage.list_clients().map_err(|e| e.to_string())?;
    let rules = state
        .storage
        .list_route_rules()
        .map_err(|e| e.to_string())?;
    let prices = state
        .storage
        .list_model_prices()
        .map_err(|e| e.to_string())?;
    let virtual_models = state
        .storage
        .list_virtual_models()
        .map_err(|e| e.to_string())?;

    *state.channels.lock().map_err(|_| "锁失败".to_string())? = channels;
    *state.accounts.lock().map_err(|_| "锁失败".to_string())? = accounts;
    *state.routes.lock().map_err(|_| "锁失败".to_string())? = routes;
    *state.clients.lock().map_err(|_| "锁失败".to_string())? = clients;
    *state.rules.lock().map_err(|_| "锁失败".to_string())? = rules;
    *state.prices.lock().map_err(|_| "锁失败".to_string())? = prices;
    *state
        .virtual_models
        .lock()
        .map_err(|_| "锁失败".to_string())? = virtual_models;

    Ok(())
}

// ─── Smart Routing Commands ───────────────────────────────────────────────

#[tauri::command]
fn account_routing_scores(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<(String, String, f64, f64, f64)>, String> {
    state
        .storage
        .account_routing_scores()
        .map_err(|err| err.to_string())
}

// ─── Auto-start Commands ───────────────────────────────────────────────────

#[tauri::command]
fn is_autostart_enabled(app: AppHandle) -> Result<bool, String> {
    let autostart = app.autolaunch();
    autostart
        .is_enabled()
        .map_err(|e| format!("检查自启动状态失败: {e}"))
}

#[tauri::command]
fn enable_autostart(app: AppHandle) -> Result<(), String> {
    let autostart = app.autolaunch();
    autostart
        .enable()
        .map_err(|e| format!("启用自启动失败: {e}"))
}

#[tauri::command]
fn disable_autostart(app: AppHandle) -> Result<(), String> {
    let autostart = app.autolaunch();
    autostart
        .disable()
        .map_err(|e| format!("禁用自启动失败: {e}"))
}

// ─── App Entry ──────────────────────────────────────────────────────────────

pub fn run() {
    let db_path = std::env::current_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
        .join("flowlet.sqlite");
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

    // 初始化账号
    let accounts = storage.list_channel_accounts().expect("读取账号配置失败");
    let accounts = if accounts.is_empty() {
        let now = chrono::Utc::now().to_rfc3339();
        let default_account = ChannelAccount {
            id: "account-default".to_string(),
            channel_id: "longcat".to_string(),
            name: "默认账号".to_string(),
            api_key: String::new(),
            enabled: true,
            priority: 0,
            remark: Some("请编辑账号并填入 LongCat API Key".to_string()),
            last_used_at: None,
            last_error: None,
            created_at: now.clone(),
            updated_at: now,
        };
        let accounts = vec![default_account];
        storage
            .save_channel_accounts(accounts.as_slice())
            .expect("保存默认账号失败");
        accounts
    } else {
        accounts
    };

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

    // 初始化路由候选
    let routes = storage.list_route_candidates().expect("读取路由配置失败");
    let routes = if routes.is_empty() {
        let now = chrono::Utc::now().to_rfc3339();
        let default_route = RouteCandidate {
            id: "route-auto-default".to_string(),
            virtual_model_id: "auto".to_string(),
            channel_id: "longcat".to_string(),
            account_id: "account-default".to_string(),
            upstream_model: "LongCat-2.0".to_string(),
            client_protocol: ProtocolType::OpenAi,
            priority: 0,
            enabled: true,
            created_at: now.clone(),
            updated_at: now,
        };
        let routes = vec![default_route];
        storage
            .save_route_candidates(routes.as_slice())
            .expect("保存默认路由失败");
        routes
    } else {
        routes
    };

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

    let state = AppState {
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
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .plugin(tauri_plugin_opener::init())
        .manage(state.clone())
        .setup(move |app| {
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
                            let proxy = state.proxy.clone();
                            let channels = state.channels.clone();
                            let accounts = state.accounts.clone();
                            let routes = state.routes.clone();
                            let clients = state.clients.clone();
                            let rules = state.rules.clone();
                            let storage = state.storage.clone();
                            let timeout = state.upstream_timeout_seconds;
                            let app_clone = app.clone();
                            tauri::async_runtime::spawn(async move {
                                match start_proxy_internal(
                                    proxy, channels, accounts, routes, clients, rules, storage,
                                    timeout,
                                )
                                .await
                                {
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
            start_proxy,
            stop_proxy,
            proxy_status,
            list_channel_presets,
            save_channel_presets,
            list_channel_accounts,
            save_channel_accounts,
            list_route_candidates,
            save_route_candidates,
            list_clients,
            save_clients,
            list_model_prices,
            save_model_prices,
            list_virtual_models,
            save_virtual_models,
            analyze_usage,
            usage_summary,
            list_request_logs,
            query_balance,
            sync_models,
            save_balance_snapshot,
            list_balance_snapshots,
            latest_balance_snapshots,
            account_stats,
            is_autostart_enabled,
            enable_autostart,
            disable_autostart,
            list_route_rules,
            save_route_rules,
            account_routing_scores,
            export_config,
            import_config,
            validate_config,
            db_stats,
            cleanup_old_logs,
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
    channels: Arc<Mutex<Vec<ChannelPreset>>>,
    accounts: Arc<Mutex<Vec<ChannelAccount>>>,
    routes: Arc<Mutex<Vec<RouteCandidate>>>,
    clients: Arc<Mutex<Vec<ClientConfig>>>,
    rules: Arc<Mutex<Vec<RouteRule>>>,
    storage: Storage,
    timeout: u64,
) -> Result<(), String> {
    let channels = channels
        .lock()
        .map_err(|_| "读取渠道配置失败".to_string())?
        .clone();
    let accounts = accounts
        .lock()
        .map_err(|_| "读取账号配置失败".to_string())?
        .clone();
    let routes = routes
        .lock()
        .map_err(|_| "读取路由配置失败".to_string())?
        .clone();
    let clients = clients
        .lock()
        .map_err(|_| "读取客户端配置失败".to_string())?
        .clone();
    let rules = rules
        .lock()
        .map_err(|_| "读取路由规则失败".to_string())?
        .clone();
    let scores = storage.account_routing_scores().unwrap_or_default();

    if channels.is_empty() {
        return Err("请先配置至少一个渠道".to_string());
    }
    if accounts.is_empty() {
        return Err("请先配置至少一个账号".to_string());
    }

    proxy
        .start(
            channels, accounts, clients, routes, rules, scores, storage, timeout,
        )
        .await
        .map_err(|err| err.to_string())
}
