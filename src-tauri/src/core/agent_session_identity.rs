use axum::http::{HeaderMap, HeaderName, HeaderValue};

pub(crate) const AGENT_CLIENT_HEADER: &str = "x-flowlet-client";
pub(crate) const AGENT_SESSION_HEADER: &str = "x-flowlet-session";

const MAX_AGENT_SESSION_ID_BYTES: usize = 512;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AgentSessionIdentity {
    pub(crate) agent_type: String,
    pub(crate) session_id: String,
    pub(crate) parent_session_id: Option<String>,
}

/// 从代理收到的实时 HTTP Header 识别 Agent 会话。
pub(crate) fn from_http_headers(headers: &HeaderMap) -> Option<AgentSessionIdentity> {
    parse_with(|name| {
        headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .and_then(valid_header_value)
    })
}

/// 从历史请求日志保存的 Header JSON 识别 Agent 会话。
///
/// 实时代理与历史修复必须经过同一套 `parse_with` 规则，避免新增 Agent 时
/// 两条路径产生不同的归属结果。
pub(crate) fn from_header_json(headers_json: &str) -> Option<AgentSessionIdentity> {
    let parsed = serde_json::from_str::<serde_json::Value>(headers_json).ok()?;
    let headers = parsed.as_object()?;
    parse_with(|name| {
        headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .and_then(|(_, value)| value.as_str())
            .and_then(valid_header_value)
    })
}

/// 从历史请求日志保存的 Header JSON 还原 `HeaderMap`（键名统一小写）。
///
/// 供历史修复路径把落库的 `req_headers_json` 还原成与实时请求一致的
/// `HeaderMap`，再交给实时识别逻辑（如 `identify_client_agent`）复用
/// 同一套规则，保证修复结果与新请求的归属一致。
///
/// 落库 JSON 的键名大小写不固定（历史捕获层可能原样保存 SDK 原值），这里
/// 全部降为小写后写入，符合 `HeaderMap` 的规范化语义；非字符串值与无法
/// 解析为合法 Header 名/值的条目被跳过，避免历史脏数据让整段修复中断。
pub(crate) fn header_map_from_json(headers_json: &str) -> Option<HeaderMap> {
    let parsed = serde_json::from_str::<serde_json::Value>(headers_json).ok()?;
    let obj = parsed.as_object()?;
    let mut headers = HeaderMap::new();
    for (raw_name, raw_value) in obj {
        let Some(value) = raw_value.as_str() else {
            continue;
        };
        let Ok(name) = HeaderName::from_bytes(raw_name.to_ascii_lowercase().as_bytes()) else {
            continue;
        };
        let Ok(value) = HeaderValue::from_str(value) else {
            continue;
        };
        headers.append(name, value);
    }
    Some(headers)
}

fn parse_with(header: impl Fn(&str) -> Option<String>) -> Option<AgentSessionIdentity> {
    if let Some(session_id) = header("x-claude-code-session-id") {
        return Some(AgentSessionIdentity {
            agent_type: "claude-code".to_string(),
            session_id,
            parent_session_id: None,
        });
    }

    // Pi 使用通用 OpenAI SDK，必须以 Flowlet 写入的客户端标记为门控，
    // 避免把其他客户端的同名 Session Header 错归为 Pi。
    let is_flowlet_pi =
        header(AGENT_CLIENT_HEADER).is_some_and(|value| value.eq_ignore_ascii_case("pi"));
    if is_flowlet_pi {
        if let Some(session_id) = header(AGENT_SESSION_HEADER) {
            return Some(AgentSessionIdentity {
                agent_type: "pi".to_string(),
                session_id,
                parent_session_id: None,
            });
        }
    }

    let opencode_session = header("x-opencode-session");
    let user_agent_is_opencode =
        header("user-agent").is_some_and(|value| value.to_ascii_lowercase().contains("opencode/"));
    if !user_agent_is_opencode && opencode_session.is_none() {
        return None;
    }

    let session_id = opencode_session
        .or_else(|| header("x-session-id"))
        .or_else(|| header("x-session-affinity"))?;
    Some(AgentSessionIdentity {
        agent_type: "opencode".to_string(),
        session_id,
        parent_session_id: header("x-parent-session-id"),
    })
}

fn valid_header_value(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty() && value != "[redacted]" && value.len() <= MAX_AGENT_SESSION_ID_BYTES)
        .then(|| value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    #[test]
    fn http_and_json_paths_use_the_same_opencode_precedence() {
        let mut headers = HeaderMap::new();
        headers.insert("user-agent", HeaderValue::from_static("opencode/1.0"));
        headers.insert("x-session-affinity", HeaderValue::from_static("legacy"));
        headers.insert("x-session-id", HeaderValue::from_static("current"));
        headers.insert("x-parent-session-id", HeaderValue::from_static("parent"));

        let expected = AgentSessionIdentity {
            agent_type: "opencode".to_string(),
            session_id: "current".to_string(),
            parent_session_id: Some("parent".to_string()),
        };
        assert_eq!(from_http_headers(&headers), Some(expected.clone()));
        assert_eq!(
            from_header_json(
                r#"{
                    "User-Agent":"opencode/1.0",
                    "x-session-affinity":"legacy",
                    "x-session-id":"current",
                    "x-parent-session-id":"parent"
                }"#,
            ),
            Some(expected),
        );
    }

    #[test]
    fn pi_session_requires_the_client_marker_on_both_paths() {
        let mut headers = HeaderMap::new();
        headers.insert(AGENT_SESSION_HEADER, HeaderValue::from_static("pi-session"));
        assert_eq!(from_http_headers(&headers), None);
        assert_eq!(
            from_header_json(r#"{"x-flowlet-session":"pi-session"}"#),
            None,
        );

        headers.insert(AGENT_CLIENT_HEADER, HeaderValue::from_static("pi"));
        let expected = AgentSessionIdentity {
            agent_type: "pi".to_string(),
            session_id: "pi-session".to_string(),
            parent_session_id: None,
        };
        assert_eq!(from_http_headers(&headers), Some(expected.clone()));
        assert_eq!(
            from_header_json(r#"{"X-Flowlet-Client":"pi","X-Flowlet-Session":"pi-session"}"#,),
            Some(expected),
        );
    }

    #[test]
    fn redacted_and_oversized_session_ids_are_rejected() {
        assert_eq!(
            from_header_json(r#"{"x-claude-code-session-id":"[redacted]"}"#),
            None,
        );
        let oversized = "x".repeat(MAX_AGENT_SESSION_ID_BYTES + 1);
        let json = serde_json::json!({
            "x-claude-code-session-id": oversized,
        })
        .to_string();
        assert_eq!(from_header_json(&json), None);
    }
}
