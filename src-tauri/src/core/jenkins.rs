//! Jenkins API 客户端（面向 Jenkins LTS 的 `/me/api/json` 身份端点）。
//!
//! 选择面：
//! - 认证只用 HTTP Basic：`Authorization: Basic base64("{username}:{token}")`。
//!   Jenkins API Token 必须与用户名一起认证，单独 token 无法确认身份；
//! - 校验端点固定为 `/me/api/json`：只有登录用户自己能访问，能同时确认用户名与
//!   token 有效；`/api/json`（根信息）匿名可访问，不能用来校验凭据；
//! - 版本取响应的 `X-Jenkins` 头，不需要额外请求（Jenkins 没有 GitLab 那样的
//!   `/version` 端点）；
//! - Jenkins 使用上下文路径部署（`https://host/ci`）时 `/me/api/json` 直接拼在
//!   上下文路径后，因此地址归一保留子路径，**不**自动剥 `/api`、`/me`、`/api/json`。
//!
//! HTTP 调用既服务桌面/Web Host 的保存校验，也服务 CLI 的透传子命令；本模块只负责
//! URL/请求构造与响应解析，便于单测。

use serde::{Deserialize, Serialize};
use std::time::Duration;

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(20);

/// 当前凭据的身份投影：只保留用户名与 Jenkins 版本，避免把 `<me>` 大对象塞进上下文。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct JenkinsIdentity {
    pub username: Option<String>,
    pub version: Option<String>,
}

#[derive(Debug, Clone)]
pub struct JenkinsError {
    pub status: Option<u16>,
    pub message: String,
}

impl std::fmt::Display for JenkinsError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.status {
            Some(status) => write!(formatter, "Jenkins API {status}: {}", self.message),
            None => write!(formatter, "Jenkins API: {}", self.message),
        }
    }
}

impl std::error::Error for JenkinsError {}

/// 规范化实例地址：
/// - 必须是 http/https；
/// - 去掉末尾所有 `/`；
/// - 保留子路径部署（`https://host/ci`）；
/// - **不**自动剥 `/api`、`/me`、`/api/json`（Jenkins API 没有统一 `/api` 前缀，
///   `/me/api/json` 本身就是校验端点）；
/// - 拒绝 query / fragment。
pub fn normalize_base_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Jenkins 地址不能为空".to_string());
    }
    let parsed =
        url::Url::parse(trimmed).map_err(|error| format!("Jenkins 地址无法解析：{error}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Jenkins 地址必须是 http 或 https".to_string());
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err("Jenkins 地址不能带查询参数或锚点".to_string());
    }
    let base = parsed.as_str().trim_end_matches('/').to_string();
    if base.is_empty() || parsed.host_str().is_none() {
        return Err("Jenkins 地址缺少主机名".to_string());
    }
    Ok(base)
}

/// 把 `GET /me/api/json` 这类路径拼成完整 URL；拒绝绝对 URL，避免把凭据发到别处。
pub fn resolve_api_path(base: &str, path: &str) -> Result<String, String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("API 路径不能为空".to_string());
    }
    if path.starts_with("http://") || path.starts_with("https://") {
        return Err("API 路径必须是相对路径（如 /me/api/json），不接受绝对 URL".to_string());
    }
    Ok(format!("{}{}", base, normalize_path(path)))
}

fn normalize_path(path: &str) -> String {
    if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{path}")
    }
}

/// `Authorization` 头值：`Basic base64("{username}:{token}")`。
/// 单独拆成纯函数便于单测，生产路径与测试走同一实现。
pub fn authorization_header(username: &str, token: &str) -> String {
    use base64::Engine;
    let encoded = base64::engine::general_purpose::STANDARD.encode(format!("{username}:{token}"));
    format!("Basic {encoded}")
}

pub struct JenkinsClient {
    base: String,
    username: String,
    token: String,
    insecure: bool,
}

impl JenkinsClient {
    pub fn new(url: &str, username: &str, token: &str) -> Result<Self, String> {
        if token.trim().is_empty() {
            return Err("Jenkins token 不能为空".to_string());
        }
        if username.trim().is_empty() {
            return Err("Jenkins 用户名不能为空".to_string());
        }
        Ok(Self {
            base: normalize_base_url(url)?,
            username: username.trim().to_string(),
            token: token.trim().to_string(),
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
        method: &str,
        path: &str,
        body: Option<&serde_json::Value>,
    ) -> Result<(serde_json::Value, Option<String>), JenkinsError> {
        let url = resolve_api_path(&self.base, path).map_err(|message| JenkinsError {
            status: None,
            message,
        })?;
        let method = method
            .parse::<reqwest::Method>()
            .map_err(|_| JenkinsError {
                status: None,
                message: format!("不支持的 HTTP 方法：{method}"),
            })?;
        let client = self.build_client().map_err(|message| JenkinsError {
            status: None,
            message,
        })?;
        let mut request = client
            .request(method, &url)
            .header(
                "Authorization",
                authorization_header(&self.username, &self.token),
            )
            .header("Accept", "application/json");
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = request.send().await.map_err(|error| JenkinsError {
            status: None,
            message: format!("请求 {url} 失败：{error}（内网自签证书请加 --insecure）"),
        })?;
        let status = response.status().as_u16();
        // `X-Jenkins` 是版本号的唯一来源，必须在消费 body 之前取。
        let version = parse_version(
            response
                .headers()
                .get("x-jenkins")
                .and_then(|value| value.to_str().ok()),
        );
        let text = response.text().await.map_err(|error| JenkinsError {
            status: Some(status),
            message: format!("读取响应失败：{error}"),
        })?;
        let value: serde_json::Value = if text.trim().is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::from_str(&text).unwrap_or_else(|_| serde_json::Value::String(text.clone()))
        };
        if !(200..300).contains(&status) {
            return Err(JenkinsError {
                status: Some(status),
                message: describe_error(status, &value),
            });
        }
        Ok((value, version))
    }

    /// `/me/api/json` 是唯一能同时确认「用户名 + API Token」有效的端点。
    pub async fn identity(&self) -> Result<JenkinsIdentity, JenkinsError> {
        let (value, version) = self.send("GET", "/me/api/json", None).await?;
        Ok(JenkinsIdentity {
            username: parse_username(&value),
            version,
        })
    }

    /// 通用透传：给 Agent 用任意 Jenkins JSON 端点，不必为每个功能加命令。
    pub async fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<&serde_json::Value>,
    ) -> Result<serde_json::Value, JenkinsError> {
        let (value, _) = self.send(method, path, body).await?;
        Ok(value)
    }
}

/// Jenkins `/me/api/json` 的顶层字段：`fullName` 是显示名，`id` 是登录名。
/// 契约要求 username 优先取非空的 `fullName`，否则回退非空的 `id`。
pub fn parse_username(value: &serde_json::Value) -> Option<String> {
    let text = |key: &str| {
        value
            .get(key)
            .and_then(|item| item.as_str())
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(str::to_string)
    };
    text("fullName").or_else(|| text("id"))
}

/// 版本只来自 `X-Jenkins` 头；缺失或空白时返回 `None`，不要伪造版本。
pub fn parse_version(header: Option<&str>) -> Option<String> {
    header
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// 把 Jenkins 的错误转成可执行提示。Jenkins 的反向代理/登录页经常返回 HTML
/// 错误页，原始 HTML 一律不拼进 message；只有 JSON 体的 `message` / `error`
/// 可以拼在提示前。
fn describe_error(status: u16, value: &serde_json::Value) -> String {
    let detail = value
        .get("message")
        .or_else(|| value.get("error"))
        .map(|item| match item {
            serde_json::Value::String(text) => text.clone(),
            other => other.to_string(),
        })
        .unwrap_or_default();
    let hint = match status {
        401 => "用户名或 API Token 无效，请到 Jenkins 用户设置页确认 API Token",
        403 => "权限不足：该 Jenkins 用户可能缺少 Overall/Read 权限",
        404 => {
            "接口不存在：请确认填写的是 Jenkins 根地址（如 https://jenkins.example.com），不要带 /me 或 /api/json"
        }
        429 => "触发 Jenkins 限流，稍后重试",
        _ => "请检查用户名、token、实例地址与网络连通性",
    };
    if detail.trim().is_empty() {
        hint.to_string()
    } else {
        format!("{detail}（{hint}）")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_instance_urls() {
        assert_eq!(
            normalize_base_url("https://jenkins.example.com").unwrap(),
            "https://jenkins.example.com"
        );
        assert_eq!(
            normalize_base_url("  https://jenkins.example.com///  ").unwrap(),
            "https://jenkins.example.com"
        );
        // 子路径部署（Jenkins 上下文路径）必须保留。
        assert_eq!(
            normalize_base_url("https://host/ci/").unwrap(),
            "https://host/ci"
        );
        // 不自动剥 /api、/me、/api/json：Jenkins 没有统一 /api 前缀。
        assert_eq!(
            normalize_base_url("https://host/ci/me/api/json").unwrap(),
            "https://host/ci/me/api/json"
        );
        assert_eq!(
            normalize_base_url("https://host/api/json").unwrap(),
            "https://host/api/json"
        );
        assert_eq!(
            normalize_base_url("http://10.0.0.5:8080").unwrap(),
            "http://10.0.0.5:8080"
        );

        assert_eq!(normalize_base_url("").unwrap_err(), "Jenkins 地址不能为空");
        assert_eq!(
            normalize_base_url("   ").unwrap_err(),
            "Jenkins 地址不能为空"
        );
        assert_eq!(
            normalize_base_url("ftp://host").unwrap_err(),
            "Jenkins 地址必须是 http 或 https"
        );
        assert!(normalize_base_url("jenkins.example.com")
            .unwrap_err()
            .starts_with("Jenkins 地址无法解析："));
        assert_eq!(
            normalize_base_url("https://host/?a=1").unwrap_err(),
            "Jenkins 地址不能带查询参数或锚点"
        );
        assert_eq!(
            normalize_base_url("https://host/#top").unwrap_err(),
            "Jenkins 地址不能带查询参数或锚点"
        );
    }

    #[test]
    fn builds_api_paths_without_stripping_jenkins_prefixes() {
        assert_eq!(
            resolve_api_path("https://host", "/me/api/json").unwrap(),
            "https://host/me/api/json"
        );
        assert_eq!(
            resolve_api_path("https://host/ci", "me/api/json").unwrap(),
            "https://host/ci/me/api/json"
        );
        assert_eq!(
            resolve_api_path("https://host/ci", "/job/app/api/json").unwrap(),
            "https://host/ci/job/app/api/json"
        );
        assert!(resolve_api_path("https://host", "  ").is_err());
        assert!(resolve_api_path("https://host", "https://evil.example.com/x").is_err());
        assert!(resolve_api_path("https://host", "http://evil.example.com/x").is_err());
    }

    #[test]
    fn builds_basic_authorization_header() {
        use base64::Engine;
        let header = authorization_header("alice", "jenkins-test-fixture-token");
        assert!(header.starts_with("Basic "));
        let encoded = header.trim_start_matches("Basic ");
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap();
        assert_eq!(
            String::from_utf8(decoded).unwrap(),
            "alice:jenkins-test-fixture-token"
        );
        // Basic 认证里冒号是分隔符，用户名本身的冒号在保存前已被拒绝；
        // 这里确认编码不会丢弃或截断 token 中的特殊字符。
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(authorization_header("alice", "a:b/c?d").trim_start_matches("Basic "))
            .unwrap();
        assert_eq!(String::from_utf8(decoded).unwrap(), "alice:a:b/c?d");
    }

    #[test]
    fn constructs_client_with_normalized_inputs() {
        let client = JenkinsClient::new(
            "  https://jenkins.example.com/ci/  ",
            "  alice  ",
            "  jenkins-test-fixture-token  ",
        )
        .unwrap();
        assert_eq!(client.base(), "https://jenkins.example.com/ci");
        assert_eq!(client.username(), "alice");

        assert_eq!(
            JenkinsClient::new("https://host", "alice", "  ")
                .err()
                .unwrap(),
            "Jenkins token 不能为空"
        );
        assert_eq!(
            JenkinsClient::new("https://host", "  ", "token")
                .err()
                .unwrap(),
            "Jenkins 用户名不能为空"
        );
        // 地址错误优先于凭据校验之外的其它分支。
        assert_eq!(
            JenkinsClient::new("ftp://host", "alice", "token")
                .err()
                .unwrap(),
            "Jenkins 地址必须是 http 或 https"
        );
    }

    #[test]
    fn parses_identity_username_with_full_name_fallback() {
        assert_eq!(
            parse_username(&serde_json::json!({"id": "alice", "fullName": "Alice Wang"})),
            Some("Alice Wang".to_string())
        );
        // fullName 是空串/空白/非字符串时回退到 id。
        assert_eq!(
            parse_username(&serde_json::json!({"id": "alice", "fullName": "  "})),
            Some("alice".to_string())
        );
        assert_eq!(
            parse_username(&serde_json::json!({"id": "alice", "fullName": null})),
            Some("alice".to_string())
        );
        assert_eq!(
            parse_username(&serde_json::json!({"id": "alice", "fullName": 42})),
            Some("alice".to_string())
        );
        assert_eq!(
            parse_username(&serde_json::json!({"id": 42, "fullName": ""})),
            None
        );
        assert_eq!(parse_username(&serde_json::json!({})), None);
        assert_eq!(parse_username(&serde_json::Value::Null), None);
        assert_eq!(
            parse_username(&serde_json::Value::String("not-json".to_string())),
            None
        );
    }

    #[test]
    fn parses_x_jenkins_version_header() {
        assert_eq!(
            parse_version(Some(" 2.452.1 ")),
            Some("2.452.1".to_string())
        );
        assert_eq!(parse_version(Some("")), None);
        assert_eq!(parse_version(Some("   ")), None);
        assert_eq!(parse_version(None), None);
    }

    #[test]
    fn maps_status_codes_to_actionable_hints() {
        let unauthorized = describe_error(401, &serde_json::json!({}));
        assert!(unauthorized.contains("用户名或 API Token 无效"));
        assert!(unauthorized.contains("API Token"));

        let forbidden = describe_error(403, &serde_json::json!({}));
        assert!(forbidden.contains("Overall/Read"));

        let missing = describe_error(404, &serde_json::json!({}));
        assert!(missing.contains("根地址"));
        assert!(missing.contains("/me"));

        let limited = describe_error(429, &serde_json::json!({}));
        assert!(limited.contains("限流"));

        let other = describe_error(500, &serde_json::Value::Null);
        assert!(other.contains("网络"));

        // JSON 体的 message / error 拼在提示前，HTML 错误页整体丢弃。
        let with_message = describe_error(401, &serde_json::json!({"message": "Unauthorized"}));
        assert!(with_message.starts_with("Unauthorized（"));
        let with_error = describe_error(500, &serde_json::json!({"error": "boom"}));
        assert!(with_error.starts_with("boom（"));
        let html = describe_error(
            401,
            &serde_json::Value::String("<html><body>login required</body></html>".to_string()),
        );
        assert!(!html.contains("<html>"));
        assert!(!html.contains("login required"));
    }

    #[test]
    fn formats_error_display_with_and_without_status() {
        let with_status = JenkinsError {
            status: Some(401),
            message: "Unauthorized".to_string(),
        };
        assert_eq!(with_status.to_string(), "Jenkins API 401: Unauthorized");
        let without_status = JenkinsError {
            status: None,
            message: "Jenkins 地址不能为空".to_string(),
        };
        assert_eq!(
            without_status.to_string(),
            "Jenkins API: Jenkins 地址不能为空"
        );
    }
}
