//! Browser OAuth and account-scoped remote quota observation; no client process required.
use super::antigravity_account::{
    fraction, reset_at, string, summary_quotas, AntigravityAccountReport,
    AntigravityAccountsReport, AntigravityQuota,
};
use base64::Engine;
use futures_util::{stream, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::sync::Mutex;

// Serializes refresh/rotation, authorization commits and deletion, preventing resurrection
// after delete or two refreshes overwriting a rotated refresh token. Browser wait is outside it.
static STORE_LOCK: Mutex<()> = Mutex::const_new(());
static LOGIN_LOCK: Mutex<()> = Mutex::const_new(());
const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const USERINFO_URL: &str = "https://www.googleapis.com/oauth2/v2/userinfo";
const CLOUD_URL: &str = "https://cloudcode-pa.googleapis.com";
const SUMMARY_URL: &str =
    "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";

// Public installed-application OAuth client configuration, not a user's credential.
// Consumer client pairing verified against Antigravity-Manager commit
// 0067fe045ddd77f4462ea8e2c25384839d869f32 (src-tauri/src/modules/oauth.rs).
// Do not infer a client/secret pair from string-pool ordering in installed binaries.
#[derive(Clone, Deserialize, Serialize)]
struct OAuthClient {
    client_id: String,
    client_secret: String,
}

#[derive(Clone, Deserialize, Serialize)]
struct Credentials {
    client: OAuthClient,
    access_token: String,
    refresh_token: String,
    expires_at: i64,
    email: String,
    project: Option<String>,
}

#[derive(Deserialize, Serialize)]
struct StoredAccount {
    credentials: Credentials,
    snapshot: AntigravityAccountReport,
}

#[derive(Debug)]
struct RemoteError {
    message: String,
    reauthorize: bool,
    status: Option<u16>,
}
impl RemoteError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            reauthorize: false,
            status: None,
        }
    }
}

#[derive(Clone)]
struct Endpoints {
    token: String,
    userinfo: String,
    cloud: String,
    summary: String,
}
impl Default for Endpoints {
    fn default() -> Self {
        Self {
            token: TOKEN_URL.into(),
            userinfo: USERINFO_URL.into(),
            cloud: CLOUD_URL.into(),
            summary: SUMMARY_URL.into(),
        }
    }
}

fn resolve_client() -> Result<OAuthClient, String> {
    let id = std::env::var("ANTIGRAVITY_OAUTH_CLIENT_ID").ok();
    let secret = std::env::var("ANTIGRAVITY_OAUTH_CLIENT_SECRET").ok();
    match (id, secret) {
        (Some(client_id), Some(client_secret))
            if !client_id.trim().is_empty() && !client_secret.trim().is_empty() =>
        {
            Ok(OAuthClient {
                client_id,
                client_secret,
            })
        }
        _ => Err(
            "未配置 Antigravity OAuth 客户端：请成对设置 ANTIGRAVITY_OAUTH_CLIENT_ID 与 \
             ANTIGRAVITY_OAUTH_CLIENT_SECRET（来源与安全说明见 docs/antigravity-account.md）"
                .into(),
        ),
    }
}

fn http_client() -> Result<reqwest::Client, String> {
    super::upstream_proxy::apply_to(reqwest::Client::builder())?
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|_| "无法创建 Antigravity 远端连接".into())
}

async fn response_json(response: reqwest::Response) -> Result<Value, RemoteError> {
    let status = response.status().as_u16();
    let mut response = response;
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| RemoteError::new("Antigravity 远端响应读取失败"))?
    {
        if bytes.len() + chunk.len() > 2 * 1024 * 1024 {
            return Err(RemoteError::new("Antigravity 远端响应过大"));
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    if !(200..300).contains(&status) {
        let reauthorize = status == 401 || value["error"] == "invalid_grant";
        let message = if reauthorize {
            "Antigravity 授权已失效，请重新授权".into()
        } else if value["error"] == "invalid_client" {
            "Google 拒绝了 OAuth 客户端，请更新 Flowlet 或配置匹配的 OAuth 客户端".into()
        } else if status == 403 {
            "此账号无权读取 Antigravity 额度".into()
        } else {
            format!("Antigravity 远端接口返回 HTTP {status}")
        };
        return Err(RemoteError {
            message,
            reauthorize,
            status: Some(status),
        });
    }
    if !value.is_object() || value.get("error").is_some() {
        return Err(RemoteError::new("Antigravity 远端接口返回了无效数据"));
    }
    Ok(value)
}

async fn send(request: reqwest::RequestBuilder) -> Result<Value, RemoteError> {
    let stage = request
        .try_clone()
        .and_then(|builder| builder.build().ok())
        .map(|request| match request.url().path() {
            "/token" => "Google 令牌交换/续期",
            "/oauth2/v2/userinfo" => "Google 账号身份验证",
            "/v1internal:loadCodeAssist" => "Antigravity 账号信息",
            "/v1internal:retrieveUserQuotaSummary" => "Antigravity 分组额度",
            "/v1internal:retrieveUserQuota" => "Antigravity 模型额度",
            _ => "Antigravity 远端接口",
        })
        .unwrap_or("Antigravity 远端接口");
    let response = request.send().await.map_err(|error| {
        let reason = if error.is_timeout() {
            "请求超时"
        } else if error.is_connect() {
            "连接失败"
        } else {
            "请求发送失败"
        };
        // Never include error URLs, OAuth codes, request bodies or credentials.
        RemoteError::new(format!("{stage}{reason}，请检查网络或上游代理设置后重试"))
    })?;
    response_json(response).await
}

fn user_agent() -> String {
    let platform = if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(windows) {
        "windows"
    } else {
        "linux"
    };
    let arch = if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "amd64"
    };
    format!("antigravity/hub/2.9.1 {platform}/{arch}")
}

async fn cloud_post(
    client: &reqwest::Client,
    url: &str,
    token: &str,
    body: &Value,
) -> Result<Value, RemoteError> {
    send(
        client
            .post(url)
            .bearer_auth(token)
            .header("User-Agent", user_agent())
            .json(body),
    )
    .await
}

fn metadata() -> Value {
    json!({"ideType":"ANTIGRAVITY", "platform":"PLATFORM_UNSPECIFIED", "pluginType":"GEMINI"})
}

fn project_id(value: &Value) -> Option<String> {
    string(value)
        .or_else(|| string(&value["id"]))
        .or_else(|| string(&value["projectId"]))
}

fn plan_name(value: &Value) -> Option<String> {
    string(&value["paidTier"]["name"])
        .or_else(|| string(&value["paidTier"]["id"]))
        .or_else(|| string(&value["planInfo"]["planType"]))
        .or_else(|| string(&value["currentTier"]["name"]))
        .or_else(|| string(&value["currentTier"]["id"]))
}

fn has_measured_quota(quotas: &[AntigravityQuota]) -> bool {
    quotas
        .iter()
        .any(|q| !q.disabled && q.remaining_fraction.is_some())
}

fn verified_buckets(value: &Value) -> Vec<AntigravityQuota> {
    value["buckets"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|bucket| {
            let id = string(&bucket["modelId"])?;
            Some(AntigravityQuota {
                label: id.clone(),
                id,
                remaining_fraction: fraction(&bucket["remainingFraction"]),
                reset_at: reset_at(&bucket["resetTime"]),
                description: None,
                disabled: false,
            })
        })
        .collect()
}

async fn refresh_token(
    client: &reqwest::Client,
    endpoints: &Endpoints,
    credentials: &mut Credentials,
) -> Result<(), RemoteError> {
    let value = send(client.post(&endpoints.token).form(&[
        ("grant_type", "refresh_token"),
        ("refresh_token", &credentials.refresh_token),
        ("client_id", &credentials.client.client_id),
        ("client_secret", &credentials.client.client_secret),
    ]))
    .await?;
    let mut refreshed = credentials.clone();
    apply_tokens(&mut refreshed, &value)?;
    // Never attribute or commit a refreshed credential before verifying its owner.
    let email = user_email(client, endpoints, &refreshed.access_token).await?;
    if email != credentials.email {
        return Err(RemoteError {
            reauthorize: true,
            ..RemoteError::new("授权账号身份不一致，请重新授权")
        });
    }
    *credentials = refreshed;
    Ok(())
}

fn apply_tokens(credentials: &mut Credentials, value: &Value) -> Result<(), RemoteError> {
    credentials.access_token =
        string(&value["access_token"]).ok_or_else(|| RemoteError::new("Google 未返回访问令牌"))?;
    if let Some(refresh) = string(&value["refresh_token"]) {
        credentials.refresh_token = refresh;
    }
    let expires = value["expires_in"]
        .as_i64()
        .filter(|n| *n > 0)
        .ok_or_else(|| RemoteError::new("Google 未返回有效的令牌有效期"))?;
    credentials.expires_at = chrono::Utc::now().timestamp().saturating_add(expires);
    Ok(())
}

async fn user_email(
    client: &reqwest::Client,
    endpoints: &Endpoints,
    token: &str,
) -> Result<String, RemoteError> {
    let user = send(client.get(&endpoints.userinfo).bearer_auth(token)).await?;
    if user["verified_email"] != true {
        return Err(RemoteError::new("Google 账号邮箱尚未验证"));
    }
    string(&user["email"])
        .map(|s| s.to_lowercase())
        .ok_or_else(|| RemoteError::new("Google 未返回账号身份"))
}

async fn fetch_quota(
    client: &reqwest::Client,
    endpoints: &Endpoints,
    credentials: &mut Credentials,
) -> Result<(Option<String>, Vec<AntigravityQuota>, String), RemoteError> {
    let load_url = format!("{}/v1internal:loadCodeAssist", endpoints.cloud);
    let assist = cloud_post(
        client,
        &load_url,
        &credentials.access_token,
        &json!({"metadata": metadata()}),
    )
    .await?;
    if assist["ineligibleTiers"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|tier| tier["reasonCode"] == "GOOGLE_TOS_NOT_SUPPORTED_BY_CLIENT")
        && assist.get("currentTier").is_none_or(Value::is_null)
        && credentials.project.is_none()
        && project_id(&assist["cloudaicompanionProject"]).is_none()
    {
        return Err(RemoteError {
            reauthorize: true,
            ..RemoteError::new("此 OAuth 授权不能读取该账号额度，请重新授权")
        });
    }
    credentials.project =
        project_id(&assist["cloudaicompanionProject"]).or(credentials.project.clone());
    // Quota observation must not provision or change a Google Cloud account.
    // Users needing initial onboarding are directed to the official client once.
    let project = credentials.project.as_ref().ok_or_else(|| {
        RemoteError::new("账号尚未完成 Antigravity 初始化，请先在官方客户端登录一次")
    })?;
    let body = json!({"project":project});
    let summary = cloud_post(client, &endpoints.summary, &credentials.access_token, &body).await;
    let quotas = match summary {
        Ok(value) => summary_quotas(&value),
        Err(error) if error.reauthorize => return Err(error),
        Err(_) => Vec::new(),
    };
    let plan = plan_name(&assist);
    if has_measured_quota(&quotas) {
        return Ok((plan, quotas, "summary".into()));
    }
    // retrieveUserQuota is the measurement source. Never fabricate 100% from model availability.
    let buckets = cloud_post(
        client,
        &format!("{}/v1internal:retrieveUserQuota", endpoints.cloud),
        &credentials.access_token,
        &body,
    )
    .await?;
    let mut quotas = verified_buckets(&buckets);
    if !has_measured_quota(&quotas) {
        return Err(RemoteError::new(
            "远端未返回可测量额度，当前只能确认模型可用性",
        ));
    }
    // Fetch model names only after measured buckets have been confirmed.
    if let Ok(models) = cloud_post(
        client,
        &format!("{}/v1internal:fetchAvailableModels", endpoints.cloud),
        &credentials.access_token,
        &body,
    )
    .await
    {
        for quota in &mut quotas {
            if let Some(name) = string(&models["models"][&quota.id]["displayName"])
                .or_else(|| string(&models["models"][&quota.id]["label"]))
            {
                quota.label = name;
            }
        }
    }
    Ok((plan, quotas, "models".into()))
}

fn account_path(root: &Path, account_id: &str) -> PathBuf {
    root.join(format!(
        "{:x}.json",
        Sha256::digest(account_id.to_lowercase().as_bytes())
    ))
}

fn write_account(root: &Path, account: &StoredAccount) -> Result<(), String> {
    use std::io::Write;
    let mut dir = std::fs::DirBuilder::new();
    dir.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        dir.mode(0o700);
    }
    dir.create(root)
        .map_err(|_| "无法创建 Antigravity 授权目录".to_owned())?;
    let path = account_path(root, &account.credentials.email);
    let temporary = root.join(format!(".pending-{}.json", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .map_err(|_| "无法写入 Antigravity 授权文件".to_owned())?;
        let bytes = serde_json::to_vec(account)
            .map_err(|_| "无法序列化 Antigravity 授权数据".to_owned())?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "无法保存 Antigravity 授权数据".to_owned())?;
        drop(file);
        #[cfg(not(windows))]
        std::fs::rename(&temporary, &path)
            .map_err(|_| "无法更新 Antigravity 授权文件".to_owned())?;
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            use windows_sys::Win32::Storage::FileSystem::{
                MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
            };
            let from: Vec<u16> = temporary.as_os_str().encode_wide().chain(Some(0)).collect();
            let to: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
            if unsafe {
                MoveFileExW(
                    from.as_ptr(),
                    to.as_ptr(),
                    MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
                )
            } == 0
            {
                return Err("无法更新 Antigravity 授权文件".into());
            }
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result
}

fn read_account(path: &Path) -> Result<StoredAccount, String> {
    let content = std::fs::read(path).map_err(|_| "无法读取 Antigravity 授权文件".to_owned())?;
    serde_json::from_slice(&content).map_err(|_| "Antigravity 授权文件格式无效".into())
}

fn new_snapshot(email: &str) -> AntigravityAccountReport {
    AntigravityAccountReport {
        account_id: email.into(),
        email: Some(email.into()),
        source: "oauth".into(),
        stale: false,
        reauthorization_required: false,
        plan: None,
        quotas: Vec::new(),
        quota_source: None,
        updated_at: chrono::Utc::now().to_rfc3339(),
        error: None,
    }
}

async fn refresh_account(
    root: &Path,
    mut account: StoredAccount,
    client: &reqwest::Client,
    endpoints: &Endpoints,
) -> Result<AntigravityAccountReport, String> {
    let result = tokio::time::timeout(Duration::from_secs(35), async {
        if account.credentials.expires_at <= chrono::Utc::now().timestamp() + 60 {
            refresh_token(client, endpoints, &mut account.credentials).await?;
            write_account(root, &account).map_err(RemoteError::new)?;
        }
        let mut result = fetch_quota(client, endpoints, &mut account.credentials).await;
        if result
            .as_ref()
            .is_err_and(|error| error.status == Some(401))
        {
            refresh_token(client, endpoints, &mut account.credentials).await?;
            write_account(root, &account).map_err(RemoteError::new)?;
            result = fetch_quota(client, endpoints, &mut account.credentials).await;
        }
        result
    })
    .await
    .unwrap_or_else(|_| Err(RemoteError::new("Antigravity 远端额度查询超时")));
    match result {
        Ok((plan, quotas, source)) => {
            account.snapshot = new_snapshot(&account.credentials.email);
            account.snapshot.plan = plan;
            account.snapshot.quotas = quotas;
            account.snapshot.quota_source = Some(source);
        }
        Err(error) => {
            account.snapshot.stale = true;
            account.snapshot.error = Some(error.message);
            account.snapshot.reauthorization_required = error.reauthorize;
        }
    }
    write_account(root, &account)?;
    Ok(account.snapshot)
}

pub async fn query_accounts(root: &Path) -> Result<AntigravityAccountsReport, String> {
    let _guard = STORE_LOCK.lock().await;
    if !root.exists() {
        return Ok(AntigravityAccountsReport {
            accounts: Vec::new(),
        });
    }
    let entries =
        std::fs::read_dir(root).map_err(|_| "无法读取 Antigravity 授权目录".to_owned())?;
    let mut accounts = Vec::new();
    for entry in entries {
        let path = entry
            .map_err(|_| "无法读取 Antigravity 授权账号".to_owned())?
            .path();
        let name = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
        if path.extension().is_some_and(|ext| ext == "json")
            && name.len() == 64
            && name.bytes().all(|c| c.is_ascii_hexdigit())
        {
            let account = read_account(&path)?;
            if account_path(root, &account.credentials.email) != path {
                return Err("Antigravity 授权文件身份不一致".into());
            }
            accounts.push(account);
        }
    }
    if accounts.is_empty() {
        return Ok(AntigravityAccountsReport {
            accounts: Vec::new(),
        });
    }
    let client = http_client()?;
    let endpoints = Endpoints::default();
    let results = stream::iter(
        accounts
            .into_iter()
            .map(|account| refresh_account(root, account, &client, &endpoints)),
    )
    .buffer_unordered(4)
    .collect::<Vec<_>>()
    .await;
    let mut accounts = results.into_iter().collect::<Result<Vec<_>, _>>()?;
    accounts.sort_by(|a, b| a.account_id.cmp(&b.account_id));
    Ok(AntigravityAccountsReport { accounts })
}

pub async fn delete_account(root: &Path, account_id: &str) -> Result<(), String> {
    let _guard = STORE_LOCK.lock().await;
    let path = account_path(root, account_id);
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("无法移除 Antigravity 授权".into()),
    }
}

fn authorization_url(client_id: &str, redirect: &str, state: &str, verifier: &str) -> String {
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(Sha256::digest(verifier.as_bytes()));
    let mut url = url::Url::parse(AUTH_URL).expect("static Google OAuth URL");
    url.query_pairs_mut().extend_pairs([
        ("client_id", client_id), ("redirect_uri", redirect), ("response_type", "code"),
        ("scope", "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email"),
        ("access_type", "offline"), ("prompt", "select_account consent"), ("state", state),
        ("code_challenge", &challenge), ("code_challenge_method", "S256"),
    ]);
    url.into()
}

type CallbackSender =
    std::sync::Arc<std::sync::Mutex<Option<tokio::sync::oneshot::Sender<Result<String, String>>>>>;
#[derive(Clone)]
struct CallbackState {
    nonce: String,
    sender: CallbackSender,
}

async fn oauth_callback(
    axum::extract::State(state): axum::extract::State<CallbackState>,
    axum::extract::Query(query): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> (axum::http::StatusCode, &'static str) {
    if query.get("state") != Some(&state.nonce) {
        return (
            axum::http::StatusCode::BAD_REQUEST,
            "Invalid OAuth state. Return to Flowlet to retry.",
        );
    }
    let result = if query.contains_key("error") {
        Err("Google 授权已取消或被拒绝".into())
    } else {
        query
            .get("code")
            .filter(|code| !code.is_empty())
            .cloned()
            .ok_or_else(|| "Google 未返回授权码".into())
    };
    if let Ok(mut sender) = state.sender.lock() {
        if let Some(sender) = sender.take() {
            let _ = sender.send(result);
        }
    }
    (
        axum::http::StatusCode::OK,
        "Authorization response received. You can return to Flowlet.",
    )
}

pub async fn authorize<F>(root: &Path, open_url: F) -> Result<AntigravityAccountReport, String>
where
    F: FnOnce(&str) -> Result<(), String>,
{
    // Reject a second login rather than leaving another callback listener/browser session alive.
    let _login = LOGIN_LOCK
        .try_lock()
        .map_err(|_| "Antigravity 授权正在进行，请完成当前浏览器登录".to_owned())?;
    authorize_with(
        root,
        open_url,
        resolve_client()?,
        http_client()?,
        Endpoints::default(),
        Duration::from_secs(180),
    )
    .await
}

async fn authorize_with<F>(
    root: &Path,
    open_url: F,
    oauth_client: OAuthClient,
    client: reqwest::Client,
    endpoints: Endpoints,
    wait: Duration,
) -> Result<AntigravityAccountReport, String>
where
    F: FnOnce(&str) -> Result<(), String>,
{
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|_| "无法启动 Google OAuth 本地回调".to_owned())?;
    let port = listener
        .local_addr()
        .map_err(|_| "无法读取 Google OAuth 回调端口".to_owned())?
        .port();
    let redirect = format!("http://127.0.0.1:{port}/oauth/callback");
    let nonce = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let verifier = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let state = CallbackState {
        nonce: nonce.clone(),
        sender: std::sync::Arc::new(std::sync::Mutex::new(Some(sender))),
    };
    let router = axum::Router::new()
        .route("/oauth/callback", axum::routing::get(oauth_callback))
        .with_state(state);
    // Keep serving in the same future: timeout/cancellation/drop closes the listener, no detached task.
    let url = authorization_url(&oauth_client.client_id, &redirect, &nonce, &verifier);
    open_url(&url)?;
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let server = axum::serve(listener, router).with_graceful_shutdown(async {
        let _ = stopped.await;
    });
    use std::future::IntoFuture;
    let server = server.into_future();
    tokio::pin!(server);
    let code = tokio::time::timeout(wait, async {
        let code = tokio::select! {
            code = receiver => code.map_err(|_| "Google OAuth 回调已关闭".to_owned())?,
            _ = &mut server => Err("Google OAuth 回调服务已停止".to_owned()),
        };
        let _ = stop.send(());
        // Flush the browser response before releasing the loopback listener.
        let _ = tokio::time::timeout(Duration::from_secs(2), &mut server).await;
        code
    })
    .await
    .map_err(|_| "Google 授权等待超时，请重新授权".to_owned())??;
    let tokens = send(client.post(&endpoints.token).form(&[
        ("grant_type", "authorization_code"),
        ("code", &code),
        ("redirect_uri", &redirect),
        ("client_id", &oauth_client.client_id),
        ("client_secret", &oauth_client.client_secret),
        ("code_verifier", &verifier),
    ]))
    .await
    .map_err(|error| error.message)?;
    let mut credentials = Credentials {
        client: oauth_client,
        access_token: String::new(),
        refresh_token: String::new(),
        expires_at: 0,
        email: String::new(),
        project: None,
    };
    apply_tokens(&mut credentials, &tokens).map_err(|error| error.message)?;
    if credentials.refresh_token.is_empty() {
        return Err("Google 未授予离线访问权限，请重新授权并允许访问".into());
    }
    credentials.email = user_email(&client, &endpoints, &credentials.access_token)
        .await
        .map_err(|error| error.message)?;
    let _guard = STORE_LOCK.lock().await;
    let snapshot = if account_path(root, &credentials.email).exists() {
        read_account(&account_path(root, &credentials.email))?.snapshot
    } else {
        new_snapshot(&credentials.email)
    };
    let account = StoredAccount {
        snapshot,
        credentials,
    };
    // Save the successful login even if the quota API is temporarily unavailable.
    write_account(root, &account)?;
    refresh_account(root, account, &client, &endpoints).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        extract::{Form, State},
        http::{HeaderMap, StatusCode},
        routing::{get, post},
        Json, Router,
    };
    use std::{
        collections::HashMap,
        sync::{Arc, Mutex as StdMutex},
    };

    struct TestRoot(PathBuf);
    impl TestRoot {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!("flowlet-ag-oauth-{}", uuid::Uuid::new_v4())))
        }
    }
    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[derive(Default)]
    struct Fixture {
        mode: String,
        forms: StdMutex<Vec<HashMap<String, String>>>,
        challenge: StdMutex<Option<String>>,
    }
    struct Mock {
        endpoints: Endpoints,
        state: Arc<Fixture>,
        task: tokio::task::JoinHandle<()>,
    }
    impl Drop for Mock {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    async fn mock(mode: &str) -> Mock {
        async fn tokens(
            State(state): State<Arc<Fixture>>,
            Form(form): Form<HashMap<String, String>>,
        ) -> (StatusCode, Json<Value>) {
            assert_eq!(form["client_secret"], "public+secret&=");
            if form["grant_type"] == "authorization_code" {
                let verifier = &form["code_verifier"];
                assert_eq!(
                    Some(
                        base64::engine::general_purpose::URL_SAFE_NO_PAD
                            .encode(Sha256::digest(verifier))
                    ),
                    *state.challenge.lock().unwrap()
                );
                assert_eq!(form["code"], "test+code&=");
            } else {
                assert_eq!(form["refresh_token"], "old+refresh&=");
            }
            state.forms.lock().unwrap().push(form);
            if state.mode == "expired" {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(
                        json!({"error":"invalid_grant", "error_description":"sensitive-do-not-echo"}),
                    ),
                );
            }
            (
                StatusCode::OK,
                Json(
                    json!({"access_token":"fresh-token", "refresh_token":"rotated-token", "expires_in":3600}),
                ),
            )
        }
        async fn user(State(state): State<Arc<Fixture>>, headers: HeaderMap) -> Json<Value> {
            assert_eq!(headers["authorization"], "Bearer fresh-token");
            Json(
                json!({"email": if state.mode == "mismatch" { "other@example.test" } else { "test@example.test" }, "verified_email":true}),
            )
        }
        async fn assist(
            State(state): State<Arc<Fixture>>,
            headers: HeaderMap,
            Json(body): Json<Value>,
        ) -> (StatusCode, Json<Value>) {
            assert_eq!(headers["user-agent"], user_agent());
            assert_eq!(body["metadata"]["ideType"], "ANTIGRAVITY");
            if state.mode == "unauthorized" && headers["authorization"] != "Bearer fresh-token" {
                return (
                    StatusCode::UNAUTHORIZED,
                    Json(json!({"error":"unauthenticated"})),
                );
            }
            (
                StatusCode::OK,
                Json(
                    json!({"cloudaicompanionProject":{"id":"test-project"}, "paidTier":{"name":"Ultra"}, "currentTier":{"name":"Free"}}),
                ),
            )
        }
        async fn summary(
            State(state): State<Arc<Fixture>>,
            Json(body): Json<Value>,
        ) -> (StatusCode, Json<Value>) {
            assert_eq!(body["project"], "test-project");
            if state.mode == "buckets" || state.mode == "unmeasured" {
                return (StatusCode::NOT_FOUND, Json(json!({})));
            }
            if state.mode == "denied" {
                return (
                    StatusCode::FORBIDDEN,
                    Json(json!({"error":"sensitive-do-not-echo"})),
                );
            }
            (
                StatusCode::OK,
                Json(
                    json!({"response":{"groups":[{"displayName":"Gemini", "buckets":[
                        {"bucketId":"weekly", "displayName":"Weekly", "remaining":{"remainingFraction":0.4}, "resetTime":"2026-11-07T00:00:00Z"}
                    ]}]}}),
                ),
            )
        }
        async fn buckets(State(state): State<Arc<Fixture>>) -> (StatusCode, Json<Value>) {
            if state.mode == "denied" {
                return (
                    StatusCode::FORBIDDEN,
                    Json(json!({"error":"sensitive-do-not-echo"})),
                );
            }
            (
                StatusCode::OK,
                Json(if state.mode == "unmeasured" {
                    json!({"buckets":[{"modelId":"gemini"}]})
                } else {
                    json!({"buckets":[{"modelId":"gemini", "remainingFraction":0.2}]})
                }),
            )
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let state = Arc::new(Fixture {
            mode: mode.into(),
            ..Default::default()
        });
        let router = Router::new().route("/token", post(tokens)).route("/user", get(user))
            .route("/v1internal:loadCodeAssist", post(assist)).route("/summary", post(summary))
            .route("/v1internal:retrieveUserQuota", post(buckets))
            .route("/v1internal:fetchAvailableModels", post(|| async { Json(json!({"models":{"gemini":{"displayName":"Gemini","quotaInfo":{"remainingFraction":1}}}})) }))
            .with_state(state.clone());
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        Mock {
            endpoints: Endpoints {
                token: format!("{base}/token"),
                userinfo: format!("{base}/user"),
                cloud: base.clone(),
                summary: format!("{base}/summary"),
            },
            state,
            task,
        }
    }
    fn test_credentials() -> Credentials {
        Credentials {
            client: OAuthClient {
                client_id: "test-client".into(),
                client_secret: "public+secret&=".into(),
            },
            access_token: "old-token".into(),
            refresh_token: "old+refresh&=".into(),
            expires_at: 0,
            email: "test@example.test".into(),
            project: None,
        }
    }
    fn client() -> reqwest::Client {
        reqwest::Client::builder().no_proxy().build().unwrap()
    }

    #[test]
    fn authorization_url_uses_state_offline_access_and_rfc7636_pkce() {
        let url = url::Url::parse(&authorization_url(
            "client",
            "http://127.0.0.1:1234/oauth/callback",
            "nonce",
            "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
        ))
        .unwrap();
        assert_eq!(url.host_str(), Some("accounts.google.com"));
        let query: HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(query["state"], "nonce");
        assert_eq!(query["access_type"], "offline");
        assert_eq!(query["code_challenge_method"], "S256");
        assert_eq!(
            query["code_challenge"],
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[tokio::test]
    async fn forged_callback_cannot_complete_or_replace_a_valid_authorization() {
        let (tx, mut rx) = tokio::sync::oneshot::channel();
        let state = CallbackState {
            nonce: "expected".into(),
            sender: Arc::new(StdMutex::new(Some(tx))),
        };
        let query = |state: &str, code: &str| {
            axum::extract::Query(HashMap::from([
                ("state".into(), state.into()),
                ("code".into(), code.into()),
            ]))
        };
        assert_eq!(
            oauth_callback(State(state.clone()), query("forged", "bad"))
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
        assert!(rx.try_recv().is_err());
        assert_eq!(
            oauth_callback(State(state.clone()), query("expected", "good"))
                .await
                .0,
            StatusCode::OK
        );
        assert_eq!(rx.await.unwrap().unwrap(), "good");
        assert!(state.sender.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn browser_login_persists_offline_authorization_and_measured_quota_without_a_client_process(
    ) {
        let mock = mock("summary").await;
        let root = TestRoot::new();
        let state = mock.state.clone();
        let (callback_done, callback_result) = tokio::sync::oneshot::channel();
        let open = move |url: &str| {
            let parsed = url::Url::parse(url).unwrap();
            let query: HashMap<_, _> = parsed.query_pairs().into_owned().collect();
            *state.challenge.lock().unwrap() = Some(query["code_challenge"].clone());
            let mut callback = url::Url::parse(&query["redirect_uri"]).unwrap();
            callback
                .query_pairs_mut()
                .append_pair("state", &query["state"])
                .append_pair("code", "test+code&=");
            tokio::spawn(async move {
                let response = client().get(callback).send().await.unwrap();
                assert_eq!(response.status(), StatusCode::OK);
                assert!(response.text().await.unwrap().contains("return to Flowlet"));
                let _ = callback_done.send(());
            });
            Ok(())
        };
        let report = authorize_with(
            &root.0,
            open,
            test_credentials().client,
            client(),
            mock.endpoints.clone(),
            Duration::from_secs(3),
        )
        .await
        .unwrap();
        callback_result.await.unwrap();
        assert_eq!(report.source, "oauth");
        assert_eq!(report.plan.as_deref(), Some("Ultra"));
        assert_eq!(report.quotas[0].remaining_fraction, Some(0.4));
        let stored = read_account(&account_path(&root.0, &report.account_id)).unwrap();
        assert_eq!(stored.credentials.refresh_token, "rotated-token");
        let public = serde_json::to_string(&report).unwrap();
        assert!(
            !public.contains("fresh-token")
                && !public.contains("rotated-token")
                && !public.contains("public+secret")
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(account_path(&root.0, &report.account_id))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
            assert_eq!(
                std::fs::metadata(&root.0).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
        delete_account(&root.0, &report.account_id).await.unwrap();
        assert!(!account_path(&root.0, &report.account_id).exists());
    }

    #[tokio::test]
    async fn refresh_rotation_is_persisted_even_when_quota_fails_and_old_snapshot_stays_stale() {
        let mock = mock("denied").await;
        let root = TestRoot::new();
        let mut snapshot = new_snapshot("test@example.test");
        snapshot.updated_at = "2026-11-01T00:00:00Z".into();
        snapshot.quotas =
            verified_buckets(&json!({"buckets":[{"modelId":"gemini","remainingFraction":0.7}]}));
        let stored = StoredAccount {
            credentials: test_credentials(),
            snapshot,
        };
        let report = refresh_account(&root.0, stored, &client(), &mock.endpoints)
            .await
            .unwrap();
        assert!(report.stale);
        assert_eq!(report.updated_at, "2026-11-01T00:00:00Z");
        assert_eq!(report.quotas[0].remaining_fraction, Some(0.7));
        assert!(!report.error.as_ref().unwrap().contains("sensitive"));
        let persisted = read_account(&account_path(&root.0, &report.account_id)).unwrap();
        assert_eq!(persisted.credentials.refresh_token, "rotated-token");
    }

    #[tokio::test]
    async fn invalid_grant_is_explicit_and_identity_mismatch_does_not_persist_rotated_credentials()
    {
        for mode in ["expired", "mismatch"] {
            let mock = mock(mode).await;
            let root = TestRoot::new();
            let stored = StoredAccount {
                credentials: test_credentials(),
                snapshot: new_snapshot("test@example.test"),
            };
            let report = refresh_account(&root.0, stored, &client(), &mock.endpoints)
                .await
                .unwrap();
            assert!(report.stale && report.error.is_some());
            if mode == "expired" {
                assert!(report.reauthorization_required);
            }
            assert!(!report.error.unwrap().contains("sensitive"));
            // Failed identity verification cannot commit an unrelated account's tokens.
            // The snapshot write uses the last known good credentials.
            let persisted = read_account(&account_path(&root.0, "test@example.test")).unwrap();
            assert_eq!(persisted.credentials.refresh_token, "old+refresh&=");
        }
    }

    #[tokio::test]
    async fn remote_buckets_override_availability_and_unmeasured_data_is_not_reported_as_full_quota(
    ) {
        for mode in ["buckets", "unmeasured", "unauthorized"] {
            let mock = mock(mode).await;
            let root = TestRoot::new();
            let mut credentials = test_credentials();
            if mode == "unauthorized" {
                credentials.expires_at = chrono::Utc::now().timestamp() + 3600;
            }
            let report = refresh_account(
                &root.0,
                StoredAccount {
                    credentials,
                    snapshot: new_snapshot("test@example.test"),
                },
                &client(),
                &mock.endpoints,
            )
            .await
            .unwrap();
            if mode == "unmeasured" {
                assert!(report.error.is_some() && report.quotas.is_empty());
            } else {
                assert!(report.error.is_none(), "{:?}", report.error);
                assert_eq!(
                    report.quotas[0].remaining_fraction,
                    Some(if mode == "buckets" { 0.2 } else { 0.4 })
                );
            }
            assert_eq!(mock.state.forms.lock().unwrap().len(), 1);
        }
    }

    #[tokio::test]
    async fn login_timeout_or_browser_failure_leaves_no_credentials_or_callback_listener() {
        for fail_open in [false, true] {
            let root = TestRoot::new();
            let address = Arc::new(StdMutex::new(None));
            let captured = address.clone();
            let result = authorize_with(
                &root.0,
                move |url| {
                    let url = url::Url::parse(url).unwrap();
                    let redirect = url
                        .query_pairs()
                        .find(|(key, _)| key == "redirect_uri")
                        .unwrap()
                        .1
                        .into_owned();
                    *captured.lock().unwrap() = Some(url::Url::parse(&redirect).unwrap());
                    if fail_open {
                        Err("cannot open browser".into())
                    } else {
                        Ok(())
                    }
                },
                test_credentials().client,
                client(),
                Endpoints::default(),
                Duration::from_millis(15),
            )
            .await;
            assert!(result.is_err());
            assert!(!root.0.exists());
            let url = address.lock().unwrap().clone().unwrap();
            assert!(
                tokio::net::TcpStream::connect(("127.0.0.1", url.port().unwrap()))
                    .await
                    .is_err()
            );
        }
    }
}
