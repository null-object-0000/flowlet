use crate::core::device_identity::{
    DailyUsageTotal, DeviceUsageBundle, DeviceUsageImportPreview, DeviceUsageImportResult,
    DeviceUsageSnapshot, KnownDevice,
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
    tauri::async_runtime::spawn_blocking(move || {
        crate::core::device_sync::build_device_snapshot(&storage, &identity)
    })
    .await
    .map_err(|error| format!("生成设备每日用量任务失败：{error}"))?
    .map_err(|error| error.to_string())
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
            return storage
                .daily_usage_totals()
                .map_err(|error| error.to_string());
        }
        if let Some(device_id) = device_id.as_deref() {
            return storage
                .imported_daily_usage(Some(device_id))
                .map_err(|error| error.to_string());
        }
        let current = storage
            .daily_usage_totals()
            .map_err(|error| error.to_string())?;
        let imported = storage
            .imported_daily_usage(None)
            .map_err(|error| error.to_string())?;
        let mut by_date = std::collections::BTreeMap::<String, DailyUsageTotal>::new();
        for day in current.into_iter().chain(imported) {
            let total = by_date.entry(day.date.clone()).or_insert(DailyUsageTotal {
                date: day.date.clone(),
                request_count: 0,
                known_tokens: 0,
                input_tokens: 0,
                input_cached_tokens: 0,
                input_uncached_tokens: 0,
                cache_measured_input_tokens: 0,
                output_tokens: 0,
                unknown_count: 0,
            });
            total.request_count += day.request_count;
            total.known_tokens += day.known_tokens;
            total.input_tokens += day.input_tokens;
            total.input_cached_tokens += day.input_cached_tokens;
            total.input_uncached_tokens += day.input_uncached_tokens;
            total.cache_measured_input_tokens += day.cache_measured_input_tokens;
            total.output_tokens += day.output_tokens;
            total.unknown_count += day.unknown_count;
        }
        Ok(by_date.into_values().collect())
    })
    .await
    .map_err(|error| format!("读取设备每日用量任务失败：{error}"))?
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
    crate::core::device_sync::run_configured_sync(storage, identity, "manual").await
}

#[tauri::command]
pub(crate) async fn refresh_shared_device_usage_s3(
    state: tauri::State<'_, AppState>,
) -> Result<crate::core::device_sync::S3DevicePullResult, String> {
    crate::core::device_sync::run_configured_pull(state.storage.clone()).await
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
    tauri::async_runtime::spawn_blocking(move || {
        let snapshot = crate::core::device_sync::build_device_snapshot(&storage, &identity)?;
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
                &snapshot.device_id,
                &snapshot.device_created_at,
                &display_name,
                &platform,
                &app_version,
                &snapshot.generated_at,
                snapshot.timezone_offset_minutes,
                &snapshot.days,
                &snapshot.sessions,
            )
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("导入设备用量任务失败：{error}"))?
}
