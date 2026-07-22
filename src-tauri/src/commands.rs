use super::{update_tray_tooltip, AppState};
use crate::core::config::{
    AccountBalanceSnapshot, AccountStatsRow, ChannelAccount, ChannelModel, ChannelPreset,
    LogCaptureConfig, LogFilterClient, LogsFilter, LogsPageResult, ProxyBindConfig,
    RequestLogModelOptions, RequestLogRow, RouteCandidate, RouteRule, UsageSummaryRow,
    VirtualModel,
};
use crate::core::presets::{BalanceQueryResult, ModelSyncResult};
use crate::core::proxy::ProxyStatus;
use crate::core::sync::{
    query_deepseek_balance, query_kimi_balance, sync_deepseek_models, sync_kimi_models,
    sync_longcat_models, sync_qwen_models, test_channel_connection,
};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter};

#[derive(Clone, serde::Serialize)]
struct ExportProgress {
    stage: String,
    message: String,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct StorageUsageProgress {
    scan_id: String,
    summary: crate::core::storage::StorageUsageSummary,
}

static AGENT_DATA_SYNC_RUNNING: AtomicBool = AtomicBool::new(false);
struct AgentDataSyncGuard;
impl Drop for AgentDataSyncGuard {
    fn drop(&mut self) {
        AGENT_DATA_SYNC_RUNNING.store(false, Ordering::Release);
    }
}

static CODEX_ACCOUNT_SYNC_RUNNING: AtomicBool = AtomicBool::new(false);
struct CodexAccountSyncGuard;
impl Drop for CodexAccountSyncGuard {
    fn drop(&mut self) {
        CODEX_ACCOUNT_SYNC_RUNNING.store(false, Ordering::Release);
    }
}
use tauri_plugin_autostart::ManagerExt;

// ─── Agent Environment Commands ────────────────────────────────────────────

// Claude Code 走 Anthropic-compatible 端点，其余已支持一键接入的 Agent
// （OpenCode、Pi）走 OpenAI-compatible 端点。
fn agent_endpoint_suffix(agent_id: &str) -> &'static str {
    match agent_id {
        "claude-code" => "/anthropic",
        _ => "/v1",
    }
}

#[tauri::command]
pub(super) async fn detect_agent_environment(
    agent_id: String,
) -> Result<crate::core::agent_environment::AgentEnvironmentReport, String> {
    crate::core::agent_environment::detect_agent_environment(&agent_id).await
}

#[tauri::command]
pub(super) async fn query_codex_accounts(
    state: tauri::State<'_, AppState>,
) -> Result<crate::core::codex_account::CodexAccountsReport, String> {
    crate::core::codex_account::query_codex_accounts(&state.codex_accounts_dir).await
}

#[tauri::command]
pub(super) fn list_cached_codex_accounts(
    state: tauri::State<'_, AppState>,
) -> Result<crate::core::codex_account::CodexAccountsReport, String> {
    crate::core::codex_account::list_cached_codex_accounts(&state.codex_accounts_dir)
}

#[tauri::command]
pub(super) async fn sync_codex_accounts(
    state: tauri::State<'_, AppState>,
    trigger_source: String,
) -> Result<crate::core::codex_account::CodexAccountSyncResult, String> {
    if CODEX_ACCOUNT_SYNC_RUNNING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Ok(crate::core::codex_account::CodexAccountSyncResult {
            started: false,
            job_id: None,
            accounts: 0,
            stale: 0,
            failed: 0,
            message: "已有 Codex 账号同步正在运行".to_string(),
        });
    }
    let _guard = CodexAccountSyncGuard;
    let codex_home = crate::core::codex_account::codex_home();
    crate::core::codex_account::sync_codex_accounts(
        &state.storage,
        &state.codex_accounts_dir,
        &codex_home,
        &trigger_source,
    )
    .await
}

#[tauri::command]
pub(super) async fn authorize_codex_account(
    state: tauri::State<'_, AppState>,
) -> Result<crate::core::codex_account::CodexAccountReport, String> {
    crate::core::codex_account::authorize_codex_account(&state.codex_accounts_dir, |auth_url| {
        tauri_plugin_opener::open_url(auth_url, None::<&str>)
            .map_err(|error| format!("无法打开 Codex 账号授权页面：{error}"))
    })
    .await
}

#[tauri::command]
pub(super) fn inspect_agent_global_config(
    state: tauri::State<'_, AppState>,
    agent_id: String,
) -> Result<crate::core::agent_global_config::AgentGlobalConfigReport, String> {
    let bind = state
        .bind_config
        .lock()
        .map_err(|_| "读取 Flowlet 客户端配置失败".to_string())?
        .clone()
        .normalized();
    let suffix = agent_endpoint_suffix(&agent_id);
    crate::core::agent_global_config::inspect_agent_global_config(
        &agent_id,
        &format!("http://127.0.0.1:{}{suffix}", bind.port),
    )
}

#[tauri::command]
pub(super) fn apply_agent_global_config(
    state: tauri::State<'_, AppState>,
    agent_id: String,
    options: Option<crate::core::agent_global_config::AgentGlobalConfigOptions>,
) -> Result<crate::core::agent_global_config::AgentGlobalConfigReport, String> {
    let bind = state
        .bind_config
        .lock()
        .map_err(|_| "读取 Flowlet 客户端配置失败".to_string())?
        .clone()
        .normalized();
    let suffix = agent_endpoint_suffix(&agent_id);
    crate::core::agent_global_config::apply_agent_global_config(
        &agent_id,
        &format!("http://127.0.0.1:{}{suffix}", bind.port),
        &bind.default_client_token,
        options.as_ref(),
    )
}

#[tauri::command]
pub(super) fn restore_agent_global_config(
    state: tauri::State<'_, AppState>,
    agent_id: String,
) -> Result<crate::core::agent_global_config::AgentGlobalConfigReport, String> {
    let port = state
        .bind_config
        .lock()
        .map_err(|_| "读取 Flowlet 客户端配置失败".to_string())?
        .clone()
        .normalized()
        .port;
    let suffix = agent_endpoint_suffix(&agent_id);
    crate::core::agent_global_config::restore_agent_global_config(
        &agent_id,
        &format!("http://127.0.0.1:{port}{suffix}"),
    )
}

// ─── Proxy Commands ──────────────────────────────────────────────────────────

#[tauri::command]
pub(super) async fn start_proxy(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    if state.proxy.status().running {
        update_tray_tooltip(&app, true);
        return Ok(());
    }
    tracing::info!("start_proxy: 开始启动本地代理");
    state.start_configured_proxy().await.map_err(|err| {
        tracing::error!(error = %err, "start_proxy: 启动失败");
        err
    })?;
    tracing::info!("start_proxy: 本地代理启动成功");
    update_tray_tooltip(&app, true);
    Ok(())
}

#[tauri::command]
pub(super) async fn stop_proxy(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    state.proxy.stop().await.map_err(|err| err.to_string())?;
    // 更新托盘 tooltip
    update_tray_tooltip(&app, false);
    Ok(())
}

#[tauri::command]
pub(super) fn proxy_status(state: tauri::State<'_, AppState>) -> ProxyStatus {
    let mut status = state.proxy.status();
    if !status.running {
        if let Ok(config) = state.bind_config.lock() {
            status.bind_addr = config.clone().normalized().bind_addr();
        }
    }
    status
}

// ─── Connection Test ───────────────────────────────────────────────────────

#[tauri::command]
pub(super) async fn test_connection(
    state: tauri::State<'_, AppState>,
    channel_id: String,
    api_key: String,
    base_url_override: Option<String>,
) -> Result<(), String> {
    // 直接传入连接参数，这样新建账号（尚未保存）也能测试。
    // 仅做上游鉴权校验，不读写已保存的账号列表。
    let account = ChannelAccount {
        id: String::new(),
        channel_id,
        name: String::new(),
        api_key,
        enabled: true,
        priority: 0,
        base_url_override,
        ..Default::default()
    };
    let channels_config = state
        .channels_config
        .lock()
        .map_err(|_| "锁定渠道运行时配置失败".to_string())?
        .clone();
    test_channel_connection(&account, &channels_config).await
}

#[tauri::command]
pub(super) fn get_proxy_bind_config(
    state: tauri::State<'_, AppState>,
) -> Result<ProxyBindConfig, String> {
    state
        .bind_config
        .lock()
        .map(|guard| guard.clone().normalized())
        .map_err(|_| "读取代理监听配置失败".to_string())
}

#[tauri::command]
pub(super) fn set_proxy_bind_config(
    state: tauri::State<'_, AppState>,
    config: ProxyBindConfig,
) -> Result<(), String> {
    let config = config.normalized();
    config
        .bind_addr()
        .parse::<std::net::SocketAddr>()
        .map_err(|_| "代理监听地址无效".to_string())?;
    let json = serde_json::to_string(&config).map_err(|err| err.to_string())?;
    state
        .storage
        .set_app_meta("proxy_bind_config", &json)
        .map_err(|err| err.to_string())?;
    if let Ok(mut guard) = state.bind_config.lock() {
        *guard = config.clone();
    }
    if let Ok(mut guard) = state.proxy.bind_config.lock() {
        *guard = config;
    }
    Ok(())
}
// ─── Channel Presets Commands ────────────────────────────────────────────────

#[tauri::command]
pub(super) fn list_channel_presets(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<ChannelPreset>, String> {
    state
        .channels
        .lock()
        .map(|channels| channels.clone())
        .map_err(|_| "读取渠道模板失败".to_string())
}

#[tauri::command]
pub(super) fn save_channel_presets(
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

// ─── Channel Accounts Commands ──────────────────────────────────────────────

#[tauri::command]
pub(super) fn list_channel_accounts(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<ChannelAccount>, String> {
    state
        .accounts
        .lock()
        .map(|accounts| accounts.clone())
        .map_err(|_| "读取账号配置失败".to_string())
}

#[tauri::command]
pub(super) fn save_channel_accounts(
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

// ─── Route Candidates Commands ──────────────────────────────────────────────

#[tauri::command]
pub(super) fn list_route_candidates(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<RouteCandidate>, String> {
    state
        .routes
        .lock()
        .map(|routes| routes.clone())
        .map_err(|_| "读取路由配置失败".to_string())
}

#[tauri::command]
pub(super) fn save_route_candidates(
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
pub(super) fn list_channel_models(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<ChannelModel>, String> {
    state
        .storage
        .list_channel_models()
        .map_err(|err| err.to_string())
}

// ─── Virtual Models Commands ────────────────────────────────────────────────

#[tauri::command]
pub(super) fn list_virtual_models(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<VirtualModel>, String> {
    state
        .virtual_models
        .lock()
        .map(|models| models.clone())
        .map_err(|_| "读取虚拟模型失败".to_string())
}

#[tauri::command]
pub(super) fn save_virtual_models(
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

// ─── Usage & Logs Commands ──────────────────────────────────────────────────

#[tauri::command]
pub(super) fn analyze_usage(state: tauri::State<'_, AppState>) -> Result<usize, String> {
    let parsed = state
        .storage
        .reanalyze_captured_usage("all")
        .map_err(|err| err.to_string())?;
    let inserted = state
        .storage
        .analyze_unknown_usage("all")
        .map_err(|err| err.to_string())?;
    state
        .storage
        .recalculate_usage_costs("all")
        .map_err(|err| err.to_string())?;
    Ok(parsed + inserted)
}

#[tauri::command]
pub(super) fn repair_agent_sessions(
    state: tauri::State<'_, AppState>,
    time_range: String,
) -> Result<crate::core::config::AgentSessionRepairResult, String> {
    state
        .storage
        .repair_agent_sessions(&time_range)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(super) fn repair_captured_usage(
    state: tauri::State<'_, AppState>,
    time_range: String,
) -> Result<usize, String> {
    state
        .storage
        .reanalyze_captured_usage(&time_range)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(super) fn repair_unknown_usage(
    state: tauri::State<'_, AppState>,
    time_range: String,
) -> Result<usize, String> {
    state
        .storage
        .analyze_unknown_usage(&time_range)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(super) fn repair_usage_costs(
    state: tauri::State<'_, AppState>,
    time_range: String,
) -> Result<usize, String> {
    state
        .storage
        .recalculate_usage_costs(&time_range)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(super) fn usage_summary(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<UsageSummaryRow>, String> {
    state.storage.usage_summary().map_err(|err| err.to_string())
}

#[tauri::command]
pub(super) fn list_request_logs(
    state: tauri::State<'_, AppState>,
    filter: LogsFilter,
) -> Result<LogsPageResult, String> {
    state
        .storage
        .list_request_logs_page(filter)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(super) fn list_agent_sessions(
    state: tauri::State<'_, AppState>,
    filter: crate::core::config::AgentSessionsFilter,
) -> Result<crate::core::config::AgentSessionsPageResult, String> {
    state
        .storage
        .list_agent_sessions(filter)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(super) fn list_agent_session_children(
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
pub(super) async fn get_agent_session_timeline(
    state: tauri::State<'_, AppState>,
    agent_type: String,
    session_id: String,
) -> Result<crate::core::config::AgentSessionTimeline, String> {
    let prices = state.storage.prices();
    tauri::async_runtime::spawn_blocking(move || {
        let mut timeline = crate::core::agent_session_timeline::get_native_agent_session_timeline(
            &agent_type,
            &session_id,
        )?;
        crate::core::agent_session_timeline::apply_native_cost_estimate_to_timeline(
            &agent_type,
            &mut timeline,
            &prices,
        );
        Ok(timeline)
    })
    .await
    .map_err(|error| format!("读取原生会话任务失败：{error}"))?
}

#[tauri::command]
pub(super) async fn get_agent_session_native_summary(
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
pub(super) async fn sync_agent_data(
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
pub(super) fn list_background_jobs(
    state: tauri::State<'_, AppState>,
    filter: crate::core::storage::BackgroundJobsFilter,
) -> Result<crate::core::storage::BackgroundJobsPage, String> {
    state
        .storage
        .list_background_jobs(filter)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(super) fn get_background_job_detail(
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
pub(super) fn get_agent_sync_status(
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
pub(super) fn cancel_background_job(
    state: tauri::State<'_, AppState>,
    job_id: String,
) -> Result<bool, String> {
    state
        .storage
        .request_background_job_cancel(&job_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(super) fn cleanup_background_jobs(
    state: tauri::State<'_, AppState>,
    keep_days: u32,
) -> Result<crate::core::storage::CleanupBackgroundJobsResult, String> {
    state
        .storage
        .cleanup_background_jobs(keep_days)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(super) async fn probe_cost_ledger_sources(
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
pub(super) fn list_agent_session_clients(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<LogFilterClient>, String> {
    state
        .storage
        .list_agent_session_clients()
        .map_err(|err| err.to_string())
}

/// 返回请求日志中实际出现的客户端身份列表，供前端"客户端"筛选项使用。
/// id 为空串表示"未知"（client_id IS NULL）。
#[tauri::command]
pub(super) fn list_request_log_clients(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<LogFilterClient>, String> {
    state
        .storage
        .list_request_log_clients()
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(super) fn list_request_log_models(
    state: tauri::State<'_, AppState>,
) -> Result<RequestLogModelOptions, String> {
    state
        .storage
        .list_request_log_models()
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(super) fn get_request_log_detail(
    state: tauri::State<'_, AppState>,
    request_id: String,
) -> Result<Vec<RequestLogRow>, String> {
    state
        .storage
        .list_request_logs_by_request_id(&request_id)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(super) fn get_log_capture_config(
    state: tauri::State<'_, AppState>,
) -> Result<LogCaptureConfig, String> {
    state
        .capture
        .lock()
        .map(|guard| guard.clone())
        .map_err(|_| "锁失败".to_string())
}

#[tauri::command]
pub(super) fn set_log_capture_config(
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

// ─── Sync Commands ──────────────────────────────────────────────────────────

#[tauri::command]
pub(super) async fn query_balance(
    state: tauri::State<'_, AppState>,
    account_id: String,
) -> Result<BalanceQueryResult, String> {
    let account = {
        let accounts = state
            .accounts
            .lock()
            .map_err(|_| "读取账号失败".to_string())?;
        accounts
            .iter()
            .find(|a| a.id == account_id)
            .ok_or("账号不存在")?
            .clone()
    };

    // 目前支持 DeepSeek 和 Kimi 余额查询
    if account.channel_id != "deepseek" && account.channel_id != "kimi" {
        return Ok(BalanceQueryResult {
            balance: None,
            currency: None,
            is_available: false,
            error: Some("当前仅 DeepSeek 和 Kimi 支持余额查询".to_string()),
        });
    }

    if account
        .base_url_override
        .as_deref()
        .is_some_and(|url| !url.trim().is_empty())
    {
        return Ok(BalanceQueryResult {
            balance: None,
            currency: None,
            is_available: false,
            error: Some("自定义 OpenAI Base URL 不支持官方余额自动同步".to_string()),
        });
    }

    let config = state
        .channels_config
        .lock()
        .map_err(|_| "锁定渠道运行时配置失败".to_string())?
        .clone();

    // 在 spawn_blocking 中执行 HTTP 调用，避免 Send 问题
    let result = tauri::async_runtime::spawn_blocking(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap_or_else(|_| panic!("创建运行时失败"));
        if account.channel_id == "kimi" {
            rt.block_on(query_kimi_balance(&account, &config))
        } else {
            rt.block_on(query_deepseek_balance(&account, &config))
        }
    })
    .await
    .map_err(|e| format!("任务执行失败: {e}"))?;

    // 更新账号凭证状态与最后错误信息。
    // 测试连接成功 → 重置为 healthy；若返回 401 则标记为 invalid_key。
    // 同时更新共享内存，保证 SQLite / 共享内存 / 前端状态一致，下一次路由立即生效。
    if result.error.is_none() {
        let _ = state.storage.mark_account_credential_healthy(&account_id);
        if let Ok(mut shared) = state.accounts.lock() {
            if let Some(shared_account) = shared.iter_mut().find(|item| item.id == account_id) {
                shared_account.credential_status =
                    crate::core::config::ACCOUNT_CREDENTIAL_HEALTHY.to_string();
                shared_account.last_error = None;
            }
        }
    }
    if let Some(ref err) = result.error {
        let _ = state.storage.update_account_last_error(&account_id, err);
        if err.contains("HTTP 401") || err.contains("401") {
            let _ = state.storage.mark_account_credential_invalid(&account_id);
            if let Ok(mut shared) = state.accounts.lock() {
                if let Some(shared_account) = shared.iter_mut().find(|item| item.id == account_id) {
                    shared_account.credential_status =
                        crate::core::config::ACCOUNT_CREDENTIAL_INVALID_KEY.to_string();
                    shared_account.last_error = Some(err.clone());
                }
            }
        }
    } else {
        let now = chrono::Utc::now().to_rfc3339();
        let snapshot = AccountBalanceSnapshot {
            id: format!("balance-{}-{}", account_id, uuid::Uuid::new_v4()),
            account_id: account_id.clone(),
            balance: result.balance,
            currency: result.currency.clone(),
            token_pack_total: None,
            token_pack_used: None,
            token_pack_remaining: None,
            token_pack_expire_at: None,
            token_packs: None,
            raw_scraped_json: None,
            source: "sync".to_string(),
            synced_at: Some(now.clone()),
            remark: Some("余额自动同步".to_string()),
            created_at: now.clone(),
            updated_at: now,
        };
        state
            .storage
            .save_balance_snapshot(&snapshot)
            .map_err(|err| err.to_string())?;
        let _ = state.storage.update_account_last_used(&account_id);
    }

    Ok(result)
}

#[tauri::command]
pub(super) async fn sync_models(
    state: tauri::State<'_, AppState>,
    account_id: String,
) -> Result<ModelSyncResult, String> {
    let account = {
        let accounts = state
            .accounts
            .lock()
            .map_err(|_| "读取账号失败".to_string())?;
        accounts
            .iter()
            .find(|a| a.id == account_id)
            .ok_or("账号不存在")?
            .clone()
    };

    let channel_id = account.channel_id.clone();
    let config = state
        .channels_config
        .lock()
        .map_err(|_| "锁定渠道运行时配置失败".to_string())?
        .clone();

    let result = match channel_id.as_str() {
        "deepseek" => tauri::async_runtime::spawn_blocking(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap_or_else(|_| panic!("创建运行时失败"));
            rt.block_on(sync_deepseek_models(&account, &config))
        })
        .await
        .map_err(|e| format!("任务执行失败: {e}"))?,
        "longcat" => tauri::async_runtime::spawn_blocking(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap_or_else(|_| panic!("创建运行时失败"));
            rt.block_on(sync_longcat_models(&account, &config))
        })
        .await
        .map_err(|e| format!("任务执行失败: {e}"))?,
        "kimi" => tauri::async_runtime::spawn_blocking(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap_or_else(|_| panic!("创建运行时失败"));
            rt.block_on(sync_kimi_models(&account, &config))
        })
        .await
        .map_err(|e| format!("任务执行失败: {e}"))?,
        "qwen" => tauri::async_runtime::spawn_blocking(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap_or_else(|_| panic!("创建运行时失败"));
            rt.block_on(sync_qwen_models(&account, &config))
        })
        .await
        .map_err(|e| format!("任务执行失败: {e}"))?,
        _ => {
            return Ok(ModelSyncResult {
                models_synced: 0,
                models: Vec::new(),
                errors: vec![
                    "当前仅 DeepSeek、LongCat、Kimi 和千问 Qwen 支持模型列表同步".to_string(),
                ],
            });
        }
    };

    if result.errors.is_empty() {
        let mut models = state
            .storage
            .list_channel_models()
            .map_err(|err| err.to_string())?
            .into_iter()
            .filter(|model| model.channel_id != channel_id)
            .collect::<Vec<_>>();
        models.extend(result.models.clone());
        state
            .storage
            .save_channel_models(&models)
            .map_err(|err| err.to_string())?;
        let _ = state.storage.update_account_last_used(&account_id);
    } else if let Some(first_err) = result.errors.first() {
        let _ = state
            .storage
            .update_account_last_error(&account_id, first_err);
    }

    Ok(result)
}

// ─── Balance Snapshot Commands ──────────────────────────────────────────────

#[tauri::command]
pub(super) fn save_balance_snapshot(
    state: tauri::State<'_, AppState>,
    snapshot: AccountBalanceSnapshot,
) -> Result<(), String> {
    state
        .storage
        .save_balance_snapshot(&snapshot)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(super) fn list_balance_snapshots(
    state: tauri::State<'_, AppState>,
    account_id: String,
) -> Result<Vec<AccountBalanceSnapshot>, String> {
    state
        .storage
        .list_balance_snapshots(&account_id)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(super) fn latest_balance_snapshots(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<AccountBalanceSnapshot>, String> {
    state
        .storage
        .latest_balance_snapshots()
        .map_err(|err| err.to_string())
}

// ─── Account Stats Commands ────────────────────────────────────────────────

#[tauri::command]
pub(super) fn account_stats(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<AccountStatsRow>, String> {
    state.storage.account_stats().map_err(|err| err.to_string())
}

// ─── Route Rules Commands ──────────────────────────────────────────────────

#[tauri::command]
pub(super) fn list_route_rules(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<RouteRule>, String> {
    state
        .rules
        .lock()
        .map(|rules| rules.clone())
        .map_err(|_| "读取路由规则失败".to_string())
}

#[tauri::command]
pub(super) fn save_route_rules(
    state: tauri::State<'_, AppState>,
    rules: Vec<RouteRule>,
) -> Result<(), String> {
    state
        .storage
        .save_route_rules(&rules)
        .map_err(|err| err.to_string())?;

    let mut current = state
        .rules
        .lock()
        .map_err(|_| "保存路由规则失败".to_string())?;
    *current = rules;
    Ok(())
}

// ─── Maintenance Commands ─────────────────────────────────────────────────

// ─── App Meta (全局配置 KV) ────────────────────────────────────────────────

#[tauri::command]
pub(super) fn read_app_meta(
    state: tauri::State<'_, AppState>,
    key: String,
) -> Result<Option<String>, String> {
    state
        .storage
        .get_app_meta(&key)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(super) fn write_app_meta(
    state: tauri::State<'_, AppState>,
    key: String,
    value: String,
) -> Result<(), String> {
    state
        .storage
        .set_app_meta(&key, &value)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(super) fn db_stats(state: tauri::State<'_, AppState>) -> Result<(i64, i64, i64), String> {
    state.storage.db_stats().map_err(|err| err.to_string())
}

#[tauri::command]
pub(super) async fn storage_usage_summary(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    scan_id: String,
) -> Result<crate::core::storage::StorageUsageSummary, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let config_bytes = std::fs::metadata(&state.config_path)
            .map(|metadata| metadata.len().min(i64::MAX as u64) as i64)
            .unwrap_or(0);
        state
            .storage
            .storage_usage_summary_with_progress(config_bytes, |summary| {
                let _ = app.emit(
                    "storage-usage-progress",
                    StorageUsageProgress {
                        scan_id: scan_id.clone(),
                        summary,
                    },
                );
            })
            .map_err(|err| err.to_string())
    })
    .await
    .map_err(|error| format!("读取存储占用任务失败：{error}"))?
}

#[tauri::command]
pub(super) fn read_config(state: tauri::State<'_, AppState>) -> Result<String, String> {
    let path = &state.config_path;
    crate::core::proxy::read_config_raw(path)
        .ok_or_else(|| "config.json 不存在或读取失败".to_string())
}

#[tauri::command]
pub(super) fn write_config(
    state: tauri::State<'_, AppState>,
    content: String,
) -> Result<(), String> {
    let path = &state.config_path;
    crate::core::proxy::write_config_raw(path, &content)
}

/// 烟雾测试用：验证前端 IPC 能连上后端。返回当前进程环境摘要。
#[tauri::command]
pub(super) fn ipc_ping() -> serde_json::Value {
    tracing::info!(pid = std::process::id(), "ipc_ping received");
    serde_json::json!({
        "ok": true,
        "pid": std::process::id(),
        "exe": std::env::current_exe().ok().map(|p| p.display().to_string()),
    })
}

/// 前端日志落盘。JS 通过这个 Tauri 命令把 console 内容写到同一份文件日志里，
/// 这样 Rust + JS 在 portable 模式下都能集中排查。
#[tauri::command]
pub(super) fn log_from_frontend(level: String, message: String) {
    let target = "flowlet_frontend";
    match level.as_str() {
        "error" => tracing::error!(target, message),
        "warn" => tracing::warn!(target, message),
        "debug" => tracing::debug!(target, message),
        _ => tracing::info!(target, message),
    }
}

#[tauri::command]
pub(super) fn cleanup_old_logs(
    state: tauri::State<'_, AppState>,
    keep_days: i64,
) -> Result<(usize, usize), String> {
    state
        .storage
        .cleanup_old_logs(keep_days)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(super) fn cleanup_expired_body_data(
    state: tauri::State<'_, AppState>,
    retention_days: i64,
) -> Result<usize, String> {
    state
        .storage
        .cleanup_expired_body_data(retention_days)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(super) fn prune_oldest_body_data(
    state: tauri::State<'_, AppState>,
    target_bytes: i64,
    prune_ratio: f64,
) -> Result<usize, String> {
    state
        .storage
        .prune_oldest_body_data(target_bytes, prune_ratio)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(super) fn get_total_body_size_bytes(
    state: tauri::State<'_, AppState>,
) -> Result<i64, String> {
    state
        .storage
        .get_total_body_size_bytes()
        .map_err(|err| err.to_string())
}

// ─── Config Import/Export Commands ────────────────────────────────────────

#[tauri::command]
pub(super) fn export_config(state: tauri::State<'_, AppState>) -> Result<String, String> {
    state.storage.export_config().map_err(|err| err.to_string())
}

#[tauri::command]
pub(super) fn import_config(state: tauri::State<'_, AppState>, json: String) -> Result<(), String> {
    state
        .storage
        .import_config(&json)
        .map_err(|err| err.to_string())?;

    // 重新加载内存状态
    let channels = state
        .storage
        .list_channel_presets()
        .map_err(|e| e.to_string())?;
    let accounts = state
        .storage
        .list_channel_accounts()
        .map_err(|e| e.to_string())?;
    let routes = state
        .storage
        .list_route_candidates()
        .map_err(|e| e.to_string())?;
    let rules = state
        .storage
        .list_route_rules()
        .map_err(|e| e.to_string())?;
    let virtual_models = state
        .storage
        .list_virtual_models()
        .map_err(|e| e.to_string())?;

    *state.channels.lock().map_err(|_| "锁失败".to_string())? = channels;
    *state.accounts.lock().map_err(|_| "锁失败".to_string())? = accounts;
    *state.routes.lock().map_err(|_| "锁失败".to_string())? = routes;
    *state.rules.lock().map_err(|_| "锁失败".to_string())? = rules;
    *state
        .virtual_models
        .lock()
        .map_err(|_| "锁失败".to_string())? = virtual_models;

    Ok(())
}

// ─── Full Data Export/Import Commands ─────────────────────────────────────

const MAX_BACKUP_CONFIG_BYTES: u64 = 16 * 1024 * 1024;
const MAX_BACKUP_DATABASE_BYTES: u64 = 16 * 1024 * 1024 * 1024;

struct TempPathCleanup(std::path::PathBuf);

impl Drop for TempPathCleanup {
    fn drop(&mut self) {
        if self.0.is_dir() {
            let _ = std::fs::remove_dir_all(&self.0);
        } else {
            let _ = std::fs::remove_file(&self.0);
        }
    }
}

#[tauri::command]
pub(super) async fn export_all_data(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    dest_path: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        let dest = std::path::Path::new(&dest_path);

        let _ = app.emit(
            "export-progress",
            ExportProgress {
                stage: "reading_config".into(),
                message: "读取配置文件…".into(),
            },
        );
        let config_content = std::fs::read_to_string(&state.config_path)
            .map_err(|e| format!("读取 config.json 失败: {e}"))?;

        let _ = app.emit(
            "export-progress",
            ExportProgress {
                stage: "backing_up_db".into(),
                message: "备份数据库…".into(),
            },
        );
        let tmp_db =
            std::env::temp_dir().join(format!("flowlet-export-{}.sqlite", uuid::Uuid::new_v4()));
        let _tmp_db_cleanup = TempPathCleanup(tmp_db.clone());
        state
            .storage
            .backup_to_path(&tmp_db)
            .map_err(|e| format!("备份数据库失败: {e}"))?;

        let _ = app.emit(
            "export-progress",
            ExportProgress {
                stage: "compressing".into(),
                message: "正在压缩…".into(),
            },
        );
        let file = std::fs::File::create(dest).map_err(|e| format!("创建备份文件失败: {e}"))?;
        let dest_cleanup = TempPathCleanup(dest.to_path_buf());
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);

        zip.start_file("config.json", options)
            .map_err(|e| format!("压缩 config.json 失败: {e}"))?;
        zip.write_all(config_content.as_bytes())
            .map_err(|e| format!("写入 config.json 到备份失败: {e}"))?;

        zip.start_file("flowlet.sqlite", options)
            .map_err(|e| format!("压缩数据库失败: {e}"))?;
        let mut db_file =
            std::fs::File::open(&tmp_db).map_err(|e| format!("读取备份数据库失败: {e}"))?;
        std::io::copy(&mut db_file, &mut zip).map_err(|e| format!("写入数据库到备份失败: {e}"))?;

        zip.finish().map_err(|e| format!("完成备份失败: {e}"))?;
        std::mem::forget(dest_cleanup);
        let _ = app.emit(
            "export-progress",
            ExportProgress {
                stage: "done".into(),
                message: "导出完成".into(),
            },
        );
        Ok(())
    })
    .await
    .map_err(|e| format!("导出任务失败: {e}"))?
}

#[tauri::command]
pub(super) async fn import_all_data(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    source_path: String,
) -> Result<(), String> {
    let (tmp, new_config_path, new_db_path) =
        tokio::task::spawn_blocking(move || prepare_import_archive(&source_path))
            .await
            .map_err(|e| format!("导入准备失败: {e}"))??;
    let _tmp_cleanup = TempPathCleanup(tmp.clone());

    let was_running = state.proxy.status().running;
    if was_running {
        state
            .proxy
            .stop()
            .await
            .map_err(|e| format!("停止代理失败: {e}"))?;
    }

    let rollback_db = tmp.join("rollback.sqlite");
    let state_clone = state.inner().clone();
    let apply_result = tokio::task::spawn_blocking(move || {
        state_clone
            .storage
            .backup_to_path(&rollback_db)
            .map_err(|e| format!("创建导入前数据库快照失败: {e}"))?;
        let old_config = std::fs::read(&state_clone.config_path)
            .map_err(|e| format!("读取导入前 config.json 失败: {e}"))?;

        let apply = (|| {
            std::fs::copy(&new_config_path, &state_clone.config_path)
                .map_err(|e| format!("替换 config.json 失败: {e}"))?;
            state_clone
                .storage
                .replace_database_from(&new_db_path)
                .map_err(|e| format!("替换数据库失败: {e}"))?;
            reload_state_after_import(&state_clone)
        })();

        if let Err(error) = apply {
            let mut rollback_errors = Vec::new();
            if let Err(rollback_error) = std::fs::write(&state_clone.config_path, &old_config) {
                rollback_errors.push(format!("恢复 config.json 失败: {rollback_error}"));
            }
            if let Err(rollback_error) = state_clone.storage.replace_database_from(&rollback_db) {
                rollback_errors.push(format!("恢复数据库失败: {rollback_error}"));
            }
            if let Err(rollback_error) = reload_state_after_import(&state_clone) {
                rollback_errors.push(format!("恢复运行时状态失败: {rollback_error}"));
            }
            return if rollback_errors.is_empty() {
                Err(format!("{error}；已恢复导入前数据"))
            } else {
                Err(format!(
                    "{error}；回滚不完整：{}",
                    rollback_errors.join("；")
                ))
            };
        }

        Ok::<_, String>(())
    })
    .await
    .map_err(|e| format!("导入替换失败: {e}"))?;

    if let Err(error) = apply_result {
        if was_running {
            if let Err(restart_error) = state.start_configured_proxy().await {
                return Err(format!("{error}；恢复代理失败: {restart_error}"));
            }
            update_tray_tooltip(&app, true);
        }
        return Err(error);
    }

    state.start_configured_proxy().await.map_err(|e| {
        tracing::warn!(error = %e, "数据导入后代理启动失败，请手动启动");
        format!("数据已导入，但代理启动失败: {e}")
    })?;
    update_tray_tooltip(&app, true);
    Ok(())
}

fn prepare_import_archive(
    source_path: &str,
) -> Result<(std::path::PathBuf, std::path::PathBuf, std::path::PathBuf), String> {
    let tmp = std::env::temp_dir().join(format!("flowlet-import-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&tmp).map_err(|e| format!("创建临时目录失败: {e}"))?;
    let cleanup = TempPathCleanup(tmp.clone());

    let file = std::fs::File::open(source_path).map_err(|e| format!("打开备份文件失败: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("读取备份压缩包失败: {e}"))?;

    let new_config_path = tmp.join("config.json");
    extract_backup_entry(
        &mut archive,
        "config.json",
        &new_config_path,
        MAX_BACKUP_CONFIG_BYTES,
    )?;
    let new_db_path = tmp.join("flowlet.sqlite");
    extract_backup_entry(
        &mut archive,
        "flowlet.sqlite",
        &new_db_path,
        MAX_BACKUP_DATABASE_BYTES,
    )?;

    let config_str = std::fs::read_to_string(&new_config_path)
        .map_err(|e| format!("读取备份中的 config.json 失败: {e}"))?;
    let config_value: serde_json::Value = serde_json::from_str(&config_str)
        .map_err(|e| format!("备份中的 config.json 格式无效: {e}"))?;
    if !config_value.is_object() {
        return Err("备份中的 config.json 顶层必须是对象".to_string());
    }
    crate::core::channels_config::ChannelsConfig::from_config_json(&config_value)
        .map_err(|e| format!("备份中的渠道配置无效: {e}"))?;

    validate_import_database(&new_db_path)?;
    std::mem::forget(cleanup);
    Ok((tmp, new_config_path, new_db_path))
}

fn extract_backup_entry(
    archive: &mut zip::ZipArchive<std::fs::File>,
    name: &str,
    destination: &std::path::Path,
    max_bytes: u64,
) -> Result<(), String> {
    let mut entry = archive
        .by_name(name)
        .map_err(|_| format!("备份文件不完整：缺少 {name}"))?;
    if entry.is_dir() || entry.size() > max_bytes {
        return Err(format!("备份条目 {name} 类型或大小无效"));
    }
    let mut output =
        std::fs::File::create(destination).map_err(|e| format!("创建临时文件失败: {e}"))?;
    let copied = std::io::copy(&mut entry.by_ref().take(max_bytes + 1), &mut output)
        .map_err(|e| format!("解压 {name} 失败: {e}"))?;
    if copied > max_bytes {
        return Err(format!("备份条目 {name} 超过大小限制"));
    }
    Ok(())
}

fn validate_import_database(path: &std::path::Path) -> Result<(), String> {
    use rusqlite::OpenFlags;

    let connection = rusqlite::Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("备份中的数据库无法打开: {e}"))?;
    let check: String = connection
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(|e| format!("校验备份数据库失败: {e}"))?;
    if check != "ok" {
        return Err(format!("备份数据库损坏: {check}"));
    }
    for table in ["channel_presets", "channel_accounts", "request_logs"] {
        let exists: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                [table],
                |row| row.get(0),
            )
            .map_err(|e| format!("检查备份数据库结构失败: {e}"))?;
        if exists != 1 {
            return Err(format!("备份数据库结构无效：缺少 {table} 表"));
        }
    }
    Ok(())
}

fn reload_state_after_import(state: &AppState) -> Result<(), String> {
    let channels_config = crate::load_channels_config_from(&state.config_path)?;
    let merged = crate::merge_builtin_config(channels_config);
    state
        .storage
        .ensure_missing_presets(&merged.presets)
        .map_err(|e| e.to_string())?;
    state
        .storage
        .sync_preset_protocol_config(&merged.presets)
        .map_err(|e| e.to_string())?;
    state
        .storage
        .ensure_preset_balance_query(&merged.presets)
        .map_err(|e| e.to_string())?;
    state
        .storage
        .ensure_preset_platform_urls(&merged.presets)
        .map_err(|e| e.to_string())?;

    let channels = state
        .storage
        .list_channel_presets()
        .map_err(|e| e.to_string())?;
    let accounts = state
        .storage
        .list_channel_accounts()
        .map_err(|e| e.to_string())?;
    let routes = state
        .storage
        .list_route_candidates()
        .map_err(|e| e.to_string())?;
    let virtual_models = state
        .storage
        .list_virtual_models()
        .map_err(|e| e.to_string())?;
    let rules = state
        .storage
        .list_route_rules()
        .map_err(|e| e.to_string())?;

    state.storage.set_prices(merged.prices.clone());

    let config_value = crate::core::proxy::read_config_raw(&state.config_path)
        .and_then(|json| serde_json::from_str::<serde_json::Value>(&json).ok())
        .ok_or_else(|| "读取导入后的 config.json 失败".to_string())?;
    let capture = crate::core::proxy::extract_log_capture(&config_value);
    let bind_config = config_value
        .as_object()
        .and_then(|object| object.get("bind"))
        .and_then(|bind| serde_json::from_value::<ProxyBindConfig>(bind.clone()).ok())
        .unwrap_or_else(|| crate::load_bind_config_from_sqlite(&state.storage))
        .normalized();

    *state
        .channels
        .lock()
        .map_err(|_| "锁定渠道状态失败".to_string())? = channels;
    *state
        .accounts
        .lock()
        .map_err(|_| "锁定账号状态失败".to_string())? = accounts;
    *state
        .routes
        .lock()
        .map_err(|_| "锁定路由状态失败".to_string())? = routes;
    *state
        .virtual_models
        .lock()
        .map_err(|_| "锁定虚拟模型状态失败".to_string())? = virtual_models;
    *state
        .rules
        .lock()
        .map_err(|_| "锁定规则状态失败".to_string())? = rules;
    *state
        .capture
        .lock()
        .map_err(|_| "锁定捕获配置失败".to_string())? = capture;
    *state
        .bind_config
        .lock()
        .map_err(|_| "锁定绑定配置失败".to_string())? = bind_config.clone();
    *state
        .proxy
        .bind_config
        .lock()
        .map_err(|_| "锁定代理绑定配置失败".to_string())? = bind_config;
    *state
        .channels_config
        .lock()
        .map_err(|_| "锁定渠道运行时配置失败".to_string())? = merged;

    Ok(())
}

// ─── Smart Routing Commands ───────────────────────────────────────────────

#[tauri::command]
pub(super) fn account_routing_scores(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<(String, String, f64, f64, f64)>, String> {
    state
        .storage
        .account_routing_scores()
        .map_err(|err| err.to_string())
}

// ─── Auto-start Commands ───────────────────────────────────────────────────

#[tauri::command]
pub(super) fn is_autostart_enabled(app: AppHandle) -> Result<bool, String> {
    let autostart = app.autolaunch();
    autostart
        .is_enabled()
        .map_err(|e| format!("检查自启动状态失败: {e}"))
}

#[tauri::command]
pub(super) fn enable_autostart(app: AppHandle) -> Result<(), String> {
    let autostart = app.autolaunch();
    autostart
        .enable()
        .map_err(|e| format!("启用自启动失败: {e}"))
}

#[tauri::command]
pub(super) fn disable_autostart(app: AppHandle) -> Result<(), String> {
    let autostart = app.autolaunch();
    autostart
        .disable()
        .map_err(|e| format!("禁用自启动失败: {e}"))
}

#[cfg(test)]
mod data_import_export_tests {
    use super::*;
    use crate::core::channels_config::DEFAULT_CONFIG_JSON;
    use crate::core::storage::Storage;

    fn create_backup(include_escape_entry: Option<&str>) -> std::path::PathBuf {
        let id = uuid::Uuid::new_v4();
        let db_path = std::env::temp_dir().join(format!("flowlet-backup-test-{id}.sqlite"));
        let backup_path = std::env::temp_dir().join(format!("flowlet-backup-test-{id}.flowlet"));
        let storage = Storage::open(&db_path).unwrap();
        let snapshot_path =
            std::env::temp_dir().join(format!("flowlet-backup-snapshot-{id}.sqlite"));
        storage.backup_to_path(&snapshot_path).unwrap();
        drop(storage);

        let file = std::fs::File::create(&backup_path).unwrap();
        let mut archive = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        archive.start_file("config.json", options).unwrap();
        archive.write_all(DEFAULT_CONFIG_JSON.as_bytes()).unwrap();
        archive.start_file("flowlet.sqlite", options).unwrap();
        archive
            .write_all(&std::fs::read(&snapshot_path).unwrap())
            .unwrap();
        if let Some(name) = include_escape_entry {
            archive.start_file(name, options).unwrap();
            archive.write_all(b"escape").unwrap();
        }
        archive.finish().unwrap();
        for path in [&db_path, &snapshot_path] {
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{}", path.display(), suffix));
            }
        }
        backup_path
    }

    #[test]
    fn import_archive_ignores_non_backup_entries_without_path_traversal() {
        let escape_name = format!("flowlet-import-escape-{}.txt", uuid::Uuid::new_v4());
        let escape_path = std::env::temp_dir().join(&escape_name);
        let archive_path = create_backup(Some(&format!("../{escape_name}")));

        let (tmp, config_path, db_path) =
            prepare_import_archive(archive_path.to_str().unwrap()).unwrap();
        assert!(config_path.starts_with(&tmp));
        assert!(db_path.starts_with(&tmp));
        assert!(!escape_path.exists());

        let _ = std::fs::remove_dir_all(tmp);
        let _ = std::fs::remove_file(archive_path);
    }

    #[test]
    fn import_archive_rejects_database_without_flowlet_schema() {
        let id = uuid::Uuid::new_v4();
        let empty_db = std::env::temp_dir().join(format!("flowlet-empty-{id}.sqlite"));
        rusqlite::Connection::open(&empty_db)
            .unwrap()
            .close()
            .unwrap();
        let archive_path = std::env::temp_dir().join(format!("flowlet-empty-{id}.flowlet"));
        let file = std::fs::File::create(&archive_path).unwrap();
        let mut archive = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        archive.start_file("config.json", options).unwrap();
        archive.write_all(DEFAULT_CONFIG_JSON.as_bytes()).unwrap();
        archive.start_file("flowlet.sqlite", options).unwrap();
        archive
            .write_all(&std::fs::read(&empty_db).unwrap())
            .unwrap();
        archive.finish().unwrap();

        let error = prepare_import_archive(archive_path.to_str().unwrap()).unwrap_err();
        assert!(error.contains("缺少 channel_presets 表"));
        let _ = std::fs::remove_file(empty_db);
        let _ = std::fs::remove_file(archive_path);
    }
}

// ─── Scrape Console Commands ────────────────────────────────────────────────
// 后台 webview 登录控制台 + 拦截 API 抓取套餐余量。

use crate::core::scrape_console::{
    self, build_scrape_webview, classify_response_url, resolve_scrape_mode,
};

/// 抓取结果(前端展示用)。
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrapeBalanceResult {
    pub balance: Option<f64>,
    pub currency: Option<String>,
    pub plan_name: Option<String>,
    pub token_total: Option<i64>,
    pub token_used: Option<i64>,
    pub token_remaining: Option<i64>,
    pub token_pack_expire_at: Option<String>,
    pub raw_scraped_json: Option<String>,
    pub source: String,
    pub synced_at: String,
}

/// 登录态探测结果。
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrapeLoginStatus {
    pub is_logged_in: bool,
    pub channel_id: String,
    /// 登录后的账户标识(如有,用于 UI 展示)。
    pub account_hint: Option<String>,
}

/// 创建 per-account 后台抓取 webview(隐藏)。
#[tauri::command]
pub(super) async fn open_scrape_console(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    account_id: String,
) -> Result<(), String> {
    // 已存在则直接返回
    {
        let guard = state
            .scrape_webviews
            .lock()
            .map_err(|_| "锁定抓取 webview 失败".to_string())?;
        if guard.contains_key(&account_id) {
            return Ok(());
        }
    }

    let mode = {
        let accounts = state
            .accounts
            .lock()
            .map_err(|_| "读取账号失败".to_string())?;
        let account = accounts
            .iter()
            .find(|a| a.id == account_id)
            .ok_or("账号不存在")?;
        let config = state
            .channels_config
            .lock()
            .map_err(|_| "锁定渠道配置失败".to_string())?;
        resolve_scrape_mode(&config, &account.channel_id, account.resource_mode.as_deref())
            .ok_or("该账号所属渠道不支持控制台抓取")?
    };

    let window = build_scrape_webview(&app, &account_id, &mode)?;

    let mut guard = state
        .scrape_webviews
        .lock()
        .map_err(|_| "锁定抓取 webview 失败".to_string())?;
    guard.insert(account_id, window);
    Ok(())
}

/// 关闭并 drop per-account 抓取 webview。
#[tauri::command]
pub(super) async fn close_scrape_console(
    state: tauri::State<'_, AppState>,
    account_id: String,
) -> Result<(), String> {
    let mut guard = state
        .scrape_webviews
        .lock()
        .map_err(|_| "锁定抓取 webview 失败".to_string())?;
    if let Some(window) = guard.remove(&account_id) {
        let _ = window.close();
    }
    Ok(())
}

/// 页面 JS 通过 IPC 回传拦截到的响应体。
#[tauri::command]
pub(super) async fn handle_intercepted_response(
    state: tauri::State<'_, AppState>,
    channel_id: String,
    url: String,
    body: String,
) -> Result<(), String> {
    let mut guard = state
        .scrape_pending
        .lock()
        .map_err(|_| "锁定抓取缓冲失败".to_string())?;
    let entry = guard.entry(channel_id).or_default();
    // 按 URL 分类去重:同类型响应只保留最新
    let kind = classify_response_url(&url);
    entry.retain(|(u, _)| classify_response_url(u) != kind);
    entry.push((url, body));
    Ok(())
}

/// 登录态探测脚本:在目标控制台域上发一次 account-info 请求,解析响应判断是否已登录。
/// 已登录 → 返回 is_logged_in=true;未登录/跳转登录页 → is_logged_in=false。
///
/// 注意:必须用 .then() 链而非 async/await。eval_with_callback 的回调拿到的是脚本
/// 的返回值,async 函数返回 Promise,而 JSON.stringify(Promise) = "{}",导致解析失败。
fn probe_login_script(channel_id: &str) -> &'static str {
    match channel_id {
        // LongCat:/api/v1/user-current → code===0 && data.loginStatus===1
        "longcat" => r#"(function(){
          return fetch('/api/v1/user-current', { credentials: 'include', headers: { 'x-requested-with': 'XMLHttpRequest' } })
            .then((res) => {
              if (!res.ok) return JSON.stringify({ isLoggedIn: false });
              return res.json().then((j) => {
                const ok = j?.code === 0 && j?.data?.loginStatus === 1;
                return JSON.stringify({ isLoggedIn: ok, accountHint: j?.data?.name ?? null });
              });
            })
            .catch((e) => JSON.stringify({ isLoggedIn: false, error: String(e) }));
        })()"#,
        // Qwen:platform-home.qianwenai.com/api/account/info.json → code==="200" && data.currentId
        "qwen" => r#"(function(){
          return fetch('https://platform-home.qianwenai.com/api/account/info.json', { credentials: 'include' })
            .then((res) => {
              if (!res.ok) return JSON.stringify({ isLoggedIn: false });
              return res.json().then((j) => {
                const ok = j?.code === '200' && j?.data?.currentId;
                return JSON.stringify({ isLoggedIn: ok, accountHint: j?.data?.aliyunId ?? null });
              });
            })
            .catch((e) => JSON.stringify({ isLoggedIn: false, error: String(e) }));
        })()"#,
        _ => r#"(function(){ return Promise.resolve(JSON.stringify({ isLoggedIn: false, error: 'unsupported-channel' })); })()"#,
    }
}

/// 探测当前 webview 是否已登录控制台。
/// 流程:确保 webview 存在 → 导航到控制台 URL → 等页面加载 → eval 探测脚本 → 返回登录态。
#[tauri::command]
pub(super) async fn probe_scrape_login(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    account_id: String,
) -> Result<ScrapeLoginStatus, String> {
    // 1. 确保 webview 存在(会解析 channel_id)
    open_scrape_console(app.clone(), state.clone(), account_id.clone()).await?;

    let (channel_id, console_url) = {
        let accounts = state
            .accounts
            .lock()
            .map_err(|_| "读取账号失败".to_string())?;
        let account = accounts
            .iter()
            .find(|a| a.id == account_id)
            .ok_or("账号不存在")?;
        let config = state
            .channels_config
            .lock()
            .map_err(|_| "锁定渠道配置失败".to_string())?;
        let mode = resolve_scrape_mode(&config, &account.channel_id, account.resource_mode.as_deref())
            .ok_or("该账号所属渠道不支持控制台抓取")?;
        (account.channel_id.clone(), mode.console_url.clone())
    };

    // 2. 导航到控制台 URL
    {
        let guard = state
            .scrape_webviews
            .lock()
            .map_err(|_| "锁定抓取 webview 失败".to_string())?;
        let window = guard
            .get(&account_id)
            .ok_or("抓取 webview 不存在")?;
        let url = console_url
            .parse()
            .map_err(|e| format!("URL 解析失败: {e}"))?;
        window
            .navigate(url)
            .map_err(|e| format!("导航失败: {e}"))?;
    }

    // 3. eval 探测脚本(页面加载后 fetch 当前用户接口)
    let probe_js = probe_login_script(&channel_id);
    let raw_result = {
        let (tx, rx) = tokio::sync::oneshot::channel::<String>();
        {
            let guard = state
                .scrape_webviews
                .lock()
                .map_err(|_| "锁定抓取 webview 失败".to_string())?;
            let window = guard
                .get(&account_id)
                .ok_or("抓取 webview 不存在")?;
            let tx_cell = std::cell::Cell::new(Some(tx));
            let _ = window.eval_with_callback(probe_js, move |s| {
                if let Some(tx) = tx_cell.take() {
                    let _ = tx.send(s);
                }
            });
        }
        // 探测超时 15s(含页面加载 + fetch)
        match tokio::time::timeout(std::time::Duration::from_secs(15), rx).await {
            Ok(Ok(s)) => s,
            Ok(Err(_)) => return Err("探测回调通道关闭".to_string()),
            Err(_) => return Err("登录态探测超时".to_string()),
        }
    };

    // 4. 解析探测结果
    #[derive(serde::Deserialize)]
    struct ProbeResp {
        #[serde(rename = "isLoggedIn")]
        is_logged_in: bool,
        #[serde(rename = "accountHint")]
        account_hint: Option<String>,
    }
    let parsed: ProbeResp = serde_json::from_str(&raw_result)
        .map_err(|e| format!("探测输出解析失败: {e}, raw={raw_result}"))?;

    let status = ScrapeLoginStatus {
        is_logged_in: parsed.is_logged_in,
        channel_id,
        account_hint: parsed.account_hint,
    };

    // 未登录 → 把 webview 移到可见区域,让用户登录
    if !status.is_logged_in {
        surface_scrape_webview(&state, &account_id)?;
    }

    Ok(status)
}

/// 把抓取 webview 移到可见区域(用于未登录时让用户登录)。
fn surface_scrape_webview(
    state: &tauri::State<'_, AppState>,
    account_id: &str,
) -> Result<(), String> {
    let guard = state
        .scrape_webviews
        .lock()
        .map_err(|_| "锁定抓取 webview 失败".to_string())?;
    let window = guard.get(account_id).ok_or("抓取 webview 不存在")?;
    window
        .set_size(tauri::LogicalSize::new(1024.0, 768.0))
        .map_err(|e| format!("设置窗口大小失败: {e}"))?;
    window
        .set_position(tauri::LogicalPosition::new(100.0, 100.0))
        .map_err(|e| format!("设置窗口位置失败: {e}"))?;
    window.show().map_err(|e| format!("显示窗口失败: {e}"))?;
    window
        .set_focus()
        .map_err(|e| format!("聚焦窗口失败: {e}"))?;
    Ok(())
}

/// 编排器:抓取余额的主入口(前端按钮调用)。
/// 流程:探测登录态 → 未登录则弹出 webview 并提前返回;已登录则继续拦截+提取。
/// 注意:前端在调 scrape_balance 之前应先调 probe_scrape_login 显式处理登录态;
/// 这里的探测是防御性二次检查(防直连调用),未登录时只返回错误,不再发事件(避免与前端事件监听竞态)。
#[tauri::command]
pub(super) async fn scrape_balance(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    account_id: String,
) -> Result<ScrapeBalanceResult, String> {
    // 1. 探测登录态(内部会确保 webview 存在 + 导航 + eval 探测脚本)
    let login_status = probe_scrape_login(app.clone(), state.clone(), account_id.clone()).await?;
    if !login_status.is_logged_in {
        // 未登录:probe_scrape_login 已经把 webview 移到可见区域,直接返回错误
        return Err("请先登录官方控制台(已弹出登录窗口)".to_string());
    }

    // 2. 解析模式配置
    let mode = {
        let accounts = state
            .accounts
            .lock()
            .map_err(|_| "读取账号失败".to_string())?;
        let account = accounts
            .iter()
            .find(|a| a.id == account_id)
            .ok_or("账号不存在")?;
        let config = state
            .channels_config
            .lock()
            .map_err(|_| "锁定渠道配置失败".to_string())?;
        resolve_scrape_mode(&config, &account.channel_id, account.resource_mode.as_deref())
            .ok_or("该账号所属渠道不支持控制台抓取")?
    };

    // 3. 清空该账号旧的待处理缓冲
    {
        let mut guard = state
            .scrape_pending
            .lock()
            .map_err(|_| "锁定抓取缓冲失败".to_string())?;
        guard.remove(&account_id);
    }

    // 4. 导航到控制台 URL(触发页面自发调 API)
    {
        let guard = state
            .scrape_webviews
            .lock()
            .map_err(|_| "锁定抓取 webview 失败".to_string())?;
        let window = guard
            .get(&account_id)
            .ok_or("抓取 webview 不存在")?;
        let url = mode
            .console_url
            .parse()
            .map_err(|e| format!("URL 解析失败: {e}"))?;
        window
            .navigate(url)
            .map_err(|e| format!("导航失败: {e}"))?;
    }

    // 5. 收集窗口:等待拦截响应到位(简单轮询,5s 窗口)
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let slots = loop {
        let now = std::time::Instant::now();
        if now >= deadline {
            break None;
        }
        {
            let guard = state
                .scrape_pending
                .lock()
                .map_err(|_| "锁定抓取缓冲失败".to_string())?;
            if let Some(pending) = guard.get(&account_id) {
                let mut map = std::collections::HashMap::new();
                for (url, body) in pending {
                    map.insert(classify_response_url(url).to_string(), body.clone());
                }
                if scrape_console::aggregate_complete(&map, &mode) {
                    break Some(map);
                }
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    };

    let slots = slots.ok_or("抓取超时:未收到目标 API 响应,请确认已登录或重试")?;

    // 6. 执行 extractor
    let extractor_call = if mode.aggregate {
        let bundle = scrape_console::build_aggregate_bundle(&slots);
        format!(
            "(function(){{ try {{ return JSON.stringify(({})({})); }} catch(e) {{ return JSON.stringify({{error:String(e)}}); }} }})()",
            mode.extractor_js, bundle
        )
    } else {
        // 单响应模式:取唯一目标槽
        let target_key = if mode.console_url.contains("tab=api") {
            "api_usage_summary"
        } else {
            "token_packs_summary"
        };
        let raw = slots
            .get(target_key)
            .ok_or("未找到目标响应")?;
        format!(
            "(function(){{ try {{ return JSON.stringify(({})({})); }} catch(e) {{ return JSON.stringify({{error:String(e)}}); }} }})()",
            mode.extractor_js, raw
        )
    };

    let raw_result = {
        // window 引用需要限制在 await 之前,否则 MutexGuard 跨 await 导致 !Send
        let extractor_call_clone = extractor_call.clone();
        let (tx, rx) = tokio::sync::oneshot::channel::<String>();
        {
            let guard = state
                .scrape_webviews
                .lock()
                .map_err(|_| "锁定抓取 webview 失败".to_string())?;
            let window = guard
                .get(&account_id)
                .ok_or("抓取 webview 不存在")?;
            // eval_with_callback 的回调是 Fn(不是 FnOnce),用 Cell 绕过 move 限制
            let tx_cell = std::cell::Cell::new(Some(tx));
            let _ = window.eval_with_callback(extractor_call_clone, move |s| {
                if let Some(tx) = tx_cell.take() {
                    let _ = tx.send(s);
                }
            });
        } // guard 在这里 drop
        // 等待回调,超时 10s
        match tokio::time::timeout(std::time::Duration::from_secs(10), rx).await {
            Ok(Ok(s)) => s,
            Ok(Err(_)) => return Err("extractor 回调通道关闭".to_string()),
            Err(_) => return Err("extractor 执行超时".to_string()),
        }
    };

    // 7. 解析 extractor 输出
    let parsed: serde_json::Value = serde_json::from_str(&raw_result)
        .map_err(|e| format!("extractor 输出解析失败: {e}, raw={raw_result}"))?;
    if let Some(err) = parsed.get("error").and_then(|v| v.as_str()) {
        return Err(format!("extractor 执行错误: {err}"));
    }
    if parsed.is_null() || parsed == serde_json::Value::Null {
        return Err("extractor 返回空结果,请确认页面已加载目标数据".to_string());
    }

    let balance = parsed.get("balance").and_then(|v| v.as_f64());
    let currency = parsed
        .get("currency")
        .and_then(|v| v.as_str())
        .map(String::from);
    let plan_name = parsed
        .get("plan_name")
        .and_then(|v| v.as_str())
        .map(String::from);
    let token_total = parsed.get("token_total").and_then(|v| v.as_i64());
    let token_used = parsed.get("token_used").and_then(|v| v.as_i64());
    let token_remaining = parsed.get("token_remaining").and_then(|v| v.as_i64());
    let token_pack_expire_at = parsed
        .get("token_expire_at")
        .and_then(|v| v.as_str())
        .map(String::from);

    let now = chrono::Utc::now().to_rfc3339();
    let raw_scraped_json = serde_json::to_string(&parsed).ok();

    // 8. 写快照
    let snapshot = AccountBalanceSnapshot {
        id: format!("balance-{}-{}", account_id, uuid::Uuid::new_v4()),
        account_id: account_id.clone(),
        balance,
        currency: currency.clone(),
        token_pack_total: token_total,
        token_pack_used: token_used,
        token_pack_remaining: token_remaining,
        token_pack_expire_at: token_pack_expire_at.clone(),
        token_packs: None,
        raw_scraped_json: raw_scraped_json.clone(),
        source: "scrape".to_string(),
        synced_at: Some(now.clone()),
        remark: Some("控制台抓取".to_string()),
        created_at: now.clone(),
        updated_at: now.clone(),
    };
    state
        .storage
        .save_balance_snapshot(&snapshot)
        .map_err(|e| format!("保存余额快照失败: {e}"))?;

    // 9. 发事件通知前端
    let result = ScrapeBalanceResult {
        balance,
        currency,
        plan_name,
        token_total,
        token_used,
        token_remaining,
        token_pack_expire_at: token_pack_expire_at.clone(),
        raw_scraped_json,
        source: "scrape".to_string(),
        synced_at: now,
    };
    let _ = app.emit("scrape:result", &result);

    // 10. 隐藏 webview(保活供下次抓取)
    {
        let guard = state
            .scrape_webviews
            .lock()
            .map_err(|_| "锁定抓取 webview 失败".to_string())?;
        if let Some(window) = guard.get(&account_id) {
            let _ = window.hide();
        }
    }

    Ok(result)
}
