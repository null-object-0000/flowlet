//! OCI 镜像仓库（Docker Registry HTTP API V2 / OCI Distribution）客户端。
//!
//! 选择面（契约 `.dsh-scratch/registry-contract.md` §2/§4，逐行为对齐 Node
//! `packages/flowlet-core/src/web/registry.ts`）：
//! - 只做行业通用标准：`GET /v2/` 探测 + `WWW-Authenticate` 质询 + Bearer token 换发；
//!   Docker Hub / GHCR / Quay / ACR / Harbor 都走同一套，robot account 只是普通
//!   「用户名 + 密码/token」，不特判；
//! - **不做** Harbor 专属能力：不请求 `/api/v2.0/*`、不探测版本/项目数、不调
//!   `/v2/_catalog`、不按主机名猜 Harbor；
//! - 版本只取标准响应头 `docker-distribution-api-version`（如 `registry/2.0`），缺失为
//!   `None`，不伪造；
//! - 20s 超时；`insecure` 时跳过 TLS 校验；错误文案逐字对齐契约 §2 / §4。
//!
//! HTTP 调用既服务桌面/Web Host 的保存校验，也服务 CLI 的透传子命令；本模块只负责
//! URL/请求构造与响应解析，便于单测。

use base64::Engine;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
use std::time::Duration;

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(20);

/// 认证失败统一文案（契约 §4.2 逐字）。
pub const AUTH_FAILED: &str = "用户名或 token 无效（registry 认证失败）";
/// Bearer 质询里 realm 缺失/无法解析（契约 §4.2 逐字）。
pub const CHALLENGE_UNPARSABLE: &str = "镜像仓库返回的认证质询无法解析";

/// 校验结果的身份投影：`username` 是入参用户名（docker login 的用户名），
/// `version` 只来自标准响应头。`detail` 在服务层恒为 `None`（契约 §4.2）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RegistryIdentity {
    pub username: Option<String>,
    pub version: Option<String>,
}

/// 错误投影：`status` 用于排查，`message` 是可直接展示的契约文案。
///
/// `Display` 只输出 `message`：Node `checkRegistry` 返回给界面/命令结果的是
/// `error.message`，而契约 §4.2 的文案不含 provider/状态码前缀；若在这里拼
/// `Registry API {status}:`，两套 Host 的保存失败文案（`校验失败，未保存：...`）
/// 就会出现跨语言差异。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistryError {
    pub status: Option<u16>,
    pub message: String,
}

impl RegistryError {
    fn new(status: Option<u16>, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for RegistryError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for RegistryError {}

/// 归一后的 `baseUrl` 的 `host[:port]`，用于环境变量 `{PREFIX}_HOST` 与提示。
///
/// 归一后的 `baseUrl` 一定是可解析的 origin；这里对脏数据不抛错（环境变量生成
/// 不应因为一条旧行失败），解析失败时按文本剥掉 scheme 与路径。
pub fn registry_host(base_url: &str) -> String {
    let trimmed = base_url.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let candidate = if scheme_prefix_len(trimmed).is_some() {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    match url::Url::parse(&candidate) {
        Ok(parsed) => {
            let mut host = parsed.host_str().unwrap_or_default().to_string();
            if let Some(port) = parsed.port() {
                host.push_str(&format!(":{port}"));
            }
            host
        }
        Err(_) => {
            let stripped = match scheme_prefix_len(trimmed) {
                Some(len) => &trimmed[len..],
                None => trimmed,
            };
            stripped
                .split(['/', '?', '#'])
                .next()
                .unwrap_or_default()
                .trim()
                .to_string()
        }
    }
}

/// 规范化镜像仓库地址（契约 §2，规则按顺序执行）：
/// 1. trim；空 → `镜像仓库地址不能为空`；
/// 2. 没有 `scheme://` 前缀时补 `https://`；
/// 3. 协议必须是 http/https；
/// 4. 拒绝 query / fragment；
/// 5. 去掉末尾所有 `/`，pathname 为 `/v2`、`/v2/` 时也剥掉；处理后必须没有路径；
/// 6. 主机名不能为空；
/// 7. 返回 origin 形式 `http(s)://host[:port]`（无末尾斜杠、无路径）。
pub fn normalize_base_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("镜像仓库地址不能为空".to_string());
    }
    // 用户通常只填 `hub.example.com`（docker login 也是这么填的），补默认 https。
    let candidate = if scheme_prefix_len(trimmed).is_some() {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    let parsed = match url::Url::parse(&candidate) {
        Ok(parsed) => parsed,
        Err(_) => return Err(parse_failure_message(&candidate)),
    };
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("镜像仓库地址必须是 http 或 https".to_string());
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err("镜像仓库地址不能带查询参数或锚点".to_string());
    }
    // 去掉末尾所有 `/`；再兼容用户从文档粘贴的 `/v2`、`/v2/`（只是地址清洗，
    // 不是 Harbor 探测）。
    let path = parsed.path().trim_end_matches('/');
    if !path.is_empty() && path != "/v2" {
        return Err("镜像仓库地址只能是主机（可带端口），不能包含路径".to_string());
    }
    if parsed.host_str().map_or(true, str::is_empty) {
        return Err("镜像仓库地址缺少主机名".to_string());
    }
    let mut base = format!(
        "{}://{}",
        parsed.scheme(),
        parsed.host_str().unwrap_or_default()
    );
    if let Some(port) = parsed.port() {
        base.push_str(&format!(":{port}"));
    }
    Ok(base)
}

/// `^[a-zA-Z][a-zA-Z0-9+.-]*://` 的长度；没有合法 scheme 前缀时为 `None`。
fn scheme_prefix_len(value: &str) -> Option<usize> {
    let index = value.find("://")?;
    let scheme = &value[..index];
    let mut chars = scheme.chars();
    match chars.next() {
        Some(first) if first.is_ascii_alphabetic() => {}
        _ => return None,
    }
    if !chars.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '+' | '-' | '.')) {
        return None;
    }
    Some(index + 3)
}

/// URL 解析失败的契约文案。
///
/// 与 Node `urlParseErrorDetail` 逐字一致：地址预处理器已经保证候选串带 scheme，
/// 因此只可能落到「缺少主机名」（整个串就是 `scheme://`）或「无法解析」两条分支。
fn parse_failure_message(candidate: &str) -> String {
    match scheme_prefix_len(candidate) {
        None => "镜像仓库地址无法解析：relative URL without a base".to_string(),
        Some(len) if len == candidate.len() => "镜像仓库地址缺少主机名".to_string(),
        Some(_) => "镜像仓库地址无法解析：invalid URL".to_string(),
    }
}

/// `WWW-Authenticate` 质询解析结果；`scheme` 是首个质询方案的小写形式，
/// 无质询时为空串。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RegistryChallenge {
    pub scheme: String,
    pub realm: Option<String>,
    pub service: Option<String>,
    pub scope: Option<String>,
}

/// 解析 `WWW-Authenticate`（RFC 6750 / Docker token auth）：
/// 形如 `Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:x:pull"`。
/// 只解析首个质询方案；参数值支持 `"..."` 与转义；空白值归一为 `None`。
pub fn parse_challenge(raw: Option<&str>) -> RegistryChallenge {
    let text = raw.unwrap_or_default().trim();
    if text.is_empty() {
        return RegistryChallenge::default();
    }
    let (scheme, rest) = match text.char_indices().find(|(_, ch)| ch.is_whitespace()) {
        Some((index, ch)) => (&text[..index], &text[index + ch.len_utf8()..]),
        None => (text, ""),
    };
    let scheme = scheme.to_lowercase();
    if scheme != "bearer" {
        return RegistryChallenge {
            scheme,
            ..RegistryChallenge::default()
        };
    }
    let params = parse_challenge_params(rest);
    let param = |key: &str| {
        params
            .iter()
            .find(|pair| pair.0 == key)
            .map(|pair| pair.1.clone())
    };
    RegistryChallenge {
        scheme,
        realm: blank_to_none(param("realm")),
        service: blank_to_none(param("service")),
        scope: blank_to_none(param("scope")),
    }
}

fn challenge_param_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r#"([A-Za-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))"#)
            .expect("challenge 参数正则是常量")
    })
}

/// 与 Node `parseChallengeParams` 同语义：同名参数取第一次出现，值支持引号与转义。
fn parse_challenge_params(raw: &str) -> Vec<(String, String)> {
    let mut params: Vec<(String, String)> = Vec::new();
    for captures in challenge_param_regex().captures_iter(raw) {
        let Some(key) = captures.get(1) else {
            continue;
        };
        let key = key.as_str().to_lowercase();
        if params.iter().any(|pair| pair.0 == key) {
            continue;
        }
        let value = match captures.get(2) {
            Some(quoted) => unescape_challenge_value(quoted.as_str()),
            None => captures
                .get(3)
                .map(|value| value.as_str())
                .unwrap_or_default()
                .to_string(),
        };
        params.push((key, value.to_string()));
    }
    params
}

/// 反转义引号内值：`\\(.)` → `$1`；反斜杠后是行终止符（JS 正则 `.` 不匹配）时保留原样。
fn unescape_challenge_value(raw: &str) -> String {
    let mut result = String::with_capacity(raw.len());
    let mut chars = raw.chars();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            result.push(ch);
            continue;
        }
        match chars.next() {
            Some(next) if !matches!(next, '\n' | '\r' | '\u{2028}' | '\u{2029}') => {
                result.push(next)
            }
            Some(next) => {
                result.push('\\');
                result.push(next);
            }
            None => result.push('\\'),
        }
    }
    result
}

fn blank_to_none(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// `Authorization: Basic base64("{username}:{password}")`（docker login 的同一套凭证）。
pub fn authorization_header(username: &str, password: &str) -> String {
    let encoded =
        base64::engine::general_purpose::STANDARD.encode(format!("{username}:{password}"));
    format!("Basic {encoded}")
}

/// 版本唯一来源：标准响应头 `docker-distribution-api-version`；缺失/空白为 `None`。
pub fn parse_version(header: Option<&str>) -> Option<String> {
    header
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// 非 401/非 2xx 的状态码映射（契约 §4.2 逐字）。
pub fn describe_status_error(status: u16) -> String {
    match status {
        403 => "认证被拒绝（403）：用户名或 token 无效，或该账号无权访问".to_string(),
        404 => "接口不存在：请确认填写的是镜像仓库根地址（如 https://hub.example.com），不要带路径"
            .to_string(),
        429 => "镜像仓库触发限流，稍后重试".to_string(),
        other => format!("镜像仓库返回 HTTP {other}"),
    }
}

/// token 端点响应体：`token` 优先，其次 OAuth2 兼容的 `access_token`；都为空为 `None`。
pub fn parse_token(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(trimmed).ok()?;
    let row = value.as_object()?;
    for key in ["token", "access_token"] {
        if let Some(item) = row.get(key).and_then(|item| item.as_str()) {
            let trimmed = item.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

/// 构造 token 端点 URL：`{realm}?service={service}[&scope={scope}]`。
/// realm 缺失、无法解析或不是 http(s) 绝对地址 → `None`（调用方报「认证质询无法解析」）。
fn build_token_url(challenge: &RegistryChallenge) -> Option<String> {
    let realm = challenge.realm.as_deref()?;
    let mut url = url::Url::parse(realm).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    // 与 Node `searchParams.set` 同语义：同名参数替换而不是追加，顺序保持。
    let mut pairs: Vec<(String, String)> = url
        .query_pairs()
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    for (key, value) in [
        ("service", challenge.service.as_deref()),
        ("scope", challenge.scope.as_deref()),
    ] {
        let Some(value) = value else {
            continue;
        };
        let mut replaced = false;
        for pair in pairs.iter_mut() {
            if pair.0 == key {
                pair.1 = value.to_string();
                replaced = true;
                break;
            }
        }
        if !replaced {
            pairs.push((key.to_string(), value.to_string()));
        }
    }
    if !pairs.is_empty() {
        let mut serializer = url.query_pairs_mut();
        serializer.clear();
        for (key, value) in &pairs {
            serializer.append_pair(key, value);
        }
    }
    Some(url.to_string())
}

/// 单次请求的响应快照：body 之外还要在消费 body 前取标准头与质询头。
struct ResponseSnapshot {
    status: u16,
    version: Option<String>,
    challenge: Option<String>,
    text: String,
}

impl ResponseSnapshot {
    fn is_success(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

pub struct RegistryClient {
    base: String,
    username: String,
    password: String,
    insecure: bool,
}

impl RegistryClient {
    /// 构造客户端：地址按契约 §2 归一，用户名 trim。
    ///
    /// 与 Node `checkRegistry` 一致，这里**不**校验用户名/密码是否为空：空凭据会照常
    /// 发请求，由服务端 401 映射成统一认证失败文案（保存路径的必填校验在
    /// `service_credentials::normalize_username` 与 token 检查里）。
    pub fn new(url: &str, username: &str, password: &str) -> Result<Self, String> {
        Ok(Self {
            base: normalize_base_url(url)?,
            username: username.trim().to_string(),
            password: password.to_string(),
            insecure: false,
        })
    }

    pub fn with_insecure(mut self, insecure: bool) -> Self {
        self.insecure = insecure;
        self
    }

    pub fn base(&self) -> &str {
        &self.base
    }

    pub fn username(&self) -> &str {
        &self.username
    }

    fn build_client(&self) -> Result<reqwest::Client, String> {
        reqwest::Client::builder()
            .timeout(DEFAULT_TIMEOUT)
            .danger_accept_invalid_certs(self.insecure)
            .user_agent(format!("flowlet/{}", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|error| format!("创建 HTTP 客户端失败：{error}"))
    }

    async fn send(
        &self,
        client: &reqwest::Client,
        url: &str,
        authorization: &str,
    ) -> Result<ResponseSnapshot, RegistryError> {
        let response = client
            .get(url)
            .header("Authorization", authorization)
            .header("Accept", "application/json")
            .send()
            .await
            .map_err(|error| {
                RegistryError::new(
                    None,
                    format!("请求 {url} 失败：{error}（内网自签证书请加 --insecure）"),
                )
            })?;
        let status = response.status().as_u16();
        // 标准头与质询头都必须在消费 body 之前取。
        let version = parse_version(
            response
                .headers()
                .get("docker-distribution-api-version")
                .and_then(|value| value.to_str().ok()),
        );
        let challenge = response
            .headers()
            .get("www-authenticate")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let text = response
            .text()
            .await
            .map_err(|error| RegistryError::new(Some(status), format!("读取响应失败：{error}")))?;
        Ok(ResponseSnapshot {
            status,
            version,
            challenge,
            text,
        })
    }

    /// 校验凭据（契约 §4）：
    /// `GET {base}/v2/`（Basic）→ 200 直接成功；401 且 Bearer 质询则用
    /// realm/service/scope 换 token → 携带 `Bearer` 重试 `GET {base}/v2/`。
    /// 成功时 `version` 取 `docker-distribution-api-version`（重试响应优先，其次
    /// token 响应），`username` 为入参用户名。
    pub async fn check(&self) -> Result<RegistryIdentity, RegistryError> {
        let api_url = format!("{}/v2/", self.base);
        let basic = authorization_header(&self.username, &self.password);
        let client = self
            .build_client()
            .map_err(|message| RegistryError::new(None, message))?;

        let main = self.send(&client, &api_url, &basic).await?;
        if main.is_success() {
            return Ok(self.identity(main.version));
        }
        if main.status != 401 {
            return Err(RegistryError::new(
                Some(main.status),
                describe_status_error(main.status),
            ));
        }

        // 401：只接受 Bearer 质询；Basic 质询或不带 Bearer 说明用户名/密码不对。
        let challenge = parse_challenge(main.challenge.as_deref());
        if challenge.scheme != "bearer" {
            return Err(RegistryError::new(Some(401), AUTH_FAILED));
        }
        let token_url = build_token_url(&challenge)
            .ok_or_else(|| RegistryError::new(Some(401), CHALLENGE_UNPARSABLE))?;

        let token_response = self.send(&client, &token_url, &basic).await?;
        if token_response.status == 401 || token_response.status == 403 {
            return Err(RegistryError::new(Some(token_response.status), AUTH_FAILED));
        }
        if token_response.status != 200 {
            return Err(RegistryError::new(
                Some(token_response.status),
                describe_status_error(token_response.status),
            ));
        }
        let token = parse_token(&token_response.text)
            .ok_or_else(|| RegistryError::new(Some(200), AUTH_FAILED))?;

        let retried = self
            .send(&client, &api_url, &format!("Bearer {token}"))
            .await?;
        if retried.is_success() {
            // 重试响应头优先，其次 token 响应头（契约 §4.2）。
            return Ok(self.identity(retried.version.or(token_response.version)));
        }
        Err(RegistryError::new(Some(retried.status), AUTH_FAILED))
    }

    fn identity(&self, version: Option<String>) -> RegistryIdentity {
        RegistryIdentity {
            username: Some(self.username.clone()),
            version,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{HeaderMap, HeaderValue, StatusCode};
    use axum::response::{IntoResponse, Response};
    use axum::routing::get;
    use axum::Router;

    const MOCK_USER: &str = "robot$flowlet+pull";
    const MOCK_PASSWORD: &str = "mock-registry-password-9x8y";
    const MOCK_TOKEN: &str = "mock-registry-bearer-token";

    fn ok_response(version: Option<&str>) -> Response {
        let mut response = Response::new(Body::from("{}"));
        if let Some(version) = version {
            response.headers_mut().insert(
                "docker-distribution-api-version",
                HeaderValue::from_str(version).unwrap(),
            );
        }
        response
    }

    fn unauthorized(challenge: Option<&str>) -> Response {
        let mut response = Response::new(Body::empty());
        *response.status_mut() = StatusCode::UNAUTHORIZED;
        if let Some(challenge) = challenge {
            response.headers_mut().insert(
                "www-authenticate",
                HeaderValue::from_str(challenge).unwrap(),
            );
        }
        response
    }

    fn authorization_of(headers: &HeaderMap) -> String {
        headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_string()
    }

    async fn spawn(router: Router) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        base
    }

    #[test]
    fn normalizes_registry_urls() {
        assert_eq!(
            normalize_base_url("hub.example.com").unwrap(),
            "https://hub.example.com"
        );
        assert_eq!(
            normalize_base_url("  hub.example.com/  ").unwrap(),
            "https://hub.example.com"
        );
        assert_eq!(
            normalize_base_url("  https://hub.example.com///  ").unwrap(),
            "https://hub.example.com"
        );
        assert_eq!(
            normalize_base_url("http://10.0.0.5:5000").unwrap(),
            "http://10.0.0.5:5000"
        );
        assert_eq!(
            normalize_base_url("10.1.1.1:5000").unwrap(),
            "https://10.1.1.1:5000"
        );
        // 用户从文档粘贴的 `/v2`、`/v2/` 属于地址清洗，不是 Harbor 探测。
        assert_eq!(
            normalize_base_url("https://hub.example.com/v2").unwrap(),
            "https://hub.example.com"
        );
        assert_eq!(
            normalize_base_url("https://hub.example.com/v2/").unwrap(),
            "https://hub.example.com"
        );
        assert_eq!(
            normalize_base_url("https://hub.example.com/v2//").unwrap(),
            "https://hub.example.com"
        );
        // 主机名/协议大小写按 URL 语义归一。
        assert_eq!(
            normalize_base_url("HTTPS://Hub.Example.com").unwrap(),
            "https://hub.example.com"
        );
        // 默认端口归一后省略（与 Node `URL.origin` 一致）。
        assert_eq!(
            normalize_base_url("https://hub.example.com:443").unwrap(),
            "https://hub.example.com"
        );

        assert_eq!(normalize_base_url("").unwrap_err(), "镜像仓库地址不能为空");
        assert_eq!(
            normalize_base_url("   ").unwrap_err(),
            "镜像仓库地址不能为空"
        );
        assert_eq!(
            normalize_base_url("ftp://hub.example.com").unwrap_err(),
            "镜像仓库地址必须是 http 或 https"
        );
        assert_eq!(
            normalize_base_url("https://hub.example.com?x=1").unwrap_err(),
            "镜像仓库地址不能带查询参数或锚点"
        );
        assert_eq!(
            normalize_base_url("https://hub.example.com/#top").unwrap_err(),
            "镜像仓库地址不能带查询参数或锚点"
        );
        assert_eq!(
            normalize_base_url("https://hub.example.com/library/nginx").unwrap_err(),
            "镜像仓库地址只能是主机（可带端口），不能包含路径"
        );
        assert_eq!(
            normalize_base_url("hub.example.com/library/nginx").unwrap_err(),
            "镜像仓库地址只能是主机（可带端口），不能包含路径"
        );
        assert_eq!(
            normalize_base_url("https://hub.example.com/v2/library").unwrap_err(),
            "镜像仓库地址只能是主机（可带端口），不能包含路径"
        );
        // Harbor 的 `/api/v2.0` 也只是路径：绝不猜测或探测。
        assert_eq!(
            normalize_base_url("https://hub.example.com/api/v2.0").unwrap_err(),
            "镜像仓库地址只能是主机（可带端口），不能包含路径"
        );
        // 非法端口：与 Node `new URL` 抛错后的 invalid URL 文案对齐。
        assert_eq!(
            normalize_base_url("https://hub.example.com:bad-port").unwrap_err(),
            "镜像仓库地址无法解析：invalid URL"
        );
        // `scheme://` 之后没有主机：与 Node `urlParseErrorDetail` 的 empty host 对齐。
        assert_eq!(
            normalize_base_url("https://").unwrap_err(),
            "镜像仓库地址缺少主机名"
        );
        // WHATWG 会忽略 scheme 后多余的斜杠：`https:///path` 解析出的主机是 `path`
        // （与 Node `new URL` / `URL.origin` 一致），不是报错。
        assert_eq!(normalize_base_url("https:///path").unwrap(), "https://path");
        assert_eq!(
            normalize_base_url("https://hub example.com").unwrap_err(),
            "镜像仓库地址无法解析：invalid URL"
        );
    }

    #[test]
    fn extracts_host_for_env_keys() {
        assert_eq!(registry_host("https://hub.example.com"), "hub.example.com");
        assert_eq!(registry_host("http://10.1.1.1:5000"), "10.1.1.1:5000");
        assert_eq!(
            registry_host("  https://hub.example.com/  "),
            "hub.example.com"
        );
        // 未归一的脏数据（有路径）只取 host[:port]。
        assert_eq!(
            registry_host("https://hub.example.com/library/nginx"),
            "hub.example.com"
        );
        assert_eq!(
            registry_host("hub.example.com:5000"),
            "hub.example.com:5000"
        );
        assert_eq!(registry_host(""), "");
        assert_eq!(
            registry_host("https://hub.example.com/v2/"),
            "hub.example.com"
        );
        // 脏数据不抛错（envKeys 不该因旧行失败）。
        assert_eq!(registry_host("https://"), "");
        assert_eq!(registry_host("::bad"), "::bad");
        // 默认端口省略，与 Node `URL.host` 一致。
        assert_eq!(
            registry_host("https://hub.example.com:443"),
            "hub.example.com"
        );
        // IPv6 保留方括号。
        assert_eq!(registry_host("http://[::1]:5000"), "[::1]:5000");
        // 解析失败的兜底：按文本剥 scheme 与路径（环境变量生成不因脏数据失败）。
        assert_eq!(registry_host("https://hub example.com"), "hub example.com");
    }

    #[test]
    fn parses_bearer_challenges() {
        let challenge = parse_challenge(Some(
            r#"Bearer realm="https://auth.example.com/token",service="harbor-registry",scope="repository:library/nginx:pull""#,
        ));
        assert_eq!(challenge.scheme, "bearer");
        assert_eq!(
            challenge.realm.as_deref(),
            Some("https://auth.example.com/token")
        );
        assert_eq!(challenge.service.as_deref(), Some("harbor-registry"));
        assert_eq!(
            challenge.scope.as_deref(),
            Some("repository:library/nginx:pull")
        );
        // 参数值可以不带引号。
        let unquoted = parse_challenge(Some("Bearer realm=https://a/token service=svc"));
        assert_eq!(unquoted.realm.as_deref(), Some("https://a/token"));
        assert_eq!(unquoted.service.as_deref(), Some("svc"));
        assert_eq!(unquoted.scope, None);
        // 方案大小写不敏感（与 Node 的 scheme 小写化一致）。
        let uppercase = parse_challenge(Some("BEARER realm=\"https://a/token\""));
        assert_eq!(uppercase.scheme, "bearer");
        assert_eq!(uppercase.realm.as_deref(), Some("https://a/token"));
        // 转义引号按 `\\(.)` 反转义。
        let escaped = parse_challenge(Some(r#"Bearer realm="https://a/\"/token""#));
        assert_eq!(escaped.realm.as_deref(), Some("https://a/\"/token"));
        // 同名参数取第一次出现。
        let repeated = parse_challenge(Some(
            r#"Bearer realm="https://first/token",realm="https://second/token""#,
        ));
        assert_eq!(repeated.realm.as_deref(), Some("https://first/token"));

        for not_bearer in [
            Some("Basic realm=\"registry\""),
            Some("Negotiate"),
            None,
            Some(""),
            Some("   "),
        ] {
            let challenge = parse_challenge(not_bearer);
            assert_ne!(challenge.scheme, "bearer");
            assert_eq!(challenge.realm, None);
        }

        // Bearer 但 realm 缺失/空白：scheme 仍是 bearer，由调用方报「质询无法解析」。
        for missing_realm in [
            Some("Bearer"),
            Some("Bearer service=\"svc\""),
            Some("Bearer realm=\"\""),
            Some("Bearer realm=\"   \""),
        ] {
            let challenge = parse_challenge(missing_realm);
            assert_eq!(challenge.scheme, "bearer");
            assert_eq!(challenge.realm, None);
        }
    }

    #[test]
    fn builds_token_endpoint_urls() {
        let challenge = parse_challenge(Some(
            r#"Bearer realm="https://auth.example.com/token",service="harbor-registry",scope="repository:library/nginx:pull""#,
        ));
        assert_eq!(
            build_token_url(&challenge).as_deref(),
            Some(
                "https://auth.example.com/token?service=harbor-registry&scope=repository%3Alibrary%2Fnginx%3Apull"
            )
        );

        // service/scope 可缺省；都没有时 URL 保持原样（不追加多余的 `?`）。
        let realm_only = parse_challenge(Some(r#"Bearer realm="https://auth.example.com/token""#));
        assert_eq!(
            build_token_url(&realm_only).as_deref(),
            Some("https://auth.example.com/token")
        );
        let scope_only = parse_challenge(Some(
            r#"Bearer realm="https://auth.example.com/token",scope="repository:x:pull""#,
        ));
        assert_eq!(
            build_token_url(&scope_only).as_deref(),
            Some("https://auth.example.com/token?scope=repository%3Ax%3Apull")
        );

        // realm 已有 query：追加参数，现有参数保留。
        let with_query = parse_challenge(Some(
            r#"Bearer realm="https://auth.example.com/token?account=robot",service="harbor-registry""#,
        ));
        assert_eq!(
            build_token_url(&with_query).as_deref(),
            Some("https://auth.example.com/token?account=robot&service=harbor-registry")
        );

        // realm 缺失/无法解析/非 http(s)：None（调用方报「认证质询无法解析」）。
        for realm in [
            None,
            Some("not a url"),
            Some("ftp://auth.example.com/token"),
            Some("/relative-token"),
        ] {
            let challenge = RegistryChallenge {
                scheme: "bearer".to_string(),
                realm: realm.map(str::to_string),
                service: None,
                scope: None,
            };
            assert_eq!(build_token_url(&challenge), None, "realm: {realm:?}");
        }
    }

    #[test]
    fn parses_token_payloads() {
        assert_eq!(
            parse_token(r#"{"token":"  mock-token  "}"#),
            Some("mock-token".to_string())
        );
        // `token` 优先，其次 OAuth2 兼容的 `access_token`。
        assert_eq!(
            parse_token(r#"{"token":"primary","access_token":"secondary"}"#),
            Some("primary".to_string())
        );
        assert_eq!(
            parse_token(r#"{"access_token":"secondary"}"#),
            Some("secondary".to_string())
        );
        for invalid in [
            "",
            "   ",
            "not-json",
            "[]",
            "null",
            r#"{"token":""}"#,
            r#"{"token":"   "}"#,
            r#"{"token":42}"#,
            r#"{"access_token":null}"#,
            r#"{"other":"x"}"#,
        ] {
            assert_eq!(parse_token(invalid), None, "payload: {invalid}");
        }
    }

    #[test]
    fn maps_status_codes_to_contract_messages() {
        assert_eq!(
            describe_status_error(403),
            "认证被拒绝（403）：用户名或 token 无效，或该账号无权访问"
        );
        assert_eq!(
            describe_status_error(404),
            "接口不存在：请确认填写的是镜像仓库根地址（如 https://hub.example.com），不要带路径"
        );
        assert_eq!(describe_status_error(429), "镜像仓库触发限流，稍后重试");
        assert_eq!(describe_status_error(500), "镜像仓库返回 HTTP 500");
    }

    #[test]
    fn formats_error_display_as_contract_message() {
        let error = RegistryError {
            status: Some(401),
            message: AUTH_FAILED.to_string(),
        };
        // Display 不拼状态码前缀，保存失败文案才能与 Node 逐字一致。
        assert_eq!(error.to_string(), AUTH_FAILED);
        let without_status = RegistryError {
            status: None,
            message: "镜像仓库地址不能为空".to_string(),
        };
        assert_eq!(without_status.to_string(), "镜像仓库地址不能为空");
    }

    #[test]
    fn parses_distribution_version_header() {
        assert_eq!(
            parse_version(Some(" registry/2.0 ")),
            Some("registry/2.0".to_string())
        );
        assert_eq!(parse_version(Some("")), None);
        assert_eq!(parse_version(Some("   ")), None);
        assert_eq!(parse_version(None), None);
    }

    #[test]
    fn builds_basic_authorization_header() {
        let header = authorization_header(MOCK_USER, MOCK_PASSWORD);
        assert!(header.starts_with("Basic "));
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(header.trim_start_matches("Basic "))
            .unwrap();
        assert_eq!(
            String::from_utf8(decoded).unwrap(),
            format!("{MOCK_USER}:{MOCK_PASSWORD}")
        );
    }

    #[test]
    fn constructs_client_with_normalized_url_and_trimmed_username() {
        let client = RegistryClient::new(
            "  hub.example.com/v2/  ",
            &format!("  {MOCK_USER}  "),
            MOCK_PASSWORD,
        )
        .unwrap();
        assert_eq!(client.base(), "https://hub.example.com");
        assert_eq!(client.username(), MOCK_USER);

        assert_eq!(
            RegistryClient::new("ftp://hub.example.com", MOCK_USER, MOCK_PASSWORD)
                .err()
                .unwrap(),
            "镜像仓库地址必须是 http 或 https"
        );
        // 空凭据不在构造期报错（与 Node 一致），由服务端 401 映射成统一认证失败文案。
        assert!(RegistryClient::new("hub.example.com", "", "").is_ok());
    }

    #[tokio::test]
    async fn accepts_basic_auth_registry_without_challenge() {
        let router = Router::new().route(
            "/v2/",
            get(|headers: HeaderMap| async move {
                if authorization_of(&headers) == authorization_header(MOCK_USER, MOCK_PASSWORD) {
                    ok_response(Some("registry/2.0"))
                } else {
                    unauthorized(None)
                }
            }),
        );
        let base = spawn(router).await;
        let client = RegistryClient::new(&base, MOCK_USER, MOCK_PASSWORD).unwrap();
        let identity = client.check().await.unwrap();
        assert_eq!(identity.username.as_deref(), Some(MOCK_USER));
        assert_eq!(identity.version.as_deref(), Some("registry/2.0"));
    }

    #[tokio::test]
    async fn follows_bearer_challenge_and_prefers_retry_version_header() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let challenge = format!(
            r#"Bearer realm="{base}/token",service="harbor-registry",scope="repository:library/nginx:pull""#
        );
        let router = Router::new()
            .route(
                "/v2/",
                get(move |headers: HeaderMap| {
                    let challenge = challenge.clone();
                    async move {
                        if authorization_of(&headers) == format!("Bearer {MOCK_TOKEN}") {
                            ok_response(Some("registry/2.0"))
                        } else {
                            unauthorized(Some(challenge.as_str()))
                        }
                    }
                }),
            )
            .route(
                "/token",
                get(|headers: HeaderMap| async move {
                    if authorization_of(&headers) == authorization_header(MOCK_USER, MOCK_PASSWORD)
                    {
                        let mut response = axum::Json(serde_json::json!({
                            "access_token": MOCK_TOKEN
                        }))
                        .into_response();
                        // 重试响应头优先，其次 token 响应头（契约 §4.2）。
                        response.headers_mut().insert(
                            "docker-distribution-api-version",
                            HeaderValue::from_static("registry/token"),
                        );
                        response
                    } else {
                        StatusCode::UNAUTHORIZED.into_response()
                    }
                }),
            );
        tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        let client = RegistryClient::new(&base, MOCK_USER, MOCK_PASSWORD).unwrap();
        let identity = client.check().await.unwrap();
        assert_eq!(identity.username.as_deref(), Some(MOCK_USER));
        assert_eq!(identity.version.as_deref(), Some("registry/2.0"));
    }

    #[tokio::test]
    async fn falls_back_to_token_response_version() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let challenge = format!(r#"Bearer realm="{base}/token""#);
        let router = Router::new()
            .route(
                "/v2/",
                get(move |headers: HeaderMap| {
                    let challenge = challenge.clone();
                    async move {
                        if authorization_of(&headers) == format!("Bearer {MOCK_TOKEN}") {
                            ok_response(None)
                        } else {
                            unauthorized(Some(challenge.as_str()))
                        }
                    }
                }),
            )
            .route(
                "/token",
                get(|| async {
                    let mut response =
                        axum::Json(serde_json::json!({ "token": MOCK_TOKEN })).into_response();
                    response.headers_mut().insert(
                        "docker-distribution-api-version",
                        HeaderValue::from_static("registry/token"),
                    );
                    response
                }),
            );
        tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        let client = RegistryClient::new(&base, MOCK_USER, MOCK_PASSWORD).unwrap();
        let identity = client.check().await.unwrap();
        assert_eq!(identity.version.as_deref(), Some("registry/token"));
    }

    #[tokio::test]
    async fn rejects_non_bearer_challenge_with_auth_failed() {
        let router = Router::new().route(
            "/v2/",
            get(|| async { unauthorized(Some("Basic realm=\"registry\"")) }),
        );
        let base = spawn(router).await;
        let client = RegistryClient::new(&base, MOCK_USER, MOCK_PASSWORD).unwrap();
        let error = client.check().await.unwrap_err();
        assert_eq!(error.to_string(), AUTH_FAILED);
    }

    #[tokio::test]
    async fn rejects_unparsable_bearer_challenge() {
        let router = Router::new().route(
            "/v2/",
            get(|| async { unauthorized(Some("Bearer service=\"harbor-registry\"")) }),
        );
        let base = spawn(router).await;
        let client = RegistryClient::new(&base, MOCK_USER, MOCK_PASSWORD).unwrap();
        let error = client.check().await.unwrap_err();
        assert_eq!(error.to_string(), CHALLENGE_UNPARSABLE);
    }

    #[tokio::test]
    async fn maps_token_endpoint_rejection_to_auth_failed() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let challenge = format!(r#"Bearer realm="{base}/token",service="harbor-registry""#);
        let router = Router::new()
            .route(
                "/v2/",
                get(move || {
                    let challenge = challenge.clone();
                    async move { unauthorized(Some(challenge.as_str())) }
                }),
            )
            .route(
                "/token",
                get(|| async { StatusCode::UNAUTHORIZED.into_response() }),
            );
        tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        let client = RegistryClient::new(&base, MOCK_USER, MOCK_PASSWORD).unwrap();
        let error = client.check().await.unwrap_err();
        assert_eq!(error.to_string(), AUTH_FAILED);
    }

    #[tokio::test]
    async fn maps_forbidden_registry_response_to_contract_message() {
        let router = Router::new().route(
            "/v2/",
            get(|| async { (StatusCode::FORBIDDEN, "forbidden").into_response() }),
        );
        let base = spawn(router).await;
        let client = RegistryClient::new(&base, MOCK_USER, MOCK_PASSWORD).unwrap();
        let error = client.check().await.unwrap_err();
        assert_eq!(error.to_string(), describe_status_error(403));
        assert_eq!(error.status, Some(403));
    }
}
