use crate::core::config::{ChannelAccount, ProxyBindConfig};
use crate::core::proxy::ProxyStatus;
use crate::core::sync::test_channel_connection;
use crate::{update_tray_tooltip, AppState};
use tauri::AppHandle;

#[tauri::command]
pub(crate) async fn start_proxy(
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
pub(crate) async fn stop_proxy(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    state.services.stop_proxy().await?;
    update_tray_tooltip(&app, false);
    Ok(())
}

#[tauri::command]
pub(crate) fn proxy_status(state: tauri::State<'_, AppState>) -> ProxyStatus {
    let mut status = state.proxy.status();
    if !status.running {
        if let Ok(config) = state.bind_config.lock() {
            status.bind_addr = config.clone().normalized().bind_addr();
        }
    }
    status
}

#[tauri::command]
pub(crate) async fn test_connection(
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
pub(crate) fn get_proxy_bind_config(
    state: tauri::State<'_, AppState>,
) -> Result<ProxyBindConfig, String> {
    state
        .bind_config
        .lock()
        .map(|guard| guard.clone().normalized())
        .map_err(|_| "读取代理监听配置失败".to_string())
}

#[tauri::command]
pub(crate) fn set_proxy_bind_config(
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
    state.services.set_bind_config(config)
}
