//! 千问平台（Qwen Platform）HTTP 通道命令。
//!
//! 面向「千问 API 按量付费」账号：通过官方 CLI 的 device flow 授权，
//! 再用 HTTP 直连 BssOpenAPI 拉取余额与各模型免费额度，替代隐藏 WebView
//! 控制台抓取。核心实现在 `core::qwen_platform`。

use crate::core::qwen_platform::{LoginChallenge, LoginPoll, PlatformStatus, PlatformSyncOutcome};
use crate::AppState;

#[tauri::command]
pub(crate) fn qwen_platform_status(
    state: tauri::State<'_, AppState>,
    account_id: String,
) -> Result<PlatformStatus, String> {
    crate::core::qwen_platform::status(&state.services, &account_id)
}

/// 发起 device flow：返回浏览器授权地址与轮询间隔。前端负责打开浏览器。
#[tauri::command]
pub(crate) async fn qwen_platform_login_start(
    state: tauri::State<'_, AppState>,
    account_id: String,
) -> Result<LoginChallenge, String> {
    crate::core::qwen_platform::start_login(&state.services, &account_id).await
}

/// 轮询授权结果；`complete` 时凭据已落盘，可直接调用同步。
#[tauri::command]
pub(crate) async fn qwen_platform_login_poll(
    state: tauri::State<'_, AppState>,
    account_id: String,
) -> Result<LoginPoll, String> {
    crate::core::qwen_platform::poll_login(&state.services, &account_id).await
}

#[tauri::command]
pub(crate) fn qwen_platform_logout(
    state: tauri::State<'_, AppState>,
    account_id: String,
) -> Result<(), String> {
    crate::core::qwen_platform::logout(&state.services, &account_id)
}

/// 立即通过 HTTP 同步余额与免费额度，并写入余额快照。
#[tauri::command]
pub(crate) async fn qwen_platform_sync(
    state: tauri::State<'_, AppState>,
    account_id: String,
) -> Result<PlatformSyncOutcome, String> {
    crate::core::qwen_platform::sync_account(&state.services, &account_id).await
}

/// 桌面端打开外部浏览器（device flow 授权页）。只允许 http(s)，避免任意协议唤起。
#[tauri::command]
pub(crate) fn open_external_url(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if !(trimmed.starts_with("https://") || trimmed.starts_with("http://")) {
        return Err("只允许打开 http(s) 地址".to_string());
    }
    tauri_plugin_opener::open_url(trimmed, None::<&str>)
        .map_err(|error| format!("无法打开浏览器：{error}"))
}
