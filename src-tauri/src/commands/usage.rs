use crate::core::config::{AgentNativeUsageSummaryRow, UsageSummaryRow, UsageTodaySummary};
use crate::AppState;
use chrono::DateTime;

#[tauri::command]
pub(crate) fn analyze_usage(state: tauri::State<'_, AppState>) -> Result<usize, String> {
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
pub(crate) fn repair_agent_sessions(
    state: tauri::State<'_, AppState>,
    time_range: String,
) -> Result<crate::core::config::AgentSessionRepairResult, String> {
    let ua_rules = crate::core::proxy::load_config_ua_rules(&state.config_path);
    state
        .storage
        .repair_agent_sessions(&time_range, &ua_rules)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(crate) async fn repair_captured_usage(
    state: tauri::State<'_, AppState>,
    time_range: String,
) -> Result<usize, String> {
    let storage = state.storage.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let captured = storage.reanalyze_captured_usage(&time_range)?;
        let native = storage.repair_usage_from_native_sessions(&time_range)?;
        Ok::<_, crate::core::storage::StorageError>(captured + native)
    })
    .await
    .map_err(|error| format!("Token 用量修复任务失败：{error}"))?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn repair_unknown_usage(
    state: tauri::State<'_, AppState>,
    time_range: String,
) -> Result<usize, String> {
    state
        .storage
        .analyze_unknown_usage(&time_range)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(crate) fn repair_usage_costs(
    state: tauri::State<'_, AppState>,
    time_range: String,
) -> Result<usize, String> {
    state
        .storage
        .recalculate_usage_costs(&time_range)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub(crate) async fn usage_summary(
    state: tauri::State<'_, AppState>,
    start_at: Option<String>,
    end_at: Option<String>,
    group_by: String,
) -> Result<Vec<UsageSummaryRow>, String> {
    if !matches!(group_by.as_str(), "hour" | "day") {
        return Err(format!("不支持的用量分组粒度：{group_by}"));
    }
    match (&start_at, &end_at) {
        (None, None) => {}
        (Some(start), Some(end)) => {
            let start_value = DateTime::parse_from_rfc3339(start)
                .map_err(|_| "用量统计开始时间格式无效".to_string())?;
            let end_value = DateTime::parse_from_rfc3339(end)
                .map_err(|_| "用量统计结束时间格式无效".to_string())?;
            if start_value >= end_value {
                return Err("用量统计开始时间必须早于结束时间".to_string());
            }
        }
        _ => return Err("用量统计开始时间和结束时间必须同时提供".to_string()),
    }
    let storage = state.storage.clone();
    let current_device_id = state
        .device_identity
        .lock()
        .map_err(|_| "读取当前设备身份失败".to_string())?
        .device_id
        .clone();
    tauri::async_runtime::spawn_blocking(move || {
        storage.usage_summary_range(
            start_at.as_deref(),
            end_at.as_deref(),
            &group_by,
            &current_device_id,
        )
    })
    .await
    .map_err(|err| format!("读取用量统计任务失败：{err}"))?
    .map_err(|err| err.to_string())
}

#[tauri::command]
pub(crate) async fn agent_native_usage_summary(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<AgentNativeUsageSummaryRow>, String> {
    let storage = state.storage.clone();
    tauri::async_runtime::spawn_blocking(move || storage.agent_native_usage_summary())
        .await
        .map_err(|err| format!("读取 Agent 原生用量任务失败：{err}"))?
        .map_err(|err| err.to_string())
}

/// 概览页「今日消耗」专用：返回今日 Token 聚合（总量 + 输入/缓存/输出拆解），
/// 供 service-strip 悬浮明细展示总消耗、缓存命中率与输入/输出拆解。
/// 使用 `async fn` 避免同步命令占用 Tauri 主线程；底层查询走索引范围
/// 扫描、不带分组、不带 JOIN，持锁时间极短，不会卡住窗口拖动。
#[tauri::command]
pub(crate) async fn usage_today_tokens(
    state: tauri::State<'_, AppState>,
) -> Result<UsageTodaySummary, String> {
    state
        .storage
        .usage_today_summary()
        .map_err(|err| err.to_string())
}
