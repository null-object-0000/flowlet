use crate::AppState;
use crate::core::config::{
    ChannelAccount, ChannelModel, ChannelPreset, RouteCandidate, VirtualModel,
};

#[tauri::command]
pub(crate) fn list_channel_presets(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<ChannelPreset>, String> {
    state
        .channels
        .lock()
        .map(|channels| channels.clone())
        .map_err(|_| "读取渠道模板失败".to_string())
}

#[tauri::command]
pub(crate) fn save_channel_presets(
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

#[tauri::command]
pub(crate) fn list_channel_accounts(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<ChannelAccount>, String> {
    state
        .accounts
        .lock()
        .map(|accounts| accounts.clone())
        .map_err(|_| "读取账号配置失败".to_string())
}

#[tauri::command]
pub(crate) fn save_channel_accounts(
    state: tauri::State<'_, AppState>,
    accounts: Vec<ChannelAccount>,
) -> Result<Vec<ChannelAccount>, String> {
    state
        .storage
        .save_channel_accounts(&accounts)
        .map_err(|err| err.to_string())?;

    // 从数据库重新读取规范化后的账号列表（API Key 变化时 credential_status 已被重置）。
    let normalized = state
        .storage
        .list_channel_accounts()
        .map_err(|err| err.to_string())?;

    let mut current = state
        .accounts
        .lock()
        .map_err(|_| "保存账号配置失败".to_string())?;
    *current = normalized.clone();
    Ok(normalized)
}

#[tauri::command]
pub(crate) fn list_route_candidates(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<RouteCandidate>, String> {
    state
        .routes
        .lock()
        .map(|routes| routes.clone())
        .map_err(|_| "读取路由配置失败".to_string())
}

#[tauri::command]
pub(crate) fn save_route_candidates(
    state: tauri::State<'_, AppState>,
    routes: Vec<RouteCandidate>,
) -> Result<(), String> {
    state
        .storage
        .save_route_candidates(&routes)
        .map_err(|err| {
            let msg = err.to_string();
            tracing::error!(error = %msg, "保存路由候选失败");
            msg
        })?;

    let mut current = state.routes.lock().map_err(|_| {
        let msg = "保存路由配置失败".to_string();
        tracing::error!("{}", msg);
        msg
    })?;
    *current = routes;
    Ok(())
}

#[tauri::command]
pub(crate) fn list_channel_models(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<ChannelModel>, String> {
    state
        .storage
        .list_channel_models()
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(crate) fn list_virtual_models(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<VirtualModel>, String> {
    state
        .virtual_models
        .lock()
        .map(|models| models.clone())
        .map_err(|_| "读取虚拟模型失败".to_string())
}

#[tauri::command]
pub(crate) fn save_virtual_models(
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
