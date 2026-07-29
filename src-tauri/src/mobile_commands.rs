use super::MobileAppState;
use crate::core::device_identity::{DailyUsageTotal, KnownDevice, SharedAgentSession};

#[tauri::command]
pub(super) async fn list_shared_devices(
    state: tauri::State<'_, MobileAppState>,
) -> Result<Vec<KnownDevice>, String> {
    let storage = state.storage.clone();
    tauri::async_runtime::spawn_blocking(move || {
        storage
            .imported_known_devices()
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("读取共享设备目录任务失败：{error}"))?
}

#[tauri::command]
pub(super) async fn shared_device_daily_usage(
    state: tauri::State<'_, MobileAppState>,
    device_id: Option<String>,
) -> Result<Vec<DailyUsageTotal>, String> {
    let storage = state.storage.clone();
    tauri::async_runtime::spawn_blocking(move || {
        storage
            .imported_daily_usage(device_id.as_deref())
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("读取共享设备每日用量任务失败：{error}"))?
}

#[tauri::command]
pub(super) async fn list_shared_device_sessions(
    state: tauri::State<'_, MobileAppState>,
    device_id: Option<String>,
) -> Result<Vec<SharedAgentSession>, String> {
    let storage = state.storage.clone();
    tauri::async_runtime::spawn_blocking(move || {
        storage
            .imported_device_sessions(device_id.as_deref())
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("读取共享设备会话任务失败：{error}"))?
}

#[tauri::command]
pub(super) async fn get_s3_sync_settings(
    state: tauri::State<'_, MobileAppState>,
) -> Result<crate::core::device_sync::S3SyncSettings, String> {
    let storage = state.storage.clone();
    tauri::async_runtime::spawn_blocking(move || crate::core::device_sync::load_settings(&storage))
        .await
        .map_err(|_| "读取 S3 同步设置任务失败".to_string())?
}

#[tauri::command]
pub(super) async fn save_s3_sync_config(
    state: tauri::State<'_, MobileAppState>,
    config: crate::core::device_sync::S3SyncConfigInput,
) -> Result<crate::core::device_sync::S3SyncSettings, String> {
    let storage = state.storage.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::core::device_sync::save_config(&storage, &config)?;
        crate::core::device_sync::load_settings(&storage)
    })
    .await
    .map_err(|_| "保存 S3 同步设置任务失败".to_string())?
}

#[tauri::command]
pub(super) async fn test_s3_read_connection(
    _state: tauri::State<'_, MobileAppState>,
    config: crate::core::device_sync::S3SyncConfigInput,
) -> Result<crate::core::device_sync::S3ConnectionTestResult, String> {
    crate::core::device_sync::test_read_connection(&config).await
}

#[tauri::command]
pub(super) async fn refresh_shared_device_usage_s3(
    state: tauri::State<'_, MobileAppState>,
) -> Result<crate::core::device_sync::S3DevicePullResult, String> {
    crate::core::device_sync::run_configured_pull(state.storage.clone()).await
}
