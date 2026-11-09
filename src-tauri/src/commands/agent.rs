use crate::core::config::{ProtocolType, ACCOUNT_CREDENTIAL_HEALTHY};
use crate::core::model_catalog::model_catalog;
use crate::core::runtime_config::RuntimeConfigSnapshot;
use crate::AppState;
use std::collections::BTreeSet;

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

/// Agent 全局配置实际使用的协议。全局配置写入的 Base URL 由插件注册表的
/// `endpointSuffix` 决定：Claude Code 走 `/anthropic`，Codex 走 Responses，
/// 其余四个 Agent 走 `/v1`（OpenAI-compatible）。默认模型必须在该协议下有可用路由，
/// 否则客户端即使写入了配置也发不出请求。
fn agent_protocols(adapter_id: &str) -> &'static [ProtocolType] {
    match adapter_id {
        "claude-code" => &[ProtocolType::Anthropic],
        "codex" => &[ProtocolType::Responses],
        _ => &[ProtocolType::OpenAi],
    }
}

/// 当前 Agent 协议下可用的规范模型 ID，按字典序返回。
///
/// 「可用」= 路由已启用 + 账号启用且凭据健康 + 渠道启用且支持该协议；与代理真实
/// 选路使用同一组事实，避免接入抽屉里选到实际发不出请求的模型。
fn available_agent_models(
    snapshot: &RuntimeConfigSnapshot,
    protocols: &[ProtocolType],
) -> Vec<String> {
    let mut models = BTreeSet::new();
    for route in &snapshot.routes {
        if !route.enabled || !protocols.contains(&route.client_protocol) {
            continue;
        }
        // 目录里不存在的模型（例如升级前的聚合模型旧路由）不参与可用性判断。
        let Some(identity) = model_catalog().find(&route.virtual_model_id) else {
            continue;
        };
        let account_usable = snapshot.accounts.iter().any(|account| {
            account.id == route.account_id
                && account.enabled
                && !account.api_key.trim().is_empty()
                && account.credential_status == ACCOUNT_CREDENTIAL_HEALTHY
        });
        if !account_usable {
            continue;
        }
        let channel_usable = snapshot.channels.iter().any(|channel| {
            channel.id == route.channel_id
                && channel.enabled
                && channel.supported_protocols.contains(&route.client_protocol)
        });
        if channel_usable {
            models.insert(identity.id.clone());
        }
    }
    models.into_iter().collect()
}

/// 解析单个模型的最终取值：用户传了就必须是已知模型，否则按字典序取第一个可用模型。
fn resolve_requested_model(
    requested: Option<&str>,
    available: &[String],
) -> Result<String, String> {
    if let Some(requested) = requested.map(str::trim).filter(|value| !value.is_empty()) {
        return crate::core::agent_global_config::canonical_known_model(requested);
    }
    available.first().cloned().ok_or_else(|| {
        "没有可用的开放模型：请先在模型服务页为当前 Agent 协议开放模型，并确保账号可用".to_string()
    })
}

/// 解析快速模型：显式传值时校验并归一到规范模型 ID，缺省时回退到已解析的主模型
/// （而不是再取「第一个可用模型」），与接入抽屉「快速模型默认等于主模型」一致。
fn resolve_fast_model(requested: Option<&str>, primary_model: &str) -> Result<String, String> {
    match requested.map(str::trim).filter(|value| !value.is_empty()) {
        Some(fast) => crate::core::agent_global_config::canonical_known_model(fast),
        None => Ok(primary_model.to_string()),
    }
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
    options: Option<crate::core::agent_global_config::AgentGlobalConfigOptions>,
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
    // 默认模型由用户在接入抽屉中显式选择；未选择时按当前协议的可用模型字典序补齐。
    // 任何非法模型都在写文件之前被拒绝，避免把不存在的模型写进客户端配置。
    let snapshot = state.runtime_config.snapshot();
    let available = available_agent_models(&snapshot, agent_protocols(adapter_id));
    let primary_model = resolve_requested_model(
        options
            .as_ref()
            .and_then(|value| value.primary_model.as_deref()),
        &available,
    )?;
    let fast_model = resolve_fast_model(
        options
            .as_ref()
            .and_then(|value| value.fast_model.as_deref()),
        &primary_model,
    )?;
    let mut options = options.unwrap_or_default();
    options.primary_model = Some(primary_model);
    options.fast_model = Some(fast_model);
    let options = Some(options);
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

#[tauri::command]
pub(crate) async fn query_antigravity_accounts(
    state: tauri::State<'_, AppState>,
) -> Result<crate::core::antigravity_account::AntigravityAccountsReport, String> {
    let root = state
        .codex_accounts_dir
        .with_file_name("antigravity-accounts");
    let (remote, local) = tokio::join!(
        crate::core::antigravity_oauth::query_accounts(&root),
        crate::core::antigravity_account::query_antigravity_accounts(),
    );
    // Saved OAuth accounts remain authoritative even if another local account is active.
    let mut report = remote?;
    let local = match local {
        Ok(local) => local,
        Err(error) if report.accounts.is_empty() => return Err(error),
        Err(_) => crate::core::antigravity_account::AntigravityAccountsReport {
            accounts: Vec::new(),
        },
    };
    {
        for account in local.accounts {
            if !report.accounts.iter().any(|saved| {
                saved
                    .email
                    .as_ref()
                    .zip(account.email.as_ref())
                    .is_some_and(|(a, b)| a.eq_ignore_ascii_case(b))
            }) {
                report.accounts.push(account);
            }
        }
    }
    Ok(report)
}

#[tauri::command]
pub(crate) async fn authorize_antigravity_account(
    state: tauri::State<'_, AppState>,
) -> Result<crate::core::antigravity_account::AntigravityAccountReport, String> {
    let root = state
        .codex_accounts_dir
        .with_file_name("antigravity-accounts");
    crate::core::antigravity_oauth::authorize(&root, |url| {
        tauri_plugin_opener::open_url(url, None::<&str>)
            .map_err(|_| "无法打开 Google 授权页面".to_owned())
    })
    .await
}

#[tauri::command]
pub(crate) async fn delete_antigravity_account(
    state: tauri::State<'_, AppState>,
    account_id: String,
) -> Result<(), String> {
    let root = state
        .codex_accounts_dir
        .with_file_name("antigravity-accounts");
    crate::core::antigravity_oauth::delete_account(&root, &account_id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::config::{ChannelAccount, ChannelPreset, RouteCandidate};

    fn route(model: &str, protocol: ProtocolType) -> RouteCandidate {
        RouteCandidate {
            virtual_model_id: model.to_string(),
            upstream_model: model.to_string(),
            channel_id: "openai-api".to_string(),
            account_id: "project".to_string(),
            client_protocol: protocol,
            enabled: true,
            ..Default::default()
        }
    }

    fn snapshot_with_routes(routes: Vec<RouteCandidate>) -> RuntimeConfigSnapshot {
        RuntimeConfigSnapshot::new(
            vec![ChannelPreset::openai_api()],
            vec![ChannelAccount {
                id: "project".to_string(),
                channel_id: "openai-api".to_string(),
                api_key: "test".to_string(),
                enabled: true,
                ..Default::default()
            }],
            routes,
            vec![],
            vec![],
        )
    }

    #[test]
    fn agent_protocols_match_the_written_endpoint() {
        assert_eq!(agent_protocols("claude-code"), &[ProtocolType::Anthropic]);
        assert_eq!(agent_protocols("codex"), &[ProtocolType::Responses]);
        for adapter in ["opencode", "pi", "deepseek-harness", "hermes"] {
            assert_eq!(
                agent_protocols(adapter),
                &[ProtocolType::OpenAi],
                "{adapter}"
            );
        }
    }

    #[test]
    fn available_models_require_enabled_route_healthy_account_and_channel() {
        let mut disabled_route = route("kimi-k3", ProtocolType::OpenAi);
        disabled_route.enabled = false;
        let mut disabled_account = route("glm-5.3", ProtocolType::OpenAi);
        disabled_account.account_id = "missing".to_string();
        let snapshot = snapshot_with_routes(vec![
            route("LongCat-2.5", ProtocolType::OpenAi),
            disabled_route,
            disabled_account,
            // 已移除的聚合模型旧路由：目录里不存在，不参与可用性判断。
            route("flowlet-pro", ProtocolType::OpenAi),
            // 协议不匹配（Claude Code 只接受 anthropic）。
            route("kimi-k3", ProtocolType::Anthropic),
            route("gpt-6.1-sol", ProtocolType::OpenAi),
        ]);
        assert_eq!(
            available_agent_models(&snapshot, &[ProtocolType::OpenAi]),
            vec!["LongCat-2.5", "gpt-6.1-sol"]
        );
        assert!(available_agent_models(&snapshot, &[ProtocolType::Anthropic]).is_empty());
        assert!(available_agent_models(&snapshot, &[ProtocolType::Responses]).is_empty());
    }

    #[test]
    fn requested_model_defaults_to_first_available_and_rejects_unknown() {
        let available = vec!["LongCat-2.5".to_string(), "glm-5.3".to_string()];
        // 缺省：字典序第一个可用模型。
        assert_eq!(
            resolve_requested_model(None, &available).unwrap(),
            "LongCat-2.5"
        );
        // 显式选择：允许别名，归一为规范 ID。
        assert_eq!(
            resolve_requested_model(Some("deepseek-flash"), &available).unwrap(),
            "deepseek-v4.1-flash"
        );
        let error = resolve_requested_model(Some("flowlet-pro"), &available).unwrap_err();
        assert!(error.contains("不在 Flowlet 模型目录中"), "{error}");
        // 一个可用模型都没有 → 结构化错误。
        let error = resolve_requested_model(None, &[]).unwrap_err();
        assert!(error.contains("没有可用的开放模型"), "{error}");
    }

    #[test]
    fn fast_model_defaults_to_primary_and_validates_explicit_value() {
        assert_eq!(resolve_fast_model(None, "kimi-k3").unwrap(), "kimi-k3");
        assert_eq!(
            resolve_fast_model(Some("  "), "kimi-k3").unwrap(),
            "kimi-k3"
        );
        assert_eq!(
            resolve_fast_model(Some("glm-5.3"), "kimi-k3").unwrap(),
            "glm-5.3"
        );
        let error = resolve_fast_model(Some("flowlet-flash"), "kimi-k3").unwrap_err();
        assert!(error.contains("不在 Flowlet 模型目录中"), "{error}");
    }
}
