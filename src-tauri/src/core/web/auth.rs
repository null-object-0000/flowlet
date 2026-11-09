//! Management authentication for the browser host.
//!
//! Two modes are supported:
//! - `token`: the legacy static bearer token (`FLOWLET_ADMIN_TOKEN`);
//! - `oidc`: browser OIDC authorization-code login against a standard-compatible
//!   provider (target: the company GitLab instance), plus HttpOnly server-side
//!   sessions and CSRF-protected command calls.
//!
//! The implementation intentionally keeps all auth state in memory. Restarting the
//! host invalidates sessions; that is an accepted v1 tradeoff (see
//! `docs/admin-sso-design.md`).

use axum::body::Body;
use axum::extract::{Extension, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use hmac::{Hmac, Mac};
use ring::signature::{RsaPublicKeyComponents, RSA_PKCS1_2048_8192_SHA256};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

use super::WebState;

const ADMIN_COOKIE: &str = "flowlet-admin";
const ADMIN_COOKIE_SECURE: &str = "__Host-flowlet-admin";
const BROWSER_COOKIE: &str = "flowlet-oidc-browser";
const BROWSER_COOKIE_SECURE: &str = "__Host-flowlet-oidc-browser";
const CSRF_HEADER: &str = "x-csrf-token";
const BROWSER_COOKIE_TTL: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuthMode {
    Token,
    Oidc,
}

impl AuthMode {
    fn as_str(self) -> &'static str {
        match self {
            AuthMode::Token => "token",
            AuthMode::Oidc => "oidc",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PkceMode {
    Auto,
    Required,
    Off,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum NonceMode {
    Required,
    BestEffort,
    Off,
}

#[derive(Clone)]
pub struct OidcConfig {
    pub issuer: String,
    discovery_url: String,
    client_id: String,
    client_secret: String,
    scopes: String,
    redirect_url: String,
    display_name: String,
    email_claim: String,
    name_claim: String,
    groups_claim: String,
    allowed_subs: Vec<String>,
    allowed_groups: Vec<String>,
    allowed_emails: Vec<String>,
    allowed_domains: Vec<String>,
    allow_any: bool,
    allow_http_issuer: bool,
    insecure_http: bool,
    pkce: PkceMode,
    nonce: NonceMode,
    signing_algs: Vec<String>,
}

#[derive(Clone)]
pub struct AdminAuthConfig {
    pub mode: AuthMode,
    admin_token: String,
    pub allow_token_login: bool,
    public_web_url: String,
    cookie_secure: bool,
    session_idle: Duration,
    session_ttl: Duration,
    oidc: Option<OidcConfig>,
}

#[derive(Clone)]
pub struct Identity {
    pub sub: String,
    pub email: Option<String>,
    pub username: Option<String>,
    pub name: Option<String>,
    pub groups: Vec<String>,
    pub provider: String,
}

impl Identity {
    pub fn label(&self) -> String {
        self.email
            .clone()
            .or_else(|| self.username.clone())
            .or_else(|| self.name.clone())
            .unwrap_or_else(|| self.sub.clone())
    }

    fn public_json(&self) -> Value {
        json!({
            "email": self.email,
            "username": self.username,
            "name": self.name,
            "provider": self.provider,
        })
    }
}

struct Session {
    identity: Identity,
    csrf_token: String,
    created: Instant,
    last_seen: Instant,
    absolute_expire: Instant,
}

struct Transaction {
    nonce: String,
    verifier: Option<String>,
    browser_hash: String,
    created: Instant,
}

struct CachedDiscovery {
    doc: DiscoveryDoc,
    fetched: Instant,
}

struct CachedJwks {
    keys: Vec<Jwk>,
    fetched: Instant,
}

#[derive(Clone)]
pub struct AuthContext {
    pub via_cookie: bool,
    pub csrf_token: Option<String>,
    pub identity: Option<Identity>,
    session_key: Option<String>,
}

pub struct AdminAuth {
    pub config: AdminAuthConfig,
    sessions: Mutex<HashMap<String, Session>>,
    transactions: Mutex<HashMap<String, Transaction>>,
    discovery: Mutex<Option<CachedDiscovery>>,
    jwks: Mutex<Option<CachedJwks>>,
    http: reqwest::Client,
}

#[derive(Clone, Deserialize)]
struct DiscoveryDoc {
    issuer: String,
    authorization_endpoint: String,
    token_endpoint: String,
    #[serde(default)]
    userinfo_endpoint: Option<String>,
    jwks_uri: String,
    #[serde(default)]
    code_challenge_methods_supported: Option<Vec<String>>,
}

#[derive(Clone, Deserialize)]
struct JwkSet {
    keys: Vec<Jwk>,
}

#[derive(Clone, Deserialize)]
struct Jwk {
    kty: String,
    #[serde(default)]
    kid: Option<String>,
    #[serde(default)]
    n: Option<String>,
    #[serde(default)]
    e: Option<String>,
    #[serde(default)]
    alg: Option<String>,
}

#[derive(Deserialize)]
pub struct CallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

#[derive(Deserialize)]
struct TokenResponse {
    id_token: Option<String>,
    access_token: Option<String>,
}

#[derive(Deserialize)]
struct IdTokenClaims {
    iss: String,
    aud: Value,
    exp: u64,
    iat: u64,
    sub: String,
    #[serde(default)]
    nonce: Option<String>,
    #[serde(default)]
    azp: Option<String>,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn random_token() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

fn sha256_hex(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

fn env_trim(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn env_bool(name: &str, default: bool) -> bool {
    match env_trim(name).as_deref() {
        Some("1") | Some("true") | Some("yes") | Some("on") => true,
        Some("0") | Some("false") | Some("no") | Some("off") => false,
        _ => default,
    }
}

fn env_csv(name: &str) -> Vec<String> {
    env_trim(name)
        .map(|value| {
            value
                .split(',')
                .map(|item| item.trim().to_owned())
                .filter(|item| !item.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

fn read_secret(name: &str, file_name: &str) -> Option<String> {
    if let Some(value) = env_trim(name) {
        return Some(value);
    }
    let path = env_trim(file_name)?;
    std::fs::read_to_string(path)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn validate_https_endpoint(value: &str, allow_http: bool) -> Result<(), String> {
    if value.starts_with("https://") || (allow_http && value.starts_with("http://")) {
        Ok(())
    } else {
        Err(format!("只接受 https 地址：{value}"))
    }
}

fn parse_public_web_url(value: &str) -> Result<String, String> {
    let trimmed = value.trim().trim_end_matches('/');
    let url =
        url::Url::parse(trimmed).map_err(|_| "FLOWLET_PUBLIC_WEB_URL 不是合法 URL".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("FLOWLET_PUBLIC_WEB_URL 只支持 http/https".into());
    }
    if url.path() != "/" && !url.path().is_empty() {
        return Err("FLOWLET_PUBLIC_WEB_URL 不支持子路径".into());
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("FLOWLET_PUBLIC_WEB_URL 不允许查询串或片段".into());
    }
    Ok(trimmed.to_owned())
}

impl AdminAuthConfig {
    pub fn from_env() -> Result<Self, String> {
        let mode = match env_trim("FLOWLET_ADMIN_AUTH_MODE").as_deref() {
            None | Some("token") => AuthMode::Token,
            Some("oidc") => AuthMode::Oidc,
            Some(other) => return Err(format!("未知的 FLOWLET_ADMIN_AUTH_MODE：{other}")),
        };
        let admin_token = env_trim("FLOWLET_ADMIN_TOKEN").unwrap_or_default();
        let allow_token_login = env_bool("FLOWLET_ADMIN_ALLOW_TOKEN_LOGIN", false);
        let public_web_url = match env_trim("FLOWLET_PUBLIC_WEB_URL") {
            Some(value) => parse_public_web_url(&value)?,
            None if mode == AuthMode::Oidc => {
                return Err("OIDC 模式必须设置 FLOWLET_PUBLIC_WEB_URL".into())
            }
            None => String::new(),
        };
        let session_idle = Duration::from_secs(
            env_trim("FLOWLET_ADMIN_SESSION_IDLE_MINUTES")
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or(30)
                .max(1)
                * 60,
        );
        let session_ttl = Duration::from_secs(
            env_trim("FLOWLET_ADMIN_SESSION_TTL_HOURS")
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or(8)
                .max(1)
                * 3600,
        );
        if session_idle > session_ttl {
            return Err("空闲超时不能大于绝对超时".into());
        }
        let cookie_secure = match env_trim("FLOWLET_ADMIN_COOKIE_SECURE").as_deref() {
            Some("always") => true,
            Some("never") => false,
            _ => public_web_url.starts_with("https://"),
        };
        match mode {
            AuthMode::Token => {
                if admin_token.len() < 24 {
                    return Err("FLOWLET_ADMIN_TOKEN 必须至少包含 24 个字符".into());
                }
                Ok(Self {
                    mode,
                    admin_token,
                    allow_token_login,
                    public_web_url,
                    cookie_secure,
                    session_idle,
                    session_ttl,
                    oidc: None,
                })
            }
            AuthMode::Oidc => {
                if allow_token_login && admin_token.len() < 24 {
                    return Err(
                        "开启 ALLOW_TOKEN_LOGIN 时 FLOWLET_ADMIN_TOKEN 必须至少包含 24 个字符"
                            .into(),
                    );
                }
                let issuer = env_trim("FLOWLET_OIDC_ISSUER")
                    .ok_or_else(|| "OIDC 模式必须设置 FLOWLET_OIDC_ISSUER".to_string())?;
                let allow_http_issuer = env_bool("FLOWLET_OIDC_ALLOW_HTTP_ISSUER", false);
                let insecure_http = env_bool("FLOWLET_OIDC_INSECURE_HTTP", false);
                let issuer_is_https = issuer.starts_with("https://");
                if !issuer_is_https && !allow_http_issuer && !insecure_http {
                    return Err(
                        "issuer 非 https；旧自建 GitLab 请显式设置 FLOWLET_OIDC_ALLOW_HTTP_ISSUER=1"
                            .into(),
                    );
                }
                let discovery_url = match env_trim("FLOWLET_OIDC_DISCOVERY_URL") {
                    Some(value) => value,
                    None if !issuer_is_https => {
                        return Err(
                            "issuer 为 http 时必须显式设置 https 的 FLOWLET_OIDC_DISCOVERY_URL"
                                .into(),
                        )
                    }
                    None => format!(
                        "{}/.well-known/openid-configuration",
                        issuer.trim_end_matches('/')
                    ),
                };
                validate_https_endpoint(&discovery_url, insecure_http)?;
                let client_id = env_trim("FLOWLET_OIDC_CLIENT_ID")
                    .ok_or_else(|| "OIDC 模式必须设置 FLOWLET_OIDC_CLIENT_ID".to_string())?;
                let client_secret = read_secret(
                    "FLOWLET_OIDC_CLIENT_SECRET",
                    "FLOWLET_OIDC_CLIENT_SECRET_FILE",
                )
                .ok_or_else(|| "OIDC 模式必须设置 FLOWLET_OIDC_CLIENT_SECRET(_FILE)".to_string())?;
                let scopes = env_trim("FLOWLET_OIDC_SCOPES").unwrap_or_else(|| "openid".into());
                let allowed_subs = env_csv("FLOWLET_OIDC_ALLOWED_SUBS");
                let allowed_groups = env_csv("FLOWLET_OIDC_ALLOWED_GROUPS");
                let allowed_emails = env_csv("FLOWLET_OIDC_ALLOWED_EMAILS");
                let allowed_domains = env_csv("FLOWLET_OIDC_ALLOWED_DOMAINS");
                let allow_any = env_bool("FLOWLET_OIDC_ALLOW_ANY", false);
                if !allow_any
                    && allowed_subs.is_empty()
                    && allowed_groups.is_empty()
                    && allowed_emails.is_empty()
                    && allowed_domains.is_empty()
                {
                    return Err("OIDC 模式必须配置准入名单，或显式设置 ALLOW_ANY=1".into());
                }
                let pkce = match env_trim("FLOWLET_OIDC_PKCE").as_deref() {
                    None | Some("auto") => PkceMode::Auto,
                    Some("required") => PkceMode::Required,
                    Some("off") => PkceMode::Off,
                    Some(other) => return Err(format!("未知的 FLOWLET_OIDC_PKCE：{other}")),
                };
                let nonce = match env_trim("FLOWLET_OIDC_NONCE").as_deref() {
                    None | Some("required") => NonceMode::Required,
                    Some("best_effort") => NonceMode::BestEffort,
                    Some("off") => NonceMode::Off,
                    Some(other) => return Err(format!("未知的 FLOWLET_OIDC_NONCE：{other}")),
                };
                let redirect_url = env_trim("FLOWLET_OIDC_REDIRECT_URL")
                    .unwrap_or_else(|| format!("{public_web_url}/api/auth/callback"));
                let signing_algs = env_trim("FLOWLET_OIDC_SIGNING_ALGS")
                    .map(|value| {
                        value
                            .split(',')
                            .map(|item| item.trim().to_owned())
                            .filter(|item| !item.is_empty())
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_else(|| vec!["RS256".into()]);
                if signing_algs.iter().any(|alg| alg != "RS256") {
                    return Err("当前实现只支持 RS256 ID token".into());
                }
                Ok(Self {
                    mode,
                    admin_token,
                    allow_token_login,
                    public_web_url,
                    cookie_secure,
                    session_idle,
                    session_ttl,
                    oidc: Some(OidcConfig {
                        issuer,
                        discovery_url,
                        client_id,
                        client_secret,
                        scopes,
                        redirect_url,
                        display_name: env_trim("FLOWLET_OIDC_DISPLAY_NAME")
                            .unwrap_or_else(|| "GitLab".into()),
                        email_claim: env_trim("FLOWLET_OIDC_EMAIL_CLAIM")
                            .unwrap_or_else(|| "email".into()),
                        name_claim: env_trim("FLOWLET_OIDC_NAME_CLAIM")
                            .unwrap_or_else(|| "name".into()),
                        groups_claim: env_trim("FLOWLET_OIDC_GROUPS_CLAIM")
                            .unwrap_or_else(|| "groups".into()),
                        allowed_subs,
                        allowed_groups,
                        allowed_emails,
                        allowed_domains,
                        allow_any,
                        allow_http_issuer,
                        insecure_http,
                        pkce,
                        nonce,
                        signing_algs,
                    }),
                })
            }
        }
    }

    /// Test/helper constructor for legacy token mode.
    pub fn token_for_tests(token: &str) -> Self {
        Self {
            mode: AuthMode::Token,
            admin_token: token.to_owned(),
            allow_token_login: false,
            public_web_url: "http://127.0.0.1".into(),
            cookie_secure: false,
            session_idle: Duration::from_secs(30 * 60),
            session_ttl: Duration::from_secs(8 * 3600),
            oidc: None,
        }
    }
}

impl AdminAuth {
    pub fn from_config(config: AdminAuthConfig) -> Result<Arc<Self>, String> {
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|error| format!("无法创建 OIDC HTTP 客户端：{error}"))?;
        Ok(Arc::new(Self {
            config,
            sessions: Mutex::new(HashMap::new()),
            transactions: Mutex::new(HashMap::new()),
            discovery: Mutex::new(None),
            jwks: Mutex::new(None),
            http,
        }))
    }

    pub fn from_env() -> Result<Arc<Self>, String> {
        Self::from_config(AdminAuthConfig::from_env()?)
    }

    /// Static bearer token for the legacy `token` mode, if configured.
    pub fn static_token(&self) -> Option<&str> {
        (!self.config.admin_token.is_empty()).then_some(self.config.admin_token.as_str())
    }

    pub fn mode(&self) -> AuthMode {
        self.config.mode
    }

    pub fn display_name(&self) -> Option<String> {
        self.config
            .oidc
            .as_ref()
            .map(|oidc| oidc.display_name.clone())
    }

    fn token_matches(&self, candidate: &str) -> bool {
        if self.config.admin_token.is_empty() {
            return false;
        }
        let mut expected =
            Hmac::<Sha256>::new_from_slice(b"flowlet-web-admin").expect("valid HMAC key");
        expected.update(self.config.admin_token.as_bytes());
        let mut actual =
            Hmac::<Sha256>::new_from_slice(b"flowlet-web-admin").expect("valid HMAC key");
        actual.update(candidate.as_bytes());
        actual
            .verify_slice(&expected.finalize().into_bytes())
            .is_ok()
    }

    fn bearer(&self, headers: &HeaderMap) -> Option<String> {
        headers
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .map(str::to_owned)
    }

    pub fn authenticate(&self, headers: &HeaderMap) -> Option<AuthContext> {
        if let Some(token) = self.bearer(headers) {
            if self.config.mode == AuthMode::Token
                || (self.config.mode == AuthMode::Oidc && self.config.allow_token_login)
            {
                if self.token_matches(&token) {
                    return Some(AuthContext {
                        via_cookie: false,
                        csrf_token: None,
                        identity: None,
                        session_key: None,
                    });
                }
            }
        }
        if self.config.mode != AuthMode::Oidc {
            return None;
        }
        let cookie = cookie_value(headers, self.admin_cookie_name())?;
        let key = sha256_hex(&cookie);
        let mut sessions = self.sessions.lock().ok()?;
        let session = sessions.get_mut(&key)?;
        let now = Instant::now();
        if now >= session.absolute_expire
            || now.duration_since(session.last_seen) > self.config.session_idle
        {
            sessions.remove(&key);
            return None;
        }
        session.last_seen = now;
        Some(AuthContext {
            via_cookie: true,
            csrf_token: Some(session.csrf_token.clone()),
            identity: Some(session.identity.clone()),
            session_key: Some(key),
        })
    }

    pub fn verify_csrf(&self, headers: &HeaderMap, context: &AuthContext) -> bool {
        if !context.via_cookie {
            return true;
        }
        let Some(expected) = context.csrf_token.as_deref() else {
            return false;
        };
        let Some(actual) = headers
            .get(CSRF_HEADER)
            .and_then(|value| value.to_str().ok())
        else {
            return false;
        };
        if actual != expected {
            return false;
        }
        let Some(origin) = headers
            .get(header::ORIGIN)
            .and_then(|value| value.to_str().ok())
        else {
            return false;
        };
        let expected_origin = url::Url::parse(&self.config.public_web_url)
            .ok()
            .map(|url| url.origin().ascii_serialization());
        Some(origin.to_owned()) == expected_origin
    }

    fn admin_cookie_name(&self) -> &'static str {
        if self.config.cookie_secure {
            ADMIN_COOKIE_SECURE
        } else {
            ADMIN_COOKIE
        }
    }

    fn browser_cookie_name(&self) -> &'static str {
        if self.config.cookie_secure {
            BROWSER_COOKIE_SECURE
        } else {
            BROWSER_COOKIE
        }
    }

    fn session_cookie(&self, value: &str) -> HeaderValue {
        build_cookie(
            self.admin_cookie_name(),
            value,
            self.config.cookie_secure,
            Some(self.config.session_ttl.as_secs()),
        )
    }

    fn clear_session_cookie(&self) -> HeaderValue {
        build_cookie(
            self.admin_cookie_name(),
            "",
            self.config.cookie_secure,
            Some(0),
        )
    }

    fn browser_cookie(&self, value: &str) -> HeaderValue {
        build_cookie(
            self.browser_cookie_name(),
            value,
            self.config.cookie_secure,
            Some(BROWSER_COOKIE_TTL.as_secs()),
        )
    }

    fn clear_browser_cookie(&self) -> HeaderValue {
        build_cookie(
            self.browser_cookie_name(),
            "",
            self.config.cookie_secure,
            Some(0),
        )
    }

    fn create_session(&self, identity: Identity) -> (String, String) {
        let raw = random_token();
        let key = sha256_hex(&raw);
        let csrf = random_token();
        let now = Instant::now();
        let mut sessions = self.sessions.lock().expect("session store");
        sessions.retain(|_, session| {
            now < session.absolute_expire
                && now.duration_since(session.last_seen) <= self.config.session_idle
        });
        sessions.insert(
            key,
            Session {
                identity,
                csrf_token: csrf.clone(),
                created: now,
                last_seen: now,
                absolute_expire: now + self.config.session_ttl,
            },
        );
        (raw, csrf)
    }

    fn destroy_session(&self, context: &AuthContext) -> bool {
        let Some(key) = context.session_key.as_ref() else {
            return false;
        };
        self.sessions
            .lock()
            .map(|mut sessions| sessions.remove(key).is_some())
            .unwrap_or(false)
    }

    async fn discovery_doc(&self) -> Result<DiscoveryDoc, String> {
        let oidc = self
            .config
            .oidc
            .as_ref()
            .ok_or_else(|| "OIDC 未配置".to_string())?;
        {
            let cached = self
                .discovery
                .lock()
                .map_err(|_| "OIDC 状态损坏".to_string())?;
            if let Some(cached) = cached.as_ref() {
                if cached.fetched.elapsed() < Duration::from_secs(3600) {
                    return Ok(cached.doc.clone());
                }
            }
        }
        let response = self
            .http
            .get(&oidc.discovery_url)
            .header(header::ACCEPT, "application/json")
            .send()
            .await
            .map_err(|_| "无法访问 OIDC discovery 端点".to_string())?;
        if !response.status().is_success() {
            return Err(format!("OIDC discovery 返回 HTTP {}", response.status()));
        }
        let doc = response
            .json::<DiscoveryDoc>()
            .await
            .map_err(|_| "OIDC discovery 响应不是合法 JSON".to_string())?;
        if doc.issuer != oidc.issuer {
            return Err(format!(
                "OIDC issuer 不一致：配置 {}，discovery {}",
                oidc.issuer, doc.issuer
            ));
        }
        validate_https_endpoint(&doc.authorization_endpoint, oidc.insecure_http)?;
        validate_https_endpoint(&doc.token_endpoint, oidc.insecure_http)?;
        validate_https_endpoint(&doc.jwks_uri, oidc.insecure_http)?;
        if let Some(userinfo) = doc.userinfo_endpoint.as_deref() {
            validate_https_endpoint(userinfo, oidc.insecure_http)?;
        }
        *self
            .discovery
            .lock()
            .map_err(|_| "OIDC 状态损坏".to_string())? = Some(CachedDiscovery {
            doc: doc.clone(),
            fetched: Instant::now(),
        });
        Ok(doc)
    }

    async fn jwks(&self, force: bool) -> Result<Vec<Jwk>, String> {
        if !force {
            let cached = self.jwks.lock().map_err(|_| "JWKS 状态损坏".to_string())?;
            if let Some(cached) = cached.as_ref() {
                if cached.fetched.elapsed() < Duration::from_secs(3600) {
                    return Ok(cached.keys.clone());
                }
            }
        }
        let doc = self.discovery_doc().await?;
        let response = self
            .http
            .get(&doc.jwks_uri)
            .header(header::ACCEPT, "application/json")
            .send()
            .await
            .map_err(|_| "无法访问 OIDC JWKS".to_string())?;
        if !response.status().is_success() {
            return Err(format!("OIDC JWKS 返回 HTTP {}", response.status()));
        }
        let set = response
            .json::<JwkSet>()
            .await
            .map_err(|_| "OIDC JWKS 响应不是合法 JSON".to_string())?;
        *self.jwks.lock().map_err(|_| "OIDC 状态损坏".to_string())? = Some(CachedJwks {
            keys: set.keys.clone(),
            fetched: Instant::now(),
        });
        Ok(set.keys)
    }
}

fn build_cookie(name: &str, value: &str, secure: bool, max_age: Option<u64>) -> HeaderValue {
    let mut parts = vec![
        format!("{name}={value}"),
        "Path=/".into(),
        "HttpOnly".into(),
        "SameSite=Lax".into(),
    ];
    if secure {
        parts.push("Secure".into());
    }
    if let Some(age) = max_age {
        parts.push(format!("Max-Age={age}"));
    }
    HeaderValue::from_str(&parts.join("; ")).expect("valid cookie")
}

fn cookie_value<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .filter_map(|item| {
            let item = item.trim();
            let (key, value) = item.split_once('=')?;
            (key.trim() == name).then_some(value.trim())
        })
        .find(|value| !value.is_empty())
}

fn json_error(status: StatusCode, code: &str, message: &str) -> Response {
    (status, Json(json!({ "code": code, "message": message }))).into_response()
}

fn redirect_with_cookies(location: &str, cookies: Vec<HeaderValue>) -> Response {
    let mut builder = Response::builder()
        .status(StatusCode::SEE_OTHER)
        .header(header::LOCATION, location)
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::REFERRER_POLICY, "no-referrer");
    for cookie in cookies {
        builder = builder.header(header::SET_COOKIE, cookie);
    }
    builder
        .body(Body::empty())
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

pub async fn authenticate_middleware(
    State(state): State<Arc<WebState>>,
    headers: HeaderMap,
    mut request: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let Some(context) = state.auth.authenticate(&headers) else {
        return json_error(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "管理凭据无效，请重新登录",
        );
    };
    if !matches!(
        *request.method(),
        Method::GET | Method::HEAD | Method::OPTIONS
    ) {
        if !state.auth.verify_csrf(&headers, &context) {
            return json_error(
                StatusCode::FORBIDDEN,
                "csrf_rejected",
                "请求校验失败，请刷新页面后重试",
            );
        }
    }
    request.extensions_mut().insert(context);
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().expect("header"));
    response
}

pub async fn config_handler(State(state): State<Arc<WebState>>) -> Response {
    let auth = &state.auth;
    let oidc = auth.config.oidc.as_ref();
    (
        StatusCode::OK,
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({
            "mode": auth.config.mode.as_str(),
            "provider": { "display_name": oidc.map(|item| item.display_name.clone()) },
            "login_path": "/api/auth/login",
            "token_login": auth.config.mode == AuthMode::Token
                || (auth.config.mode == AuthMode::Oidc && auth.config.allow_token_login),
        })),
    )
        .into_response()
}

pub async fn session_handler(
    State(state): State<Arc<WebState>>,
    Extension(context): Extension<AuthContext>,
) -> Response {
    let auth = &state.auth;
    if auth.config.mode == AuthMode::Token {
        return Json(json!({ "authenticated": true, "mode": "token", "csrf_token": Value::Null }))
            .into_response();
    }
    let Some(identity) = context.identity.as_ref() else {
        return json_error(StatusCode::UNAUTHORIZED, "unauthorized", "会话无效");
    };
    Json(json!({
        "authenticated": true,
        "mode": "oidc",
        "identity": identity.public_json(),
        "csrf_token": context.csrf_token,
    }))
    .into_response()
}

pub async fn login_handler(State(state): State<Arc<WebState>>, headers: HeaderMap) -> Response {
    let auth = &state.auth;
    let Some(oidc) = auth.config.oidc.as_ref() else {
        return json_error(
            StatusCode::NOT_FOUND,
            "auth_not_configured",
            "当前未启用 OIDC",
        );
    };
    let discovery = match auth.discovery_doc().await {
        Ok(doc) => doc,
        Err(error) => {
            tracing::warn!(error = %error, "OIDC discovery failed");
            return redirect_with_cookies("/?auth_error=provider_unavailable", vec![]);
        }
    };
    let state_token = random_token();
    let nonce = random_token();
    let browser = cookie_value(&headers, auth.browser_cookie_name())
        .map(str::to_owned)
        .unwrap_or_else(random_token);
    let browser_hash = sha256_hex(&browser);
    let pkce_supported = discovery
        .code_challenge_methods_supported
        .as_ref()
        .map(|methods| methods.iter().any(|method| method == "S256"))
        .unwrap_or(false);
    if oidc.pkce == PkceMode::Required && !pkce_supported {
        return json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "provider_unavailable",
            "OIDC 未声明 PKCE S256",
        );
    }
    let use_pkce = pkce_supported && oidc.pkce != PkceMode::Off;
    let verifier = use_pkce.then(random_token);
    let challenge = verifier
        .as_ref()
        .map(|verifier| URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes())));
    {
        let mut transactions = auth.transactions.lock().expect("transaction store");
        let now = Instant::now();
        transactions.retain(|_, transaction| {
            now.duration_since(transaction.created) < Duration::from_secs(600)
        });
        transactions.insert(
            sha256_hex(&state_token),
            Transaction {
                nonce: nonce.clone(),
                verifier,
                browser_hash,
                created: now,
            },
        );
    }
    let mut url = url::Url::parse(&discovery.authorization_endpoint).expect("valid authorize URL");
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("response_type", "code");
        query.append_pair("client_id", &oidc.client_id);
        query.append_pair("redirect_uri", &oidc.redirect_url);
        query.append_pair("scope", &oidc.scopes);
        query.append_pair("state", &state_token);
        query.append_pair("nonce", &nonce);
        if let Some(challenge) = challenge.as_deref() {
            query.append_pair("code_challenge", challenge);
            query.append_pair("code_challenge_method", "S256");
        }
    }
    let mut response = Response::builder()
        .status(StatusCode::FOUND)
        .header(header::LOCATION, url.as_str())
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::REFERRER_POLICY, "no-referrer")
        .header(header::SET_COOKIE, auth.browser_cookie(&browser))
        .body(Body::empty())
        .expect("valid redirect");
    response
        .headers_mut()
        .insert(header::SET_COOKIE, auth.browser_cookie(&browser));
    response
}

pub async fn callback_handler(
    State(state): State<Arc<WebState>>,
    Query(query): Query<CallbackQuery>,
    headers: HeaderMap,
) -> Response {
    let auth = &state.auth;
    let browser = cookie_value(&headers, auth.browser_cookie_name())
        .map(str::to_owned)
        .unwrap_or_default();
    if let Some(error) = query.error.as_deref() {
        tracing::info!(error = %error, "OIDC callback returned an error");
        return redirect_with_cookies(
            "/?auth_error=access_denied",
            vec![auth.clear_browser_cookie()],
        );
    }
    let (Some(code), Some(state_token)) = (query.code.as_deref(), query.state.as_deref()) else {
        return redirect_with_cookies(
            "/?auth_error=login_failed",
            vec![auth.clear_browser_cookie()],
        );
    };
    let transaction = {
        let mut transactions = auth.transactions.lock().expect("transaction store");
        transactions.remove(&sha256_hex(state_token))
    };
    let Some(transaction) = transaction else {
        return redirect_with_cookies(
            "/?auth_error=state_invalid",
            vec![auth.clear_browser_cookie()],
        );
    };
    if transaction.created.elapsed() > Duration::from_secs(600)
        || browser.is_empty()
        || sha256_hex(&browser) != transaction.browser_hash
    {
        return redirect_with_cookies(
            "/?auth_error=state_invalid",
            vec![auth.clear_browser_cookie()],
        );
    }
    let oidc = match auth.config.oidc.as_ref() {
        Some(oidc) => oidc,
        None => {
            return json_error(
                StatusCode::NOT_FOUND,
                "auth_not_configured",
                "当前未启用 OIDC",
            )
        }
    };
    let discovery = match auth.discovery_doc().await {
        Ok(doc) => doc,
        Err(error) => {
            tracing::warn!(error = %error, "OIDC discovery failed during callback");
            return redirect_with_cookies("/?auth_error=provider_unavailable", vec![]);
        }
    };
    let mut form = vec![
        ("grant_type".to_string(), "authorization_code".to_string()),
        ("code".to_string(), code.to_string()),
        ("redirect_uri".to_string(), oidc.redirect_url.clone()),
    ];
    if let Some(verifier) = transaction.verifier.as_deref() {
        form.push(("code_verifier".to_string(), verifier.to_string()));
    }
    let response = match auth
        .http
        .post(&discovery.token_endpoint)
        .basic_auth(&oidc.client_id, Some(&oidc.client_secret))
        .header(header::ACCEPT, "application/json")
        .form(&form)
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => {
            tracing::warn!(error = %error, "OIDC token request failed");
            return redirect_with_cookies("/?auth_error=provider_unavailable", vec![]);
        }
    };
    if !response.status().is_success() {
        tracing::warn!(status = %response.status(), "OIDC token endpoint rejected the code");
        return redirect_with_cookies("/?auth_error=login_failed", vec![]);
    }
    let token = match response.json::<TokenResponse>().await {
        Ok(token) => token,
        Err(error) => {
            tracing::warn!(error = %error, "OIDC token response was not JSON");
            return redirect_with_cookies("/?auth_error=login_failed", vec![]);
        }
    };
    let Some(id_token) = token.id_token.as_deref() else {
        tracing::warn!("OIDC token response did not include id_token");
        return redirect_with_cookies("/?auth_error=login_failed", vec![]);
    };
    let claims = match verify_id_token(auth, &discovery, id_token, oidc, &transaction.nonce).await {
        Ok(claims) => claims,
        Err(error) => {
            tracing::warn!(error = %error, "OIDC id_token validation failed");
            return redirect_with_cookies("/?auth_error=login_failed", vec![]);
        }
    };
    let mut identity = Identity {
        sub: claims.sub.clone(),
        email: None,
        username: None,
        name: None,
        groups: Vec::new(),
        provider: oidc.display_name.clone(),
    };
    if let Some(userinfo_endpoint) = discovery.userinfo_endpoint.as_deref() {
        if let Some(access_token) = token.access_token.as_deref() {
            if let Ok(response) = auth
                .http
                .get(userinfo_endpoint)
                .bearer_auth(access_token)
                .header(header::ACCEPT, "application/json")
                .send()
                .await
            {
                if response.status().is_success() {
                    if let Ok(value) = response.json::<Value>().await {
                        let userinfo_sub = string_claim(&value, "sub");
                        if userinfo_sub.as_deref() != Some(claims.sub.as_str()) {
                            tracing::warn!("OIDC userinfo sub does not match id_token");
                            return redirect_with_cookies("/?auth_error=login_failed", vec![]);
                        }
                        apply_claims(&mut identity, oidc, &value);
                    } else {
                        tracing::warn!("OIDC userinfo response was not JSON");
                    }
                }
            }
        }
    }
    apply_claims(&mut identity, oidc, &Value::Null);
    if !allowlisted(oidc, &identity) {
        tracing::info!(sub = %mask_secret(&identity.sub), "OIDC login denied by allowlist");
        return redirect_with_cookies(
            "/?auth_error=allowlist_denied",
            vec![auth.clear_browser_cookie()],
        );
    }
    let (session_id, _csrf) = auth.create_session(identity);
    tracing::info!(sub = %mask_secret(&claims.sub), "OIDC login succeeded");
    redirect_with_cookies(
        "/",
        vec![
            auth.session_cookie(&session_id),
            auth.clear_browser_cookie(),
        ],
    )
}

pub async fn logout_handler(
    State(state): State<Arc<WebState>>,
    Extension(context): Extension<AuthContext>,
) -> Response {
    let auth = &state.auth;
    auth.destroy_session(&context);
    let mut response = StatusCode::NO_CONTENT.into_response();
    if let Ok(value) =
        HeaderValue::from_str(&auth.clear_session_cookie().to_str().unwrap_or_default())
    {
        response.headers_mut().insert(header::SET_COOKIE, value);
    }
    response
}

fn mask_secret(value: &str) -> String {
    if value.len() <= 8 {
        return "***".into();
    }
    format!("{}…", &value[..8])
}

fn string_claim(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn apply_claims(identity: &mut Identity, oidc: &OidcConfig, value: &Value) {
    if let Some(email) = string_claim(value, &oidc.email_claim) {
        identity.email = Some(email);
    }
    for key in ["preferred_username", "nickname"] {
        if identity.username.is_none() {
            if let Some(value) = string_claim(value, key) {
                identity.username = Some(value);
            }
        }
    }
    if identity.name.is_none() {
        if let Some(name) = string_claim(value, &oidc.name_claim) {
            identity.name = Some(name);
        }
    }
    if identity.groups.is_empty() {
        if let Some(groups) = value.get(&oidc.groups_claim) {
            if let Some(items) = groups.as_array() {
                identity.groups = items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect();
            }
        }
    }
}

fn allowlisted(oidc: &OidcConfig, identity: &Identity) -> bool {
    if oidc.allow_any {
        return true;
    }
    if oidc.allowed_subs.iter().any(|item| item == &identity.sub) {
        return true;
    }
    if oidc
        .allowed_groups
        .iter()
        .any(|item| identity.groups.iter().any(|group| group == item))
    {
        return true;
    }
    if let Some(email) = identity.email.as_deref() {
        if oidc
            .allowed_emails
            .iter()
            .any(|item| item.eq_ignore_ascii_case(email))
        {
            return true;
        }
        if let Some((_, domain)) = email.rsplit_once('@') {
            if oidc
                .allowed_domains
                .iter()
                .any(|item| item.eq_ignore_ascii_case(domain))
            {
                return true;
            }
        }
    }
    false
}

async fn verify_id_token(
    auth: &AdminAuth,
    _discovery: &DiscoveryDoc,
    token: &str,
    oidc: &OidcConfig,
    expected_nonce: &str,
) -> Result<IdTokenClaims, String> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return Err("id_token 不是合法 JWT".into());
    }
    let header: Value = serde_json::from_slice(
        &URL_SAFE_NO_PAD
            .decode(parts[0])
            .map_err(|_| "id_token header 不是 base64url".to_string())?,
    )
    .map_err(|_| "id_token header 不是 JSON".to_string())?;
    let alg = header.get("alg").and_then(Value::as_str).unwrap_or("");
    if !oidc.signing_algs.iter().any(|item| item == alg) {
        return Err(format!("不支持的 id_token 签名算法：{alg}"));
    }
    if alg != "RS256" {
        return Err("当前只支持 RS256".into());
    }
    let kid = header.get("kid").and_then(Value::as_str);
    let signing_input = format!("{}.{}", parts[0], parts[1]);
    let signature = URL_SAFE_NO_PAD
        .decode(parts[2])
        .map_err(|_| "id_token 签名不是 base64url".to_string())?;
    let mut keys = auth.jwks(false).await?;
    if kid.is_some() && !keys.iter().any(|key| key.kid.as_deref() == kid) {
        keys = auth.jwks(true).await?;
    }
    let mut verified = false;
    for key in keys {
        if key.kty != "RSA" || key.alg.as_deref().is_some_and(|alg| alg != "RS256") {
            continue;
        }
        if let (Some(n), Some(e)) = (key.n.as_deref(), key.e.as_deref()) {
            let (Ok(n), Ok(e)) = (URL_SAFE_NO_PAD.decode(n), URL_SAFE_NO_PAD.decode(e)) else {
                continue;
            };
            let components = RsaPublicKeyComponents {
                n: n.as_slice(),
                e: e.as_slice(),
            };
            if components
                .verify(
                    &RSA_PKCS1_2048_8192_SHA256,
                    signing_input.as_bytes(),
                    &signature,
                )
                .is_ok()
            {
                verified = true;
                break;
            }
        }
    }
    if !verified {
        return Err("id_token 签名校验失败".into());
    }
    let claims: IdTokenClaims = serde_json::from_slice(
        &URL_SAFE_NO_PAD
            .decode(parts[1])
            .map_err(|_| "id_token payload 不是 base64url".to_string())?,
    )
    .map_err(|_| "id_token payload 不是合法 claims".to_string())?;
    if claims.iss != oidc.issuer {
        return Err("id_token issuer 不匹配".into());
    }
    let audience_ok = match &claims.aud {
        Value::String(value) => value == &oidc.client_id,
        Value::Array(values) => values
            .iter()
            .any(|value| value.as_str() == Some(&oidc.client_id)),
        _ => false,
    };
    if !audience_ok {
        return Err("id_token audience 不匹配".into());
    }
    if let Some(azp) = claims.azp.as_deref() {
        if azp != oidc.client_id {
            return Err("id_token azp 不匹配".into());
        }
    }
    let now = now_secs();
    if claims.exp + 60 < now {
        return Err("id_token 已过期".into());
    }
    if claims.iat > now + 60 {
        return Err("id_token iat 在未来".into());
    }
    match oidc.nonce {
        NonceMode::Required => {
            if claims.nonce.as_deref() != Some(expected_nonce) {
                return Err("id_token nonce 不匹配".into());
            }
        }
        NonceMode::BestEffort => {
            if let Some(nonce) = claims.nonce.as_deref() {
                if nonce != expected_nonce {
                    return Err("id_token nonce 不匹配".into());
                }
            } else {
                tracing::warn!("id_token 缺少 nonce（FLOWLET_OIDC_NONCE=best_effort）");
            }
        }
        NonceMode::Off => {}
    }
    Ok(claims)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_mode_accepts_only_matching_bearer() {
        let config = AdminAuthConfig::token_for_tests("0123456789abcdef0123456789");
        let auth = AdminAuth::from_config(config).expect("auth");
        let mut ok = HeaderMap::new();
        ok.insert(
            header::AUTHORIZATION,
            "Bearer 0123456789abcdef0123456789".parse().unwrap(),
        );
        assert!(auth.authenticate(&ok).is_some());
        let mut bad = HeaderMap::new();
        bad.insert(header::AUTHORIZATION, "Bearer wrong".parse().unwrap());
        assert!(auth.authenticate(&bad).is_none());
    }

    #[test]
    fn allowlist_uses_sub_groups_or_email_domain() {
        let base = OidcConfig {
            issuer: "http://example".into(),
            discovery_url: "https://example/.well-known/openid-configuration".into(),
            client_id: "client".into(),
            client_secret: "secret".into(),
            scopes: "openid".into(),
            redirect_url: "http://localhost/api/auth/callback".into(),
            display_name: "GitLab".into(),
            email_claim: "email".into(),
            name_claim: "name".into(),
            groups_claim: "groups".into(),
            allowed_subs: vec!["sub-1".into()],
            allowed_groups: vec![],
            allowed_emails: vec![],
            allowed_domains: vec![],
            allow_any: false,
            allow_http_issuer: true,
            insecure_http: false,
            pkce: PkceMode::Auto,
            nonce: NonceMode::Required,
            signing_algs: vec!["RS256".into()],
        };
        let identity = Identity {
            sub: "sub-1".into(),
            email: None,
            username: None,
            name: None,
            groups: vec![],
            provider: "GitLab".into(),
        };
        assert!(allowlisted(&base, &identity));
        let mut other = identity.clone();
        other.sub = "sub-2".into();
        other.email = Some("alice@corp.example".into());
        assert!(!allowlisted(&base, &other));
        let mut by_domain = base.clone();
        by_domain.allowed_domains = vec!["corp.example".into()];
        assert!(allowlisted(&by_domain, &other));
    }

    #[test]
    fn csrf_requires_header_and_matching_origin() {
        let config = AdminAuthConfig::token_for_tests("0123456789abcdef0123456789");
        let auth = AdminAuth::from_config(config).expect("auth");
        let context = AuthContext {
            via_cookie: true,
            csrf_token: Some("token".into()),
            identity: None,
            session_key: None,
        };
        let mut headers = HeaderMap::new();
        assert!(!auth.verify_csrf(&headers, &context));
        headers.insert(CSRF_HEADER, "token".parse().unwrap());
        assert!(!auth.verify_csrf(&headers, &context));
        headers.insert(header::ORIGIN, "http://127.0.0.1".parse().unwrap());
        assert!(auth.verify_csrf(&headers, &context));
    }
}
