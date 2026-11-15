pub mod core;
#[cfg(mobile)]
mod mobile_commands;
#[cfg(mobile)]
use core::storage::Storage;

#[derive(Clone)]
#[cfg(mobile)]
struct MobileAppState {
    storage: Storage,
    jobs: core::job_runtime::JobRuntime,
}

/// 移动端后台同步完成事件负载。前端监听此事件后 invalidate 本地 query，
/// 触发页面重读 SQLite / probe 缓存。
#[derive(Debug, Clone, serde::Serialize)]
#[cfg(mobile)]
#[serde(rename_all = "camelCase")]
struct MobileSyncUpdate {
    completed_at: String,
    s3_imported_devices: usize,
    s3_failed_objects: usize,
    s3_error: Option<String>,
    lan_probe_count: usize,
}

#[cfg(mobile)]
#[tauri::mobile_entry_point]
pub fn run() {
    run_mobile();
}

#[cfg(mobile)]
fn run_mobile() {
    use tauri::{Emitter as _, Manager as _};

    tauri::Builder::default()
        .plugin(tauri_plugin_barcode_scanner::init())
        .setup(|app| {
            #[cfg(target_os = "android")]
            {
                let credential_store = android_native_keyring_store::Store::new()
                    .map_err(|error| format!("初始化 Android 系统凭据库失败：{error}"))?;
                keyring_core::set_default_store(credential_store);
            }

            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let storage = Storage::open(data_dir.join("flowlet-mobile.sqlite"))
                .map_err(|error| error.to_string())?;
            let jobs = core::job_runtime::JobRuntime::default();
            app.manage(MobileAppState {
                storage: storage.clone(),
                jobs: jobs.clone(),
            });

            // 移动端后台定时同步：每 5 分钟执行一次 S3-only pull + LAN probe 缓存。
            // 应用切后台被系统挂起时定时器暂停，恢复后由 MissedTickBehavior::Delay 立即补一次。
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                use crate::core::device_sync::{
                    AUTO_SYNC_INITIAL_DELAY, MOBILE_AUTO_SYNC_INTERVAL,
                };
                use tokio::time::{self, MissedTickBehavior};

                let mut interval = time::interval_at(
                    time::Instant::now() + AUTO_SYNC_INITIAL_DELAY,
                    MOBILE_AUTO_SYNC_INTERVAL,
                );
                interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
                loop {
                    interval.tick().await;
                    let storage = storage.clone();
                    let app_handle = app_handle.clone();

                    // Step 1: S3-only pull（不走 LAN 优先）。
                    let (s3_imported_devices, s3_failed_objects, s3_error) =
                        match crate::core::device_sync::load_config(&storage) {
                            Ok(Some(_)) => {
                                match crate::core::device_sync::run_configured_pull(
                                    storage.clone(),
                                    &jobs,
                                    false,
                                )
                                .await
                                {
                                    Ok(result) => {
                                        (result.imported_devices, result.failed_objects, None)
                                    }
                                    Err(error) => {
                                        tracing::warn!(%error, "mobile background S3 pull failed");
                                        (0, 0, Some(error))
                                    }
                                }
                            }
                            Ok(None) => (0, 0, None),
                            Err(error) => {
                                tracing::warn!(%error, "mobile background S3 config check failed");
                                (0, 0, Some(error))
                            }
                        };

                    // Step 2: LAN probe 缓存。
                    let lan_probe_count =
                        crate::core::lan_sync::probe_and_cache_lan_peers(&storage)
                            .await
                            .len();

                    let update = MobileSyncUpdate {
                        completed_at: chrono::Utc::now().to_rfc3339(),
                        s3_imported_devices,
                        s3_failed_objects,
                        s3_error,
                        lan_probe_count,
                    };
                    let _ = app_handle.emit("mobile-device-sync-updated", &update);
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            mobile_commands::list_shared_devices,
            mobile_commands::list_shared_account_resources,
            mobile_commands::list_shared_device_agents,
            mobile_commands::shared_device_daily_usage,
            mobile_commands::shared_device_hourly_usage,
            mobile_commands::list_shared_device_sessions,
            mobile_commands::get_s3_sync_settings,
            mobile_commands::save_s3_sync_config,
            mobile_commands::test_s3_read_connection,
            mobile_commands::refresh_shared_device_usage_s3,
            mobile_commands::list_remote_opencode_permissions,
            mobile_commands::reply_remote_opencode_permission,
            mobile_commands::refresh_shared_device_usage_lan,
            mobile_commands::refresh_shared_device,
            mobile_commands::refresh_shared_device_session_lan,
            mobile_commands::probe_lan_peers,
            mobile_commands::list_cached_lan_probes,
        ])
        .run(tauri::generate_context!())
        .expect("启动 Flowlet Mobile 失败");
}
