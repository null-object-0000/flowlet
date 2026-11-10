//! 三方服务凭据：类型、校验与业务编排。
//!
//! 凭据的明文只在保存/校验/导出时短暂出现在内存里；落库的是 `secret_box` 加密后的
//! 密文 + 一个用于界面展示的掩码后缀。桌面 Tauri command 与 Web 管理白名单共用这里
//! 的实现，避免两套 Host 各写一份业务逻辑。

use super::beszel::{parse_info_version as beszel_info_version, BeszelClient};
use super::dockhand::DockhandClient;
use super::gitlab::GitlabClient;
use super::jenkins::JenkinsClient;
use super::services::FlowletServices;
use super::storage::StorageError;
use super::uptime_kuma::UptimeKumaClient;
use serde::{Deserialize, Serialize};

pub const PROVIDER_GITLAB: &str = "gitlab";
pub const PROVIDER_DOCKHAND: &str = "dockhand";
pub const PROVIDER_JENKINS: &str = "jenkins";
pub const PROVIDER_UPTIME_KUMA: &str = "uptime-kuma";
pub const PROVIDER_BESZEL: &str = "beszel";

/// 环境变量名前缀默认值：`GITLAB_URL` / `DOCKHAND_URL` / `JENKINS_URL` /
/// `UPTIME_KUMA_URL` / `BESZEL_URL`（与第一期行为一致）。
pub const DEFAULT_ENV_PREFIX_GITLAB: &str = "GITLAB";
pub const DEFAULT_ENV_PREFIX_DOCKHAND: &str = "DOCKHAND";
pub const DEFAULT_ENV_PREFIX_JENKINS: &str = "JENKINS";
pub const DEFAULT_ENV_PREFIX_UPTIME_KUMA: &str = "UPTIME_KUMA";
pub const DEFAULT_ENV_PREFIX_BESZEL: &str = "BESZEL";

/// 列表 / 详情视图：**不含明文密钥**。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServiceCredentialView {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub base_url: String,
    /// 用户名（明文，不是密文）：jenkins 存用户名、beszel 存登录邮箱；
    /// 其它 provider 恒为 `None`。
    pub username: Option<String>,
    /// 已解析的环境前缀（旧行按 provider 默认值返回），前端直接展示。
    pub env_prefix: String,
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
    /// 用户名：jenkins 为用户登录名、beszel 为登录邮箱；其它 provider 忽略。
    /// 编辑时传空/未传表示保留原值。
    #[serde(default)]
    pub username: Option<String>,
    /// 环境前缀；空/NULL 表示使用 provider 默认前缀。
    #[serde(default)]
    pub env_prefix: Option<String>,
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
    /// 额外的人类可读摘要，例如 Dockhand 的「2 个环境」；GitLab 恒为 `None`。
    pub detail: Option<String>,
    pub error: Option<String>,
}

/// 供 `flowlet-cred pull` 使用的导出项（含明文，只在已鉴权的管理接口返回）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServiceCredentialExport {
    pub name: String,
    pub provider: String,
    pub base_url: String,
    /// Jenkins 用户名；GitLab/Dockhand 恒为 `None`。
    /// `#[serde(default)]` 兼容尚未升级的服务端响应。
    #[serde(default)]
    pub username: Option<String>,
    /// 已解析的环境前缀；`#[serde(default)]` 兼容第一期（无该字段）的服务端响应，
    /// 缺省时 `env_keys` 回退到 provider 默认前缀。
    #[serde(default)]
    pub env_prefix: String,
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
    /// 需要用户名一起认证时给出输入框标签（Jenkins 为 `Some("用户名")`）；
    /// GitLab/Dockhand 为 `None`，前端不渲染用户名字段。
    #[serde(default)]
    pub username_label: Option<String>,
    /// 未填环境前缀时使用的默认值（前端做 placeholder / 预览）。
    pub default_env_prefix: String,
    pub available: bool,
}

pub fn providers() -> Vec<CredentialProvider> {
    vec![
        CredentialProvider {
            id: PROVIDER_GITLAB.to_string(),
            label: "GitLab".to_string(),
            base_url_hint: "https://gitlab.example.com".to_string(),
            token_label: "Personal Access Token（需要 api scope）".to_string(),
            username_label: None,
            default_env_prefix: DEFAULT_ENV_PREFIX_GITLAB.to_string(),
            available: true,
        },
        CredentialProvider {
            id: PROVIDER_DOCKHAND.to_string(),
            label: "Dockhand".to_string(),
            base_url_hint: "http://dockhand.example.com:3000".to_string(),
            token_label: "API Token（Dockhand 设置 → API 令牌）".to_string(),
            username_label: None,
            default_env_prefix: DEFAULT_ENV_PREFIX_DOCKHAND.to_string(),
            available: true,
        },
        CredentialProvider {
            id: PROVIDER_JENKINS.to_string(),
            label: "Jenkins".to_string(),
            base_url_hint: "https://jenkins.example.com".to_string(),
            token_label: "API Token（Jenkins 用户设置 → API Token）".to_string(),
            username_label: Some("用户名".to_string()),
            default_env_prefix: DEFAULT_ENV_PREFIX_JENKINS.to_string(),
            available: true,
        },
        CredentialProvider {
            id: PROVIDER_UPTIME_KUMA.to_string(),
            label: "Uptime Kuma".to_string(),
            base_url_hint: "https://uptime-kuma.example.com/uptime-kuma".to_string(),
            token_label: "API Key（设置 → API 密钥；仅用于读取 /metrics 指标）".to_string(),
            username_label: None,
            default_env_prefix: DEFAULT_ENV_PREFIX_UPTIME_KUMA.to_string(),
            available: true,
        },
        CredentialProvider {
            id: PROVIDER_BESZEL.to_string(),
            label: "Beszel".to_string(),
            base_url_hint: "http://beszel.example.com:8090".to_string(),
            token_label: "登录密码（Beszel 用户密码）".to_string(),
            username_label: Some("邮箱".to_string()),
            default_env_prefix: DEFAULT_ENV_PREFIX_BESZEL.to_string(),
            available: true,
        },
    ]
}

pub fn is_supported_provider(provider: &str) -> bool {
    matches!(
        provider,
        PROVIDER_GITLAB
            | PROVIDER_DOCKHAND
            | PROVIDER_JENKINS
            | PROVIDER_UPTIME_KUMA
            | PROVIDER_BESZEL
    )
}

/// provider 的默认环境前缀：gitlab → `GITLAB`、dockhand → `DOCKHAND`、
/// jenkins → `JENKINS`、uptime-kuma → `UPTIME_KUMA`、beszel → `BESZEL`。
/// 保存/测试路径会先做 provider 校验；这里对旧库中可能存在的未知 provider 行回退成
/// provider 名的大写（与 Node Host 的 `defaultEnvPrefix` 逐字对齐）。
pub fn default_env_prefix(provider: &str) -> String {
    match provider {
        PROVIDER_GITLAB => DEFAULT_ENV_PREFIX_GITLAB.to_string(),
        PROVIDER_DOCKHAND => DEFAULT_ENV_PREFIX_DOCKHAND.to_string(),
        PROVIDER_JENKINS => DEFAULT_ENV_PREFIX_JENKINS.to_string(),
        PROVIDER_UPTIME_KUMA => DEFAULT_ENV_PREFIX_UPTIME_KUMA.to_string(),
        PROVIDER_BESZEL => DEFAULT_ENV_PREFIX_BESZEL.to_string(),
        other => other.trim().to_uppercase(),
    }
}

/// 归一环境前缀：`raw` 为空时用 provider 默认值，否则 trim + ASCII 大写后校验
/// `^[A-Z][A-Z0-9_]{0,23}$`。长度按 UTF-8 字节计（与 Node 的
/// `Buffer.byteLength(upper, "utf8")` 对齐），保证两套 Host 的报错分支一致。
pub fn normalize_env_prefix(raw: &str, provider: &str) -> Result<String, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(default_env_prefix(provider));
    }
    let upper = raw.to_ascii_uppercase();
    if upper.len() > 24 {
        return Err("环境前缀不能超过 24 个字符".to_string());
    }
    if !is_valid_env_prefix(&upper) {
        return Err("环境前缀只能包含字母、数字和下划线，且以字母开头".to_string());
    }
    Ok(upper)
}

fn is_valid_env_prefix(prefix: &str) -> bool {
    let mut chars = prefix.chars();
    match chars.next() {
        Some(first) if first.is_ascii_uppercase() => {}
        _ => return false,
    }
    chars.all(|ch| ch.is_ascii_uppercase() || ch.is_ascii_digit() || ch == '_')
}

/// 读取行上解析后的环境前缀：新写入的行存的是归一后的大写前缀；旧行为 NULL，
/// 按 provider 默认值解析，因此升级后行为与第一期一致（与 Node Host 的
/// `resolveEnvPrefix` 保持一致：非空就原样返回，不做二次归一）。
pub fn resolve_env_prefix(row: &crate::core::storage::ServiceCredentialRow) -> String {
    row.env_prefix
        .as_deref()
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| default_env_prefix(&row.provider))
}

/// 已启用凭据之间解析后的前缀必须唯一（不同 provider 也算冲突，因为生成的环境
/// 变量名相同）。`self_id` 用于编辑时排除自身；`enabled=false` 的行 pull 会跳过，
/// 不参与检查。
pub fn validate_env_prefix_conflict(
    rows: &[crate::core::storage::ServiceCredentialRow],
    self_id: Option<&str>,
    provider: &str,
    raw_prefix: &str,
) -> Result<(), String> {
    let prefix = normalize_env_prefix(raw_prefix, provider)?;
    for row in rows.iter().filter(|row| row.enabled) {
        if Some(row.id.as_str()) == self_id {
            continue;
        }
        if resolve_env_prefix(row) == prefix {
            return Err(format!(
                "环境前缀已被「{}」占用：{prefix}（同一前缀会生成相同的环境变量名）",
                row.name
            ));
        }
    }
    Ok(())
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

/// 归一保存入参的 username（契约 §3.2）：
/// - gitlab / dockhand / uptime-kuma：忽略入参，恒落库 `NULL`；
/// - jenkins：trim 后必须非空（编辑时传空表示保留原值）、不超过 64 个字符、
///   且不能含冒号/空白/控制字符（Basic 认证用 `:` 分隔，含冒号会改变凭据含义）；
/// - beszel：trim 后必须是登录邮箱（编辑时传空表示保留原值）、不超过 254 个字符，
///   且含 `@` 且格式基本合法（邮箱是 PocketBase 的登录身份，不是可选的展示名）。
pub fn normalize_username(
    provider: &str,
    raw: Option<&str>,
    existing: Option<&str>,
) -> Result<Option<String>, String> {
    match provider {
        PROVIDER_JENKINS => normalize_jenkins_username(raw, existing),
        PROVIDER_BESZEL => normalize_beszel_email(raw, existing),
        _ => Ok(None),
    }
}

fn normalize_jenkins_username(
    raw: Option<&str>,
    existing: Option<&str>,
) -> Result<Option<String>, String> {
    let trimmed = raw.map(str::trim).unwrap_or_default();
    if trimmed.is_empty() {
        let fallback = existing.map(str::trim).unwrap_or_default();
        if fallback.is_empty() {
            return Err("Jenkins 需要填写用户名（API Token 必须与用户名一起认证）".to_string());
        }
        validate_jenkins_username(fallback)?;
        return Ok(Some(fallback.to_string()));
    }
    validate_jenkins_username(trimmed)?;
    Ok(Some(trimmed.to_string()))
}

fn validate_jenkins_username(username: &str) -> Result<(), String> {
    if username.chars().count() > 64 {
        return Err("Jenkins 用户名不能超过 64 个字符".to_string());
    }
    if username
        .chars()
        .any(|ch| ch == ':' || ch.is_whitespace() || (ch as u32) < 0x20)
    {
        return Err("Jenkins 用户名不能包含冒号、空格或控制字符".to_string());
    }
    Ok(())
}

/// beszel 的 username 就是登录邮箱：trim、编辑时空值回退原邮箱、必填。
fn normalize_beszel_email(
    raw: Option<&str>,
    existing: Option<&str>,
) -> Result<Option<String>, String> {
    let trimmed = raw.map(str::trim).unwrap_or_default();
    let candidate = if trimmed.is_empty() {
        existing.map(str::trim).unwrap_or_default()
    } else {
        trimmed
    };
    if candidate.is_empty() {
        return Err("Beszel 需要填写邮箱（登录 Beszel 用邮箱 + 密码）".to_string());
    }
    validate_beszel_email(candidate)?;
    Ok(Some(candidate.to_string()))
}

/// 邮箱格式的「基本合法」校验（不用引入完整 RFC 5322 正则）：
/// 长度不超过 254 字符、恰好一个 `@`、本地部分与域名都非空、
/// 域名至少含一个 `.` 且不以 `.` 开头/结尾、不含空白或连续 `..`。
fn validate_beszel_email(email: &str) -> Result<(), String> {
    if email.chars().count() > 254 {
        return Err("Beszel 邮箱不能超过 254 个字符".to_string());
    }
    let mut parts = email.split('@');
    let local = parts.next().unwrap_or_default();
    let domain = parts.next().unwrap_or_default();
    let has_extra_at = parts.next().is_some();
    let invalid = has_extra_at
        || local.is_empty()
        || domain.is_empty()
        || local.chars().any(char::is_whitespace)
        || domain
            .chars()
            .any(|ch| ch.is_whitespace() || ch == '@' || (ch as u32) < 0x20)
        || !domain.contains('.')
        || domain.starts_with('.')
        || domain.ends_with('.')
        || domain.contains("..");
    if invalid {
        return Err("Beszel 邮箱格式不正确（例如：you@example.com）".to_string());
    }
    Ok(())
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
        username: row.username.clone(),
        env_prefix: resolve_env_prefix(row),
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
                detail: None,
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
                detail: None,
                error: None,
            }
        }
        Err(error) => CredentialCheck {
            ok: false,
            username: None,
            version: None,
            detail: None,
            error: Some(error.to_string()),
        },
    }
}

/// 校验一个 Dockhand 凭据；返回结构化结果而不是直接抛错，便于界面展示。
///
/// `/health` 匿名可访问，不能用来校验 token；`/environments` 是唯一稳定且能确认
/// 凭据有效的端点。Dockhand 没有「当前 token 用户」接口，因此 username/version 恒空，
/// 用环境数量作为 detail 供界面 toast 展示。
pub async fn check_dockhand(base_url: &str, token: &str, insecure: bool) -> CredentialCheck {
    let client = match DockhandClient::new(base_url, token) {
        Ok(client) => client.with_insecure(insecure),
        Err(error) => {
            return CredentialCheck {
                ok: false,
                username: None,
                version: None,
                detail: None,
                error: Some(error),
            }
        }
    };
    match client.environments().await {
        Ok(environments) => CredentialCheck {
            ok: true,
            username: None,
            version: None,
            detail: Some(format!("{} 个环境", environments.len())),
            error: None,
        },
        Err(error) => CredentialCheck {
            ok: false,
            username: None,
            version: None,
            detail: None,
            error: Some(error.to_string()),
        },
    }
}

/// 校验一个 Jenkins 凭据；返回结构化结果而不是直接抛错，便于界面展示。
///
/// `/me/api/json` 同时确认用户名与 API Token：Jenkins 的 token 必须与用户名一起
/// 用 Basic 认证，单独校验 token 没有意义。版本取 `X-Jenkins` 响应头。
pub async fn check_jenkins(
    base_url: &str,
    username: &str,
    token: &str,
    insecure: bool,
) -> CredentialCheck {
    let client = match JenkinsClient::new(base_url, username, token) {
        Ok(client) => client.with_insecure(insecure),
        Err(error) => {
            return CredentialCheck {
                ok: false,
                username: None,
                version: None,
                detail: None,
                error: Some(error),
            }
        }
    };
    match client.identity().await {
        Ok(identity) => CredentialCheck {
            ok: true,
            username: identity.username,
            version: identity.version,
            detail: None,
            error: None,
        },
        Err(error) => CredentialCheck {
            ok: false,
            username: None,
            version: None,
            detail: None,
            error: Some(error.to_string()),
        },
    }
}

/// 校验一个 Uptime Kuma 凭据；返回结构化结果而不是直接抛错，便于界面展示。
///
/// 2.x 没有监控管理 REST API，`/metrics` 是唯一能确认 API Key 的端点；
/// `/metrics` 用 Basic 认证（用户名空、密码为 Key）。版本取内部构建版本
/// `app_version{version="0.0.28"}`，监控数量与 up/down 作为 detail。
pub async fn check_uptime_kuma(base_url: &str, token: &str, insecure: bool) -> CredentialCheck {
    let client = match UptimeKumaClient::new(base_url, token) {
        Ok(client) => client.with_insecure(insecure),
        Err(error) => {
            return CredentialCheck {
                ok: false,
                username: None,
                version: None,
                detail: None,
                error: Some(error),
            }
        }
    };
    match client.metrics().await {
        Ok(metrics) => {
            let detail = Some(metrics.summarize());
            CredentialCheck {
                ok: true,
                username: None,
                version: metrics.version,
                detail,
                error: None,
            }
        }
        Err(error) => CredentialCheck {
            ok: false,
            username: None,
            version: None,
            detail: None,
            error: Some(error.to_string()),
        },
    }
}

/// 校验一个 Beszel 凭据；返回结构化结果而不是直接抛错，便于界面展示。
///
/// Beszel 没有长期 API Token：先用邮箱 + 密码换短期 token，`auth` 失败即判定失败；
/// Hub 版本取 `/api/beszel/info` 的 `v`（失败不致命，版本留空）；系统数量取
/// `/api/collections/systems/records?perPage=1` 的 `totalItems`（失败即失败）。
/// 校验通过时 username 取认证记录里的邮箱（缺失回退入参邮箱），detail 为「N 台系统」。
pub async fn check_beszel(
    base_url: &str,
    email: &str,
    password: &str,
    insecure: bool,
) -> CredentialCheck {
    let client = match BeszelClient::new(base_url, email, password) {
        Ok(client) => client.with_insecure(insecure),
        Err(error) => {
            return CredentialCheck {
                ok: false,
                username: None,
                version: None,
                detail: None,
                error: Some(error),
            }
        }
    };
    let auth = match client.auth().await {
        Ok(auth) => auth,
        Err(error) => {
            return CredentialCheck {
                ok: false,
                username: None,
                version: None,
                detail: None,
                error: Some(error.to_string()),
            }
        }
    };
    // info 失败不致命：版本缺失不影响凭据可用性判断。
    let version = client
        .info()
        .await
        .ok()
        .as_ref()
        .and_then(beszel_info_version);
    let systems = match client.systems_count().await {
        Ok(total) => total,
        Err(error) => {
            return CredentialCheck {
                ok: false,
                username: None,
                version: None,
                detail: None,
                error: Some(error.to_string()),
            }
        }
    };
    CredentialCheck {
        ok: true,
        username: auth
            .email
            .clone()
            .or_else(|| Some(client.email().to_string())),
        version,
        detail: Some(format!("{systems} 台系统")),
        error: None,
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
            "暂不支持的服务类型：{}（当前支持 gitlab、dockhand、jenkins、uptime-kuma、beszel）",
            input.provider
        ));
    }
    let base_url = match input.provider.as_str() {
        PROVIDER_GITLAB => super::gitlab::normalize_base_url(&input.base_url)?,
        PROVIDER_JENKINS => super::jenkins::normalize_base_url(&input.base_url)?,
        PROVIDER_UPTIME_KUMA => super::uptime_kuma::normalize_base_url(&input.base_url)?,
        PROVIDER_BESZEL => super::beszel::normalize_base_url(&input.base_url)?,
        _ => super::dockhand::normalize_base_url(&input.base_url)?,
    };
    let env_prefix = normalize_env_prefix(
        input.env_prefix.as_deref().unwrap_or_default(),
        &input.provider,
    )?;
    let enabled = input.enabled.unwrap_or(true);
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
    // 非 jenkins 的 username 一律落 NULL；jenkins 编辑时空值表示保留原行用户名。
    let username = normalize_username(
        &input.provider,
        input.username.as_deref(),
        existing.as_ref().and_then(|row| row.username.as_deref()),
    )?;

    // 前缀冲突属于本地配置错误，先于网络校验返回，避免用户等一轮超时。
    if enabled {
        let rows = services
            .storage
            .list_service_credentials()
            .map_err(|error| error.to_string())?;
        validate_env_prefix_conflict(
            &rows,
            existing.as_ref().map(|row| row.id.as_str()),
            &input.provider,
            input.env_prefix.as_deref().unwrap_or_default(),
        )?;
    }

    // 先验证再落库：token 无效或实例不可达时不写坏数据。
    let check = match input.provider.as_str() {
        PROVIDER_GITLAB => check_gitlab(&base_url, &token, insecure).await,
        PROVIDER_JENKINS => {
            check_jenkins(
                &base_url,
                username.as_deref().unwrap_or_default(),
                &token,
                insecure,
            )
            .await
        }
        PROVIDER_UPTIME_KUMA => check_uptime_kuma(&base_url, &token, insecure).await,
        PROVIDER_BESZEL => {
            check_beszel(
                &base_url,
                username.as_deref().unwrap_or_default(),
                &token,
                insecure,
            )
            .await
        }
        _ => check_dockhand(&base_url, &token, insecure).await,
    };
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
        env_prefix: Some(env_prefix),
        username,
        enabled,
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
    let check = match row.provider.as_str() {
        PROVIDER_GITLAB => check_gitlab(&row.base_url, &token, insecure).await,
        PROVIDER_DOCKHAND => check_dockhand(&row.base_url, &token, insecure).await,
        PROVIDER_JENKINS => {
            check_jenkins(
                &row.base_url,
                row.username.as_deref().unwrap_or_default(),
                &token,
                insecure,
            )
            .await
        }
        PROVIDER_UPTIME_KUMA => check_uptime_kuma(&row.base_url, &token, insecure).await,
        PROVIDER_BESZEL => {
            check_beszel(
                &row.base_url,
                row.username.as_deref().unwrap_or_default(),
                &token,
                insecure,
            )
            .await
        }
        provider => return Err(format!("暂不支持测试该服务类型：{provider}")),
    };
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
            username: row.username.clone(),
            env_prefix: resolve_env_prefix(row),
            token,
        });
    }
    Ok(exports)
}

/// 供 CLI 拉取时把服务凭据映射成 dotenv 键名：
/// - 非 jenkins/beszel：`{PREFIX}_URL` / `{PREFIX}_TOKEN`（顺序与第二期一致）；
/// - jenkins：`{PREFIX}_URL` / `{PREFIX}_USER` / `{PREFIX}_TOKEN`，USER 取导出的
///   `username`（缺失时为空串）；
/// - uptime-kuma：`{PREFIX}_URL` / `{PREFIX}_API_KEY`（它的 Key 只用于 `/metrics`
///   鉴权，沿用公司 infra skill 已有的 `UPTIME_KUMA_API_KEY` 命名）；
/// - beszel：`{PREFIX}_URL` / `{PREFIX}_EMAIL` / `{PREFIX}_PASSWORD`，EMAIL 取导出的
///   `username`（缺失时为空串），PASSWORD 是登录密码（Beszel 没有长期 API Token）。
/// 未登记的 provider 返回空，pull 侧跳过。
pub fn env_keys(export: &ServiceCredentialExport) -> Vec<(String, String, &'static str)> {
    if !is_supported_provider(&export.provider) {
        return Vec::new();
    }
    // 旧服务端（第一期）的导出没有 envPrefix，回退到 provider 默认前缀，
    // 这样 Rust legacy CLI 对旧 Host 仍然可用。
    let prefix = match export.env_prefix.trim() {
        "" => default_env_prefix(&export.provider),
        raw => raw.to_string(),
    };
    if export.provider == PROVIDER_JENKINS {
        return vec![
            (format!("{prefix}_URL"), export.base_url.clone(), "service"),
            (
                format!("{prefix}_USER"),
                export.username.clone().unwrap_or_default(),
                "service",
            ),
            (format!("{prefix}_TOKEN"), export.token.clone(), "cli_token"),
        ];
    }
    if export.provider == PROVIDER_BESZEL {
        return vec![
            (format!("{prefix}_URL"), export.base_url.clone(), "service"),
            (
                format!("{prefix}_EMAIL"),
                export.username.clone().unwrap_or_default(),
                "service",
            ),
            (
                format!("{prefix}_PASSWORD"),
                export.token.clone(),
                "cli_token",
            ),
        ];
    }
    let token_key = if export.provider == PROVIDER_UPTIME_KUMA {
        format!("{prefix}_API_KEY")
    } else {
        format!("{prefix}_TOKEN")
    };
    vec![
        (format!("{prefix}_URL"), export.base_url.clone(), "service"),
        (token_key, export.token.clone(), "cli_token"),
    ]
}

pub fn to_storage_error(error: StorageError) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_providers_in_contract_order() {
        let listed = providers();
        let ids: Vec<&str> = listed.iter().map(|provider| provider.id.as_str()).collect();
        assert_eq!(
            ids,
            vec![
                PROVIDER_GITLAB,
                PROVIDER_DOCKHAND,
                PROVIDER_JENKINS,
                PROVIDER_UPTIME_KUMA,
                PROVIDER_BESZEL
            ]
        );
        assert_eq!(listed[0].label, "GitLab");
        assert_eq!(listed[1].label, "Dockhand");
        assert_eq!(listed[2].label, "Jenkins");
        assert_eq!(listed[3].label, "Uptime Kuma");
        assert_eq!(listed[4].label, "Beszel");
        assert_eq!(listed[1].base_url_hint, "http://dockhand.example.com:3000");
        assert_eq!(listed[0].default_env_prefix, DEFAULT_ENV_PREFIX_GITLAB);
        assert_eq!(listed[1].default_env_prefix, DEFAULT_ENV_PREFIX_DOCKHAND);
        assert_eq!(listed[2].default_env_prefix, DEFAULT_ENV_PREFIX_JENKINS);
        assert_eq!(listed[3].default_env_prefix, DEFAULT_ENV_PREFIX_UPTIME_KUMA);
        assert_eq!(listed[4].default_env_prefix, DEFAULT_ENV_PREFIX_BESZEL);
        assert_eq!(listed[2].base_url_hint, "https://jenkins.example.com");
        assert_eq!(
            listed[2].token_label,
            "API Token（Jenkins 用户设置 → API Token）"
        );
        assert_eq!(
            listed[3].base_url_hint,
            "https://uptime-kuma.example.com/uptime-kuma"
        );
        assert_eq!(
            listed[3].token_label,
            "API Key（设置 → API 密钥；仅用于读取 /metrics 指标）"
        );
        assert_eq!(listed[4].base_url_hint, "http://beszel.example.com:8090");
        assert_eq!(listed[4].token_label, "登录密码（Beszel 用户密码）");
        // 需要用户名一起认证的 provider 才渲染用户名字段：Jenkins 是「用户名」，
        // Beszel 是「邮箱」；GitLab/Dockhand/Uptime Kuma 不渲染。
        assert_eq!(listed[0].username_label, None);
        assert_eq!(listed[1].username_label, None);
        assert_eq!(listed[2].username_label.as_deref(), Some("用户名"));
        assert_eq!(listed[3].username_label, None);
        assert_eq!(listed[4].username_label.as_deref(), Some("邮箱"));
        assert!(listed.iter().all(|provider| provider.available));

        // 前端依赖 camelCase 的 usernameLabel；None 序列化成 null。
        let values = serde_json::to_value(listed).unwrap();
        assert_eq!(values[0]["usernameLabel"], serde_json::Value::Null);
        assert_eq!(values[2]["usernameLabel"], "用户名");
        assert_eq!(values[4]["usernameLabel"], "邮箱");
    }

    #[test]
    fn recognizes_supported_providers_only() {
        assert!(is_supported_provider(PROVIDER_GITLAB));
        assert!(is_supported_provider(PROVIDER_DOCKHAND));
        assert!(is_supported_provider(PROVIDER_JENKINS));
        assert!(is_supported_provider(PROVIDER_UPTIME_KUMA));
        assert!(is_supported_provider(PROVIDER_BESZEL));
        assert!(!is_supported_provider("github"));
        assert!(!is_supported_provider(""));
        // 前端下拉的 id 是精确匹配，大小写/空白都不能被当成支持。
        assert!(!is_supported_provider("Dockhand"));
        assert!(!is_supported_provider(" dockhand "));
        assert!(!is_supported_provider("Jenkins"));
        assert!(!is_supported_provider(" jenkins "));
        assert!(!is_supported_provider("Uptime Kuma"));
        assert!(!is_supported_provider(" uptime-kuma "));
        assert!(!is_supported_provider("Beszel"));
        assert!(!is_supported_provider(" beszel "));
    }

    #[test]
    fn normalizes_jenkins_username_like_contract() {
        // 非 jenkins：忽略入参，恒为 NULL。
        assert_eq!(
            normalize_username(PROVIDER_GITLAB, Some("alice"), Some("bob")),
            Ok(None)
        );
        assert_eq!(
            normalize_username(PROVIDER_DOCKHAND, Some("alice"), None),
            Ok(None)
        );

        // jenkins 新建：trim 后必须非空。
        assert_eq!(
            normalize_username(PROVIDER_JENKINS, Some("  alice  "), None),
            Ok(Some("alice".to_string()))
        );
        assert_eq!(
            normalize_username(PROVIDER_JENKINS, None, None).unwrap_err(),
            "Jenkins 需要填写用户名（API Token 必须与用户名一起认证）"
        );
        assert_eq!(
            normalize_username(PROVIDER_JENKINS, Some("   "), None).unwrap_err(),
            "Jenkins 需要填写用户名（API Token 必须与用户名一起认证）"
        );

        // jenkins 编辑：空值保留原行用户名；原行也没有则报空用户名错误。
        assert_eq!(
            normalize_username(PROVIDER_JENKINS, None, Some("alice")),
            Ok(Some("alice".to_string()))
        );
        assert_eq!(
            normalize_username(PROVIDER_JENKINS, Some(""), Some("alice")),
            Ok(Some("alice".to_string()))
        );
        assert_eq!(
            normalize_username(PROVIDER_JENKINS, Some("  "), Some("alice")),
            Ok(Some("alice".to_string()))
        );
        assert_eq!(
            normalize_username(PROVIDER_JENKINS, None, Some("   ")).unwrap_err(),
            "Jenkins 需要填写用户名（API Token 必须与用户名一起认证）"
        );

        // 64 个字符是上限（按字符数，不是字节数）。
        assert!(normalize_username(PROVIDER_JENKINS, Some(&"a".repeat(64)), None).is_ok());
        assert_eq!(
            normalize_username(PROVIDER_JENKINS, Some(&"a".repeat(65)), None).unwrap_err(),
            "Jenkins 用户名不能超过 64 个字符"
        );
        assert!(
            normalize_username(PROVIDER_JENKINS, Some(&"名".repeat(64)), None).is_ok(),
            "长度按字符数而不是 UTF-8 字节数"
        );

        // 冒号（Basic 认证分隔符）、空白、控制字符一律拒绝。
        for invalid in ["ali:ce", "ali ce", "ali\tce", "ali\nce", "ali\u{0}ce"] {
            assert_eq!(
                normalize_username(PROVIDER_JENKINS, Some(invalid), None).unwrap_err(),
                "Jenkins 用户名不能包含冒号、空格或控制字符"
            );
        }
        // 中文、点、下划线、@ 等常规字符允许。
        for valid in ["用户名", "alice.wang", "alice_wang", "alice@example.com"] {
            assert_eq!(
                normalize_username(PROVIDER_JENKINS, Some(valid), None),
                Ok(Some(valid.to_string()))
            );
        }
    }

    #[test]
    fn normalizes_beszel_email_like_contract() {
        // gitlab / dockhand / uptime-kuma：忽略入参，恒为 NULL。
        assert_eq!(
            normalize_username(PROVIDER_GITLAB, Some("you@example.com"), Some("old@example.com")),
            Ok(None)
        );
        assert_eq!(
            normalize_username(PROVIDER_UPTIME_KUMA, Some("you@example.com"), None),
            Ok(None)
        );

        // beszel 新建：trim 后必须是邮箱。
        assert_eq!(
            normalize_username(PROVIDER_BESZEL, Some("  you@example.com  "), None),
            Ok(Some("you@example.com".to_string()))
        );
        assert_eq!(
            normalize_username(PROVIDER_BESZEL, None, None).unwrap_err(),
            "Beszel 需要填写邮箱（登录 Beszel 用邮箱 + 密码）"
        );
        assert_eq!(
            normalize_username(PROVIDER_BESZEL, Some("   "), None).unwrap_err(),
            "Beszel 需要填写邮箱（登录 Beszel 用邮箱 + 密码）"
        );

        // beszel 编辑：空值保留原邮箱；原行也没有则报空邮箱错误。
        assert_eq!(
            normalize_username(PROVIDER_BESZEL, None, Some("old@example.com")),
            Ok(Some("old@example.com".to_string()))
        );
        assert_eq!(
            normalize_username(PROVIDER_BESZEL, Some("  "), Some("old@example.com")),
            Ok(Some("old@example.com".to_string()))
        );
        assert_eq!(
            normalize_username(PROVIDER_BESZEL, None, Some("   ")).unwrap_err(),
            "Beszel 需要填写邮箱（登录 Beszel 用邮箱 + 密码）"
        );

        // 254 个字符是上限（按字符数）。
        let long_valid = format!("{}@example.com", "a".repeat(254 - "@example.com".len()));
        assert_eq!(
            normalize_username(PROVIDER_BESZEL, Some(&long_valid), None)
                .unwrap()
                .unwrap()
                .chars()
                .count(),
            254
        );
        let too_long = format!("{}@example.com", "a".repeat(255 - "@example.com".len()));
        assert_eq!(
            normalize_username(PROVIDER_BESZEL, Some(&too_long), None).unwrap_err(),
            "Beszel 邮箱不能超过 254 个字符"
        );

        // 基本格式校验：必须恰好一个 @、本地部分与域名都非空、域名至少含一个点。
        for invalid in [
            "you",
            "@example.com",
            "you@",
            "you@@example.com",
            "you@example",
            "you@.example.com",
            "you@example.com.",
            "you@exam..ple.com",
            "you @example.com",
        ] {
            assert_eq!(
                normalize_username(PROVIDER_BESZEL, Some(invalid), None).unwrap_err(),
                "Beszel 邮箱格式不正确（例如：you@example.com）",
                "invalid email accepted: {invalid}"
            );
        }
        // 常见合法形态（大写、加号、多级域名）允许。
        for valid in [
            "You@Example.com",
            "you+beszel@example.com",
            "you@mon.example.com",
        ] {
            assert_eq!(
                normalize_username(PROVIDER_BESZEL, Some(valid), None),
                Ok(Some(valid.to_string()))
            );
        }
    }

    fn export(provider: &str, env_prefix: &str) -> ServiceCredentialExport {
        ServiceCredentialExport {
            name: "公司面板".to_string(),
            provider: provider.to_string(),
            base_url: "http://host:3000".to_string(),
            username: None,
            env_prefix: env_prefix.to_string(),
            token: "fixture-token".to_string(),
        }
    }

    fn row(
        id: &str,
        name: &str,
        provider: &str,
        env_prefix: Option<&str>,
        enabled: bool,
    ) -> crate::core::storage::ServiceCredentialRow {
        crate::core::storage::ServiceCredentialRow {
            id: id.to_string(),
            name: name.to_string(),
            provider: provider.to_string(),
            base_url: "http://host:3000".to_string(),
            secret_ciphertext: "v1:fake".to_string(),
            secret_hint: "••••fake".to_string(),
            kind: "cli_token".to_string(),
            note: None,
            env_prefix: env_prefix.map(str::to_string),
            username: None,
            enabled,
            created_at: "2026-11-10T00:00:00Z".to_string(),
            updated_at: "2026-11-10T00:00:00Z".to_string(),
            last_verified_at: None,
            last_error: None,
        }
    }

    #[test]
    fn maps_export_to_env_keys_per_provider() {
        let gitlab = env_keys(&export(PROVIDER_GITLAB, ""));
        assert_eq!(
            gitlab,
            vec![
                (
                    "GITLAB_URL".to_string(),
                    "http://host:3000".to_string(),
                    "service"
                ),
                (
                    "GITLAB_TOKEN".to_string(),
                    "fixture-token".to_string(),
                    "cli_token"
                ),
            ]
        );
        let dockhand = env_keys(&export(PROVIDER_DOCKHAND, ""));
        assert_eq!(
            dockhand,
            vec![
                (
                    "DOCKHAND_URL".to_string(),
                    "http://host:3000".to_string(),
                    "service"
                ),
                (
                    "DOCKHAND_TOKEN".to_string(),
                    "fixture-token".to_string(),
                    "cli_token"
                ),
            ]
        );
        // 多实例：同一 provider 用不同前缀生成不同变量名。
        let north_america = env_keys(&export(PROVIDER_DOCKHAND, "DOCKHAND_NA"));
        assert_eq!(north_america[0].0, "DOCKHAND_NA_URL");
        assert_eq!(north_america[1].0, "DOCKHAND_NA_TOKEN");
        // 未登记的 provider 不导出任何键，pull 侧会跳过。
        assert!(env_keys(&export("unknown", "")).is_empty());
    }

    #[test]
    fn maps_jenkins_export_to_three_env_keys() {
        let mut jenkins = export(PROVIDER_JENKINS, "");
        jenkins.base_url = "https://jenkins.example.com".to_string();
        jenkins.username = Some("alice".to_string());
        assert_eq!(
            env_keys(&jenkins),
            vec![
                (
                    "JENKINS_URL".to_string(),
                    "https://jenkins.example.com".to_string(),
                    "service"
                ),
                ("JENKINS_USER".to_string(), "alice".to_string(), "service"),
                (
                    "JENKINS_TOKEN".to_string(),
                    "fixture-token".to_string(),
                    "cli_token"
                ),
            ]
        );

        // 自定义前缀：三把键都跟着前缀走。
        jenkins.env_prefix = "JENKINS_WORK".to_string();
        let keys: Vec<String> = env_keys(&jenkins)
            .into_iter()
            .map(|(key, _, _)| key)
            .collect();
        assert_eq!(
            keys,
            vec![
                "JENKINS_WORK_URL",
                "JENKINS_WORK_USER",
                "JENKINS_WORK_TOKEN"
            ]
        );

        // username 缺失（例如未升级的旧 Host 导出）时 USER 值为空串而不是丢键。
        jenkins.username = None;
        let pairs = env_keys(&jenkins);
        assert_eq!(pairs.len(), 3);
        assert_eq!(pairs[1].0, "JENKINS_WORK_USER");
        assert_eq!(pairs[1].1, "");
    }

    #[test]
    fn maps_uptime_kuma_export_to_url_and_api_key() {
        let mut kuma = export(PROVIDER_UPTIME_KUMA, "");
        kuma.base_url = "https://host/uptime-kuma".to_string();
        assert_eq!(
            env_keys(&kuma),
            vec![
                (
                    "UPTIME_KUMA_URL".to_string(),
                    "https://host/uptime-kuma".to_string(),
                    "service"
                ),
                (
                    "UPTIME_KUMA_API_KEY".to_string(),
                    "fixture-token".to_string(),
                    "cli_token"
                ),
            ]
        );

        // 多实例：前缀跟着走，token 键仍然是 `_API_KEY`。
        kuma.env_prefix = "UPTIME_KUMA_TW".to_string();
        let keys: Vec<String> = env_keys(&kuma).into_iter().map(|(key, _, _)| key).collect();
        assert_eq!(keys, vec!["UPTIME_KUMA_TW_URL", "UPTIME_KUMA_TW_API_KEY"]);
    }

    #[test]
    fn maps_beszel_export_to_three_env_keys() {
        let mut beszel = export(PROVIDER_BESZEL, "");
        beszel.base_url = "http://beszel.example.com:8090".to_string();
        beszel.username = Some("you@example.com".to_string());
        assert_eq!(
            env_keys(&beszel),
            vec![
                (
                    "BESZEL_URL".to_string(),
                    "http://beszel.example.com:8090".to_string(),
                    "service"
                ),
                (
                    "BESZEL_EMAIL".to_string(),
                    "you@example.com".to_string(),
                    "service"
                ),
                (
                    "BESZEL_PASSWORD".to_string(),
                    "fixture-token".to_string(),
                    "cli_token"
                ),
            ]
        );

        // 多实例（--profile=mon）：三把键都跟着前缀走。
        beszel.env_prefix = "BESZEL_MON".to_string();
        let keys: Vec<String> = env_keys(&beszel).into_iter().map(|(key, _, _)| key).collect();
        assert_eq!(
            keys,
            vec!["BESZEL_MON_URL", "BESZEL_MON_EMAIL", "BESZEL_MON_PASSWORD"]
        );

        // username 缺失（例如未升级的旧 Host 导出）时 EMAIL 值为空串而不是丢键。
        beszel.username = None;
        let pairs = env_keys(&beszel);
        assert_eq!(pairs.len(), 3);
        assert_eq!(pairs[1].0, "BESZEL_MON_EMAIL");
        assert_eq!(pairs[1].1, "");
    }

    #[test]
    fn normalizes_env_prefix_like_contract() {
        assert_eq!(
            normalize_env_prefix("", PROVIDER_DOCKHAND).unwrap(),
            DEFAULT_ENV_PREFIX_DOCKHAND
        );
        assert_eq!(
            normalize_env_prefix("  ", PROVIDER_GITLAB).unwrap(),
            DEFAULT_ENV_PREFIX_GITLAB
        );
        assert_eq!(
            normalize_env_prefix(" dockhand_na ", PROVIDER_DOCKHAND).unwrap(),
            "DOCKHAND_NA"
        );
        assert_eq!(normalize_env_prefix("na", PROVIDER_DOCKHAND).unwrap(), "NA");
        assert_eq!(
            normalize_env_prefix("A_1", PROVIDER_DOCKHAND).unwrap(),
            "A_1"
        );
        // 24 个字符是上限（默认前缀 DOCKHAND 只有 8 个）。
        assert!(normalize_env_prefix(&"A".repeat(24), PROVIDER_DOCKHAND).is_ok());

        let too_long = normalize_env_prefix(&"A".repeat(25), PROVIDER_DOCKHAND).unwrap_err();
        assert_eq!(too_long, "环境前缀不能超过 24 个字符");
        // 长度按 UTF-8 字节计（10 个汉字 = 30 字节），与 Node Buffer.byteLength 对齐。
        let unicode_too_long =
            normalize_env_prefix("环境环境环境环境环境", PROVIDER_DOCKHAND).unwrap_err();
        assert_eq!(unicode_too_long, "环境前缀不能超过 24 个字符");
        for invalid in ["1ABC", "ABC-D", "ABC D", "环境", "_ABC"] {
            let error = normalize_env_prefix(invalid, PROVIDER_DOCKHAND).unwrap_err();
            assert_eq!(error, "环境前缀只能包含字母、数字和下划线，且以字母开头");
        }
    }

    #[test]
    fn resolves_legacy_null_prefix_to_provider_default() {
        assert_eq!(
            resolve_env_prefix(&row("1", "旧 GitLab", PROVIDER_GITLAB, None, true)),
            DEFAULT_ENV_PREFIX_GITLAB
        );
        assert_eq!(
            resolve_env_prefix(&row("2", "旧 Dockhand", PROVIDER_DOCKHAND, None, true)),
            DEFAULT_ENV_PREFIX_DOCKHAND
        );
        // 非空前缀原样返回（与 Node resolveEnvPrefix 一致，不做二次归一）。
        assert_eq!(
            resolve_env_prefix(&row(
                "3",
                "北美",
                PROVIDER_DOCKHAND,
                Some("DOCKHAND_NA"),
                true
            )),
            "DOCKHAND_NA"
        );
        assert_eq!(
            resolve_env_prefix(&row("4", "空串", PROVIDER_DOCKHAND, Some(""), true)),
            DEFAULT_ENV_PREFIX_DOCKHAND
        );
        // 未知 provider 的旧行回退成 provider 名大写（与 Node toUpperCase 一致）。
        assert_eq!(
            resolve_env_prefix(&row("5", "旧行", "github", None, true)),
            "GITHUB"
        );
    }

    #[test]
    fn rejects_duplicate_enabled_env_prefix() {
        let rows = vec![
            row("a", "公司 GitLab", PROVIDER_GITLAB, None, true),
            row(
                "b",
                "北美 Dockhand",
                PROVIDER_DOCKHAND,
                Some("DOCKHAND_NA"),
                true,
            ),
            row("c", "已停用", PROVIDER_DOCKHAND, Some("DOCKHAND_SZ"), false),
        ];
        // 与旧行解析后的默认前缀冲突（传入 raw 前缀，函数内部归一）。
        let conflict =
            validate_env_prefix_conflict(&rows, None, PROVIDER_GITLAB, " gitlab ").unwrap_err();
        assert_eq!(
            conflict,
            "环境前缀已被「公司 GitLab」占用：GITLAB（同一前缀会生成相同的环境变量名）"
        );
        // 编辑自身时排除自己。
        assert!(
            validate_env_prefix_conflict(&rows, Some("b"), PROVIDER_DOCKHAND, "dockhand_na")
                .is_ok()
        );
        // disabled 行不参与冲突检查。
        assert!(
            validate_env_prefix_conflict(&rows, None, PROVIDER_DOCKHAND, "DOCKHAND_SZ").is_ok()
        );
        // 不同前缀不冲突。
        assert!(
            validate_env_prefix_conflict(&rows, None, PROVIDER_DOCKHAND, "DOCKHAND_SELF").is_ok()
        );
        // 非法前缀直接返回归一错误（save 更早一步已校验，这里保证纯函数自洽）。
        assert_eq!(
            validate_env_prefix_conflict(&rows, None, PROVIDER_DOCKHAND, "1BAD").unwrap_err(),
            "环境前缀只能包含字母、数字和下划线，且以字母开头"
        );
    }

    #[test]
    fn view_input_export_use_camel_case_env_prefix() {
        let view = to_view(&row(
            "1",
            "北美 Dockhand",
            PROVIDER_DOCKHAND,
            Some("DOCKHAND_NA"),
            true,
        ));
        let value = serde_json::to_value(&view).unwrap();
        assert_eq!(value["envPrefix"], "DOCKHAND_NA");

        // 旧行（NULL）在 view 里必须返回 provider 默认前缀。
        let legacy = to_view(&row("2", "旧 GitLab", PROVIDER_GITLAB, None, true));
        assert_eq!(legacy.env_prefix, "GITLAB");

        // Input 缺省 envPrefix 也能反序列化（前端旧版本/空值时下发）。
        let input: ServiceCredentialInput = serde_json::from_value(serde_json::json!({
            "name": "公司",
            "provider": "dockhand",
            "baseUrl": "http://host:3000",
            "token": "fixture-token"
        }))
        .unwrap();
        assert_eq!(input.env_prefix, None);

        // 第一期服务端导出没有 envPrefix，反序列化后应回退 provider 默认前缀。
        let legacy_export: ServiceCredentialExport = serde_json::from_value(serde_json::json!({
            "name": "公司",
            "provider": "dockhand",
            "baseUrl": "http://host:3000",
            "token": "fixture-token"
        }))
        .unwrap();
        assert_eq!(legacy_export.env_prefix, "");
        assert_eq!(env_keys(&legacy_export)[0].0, "DOCKHAND_URL");

        let custom = export(PROVIDER_DOCKHAND, "DOCKHAND_NA");
        let value = serde_json::to_value(&custom).unwrap();
        assert_eq!(value["envPrefix"], "DOCKHAND_NA");
        assert!(value["username"].is_null());
    }

    #[test]
    fn view_input_export_use_camel_case_username() {
        // View / Export 的 username 明文返回，GitLab/Dockhand 为 null。
        let mut jenkins_row = row("1", "公司 Jenkins", PROVIDER_JENKINS, None, true);
        jenkins_row.username = Some("alice".to_string());
        let view = to_view(&jenkins_row);
        assert_eq!(view.username.as_deref(), Some("alice"));
        let value = serde_json::to_value(&view).unwrap();
        assert_eq!(value["username"], "alice");

        let export = export(PROVIDER_JENKINS, "");
        let value = serde_json::to_value(&export).unwrap();
        assert!(value["username"].is_null());

        // Input 缺省 username 也能反序列化（前端旧版本/空值时下发）。
        let input: ServiceCredentialInput = serde_json::from_value(serde_json::json!({
            "name": "公司",
            "provider": "jenkins",
            "baseUrl": "https://jenkins.example.com",
            "token": "fixture-token"
        }))
        .unwrap();
        assert_eq!(input.username, None);

        // 旧服务端导出（无 username）在 Rust 侧仍可反序列化。
        let legacy: ServiceCredentialExport = serde_json::from_value(serde_json::json!({
            "name": "公司",
            "provider": "dockhand",
            "baseUrl": "http://host:3000",
            "token": "fixture-token"
        }))
        .unwrap();
        assert_eq!(legacy.username, None);
    }

    #[test]
    fn beszel_view_keeps_email_username_and_default_prefix() {
        let mut beszel_row = row("b1", "监控 Beszel", PROVIDER_BESZEL, None, true);
        beszel_row.username = Some("you@example.com".to_string());
        let view = to_view(&beszel_row);
        assert_eq!(view.username.as_deref(), Some("you@example.com"));
        assert_eq!(view.env_prefix, DEFAULT_ENV_PREFIX_BESZEL);
        let value = serde_json::to_value(&view).unwrap();
        assert_eq!(value["username"], "you@example.com");
        assert_eq!(value["provider"], "beszel");

        // 导出（flowlet pull 用）同样带邮箱；env_keys 用它生成 _EMAIL。
        let exported = export_from_row(&beszel_row);
        assert_eq!(exported.username.as_deref(), Some("you@example.com"));
        assert_eq!(env_keys(&exported)[1].0, "BESZEL_EMAIL");
        assert_eq!(env_keys(&exported)[1].1, "you@example.com");
    }

    /// 测试用：复用 `export()` 的投影逻辑（避免复制粘贴 ServiceCredentialExport 构造）。
    fn export_from_row(row: &crate::core::storage::ServiceCredentialRow) -> ServiceCredentialExport {
        ServiceCredentialExport {
            name: row.name.clone(),
            provider: row.provider.clone(),
            base_url: row.base_url.clone(),
            username: row.username.clone(),
            env_prefix: resolve_env_prefix(row),
            token: "fixture-token".to_string(),
        }
    }

    #[test]
    fn masks_secret_tail_only() {
        assert_eq!(mask_secret("1234"), "••••");
        assert_eq!(mask_secret("dockhand-test-fixture-token-9x8y"), "••••9x8y");
    }

    #[test]
    fn credential_check_serializes_detail_field() {
        let check = CredentialCheck {
            ok: true,
            username: None,
            version: None,
            detail: Some("2 个环境".to_string()),
            error: None,
        };
        let value = serde_json::to_value(&check).unwrap();
        assert_eq!(value["detail"], "2 个环境");
        assert!(value["username"].is_null());
    }
}
