use crate::core::config::{
    AuthStrategy, ChannelAccount, ChannelPreset, ProtocolType, RouteCandidate,
    UaClientRule, ACCOUNT_CREDENTIAL_HEALTHY,
};
use axum::{
    body::Body,
    http::{header, HeaderMap, HeaderValue, Method, StatusCode, Uri},
    response::Response,
};
use base64::Engine;
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
    channels: &[ChannelPreset],
    protocol: &ProtocolType,
) -> Response {
    let entries = collect_model_entries(routes, accounts, channels, protocol);

    match protocol {
        ProtocolType::OpenAi => build_openai_model_list(&entries),
        ProtocolType::Anthropic => build_anthropic_model_list(&entries),
    }
}

/// 单个对外模型的展示信息。owned_by 用于 OpenAI-compatible 模型列表。
#[derive(Clone)]
struct ModelEntry {
    id: String,
    owned_by: String,
    created_at: String,
}

/// 从 routes 中按 protocol+enabled+healthy 过滤后，收集对外模型集合。
/// 同时包含聚合模型（flowlet-pro/flash）与直接底层模型。
/// 直接模型：virtual_model_id === upstream_model，以渠道 vendor 为 owned_by；
/// 聚合模型：owned_by = "flowlet"。
fn collect_model_entries(
    routes: &[RouteCandidate],
    accounts: &[ChannelAccount],
    channels: &[ChannelPreset],
    protocol: &ProtocolType,
) -> Vec<ModelEntry> {
    // 账号健康判断与路由候选池一致：必须 enabled + API Key 非空 + credential_status = healthy。
    let healthy_accounts: BTreeSet<&str> = accounts
        .iter()
        .filter(|a| {
            a.enabled
                && !a.api_key.trim().is_empty()
                && a.credential_status == ACCOUNT_CREDENTIAL_HEALTHY
        })
        .map(|a| a.id.as_str())
        .collect();

    let dual_protocol_channels: BTreeSet<&str> = channels
        .iter()
        .filter(|channel| {
            channel.supported_protocols.contains(&ProtocolType::OpenAi)
                && channel.supported_protocols.contains(&ProtocolType::Anthropic)
        })
        .map(|channel| channel.id.as_str())
        .collect();

    let vendor_by_channel: std::collections::HashMap<&str, &str> = channels
        .iter()
        .map(|channel| (channel.id.as_str(), channel.vendor.as_str()))
        .collect();

    let mut result: Vec<ModelEntry> = Vec::new();
    let mut seen = BTreeSet::new();

    for route in routes {
        if !route.enabled
            || route.client_protocol != *protocol
            || !healthy_accounts.contains(route.account_id.as_str())
        {
            continue;
        }
        let is_aggregate =
            matches!(route.virtual_model_id.as_str(), "flowlet-pro" | "flowlet-flash");
        // 聚合模型必须来自双协议渠道；直接模型按 client_protocol 自然兼容。
        if is_aggregate && !dual_protocol_channels.contains(route.channel_id.as_str()) {
            continue;
        }
        // 直接模型：对外模型名必须与上游模型名一致（不允许同名非直接路由混入）。
        if !is_aggregate && route.virtual_model_id != route.upstream_model {
            continue;
        }
        let id = route.virtual_model_id.trim();
        if id.is_empty() || !seen.insert(id.to_string()) {
            continue;
        }
        let owned_by = if is_aggregate {
            "flowlet".to_string()
        } else {
            vendor_by_channel
                .get(route.channel_id.as_str())
                .copied()
                .unwrap_or("flowlet")
                .to_string()
        };
        result.push(ModelEntry {
            id: id.to_string(),
            owned_by,
            created_at: route.created_at.clone(),
        });
    }
    // 排序固定：flowlet-pro → flowlet-flash → 其余按名字典序（需求八）。
    result.sort_by(|a, b| rank_model(&a.id).cmp(&rank_model(&b.id)).then_with(|| a.id.cmp(&b.id)));
    result
}

fn rank_model(id: &str) -> u8 {
    match id {
        "flowlet-pro" => 0,
        "flowlet-flash" => 1,
        _ => 2,
    }
}

fn build_openai_model_list(entries: &[ModelEntry]) -> Response {
    // Flowlet 聚合模型的 owned_by 固定为 "flowlet"；直接模型使用其所属渠道 vendor。
    let parse_unix_seconds = |raw: &str| -> i64 {
        if raw.is_empty() {
            return 0;
        }
        if let Ok(ts) = raw.parse::<i64>() {
            return ts;
        }
        chrono::DateTime::parse_from_rfc3339(raw)
            .map(|dt| dt.timestamp())
            .unwrap_or(0)
    };

    let data: Vec<serde_json::Value> = entries
        .iter()
        .map(|entry| {
            serde_json::json!({
                "id": entry.id,
                "object": "model",
                "created": parse_unix_seconds(&entry.created_at),
                "owned_by": entry.owned_by
            })
        })
        .collect();

    json_response(serde_json::json!({
        "object": "list",
        "data": data
    }))
}

fn build_anthropic_model_list(entries: &[ModelEntry]) -> Response {
    // Anthropic GET /v1/models 官方 schema（参考 docs.claude.com）：
    // { "data": [{ "id": "...", "type": "model", "display_name": "...", "created_at": "RFC3339" }],
    //   "has_more": false, "first_id": "...", "last_id": "..." }
    let data: Vec<serde_json::Value> = entries
        .iter()
        .map(|entry| {
            let created_at = if entry.created_at.is_empty() {
                "1970-01-01T00:00:00Z"
            } else {
                entry.created_at.as_str()
            };
            serde_json::json!({
                "id": entry.id,
                "type": "model",
                "display_name": entry.id,
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

/// 通过鉴权 token（Authorization Bearer 或 X-Api-Key）识别客户端。
/// 匹配 `default_client_token`（来自 ProxyBindConfig）。
pub(super) fn identify_client(
    headers: &HeaderMap,
    default_token: &str,
) -> Option<(String, String)> {
    // 1. 先检查 Authorization Bearer
    if let Some(token) = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
    {
        if token == default_token {
            return Some(("default".to_string(), "默认客户端".to_string()));
        }
    }

    // 2. 再检查 X-Api-Key
    if let Some(token) = headers
        .get("x-api-key")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
    {
        if token == default_token {
            return Some(("default".to_string(), "默认客户端".to_string()));
        }
    }

    None
}

/// 从 config.json 加载时只要 ua_rules 数组。
/// config.json 顶层既可以是 { "ua_rules": [...] }（新格式），也可以是旧格式的 [...]。
fn extract_ua_rules(value: serde_json::Value) -> Vec<UaClientRule> {
    if let Some(arr) = value.as_array() {
        return serde_json::from_value::<Vec<UaClientRule>>(serde_json::Value::Array(arr.to_vec()))
            .unwrap_or_default();
    }
    if let Some(arr) = value.pointer("/ua_rules").and_then(|v| v.as_array()) {
        return serde_json::from_value::<Vec<UaClientRule>>(serde_json::Value::Array(arr.to_vec()))
            .unwrap_or_default();
    }
    Vec::new()
}

/// 从 config.json 顶层对象解析 log_capture 配置。缺失任何字段时使用默认值。
pub fn extract_log_capture(value: &serde_json::Value) -> crate::core::config::LogCaptureConfig {
    use crate::core::config::LogCaptureConfig;
    if let Some(obj) = value.as_object() {
        if let Some(lc) = obj.get("log_capture").and_then(|v| v.as_object()) {
            return LogCaptureConfig {
                capture_req_headers: lc
                    .get("capture_req_headers")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true),
                capture_req_body: lc
                    .get("capture_req_body")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true),
                capture_res_headers: lc
                    .get("capture_res_headers")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true),
                capture_res_body: lc
                    .get("capture_res_body")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true),
                stream_summary_max_bytes: lc
                    .get("stream_summary_max_bytes")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(16 * 1024) as usize,
                max_body_bytes: lc
                    .get("max_body_bytes")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(1024 * 1024) as usize,
                redact_sensitive_headers: lc
                    .get("redact_sensitive_headers")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
            };
        }
    }
    LogCaptureConfig::default()
}

/// 通过请求 User-Agent 子串匹配独立的客户端身份规则。
///
/// 与鉴权 token 无关，仅决定日志/用量中的客户端归属。返回命中的
/// UaClientRule 的 (id, name)；无任何命中时返回 None。
pub(super) fn identify_client_by_ua(
    headers: &HeaderMap,
    rules: &[UaClientRule],
) -> Option<(String, String)> {
    let ua = headers.get(header::USER_AGENT).and_then(|v| v.to_str().ok())?;
    rules
        .iter()
        .find(|r| r.enabled && !r.pattern.is_empty() && ua.contains(&r.pattern))
        .map(|r| (r.id.clone(), r.name.clone()))
}

/// 确保运行时 config.json 存在；缺失时写入编译时内置的完整默认配置。
pub(super) fn ensure_config_file(path: &std::path::Path) {
    if path.exists() {
        return;
    }
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(path, crate::core::channels_config::DEFAULT_CONFIG_JSON);
}

/// 从本地 config.json 文件加载 UA 客户端规则。文件不存在或解析失败时返回空列表。
pub(super) fn load_config_ua_rules(path: &std::path::Path) -> Vec<UaClientRule> {
    let Ok(json) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&json) else {
        return Vec::new();
    };
    extract_ua_rules(value)
}

// 向后兼容：旧代码里 load_ua_rules(...) 仍然可用
pub(super) use load_config_ua_rules as load_ua_rules;



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

// ─── Header Sanitization + Body Encoding ─────────────────────────────────────

/// Serialize HTTP headers to a JSON object, redacting sensitive values.
///
/// 1. Hop-by-hop headers are skipped (reuses
///    [`is_hop_by_hop`]).
/// 2. Header names in `redact` are lower-cased and replaced with
///    `"[redacted]"`. This prevents leakage of Authorization tokens,
///    x-api-key values, and cookies into the request log payload.
pub(super) fn sanitize_headers(headers: &HeaderMap, redact: &[&str]) -> serde_json::Value {
    let redact_lower: std::collections::HashSet<String> =
        redact.iter().map(|key| key.to_ascii_lowercase()).collect();
    let mut map = serde_json::Map::new();
    for (name, value) in headers {
        if is_hop_by_hop(name.as_str()) {
            continue;
        }
        let key = name.as_str().to_string();
        let value = if redact_lower.contains(&key.to_ascii_lowercase()) {
            serde_json::Value::String("[redacted]".to_string())
        } else {
            value
                .to_str()
                .map(|v| serde_json::Value::String(v.to_string()))
                .unwrap_or_else(|_| serde_json::Value::String("[non-ascii]".to_string()))
        };
        map.insert(key, value);
    }
    serde_json::Value::Object(map)
}

pub(super) fn encode_body_base64(body: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(body)
}

pub(super) fn truncate_utf8(body: &mut Vec<u8>, max: usize) {
    if body.len() <= max {
        return;
    }
    let mut cut = max;
    // 回退到最近的 UTF-8 字符边界（UTF-8 续字节以 10xxxxxx 开头）
    while cut > 0 && (body[cut] & 0b1100_0000) == 0b1000_0000 {
        cut -= 1;
    }
    body.truncate(cut);
}

/// Build the textual "首尾片段" summary that we persist in the
/// `stream_summary` column for captured streaming responses.
#[allow(dead_code)]
pub(super) fn summarize_stream_fragment(fragment: &str) -> Option<String> {
    let non_empty: Vec<&str> = fragment.lines().filter(|line| !line.is_empty()).collect();
    if non_empty.is_empty() {
        return None;
    }
    let head = non_empty[0];
    let tail = non_empty[non_empty.len() - 1];
    Some(format!(
        "chunks: {}\nfirst: {}\nlast:  {}",
        non_empty.len(),
        head,
        tail
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_headers_redacts_bearer() {
        let mut map = HeaderMap::new();
        map.insert("authorization", HeaderValue::from_static("Bearer abc"));
        map.insert("content-type", HeaderValue::from_static("application/json"));
        let redacted = sanitize_headers(&map, &["authorization"]);
        let obj = redacted.as_object().unwrap();
        assert_eq!(obj["authorization"], "[redacted]");
        assert_eq!(obj["content-type"], "application/json");
    }

    #[test]
    fn encode_body_roundtrips_string() {
        let encoded = encode_body_base64(b"hello");
        assert_eq!(encoded, "aGVsbG8=");
    }
}

pub(super) fn rewrite_model(body: &[u8], upstream_model: &str, _protocol: &ProtocolType) -> Vec<u8> {
    let Ok(mut value) = serde_json::from_slice::<serde_json::Value>(body) else {
        return body.to_vec();
    };
    let Some(original_model) = value.get("model").and_then(|field| field.as_str()).map(str::to_string) else {
        return body.to_vec();
    };
    let Some(model_field) = value.get_mut("model") else {
        return body.to_vec();
    };
    *model_field = serde_json::Value::String(upstream_model.to_string());

    let body_text = String::from_utf8_lossy(body);
    for (search, replacement) in [
        (format!(r#""model":"{}""#, original_model), format!(r#""model":"{}""#, upstream_model)),
        (format!(r#""model": "{}""#, original_model), format!(r#""model": "{}""#, upstream_model)),
    ] {
        if let Some(position) = body_text.find(&search) {
            let mut result = body_text.clone().into_owned();
            result.replace_range(position..position + search.len(), &replacement);
            return result.into_bytes();
        }
    }
    serde_json::to_vec(&value).unwrap_or_else(|_| body.to_vec())
}