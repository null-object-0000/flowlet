//! 通用 HTTP Bearer 凭据客户端（「一个地址 + 一把 Bearer token」的三方服务）。
//!
//! 为什么单独一个 provider：像 FileBrowser Quantum 这类自建面板没有统一 API，
//! 但认证模型和 GitLab / Dockhand 同构（`Authorization: Bearer <token>`），
//! 复用专用 provider 会逼着每种服务各写一套 provider。这里只保留最小契约：
//!
//! - 地址：http/https，保留子路径部署（`https://host/files`），丢弃 fragment；
//!   拒绝 query 与账号密码；
//! - 认证：`Authorization: Bearer <token>`；
//! - 校验：`GET {base}` 带 token，再不带 token 打一次做对照——
//!   * 401/403 → 确定失败（token 被拒）；
//!   * 2xx + 匿名为 401/403 → 认证确实生效；
//!   * 2xx + 匿名也是 2xx → **无法证明 token 有效**，探针如实标注，不谎报通过；
//! - 不跟随重定向，避免把 token 发到别处；10s 超时；insecure 时跳过 TLS 校验。

use serde::{Deserialize, Serialize};
use std::time::Duration;

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone)]
pub struct HttpBearerError {
    pub status: Option<u16>,
    pub message: String,
}

impl std::fmt::Display for HttpBearerError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.status {
            Some(status) => write!(formatter, "HTTP Bearer API {status}: {}", self.message),
            None => write!(formatter, "HTTP Bearer API: {}", self.message),
        }
    }
}

impl std::error::Error for HttpBearerError {}

/// 探针结果：地址可达性 + 认证是否真的起作用。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HttpBearerProbe {
    /// 带 token 请求的状态码。
    pub status: u16,
    /// 不带 token 时是否同样能访问（true = 无法从响应证明 token 有效）。
    pub anonymous_accessible: bool,
    /// 该路径没有端点（HTTP 404/405）。通用 provider 不知道服务的端点布局
    /// （例如 `https://api.cloudflare.com/client/v4` 的裸根就是 404），
    /// 这种情况只能算「地址可达但无法校验」，不代表 token 无效。
    pub endpoint_missing: bool,
}

impl HttpBearerProbe {
    /// 认证是否被证明有效：带 token 通、匿名不通。
    pub fn authenticated(&self) -> bool {
        !self.anonymous_accessible && !self.endpoint_missing
    }
}

/// 规范化实例地址：
/// - 必须是 http/https；
/// - 丢弃 fragment（前端路由不是服务端路径）；
/// - 拒绝 query 与账号密码；
/// - 去掉末尾所有 `/`；
/// - 保留子路径部署（`https://host/files`）。
pub fn normalize_base_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("地址不能为空".to_string());
    }
    let mut parsed = url::Url::parse(trimmed).map_err(|error| format!("地址无法解析：{error}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("地址必须以 http:// 或 https:// 开头".to_string());
    }
    if parsed.query().is_some() || !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("地址不能带查询参数或账号密码".to_string());
    }
    parsed.set_fragment(None);
    let base = parsed.as_str().trim_end_matches('/').to_string();
    if base.is_empty() || parsed.host_str().is_none() {
        return Err("地址缺少主机名".to_string());
    }
    Ok(base)
}

pub fn authorization_header(token: &str) -> String {
    format!("Bearer {token}")
}

#[derive(Debug)]
pub struct HttpBearerClient {
    base: String,
    token: String,
    insecure: bool,
}

impl HttpBearerClient {
    pub fn new(url: &str, token: &str) -> Result<Self, String> {
        if token.trim().is_empty() {
            return Err("Token 不能为空".to_string());
        }
        Ok(Self {
            base: normalize_base_url(url)?,
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

    fn build_client(&self) -> Result<reqwest::Client, String> {
        reqwest::Client::builder()
            .timeout(DEFAULT_TIMEOUT)
            .danger_accept_invalid_certs(self.insecure)
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(format!("flowlet/{}", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|error| format!("创建 HTTP 客户端失败：{error}"))
    }

    async fn probe_once(
        client: &reqwest::Client,
        url: &str,
        token: Option<&str>,
    ) -> Result<u16, HttpBearerError> {
        let mut request = client
            .get(url)
            .header("Accept", "application/json, */*;q=0.8");
        if let Some(token) = token {
            request = request.header("Authorization", authorization_header(token));
        }
        let response = request.send().await.map_err(|error| HttpBearerError {
            status: None,
            message: format!(
                "请求 {url} 失败：{error}（内网自签证书请配置可信 CA 或使用 --insecure）"
            ),
        })?;
        Ok(response.status().as_u16())
    }

    /// 打两次：带 token 一次、不带一次，用来判断认证是否真的起作用。
    ///
    /// 子路径部署（`https://host/files`）常见「无斜杠 → 301 到带斜杠」的重定向，
    /// 所以 3xx 时先在**同一地址**上补一个 `/` 重试（不跟随 Location，凭据不会
    /// 因此发到别处），成功就用那次的结果。
    pub async fn probe(&self) -> Result<HttpBearerProbe, HttpBearerError> {
        let client = self.build_client().map_err(|message| HttpBearerError {
            status: None,
            message,
        })?;
        let mut target = self.base.clone();
        let mut status = Self::probe_once(&client, &target, Some(&self.token)).await?;

        if (300..400).contains(&status) && !target.ends_with('/') {
            let with_slash = format!("{target}/");
            let retried = Self::probe_once(&client, &with_slash, Some(&self.token)).await?;
            if (200..300).contains(&retried) {
                target = with_slash;
                status = retried;
            }
        }

        if (300..400).contains(&status) {
            return Err(HttpBearerError {
                status: Some(status),
                message: format!(
                    "{target} 返回重定向（HTTP {status}）：请直接填写最终地址；凭据不会跟随重定向"
                ),
            });
        }
        if status == 401 || status == 403 {
            return Err(HttpBearerError {
                status: Some(status),
                message: format!("已拒绝这把 token（HTTP {status}），请确认 token 是否有效或已过期"),
            });
        }
        if status == 404 || status == 405 {
            // 通用 provider 猜不到服务的端点布局：裸根 404 很常见
            // （`https://api.cloudflare.com/client/v4` 就是），这不能说明 token 无效。
            return Ok(HttpBearerProbe {
                status,
                anonymous_accessible: false,
                endpoint_missing: true,
            });
        }
        if !(200..300).contains(&status) {
            return Err(HttpBearerError {
                status: Some(status),
                message: format!("{target} 返回 HTTP {status}：请检查实例地址与网络连通性"),
            });
        }

        // 对照请求：匿名能拿到同样的成功码，说明这个地址不需要认证，
        // 那就无法从响应证明 token 有效。失败（网络错误）按「匿名不可访问」处理。
        let anonymous_accessible = matches!(
            Self::probe_once(&client, &target, None).await,
            Ok(code) if (200..300).contains(&code)
        );

        Ok(HttpBearerProbe {
            status,
            anonymous_accessible,
            endpoint_missing: false,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_instance_urls() {
        assert_eq!(
            normalize_base_url("https://iad.tripwhims.com/files").unwrap(),
            "https://iad.tripwhims.com/files"
        );
        assert_eq!(
            normalize_base_url("  https://iad.tripwhims.com/files//  ").unwrap(),
            "https://iad.tripwhims.com/files"
        );
        // 前端路由 fragment 必须丢掉。
        assert_eq!(
            normalize_base_url("https://host/files/settings#api-main").unwrap(),
            "https://host/files/settings"
        );
        assert_eq!(
            normalize_base_url("http://10.0.0.5:8080").unwrap(),
            "http://10.0.0.5:8080"
        );

        assert_eq!(normalize_base_url("").unwrap_err(), "地址不能为空");
        assert_eq!(normalize_base_url("   ").unwrap_err(), "地址不能为空");
        assert_eq!(
            normalize_base_url("ftp://host").unwrap_err(),
            "地址必须以 http:// 或 https:// 开头"
        );
        assert_eq!(
            normalize_base_url("https://host/api?x=1").unwrap_err(),
            "地址不能带查询参数或账号密码"
        );
        assert_eq!(
            normalize_base_url("https://user:pass@host/api").unwrap_err(),
            "地址不能带查询参数或账号密码"
        );
    }

    #[test]
    fn builds_bearer_header() {
        assert_eq!(authorization_header("abc123"), "Bearer abc123");
    }

    #[test]
    fn distinguishes_proven_and_unproven_auth() {
        let proven = HttpBearerProbe {
            status: 200,
            anonymous_accessible: false,
            endpoint_missing: false,
        };
        assert!(proven.authenticated());
        let unproven = HttpBearerProbe {
            status: 200,
            anonymous_accessible: true,
            endpoint_missing: false,
        };
        assert!(!unproven.authenticated());
        // 裸根 404（如 api.cloudflare.com/client/v4）：地址可达但判断不了 token。
        let missing = HttpBearerProbe {
            status: 404,
            anonymous_accessible: false,
            endpoint_missing: true,
        };
        assert!(!missing.authenticated());
    }

    #[test]
    fn rejects_blank_token() {
        assert_eq!(
            HttpBearerClient::new("https://host/files", "  ").unwrap_err(),
            "Token 不能为空"
        );
    }
}