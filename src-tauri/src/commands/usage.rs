use crate::core::config::{AgentNativeUsageSummaryRow, UsageSummaryRow, UsageTodaySummary};
use crate::AppState;

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
pub(crate) fn repair_captured_usage(
    state: tauri::State<'_, AppState>,
    time_range: String,
) -> Result<usize, String> {
    state
        .storage
        .reanalyze_captured_usage(&time_range)
        .map_err(|err| err.to_string())
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
    period: String,
) -> Result<Vec<UsageSummaryRow>, String> {
    if !matches!(
        period.as_str(),
        "all" | "year" | "quarter" | "month" | "week" | "today"
    ) {
        return Err(format!("不支持的用量统计周期：{period}"));
    }
    let storage = state.storage.clone();
    tauri::async_runtime::spawn_blocking(move || storage.usage_summary(&period))
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
