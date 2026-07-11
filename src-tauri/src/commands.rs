use super::{update_tray_tooltip, AppState};
use crate::core::config::{
    AccountBalanceSnapshot, AccountStatsRow, ChannelAccount, ChannelModel, ChannelPreset,
    ClientConfig, LogCaptureConfig, LogsFilter, LogsPageResult, ModelPrice, ProxyBindConfig,
    RequestLogRow, RouteCandidate, RouteRule, UsageSummaryRow, VirtualModel,
};
use crate::core::presets::{BalanceQueryResult, ModelSyncResult};
use crate::core::proxy::ProxyStatus;
use crate::core::sync::{query_deepseek_balance, sync_deepseek_models, sync_longcat_models};
use tauri::AppHandle;
use tauri_plugin_autostart::ManagerExt;

// ─── Proxy Commands ──────────────────────────────────────────────────────────

#[tauri::command]
pub(super) async fn start_proxy(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    if state.proxy.status().running {
        update_tray_tooltip(&app, true);
        return Ok(());
    }
    tracing::info!("start_proxy: 开始启动本地代理");
    state.start_configured_proxy().await.map_err(|err| {
        tracing::error!(error = %err, "start_proxy: 启动失败");
        err
    })?;
    tracing::info!("start_proxy: 本地代理启动成功");
    update_tray_tooltip(&app, true);
    Ok(())
}

#[tauri::command]
pub(super) async fn stop_proxy(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    state.proxy.stop().await.map_err(|err| err.to_string())?;
    // 更新托盘 tooltip
    update_tray_tooltip(&app, false);
    Ok(())
}

#[tauri::command]
pub(super) fn proxy_status(state: tauri::State<'_, AppState>) -> ProxyStatus {
    let mut status = state.proxy.status();
    if !status.running {
        if let Ok(config) = state.bind_config.lock() {
            status.bind_addr = config.clone().normalized().bind_addr();
        }
    }
    status
}

#[tauri::command]
pub(super) fn get_proxy_bind_config(
    state: tauri::State<'_, AppState>,
) -> Result<ProxyBindConfig, String> {
    state
        .bind_config
        .lock()
        .map(|guard| guard.clone().normalized())
        .map_err(|_| "读取代理监听配置失败".to_string())
}

#[tauri::command]
pub(super) fn set_proxy_bind_config(
    state: tauri::State<'_, AppState>,
    config: ProxyBindConfig,
) -> Result<(), String> {
    let config = config.normalized();
    config
        .bind_addr()
        .parse::<std::net::SocketAddr>()
        .map_err(|_| "代理监听地址无效".to_string())?;
    let json = serde_json::to_string(&config).map_err(|err| err.to_string())?;
    state
        .storage
        .set_app_meta("proxy_bind_config", &json)
        .map_err(|err| err.to_string())?;
    if let Ok(mut guard) = state.bind_config.lock() {
        *guard = config;
    }
    Ok(())
}
// ─── Channel Presets Commands ────────────────────────────────────────────────

#[tauri::command]
pub(super) fn list_channel_presets(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<ChannelPreset>, String> {
    state
        .channels
        .lock()
        .map(|channels| channels.clone())
        .map_err(|_| "读取渠道模板失败".to_string())
}

#[tauri::command]
pub(super) fn save_channel_presets(
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
pub(super) fn list_channel_accounts(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<ChannelAccount>, String> {
    state
        .accounts
        .lock()
        .map(|accounts| accounts.clone())
        .map_err(|_| "读取账号配置失败".to_string())
}

#[tauri::command]
pub(super) fn save_channel_accounts(
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
pub(super) fn list_route_candidates(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<RouteCandidate>, String> {
    state
        .routes
        .lock()
        .map(|routes| routes.clone())
        .map_err(|_| "读取路由配置失败".to_string())
}

#[tauri::command]
pub(super) fn save_route_candidates(
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
pub(super) fn list_clients(state: tauri::State<'_, AppState>) -> Result<Vec<ClientConfig>, String> {
    state
        .clients
        .lock()
        .map(|clients| clients.clone())
        .map_err(|_| "读取客户端配置失败".to_string())
}

#[tauri::command]
pub(super) fn save_clients(
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
pub(super) fn list_model_prices(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<ModelPrice>, String> {
    state
        .prices
        .lock()
        .map(|prices| prices.clone())
        .map_err(|_| "读取价格配置失败".to_string())
}

#[tauri::command]
pub(super) fn save_model_prices(
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

#[tauri::command]
pub(super) fn list_channel_models(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<ChannelModel>, String> {
    state
        .storage
        .list_channel_models()
        .map_err(|err| err.to_string())
}

// ─── Virtual Models Commands ────────────────────────────────────────────────

#[tauri::command]
pub(super) fn list_virtual_models(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<VirtualModel>, String> {
    state
        .virtual_models
        .lock()
        .map(|models| models.clone())
        .map_err(|_| "读取虚拟模型失败".to_string())
}

#[tauri::command]
pub(super) fn save_virtual_models(
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
pub(super) fn analyze_usage(state: tauri::State<'_, AppState>) -> Result<usize, String> {
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
pub(super) fn usage_summary(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<UsageSummaryRow>, String> {
    state.storage.usage_summary().map_err(|err| err.to_string())
}

#[tauri::command]
pub(super) fn list_request_logs(
    state: tauri::State<'_, AppState>,
    filter: LogsFilter,
) -> Result<LogsPageResult, String> {
    state
        .storage
        .list_request_logs_page(filter)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(super) fn get_request_log_detail(
    state: tauri::State<'_, AppState>,
    request_id: String,
) -> Result<Vec<RequestLogRow>, String> {
    state
        .storage
        .list_request_logs_by_request_id(&request_id)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(super) fn get_log_capture_config(
    state: tauri::State<'_, AppState>,
) -> Result<LogCaptureConfig, String> {
    state
        .capture
        .lock()
        .map(|guard| guard.clone())
        .map_err(|_| "锁失败".to_string())
}

#[tauri::command]
pub(super) fn set_log_capture_config(
    state: tauri::State<'_, AppState>,
    config: LogCaptureConfig,
) -> Result<(), String> {
    let json = serde_json::to_string(&config).map_err(|err| err.to_string())?;
    state
        .storage
        .set_app_meta("log_capture_config", &json)
        .map_err(|err| err.to_string())?;
    if let Ok(mut guard) = state.capture.lock() {
        *guard = config;
    }
    Ok(())
}

// ─── Sync Commands ──────────────────────────────────────────────────────────

#[tauri::command]
pub(super) async fn query_balance(
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
    } else {
        let now = chrono::Utc::now().to_rfc3339();
        let snapshot = AccountBalanceSnapshot {
            id: format!("balance-{}-{}", account_id, uuid::Uuid::new_v4()),
            account_id: account_id.clone(),
            balance: result.balance,
            currency: result.currency.clone(),
            token_pack_total: None,
            token_pack_used: None,
            token_pack_remaining: None,
            token_pack_expire_at: None,
            source: "sync".to_string(),
            synced_at: Some(now.clone()),
            remark: Some("DeepSeek /user/balance 自动同步".to_string()),
            created_at: now.clone(),
            updated_at: now,
        };
        state
            .storage
            .save_balance_snapshot(&snapshot)
            .map_err(|err| err.to_string())?;
        let _ = state.storage.update_account_last_used(&account_id);
    }

    Ok(result)
}

#[tauri::command]
pub(super) async fn sync_models(
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

    let channel_id = account.channel_id.clone();

    let result = match channel_id.as_str() {
        "deepseek" => tauri::async_runtime::spawn_blocking(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap_or_else(|_| panic!("创建运行时失败"));
            rt.block_on(sync_deepseek_models(&account))
        })
        .await
        .map_err(|e| format!("任务执行失败: {e}"))?,
        "longcat" => tauri::async_runtime::spawn_blocking(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap_or_else(|_| panic!("创建运行时失败"));
            rt.block_on(sync_longcat_models(&account))
        })
        .await
        .map_err(|e| format!("任务执行失败: {e}"))?,
        _ => {
            return Ok(ModelSyncResult {
                models_synced: 0,
                models: Vec::new(),
                errors: vec![format!("当前仅 DeepSeek 和 LongCat 支持模型列表同步")],
            });
        }
    };

    if result.errors.is_empty() {
        let mut models = state
            .storage
            .list_channel_models()
            .map_err(|err| err.to_string())?
            .into_iter()
            .filter(|model| model.channel_id != channel_id)
            .collect::<Vec<_>>();
        models.extend(result.models.clone());
        state
            .storage
            .save_channel_models(&models)
            .map_err(|err| err.to_string())?;
        let _ = state.storage.update_account_last_used(&account_id);
    } else if let Some(first_err) = result.errors.first() {
        let _ = state
            .storage
            .update_account_last_error(&account_id, first_err);
        // LongCat 同步失败时，以内置 LongCat-2.0 兜底
        if channel_id == "longcat" {
            ensure_longcat_fallback(&state, &account_id)?;
        }
    }

    Ok(result)
}

/// LongCat 同步失败时，确保内置 LongCat-2.0 模型存在
fn ensure_longcat_fallback(state: &AppState, account_id: &str) -> Result<(), String> {
    let mut models = state
        .storage
        .list_channel_models()
        .map_err(|err| err.to_string())?;
    let has_longcat = models.iter().any(|m| m.channel_id == "longcat" && m.model == "LongCat-2.0");
    if !has_longcat {
        let now = chrono::Utc::now().to_rfc3339();
        models.push(crate::core::config::ChannelModel {
            id: "longcat-LongCat-2.0".to_string(),
            channel_id: "longcat".to_string(),
            model: "LongCat-2.0".to_string(),
            display_name: Some("LongCat-2.0".to_string()),
            supported_protocols: vec![
                crate::core::config::ProtocolType::OpenAi,
                crate::core::config::ProtocolType::Anthropic,
            ],
            context_window: None,
            max_output_tokens: None,
            supports_stream: true,
            enabled: true,
            source: "fallback".to_string(),
            synced_at: Some(now.clone()),
            created_at: now.clone(),
            updated_at: now,
        });
        state
            .storage
            .save_channel_models(&models)
            .map_err(|err| err.to_string())?;
    }
    let _ = account_id;
    Ok(())
}

// ─── Balance Snapshot Commands ──────────────────────────────────────────────

#[tauri::command]
pub(super) fn save_balance_snapshot(
    state: tauri::State<'_, AppState>,
    snapshot: AccountBalanceSnapshot,
) -> Result<(), String> {
    state
        .storage
        .save_balance_snapshot(&snapshot)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(super) fn list_balance_snapshots(
    state: tauri::State<'_, AppState>,
    account_id: String,
) -> Result<Vec<AccountBalanceSnapshot>, String> {
    state
        .storage
        .list_balance_snapshots(&account_id)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(super) fn latest_balance_snapshots(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<AccountBalanceSnapshot>, String> {
    state
        .storage
        .latest_balance_snapshots()
        .map_err(|err| err.to_string())
}

// ─── Account Stats Commands ────────────────────────────────────────────────

#[tauri::command]
pub(super) fn account_stats(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<AccountStatsRow>, String> {
    state.storage.account_stats().map_err(|err| err.to_string())
}

// ─── Route Rules Commands ──────────────────────────────────────────────────

#[tauri::command]
pub(super) fn list_route_rules(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<RouteRule>, String> {
    state
        .rules
        .lock()
        .map(|rules| rules.clone())
        .map_err(|_| "读取路由规则失败".to_string())
}

#[tauri::command]
pub(super) fn save_route_rules(
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

// ─── Maintenance Commands ─────────────────────────────────────────────────

#[tauri::command]
pub(super) fn db_stats(state: tauri::State<'_, AppState>) -> Result<(i64, i64, i64), String> {
    state.storage.db_stats().map_err(|err| err.to_string())
}

#[tauri::command]
pub(super) fn read_config(state: tauri::State<'_, AppState>) -> Result<String, String> {
    let path = &state.config_path;
    crate::core::proxy::read_config_raw(path).ok_or_else(|| "config.json 不存在或读取失败".to_string())
}

#[tauri::command]
pub(super) fn write_config(state: tauri::State<'_, AppState>, content: String) -> Result<(), String> {
    let path = &state.config_path;
    crate::core::proxy::write_config_raw(path, &content)
}

/// 烟雾测试用：验证前端 IPC 能连上后端。返回当前进程环境摘要。
#[tauri::command]
pub(super) fn ipc_ping() -> serde_json::Value {
    tracing::info!(pid = std::process::id(), "ipc_ping received");
    serde_json::json!({
        "ok": true,
        "pid": std::process::id(),
        "exe": std::env::current_exe().ok().map(|p| p.display().to_string()),
    })
}

/// 前端日志落盘。JS 通过这个 Tauri 命令把 console 内容写到同一份文件日志里，
/// 这样 Rust + JS 在 portable 模式下都能集中排查。
#[tauri::command]
pub(super) fn log_from_frontend(level: String, message: String) {
    let target = "flowlet_frontend";
    match level.as_str() {
        "error" => tracing::error!(target, message),
        "warn" => tracing::warn!(target, message),
        "debug" => tracing::debug!(target, message),
        _ => tracing::info!(target, message),
    }
}

#[tauri::command]
pub(super) fn cleanup_old_logs(
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
pub(super) fn export_config(state: tauri::State<'_, AppState>) -> Result<String, String> {
    state.storage.export_config().map_err(|err| err.to_string())
}

#[tauri::command]
pub(super) fn import_config(state: tauri::State<'_, AppState>, json: String) -> Result<(), String> {
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
pub(super) fn account_routing_scores(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<(String, String, f64, f64, f64)>, String> {
    state
        .storage
        .account_routing_scores()
        .map_err(|err| err.to_string())
}

// ─── Auto-start Commands ───────────────────────────────────────────────────

#[tauri::command]
pub(super) fn is_autostart_enabled(app: AppHandle) -> Result<bool, String> {
    let autostart = app.autolaunch();
    autostart
        .is_enabled()
        .map_err(|e| format!("检查自启动状态失败: {e}"))
}

#[tauri::command]
pub(super) fn enable_autostart(app: AppHandle) -> Result<(), String> {
    let autostart = app.autolaunch();
    autostart
        .enable()
        .map_err(|e| format!("启用自启动失败: {e}"))
}

#[tauri::command]
pub(super) fn disable_autostart(app: AppHandle) -> Result<(), String> {
    let autostart = app.autolaunch();
    autostart
        .disable()
        .map_err(|e| format!("禁用自启动失败: {e}"))
}


