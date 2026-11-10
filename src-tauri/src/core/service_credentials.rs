//! 三方服务凭据：类型、校验与业务编排。
//!
//! 凭据的明文只在保存/校验/导出时短暂出现在内存里；落库的是 `secret_box` 加密后的
//! 密文 + 一个用于界面展示的掩码后缀。桌面 Tauri command 与 Web 管理白名单共用这里
//! 的实现，避免两套 Host 各写一份业务逻辑。

use super::gitlab::{normalize_base_url, GitlabClient};
use super::services::FlowletServices;
use super::storage::StorageError;
use serde::{Deserialize, Serialize};

pub const PROVIDER_GITLAB: &str = "gitlab";

/// 列表 / 详情视图：**不含明文密钥**。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServiceCredentialView {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub base_url: String,
    pub kind: String,
    pub note: Option<String>,
    pub enabled: bool,
    /// 例如 `••••1a2b`，只用于界面确认是不是那把 token。
    pub secret_hint: String,
    pub created_at: String,
    pub updated_at: String,
    pub last_verified_at: Option<String>,
    pub last_error: Option<String>,
}

/// 保存入参。`token` 为空表示“保持原值”（编辑场景），新建时必须提供。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceCredentialInput {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub provider: String,
    pub base_url: String,
    #[serde(default)]
    pub token: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub enabled: Option<bool>,
}

/// 校验结果（保存与手动测试共用）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CredentialCheck {
    pub ok: bool,
    pub username: Option<String>,
    pub version: Option<String>,
    pub error: Option<String>,
}

/// 供 `flowlet-cred pull` 使用的导出项（含明文，只在已鉴权的管理接口返回）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServiceCredentialExport {
    pub name: String,
    pub provider: String,
    pub base_url: String,
    pub token: String,
}

/// 前端渲染表单用的 provider 元数据；新增服务类型时在这里登记。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CredentialProvider {
    pub id: String,
    pub label: String,
    /// 例如 `https://gitlab.example.com`。
    pub base_url_hint: String,
    pub token_label: String,
    pub available: bool,
}

pub fn providers() -> Vec<CredentialProvider> {
    vec![CredentialProvider {
        id: PROVIDER_GITLAB.to_string(),
        label: "GitLab".to_string(),
        base_url_hint: "https://gitlab.example.com".to_string(),
        token_label: "Personal Access Token（需要 api scope）".to_string(),
        available: true,
    }]
}

pub fn is_supported_provider(provider: &str) -> bool {
    provider == PROVIDER_GITLAB
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// 展示用掩码：保留最后 4 位，其余用圆点。
pub fn mask_secret(secret: &str) -> String {
    let chars: Vec<char> = secret.chars().collect();
    if chars.len() <= 4 {
        return "••••".to_string();
    }
    let tail: String = chars.iter().skip(chars.len() - 4).collect();
    format!("••••{tail}")
}

pub fn to_view(row: &crate::core::storage::ServiceCredentialRow) -> ServiceCredentialView {
    ServiceCredentialView {
        id: row.id.clone(),
        name: row.name.clone(),
        provider: row.provider.clone(),
        base_url: row.base_url.clone(),
        kind: row.kind.clone(),
        note: row.note.clone(),
        enabled: row.enabled,
        secret_hint: row.secret_hint.clone(),
        created_at: row.created_at.clone(),
        updated_at: row.updated_at.clone(),
        last_verified_at: row.last_verified_at.clone(),
        last_error: row.last_error.clone(),
    }
}

pub fn list(services: &FlowletServices) -> Result<Vec<ServiceCredentialView>, String> {
    services
        .storage
        .list_service_credentials()
        .map(|rows| rows.iter().map(to_view).collect())
        .map_err(|error| error.to_string())
}

/// 校验一个 GitLab 凭据；返回结构化结果而不是直接抛错，便于界面展示。
pub async fn check_gitlab(base_url: &str, token: &str, insecure: bool) -> CredentialCheck {
    let client = match GitlabClient::new(base_url, token) {
        Ok(client) => client.with_insecure(insecure),
        Err(error) => {
            return CredentialCheck {
                ok: false,
                username: None,
                version: None,
                error: Some(error),
            }
        }
    };
    match client.current_user().await {
        Ok(user) => {
            let username = user
                .get("username")
                .and_then(|value| value.as_str())
                .map(str::to_string);
            let version = client.version().await.ok().flatten();
            CredentialCheck {
                ok: true,
                username,
                version,
                error: None,
            }
        }
        Err(error) => CredentialCheck {
            ok: false,
            username: None,
            version: None,
            error: Some(error.to_string()),
        },
    }
}

pub async fn save(
    services: &FlowletServices,
    input: ServiceCredentialInput,
    insecure: bool,
) -> Result<ServiceCredentialView, String> {
    let name = input.name.trim();
    if name.is_empty() {
        return Err("凭据名称不能为空".to_string());
    }
    if name.chars().count() > 64 {
        return Err("凭据名称不能超过 64 个字符".to_string());
    }
    if !is_supported_provider(&input.provider) {
        return Err(format!(
            "暂不支持的服务类型：{}（当前只支持 gitlab）",
            input.provider
        ));
    }
    let base_url = normalize_base_url(&input.base_url)?;
    let kind = input
        .kind
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("cli_token")
        .to_string();

    let existing = match input.id.as_deref() {
        Some(id) => Some(
            services
                .storage
                .get_service_credential(id)
                .map_err(|error| error.to_string())?
                .ok_or_else(|| format!("凭据不存在：{id}"))?,
        ),
        None => None,
    };
    let provided_token = input
        .token
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let token = match (&provided_token, &existing) {
        (Some(token), _) => token.clone(),
        (None, Some(row)) => services
            .secrets
            .decrypt(&row.secret_ciphertext)
            .map_err(|error| format!("原凭据无法解密：{error}"))?,
        (None, None) => return Err("新建凭据时必须填写 token".to_string()),
    };

    // 先验证再落库：token 无效或实例不可达时不写坏数据。
    let check = check_gitlab(&base_url, &token, insecure).await;
    if !check.ok {
        return Err(format!(
            "校验失败，未保存：{}",
            check.error.unwrap_or_else(|| "未知错误".to_string())
        ));
    }
    let verified_at = now();
    let ciphertext = services
        .secrets
        .encrypt(&token)
        .map_err(|error| format!("加密凭据失败：{error}"))?;
    let timestamp = now();
    let row = crate::core::storage::ServiceCredentialRow {
        id: input
            .id
            .clone()
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        name: name.to_string(),
        provider: input.provider.clone(),
        base_url: base_url.clone(),
        secret_ciphertext: ciphertext,
        secret_hint: mask_secret(&token),
        kind,
        note: input
            .note
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
        enabled: input.enabled.unwrap_or(true),
        created_at: existing
            .as_ref()
            .map(|row| row.created_at.clone())
            .unwrap_or_else(|| timestamp.clone()),
        updated_at: timestamp,
        last_verified_at: Some(verified_at),
        last_error: None,
    };
    services
        .storage
        .upsert_service_credential(&row)
        .map_err(|error| error.to_string())?;
    Ok(to_view(&row))
}

pub async fn test(
    services: &FlowletServices,
    id: &str,
    insecure: bool,
) -> Result<CredentialCheck, String> {
    let row = services
        .storage
        .get_service_credential(id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("凭据不存在：{id}"))?;
    let token = services
        .secrets
        .decrypt(&row.secret_ciphertext)
        .map_err(|error| format!("凭据无法解密：{error}"))?;
    if row.provider != PROVIDER_GITLAB {
        return Err(format!("暂不支持测试该服务类型：{}", row.provider));
    }
    let check = check_gitlab(&row.base_url, &token, insecure).await;
    let verified_at = if check.ok { Some(now()) } else { None };
    services
        .storage
        .update_service_credential_verification(id, verified_at.as_deref(), check.error.as_deref())
        .map_err(|error| error.to_string())?;
    Ok(check)
}

pub fn delete(services: &FlowletServices, id: &str) -> Result<(), String> {
    let removed = services
        .storage
        .delete_service_credential(id)
        .map_err(|error| error.to_string())?;
    if removed {
        Ok(())
    } else {
        Err(format!("凭据不存在：{id}"))
    }
}

/// `flowlet-cred pull` 的导出：默认只导出启用中的凭据。
pub fn export(services: &FlowletServices) -> Result<Vec<ServiceCredentialExport>, String> {
    let rows = services
        .storage
        .list_service_credentials()
        .map_err(|error| error.to_string())?;
    let mut exports = Vec::new();
    for row in rows.iter().filter(|row| row.enabled) {
        let token = services
            .secrets
            .decrypt(&row.secret_ciphertext)
            .map_err(|error| format!("凭据 {} 无法解密：{error}", row.name))?;
        exports.push(ServiceCredentialExport {
            name: row.name.clone(),
            provider: row.provider.clone(),
            base_url: row.base_url.clone(),
            token,
        });
    }
    Ok(exports)
}

/// 供 CLI 拉取时把服务凭据映射成 dotenv 键名。新增服务类型时在这里登记约定。
pub fn env_keys(export: &ServiceCredentialExport) -> Vec<(String, String, &'static str)> {
    match export.provider.as_str() {
        PROVIDER_GITLAB => vec![
            ("GITLAB_URL".to_string(), export.base_url.clone(), "service"),
            (
                "GITLAB_TOKEN".to_string(),
                export.token.clone(),
                "cli_token",
            ),
        ],
        _ => Vec::new(),
    }
}

pub fn to_storage_error(error: StorageError) -> String {
    error.to_string()
}
