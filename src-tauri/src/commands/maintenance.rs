use super::proxy_status;
use crate::AppState;
use tauri::{AppHandle, Emitter};
use tauri_plugin_autostart::ManagerExt;

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct StorageUsageProgress {
    scan_id: String,
    summary: crate::core::storage::StorageUsageSummary,
}

#[tauri::command]
pub(crate) fn read_app_meta(
    state: tauri::State<'_, AppState>,
    key: String,
) -> Result<Option<String>, String> {
    state
        .storage
        .get_app_meta(&key)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(crate) fn write_app_meta(
    state: tauri::State<'_, AppState>,
    key: String,
    value: String,
) -> Result<(), String> {
    state
        .storage
        .set_app_meta(&key, &value)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(crate) fn db_stats(state: tauri::State<'_, AppState>) -> Result<(i64, i64, i64), String> {
    state.storage.db_stats().map_err(|err| err.to_string())
}

#[tauri::command]
pub(crate) async fn storage_usage_summary(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    scan_id: String,
) -> Result<crate::core::storage::StorageUsageSummary, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let config_bytes = std::fs::metadata(&state.config_path)
            .map(|metadata| metadata.len().min(i64::MAX as u64) as i64)
            .unwrap_or(0);
        state
            .storage
            .storage_usage_summary_with_progress(config_bytes, |summary| {
                let _ = app.emit(
                    "storage-usage-progress",
                    StorageUsageProgress {
                        scan_id: scan_id.clone(),
                        summary,
                    },
                );
            })
            .map_err(|err| err.to_string())
    })
    .await
    .map_err(|error| format!("读取存储占用任务失败：{error}"))?
}

#[tauri::command]
pub(crate) async fn compact_database(
    state: tauri::State<'_, AppState>,
) -> Result<crate::core::storage::DatabaseCompactionResult, String> {
    if state.proxy.status().running {
        return Err("优化数据库前必须先暂停代理服务".to_string());
    }
    let storage = state.storage.clone();
    tauri::async_runtime::spawn_blocking(move || {
        tracing::info!("开始完整压缩数据库并启用增量空间回收");
        let result = storage
            .compact_database()
            .map_err(|error| error.to_string())?;
        tracing::info!(
            before_mb = format!("{:.1}", result.before.database_bytes as f64 / 1048576.0),
            after_mb = format!("{:.1}", result.after.database_bytes as f64 / 1048576.0),
            reclaimed_mb = format!("{:.1}", result.reclaimed_bytes as f64 / 1048576.0),
            "数据库完整压缩完成"
        );
        Ok(result)
    })
    .await
    .map_err(|error| format!("数据库优化任务失败：{error}"))?
}

#[tauri::command]
pub(crate) fn read_config(state: tauri::State<'_, AppState>) -> Result<String, String> {
    crate::core::proxy::read_config_raw(&state.config_path)
        .ok_or_else(|| "config.json 不存在或读取失败".to_string())
}

#[tauri::command]
pub(crate) fn write_config(
    state: tauri::State<'_, AppState>,
    content: String,
) -> Result<(), String> {
    crate::core::proxy::write_config_raw(&state.config_path, &content)
}

#[tauri::command]
pub(crate) fn ipc_ping() -> serde_json::Value {
    tracing::info!(pid = std::process::id(), "ipc_ping received");
    serde_json::json!({
        "ok": true,
        "pid": std::process::id(),
        "exe": std::env::current_exe().ok().map(|p| p.display().to_string()),
    })
}

#[tauri::command]
pub(crate) fn log_from_frontend(level: String, message: String) {
    let target = "flowlet_frontend";
    match level.as_str() {
        "error" => tracing::error!(target, message),
        "warn" => tracing::warn!(target, message),
        "debug" => tracing::debug!(target, message),
        _ => tracing::info!(target, message),
    }
}

#[tauri::command]
pub(crate) fn cleanup_old_logs(
    state: tauri::State<'_, AppState>,
    keep_days: i64,
) -> Result<(usize, usize), String> {
    state
        .storage
        .cleanup_old_logs(keep_days)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(crate) fn cleanup_expired_body_data(
    state: tauri::State<'_, AppState>,
    retention_days: i64,
) -> Result<usize, String> {
    state
        .storage
        .cleanup_expired_body_data(retention_days)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(crate) fn prune_oldest_body_data(
    state: tauri::State<'_, AppState>,
    target_bytes: i64,
    prune_ratio: f64,
) -> Result<usize, String> {
    state
        .storage
        .prune_oldest_body_data(target_bytes, prune_ratio)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(crate) fn get_total_body_size_bytes(state: tauri::State<'_, AppState>) -> Result<i64, String> {
    state
        .storage
        .get_total_body_size_bytes()
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(crate) fn export_config(state: tauri::State<'_, AppState>) -> Result<String, String> {
    state.storage.export_config().map_err(|err| err.to_string())
}

#[tauri::command]
pub(crate) fn import_config(state: tauri::State<'_, AppState>, json: String) -> Result<(), String> {
    state
        .storage
        .import_config(&json)
        .map_err(|err| err.to_string())?;

    let channels = state
        .storage
        .list_channel_presets()
        .map_err(|error| error.to_string())?;
    let accounts = state
        .storage
        .list_channel_accounts()
        .map_err(|error| error.to_string())?;
    let routes = state
        .storage
        .list_route_candidates()
        .map_err(|error| error.to_string())?;
    let rules = state
        .storage
        .list_route_rules()
        .map_err(|error| error.to_string())?;
    let virtual_models = state
        .storage
        .list_virtual_models()
        .map_err(|error| error.to_string())?;

    *state.channels.lock().map_err(|_| "锁失败".to_string())? = channels;
    *state.accounts.lock().map_err(|_| "锁失败".to_string())? = accounts;
    *state.routes.lock().map_err(|_| "锁失败".to_string())? = routes;
    *state.rules.lock().map_err(|_| "锁失败".to_string())? = rules;
    *state
        .virtual_models
        .lock()
        .map_err(|_| "锁失败".to_string())? = virtual_models;
    Ok(())
}

#[tauri::command]
pub(crate) fn account_routing_scores(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<(String, String, f64, f64, f64)>, String> {
    state
        .storage
        .account_routing_scores()
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(crate) fn is_autostart_enabled(app: AppHandle) -> Result<bool, String> {
    app.autolaunch()
        .is_enabled()
        .map_err(|error| format!("检查自启动状态失败: {error}"))
}

#[tauri::command]
pub(crate) fn enable_autostart(app: AppHandle) -> Result<(), String> {
    app.autolaunch()
        .enable()
        .map_err(|error| format!("启用自启动失败: {error}"))
}

#[tauri::command]
pub(crate) fn disable_autostart(app: AppHandle) -> Result<(), String> {
    app.autolaunch()
        .disable()
        .map_err(|error| format!("禁用自启动失败: {error}"))
}

#[tauri::command]
pub(crate) fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
pub(crate) fn get_app_data_dir() -> String {
    // 数据目录与 exe 同级，便携/安装模式统一。
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(|directory| directory.to_path_buf()))
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    exe_dir.to_string_lossy().to_string()
}

#[tauri::command]
pub(crate) fn get_app_diagnostics(state: tauri::State<'_, AppState>) -> serde_json::Value {
    let os = format!("{} {}", std::env::consts::OS, std::env::consts::ARCH);
    let proxy = proxy_status(state);
    let proxy_status = if proxy.running { "running" } else { "stopped" };
    serde_json::json!({
        "os": os,
        "database": "healthy",
        "proxy": proxy_status,
    })
}
