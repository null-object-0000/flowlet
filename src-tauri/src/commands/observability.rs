use crate::AppState;
use crate::core::config::{
    LogCaptureConfig, LogFilterClient, LogsFilter, LogsPageResult, RequestLogModelOptions,
    RequestLogRow,
};
use std::sync::atomic::{AtomicBool, Ordering};

static AGENT_DATA_SYNC_RUNNING: AtomicBool = AtomicBool::new(false);

struct AgentDataSyncGuard;

impl Drop for AgentDataSyncGuard {
    fn drop(&mut self) {
        AGENT_DATA_SYNC_RUNNING.store(false, Ordering::Release);
    }
}

#[tauri::command]
pub(crate) fn list_request_logs(
    state: tauri::State<'_, AppState>,
    filter: LogsFilter,
) -> Result<LogsPageResult, String> {
    state
        .storage
        .list_request_logs_page(filter)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(crate) async fn list_agent_sessions(
    state: tauri::State<'_, AppState>,
    filter: crate::core::config::AgentSessionsFilter,
) -> Result<crate::core::config::AgentSessionsPageResult, String> {
    // OpenCode 的 pending permission 是进程内实时状态，优先级高于
    // SQLite 中“末条 assistant 尚未完成”的运行态推断；必须在过滤和分页前合并，
    // 否则按运行状态筛选时，实时等待中的 OpenCode 会话会被 SQLite 中旧的状态误筛掉。
    let permission_report = crate::core::opencode_control::list_permissions().await;
    let waiting_sessions = if permission_report.available {
        permission_report
            .permissions
            .into_iter()
            .map(|permission| permission.session_id)
            .collect::<std::collections::HashSet<_>>()
    } else {
        std::collections::HashSet::new()
    };
    state
        .storage
        .list_agent_sessions(filter, &waiting_sessions)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(crate) fn list_agent_session_children(
    state: tauri::State<'_, AppState>,
    agent_type: String,
    parent_session_id: String,
) -> Result<Vec<crate::core::config::AgentSessionRow>, String> {
    state
        .storage
        .list_agent_session_children(&agent_type, &parent_session_id)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(crate) async fn list_opencode_session_permissions(
    session_id: String,
) -> Result<crate::core::opencode_control::OpenCodePermissionReport, String> {
    Ok(crate::core::opencode_control::list_session_permissions(&session_id).await)
}

#[tauri::command]
pub(crate) async fn reply_opencode_permission(
    permission_id: String,
    decision: crate::core::opencode_control::OpenCodePermissionDecision,
) -> Result<(), String> {
    crate::core::opencode_control::reply_permission(&permission_id, decision).await
}

#[tauri::command]
pub(crate) async fn get_agent_session_native_summary(
    state: tauri::State<'_, AppState>,
    agent_type: String,
    session_id: String,
) -> Result<crate::core::config::AgentSessionNativeSummary, String> {
    let prices = state.storage.prices();
    tauri::async_runtime::spawn_blocking(move || {
        let mut summary = crate::core::agent_session_timeline::get_native_agent_session_summary(
            &agent_type,
            &session_id,
        )?;
        crate::core::agent_session_timeline::apply_native_cost_estimate_to_summary(
            &agent_type,
            &mut summary,
            &prices,
        );
        Ok(summary)
    })
    .await
    .map_err(|error| format!("读取原生会话摘要任务失败：{error}"))?
}

#[tauri::command]
pub(crate) async fn get_agent_session_last_interaction(
    state: tauri::State<'_, AppState>,
    agent_type: String,
    session_id: String,
) -> Result<Option<crate::core::config::AgentSessionTimeline>, String> {
    let prices = state.storage.prices();
    tauri::async_runtime::spawn_blocking(move || {
        let mut interaction =
            crate::core::agent_session_timeline::get_native_agent_session_last_interaction(
                &agent_type,
                &session_id,
            )?;
        if let Some(interaction) = interaction.as_mut() {
            crate::core::agent_session_timeline::apply_native_cost_estimate_to_timeline(
                &agent_type,
                interaction,
                &prices,
            );
        }
        Ok(interaction)
    })
    .await
    .map_err(|error| format!("读取会话最后一次交互任务失败：{error}"))?
}

#[tauri::command]
pub(crate) async fn sync_agent_data(
    state: tauri::State<'_, AppState>,
    force: bool,
    trigger_source: String,
) -> Result<crate::core::storage::AgentDataSyncResult, String> {
    if AGENT_DATA_SYNC_RUNNING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Ok(crate::core::storage::AgentDataSyncResult {
            started: false,
            job_id: None,
            scanned: 0,
            changed: 0,
            failed: 0,
            message: "已有 Agent 数据同步正在运行".to_string(),
        });
    }
    let _guard = AgentDataSyncGuard;
    let storage = state.storage.clone();
    tauri::async_runtime::spawn_blocking(move || storage.sync_agent_data(force, &trigger_source))
        .await
        .map_err(|error| format!("Agent 数据同步任务失败：{error}"))?
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn list_background_jobs(
    state: tauri::State<'_, AppState>,
    filter: crate::core::storage::BackgroundJobsFilter,
) -> Result<crate::core::storage::BackgroundJobsPage, String> {
    state
        .storage
        .list_background_jobs(filter)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn get_background_job_detail(
    state: tauri::State<'_, AppState>,
    job_id: String,
) -> Result<crate::core::storage::BackgroundJobDetail, String> {
    state
        .storage
        .get_background_job_detail(&job_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "任务日志不存在".to_string())
}

#[tauri::command]
pub(crate) fn get_agent_sync_status(
    state: tauri::State<'_, AppState>,
) -> Result<crate::core::storage::AgentSyncStatusReport, String> {
    Ok(crate::core::storage::AgentSyncStatusReport {
        running: AGENT_DATA_SYNC_RUNNING.load(Ordering::Acquire),
        sources: state
            .storage
            .list_agent_source_sync_states()
            .map_err(|error| error.to_string())?,
    })
}

#[tauri::command]
pub(crate) fn cancel_background_job(
    state: tauri::State<'_, AppState>,
    job_id: String,
) -> Result<bool, String> {
    state
        .storage
        .request_background_job_cancel(&job_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn cleanup_background_jobs(
    state: tauri::State<'_, AppState>,
    keep_days: u32,
) -> Result<crate::core::storage::CleanupBackgroundJobsResult, String> {
    state
        .storage
        .cleanup_background_jobs(keep_days)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) async fn probe_cost_ledger_sources(
    state: tauri::State<'_, AppState>,
) -> Result<crate::core::cost_ledger_source_probe::CostLedgerSourceProbeResult, String> {
    let storage = state.storage.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::core::cost_ledger_source_probe::probe_cost_ledger_sources(&storage)
    })
    .await
    .map_err(|error| format!("探测成本账本数据源失败：{error}"))
}

#[tauri::command]
pub(crate) fn list_agent_session_clients(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<LogFilterClient>, String> {
    state
        .storage
        .list_agent_session_clients()
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(crate) fn list_request_log_clients(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<LogFilterClient>, String> {
    state
        .storage
        .list_request_log_clients()
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(crate) fn list_request_log_models(
    state: tauri::State<'_, AppState>,
) -> Result<RequestLogModelOptions, String> {
    state
        .storage
        .list_request_log_models()
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(crate) fn get_request_log_detail(
    state: tauri::State<'_, AppState>,
    request_id: String,
) -> Result<Vec<RequestLogRow>, String> {
    state
        .storage
        .list_request_logs_by_request_id(&request_id)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(crate) fn get_log_capture_config(
    state: tauri::State<'_, AppState>,
) -> Result<LogCaptureConfig, String> {
    state
        .capture
        .lock()
        .map(|guard| guard.clone())
        .map_err(|_| "锁失败".to_string())
}

#[tauri::command]
pub(crate) fn set_log_capture_config(
    state: tauri::State<'_, AppState>,
    config: LogCaptureConfig,
) -> Result<(), String> {
    let json = serde_json::to_string(&config).map_err(|err| err.to_string())?;
    state
        .storage
        .set_app_meta("log_capture_config", &json)
        .map_err(|err| err.to_string())?;
    if let Ok(mut guard) = state.capture.lock() {
        *guard = config;
    }
    Ok(())
}
