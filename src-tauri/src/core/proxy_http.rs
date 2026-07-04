use crate::core::config::{AuthStrategy, ChannelAccount, ClientConfig, ProtocolType, RouteCandidate};
use axum::{
    body::Body,
    http::{header, HeaderMap, HeaderValue, Method, StatusCode, Uri},
    response::Response,
};
use std::collections::BTreeSet;

pub(super) fn cors_preflight_response(request_headers: &HeaderMap) -> Response {
    let mut response = Response::new(Body::empty());
    *response.status_mut() = StatusCode::NO_CONTENT;
    let requested_headers = request_headers.get(header::ACCESS_CONTROL_REQUEST_HEADERS);
    add_cors_headers(response.headers_mut(), requested_headers);
    response
}

pub(super) fn add_cors_headers(headers: &mut HeaderMap<HeaderValue>, requested_headers: Option<&HeaderValue>) {
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET,POST,PUT,PATCH,DELETE,OPTIONS"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        requested_headers.cloned().unwrap_or_else(|| {
            HeaderValue::from_static(
                "authorization,content-type,x-api-key,anthropic-version,anthropic-beta",
            )
        }),
    );
    headers.insert(
        header::ACCESS_CONTROL_EXPOSE_HEADERS,
        HeaderValue::from_static("content-type,x-request-id"),
    );
    headers.insert(
        header::ACCESS_CONTROL_MAX_AGE,
        HeaderValue::from_static("86400"),
    );
}

pub(super) fn is_model_list_request(method: &Method, path: &str) -> bool {
    if method != Method::GET {
        return false;
    }

    let path_without_query = path.split('?').next().unwrap_or(path);
    matches!(
        path_without_query,
        "/v1/models" | "/openai/v1/models" | "/anthropic/v1/models"
    )
}

pub(super) fn build_model_list_response(
    routes: &[RouteCandidate],
    accounts: &[ChannelAccount],
    protocol: &ProtocolType,
) -> Response {
    let entries = collect_model_entries(routes, accounts, protocol);

    match protocol {
        ProtocolType::OpenAi => build_openai_model_list(&entries, accounts),
        ProtocolType::Anthropic => build_anthropic_model_list(&entries),
    }
}

/// 从 routes 中按 protocol+enabled 过滤后，收集 (model_id, account_id, created_at)
/// BTreeSet 保证按模型名字典序排列且去重。
fn collect_model_entries(
    routes: &[RouteCandidate],
    accounts: &[ChannelAccount],
    protocol: &ProtocolType,
) -> Vec<(String, String, String)> {
    let enabled_accounts: BTreeSet<&str> = accounts
        .iter()
        .filter(|a| a.enabled)
        .map(|a| a.id.as_str())
        .collect();

    let mut result: Vec<(String, String, String)> = Vec::new();
    let mut seen = BTreeSet::new();

    for route in routes {
        if !route.enabled
            || route.client_protocol != *protocol
            || !enabled_accounts.contains(route.account_id.as_str())
        {
            continue;
        }
        // 只返回对外模型名（virtual_model_id），不回漏 upstream_model
        let id = route.virtual_model_id.trim();
        if id.is_empty() || !seen.insert(id.to_string()) {
            continue;
        }
        result.push((
            id.to_string(),
            route.account_id.clone(),
            route.created_at.clone(),
        ));
    }
    // 按 model_id 字典序稳定排序，保证 first_id/last_id 和输出顺序确定
    result.sort_by(|a, b| a.0.cmp(&b.0));
    result
}

fn build_openai_model_list(
    entries: &[(String, String, String)],
    accounts: &[ChannelAccount],
) -> Response {
    let account_name: std::collections::HashMap<&str, &str> = accounts
        .iter()
        .map(|a| (a.id.as_str(), a.name.as_str()))
        .collect();

    let parse_unix_seconds = |raw: &str| -> i64 {
        if raw.is_empty() {
            return 0;
        }
        // 优先尝试直接解析为 Unix 时间戳（纯数字）
        if let Ok(ts) = raw.parse::<i64>() {
            return ts;
        }
        // 否则尝试按 RFC 3339 / ISO 8601 解析
        chrono::DateTime::parse_from_rfc3339(raw)
            .map(|dt| dt.timestamp())
            .unwrap_or(0)
    };

    let data: Vec<serde_json::Value> = entries
        .iter()
        .map(|(id, account_id, created_at)| {
            let owned_by = account_name
                .get(account_id.as_str())
                .filter(|name| !name.is_empty())
                .copied()
                .unwrap_or("flowlet");
            serde_json::json!({
                "id": id,
                "object": "model",
                "created": parse_unix_seconds(created_at),
                "owned_by": owned_by
            })
        })
        .collect();

    json_response(serde_json::json!({
        "object": "list",
        "data": data
    }))
}

fn build_anthropic_model_list(entries: &[(String, String, String)]) -> Response {
    // Anthropic GET /v1/models 官方 schema（参考 docs.claude.com）：
    // { "data": [{ "id": "...", "type": "model", "display_name": "...", "created_at": "RFC3339" }],
    //   "has_more": false, "first_id": "...", "last_id": "..." }
    //
    // 上游 created_at 在数据库中以 RFC 3339 存储（如 "2026-01-01T00:00:00Z"）。
    // 若为空字符串（老数据兜底），返回 epoch 起点。
    let data: Vec<serde_json::Value> = entries
        .iter()
        .map(|(id, _account_id, created_at)| {
            let created_at = if created_at.is_empty() {
                "1970-01-01T00:00:00Z"
            } else {
                created_at.as_str()
            };
            serde_json::json!({
                "id": id,
                "type": "model",
                "display_name": id,
                "created_at": created_at
            })
        })
        .collect();

    let first_id = data.first().and_then(|v| v["id"].as_str()).unwrap_or("");
    let last_id = data.last().and_then(|v| v["id"].as_str()).unwrap_or("");

    json_response(serde_json::json!({
        "data": data,
        "has_more": false,
        "first_id": first_id,
        "last_id": last_id
    }))
}

fn json_response(value: serde_json::Value) -> Response {
    let mut response = Response::new(Body::from(value.to_string()));
    *response.status_mut() = StatusCode::OK;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    response
}

pub(super) fn is_streaming_response(headers: &HeaderMap) -> bool {
    headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.contains("text/event-stream"))
        .unwrap_or(false)
}

// ─── URL Building ────────────────────────────────────────────────────────────

pub(super) fn build_upstream_url(base_url: &str, original_uri: &Uri, protocol: &ProtocolType) -> String {
    let base = base_url.trim_end_matches('/');
    let path = original_uri
        .path_and_query()
        .map(|value| value.as_str())
        .unwrap_or("/");

    match protocol {
        ProtocolType::OpenAi => {
            // 保留 /v1 和 /openai/v1 前缀，因为 base_url 已经包含了 /openai 或 /v1 的入口前缀
            let path = path.trim_start_matches("/openai");
            format!("{base}{path}")
        }
        ProtocolType::Anthropic => {
            // 保留 /v1 前缀，只去掉 /anthropic 入口前缀
            let path = path.trim_start_matches("/anthropic");
            format!("{base}{path}")
        }
    }
}

// ─── Header Handling ────────────────────────────────────────────────────────

pub(super) fn apply_request_headers(
    mut builder: reqwest::RequestBuilder,
    headers: &HeaderMap,
    api_key: &str,
    protocol: &ProtocolType,
    auth_strategy: &AuthStrategy,
) -> reqwest::RequestBuilder {
    for (name, value) in headers {
        if is_hop_by_hop(name.as_str())
            || name == header::HOST
            || name == header::AUTHORIZATION
            || name.as_str() == "x-api-key"
        {
            continue;
        }
        builder = builder.header(name, value);
    }

    if !api_key.trim().is_empty() {
        match auth_strategy {
            AuthStrategy::Bearer => {
                builder = builder.bearer_auth(api_key.trim());
            }
            AuthStrategy::XApiKey => {
                builder = builder.header("x-api-key", api_key.trim());
            }
        }
    }

    let _ = protocol;
    builder
}

pub(super) fn copy_response_headers(source: &HeaderMap, target: &mut HeaderMap<HeaderValue>) {
    for (name, value) in source {
        if is_hop_by_hop(name.as_str()) {
            continue;
        }
        target.append(name, value.clone());
    }
}

pub(super) fn is_hop_by_hop(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
    )
}

// ─── Client Identification ──────────────────────────────────────────────────

pub(super) fn identify_client(headers: &HeaderMap, clients: &[ClientConfig]) -> Option<(String, String)> {
    // 1. 先检查 Authorization Bearer
    if let Some(token) = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
    {
        if let Some(client) = clients.iter().find(|c| c.enabled && c.token == token) {
            return Some((client.id.clone(), client.name.clone()));
        }
    }

    // 2. 再检查 X-Api-Key
    if let Some(token) = headers
        .get("x-api-key")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
    {
        if let Some(client) = clients.iter().find(|c| c.enabled && c.token == token) {
            return Some((client.id.clone(), client.name.clone()));
        }
    }

    None
}

// ─── Model Rewriting ─────────────────────────────────────────────────────────

pub(super) fn extract_model(body: &[u8], protocol: &ProtocolType) -> Option<String> {
    let value: serde_json::Value = serde_json::from_slice(body).ok()?;
    match protocol {
        ProtocolType::OpenAi => value
            .get("model")
            .and_then(|v| v.as_str())
            .map(String::from),
        ProtocolType::Anthropic => value
            .get("model")
            .and_then(|v| v.as_str())
            .map(String::from),
    }
}

pub(super) fn rewrite_model(body: &[u8], upstream_model: &str, _protocol: &ProtocolType) -> Vec<u8> {
    let Ok(mut value) = serde_json::from_slice::<serde_json::Value>(body) else {
        return body.to_vec();
    };

    let Some(model_field) = value.get_mut("model") else {
        return body.to_vec();
    };

    if model_field.as_str() != Some("auto") {
        return body.to_vec();
    }

    *model_field = serde_json::Value::String(upstream_model.to_string());

    // 使用 serde_json::to_vec 会改变字段顺序，改用手动替换保持原始 body 结构
    // 对于 {"model":"auto",...} 替换为 {"model":"upstream_model",...}
    let body_str = String::from_utf8_lossy(body);
    let search = r#""model":"auto""#;
    let replace = format!(r#""model":"{upstream_model}""#);
    if let Some(pos) = body_str.find(search) {
        let mut result = body_str.into_owned();
        result.replace_range(pos..pos + search.len(), &replace);
        result.into_bytes()
    } else {
        // 尝试带空格的变体
        let search = r#""model": "auto""#;
        let replace = format!(r#""model": "{upstream_model}""#);
        if let Some(pos) = body_str.find(search) {
            let mut result = body_str.into_owned();
            result.replace_range(pos..pos + search.len(), &replace);
            result.into_bytes()
        } else {
            serde_json::to_vec(&value).unwrap_or_else(|_| body.to_vec())
        }
    }
}


