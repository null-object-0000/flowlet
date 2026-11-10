//! GitLab API v4 客户端（面向 GitLab CE 10.8.7 实测）。
//!
//! 选择面：
//! - 认证只用 `PRIVATE-TOKEN` 请求头。10.8.7 时代 `Authorization: Bearer <PAT>` 尚未
//!   普遍可用，个人访问令牌走 `PRIVATE-TOKEN` 是唯一稳定方式；
//! - 只使用 10.8 已存在的端点（`/user`、`/projects`、`/projects/:id/...`、`/groups`、
//!   `/version`(仅管理员)）。不使用 `/personal_access_tokens/self` 等 11.x+ 才有的端点；
//! - 分页读取 `X-Next-Page` / `X-Total` 响应头（10.8 不保证 `Link` 头存在）；
//! - 允许实例部署在子路径（`https://host/gitlab`），也接受用户直接粘贴 `/api/v4`。
//!
//! HTTP 调用在 CLI 侧执行，本模块只负责 URL/请求构造与响应解析，便于单测。

use serde::{Deserialize, Serialize};
use std::time::Duration;

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(20);

/// 单个项目的最小投影，避免把 GitLab 返回的大对象原样塞进 Agent 上下文。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProjectSummary {
    pub id: i64,
    pub path_with_namespace: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub default_branch: Option<String>,
    #[serde(default)]
    pub visibility: Option<String>,
    #[serde(default)]
    pub web_url: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Pagination {
    pub page: Option<u32>,
    pub next_page: Option<u32>,
    pub total: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct GitlabError {
    pub status: Option<u16>,
    pub message: String,
}

impl std::fmt::Display for GitlabError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.status {
            Some(status) => write!(formatter, "GitLab API {status}: {}", self.message),
            None => write!(formatter, "GitLab API: {}", self.message),
        }
    }
}

impl std::error::Error for GitlabError {}

/// 规范化实例地址：
/// - 必须是 http/https；
/// - 去掉末尾 `/`；
/// - 用户粘贴到 `/api/v4` 时自动剥掉；
/// - 保留子路径部署（`https://host/gitlab`）；
/// - 拒绝 query / fragment。
pub fn normalize_base_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("GitLab 地址不能为空".to_string());
    }
    let parsed =
        url::Url::parse(trimmed).map_err(|error| format!("GitLab 地址无法解析：{error}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("GitLab 地址必须是 http 或 https".to_string());
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err("GitLab 地址不能带查询参数或锚点".to_string());
    }
    let mut base = parsed.as_str().trim_end_matches('/').to_string();
    if let Some(stripped) = base.strip_suffix("/api/v4") {
        base = stripped.trim_end_matches('/').to_string();
    }
    if base.is_empty() || base == "https:" {
        return Err("GitLab 地址缺少主机名".to_string());
    }
    Ok(base)
}

pub fn api_base(base: &str) -> String {
    format!("{base}/api/v4")
}

/// 把 `GET /projects` 这类路径拼成完整 URL；拒绝绝对 URL，避免把 token 发到别处。
pub fn resolve_api_path(base: &str, path: &str) -> Result<String, String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("API 路径不能为空".to_string());
    }
    if path.starts_with("http://") || path.starts_with("https://") {
        return Err("API 路径必须是相对路径（如 /projects），不接受绝对 URL".to_string());
    }
    let path = if path.starts_with("/api/v4") {
        path.trim_start_matches("/api/v4").to_string()
    } else {
        path.to_string()
    };
    Ok(format!("{}{}", api_base(base), normalize_path(&path)))
}

fn normalize_path(path: &str) -> String {
    if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{path}")
    }
}

pub struct GitlabClient {
    base: String,
    token: String,
    insecure: bool,
}

impl GitlabClient {
    pub fn new(url: &str, token: &str) -> Result<Self, String> {
        if token.trim().is_empty() {
            return Err("GitLab token 不能为空".to_string());
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
    ) -> Result<(u16, serde_json::Value, Pagination), GitlabError> {
        let url = resolve_api_path(&self.base, path).map_err(|message| GitlabError {
            status: None,
            message,
        })?;
        let method = method.parse::<reqwest::Method>().map_err(|_| GitlabError {
            status: None,
            message: format!("不支持的 HTTP 方法：{method}"),
        })?;
        let client = self.build_client().map_err(|message| GitlabError {
            status: None,
            message,
        })?;
        let mut request = client
            .request(method, &url)
            .header("PRIVATE-TOKEN", &self.token)
            .header("Accept", "application/json");
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = request.send().await.map_err(|error| GitlabError {
            status: None,
            message: format!("请求 {url} 失败：{error}（内网自签证书请加 --insecure）"),
        })?;
        let status = response.status().as_u16();
        let pagination = pagination_from_headers(response.headers());
        let text = response.text().await.map_err(|error| GitlabError {
            status: Some(status),
            message: format!("读取响应失败：{error}"),
        })?;
        let value: serde_json::Value = if text.trim().is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::from_str(&text).unwrap_or_else(|_| serde_json::Value::String(text.clone()))
        };
        if !(200..300).contains(&status) {
            return Err(GitlabError {
                status: Some(status),
                message: describe_error(status, &value),
            });
        }
        Ok((status, value, pagination))
    }

    pub async fn current_user(&self) -> Result<serde_json::Value, GitlabError> {
        let (_, value, _) = self.send("GET", "/user", None).await?;
        Ok(value)
    }

    /// `/version` 在 10.8 只对管理员开放；非管理员时返回 Ok(None)。
    pub async fn version(&self) -> Result<Option<String>, GitlabError> {
        match self.send("GET", "/version", None).await {
            Ok((_, value, _)) => Ok(value
                .get("version")
                .and_then(|item| item.as_str())
                .map(str::to_string)),
            Err(error) if matches!(error.status, Some(401) | Some(403) | Some(404)) => Ok(None),
            Err(error) => Err(error),
        }
    }

    pub async fn projects(
        &self,
        search: Option<&str>,
        membership: bool,
        limit: usize,
    ) -> Result<Vec<ProjectSummary>, GitlabError> {
        let mut projects = Vec::new();
        let mut page = 1u32;
        let per_page = limit.clamp(1, 100);
        loop {
            let mut path =
                format!("/projects?per_page={per_page}&page={page}&order_by=last_activity_at");
            if membership {
                path.push_str("&membership=true");
            }
            if let Some(search) = search.map(str::trim).filter(|value| !value.is_empty()) {
                path.push_str(&format!("&search={}", urlencode(search)));
            }
            let (_, value, pagination) = self.send("GET", &path, None).await?;
            let batch = parse_projects(&value)?;
            if batch.is_empty() {
                break;
            }
            projects.extend(batch);
            if projects.len() >= limit {
                projects.truncate(limit);
                break;
            }
            match pagination.next_page {
                Some(next) if next > page => page = next,
                _ => break,
            }
        }
        Ok(projects)
    }

    /// 通用透传：给 Agent 用 10.8 已有的任意端点，不必为每个功能加命令。
    pub async fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<&serde_json::Value>,
    ) -> Result<(serde_json::Value, Pagination), GitlabError> {
        let (_, value, pagination) = self.send(method, path, body).await?;
        Ok((value, pagination))
    }
}

pub fn parse_projects(value: &serde_json::Value) -> Result<Vec<ProjectSummary>, GitlabError> {
    serde_json::from_value::<Vec<ProjectSummary>>(value.clone()).map_err(|error| GitlabError {
        status: None,
        message: format!("解析项目列表失败：{error}"),
    })
}

fn pagination_from_headers(headers: &reqwest::header::HeaderMap) -> Pagination {
    let number = |name: &str| -> Option<u32> {
        headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.trim().parse().ok())
    };
    Pagination {
        page: number("x-page"),
        next_page: number("x-next-page").filter(|value| *value > 0),
        total: headers
            .get("x-total")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.trim().parse().ok()),
    }
}

/// 把 GitLab 的错误体转成可执行的提示。10.8 通常返回 `{"message": "..."}`，
/// 401/403 还可能返回 `{"error": "invalid_token"}`。
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
        401 => "token 无效或已过期，请重新生成个人访问令牌（需 api scope）",
        403 => "权限不足；该接口可能需要管理员权限，或 token 缺少 api scope",
        404 => "资源不存在，或该接口在 GitLab 10.8.7 中不存在",
        429 => "触发 GitLab 限流，稍后重试",
        _ => "请检查 token、实例地址与网络连通性",
    };
    if detail.is_empty() {
        hint.to_string()
    } else {
        format!("{detail}（{hint}）")
    }
}

fn urlencode(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            b' ' => out.push_str("%20"),
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_instance_urls() {
        assert_eq!(
            normalize_base_url("https://gitlab.example.com").unwrap(),
            "https://gitlab.example.com"
        );
        assert_eq!(
            normalize_base_url("https://gitlab.example.com/").unwrap(),
            "https://gitlab.example.com"
        );
        assert_eq!(
            normalize_base_url("https://gitlab.example.com/gitlab/").unwrap(),
            "https://gitlab.example.com/gitlab"
        );
        assert_eq!(
            normalize_base_url("https://gitlab.example.com/api/v4").unwrap(),
            "https://gitlab.example.com"
        );
        assert!(normalize_base_url("ftp://gitlab.example.com").is_err());
        assert!(normalize_base_url("gitlab.example.com").is_err());
        assert!(normalize_base_url("https://gitlab.example.com/?a=1").is_err());
    }

    #[test]
    fn builds_api_paths_with_subpath() {
        assert_eq!(
            resolve_api_path("https://host/gitlab", "/projects").unwrap(),
            "https://host/gitlab/api/v4/projects"
        );
        assert_eq!(
            resolve_api_path("https://host", "projects").unwrap(),
            "https://host/api/v4/projects"
        );
        assert_eq!(
            resolve_api_path("https://host", "/api/v4/projects").unwrap(),
            "https://host/api/v4/projects"
        );
        assert!(resolve_api_path("https://host", "https://evil.example.com/x").is_err());
    }

    #[test]
    fn parses_project_list() {
        let json = serde_json::json!([
            {
                "id": 42,
                "path_with_namespace": "group/app",
                "name": "app",
                "default_branch": "main",
                "visibility": "private",
                "web_url": "https://gitlab.example.com/group/app"
            },
            { "id": 7, "path_with_namespace": "team/svc" }
        ]);
        let projects = parse_projects(&json).unwrap();
        assert_eq!(projects.len(), 2);
        assert_eq!(projects[0].id, 42);
        assert_eq!(projects[0].default_branch.as_deref(), Some("main"));
        assert_eq!(projects[1].path_with_namespace, "team/svc");
        assert_eq!(projects[1].default_branch, None);
    }

    #[test]
    fn maps_status_codes_to_actionable_hints() {
        let unauthorized = describe_error(401, &serde_json::json!({"message": "401 Unauthorized"}));
        assert!(unauthorized.contains("token 无效"));
        let forbidden = describe_error(403, &serde_json::json!({}));
        assert!(forbidden.contains("管理员"));
        let missing = describe_error(404, &serde_json::json!({"message": "404 Not Found"}));
        assert!(missing.contains("10.8.7"));
        assert!(describe_error(500, &serde_json::Value::Null).contains("网络"));
    }

    #[test]
    fn rejects_blank_token() {
        assert!(GitlabClient::new("https://gitlab.example.com", "  ").is_err());
        assert!(GitlabClient::new("https://gitlab.example.com", "glpat-xxx").is_ok());
    }

    #[test]
    fn encodes_search_terms() {
        assert_eq!(
            urlencode("my project/名字"),
            "my%20project%2F%E5%90%8D%E5%AD%97"
        );
    }

    #[test]
    fn reads_pagination_headers() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert("x-page", "2".parse().unwrap());
        headers.insert("x-next-page", "3".parse().unwrap());
        headers.insert("x-total", "120".parse().unwrap());
        let pagination = pagination_from_headers(&headers);
        assert_eq!(pagination.page, Some(2));
        assert_eq!(pagination.next_page, Some(3));
        assert_eq!(pagination.total, Some(120));

        // 最后一页时 GitLab 可能返回空值或 0，两者都必须视为没有下一页。
        let mut last_page = reqwest::header::HeaderMap::new();
        last_page.insert("x-next-page", "0".parse().unwrap());
        assert_eq!(pagination_from_headers(&last_page).next_page, None);
    }
}
