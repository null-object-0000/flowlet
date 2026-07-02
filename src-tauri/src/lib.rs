mod core;

use core::config::{ClientConfig, ModelPrice, ProviderConfig, VirtualModelRoute};
use core::proxy::{ProxyController, ProxyStatus};
use core::storage::{RequestLogRow, Storage, UsageSummaryRow};
use std::sync::{Arc, Mutex};

#[derive(Clone)]
struct AppState {
    proxy: ProxyController,
    provider: Arc<Mutex<ProviderConfig>>,
    routes: Arc<Mutex<Vec<VirtualModelRoute>>>,
    clients: Arc<Mutex<Vec<ClientConfig>>>,
    prices: Arc<Mutex<Vec<ModelPrice>>>,
    storage: Storage,
}

#[tauri::command]
async fn start_proxy(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let provider = state
        .provider
        .lock()
        .map_err(|_| "读取 Provider 配置失败".to_string())?
        .clone();
    let routes = state
        .routes
        .lock()
        .map_err(|_| "读取虚拟模型路由失败".to_string())?
        .clone();
    let clients = state
        .clients
        .lock()
        .map_err(|_| "读取 Client Token 失败".to_string())?
        .clone();
    state
        .proxy
        .start(provider, routes, clients, state.storage.clone())
        .await
        .map_err(|err| err.to_string())
}

#[tauri::command]
async fn stop_proxy(state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.proxy.stop().await.map_err(|err| err.to_string())
}

#[tauri::command]
fn proxy_status(state: tauri::State<'_, AppState>) -> ProxyStatus {
    state.proxy.status()
}

#[tauri::command]
fn get_provider(state: tauri::State<'_, AppState>) -> Result<ProviderConfig, String> {
    state
        .provider
        .lock()
        .map(|provider| provider.clone())
        .map_err(|_| "读取 Provider 配置失败".to_string())
}

#[tauri::command]
fn save_provider(
    state: tauri::State<'_, AppState>,
    provider: ProviderConfig,
) -> Result<(), String> {
    state
        .storage
        .save_provider(&provider)
        .map_err(|err| err.to_string())?;

    let mut current = state
        .provider
        .lock()
        .map_err(|_| "保存 Provider 配置失败".to_string())?;
    *current = provider;
    Ok(())
}

#[tauri::command]
fn list_virtual_model_routes(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<VirtualModelRoute>, String> {
    state
        .routes
        .lock()
        .map(|routes| routes.clone())
        .map_err(|_| "读取虚拟模型路由失败".to_string())
}

#[tauri::command]
fn save_virtual_model_routes(
    state: tauri::State<'_, AppState>,
    routes: Vec<VirtualModelRoute>,
) -> Result<(), String> {
    state
        .storage
        .save_virtual_model_routes(&routes)
        .map_err(|err| err.to_string())?;

    let mut current = state
        .routes
        .lock()
        .map_err(|_| "保存虚拟模型路由失败".to_string())?;
    *current = routes;
    Ok(())
}

#[tauri::command]
fn list_clients(state: tauri::State<'_, AppState>) -> Result<Vec<ClientConfig>, String> {
    state
        .clients
        .lock()
        .map(|clients| clients.clone())
        .map_err(|_| "读取 Client Token 失败".to_string())
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
        .map_err(|_| "保存 Client Token 失败".to_string())?;
    *current = clients;
    Ok(())
}

#[tauri::command]
fn list_model_prices(state: tauri::State<'_, AppState>) -> Result<Vec<ModelPrice>, String> {
    state
        .prices
        .lock()
        .map(|prices| prices.clone())
        .map_err(|_| "读取模型价格失败".to_string())
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
        .map_err(|_| "保存模型价格失败".to_string())?;
    *current = prices;
    Ok(())
}

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

pub fn run() {
    let db_path = std::env::current_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
        .join("flowlet.sqlite");
    let storage = Storage::open(db_path).expect("初始化 SQLite 存储失败");
    let provider = storage
        .get_provider()
        .expect("读取 Provider 配置失败")
        .unwrap_or_default();
    let routes = storage
        .list_virtual_model_routes()
        .expect("读取虚拟模型路由失败");
    let routes = if routes.is_empty() {
        vec![VirtualModelRoute::default_auto(
            provider.default_model.clone(),
        )]
    } else {
        routes
    };
    let clients = storage.list_clients().expect("读取 Client Token 失败");
    let clients = if clients.is_empty() {
        vec![ClientConfig {
            id: "client-default".to_string(),
            name: "本机默认客户端".to_string(),
            token: "flowlet-local-token".to_string(),
            app_type: "local".to_string(),
            enabled: true,
        }]
    } else {
        clients
    };
    let prices = storage.list_model_prices().expect("读取模型价格失败");

    let state = AppState {
        proxy: ProxyController::default(),
        provider: Arc::new(Mutex::new(provider)),
        routes: Arc::new(Mutex::new(routes)),
        clients: Arc::new(Mutex::new(clients)),
        prices: Arc::new(Mutex::new(prices)),
        storage,
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            start_proxy,
            stop_proxy,
            proxy_status,
            get_provider,
            save_provider,
            list_virtual_model_routes,
            save_virtual_model_routes,
            list_clients,
            save_clients,
            list_model_prices,
            save_model_prices,
            analyze_usage,
            usage_summary,
            list_request_logs
        ])
        .run(tauri::generate_context!())
        .expect("启动 Flowlet 失败");
}
