use crate::core::device_identity::{
    DailyUsageTotal, DeviceUsageBundle, DeviceUsageImportPreview, DeviceUsageImportResult,
    DeviceUsageSnapshot, HourlyUsageTotal, KnownDevice, SharedDeviceProject,
};
use crate::AppState;

#[tauri::command]
pub(crate) async fn device_usage_snapshot(
    state: tauri::State<'_, AppState>,
) -> Result<DeviceUsageSnapshot, String> {
    let storage = state.storage.clone();
    let identity = state
        .device_identity
        .lock()
        .map_err(|_| "读取当前设备身份失败".to_string())?
        .clone();
    crate::core::device_sync::build_device_snapshot(storage, identity).await
}

#[tauri::command]
pub(crate) async fn list_known_devices(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<KnownDevice>, String> {
    let storage = state.storage.clone();
    let identity = state
        .device_identity
        .lock()
        .map_err(|_| "读取当前设备身份失败".to_string())?
        .clone();
    tauri::async_runtime::spawn_blocking(move || {
        let current_days = storage
            .daily_usage_totals()
            .map_err(|error| error.to_string())?;
        let mut devices = storage
            .imported_known_devices()
            .map_err(|error| error.to_string())?;
        devices.retain(|device| device.device_id != identity.device_id);
        devices.insert(
            0,
            KnownDevice {
                device_id: identity.device_id,
                device_created_at: identity.created_at,
                display_name: identity.display_name,
                platform: identity.platform,
                app_version: env!("CARGO_PKG_VERSION").to_string(),
                is_current: true,
                timezone_offset_minutes: chrono::Local::now().offset().local_minus_utc() / 60,
                first_usage_date: current_days.first().map(|day| day.date.clone()),
                last_usage_date: current_days.last().map(|day| day.date.clone()),
                day_count: current_days.len() as i64,
                request_count: current_days.iter().map(|day| day.request_count).sum(),
                known_tokens: current_days.iter().map(|day| day.known_tokens).sum(),
                last_seen_at: chrono::Utc::now().to_rfc3339(),
            },
        );
        Ok(devices)
    })
    .await
    .map_err(|error| format!("读取设备目录任务失败：{error}"))?
}

#[tauri::command]
pub(crate) async fn list_shared_devices(
    state: tauri::State<'_, AppState>,
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

/// 桌面端项目看板读取其他设备的只读项目/任务快照。
/// 数据只来自 `device_projects`，不会写入本机 `projects` / `project_tasks` 事实表。
#[tauri::command]
pub(crate) async fn list_shared_device_projects(
    state: tauri::State<'_, AppState>,
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

#[tauri::command]
pub(crate) async fn device_daily_usage(
    state: tauri::State<'_, AppState>,
    device_id: Option<String>,
) -> Result<Vec<DailyUsageTotal>, String> {
    let storage = state.storage.clone();
    let current_device_id = state
        .device_identity
        .lock()
        .map_err(|_| "读取当前设备身份失败".to_string())?
        .device_id
        .clone();
    tauri::async_runtime::spawn_blocking(move || {
        if device_id.as_deref() == Some(current_device_id.as_str()) {
            // 本设备：代理 + Agent 原生合并口径。
            return storage
                .local_daily_usage_totals_with_native()
                .map_err(|error| error.to_string());
        }
        if let Some(device_id) = device_id.as_deref() {
            return storage
                .imported_daily_usage(Some(device_id))
                .map_err(|error| error.to_string());
        }
        let current = storage
            .local_daily_usage_totals_with_native()
            .map_err(|error| error.to_string())?;
        let imported = storage
            .imported_daily_usage(None)
            .map_err(|error| error.to_string())?;
        Ok(crate::core::device_identity::merge_daily_usage_totals(
            current.into_iter().chain(imported),
        ))
    })
    .await
    .map_err(|error| format!("读取设备每日用量任务失败：{error}"))?
}

#[tauri::command]
pub(crate) async fn device_hourly_usage(
    state: tauri::State<'_, AppState>,
    device_id: Option<String>,
) -> Result<Vec<HourlyUsageTotal>, String> {
    let storage = state.storage.clone();
    let current_device_id = state
        .device_identity
        .lock()
        .map_err(|_| "读取当前设备身份失败".to_string())?
        .device_id
        .clone();
    tauri::async_runtime::spawn_blocking(move || {
        if device_id.as_deref() == Some(current_device_id.as_str()) {
            // 本设备：代理 + Agent 原生合并口径。
            return storage
                .local_hourly_usage_totals_with_native()
                .map_err(|error| error.to_string());
        }
        if let Some(device_id) = device_id.as_deref() {
            return storage
                .imported_hourly_usage(Some(device_id))
                .map_err(|error| error.to_string());
        }
        let current = storage
            .local_hourly_usage_totals_with_native()
            .map_err(|error| error.to_string())?;
        let imported = storage
            .imported_hourly_usage(None)
            .map_err(|error| error.to_string())?;
        Ok(crate::core::device_identity::merge_hourly_usage_totals(
            current.into_iter().chain(imported),
        ))
    })
    .await
    .map_err(|error| format!("读取设备小时用量任务失败：{error}"))?
}

#[tauri::command]
pub(crate) async fn shared_device_daily_usage(
    state: tauri::State<'_, AppState>,
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
pub(crate) async fn shared_device_hourly_usage(
    state: tauri::State<'_, AppState>,
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
pub(crate) async fn rename_current_device(
    state: tauri::State<'_, AppState>,
    display_name: String,
) -> Result<(), String> {
    let identity = state.device_identity.clone();
    let data_dir = state.device_identity_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        identity
            .lock()
            .map_err(|_| "更新当前设备身份失败".to_string())?
            .update_display_name(&data_dir, &display_name)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("重命名当前设备任务失败：{error}"))?
}

#[tauri::command]
pub(crate) async fn get_s3_sync_settings(
    state: tauri::State<'_, AppState>,
) -> Result<crate::core::device_sync::S3SyncSettings, String> {
    let storage = state.storage.clone();
    tauri::async_runtime::spawn_blocking(move || crate::core::device_sync::load_settings(&storage))
        .await
        .map_err(|_| "读取 S3 同步设置任务失败".to_string())?
}

#[tauri::command]
pub(crate) async fn export_s3_connection_config(
    state: tauri::State<'_, AppState>,
) -> Result<crate::core::device_sync::S3SyncConfigInput, String> {
    let storage = state.storage.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::core::device_sync::export_connection_config(&storage)
    })
    .await
    .map_err(|_| "读取 S3 完整连接配置任务失败".to_string())?
}

#[tauri::command]
pub(crate) async fn save_s3_sync_config(
    state: tauri::State<'_, AppState>,
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
pub(crate) async fn test_s3_sync_connection(
    _state: tauri::State<'_, AppState>,
    config: crate::core::device_sync::S3SyncConfigInput,
) -> Result<crate::core::device_sync::S3ConnectionTestResult, String> {
    crate::core::device_sync::test_connection(&config).await
}

#[tauri::command]
pub(crate) async fn test_s3_read_connection(
    _state: tauri::State<'_, AppState>,
    config: crate::core::device_sync::S3SyncConfigInput,
) -> Result<crate::core::device_sync::S3ConnectionTestResult, String> {
    crate::core::device_sync::test_read_connection(&config).await
}

#[tauri::command]
pub(crate) async fn sync_device_usage_s3(
    state: tauri::State<'_, AppState>,
) -> Result<crate::core::device_sync::S3DeviceSyncResult, String> {
    let storage = state.storage.clone();
    let identity = state
        .device_identity
        .lock()
        .map_err(|_| "读取当前设备身份失败".to_string())?
        .clone();
    crate::core::device_sync::run_configured_sync(storage, &state.jobs, identity, "manual").await
}

#[tauri::command]
pub(crate) async fn recover_current_device_sync(
    state: tauri::State<'_, AppState>,
) -> Result<crate::core::device_sync::S3ConnectionTestResult, String> {
    let storage = state.storage.clone();
    let identity = state
        .device_identity
        .lock()
        .map_err(|_| "读取当前设备身份失败".to_string())?
        .clone();
    crate::core::device_sync::recover_current_device_sync(storage, identity).await
}

#[tauri::command]
pub(crate) async fn refresh_shared_device_usage_s3(
    state: tauri::State<'_, AppState>,
) -> Result<crate::core::device_sync::S3DevicePullResult, String> {
    crate::core::device_sync::run_configured_pull(state.storage.clone(), &state.jobs, true).await
}

#[tauri::command]
pub(crate) async fn list_remote_opencode_permissions(
    state: tauri::State<'_, AppState>,
    device_id: String,
    session_id: String,
) -> Result<crate::core::opencode_control::OpenCodePermissionReport, String> {
    crate::core::lan_sync::list_remote_permissions(&state.storage, &device_id, &session_id).await
}

#[tauri::command]
pub(crate) async fn reply_remote_opencode_permission(
    state: tauri::State<'_, AppState>,
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
pub(crate) async fn refresh_shared_device_usage_lan(
    state: tauri::State<'_, AppState>,
    device_id: Option<String>,
) -> Result<crate::core::lan_sync::LanRefreshResult, String> {
    crate::core::lan_sync::refresh_known_peers(state.storage.clone(), device_id.as_deref()).await
}

#[tauri::command]
pub(crate) async fn lan_server_status(
    state: tauri::State<'_, AppState>,
) -> Result<crate::core::lan_sync::LanServerReport, String> {
    Ok(crate::core::lan_sync::read_server_report(
        &state.lan_status,
        &state.lan_inbound,
    ))
}

#[tauri::command]
pub(crate) async fn probe_lan_peers(
    state: tauri::State<'_, AppState>,
    device_id: Option<String>,
) -> Result<Vec<crate::core::lan_sync::LanPeerProbe>, String> {
    Ok(crate::core::lan_sync::probe_lan_peers(&state.storage, device_id.as_deref()).await)
}

fn read_device_usage_bundle(path: &str) -> Result<DeviceUsageBundle, String> {
    const MAX_BUNDLE_BYTES: u64 = 4 * 1024 * 1024;
    let metadata = std::fs::metadata(path).map_err(|error| format!("读取导入文件失败：{error}"))?;
    if metadata.len() > MAX_BUNDLE_BYTES {
        return Err("设备用量文件超过 4 MB 限制".to_string());
    }
    let bytes = std::fs::read(path).map_err(|error| format!("读取导入文件失败：{error}"))?;
    DeviceUsageBundle::from_bytes(&bytes)
}

#[tauri::command]
pub(crate) async fn export_device_usage_bundle(
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<(), String> {
    let storage = state.storage.clone();
    let identity = state
        .device_identity
        .lock()
        .map_err(|_| "读取当前设备身份失败".to_string())?
        .clone();
    let snapshot = crate::core::device_sync::build_device_snapshot(storage, identity).await?;
    tauri::async_runtime::spawn_blocking(move || {
        let bundle = DeviceUsageBundle::new(snapshot);
        let bytes = serde_json::to_vec_pretty(&bundle)
            .map_err(|error| format!("生成设备用量文件失败：{error}"))?;
        let target = std::path::PathBuf::from(&path);
        let parent = target.parent().unwrap_or_else(|| std::path::Path::new("."));
        let temporary = parent.join(format!(
            ".flowlet-usage-{}.tmp",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::write(&temporary, bytes)
            .map_err(|error| format!("写入设备用量临时文件失败：{error}"))?;
        let backup = parent.join(format!(
            ".flowlet-usage-{}.backup",
            uuid::Uuid::new_v4().simple()
        ));
        if target.exists() {
            std::fs::rename(&target, &backup)
                .map_err(|error| format!("准备覆盖设备用量文件失败：{error}"))?;
        }
        match std::fs::rename(&temporary, &target) {
            Ok(()) => {
                let _ = std::fs::remove_file(&backup);
                Ok(())
            }
            Err(error) => {
                let _ = std::fs::remove_file(&temporary);
                if backup.exists() {
                    let _ = std::fs::rename(&backup, &target);
                }
                Err(format!("保存设备用量文件失败：{error}"))
            }
        }
    })
    .await
    .map_err(|error| format!("导出设备用量任务失败：{error}"))?
}

#[tauri::command]
pub(crate) async fn preview_device_usage_import(
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<DeviceUsageImportPreview, String> {
    let storage = state.storage.clone();
    let current_device_id = state
        .device_identity
        .lock()
        .map_err(|_| "读取当前设备身份失败".to_string())?
        .device_id
        .clone();
    tauri::async_runtime::spawn_blocking(move || {
        let bundle = read_device_usage_bundle(&path)?;
        let snapshot = bundle.snapshot;
        let display_name = snapshot.resolved_display_name();
        let platform = snapshot.resolved_platform();
        let app_version = snapshot.resolved_app_version();
        storage
            .preview_device_usage_import(
                &current_device_id,
                &snapshot.device_id,
                &snapshot.device_created_at,
                &display_name,
                &platform,
                &app_version,
                &snapshot.generated_at,
                snapshot.timezone_offset_minutes,
                &snapshot.days,
            )
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("预览设备用量导入任务失败：{error}"))?
}

#[tauri::command]
pub(crate) async fn import_device_usage_bundle(
    state: tauri::State<'_, AppState>,
    path: String,
) -> Result<DeviceUsageImportResult, String> {
    let storage = state.storage.clone();
    let current_device_id = state
        .device_identity
        .lock()
        .map_err(|_| "读取当前设备身份失败".to_string())?
        .device_id
        .clone();
    tauri::async_runtime::spawn_blocking(move || {
        let bundle = read_device_usage_bundle(&path)?;
        let snapshot = bundle.snapshot;
        if snapshot.device_id == current_device_id {
            return Err("不能把当前设备的用量重新导入为远程设备".to_string());
        }
        let display_name = snapshot.resolved_display_name();
        let platform = snapshot.resolved_platform();
        let app_version = snapshot.resolved_app_version();
        storage
            .import_device_usage(
                snapshot.schema_version,
                &snapshot.device_id,
                &snapshot.device_created_at,
                &display_name,
                &platform,
                &app_version,
                &snapshot.generated_at,
                snapshot.timezone_offset_minutes,
                &snapshot.days,
                &snapshot.hours,
                &snapshot.sessions,
                &snapshot.agents,
            )
            .map_err(|error| error.to_string())?;
        storage
            .import_device_usage_breakdowns(
                &snapshot.device_id,
                &snapshot.generated_at,
                &snapshot.usage_breakdowns,
            )
            .map_err(|error| error.to_string())?;
        storage
            .import_device_projects(
                &snapshot.device_id,
                &snapshot.generated_at,
                &snapshot.projects,
            )
            .map_err(|error| error.to_string())?;
        storage
            .import_device_account_resources(
                &snapshot.device_id,
                &snapshot.generated_at,
                &snapshot.account_resources,
            )
            .map_err(|error| error.to_string())?;
        Ok(DeviceUsageImportResult {
            device_id: snapshot.device_id,
            imported_days: 0,
            unchanged_days: 0,
        })
    })
    .await
    .map_err(|error| format!("导入设备用量任务失败：{error}"))?
}
