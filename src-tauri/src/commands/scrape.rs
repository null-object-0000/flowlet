use crate::core::channels_config::ChannelsConfig;
use crate::core::config::{
    AccountBalanceSnapshot, AccountStatsRow, ChannelAccount, ChannelPreset, RouteCandidate,
    RouteRule,
};
use crate::core::presets::{BalanceQueryResult, ModelSyncResult};
use crate::core::sync::{
    query_deepseek_balance, query_kimi_balance, sync_deepseek_models, sync_kimi_models,
    sync_longcat_models, sync_openai_compatible_models, sync_qwen_models,
};
use crate::AppState;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Manager};

static CHANNEL_RESOURCE_SYNC_RUNNING: AtomicBool = AtomicBool::new(false);
struct ChannelResourceSyncGuard;
impl Drop for ChannelResourceSyncGuard {
    fn drop(&mut self) {
        CHANNEL_RESOURCE_SYNC_RUNNING.store(false, Ordering::Release);
    }
}

/// 手动触发 models-cn 目录同步。拉取远程数据保存到本地，写入任务日志。
#[tauri::command]
pub(crate) async fn sync_models_cn_catalog(
    state: tauri::State<'_, AppState>,
    source_url: String,
    trigger_source: String,
) -> Result<crate::core::storage::storage_tasks::CatalogSyncResult, String> {
    let storage = state.storage.clone();
    let config_path = state.config_path.clone();
    crate::core::storage::storage_tasks::sync_models_cn_catalog(
        &storage,
        &config_path,
        &source_url,
        &trigger_source,
    )
    .await
}

/// 手动触发 models.dev 目录同步。拉取远程数据保存到本地，写入任务日志。
#[tauri::command]
pub(crate) async fn sync_models_dev_catalog(
    state: tauri::State<'_, AppState>,
    source_url: String,
    trigger_source: String,
) -> Result<crate::core::storage::storage_tasks::CatalogSyncResult, String> {
    let storage = state.storage.clone();
    let config_path = state.config_path.clone();
    crate::core::storage::storage_tasks::sync_models_dev_catalog(
        &storage,
        &config_path,
        &source_url,
        &trigger_source,
    )
    .await
}

/// 读取本地 models-cn 目录文件。返回 None 表示文件不存在。
#[tauri::command]
pub(crate) fn get_models_cn_catalog(
    _state: tauri::State<'_, AppState>,
) -> Result<Option<String>, String> {
    Ok(crate::core::storage::storage_tasks::read_models_cn_file())
}

/// 从本地 models-cn 目录提取 channel_id:upstream_model → currency 映射。
#[tauri::command]
pub(crate) fn get_models_cn_currencies(
    _state: tauri::State<'_, AppState>,
) -> Result<Vec<(String, String)>, String> {
    crate::core::storage::storage_tasks::get_models_cn_currencies()
}

/// 单条渠道预设变更项。
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetDiffItem {
    pub id: String,
    pub name: String,
    pub status: String, // "added" | "removed" | "updated"
    pub before: Option<String>,
    pub after: Option<String>,
}

/// config.json 与数据库渠道预设的对比结果。
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetSyncPreview {
    pub has_changes: bool,
    pub added_count: usize,
    pub removed_count: usize,
    pub updated_count: usize,
    /// 已有渠道新增的暴露模型（需要生成路由才会在下拉出现）。
    pub new_exposed_models: Vec<NewExposedModel>,
    pub items: Vec<PresetDiffItem>,
}

/// 已有渠道新出现的 config 暴露模型（数据库里尚无对应路由）。
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewExposedModel {
    pub channel_id: String,
    pub channel_name: String,
    pub model_id: String,
}

/// 按实际路由合并规则计算本次同步会补齐的模型。
///
/// 预览必须与 `merge_default_routes` 使用同一套 exposed_models / synced_models /
/// 全局白名单约束，不能直接拿 config.json 的 default_exposed_models 与现有路由比较，
/// 否则用户未勾选的默认模型会永久显示为“待同步”，但确认后又不会真正生成路由。
fn preview_new_exposed_models(
    channels_config: &crate::core::channels_config::ChannelsConfig,
    existing_routes: &[RouteCandidate],
    accounts: &[ChannelAccount],
    presets: &[ChannelPreset],
) -> Vec<NewExposedModel> {
    let merged = channels_config.merge_default_routes(existing_routes, accounts, presets);
    let channel_names: std::collections::HashMap<&str, &str> = presets
        .iter()
        .map(|preset| (preset.id.as_str(), preset.name.as_str()))
        .collect();
    let mut seen = std::collections::HashSet::new();
    let mut additions = Vec::new();

    // merge_default_routes 保留原数组顺序，只在末尾追加缺失路由。
    for route in merged.iter().skip(existing_routes.len()) {
        let key = (route.channel_id.clone(), route.upstream_model.clone());
        if !seen.insert(key) {
            continue;
        }
        additions.push(NewExposedModel {
            channel_id: route.channel_id.clone(),
            channel_name: channel_names
                .get(route.channel_id.as_str())
                .copied()
                .unwrap_or(route.channel_id.as_str())
                .to_string(),
            model_id: route.upstream_model.clone(),
        });
    }
    additions
}

/// 预览 config.json 与数据库渠道预设的差异（不写入）。
#[tauri::command]
pub(crate) fn preview_sync_channel_presets(
    state: tauri::State<'_, AppState>,
) -> Result<PresetSyncPreview, String> {
    let storage = state.storage.clone();
    let config_path = state.config_path.clone();
    let config_raw =
        std::fs::read_to_string(&config_path).map_err(|e| format!("读取 config.json 失败：{e}"))?;
    let config_value: serde_json::Value =
        serde_json::from_str(&config_raw).map_err(|e| format!("解析 config.json 失败：{e}"))?;
    let channels_config =
        crate::core::channels_config::ChannelsConfig::from_config_json(&config_value)
            .map_err(|e| format!("构建 ChannelsConfig 失败：{e}"))?;

    let mut new_presets = channels_config.presets.clone();
    let builtin = crate::core::presets::builtin_channel_presets();
    for bp in &builtin {
        if !new_presets.iter().any(|p| p.id == bp.id) {
            new_presets.push(bp.clone());
        }
    }

    let existing = storage.list_channel_presets().map_err(|e| e.to_string())?;
    let existing_map: std::collections::HashMap<&str, &ChannelPreset> =
        existing.iter().map(|p| (p.id.as_str(), p)).collect();
    let new_map: std::collections::HashMap<&str, &ChannelPreset> =
        new_presets.iter().map(|p| (p.id.as_str(), p)).collect();

    let mut items: Vec<PresetDiffItem> = Vec::new();

    // 新增
    for np in &new_presets {
        if !existing_map.contains_key(np.id.as_str()) {
            items.push(PresetDiffItem {
                id: np.id.clone(),
                name: np.name.clone(),
                status: "added".to_string(),
                before: None,
                after: Some(format!("{}/{}", np.name, np.default_model)),
            });
        }
    }

    // 移除
    for ep in &existing {
        if !new_map.contains_key(ep.id.as_str()) && !builtin.iter().any(|b| b.id == ep.id) {
            items.push(PresetDiffItem {
                id: ep.id.clone(),
                name: ep.name.clone(),
                status: "removed".to_string(),
                before: Some(format!("{}/{}", ep.name, ep.default_model)),
                after: None,
            });
        }
    }

    // 更新（同 ID 但字段变化）
    for np in &new_presets {
        if let Some(ep) = existing_map.get(np.id.as_str()) {
            let mut changes: Vec<String> = Vec::new();
            if np.name != ep.name {
                changes.push(format!("名称：{} → {}", ep.name, np.name));
            }
            if np.default_model != ep.default_model {
                changes.push(format!(
                    "默认模型：{} → {}",
                    ep.default_model, np.default_model
                ));
            }
            if np.small_model != ep.small_model {
                let ep_small = ep.small_model.as_deref().unwrap_or("-");
                let np_small = np.small_model.as_deref().unwrap_or("-");
                if ep_small != np_small {
                    changes.push(format!("小型模型：{} → {}", ep_small, np_small));
                }
            }
            if np.platform_url != ep.platform_url {
                changes.push("平台地址已更新".to_string());
            }
            if np.supported_protocols != ep.supported_protocols {
                changes.push("支持协议已变更".to_string());
            }
            if !changes.is_empty() {
                items.push(PresetDiffItem {
                    id: np.id.clone(),
                    name: np.name.clone(),
                    status: "updated".to_string(),
                    before: Some(format!("{}/{}", ep.name, ep.default_model)),
                    after: Some(changes.join("；")),
                });
            }
        }
    }

    let existing_routes = storage.list_route_candidates().map_err(|e| e.to_string())?;
    let existing_accounts = storage.list_channel_accounts().map_err(|e| e.to_string())?;
    let new_exposed_models = preview_new_exposed_models(
        &channels_config,
        &existing_routes,
        &existing_accounts,
        &new_presets,
    );

    let added_count = items.iter().filter(|i| i.status == "added").count();
    let removed_count = items.iter().filter(|i| i.status == "removed").count();
    let updated_count = items.iter().filter(|i| i.status == "updated").count();
    let has_changes = !items.is_empty() || !new_exposed_models.is_empty();

    Ok(PresetSyncPreview {
        has_changes,
        added_count,
        removed_count,
        updated_count,
        new_exposed_models,
        items,
    })
}

/// 把 config.json 渠道预设同步到数据库，并补齐新增暴露模型的默认路由。
/// 新增渠道默认禁用，已有渠道保留启用状态。
#[tauri::command]
pub(crate) fn apply_sync_channel_presets(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let storage = state.storage.clone();
    let config_path = state.config_path.clone();
    crate::migrate_channel_presets_from_config(&storage, &config_path, true)?;

    // 同步完成后，为新暴露模型补齐默认路由
    let config_raw =
        std::fs::read_to_string(&config_path).map_err(|e| format!("读取 config.json 失败：{e}"))?;
    let config_value: serde_json::Value =
        serde_json::from_str(&config_raw).map_err(|e| format!("解析 config.json 失败：{e}"))?;
    let channels_config =
        crate::core::channels_config::ChannelsConfig::from_config_json(&config_value)
            .map_err(|e| format!("构建 ChannelsConfig 失败：{e}"))?;

    let existing_routes = storage.list_route_candidates().map_err(|e| e.to_string())?;
    let accounts = storage.list_channel_accounts().map_err(|e| e.to_string())?;
    let presets = storage.list_channel_presets().map_err(|e| e.to_string())?;

    let merged = channels_config.merge_default_routes(&existing_routes, &accounts, &presets);
    if merged.len() != existing_routes.len() {
        storage
            .save_route_candidates(&merged)
            .map_err(|e| e.to_string())?;
        tracing::info!(
            added = merged.len() - existing_routes.len(),
            "新增暴露模型默认路由已补齐"
        );
    }

    Ok(())
}

#[cfg(test)]
mod preset_sync_tests {
    use super::preview_new_exposed_models;
    use crate::core::channels_config::ChannelsConfig;
    use crate::core::config::ChannelAccount;

    fn qwen_config() -> ChannelsConfig {
        ChannelsConfig::from_config_json(&serde_json::json!({
            "channels_config": {
                "channels": [{
                    "id": "qwen",
                    "name": "Qwen",
                    "vendor": "qwen",
                    "supported_protocols": ["openai"]
                }],
                "default_exposed_models": {
                    "qwen": ["qwen3.7-flash", "qwen3.6-plus"]
                }
            }
        }))
        .expect("valid qwen config")
    }

    #[test]
    fn preview_does_not_report_defaults_the_account_did_not_expose() {
        let config = qwen_config();
        let account = ChannelAccount {
            id: "qwen-account".to_string(),
            channel_id: "qwen".to_string(),
            api_key: "sk-test".to_string(),
            enabled: true,
            exposed_models: Some(vec![]),
            synced_models: Some(vec![
                "qwen3.7-flash".to_string(),
                "qwen3.6-plus".to_string(),
            ]),
            ..Default::default()
        };

        let additions = preview_new_exposed_models(&config, &[], &[account], &config.presets);

        assert!(additions.is_empty());
    }

    #[test]
    fn preview_reports_only_routes_the_apply_step_can_create() {
        let config = qwen_config();
        let account = ChannelAccount {
            id: "qwen-account".to_string(),
            channel_id: "qwen".to_string(),
            api_key: "sk-test".to_string(),
            enabled: true,
            exposed_models: Some(vec!["qwen3.7-flash".to_string()]),
            synced_models: Some(vec![
                "qwen3.7-flash".to_string(),
                "qwen3.6-plus".to_string(),
            ]),
            ..Default::default()
        };

        let additions = preview_new_exposed_models(&config, &[], &[account], &config.presets);

        assert_eq!(additions.len(), 1);
        assert_eq!(additions[0].channel_id, "qwen");
        assert_eq!(additions[0].model_id, "qwen3.7-flash");
    }
}

// ─── Sync Commands ──────────────────────────────────────────────────────────

#[tauri::command]
pub(crate) async fn query_balance(
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

    if account.effective_openai_base_url().is_some() {
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
            remark: Some("官方余额接口同步".to_string()),
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

/// 用连接参数拉取某渠道上游的模型列表（底层 /models 能力）。
///
/// 与 test_connection 一样接收连接参数而非 account_id，因此新建（尚未保存）的账号
/// 也能拉取。成功后把结果写入 `channel_models` 目录（供模型服务页展示），但**不**写
/// 账号的 `synced_models` / `exposed_models`——那些由账号编辑器保存时按用户勾选持久化。
#[tauri::command]
pub(crate) async fn fetch_channel_models(
    state: tauri::State<'_, AppState>,
    channel_id: String,
    api_key: String,
    base_url_override: Option<String>,
) -> Result<ModelSyncResult, String> {
    let account = ChannelAccount {
        id: String::new(),
        channel_id: channel_id.clone(),
        api_key,
        base_url_override,
        enabled: true,
        ..Default::default()
    };

    let config = state
        .channels_config
        .lock()
        .map_err(|_| "锁定渠道运行时配置失败".to_string())?
        .clone();
    let preset = state
        .channels
        .lock()
        .map_err(|_| "读取渠道模板失败".to_string())?
        .iter()
        .find(|preset| preset.id == channel_id)
        .cloned();

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
        "custom" => {
            let preset = preset.ok_or_else(|| "自定义渠道模板不存在".to_string())?;
            tauri::async_runtime::spawn_blocking(move || {
                let rt = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .unwrap_or_else(|_| panic!("创建运行时失败"));
                rt.block_on(sync_openai_compatible_models(&account, &preset, None))
            })
            .await
            .map_err(|e| format!("任务执行失败: {e}"))?
        }
        "zhipu" => {
            let preset = preset.ok_or_else(|| "智谱渠道模板不存在".to_string())?;
            // 智谱 models 端点是 /api/paas/v4/models（不以 /v1 结尾），
            // 显式传入配置的 endpoints.models 覆盖，避免 openai_models_url 拼出
            // 非标准 /v1/models 变体；与 test_channel_connection 保持一致。
            let models_url = config.models_endpoint_url("zhipu");
            tauri::async_runtime::spawn_blocking(move || {
                let rt = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .unwrap_or_else(|_| panic!("创建运行时失败"));
                rt.block_on(sync_openai_compatible_models(&account, &preset, models_url))
            })
            .await
            .map_err(|e| format!("任务执行失败: {e}"))?
        }
        _ => {
            return Ok(ModelSyncResult {
                models_synced: 0,
                models: Vec::new(),
                errors: vec!["当前渠道不支持拉取模型列表".to_string()],
            });
        }
    };

    // 更新渠道模型目录（按 channel_id 替换），供模型服务页展示该渠道上游实际提供的模型。
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
    }

    Ok(result)
}

// ─── Balance Snapshot Commands ──────────────────────────────────────────────

#[tauri::command]
pub(crate) fn save_balance_snapshot(
    state: tauri::State<'_, AppState>,
    snapshot: AccountBalanceSnapshot,
) -> Result<(), String> {
    state
        .storage
        .save_balance_snapshot(&snapshot)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(crate) fn list_balance_snapshots(
    state: tauri::State<'_, AppState>,
    account_id: String,
) -> Result<Vec<AccountBalanceSnapshot>, String> {
    state
        .storage
        .list_balance_snapshots(&account_id)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(crate) fn latest_balance_snapshots(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<AccountBalanceSnapshot>, String> {
    state
        .storage
        .latest_balance_snapshots()
        .map_err(|err| err.to_string())
}

// ─── Account Stats Commands ────────────────────────────────────────────────

#[tauri::command]
pub(crate) fn account_stats(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<AccountStatsRow>, String> {
    state.storage.account_stats().map_err(|err| err.to_string())
}

// ─── Route Rules Commands ──────────────────────────────────────────────────

#[tauri::command]
pub(crate) fn list_route_rules(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<RouteRule>, String> {
    state
        .rules
        .lock()
        .map(|rules| rules.clone())
        .map_err(|_| "读取路由规则失败".to_string())
}

#[tauri::command]
pub(crate) fn save_route_rules(
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

// ─── Scrape Console Commands ────────────────────────────────────────────────
// 后台 webview 登录控制台 + 拦截 API 抓取套餐余量。

use crate::core::scrape_console::{
    self, build_scrape_webview, classify_response_url, resolve_scrape_mode,
};

/// 抓取结果(前端展示用)。
#[derive(Clone, serde::Serialize)]
pub struct ScrapeBalanceResult {
    pub balance: Option<f64>,
    pub currency: Option<String>,
    pub plan_name: Option<String>,
    pub token_total: Option<i64>,
    pub token_used: Option<i64>,
    pub token_remaining: Option<i64>,
    pub token_pack_expire_at: Option<String>,
    pub token_packs: Option<String>,
    pub raw_scraped_json: Option<String>,
    pub source: String,
    pub synced_at: String,
}

/// 登录态探测结果。
#[derive(Clone, serde::Serialize)]
pub struct ScrapeLoginStatus {
    pub is_logged_in: bool,
    pub channel_id: String,
    /// 登录后的账户标识(如有,用于 UI 展示)。
    pub account_hint: Option<String>,
    /// captured / login_required / console_action_required / capture_timeout。
    /// 未捕获不能等同于未登录。
    pub probe_state: ScrapeProbeState,
    pub message: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScrapeProbeState {
    Captured,
    LoginRequired,
    ConsoleActionRequired,
    CaptureTimeout,
}

/// 创建 per-account 后台抓取 webview(隐藏)。
#[tauri::command]
pub(crate) async fn open_scrape_console(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    account_id: String,
) -> Result<(), String> {
    // 已存在且仍注册在 Tauri 中才复用。用户直接关闭登录窗口时，HashMap 中的
    // WebviewWindow 句柄可能短暂残留，不能把它当成可用窗口。
    {
        let mut guard = state
            .scrape_webviews
            .lock()
            .map_err(|_| "锁定抓取 webview 失败".to_string())?;
        if let Some(window) = guard.get(&account_id) {
            if app.get_webview_window(window.label()).is_some() && window.is_visible().is_ok() {
                return Ok(());
            }
            guard.remove(&account_id);
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
        resolve_scrape_mode(
            &config,
            &account.channel_id,
            account.resource_mode.as_deref(),
        )
        .ok_or("该账号所属渠道不支持控制台抓取")?
    };

    let channel_id = {
        let accounts = state
            .accounts
            .lock()
            .map_err(|_| "读取账号失败".to_string())?;
        accounts
            .iter()
            .find(|account| account.id == account_id)
            .map(|account| account.channel_id.clone())
            .ok_or("账号不存在")?
    };
    let window = build_scrape_webview(&app, &account_id, &channel_id, &mode)?;
    #[cfg(windows)]
    if let Err(error) = scrape_console::install_windows_response_capture(
        &window,
        account_id.clone(),
        state.scrape_pending.clone(),
        state.scrape_native_ready.clone(),
    ) {
        tracing::warn!(
            account_id = %account_id,
            error = %error,
            "调度 WebView2 原生监听失败，将使用页面注入 fallback"
        );
    }
    #[cfg(target_os = "linux")]
    if let Err(error) = scrape_console::install_linux_response_capture(
        &window,
        account_id.clone(),
        state.scrape_pending.clone(),
        state.scrape_native_ready.clone(),
    ) {
        tracing::warn!(
            account_id = %account_id,
            error = %error,
            "调度 WebKitGTK 原生监听失败，将使用页面注入 fallback"
        );
    }
    let cleanup_account_id = account_id.clone();
    let scrape_webviews = state.scrape_webviews.clone();
    let scrape_pending = state.scrape_pending.clone();
    let scrape_ready = state.scrape_ready.clone();
    let scrape_native_ready = state.scrape_native_ready.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
            if let Ok(mut guard) = scrape_webviews.lock() {
                guard.remove(&cleanup_account_id);
            }
            if let Ok(mut guard) = scrape_pending.lock() {
                guard.remove(&cleanup_account_id);
            }
            if let Ok(mut guard) = scrape_ready.lock() {
                guard.remove(&cleanup_account_id);
            }
            if let Ok(mut guard) = scrape_native_ready.lock() {
                guard.remove(&cleanup_account_id);
            }
        }
    });

    let mut guard = state
        .scrape_webviews
        .lock()
        .map_err(|_| "锁定抓取 webview 失败".to_string())?;
    guard.insert(account_id, window);
    Ok(())
}

/// 关闭并 drop per-account 抓取 webview。
#[tauri::command]
pub(crate) async fn close_scrape_console(
    state: tauri::State<'_, AppState>,
    account_id: String,
) -> Result<(), String> {
    let window = {
        let mut guard = state
            .scrape_webviews
            .lock()
            .map_err(|_| "锁定抓取 webview 失败".to_string())?;
        guard.remove(&account_id)
    };
    if let Some(window) = window {
        let _ = window.close();
    }
    if let Ok(mut guard) = state.scrape_pending.lock() {
        guard.remove(&account_id);
    }
    if let Ok(mut guard) = state.scrape_ready.lock() {
        guard.remove(&account_id);
    }
    if let Ok(mut guard) = state.scrape_native_ready.lock() {
        guard.remove(&account_id);
    }
    Ok(())
}

/// document-start 拦截器安装完成后的 ACK。账号从 webview label 推导，不能由页面伪造。
#[tauri::command]
pub(crate) async fn handle_scrape_interceptor_ready(
    webview: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    channel_id: String,
    document_id: String,
    page_url: String,
) -> Result<(), String> {
    let account_id = webview
        .label()
        .strip_prefix("scrape-")
        .filter(|value| !value.is_empty())
        .ok_or("只允许抓取控制台窗口报告监听状态")?
        .to_string();
    if document_id.len() > 128 || page_url.len() > 4096 {
        return Err("抓取监听状态参数过长".to_string());
    }
    {
        let accounts = state
            .accounts
            .lock()
            .map_err(|_| "读取账号失败".to_string())?;
        let account = accounts
            .iter()
            .find(|account| account.id == account_id)
            .ok_or("抓取窗口对应账号不存在")?;
        if account.channel_id != channel_id {
            return Err("抓取监听渠道与账号不匹配".to_string());
        }
    }
    let mut guard = state
        .scrape_ready
        .lock()
        .map_err(|_| "锁定抓取监听状态失败".to_string())?;
    guard.insert(
        account_id.clone(),
        crate::core::scrape_console::ScrapeInterceptorReady {
            document_id: document_id.clone(),
            page_url: page_url.clone(),
        },
    );
    tracing::debug!(
        account_id = %account_id,
        channel_id = %channel_id,
        document_id = %document_id,
        page_url = %page_url,
        "控制台抓取监听已就绪"
    );
    Ok(())
}

/// 页面 JS 通过 IPC 回传拦截到的响应体。
#[tauri::command]
pub(crate) async fn handle_intercepted_response(
    webview: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    channel_id: String,
    url: String,
    body: String,
) -> Result<(), String> {
    const MAX_SCRAPED_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
    let account_id = webview
        .label()
        .strip_prefix("scrape-")
        .filter(|value| !value.is_empty())
        .ok_or("只允许抓取控制台窗口回传响应")?
        .to_string();
    if body.len() > MAX_SCRAPED_RESPONSE_BYTES {
        return Err("抓取响应超过 8 MB，已拒绝写入缓冲".to_string());
    }
    {
        let accounts = state
            .accounts
            .lock()
            .map_err(|_| "读取账号失败".to_string())?;
        let account = accounts
            .iter()
            .find(|account| account.id == account_id)
            .ok_or("抓取窗口对应账号不存在")?;
        if account.channel_id != channel_id {
            return Err("抓取响应渠道与账号不匹配".to_string());
        }
    }
    let mut guard = state
        .scrape_pending
        .lock()
        .map_err(|_| "锁定抓取缓冲失败".to_string())?;
    let entry = guard.entry(account_id.clone()).or_default();
    let kind = classify_response_url(&url);
    let body_bytes = body.len();
    scrape_console::record_captured_response(entry, url.clone(), body);
    tracing::info!(
        account_id = %account_id,
        channel_id = %channel_id,
        response_kind = %kind,
        response_url = %url,
        body_bytes,
        "控制台抓取捕获到页面业务响应"
    );
    Ok(())
}

#[cfg(test)]
mod scrape_capture_tests {
    use super::{
        channel_resource_sync_completion_status, channel_resource_sync_method,
        is_explicit_login_url, merge_longcat_token_packs, scrape_responses_complete,
        ChannelResourceSyncMethod,
    };
    use crate::core::channels_config::{ChannelsConfig, DEFAULT_CONFIG_JSON};
    use crate::core::config::ChannelAccount;
    use crate::core::scrape_console::ScrapeModeRuntime;

    fn default_channels_config() -> ChannelsConfig {
        let json: serde_json::Value =
            serde_json::from_str(DEFAULT_CONFIG_JSON).expect("valid embedded config");
        ChannelsConfig::from_config_json(&json).expect("valid channels config")
    }

    #[test]
    fn completed_business_response_is_login_evidence() {
        let mode = ScrapeModeRuntime {
            console_url: "https://longcat.chat/platform/usage?tab=token".to_string(),
            console_url_secondary: None,
            console_url_tertiary: None,
            interceptor_js: String::new(),
            extractor_js: String::new(),
            aggregate: false,
            required_slots: vec![],
        };
        let responses = vec![
            (
                "https://longcat.chat/api/irrelevant".to_string(),
                r#"{"code":0}"#.to_string(),
            ),
            (
                "https://longcat.chat/api/pay/quota/metering/token-packs/summary".to_string(),
                r#"{"code":0,"data":{"currentLot":{}}}"#.to_string(),
            ),
        ];

        assert!(scrape_responses_complete(&responses, &mode));
    }

    #[test]
    fn capture_timeout_is_not_login_evidence() {
        assert!(!is_explicit_login_url(
            "qwen",
            "https://platform.qianwenai.com/home/billing/subscription/token-plan-individual"
        ));
        assert!(!is_explicit_login_url(
            "longcat",
            "https://longcat.chat/platform/usage?tab=token"
        ));
    }

    #[test]
    fn explicit_login_pages_are_login_evidence() {
        assert!(is_explicit_login_url(
            "qwen",
            "https://account.aliyun.com/login/login.htm"
        ));
        assert!(is_explicit_login_url(
            "longcat",
            "https://longcat.chat/login"
        ));
    }

    #[test]
    fn channel_resource_sync_reports_skipped_accounts_as_warnings() {
        assert_eq!(
            channel_resource_sync_completion_status(0, 2),
            "succeeded_with_warnings"
        );
        assert_eq!(
            channel_resource_sync_completion_status(1, 0),
            "succeeded_with_warnings"
        );
        assert_eq!(channel_resource_sync_completion_status(0, 0), "succeeded");
    }

    #[test]
    fn official_balance_accounts_sync_even_with_legacy_manual_mode() {
        let config = default_channels_config();
        for channel_id in ["deepseek", "kimi"] {
            let account = ChannelAccount {
                channel_id: channel_id.to_string(),
                resource_mode: Some("pay_as_you_go".to_string()),
                resource_sync_mode: "manual".to_string(),
                ..Default::default()
            };
            assert_eq!(
                channel_resource_sync_method(&config, &account),
                Some(ChannelResourceSyncMethod::OfficialApi)
            );
        }
    }

    #[test]
    fn official_balance_sync_skips_disabled_or_custom_endpoint_accounts() {
        let config = default_channels_config();
        let disabled = ChannelAccount {
            channel_id: "deepseek".to_string(),
            enabled: false,
            ..Default::default()
        };
        let custom_endpoint = ChannelAccount {
            channel_id: "kimi".to_string(),
            base_url_override: Some("https://proxy.example/v1".to_string()),
            ..Default::default()
        };

        assert_eq!(channel_resource_sync_method(&config, &disabled), None);
        assert_eq!(
            channel_resource_sync_method(&config, &custom_endpoint),
            None
        );
    }

    #[test]
    fn console_sync_still_requires_auto_mode() {
        let config = default_channels_config();
        let automatic = ChannelAccount {
            channel_id: "longcat".to_string(),
            resource_mode: Some("hybrid".to_string()),
            resource_sync_mode: "auto".to_string(),
            ..Default::default()
        };
        let manual = ChannelAccount {
            resource_sync_mode: "manual".to_string(),
            ..automatic.clone()
        };

        assert_eq!(
            channel_resource_sync_method(&config, &automatic),
            Some(ChannelResourceSyncMethod::ConsoleScrape)
        );
        assert_eq!(channel_resource_sync_method(&config, &manual), None);
    }

    #[test]
    fn qwen_console_sync_only_for_token_plan_subscription() {
        let config = default_channels_config();
        let token_plan = ChannelAccount {
            channel_id: "qwen".to_string(),
            resource_mode: Some("token_plan".to_string()),
            resource_sync_mode: "auto".to_string(),
            ..Default::default()
        };
        let token_plan_manual = ChannelAccount {
            resource_sync_mode: "manual".to_string(),
            ..token_plan.clone()
        };
        let pay_as_you_go = ChannelAccount {
            channel_id: "qwen".to_string(),
            resource_mode: Some("pay_as_you_go".to_string()),
            resource_sync_mode: "auto".to_string(),
            ..Default::default()
        };

        assert_eq!(
            channel_resource_sync_method(&config, &token_plan),
            Some(ChannelResourceSyncMethod::ConsoleScrape)
        );
        assert_eq!(
            channel_resource_sync_method(&config, &token_plan_manual),
            None
        );
        // API 按量付费账号没有官方余额接口也没有可用的控制台抓取模式，
        // 即使标记 auto 也不参与自动同步。
        assert_eq!(channel_resource_sync_method(&config, &pay_as_you_go), None);
    }

    #[test]
    fn preserves_longcat_current_and_other_lots_as_snapshot_details() {
        let slots = std::collections::HashMap::from([(
            "token_packs_summary".to_string(),
            r#"{"code":0,"data":{"currentLot":{"lotId":151724,"totalToken":50000000},"estimate":{"windowDays":7},"otherLots":[{"lotId":159869,"totalToken":10000000}]}}"#
                .to_string(),
        )]);

        let token_packs = merge_longcat_token_packs(&slots, None).expect("token packs");
        let parsed: serde_json::Value =
            serde_json::from_str(&token_packs).expect("valid token packs json");
        assert_eq!(parsed.as_array().map(Vec::len), Some(2));
        assert_eq!(parsed[0]["lotId"], 151724);
        assert_eq!(parsed[1]["lotId"], 159869);
    }

    #[test]
    fn deduplicates_longcat_summary_and_list_by_cep_business_order() {
        let slots = std::collections::HashMap::from([
            (
                "token_packs_summary".to_string(),
                r#"{"code":0,"data":{"currentLot":{"lotId":160795,"bizOrderNo":"CEP-2071803119104245853","totalToken":5000000,"consumedToken":5000000,"remainingToken":0,"status":"EXHAUSTED"},"otherLots":[]}}"#.to_string(),
            ),
            (
                "token_packs_list".to_string(),
                r#"{"code":0,"data":{"items":[{"resourceId":"2071803119104245853","packageId":"2071803119104245853","packageName":"问卷Token包","statusCode":4,"statusText":"已用尽","totalTokenAmount":5000000,"usedTokenAmount":5000000,"remainTokenAmount":0},{"resourceId":"2071771394512937000","packageId":"2071771394512937000","packageName":"实名奖励Token1000万资源包","statusCode":4,"statusText":"已用尽","totalTokenAmount":10000000,"usedTokenAmount":10000000,"remainTokenAmount":0}]}}"#.to_string(),
            ),
        ]);

        let packs = merge_longcat_token_packs(&slots, None).expect("merged packs");
        let parsed: Vec<serde_json::Value> =
            serde_json::from_str(&packs).expect("valid merged packs");
        assert_eq!(parsed.len(), 2, "summary 与对应 list item 不应重复");
        let matched = parsed
            .iter()
            .find(|pack| pack["packageId"] == "2071803119104245853")
            .expect("matched summary pack");
        assert_eq!(matched["lotId"], 160795, "保留 summary 内部 lotId");
        assert_eq!(matched["packageName"], "问卷Token包");
        assert_eq!(matched["statusText"], "已用尽");
        assert_eq!(matched["totalToken"], 5_000_000);
        assert!(
            matched.get("_fromList").is_none(),
            "匹配项仍是 summary 权威记录，不应标记为纯 list 补充项"
        );

        // 即使旧 extractor 已经把 list item 作为重复项追加，Rust 最终归一化仍应去重。
        let extracted = serde_json::to_string(&[
            serde_json::json!({
                "lotId": 160795,
                "bizOrderNo": "CEP-2071803119104245853",
                "totalToken": 5_000_000
            }),
            serde_json::json!({
                "lotId": "2071803119104245853",
                "packageName": "问卷Token包",
                "statusCode": 4,
                "statusText": "已用尽",
                "_fromList": true
            }),
        ])
        .unwrap();
        let normalized =
            merge_longcat_token_packs(&slots, Some(&extracted)).expect("normalized packs");
        let normalized: Vec<serde_json::Value> =
            serde_json::from_str(&normalized).expect("valid normalized packs");
        assert_eq!(normalized.len(), 2);
    }
}

fn has_complete_scrape_capture(
    state: &tauri::State<'_, AppState>,
    account_id: &str,
    mode: &crate::core::scrape_console::ScrapeModeRuntime,
) -> Result<bool, String> {
    let guard = state
        .scrape_pending
        .lock()
        .map_err(|_| "锁定抓取缓冲失败".to_string())?;
    let Some(responses) = guard.get(account_id) else {
        return Ok(false);
    };
    Ok(scrape_responses_complete(responses, mode))
}

fn scrape_responses_complete(
    responses: &[(String, String)],
    mode: &crate::core::scrape_console::ScrapeModeRuntime,
) -> bool {
    let slots = responses
        .iter()
        .filter_map(|(url, body)| {
            let kind = classify_response_url(url);
            scrape_console::captured_response_satisfies_slot(kind, body)
                .then(|| (kind.to_string(), body.clone()))
        })
        .collect::<std::collections::HashMap<_, _>>();
    scrape_console::aggregate_complete(&slots, mode)
}

fn collect_scrape_slots(
    state: &tauri::State<'_, AppState>,
    account_id: &str,
) -> Result<std::collections::HashMap<String, String>, String> {
    let guard = state
        .scrape_pending
        .lock()
        .map_err(|_| "锁定抓取缓冲失败".to_string())?;
    Ok(guard
        .get(account_id)
        .into_iter()
        .flatten()
        .filter_map(|(url, body)| {
            let kind = classify_response_url(url);
            scrape_console::captured_response_satisfies_slot(kind, body)
                .then(|| (kind.to_string(), body.clone()))
        })
        .collect())
}

/// 从 LongCat 原始响应兜底提取并归一化完整资源包数组。
///
/// summary 的 lotId 是内部批次 ID，list 的 resourceId/packageId 是套餐资源 ID，
/// 二者不能直接比较。跨接口关联使用：
/// `summary.bizOrderNo == "CEP-" + list.packageId`。
/// list 响应负责补充名称、展示状态等字段，但 summary 的额度数值保持权威。
fn merge_longcat_token_packs(
    slots: &std::collections::HashMap<String, String>,
    extracted: Option<&str>,
) -> Option<String> {
    let mut candidates = Vec::new();
    // summary 始终先进入候选，确保额度数值和内部 lotId 为权威来源；旧 extractor
    // 即使只返回 list 明细，也会在后续按 bizOrderNo/packageId 合并到 summary。
    if let Some(raw) = slots.get("token_packs_summary") {
        if let Ok(root) = serde_json::from_str::<serde_json::Value>(raw) {
            let data = root.get("data").unwrap_or(&root);
            if let Some(current) = data.get("currentLot").filter(|value| value.is_object()) {
                candidates.push(current.clone());
            }
            if let Some(others) = data.get("otherLots").and_then(|value| value.as_array()) {
                candidates.extend(others.iter().filter(|value| value.is_object()).cloned());
            }
        }
    }
    if let Some(extracted) =
        extracted.and_then(|raw| serde_json::from_str::<Vec<serde_json::Value>>(raw).ok())
    {
        candidates.extend(extracted);
    }

    if let Some(raw) = slots.get("token_packs_list") {
        if let Ok(root) = serde_json::from_str::<serde_json::Value>(raw) {
            let data = root.get("data").unwrap_or(&root);
            if let Some(items) = data.get("items").and_then(|value| value.as_array()) {
                candidates.extend(items.iter().filter_map(longcat_list_item_as_pack));
            }
        }
    }

    let mut packs = Vec::<serde_json::Value>::new();
    let mut indexes = std::collections::HashMap::<String, usize>::new();
    for candidate in candidates {
        let keys = longcat_pack_identity_keys(&candidate);
        let existing_index = keys.iter().find_map(|key| indexes.get(key).copied());
        if let Some(index) = existing_index {
            merge_longcat_pack_details(&mut packs[index], candidate);
            for key in longcat_pack_identity_keys(&packs[index]) {
                indexes.insert(key, index);
            }
        } else {
            let index = packs.len();
            packs.push(candidate);
            for key in longcat_pack_identity_keys(&packs[index]) {
                indexes.insert(key, index);
            }
        }
    }

    if packs.is_empty() {
        None
    } else {
        serde_json::to_string(&packs).ok()
    }
}

fn longcat_list_item_as_pack(item: &serde_json::Value) -> Option<serde_json::Value> {
    let resource_id = item.get("resourceId").or_else(|| item.get("packageId"))?;
    let mut pack = serde_json::Map::new();
    pack.insert("lotId".to_string(), resource_id.clone());
    pack.insert("packageId".to_string(), resource_id.clone());
    pack.insert("_fromList".to_string(), serde_json::Value::Bool(true));
    let mappings = [
        ("packageName", "packageName"),
        ("sourceTypeCode", "sourceTypeCode"),
        ("sourceTypeText", "sourceTypeText"),
        ("statusCode", "statusCode"),
        ("statusText", "statusText"),
        ("displayStatusCode", "displayStatusCode"),
        ("displayStatusText", "displayStatusText"),
        ("totalTokenAmount", "totalToken"),
        ("usedTokenAmount", "consumedToken"),
        ("remainTokenAmount", "remainingToken"),
        ("validEndTime", "expireTime"),
        ("validStartTime", "validStartTime"),
        ("acquireTime", "acquireTime"),
        ("acquireDateText", "acquireDateText"),
        ("usagePercent", "usagePercent"),
        ("validDays", "validDays"),
        ("applicableModels", "applicableModels"),
        ("skuCode", "skuCode"),
        ("productId", "productId"),
    ];
    for (source, target) in mappings {
        if let Some(value) = item.get(source) {
            pack.insert(target.to_string(), value.clone());
        }
    }
    Some(serde_json::Value::Object(pack))
}

fn longcat_pack_identity_keys(pack: &serde_json::Value) -> Vec<String> {
    let mut keys = Vec::new();
    if let Some(biz_order_no) = pack.get("bizOrderNo").and_then(|value| value.as_str()) {
        keys.push(format!("biz:{biz_order_no}"));
        if let Some(package_id) = biz_order_no.strip_prefix("CEP-") {
            keys.push(format!("package:{package_id}"));
        }
    }
    if let Some(package_id) = pack
        .get("packageId")
        .or_else(|| pack.get("resourceId"))
        .and_then(json_scalar_string)
    {
        keys.push(format!("package:{package_id}"));
        keys.push(format!("biz:CEP-{package_id}"));
    } else if pack
        .get("_fromList")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
    {
        if let Some(package_id) = pack.get("lotId").and_then(json_scalar_string) {
            keys.push(format!("package:{package_id}"));
            keys.push(format!("biz:CEP-{package_id}"));
        }
    }
    if let Some(lot_id) = pack.get("lotId").and_then(json_scalar_string) {
        keys.push(format!("lot:{lot_id}"));
    }
    keys
}

fn json_scalar_string(value: &serde_json::Value) -> Option<String> {
    value
        .as_str()
        .map(ToOwned::to_owned)
        .or_else(|| value.as_u64().map(|value| value.to_string()))
        .or_else(|| value.as_i64().map(|value| value.to_string()))
}

fn merge_longcat_pack_details(target: &mut serde_json::Value, incoming: serde_json::Value) {
    let target_from_list = target
        .get("_fromList")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let incoming_from_list = incoming
        .get("_fromList")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);

    if target_from_list && !incoming_from_list {
        let previous = std::mem::replace(target, incoming);
        enrich_longcat_pack_from_list(target, &previous);
    } else if incoming_from_list {
        enrich_longcat_pack_from_list(target, &incoming);
    }
}

fn enrich_longcat_pack_from_list(target: &mut serde_json::Value, list_pack: &serde_json::Value) {
    let Some(target) = target.as_object_mut() else {
        return;
    };
    let Some(list_pack) = list_pack.as_object() else {
        return;
    };
    let package_id = list_pack
        .get("packageId")
        .or_else(|| list_pack.get("lotId"))
        .cloned();
    if let Some(package_id) = package_id {
        target.insert("packageId".to_string(), package_id);
    }
    for field in [
        "packageName",
        "sourceTypeCode",
        "sourceTypeText",
        "statusCode",
        "statusText",
        "displayStatusCode",
        "displayStatusText",
        "validStartTime",
        "acquireTime",
        "acquireDateText",
        "usagePercent",
        "validDays",
        "applicableModels",
        "skuCode",
        "productId",
    ] {
        if let Some(value) = list_pack.get(field) {
            target.insert(field.to_string(), value.clone());
        }
    }
}

fn scrape_interceptor_ready(
    state: &tauri::State<'_, AppState>,
    account_id: &str,
) -> Result<Option<crate::core::scrape_console::ScrapeInterceptorReady>, String> {
    let guard = state
        .scrape_ready
        .lock()
        .map_err(|_| "锁定抓取监听状态失败".to_string())?;
    Ok(guard.get(account_id).cloned())
}

fn native_scrape_capture_ready(
    state: &tauri::State<'_, AppState>,
    account_id: &str,
) -> Result<bool, String> {
    let guard = state
        .scrape_native_ready
        .lock()
        .map_err(|_| "锁定原生抓取监听状态失败".to_string())?;
    Ok(guard.contains(account_id))
}

fn scrape_interaction_required(
    state: &tauri::State<'_, AppState>,
    account_id: &str,
) -> Result<bool, String> {
    let guard = state
        .scrape_interaction_required
        .lock()
        .map_err(|_| "锁定控制台交互状态失败".to_string())?;
    Ok(guard.contains(account_id))
}

fn set_scrape_interaction_required(
    state: &tauri::State<'_, AppState>,
    account_id: &str,
    required: bool,
) -> Result<(), String> {
    let mut guard = state
        .scrape_interaction_required
        .lock()
        .map_err(|_| "锁定控制台交互状态失败".to_string())?;
    if required {
        guard.insert(account_id.to_string());
    } else {
        guard.remove(account_id);
    }
    Ok(())
}

fn current_scrape_page_url(
    state: &tauri::State<'_, AppState>,
    account_id: &str,
) -> Result<Option<String>, String> {
    let guard = state
        .scrape_webviews
        .lock()
        .map_err(|_| "锁定抓取 webview 失败".to_string())?;
    Ok(guard
        .get(account_id)
        .and_then(|window| window.url().ok())
        .map(|url| url.to_string()))
}

/// 只识别明确的登录页面。目标响应未出现、页面加载慢或拦截器异常都不能据此判定未登录。
fn is_explicit_login_url(channel_id: &str, page_url: &str) -> bool {
    let url = page_url.to_ascii_lowercase();
    let has_login_path = url.contains("/login")
        || url.contains("/signin")
        || url.contains("/sign-in")
        || url.contains("passport")
        || url.contains("oauth");
    match channel_id {
        "qwen" => has_login_path || url.contains("account.aliyun.com"),
        "longcat" => has_login_path,
        _ => false,
    }
}

/// 刷新控制台并通过页面自身发起的业务请求判断是否已登录。
/// 拦截器是 WebView initialization_script，会在每次导航的页面脚本之前安装；
/// 因此必须先清缓冲，再导航刷新，随后等待目标业务响应。
#[tauri::command]
pub(crate) async fn probe_scrape_login(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    account_id: String,
    interactive: Option<bool>,
) -> Result<ScrapeLoginStatus, String> {
    let interactive = interactive.unwrap_or(true);
    // 1. 先解析账号与抓取模式。交互式刷新从这里开始占用该账号，直到完整抓取成功；
    //    后台轮次看到这个标记后必须跳过，不能重新导航用户正在登录的 WebView。
    let (channel_id, mode) = {
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
        let mode = resolve_scrape_mode(
            &config,
            &account.channel_id,
            account.resource_mode.as_deref(),
        )
        .ok_or("该账号所属渠道不支持控制台抓取")?;
        (account.channel_id.clone(), mode)
    };
    if interactive {
        set_scrape_interaction_required(&state, &account_id, true)?;
    } else if scrape_interaction_required(&state, &account_id)? {
        return Ok(ScrapeLoginStatus {
            is_logged_in: false,
            channel_id,
            account_hint: None,
            probe_state: ScrapeProbeState::LoginRequired,
            message: Some("账号正在等待控制台登录或人工处理，本轮自动同步已跳过。".to_string()),
        });
    }

    // 2. 确保 webview 存在。
    open_scrape_console(app.clone(), state.clone(), account_id.clone()).await?;

    tracing::info!(
        account_id = %account_id,
        channel_id = %channel_id,
        native_ready = native_scrape_capture_ready(&state, &account_id)?,
        "开始刷新控制台并等待业务响应"
    );
    // 3. 先清空旧响应和旧 document ACK，再依次导航到各控制台页面。
    //    LongCat hybrid 模式下 token 资源包与按量余额分属不同标签页(?tab=token /
    //    ?tab=api),需多阶段导航;响应累积在同一个 scrape_pending 缓冲中,按 URL
    //    分类到不同槽位(token_packs_summary / api_usage_summary)。
    {
        let mut guard = state
            .scrape_pending
            .lock()
            .map_err(|_| "锁定抓取缓冲失败".to_string())?;
        guard.remove(&account_id);
    }
    {
        let mut guard = state
            .scrape_ready
            .lock()
            .map_err(|_| "锁定抓取监听状态失败".to_string())?;
        guard.remove(&account_id);
    }

    let mut phase_urls: Vec<&str> = vec![mode.console_url.as_str()];
    if let Some(secondary) = mode.console_url_secondary.as_ref() {
        phase_urls.push(secondary.as_str());
    }
    if let Some(tertiary) = mode.console_url_tertiary.as_ref() {
        phase_urls.push(tertiary.as_str());
    }

    let phase_count = phase_urls.len();
    let mut ready_for_last_phase = None;
    let mut last_interceptor_page_url = String::new();
    let mut explicit_login_page_url = None;

    'phases: for (phase_index, phase_url) in phase_urls.into_iter().enumerate() {
        if !interactive && scrape_interaction_required(&state, &account_id)? {
            break;
        }
        let expected_slots =
            scrape_console::required_slots_for_phase(&mode, phase_index, phase_count);
        let phase_started_at = std::time::Instant::now();
        tracing::info!(
            account_id = %account_id,
            channel_id = %channel_id,
            phase = phase_index + 1,
            phases = phase_count,
            page_url = %phase_url,
            ?expected_slots,
            "开始控制台抓取阶段"
        );
        // 每个阶段重新等待本页面的拦截器 ACK(导航会触发新 document 注入拦截器)。
        {
            let mut guard = state
                .scrape_ready
                .lock()
                .map_err(|_| "锁定抓取监听状态失败".to_string())?;
            guard.remove(&account_id);
        }
        {
            let guard = state
                .scrape_webviews
                .lock()
                .map_err(|_| "锁定抓取 webview 失败".to_string())?;
            let window = guard.get(&account_id).ok_or("抓取 webview 不存在")?;
            let url = phase_url
                .parse()
                .map_err(|error| format!("控制台 URL 解析失败: {error}"))?;
            window
                .navigate(url)
                .map_err(|error| format!("刷新控制台失败: {error}"))?;
        }
        last_interceptor_page_url = phase_url.to_string();

        // 4. 先等当前 document 的监听 ACK。响应可能先于 ACK 回传，因此完整响应也可直接
        // 作为监听已生效的证据。这里超时只说明监听/页面初始化失败，不代表未登录。
        let ready_deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let ready = loop {
            if let Some(page_url) = current_scrape_page_url(&state, &account_id)? {
                if is_explicit_login_url(&channel_id, &page_url) {
                    explicit_login_page_url = Some(page_url);
                    break None;
                }
            }
            if !interactive && scrape_interaction_required(&state, &account_id)? {
                break None;
            }
            if has_complete_scrape_capture(&state, &account_id, &mode)? {
                break Some(crate::core::scrape_console::ScrapeInterceptorReady {
                    document_id: "captured-response".to_string(),
                    page_url: phase_url.to_string(),
                });
            }
            if native_scrape_capture_ready(&state, &account_id)? {
                break Some(crate::core::scrape_console::ScrapeInterceptorReady {
                    document_id: "native-webview-listener".to_string(),
                    page_url: phase_url.to_string(),
                });
            }
            if let Some(ready) = scrape_interceptor_ready(&state, &account_id)? {
                break Some(ready);
            }
            // 任意槽位已捕获也可作为监听已生效的证据(多阶段模式下全量聚合此时尚未齐备)。
            if collect_scrape_slots(&state, &account_id)?
                .keys()
                .next()
                .is_some()
            {
                break Some(crate::core::scrape_console::ScrapeInterceptorReady {
                    document_id: "captured-slot".to_string(),
                    page_url: phase_url.to_string(),
                });
            }
            if std::time::Instant::now() >= ready_deadline {
                break None;
            }
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        };
        ready_for_last_phase = ready.clone();
        if explicit_login_page_url.is_some()
            || (!interactive && scrape_interaction_required(&state, &account_id)?)
        {
            break 'phases;
        }

        // 5. 监听就绪后等待本阶段明确需要的响应。不能以“出现任意新槽位”作为
        //    完成条件：LongCat 页面会产生大量 usage 页面/埋点响应，Qwen 的三个接口
        //    也可能相差几十毫秒到达。
        if ready.is_some() {
            let capture_deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
            while std::time::Instant::now() < capture_deadline {
                if let Some(page_url) = current_scrape_page_url(&state, &account_id)? {
                    if is_explicit_login_url(&channel_id, &page_url) {
                        explicit_login_page_url = Some(page_url);
                        break;
                    }
                }
                if !interactive && scrape_interaction_required(&state, &account_id)? {
                    break;
                }
                let slots = collect_scrape_slots(&state, &account_id)?;
                let phase_complete = if expected_slots.is_empty() {
                    !slots.is_empty()
                } else {
                    expected_slots.iter().all(|slot| slots.contains_key(slot))
                };
                if phase_complete {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            }
        }
        if explicit_login_page_url.is_some()
            || (!interactive && scrape_interaction_required(&state, &account_id)?)
        {
            break 'phases;
        }

        let slots = collect_scrape_slots(&state, &account_id)?;
        let captured_kinds = slots.keys().cloned().collect::<Vec<_>>();
        let missing_phase_slots = scrape_console::missing_required_slots(&slots, &expected_slots);
        if missing_phase_slots.is_empty() {
            tracing::info!(
                account_id = %account_id,
                channel_id = %channel_id,
                phase = phase_index + 1,
                phases = phase_count,
                elapsed_ms = phase_started_at.elapsed().as_millis() as u64,
                ?expected_slots,
                ?captured_kinds,
                "控制台抓取阶段完成"
            );
        } else {
            tracing::warn!(
                account_id = %account_id,
                channel_id = %channel_id,
                phase = phase_index + 1,
                phases = phase_count,
                elapsed_ms = phase_started_at.elapsed().as_millis() as u64,
                page_url = %phase_url,
                ?expected_slots,
                ?missing_phase_slots,
                ?captured_kinds,
                "控制台抓取阶段等待目标响应超时"
            );
        }
    }

    let ready = ready_for_last_phase;
    let captured = has_complete_scrape_capture(&state, &account_id, &mode)?;
    let current_page_url = explicit_login_page_url
        .or(current_scrape_page_url(&state, &account_id)?)
        .or_else(|| {
            ready
                .as_ref()
                .map(|value| value.page_url.clone())
                .or_else(|| {
                    (!last_interceptor_page_url.is_empty()).then_some(last_interceptor_page_url)
                })
        })
        .unwrap_or_default();
    let probe_state = if captured {
        ScrapeProbeState::Captured
    } else if is_explicit_login_url(&channel_id, &current_page_url) {
        ScrapeProbeState::LoginRequired
    } else if ready.is_some() {
        ScrapeProbeState::ConsoleActionRequired
    } else {
        ScrapeProbeState::CaptureTimeout
    };
    if matches!(
        probe_state,
        ScrapeProbeState::LoginRequired | ScrapeProbeState::ConsoleActionRequired
    ) {
        // 后台轮次首次发现登录失效/需要人工处理后也要记住该状态，后续周期直接
        // 跳过，直到用户手动刷新并完整抓取成功。
        set_scrape_interaction_required(&state, &account_id, true)?;
    }

    let captured_slots = collect_scrape_slots(&state, &account_id)?;
    let captured_kinds = captured_slots.keys().cloned().collect::<Vec<_>>();
    let missing_slots =
        scrape_console::missing_required_slots(&captured_slots, &mode.required_slots);
    if matches!(
        probe_state,
        ScrapeProbeState::ConsoleActionRequired | ScrapeProbeState::CaptureTimeout
    ) {
        tracing::warn!(
            account_id = %account_id,
            channel_id = %channel_id,
            native_ready = native_scrape_capture_ready(&state, &account_id)?,
            interceptor_ready = ready.is_some(),
            ready_document_id = ready.as_ref().map(|value| value.document_id.as_str()),
            current_page_url = %current_page_url,
            ?captured_kinds,
            ?missing_slots,
            "控制台刷新后未捕获到完整业务响应"
        );
    }

    let missing_hint = if missing_slots.is_empty() {
        String::new()
    } else {
        format!("（缺少：{}）", missing_slots.join(", "))
    };

    let status = ScrapeLoginStatus {
        is_logged_in: probe_state == ScrapeProbeState::Captured,
        channel_id,
        account_hint: None,
        probe_state,
        message: match probe_state {
            ScrapeProbeState::Captured => None,
            ScrapeProbeState::LoginRequired => Some(if interactive {
                "检测到控制台登录页，请在弹出的窗口中完成登录。".to_string()
            } else {
                "控制台登录状态已失效，本轮自动同步已跳过。请手动刷新并重新登录。".to_string()
            }),
            ScrapeProbeState::ConsoleActionRequired => Some(if interactive {
                format!(
                    "未捕获到完整套餐接口响应{missing_hint}，已打开控制台窗口。请在窗口中完成登录或等待页面加载后，再重新抓取。"
                )
            } else {
                format!(
                    "未捕获到完整套餐接口响应{missing_hint}，本轮自动同步已跳过。请手动刷新检查控制台。"
                )
            }),
            ScrapeProbeState::CaptureTimeout => {
                Some("控制台页面监听初始化失败，请重新抓取。".to_string())
            }
        },
    };

    // 明确进入登录页时必须展示窗口；监听已就绪但业务接口没有触发时，也展示控制台
    // 供用户完成登录、验证码或等待页面加载。后者是 console_action_required，
    // 不声称用户未登录。
    if interactive
        && matches!(
            status.probe_state,
            ScrapeProbeState::LoginRequired | ScrapeProbeState::ConsoleActionRequired
        )
    {
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
pub(crate) async fn scrape_balance(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    account_id: String,
    interactive: Option<bool>,
) -> Result<ScrapeBalanceResult, String> {
    let interactive = interactive.unwrap_or(true);
    if !interactive && scrape_interaction_required(&state, &account_id)? {
        return Err("账号正在等待控制台登录或人工处理，本轮自动同步已跳过".to_string());
    }
    // 1. 解析模式配置。
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
        resolve_scrape_mode(
            &config,
            &account.channel_id,
            account.resource_mode.as_deref(),
        )
        .ok_or("该账号所属渠道不支持控制台抓取")?
    };

    // 2. 前端通常已调用 probe_scrape_login 完成一次“清缓冲 → 刷新 → 捕获”。
    // 直接调用本 command 时若没有完整响应，则在这里执行同一流程一次。
    if !has_complete_scrape_capture(&state, &account_id, &mode)? {
        let login_status = probe_scrape_login(
            app.clone(),
            state.clone(),
            account_id.clone(),
            Some(interactive),
        )
        .await?;
        match login_status.probe_state {
            ScrapeProbeState::Captured => {}
            ScrapeProbeState::LoginRequired => {
                return Err(if interactive {
                    "请先登录官方控制台（已弹出登录窗口）".to_string()
                } else {
                    "控制台登录状态已失效，请手动刷新并重新登录".to_string()
                });
            }
            ScrapeProbeState::ConsoleActionRequired | ScrapeProbeState::CaptureTimeout => {
                return Err(login_status
                    .message
                    .unwrap_or_else(|| "未捕获到控制台业务响应，请重试".to_string()));
            }
        }
    }

    // 3. 消费 probe 阶段捕获的同一批响应，不再二次刷新页面。
    let slots = collect_scrape_slots(&state, &account_id)?;
    if !scrape_console::aggregate_complete(&slots, &mode) {
        return Err("未收到完整的控制台业务响应，请重试".to_string());
    }
    if let Ok(mut guard) = state.scrape_pending.lock() {
        guard.remove(&account_id);
    }

    // 4. 执行 extractor
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
        let raw = slots.get(target_key).ok_or("未找到目标响应")?;
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
            let window = guard.get(&account_id).ok_or("抓取 webview 不存在")?;
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
    let mut parsed: serde_json::Value = serde_json::from_str(&raw_result)
        .map_err(|e| format!("extractor 输出解析失败: {e}, raw={raw_result}"))?;
    // WebView2 会把 JS 字符串返回值再次 JSON 序列化；兼容配置中返回
    // JSON.stringify(...) 的 extractor，避免把结果误判成普通字符串。
    if let Some(encoded) = parsed.as_str() {
        parsed = serde_json::from_str(encoded)
            .map_err(|e| format!("extractor 字符串结果解析失败: {e}, raw={raw_result}"))?;
    }
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
    let extracted_token_packs = parsed
        .get("token_packs")
        .filter(|value| value.is_array())
        .and_then(|value| serde_json::to_string(value).ok());
    let token_packs = merge_longcat_token_packs(&slots, extracted_token_packs.as_deref());

    let now = chrono::Utc::now().to_rfc3339();
    let raw_scraped_json = if mode.aggregate {
        serde_json::to_string(&scrape_console::build_aggregate_bundle(&slots)).ok()
    } else {
        let target_key = if mode.console_url.contains("tab=api") {
            "api_usage_summary"
        } else {
            "token_packs_summary"
        };
        slots.get(target_key).cloned()
    };

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
        token_packs: token_packs.clone(),
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

    // 9. 返回前端；调用方通过 command 返回值更新状态。
    let result = ScrapeBalanceResult {
        balance,
        currency,
        plan_name,
        token_total,
        token_used,
        token_remaining,
        token_pack_expire_at: token_pack_expire_at.clone(),
        token_packs,
        raw_scraped_json,
        source: "scrape".to_string(),
        synced_at: now,
    };
    // 10. 登录态由 per-account WebView 数据目录持久化，不需要保活浏览器进程。
    // 完整抓取成功后立即关闭窗口；下次同步按需重建，避免隐藏 WebView 长期占用
    // renderer / GPU / network 等 WebView2 子进程。
    if interactive {
        set_scrape_interaction_required(&state, &account_id, false)?;
    }
    if let Err(error) = close_scrape_console(state.clone(), account_id.clone()).await {
        tracing::warn!(
            account_id = %account_id,
            error = %error,
            "抓取成功后关闭 WebView 失败"
        );
    }

    Ok(result)
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrapeBalanceSyncResult {
    pub started: bool,
    pub job_id: Option<String>,
    pub accounts: usize,
    pub synced: usize,
    pub failed: usize,
    pub message: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ChannelResourceSyncMethod {
    OfficialApi,
    ConsoleScrape,
}

impl ChannelResourceSyncMethod {
    fn label(self) -> &'static str {
        match self {
            Self::OfficialApi => "官方余额 API",
            Self::ConsoleScrape => "官方控制台",
        }
    }
}

/// 官方余额 API 账号默认周期同步；控制台抓取账号仍由 resource_sync_mode 控制。
/// 自定义 Base URL 无法保证官方余额接口语义，与手动刷新和保存后刷新保持一致地跳过。
fn channel_resource_sync_method(
    config: &ChannelsConfig,
    account: &ChannelAccount,
) -> Option<ChannelResourceSyncMethod> {
    if !account.enabled {
        return None;
    }

    let supports_official_balance = matches!(account.channel_id.as_str(), "deepseek" | "kimi")
        && config
            .presets
            .iter()
            .find(|preset| preset.id == account.channel_id)
            .is_some_and(|preset| preset.supports_balance_query)
        && account.effective_openai_base_url().is_none();
    if supports_official_balance {
        return Some(ChannelResourceSyncMethod::OfficialApi);
    }

    (account.resource_sync_mode == "auto"
        && resolve_scrape_mode(
            config,
            &account.channel_id,
            account.resource_mode.as_deref(),
        )
        .is_some())
    .then_some(ChannelResourceSyncMethod::ConsoleScrape)
}

fn channel_resource_sync_completion_status(failed: usize, skipped: usize) -> &'static str {
    if failed > 0 || skipped > 0 {
        "succeeded_with_warnings"
    } else {
        "succeeded"
    }
}

/// 周期同步渠道资源：DeepSeek / Kimi 使用官方余额 API，LongCat / Qwen 等
/// 控制台渠道使用隐藏 WebView。后台抓取遇到登录失效或页面需要交互时只记入
/// 任务日志，等待用户从账号编辑页手动刷新处理。
#[tauri::command]
pub(crate) async fn sync_scrape_balances(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    trigger_source: String,
) -> Result<ScrapeBalanceSyncResult, String> {
    let accounts = {
        let accounts = state
            .accounts
            .lock()
            .map_err(|_| "读取账号失败".to_string())?;
        let config = state
            .channels_config
            .lock()
            .map_err(|_| "锁定渠道配置失败".to_string())?;
        accounts
            .iter()
            .filter_map(|account| {
                let method = channel_resource_sync_method(&config, account)?;
                let channel_name = config
                    .presets
                    .iter()
                    .find(|preset| preset.id == account.channel_id)
                    .map(|preset| preset.name.clone())
                    .unwrap_or_else(|| account.channel_id.clone());
                Some((
                    account.id.clone(),
                    account.name.clone(),
                    account.channel_id.clone(),
                    channel_name,
                    account.resource_mode.clone(),
                    method,
                ))
            })
            .collect::<Vec<_>>()
    };

    if accounts.is_empty() {
        return Ok(ScrapeBalanceSyncResult {
            started: false,
            job_id: None,
            accounts: 0,
            synced: 0,
            failed: 0,
            message: "没有可自动同步的渠道资源账号".to_string(),
        });
    }
    if CHANNEL_RESOURCE_SYNC_RUNNING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Ok(ScrapeBalanceSyncResult {
            started: false,
            job_id: None,
            accounts: accounts.len(),
            synced: 0,
            failed: 0,
            message: "已有渠道资源自动同步正在运行".to_string(),
        });
    }
    let _guard = ChannelResourceSyncGuard;
    let started_at = std::time::Instant::now();
    let job_id = uuid::Uuid::new_v4().to_string();
    state
        .storage
        .create_job(
            &job_id,
            "channel-resource-sync",
            "渠道资源自动同步",
            "同步账号资源",
            &trigger_source,
            accounts.len(),
            &format!("开始同步 {} 个启用自动同步的渠道账号", accounts.len()),
        )
        .map_err(|error| format!("创建渠道资源同步任务失败：{error}"))?;

    let mut synced = 0usize;
    let mut failed = 0usize;
    let mut skipped = 0usize;
    for (index, (account_id, account_name, channel_id, channel_name, resource_mode, method)) in
        accounts.iter().enumerate()
    {
        let account_suffix = account_id.rsplit('-').next().unwrap_or(account_id);
        let account_label = format!("{channel_name} · {account_name} · {account_suffix}");
        tracing::info!(
            job_id = %job_id,
            account_id = %account_id,
            account_name = %account_name,
            channel_id = %channel_id,
            channel_name = %channel_name,
            resource_mode = ?resource_mode,
            sync_method = method.label(),
            "开始同步渠道账号资源"
        );
        if *method == ChannelResourceSyncMethod::ConsoleScrape
            && scrape_interaction_required(&state, account_id)?
        {
            skipped += 1;
            let _ = state.storage.add_job_event(
                &job_id,
                "warning",
                "跳过账号资源同步",
                &format!("{account_label} 正在等待登录或人工处理，本轮已跳过"),
            );
            let _ = state.storage.update_job_progress(
                &job_id,
                (index + 1) as i64,
                accounts.len() as i64,
            );
            continue;
        }
        let sync_result = match method {
            ChannelResourceSyncMethod::OfficialApi => {
                match query_balance(state.clone(), account_id.clone()).await {
                    Ok(result) => match result.error {
                        Some(error) => Err(error),
                        None if result.is_available => Ok(()),
                        None => Err("官方余额接口当前不可用".to_string()),
                    },
                    Err(error) => Err(error),
                }
            }
            ChannelResourceSyncMethod::ConsoleScrape => {
                let result =
                    scrape_balance(app.clone(), state.clone(), account_id.clone(), Some(false))
                        .await
                        .map(|_| ());
                // 后台任务逐账号串行执行。无论成功、登录失效还是抓取超时，本轮使用的
                // 隐藏 WebView 都应在切换到下一个账号前关闭；需要人工登录的状态由
                // scrape_interaction_required 单独记录，不依赖浏览器进程常驻。
                if let Err(error) = close_scrape_console(state.clone(), account_id.clone()).await {
                    tracing::warn!(
                        account_id = %account_id,
                        error = %error,
                        "后台抓取结束后关闭 WebView 失败"
                    );
                }
                result
            }
        };
        match sync_result {
            Ok(_) => {
                synced += 1;
                let _ = state.storage.add_job_event(
                    &job_id,
                    "info",
                    "同步账号资源",
                    &format!("{account_label} 通过{}同步成功", method.label()),
                );
            }
            Err(error) => {
                failed += 1;
                let _ = state.storage.add_job_event(
                    &job_id,
                    "warning",
                    "同步账号资源",
                    &format!("{account_label} 通过{}同步失败：{error}", method.label()),
                );
            }
        }
        let _ =
            state
                .storage
                .update_job_progress(&job_id, (index + 1) as i64, accounts.len() as i64);
    }

    let duration_ms = started_at.elapsed().as_millis() as u64;
    let official_api_accounts = accounts
        .iter()
        .filter(|account| account.5 == ChannelResourceSyncMethod::OfficialApi)
        .count();
    let console_accounts = accounts.len() - official_api_accounts;
    let summary = serde_json::json!({
        "accounts": accounts.len(),
        "officialApiAccounts": official_api_accounts,
        "consoleAccounts": console_accounts,
        "syncedAccounts": synced,
        "failedAccounts": failed,
        "skippedAccounts": skipped,
        "durationMs": duration_ms,
    })
    .to_string();
    state
        .storage
        .finish_job(
            &job_id,
            channel_resource_sync_completion_status(failed, skipped),
            &summary,
            &format!(
                "渠道资源同步完成：成功 {synced} 个，失败 {failed} 个，跳过 {} 个",
                skipped
            ),
        )
        .map_err(|error| format!("完成渠道资源同步任务失败：{error}"))?;

    Ok(ScrapeBalanceSyncResult {
        started: true,
        job_id: Some(job_id),
        accounts: accounts.len(),
        synced,
        failed,
        message: format!(
            "渠道资源同步完成：成功 {synced} 个，失败 {failed} 个，跳过 {} 个",
            skipped
        ),
    })
}
