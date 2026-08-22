use crate::AppState;

#[tauri::command]
pub(crate) fn list_agent_capabilities(
) -> Result<crate::core::agent_plugin_bundle::AgentCapabilitiesReport, String> {
    Ok(crate::core::agent_plugin_bundle::capabilities())
}

// Claude Code 走 Anthropic-compatible 端点，其余已支持一键接入的 Agent
// （OpenCode、Pi）走 OpenAI-compatible 端点。
fn agent_endpoint_suffix(agent_id: &str) -> Result<&'static str, String> {
    crate::core::plugin_registry::plugin_registry()
        .agent(agent_id)
        .map(|agent| agent.endpoint_suffix.as_str())
        .ok_or_else(|| format!("未注册的 Agent 插件：{agent_id}"))
}

fn agent_global_config_adapter(agent_id: &str) -> Result<&'static str, String> {
    crate::core::plugin_registry::plugin_registry()
        .agent(agent_id)
        .map(|agent| agent.global_config_adapter_id.as_str())
        .ok_or_else(|| format!("未注册的 Agent 插件：{agent_id}"))
}

#[tauri::command]
pub(crate) async fn detect_agent_environment(
    state: tauri::State<'_, AppState>,
    agent_id: String,
) -> Result<crate::core::agent_environment::AgentEnvironmentReport, String> {
    let mut report = crate::core::agent_environment::detect_agent_environment(&agent_id).await?;
    state
        .agent_runtimes
        .enrich_report(&agent_id, &mut report)
        .await;
    Ok(report)
}

#[tauri::command]
pub(crate) async fn start_agent_runtime(
    state: tauri::State<'_, AppState>,
    agent_id: String,
) -> Result<crate::core::agent_environment::AgentEnvironmentReport, String> {
    state.agent_runtimes.start(&agent_id).await
}

#[tauri::command]
pub(crate) async fn stop_agent_runtime(
    state: tauri::State<'_, AppState>,
    agent_id: String,
) -> Result<crate::core::agent_environment::AgentEnvironmentReport, String> {
    state.agent_runtimes.stop(&agent_id).await
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
    let lease = match state
        .jobs
        .try_acquire_definition(&crate::core::job_runtime::CODEX_ACCOUNT_SYNC)
    {
        Ok(lease) => lease,
        Err(_) => {
            return Ok(crate::core::codex_account::CodexAccountSyncResult {
                started: false,
                job_id: None,
                accounts: 0,
                stale: 0,
                failed: 0,
                message: "已有 Codex 账号同步正在运行".to_string(),
            });
        }
    };
    let codex_home = crate::core::codex_account::codex_home();
    crate::core::codex_account::sync_codex_accounts(
        &state.storage,
        &state.codex_accounts_dir,
        &codex_home,
        &trigger_source,
        |job_id| lease.attach_job_id(job_id),
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

/// 删除单个 Codex 账号的 Flowlet 托管配置（凭据副本与观测快照）。
/// 不触碰 Codex 客户端自身登录状态；若该账号仍是 Codex 当前登录账号，
/// 下一次同步会自动重新发现它。
#[tauri::command]
pub(crate) fn delete_codex_account(
    state: tauri::State<'_, AppState>,
    account_id: String,
) -> Result<crate::core::codex_account::CodexAccountDeletionResult, String> {
    crate::core::codex_account::delete_codex_account(&state.codex_accounts_dir, &account_id)
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
    let suffix = agent_endpoint_suffix(&agent_id)?;
    let adapter_id = agent_global_config_adapter(&agent_id)?;
    let mut report = crate::core::agent_global_config::inspect_agent_global_config(
        adapter_id,
        &format!("http://127.0.0.1:{}{suffix}", bind.port),
    )?;
    report.agent_id = agent_id;
    Ok(report)
}

#[tauri::command]
pub(crate) async fn apply_agent_global_config(
    state: tauri::State<'_, AppState>,
    agent_id: String,
    mut options: Option<crate::core::agent_global_config::AgentGlobalConfigOptions>,
) -> Result<crate::core::agent_global_config::AgentGlobalConfigReport, String> {
    let bind = state
        .bind_config
        .lock()
        .map_err(|_| "读取 Flowlet 客户端配置失败".to_string())?
        .clone()
        .normalized();
    let suffix = agent_endpoint_suffix(&agent_id)?;
    let adapter_id = agent_global_config_adapter(&agent_id)?;
    let expected_base_url = format!("http://127.0.0.1:{}{suffix}", bind.port);
    let client_token = bind.default_client_token;
    if adapter_id == "deepseek-harness"
        && options
            .as_ref()
            .and_then(|value| value.model_specs)
            .unwrap_or(false)
    {
        let modalities = crate::core::model_input_capabilities::deepseek_harness_model_inputs(
            &state.runtime_config.snapshot(),
        );
        options
            .get_or_insert_with(Default::default)
            .model_input_modalities = Some(modalities);
    }
    let mut report = tauri::async_runtime::spawn_blocking(move || {
        crate::core::agent_global_config::apply_agent_global_config(
            adapter_id,
            &expected_base_url,
            &client_token,
            options.as_ref(),
        )
    })
    .await
    .map_err(|error| format!("等待 Agent 全局配置写入失败：{error}"))??;
    report.agent_id = agent_id;
    Ok(report)
}

#[tauri::command]
pub(crate) async fn restore_agent_global_config(
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
    let suffix = agent_endpoint_suffix(&agent_id)?;
    let adapter_id = agent_global_config_adapter(&agent_id)?;
    let expected_base_url = format!("http://127.0.0.1:{port}{suffix}");
    let mut report = tauri::async_runtime::spawn_blocking(move || {
        crate::core::agent_global_config::restore_agent_global_config(
            adapter_id,
            &expected_base_url,
        )
    })
    .await
    .map_err(|error| format!("等待 Agent 全局配置恢复失败：{error}"))??;
    report.agent_id = agent_id;
    Ok(report)
}
