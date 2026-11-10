//! Beszel Hub API 客户端（PocketBase 底座，默认端口 8090）。
//!
//! 选择面：
//! - Beszel **没有长期 API Token**：只能用「邮箱 + 密码」调
//!   `POST /api/collections/users/auth-with-password` 换短期 token（PocketBase 默认 14 天），
//!   因此凭据存邮箱（明文）+ 密码（密文），每次校验/调用现场换 token；
//! - 后续请求用 PocketBase 原生 `Authorization: <token>`，**不是** `Bearer <token>`；
//! - Hub 版本取 `GET /api/beszel/info` 的 `v`（需认证）；该请求失败不致命，版本留空；
//! - 系统列表取 `/api/collections/systems/records`，只投影 `id/name/host/status/port`；
//! - 用户可能粘贴 PocketBase 管理面板地址（`http://host:8090/_/`）或 `.../api`，
//!   地址归一时反复剥掉末尾的 `/`、`/api`、`/_`、`/_/`，其它子路径部署保留。
//!
//! HTTP 调用既服务桌面/Web Host 的保存校验，也服务 CLI 的透传子命令；本模块只负责
//! URL/请求构造与响应解析，便于单测。

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::Duration;

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(20);

/// PocketBase 认证记录投影：只保留界面需要的身份字段。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BeszelAuth {
    pub token: String,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub role: Option<String>,
}

/// 系统列表的最小投影，避免把 PocketBase 记录的 `collectionId`/`collectionName`/`users`
/// 等大对象塞进 Agent 上下文。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BeszelSystem {
    pub id: String,
    pub name: String,
    pub host: String,
    pub status: String,
    pub port: String,
}

/// `GET /api/collections/systems/records` 的分页投影：`totalItems` 用于校验摘要
/// （「N 台系统」），`items` 用于 CLI `beszel systems`。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BeszelSystems {
    pub total_items: u64,
    pub items: Vec<BeszelSystem>,
}

#[derive(Debug, Clone)]
pub struct BeszelError {
    pub status: Option<u16>,
    pub message: String,
}

impl std::fmt::Display for BeszelError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.status {
            Some(status) => write!(formatter, "Beszel API {status}: {}", self.message),
            None => write!(formatter, "Beszel API: {}", self.message),
        }
    }
}

impl std::error::Error for BeszelError {}

/// 规范化 Hub 地址：
/// - 必须是 http/https；
/// - 去掉末尾所有 `/`；
/// - 反复剥掉末尾的 `/api`、`/_`、`/_/`（用户可能粘贴 `http://host:8090/api` 或
///   PocketBase 管理面板 `http://host:8090/_/`），保留其它子路径部署；
/// - 拒绝 query / fragment；
/// - 返回不带末尾斜杠的根地址。
pub fn normalize_base_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Beszel 地址不能为空".to_string());
    }
    let parsed =
        url::Url::parse(trimmed).map_err(|error| format!("Beszel 地址无法解析：{error}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Beszel 地址必须是 http 或 https".to_string());
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err("Beszel 地址不能带查询参数或锚点".to_string());
    }
    let mut base = parsed.as_str().to_string();
    // 反复剥后缀，直到不再变化：`/api/_/` → `/api` → ``、`/` → ``。
    loop {
        let mut stripped = false;
        for suffix in ["/_/", "/api", "/_", "/"] {
            if let Some(rest) = base.strip_suffix(suffix) {
                base = rest.to_string();
                stripped = true;
                break;
            }
        }
        if !stripped {
            break;
        }
    }
    if base.is_empty() || base == "http:" || base == "https:" || parsed.host_str().is_none() {
        return Err("Beszel 地址缺少主机名".to_string());
    }
    Ok(base)
}

pub fn api_base(base: &str) -> String {
    format!("{base}/api")
}

/// 把 `GET /collections/systems/records` 这类路径拼成完整 URL；拒绝绝对 URL，
/// 避免把凭据发到别处。允许用户带 `/api` 前缀（`/api/collections/...`）或直接写
/// 相对路径（`collections/...`）；query 原样保留。
pub fn resolve_api_path(base: &str, path: &str) -> Result<String, String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("API 路径不能为空".to_string());
    }
    if path.starts_with("http://") || path.starts_with("https://") {
        return Err(
            "API 路径必须是相对路径（如 /collections/systems/records），不接受绝对 URL".to_string(),
        );
    }
    // `flowlet beszel api /api/collections/...` 与 `.../collections/...` 都接受。
    let path = match path.strip_prefix("/api") {
        // 只有整段 `/api` 才是前缀；`/apix`、`/apiary` 属于普通路径。
        Some(rest) if rest.is_empty() || rest.starts_with('/') => rest,
        _ => path,
    };
    let path = path.trim_start_matches('/');
    if path.is_empty() {
        return Ok(api_base(base));
    }
    Ok(format!("{}/{}", api_base(base), path))
}

/// 认证请求体（PocketBase `auth-with-password`）。
fn auth_body(email: &str, password: &str) -> serde_json::Value {
    serde_json::json!({ "identity": email, "password": password })
}

pub struct BeszelClient {
    base: String,
    email: String,
    password: String,
    insecure: bool,
    /// 短期 token 缓存：一次命令只认证一次。`auth()` 与后续请求共享同一份缓存。
    token: Mutex<Option<String>>,
}

impl BeszelClient {
    pub fn new(url: &str, email: &str, password: &str) -> Result<Self, String> {
        if email.trim().is_empty() {
            return Err("Beszel 邮箱不能为空".to_string());
        }
        if password.trim().is_empty() {
            return Err("Beszel 密码不能为空".to_string());
        }
        Ok(Self {
            base: normalize_base_url(url)?,
            email: email.trim().to_string(),
            password: password.trim().to_string(),
            insecure: false,
            token: Mutex::new(None),
        })
    }

    pub fn with_insecure(mut self, insecure: bool) -> Self {
        self.insecure = insecure;
        self
    }

    pub fn base(&self) -> &str {
        &self.base
    }

    pub fn email(&self) -> &str {
        &self.email
    }

    fn build_client(&self) -> Result<reqwest::Client, String> {
        reqwest::Client::builder()
            .timeout(DEFAULT_TIMEOUT)
            .danger_accept_invalid_certs(self.insecure)
            .user_agent(format!("flowlet/{}", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|error| format!("创建 HTTP 客户端失败：{error}"))
    }

    fn cached_token(&self) -> Option<String> {
        self.token.lock().ok().and_then(|guard| guard.clone())
    }

    fn store_token(&self, token: &str) {
        if let Ok(mut guard) = self.token.lock() {
            *guard = Some(token.to_string());
        }
    }

    /// 底层发送（不带 token 解析，避免 `auth` ↔ `send` 的异步递归）。
    /// `token` 为 `Some` 时带 PocketBase 原生 `Authorization: <token>`；
    /// 认证请求本身为 `None`。`is_auth` 只影响 400 的错误提示分支。
    async fn send_raw(
        &self,
        method: &str,
        path: &str,
        body: Option<&serde_json::Value>,
        token: Option<&str>,
        is_auth: bool,
    ) -> Result<serde_json::Value, BeszelError> {
        let url = resolve_api_path(&self.base, path).map_err(|message| BeszelError {
            status: None,
            message,
        })?;
        let method = method
            .parse::<reqwest::Method>()
            .map_err(|_| BeszelError {
                status: None,
                message: format!("不支持的 HTTP 方法：{method}"),
            })?;
        let client = self.build_client().map_err(|message| BeszelError {
            status: None,
            message,
        })?;
        let mut request = client
            .request(method, &url)
            .header("Accept", "application/json");
        if let Some(token) = token {
            request = request.header("Authorization", token);
        }
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = request.send().await.map_err(|error| BeszelError {
            status: None,
            message: format!("请求 {url} 失败：{error}（内网自签证书请加 --insecure）"),
        })?;
        let status = response.status().as_u16();
        let text = response.text().await.map_err(|error| BeszelError {
            status: Some(status),
            message: format!("读取响应失败：{error}"),
        })?;
        let value: serde_json::Value = if text.trim().is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::from_str(&text).unwrap_or_else(|_| serde_json::Value::String(text.clone()))
        };
        if !(200..300).contains(&status) {
            return Err(BeszelError {
                status: Some(status),
                message: describe_error(status, &value, is_auth),
            });
        }
        Ok(value)
    }

    /// 需要认证的请求：先取（或现场换）token，再带原生 Authorization 头发送。
    async fn send(
        &self,
        method: &str,
        path: &str,
        body: Option<&serde_json::Value>,
    ) -> Result<serde_json::Value, BeszelError> {
        let token = self.ensure_token().await?;
        self.send_raw(method, path, body, Some(&token), false)
            .await
    }

    /// 邮箱 + 密码换短期 token；结果缓存在实例内。
    pub async fn auth(&self) -> Result<BeszelAuth, BeszelError> {
        let body = auth_body(&self.email, &self.password);
        let value = self
            .send_raw(
                "POST",
                "/collections/users/auth-with-password",
                Some(&body),
                None,
                true,
            )
            .await?;
        let auth = parse_auth(&value)?;
        self.store_token(&auth.token);
        Ok(auth)
    }

    async fn ensure_token(&self) -> Result<String, BeszelError> {
        if let Some(token) = self.cached_token() {
            return Ok(token);
        }
        let auth = self.auth().await?;
        Ok(auth.token)
    }

    /// `GET /api/beszel/info`：返回原始 JSON（CLI `status` 需要 `v`，其它字段留给透传）。
    pub async fn info(&self) -> Result<serde_json::Value, BeszelError> {
        self.send("GET", "/beszel/info", None).await
    }

    /// 系统列表（`perPage=200`）。
    pub async fn systems(&self) -> Result<BeszelSystems, BeszelError> {
        let value = self.send("GET", &systems_path(200), None).await?;
        parse_systems(&value)
    }

    /// 只取系统总数（`perPage=1`），用于保存校验的摘要，避免拉全量记录。
    pub async fn systems_count(&self) -> Result<u64, BeszelError> {
        let value = self.send("GET", &systems_path(1), None).await?;
        Ok(parse_systems(&value)?.total_items)
    }

    /// 通用透传：给 Agent 用任意 Beszel/PocketBase 端点，不必为每个功能加命令。
    pub async fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<&serde_json::Value>,
    ) -> Result<serde_json::Value, BeszelError> {
        self.send(method, path, body).await
    }
}

fn systems_path(per_page: u64) -> String {
    format!(
        "/collections/systems/records?page=1&perPage={per_page}&sort=name&fields=id,name,host,status,port,updated"
    )
}

/// `info` 里的版本号：`v` 缺失/空白/非字符串时为 `None`，不要伪造版本。
pub fn parse_info_version(value: &serde_json::Value) -> Option<String> {
    value
        .get("v")
        .and_then(|item| item.as_str())
        .map(str::trim)
        .filter(|version| !version.is_empty())
        .map(str::to_string)
}

/// PocketBase `auth-with-password` 响应：`{ token, record: { email, name, role } }`。
pub fn parse_auth(value: &serde_json::Value) -> Result<BeszelAuth, BeszelError> {
    let token = value
        .get("token")
        .and_then(|item| item.as_str())
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .ok_or_else(|| BeszelError {
            status: None,
            message: "解析登录响应失败：缺少 token".to_string(),
        })?;
    let record = value.get("record").filter(|item| item.is_object());
    let text = |key: &str| {
        record
            .and_then(|record| record.get(key))
            .and_then(|item| item.as_str())
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(str::to_string)
    };
    Ok(BeszelAuth {
        token: token.to_string(),
        email: text("email"),
        name: text("name"),
        role: text("role"),
    })
}

/// 记录字段可能是字符串或数字（Beszel 的 `port` 在不同版本里类型不一致）；
/// 缺失或其它类型一律投影成空串，保证列表不会被单条异常记录打断。
fn text_field(value: &serde_json::Value, key: &str) -> String {
    match value.get(key) {
        Some(serde_json::Value::String(text)) => text.clone(),
        Some(serde_json::Value::Number(number)) => number.to_string(),
        _ => String::new(),
    }
}

pub fn parse_systems(value: &serde_json::Value) -> Result<BeszelSystems, BeszelError> {
    let total_items = value
        .get("totalItems")
        .and_then(|item| item.as_u64())
        .unwrap_or(0);
    let items = match value.get("items") {
        None => Vec::new(),
        Some(serde_json::Value::Array(items)) => items
            .iter()
            .map(|item| BeszelSystem {
                id: text_field(item, "id"),
                name: text_field(item, "name"),
                host: text_field(item, "host"),
                status: text_field(item, "status"),
                port: text_field(item, "port"),
            })
            .collect(),
        Some(_) => {
            return Err(BeszelError {
                status: None,
                message: "解析系统列表失败：expected a sequence".to_string(),
            })
        }
    };
    Ok(BeszelSystems { total_items, items })
}

/// 把 Beszel/PocketBase 的错误转成可执行提示。`is_auth` 把 400 的提示换成
/// 「邮箱或密码错误」，因为只有认证端点会用 400 表示凭据错误。
fn describe_error(status: u16, value: &serde_json::Value, is_auth: bool) -> String {
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
    let hint = match (status, is_auth) {
        (400, true) => "邮箱或密码错误，请确认是 Beszel 用户账号（不是 PocketBase 超级管理员）",
        (401, _) => "token 无效或已过期，请重新用邮箱+密码登录",
        (403, _) => "密码登录可能被禁用（DISABLE_PASSWORD_AUTH），或账号没有读取权限",
        (404, _) => "接口不存在：请确认填写的是 Beszel Hub 根地址（默认端口 8090）",
        (429, _) => "触发 Beszel 限流，稍后重试",
        _ => "请检查邮箱、密码、实例地址与网络连通性",
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
    fn normalizes_hub_urls() {
        assert_eq!(
            normalize_base_url("http://beszel.example.com:8090").unwrap(),
            "http://beszel.example.com:8090"
        );
        assert_eq!(
            normalize_base_url("  http://10.1.1.1:8090///  ").unwrap(),
            "http://10.1.1.1:8090"
        );
        // 用户粘贴 `/api` 或 PocketBase 管理面板 `/_/` 都要剥掉。
        assert_eq!(
            normalize_base_url("http://host:8090/api").unwrap(),
            "http://host:8090"
        );
        assert_eq!(
            normalize_base_url("http://host:8090/api/").unwrap(),
            "http://host:8090"
        );
        assert_eq!(
            normalize_base_url("http://host:8090/_/").unwrap(),
            "http://host:8090"
        );
        assert_eq!(
            normalize_base_url("http://host:8090/_").unwrap(),
            "http://host:8090"
        );
        assert_eq!(
            normalize_base_url("http://host:8090/api/_/").unwrap(),
            "http://host:8090"
        );
        // 其它子路径部署必须保留（反复剥也不动 /beszel 这类路径）。
        assert_eq!(
            normalize_base_url("https://host/beszel/").unwrap(),
            "https://host/beszel"
        );
        assert_eq!(
            normalize_base_url("https://host/beszel/_/").unwrap(),
            "https://host/beszel"
        );

        assert_eq!(normalize_base_url("").unwrap_err(), "Beszel 地址不能为空");
        assert_eq!(
            normalize_base_url("   ").unwrap_err(),
            "Beszel 地址不能为空"
        );
        assert_eq!(
            normalize_base_url("ftp://host").unwrap_err(),
            "Beszel 地址必须是 http 或 https"
        );
        assert!(normalize_base_url("beszel.example.com")
            .unwrap_err()
            .starts_with("Beszel 地址无法解析："));
        assert_eq!(
            normalize_base_url("http://host:8090/?a=1").unwrap_err(),
            "Beszel 地址不能带查询参数或锚点"
        );
        assert_eq!(
            normalize_base_url("http://host:8090/#/login").unwrap_err(),
            "Beszel 地址不能带查询参数或锚点"
        );
        // 只剩 scheme / 无主机名：URL 解析直接失败。
        assert!(normalize_base_url("http://").is_err());
        assert!(normalize_base_url("http:///api").is_err());
    }

    #[test]
    fn builds_api_paths_with_query_preserved() {
        assert_eq!(api_base("http://host:8090"), "http://host:8090/api");
        assert_eq!(
            resolve_api_path("http://host:8090", "/collections/systems/records").unwrap(),
            "http://host:8090/api/collections/systems/records"
        );
        // 带 /api 前缀、不带前导斜杠都要接受。
        assert_eq!(
            resolve_api_path("http://host:8090", "/api/collections/systems/records").unwrap(),
            "http://host:8090/api/collections/systems/records"
        );
        assert_eq!(
            resolve_api_path("http://host:8090", "collections/systems/records").unwrap(),
            "http://host:8090/api/collections/systems/records"
        );
        // query 必须保留（perPage 等）。
        assert_eq!(
            resolve_api_path(
                "http://host:8090",
                "/collections/systems/records?page=1&perPage=1"
            )
            .unwrap(),
            "http://host:8090/api/collections/systems/records?page=1&perPage=1"
        );
        // `/apix`、`/apiary` 不是 `/api` 前缀，不能被误剥。
        assert_eq!(
            resolve_api_path("http://host:8090", "/apix/records").unwrap(),
            "http://host:8090/api/apix/records"
        );
        assert_eq!(
            resolve_api_path("http://host:8090", "/api").unwrap(),
            "http://host:8090/api"
        );

        assert_eq!(resolve_api_path("http://host", "  ").unwrap_err(), "API 路径不能为空");
        assert_eq!(
            resolve_api_path("http://host", "https://evil.example.com/x").unwrap_err(),
            "API 路径必须是相对路径（如 /collections/systems/records），不接受绝对 URL"
        );
        assert!(resolve_api_path("http://host", "http://evil.example.com/x").is_err());
    }

    #[test]
    fn constructs_client_with_normalized_inputs() {
        let client = BeszelClient::new(
            "  http://host:8090/api/  ",
            "  you@example.com  ",
            "  beszel-test-fixture-password  ",
        )
        .unwrap();
        assert_eq!(client.base(), "http://host:8090");
        assert_eq!(client.email(), "you@example.com");

        assert_eq!(
            BeszelClient::new("http://host:8090", "  ", "password")
                .err()
                .unwrap(),
            "Beszel 邮箱不能为空"
        );
        assert_eq!(
            BeszelClient::new("http://host:8090", "you@example.com", "   ")
                .err()
                .unwrap(),
            "Beszel 密码不能为空"
        );
        // 地址错误优先（与其它 provider 的构造顺序一致）。
        assert_eq!(
            BeszelClient::new("ftp://host", "you@example.com", "password")
                .err()
                .unwrap(),
            "Beszel 地址必须是 http 或 https"
        );
    }

    #[test]
    fn parses_auth_response() {
        let auth = parse_auth(&serde_json::json!({
            "token": " pb-token ",
            "record": {
                "id": "u1",
                "email": "you@example.com",
                "name": "监控",
                "role": "admin"
            }
        }))
        .unwrap();
        assert_eq!(
            auth,
            BeszelAuth {
                token: "pb-token".to_string(),
                email: Some("you@example.com".to_string()),
                name: Some("监控".to_string()),
                role: Some("admin".to_string()),
            }
        );

        // record 缺失/非对象时 token 仍然可用，身份字段留空。
        let minimal = parse_auth(&serde_json::json!({ "token": "pb-token" })).unwrap();
        assert_eq!(minimal.token, "pb-token");
        assert_eq!(minimal.email, None);
        assert_eq!(minimal.name, None);
        assert_eq!(minimal.role, None);

        // 空白 token 视为缺失。
        for invalid in [
            serde_json::json!({}),
            serde_json::json!({ "token": "" }),
            serde_json::json!({ "token": "   " }),
            serde_json::json!({ "token": 42 }),
            serde_json::Value::Null,
        ] {
            assert_eq!(
                parse_auth(&invalid).unwrap_err().message,
                "解析登录响应失败：缺少 token"
            );
        }
    }

    #[test]
    fn parses_info_version() {
        assert_eq!(
            parse_info_version(&serde_json::json!({ "v": "0.21.1" })),
            Some("0.21.1".to_string())
        );
        assert_eq!(
            parse_info_version(&serde_json::json!({ "v": " 0.21.1 " })),
            Some("0.21.1".to_string())
        );
        assert_eq!(parse_info_version(&serde_json::json!({ "v": "" })), None);
        assert_eq!(parse_info_version(&serde_json::json!({ "v": 2 })), None);
        assert_eq!(parse_info_version(&serde_json::json!({})), None);
        assert_eq!(parse_info_version(&serde_json::Value::Null), None);
    }

    #[test]
    fn parses_system_projection() {
        let systems = parse_systems(&serde_json::json!({
            "page": 1,
            "perPage": 200,
            "totalItems": 2,
            "totalPages": 1,
            "items": [
                {
                    "id": "s1",
                    "name": "web-1",
                    "host": "10.1.1.1",
                    "status": "up",
                    "port": "45876",
                    "updated": "2026-11-01 10:00:00.000Z"
                },
                {
                    "id": "s2",
                    "name": "db-1",
                    "host": "10.1.1.2",
                    "status": "paused",
                    "port": 22
                }
            ]
        }))
        .unwrap();
        assert_eq!(systems.total_items, 2);
        assert_eq!(
            systems.items[0],
            BeszelSystem {
                id: "s1".to_string(),
                name: "web-1".to_string(),
                host: "10.1.1.1".to_string(),
                status: "up".to_string(),
                port: "45876".to_string(),
            }
        );
        // 数字型 port 容忍；缺失字段投影成空串。
        assert_eq!(systems.items[1].port, "22");

        let partial = parse_systems(&serde_json::json!({
            "totalItems": 1,
            "items": [{ "id": "s3" }]
        }))
        .unwrap();
        assert_eq!(partial.items[0].name, "");
        assert_eq!(partial.items[0].host, "");
        assert_eq!(partial.items[0].status, "");
        assert_eq!(partial.items[0].port, "");

        // 只取 totalItems 时 items 可以缺失。
        let count_only = parse_systems(&serde_json::json!({ "totalItems": 7 })).unwrap();
        assert_eq!(count_only.total_items, 7);
        assert!(count_only.items.is_empty());
        // totalItems 缺失/非数字时按 0 处理，不报错。
        assert_eq!(
            parse_systems(&serde_json::json!({ "items": [] }))
                .unwrap()
                .total_items,
            0
        );

        // 非数组 items 是明确的解析错误。
        let error = parse_systems(&serde_json::json!({ "items": "nope" })).unwrap_err();
        assert_eq!(error.message, "解析系统列表失败：expected a sequence");
    }

    #[test]
    fn maps_status_codes_to_actionable_hints() {
        let bad_login = describe_error(
            400,
            &serde_json::json!({ "message": "Failed to authenticate." }),
            true,
        );
        assert!(bad_login.starts_with("Failed to authenticate.（"));
        assert!(bad_login.contains("邮箱或密码错误"));
        assert!(bad_login.contains("不是 PocketBase 超级管理员"));

        // 非认证端点的 400 走通用提示。
        let generic_bad_request = describe_error(400, &serde_json::json!({}), false);
        assert!(generic_bad_request.contains("网络连通性"));

        assert!(describe_error(401, &serde_json::json!({}), false).contains("token 无效或已过期"));
        assert!(
            describe_error(403, &serde_json::json!({}), false).contains("DISABLE_PASSWORD_AUTH")
        );
        assert!(describe_error(404, &serde_json::json!({}), false).contains("8090"));
        assert!(describe_error(429, &serde_json::json!({}), false).contains("限流"));
        assert!(describe_error(500, &serde_json::Value::Null, false).contains("网络"));

        let with_error = describe_error(500, &serde_json::json!({ "error": "boom" }), false);
        assert!(with_error.starts_with("boom（"));
        // 纯文本原文也作为 detail 拼在提示前。
        let text = describe_error(
            500,
            &serde_json::Value::String("upstream exploded".to_string()),
            false,
        );
        assert!(text.starts_with("upstream exploded（"));
    }

    #[test]
    fn formats_error_display_with_and_without_status() {
        let with_status = BeszelError {
            status: Some(400),
            message: "Failed to authenticate.".to_string(),
        };
        assert_eq!(
            with_status.to_string(),
            "Beszel API 400: Failed to authenticate."
        );
        let without_status = BeszelError {
            status: None,
            message: "Beszel 地址不能为空".to_string(),
        };
        assert_eq!(
            without_status.to_string(),
            "Beszel API: Beszel 地址不能为空"
        );
    }

    #[test]
    fn builds_auth_body_and_systems_path() {
        let body = auth_body("you@example.com", "secret");
        assert_eq!(body["identity"], "you@example.com");
        assert_eq!(body["password"], "secret");
        assert_eq!(
            systems_path(1),
            "/collections/systems/records?page=1&perPage=1&sort=name&fields=id,name,host,status,port,updated"
        );
        assert_eq!(
            systems_path(200),
            "/collections/systems/records?page=1&perPage=200&sort=name&fields=id,name,host,status,port,updated"
        );
    }
}