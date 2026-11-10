//! Dockhand 面板 API 客户端（面向公司内部 `fnsys/dockhand` 1.0.57 实测）。
//!
//! 选择面：
//! - 认证只用 `Authorization: Bearer <API Token>`（面板设置 → API 令牌）；
//! - `/api/health` 匿名可访问，不能用来校验 token；校验必须走 `/api/environments`；
//! - `/api/system`、`/api/stacks` 等资源接口都要求 `?env=<id>`；
//! - 面板可能部署在子路径（`http://host:3000/dockhand`），也接受用户直接粘贴 `/api`。
//!
//! HTTP 调用既服务桌面/Web Host 的保存校验，也服务 CLI 的透传子命令；本模块只负责
//! URL/请求构造与响应解析，便于单测。

use serde::{Deserialize, Serialize};
use std::time::Duration;

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(20);

/// 单个环境的最小投影，避免把面板返回的大对象原样塞进 Agent 上下文。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DockhandEnvironment {
    pub id: i64,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default)]
    pub port: Option<i64>,
    #[serde(default)]
    pub protocol: Option<String>,
}

#[derive(Debug, Clone)]
pub struct DockhandError {
    pub status: Option<u16>,
    pub message: String,
}

impl std::fmt::Display for DockhandError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.status {
            Some(status) => write!(formatter, "Dockhand API {status}: {}", self.message),
            None => write!(formatter, "Dockhand API: {}", self.message),
        }
    }
}

impl std::error::Error for DockhandError {}

/// 规范化面板地址：
/// - 必须是 http/https；
/// - 去掉末尾所有 `/`；
/// - 用户粘贴到 `/api` 时自动剥掉（例如 `http://host:3000/api`）；
/// - 保留子路径部署（`http://host:3000/dockhand`）；
/// - 拒绝 query / fragment。
pub fn normalize_base_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Dockhand 地址不能为空".to_string());
    }
    let parsed =
        url::Url::parse(trimmed).map_err(|error| format!("Dockhand 地址无法解析：{error}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Dockhand 地址必须是 http 或 https".to_string());
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err("Dockhand 地址不能带查询参数或锚点".to_string());
    }
    let mut base = parsed.as_str().trim_end_matches('/').to_string();
    if let Some(stripped) = base.strip_suffix("/api") {
        base = stripped.trim_end_matches('/').to_string();
    }
    if base.is_empty() || base == "http:" || base == "https:" || parsed.host_str().is_none() {
        return Err("Dockhand 地址缺少主机名".to_string());
    }
    Ok(base)
}

pub fn api_base(base: &str) -> String {
    format!("{base}/api")
}

/// 把 `GET /environments` 这类路径拼成完整 URL；拒绝绝对 URL，避免把 token 发到别处。
pub fn resolve_api_path(base: &str, path: &str) -> Result<String, String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("API 路径不能为空".to_string());
    }
    if path.starts_with("http://") || path.starts_with("https://") {
        return Err("API 路径必须是相对路径（如 /environments），不接受绝对 URL".to_string());
    }
    // 允许 `dockhand api /api/environments` 与 `dockhand api /environments` 两种写法。
    let path = path.strip_prefix("/api").unwrap_or(path);
    Ok(format!("{}{}", api_base(base), normalize_path(path)))
}

fn normalize_path(path: &str) -> String {
    if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{path}")
    }
}

pub struct DockhandClient {
    base: String,
    token: String,
    insecure: bool,
}

impl DockhandClient {
    pub fn new(url: &str, token: &str) -> Result<Self, String> {
        if token.trim().is_empty() {
            return Err("Dockhand token 不能为空".to_string());
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

    pub fn api_base(&self) -> String {
        api_base(&self.base)
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
    ) -> Result<(u16, serde_json::Value), DockhandError> {
        let url = resolve_api_path(&self.base, path).map_err(|message| DockhandError {
            status: None,
            message,
        })?;
        let method = method
            .parse::<reqwest::Method>()
            .map_err(|_| DockhandError {
                status: None,
                message: format!("不支持的 HTTP 方法：{method}"),
            })?;
        let client = self.build_client().map_err(|message| DockhandError {
            status: None,
            message,
        })?;
        let mut request = client
            .request(method, &url)
            .header("Authorization", format!("Bearer {}", self.token))
            .header("Accept", "application/json");
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = request.send().await.map_err(|error| DockhandError {
            status: None,
            message: format!("请求 {url} 失败：{error}（内网自签证书请加 --insecure）"),
        })?;
        let status = response.status().as_u16();
        let text = response.text().await.map_err(|error| DockhandError {
            status: Some(status),
            message: format!("读取响应失败：{error}"),
        })?;
        let value: serde_json::Value = if text.trim().is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::from_str(&text).unwrap_or_else(|_| serde_json::Value::String(text.clone()))
        };
        if !(200..300).contains(&status) {
            return Err(DockhandError {
                status: Some(status),
                message: describe_error(status, &value),
            });
        }
        Ok((status, value))
    }

    /// `/environments` 是唯一能确认 token 有效的稳定端点（`/health` 匿名可访问）。
    pub async fn environments(&self) -> Result<Vec<DockhandEnvironment>, DockhandError> {
        let (_, value) = self.send("GET", "/environments", None).await?;
        parse_environments(&value)
    }

    pub async fn health(&self) -> Result<serde_json::Value, DockhandError> {
        let (_, value) = self.send("GET", "/health", None).await?;
        Ok(value)
    }

    /// Docker 版本、宿主信息、运行时与数据库状态。
    pub async fn system(&self, env_id: i64) -> Result<serde_json::Value, DockhandError> {
        let (_, value) = self
            .send("GET", &format!("/system?env={env_id}"), None)
            .await?;
        Ok(value)
    }

    pub async fn stacks(&self, env_id: i64) -> Result<serde_json::Value, DockhandError> {
        let (_, value) = self
            .send("GET", &format!("/stacks?env={env_id}"), None)
            .await?;
        Ok(value)
    }

    /// 通用透传：给 Agent 用任意面板端点，不必为每个功能加命令。
    pub async fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<&serde_json::Value>,
    ) -> Result<serde_json::Value, DockhandError> {
        let (_, value) = self.send(method, path, body).await?;
        Ok(value)
    }
}

/// 面板历史版本对字段的补齐并不稳定：缺失或非数字的 `id` 无法参与后续
/// `?env=` 请求，直接跳过该行比合成 `id = 0` 更安全。
pub fn parse_environments(
    value: &serde_json::Value,
) -> Result<Vec<DockhandEnvironment>, DockhandError> {
    let items = value.as_array().ok_or_else(|| DockhandError {
        status: None,
        message: "解析环境列表失败：expected a sequence".to_string(),
    })?;
    let mut environments = Vec::new();
    for item in items {
        let Some(id) = item.get("id").and_then(|value| value.as_i64()) else {
            continue;
        };
        environments.push(DockhandEnvironment {
            id,
            name: item
                .get("name")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .to_string(),
            host: item
                .get("host")
                .and_then(|value| value.as_str())
                .map(str::to_string),
            port: item.get("port").and_then(|value| value.as_i64()),
            protocol: item
                .get("protocol")
                .and_then(|value| value.as_str())
                .map(str::to_string),
        });
    }
    Ok(environments)
}

/// 把面板的错误体转成可执行的提示。面板通常返回 `{"message": "..."}`，
/// 401 还可能返回 `{"error": "..."}` 或纯文本。
fn describe_error(status: u16, value: &serde_json::Value) -> String {
    let detail = value
        .get("message")
        .or_else(|| value.get("error"))
        .map(|item| match item {
            serde_json::Value::String(text) => text.clone(),
            other => other.to_string(),
        })
        .or_else(|| {
            value
                .as_str()
                .map(str::to_string)
                .filter(|text| !text.trim().is_empty())
        })
        .unwrap_or_default();
    let hint = match status {
        401 => "token 无效或已过期，请到 Dockhand 生成新的 API Token",
        403 => "权限不足：该 API Token 可能缺少管理员权限，或账号未启用",
        404 => "接口不存在：请确认填写的是 Dockhand 面板根地址（如 http://host:3000）",
        429 => "触发 Dockhand 限流，稍后重试",
        _ => "请检查 token、实例地址与网络连通性",
    };
    if detail.is_empty() {
        hint.to_string()
    } else {
        format!("{detail}（{hint}）")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_panel_urls() {
        assert_eq!(
            normalize_base_url("http://dockhand.example.com:3000").unwrap(),
            "http://dockhand.example.com:3000"
        );
        assert_eq!(
            normalize_base_url("http://dockhand.example.com:3000///").unwrap(),
            "http://dockhand.example.com:3000"
        );
        assert_eq!(
            normalize_base_url("http://host:3000/api").unwrap(),
            "http://host:3000"
        );
        assert_eq!(
            normalize_base_url("http://host:3000/dockhand/").unwrap(),
            "http://host:3000/dockhand"
        );
        assert_eq!(
            normalize_base_url("  https://host/dockhand/api/  ").unwrap(),
            "https://host/dockhand"
        );
        assert!(normalize_base_url("").is_err());
        assert!(normalize_base_url("ftp://host:3000").is_err());
        assert!(normalize_base_url("host:3000").is_err());
        assert!(normalize_base_url("http://host:3000/?a=1").is_err());
        assert!(normalize_base_url("http://host:3000/#env").is_err());
    }

    #[test]
    fn builds_api_base_and_paths() {
        assert_eq!(api_base("http://host:3000"), "http://host:3000/api");
        assert_eq!(
            resolve_api_path("http://host:3000", "/environments").unwrap(),
            "http://host:3000/api/environments"
        );
        assert_eq!(
            resolve_api_path("http://host:3000", "environments").unwrap(),
            "http://host:3000/api/environments"
        );
        assert_eq!(
            resolve_api_path("http://host:3000", "/api/environments").unwrap(),
            "http://host:3000/api/environments"
        );
        assert_eq!(
            resolve_api_path("http://host:3000/dockhand", "/api/stacks?env=2").unwrap(),
            "http://host:3000/dockhand/api/stacks?env=2"
        );
        assert_eq!(
            resolve_api_path("http://host:3000", "/stacks?env=2").unwrap(),
            "http://host:3000/api/stacks?env=2"
        );
        assert!(resolve_api_path("http://host:3000", "  ").is_err());
        assert!(resolve_api_path("http://host:3000", "https://evil.example.com/x").is_err());
        assert!(resolve_api_path("http://host:3000", "http://evil.example.com/x").is_err());
    }

    #[test]
    fn parses_environment_list_tolerantly() {
        let json = serde_json::json!([
            {
                "id": 2,
                "name": "[CentOS] 10.100.217.60",
                "host": "10.100.217.60",
                "port": 2375,
                "protocol": "http"
            },
            { "id": 3, "name": "minimal" },
            { "name": "id missing, skipped" },
            { "id": "not-a-number", "name": "bad id, skipped" },
            "not-an-object"
        ]);
        let environments = parse_environments(&json).unwrap();
        assert_eq!(environments.len(), 2);
        assert_eq!(environments[0].id, 2);
        assert_eq!(environments[0].host.as_deref(), Some("10.100.217.60"));
        assert_eq!(environments[0].port, Some(2375));
        assert_eq!(environments[0].protocol.as_deref(), Some("http"));
        assert_eq!(environments[1].name, "minimal");
        assert_eq!(environments[1].host, None);

        // 数组元素里缺少 name 时补空串，而不是整份列表失败。
        let missing_name = serde_json::json!([{ "id": 7 }]);
        let environments = parse_environments(&missing_name).unwrap();
        assert_eq!(environments[0].name, "");
    }

    #[test]
    fn rejects_non_sequence_environment_payload() {
        let error = parse_environments(&serde_json::json!({"environments": []})).unwrap_err();
        assert!(error.to_string().contains("expected a sequence"));
    }

    #[test]
    fn maps_status_codes_to_actionable_hints() {
        let unauthorized = describe_error(
            401,
            &serde_json::json!({"message": "Unauthorized: invalid or expired API token"}),
        );
        assert!(unauthorized.contains("invalid or expired API token"));
        assert!(unauthorized.contains("Dockhand 生成新的 API Token"));

        let forbidden = describe_error(403, &serde_json::json!({}));
        assert!(forbidden.contains("管理员"));

        let missing = describe_error(404, &serde_json::json!({"error": "Not Found"}));
        assert!(missing.contains("面板根地址"));

        let limited = describe_error(429, &serde_json::json!("too many requests"));
        assert!(limited.contains("限流"));

        let other = describe_error(500, &serde_json::Value::Null);
        assert!(other.contains("网络"));
    }

    #[test]
    fn formats_error_display_with_and_without_status() {
        let with_status = DockhandError {
            status: Some(401),
            message: "Unauthorized".to_string(),
        };
        assert_eq!(with_status.to_string(), "Dockhand API 401: Unauthorized");
        let without_status = DockhandError {
            status: None,
            message: "Dockhand 地址不能为空".to_string(),
        };
        assert_eq!(
            without_status.to_string(),
            "Dockhand API: Dockhand 地址不能为空"
        );
    }

    #[test]
    fn rejects_blank_token() {
        assert!(DockhandClient::new("http://host:3000", "  ").is_err());
        assert!(DockhandClient::new("http://host:3000", "dockhand-test-fixture-token").is_ok());
    }
}
