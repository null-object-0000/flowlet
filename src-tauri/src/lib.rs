#[cfg(desktop)]
mod commands;
pub mod core;
#[cfg(mobile)]
mod mobile_commands;

#[cfg(desktop)]
use core::device_identity::DeviceIdentity;
#[cfg(desktop)]
use core::services::FlowletServices;
use core::storage::Storage;
#[cfg(desktop)]
use std::path::PathBuf;
#[cfg(desktop)]
use std::sync::{Arc, Mutex};
#[cfg(desktop)]
use tauri::menu::{Menu, MenuItem};
#[cfg(desktop)]
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
#[cfg(desktop)]
use tauri::{AppHandle, Manager};
#[cfg(desktop)]
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

#[derive(Clone)]
#[cfg(desktop)]
struct AppState {
    services: FlowletServices,
    device_identity: Arc<Mutex<DeviceIdentity>>,
    device_identity_dir: std::path::PathBuf,
    tray: Arc<Mutex<Option<TrayIcon>>>,
    codex_accounts_dir: std::path::PathBuf,
    agent_source_watcher: Arc<Mutex<Option<notify::RecommendedWatcher>>>,
    /// LAN 直连服务的运行状态与最近入站请求，供「局域网直连」卡片展示。
    lan_status: Arc<Mutex<core::lan_sync::LanServerStatus>>,
    lan_inbound: Arc<Mutex<std::collections::VecDeque<core::lan_sync::LanInboundEvent>>>,
    /// 当前活动的 per-account 抓取 WebView，key=account_id。窗口只在抓取或等待
    /// 用户交互期间存在；登录态由账号独立的数据目录持久化，不依赖进程保活。
    scrape_webviews: Arc<Mutex<std::collections::HashMap<String, tauri::WebviewWindow>>>,
    /// per-account 待处理拦截响应缓冲(抓取过程中临时存放)。
    scrape_pending: Arc<Mutex<std::collections::HashMap<String, Vec<(String, String)>>>>,
    /// per-account 当前 document-start 拦截器就绪标识。
    scrape_ready:
        Arc<Mutex<std::collections::HashMap<String, core::scrape_console::ScrapeInterceptorReady>>>,
    /// per-account 已成功安装的原生 WebView 网络监听。它跨页面导航保持有效。
    scrape_native_ready: Arc<Mutex<std::collections::HashSet<String>>>,
    /// 正在等待用户登录/处理控制台页面的账号。交互式刷新开始时即加入，
    /// 只有一次交互式抓取完整成功后才移除；后台同步必须跳过这些账号，
    /// 避免在用户登录过程中重新导航同一个 WebView。
    scrape_interaction_required: Arc<Mutex<std::collections::HashSet<String>>>,
    /// 已打开的「项目详情独立窗口」的 project_id 记录，用于应用重启后自动恢复。
    detail_windows: Arc<core::detail_windows::DetailWindowRegistry>,
    /// 应用是否正在退出。退出时窗口销毁事件不应再清空上面的独立窗口记录。
    app_exiting: Arc<Mutex<bool>>,
}
#[cfg(desktop)]
impl std::ops::Deref for AppState {
    type Target = FlowletServices;

    fn deref(&self) -> &Self::Target {
        &self.services
    }
}

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

#[cfg(desktop)]
impl AppState {
    async fn start_configured_proxy(&self) -> Result<(), String> {
        self.services.start_proxy().await
    }
}

// ─── App Entry ──────────────────────────────────────────────────────────────

#[cfg(desktop)]
fn build_app_state(db_path: std::path::PathBuf, config_path: std::path::PathBuf) -> AppState {
    let _t0 = std::time::Instant::now();
    let codex_accounts_dir = db_path
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."))
        .join("codex-accounts");
    let device_identity_dir = db_path
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."))
        .to_path_buf();
    let device_identity = DeviceIdentity::load_or_create(&device_identity_dir)
        .unwrap_or_else(|error| panic!("初始化设备身份失败: {error}"));

    tracing::info!(db_path = %db_path.display(), t_ms = _t0.elapsed().as_millis() as u64, "初始化 Storage");

    let services = FlowletServices::open(&db_path, &config_path)
        .unwrap_or_else(|error| panic!("初始化 Flowlet 服务失败: {error}"));
    let storage = services.storage.clone();

    // 旧版项目任务曾通过 --session-dir 把 Pi 会话写到 ~/.flowlet。先迁入 Pi 原生
    // sessions 目录，再启动会话扫描与文件监听；失败只记日志，不阻断应用启动。
    let pi_migration = core::pi_session_migration::migrate_legacy_pi_task_sessions();
    if pi_migration.migrated > 0
        || pi_migration.skipped_existing > 0
        || pi_migration.skipped_invalid > 0
        || pi_migration.failed > 0
    {
        tracing::info!(
            migrated = pi_migration.migrated,
            skipped_existing = pi_migration.skipped_existing,
            skipped_invalid = pi_migration.skipped_invalid,
            failed = pi_migration.failed,
            "Pi 历史任务会话迁移完成"
        );
    }

    // 应用重启恢复：上次退出时仍处于执行中（in_progress）的项目任务会被恢复为
    // submitted（待处理），调度器会自动重新领取执行（--resume 复用上次会话）；
    // 被中断的那轮执行记录打上 interrupted 标记，供看板 / 执行历史标注异常。
    // 只在 desktop 主进程启动时执行一次；其他设备领取且在租约窗口内的任务不受影响。
    let current_device_id = device_identity.device_id.clone();
    match storage.recover_interrupted_project_tasks(&current_device_id) {
        Ok(recovered) => {
            if recovered > 0 {
                tracing::info!(recovered, "已恢复应用重启中断的项目任务");
            }
        }
        Err(error) => {
            tracing::warn!(error = %error, "恢复中断的项目任务失败");
        }
    }
    match storage.recover_interrupted_recurring_runs() {
        Ok(recovered) if recovered > 0 => {
            tracing::info!(recovered, "已恢复应用重启中断的重复任务运行")
        }
        Ok(_) => {}
        Err(error) => tracing::warn!(error = %error, "恢复中断的重复任务运行失败"),
    }

    storage
        .cleanup_orphan_balance_snapshots()
        .expect("清理孤儿余额快照失败");
    tracing::trace!(
        t_ms = _t0.elapsed().as_millis() as u64,
        "step: routes + balance cleanup"
    );

    // 模型身份与路由渠道拆分后的单次历史费用修复：过去自定义渠道上的官方模型
    // 因 channel_id 无价格而被记为 0。价格表可用时按“实际渠道显式价格优先，
    // 否则官方模型价格”重算一次；标记成功后不再增加后续启动成本。
    const MODEL_OWNERSHIP_COST_REPAIR_KEY: &str = "model_ownership_cost_repair_v1";
    let ownership_cost_repaired = storage
        .get_app_meta(MODEL_OWNERSHIP_COST_REPAIR_KEY)
        .ok()
        .flatten()
        .as_deref()
        == Some("done");
    if !ownership_cost_repaired && !storage.prices().is_empty() {
        match storage.recalculate_usage_costs("all") {
            Ok(updated) => {
                if let Err(error) = storage.set_app_meta(MODEL_OWNERSHIP_COST_REPAIR_KEY, "done") {
                    tracing::warn!(error = %error, "记录模型归属费用修复标记失败");
                } else {
                    tracing::info!(updated, "已按模型官方归属重算历史费用");
                }
            }
            Err(error) => {
                tracing::warn!(error = %error, "按模型官方归属重算历史费用失败");
            }
        }
    }

    // 分时价格上线后的单次历史费用修复：按请求原始发生时间重新选择价格，
    // 避免旧版本把已过期价格或当前峰谷时段价格套到全部历史请求。
    const TIME_SCHEDULE_COST_REPAIR_KEY: &str = "time_schedule_cost_repair_v1";
    let time_schedule_cost_repaired = storage
        .get_app_meta(TIME_SCHEDULE_COST_REPAIR_KEY)
        .ok()
        .flatten()
        .as_deref()
        == Some("done");
    if !time_schedule_cost_repaired && !storage.prices().is_empty() {
        match storage.recalculate_usage_costs("all") {
            Ok(updated) => {
                if let Err(error) = storage.set_app_meta(TIME_SCHEDULE_COST_REPAIR_KEY, "done") {
                    tracing::warn!(error = %error, "记录分时价格费用修复标记失败");
                } else {
                    tracing::info!(updated, "已按请求发生时间重算历史费用");
                }
            }
            Err(error) => tracing::warn!(error = %error, "按分时价格重算历史费用失败"),
        }
    }

    // 回填历史请求的费用分类明细（早期版本只有总数、缺分类）。幂等，仅补齐 NULL 列。
    if let Err(error) = storage.backfill_cost_breakdown() {
        tracing::warn!(error = %error, "费用分类明细回填失败");
    }

    let state = AppState {
        services,
        device_identity: Arc::new(Mutex::new(device_identity)),
        device_identity_dir,
        tray: Arc::new(Mutex::new(None)),
        codex_accounts_dir,
        agent_source_watcher: Arc::new(Mutex::new(None)),
        lan_status: Arc::new(Mutex::new(core::lan_sync::LanServerStatus::default())),
        lan_inbound: Arc::new(Mutex::new(std::collections::VecDeque::new())),
        scrape_webviews: Arc::new(Mutex::new(std::collections::HashMap::new())),
        scrape_pending: Arc::new(Mutex::new(std::collections::HashMap::new())),
        scrape_ready: Arc::new(Mutex::new(std::collections::HashMap::new())),
        scrape_native_ready: Arc::new(Mutex::new(std::collections::HashSet::new())),
        scrape_interaction_required: Arc::new(Mutex::new(std::collections::HashSet::new())),
        detail_windows: Arc::new(core::detail_windows::DetailWindowRegistry::new(
            db_path
                .parent()
                .unwrap_or_else(|| std::path::Path::new("."))
                .join("detail-windows.json"),
        )),
        app_exiting: Arc::new(Mutex::new(false)),
    };
    tracing::info!(
        t_ms = _t0.elapsed().as_millis() as u64,
        "build_app_state 全部完成"
    );
    state
}

/// 数据库路径：始终放在 exe 同级目录下，与程序完全自包含。
/// 不再区分「安装/便携」模式 — SQLite 和日志都在 exe 旁。
#[cfg(desktop)]
fn app_database_path(_app: &tauri::App) -> std::path::PathBuf {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."));

    let app_data_dir = exe_dir;
    std::fs::create_dir_all(&app_data_dir).expect("创建应用数据目录失败");

    let db_path = app_data_dir.join("flowlet.sqlite");
    migrate_legacy_database(&db_path);
    db_path
}

/// 桌面配置路径：
/// - 便携版使用可执行文件同目录的 config.json，保证配置随目录迁移；
/// - 安装版继续使用 Tauri 资源目录中的 config.json。
#[cfg(desktop)]
fn desktop_config_path(
    resource_dir: &std::path::Path,
    executable_dir: Option<&std::path::Path>,
    portable: bool,
) -> std::path::PathBuf {
    if portable {
        if let Some(executable_dir) = executable_dir {
            return executable_dir.join("config.json");
        }
    }
    resource_dir.join("config.json")
}

#[cfg(desktop)]
fn migrate_legacy_database(db_path: &std::path::Path) {
    if db_path.exists() {
        return;
    }

    let legacy_db_path = std::env::current_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
        .join("flowlet.sqlite");
    if !legacy_db_path.exists() {
        return;
    }

    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent).expect("创建数据库迁移目录失败");
    }

    std::fs::copy(&legacy_db_path, db_path).expect("迁移 SQLite 数据库失败");
    for suffix in ["-wal", "-shm"] {
        let legacy_sidecar = legacy_db_path.with_file_name(format!(
            "{}{}",
            legacy_db_path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("flowlet.sqlite"),
            suffix
        ));
        if legacy_sidecar.exists() {
            let target_sidecar = db_path.with_file_name(format!("flowlet.sqlite{}", suffix));
            let _ = std::fs::copy(legacy_sidecar, target_sidecar);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(desktop)]
    run_desktop();
    #[cfg(mobile)]
    run_mobile();
}

#[cfg(desktop)]
fn run_desktop() {
    // main.rs 会更早调用；保留这里可保证 flowlet_lib 被其他宿主直接调用时也有日志。
    let _ = crate::core::logging::init_file_logging();
    crate::core::logging::install_panic_hook();
    let start_hidden = std::env::args().any(|arg| arg == "--hidden" || arg == "--minimized");
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        // 记住主窗口上次的尺寸/位置/最大化状态。不恢复 VISIBLE，
        // 避免覆盖 --hidden 后台启动与「关闭=隐藏到托盘」的可见性控制。
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED)
                .build(),
        )
        .setup(move |app| {
            let setup_t0 = std::time::Instant::now();
            tracing::info!("tauri setup 开始");

            // 首次启动：把随包打包的模型目录文件从资源目录复制到 exe 旁，
            // 让用户开箱即用，无需手动触发同步。
            let resource_dir = app.path().resource_dir()?;
            let exe_dir = std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|d| d.to_path_buf()));
            let config_path = desktop_config_path(
                &resource_dir,
                exe_dir.as_deref(),
                core::webview_profile::is_portable(),
            );
            if let Some(exe_dir) = exe_dir {
                for file_name in ["models-cn.json", "models-dev.json"] {
                    let bundled = resource_dir.join(file_name);
                    let target = exe_dir.join(file_name);
                    if !target.exists() && bundled.exists() {
                        match std::fs::copy(&bundled, &target) {
                            Ok(_) => tracing::info!(file = file_name, "首次启动：已复制内置模型目录到 exe 目录"),
                            Err(error) => tracing::warn!(file = file_name, %error, "复制内置模型目录失败"),
                        }
                    }
                }
            }

            let app_local_data_dir = app.path().app_local_data_dir()?;
            // WebView 数据根目录：便携版在 exe 旁（登录态随身），安装版在
            // %LOCALAPPDATA%。便携版首次启动时把旧位置的登录态 profile 迁移过来
            // （幂等，目标已存在即跳过）；非便携版两个根相同，迁移自动为空操作。
            let webview_root = core::webview_profile::webview_data_root(app.handle())?;
            let migration = core::webview_profile::migrate_webview_profiles_to_portable(
                &app_local_data_dir,
                &webview_root,
            );
            if migration.migrated > 0 || !migration.failures.is_empty() {
                tracing::info!(
                    migrated = migration.migrated,
                    skipped = migration.skipped,
                    failures = migration.failures.len(),
                    root = %webview_root.display(),
                    "setup: WebView 登录态目录迁移完成"
                );
                for error in migration.failures {
                    tracing::warn!(%error, "setup: WebView 登录态目录迁移失败");
                }
            }
            let cache_prune_t0 = std::time::Instant::now();
            let cache_report = core::webview_profile::prune_oversized_webview_caches(&webview_root);
            if cache_report.profiles_pruned > 0 || !cache_report.failures.is_empty() {
                tracing::info!(
                    profiles_scanned = cache_report.profiles_scanned,
                    profiles_pruned = cache_report.profiles_pruned,
                    pruned_mb = format!("{:.1}", cache_report.bytes_pruned as f64 / 1048576.0),
                    failures = cache_report.failures.len(),
                    t_ms = cache_prune_t0.elapsed().as_millis() as u64,
                    "setup: WebView 运行时缓存整理完成"
                );
                for error in cache_report.failures {
                    tracing::warn!(%error, "setup: WebView 缓存整理失败");
                }
            }

            let state = build_app_state(app_database_path(app), config_path.clone());
            app.manage(state.clone());
            let state_for_tray = state.clone();

            // 便携版（无安装器/快捷方式）注册 Windows AppUserModelID，
            // 否则任务完成等 toast 通知会被系统静默丢弃。幂等，仅 HKCU。
            #[cfg(windows)]
            crate::core::notification_registry::register_app_user_model_id(
                &app.config().identifier,
                "Flowlet",
            );
            tracing::info!(
                t_ms = setup_t0.elapsed().as_millis() as u64,
                "setup: state managed"
            );

            // 主窗口与 per-account 控制台抓取窗口使用独立的 WebView 数据目录；
            // 上方仅整理可再生缓存，Cookie / Local Storage 等登录态继续原位保留。
            let main_window_config = app
                .config()
                .app
                .windows
                .iter()
                .find(|config| config.label == "main")
                .cloned()
                .ok_or_else(|| {
                    std::io::Error::new(
                        std::io::ErrorKind::NotFound,
                        "tauri.conf.json 缺少 main 窗口配置",
                    )
                })?;
            let main_webview_data_dir = webview_root.join("main-webview");
            let main_webview_t0 = std::time::Instant::now();
            tracing::info!(
                data_dir = %main_webview_data_dir.display(),
                "setup: 开始创建主 WebView"
            );
            let main_webview_builder =
                tauri::WebviewWindowBuilder::from_config(app.handle(), &main_window_config)?
                    .data_directory(main_webview_data_dir.clone());
            #[cfg(windows)]
            let main_webview_builder = main_webview_builder.additional_browser_args(
                core::webview_profile::WINDOWS_CACHE_LIMIT_BROWSER_ARGS,
            );
            // 插件 on_window_ready 会自动恢复上次的尺寸/位置/最大化
            // （无历史状态时保持 tauri.conf.json 的 1200x720）。Windows 无边框窗口的
            // 配置下限实际约束外框，需补偿不可见 resize frame，保证客户区不小于基线。
            let main_window = main_webview_builder.build()?;
            core::window_size::enforce_minimum_content_size(&main_window)?;
            tracing::info!(
                data_dir = %main_webview_data_dir.display(),
                t_ms = main_webview_t0.elapsed().as_millis() as u64,
                "setup: 主 WebView 创建完成"
            );

            let app_handle = app.handle();

            // 主窗口状态插件会异步恢复上次的尺寸/位置/最大化。延时校验一次，
            // 把因显示器布局变化或上次关闭位置异常而「一半在屏外」的主窗口拉回
            // 可见区域；同时恢复上次退出时仍打开的「项目详情独立窗口」。
            {
                let app_handle_restore = app_handle.clone();
                let state_restore = state.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
                    if let Some(window) = app_handle_restore.get_webview_window("main") {
                        if let Err(error) =
                            crate::core::window_size::enforce_minimum_content_size(&window)
                        {
                            tracing::warn!(%error, "校正主窗口最小客户区失败");
                        }
                        crate::core::window_visibility::ensure_window_on_screen(&window);
                    }
                    for project_id in state_restore.detail_windows.snapshot() {
                        if let Err(error) = crate::commands::open_detail_window(
                            &app_handle_restore,
                            &state_restore,
                            &project_id,
                            None,
                        )
                        .await
                        {
                            tracing::warn!(
                                project_id = %project_id,
                                %error,
                                "恢复项目详情独立窗口失败"
                            );
                        }
                    }
                });
            }

            match core::agent_source_watcher::start_agent_source_watcher(app_handle.clone()) {
                Ok(watcher) => {
                    if let Ok(mut guard) = state.agent_source_watcher.lock() {
                        *guard = Some(watcher);
                    }
                }
                Err(error) => {
                    tracing::warn!(%error, "Agent 数据源文件监听未启用，将继续使用定时轮询")
                }
            }

            // LAN 服务只承担同一 S3 信任域内设备的直连加速与可操作事件转发。
            // 监听失败不会影响代理或 S3 快照同步；后者仍是完整的回退路径。
            let lan_storage = state.storage.clone();
            let lan_identity = state.device_identity.clone();
            let lan_status = state.lan_status.clone();
            let lan_inbound = state.lan_inbound.clone();
            tauri::async_runtime::spawn(async move {
                let identity = match lan_identity.lock() {
                    Ok(identity) => identity.clone(),
                    Err(_) => {
                        tracing::warn!("局域网同步服务无法读取设备身份");
                        crate::core::lan_sync::record_start_failure(
                            &lan_status,
                            "无法读取设备身份",
                        );
                        return;
                    }
                };
                match crate::core::lan_sync::start_server(
                    lan_storage,
                    identity,
                    lan_status.clone(),
                    lan_inbound,
                )
                .await
                {
                    Ok(descriptor) => tracing::info!(
                        endpoints = ?descriptor.endpoints,
                        "局域网同步服务已启动"
                    ),
                    Err(error) => {
                        tracing::warn!(%error, "局域网同步服务未启用");
                        crate::core::lan_sync::record_start_failure(&lan_status, &error);
                    }
                }
            });

            // 关闭窗口时隐藏到托盘，而非退出。自启动传入 --hidden 时保持后台托盘模式。
            if let Some(window) = app.get_webview_window("main") {
                if !start_hidden {
                    let _ = window.show();
                    let _ = window.set_focus();
                }

                let window_label = window.label().to_string();
                let app_handle_for_window = app_handle.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        if let Some(w) = app_handle_for_window.get_webview_window(&window_label) {
                            // 关闭窗口只是隐藏到托盘，不会销毁窗口（也就不会触发
                            // 窗口状态插件的 Exit 写盘），先手动落盘当前尺寸/位置。
                            let _ = app_handle_for_window.save_window_state(
                                StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED,
                            );
                            let _ = w.hide();
                        }
                        api.prevent_close();
                    }
                });
            }

            // 构建托盘菜单
            let toggle = MenuItem::with_id(app_handle, "toggle", "显示/隐藏", true, None::<&str>)?;
            let start_item = MenuItem::with_id(
                app_handle,
                "start_proxy",
                "重启代理服务",
                true,
                None::<&str>,
            )?;
            let quit = MenuItem::with_id(app_handle, "quit", "退出 Flowlet", true, None::<&str>)?;
            let menu = Menu::with_items(app_handle, &[&toggle, &start_item, &quit])?;

            // 创建系统托盘（使用项目 icons/tray.png，保留菜单与点击事件）
            let tray_icon = tauri::include_image!("icons/tray.png");
            let tray = TrayIconBuilder::with_id("main-tray")
                .tooltip("Flowlet - 代理已停止 ⏹")
                .icon(tray_icon)
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app: &AppHandle, event| match event.id().as_ref() {
                    "toggle" => {
                        toggle_window_to_front(app);
                    }
                    "start_proxy" => {
                        if let Some(state) = app.try_state::<AppState>() {
                            let state = state.inner().clone();
                            let app_clone = app.clone();
                            tauri::async_runtime::spawn(async move {
                                if state.proxy.status().running {
                                    let _ = state.proxy.stop().await;
                                }
                                match state.start_configured_proxy().await {
                                    Ok(()) => update_tray_tooltip(&app_clone, true),
                                    Err(_) => update_tray_tooltip(&app_clone, false),
                                }
                            });
                        }
                    }
                    "quit" => {
                        let app_clone = app.clone();
                        let proxy = app.try_state::<AppState>().map(|state| state.proxy.clone());
                        tauri::async_runtime::spawn(async move {
                            // 标记正在退出：随后的窗口销毁事件不应再清空
                            // 「项目详情独立窗口」记录，否则下次启动无法恢复。
                            if let Some(state) = app_clone.try_state::<AppState>() {
                                if let Ok(mut exiting) = state.app_exiting.lock() {
                                    *exiting = true;
                                }
                            }
                            if let Some(proxy) = proxy {
                                let _ = proxy.stop().await;
                            }
                            app_clone.exit(0);
                        });
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle_window_to_front(tray.app_handle());
                    }
                })
                .build(app_handle)?;

            // 保存 tray 引用到 state
            if let Ok(mut tray_guard) = state_for_tray.tray.lock() {
                *tray_guard = Some(tray);
            }

            // 重复任务常驻调度：窗口隐藏到托盘后仍继续运行。每轮先把到期定义转换成
            // 独立 Run（唯一索引防重复），再尝试领取排队 Run；同项目槽被普通任务或
            // 另一条 Run 占用时保留排队，下轮继续。错过多个周期只生成最近一次到期 Run。
            let recurring_storage = state.storage.clone();
            let recurring_jobs = state.jobs.clone();
            tauri::async_runtime::spawn(async move {
                let period = std::time::Duration::from_secs(30);
                let mut interval = tokio::time::interval(period);
                interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
                loop {
                    interval.tick().await;
                    if let Err(error) = recurring_storage.claim_due_recurring_runs() {
                        tracing::warn!(error = %error, "创建到期重复任务运行失败");
                    }
                    let queued = match recurring_storage.list_queued_recurring_runs() {
                        Ok(queued) => queued,
                        Err(error) => { tracing::warn!(error = %error, "读取重复任务运行队列失败"); continue; }
                    };
                    for run in queued {
                        match crate::core::agent_task_runner::run_recurring_task_run(recurring_storage.clone(), recurring_jobs.clone(), run.id.clone()).await {
                            Ok(result) if result.started => {}
                            Ok(_) => {}
                            Err(error) => tracing::warn!(run_id = %run.id, error = %error, "领取重复任务运行失败"),
                        }
                    }
                }
            });

            // S3 设备用量后台同步：启动后 5 秒首次检查，以尽快发布 LAN 端点；
            // 之后每 15 分钟执行一次。
            // 未配置时静默跳过；与手动同步重叠时由共享 guard 去重。窗口隐藏到托盘后
            // Tauri runtime 仍然存活，因此定时同步会继续运行，退出 Flowlet 时停止。
            let s3_timer_storage = state.storage.clone();
            let s3_timer_identity = state.device_identity.clone();
            let s3_timer_runtime_config = state.runtime_config.clone();
            let s3_timer_jobs = state.jobs.clone();
            tauri::async_runtime::spawn(async move {
                let period = crate::core::device_sync::AUTO_SYNC_INTERVAL;
                let mut interval = tokio::time::interval_at(
                    tokio::time::Instant::now()
                        + crate::core::device_sync::AUTO_SYNC_INITIAL_DELAY,
                    period,
                );
                interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
                loop {
                    interval.tick().await;
                    let storage = s3_timer_storage.clone();
                    let configured = tauri::async_runtime::spawn_blocking(move || {
                        crate::core::device_sync::load_config(&storage)
                            .map(|config| config.is_some())
                    })
                    .await;
                    match configured {
                        Ok(Ok(true)) => {}
                        Ok(Ok(false)) => continue,
                        Ok(Err(error)) => {
                            tracing::warn!(error = %error, "scheduled S3 device sync config check failed");
                            continue;
                        }
                        Err(error) => {
                            tracing::warn!(error = %error, "scheduled S3 device sync config task panicked");
                            continue;
                        }
                    }

                    let identity = match s3_timer_identity.lock() {
                        Ok(identity) => identity.clone(),
                        Err(_) => {
                            tracing::warn!("scheduled S3 device sync could not read device identity");
                            continue;
                        }
                    };
                    match crate::core::device_sync::run_configured_sync(
                        s3_timer_storage.clone(),
                        &s3_timer_jobs,
                        identity,
                        "background",
                    )
                    .await
                    {
                        Ok(result) => {
                            tracing::info!(
                                remote_devices = result.remote_devices,
                                imported_devices = result.imported_devices,
                                imported_days = result.imported_days,
                                failed_objects = result.failed_objects,
                                "scheduled S3 device sync finished"
                            );
                        }
                        Err(error)
                            if error == crate::core::device_sync::SYNC_ALREADY_RUNNING_ERROR =>
                        {
                            tracing::debug!("scheduled S3 device sync skipped because another sync is running");
                        }
                        Err(error) => {
                            tracing::warn!(error = %error, "scheduled S3 device sync failed");
                        }
                    }

                    if crate::core::account_workspace_sync::is_enabled(&s3_timer_storage) {
                        match crate::core::account_workspace_sync::sync(
                            s3_timer_storage.clone(),
                            &s3_timer_jobs,
                            "background",
                        )
                        .await
                        {
                            Ok(result) => {
                                if let Ok(accounts) = s3_timer_storage.list_channel_accounts() {
                                    s3_timer_runtime_config
                                        .update(|snapshot| snapshot.accounts = accounts);
                                }
                                tracing::info!(
                                    revision = result.revision,
                                    linked_accounts = result.linked_accounts,
                                    created_local_accounts = result.created_local_accounts,
                                    "scheduled S3 account workspace sync finished"
                                );
                            }
                            Err(error) => {
                                tracing::warn!(
                                    error = %error,
                                    "scheduled S3 account workspace sync failed"
                                );
                            }
                        }
                    }

                    // 项目工作区同步：与账号工作区共用密钥。拉取远端项目/任务变更，
                    // 并把本机项目/任务的变更推送到各自对象。
                    if crate::core::project_workspace_sync::is_enabled(&s3_timer_storage) {
                        match crate::core::project_workspace_sync::sync_all(
                            s3_timer_storage.clone(),
                            &s3_timer_jobs,
                            "background",
                        )
                        .await
                        {
                            Ok(result) => {
                                tracing::info!(
                                    synced_projects = result.synced_projects,
                                    uploaded_objects = result.uploaded_objects,
                                    "scheduled project workspace sync finished"
                                );
                            }
                            Err(error) => {
                                tracing::warn!(
                                    error = %error,
                                    "scheduled project workspace sync failed"
                                );
                            }
                        }
                    }
                }
            });

            // 定时 Body 清理：启动后 15 分钟触发第一次，之后每 15 分钟跑一次。
            // 启动时不做任何清理动作，全部交给定时任务。
            // 每次清理在 spawn_blocking 中执行（不阻塞主线程），结果写入 background_jobs。
            let timer_storage = state.storage.clone();
            let timer_config_path = state.config_path.clone();
            let timer_jobs = state.jobs.clone();
            tauri::async_runtime::spawn(async move {
                let period = std::time::Duration::from_secs(15 * 60);
                let mut interval =
                    tokio::time::interval_at(tokio::time::Instant::now() + period, period);
                interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
                loop {
                    interval.tick().await;
                    let storage = timer_storage.clone();
                    let cfg_path = timer_config_path.clone();
                    let jobs = timer_jobs.clone();
                    let result = tauri::async_runtime::spawn_blocking(move || {
                        storage.run_scheduled_body_cleanup_job(&cfg_path, &jobs)
                    })
                    .await;
                    match result {
                        Ok(Ok((job_id, expired, pruned, before, after))) => {
                            let before_mb = before as f64 / 1048576.0;
                            let after_mb = after as f64 / 1048576.0;
                            tracing::info!(
                                job_id = %job_id,
                                expired,
                                pruned,
                                before_mb = format!("{before_mb:.1}"),
                                after_mb = format!("{after_mb:.1}"),
                                "scheduled body cleanup finished"
                            );
                        }
                        Ok(Err(error)) => {
                            tracing::warn!(error = %error, "scheduled body cleanup job failed");
                        }
                        Err(error) => {
                            tracing::warn!(error = %error, "scheduled body cleanup task panicked");
                        }
                    }
                }
            });

            // 定时模型目录同步（models-cn + models.dev）：启动后 1 小时触发第一次，
            // 之后每 1 小时跑一次。两个源相互独立，结果分别写入 background_jobs 任务日志。
            let catalog_timer_storage = state.storage.clone();
            let catalog_timer_config_path = state.config_path.clone();
            let catalog_timer_jobs = state.jobs.clone();
            tauri::async_runtime::spawn(async move {
                let period = std::time::Duration::from_secs(60 * 60);
                let mut interval =
                    tokio::time::interval_at(tokio::time::Instant::now() + period, period);
                interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
                let models_cn_url = "https://null-object-0000.github.io/models-cn/api.json";
                let models_dev_url = "https://models.dev/api.json";
                loop {
                    interval.tick().await;
                    let storage = catalog_timer_storage.clone();
                    let config_path = catalog_timer_config_path.clone();
                    match crate::core::storage::storage_tasks::sync_models_cn_catalog(&storage, &catalog_timer_jobs, &config_path, models_cn_url, "scheduled").await {
                        Ok(sync_result) => {
                            tracing::info!(
                                started = sync_result.started,
                                skipped = sync_result.skipped,
                                providers = sync_result.provider_count,
                                models = sync_result.model_count,
                                "scheduled models-cn sync finished"
                            );
                        }
                        Err(error) => {
                            tracing::warn!(error = %error, "scheduled models-cn sync failed");
                        }
                    }
                    let storage = catalog_timer_storage.clone();
                    let config_path = catalog_timer_config_path.clone();
                    match crate::core::storage::storage_tasks::sync_models_dev_catalog(&storage, &catalog_timer_jobs, &config_path, models_dev_url, "scheduled").await {
                        Ok(sync_result) => {
                            tracing::info!(
                                started = sync_result.started,
                                skipped = sync_result.skipped,
                                providers = sync_result.provider_count,
                                models = sync_result.model_count,
                                "scheduled models.dev sync finished"
                            );
                        }
                        Err(error) => {
                            tracing::warn!(error = %error, "scheduled models.dev sync failed");
                        }
                    }
                }
            });

            tracing::info!(
                t_ms = setup_t0.elapsed().as_millis() as u64,
                "✅ setup 完成 — invoke_handler + Tauri event loop 接管"
            );

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::detect_agent_environment,
            commands::check_agent_latest_versions,
            commands::list_cached_codex_accounts,
            commands::query_codex_account,
            commands::query_codex_accounts,
            commands::sync_codex_accounts,
            commands::authorize_codex_account,
            commands::delete_codex_account,
            commands::inspect_agent_global_config,
            commands::apply_agent_global_config,
            commands::restore_agent_global_config,
            commands::start_proxy,
            commands::stop_proxy,
            commands::proxy_status,
            commands::test_connection,
            commands::get_proxy_bind_config,
            commands::set_proxy_bind_config,
            commands::list_channel_presets,
            commands::save_channel_presets,
            commands::list_channel_accounts,
            commands::save_channel_accounts,
            commands::initialize_account_workspace,
            commands::get_account_workspace_status,
            commands::sync_account_workspace,
            commands::export_desktop_account_workspace,
            commands::import_desktop_account_workspace,
            commands::list_route_candidates,
            commands::save_route_candidates,
            commands::list_channel_models,
            commands::list_virtual_models,
            commands::save_virtual_models,
            commands::analyze_usage,
            commands::repair_agent_sessions,
            commands::repair_captured_usage,
            commands::repair_unknown_usage,
            commands::repair_usage_costs,
            commands::usage_summary,
            commands::agent_native_usage_summary,
            commands::usage_today_tokens,
            commands::device_usage_snapshot,
            commands::list_known_devices,
            commands::list_shared_devices,
            commands::list_shared_device_projects,
            commands::device_daily_usage,
            commands::device_hourly_usage,
            commands::shared_device_daily_usage,
            commands::shared_device_hourly_usage,
            commands::list_shared_device_sessions,
            commands::refresh_shared_device,
            commands::rename_current_device,
            commands::get_s3_sync_settings,
            commands::export_s3_connection_config,
            commands::save_s3_sync_config,
            commands::test_s3_sync_connection,
            commands::test_s3_read_connection,
            commands::sync_device_usage_s3,
            commands::recover_current_device_sync,
            commands::refresh_shared_device_usage_s3,
            commands::list_remote_opencode_permissions,
            commands::reply_remote_opencode_permission,
            commands::refresh_shared_device_usage_lan,
            commands::lan_server_status,
            commands::probe_lan_peers,
            commands::export_device_usage_bundle,
            commands::preview_device_usage_import,
            commands::import_device_usage_bundle,
            commands::list_request_logs,
            commands::list_agent_sessions,
            commands::list_agent_capabilities,
            commands::list_projects,
            commands::get_project,
            commands::save_project,
            commands::delete_project,
            commands::list_project_tasks,
            commands::list_recurring_tasks,
            commands::save_recurring_task,
            commands::delete_recurring_task,
            commands::list_recurring_task_runs,
            commands::run_recurring_task_now,
            commands::save_project_task,
            commands::delete_project_task,
            commands::open_project_detail_window,
            commands::run_project_task,
            commands::get_project_task_runner_state,
            commands::list_queued_project_tasks,
            commands::boost_project_task,
            commands::set_project_task_status,
            commands::convert_project_task_to_code,
            commands::get_project_workspace_status,
            commands::sync_project_workspace,
            commands::list_agent_session_children,
            commands::list_opencode_session_permissions,
            commands::reply_opencode_permission,
            commands::list_dsh_session_permissions,
            commands::reply_dsh_permission,
            commands::get_agent_session_native_summary,
            commands::get_agent_session_last_interaction,
            commands::get_agent_session_timeline,
            commands::get_agent_session_flowlet_usage,
            commands::sync_agent_data,
            commands::list_background_jobs,
            commands::get_background_job_detail,
            commands::get_agent_sync_status,
            commands::cancel_background_job,
            commands::cleanup_background_jobs,
            commands::sync_models_cn_catalog,
            commands::sync_models_dev_catalog,
            commands::get_models_cn_catalog,
            commands::get_models_cn_currencies,
            commands::preview_sync_channel_presets,
            commands::apply_sync_channel_presets,
            commands::probe_cost_ledger_sources,
            commands::list_agent_session_clients,
            commands::list_request_log_clients,
            commands::list_request_log_models,
            commands::get_request_log_detail,
            commands::get_log_capture_config,
            commands::set_log_capture_config,
            commands::query_balance,
            commands::fetch_channel_models,
            commands::save_balance_snapshot,
            commands::list_balance_snapshots,
            commands::latest_balance_snapshots,
            commands::open_scrape_console,
            commands::close_scrape_console,
            commands::handle_intercepted_response,
            commands::handle_scrape_interceptor_ready,
            commands::probe_scrape_login,
            commands::scrape_balance,
            commands::sync_scrape_balances,
            commands::account_stats,
            commands::is_autostart_enabled,
            commands::enable_autostart,
            commands::disable_autostart,
            commands::get_task_review_notification_enabled,
            commands::set_task_review_notification_enabled,
            commands::list_route_rules,
            commands::save_route_rules,
            commands::account_routing_scores,
            commands::export_config,
            commands::import_config,
            commands::db_stats,
            commands::storage_usage_summary,
            commands::compact_database,
            commands::read_app_meta,
            commands::write_app_meta,
            commands::get_app_version,
            commands::get_app_data_dir,
            commands::get_app_diagnostics,
            commands::cleanup_old_logs,
            commands::cleanup_expired_body_data,
            commands::prune_oldest_body_data,
            commands::get_total_body_size_bytes,
            commands::read_config,
            commands::write_config,
            commands::ipc_ping,
            commands::log_from_frontend,
        ])
        .run(tauri::generate_context!())
        .expect("启动 Flowlet 失败");
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
            mobile_commands::list_shared_device_projects,
            mobile_commands::submit_task_lan,
            mobile_commands::set_task_status_lan,
            mobile_commands::edit_task_lan,
            mobile_commands::delete_task_lan,
        ])
        .run(tauri::generate_context!())
        .expect("启动 Flowlet Mobile 失败");
}

/// 切换主窗口显示/隐藏。显示时确保窗口被恢复到前台焦点状态。
/// 仅 show + set_focus 可能无法把窗口带到前台，因此额外做 unminimize
/// 和短暂置顶再取消的操作覆盖 Windows 等场景。
#[cfg(desktop)]
fn toggle_window_to_front(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            // 托盘「显示/隐藏」隐藏主窗口时同样先落盘当前尺寸/位置。
            let _ = app
                .save_window_state(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED);
            let _ = window.hide();
            return;
        }
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_always_on_top(true);
        let _ = window.set_focus();
        let _ = window.set_always_on_top(false);
    }
}

/// 更新托盘 tooltip 显示代理状态
#[cfg(desktop)]
fn update_tray_tooltip(app: &AppHandle, running: bool) {
    let tooltip = if running {
        "Flowlet - 代理运行中 ✅"
    } else {
        "Flowlet - 代理已停止 ⏹"
    };
    let state = app.state::<AppState>();
    let tray_guard = match state.tray.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    if let Some(ref t) = *tray_guard {
        let _ = t.set_tooltip(Some(tooltip));
    }
}

/// 把 config.json 渠道预设同步到数据库。
/// `disable_newly_added` 为 true 时，新增渠道（数据库里没有的）会被设为 disabled，
/// 已有渠道保留原启用状态；为 false 时全量按 config 写入。
#[cfg(desktop)]
fn migrate_channel_presets_from_config(
    storage: &Storage,
    config_path: &std::path::Path,
    disable_newly_added: bool,
) -> Result<(), String> {
    let config_raw =
        std::fs::read_to_string(config_path).map_err(|e| format!("读取 config.json 失败：{e}"))?;

    // 重新解析 config.json 并同步渠道预设
    let config_value: serde_json::Value =
        serde_json::from_str(&config_raw).map_err(|e| format!("解析 config.json 失败：{e}"))?;
    let channels_config = core::channels_config::ChannelsConfig::from_config_json(&config_value)
        .map_err(|e| format!("构建 ChannelsConfig 失败：{e}"))?;

    // 内置渠道始终保留
    let mut presets = channels_config.presets.clone();
    let builtin = core::presets::builtin_channel_presets();
    for bp in &builtin {
        if !presets.iter().any(|p| p.id == bp.id) {
            presets.push(bp.clone());
        }
    }

    // 读取现有渠道，建立 ID → enabled 映射
    let existing = storage
        .list_channel_presets()
        .map_err(|e| format!("读取现有渠道预设失败：{e}"))?;
    let existing_map: std::collections::HashMap<&str, bool> = existing
        .iter()
        .map(|p| (p.id.as_str(), p.enabled))
        .collect();

    // 新增渠道默认禁用（用户需手动启用并配置 API Key）
    if disable_newly_added {
        for preset in &mut presets {
            if !existing_map.contains_key(preset.id.as_str()) {
                preset.enabled = false;
                tracing::info!(channel = %preset.id, "新增渠道默认禁用");
            } else {
                // 已有渠道保留原启用状态
                preset.enabled = existing_map[preset.id.as_str()];
            }
        }
    } else {
        // 不强制禁用新增时，已有渠道保留原状态，新增渠道按 config 默认值（通常 true）
        for preset in &mut presets {
            if let Some(&enabled) = existing_map.get(preset.id.as_str()) {
                preset.enabled = enabled;
            }
        }
    }

    // 全量替换渠道预设（save_channel_presets 内部先 DELETE 再 INSERT）
    storage
        .save_channel_presets(&presets)
        .map_err(|e| format!("保存渠道预设失败：{e}"))?;

    tracing::info!(
        count = presets.len(),
        disable_newly_added,
        "渠道预设同步完成"
    );
    Ok(())
}

#[cfg(all(test, desktop))]
mod desktop_config_path_tests {
    use super::desktop_config_path;
    use std::path::Path;

    #[test]
    fn portable_config_lives_beside_the_executable() {
        let path = desktop_config_path(
            Path::new("/usr/lib/Flowlet"),
            Some(Path::new("/opt/Flowlet")),
            true,
        );
        assert_eq!(path, Path::new("/opt/Flowlet/config.json"));
    }

    #[test]
    fn installed_config_stays_in_the_resource_directory() {
        let path = desktop_config_path(
            Path::new("/usr/lib/Flowlet"),
            Some(Path::new("/opt/Flowlet")),
            false,
        );
        assert_eq!(path, Path::new("/usr/lib/Flowlet/config.json"));
    }
}
