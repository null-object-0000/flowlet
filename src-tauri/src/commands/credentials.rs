//! 三方服务凭据的管理命令。
//!
//! 桌面 Host 与 Web Host 共用 `core::service_credentials` 的实现：
//! - 桌面：这些 `#[tauri::command]` 直接暴露给前端；
//! - Web：`core/web/commands.rs` 的白名单把同名命令转发到同一套逻辑。
//!
//! 管理接口只返回掩码视图；明文只在 `export_service_credentials`（供
//! `flowlet-cred pull`）里出现，且同样需要管理凭据。

use crate::core::service_credentials::{
    self, CredentialCheck, CredentialProvider, ServiceCredentialExport, ServiceCredentialInput,
    ServiceCredentialView,
};
use crate::AppState;

#[tauri::command]
pub(crate) fn list_credential_providers() -> Vec<CredentialProvider> {
    service_credentials::providers()
}

#[tauri::command]
pub(crate) fn list_service_credentials(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<ServiceCredentialView>, String> {
    service_credentials::list(&state.services)
}

#[tauri::command]
pub(crate) async fn save_service_credential(
    state: tauri::State<'_, AppState>,
    input: ServiceCredentialInput,
    insecure: Option<bool>,
) -> Result<ServiceCredentialView, String> {
    service_credentials::save(&state.services, input, insecure.unwrap_or(false)).await
}

#[tauri::command]
pub(crate) async fn test_service_credential(
    state: tauri::State<'_, AppState>,
    id: String,
    insecure: Option<bool>,
) -> Result<CredentialCheck, String> {
    service_credentials::test(&state.services, &id, insecure.unwrap_or(false)).await
}

#[tauri::command]
pub(crate) fn delete_service_credential(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    service_credentials::delete(&state.services, &id)
}

#[tauri::command]
pub(crate) fn export_service_credentials(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<ServiceCredentialExport>, String> {
    service_credentials::export(&state.services)
}
