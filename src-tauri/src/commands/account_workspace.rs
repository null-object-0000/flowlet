use crate::core::account_workspace_sync::{self, AccountWorkspaceSyncResult};
use crate::AppState;

#[tauri::command]
pub(crate) fn get_account_workspace_status(
    state: tauri::State<'_, AppState>,
) -> Result<account_workspace_sync::AccountWorkspaceStatus, String> {
    account_workspace_sync::status(&state.storage)
}

#[tauri::command]
pub(crate) async fn initialize_account_workspace(
    state: tauri::State<'_, AppState>,
) -> Result<AccountWorkspaceSyncResult, String> {
    let result = account_workspace_sync::initialize(state.storage.clone()).await?;
    refresh_accounts(&state)?;
    Ok(result)
}

#[tauri::command]
pub(crate) async fn sync_account_workspace(
    state: tauri::State<'_, AppState>,
) -> Result<AccountWorkspaceSyncResult, String> {
    let result = account_workspace_sync::sync(state.storage.clone(), "manual").await?;
    refresh_accounts(&state)?;
    Ok(result)
}

#[tauri::command]
pub(crate) fn export_desktop_account_workspace(
    state: tauri::State<'_, AppState>,
) -> Result<account_workspace_sync::DesktopAccountWorkspacePackage, String> {
    account_workspace_sync::export_desktop_package(&state.storage)
}

#[tauri::command]
pub(crate) async fn import_desktop_account_workspace(
    state: tauri::State<'_, AppState>,
    package: account_workspace_sync::DesktopAccountWorkspacePackage,
) -> Result<AccountWorkspaceSyncResult, String> {
    account_workspace_sync::import_desktop_package(&state.storage, &package).await?;
    let result = account_workspace_sync::sync(state.storage.clone(), "manual").await?;
    refresh_accounts(&state)?;
    Ok(result)
}

fn refresh_accounts(state: &tauri::State<'_, AppState>) -> Result<(), String> {
    let accounts = state
        .storage
        .list_channel_accounts()
        .map_err(|error| error.to_string())?;
    *state
        .accounts
        .lock()
        .map_err(|_| "刷新账号工作区缓存失败".to_string())? = accounts;
    Ok(())
}
