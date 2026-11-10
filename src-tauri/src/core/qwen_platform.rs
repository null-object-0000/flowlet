//! 千问平台 HTTP 通道：device-flow 登录 + BssOpenAPI 直连查询。
//!
//! ## 为什么存在
//!
//! 千问 API 按量付费账号的「余额 + 各模型免费额度」原先只通过「隐藏 WebView
//! 打开控制台并拦截 XHR」获得（见 `scrape_console`）。这条路径有三个硬限制：
//!
//! 1. 必须能创建 WebView：Docker / Web Host 根本没有这个能力；
//! 2. 依赖控制台页面结构、抓包时机与登录态持久化目录，脆弱且难排查；
//! 3. Linux 上 WebKitGTK 创建失败是 `abort()`，会带走整个进程。
//!
//! 千问官方 CLI（`@qianwenai/qianwen-cli`）证明同一批数据可以通过公开 HTTP
//! 接口取得：device flow 拿 CLI 访问令牌，再用 `BssOpenAPI-V3` 网关查询
//! `DescribeFqInstance`（免费额度实例）、`GetFundAccountAvailableAmount`
//! （账户可用余额）与 `ListSettleBillTotalSummary`（结算账单）。本模块实现
//! 这条路径，并把结果**写成与控制台抓取同构的 slot bundle**，因此前端
//! `qwenFreetierDetails` 解析器、余额快照表与展示逻辑都不需要改。
//!
//! ## 接口契约（来自 CLI 1.10.0 实现）
//!
//! - `POST {AUTH_BASE}/cli/device/code?client_id=&code_challenge=&code_challenge_method=S256`
//!   → `{Success, Data:{Token, VerificationUrl, ExpiresIn, Interval}}`
//! - `POST {AUTH_BASE}/cli/device/token?client_id=&token=&code_verifier=`
//!   → `{Success, Data:{Status, Credentials:{AccessToken, ExpireTime, User}}}`
//! - `POST {API_BASE}/data/v2/api.json`
//!   `Authorization: Bearer <access_token>`
//!   body `{product, action, region:"cn-beijing", params:{...[String]}}`
//!   → `{code:"200", data:{...}}`
//!
//! 令牌没有 refresh token：过期后只能重新走一次 device flow。凭据按账号
//! 保存在数据目录 `qwen-platform/<account_id>.json`（权限 0600），不写入
//! SQLite，也不复用模型调用的 API Key。

use std::collections::HashMap;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::core::config::{AccountBalanceSnapshot, ChannelAccount};
use crate::core::services::FlowletServices;
use crate::core::storage::Storage;
use crate::core::upstream_proxy;

pub const QWEN_CHANNEL_ID: &str = "qwen";
/// 与前端 `isQwenPayAsYouGoAccount` 保持一致：`None` 视为历史默认的按量付费。
const QWEN_PAY_AS_YOU_GO_MODE: &str = "pay_as_you_go";
/// 登录失效时返回给前端的固定文案；调用方（周期同步）据此决定是否回退控制台抓取。
pub const LOGIN_EXPIRED_MESSAGE: &str = "千问平台登录已过期，请重新登录千问平台";
const AUTH_BASE: &str = "https://t.qianwenai.com";
const API_BASE: &str = "https://cli.qianwenai.com";
const MODEL_MAPPING_URL: &str = "https://alioth.alicdn.com/model-mapping";
const BSS_PRODUCT: &str = "BssOpenAPI-V3";
const REGION: &str = "cn-beijing";
const SOURCE: &str = "qwen_platform";
const REMARK: &str = "千问平台 API";
const HTTP_TIMEOUT: Duration = Duration::from_secs(20);
const FQ_PAGE_SIZE: usize = 500;
const MAX_FQ_PAGES: usize = 10;
const CREDENTIALS_DIR: &str = "qwen-platform";
const CLIENT_ID_FILE: &str = "client-id";
/// cs-data 网关：Token Plan 订阅数据的真实来源（千问控制台页面也调它）。
const CS_DATA_BASE: &str = "https://cs-data.qianwenai.com";
/// CLI 先用 `ModelStudioRegional/GenerateCLIAccessToken` 换派生令牌，再用它访问 cs-data。
const CLI_ACCESS_PRODUCT: &str = "ModelStudioRegional";
const CLI_ACCESS_ACTION: &str = "GenerateCLIAccessToken";
const CLI_ACCESS_VERSION: &str = "2026-02-10";
/// Token Plan 个人版套餐商品码（CLI `features.tokenPlanCommodityCodes.soloBuy`）。
const TOKEN_PLAN_SOLO_BUY_COMMODITY: &str = "sfm_tokenplansolo_public_cn";
/// cs-data 业务 api：与控制台抓取的同名槽位一一对应。
const CS_API_SUBSCRIPTION: &str = "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/subscription";
const CS_API_QUOTA_CONFIG: &str = "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/quota-config";
const CS_API_USAGE: &str = "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage";
const CS_API_RESET_CARDS: &str = "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/reset-card/list";
const QWEN_TOKEN_PLAN_MODE: &str = "token_plan";

/// 平台侧错误。区分「未登录」「令牌过期」「其它」三类，因为周期同步对前两类
/// 应当回退控制台抓取，而不是把整轮同步判为失败。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlatformError {
    NotLoggedIn,
    AuthExpired,
    Message(String),
}

impl PlatformError {
    pub fn message(&self) -> String {
        match self {
            Self::NotLoggedIn => "尚未登录千问平台".to_string(),
            Self::AuthExpired => LOGIN_EXPIRED_MESSAGE.to_string(),
            Self::Message(message) => message.clone(),
        }
    }

    /// 登录态问题（需要用户重新授权），周期同步应回退到控制台抓取路径。
    pub fn is_login_issue(&self) -> bool {
        matches!(self, Self::NotLoggedIn | Self::AuthExpired)
    }
}

impl fmt::Display for PlatformError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message())
    }
}

impl From<PlatformError> for String {
    fn from(error: PlatformError) -> Self {
        error.message()
    }
}

impl From<String> for PlatformError {
    fn from(message: String) -> Self {
        Self::Message(message)
    }
}

impl From<&str> for PlatformError {
    fn from(message: &str) -> Self {
        Self::Message(message.to_string())
    }
}

// ─── 对外返回结构 ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformStatus {
    pub account_id: String,
    pub logged_in: bool,
    pub aliyun_id: Option<String>,
    pub email: Option<String>,
    pub expires_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginChallenge {
    pub verification_url: String,
    pub expires_in_seconds: u64,
    pub interval_seconds: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LoginPollStatus {
    Pending,
    SlowDown,
    Complete,
    Expired,
    Denied,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginPoll {
    pub status: LoginPollStatus,
    pub aliyun_id: Option<String>,
    pub email: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformSyncOutcome {
    pub account_id: String,
    pub balance: Option<f64>,
    pub currency: Option<String>,
    pub synced_at: String,
    pub raw_scraped_json: String,
}

// ─── 凭据持久化 ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlatformCredentials {
    pub access_token: String,
    #[serde(default)]
    pub expires_at: Option<String>,
    #[serde(default)]
    pub aliyun_id: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    pub updated_at: String,
}

impl PlatformCredentials {
    /// 服务端返回的 `ExpireTime` 可能是 RFC3339，也可能是纯数字时间戳；无法解析时
    /// 视为「未提供过期时间」，仍按已登录处理（真实失效由网关 401 兜底）。
    pub fn is_expired(&self, now: DateTime<Utc>) -> bool {
        self.expires_at
            .as_deref()
            .and_then(parse_expire_time)
            .is_some_and(|expire| expire <= now)
    }
}

fn parse_expire_time(raw: &str) -> Option<DateTime<Utc>> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(value) = DateTime::parse_from_rfc3339(trimmed) {
        return Some(value.with_timezone(&Utc));
    }
    if let Ok(seconds) = trimmed.parse::<i64>() {
        // 兼容秒级时间戳（毫秒时间戳超出合理范围则拒绝）。
        return DateTime::<Utc>::from_timestamp(seconds, 0);
    }
    None
}

fn data_dir(storage: &Storage) -> PathBuf {
    storage
        .database_path()
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn platform_dir(storage: &Storage) -> PathBuf {
    data_dir(storage).join(CREDENTIALS_DIR)
}

fn credential_path(storage: &Storage, account_id: &str) -> Result<PathBuf, String> {
    validate_account_id(account_id)?;
    Ok(platform_dir(storage).join(format!("{account_id}.json")))
}

fn validate_account_id(account_id: &str) -> Result<(), String> {
    let valid = !account_id.is_empty()
        && account_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if valid {
        Ok(())
    } else {
        Err(format!("非法账号 id: {account_id}"))
    }
}

pub fn load_credentials(
    storage: &Storage,
    account_id: &str,
) -> Result<Option<PlatformCredentials>, String> {
    let path = credential_path(storage, account_id)?;
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("读取千问平台凭据失败: {error}")),
    };
    match serde_json::from_str::<PlatformCredentials>(&raw) {
        Ok(credentials) if !credentials.access_token.trim().is_empty() => Ok(Some(credentials)),
        Ok(_) => Ok(None),
        Err(error) => {
            tracing::warn!(%error, path = %path.display(), "千问平台凭据文件解析失败，按未登录处理");
            Ok(None)
        }
    }
}

fn save_credentials(
    storage: &Storage,
    account_id: &str,
    credentials: &PlatformCredentials,
) -> Result<(), String> {
    let path = credential_path(storage, account_id)?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|error| format!("创建千问平台凭据目录失败: {error}"))?;
    }
    let body = serde_json::to_string_pretty(credentials)
        .map_err(|error| format!("序列化千问平台凭据失败: {error}"))?;
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, body).map_err(|error| format!("写入千问平台凭据失败: {error}"))?;
    restrict_permissions(&temp);
    fs::rename(&temp, &path).map_err(|error| format!("保存千问平台凭据失败: {error}"))?;
    Ok(())
}

fn remove_credentials(storage: &Storage, account_id: &str) -> Result<bool, String> {
    let path = credential_path(storage, account_id)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("删除千问平台凭据失败: {error}")),
    }
}

#[cfg(unix)]
fn restrict_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(metadata) = fs::metadata(path) {
        let mut permissions = metadata.permissions();
        permissions.set_mode(0o600);
        let _ = fs::set_permissions(path, permissions);
    }
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) {}

/// 设备 id：devcie flow 的 `client_id`。与 CLI 一样在数据目录持久化，保证同一台
/// 设备重复登录时服务端看到同一个客户端。
fn load_or_create_client_id(storage: &Storage) -> Result<String, String> {
    let dir = platform_dir(storage);
    let path = dir.join(CLIENT_ID_FILE);
    if let Ok(raw) = fs::read_to_string(&path) {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }
    fs::create_dir_all(&dir).map_err(|error| format!("创建千问平台目录失败: {error}"))?;
    let id = uuid::Uuid::new_v4().to_string();
    fs::write(&path, format!("{id}\n"))
        .map_err(|error| format!("写入千问平台设备 id 失败: {error}"))?;
    restrict_permissions(&path);
    Ok(id)
}

// ─── 登录（device flow + PKCE）──────────────────────────────────────────────

#[derive(Debug, Clone)]
struct PendingLogin {
    client_id: String,
    code_verifier: String,
    device_token: String,
    expires_at: DateTime<Utc>,
}

fn pending_login_store() -> &'static Mutex<HashMap<String, PendingLogin>> {
    static PENDING: OnceLock<Mutex<HashMap<String, PendingLogin>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

fn account_or_error(
    services: &FlowletServices,
    account_id: &str,
) -> Result<ChannelAccount, String> {
    let account = services
        .runtime_config
        .snapshot()
        .accounts
        .iter()
        .find(|account| account.id == account_id)
        .cloned();
    match account {
        Some(account) if account.channel_id == QWEN_CHANNEL_ID => Ok(account),
        Some(_) => Err("该账号不属于千问渠道".to_string()),
        None => Err("账号不存在".to_string()),
    }
}

/// 千问账号的两种资源模式需要不同的平台接口：
/// - API 按量付费：余额 + 各模型免费额度（BssOpenAPI）；
/// - Token Plan 订阅：订阅状态 + 额度窗口 + 重置券（cs-data）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlatformAccountKind {
    PayAsYouGo,
    TokenPlan,
}

pub fn platform_account_kind(account: &ChannelAccount) -> Option<PlatformAccountKind> {
    if account.channel_id != QWEN_CHANNEL_ID {
        return None;
    }
    match account.resource_mode.as_deref() {
        Some(QWEN_TOKEN_PLAN_MODE) => Some(PlatformAccountKind::TokenPlan),
        Some(QWEN_PAY_AS_YOU_GO_MODE) | None => Some(PlatformAccountKind::PayAsYouGo),
        Some(_) => None,
    }
}

/// 两种模式都支持平台同步，但走不同的接口。
pub fn supports_platform_sync(account: &ChannelAccount) -> bool {
    platform_account_kind(account).is_some()
}

fn build_client(account: &ChannelAccount) -> Result<reqwest::Client, String> {
    upstream_proxy::apply_to_account(reqwest::Client::builder(), account)
        .and_then(|builder| {
            builder
                .timeout(HTTP_TIMEOUT)
                .user_agent(user_agent())
                .build()
                .map_err(|error| error.to_string())
        })
        .map_err(|error| format!("创建千问平台 HTTP 客户端失败: {error}"))
}

fn user_agent() -> String {
    format!("flowlet/{}", env!("CARGO_PKG_VERSION"))
}

fn generate_code_verifier() -> String {
    // 两枚 UUIDv4 拼成 32 字节随机量，再按 RFC 7636 用 base64url 编码。
    let mut bytes = [0u8; 32];
    bytes[..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    bytes[16..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    URL_SAFE_NO_PAD.encode(bytes)
}

fn code_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn query_encode(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

#[derive(Deserialize)]
struct DeviceCodeEnvelope {
    #[serde(default, alias = "Success")]
    success: bool,
    #[serde(default, alias = "Data")]
    data: Option<DeviceCodeData>,
    #[serde(default, alias = "Message")]
    message: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct DeviceCodeData {
    token: String,
    verification_url: String,
    #[serde(default)]
    expires_in: u64,
    #[serde(default)]
    interval: u64,
}

fn parse_device_code_body(body: &str) -> Result<DeviceCodeData, PlatformError> {
    let envelope: DeviceCodeEnvelope = serde_json::from_str(body)
        .map_err(|error| PlatformError::Message(format!("解析千问登录响应失败: {error}")))?;
    if !envelope.success {
        return Err(PlatformError::Message(
            envelope
                .message
                .unwrap_or_else(|| "千问平台拒绝发起登录".to_string()),
        ));
    }
    let data = envelope
        .data
        .ok_or_else(|| PlatformError::Message("千问登录响应缺少 Data".to_string()))?;
    if data.token.trim().is_empty() || data.verification_url.trim().is_empty() {
        return Err(PlatformError::Message(
            "千问登录响应缺少 Token 或 VerificationUrl".to_string(),
        ));
    }
    Ok(data)
}

async fn post_device_endpoint(
    client: &reqwest::Client,
    url: &str,
) -> Result<String, PlatformError> {
    let response = client
        .post(url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|error| PlatformError::Message(format!("请求千问登录服务失败: {error}")))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| PlatformError::Message(format!("读取千问登录响应失败: {error}")))?;
    if !status.is_success() {
        return Err(classify_device_error(status.as_u16(), &body));
    }
    Ok(body)
}

/// device flow 的失败是 HTTP 400 + 文本原因，CLI 也是按文本匹配的。
fn classify_device_error(status: u16, body: &str) -> PlatformError {
    let lower = body.to_ascii_lowercase();
    if lower.contains("expired") {
        return PlatformError::AuthExpired;
    }
    if lower.contains("access_denied") || lower.contains("denied") {
        return PlatformError::Message("用户拒绝了千问平台授权".to_string());
    }
    if lower.contains("slow_down") {
        return PlatformError::Message(
            "登录轮询过快，请稍后重试（千问平台要求放慢轮询）".to_string(),
        );
    }
    PlatformError::Message(format!(
        "千问登录服务返回 HTTP {status}{}",
        error_suffix(body)
    ))
}

fn error_suffix(body: &str) -> String {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        String::new()
    } else {
        format!(": {}", trimmed.chars().take(200).collect::<String>())
    }
}

#[derive(Deserialize)]
struct TokenEnvelope {
    #[serde(default, alias = "Success")]
    success: bool,
    #[serde(default, alias = "Data")]
    data: Option<TokenData>,
    #[serde(default, alias = "Message")]
    message: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct TokenData {
    #[serde(default, alias = "Status")]
    status: Option<String>,
    #[serde(default, alias = "Credentials")]
    credentials: Option<TokenCredentials>,
}

#[derive(Debug, Clone, Deserialize)]
struct TokenCredentials {
    #[serde(default, alias = "AccessToken")]
    access_token: Option<String>,
    #[serde(default, alias = "ExpireTime")]
    expire_time: Option<Value>,
    #[serde(default, alias = "User")]
    user: Option<TokenUser>,
}

#[derive(Debug, Clone, Deserialize, Default)]
struct TokenUser {
    #[serde(default, alias = "Id")]
    id: Option<Value>,
    #[serde(default, alias = "Email")]
    email: Option<Value>,
    #[serde(default, alias = "AliyunId")]
    aliyun_id: Option<Value>,
}

/// 线上实测 `User.Id` 是数字（如 `1494342465971857`），CLI 也会把 aliyunId
/// 放在数字/字符串两种形态里；统一转成展示用字符串。
fn value_text(value: Option<Value>) -> Option<String> {
    match value? {
        Value::String(text) => {
            let trimmed = text.trim().to_string();
            (!trimmed.is_empty()).then_some(trimmed)
        }
        Value::Number(number) => Some(number.to_string()),
        Value::Null => None,
        other => {
            let text = other.to_string().trim().to_string();
            (!text.is_empty()).then_some(text)
        }
    }
}

/// token 轮询响应解析结果。
#[derive(Debug, Clone, PartialEq, Eq)]
enum TokenPollOutcome {
    Pending,
    SlowDown,
    Complete {
        access_token: String,
        expires_at: Option<String>,
        aliyun_id: Option<String>,
        email: Option<String>,
    },
    Expired,
    Denied,
}

fn parse_token_body(body: &str) -> Result<TokenPollOutcome, PlatformError> {
    let envelope: TokenEnvelope = serde_json::from_str(body)
        .map_err(|error| PlatformError::Message(format!("解析千问登录结果失败: {error}")))?;
    if !envelope.success {
        return Err(PlatformError::Message(
            envelope
                .message
                .unwrap_or_else(|| "千问登录状态查询失败".to_string()),
        ));
    }
    let data = envelope
        .data
        .ok_or_else(|| PlatformError::Message("千问登录结果缺少 Data".to_string()))?;
    let status = data
        .status
        .as_deref()
        .unwrap_or("authorization_pending")
        .trim()
        .to_ascii_lowercase();
    match status.as_str() {
        "complete" | "success" => {
            let credentials = data.credentials.ok_or_else(|| {
                PlatformError::Message("千问登录完成但未返回访问令牌".to_string())
            })?;
            let access_token = credentials
                .access_token
                .map(|token| token.trim().to_string())
                .filter(|token| !token.is_empty())
                .ok_or_else(|| PlatformError::Message("千问登录完成但访问令牌为空".to_string()))?;
            let user = credentials.user.unwrap_or_default();
            Ok(TokenPollOutcome::Complete {
                access_token,
                expires_at: credentials
                    .expire_time
                    .map(|value| match value {
                        Value::String(text) => text,
                        other => other.to_string(),
                    })
                    .filter(|text| !text.trim().is_empty()),
                aliyun_id: value_text(user.aliyun_id).or_else(|| value_text(user.id)),
                email: value_text(user.email),
            })
        }
        "slow_down" => Ok(TokenPollOutcome::SlowDown),
        "expired_token" | "expired" => Ok(TokenPollOutcome::Expired),
        "access_denied" | "denied" => Ok(TokenPollOutcome::Denied),
        _ => Ok(TokenPollOutcome::Pending),
    }
}

pub async fn start_login(
    services: &FlowletServices,
    account_id: &str,
) -> Result<LoginChallenge, String> {
    let account = account_or_error(services, account_id)?;
    if !supports_platform_sync(&account) {
        return Err("只有千问 API 按量付费账号需要登录千问平台".to_string());
    }
    let client_id = load_or_create_client_id(&services.storage)?;
    let verifier = generate_code_verifier();
    let challenge = code_challenge(&verifier);
    let url = format!(
        "{AUTH_BASE}/cli/device/code?client_id={}&code_challenge={}&code_challenge_method=S256",
        query_encode(&client_id),
        query_encode(&challenge)
    );
    let client = build_client(&account)?;
    let body = post_device_endpoint(&client, &url)
        .await
        .map_err(String::from)?;
    let data = parse_device_code_body(&body).map_err(String::from)?;
    let expires_in = if data.expires_in == 0 {
        300
    } else {
        data.expires_in
    };
    let interval = if data.interval == 0 { 2 } else { data.interval };
    let pending = PendingLogin {
        client_id,
        code_verifier: verifier,
        device_token: data.token,
        expires_at: Utc::now() + chrono::Duration::seconds(expires_in as i64),
    };
    pending_login_store()
        .lock()
        .map_err(|_| "锁定千问登录状态失败".to_string())?
        .insert(account_id.to_string(), pending);
    Ok(LoginChallenge {
        verification_url: data.verification_url,
        expires_in_seconds: expires_in,
        interval_seconds: interval,
    })
}

pub async fn poll_login(services: &FlowletServices, account_id: &str) -> Result<LoginPoll, String> {
    let account = account_or_error(services, account_id)?;
    let pending = pending_login_store()
        .lock()
        .map_err(|_| "锁定千问登录状态失败".to_string())?
        .get(account_id)
        .cloned()
        .ok_or_else(|| "请先发起千问平台登录".to_string())?;
    if pending.expires_at <= Utc::now() {
        pending_login_store()
            .lock()
            .map_err(|_| "锁定千问登录状态失败".to_string())?
            .remove(account_id);
        return Ok(LoginPoll {
            status: LoginPollStatus::Expired,
            aliyun_id: None,
            email: None,
        });
    }
    let url = format!(
        "{AUTH_BASE}/cli/device/token?client_id={}&token={}&code_verifier={}",
        query_encode(&pending.client_id),
        query_encode(&pending.device_token),
        query_encode(&pending.code_verifier)
    );
    let client = build_client(&account)?;
    let body = match post_device_endpoint(&client, &url).await {
        Ok(body) => body,
        Err(PlatformError::AuthExpired) => {
            pending_login_store()
                .lock()
                .map_err(|_| "锁定千问登录状态失败".to_string())?
                .remove(account_id);
            return Ok(LoginPoll {
                status: LoginPollStatus::Expired,
                aliyun_id: None,
                email: None,
            });
        }
        Err(error) => return Err(error.message()),
    };
    let outcome = parse_token_body(&body).map_err(String::from)?;
    match outcome {
        TokenPollOutcome::Pending => Ok(LoginPoll {
            status: LoginPollStatus::Pending,
            aliyun_id: None,
            email: None,
        }),
        TokenPollOutcome::SlowDown => Ok(LoginPoll {
            status: LoginPollStatus::SlowDown,
            aliyun_id: None,
            email: None,
        }),
        TokenPollOutcome::Expired => {
            pending_login_store()
                .lock()
                .map_err(|_| "锁定千问登录状态失败".to_string())?
                .remove(account_id);
            Ok(LoginPoll {
                status: LoginPollStatus::Expired,
                aliyun_id: None,
                email: None,
            })
        }
        TokenPollOutcome::Denied => {
            pending_login_store()
                .lock()
                .map_err(|_| "锁定千问登录状态失败".to_string())?
                .remove(account_id);
            Ok(LoginPoll {
                status: LoginPollStatus::Denied,
                aliyun_id: None,
                email: None,
            })
        }
        TokenPollOutcome::Complete {
            access_token,
            expires_at,
            aliyun_id,
            email,
        } => {
            let mut aliyun_id = aliyun_id;
            let mut email = email;
            if aliyun_id.is_none() || email.is_none() {
                if let Some((display_id, display_email)) =
                    fetch_account_identity(&client, &access_token).await
                {
                    aliyun_id = aliyun_id.or(display_id);
                    email = email.or(display_email);
                }
            }
            let credentials = PlatformCredentials {
                access_token,
                expires_at,
                aliyun_id: aliyun_id.clone(),
                email: email.clone(),
                updated_at: Utc::now().to_rfc3339(),
            };
            save_credentials(&services.storage, account_id, &credentials)?;
            pending_login_store()
                .lock()
                .map_err(|_| "锁定千问登录状态失败".to_string())?
                .remove(account_id);
            Ok(LoginPoll {
                status: LoginPollStatus::Complete,
                aliyun_id,
                email,
            })
        }
    }
}

pub fn status(services: &FlowletServices, account_id: &str) -> Result<PlatformStatus, String> {
    let _account = account_or_error(services, account_id)?;
    let credentials = load_credentials(&services.storage, account_id)?;
    let logged_in = credentials
        .as_ref()
        .is_some_and(|credentials| !credentials.is_expired(Utc::now()));
    Ok(PlatformStatus {
        account_id: account_id.to_string(),
        logged_in,
        aliyun_id: credentials.as_ref().and_then(|c| c.aliyun_id.clone()),
        email: credentials.as_ref().and_then(|c| c.email.clone()),
        expires_at: credentials.as_ref().and_then(|c| c.expires_at.clone()),
    })
}

pub fn logout(services: &FlowletServices, account_id: &str) -> Result<(), String> {
    let _account = account_or_error(services, account_id)?;
    remove_credentials(&services.storage, account_id)?;
    if let Ok(mut pending) = pending_login_store().lock() {
        pending.remove(account_id);
    }
    Ok(())
}

// ─── 网关调用 ────────────────────────────────────────────────────────────────

fn stringify_params(params: Map<String, Value>) -> Map<String, Value> {
    params
        .into_iter()
        .map(|(key, value)| {
            let text = match value {
                Value::String(text) => text,
                other => other.to_string(),
            };
            (key, Value::String(text))
        })
        .collect()
}

#[derive(Debug, Clone, Deserialize)]
struct GatewayEnvelope {
    #[serde(default)]
    code: Value,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    data: Option<Value>,
}

fn gateway_code_text(code: &Value) -> String {
    match code {
        Value::String(text) => text.clone(),
        Value::Number(number) => number.to_string(),
        other => other.to_string(),
    }
}

/// 解析 `{code, message, data}` 信封；`code` 为数字或字符串 "200" 都接受。
fn parse_gateway_body(body: &str) -> Result<Value, PlatformError> {
    let envelope: GatewayEnvelope = serde_json::from_str(body)
        .map_err(|error| PlatformError::Message(format!("解析千问平台响应失败: {error}")))?;
    let code = gateway_code_text(&envelope.code);
    if code == "200" {
        return Ok(envelope.data.unwrap_or(Value::Null));
    }
    let message = envelope
        .message
        .unwrap_or_else(|| format!("千问平台返回 code={code}"));
    let lower = format!("{code} {message}").to_ascii_lowercase();
    if lower.contains("401")
        || lower.contains("unauthor")
        || lower.contains("notlogined")
        || lower.contains("not_login")
        || lower.contains("token") && lower.contains("expire")
    {
        return Err(PlatformError::AuthExpired);
    }
    Err(PlatformError::Message(message))
}

async fn gateway_call_with(
    client: &reqwest::Client,
    access_token: &str,
    product: &str,
    action: &str,
    version: Option<&str>,
    params: Map<String, Value>,
) -> Result<Value, PlatformError> {
    let mut body = json!({
        "product": product,
        "action": action,
        "region": REGION,
        "params": stringify_params(params),
    });
    if let Some(version) = version {
        body["version"] = Value::String(version.to_string());
    }
    let response = client
        .post(format!("{API_BASE}/data/v2/api.json"))
        .header("Authorization", format!("Bearer {access_token}"))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|error| PlatformError::Message(format!("请求千问平台失败: {error}")))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| PlatformError::Message(format!("读取千问平台响应失败: {error}")))?;
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err(PlatformError::AuthExpired);
    }
    if !status.is_success() {
        return Err(PlatformError::Message(format!(
            "千问平台返回 HTTP {}{}",
            status.as_u16(),
            error_suffix(&text)
        )));
    }
    parse_gateway_body(&text)
}

async fn gateway_call(
    client: &reqwest::Client,
    access_token: &str,
    action: &str,
    params: Map<String, Value>,
) -> Result<Value, PlatformError> {
    gateway_call_with(client, access_token, BSS_PRODUCT, action, None, params).await
}

/// 用 device-flow 的访问令牌换 cs-data 需要的派生令牌（CLI 同样先换再用）。
async fn derive_cli_access_token(
    client: &reqwest::Client,
    access_token: &str,
) -> Result<String, PlatformError> {
    let data = gateway_call_with(
        client,
        access_token,
        CLI_ACCESS_PRODUCT,
        CLI_ACCESS_ACTION,
        Some(CLI_ACCESS_VERSION),
        Map::new(),
    )
    .await?;
    let token = data
        .get("cliAccessToken")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| PlatformError::Message("千问平台未返回 Token Plan 访问令牌".to_string()))?;
    Ok(token.to_string())
}

/// cs-data 业务信封：`{code:"200", successResponse, data:{DataV2:{ret:["SUCCESS::"], data:{data:<业务>}}}}`。
///
/// 返回**完整响应对象**，因为它会被原样写入 bundle 槽位——前端解析器沿
/// `data.DataV2.data.data` 取业务数据，必须与控制台抓取的形状一致。
fn validate_cs_data_body(body: &str) -> Result<Value, PlatformError> {
    let root: Value = serde_json::from_str(body)
        .map_err(|error| PlatformError::Message(format!("解析 Token Plan 响应失败: {error}")))?;
    let code = root.get("code").map(gateway_code_text).unwrap_or_default();
    if code != "200" {
        let message = root
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("Token Plan 接口未确认成功");
        return Err(classify_cs_data_failure(&code, message));
    }
    let data = root.get("data").unwrap_or(&Value::Null);
    if data.get("success").and_then(Value::as_bool) == Some(false) {
        let error_code = data
            .get("errorCode")
            .and_then(Value::as_str)
            .unwrap_or("TokenPlanGatewayError");
        return Err(classify_cs_data_failure(error_code, error_code));
    }
    let ret = data
        .pointer("/DataV2/ret/0")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !ret.starts_with("SUCCESS") {
        let (error_code, message) = match ret.split_once("::") {
            Some((code, message)) => (code, message),
            None => (ret, "Token Plan 业务返回失败"),
        };
        return Err(classify_cs_data_failure(error_code, message));
    }
    Ok(root)
}

fn classify_cs_data_failure(code: &str, message: &str) -> PlatformError {
    let lower = format!("{code} {message}").to_ascii_lowercase();
    if lower.contains("notlogined")
        || lower.contains("not_login")
        || lower.contains("not logged in")
        || lower.contains("unauthor")
        || lower.contains("401")
        || lower.contains("403")
        || (lower.contains("token") && lower.contains("expire"))
    {
        return PlatformError::AuthExpired;
    }
    PlatformError::Message(if message.trim().is_empty() {
        format!("Token Plan 接口返回 {code}")
    } else {
        format!("{message} ({code})")
    })
}

/// 调 cs-data 的一个业务 api。`data` 是业务参数（subscription 需要 commodityCode，
/// 其余为空），`cornerstoneParam` 由本函数补齐。
/// cs-data 请求构造：URL + form-urlencoded body（纯函数，便于单测）。
fn cs_data_request(api: &str, data: Map<String, Value>) -> (String, String) {
    let mut payload = data;
    payload.insert(
        "cornerstoneParam".to_string(),
        json!({
            "protocol": "V2",
            "console": "ONE_CONSOLE",
            "productCode": "p_efm",
            "switchUserType": 3,
            "consoleSite": "QIANWENAI",
        }),
    );
    let envelope = json!({
        "Api": api,
        "V": "1.0",
        "Data": Value::Object(payload),
    });
    let form = format!(
        "params={}&region={}",
        query_encode(&envelope.to_string()),
        query_encode(REGION)
    );
    let url = format!(
        "{CS_DATA_BASE}/cli/api.json?action=BroadScopeAspnGateway&product=sfm_bailian&api={}",
        query_encode(api)
    );
    (url, form)
}

async fn call_cs_data_api(
    client: &reqwest::Client,
    cli_access_token: &str,
    api: &str,
    data: Map<String, Value>,
) -> Result<Value, PlatformError> {
    let (url, form) = cs_data_request(api, data);
    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {cli_access_token}"))
        .header("Content-Type", "application/x-www-form-urlencoded")
        .header("Accept", "application/json")
        .body(form)
        .send()
        .await
        .map_err(|error| PlatformError::Message(format!("请求 Token Plan 接口失败: {error}")))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| PlatformError::Message(format!("读取 Token Plan 响应失败: {error}")))?;
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err(PlatformError::AuthExpired);
    }
    if !status.is_success() {
        return Err(PlatformError::Message(format!(
            "Token Plan 接口返回 HTTP {}{}",
            status.as_u16(),
            error_suffix(&text)
        )));
    }
    validate_cs_data_body(&text)
}

/// Token Plan 订阅槽位 bundle：`subscription` / `quota_config` / `usage`
/// 是前端解析器的必需槽位，`reset_card_list` 可选。
async fn fetch_token_plan_bundle(
    client: &reqwest::Client,
    access_token: &str,
) -> Result<Value, PlatformError> {
    let cli_token = derive_cli_access_token(client, access_token).await?;

    let mut subscription_params = Map::new();
    subscription_params.insert(
        "commodityCode".to_string(),
        Value::String(TOKEN_PLAN_SOLO_BUY_COMMODITY.to_string()),
    );
    let subscription = match call_cs_data_api(
        client,
        &cli_token,
        CS_API_SUBSCRIPTION,
        subscription_params,
    )
    .await
    {
        Ok(value) => value,
        // 团队/其它套餐形态可能不接受 commodityCode：去掉参数再试一次。
        Err(PlatformError::Message(_)) => {
            call_cs_data_api(client, &cli_token, CS_API_SUBSCRIPTION, Map::new()).await?
        }
        Err(error) => return Err(error),
    };
    let quota_config =
        call_cs_data_api(client, &cli_token, CS_API_QUOTA_CONFIG, Map::new()).await?;
    let usage = call_cs_data_api(client, &cli_token, CS_API_USAGE, Map::new()).await?;
    // 重置券是可选能力：接口不可用时不阻断订阅同步（与控制台抓取一致）。
    let reset_cards =
        match call_cs_data_api(client, &cli_token, CS_API_RESET_CARDS, Map::new()).await {
            Ok(value) => Some(value),
            Err(PlatformError::AuthExpired) => return Err(PlatformError::AuthExpired),
            Err(error) => {
                tracing::info!(%error, "千问平台：重置券接口不可用，跳过该槽位");
                None
            }
        };

    let mut bundle = Map::new();
    bundle.insert("subscription".to_string(), subscription);
    bundle.insert("quota_config".to_string(), quota_config);
    bundle.insert("usage".to_string(), usage);
    if let Some(reset_cards) = reset_cards {
        bundle.insert("reset_card_list".to_string(), reset_cards);
    }
    Ok(Value::Object(bundle))
}

/// 平台账号展示身份。device flow 只返回数字 `User.Id`，`/api/account/info.json`
/// 才有掩码后的 `aliyunId`（如 `nich*****@outlook.com`），用于「已登录 …」展示。
/// 该查询失败不影响登录成功，只是展示身份缺失。
async fn fetch_account_identity(
    client: &reqwest::Client,
    access_token: &str,
) -> Option<(Option<String>, Option<String>)> {
    let response = client
        .get(format!("{API_BASE}/api/account/info.json"))
        .header("Authorization", format!("Bearer {access_token}"))
        .header("Accept", "application/json")
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body = response.text().await.ok()?;
    let data = parse_gateway_body(&body).ok()?;
    let aliyun_id = data
        .get("aliyunId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let email = aliyun_id
        .as_deref()
        .filter(|value| value.contains('@'))
        .map(str::to_string);
    Some((aliyun_id, email))
}

async fn fetch_model_mapping(client: &reqwest::Client) -> Result<HashMap<String, String>, String> {
    let response = client
        .get(MODEL_MAPPING_URL)
        .send()
        .await
        .map_err(|error| format!("请求千问模型映射失败: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "千问模型映射返回 HTTP {}",
            response.status().as_u16()
        ));
    }
    let body = response
        .text()
        .await
        .map_err(|error| format!("读取千问模型映射失败: {error}"))?;
    let mapping: HashMap<String, String> =
        serde_json::from_str(&body).map_err(|error| format!("解析千问模型映射失败: {error}"))?;
    Ok(mapping)
}

async fn fetch_free_tier_instances(
    client: &reqwest::Client,
    access_token: &str,
    template_codes: &[String],
) -> Result<Vec<Value>, PlatformError> {
    let mut instances = Vec::new();
    for page in 1..=MAX_FQ_PAGES {
        let mut params = Map::new();
        params.insert("PageSize".to_string(), json!(FQ_PAGE_SIZE));
        params.insert("PageNumber".to_string(), json!(page));
        if !template_codes.is_empty() {
            params.insert("templateCodes".to_string(), json!(template_codes));
        }
        let data = gateway_call(client, access_token, "DescribeFqInstance", params).await?;
        let page_instances = data
            .get("Data")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let count = page_instances.len();
        instances.extend(page_instances);
        if count < FQ_PAGE_SIZE {
            break;
        }
    }
    Ok(instances)
}

/// 免费额度实例 → 控制台抓取同构的 slot bundle。
///
/// 前端按 `Template.Name`（上游模型 id）与开放模型对账，而 CLI 网关返回的实例
/// 只有 `Template.Code`。用千问公开的 model-mapping（model → templateCode）反查
/// 模型名，缺失时保留上游原始 `Name`，再缺失就退回 `Code`，避免出现「有额度但
/// 对不上模型」的静默丢失。
/// 上游 `DescribeFqInstance` 的展示单位是英文（`Thousand Tokens` / `TenThousand Word`
/// / `Second` / `Piece`），而控制台抓取给的是中文（`千tokens` / `万字` / `秒` / `张`）。
/// 前端 `qwenFreetierDetails` 按 `BaseValue` 算剩余百分比、按 `ShowUnit` 拼展示文案，
/// 因此这里统一：`BaseValue` 保持基础单位数量，`ShowValue` 用同一个基础单位数值，
/// `ShowUnit` 换成前端能识别的单位标签。
fn canonical_unit(raw_unit: &str) -> Option<&'static str> {
    let lower = raw_unit.to_ascii_lowercase();
    if lower.contains("token") || raw_unit.contains("千") {
        return Some("tokens");
    }
    if lower.contains("word")
        || lower.contains("char")
        || raw_unit.contains("字")
        || raw_unit.contains("word")
    {
        return Some("字");
    }
    if lower.contains("second") || lower.contains("sec") || raw_unit.contains("秒") {
        return Some("秒");
    }
    if lower.contains("piece")
        || lower.contains("image")
        || lower.contains("page")
        || raw_unit.contains("张")
    {
        return Some("张");
    }
    if lower.contains("voice") || raw_unit.contains("次") {
        return Some("次");
    }
    None
}

/// `ShowUnit` 里的数量级前缀（服务端给英文，历史控制台给中文）。
fn unit_scale(raw_unit: &str) -> f64 {
    let lower = raw_unit.to_ascii_lowercase();
    if lower.contains("hundred thousand") || raw_unit.contains("十万") {
        return 100_000.0;
    }
    if lower.contains("ten thousand") || raw_unit.contains("万") {
        return 10_000.0;
    }
    if lower.contains("million") || raw_unit.contains("百万") {
        return 1_000_000.0;
    }
    if lower.contains("billion") || raw_unit.contains("亿") {
        return 100_000_000.0;
    }
    if lower.contains("thousand") || raw_unit.contains("千") {
        return 1_000.0;
    }
    1.0
}

fn numeric_value(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.trim().parse::<f64>().ok(),
        _ => None,
    }
}

/// 金额/数量字符串化：避免 `1e6` 之类的科学计数法进入展示。
fn number_text(value: f64) -> String {
    if (value.fract()).abs() < f64::EPSILON && value.abs() < 1e15 {
        format!("{value:.0}")
    } else {
        format!("{value}")
    }
}

/// 免费额度实例 → 控制台抓取同构、且不含账号身份的裁剪结果。
///
/// - 只保留 `Template` / `Status` / `InitCapacity` / `CurrCapacity` / 周期与结束时间，
///   丢弃 `InstanceName`、`Uid`、`StartTime`（账号身份不进入余额快照）；
/// - `Template.Name` 缺失时用公开 model-mapping 反查回填，保证前端能按模型对账；
/// - 单位与 `ShowValue` 归一到基础单位，避免前端把 `1000 Thousand Tokens` 显示成
///   「1,000 Tokens」（少三个数量级）。
fn normalize_free_tier_instance(
    instance: &Value,
    model_by_template: &HashMap<String, String>,
) -> Option<Value> {
    let template = instance.get("Template")?.as_object()?;
    let code = template
        .get("Code")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let name = template
        .get("Name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .or_else(|| model_by_template.get(&code).cloned())
        .or_else(|| (!code.is_empty()).then(|| code.clone()))?;

    let mut normalized = Map::new();
    normalized.insert(
        "Template".to_string(),
        json!({ "Code": code, "Name": name }),
    );
    if let Some(status) = instance.get("Status") {
        normalized.insert("Status".to_string(), status.clone());
    }
    for key in ["InitCapacity", "CurrCapacity"] {
        if let Some(capacity) = instance.get(key) {
            normalized.insert(key.to_string(), normalize_capacity(capacity));
        }
    }
    for key in ["CurrentCycleStartTime", "CurrentCycleEndTime", "EndTime"] {
        if let Some(value) = instance.get(key) {
            normalized.insert(key.to_string(), value.clone());
        }
    }
    Some(Value::Object(normalized))
}

fn normalize_capacity(capacity: &Value) -> Value {
    let record = capacity.as_object();
    let raw_unit = record
        .and_then(|record| {
            record
                .get("ShowUnit")
                .or_else(|| record.get("BaseUnit"))
                .and_then(Value::as_str)
        })
        .unwrap_or_default();
    let show_value = numeric_value(record.and_then(|record| record.get("ShowValue")));
    let base_value = numeric_value(record.and_then(|record| record.get("BaseValue")))
        .or_else(|| show_value.map(|value| value * unit_scale(raw_unit)));
    let unit = canonical_unit(raw_unit).map(str::to_string);

    let mut normalized = Map::new();
    if let Some(base_value) = base_value {
        normalized.insert(
            "BaseValue".to_string(),
            Value::Number(serde_json::Number::from_f64(base_value).unwrap_or_else(|| 0.into())),
        );
        normalized.insert(
            "ShowValue".to_string(),
            Value::String(number_text(base_value)),
        );
    } else if let Some(show_value) = show_value {
        normalized.insert(
            "ShowValue".to_string(),
            Value::String(number_text(show_value)),
        );
    }
    if let Some(unit) = unit {
        normalized.insert("ShowUnit".to_string(), Value::String(unit.clone()));
        normalized.insert("BaseUnit".to_string(), Value::String(unit));
    }
    Value::Object(normalized)
}

fn build_slot_bundle(
    instances: Vec<Value>,
    model_by_template: &HashMap<String, String>,
    billing: Option<Value>,
    settle: Option<Value>,
) -> Value {
    let normalized = instances
        .into_iter()
        .filter_map(|instance| normalize_free_tier_instance(&instance, model_by_template))
        .collect::<Vec<_>>();
    let mut bundle = Map::new();
    if let Some(billing) = billing {
        bundle.insert("billing_amount".to_string(), json!({ "data": billing }));
    }
    bundle.insert(
        "fq_instance".to_string(),
        json!({ "data": { "Data": normalized } }),
    );
    if let Some(settle) = settle {
        bundle.insert("settle_bill".to_string(), json!({ "data": settle }));
    }
    Value::Object(bundle)
}

/// `billing_amount` 槽位：原样保留网关返回的账户余额对象。
///
/// 前端 `qwenFreetierDetails` 读取 `AvailableAmount` / `SettleCurrency` /
/// `CashBalanceAmount` / `UnsettledAmount` / `BillingAccountStatus`，因此这里
/// 不做字段裁剪；`GetBillingAccountAvailableAmount` 与
/// `GetFundAccountAvailableAmount` 的返回都可以直接落入该槽位。
fn billing_slot_from_gateway(data: &Value) -> Option<Value> {
    if !data.is_object() {
        return None;
    }
    if !data
        .get("AvailableAmount")
        .is_some_and(|value| !value.is_null())
    {
        return None;
    }
    Some(data.clone())
}

/// 账户余额查询：优先 `GetBillingAccountAvailableAmount`（字段更全，含未结清 /
/// 现金余额 / 账单状态），失败时退回 CLI 免费额度路径使用的
/// `GetFundAccountAvailableAmount`（只有可用余额与币种）。
async fn fetch_billing_data(
    client: &reqwest::Client,
    access_token: &str,
) -> Result<Value, PlatformError> {
    match gateway_call(
        client,
        access_token,
        "GetBillingAccountAvailableAmount",
        Map::new(),
    )
    .await
    {
        Ok(data) if billing_slot_from_gateway(&data).is_some() => Ok(data),
        Ok(_) => fetch_billing_fallback(client, access_token).await,
        Err(PlatformError::AuthExpired) => Err(PlatformError::AuthExpired),
        Err(error) => {
            tracing::info!(%error, "千问平台：GetBillingAccountAvailableAmount 不可用，改用 GetFundAccountAvailableAmount");
            fetch_billing_fallback(client, access_token).await
        }
    }
}

async fn fetch_billing_fallback(
    client: &reqwest::Client,
    access_token: &str,
) -> Result<Value, PlatformError> {
    gateway_call(
        client,
        access_token,
        "GetFundAccountAvailableAmount",
        Map::new(),
    )
    .await
}

fn now_billing_cycle_yyyymm(now: DateTime<Utc>) -> String {
    // 平台账单周期按北京时间切分。
    let beijing = now + chrono::Duration::hours(8);
    beijing.format("%Y%m").to_string()
}

// ─── 同步 ────────────────────────────────────────────────────────────────────

pub async fn sync_account(
    services: &FlowletServices,
    account_id: &str,
) -> Result<PlatformSyncOutcome, String> {
    let account = account_or_error(services, account_id)?;
    let kind = platform_account_kind(&account)
        .ok_or_else(|| "该账号的资源模式不支持千问平台同步".to_string())?;
    let credentials = load_credentials(&services.storage, account_id)?
        .ok_or_else(|| PlatformError::NotLoggedIn.message())?;
    if credentials.is_expired(Utc::now()) {
        return Err(PlatformError::AuthExpired.message());
    }
    let client = build_client(&account)?;

    // 两种资源模式的数据源不同，但产物都是「与 WebView 抓取同构的 slot bundle」：
    // 按量付费 → billing_amount / fq_instance / settle_bill；
    // Token Plan → subscription / quota_config / usage(/ reset_card_list)。
    let (bundle, balance, currency) = match kind {
        PlatformAccountKind::PayAsYouGo => {
            let (bundle, balance, currency) =
                fetch_pay_as_you_go_bundle(&client, &credentials.access_token)
                    .await
                    .map_err(String::from)?;
            (bundle, balance, currency)
        }
        PlatformAccountKind::TokenPlan => {
            let bundle = fetch_token_plan_bundle(&client, &credentials.access_token)
                .await
                .map_err(String::from)?;
            (bundle, None, None)
        }
    };

    let raw_scraped_json = serde_json::to_string(&bundle)
        .map_err(|error| format!("序列化千问平台同步结果失败: {error}"))?;
    let synced_at = Utc::now().to_rfc3339();

    let snapshot = AccountBalanceSnapshot {
        id: format!("balance-{}-{}", account_id, uuid::Uuid::new_v4()),
        account_id: account_id.to_string(),
        balance,
        currency: currency.clone(),
        token_pack_total: None,
        token_pack_used: None,
        token_pack_remaining: None,
        token_pack_expire_at: None,
        token_packs: None,
        raw_scraped_json: Some(raw_scraped_json.clone()),
        source: SOURCE.to_string(),
        synced_at: Some(synced_at.clone()),
        remark: Some(REMARK.to_string()),
        created_at: synced_at.clone(),
        updated_at: synced_at.clone(),
    };
    services
        .storage
        .save_balance_snapshot(&snapshot)
        .map_err(|error| format!("保存余额快照失败: {error}"))?;

    Ok(PlatformSyncOutcome {
        account_id: account_id.to_string(),
        balance,
        currency,
        synced_at,
        raw_scraped_json,
    })
}

/// API 按量付费：余额 + 各模型免费额度 + 当月结算账单。
async fn fetch_pay_as_you_go_bundle(
    client: &reqwest::Client,
    access_token: &str,
) -> Result<(Value, Option<f64>, Option<String>), PlatformError> {
    // 模型映射是公开 CDN 上的静态 JSON；取不到只影响模型名回填，不阻断同步。
    let model_by_template = match fetch_model_mapping(client).await {
        Ok(mapping) => mapping
            .into_iter()
            .map(|(model, code)| (code, model))
            .collect::<HashMap<String, String>>(),
        Err(error) => {
            tracing::warn!(%error, "千问平台同步：模型映射获取失败，按实例自带名称回填");
            HashMap::new()
        }
    };
    let mut template_codes = model_by_template.keys().cloned().collect::<Vec<_>>();
    template_codes.sort();
    template_codes.dedup();

    let instances = fetch_free_tier_instances(client, access_token, &template_codes).await?;

    let billing_slot = match fetch_billing_data(client, access_token).await {
        Ok(data) => billing_slot_from_gateway(&data),
        Err(PlatformError::AuthExpired) => return Err(PlatformError::AuthExpired),
        Err(error) => {
            tracing::warn!(%error, "千问平台同步：账户余额查询失败");
            None
        }
    };

    let month = now_billing_cycle_yyyymm(Utc::now());
    let mut settle_params = Map::new();
    settle_params.insert("StartBillingCycle".to_string(), json!(month));
    settle_params.insert("EndBillingCycle".to_string(), json!(month));
    let settle_data = match gateway_call(
        client,
        access_token,
        "ListSettleBillTotalSummary",
        settle_params,
    )
    .await
    {
        Ok(data) if data.is_object() => Some(data),
        Ok(_) => None,
        Err(PlatformError::AuthExpired) => return Err(PlatformError::AuthExpired),
        Err(error) => {
            tracing::warn!(%error, "千问平台同步：结算账单查询失败");
            None
        }
    };

    let balance = billing_slot
        .as_ref()
        .and_then(|slot| slot.get("AvailableAmount"))
        .and_then(|value| match value {
            Value::Number(number) => number.as_f64(),
            Value::String(text) => text.trim().parse::<f64>().ok(),
            _ => None,
        });
    let currency = billing_slot.as_ref().and_then(|slot| {
        ["SettleCurrency", "Currency"]
            .iter()
            .find_map(|key| slot.get(*key).and_then(Value::as_str))
            .map(str::to_string)
    });

    Ok((
        build_slot_bundle(instances, &model_by_template, billing_slot, settle_data),
        balance,
        currency,
    ))
}

/// 周期同步入口：只有「千问 API 按量付费 + 已登录」才返回 `Some`。
///
/// 登录态问题或网络失败都返回 `None` 并记日志，让调用方回退到控制台抓取；
/// 这样桌面端行为不变，而 Docker / Web Host 也能用 HTTP 路径。
pub async fn auto_sync_account(
    services: &FlowletServices,
    account_id: &str,
) -> Option<PlatformSyncOutcome> {
    let account = services
        .runtime_config
        .snapshot()
        .accounts
        .iter()
        .find(|account| account.id == account_id)
        .cloned()?;
    if !supports_platform_sync(&account) {
        return None;
    }
    let credentials = match load_credentials(&services.storage, account_id) {
        Ok(Some(credentials)) => credentials,
        Ok(None) => return None,
        Err(error) => {
            tracing::warn!(%error, account_id, "千问平台同步：读取凭据失败，回退控制台抓取");
            return None;
        }
    };
    if credentials.is_expired(Utc::now()) {
        tracing::info!(account_id, "千问平台登录已过期，回退控制台抓取");
        return None;
    }
    match sync_account(services, account_id).await {
        Ok(outcome) => Some(outcome),
        Err(error) => {
            tracing::warn!(account_id, %error, "千问平台 HTTP 同步失败，回退控制台抓取");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn code_challenge_matches_rfc7636_example() {
        // RFC 7636 Appendix B 的官方示例向量。
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        assert_eq!(
            code_challenge(verifier),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn generates_url_safe_verifier_of_sufficient_length() {
        let verifier = generate_code_verifier();
        assert!(
            (43..=128).contains(&verifier.len()),
            "verifier 长度 {}",
            verifier.len()
        );
        assert!(verifier
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        assert_ne!(verifier, generate_code_verifier());
    }

    #[test]
    fn parses_device_code_envelope() {
        let body = r#"{"Success":true,"Data":{"Token":"tok","ExpiresIn":300,"VerificationUrl":"https://example.test/auth","Interval":2}}"#;
        let data = parse_device_code_body(body).expect("parsed");
        assert_eq!(data.token, "tok");
        assert_eq!(data.expires_in, 300);
        assert_eq!(data.interval, 2);
        assert_eq!(data.verification_url, "https://example.test/auth");

        let rejected = parse_device_code_body(r#"{"Success":false,"message":"bad client"}"#);
        assert!(
            matches!(rejected, Err(PlatformError::Message(message)) if message == "bad client")
        );
    }

    #[test]
    fn parses_pending_and_complete_token_polls() {
        let pending =
            parse_token_body(r#"{"Success":true,"Data":{"Status":"authorization_pending"}}"#)
                .expect("pending");
        assert_eq!(pending, TokenPollOutcome::Pending);

        let slow =
            parse_token_body(r#"{"Success":true,"Data":{"Status":"slow_down"}}"#).expect("slow");
        assert_eq!(slow, TokenPollOutcome::SlowDown);

        let complete = parse_token_body(
            r#"{"Success":true,"Data":{"Status":"complete","Credentials":{"AccessToken":"at","ExpireTime":"2026-12-01T00:00:00Z","User":{"Id":"u1","AliyunId":"aliyun-1","Email":"a@b.c"}}}}"#,
        )
        .expect("complete");
        assert_eq!(
            complete,
            TokenPollOutcome::Complete {
                access_token: "at".to_string(),
                expires_at: Some("2026-12-01T00:00:00Z".to_string()),
                aliyun_id: Some("aliyun-1".to_string()),
                email: Some("a@b.c".to_string()),
            }
        );

        let denied = parse_token_body(r#"{"Success":true,"Data":{"Status":"access_denied"}}"#)
            .expect("denied");
        assert_eq!(denied, TokenPollOutcome::Denied);
    }

    #[test]
    fn stringifies_gateway_params_like_the_cli() {
        let mut params = Map::new();
        params.insert("PageSize".to_string(), json!(500));
        params.insert("templateCodes".to_string(), json!(["a", "b"]));
        params.insert("Flag".to_string(), json!(true));
        params.insert("Name".to_string(), json!("keep"));
        let params = stringify_params(params);
        assert_eq!(params["PageSize"], Value::String("500".into()));
        assert_eq!(
            params["templateCodes"],
            Value::String("[\"a\",\"b\"]".into())
        );
        assert_eq!(params["Flag"], Value::String("true".into()));
        assert_eq!(params["Name"], Value::String("keep".into()));
    }

    #[test]
    fn parses_gateway_envelope_and_classifies_auth_errors() {
        let data = parse_gateway_body(r#"{"code":"200","data":{"Data":[]}}"#).expect("ok");
        assert_eq!(data["Data"], json!([]));

        let numeric = parse_gateway_body(r#"{"code":200,"data":{}}"#).expect("ok");
        assert!(numeric.is_object());

        let expired = parse_gateway_body(r#"{"code":"401","message":"Unauthorized"}"#);
        assert_eq!(expired, Err(PlatformError::AuthExpired));
    }

    #[test]
    fn builds_bundle_with_model_names_from_mapping() {
        let instances = vec![
            json!({
                "Template": {"Code": "sfm_inference_public_cn_1"},
                "Status": "valid",
                "InitCapacity": {"BaseValue": 1000000.0, "ShowUnit": "千tokens", "ShowValue": "1000.0"},
                "CurrCapacity": {"BaseValue": 250000.0, "ShowUnit": "千tokens", "ShowValue": "250.0"},
            }),
            json!({
                "Template": {"Code": "sfm_inference_public_cn_2", "Name": "qwen-existing"},
                "Status": "exhaust",
            }),
        ];
        let mut mapping = HashMap::new();
        mapping.insert(
            "sfm_inference_public_cn_1".to_string(),
            "qwen3.7-plus".to_string(),
        );
        let billing = Some(json!({"AvailableAmount": "12.34", "Currency": "CNY"}));
        let settle =
            Some(json!({"Data": [{"BillingCycle": "202611", "TotalPriceSettleFee": "1.00"}]}));
        let bundle = build_slot_bundle(instances, &mapping, billing, settle);

        assert_eq!(
            bundle.pointer("/fq_instance/data/Data/0/Template/Name"),
            Some(&Value::String("qwen3.7-plus".into()))
        );
        // 已有 Name 不被映射覆盖。
        assert_eq!(
            bundle.pointer("/fq_instance/data/Data/1/Template/Name"),
            Some(&Value::String("qwen-existing".into()))
        );
        assert_eq!(
            bundle.pointer("/billing_amount/data/AvailableAmount"),
            Some(&Value::String("12.34".into()))
        );
        assert_eq!(
            bundle.pointer("/settle_bill/data/Data/0/BillingCycle"),
            Some(&Value::String("202611".into()))
        );
        // 未提供 billing/settle 时不写入对应槽位。
        let minimal = build_slot_bundle(Vec::new(), &HashMap::new(), None, None);
        assert!(minimal.get("billing_amount").is_none());
        assert!(minimal.get("settle_bill").is_none());
        assert_eq!(minimal.pointer("/fq_instance/data/Data"), Some(&json!([])));
    }

    #[test]
    fn maps_qwen_resource_modes_to_platform_kind() {
        let mut account = ChannelAccount {
            channel_id: QWEN_CHANNEL_ID.to_string(),
            ..ChannelAccount::default()
        };
        assert_eq!(
            platform_account_kind(&account),
            Some(PlatformAccountKind::PayAsYouGo),
            "resource_mode=None 视为历史按量付费"
        );
        account.resource_mode = Some(QWEN_PAY_AS_YOU_GO_MODE.to_string());
        assert_eq!(
            platform_account_kind(&account),
            Some(PlatformAccountKind::PayAsYouGo)
        );
        account.resource_mode = Some(QWEN_TOKEN_PLAN_MODE.to_string());
        assert_eq!(
            platform_account_kind(&account),
            Some(PlatformAccountKind::TokenPlan)
        );
        account.resource_mode = Some("token_pack".to_string());
        assert_eq!(platform_account_kind(&account), None);
        account.resource_mode = None;
        account.channel_id = "deepseek".to_string();
        assert_eq!(platform_account_kind(&account), None);
    }

    #[test]
    fn builds_cs_data_request_with_cornerstone_param() {
        let mut data = Map::new();
        data.insert(
            "commodityCode".to_string(),
            Value::String(TOKEN_PLAN_SOLO_BUY_COMMODITY.to_string()),
        );
        let (url, form) = cs_data_request(CS_API_SUBSCRIPTION, data);
        assert!(url.starts_with("https://cs-data.qianwenai.com/cli/api.json?"));
        assert!(url.contains("action=BroadScopeAspnGateway"));
        assert!(url.contains("product=sfm_bailian"));
        assert!(
            url.contains("api=zeldaHttp.apikeyMgr."),
            "api 需 URL 编码后仍在"
        );
        assert!(form.starts_with("params="));
        assert!(form.ends_with("&region=cn-beijing"));
        let params = form
            .trim_start_matches("params=")
            .split("&region=")
            .next()
            .expect("params");
        // params 是 percent-encoded 的单个值，借 form_urlencoded 的解码能力还原。
        let decoded = url::form_urlencoded::parse(format!("x={params}").as_bytes())
            .next()
            .map(|(_, value)| value.to_string())
            .expect("decoded");
        let envelope: Value = serde_json::from_str(&decoded).expect("json");
        assert_eq!(envelope["Api"], json!(CS_API_SUBSCRIPTION));
        assert_eq!(envelope["V"], json!("1.0"));
        assert_eq!(
            envelope["Data"]["commodityCode"],
            json!(TOKEN_PLAN_SOLO_BUY_COMMODITY)
        );
        assert_eq!(
            envelope["Data"]["cornerstoneParam"]["protocol"],
            json!("V2")
        );
        assert_eq!(
            envelope["Data"]["cornerstoneParam"]["consoleSite"],
            json!("QIANWENAI")
        );
    }

    #[test]
    fn validates_cs_data_envelope() {
        let ok = r#"{"code":"200","successResponse":true,"data":{"success":true,"DataV2":{"ret":["SUCCESS::ok"],"data":{"data":{"specCode":"standard"}}}}}"#;
        let value = validate_cs_data_body(ok).expect("ok");
        assert_eq!(
            value.pointer("/data/DataV2/data/data/specCode"),
            Some(&json!("standard"))
        );

        let business_error = r#"{"code":"200","data":{"success":true,"DataV2":{"ret":["INVALID_ARGUMENT::bad request"]}}}"#;
        assert!(matches!(
            validate_cs_data_body(business_error),
            Err(PlatformError::Message(message)) if message.contains("bad request")
        ));

        let not_logged_in = r#"{"code":"200","data":{"success":false,"errorCode":"BailianGateway.Login.NotLogined"}}"#;
        assert_eq!(
            validate_cs_data_body(not_logged_in),
            Err(PlatformError::AuthExpired)
        );
    }

    #[test]
    fn command_payloads_serialize_to_frontend_contract() {
        // 前端按 snake_case 的 status 与 camelCase 的字段读取，改动必须同步契约。
        for (status, expected) in [
            (LoginPollStatus::Pending, "pending"),
            (LoginPollStatus::SlowDown, "slow_down"),
            (LoginPollStatus::Complete, "complete"),
            (LoginPollStatus::Expired, "expired"),
            (LoginPollStatus::Denied, "denied"),
        ] {
            assert_eq!(
                serde_json::to_string(&status).expect("serialize"),
                format!("\"{expected}\"")
            );
        }
        let status = serde_json::to_value(PlatformStatus {
            account_id: "acc".into(),
            logged_in: true,
            aliyun_id: Some("aliyun".into()),
            email: None,
            expires_at: Some("2026-11-12T00:00:00Z".into()),
        })
        .expect("status json");
        assert_eq!(status["accountId"], json!("acc"));
        assert_eq!(status["loggedIn"], json!(true));
        assert_eq!(status["expiresAt"], json!("2026-11-12T00:00:00Z"));

        let challenge = serde_json::to_value(LoginChallenge {
            verification_url: "https://example.test/auth".into(),
            expires_in_seconds: 300,
            interval_seconds: 2,
        })
        .expect("challenge json");
        assert_eq!(
            challenge["verificationUrl"],
            json!("https://example.test/auth")
        );
        assert_eq!(challenge["expiresInSeconds"], json!(300));
        assert_eq!(challenge["intervalSeconds"], json!(2));

        let outcome = serde_json::to_value(PlatformSyncOutcome {
            account_id: "acc".into(),
            balance: Some(92.65),
            currency: Some("CNY".into()),
            synced_at: "2026-11-10T00:00:00Z".into(),
            raw_scraped_json: "{}".into(),
        })
        .expect("outcome json");
        assert_eq!(outcome["accountId"], json!("acc"));
        assert_eq!(outcome["rawScrapedJson"], json!("{}"));
    }

    #[test]
    fn normalizes_english_units_and_trims_account_identity() {
        // 线上实测 DescribeFqInstance 返回英文单位，且带 InstanceName / Uid。
        let instance = json!({
            "InstanceName": "dashscope_sfm_x",
            "Uid": 1494342465971857_i64,
            "StartTime": "Tue Nov 03 00:00:00 CST 2026",
            "Status": "valid",
            "InitCapacity": {
                "BaseValue": 1000000.0,
                "ShowUnit": "Thousand Tokens",
                "ShowValue": "1000.000000"
            },
            "CurrCapacity": {
                "BaseValue": 250000.0,
                "ShowUnit": "Thousand Tokens",
                "ShowValue": "250.000000"
            },
            "Template": {"Code": "sfm_x", "Name": "qwen3.7-plus"},
            "CurrentCycleStartTime": "Tue Nov 03 00:00:00 CST 2026",
            "CurrentCycleEndTime": "Tue Feb 02 00:00:00 CST 2027",
            "EndTime": "Tue Feb 02 00:00:00 CST 2027"
        });
        let normalized =
            normalize_free_tier_instance(&instance, &HashMap::new()).expect("normalized");
        assert!(
            normalized.get("InstanceName").is_none(),
            "账号身份不得进入快照"
        );
        assert!(normalized.get("Uid").is_none());
        assert!(normalized.get("StartTime").is_none());
        assert_eq!(
            normalized.pointer("/InitCapacity/BaseValue"),
            Some(&json!(1000000.0))
        );
        // 1000 千tokens 必须归一为 1000000 tokens，而不是 1000 tokens。
        assert_eq!(
            normalized.pointer("/InitCapacity/ShowValue"),
            Some(&Value::String("1000000".to_string()))
        );
        assert_eq!(
            normalized.pointer("/InitCapacity/ShowUnit"),
            Some(&Value::String("tokens".to_string()))
        );
        assert_eq!(
            normalized.pointer("/CurrCapacity/ShowUnit"),
            Some(&Value::String("tokens".to_string()))
        );
        assert_eq!(
            normalized.pointer("/CurrentCycleEndTime"),
            Some(&json!("Tue Feb 02 00:00:00 CST 2027"))
        );

        // 万字 / 秒 / 张 三种其它单位。
        let word = normalize_free_tier_instance(
            &json!({
                "Status": "valid",
                "InitCapacity": {"BaseValue": 1000000.0, "ShowUnit": "TenThousand Word", "ShowValue": "100.0"},
                "Template": {"Code": "sfm_w", "Name": "qwen-w"}
            }),
            &HashMap::new(),
        )
        .expect("word");
        assert_eq!(
            word.pointer("/InitCapacity/ShowUnit"),
            Some(&Value::String("字".to_string()))
        );
        assert_eq!(
            word.pointer("/InitCapacity/ShowValue"),
            Some(&Value::String("1000000".to_string()))
        );
        let second = normalize_capacity(&json!({"BaseValue": 3600.0, "ShowUnit": "Second"}));
        assert_eq!(second["ShowUnit"], json!("秒"));
        let piece = normalize_capacity(&json!({"BaseValue": 500.0, "ShowUnit": "Piece"}));
        assert_eq!(piece["ShowUnit"], json!("张"));
    }

    #[test]
    fn capacity_falls_back_to_show_value_times_scale() {
        // BaseValue 缺失时，用 ShowValue × 单位数量级推导基础值。
        let capacity =
            normalize_capacity(&json!({"ShowUnit": "Thousand Tokens", "ShowValue": "12.5"}));
        assert_eq!(capacity["BaseValue"], json!(12500.0));
        assert_eq!(capacity["ShowValue"], json!("12500"));
        assert_eq!(capacity["ShowUnit"], json!("tokens"));
    }

    #[test]
    fn parses_numeric_user_id_from_live_token_payload() {
        // 线上实测：User.Id 是数字，且没有 email / AliyunId。
        let body = r#"{"Success":true,"Data":{"Status":"complete","Credentials":{"AccessToken":"at","ExpireTime":"2026-11-12T05:54:20Z","User":{"Id":1494342465971857}}}}"#;
        let outcome = parse_token_body(body).expect("complete");
        assert_eq!(
            outcome,
            TokenPollOutcome::Complete {
                access_token: "at".to_string(),
                expires_at: Some("2026-11-12T05:54:20Z".to_string()),
                aliyun_id: Some("1494342465971857".to_string()),
                email: None,
            }
        );
    }

    #[test]
    fn extracts_billing_slot_from_gateway_data() {
        let slot = billing_slot_from_gateway(&json!({"AvailableAmount": "9.5", "Currency": "CNY"}))
            .expect("slot");
        assert_eq!(slot["AvailableAmount"], json!("9.5"));
        assert_eq!(slot["Currency"], json!("CNY"));

        // 控制台口径的字段原样保留，供前端展示未结清 / 现金余额 / 账单状态。
        let rich = billing_slot_from_gateway(&json!({
            "AvailableAmount": 12.5,
            "SettleCurrency": "CNY",
            "UnsettledAmount": 1.2,
            "CashBalanceAmount": 10.0,
            "BillingAccountStatus": "valid"
        }))
        .expect("slot");
        assert_eq!(rich["UnsettledAmount"], json!(1.2));
        assert_eq!(rich["SettleCurrency"], json!("CNY"));

        assert!(billing_slot_from_gateway(&json!({})).is_none());
        assert!(billing_slot_from_gateway(&json!({"AvailableAmount": null})).is_none());
    }

    #[test]
    fn billing_cycle_uses_beijing_time() {
        // 2026-11-10T00:30+00:00 = 北京时间 2026-11-10 08:30
        let utc = DateTime::parse_from_rfc3339("2026-11-10T00:30:00Z")
            .expect("parse")
            .with_timezone(&Utc);
        assert_eq!(now_billing_cycle_yyyymm(utc), "202611");
        // 2026-10-31T17:00Z = 北京时间 2026-11-01 01:00
        let utc = DateTime::parse_from_rfc3339("2026-10-31T17:00:00Z")
            .expect("parse")
            .with_timezone(&Utc);
        assert_eq!(now_billing_cycle_yyyymm(utc), "202611");
    }

    #[test]
    fn rejects_unsafe_account_ids() {
        assert!(validate_account_id("acc-1_ok").is_ok());
        assert!(validate_account_id("../etc/passwd").is_err());
        assert!(validate_account_id("").is_err());
    }

    #[test]
    fn expires_at_accepts_rfc3339_and_unix_seconds() {
        let now = DateTime::parse_from_rfc3339("2026-11-10T00:00:00Z")
            .expect("parse")
            .with_timezone(&Utc);
        let expired = PlatformCredentials {
            access_token: "t".into(),
            expires_at: Some("2026-11-09T00:00:00Z".into()),
            aliyun_id: None,
            email: None,
            updated_at: now.to_rfc3339(),
        };
        assert!(expired.is_expired(now));
        let future = PlatformCredentials {
            expires_at: Some((now.timestamp() + 3600).to_string()),
            ..expired.clone()
        };
        assert!(!future.is_expired(now));
        let unknown = PlatformCredentials {
            expires_at: Some("not-a-date".into()),
            ..expired
        };
        assert!(!unknown.is_expired(now));
    }

    #[test]
    fn credential_file_roundtrip() {
        let dir =
            std::env::temp_dir().join(format!("flowlet-qwen-platform-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("mkdir");
        let database = dir.join("flowlet.db");
        let storage = Storage::open(&database).expect("open storage");
        let credentials = PlatformCredentials {
            access_token: "token".into(),
            expires_at: Some("2026-12-01T00:00:00Z".into()),
            aliyun_id: Some("aliyun".into()),
            email: Some("a@b.c".into()),
            updated_at: "2026-11-10T00:00:00Z".into(),
        };
        save_credentials(&storage, "acc-1", &credentials).expect("save");
        assert_eq!(
            load_credentials(&storage, "acc-1").expect("load"),
            Some(credentials.clone())
        );
        assert!(remove_credentials(&storage, "acc-1").expect("remove"));
        assert_eq!(load_credentials(&storage, "acc-1").expect("load"), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
