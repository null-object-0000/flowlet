use super::MobileAppState;
use crate::core::device_identity::{
    DailyUsageTotal, HourlyUsageTotal, KnownDevice, SharedAgentSession, SharedDeviceProject,
    SyncedAgentProfile, SyncedAgentSession,
};

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
pub(super) async fn list_shared_device_agents(
    state: tauri::State<'_, MobileAppState>,
    device_id: String,
) -> Result<Vec<SyncedAgentProfile>, String> {
    let storage = state.storage.clone();
    tauri::async_runtime::spawn_blocking(move || {
        storage
            .imported_device_agents(&device_id)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("读取共享设备 Agent 资料任务失败：{error}"))?
}

#[tauri::command]
pub(super) async fn list_shared_device_projects(
    state: tauri::State<'_, MobileAppState>,
    device_id: Option<String>,
) -> Result<Vec<SharedDeviceProject>, String> {
    let storage = state.storage.clone();
    tauri::async_runtime::spawn_blocking(move || {
        storage
            .imported_device_projects(device_id.as_deref())
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("读取共享设备项目目录任务失败：{error}"))?
}

/// 移动端通过签名 LAN 通道把任务提交到指定桌面设备。
/// 任务默认以草稿（draft）状态创建，目标设备离线、版本过旧或未绑定项目目录时返回明确错误。
#[tauri::command]
pub(super) async fn submit_task_lan(
    state: tauri::State<'_, MobileAppState>,
    device_id: String,
    input: crate::core::lan_sync::TaskSubmitInput,
) -> Result<crate::core::lan_sync::TaskSubmitResult, String> {
    crate::core::lan_sync::submit_task(&state.storage, &device_id, &input).await
}

/// 移动端通过签名 LAN 通道提交 / 撤回任务（草稿 ↔ 已提交）。
/// 与 PC 看板交互一致，任务默认草稿待提交，可手动提交、撤回；仅允许局域网直连方式变更。
#[tauri::command]
pub(super) async fn set_task_status_lan(
    state: tauri::State<'_, MobileAppState>,
    device_id: String,
    task_id: String,
    status: String,
) -> Result<crate::core::lan_sync::TaskSubmitResult, String> {
    crate::core::lan_sync::set_task_status(&state.storage, &device_id, &task_id, &status).await
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
pub(super) async fn shared_device_hourly_usage(
    state: tauri::State<'_, MobileAppState>,
    device_id: Option<String>,
) -> Result<Vec<HourlyUsageTotal>, String> {
    let storage = state.storage.clone();
    tauri::async_runtime::spawn_blocking(move || {
        storage
            .imported_hourly_usage(device_id.as_deref())
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("读取共享设备小时用量任务失败：{error}"))?
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
    // 移动端手动刷新按钮走 LAN 优先，与桌面端行为一致。
    crate::core::device_sync::run_configured_pull(state.storage.clone(), true).await
}

#[tauri::command]
pub(super) async fn list_cached_lan_probes(
    state: tauri::State<'_, MobileAppState>,
) -> Result<Vec<crate::core::lan_sync::LanPeerProbe>, String> {
    Ok(crate::core::lan_sync::cached_lan_probes(&state.storage))
}

#[tauri::command]
pub(super) async fn list_remote_opencode_permissions(
    state: tauri::State<'_, MobileAppState>,
    device_id: String,
    session_id: String,
) -> Result<crate::core::opencode_control::OpenCodePermissionReport, String> {
    crate::core::lan_sync::list_remote_permissions(&state.storage, &device_id, &session_id).await
}

#[tauri::command]
pub(super) async fn reply_remote_opencode_permission(
    state: tauri::State<'_, MobileAppState>,
    device_id: String,
    permission_id: String,
    decision: crate::core::opencode_control::OpenCodePermissionDecision,
) -> Result<(), String> {
    crate::core::lan_sync::reply_remote_permission(
        &state.storage,
        &device_id,
        &permission_id,
        decision,
    )
    .await
}

#[tauri::command]
pub(super) async fn refresh_shared_device_usage_lan(
    state: tauri::State<'_, MobileAppState>,
    device_id: Option<String>,
) -> Result<crate::core::lan_sync::LanRefreshResult, String> {
    crate::core::lan_sync::refresh_known_peers(state.storage.clone(), device_id.as_deref()).await
}

#[tauri::command]
pub(super) async fn refresh_shared_device(
    state: tauri::State<'_, MobileAppState>,
    device_id: String,
) -> Result<crate::core::device_sync::DeviceRefreshResult, String> {
    crate::core::device_sync::refresh_device(state.storage.clone(), &device_id).await
}

#[tauri::command]
pub(super) async fn refresh_shared_device_session_lan(
    state: tauri::State<'_, MobileAppState>,
    device_id: String,
    agent_type: String,
    session_id: String,
) -> Result<SyncedAgentSession, String> {
    let storage = state.storage.clone();
    let snapshot =
        crate::core::lan_sync::fetch_session(&storage, &device_id, &agent_type, &session_id)
            .await?;
    let session = snapshot.session;
    let imported_session = session.clone();
    tauri::async_runtime::spawn_blocking(move || {
        storage
            .upsert_imported_device_session(&device_id, &imported_session, &snapshot.generated_at)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("保存直连会话快照任务失败：{error}"))??;
    Ok(session)
}

#[tauri::command]
pub(super) async fn probe_lan_peers(
    state: tauri::State<'_, MobileAppState>,
    device_id: Option<String>,
) -> Result<Vec<crate::core::lan_sync::LanPeerProbe>, String> {
    Ok(crate::core::lan_sync::probe_lan_peers(&state.storage, device_id.as_deref()).await)
}
