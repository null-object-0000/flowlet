use crate::core::config::{
    ChannelAccount, ChannelModel, ChannelPreset, RouteCandidate, VirtualModel,
};
use crate::AppState;

#[tauri::command]
pub(crate) fn list_channel_presets(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<ChannelPreset>, String> {
    Ok(state.runtime_config.snapshot().channels.clone())
}

#[tauri::command]
pub(crate) fn save_channel_presets(
    state: tauri::State<'_, AppState>,
    presets: Vec<ChannelPreset>,
) -> Result<(), String> {
    state.runtime_config.update_after(
        || {
            state
                .storage
                .save_channel_presets(&presets)
                .map_err(|err| err.to_string())?;
            Ok::<_, String>(presets)
        },
        |snapshot, persisted| snapshot.channels = persisted.clone(),
    )?;
    Ok(())
}

#[tauri::command]
pub(crate) fn list_channel_accounts(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<ChannelAccount>, String> {
    Ok(state.runtime_config.snapshot().accounts.clone())
}

#[tauri::command]
pub(crate) async fn save_channel_accounts(
    state: tauri::State<'_, AppState>,
    mut accounts: Vec<ChannelAccount>,
) -> Result<Vec<ChannelAccount>, String> {
    let previous = state
        .storage
        .list_channel_accounts()
        .map_err(|err| err.to_string())?;
    if crate::core::account_workspace_sync::is_enabled(&state.storage)
        && crate::core::account_workspace_sync::global_accounts_changed(&previous, &accounts)
    {
        crate::core::account_workspace_sync::push_accounts(&state.storage, &mut accounts).await?;
    }
    // 保存后从数据库重新读取规范化账号（API Key 变化时 credential_status 已重置）；
    // 保存或重读任一步失败都不会发布新的运行时 revision。
    let normalized = state.runtime_config.update_after(
        || {
            state
                .storage
                .save_channel_accounts(&accounts)
                .map_err(|err| err.to_string())?;
            state
                .storage
                .list_channel_accounts()
                .map_err(|err| err.to_string())
        },
        |snapshot, normalized| snapshot.accounts = normalized.clone(),
    )?;
    Ok(normalized)
}

#[tauri::command]
pub(crate) fn list_route_candidates(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<RouteCandidate>, String> {
    Ok(state.runtime_config.snapshot().routes.clone())
}

#[tauri::command]
pub(crate) fn save_route_candidates(
    state: tauri::State<'_, AppState>,
    routes: Vec<RouteCandidate>,
) -> Result<(), String> {
    state.runtime_config.update_after(
        || {
            state
                .storage
                .save_route_candidates(&routes)
                .map_err(|err| {
                    let msg = err.to_string();
                    tracing::error!(error = %msg, "保存路由候选失败");
                    msg
                })?;
            Ok::<_, String>(routes)
        },
        |snapshot, persisted| snapshot.routes = persisted.clone(),
    )?;
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
    Ok(state.runtime_config.snapshot().virtual_models.clone())
}

#[tauri::command]
pub(crate) fn save_virtual_models(
    state: tauri::State<'_, AppState>,
    models: Vec<VirtualModel>,
) -> Result<(), String> {
    state.runtime_config.update_after(
        || {
            state
                .storage
                .save_virtual_models(&models)
                .map_err(|err| err.to_string())?;
            Ok::<_, String>(models)
        },
        |snapshot, persisted| snapshot.virtual_models = persisted.clone(),
    )?;
    Ok(())
}
