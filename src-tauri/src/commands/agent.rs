use crate::AppState;
use std::sync::atomic::{AtomicBool, Ordering};

static CODEX_ACCOUNT_SYNC_RUNNING: AtomicBool = AtomicBool::new(false);

struct CodexAccountSyncGuard;

impl Drop for CodexAccountSyncGuard {
    fn drop(&mut self) {
        CODEX_ACCOUNT_SYNC_RUNNING.store(false, Ordering::Release);
    }
}

// Claude Code 走 Anthropic-compatible 端点，其余已支持一键接入的 Agent
// （OpenCode、Pi）走 OpenAI-compatible 端点。
fn agent_endpoint_suffix(agent_id: &str) -> &'static str {
    match agent_id {
        "claude-code" => "/anthropic",
        _ => "/v1",
    }
}

#[tauri::command]
pub(crate) async fn detect_agent_environment(
    agent_id: String,
) -> Result<crate::core::agent_environment::AgentEnvironmentReport, String> {
    crate::core::agent_environment::detect_agent_environment(&agent_id).await
}

/// 检查所有受支持 Agent 的最新发布版本（npm registry），用于版本更新提示。
#[tauri::command]
pub(crate) async fn check_agent_latest_versions(
) -> Result<crate::core::agent_version::AgentLatestVersionsReport, String> {
    crate::core::agent_version::check_agent_latest_versions().await
}

#[tauri::command]
pub(crate) async fn query_codex_accounts(
    state: tauri::State<'_, AppState>,
) -> Result<crate::core::codex_account::CodexAccountsReport, String> {
    crate::core::codex_account::query_codex_accounts(&state.codex_accounts_dir).await
}

#[tauri::command]
pub(crate) fn list_cached_codex_accounts(
    state: tauri::State<'_, AppState>,
) -> Result<crate::core::codex_account::CodexAccountsReport, String> {
    crate::core::codex_account::list_cached_codex_accounts(&state.codex_accounts_dir)
}

#[tauri::command]
pub(crate) async fn sync_codex_accounts(
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
pub(crate) async fn authorize_codex_account(
    state: tauri::State<'_, AppState>,
) -> Result<crate::core::codex_account::CodexAccountReport, String> {
    crate::core::codex_account::authorize_codex_account(&state.codex_accounts_dir, |auth_url| {
        tauri_plugin_opener::open_url(auth_url, None::<&str>)
            .map_err(|error| format!("无法打开 Codex 账号授权页面：{error}"))
    })
    .await
}

/// 刷新单个 Codex 账号的用量（不触碰其他账号）。
#[tauri::command]
pub(crate) async fn query_codex_account(
    state: tauri::State<'_, AppState>,
    account_id: String,
) -> Result<crate::core::codex_account::CodexAccountReport, String> {
    crate::core::codex_account::query_codex_account(&state.codex_accounts_dir, &account_id).await
}

#[tauri::command]
pub(crate) fn inspect_agent_global_config(
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
pub(crate) fn apply_agent_global_config(
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
pub(crate) fn restore_agent_global_config(
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
