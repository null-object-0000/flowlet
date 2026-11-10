use super::proxy_http::FilesApiOp;
use super::proxy_routing::rank_candidates_by_score;
use super::*;
use crate::core::config::{AuthStrategy, ChannelModel, RequestLogRow, UaClientRule};
use axum::{
    http::{header, HeaderValue, Uri},
    routing::post,
};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

#[test]
fn protocol_type_from_path_identifies_anthropic() {
    assert_eq!(
        ProtocolType::from_path("/anthropic/v1/messages"),
        Some(ProtocolType::Anthropic)
    );
    assert_eq!(
        ProtocolType::from_path("/anthropic/v1/models"),
        Some(ProtocolType::Anthropic)
    );
}

#[test]
fn protocol_type_from_path_identifies_openai() {
    assert_eq!(
        ProtocolType::from_path("/v1/chat/completions"),
        Some(ProtocolType::OpenAi)
    );
    assert_eq!(
        ProtocolType::from_path("/openai/v1/chat/completions"),
        Some(ProtocolType::OpenAi)
    );
}

#[test]
fn recognizes_openai_model_detail_paths_only() {
    assert_eq!(
        model_detail_request_id(&Method::GET, "/v1/models/deepseek-v4-pro?locale=zh"),
        Some("deepseek-v4-pro".to_string())
    );
    assert_eq!(
        model_detail_request_id(&Method::GET, "/openai/v1/models/deepseek-v4-pro"),
        Some("deepseek-v4-pro".to_string())
    );
    assert_eq!(
        model_detail_request_id(&Method::POST, "/v1/models/deepseek-v4-pro"),
        None
    );
    assert_eq!(
        model_detail_request_id(&Method::GET, "/anthropic/v1/models/deepseek-v4-pro"),
        None
    );
}

#[test]
fn model_detail_price_selection_respects_effective_and_daily_ranges() {
    let model = serde_json::json!({
        "prices": [
            {"market":"china","currency":"CNY","rateType":"standard","input":{"standard":1},"output":2,"effectiveTo":"2026-08-17T00:00:00+08:00"},
            {"market":"china","currency":"CNY","rateType":"standard","input":{"standard":1.5},"output":4.5,"effectiveFrom":"2026-08-17T00:00:00+08:00","dailyTimeRange":{"label":"空闲时段","timeZone":"Asia/Shanghai","intervals":[{"start":"00:00","end":"09:00"},{"start":"12:00","end":"14:00"},{"start":"18:00","end":"00:00"}]}},
            {"market":"china","currency":"CNY","rateType":"standard","input":{"standard":3},"output":9,"effectiveFrom":"2026-08-17T00:00:00+08:00","dailyTimeRange":{"label":"高峰时段","timeZone":"Asia/Shanghai","intervals":[{"start":"09:00","end":"12:00"},{"start":"14:00","end":"18:00"}]}}
        ]
    });
    let at = |value: &str| {
        chrono::DateTime::parse_from_rfc3339(value)
            .unwrap()
            .with_timezone(&chrono::Utc)
    };
    assert_eq!(
        proxy_http::select_models_cn_price(&model, at("2026-08-16T15:59:59Z")).unwrap()["output"],
        2
    );
    assert_eq!(
        proxy_http::select_models_cn_price(&model, at("2026-08-17T00:59:59Z")).unwrap()["output"],
        4.5
    );
    assert_eq!(
        proxy_http::select_models_cn_price(&model, at("2026-08-17T01:00:00Z")).unwrap()["output"],
        9
    );
}

#[tokio::test]
async fn model_detail_prefers_upstream_limits_and_falls_back_to_models_cn() {
    let routes = vec![RouteCandidate {
        id: "route-detail".to_string(),
        virtual_model_id: "deepseek-v4-pro".to_string(),
        channel_id: "deepseek".to_string(),
        account_id: "account-detail".to_string(),
        upstream_model: "deepseek-v4-pro".to_string(),
        client_protocol: ProtocolType::OpenAi,
        enabled: true,
        created_at: "2026-01-01T00:00:00Z".to_string(),
        ..Default::default()
    }];
    let accounts = vec![ChannelAccount {
        id: "account-detail".to_string(),
        channel_id: "deepseek".to_string(),
        api_key: "key".to_string(),
        enabled: true,
        ..Default::default()
    }];
    let channels = vec![ChannelPreset {
        id: "deepseek".to_string(),
        vendor: "deepseek".to_string(),
        supported_protocols: vec![ProtocolType::OpenAi, ProtocolType::Anthropic],
        enabled: true,
        ..Default::default()
    }];
    let channel_models = vec![ChannelModel {
        id: "deepseek-deepseek-v4-pro".to_string(),
        channel_id: "deepseek".to_string(),
        model: "deepseek-v4-pro".to_string(),
        display_name: None,
        supported_protocols: vec![ProtocolType::OpenAi],
        context_window: Some(900_000),
        max_output_tokens: None,
        pricing: None,
        supports_stream: true,
        enabled: true,
        source: "synced".to_string(),
        synced_at: None,
        created_at: String::new(),
        updated_at: String::new(),
    }];
    let catalog = serde_json::json!({
        "providers": [{
            "id": "deepseek",
            "sources": [{"kind":"pricing", "retrievedAt":"2026-08-12T01:02:03Z"}],
            "models": [{
                "id": "deepseek-v4-pro",
                "limits": {"contextTokens": 1000000, "maxOutputTokens": 384000},
                "prices": [{
                    "market":"china", "currency":"CNY", "unit":"1M_tokens",
                    "rateType":"promotional", "input":{"standard":2.0}, "output":8.0,
                    "sourceUrl":"https://example.test/pricing"
                }]
            }]
        }]
    })
    .to_string();

    let response = build_model_detail_response(
        "deepseek-v4-pro",
        &routes,
        &accounts,
        &channels,
        &channel_models,
        Some(&catalog),
    );
    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(value["context_window"], 900_000);
    assert_eq!(value["max_output_tokens"], 384_000);
    assert_eq!(value["max_input_tokens"], serde_json::Value::Null);
    assert_eq!(value["specification_source"], "upstream+models-cn");
    assert_eq!(value["pricing"][0]["currency"], "CNY");
    assert_eq!(
        value["pricing"][0]["input"]["cache_hit"],
        serde_json::Value::Null
    );
    assert_eq!(value["pricing"][0]["retrieved_at"], "2026-08-12T01:02:03Z");
}

#[tokio::test]
async fn model_detail_returns_openai_not_found_for_unexposed_model() {
    let response = build_model_detail_response("deepseek-v4-pro", &[], &[], &[], &[], None);
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(value["error"]["code"], "model_not_found");
}

#[tokio::test]
async fn model_detail_prefers_raw_upstream_pricing() {
    let routes = vec![RouteCandidate {
        virtual_model_id: "LongCat-2.0".to_string(),
        channel_id: "longcat".to_string(),
        account_id: "account-longcat".to_string(),
        upstream_model: "LongCat-2.0".to_string(),
        client_protocol: ProtocolType::OpenAi,
        enabled: true,
        ..Default::default()
    }];
    let accounts = vec![ChannelAccount {
        id: "account-longcat".to_string(),
        channel_id: "longcat".to_string(),
        api_key: "key".to_string(),
        enabled: true,
        ..Default::default()
    }];
    let channels = vec![ChannelPreset {
        id: "longcat".to_string(),
        vendor: "longcat".to_string(),
        supported_protocols: vec![ProtocolType::OpenAi, ProtocolType::Anthropic],
        enabled: true,
        ..Default::default()
    }];
    let channel_models = vec![ChannelModel {
        id: "longcat-LongCat-2.0".to_string(),
        channel_id: "longcat".to_string(),
        model: "LongCat-2.0".to_string(),
        display_name: None,
        supported_protocols: vec![ProtocolType::OpenAi],
        context_window: Some(1_048_576),
        max_output_tokens: None,
        pricing: Some(serde_json::json!({"prompt":"2", "completion":"8"})),
        supports_stream: true,
        enabled: true,
        source: "synced".to_string(),
        synced_at: None,
        created_at: String::new(),
        updated_at: String::new(),
    }];
    let catalog = serde_json::json!({
        "providers": [{"id":"longcat", "models":[{
            "id":"LongCat-2.0",
            "limits":{"maxOutputTokens":131072},
            "prices":[{"market":"china", "currency":"CNY", "unit":"1M_tokens", "rateType":"standard", "input":{"standard":99}, "output":99}]
        }]}]
    }).to_string();

    let response = build_model_detail_response(
        "LongCat-2.0",
        &routes,
        &accounts,
        &channels,
        &channel_models,
        Some(&catalog),
    );
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(value["pricing"][0]["source"], "upstream");
    assert_eq!(value["pricing"][0]["raw"]["prompt"], "2");
    assert!(value["pricing"][0].get("currency").is_none());
}

#[test]
fn extracts_opencode_session_with_precedence_and_parent() {
    let mut headers = HeaderMap::new();
    headers.insert(
        "user-agent",
        HeaderValue::from_static("opencode/local runtime/node.js/24"),
    );
    headers.insert(
        "x-session-affinity",
        HeaderValue::from_static("legacy-session"),
    );
    headers.insert("x-session-id", HeaderValue::from_static("ses_current"));
    headers.insert(
        "x-parent-session-id",
        HeaderValue::from_static("ses_parent"),
    );

    assert_eq!(
        extract_agent_session(&headers),
        Some(AgentSessionIdentity {
            agent_type: "opencode".to_string(),
            session_id: "ses_current".to_string(),
            parent_session_id: Some("ses_parent".to_string()),
        })
    );
}

#[test]
fn ignores_generic_session_header_without_opencode_identity() {
    let mut headers = HeaderMap::new();
    headers.insert("user-agent", HeaderValue::from_static("another-agent/1.0"));
    headers.insert("x-session-id", HeaderValue::from_static("ses_other"));
    assert_eq!(extract_agent_session(&headers), None);
}

#[test]
fn extracts_claude_code_session_from_official_header() {
    let mut headers = HeaderMap::new();
    headers.insert("user-agent", HeaderValue::from_static("claude-cli/2.1.207"));
    headers.insert(
        "x-claude-code-session-id",
        HeaderValue::from_static("claude-session-123"),
    );

    assert_eq!(
        extract_agent_session(&headers),
        Some(AgentSessionIdentity {
            agent_type: "claude-code".to_string(),
            session_id: "claude-session-123".to_string(),
            parent_session_id: None,
        })
    );
}

#[test]
fn extracts_pi_session_only_with_client_marker() {
    let mut headers = HeaderMap::new();
    // Pi 走 OpenAI 兼容 SDK，UA 是通用的 OpenAI/JS，必须靠标记头识别。
    headers.insert("user-agent", HeaderValue::from_static("OpenAI/JS 4.90.0"));
    headers.insert("x-flowlet-client", HeaderValue::from_static("pi"));
    headers.insert(
        "x-flowlet-session",
        HeaderValue::from_static("pi-session-abc"),
    );

    assert_eq!(
        extract_agent_session(&headers),
        Some(AgentSessionIdentity {
            agent_type: "pi".to_string(),
            session_id: "pi-session-abc".to_string(),
            parent_session_id: None,
        })
    );
}

#[test]
fn ignores_pi_session_header_without_client_marker() {
    let mut headers = HeaderMap::new();
    headers.insert("user-agent", HeaderValue::from_static("OpenAI/JS 4.90.0"));
    // 没有 x-flowlet-client: pi 标记头时，x-flowlet-session 不应被读取，
    // 避免其他客户端的同名头被误归为 Pi 会话。
    headers.insert(
        "x-flowlet-session",
        HeaderValue::from_static("pi-session-abc"),
    );

    assert_eq!(extract_agent_session(&headers), None);
}

#[test]
fn ignores_pi_session_header_with_non_pi_client_marker() {
    let mut headers = HeaderMap::new();
    headers.insert("user-agent", HeaderValue::from_static("OpenAI/JS 4.90.0"));
    headers.insert("x-flowlet-client", HeaderValue::from_static("other"));
    headers.insert(
        "x-flowlet-session",
        HeaderValue::from_static("pi-session-abc"),
    );

    assert_eq!(extract_agent_session(&headers), None);
}

#[test]
fn protocol_type_from_path_returns_none_for_health() {
    assert_eq!(ProtocolType::from_path("/health"), None);
}

#[test]
fn protocol_type_from_path_keeps_openai_for_responses_subpath() {
    // from_path 是粗分类器，responses 的精确识别交给 is_responses_path
    assert_eq!(
        ProtocolType::from_path("/v1/responses"),
        Some(ProtocolType::OpenAi)
    );
}

#[test]
fn is_responses_path_detects_responses_entry_paths() {
    assert!(ProtocolType::is_responses_path("/v1/responses"));
    assert!(ProtocolType::is_responses_path("/openai/v1/responses"));
    assert!(ProtocolType::is_responses_path("/responses"));
    assert!(ProtocolType::is_responses_path("/v1/responses/resp_1"));
    assert!(ProtocolType::is_responses_path(
        "/openai/v1/responses/resp_1"
    ));
    assert!(ProtocolType::is_responses_path(
        "/v1/responses/resp_1/input_items"
    ));
    assert!(ProtocolType::is_responses_path("/v1/responses?stream=true"));
}

#[test]
fn is_responses_path_rejects_other_paths() {
    assert!(!ProtocolType::is_responses_path("/v1/chat/completions"));
    assert!(!ProtocolType::is_responses_path("/v1/models"));
    assert!(!ProtocolType::is_responses_path("/health"));
    assert!(!ProtocolType::is_responses_path("/anthropic/v1/messages"));
    assert!(!ProtocolType::is_responses_path("/v1/responsesfoo"));
}

#[test]
fn rewrite_model_maps_openai_public_name() {
    let body = br#"{"model":"auto","messages":[]}"#;
    let rewritten = rewrite_model(body, "qwen-plus", &ProtocolType::OpenAi);
    let value: serde_json::Value = serde_json::from_slice(&rewritten).unwrap();
    assert_eq!(value["model"], "qwen-plus");
    assert_eq!(value["messages"], serde_json::json!([]));
}

#[test]
fn rewrite_model_maps_anthropic_public_name() {
    let body = br#"{"model":"auto","max_tokens":100,"messages":[]}"#;
    let rewritten = rewrite_model(body, "claude-sonnet-4-20250514", &ProtocolType::Anthropic);
    let value: serde_json::Value = serde_json::from_slice(&rewritten).unwrap();
    assert_eq!(value["model"], "claude-sonnet-4-20250514");
}

#[test]
fn rewrite_model_replaces_public_model_name() {
    let body = br#"{"model":"deepseek-chat","messages":[]}"#;
    let rewritten = rewrite_model(body, "qwen-plus", &ProtocolType::OpenAi);
    let value: serde_json::Value = serde_json::from_slice(&rewritten).unwrap();
    assert_eq!(value["model"], "qwen-plus");
}

#[test]
fn ensure_reasoning_content_passback_injects_empty_for_deepseek_reasoning() {
    let body = br#"{
        "model": "deepseek-v4-pro",
        "messages": [
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "hi"},
            {"role": "assistant", "content": "previous reply"},
            {"role": "assistant", "content": "with thinking", "reasoning_content": "thought"},
            {"role": "tool", "tool_call_id": "t1", "content": "out"}
        ]
    }"#;
    let rewritten =
        ensure_reasoning_content_passback(body, "deepseek-v4-flash", &ProtocolType::OpenAi);
    let value: serde_json::Value = serde_json::from_slice(&rewritten).unwrap();
    let messages = value["messages"].as_array().unwrap();
    // 缺失字段的 assistant 消息补空串
    assert_eq!(messages[2]["reasoning_content"], "");
    // 已存在的 reasoning_content 不被改写
    assert_eq!(messages[3]["reasoning_content"], "thought");
    // system / user / tool 消息不触碰
    assert!(messages[0].get("reasoning_content").is_none());
    assert!(messages[1].get("reasoning_content").is_none());
    assert!(messages[4].get("reasoning_content").is_none());
    // 本变换不动 model 字段
    assert_eq!(value["model"], "deepseek-v4-pro");
}

#[test]
fn ensure_reasoning_content_passback_skips_non_deepseek_and_other_protocols() {
    let body = br#"{"model":"m","messages":[{"role":"assistant","content":"hi"}]}"#;
    // 非 DeepSeek 模型：原样透传
    for model in ["qwen3.7-max", "LongCat-2.0", "kimi-k3", "glm-5.2"] {
        let unchanged = ensure_reasoning_content_passback(body, model, &ProtocolType::OpenAi);
        assert_eq!(unchanged, body.to_vec(), "model {model} 不应触发补全");
    }
    // 非 OpenAI 协议：即使模型是 DeepSeek 也原样透传
    let unchanged =
        ensure_reasoning_content_passback(body, "deepseek-v4-flash", &ProtocolType::Anthropic);
    assert_eq!(unchanged, body.to_vec());
    // 所有 assistant 已带字段：原样透传
    let complete =
        br#"{"model":"m","messages":[{"role":"assistant","content":"hi","reasoning_content":""}]}"#;
    let unchanged =
        ensure_reasoning_content_passback(complete, "deepseek-v4-flash", &ProtocolType::OpenAi);
    assert_eq!(unchanged, complete.to_vec());
    // 空 messages / 无 messages / 非法 JSON：原样透传
    let cases: &[&[u8]] = &[
        br#"{"model":"m","messages":[]}"#,
        br#"{"model":"m","input":"text"}"#,
        b"not json",
    ];
    for case in cases {
        let unchanged =
            ensure_reasoning_content_passback(case, "deepseek-v4-flash", &ProtocolType::OpenAi);
        assert_eq!(unchanged, *case);
    }
    // 变体 / 带厂商前缀的上游模型 ID：canonical 归一后命中
    for variant in [
        "deepseek-v4-flash-0731",
        "deepseek/deepseek-v4-flash",
        "deepseek-v4-flash-vision-exp",
        "deepseek-v4.1-flash",
        "deepseek-flash",
        "deepseek-v4-pro",
    ] {
        let rewritten = ensure_reasoning_content_passback(body, variant, &ProtocolType::OpenAi);
        let value: serde_json::Value = serde_json::from_slice(&rewritten).unwrap();
        assert_eq!(
            value["messages"][0]["reasoning_content"], "",
            "variant {variant} 应触发补全"
        );
    }
}

#[test]
fn ensure_anthropic_thinking_passback_injects_empty_thinking_in_current_turn() {
    let body = br#"{
        "model": "deepseek-flash",
        "thinking": {"type": "enabled"},
        "system": "sys",
        "messages": [
            {"role": "user", "content": [{"type": "text", "text": "run it"}]},
            {"role": "assistant", "content": [
                {"type": "tool_use", "id": "t1", "name": "bash", "input": {"command": "echo hi"}}
            ]},
            {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "t1", "content": [{"type": "text", "text": "hi"}]}
            ]},
            {"role": "assistant", "content": [
                {"type": "thinking", "thinking": "already here", "signature": "sig"},
                {"type": "tool_use", "id": "t2", "name": "bash", "input": {"command": "pwd"}}
            ]},
            {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "t2", "content": [{"type": "text", "text": "/tmp"}]}
            ]},
            {"role": "assistant", "content": [{"type": "text", "text": "done"}]}
        ]
    }"#;
    let rewritten =
        ensure_anthropic_thinking_passback(body, "deepseek-flash", &ProtocolType::Anthropic);
    assert_ne!(rewritten, body.to_vec(), "缺失 thinking 块时应触发补全");
    let value: serde_json::Value = serde_json::from_slice(&rewritten).unwrap();
    let messages = value["messages"].as_array().unwrap();
    // 当前用户轮内缺失 thinking 的 assistant 消息：空 thinking 块放在内容最前
    assert_eq!(messages[1]["content"][0]["type"], "thinking");
    assert_eq!(messages[1]["content"][0]["thinking"], "");
    // 原有工具块与参数保持原样
    assert_eq!(messages[1]["content"][1]["type"], "tool_use");
    assert_eq!(messages[1]["content"][1]["id"], "t1");
    assert_eq!(messages[1]["content"][1]["input"]["command"], "echo hi");
    // 已有 thinking 块（含 signature）不被改写、不重复追加
    assert_eq!(messages[3]["content"].as_array().unwrap().len(), 2);
    assert_eq!(messages[3]["content"][0]["thinking"], "already here");
    assert_eq!(messages[3]["content"][0]["signature"], "sig");
    // 文本型 assistant 消息同样补齐，文本块保留
    assert_eq!(messages[5]["content"][0]["type"], "thinking");
    assert_eq!(messages[5]["content"][1]["type"], "text");
    assert_eq!(messages[5]["content"][1]["text"], "done");
    // 其余消息与顶层字段不变
    assert_eq!(messages[0]["content"][0]["type"], "text");
    assert_eq!(value["model"], "deepseek-flash");
    assert_eq!(value["thinking"]["type"], "enabled");
    assert_eq!(value["system"], "sys");
}

#[test]
fn ensure_anthropic_thinking_passback_skips_completed_turns_and_existing_thinking() {
    let body = br#"{
        "model": "deepseek-v4.1-flash",
        "thinking": {"type": "enabled"},
        "messages": [
            {"role": "user", "content": [{"type": "text", "text": "old turn"}]},
            {"role": "assistant", "content": [
                {"type": "tool_use", "id": "t1", "name": "bash", "input": {}}
            ]},
            {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "t1", "content": [{"type": "text", "text": "ok"}]}
            ]},
            {"role": "user", "content": [{"type": "text", "text": "new turn"}]},
            {"role": "assistant", "content": [
                {"type": "thinking", "thinking": "", "signature": ""},
                {"type": "tool_use", "id": "t2", "name": "bash", "input": {}}
            ]}
        ]
    }"#;
    let rewritten =
        ensure_anthropic_thinking_passback(body, "deepseek-v4.1-flash", &ProtocolType::Anthropic);
    // 旧轮次缺失 thinking 不改写，当前轮已带 thinking：整包原样透传
    assert_eq!(rewritten, body.to_vec());

    // 最后一条用户消息是 tool_result（无 text 块）时，工具调用链仍属于同一用户轮
    let tool_chain = br#"{
        "model": "deepseek-flash",
        "thinking": {"type": "enabled"},
        "messages": [
            {"role": "user", "content": [
                {"type": "text", "text": "start"},
                {"type": "tool_result", "tool_use_id": "t0", "content": []}
            ]},
            {"role": "assistant", "content": [
                {"type": "tool_use", "id": "t1", "name": "bash", "input": {}}
            ]}
        ]
    }"#;
    let rewritten =
        ensure_anthropic_thinking_passback(tool_chain, "deepseek-flash", &ProtocolType::Anthropic);
    let value: serde_json::Value = serde_json::from_slice(&rewritten).unwrap();
    assert_eq!(value["messages"][1]["content"][0]["type"], "thinking");
    assert_eq!(value["messages"][1]["content"][0]["thinking"], "");
    assert_eq!(value["messages"][1]["content"][1]["type"], "tool_use");

    // Anthropic 允许 user 消息 content 直接用字符串，也视为用户轮起点
    let string_user_turn = br#"{
        "model": "deepseek-flash",
        "thinking": {"type": "enabled"},
        "messages": [
            {"role": "user", "content": "old"},
            {"role": "assistant", "content": [{"type": "tool_use", "id": "t1", "name": "bash", "input": {}}]},
            {"role": "user", "content": "new"}
        ]
    }"#;
    let unchanged = ensure_anthropic_thinking_passback(
        string_user_turn,
        "deepseek-flash",
        &ProtocolType::Anthropic,
    );
    assert_eq!(unchanged, string_user_turn.to_vec());
    let string_user_current = br#"{
        "model": "deepseek-flash",
        "thinking": {"type": "enabled"},
        "messages": [
            {"role": "user", "content": "start"},
            {"role": "assistant", "content": [{"type": "tool_use", "id": "t1", "name": "bash", "input": {}}]}
        ]
    }"#;
    let rewritten = ensure_anthropic_thinking_passback(
        string_user_current,
        "deepseek-flash",
        &ProtocolType::Anthropic,
    );
    let value: serde_json::Value = serde_json::from_slice(&rewritten).unwrap();
    assert_eq!(value["messages"][1]["content"][0]["type"], "thinking");
}

#[test]
fn ensure_anthropic_thinking_passback_skips_inapplicable_requests() {
    let body = br#"{
        "model": "m",
        "thinking": {"type": "enabled"},
        "messages": [
            {"role": "user", "content": [{"type": "text", "text": "hi"}]},
            {"role": "assistant", "content": [{"type": "tool_use", "id": "t1", "name": "bash", "input": {}}]}
        ]
    }"#;
    // 非 DeepSeek 上游模型：原样透传
    for model in [
        "qwen3.7-max",
        "LongCat-2.0",
        "kimi-k3",
        "glm-5.2",
        "gpt-6.1-sol",
    ] {
        let unchanged = ensure_anthropic_thinking_passback(body, model, &ProtocolType::Anthropic);
        assert_eq!(unchanged, body.to_vec(), "model {model} 不应触发补全");
    }
    // 非 Anthropic 协议：即使模型是 DeepSeek 也原样透传
    for protocol in [ProtocolType::OpenAi, ProtocolType::Responses] {
        let unchanged = ensure_anthropic_thinking_passback(body, "deepseek-v4-flash", &protocol);
        assert_eq!(unchanged, body.to_vec());
    }
    // thinking 未声明 / disabled：原样透传
    let no_thinking = br#"{"model":"deepseek-flash","messages":[{"role":"assistant","content":[{"type":"tool_use","id":"t","name":"bash","input":{}}]}]}"#;
    let unchanged =
        ensure_anthropic_thinking_passback(no_thinking, "deepseek-flash", &ProtocolType::Anthropic);
    assert_eq!(unchanged, no_thinking.to_vec());
    let disabled = br#"{"model":"deepseek-flash","thinking":{"type":"disabled"},"messages":[{"role":"assistant","content":[{"type":"tool_use","id":"t","name":"bash","input":{}}]}]}"#;
    let unchanged =
        ensure_anthropic_thinking_passback(disabled, "deepseek-flash", &ProtocolType::Anthropic);
    assert_eq!(unchanged, disabled.to_vec());
    // 空 messages / 无 messages / 非法 JSON：原样透传
    let cases: &[&[u8]] = &[
        br#"{"model":"deepseek-flash","thinking":{"type":"enabled"},"messages":[]}"#,
        br#"{"model":"deepseek-flash","thinking":{"type":"enabled"},"input":"text"}"#,
        b"not json",
    ];
    for case in cases {
        let unchanged =
            ensure_anthropic_thinking_passback(case, "deepseek-flash", &ProtocolType::Anthropic);
        assert_eq!(unchanged, *case);
    }
    // 变体 / 别名上游模型 ID：canonical 归一后命中
    for variant in [
        "deepseek-flash",
        "deepseek-v4.1-flash",
        "deepseek-v4.1-flash-1017",
        "deepseek/deepseek-v4-flash",
        "deepseek-v4-pro",
    ] {
        let rewritten = ensure_anthropic_thinking_passback(body, variant, &ProtocolType::Anthropic);
        let value: serde_json::Value = serde_json::from_slice(&rewritten).unwrap();
        assert_eq!(
            value["messages"][1]["content"][0]["type"], "thinking",
            "variant {variant} 应触发补全"
        );
    }
}

#[test]
fn should_try_next_status_handles_deepseek_402() {
    assert!(should_try_next_status(
        reqwest::StatusCode::PAYMENT_REQUIRED,
        "deepseek"
    ));
    assert!(!should_try_next_status(
        reqwest::StatusCode::PAYMENT_REQUIRED,
        "longcat"
    ));
}

#[test]
fn should_try_next_status_for_rate_limit_and_server_errors() {
    assert!(should_try_next_status(
        reqwest::StatusCode::TOO_MANY_REQUESTS,
        "longcat"
    ));
    assert!(should_try_next_status(
        reqwest::StatusCode::BAD_GATEWAY,
        "longcat"
    ));
    assert!(should_try_next_status(
        reqwest::StatusCode::INTERNAL_SERVER_ERROR,
        "longcat"
    ));
    assert!(should_try_next_status(
        reqwest::StatusCode::SERVICE_UNAVAILABLE,
        "longcat"
    ));
}

#[test]
fn should_not_try_next_for_client_errors() {
    assert!(!should_try_next_status(
        reqwest::StatusCode::BAD_REQUEST,
        "longcat"
    ));
    assert!(!should_try_next_status(
        reqwest::StatusCode::UNAUTHORIZED,
        "longcat"
    ));
    assert!(!should_try_next_status(
        reqwest::StatusCode::PAYLOAD_TOO_LARGE,
        "longcat"
    ));
}

#[test]
fn inspects_fallback_body_for_supported_client_error_statuses() {
    assert!(should_inspect_fallback_body(
        reqwest::StatusCode::BAD_REQUEST
    ));
    assert!(should_inspect_fallback_body(
        reqwest::StatusCode::PAYMENT_REQUIRED
    ));
    assert!(should_inspect_fallback_body(reqwest::StatusCode::FORBIDDEN));
    assert!(!should_inspect_fallback_body(
        reqwest::StatusCode::UNPROCESSABLE_ENTITY
    ));
}

#[test]
fn detects_quota_exceeded_messages() {
    assert!(body_contains_quota_exceeded(
        br#"{"error":{"message":"You exceeded your current quota"}}"#
    ));
    assert!(body_contains_quota_exceeded(
        br#"{"error":"insufficient quota"}"#
    ));
    assert!(body_contains_quota_exceeded(
        br#"{"error":"balance insufficient"}"#
    ));
    assert!(!body_contains_quota_exceeded(
        br#"{"error":"context length exceeded"}"#
    ));
}

#[test]
fn detects_product_not_activated_without_retrying_other_bad_requests() {
    assert!(body_contains_product_not_activated(
        br#"{"error":{"message":"The product is not activated, please confirm that you have activated products and try again after activation.","type":"invalid_request_error","param":"","code":"invalid_parameter_error"}}"#
    ));
    assert!(!body_contains_product_not_activated(
        br#"{"error":{"message":"Invalid max_tokens","type":"invalid_request_error","code":"invalid_parameter_error"}}"#
    ));
    assert!(!body_contains_product_not_activated(
        br#"{"error":{"message":"The product is not activated","code":"another_error"}}"#
    ));
}

#[test]
fn detects_deactivated_account_errors() {
    assert!(body_contains_account_deactivated(
        br#"{"error":{"message":"api key is disabled","type":"authentication_error","code":"account_deactivated"}}"#
    ));
    assert!(body_contains_account_deactivated(
        br#"{"error":{"message":"API KEY IS DISABLED"}}"#
    ));
    assert!(!body_contains_account_deactivated(
        br#"{"error":{"message":"invalid request","code":"invalid_request"}}"#
    ));
}

#[test]
fn identifies_client_from_bearer_token() {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::AUTHORIZATION,
        HeaderValue::from_static("Bearer token-a"),
    );
    let default_token = "token-a";

    assert_eq!(
        identify_client(&headers, default_token),
        Some(("default".to_string(), "默认客户端".to_string()))
    );
}

#[test]
fn identifies_client_from_x_api_key() {
    let mut headers = HeaderMap::new();
    headers.insert("x-api-key", HeaderValue::from_static("token-x"));
    let default_token = "token-x";

    assert_eq!(
        identify_client(&headers, default_token),
        Some(("default".to_string(), "默认客户端".to_string()))
    );
}

#[test]
fn rejects_unknown_token() {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::AUTHORIZATION,
        HeaderValue::from_static("Bearer unknown-token"),
    );
    assert_eq!(identify_client(&headers, "my-default-token"), None);
}

#[test]
fn identifies_client_by_ua_substring() {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::USER_AGENT,
        HeaderValue::from_static("opencode/local foo"),
    );
    let rules = vec![UaClientRule {
        id: "opencode".to_string(),
        pattern: "opencode/local".to_string(),
        name: "OpenCode".to_string(),
        enabled: true,
    }];

    assert_eq!(
        identify_client_by_ua(&headers, &rules),
        Some(("opencode".to_string(), "OpenCode".to_string()))
    );
}

#[test]
fn identifies_codex_desktop_and_cli_by_ua() {
    let rules = vec![
        UaClientRule {
            id: "codex".to_string(),
            pattern: "codex_cli_rs/".to_string(),
            name: "Codex".to_string(),
            enabled: true,
        },
        UaClientRule {
            id: "codex-desktop".to_string(),
            pattern: "Codex Desktop/".to_string(),
            name: "Codex Desktop".to_string(),
            enabled: true,
        },
    ];

    // Codex Desktop 的 UA 与 CLI 互不冲突：各自命中自己的规则。
    let mut desktop = HeaderMap::new();
    desktop.insert(
        header::USER_AGENT,
        HeaderValue::from_static(
            "Codex Desktop/0.146.0-alpha.3.1 (Windows 10.0.26200; x86_64) unknown",
        ),
    );
    assert_eq!(
        identify_client_by_ua(&desktop, &rules),
        Some(("codex-desktop".to_string(), "Codex Desktop".to_string()))
    );

    let mut cli = HeaderMap::new();
    cli.insert(
        header::USER_AGENT,
        HeaderValue::from_static("codex_cli_rs/0.40.0"),
    );
    assert_eq!(
        identify_client_by_ua(&cli, &rules),
        Some(("codex".to_string(), "Codex".to_string()))
    );
}

#[test]
fn ua_no_match_returns_none() {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::USER_AGENT,
        HeaderValue::from_static("completely-unknown-ua"),
    );
    let rules = vec![UaClientRule {
        id: "opencode".to_string(),
        pattern: "opencode/local".to_string(),
        name: "OpenCode".to_string(),
        enabled: true,
    }];

    // None 由调用方映射为 "未知"
    assert_eq!(identify_client_by_ua(&headers, &rules), None);
}

#[test]
fn ua_skip_disabled_and_empty_pattern() {
    let mut headers = HeaderMap::new();
    headers.insert(header::USER_AGENT, HeaderValue::from_static("anything"));
    let rules = vec![
        UaClientRule {
            id: "disabled".to_string(),
            pattern: "anything".to_string(),
            name: "禁用".to_string(),
            enabled: false,
        },
        UaClientRule {
            id: "empty".to_string(),
            pattern: String::new(),
            name: "空模式".to_string(),
            enabled: true,
        },
    ];

    assert_eq!(identify_client_by_ua(&headers, &rules), None);
}

#[test]
fn agent_marker_header_identifies_pi_and_beats_ua_rules() {
    let mut headers = HeaderMap::new();
    // Pi 走 OpenAI SDK，UA 是通用的 OpenAI/JS；标记头应优先归属为 Pi。
    headers.insert(
        header::USER_AGENT,
        HeaderValue::from_static("OpenAI/JS 6.26.0"),
    );
    headers.insert("x-flowlet-client", HeaderValue::from_static("pi"));
    let rules = vec![UaClientRule {
        id: "opencode".to_string(),
        pattern: "opencode/".to_string(),
        name: "OpenCode".to_string(),
        enabled: true,
    }];

    assert_eq!(
        identify_client_agent(&headers, &rules),
        Some(("pi".to_string(), "Pi".to_string()))
    );
}

#[test]
fn agent_marker_header_unknown_value_uses_value_as_name() {
    let mut headers = HeaderMap::new();
    headers.insert(
        "x-flowlet-client",
        HeaderValue::from_static("  FutureAgent  "),
    );

    assert_eq!(
        identify_client_agent(&headers, &[]),
        Some(("futureagent".to_string(), "FutureAgent".to_string()))
    );
}

#[test]
fn agent_marker_falls_back_to_ua_when_absent() {
    let mut headers = HeaderMap::new();
    headers.insert(header::USER_AGENT, HeaderValue::from_static("opencode/1.0"));
    let rules = vec![UaClientRule {
        id: "opencode".to_string(),
        pattern: "opencode/".to_string(),
        name: "OpenCode".to_string(),
        enabled: true,
    }];

    assert_eq!(
        identify_client_agent(&headers, &rules),
        Some(("opencode".to_string(), "OpenCode".to_string()))
    );
}

#[test]
fn identify_client_from_json_parses_case_insensitive_headers() {
    use super::super::proxy::identify_client_from_json;
    let rules = vec![UaClientRule {
        id: "opencode".to_string(),
        pattern: "opencode/".to_string(),
        name: "OpenCode".to_string(),
        enabled: true,
    }];

    // 历史 JSON 键名大小写不固定，应该都能识别
    let json_lower = r#"{"user-agent":"opencode/1.2.3"}"#;
    let json_upper = r#"{"User-Agent":"opencode/1.2.3"}"#;

    assert_eq!(
        identify_client_from_json(json_lower, &rules),
        Some(("opencode".to_string(), "OpenCode".to_string()))
    );
    assert_eq!(
        identify_client_from_json(json_upper, &rules),
        Some(("opencode".to_string(), "OpenCode".to_string()))
    );
}

#[test]
fn identify_client_from_json_respects_marker_header_priority() {
    use super::super::proxy::identify_client_from_json;
    let rules = vec![UaClientRule {
        id: "opencode".to_string(),
        pattern: "opencode/".to_string(),
        name: "OpenCode".to_string(),
        enabled: true,
    }];

    // x-flowlet-client 标记头应优先于 UA 规则
    let json_with_marker = r#"{"user-agent":"opencode/1.2.3","x-flowlet-client":"pi"}"#;
    assert_eq!(
        identify_client_from_json(json_with_marker, &rules),
        Some(("pi".to_string(), "Pi".to_string()))
    );
}

#[test]
fn identify_client_from_json_returns_none_for_invalid_json() {
    use super::super::proxy::identify_client_from_json;
    let rules = vec![UaClientRule {
        id: "opencode".to_string(),
        pattern: "opencode/".to_string(),
        name: "OpenCode".to_string(),
        enabled: true,
    }];

    assert_eq!(identify_client_from_json("not json", &rules), None);
    assert_eq!(identify_client_from_json("[]", &rules), None);
    assert_eq!(
        identify_client_from_json(r#"{"other":"value"}"#, &rules),
        None
    );
}

#[test]
fn extracts_openai_usage() {
    let usage = extract_response_usage(
        br#"{"id":"chatcmpl","usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}}"#,
    )
    .unwrap();

    assert_eq!(
        usage,
        ResponseUsage {
            input_tokens: Some(11),
            input_cached_tokens: None,
            input_uncached_tokens: None,
            input_cache_write_tokens: None,
            output_tokens: Some(7),
            total_tokens: Some(18),
        }
    );
}

#[test]
fn extracts_input_output_usage_and_computes_total() {
    let usage =
        extract_response_usage(br#"{"usage":{"input_tokens":5,"output_tokens":8}}"#).unwrap();

    assert_eq!(
        usage,
        ResponseUsage {
            input_tokens: Some(5),
            input_cached_tokens: None,
            input_uncached_tokens: None,
            input_cache_write_tokens: None,
            output_tokens: Some(8),
            total_tokens: Some(13),
        }
    );
}

#[test]
fn ignores_response_without_usage() {
    assert!(extract_response_usage(br#"{"id":"chatcmpl"}"#).is_none());
}

#[test]
fn decodes_compressed_buffered_usage_without_mutating_passthrough_bytes() {
    use flate2::{
        write::{DeflateEncoder, GzEncoder},
        Compression,
    };
    use std::io::Write;

    let plain = br#"{"type":"message","usage":{"input_tokens":1024,"output_tokens":440,"cache_creation_input_tokens":0,"cache_read_input_tokens":24576}}"#;

    let mut gzip = GzEncoder::new(Vec::new(), Compression::default());
    gzip.write_all(plain).unwrap();
    let gzip = gzip.finish().unwrap();

    let mut deflate = DeflateEncoder::new(Vec::new(), Compression::default());
    deflate.write_all(plain).unwrap();
    let deflate = deflate.finish().unwrap();

    let mut brotli = brotli::CompressorWriter::new(Vec::new(), 4096, 5, 22);
    brotli.write_all(plain).unwrap();
    let brotli = brotli.into_inner();

    for (encoding, compressed) in [("gzip", gzip), ("deflate", deflate), ("br", brotli)] {
        let passthrough = compressed.clone();
        let decoded = decode_usage_body(compressed.clone(), Some(encoding)).unwrap();
        assert_eq!(compressed, passthrough);
        assert_eq!(decoded, plain);
        assert_eq!(
            extract_response_usage(&decoded),
            Some(ResponseUsage {
                input_tokens: Some(25_600),
                input_cached_tokens: Some(24_576),
                input_uncached_tokens: Some(1_024),
                input_cache_write_tokens: Some(0),
                output_tokens: Some(440),
                total_tokens: Some(26_040),
            })
        );
    }
}

#[test]
fn build_upstream_url_preserves_v1_prefix_for_openai() {
    let uri: Uri = "/v1/chat/completions".parse().unwrap();
    let url = build_upstream_url(
        "https://api.longcat.chat/openai",
        &uri,
        &ProtocolType::OpenAi,
    );
    assert_eq!(url, "https://api.longcat.chat/openai/v1/chat/completions");
}

#[test]
fn build_upstream_url_strips_openai_entry_prefix() {
    let uri: Uri = "/openai/v1/chat/completions".parse().unwrap();
    let url = build_upstream_url(
        "https://api.longcat.chat/openai",
        &uri,
        &ProtocolType::OpenAi,
    );
    assert_eq!(url, "https://api.longcat.chat/openai/v1/chat/completions");
}

#[test]
fn build_upstream_url_strips_anthropic_entry_prefix() {
    let uri: Uri = "/anthropic/v1/messages".parse().unwrap();
    let url = build_upstream_url(
        "https://api.longcat.chat/anthropic",
        &uri,
        &ProtocolType::Anthropic,
    );
    assert_eq!(url, "https://api.longcat.chat/anthropic/v1/messages");
}

#[test]
fn build_upstream_url_dedupes_v1_for_qwen_token_plan_base_url() {
    // token plan 账号级 Base URL 覆盖本身带 /v1，入站路径也带 /v1，不能拼成 /v1/v1
    let uri: Uri = "/v1/chat/completions".parse().unwrap();
    let url = build_upstream_url(
        "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
        &uri,
        &ProtocolType::OpenAi,
    );
    assert_eq!(
        url,
        "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions"
    );
}

#[test]
fn build_upstream_url_dedupes_v1_for_qwen_dashscope_base_url() {
    let uri: Uri = "/v1/chat/completions".parse().unwrap();
    let url = build_upstream_url(
        "https://dashscope.aliyuncs.com/compatible-mode/v1",
        &uri,
        &ProtocolType::OpenAi,
    );
    assert_eq!(
        url,
        "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
    );
}

#[test]
fn build_upstream_url_dedupes_v1_for_moonshot_base_url() {
    let uri: Uri = "/v1/chat/completions".parse().unwrap();
    let url = build_upstream_url("https://api.moonshot.cn/v1", &uri, &ProtocolType::OpenAi);
    assert_eq!(url, "https://api.moonshot.cn/v1/chat/completions");
}

#[test]
fn build_upstream_url_keeps_v1_in_base_when_path_has_no_v1() {
    // 入站路径不带 /v1 时，base 的尾随 /v1 必须保留
    let uri: Uri = "/chat/completions".parse().unwrap();
    let url = build_upstream_url("https://api.moonshot.cn/v1", &uri, &ProtocolType::OpenAi);
    assert_eq!(url, "https://api.moonshot.cn/v1/chat/completions");
}

#[test]
fn build_upstream_url_without_openai_v1_strips_v1_for_zhipu() {
    // 智谱官方 OpenAI 端点为 /api/paas/v4/chat/completions（无 /v1），
    // 通用 build_upstream_url 会拼出 /api/paas/v4/v1/chat/completions 的错误地址。
    let chat: Uri = "/v1/chat/completions".parse().unwrap();
    let url = build_upstream_url_without_openai_v1("https://open.bigmodel.cn/api/paas/v4", &chat);
    assert_eq!(url, "https://open.bigmodel.cn/api/paas/v4/chat/completions");

    // 模型列表路径同样去掉 /v1。
    let models: Uri = "/v1/models".parse().unwrap();
    let url = build_upstream_url_without_openai_v1("https://open.bigmodel.cn/api/paas/v4", &models);
    assert_eq!(url, "https://open.bigmodel.cn/api/paas/v4/models");

    // 防御性处理 /openai/v1 入口前缀。
    let prefixed: Uri = "/openai/v1/chat/completions".parse().unwrap();
    let url =
        build_upstream_url_without_openai_v1("https://open.bigmodel.cn/api/paas/v4", &prefixed);
    assert_eq!(url, "https://open.bigmodel.cn/api/paas/v4/chat/completions");
}

#[test]
fn openai_path_strips_v1_only_for_zhipu() {
    assert!(crate::core::channels_config::openai_path_strips_v1("zhipu"));
    for channel in ["longcat", "deepseek", "kimi", "qwen", "custom"] {
        assert!(
            !crate::core::channels_config::openai_path_strips_v1(channel),
            "{channel} 应保留 /v1 前缀"
        );
    }
}

#[test]
fn build_upstream_url_responses_for_longcat_base() {
    let uri: Uri = "/v1/responses".parse().unwrap();
    let url = build_upstream_url(
        "https://api.longcat.chat/openai",
        &uri,
        &ProtocolType::Responses,
    );
    assert_eq!(url, "https://api.longcat.chat/openai/v1/responses");
}

#[test]
fn build_upstream_url_responses_dedupes_v1_for_qwen_base() {
    let uri: Uri = "/v1/responses".parse().unwrap();
    let url = build_upstream_url(
        "https://dashscope.aliyuncs.com/compatible-mode/v1",
        &uri,
        &ProtocolType::Responses,
    );
    assert_eq!(
        url,
        "https://dashscope.aliyuncs.com/compatible-mode/v1/responses"
    );
}

#[test]
fn build_upstream_url_responses_for_deepseek_base() {
    let uri: Uri = "/v1/responses".parse().unwrap();
    let url = build_upstream_url("https://api.deepseek.com", &uri, &ProtocolType::Responses);
    assert_eq!(url, "https://api.deepseek.com/v1/responses");
}

#[test]
fn build_upstream_url_responses_strips_openai_entry_prefix() {
    let uri: Uri = "/openai/v1/responses".parse().unwrap();
    let url = build_upstream_url(
        "https://api.longcat.chat/openai",
        &uri,
        &ProtocolType::Responses,
    );
    assert_eq!(url, "https://api.longcat.chat/openai/v1/responses");
}

#[test]
fn build_upstream_url_responses_root_path_matches_deepseek_docs() {
    // 裸根路径入口（base_url 不带 /v1 的客户端）恰好拼出 DeepSeek
    // 官方文档的规范端点 https://api.deepseek.com/responses
    let uri: Uri = "/responses".parse().unwrap();
    let url = build_upstream_url("https://api.deepseek.com", &uri, &ProtocolType::Responses);
    assert_eq!(url, "https://api.deepseek.com/responses");
}

#[test]
fn enriches_final_upstream_error_metadata_without_body_rewrite() {
    let mut log = RequestLogInput {
        request_id: "req".to_string(),
        agent_type: None,
        agent_session_id: None,
        parent_agent_session_id: None,
        client_id: Some("client-default".to_string()),
        client_name: None,
        channel_id: Some("longcat".to_string()),
        channel_name: None,
        account_id: Some("acc-1".to_string()),
        account_name: None,
        client_protocol: "openai".to_string(),
        upstream_protocol: "openai".to_string(),
        virtual_model: Some("gpt-test".to_string()),
        public_model: Some("gpt-test".to_string()),
        upstream_model: Some("gpt-test".to_string()),
        request_type: "chat".to_string(),
        method: "POST".to_string(),
        path: "/v1/chat/completions".to_string(),
        upstream_url: None,
        upstream_proxy_used: None,
        status: Some(400),
        latency_ms: Some(1),
        is_stream: false,
        error_message: None,
        fallback_count: 0,
        route_reason: Some("direct".to_string()),
        ttfb_ms: None,
        duration_ms: None,
        attempt_seq: 0,
        req_headers_json: None,
        req_body_b64: None,
        res_headers_json: None,
        res_body_b64: None,
        is_last_attempt: true,
    };

    enrich_upstream_error_log(reqwest::StatusCode::BAD_REQUEST, &mut log);

    assert_eq!(log.error_message, Some("upstream status 400".to_string()));
    assert_eq!(log.route_reason, Some("upstream_error".to_string()));
}

#[tokio::test]
async fn forwards_status_headers_body_and_replaces_authorization() {
    let captured_auth = Arc::new(Mutex::new(None::<String>));
    let captured_auth_state = captured_auth.clone();
    let upstream = Router::new()
        .route(
            "/v1/chat/completions",
            post(
                |State(captured): State<Arc<Mutex<Option<String>>>>,
                 headers: HeaderMap,
                 body: Bytes| async move {
                    let auth = headers
                        .get(header::AUTHORIZATION)
                        .and_then(|value| value.to_str().ok())
                        .map(|value| value.to_string());
                    *captured.lock().unwrap() = auth;
                    (StatusCode::CREATED, [("x-upstream", "ok")], body)
                },
            ),
        )
        .with_state(captured_auth_state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, upstream).await.unwrap();
    });

    let storage = Storage::open(temp_db_path()).unwrap();
    let log_storage = storage.clone();
    let state = ProxyAppState {
        shared: ProxySharedConfig {
            runtime_config: RuntimeConfigStore::new(RuntimeConfigSnapshot::new(
                vec![ChannelPreset {
                    enabled: true,
                    id: "longcat".to_string(),
                    name: "LongCat".to_string(),
                    vendor: "longcat".to_string(),
                    supported_protocols: vec![ProtocolType::OpenAi, ProtocolType::Anthropic],
                    openai_base_url: format!("http://{upstream_addr}"),
                    anthropic_base_url: format!("http://{upstream_addr}"),
                    openai_auth: AuthStrategy::Bearer,
                    anthropic_auth: AuthStrategy::Bearer,
                    default_model: "LongCat-2.0".to_string(),
                    small_model: None,
                    timeout_seconds: None,
                    supports_model_list: false,
                    supports_model_detail: false,
                    supports_balance_query: false,
                    supports_quota_query: false,
                    supports_usage_query: false,
                    supports_scrape_balance: false,
                    supports_files_api: false,
                    platform_url: None,
                    created_at: String::new(),
                    updated_at: String::new(),
                }],
                vec![ChannelAccount {
                    workspace_account_id: None,
                    id: "acc-1".to_string(),
                    channel_id: "longcat".to_string(),
                    name: "主账号".to_string(),
                    api_key: "upstream-secret".to_string(),
                    management_key: None,
                    enabled: true,
                    priority: 0,
                    remark: None,
                    resource_mode: None,
                    resource_sync_mode: "manual".to_string(),
                    base_url_override: None,
                    use_upstream_proxy: None,
                    anthropic_base_url_override: None,
                    workspace_default_base_url: None,
                    workspace_default_anthropic_base_url: None,
                    last_used_at: None,
                    last_error: None,
                    credential_status: "healthy".to_string(),
                    synced_models: None,
                    models_synced_at: None,
                    exposed_models: None,
                    created_at: String::new(),
                    updated_at: String::new(),
                }],
                vec![RouteCandidate {
                    id: "route-1".to_string(),
                    virtual_model_id: "deepseek-v4-pro".to_string(),
                    channel_id: "longcat".to_string(),
                    account_id: "acc-1".to_string(),
                    upstream_model: "qwen/deepseek-v4-pro-0813".to_string(),
                    client_protocol: ProtocolType::OpenAi,
                    priority: 0,
                    enabled: true,
                    created_at: String::new(),
                    updated_at: String::new(),
                }],
                vec![],
                vec![],
            )),
            scores: Arc::new(Mutex::new(vec![])),
            round_robin: Arc::new(Mutex::new(std::collections::HashMap::new())),
        },
        client: Client::new(),
        storage,
        upstream_timeout_seconds: 120,
        rate_limiter: RateLimiter::new(600),
        capture: Arc::new(Mutex::new(LogCaptureConfig::default())),
        bind_config: Arc::new(Mutex::new(ProxyBindConfig::default())),
        activity: ActivityTracker::new(),
        config_path: std::path::PathBuf::from("/tmp/flowlet_test_config.json"),
    };

    let request = Request::builder()
        .method("POST")
        .uri("/v1/chat/completions")
        .header(header::AUTHORIZATION, "Bearer client-token")
        .header(header::CONTENT_TYPE, "application/json")
        // 模拟客户端旧长度；代理改写 model 后必须丢弃并按最终 body 重算。
        .header(header::CONTENT_LENGTH, "1")
        .body(Body::from(r#"{"model":"deepseek-v4-pro","messages":[]}"#))
        .unwrap();

    let response = forward_request(state, request, ProtocolType::OpenAi)
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    assert_eq!(
        response
            .headers()
            .get("x-upstream")
            .unwrap()
            .to_str()
            .unwrap(),
        "ok"
    );
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    assert_eq!(
        body,
        r#"{"model":"qwen/deepseek-v4-pro-0813","messages":[]}"#
    );
    assert_eq!(
        captured_auth.lock().unwrap().as_deref(),
        Some("Bearer upstream-secret")
    );
    let logs = tokio::time::timeout(std::time::Duration::from_secs(1), async {
        loop {
            let logs = log_storage.list_request_logs().unwrap();
            if !logs.is_empty() {
                break logs;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        logs[0].upstream_url.as_deref(),
        Some(format!("http://{upstream_addr}/v1/chat/completions").as_str())
    );
    let logged_headers: serde_json::Value =
        serde_json::from_str(logs[0].req_headers_json.as_deref().unwrap()).unwrap();
    assert_eq!(
        logged_headers["authorization"],
        serde_json::Value::String("Bearer upstream-secret".to_string())
    );
    assert_ne!(
        logged_headers["authorization"],
        serde_json::Value::String("Bearer client-token".to_string())
    );
    assert_eq!(
        logs[0].req_body_b64.as_deref(),
        Some(
            encode_body_base64(br#"{"model":"qwen/deepseek-v4-pro-0813","messages":[]}"#).as_str()
        )
    );
}

#[tokio::test]
async fn deepseek_reasoning_route_injects_reasoning_content_passback() {
    let captured_body = Arc::new(Mutex::new(Vec::<u8>::new()));
    let captured_body_state = captured_body.clone();
    let upstream = Router::new().route(
        "/v1/chat/completions",
        post(move |body: Bytes| async move {
            *captured_body_state.lock().unwrap() = body.to_vec();
            (
                StatusCode::OK,
                [("content-type", "application/json")],
                r#"{"id":"x","object":"chat.completion","model":"deepseek-v4-flash","choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}"#,
            )
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, upstream).await.unwrap();
    });

    let channel = dual_protocol_channel("deepseek", "DeepSeek", &format!("http://{addr}"));
    let state = build_test_state(
        vec![channel],
        vec![test_account("account", "deepseek", "key", 0)],
        vec![test_route(
            "route",
            "deepseek-v4-flash",
            "deepseek",
            "account",
            "deepseek-v4-flash-0731",
            ProtocolType::OpenAi,
            0,
        )],
    );

    let request = Request::builder()
        .method("POST")
        .uri("/v1/chat/completions")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            r#"{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"hi"},{"role":"assistant","content":"prev"}]}"#,
        ))
        .unwrap();

    let response = forward_request(state, request, ProtocolType::OpenAi)
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    // 消费响应体，避免资源悬挂。
    let _ = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();

    let captured = captured_body.lock().unwrap().clone();
    let value: serde_json::Value = serde_json::from_slice(&captured).unwrap();
    assert_eq!(value["model"], "deepseek-v4-flash-0731");
    assert!(
        value["messages"][0].get("reasoning_content").is_none(),
        "user 消息不应被补字段"
    );
    assert_eq!(
        value["messages"][1]["reasoning_content"], "",
        "assistant 消息应补空串"
    );
}

#[tokio::test]
async fn anthropic_thinking_route_injects_thinking_passback() {
    let captured_body = Arc::new(Mutex::new(Vec::<u8>::new()));
    let captured_body_state = captured_body.clone();
    let upstream = Router::new().route(
        "/v1/messages",
        post(move |body: Bytes| async move {
            *captured_body_state.lock().unwrap() = body.to_vec();
            (
                StatusCode::OK,
                [("content-type", "application/json")],
                r#"{"type":"message","role":"assistant","model":"deepseek-flash","content":[{"type":"thinking","thinking":"","signature":""},{"type":"text","text":"ok"}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}"#,
            )
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, upstream).await.unwrap();
    });

    let channel = dual_protocol_channel("deepseek", "DeepSeek", &format!("http://{addr}"));
    let state = build_test_state(
        vec![channel],
        vec![test_account("account", "deepseek", "key", 0)],
        vec![test_route(
            "route",
            "deepseek-v4.1-flash",
            "deepseek",
            "account",
            "deepseek-flash",
            ProtocolType::Anthropic,
            0,
        )],
    );

    // 工具调用链的 assistant 消息缺少 thinking 块（模拟由中转渠道生成的历史）。
    let request = Request::builder()
        .method("POST")
        .uri("/anthropic/v1/messages")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            r#"{"model":"deepseek-flash","thinking":{"type":"enabled"},"messages":[{"role":"user","content":[{"type":"text","text":"hi"}]},{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"bash","input":{}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":[{"type":"text","text":"ok"}]}]}]}"#,
        ))
        .unwrap();

    let response = forward_request(state, request, ProtocolType::Anthropic)
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let _ = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();

    let captured = captured_body.lock().unwrap().clone();
    let value: serde_json::Value = serde_json::from_slice(&captured).unwrap();
    assert_eq!(value["model"], "deepseek-flash");
    assert_eq!(
        value["messages"][0]["content"][0]["type"], "text",
        "user 消息不应被改写"
    );
    assert_eq!(value["messages"][1]["content"][0]["type"], "thinking");
    assert_eq!(value["messages"][1]["content"][0]["thinking"], "");
    assert_eq!(value["messages"][1]["content"][1]["type"], "tool_use");
    assert_eq!(value["messages"][2]["content"][0]["type"], "tool_result");
}

#[tokio::test]
async fn non_deepseek_route_leaves_assistant_messages_untouched() {
    let captured_body = Arc::new(Mutex::new(Vec::<u8>::new()));
    let captured_body_state = captured_body.clone();
    let upstream = Router::new().route(
        "/v1/chat/completions",
        post(move |body: Bytes| async move {
            *captured_body_state.lock().unwrap() = body.to_vec();
            (
                StatusCode::OK,
                [("content-type", "application/json")],
                r#"{"id":"x","object":"chat.completion","model":"LongCat-2.0","choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}"#,
            )
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, upstream).await.unwrap();
    });

    let channel = dual_protocol_channel("longcat", "LongCat", &format!("http://{addr}"));
    let state = build_test_state(
        vec![channel],
        vec![test_account("account", "longcat", "key", 0)],
        vec![test_route(
            "route",
            "LongCat-2.0",
            "longcat",
            "account",
            "LongCat-2.0",
            ProtocolType::OpenAi,
            0,
        )],
    );

    let request = Request::builder()
        .method("POST")
        .uri("/v1/chat/completions")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            r#"{"model":"LongCat-2.0","messages":[{"role":"assistant","content":"prev"}]}"#,
        ))
        .unwrap();

    let response = forward_request(state, request, ProtocolType::OpenAi)
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let _ = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();

    let captured = captured_body.lock().unwrap().clone();
    let value: serde_json::Value = serde_json::from_slice(&captured).unwrap();
    assert_eq!(value["model"], "LongCat-2.0");
    assert!(
        value["messages"][0].get("reasoning_content").is_none(),
        "非 DeepSeek 路由不应补字段"
    );
}

#[test]
fn rank_candidates_prefers_cheaper_account() {
    let mut candidates = vec![
        RouteCandidate {
            id: "route-1".to_string(),
            virtual_model_id: "auto".to_string(),
            channel_id: "deepseek".to_string(),
            account_id: "acc-expensive".to_string(),
            upstream_model: "deepseek-chat".to_string(),
            client_protocol: ProtocolType::OpenAi,
            priority: 0,
            enabled: true,
            created_at: String::new(),
            updated_at: String::new(),
        },
        RouteCandidate {
            id: "route-2".to_string(),
            virtual_model_id: "auto".to_string(),
            channel_id: "deepseek".to_string(),
            account_id: "acc-cheap".to_string(),
            upstream_model: "deepseek-v4-flash".to_string(),
            client_protocol: ProtocolType::OpenAi,
            priority: 0,
            enabled: true,
            created_at: String::new(),
            updated_at: String::new(),
        },
    ];

    // acc-cheap has lower cost, better latency, higher success rate
    let scores = vec![
        (
            "acc-expensive".to_string(),
            "deepseek".to_string(),
            500.0,
            95.0,
            10.0,
        ),
        (
            "acc-cheap".to_string(),
            "deepseek".to_string(),
            200.0,
            99.0,
            2.0,
        ),
    ];

    rank_candidates_by_score(&mut candidates, &scores);

    // acc-cheap should be first (lower score = better)
    assert_eq!(candidates[0].account_id, "acc-cheap");
    assert_eq!(candidates[1].account_id, "acc-expensive");
}

#[test]
fn rank_candidates_no_scores_keeps_priority() {
    let mut candidates = vec![
        RouteCandidate {
            id: "route-1".to_string(),
            virtual_model_id: "auto".to_string(),
            channel_id: "deepseek".to_string(),
            account_id: "acc-a".to_string(),
            upstream_model: "deepseek-chat".to_string(),
            client_protocol: ProtocolType::OpenAi,
            priority: 0,
            enabled: true,
            created_at: String::new(),
            updated_at: String::new(),
        },
        RouteCandidate {
            id: "route-2".to_string(),
            virtual_model_id: "auto".to_string(),
            channel_id: "deepseek".to_string(),
            account_id: "acc-b".to_string(),
            upstream_model: "deepseek-chat".to_string(),
            client_protocol: ProtocolType::OpenAi,
            priority: 1,
            enabled: true,
            created_at: String::new(),
            updated_at: String::new(),
        },
    ];

    // No scores → should keep original order
    let scores: Vec<(String, String, f64, f64, f64)> = vec![];
    rank_candidates_by_score(&mut candidates, &scores);
    assert_eq!(candidates[0].account_id, "acc-a");
    assert_eq!(candidates[1].account_id, "acc-b");
}

#[test]
fn export_import_config_roundtrip() {
    let path = temp_db_path();
    let storage = Storage::open(&path).unwrap();

    // 创建测试数据
    let preset = ChannelPreset::deepseek();
    storage.save_channel_presets(&[preset.clone()]).unwrap();
    let account = ChannelAccount {
        id: "acc-test".to_string(),
        channel_id: "deepseek".to_string(),
        name: "测试账号".to_string(),
        api_key: "sk-test".to_string(),
        resource_mode: Some("pay_as_you_go".to_string()),
        ..Default::default()
    };
    storage.save_channel_accounts(&[account.clone()]).unwrap();

    // 导出
    let json = storage.export_config().unwrap();
    assert!(json.contains("deepseek"));
    assert!(json.contains("acc-test"));

    // 清空
    storage.save_channel_presets(&[]).unwrap();
    storage.save_channel_accounts(&[]).unwrap();
    assert!(storage.list_channel_presets().unwrap().is_empty());

    // 导入
    storage.import_config(&json).unwrap();
    assert_eq!(storage.list_channel_presets().unwrap().len(), 1);
    assert_eq!(storage.list_channel_accounts().unwrap().len(), 1);
    assert_eq!(storage.list_channel_accounts().unwrap()[0].id, "acc-test");
    assert_eq!(
        storage.list_channel_accounts().unwrap()[0]
            .resource_mode
            .as_deref(),
        Some("pay_as_you_go")
    );

    // 清理
    let _ = std::fs::remove_file(&path);
}

#[test]
fn cleanup_old_logs_works() {
    let path = temp_db_path();
    {
        let storage = Storage::open(&path).unwrap();

        // 插入一条测试日志（手动设置 created_at 为 1 天前）
        storage
            .insert_request_log(&RequestLogInput {
                request_id: "old-req".to_string(),
                agent_type: None,
                agent_session_id: None,
                parent_agent_session_id: None,
                client_id: None,
                client_name: None,
                channel_id: None,
                channel_name: None,
                account_id: None,
                account_name: None,
                client_protocol: "openai".to_string(),
                upstream_protocol: "openai".to_string(),
                virtual_model: None,
                public_model: None,
                upstream_model: None,
                request_type: "chat".to_string(),
                method: "POST".to_string(),
                path: "/v1/chat/completions".to_string(),
                upstream_url: None,
                upstream_proxy_used: None,
                status: Some(200),
                latency_ms: Some(100),
                is_stream: false,
                error_message: None,
                fallback_count: 0,
                route_reason: None,
                ttfb_ms: None,
                duration_ms: None,
                attempt_seq: 0,
                req_headers_json: None,
                req_body_b64: None,
                res_headers_json: None,
                res_body_b64: None,
                is_last_attempt: true,
            })
            .unwrap();

        // 手动将 created_at 更新为 1 天前
        storage.test_set_logs_created_at_days_ago(1).unwrap();

        assert_eq!(storage.list_request_logs().unwrap().len(), 1);

        // 清理 0 天前的（即全部清理，因为日志是 1 天前的）
        let (deleted, _) = storage.cleanup_old_logs(0).unwrap();
        assert!(deleted >= 1);
        assert!(storage.list_request_logs().unwrap().is_empty());
    }
    let _ = std::fs::remove_file(&path);
}

#[test]
fn files_api_request_recognizes_the_four_operations() {
    assert_eq!(
        files_api_request(&Method::POST, "/anthropic/v1/files"),
        Some(FilesApiOp::Upload)
    );
    assert_eq!(
        files_api_request(
            &Method::GET,
            "/anthropic/v1/files?limit=100&after_id=file-x"
        ),
        Some(FilesApiOp::List)
    );
    assert_eq!(
        files_api_request(&Method::GET, "/anthropic/v1/files/file-abc"),
        Some(FilesApiOp::Retrieve("file-abc".to_string()))
    );
    assert_eq!(
        files_api_request(&Method::DELETE, "/anthropic/v1/files/file-abc"),
        Some(FilesApiOp::Delete("file-abc".to_string()))
    );
    // 只认 Anthropic 入口：OpenAI 入口与裸根路径都不接管。
    assert_eq!(files_api_request(&Method::POST, "/v1/files"), None);
    assert_eq!(files_api_request(&Method::POST, "/openai/v1/files"), None);
    assert_eq!(files_api_request(&Method::GET, "/v1/files/file-abc"), None);
    // 方法、多段 id、相似前缀都不算 Files 请求。
    assert_eq!(files_api_request(&Method::PUT, "/anthropic/v1/files"), None);
    assert_eq!(
        files_api_request(&Method::GET, "/anthropic/v1/files/a/b"),
        None
    );
    assert_eq!(
        files_api_request(&Method::GET, "/anthropic/v1/filesABC"),
        None
    );
    assert_eq!(
        files_api_request(&Method::GET, "/anthropic/v1/messages"),
        None
    );
}

#[test]
fn request_references_files_api_detects_the_beta_token() {
    let mut headers = HeaderMap::new();
    assert!(!request_references_files_api(&headers));
    headers.insert(
        "anthropic-beta",
        HeaderValue::from_static("context-1m-2025-08-07"),
    );
    assert!(!request_references_files_api(&headers));
    headers.insert(
        "anthropic-beta",
        HeaderValue::from_static("context-1m-2025-08-07, files-api-2025-04-14"),
    );
    assert!(request_references_files_api(&headers));
    // 前缀匹配：后续版本的 files-api beta 同样生效。
    headers.insert(
        "anthropic-beta",
        HeaderValue::from_static("files-api-2026-01-01"),
    );
    assert!(request_references_files_api(&headers));
}

#[test]
fn model_list_request_matches_openai_models_endpoint() {
    assert!(is_model_list_request(&Method::GET, "/v1/models"));
    assert!(is_model_list_request(
        &Method::GET,
        "/openai/v1/models?foo=bar"
    ));
    assert!(!is_model_list_request(&Method::POST, "/v1/models"));
    assert!(!is_model_list_request(&Method::GET, "/v1/chat/completions"));
}

#[tokio::test]
async fn model_list_response_exposes_enabled_route_models() {
    let routes = vec![
        RouteCandidate {
            id: "route-1".to_string(),
            virtual_model_id: "LongCat-2.0".to_string(),
            channel_id: "longcat".to_string(),
            account_id: "acc-enabled".to_string(),
            upstream_model: "LongCat-2.0".to_string(),
            client_protocol: ProtocolType::OpenAi,
            priority: 0,
            enabled: true,
            created_at: String::new(),
            updated_at: String::new(),
        },
        RouteCandidate {
            id: "route-2".to_string(),
            virtual_model_id: "LongCat-2.5".to_string(),
            channel_id: "longcat".to_string(),
            account_id: "acc-disabled".to_string(),
            upstream_model: "LongCat-2.5".to_string(),
            client_protocol: ProtocolType::OpenAi,
            priority: 1,
            enabled: true,
            created_at: String::new(),
            updated_at: String::new(),
        },
    ];
    let accounts = vec![
        ChannelAccount {
            id: "acc-enabled".to_string(),
            name: "LongCat 主账号".to_string(),
            channel_id: "longcat".to_string(),
            api_key: "test-key".to_string(),
            enabled: true,
            ..Default::default()
        },
        ChannelAccount {
            id: "acc-disabled".to_string(),
            name: "disabled".to_string(),
            channel_id: "longcat".to_string(),
            enabled: false,
            ..Default::default()
        },
    ];
    let channels = vec![ChannelPreset {
        id: "longcat".to_string(),
        name: "LongCat".to_string(),
        vendor: "longcat".to_string(),
        supported_protocols: vec![ProtocolType::OpenAi, ProtocolType::Anthropic],
        ..Default::default()
    }];

    let response = build_model_list_response(&routes, &accounts, &channels, &ProtocolType::OpenAi);

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers().get(header::CONTENT_TYPE),
        Some(&HeaderValue::from_static("application/json"))
    );
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let value: serde_json::Value = serde_json::from_slice(&body).unwrap();

    // OpenAI 风格：object=list, data 内每个模型含 id/object/created/owned_by
    assert_eq!(value["object"], "list");
    // 当前只返回 virtual_model_id（不回漏 upstream_model）
    let ids: Vec<&str> = value["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["id"].as_str().unwrap())
        .collect();
    // 只暴露有健康账号的一条路由（LongCat-2.5 的账号已禁用）。
    assert_eq!(ids, vec!["LongCat-2.0"]);

    // owned_by 取承载渠道的 vendor。
    let first = &value["data"][0];
    assert_eq!(first["object"], "model");
    assert_eq!(first["owned_by"], "longcat");
}

#[tokio::test]
async fn model_list_never_exposes_retired_aggregate_names() {
    // 历史聚合名即使出现在行里（身份一致也不够）也不得对外暴露。
    let routes = vec![
        RouteCandidate {
            id: "retired".to_string(),
            virtual_model_id: "flowlet-pro".to_string(),
            channel_id: "longcat".to_string(),
            account_id: "acc".to_string(),
            upstream_model: "flowlet-pro".to_string(),
            client_protocol: ProtocolType::OpenAi,
            priority: 0,
            enabled: true,
            ..Default::default()
        },
        RouteCandidate {
            id: "direct".to_string(),
            virtual_model_id: "LongCat-2.0".to_string(),
            channel_id: "longcat".to_string(),
            account_id: "acc".to_string(),
            upstream_model: "LongCat-2.0".to_string(),
            client_protocol: ProtocolType::OpenAi,
            priority: 0,
            enabled: true,
            ..Default::default()
        },
    ];
    let accounts = vec![ChannelAccount {
        id: "acc".to_string(),
        channel_id: "longcat".to_string(),
        api_key: "test-key".to_string(),
        enabled: true,
        ..Default::default()
    }];
    let channels = vec![ChannelPreset {
        id: "longcat".to_string(),
        vendor: "longcat".to_string(),
        supported_protocols: vec![ProtocolType::OpenAi, ProtocolType::Anthropic],
        ..Default::default()
    }];

    let response = build_model_list_response(&routes, &accounts, &channels, &ProtocolType::OpenAi);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(value["data"].as_array().unwrap().len(), 1);
    assert_eq!(value["data"][0]["id"], "LongCat-2.0");
}

#[tokio::test]
async fn model_list_response_exposes_canonical_openrouter_model() {
    let routes = vec![RouteCandidate {
        id: "route-ox-alpha".to_string(),
        virtual_model_id: "ox-alpha".to_string(),
        channel_id: "openrouter".to_string(),
        account_id: "acc-openrouter".to_string(),
        upstream_model: "stealth/ox-alpha".to_string(),
        client_protocol: ProtocolType::OpenAi,
        priority: 0,
        enabled: true,
        created_at: String::new(),
        updated_at: String::new(),
    }];
    let accounts = vec![ChannelAccount {
        id: "acc-openrouter".to_string(),
        channel_id: "openrouter".to_string(),
        api_key: "sk-or-test".to_string(),
        enabled: true,
        ..Default::default()
    }];
    let channels = vec![ChannelPreset {
        id: "openrouter".to_string(),
        vendor: "openrouter".to_string(),
        supported_protocols: vec![ProtocolType::OpenAi, ProtocolType::Anthropic],
        ..Default::default()
    }];

    let response = build_model_list_response(&routes, &accounts, &channels, &ProtocolType::OpenAi);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let value: serde_json::Value = serde_json::from_slice(&body).unwrap();

    assert_eq!(value["data"][0]["id"], "ox-alpha");
    assert_eq!(value["data"][0]["owned_by"], "openrouter");
}

#[tokio::test]
async fn model_list_response_anthropic_uses_anthropic_schema() {
    let routes = vec![
        RouteCandidate {
            id: "route-a".to_string(),
            virtual_model_id: "deepseek-v4-flash".to_string(),
            channel_id: "anthropic".to_string(),
            account_id: "acc-anthropic".to_string(),
            upstream_model: "deepseek-v4-flash".to_string(),
            client_protocol: ProtocolType::Anthropic,
            priority: 0,
            enabled: true,
            created_at: "2025-05-14T00:00:00Z".to_string(),
            updated_at: String::new(),
        },
        RouteCandidate {
            id: "route-b".to_string(),
            virtual_model_id: "deepseek-v4-pro".to_string(),
            channel_id: "anthropic".to_string(),
            account_id: "acc-anthropic".to_string(),
            upstream_model: "deepseek-v4-pro".to_string(),
            client_protocol: ProtocolType::Anthropic,
            priority: 1,
            enabled: true,
            created_at: String::new(), // 老数据兜底
            updated_at: String::new(),
        },
    ];
    let accounts = vec![ChannelAccount {
        id: "acc-anthropic".to_string(),
        name: "Anthropic Official".to_string(),
        channel_id: "anthropic".to_string(),
        api_key: "test-key".to_string(),
        enabled: true,
        ..Default::default()
    }];
    let channels = vec![ChannelPreset {
        id: "anthropic".to_string(),
        name: "Anthropic".to_string(),
        vendor: "anthropic".to_string(),
        supported_protocols: vec![ProtocolType::OpenAi, ProtocolType::Anthropic],
        ..Default::default()
    }];

    let response =
        build_model_list_response(&routes, &accounts, &channels, &ProtocolType::Anthropic);

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let value: serde_json::Value = serde_json::from_slice(&body).unwrap();

    // Anthropic 风格：没有 object=list，而是 data + has_more + first_id + last_id
    assert!(value.get("object").is_none());
    assert_eq!(value["has_more"], false);
    // 对外模型按名字典序排列：deepseek-v4-flash < deepseek-v4-pro
    assert_eq!(value["first_id"], "deepseek-v4-flash");
    assert_eq!(value["last_id"], "deepseek-v4-pro");

    let data = value["data"].as_array().unwrap();
    assert_eq!(data.len(), 2);
    // 每个模型对象：type=model, id, display_name, created_at
    assert_eq!(data[0]["type"], "model");
    assert_eq!(data[0]["id"], "deepseek-v4-flash");
    assert_eq!(data[0]["display_name"], "deepseek-v4-flash");
    // 空 created_at 应被替换为 epoch 起点
    assert_eq!(data[0]["created_at"], "2025-05-14T00:00:00Z");
    // 非空 RFC 3339 应原样保留
    assert_eq!(data[1]["created_at"], "1970-01-01T00:00:00Z");
}

#[test]
fn cors_preflight_allows_browser_requests() {
    let request = Request::builder()
        .method("OPTIONS")
        .uri("/v1/models")
        .header(header::ORIGIN, "https://snewbie.site")
        .header(header::ACCESS_CONTROL_REQUEST_METHOD, "GET")
        .header(
            header::ACCESS_CONTROL_REQUEST_HEADERS,
            "authorization,content-type",
        )
        .body(Body::empty())
        .unwrap();

    let response = cors_preflight_response(request.headers());

    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert_eq!(
        response.headers().get(header::ACCESS_CONTROL_ALLOW_ORIGIN),
        Some(&HeaderValue::from_static("*"))
    );
    assert_eq!(
        response.headers().get(header::ACCESS_CONTROL_ALLOW_HEADERS),
        Some(&HeaderValue::from_static("authorization,content-type"))
    );
    assert!(response
        .headers()
        .get(header::ACCESS_CONTROL_ALLOW_METHODS)
        .unwrap()
        .to_str()
        .unwrap()
        .contains("OPTIONS"));
}

#[test]
fn cors_headers_are_added_to_regular_responses() {
    let mut headers = HeaderMap::new();
    add_cors_headers(&mut headers, None);

    assert_eq!(
        headers.get(header::ACCESS_CONTROL_ALLOW_ORIGIN),
        Some(&HeaderValue::from_static("*"))
    );
    assert!(headers
        .get(header::ACCESS_CONTROL_ALLOW_HEADERS)
        .unwrap()
        .to_str()
        .unwrap()
        .contains("authorization"));
}
fn temp_db_path() -> PathBuf {
    std::env::temp_dir().join(format!("flowlet-test-{}.sqlite", uuid::Uuid::new_v4()))
}

#[tokio::test]
async fn empty_openai_model_list_is_valid() {
    let response = build_model_list_response(&[], &[], &[], &ProtocolType::OpenAi);
    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(value, serde_json::json!({"object": "list", "data": []}));
}

#[tokio::test]
async fn empty_anthropic_model_list_is_valid() {
    let response = build_model_list_response(&[], &[], &[], &ProtocolType::Anthropic);
    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(value["data"], serde_json::json!([]));
    assert_eq!(value["has_more"], false);
    assert_eq!(value["first_id"], "");
    assert_eq!(value["last_id"], "");
}
#[tokio::test]
async fn proxy_starts_without_accounts_or_routes() {
    let db_path = temp_db_path();
    let config_path = db_path.with_extension("json");
    let storage = Storage::open(&db_path).unwrap();
    let shared = ProxySharedConfig {
        runtime_config: RuntimeConfigStore::new(RuntimeConfigSnapshot::new(
            vec![],
            vec![],
            vec![],
            vec![],
            vec![],
        )),
        scores: Arc::new(Mutex::new(vec![])),
        round_robin: Arc::new(Mutex::new(std::collections::HashMap::new())),
    };
    let proxy = ProxyController::default();
    proxy
        .start_with_bind(
            shared,
            storage,
            30,
            LogCaptureConfig::default(),
            "127.0.0.1:0",
            RateLimiter::new(600),
            config_path.clone(),
        )
        .await
        .unwrap();
    assert!(proxy.status().running);
    proxy.stop().await.unwrap();
    assert!(!proxy.status().running);
    let _ = std::fs::remove_file(db_path);
    let _ = std::fs::remove_file(config_path);
}
#[tokio::test]
async fn missing_account_returns_structured_error_and_log() {
    let db_path = temp_db_path();
    let storage = Storage::open(&db_path).unwrap();
    let state = ProxyAppState {
        shared: ProxySharedConfig {
            runtime_config: RuntimeConfigStore::new(RuntimeConfigSnapshot::new(
                vec![],
                vec![],
                vec![],
                vec![],
                vec![],
            )),
            scores: Arc::new(Mutex::new(vec![])),
            round_robin: Arc::new(Mutex::new(std::collections::HashMap::new())),
        },
        client: Client::new(),
        storage: storage.clone(),
        upstream_timeout_seconds: 30,
        rate_limiter: RateLimiter::new(600),
        capture: Arc::new(Mutex::new(LogCaptureConfig::default())),
        bind_config: Arc::new(Mutex::new(ProxyBindConfig::default())),
        activity: ActivityTracker::new(),
        config_path: db_path.with_extension("json"),
    };
    let request = Request::builder()
        .method("POST")
        .uri("/v1/chat/completions")
        .header(header::CONTENT_TYPE, "application/json")
        .header("x-debug-request", "opencode-first-request")
        .body(Body::from(r#"{"model":"missing","messages":[]}"#))
        .unwrap();
    let response = forward_request(state, request, ProtocolType::OpenAi)
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(value["error"]["code"], "no_available_account");
    let logs = tokio::time::timeout(std::time::Duration::from_secs(1), async {
        loop {
            let logs = storage.list_request_logs().unwrap();
            if !logs.is_empty() {
                break logs;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(logs.len(), 1);
    assert_eq!(
        logs[0].route_reason.as_deref(),
        Some("no_available_account")
    );
    let request_headers: serde_json::Value =
        serde_json::from_str(logs[0].req_headers_json.as_deref().unwrap()).unwrap();
    assert_eq!(
        request_headers["x-debug-request"],
        serde_json::Value::String("opencode-first-request".to_string())
    );
    assert_eq!(
        logs[0].req_body_b64.as_deref(),
        Some(encode_body_base64(br#"{"model":"missing","messages":[]}"#).as_str())
    );
    let response_headers: serde_json::Value =
        serde_json::from_str(logs[0].res_headers_json.as_deref().unwrap()).unwrap();
    assert_eq!(
        response_headers["content-type"],
        serde_json::Value::String("application/json".to_string())
    );
    assert_eq!(
        logs[0].res_body_b64.as_deref(),
        Some(encode_body_base64(&body).as_str())
    );
    let _ = std::fs::remove_file(db_path);
}
#[test]
fn candidate_pool_round_robins_accounts_before_next_variant() {
    let account = |id: &str, channel_id: &str, priority: i64, api_key: &str| ChannelAccount {
        id: id.to_string(),
        channel_id: channel_id.to_string(),
        name: id.to_string(),
        api_key: api_key.to_string(),
        enabled: true,
        priority,
        ..Default::default()
    };
    let route =
        |id: &str, public: &str, channel: &str, account: &str, upstream: &str, priority: i64| {
            RouteCandidate {
                id: id.to_string(),
                virtual_model_id: public.to_string(),
                channel_id: channel.to_string(),
                account_id: account.to_string(),
                upstream_model: upstream.to_string(),
                client_protocol: ProtocolType::OpenAi,
                priority,
                enabled: true,
                ..Default::default()
            }
        };
    let channels = vec![
        ChannelPreset {
            id: "deepseek".to_string(),
            supported_protocols: vec![ProtocolType::OpenAi, ProtocolType::Anthropic],
            ..Default::default()
        },
        ChannelPreset {
            id: "longcat".to_string(),
            supported_protocols: vec![ProtocolType::OpenAi, ProtocolType::Anthropic],
            ..Default::default()
        },
    ];
    let accounts = vec![
        account("a", "deepseek", 0, "key-a"),
        account("b", "deepseek", 1, "key-b"),
        account("c", "longcat", 0, "key-c"),
        account("empty", "deepseek", 2, ""),
    ];
    let routes = vec![
        route(
            "1",
            "deepseek-v4-pro",
            "deepseek",
            "a",
            "deepseek-v4-pro",
            0,
        ),
        route(
            "2",
            "deepseek-v4-pro",
            "deepseek",
            "b",
            "deepseek-v4-pro",
            0,
        ),
        route(
            "3",
            "deepseek-v4-pro",
            "deepseek",
            "empty",
            "deepseek-v4-pro",
            0,
        ),
        // 同一规范模型的另一个上游变体（日期快照）是独立的 priority 池，池内不参与轮询。
        route(
            "4",
            "deepseek-v4-pro",
            "longcat",
            "c",
            "deepseek-v4-pro-0813",
            10,
        ),
        route(
            "5",
            "deepseek-v4-flash",
            "deepseek",
            "a",
            "deepseek-v4-flash",
            0,
        ),
    ];
    let mut round_robin = std::collections::HashMap::new();
    let first = match_candidates(
        &routes,
        &[],
        &[],
        Some("deepseek-v4-pro"),
        &ProtocolType::OpenAi,
        None,
        &accounts,
        &channels,
        &mut round_robin,
    )
    .matched;
    assert_eq!(
        first
            .iter()
            .map(|route| route.account_id.as_str())
            .collect::<Vec<_>>(),
        vec!["a", "b", "c"]
    );
    let second = match_candidates(
        &routes,
        &[],
        &[],
        Some("deepseek-v4-pro"),
        &ProtocolType::OpenAi,
        None,
        &accounts,
        &channels,
        &mut round_robin,
    )
    .matched;
    assert_eq!(
        second
            .iter()
            .map(|route| route.account_id.as_str())
            .collect::<Vec<_>>(),
        vec!["b", "a", "c"]
    );
    assert!(second
        .iter()
        .all(|route| route.virtual_model_id == "deepseek-v4-pro"));
}

#[test]
fn candidate_pool_accepts_native_protocol_and_skips_other_protocols() {
    let channels = vec![ChannelPreset {
        id: "openai-only".to_string(),
        supported_protocols: vec![ProtocolType::OpenAi],
        ..Default::default()
    }];
    let accounts = vec![ChannelAccount {
        id: "account".to_string(),
        channel_id: "openai-only".to_string(),
        api_key: "key".to_string(),
        enabled: true,
        ..Default::default()
    }];
    let routes = vec![RouteCandidate {
        virtual_model_id: "deepseek-v4-pro".to_string(),
        channel_id: "openai-only".to_string(),
        account_id: "account".to_string(),
        upstream_model: "deepseek-v4-pro".to_string(),
        client_protocol: ProtocolType::OpenAi,
        enabled: true,
        ..Default::default()
    }];
    let mut round_robin = std::collections::HashMap::new();
    assert!(!match_candidates(
        &routes,
        &[],
        &[],
        Some("deepseek-v4-pro"),
        &ProtocolType::OpenAi,
        None,
        &accounts,
        &channels,
        &mut round_robin
    )
    .matched
    .is_empty());
    assert!(match_candidates(
        &routes,
        &[],
        &[],
        Some("deepseek-v4-pro"),
        &ProtocolType::Anthropic,
        None,
        &accounts,
        &channels,
        &mut round_robin
    )
    .matched
    .is_empty());
}

#[test]
fn match_candidates_skips_routes_with_inconsistent_canonical_identity() {
    // 历史聚合路由（一个对外名对应异构上游）与手工脏数据：规范身份不一致的行不参与路由。
    let channels = vec![dual_protocol_channel(
        "deepseek",
        "DeepSeek",
        "http://upstream",
    )];
    let accounts = vec![
        test_account("a", "deepseek", "key", 0),
        test_account("b", "deepseek", "key-b", 0),
    ];
    let routes = vec![
        test_route(
            "valid",
            "deepseek-v4-pro",
            "deepseek",
            "a",
            "deepseek-v4-pro-0813",
            ProtocolType::OpenAi,
            0,
        ),
        test_route(
            "legacy-aggregate",
            "deepseek-v4-pro",
            "deepseek",
            "b",
            "LongCat-2.0",
            ProtocolType::OpenAi,
            0,
        ),
        test_route(
            "legacy-auto",
            "auto",
            "deepseek",
            "b",
            "gpt-test",
            ProtocolType::OpenAi,
            0,
        ),
        test_route(
            "legacy-auto-match",
            "auto",
            "deepseek",
            "b",
            "auto",
            ProtocolType::OpenAi,
            0,
        ),
    ];
    let mut round_robin = std::collections::HashMap::new();
    let selection = match_candidates(
        &routes,
        &[],
        &[],
        Some("deepseek-v4-pro"),
        &ProtocolType::OpenAi,
        None,
        &accounts,
        &channels,
        &mut round_robin,
    );
    assert_eq!(
        selection
            .matched
            .iter()
            .map(|route| route.id.as_str())
            .collect::<Vec<_>>(),
        vec!["valid"]
    );

    // 「auto」是历史自定义模型名：身份一致的行仍按旧语义可被显式请求命中。
    let auto_selection = match_candidates(
        &routes,
        &[],
        &[],
        Some("auto"),
        &ProtocolType::OpenAi,
        None,
        &accounts,
        &channels,
        &mut round_robin,
    );
    assert_eq!(
        auto_selection
            .matched
            .iter()
            .map(|route| route.id.as_str())
            .collect::<Vec<_>>(),
        vec!["legacy-auto-match"]
    );

    // 已移除的聚合模型别名即使身份一致（例如经自定义中转渠道转发另一个 Flowlet 实例）
    // 也不再被路由命中。
    let retired_routes = vec![test_route(
        "retired",
        "flowlet-pro",
        "deepseek",
        "a",
        "flowlet-pro",
        ProtocolType::OpenAi,
        0,
    )];
    let retired_selection = match_candidates(
        &retired_routes,
        &[],
        &[],
        Some("flowlet-pro"),
        &ProtocolType::OpenAi,
        None,
        &accounts,
        &channels,
        &mut round_robin,
    );
    assert!(retired_selection.matched.is_empty());
}

#[test]
fn match_candidates_filters_routes_by_responses_protocol() {
    let channels = vec![dual_protocol_channel(
        "deepseek",
        "DeepSeek",
        "http://upstream",
    )];
    let accounts = vec![test_account("a", "deepseek", "key", 0)];
    let routes = vec![
        test_route(
            "openai-route",
            "deepseek-v4-flash",
            "deepseek",
            "a",
            "deepseek-v4-flash",
            ProtocolType::OpenAi,
            0,
        ),
        test_route(
            "responses-route",
            "deepseek-v4-flash",
            "deepseek",
            "a",
            "deepseek-v4-flash",
            ProtocolType::Responses,
            0,
        ),
    ];
    let mut round_robin = std::collections::HashMap::new();
    let matched = match_candidates(
        &routes,
        &[],
        &[],
        Some("deepseek-v4-flash"),
        &ProtocolType::Responses,
        None,
        &accounts,
        &channels,
        &mut round_robin,
    )
    .matched;
    assert_eq!(matched.len(), 1);
    assert_eq!(matched[0].id, "responses-route");
    assert_eq!(matched[0].client_protocol, ProtocolType::Responses);
}

#[test]
fn match_candidates_excludes_channels_without_responses_routes() {
    // Kimi 不声明 responses 协议 → 不会生成 responses 路由 →
    // 该协议下任何模型都没有候选（不会被误路由到不支持的上游）。
    let channels = vec![dual_protocol_channel("kimi", "Kimi", "http://upstream")];
    let accounts = vec![test_account("a", "kimi", "key", 0)];
    let routes = vec![test_route(
        "openai-route",
        "kimi-k3",
        "kimi",
        "a",
        "kimi-k3",
        ProtocolType::OpenAi,
        0,
    )];
    let mut round_robin = std::collections::HashMap::new();
    assert!(match_candidates(
        &routes,
        &[],
        &[],
        Some("kimi-k3"),
        &ProtocolType::Responses,
        None,
        &accounts,
        &channels,
        &mut round_robin
    )
    .matched
    .is_empty());
}

#[test]
fn match_candidates_reports_protocol_mismatched_routes_as_skipped() {
    // 模型只在 OpenAI 协议下开放，Responses 请求没有任何匹配候选；
    // 但协议不匹配的候选必须被单独返回，供上层写入“已跳过”降级节点。
    let channels = vec![dual_protocol_channel(
        "deepseek",
        "DeepSeek",
        "http://upstream",
    )];
    let accounts = vec![test_account("a", "deepseek", "key", 0)];
    let routes = vec![test_route(
        "openai-route",
        "deepseek-v4-flash",
        "deepseek",
        "a",
        "deepseek-v4-flash",
        ProtocolType::OpenAi,
        0,
    )];
    let mut round_robin = std::collections::HashMap::new();
    let selection = match_candidates(
        &routes,
        &[],
        &[],
        Some("deepseek-v4-flash"),
        &ProtocolType::Responses,
        None,
        &accounts,
        &channels,
        &mut round_robin,
    );
    assert!(selection.matched.is_empty());
    assert_eq!(selection.protocol_skipped.len(), 1);
    assert_eq!(selection.protocol_skipped[0].id, "openai-route");
    assert_eq!(
        selection.protocol_skipped[0].client_protocol,
        ProtocolType::OpenAi
    );
}

// ─── End-to-end routing test helpers ─────────────────────────────────────────

// 测试用上游：根据 Authorization 中的 api_key 返回预先配置的状态码，并记录收到的 key 顺序。
struct SpyUpstream {
    status_by_key: std::collections::HashMap<String, StatusCode>,
    seen_keys: Arc<Mutex<Vec<String>>>,
}

async fn spawn_spy_upstream(
    status_by_key: std::collections::HashMap<String, StatusCode>,
) -> (String, Arc<Mutex<Vec<String>>>) {
    let seen = Arc::new(Mutex::new(Vec::<String>::new()));
    let state = Arc::new(SpyUpstream {
        status_by_key,
        seen_keys: seen.clone(),
    });
    // 代理会把 /anthropic/v1/messages 重写成上游 /v1/messages，因此需同时注册两条路径。
    let handler = {
        let state = state.clone();
        move |headers: HeaderMap, body: Bytes| {
            let state = state.clone();
            async move {
                let key = headers
                    .get(header::AUTHORIZATION)
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.strip_prefix("Bearer "))
                    .unwrap_or("")
                    .to_string();
                state.seen_keys.lock().unwrap().push(key.clone());
                let status = state
                    .status_by_key
                    .get(&key)
                    .copied()
                    .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
                (status, body)
            }
        }
    };
    let upstream = Router::new()
        .route("/v1/chat/completions", post(handler.clone()))
        .route("/v1/messages", post(handler))
        .with_state(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, upstream).await.unwrap();
    });
    (format!("http://{addr}"), seen)
}

// 用 HashMap 构造上游状态映射，避免引入 maplit 等新依赖。
fn status_map(entries: &[(&str, StatusCode)]) -> std::collections::HashMap<String, StatusCode> {
    entries.iter().map(|(k, v)| (k.to_string(), *v)).collect()
}

fn dual_protocol_channel(id: &str, name: &str, base_url: &str) -> ChannelPreset {
    ChannelPreset {
        id: id.to_string(),
        name: name.to_string(),
        vendor: id.to_string(),
        supported_protocols: vec![
            ProtocolType::OpenAi,
            ProtocolType::Anthropic,
            ProtocolType::Responses,
        ],
        openai_base_url: base_url.to_string(),
        anthropic_base_url: base_url.to_string(),
        openai_auth: AuthStrategy::Bearer,
        anthropic_auth: AuthStrategy::Bearer,
        default_model: String::new(),
        ..Default::default()
    }
}

fn test_account(id: &str, channel_id: &str, api_key: &str, priority: i64) -> ChannelAccount {
    ChannelAccount {
        id: id.to_string(),
        channel_id: channel_id.to_string(),
        name: id.to_string(),
        api_key: api_key.to_string(),
        enabled: true,
        priority,
        credential_status: "healthy".to_string(),
        ..Default::default()
    }
}

fn test_route(
    id: &str,
    virtual_model_id: &str,
    channel_id: &str,
    account_id: &str,
    upstream_model: &str,
    client_protocol: ProtocolType,
    priority: i64,
) -> RouteCandidate {
    RouteCandidate {
        id: id.to_string(),
        virtual_model_id: virtual_model_id.to_string(),
        channel_id: channel_id.to_string(),
        account_id: account_id.to_string(),
        upstream_model: upstream_model.to_string(),
        client_protocol,
        priority,
        enabled: true,
        ..Default::default()
    }
}

fn build_test_state(
    channels: Vec<ChannelPreset>,
    accounts: Vec<ChannelAccount>,
    routes: Vec<RouteCandidate>,
) -> ProxyAppState {
    let storage = Storage::open(temp_db_path()).unwrap();
    // 将账号持久化到存储，使 401 触发的 invalid_key 标记可被后续请求读取重建。
    storage.save_channel_accounts(&accounts).unwrap();
    ProxyAppState {
        shared: ProxySharedConfig {
            runtime_config: RuntimeConfigStore::new(RuntimeConfigSnapshot::new(
                channels,
                accounts,
                routes,
                vec![],
                vec![],
            )),
            scores: Arc::new(Mutex::new(vec![])),
            round_robin: Arc::new(Mutex::new(std::collections::HashMap::new())),
        },
        client: Client::new(),
        storage,
        upstream_timeout_seconds: 120,
        rate_limiter: RateLimiter::new(600),
        capture: Arc::new(Mutex::new(LogCaptureConfig::default())),
        bind_config: Arc::new(Mutex::new(ProxyBindConfig::default())),
        activity: ActivityTracker::new(),
        config_path: std::path::PathBuf::from("/tmp/flowlet_test_config.json"),
    }
}

fn chat_request(model: &str) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri("/v1/chat/completions")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(format!(
            r#"{{"model":"{model}","messages":[]}}"#
        )))
        .unwrap()
}

#[tokio::test]
async fn anthropic_thinking_compat_repairs_client_stream_but_captures_raw_upstream() {
    const RAW: &str = include_str!("../../tests/fixtures/dsh/missing-thinking-start.sse");
    let upstream = Router::new()
        .route(
            "/v1/messages",
            post(|| async { ([(header::CONTENT_TYPE, "text/event-stream")], RAW) }),
        )
        .route(
            "/v1/chat/completions",
            post(|| async { ([(header::CONTENT_TYPE, "text/event-stream")], RAW) }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
    for protocol in [ProtocolType::Anthropic, ProtocolType::OpenAi] {
        // Use the same SSE bytes for both protocols to prove compatibility is gated.
        let channel = dual_protocol_channel("custom", "Custom", &addr);
        let state = build_test_state(
            vec![channel],
            vec![test_account("a", "custom", "key", 0)],
            vec![test_route(
                "r",
                "deepseek-v4-pro",
                "custom",
                "a",
                "deepseek-v4-pro",
                protocol.clone(),
                0,
            )],
        );
        state.capture.lock().unwrap().capture_res_body = true;
        let storage = state.storage.clone();
        let path = if protocol == ProtocolType::Anthropic {
            "/anthropic/v1/messages"
        } else {
            "/v1/chat/completions"
        };
        let request = Request::builder()
            .method("POST")
            .uri(path)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                r#"{"model":"deepseek-v4-pro","stream":true,"messages":[]}"#,
            ))
            .unwrap();
        let response = forward_request(state, request, protocol.clone())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        if protocol == ProtocolType::Anthropic {
            assert!(response.headers().get(header::CONTENT_LENGTH).is_none());
        }
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        if protocol == ProtocolType::Anthropic {
            assert!(String::from_utf8_lossy(&body).contains("\"thinking\":\"\""));
        } else {
            assert_eq!(body, RAW);
        }
        let logs = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let logs = storage.list_request_logs().unwrap();
                if logs.first().is_some_and(|log| log.res_body_b64.is_some()) {
                    break logs;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            logs[0].res_body_b64.as_deref(),
            Some(encode_body_base64(RAW.as_bytes()).as_str())
        );
    }
    server.abort();
}

#[tokio::test]
async fn streaming_idle_timeout_resets_after_each_chunk() {
    let upstream = futures_util::stream::unfold(0usize, |index| async move {
        if index >= 4 {
            return None;
        }
        tokio::time::sleep(std::time::Duration::from_millis(80)).await;
        Some((
            Ok::<Bytes, reqwest::Error>(Bytes::from_static(b"data: keep-alive\n\n")),
            index + 1,
        ))
    });
    let capture = LogCaptureConfig::default();
    let (tx_done, rx_done) = tokio::sync::oneshot::channel();
    let stream = capture_timed_stream(
        upstream,
        tx_done,
        &capture,
        Instant::now(),
        None,
        std::time::Duration::from_millis(200),
        ActivityTracker::new().track(),
    );
    futures_util::pin_mut!(stream);

    let mut chunks = 0;
    while let Some(chunk) = stream.next().await {
        chunk.unwrap();
        chunks += 1;
    }

    let done = rx_done.await.unwrap();
    assert_eq!(chunks, 4);
    assert!(done.duration_ms >= 300);
    assert_eq!(done.error_message, None);
    assert_eq!(done.route_reason, None);
}

#[tokio::test]
async fn streaming_usage_survives_response_larger_than_capture_limit() {
    let mut chunks = vec![Ok::<Bytes, reqwest::Error>(Bytes::from_static(
        b"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":113,\"cache_read_input_tokens\":116352,\"cache_creation_input_tokens\":0,\"output_tokens\":0}}}\n\n",
    ))];
    let large_delta = format!(
        "event: content_block_delta\ndata: {{\"type\":\"content_block_delta\",\"delta\":{{\"type\":\"text_delta\",\"text\":\"{}\"}}}}\n\n",
        "x".repeat(64 * 1024),
    );
    for _ in 0..17 {
        chunks.push(Ok(Bytes::from(large_delta.clone())));
    }
    chunks.push(Ok(Bytes::from_static(
        b"event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":9764}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
    )));
    let streamed_bytes: usize = chunks
        .iter()
        .map(|chunk| chunk.as_ref().unwrap().len())
        .sum();
    assert!(streamed_bytes > MAX_USAGE_CAPTURE_BYTES);

    let capture = LogCaptureConfig::default();
    let (tx_done, rx_done) = tokio::sync::oneshot::channel();
    let stream = capture_timed_stream(
        futures_util::stream::iter(chunks),
        tx_done,
        &capture,
        Instant::now(),
        None,
        std::time::Duration::from_secs(1),
        ActivityTracker::new().track(),
    );
    futures_util::pin_mut!(stream);
    while let Some(chunk) = stream.next().await {
        chunk.unwrap();
    }

    let done = rx_done.await.unwrap();
    assert_eq!(
        done.usage,
        Some(ResponseUsage {
            input_tokens: Some(116465),
            input_cached_tokens: Some(116352),
            input_uncached_tokens: Some(113),
            input_cache_write_tokens: Some(0),
            output_tokens: Some(9764),
            total_tokens: Some(126229),
        })
    );
}

#[tokio::test]
async fn streaming_idle_timeout_reports_stream_failure() {
    let upstream = futures_util::stream::pending::<Result<Bytes, reqwest::Error>>();
    let capture = LogCaptureConfig::default();
    let (tx_done, rx_done) = tokio::sync::oneshot::channel();
    let stream = capture_timed_stream(
        upstream,
        tx_done,
        &capture,
        Instant::now(),
        None,
        std::time::Duration::from_millis(40),
        ActivityTracker::new().track(),
    );
    futures_util::pin_mut!(stream);

    let error = stream.next().await.unwrap().unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
    assert!(stream.next().await.is_none());

    let done = rx_done.await.unwrap();
    assert!(done.error_message.is_some());
    assert_eq!(done.route_reason.as_deref(), Some("stream_timeout"));
}

#[tokio::test]
async fn streaming_timeout_preserves_message_start_usage_as_partial() {
    let first = Bytes::from_static(
        b"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":6,\"cache_read_input_tokens\":23746,\"cache_creation_input_tokens\":11351,\"output_tokens\":0}}}\n\n",
    );
    let upstream = futures_util::stream::unfold(Some(first), |next| async move {
        match next {
            Some(bytes) => Some((Ok::<Bytes, reqwest::Error>(bytes), None)),
            None => std::future::pending().await,
        }
    });
    let capture = LogCaptureConfig::default();
    let (tx_done, rx_done) = tokio::sync::oneshot::channel();
    let mut stream = Box::pin(capture_timed_stream(
        upstream,
        tx_done,
        &capture,
        Instant::now(),
        None,
        std::time::Duration::from_millis(30),
        ActivityTracker::new().track(),
    ));

    stream.next().await.unwrap().unwrap();
    assert_eq!(
        stream.next().await.unwrap().unwrap_err().kind(),
        std::io::ErrorKind::TimedOut
    );
    let done = rx_done.await.unwrap();
    assert_eq!(done.usage_status.as_deref(), Some("partial"));
    assert_eq!(
        done.usage_source.as_deref(),
        Some("upstream_stream_partial")
    );
    let usage = done.usage.unwrap();
    assert_eq!(usage.input_tokens, Some(35103));
    assert_eq!(usage.output_tokens, None);
    assert_eq!(usage.total_tokens, None);
}

#[tokio::test]
async fn streaming_timeout_keeps_usage_complete_when_final_output_usage_arrived() {
    let first = Bytes::from_static(
        b"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":6,\"cache_read_input_tokens\":23746,\"cache_creation_input_tokens\":11351,\"output_tokens\":0}}}\n\nevent: message_delta\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":249}}\n\n",
    );
    let upstream = futures_util::stream::unfold(Some(first), |next| async move {
        match next {
            Some(bytes) => Some((Ok::<Bytes, reqwest::Error>(bytes), None)),
            None => std::future::pending().await,
        }
    });
    let capture = LogCaptureConfig::default();
    let (tx_done, rx_done) = tokio::sync::oneshot::channel();
    let mut stream = Box::pin(capture_timed_stream(
        upstream,
        tx_done,
        &capture,
        Instant::now(),
        None,
        std::time::Duration::from_millis(30),
        ActivityTracker::new().track(),
    ));

    stream.next().await.unwrap().unwrap();
    stream.next().await.unwrap().unwrap_err();
    let done = rx_done.await.unwrap();
    assert_eq!(done.usage_status.as_deref(), Some("complete"));
    assert_eq!(
        done.usage_source.as_deref(),
        Some("upstream_stream_recovered")
    );
    assert_eq!(done.usage.unwrap().total_tokens, Some(35352));
}

#[tokio::test]
async fn dropping_downstream_stream_preserves_received_partial_usage() {
    let first = Bytes::from_static(
        b"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":113,\"cache_read_input_tokens\":116352,\"cache_creation_input_tokens\":0,\"output_tokens\":0}}}\n\n",
    );
    let upstream = futures_util::stream::unfold(Some(first), |next| async move {
        match next {
            Some(bytes) => Some((Ok::<Bytes, reqwest::Error>(bytes), None)),
            None => std::future::pending().await,
        }
    });
    let capture = LogCaptureConfig::default();
    let (tx_done, rx_done) = tokio::sync::oneshot::channel();
    let mut stream = Box::pin(capture_timed_stream(
        upstream,
        tx_done,
        &capture,
        Instant::now(),
        None,
        std::time::Duration::from_secs(1),
        ActivityTracker::new().track(),
    ));

    stream.next().await.unwrap().unwrap();
    drop(stream);
    let done = rx_done.await.unwrap();
    assert_eq!(done.route_reason.as_deref(), Some("stream_cancelled"));
    assert_eq!(done.usage_status.as_deref(), Some("partial"));
    assert_eq!(done.usage.unwrap().input_tokens, Some(116465));
}

#[tokio::test]
async fn dropping_stream_after_openai_done_marker_marks_complete() {
    let body = Bytes::from_static(
        b"data: {\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":1,\"total_tokens\":4}}\n\ndata: [DONE]\n\n",
    );
    let upstream = futures_util::stream::unfold(Some(body), |next| async move {
        match next {
            Some(bytes) => Some((Ok::<Bytes, reqwest::Error>(bytes), None)),
            None => std::future::pending().await,
        }
    });
    let capture = LogCaptureConfig::default();
    let (tx_done, rx_done) = tokio::sync::oneshot::channel();
    let mut stream = Box::pin(capture_timed_stream(
        upstream,
        tx_done,
        &capture,
        Instant::now(),
        None,
        std::time::Duration::from_secs(1),
        ActivityTracker::new().track(),
    ));

    stream.next().await.unwrap().unwrap();
    drop(stream);
    let done = rx_done.await.unwrap();
    assert_eq!(done.error_message, None);
    assert_eq!(done.route_reason, None);
    assert_eq!(done.usage_status.as_deref(), Some("complete"));
    assert_eq!(done.usage.unwrap().total_tokens, Some(4));
}

#[tokio::test]
async fn dropping_stream_after_split_openai_done_marker_marks_complete() {
    let chunks = vec![
        Bytes::from_static(
            b"data: {\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":1,\"total_tokens\":4}}\n\ndata: [DO",
        ),
        Bytes::from_static(b"NE]\n\n"),
    ];
    let upstream = futures_util::stream::unfold(chunks.into_iter(), |mut chunks| async move {
        chunks
            .next()
            .map(|bytes| (Ok::<Bytes, reqwest::Error>(bytes), chunks))
    });
    let capture = LogCaptureConfig::default();
    let (tx_done, rx_done) = tokio::sync::oneshot::channel();
    let mut stream = Box::pin(capture_timed_stream(
        upstream,
        tx_done,
        &capture,
        Instant::now(),
        None,
        std::time::Duration::from_secs(1),
        ActivityTracker::new().track(),
    ));

    stream.next().await.unwrap().unwrap();
    stream.next().await.unwrap().unwrap();
    drop(stream);
    let done = rx_done.await.unwrap();
    assert_eq!(done.error_message, None);
    assert_eq!(done.route_reason, None);
    assert_eq!(done.usage_status.as_deref(), Some("complete"));
    assert_eq!(done.usage.unwrap().total_tokens, Some(4));
}

#[tokio::test]
async fn dropping_stream_after_anthropic_message_stop_marks_complete() {
    let body = Bytes::from_static(
        b"event: message_delta\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":2}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
    );
    let upstream = futures_util::stream::unfold(Some(body), |next| async move {
        match next {
            Some(bytes) => Some((Ok::<Bytes, reqwest::Error>(bytes), None)),
            None => std::future::pending().await,
        }
    });
    let capture = LogCaptureConfig::default();
    let (tx_done, rx_done) = tokio::sync::oneshot::channel();
    let mut stream = Box::pin(capture_timed_stream(
        upstream,
        tx_done,
        &capture,
        Instant::now(),
        None,
        std::time::Duration::from_secs(1),
        ActivityTracker::new().track(),
    ));

    stream.next().await.unwrap().unwrap();
    drop(stream);
    let done = rx_done.await.unwrap();
    assert_eq!(done.error_message, None);
    assert_eq!(done.route_reason, None);
    assert_eq!(done.usage_status.as_deref(), Some("complete"));
}

#[tokio::test]
async fn streaming_response_can_outlive_channel_timeout_when_chunks_keep_arriving() {
    let upstream = Router::new().route(
        "/v1/chat/completions",
        post(|| async {
            let chunks = futures_util::stream::unfold(0usize, |index| async move {
                if index >= 4 {
                    return None;
                }
                tokio::time::sleep(std::time::Duration::from_millis(350)).await;
                Some((
                    Ok::<Bytes, std::convert::Infallible>(Bytes::from_static(
                        b"data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\n",
                    )),
                    index + 1,
                ))
            });
            let mut response = Response::new(Body::from_stream(chunks));
            response.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("text/event-stream"),
            );
            response
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, upstream).await.unwrap();
    });

    let mut channel = dual_protocol_channel("longcat", "LongCat", &format!("http://{addr}"));
    channel.timeout_seconds = Some(1);
    let state = build_test_state(
        vec![channel],
        vec![test_account("account", "longcat", "key", 0)],
        vec![test_route(
            "route",
            "LongCat-2.0",
            "longcat",
            "account",
            "LongCat-2.0",
            ProtocolType::OpenAi,
            0,
        )],
    );

    let response = forward_request(state, chat_request("LongCat-2.0"), ProtocolType::OpenAi)
        .await
        .unwrap();
    let body = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        axum::body::to_bytes(response.into_body(), usize::MAX),
    )
    .await
    .unwrap()
    .unwrap();

    assert_eq!(
        body.windows(b"data:".len())
            .filter(|part| *part == b"data:")
            .count(),
        4
    );
}

// 8 个端到端路由测试
//
// 核心思路：上游根据 api_key 返回预置状态码，并记录调用顺序。顺序与最终成功账号是 fallback 行为的直接证据；
// 请求日志的 fallback_count / route_reason 是辅助断言。

#[tokio::test]
async fn e2e_same_model_account_fallback() {
    // deepseek-v4-pro / deepseek-v4-pro：账号 A(429) → 账号 B(200)
    let (addr, seen) = spawn_spy_upstream(status_map(&[
        ("key-a", StatusCode::TOO_MANY_REQUESTS),
        ("key-b", StatusCode::OK),
    ]))
    .await;
    let channels = vec![dual_protocol_channel("deepseek", "DeepSeek", &addr)];
    let accounts = vec![
        test_account("a", "deepseek", "key-a", 0),
        test_account("b", "deepseek", "key-b", 1),
    ];
    let routes = vec![
        test_route(
            "1",
            "deepseek-v4-pro",
            "deepseek",
            "a",
            "deepseek-v4-pro",
            ProtocolType::OpenAi,
            0,
        ),
        test_route(
            "2",
            "deepseek-v4-pro",
            "deepseek",
            "b",
            "deepseek-v4-pro",
            ProtocolType::OpenAi,
            0,
        ),
    ];
    let state = build_test_state(channels, accounts, routes);
    let response = forward_request(state, chat_request("deepseek-v4-pro"), ProtocolType::OpenAi)
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        *seen.lock().unwrap(),
        vec!["key-a".to_string(), "key-b".to_string()]
    );
}

#[tokio::test]
async fn e2e_cross_variant_fallback_within_canonical_model() {
    // deepseek-v4-pro：账号 A(429) → 账号 B(500) → 账号 C(200，同规范模型的上游变体)
    let (addr, seen) = spawn_spy_upstream(status_map(&[
        ("key-a", StatusCode::TOO_MANY_REQUESTS),
        ("key-b", StatusCode::INTERNAL_SERVER_ERROR),
        ("key-c", StatusCode::OK),
    ]))
    .await;
    let channels = vec![
        dual_protocol_channel("deepseek", "DeepSeek", &addr),
        dual_protocol_channel("qwen", "Qwen", &addr),
    ];
    let accounts = vec![
        test_account("a", "deepseek", "key-a", 0),
        test_account("b", "deepseek", "key-b", 1),
        test_account("c", "qwen", "key-c", 0),
    ];
    let routes = vec![
        test_route(
            "1",
            "deepseek-v4-pro",
            "deepseek",
            "a",
            "deepseek-v4-pro",
            ProtocolType::OpenAi,
            0,
        ),
        test_route(
            "2",
            "deepseek-v4-pro",
            "deepseek",
            "b",
            "deepseek-v4-pro",
            ProtocolType::OpenAi,
            0,
        ),
        // 同一规范模型的日期快照变体，priority 更低 → 前两个池都失败后才尝试。
        test_route(
            "3",
            "deepseek-v4-pro",
            "qwen",
            "c",
            "qwen/deepseek-v4-pro-0813",
            ProtocolType::OpenAi,
            10,
        ),
    ];
    let state = build_test_state(channels, accounts, routes);
    let response = forward_request(state, chat_request("deepseek-v4-pro"), ProtocolType::OpenAi)
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        *seen.lock().unwrap(),
        vec![
            "key-a".to_string(),
            "key-b".to_string(),
            "key-c".to_string()
        ]
    );
}

#[tokio::test]
async fn e2e_image_request_to_text_only_model_is_rejected_before_upstream() {
    // 固定目录样本：glm-5.2 仅文本。聚合模型移除后，一个请求只对应一个规范模型，
    // 因此图片请求会过滤掉该模型的全部候选，返回 model_input_modality_unsupported；
    // 但本地降级节点仍必须记录，且不得发起第三方请求。
    let (addr, seen) = spawn_spy_upstream(status_map(&[("text-key", StatusCode::OK)])).await;
    let channels = vec![dual_protocol_channel("zhipu", "Z.AI", &addr)];
    let accounts = vec![test_account("text", "zhipu", "text-key", 0)];
    let routes = vec![test_route(
        "text-route",
        "glm-5.2",
        "zhipu",
        "text",
        "glm-5.2",
        ProtocolType::OpenAi,
        0,
    )];
    let state = build_test_state(channels, accounts, routes);
    let storage = state.storage.clone();
    let request = Request::builder()
        .method("POST")
        .uri("/v1/chat/completions")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            r#"{"model":"glm-5.2","messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"data:image/png;base64,eA=="}}]}]}"#,
        ))
        .unwrap();
    let models_cn = r#"{"providers":[{"id":"zhipu-cn","models":[
        {"id":"glm-5.2","capabilities":{"inputModalities":["text"]}}
    ]}]}"#;
    let response = crate::core::model_input_capabilities::with_test_catalogs(
        Some(models_cn),
        None,
        forward_request(state, request, ProtocolType::OpenAi),
    )
    .await
    .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert!(seen.lock().unwrap().is_empty());

    let attempts = tokio::time::timeout(std::time::Duration::from_secs(1), async {
        loop {
            let final_rows = storage.list_request_logs().unwrap();
            if let Some(final_row) = final_rows.first() {
                let rows = storage
                    .list_request_logs_by_request_id(&final_row.request_id)
                    .unwrap();
                if rows.len() == 2 {
                    break rows;
                }
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    // 跳过节点：保留候选渠道/账号/模型，但不伪造 HTTP 状态与上游报文。
    assert_eq!(attempts[0].upstream_model.as_deref(), Some("glm-5.2"));
    assert_eq!(
        attempts[0].route_reason.as_deref(),
        Some("input_modality_image_unsupported")
    );
    assert_eq!(attempts[0].status, None);
    assert_eq!(attempts[0].upstream_url, None);
    assert!(!attempts[0].is_last_attempt);
    // 终态：没有任何候选支持图片输入。
    assert_eq!(
        attempts[1].route_reason.as_deref(),
        Some("model_input_modality_unsupported")
    );
    assert_eq!(attempts[1].status, Some(400));
    assert!(attempts[1].is_last_attempt);
}

#[tokio::test]
async fn e2e_unsupported_protocol_logs_skipped_route_and_terminal_error() {
    // deepseek-v4-flash 只以 OpenAI 协议开放；Anthropic 请求没有任何匹配候选，
    // 尝试链路必须记录协议不匹配的“已跳过”节点，并以 model_protocol_unsupported 结束。
    let (addr, seen) = spawn_spy_upstream(status_map(&[])).await;
    let channels = vec![dual_protocol_channel("deepseek", "DeepSeek", &addr)];
    let accounts = vec![test_account("ds", "deepseek", "key-ds", 0)];
    let routes = vec![test_route(
        "openai-route",
        "deepseek-v4-flash",
        "deepseek",
        "ds",
        "deepseek-v4-flash",
        ProtocolType::OpenAi,
        0,
    )];
    let state = build_test_state(channels, accounts, routes);
    let storage = state.storage.clone();
    let request = Request::builder()
        .method("POST")
        .uri("/anthropic/v1/messages")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            r#"{"model":"deepseek-v4-flash","max_tokens":10,"messages":[]}"#,
        ))
        .unwrap();
    let response = forward_request(state, request, ProtocolType::Anthropic)
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert!(seen.lock().unwrap().is_empty());

    let attempts = tokio::time::timeout(std::time::Duration::from_secs(1), async {
        loop {
            let final_rows = storage.list_request_logs().unwrap();
            if let Some(final_row) = final_rows.first() {
                let rows = storage
                    .list_request_logs_by_request_id(&final_row.request_id)
                    .unwrap();
                if rows.len() == 2 {
                    break rows;
                }
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        attempts[0].upstream_model.as_deref(),
        Some("deepseek-v4-flash")
    );
    assert_eq!(
        attempts[0].route_reason.as_deref(),
        Some("protocol_unsupported")
    );
    assert_eq!(attempts[0].status, None);
    assert_eq!(attempts[0].upstream_url, None);
    assert!(!attempts[0].is_last_attempt);
    assert_eq!(
        attempts[1].route_reason.as_deref(),
        Some("model_protocol_unsupported")
    );
    assert_eq!(attempts[1].status, Some(404));
    assert!(attempts[1].is_last_attempt);
}

#[tokio::test]
async fn e2e_product_not_activated_falls_back_to_next_candidate() {
    let seen = Arc::new(Mutex::new(Vec::<String>::new()));
    let seen_by_upstream = seen.clone();
    let upstream = Router::new().route(
        "/v1/chat/completions",
        post(move |headers: HeaderMap| {
            let seen = seen_by_upstream.clone();
            async move {
                let key = headers
                    .get(header::AUTHORIZATION)
                    .and_then(|value| value.to_str().ok())
                    .and_then(|value| value.strip_prefix("Bearer "))
                    .unwrap_or("")
                    .to_string();
                seen.lock().unwrap().push(key.clone());
                if key == "bad-key" {
                    (
                        StatusCode::BAD_REQUEST,
                        [("content-type", "application/json")],
                        r#"{"error":{"message":"The product is not activated, please confirm that you have activated products and try again after activation.","type":"invalid_request_error","param":"","code":"invalid_parameter_error"}}"#,
                    )
                } else {
                    (
                        StatusCode::OK,
                        [("content-type", "application/json")],
                        r#"{"choices":[]}"#,
                    )
                }
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, upstream).await.unwrap();
    });
    let base_url = format!("http://{addr}");

    // 同一规范模型的多候选：第一个账号报 product_not_activated 时降级到下一个候选。
    let channels = vec![
        dual_protocol_channel("deepseek", "DeepSeek", &base_url),
        dual_protocol_channel("qwen", "Qwen", &base_url),
    ];
    let accounts = vec![
        test_account("bad", "deepseek", "bad-key", 0),
        test_account("good", "qwen", "good-key", 0),
    ];
    let routes = vec![
        test_route(
            "1",
            "deepseek-v4-pro",
            "deepseek",
            "bad",
            "deepseek-v4-pro",
            ProtocolType::OpenAi,
            0,
        ),
        test_route(
            "2",
            "deepseek-v4-pro",
            "qwen",
            "good",
            "qwen/deepseek-v4-pro-0813",
            ProtocolType::OpenAi,
            10,
        ),
    ];
    let state = build_test_state(channels, accounts, routes);
    let response = forward_request(state, chat_request("deepseek-v4-pro"), ProtocolType::OpenAi)
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        *seen.lock().unwrap(),
        vec!["bad-key".to_string(), "good-key".to_string()]
    );
}

#[tokio::test]
async fn e2e_account_deactivated_falls_back_then_recovers() {
    let seen = Arc::new(Mutex::new(Vec::<String>::new()));
    let seen_by_upstream = seen.clone();
    let key_disabled = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let key_disabled_by_upstream = key_disabled.clone();
    let upstream = Router::new().route(
        "/v1/chat/completions",
        post(move |headers: HeaderMap| {
            let seen = seen_by_upstream.clone();
            let key_disabled = key_disabled_by_upstream.clone();
            async move {
                let key = headers
                    .get(header::AUTHORIZATION)
                    .and_then(|value| value.to_str().ok())
                    .and_then(|value| value.strip_prefix("Bearer "))
                    .unwrap_or("")
                    .to_string();
                seen.lock().unwrap().push(key.clone());
                if key == "disabled-key"
                    && key_disabled.load(std::sync::atomic::Ordering::SeqCst)
                {
                    (
                        StatusCode::FORBIDDEN,
                        [("content-type", "application/json")],
                        r#"{"error":{"message":"api key is disabled","type":"authentication_error","param":"","code":"account_deactivated"}}"#,
                    )
                } else {
                    (
                        StatusCode::OK,
                        [("content-type", "application/json")],
                        r#"{"choices":[]}"#,
                    )
                }
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, upstream).await.unwrap();
    });
    let base_url = format!("http://{addr}");

    // 同一规范模型、同一渠道的两个账号：主账号被停用 → 降级到备用账号；恢复后重新探测主账号。
    let channels = vec![dual_protocol_channel("deepseek", "DeepSeek", &base_url)];
    let accounts = vec![
        test_account("primary", "deepseek", "disabled-key", 0),
        test_account("backup", "deepseek", "ok-key", 10),
    ];
    let routes = vec![
        test_route(
            "1",
            "deepseek-v4-pro",
            "deepseek",
            "primary",
            "deepseek-v4-pro",
            ProtocolType::OpenAi,
            0,
        ),
        test_route(
            "2",
            "deepseek-v4-pro",
            "deepseek",
            "backup",
            "deepseek-v4-pro",
            ProtocolType::OpenAi,
            10,
        ),
    ];
    let state = build_test_state(channels, accounts, routes);
    let storage = state.storage.clone();
    let response = forward_request(
        state.clone(),
        chat_request("deepseek-v4-pro"),
        ProtocolType::OpenAi,
    )
    .await
    .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        *seen.lock().unwrap(),
        vec!["disabled-key".to_string(), "ok-key".to_string()]
    );
    let stored_accounts = storage.list_channel_accounts().unwrap();
    let disabled = stored_accounts
        .iter()
        .find(|account| account.id == "primary")
        .unwrap();
    assert_eq!(
        disabled.credential_status,
        crate::core::config::ACCOUNT_CREDENTIAL_INVALID_KEY
    );

    // 上游重新启用同一个 Key 后，下一次请求会重新探测主账号并恢复账号状态。
    key_disabled.store(false, std::sync::atomic::Ordering::SeqCst);
    let recovered_response =
        forward_request(state, chat_request("deepseek-v4-pro"), ProtocolType::OpenAi)
            .await
            .unwrap();
    assert_eq!(recovered_response.status(), StatusCode::OK);
    assert_eq!(
        *seen.lock().unwrap(),
        vec![
            "disabled-key".to_string(),
            "ok-key".to_string(),
            "disabled-key".to_string(),
        ]
    );
    let recovered_accounts = storage.list_channel_accounts().unwrap();
    let recovered = recovered_accounts
        .iter()
        .find(|account| account.id == "primary")
        .unwrap();
    assert_eq!(
        recovered.credential_status,
        crate::core::config::ACCOUNT_CREDENTIAL_HEALTHY
    );
    assert!(recovered.last_error.is_none());
}

#[tokio::test]
async fn e2e_401_marks_invalid_key_and_excludes_from_next_request() {
    // 账号 A 返回 401：当前请求不 fallback，A 被标记 invalid_key，下一次请求不再选择 A
    let (addr, seen1) = spawn_spy_upstream(status_map(&[
        ("key-a", StatusCode::UNAUTHORIZED),
        ("key-b", StatusCode::OK),
    ]))
    .await;
    let channels = vec![dual_protocol_channel("deepseek", "DeepSeek", &addr)];
    let accounts = vec![
        test_account("a", "deepseek", "key-a", 0),
        test_account("b", "deepseek", "key-b", 1),
    ];
    let routes = vec![
        test_route(
            "1",
            "deepseek-v4-pro",
            "deepseek",
            "a",
            "deepseek-v4-pro",
            ProtocolType::OpenAi,
            0,
        ),
        test_route(
            "2",
            "deepseek-v4-pro",
            "deepseek",
            "b",
            "deepseek-v4-pro",
            ProtocolType::OpenAi,
            0,
        ),
    ];
    let state = build_test_state(channels, accounts, routes);
    let storage = state.storage.clone();
    let response = forward_request(state, chat_request("deepseek-v4-pro"), ProtocolType::OpenAi)
        .await
        .unwrap();

    // 401 不 fallback：直接返回 401，且只命中过 A
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(*seen1.lock().unwrap(), vec!["key-a".to_string()]);

    // 存储中 A 应已被标记 invalid_key
    let stored = storage.list_channel_accounts().unwrap();
    assert_eq!(
        stored
            .iter()
            .find(|a| a.id == "a")
            .unwrap()
            .credential_status,
        "invalid_key"
    );

    // 模拟下一次请求：从存储重建状态（A 已是 invalid_key），A 被自动排除，只命中 B
    let (addr2, seen2) = spawn_spy_upstream(status_map(&[
        ("key-a", StatusCode::UNAUTHORIZED),
        ("key-b", StatusCode::OK),
    ]))
    .await;
    let persisted_accounts = storage.list_channel_accounts().unwrap();
    let channels2 = vec![dual_protocol_channel("deepseek", "DeepSeek", &addr2)];
    let routes2 = vec![
        test_route(
            "1",
            "deepseek-v4-pro",
            "deepseek",
            "a",
            "deepseek-v4-pro",
            ProtocolType::OpenAi,
            0,
        ),
        test_route(
            "2",
            "deepseek-v4-pro",
            "deepseek",
            "b",
            "deepseek-v4-pro",
            ProtocolType::OpenAi,
            0,
        ),
    ];
    let state2 = build_test_state(channels2, persisted_accounts, routes2);
    let response2 = forward_request(
        state2,
        chat_request("deepseek-v4-pro"),
        ProtocolType::OpenAi,
    )
    .await
    .unwrap();

    assert_eq!(response2.status(), StatusCode::OK);
    // 第二次请求只命中 B，A 因 invalid_key 被候选池排除
    assert_eq!(*seen2.lock().unwrap(), vec!["key-b".to_string()]);
}

#[tokio::test]
async fn e2e_model_sort_order_is_respected() {
    // 同一规范模型的两个上游变体：初始优先主变体，交换 priority 后日期快照优先。
    let accounts = vec![
        test_account("ds", "deepseek", "key-ds", 0),
        test_account("qwen", "qwen", "key-qwen", 0),
    ];

    // 初始顺序：deepseek-v4-pro(priority 0) → 同规范变体 deepseek-v4-pro-0813(priority 10)。
    let routes_order_a = vec![
        test_route(
            "1",
            "deepseek-v4-pro",
            "deepseek",
            "ds",
            "deepseek-v4-pro",
            ProtocolType::OpenAi,
            0,
        ),
        test_route(
            "2",
            "deepseek-v4-pro",
            "qwen",
            "qwen",
            "qwen/deepseek-v4-pro-0813",
            ProtocolType::OpenAi,
            10,
        ),
    ];
    // deepseek 可重试 429 从而回落到变体，验证 deepseek 先被尝试。
    let (addr, seen) = spawn_spy_upstream(status_map(&[
        ("key-ds", StatusCode::TOO_MANY_REQUESTS),
        ("key-qwen", StatusCode::OK),
    ]))
    .await;
    let channels = vec![
        dual_protocol_channel("deepseek", "DeepSeek", &addr),
        dual_protocol_channel("qwen", "Qwen", &addr),
    ];
    let state = build_test_state(channels, accounts.clone(), routes_order_a);
    forward_request(state, chat_request("deepseek-v4-pro"), ProtocolType::OpenAi)
        .await
        .unwrap();
    assert_eq!(
        *seen.lock().unwrap(),
        vec!["key-ds".to_string(), "key-qwen".to_string()]
    );

    // 用户交换顺序：变体(priority 0) → 主变体(priority 10)。OpenAI 与 Anthropic 请求均应遵循新顺序。
    let routes_order_b = vec![
        test_route(
            "1",
            "deepseek-v4-pro",
            "qwen",
            "qwen",
            "qwen/deepseek-v4-pro-0813",
            ProtocolType::OpenAi,
            0,
        ),
        test_route(
            "2",
            "deepseek-v4-pro",
            "deepseek",
            "ds",
            "deepseek-v4-pro",
            ProtocolType::OpenAi,
            10,
        ),
    ];
    let (addr, seen) = spawn_spy_upstream(status_map(&[
        ("key-qwen", StatusCode::TOO_MANY_REQUESTS),
        ("key-ds", StatusCode::OK),
    ]))
    .await;
    let channels = vec![
        dual_protocol_channel("deepseek", "DeepSeek", &addr),
        dual_protocol_channel("qwen", "Qwen", &addr),
    ];
    let state = build_test_state(channels, accounts.clone(), routes_order_b);
    forward_request(state, chat_request("deepseek-v4-pro"), ProtocolType::OpenAi)
        .await
        .unwrap();
    assert_eq!(
        *seen.lock().unwrap(),
        vec!["key-qwen".to_string(), "key-ds".to_string()]
    );

    let routes_order_b_anthropic = vec![
        test_route(
            "1",
            "deepseek-v4-pro",
            "qwen",
            "qwen",
            "qwen/deepseek-v4-pro-0813",
            ProtocolType::Anthropic,
            0,
        ),
        test_route(
            "2",
            "deepseek-v4-pro",
            "deepseek",
            "ds",
            "deepseek-v4-pro",
            ProtocolType::Anthropic,
            10,
        ),
    ];
    let (addr, seen) = spawn_spy_upstream(status_map(&[
        ("key-qwen", StatusCode::TOO_MANY_REQUESTS),
        ("key-ds", StatusCode::OK),
    ]))
    .await;
    let channels = vec![
        dual_protocol_channel("deepseek", "DeepSeek", &addr),
        dual_protocol_channel("qwen", "Qwen", &addr),
    ];
    let state = build_test_state(channels, accounts, routes_order_b_anthropic);
    let anthropic_request = Request::builder()
        .method("POST")
        .uri("/anthropic/v1/messages")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            r#"{"model":"deepseek-v4-pro","max_tokens":10,"messages":[]}"#,
        ))
        .unwrap();
    let response = forward_request(state, anthropic_request, ProtocolType::Anthropic)
        .await
        .unwrap();
    assert_eq!(
        *seen.lock().unwrap(),
        vec!["key-qwen".to_string(), "key-ds".to_string()]
    );
    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn e2e_model_enable_disable_sync() {
    // 关闭某个上游变体的路由后，OpenAI 与 Anthropic 都不再使用该变体；其他规范模型不受影响。
    let accounts = vec![
        test_account("ds", "deepseek", "key-ds", 0),
        test_account("qwen", "qwen", "key-qwen", 0),
    ];
    let all_routes = vec![
        test_route(
            "1",
            "deepseek-v4-pro",
            "deepseek",
            "ds",
            "deepseek-v4-pro",
            ProtocolType::OpenAi,
            0,
        ),
        test_route(
            "2",
            "deepseek-v4-pro",
            "qwen",
            "qwen",
            "qwen/deepseek-v4-pro-0813",
            ProtocolType::OpenAi,
            10,
        ),
        test_route(
            "3",
            "deepseek-v4-pro",
            "deepseek",
            "ds",
            "deepseek-v4-pro",
            ProtocolType::Anthropic,
            0,
        ),
        test_route(
            "4",
            "deepseek-v4-pro",
            "qwen",
            "qwen",
            "qwen/deepseek-v4-pro-0813",
            ProtocolType::Anthropic,
            10,
        ),
        test_route(
            "5",
            "deepseek-v4-flash",
            "deepseek",
            "ds",
            "deepseek-v4-flash",
            ProtocolType::OpenAi,
            0,
        ),
        test_route(
            "6",
            "deepseek-v4-flash",
            "deepseek",
            "ds",
            "deepseek-v4-flash",
            ProtocolType::Anthropic,
            0,
        ),
    ];

    // 首次请求前：deepseek 返回可重试 429，验证主变体先尝试、变体后回落。
    let (addr, seen) = spawn_spy_upstream(status_map(&[
        ("key-ds", StatusCode::TOO_MANY_REQUESTS),
        ("key-qwen", StatusCode::OK),
    ]))
    .await;
    let channels = vec![
        dual_protocol_channel("deepseek", "DeepSeek", &addr),
        dual_protocol_channel("qwen", "Qwen", &addr),
    ];
    let state = build_test_state(channels, accounts.clone(), all_routes.clone());
    forward_request(state, chat_request("deepseek-v4-pro"), ProtocolType::OpenAi)
        .await
        .unwrap();
    assert_eq!(
        *seen.lock().unwrap(),
        vec!["key-ds".to_string(), "key-qwen".to_string()]
    );

    // 关闭 deepseek 渠道上 deepseek-v4-pro 的所有协议路由。
    let disabled_routes: Vec<RouteCandidate> = all_routes
        .iter()
        .cloned()
        .map(|mut route| {
            if route.channel_id == "deepseek" && route.upstream_model == "deepseek-v4-pro" {
                route.enabled = false;
            }
            route
        })
        .collect();

    // 关闭后 OpenAI 请求只能走变体。
    let (addr, seen) = spawn_spy_upstream(status_map(&[
        ("key-ds", StatusCode::OK),
        ("key-qwen", StatusCode::OK),
    ]))
    .await;
    let channels = vec![
        dual_protocol_channel("deepseek", "DeepSeek", &addr),
        dual_protocol_channel("qwen", "Qwen", &addr),
    ];
    let state = build_test_state(channels.clone(), accounts.clone(), disabled_routes.clone());
    forward_request(state, chat_request("deepseek-v4-pro"), ProtocolType::OpenAi)
        .await
        .unwrap();
    assert_eq!(*seen.lock().unwrap(), vec!["key-qwen".to_string()]);

    // 关闭后 Anthropic 请求同样只能走变体。
    let state = build_test_state(channels.clone(), accounts.clone(), disabled_routes.clone());
    let anthropic_request = Request::builder()
        .method("POST")
        .uri("/anthropic/v1/messages")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            r#"{"model":"deepseek-v4-pro","max_tokens":10,"messages":[]}"#,
        ))
        .unwrap();
    forward_request(state, anthropic_request, ProtocolType::Anthropic)
        .await
        .unwrap();
    // 同一 spy 已记录上一次 OpenAI 请求，本次 Anthropic 请求同样只命中变体账号。
    assert_eq!(
        *seen.lock().unwrap(),
        vec!["key-qwen".to_string(), "key-qwen".to_string()]
    );

    // deepseek-v4-flash 是另一个规范模型，不受影响，仍使用主账号。
    let (addr, seen) = spawn_spy_upstream(status_map(&[
        ("key-ds", StatusCode::OK),
        ("key-qwen", StatusCode::OK),
    ]))
    .await;
    let channels = vec![
        dual_protocol_channel("deepseek", "DeepSeek", &addr),
        dual_protocol_channel("qwen", "Qwen", &addr),
    ];
    let state = build_test_state(channels, accounts, disabled_routes);
    forward_request(
        state,
        chat_request("deepseek-v4-flash"),
        ProtocolType::OpenAi,
    )
    .await
    .unwrap();
    assert_eq!(*seen.lock().unwrap(), vec!["key-ds".to_string()]);
}

#[tokio::test]
async fn e2e_dual_protocol_model_list_consistency() {
    // OpenAI /models 与 Anthropic /models 暴露同一组规范模型，顺序一致（按名字典序）。
    let (addr, _) = spawn_spy_upstream(std::collections::HashMap::new()).await;
    let channels = vec![dual_protocol_channel("deepseek", "DeepSeek", &addr)];
    let accounts = vec![test_account("a", "deepseek", "key-a", 0)];
    let routes = vec![
        test_route(
            "1",
            "deepseek-v4-pro",
            "deepseek",
            "a",
            "deepseek-v4-pro",
            ProtocolType::OpenAi,
            0,
        ),
        test_route(
            "2",
            "deepseek-v4-flash",
            "deepseek",
            "a",
            "deepseek-v4-flash",
            ProtocolType::OpenAi,
            0,
        ),
        test_route(
            "3",
            "deepseek-v4-pro",
            "deepseek",
            "a",
            "deepseek-v4-pro",
            ProtocolType::Anthropic,
            0,
        ),
        test_route(
            "4",
            "deepseek-v4-flash",
            "deepseek",
            "a",
            "deepseek-v4-flash",
            ProtocolType::Anthropic,
            0,
        ),
    ];
    let state = build_test_state(channels, accounts, routes);

    let openai = forward_request(
        state.clone(),
        Request::builder()
            .method("GET")
            .uri("/v1/models")
            .body(Body::empty())
            .unwrap(),
        ProtocolType::OpenAi,
    )
    .await
    .unwrap();
    let anthropic = forward_request(
        state,
        Request::builder()
            .method("GET")
            .uri("/anthropic/v1/models")
            .body(Body::empty())
            .unwrap(),
        ProtocolType::Anthropic,
    )
    .await
    .unwrap();

    let openai_body = axum::body::to_bytes(openai.into_body(), usize::MAX)
        .await
        .unwrap();
    let anthropic_body = axum::body::to_bytes(anthropic.into_body(), usize::MAX)
        .await
        .unwrap();
    let openai_value: serde_json::Value = serde_json::from_slice(&openai_body).unwrap();
    let anthropic_value: serde_json::Value = serde_json::from_slice(&anthropic_body).unwrap();

    let openai_ids: Vec<&str> = openai_value["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["id"].as_str().unwrap())
        .collect();
    let anthropic_ids: Vec<&str> = anthropic_value["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["id"].as_str().unwrap())
        .collect();
    assert_eq!(openai_ids, vec!["deepseek-v4-flash", "deepseek-v4-pro"]);
    assert_eq!(anthropic_ids, vec!["deepseek-v4-flash", "deepseek-v4-pro"]);
}

// test 1: /models 只返回规范化后的开放模型
#[tokio::test]
async fn e2e_models_exposes_direct_models_by_default() {
    let (addr, _) = spawn_spy_upstream(std::collections::HashMap::new()).await;
    let channels = vec![dual_protocol_channel("deepseek", "DeepSeek", &addr)];
    let accounts = vec![test_account("a", "deepseek", "key-a", 0)];
    // 直接路由：virtual_model_id === upstream_model；同一规范模型的多个变体只暴露一次。
    let routes = vec![
        test_route(
            "1",
            "deepseek-v4-pro",
            "deepseek",
            "a",
            "deepseek-v4-pro",
            ProtocolType::OpenAi,
            0,
        ),
        test_route(
            "2",
            "deepseek-v4-flash",
            "deepseek",
            "a",
            "deepseek-v4-flash",
            ProtocolType::OpenAi,
            0,
        ),
        test_route(
            "3",
            "deepseek-v4-pro",
            "deepseek",
            "a",
            "deepseek-v4-pro-0813",
            ProtocolType::OpenAi,
            10,
        ),
        test_route(
            "4",
            "deepseek-v4-flash",
            "deepseek",
            "a",
            "deepseek-v4-flash",
            ProtocolType::Anthropic,
            0,
        ),
    ];
    let state = build_test_state(channels, accounts, routes);

    let response = forward_request(
        state,
        Request::builder()
            .method("GET")
            .uri("/v1/models")
            .body(Body::empty())
            .unwrap(),
        ProtocolType::OpenAi,
    )
    .await
    .unwrap();
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let ids: Vec<&str> = value["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec!["deepseek-v4-flash", "deepseek-v4-pro"]);

    // owned_by 取承载渠道的 vendor。
    let owned_by: Vec<&str> = value["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["owned_by"].as_str().unwrap())
        .collect();
    assert_eq!(owned_by, vec!["deepseek", "deepseek"]);
}

// flowlet_only 曝光模式随聚合模型一并移除，不再有「只返回聚合模型」的列表分支。

// test 3: 关闭直接路由后不再对外暴露该模型
#[tokio::test]
async fn e2e_models_hides_disabled_direct_routes() {
    let (addr, _) = spawn_spy_upstream(std::collections::HashMap::new()).await;
    let channels = vec![dual_protocol_channel("deepseek", "DeepSeek", &addr)];
    let accounts = vec![test_account("a", "deepseek", "key-a", 0)];
    let routes = vec![
        test_route(
            "1",
            "deepseek-v4-pro",
            "deepseek",
            "a",
            "deepseek-v4-pro",
            ProtocolType::OpenAi,
            0,
        ),
        test_route(
            "2",
            "deepseek-v4-flash",
            "deepseek",
            "a",
            "deepseek-v4-flash",
            ProtocolType::OpenAi,
            0,
        ),
    ];
    let toggled: Vec<RouteCandidate> = routes
        .into_iter()
        .map(|mut r| {
            if r.virtual_model_id == "deepseek-v4-flash" {
                r.enabled = false;
            }
            r
        })
        .collect();
    let state = build_test_state(channels, accounts, toggled);

    let response = forward_request(
        state,
        Request::builder()
            .method("GET")
            .uri("/v1/models")
            .body(Body::empty())
            .unwrap(),
        ProtocolType::OpenAi,
    )
    .await
    .unwrap();
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let ids: Vec<&str> = value["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec!["deepseek-v4-pro"]);
}

#[tokio::test]
async fn e2e_direct_model_account_round_robin() {
    let (addr, seen) = spawn_spy_upstream(status_map(&[
        ("key-a", StatusCode::OK),
        ("key-b", StatusCode::OK),
    ]))
    .await;
    let channels = vec![dual_protocol_channel("deepseek", "DeepSeek", &addr)];
    let accounts = vec![
        test_account("a", "deepseek", "key-a", 0),
        test_account("b", "deepseek", "key-b", 1),
    ];
    let routes = vec![
        test_route(
            "1",
            "deepseek-v4-pro",
            "deepseek",
            "a",
            "deepseek-v4-pro",
            ProtocolType::OpenAi,
            0,
        ),
        test_route(
            "2",
            "deepseek-v4-pro",
            "deepseek",
            "b",
            "deepseek-v4-pro",
            ProtocolType::OpenAi,
            0,
        ),
    ];
    let state = build_test_state(channels, accounts, routes);

    for _ in 0..3 {
        let s = state.clone();
        forward_request(s, chat_request("deepseek-v4-pro"), ProtocolType::OpenAi)
            .await
            .unwrap();
    }
    // 轮询：A → B → A（spy 累积记录全部调用顺序）
    assert_eq!(
        *seen.lock().unwrap(),
        vec![
            "key-a".to_string(),
            "key-b".to_string(),
            "key-a".to_string()
        ]
    );
}

// test 5: 直接模型同模型 fallback（A 429 → B 200）
#[tokio::test]
async fn e2e_direct_model_same_model_fallback() {
    let (addr, seen) = spawn_spy_upstream(status_map(&[
        ("key-a", StatusCode::TOO_MANY_REQUESTS),
        ("key-b", StatusCode::OK),
    ]))
    .await;
    let channels = vec![dual_protocol_channel("deepseek", "DeepSeek", &addr)];
    let accounts = vec![
        test_account("a", "deepseek", "key-a", 0),
        test_account("b", "deepseek", "key-b", 1),
    ];
    let routes = vec![
        test_route(
            "1",
            "deepseek-v4-pro",
            "deepseek",
            "a",
            "deepseek-v4-pro",
            ProtocolType::OpenAi,
            0,
        ),
        test_route(
            "2",
            "deepseek-v4-pro",
            "deepseek",
            "b",
            "deepseek-v4-pro",
            ProtocolType::OpenAi,
            0,
        ),
    ];
    let state = build_test_state(channels, accounts, routes);
    let response = forward_request(state, chat_request("deepseek-v4-pro"), ProtocolType::OpenAi)
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        *seen.lock().unwrap(),
        vec!["key-a".to_string(), "key-b".to_string()]
    );
}

// test 6: 直接模型禁止跨模型 fallback（deepseek-v4-pro 全败，LongCat 健康但不命中）
#[tokio::test]
async fn e2e_direct_model_no_cross_model_fallback() {
    let (addr, seen) = spawn_spy_upstream(status_map(&[
        ("key-ds", StatusCode::INTERNAL_SERVER_ERROR),
        ("key-lc", StatusCode::OK),
    ]))
    .await;
    let channels = vec![
        dual_protocol_channel("deepseek", "DeepSeek", &addr),
        dual_protocol_channel("longcat", "LongCat", &addr),
    ];
    let accounts = vec![
        test_account("ds", "deepseek", "key-ds", 0),
        test_account("lc", "longcat", "key-lc", 0),
    ];
    // 直接路由：deepseek-v4-pro 与 LongCat-2.0 各自独立
    let routes = vec![
        test_route(
            "1",
            "deepseek-v4-pro",
            "deepseek",
            "ds",
            "deepseek-v4-pro",
            ProtocolType::OpenAi,
            0,
        ),
        test_route(
            "2",
            "LongCat-2.0",
            "longcat",
            "lc",
            "LongCat-2.0",
            ProtocolType::OpenAi,
            0,
        ),
    ];
    let state = build_test_state(channels, accounts, routes);
    let response = forward_request(state, chat_request("deepseek-v4-pro"), ProtocolType::OpenAi)
        .await
        .unwrap();
    // deepseek-v4-pro 唯一账号失败 → 500，不命中 LongCat
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(*seen.lock().unwrap(), vec!["key-ds".to_string()]);
    assert!(!seen.lock().unwrap().contains(&"key-lc".to_string()));
}

// test 8: invalid_key 账号的唯一直接模型不出现在 /models
// test 8: invalid_key 账号的唯一直接模型不出现在 /models
#[tokio::test]
async fn e2e_models_excludes_invalid_key_direct_model() {
    let (addr, _) = spawn_spy_upstream(std::collections::HashMap::new()).await;
    let channels = vec![dual_protocol_channel("deepseek", "DeepSeek", &addr)];
    let healthy_account = test_account("ok", "deepseek", "key-ok", 0);
    let mut invalid_account = test_account("bad", "deepseek", "key-bad", 1);
    invalid_account.credential_status = "invalid_key".to_string();
    let accounts = vec![healthy_account, invalid_account];
    let routes = vec![
        // deepseek-v4-pro 同时有健康账号与 invalid 账号
        test_route(
            "1",
            "deepseek-v4-pro",
            "deepseek",
            "ok",
            "deepseek-v4-pro",
            ProtocolType::OpenAi,
            0,
        ),
        test_route(
            "2",
            "deepseek-v4-pro",
            "deepseek",
            "bad",
            "deepseek-v4-pro",
            ProtocolType::OpenAi,
            0,
        ),
        // deepseek-v4-flash 仅有 invalid 账号 → 不应出现
        test_route(
            "3",
            "deepseek-v4-flash",
            "deepseek",
            "bad",
            "deepseek-v4-flash",
            ProtocolType::OpenAi,
            0,
        ),
    ];
    let state = build_test_state(channels, accounts, routes);
    let response = forward_request(
        state,
        Request::builder()
            .method("GET")
            .uri("/v1/models")
            .body(Body::empty())
            .unwrap(),
        ProtocolType::OpenAi,
    )
    .await
    .unwrap();
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let ids: Vec<&str> = value["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["id"].as_str().unwrap())
        .collect();
    // deepseek-v4-flash 仅有 invalid 账号，不出现；deepseek-v4-pro 有健康账号，出现
    assert_eq!(ids, vec!["deepseek-v4-pro"]);
}

#[tokio::test]
async fn e2e_recovers_after_api_key_change() {
    // 第一轮：账号 A 401 → 标记 invalid_key
    let (addr, _seen1) =
        spawn_spy_upstream(status_map(&[("old-key", StatusCode::UNAUTHORIZED)])).await;
    let channels = vec![dual_protocol_channel("deepseek", "DeepSeek", &addr)];
    let accounts = vec![test_account("a", "deepseek", "old-key", 0)];
    let routes = vec![test_route(
        "1",
        "deepseek-v4-pro",
        "deepseek",
        "a",
        "deepseek-v4-pro",
        ProtocolType::OpenAi,
        0,
    )];
    let state = build_test_state(channels, accounts, routes);
    let storage = state.storage.clone();
    let response = forward_request(state, chat_request("deepseek-v4-pro"), ProtocolType::OpenAi)
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

    // 模拟用户修改 API Key 并保存：存储层重置 credential_status 为 healthy
    storage
        .save_channel_accounts(&[ChannelAccount {
            id: "a".to_string(),
            channel_id: "deepseek".to_string(),
            name: "a".to_string(),
            api_key: "new-key".to_string(),
            enabled: true,
            priority: 0,
            credential_status: "healthy".to_string(),
            ..Default::default()
        }])
        .unwrap();

    // 第二轮：新 key 可用，不重启代理（从存储重建状态）
    let (addr, seen2) = spawn_spy_upstream(status_map(&[("new-key", StatusCode::OK)])).await;
    let persisted = storage.list_channel_accounts().unwrap();
    let channels2 = vec![dual_protocol_channel("deepseek", "DeepSeek", &addr)];
    let routes2 = vec![test_route(
        "1",
        "deepseek-v4-pro",
        "deepseek",
        "a",
        "deepseek-v4-pro",
        ProtocolType::OpenAi,
        0,
    )];
    let state2 = build_test_state(channels2, persisted, routes2);
    let response2 = forward_request(
        state2,
        chat_request("deepseek-v4-pro"),
        ProtocolType::OpenAi,
    )
    .await
    .unwrap();
    assert_eq!(response2.status(), StatusCode::OK);
    assert_eq!(*seen2.lock().unwrap(), vec!["new-key".to_string()]);
}

// test 10: 同代理实例内 401 立即排除（同一 ProxyAppState，第二次请求跳过 A）
#[tokio::test]
async fn e2e_same_instance_excludes_401_account_on_next_request() {
    let (addr, seen) = spawn_spy_upstream(status_map(&[
        ("key-a", StatusCode::UNAUTHORIZED),
        ("key-b", StatusCode::OK),
    ]))
    .await;
    let channels = vec![dual_protocol_channel("deepseek", "DeepSeek", &addr)];
    let accounts = vec![
        test_account("a", "deepseek", "key-a", 0),
        test_account("b", "deepseek", "key-b", 1),
    ];
    let routes = vec![
        test_route(
            "1",
            "deepseek-v4-pro",
            "deepseek",
            "a",
            "deepseek-v4-pro",
            ProtocolType::OpenAi,
            0,
        ),
        test_route(
            "2",
            "deepseek-v4-pro",
            "deepseek",
            "b",
            "deepseek-v4-pro",
            ProtocolType::OpenAi,
            0,
        ),
    ];
    let state = build_test_state(channels, accounts, routes);

    // 第一次请求：A 401，不 fallback，A 被标记 invalid_key 并更新共享内存
    let response = forward_request(
        state.clone(),
        chat_request("deepseek-v4-pro"),
        ProtocolType::OpenAi,
    )
    .await
    .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(*seen.lock().unwrap(), vec!["key-a".to_string()]);

    // 第二次请求（同一 state，共享内存已更新）：A 被排除，命中 B
    let response2 = forward_request(state, chat_request("deepseek-v4-pro"), ProtocolType::OpenAi)
        .await
        .unwrap();
    assert_eq!(response2.status(), StatusCode::OK);
    assert_eq!(
        *seen.lock().unwrap(),
        vec!["key-a".to_string(), "key-b".to_string()]
    );
}

// test 11: 新账号保存兼容 — 缺省 credential_status 可反序列化（默认 healthy）
#[test]
fn e2e_new_account_default_credential_status() {
    // 模拟前端发送缺省 credential_status 的 JSON
    let json = r#"{
        "id": "acc-x",
        "channel_id": "deepseek",
        "name": "新账号",
        "api_key": "sk-xxx",
        "enabled": true,
        "priority": 0,
        "remark": null,
        "base_url_override": null,
        "last_used_at": null,
        "last_error": null,
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-01-01T00:00:00Z"
    }"#;
    let account: crate::core::config::ChannelAccount = serde_json::from_str(json).unwrap();
    assert_eq!(account.credential_status, "healthy");
}

// test 12: 双协议 /models 一致（同一组规范模型、同一顺序）
// test 12: 双协议 /models 一致（同一组规范模型、同一顺序）
#[tokio::test]
async fn e2e_dual_protocol_models_list_consistent_with_direct() {
    let (addr, _) = spawn_spy_upstream(std::collections::HashMap::new()).await;
    let channels = vec![dual_protocol_channel("deepseek", "DeepSeek", &addr)];
    let accounts = vec![test_account("a", "deepseek", "key-a", 0)];
    let routes = vec![
        test_route(
            "1",
            "deepseek-v4-pro",
            "deepseek",
            "a",
            "deepseek-v4-pro",
            ProtocolType::OpenAi,
            0,
        ),
        test_route(
            "2",
            "deepseek-v4-flash",
            "deepseek",
            "a",
            "deepseek-v4-flash",
            ProtocolType::OpenAi,
            0,
        ),
        test_route(
            "3",
            "deepseek-v4-pro",
            "deepseek",
            "a",
            "deepseek-v4-pro",
            ProtocolType::Anthropic,
            0,
        ),
        test_route(
            "4",
            "deepseek-v4-flash",
            "deepseek",
            "a",
            "deepseek-v4-flash",
            ProtocolType::Anthropic,
            0,
        ),
    ];
    let state = build_test_state(channels, accounts, routes);

    let openai = forward_request(
        state.clone(),
        Request::builder()
            .method("GET")
            .uri("/v1/models")
            .body(Body::empty())
            .unwrap(),
        ProtocolType::OpenAi,
    )
    .await
    .unwrap();
    let anthropic = forward_request(
        state,
        Request::builder()
            .method("GET")
            .uri("/anthropic/v1/models")
            .body(Body::empty())
            .unwrap(),
        ProtocolType::Anthropic,
    )
    .await
    .unwrap();
    let openai_body = axum::body::to_bytes(openai.into_body(), usize::MAX)
        .await
        .unwrap();
    let anthropic_body = axum::body::to_bytes(anthropic.into_body(), usize::MAX)
        .await
        .unwrap();
    let openai_value: serde_json::Value = serde_json::from_slice(&openai_body).unwrap();
    let anthropic_value: serde_json::Value = serde_json::from_slice(&anthropic_body).unwrap();
    let openai_ids: Vec<&str> = openai_value["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["id"].as_str().unwrap())
        .collect();
    let anthropic_ids: Vec<&str> = anthropic_value["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["id"].as_str().unwrap())
        .collect();
    assert_eq!(openai_ids, anthropic_ids);
    assert_eq!(openai_ids, vec!["deepseek-v4-flash", "deepseek-v4-pro"]);
}

#[tokio::test]
async fn e2e_alias_inbound_routes_to_canonical_route() {
    // deepseek-flash 是白名单规范 ID deepseek-v4.1-flash 的上游官方名/别名；
    // 客户端按官方名请求必须命中该规范模型的路由，并把上游模型名改写回原始 ID。
    let (addr, captured_body) = spawn_body_capturing_upstream().await;
    let state = build_test_state(
        vec![dual_protocol_channel("deepseek", "DeepSeek", &addr)],
        vec![test_account("ds", "deepseek", "key-ds", 0)],
        vec![test_route(
            "ds-route",
            "deepseek-v4.1-flash",
            "deepseek",
            "ds",
            "deepseek-flash",
            ProtocolType::OpenAi,
            0,
        )],
    );
    let storage = state.storage.clone();

    let response = forward_request(state, chat_request("deepseek-flash"), ProtocolType::OpenAi)
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let _ = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();

    let forwarded: serde_json::Value =
        serde_json::from_slice(&captured_body.lock().unwrap()).unwrap();
    assert_eq!(forwarded["model"], "deepseek-flash");

    let logs = wait_for_request_logs(&storage, 1).await;
    assert_eq!(logs[0].public_model.as_deref(), Some("deepseek-flash"));
    assert_eq!(
        logs[0].virtual_model.as_deref(),
        Some("deepseek-v4.1-flash")
    );
    assert_eq!(logs[0].upstream_model.as_deref(), Some("deepseek-flash"));
    assert_eq!(logs[0].route_reason.as_deref(), Some("direct"));
    assert_eq!(logs[0].status, Some(200));
}

#[tokio::test]
async fn e2e_alias_inbound_routes_on_anthropic_messages() {
    // DSH 原生 DeepSeek Provider 走 Anthropic Messages 线协议并发日期快照名。
    let (addr, captured_body) = spawn_body_capturing_upstream().await;
    let state = build_test_state(
        vec![dual_protocol_channel("deepseek", "DeepSeek", &addr)],
        vec![test_account("ds", "deepseek", "key-ds", 0)],
        vec![test_route(
            "ds-route",
            "deepseek-v4-pro",
            "deepseek",
            "ds",
            "deepseek-v4-pro",
            ProtocolType::Anthropic,
            0,
        )],
    );
    let storage = state.storage.clone();

    let request = Request::builder()
        .method("POST")
        .uri("/anthropic/v1/messages")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            r#"{"model":"deepseek-v4-pro-0813","max_tokens":10,"messages":[]}"#,
        ))
        .unwrap();
    let response = forward_request(state, request, ProtocolType::Anthropic)
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let _ = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();

    let forwarded: serde_json::Value =
        serde_json::from_slice(&captured_body.lock().unwrap()).unwrap();
    assert_eq!(forwarded["model"], "deepseek-v4-pro");

    let logs = wait_for_request_logs(&storage, 1).await;
    assert_eq!(
        logs[0].public_model.as_deref(),
        Some("deepseek-v4-pro-0813")
    );
    assert_eq!(logs[0].virtual_model.as_deref(), Some("deepseek-v4-pro"));
    assert_eq!(
        logs[0].upstream_url.as_deref(),
        Some(format!("{addr}/v1/messages").as_str())
    );
}

#[tokio::test]
async fn e2e_unregistered_model_still_model_not_exposed() {
    // 目录里没有的名字不归一、不回退：仍然 404 model_not_exposed，且不发上游。
    let (addr, seen) = spawn_spy_upstream(status_map(&[])).await;
    let state = build_test_state(
        vec![dual_protocol_channel("deepseek", "DeepSeek", &addr)],
        vec![test_account("ds", "deepseek", "key-ds", 0)],
        vec![test_route(
            "ds-route",
            "deepseek-v4.1-flash",
            "deepseek",
            "ds",
            "deepseek-flash",
            ProtocolType::OpenAi,
            0,
        )],
    );
    let storage = state.storage.clone();

    let response = forward_request(state, chat_request("gpt-5.6-luna"), ProtocolType::OpenAi)
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert!(seen.lock().unwrap().is_empty());

    let logs = wait_for_request_logs(&storage, 1).await;
    assert_eq!(logs[0].route_reason.as_deref(), Some("model_not_exposed"));
    assert_eq!(logs[0].public_model.as_deref(), Some("gpt-5.6-luna"));
    assert_eq!(logs[0].virtual_model.as_deref(), Some("gpt-5.6-luna"));
    assert_eq!(logs[0].upstream_url, None);
    assert!(logs[0].is_last_attempt);
}

#[tokio::test]
async fn e2e_alias_inbound_protocol_mismatch_uses_canonical_name() {
    // 别名请求在协议不匹配时也必须按规范 ID 定位候选：降级节点与终态错误都要能对上，
    // 且两行日志分别保留客户端原始名与规范 ID。
    let (addr, seen) = spawn_spy_upstream(status_map(&[])).await;
    let state = build_test_state(
        vec![dual_protocol_channel("deepseek", "DeepSeek", &addr)],
        vec![test_account("ds", "deepseek", "key-ds", 0)],
        vec![test_route(
            "openai-route",
            "deepseek-v4.1-flash",
            "deepseek",
            "ds",
            "deepseek-flash",
            ProtocolType::OpenAi,
            0,
        )],
    );
    let storage = state.storage.clone();

    let request = Request::builder()
        .method("POST")
        .uri("/anthropic/v1/messages")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            r#"{"model":"deepseek-flash","max_tokens":10,"messages":[]}"#,
        ))
        .unwrap();
    let response = forward_request(state, request, ProtocolType::Anthropic)
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert!(seen.lock().unwrap().is_empty());

    let attempts = wait_for_request_logs(&storage, 2).await;
    assert_eq!(
        attempts[0].route_reason.as_deref(),
        Some("protocol_unsupported")
    );
    assert_eq!(
        attempts[1].route_reason.as_deref(),
        Some("model_protocol_unsupported")
    );
    for attempt in &attempts {
        assert_eq!(attempt.public_model.as_deref(), Some("deepseek-flash"));
        assert_eq!(
            attempt.virtual_model.as_deref(),
            Some("deepseek-v4.1-flash")
        );
    }
}

#[tokio::test]
async fn e2e_alias_inbound_shares_round_robin_cursor_with_canonical_name() {
    // 轮询游标按归一后的模型名分组，别名请求与规范名请求共享同一账号池。
    let (addr, seen) = spawn_spy_upstream(status_map(&[
        ("key-a", StatusCode::OK),
        ("key-b", StatusCode::OK),
    ]))
    .await;
    let state = build_test_state(
        vec![dual_protocol_channel("deepseek", "DeepSeek", &addr)],
        vec![
            test_account("a", "deepseek", "key-a", 0),
            test_account("b", "deepseek", "key-b", 0),
        ],
        vec![
            test_route(
                "route-a",
                "deepseek-v4.1-flash",
                "deepseek",
                "a",
                "deepseek-flash",
                ProtocolType::OpenAi,
                0,
            ),
            test_route(
                "route-b",
                "deepseek-v4.1-flash",
                "deepseek",
                "b",
                "deepseek-flash",
                ProtocolType::OpenAi,
                0,
            ),
        ],
    );

    for model in ["deepseek-flash", "deepseek-v4.1-flash", "deepseek-flash"] {
        let response = forward_request(state.clone(), chat_request(model), ProtocolType::OpenAi)
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let _ = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
    }

    assert_eq!(
        seen.lock().unwrap().clone(),
        vec![
            "key-a".to_string(),
            "key-b".to_string(),
            "key-a".to_string()
        ]
    );
}

#[tokio::test]
async fn e2e_case_variant_inbound_name_routes_to_canonical_case() {
    // 目录查表大小写不敏感，但命中后必须回落到目录里的规范大小写（路由存的是 LongCat-2.0）。
    let (addr, captured_body) = spawn_body_capturing_upstream().await;
    let state = build_test_state(
        vec![dual_protocol_channel("longcat", "LongCat", &addr)],
        vec![test_account("lc", "longcat", "key-lc", 0)],
        vec![test_route(
            "lc-route",
            "LongCat-2.0",
            "longcat",
            "lc",
            "LongCat-2.0",
            ProtocolType::OpenAi,
            0,
        )],
    );
    let storage = state.storage.clone();

    let response = forward_request(state, chat_request("LONGCAT-2.0"), ProtocolType::OpenAi)
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let _ = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let forwarded: serde_json::Value =
        serde_json::from_slice(&captured_body.lock().unwrap()).unwrap();
    assert_eq!(forwarded["model"], "LongCat-2.0");

    let logs = wait_for_request_logs(&storage, 1).await;
    assert_eq!(logs[0].public_model.as_deref(), Some("LONGCAT-2.0"));
    assert_eq!(logs[0].virtual_model.as_deref(), Some("LongCat-2.0"));
}

#[tokio::test]
async fn model_list_does_not_advertise_aliases() {
    // 接受别名但不对外宣传别名：/models 仍只暴露规范模型 ID。
    let (addr, _seen) = spawn_spy_upstream(status_map(&[])).await;
    let state = build_test_state(
        vec![dual_protocol_channel("deepseek", "DeepSeek", &addr)],
        vec![test_account("ds", "deepseek", "key-ds", 0)],
        vec![test_route(
            "ds-route",
            "deepseek-v4.1-flash",
            "deepseek",
            "ds",
            "deepseek-flash",
            ProtocolType::OpenAi,
            0,
        )],
    );
    let request = Request::builder()
        .method("GET")
        .uri("/v1/models")
        .body(Body::empty())
        .unwrap();
    let response = forward_request(state, request, ProtocolType::OpenAi)
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let ids: Vec<&str> = body["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|model| model["id"].as_str().unwrap())
        .collect();
    assert!(ids.contains(&"deepseek-v4.1-flash"));
    assert!(!ids.contains(&"deepseek-flash"));
}

#[test]
fn match_candidates_keeps_exact_match_contract_for_aliases() {
    // 归一发生在 proxy.rs、match_candidates 之上；匹配器本身仍是精确匹配，
    // 直接把别名交给它会落空（用它证明归一没有被塞进匹配器）。
    let channels = vec![dual_protocol_channel(
        "deepseek",
        "DeepSeek",
        "http://upstream",
    )];
    let accounts = vec![test_account("ds", "deepseek", "key-ds", 0)];
    let routes = vec![test_route(
        "ds-route",
        "deepseek-v4.1-flash",
        "deepseek",
        "ds",
        "deepseek-flash",
        ProtocolType::OpenAi,
        0,
    )];
    let mut round_robin = std::collections::HashMap::new();
    let selection = match_candidates(
        &routes,
        &[],
        &[],
        Some("deepseek-flash"),
        &ProtocolType::OpenAi,
        None,
        &accounts,
        &channels,
        &mut round_robin,
    );
    assert!(selection.matched.is_empty());
    assert!(selection.protocol_skipped.is_empty());
}

// ─── Anthropic Files API（渠道级账号绑定）─────────────────────────────────────
//
// Files 请求不带 model，不能走 match_candidates；file id 只在绑定账号的 API Key 上有效，
// 因此 upload/list/retrieve/delete 固定走渠道级绑定账号，引用文件的 /messages 也钉到它。

#[derive(Clone, Debug)]
struct SeenFilesRequest {
    method: String,
    path: String,
    api_key: String,
    body: Vec<u8>,
}

fn files_api_channel(id: &str, name: &str, base_url: &str) -> ChannelPreset {
    ChannelPreset {
        supports_files_api: true,
        ..dual_protocol_channel(id, name, base_url)
    }
}

/// 记录 Files 请求的服务端：捕获方法、路径、鉴权头与 body，按需返回固定状态。
async fn spawn_files_upstream(
    status: StatusCode,
    response_body: &'static str,
) -> (String, Arc<Mutex<Vec<SeenFilesRequest>>>) {
    let seen = Arc::new(Mutex::new(Vec::<SeenFilesRequest>::new()));
    let state = seen.clone();
    let handler = move |method: Method, uri: Uri, headers: HeaderMap, body: Bytes| {
        let state = state.clone();
        async move {
            state.lock().unwrap().push(SeenFilesRequest {
                method: method.to_string(),
                path: uri
                    .path_and_query()
                    .map(|v| v.as_str().to_string())
                    .unwrap_or_default(),
                api_key: headers
                    .get("x-api-key")
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_string)
                    .or_else(|| {
                        headers
                            .get(header::AUTHORIZATION)
                            .and_then(|value| value.to_str().ok())
                            .and_then(|value| value.strip_prefix("Bearer "))
                            .map(str::to_string)
                    })
                    .unwrap_or_default(),
                body: body.to_vec(),
            });
            (
                status,
                [("content-type", "application/json")],
                response_body,
            )
        }
    };
    let upstream = Router::new()
        .route("/v1/files", post(handler.clone()).get(handler.clone()))
        .route(
            "/v1/files/{id}",
            axum::routing::get(handler.clone()).delete(handler.clone()),
        )
        // 引用文件的 /messages 也打到同一个假上游，便于断言它落在哪个账号上。
        .route("/v1/messages", post(handler))
        .with_state(seen.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, upstream).await.unwrap();
    });
    (format!("http://{addr}"), seen)
}

fn files_upload_request(path: &str, method: &str, body: &[u8]) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(path)
        .header(
            header::CONTENT_TYPE,
            "multipart/form-data; boundary=----dsh-test-boundary",
        )
        .header("anthropic-version", "2023-06-01")
        .header("anthropic-beta", "files-api-2025-04-14")
        .body(Body::from(body.to_vec()))
        .unwrap()
}

#[tokio::test]
async fn files_upload_forwards_to_the_bound_account_and_keeps_the_body() {
    let (addr, seen) = spawn_files_upstream(
        StatusCode::OK,
        r#"{"id":"file-abc","type":"file","mime_type":"image/png","size_bytes":3,"created_at":"2026-10-19T00:00:00Z","filename":"dsh-x.png"}"#,
    )
    .await;
    let state = build_test_state(
        vec![files_api_channel("deepseek", "DeepSeek", &addr)],
        vec![test_account("ds", "deepseek", "key-ds", 0)],
        vec![],
    );
    let storage = state.storage.clone();

    let payload = b"------dsh-test-boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"dsh-x.png\"\r\n\r\nPNG\r\n------dsh-test-boundary--\r\n";
    let response = forward_request(
        state,
        files_upload_request("/anthropic/v1/files", "POST", payload),
        ProtocolType::Anthropic,
    )
    .await
    .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let requests = seen.lock().unwrap().clone();
    assert_eq!(requests.len(), 1);
    // `/anthropic` 入口前缀被去掉，其余路径原样拼到渠道的 anthropic base URL 上。
    assert_eq!(requests[0].path, "/v1/files");
    assert_eq!(requests[0].method, "POST");
    // 入站鉴权头被替换成绑定账号的 API Key（DeepSeek 走 x-api-key）。
    assert_eq!(requests[0].api_key, "key-ds");
    // multipart body 逐字节透传。
    assert_eq!(requests[0].body, payload);

    let logs = wait_for_request_logs(&storage, 1).await;
    assert_eq!(logs[0].request_type, "files");
    assert_eq!(logs[0].route_reason.as_deref(), Some("files_api"));
    assert_eq!(logs[0].public_model, None);
    assert_eq!(logs[0].virtual_model, None);
    assert_eq!(logs[0].upstream_model, None);
    assert_eq!(logs[0].account_name.as_deref(), Some("ds"));
    assert_eq!(logs[0].status, Some(200));
    assert!(logs[0].is_last_attempt);
    // multipart 上传不再往日志里复制一份 body。
    assert_eq!(logs[0].req_body_b64, None);
}

#[tokio::test]
async fn files_request_keeps_the_operation_paths_and_methods() {
    let (addr, seen) = spawn_files_upstream(StatusCode::OK, r#"{"data":[]}"#).await;
    let state = build_test_state(
        vec![files_api_channel("deepseek", "DeepSeek", &addr)],
        vec![test_account("ds", "deepseek", "key-ds", 0)],
        vec![],
    );

    for (method, path) in [
        ("GET", "/anthropic/v1/files?limit=100&after_id=file-x"),
        ("GET", "/anthropic/v1/files/file-abc"),
        ("DELETE", "/anthropic/v1/files/file-abc"),
    ] {
        let response = forward_request(
            state.clone(),
            files_upload_request(path, method, b""),
            ProtocolType::Anthropic,
        )
        .await
        .unwrap();
        assert_eq!(response.status(), StatusCode::OK, "{method} {path}");
    }

    let requests = seen.lock().unwrap().clone();
    let paths: Vec<(String, String)> = requests
        .iter()
        .map(|request| (request.method.clone(), request.path.clone()))
        .collect();
    assert_eq!(
        paths,
        vec![
            (
                "GET".to_string(),
                "/v1/files?limit=100&after_id=file-x".to_string()
            ),
            ("GET".to_string(), "/v1/files/file-abc".to_string()),
            ("DELETE".to_string(), "/v1/files/file-abc".to_string()),
        ]
    );
}

#[tokio::test]
async fn files_request_without_a_files_capable_channel_returns_503() {
    let (addr, seen) = spawn_files_upstream(StatusCode::OK, "{}").await;
    let state = build_test_state(
        // 渠道没有声明 supports_files_api：不上游发请求，明确报本地配置问题。
        vec![dual_protocol_channel("deepseek", "DeepSeek", &addr)],
        vec![test_account("ds", "deepseek", "key-ds", 0)],
        vec![],
    );
    let storage = state.storage.clone();

    let response = forward_request(
        state,
        files_upload_request("/anthropic/v1/files", "POST", b"x"),
        ProtocolType::Anthropic,
    )
    .await
    .unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert!(seen.lock().unwrap().is_empty());

    let logs = wait_for_request_logs(&storage, 1).await;
    assert_eq!(
        logs[0].route_reason.as_deref(),
        Some("files_account_unavailable")
    );
    assert_eq!(logs[0].status, Some(503));
    assert_eq!(logs[0].upstream_url, None);
}

#[tokio::test]
async fn files_upstream_error_status_and_body_pass_through_unchanged() {
    // DSH 依赖上游错误原文做「list + delete + 重新上传」的配额自愈，不能改写。
    let upstream_body = r#"{"error":{"type":"quota_exceeded","code":"file_quota_exceeded","message":"storage quota exceeded"}}"#;
    let (addr, seen) = spawn_files_upstream(StatusCode::CONFLICT, upstream_body).await;
    let state = build_test_state(
        vec![files_api_channel("deepseek", "DeepSeek", &addr)],
        vec![test_account("ds", "deepseek", "key-ds", 0)],
        vec![],
    );
    let storage = state.storage.clone();

    let response = forward_request(
        state,
        files_upload_request("/anthropic/v1/files", "POST", b"x"),
        ProtocolType::Anthropic,
    )
    .await
    .unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    assert_eq!(body, upstream_body.as_bytes());

    // 只有一个绑定账号，不会换账号重试（换账号也认不到同一个 file id）。
    assert_eq!(seen.lock().unwrap().len(), 1);
    let logs = wait_for_request_logs(&storage, 1).await;
    assert_eq!(logs[0].status, Some(409));
}

/// 两个候选账号：只有 `deepseek` 渠道声明了 Files API，绑定账号即它的账号。
fn files_pinning_state(addr: &str) -> ProxyAppState {
    build_test_state(
        vec![
            files_api_channel("deepseek", "DeepSeek", addr),
            dual_protocol_channel("custom", "自定义渠道", addr),
        ],
        vec![
            test_account("ds", "deepseek", "key-ds", 0),
            test_account("alt", "custom", "key-alt", 0),
        ],
        vec![
            test_route(
                "route-ds",
                "deepseek-v4.1-flash",
                "deepseek",
                "ds",
                "deepseek-flash",
                ProtocolType::Anthropic,
                0,
            ),
            test_route(
                "route-alt",
                "deepseek-v4.1-flash",
                "custom",
                "alt",
                "deepseek-v4.1-flash",
                ProtocolType::Anthropic,
                0,
            ),
        ],
    )
}

fn messages_request(model: &str, files_beta: bool) -> Request<Body> {
    let mut builder = Request::builder()
        .method("POST")
        .uri("/anthropic/v1/messages")
        .header(header::CONTENT_TYPE, "application/json");
    if files_beta {
        builder = builder.header("anthropic-beta", "files-api-2025-04-14");
    }
    builder
        .body(Body::from(format!(
            r#"{{"model":"{model}","max_tokens":16,"messages":[]}}"#
        )))
        .unwrap()
}

#[tokio::test]
async fn messages_referencing_files_pin_to_the_bound_account() {
    let (addr, seen) =
        spawn_files_upstream(StatusCode::OK, r#"{"type":"message","content":[]}"#).await;
    let state = files_pinning_state(&addr);
    let storage = state.storage.clone();

    let response = forward_request(
        state,
        messages_request("deepseek-flash", true),
        ProtocolType::Anthropic,
    )
    .await
    .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let requests = seen.lock().unwrap().clone();
    assert_eq!(requests.len(), 1);
    // 钉到绑定账号，而不是轮询到另一个候选。
    assert_eq!(requests[0].api_key, "key-ds");

    let logs = wait_for_request_logs(&storage, 1).await;
    assert_eq!(logs[0].route_reason.as_deref(), Some("files_api_pinned"));
    assert_eq!(logs[0].account_name.as_deref(), Some("ds"));
    assert_eq!(
        logs[0].virtual_model.as_deref(),
        Some("deepseek-v4.1-flash")
    );
}

#[tokio::test]
async fn messages_without_the_files_beta_keep_normal_routing() {
    let (addr, seen) =
        spawn_files_upstream(StatusCode::OK, r#"{"type":"message","content":[]}"#).await;
    let state = files_pinning_state(&addr);
    let storage = state.storage.clone();

    let response = forward_request(
        state,
        messages_request("deepseek-flash", false),
        ProtocolType::Anthropic,
    )
    .await
    .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(seen.lock().unwrap().len(), 1);

    let logs = wait_for_request_logs(&storage, 1).await;
    assert_eq!(logs[0].route_reason.as_deref(), Some("direct"));
}

#[tokio::test]
async fn files_beta_pin_miss_falls_back_to_normal_routing() {
    // 绑定账号（deepseek 渠道）没有这个模型的路由 → 不干预，按常规候选走，并记下原因。
    let (addr, seen) =
        spawn_files_upstream(StatusCode::OK, r#"{"type":"message","content":[]}"#).await;
    let state = build_test_state(
        vec![
            files_api_channel("deepseek", "DeepSeek", &addr),
            dual_protocol_channel("custom", "自定义渠道", &addr),
        ],
        vec![
            test_account("ds", "deepseek", "key-ds", 0),
            test_account("alt", "custom", "key-alt", 0),
        ],
        vec![test_route(
            "route-alt",
            "deepseek-v4.1-flash",
            "custom",
            "alt",
            "deepseek-v4.1-flash",
            ProtocolType::Anthropic,
            0,
        )],
    );
    let storage = state.storage.clone();

    let response = forward_request(
        state,
        messages_request("deepseek-flash", true),
        ProtocolType::Anthropic,
    )
    .await
    .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let requests = seen.lock().unwrap().clone();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].api_key, "key-alt");

    let logs = wait_for_request_logs(&storage, 1).await;
    assert_eq!(
        logs[0].route_reason.as_deref(),
        Some("files_api_pin_missed")
    );
}

#[test]
fn files_account_prefers_a_deterministic_account() {
    // 绑定必须确定：同一配置反复取到同一个账号，不随轮询游标变化。
    let channels = vec![
        files_api_channel("deepseek", "DeepSeek", "http://upstream"),
        files_api_channel("custom", "自定义渠道", "http://upstream"),
    ];
    let accounts = vec![
        test_account("ds-late", "deepseek", "key-late", 5),
        test_account("ds-first", "deepseek", "key-first", 1),
        test_account("alt", "custom", "key-alt", 0),
    ];
    // 渠道 id 先排序（custom < deepseek），因此绑定的是自定义渠道优先级最高的账号。
    for _ in 0..3 {
        let (channel, account) = files_account(&channels, &accounts).unwrap();
        assert_eq!(channel.id, "custom");
        assert_eq!(account.id, "alt");
    }

    // 自定义渠道没有可路由账号时回落到下一个渠道里优先级最高的账号。
    let mut disabled = accounts.clone();
    disabled[2].enabled = false;
    let (channel, account) = files_account(&channels, &disabled).unwrap();
    assert_eq!(channel.id, "deepseek");
    assert_eq!(account.id, "ds-first");

    // 没有声明 Files API 的渠道不参与绑定。
    assert!(files_account(
        &[dual_protocol_channel(
            "deepseek",
            "DeepSeek",
            "http://upstream"
        )],
        &accounts,
    )
    .is_none());
}

#[tokio::test]
async fn openai_api_forwards_direct_models_with_native_protocols() {
    let app = Router::new().fallback(
        |uri: Uri, headers: axum::http::HeaderMap, body: axum::Json<serde_json::Value>| async move {
            let expected_path = if body.0.get("input").is_some() {
                "/v1/responses"
            } else {
                "/v1/chat/completions"
            };
            assert_eq!(uri.path(), expected_path);
            assert_eq!(headers["authorization"], "Bearer project-key");
            assert_eq!(body.0["model"], "gpt-6.1-sol");
            assert_eq!(body.0["metadata"]["keep"], "unchanged");
            (
                StatusCode::OK,
                [("content-type", "application/json")],
                r#"{"id":"mock-response","usage":{"input_tokens":2,"output_tokens":1}}"#,
            )
        },
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let mut channel = ChannelPreset::openai_api();
    channel.openai_base_url = format!("http://{addr}/v1");
    for protocol in [ProtocolType::OpenAi, ProtocolType::Responses] {
        // 入站别名 / 大小写变体都归一到规范模型 gpt-6.1-sol。
        for model in ["openai/GPT-6.1-SOL", "gpt-6.1-sol"] {
            let routes = vec![test_route(
                "direct",
                "gpt-6.1-sol",
                "openai-api",
                "account",
                "gpt-6.1-sol",
                protocol.clone(),
                0,
            )];
            let state = build_test_state(
                vec![channel.clone()],
                vec![test_account("account", "openai-api", "project-key", 0)],
                routes,
            );
            let mut payload = serde_json::json!({"model":model,"metadata":{"keep":"unchanged"}});
            let path = if protocol == ProtocolType::Responses {
                payload["input"] = serde_json::json!("hello");
                payload["store"] = serde_json::json!(false);
                "/v1/responses"
            } else {
                payload["messages"] = serde_json::json!([{"role":"user","content":"hello"}]);
                "/v1/chat/completions"
            };
            let request = Request::builder()
                .method("POST")
                .uri(path)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(payload.to_string()))
                .unwrap();
            let response = forward_request(state, request, protocol.clone())
                .await
                .unwrap();
            let status = response.status();
            let body = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap();
            assert_eq!(
                status,
                StatusCode::OK,
                "{protocol:?} {model}: {}",
                String::from_utf8_lossy(&body)
            );
            assert!(std::str::from_utf8(&body)
                .unwrap()
                .contains("mock-response"));
        }
    }
    server.abort();
}

#[tokio::test]
async fn openai_api_models_list_respects_protocol_and_disabled_account() {
    let mut account = test_account("account", "openai-api", "project-key", 0);
    let channel = ChannelPreset::openai_api();
    let routes = vec![test_route(
        "direct",
        "gpt-6.1-sol",
        "openai-api",
        "account",
        "gpt-6.1-sol",
        ProtocolType::OpenAi,
        0,
    )];
    for (protocol, count) in [(ProtocolType::OpenAi, 1), (ProtocolType::Anthropic, 0)] {
        let response =
            build_model_list_response(&routes, &[account.clone()], &[channel.clone()], &protocol);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["data"].as_array().unwrap().len(), count);
    }
    let response = build_model_list_response(
        &routes,
        &[account.clone()],
        &[channel.clone()],
        &ProtocolType::OpenAi,
    );
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(value["data"][0]["id"], "gpt-6.1-sol");
    account.enabled = false;
    let response =
        build_model_list_response(&routes, &[account], &[channel], &ProtocolType::OpenAi);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(value["data"].as_array().unwrap().is_empty());
}

#[path = "proxy_tests/upstream_proxy_tests.rs"]
mod upstream_proxy_tests;

#[tokio::test]
async fn vibetoken_forwards_direct_models_with_native_protocols() {
    let app = Router::new().fallback(
        |uri: Uri, headers: axum::http::HeaderMap, body: axum::Json<serde_json::Value>| async move {
            let expected_path = if body.0.get("input").is_some() {
                "/v1/responses"
            } else {
                "/v1/chat/completions"
            };
            assert_eq!(uri.path(), expected_path);
            assert_eq!(headers["authorization"], "Bearer project-key");
            assert_eq!(body.0["model"], "deepseek/deepseek-v4-pro");
            assert_eq!(body.0["metadata"]["keep"], "unchanged");
            (
                StatusCode::OK,
                [("content-type", "application/json")],
                r#"{"id":"mock-response","usage":{"input_tokens":2,"output_tokens":1}}"#,
            )
        },
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let mut channel = ChannelPreset::vibetoken();
    channel.openai_base_url = format!("http://{addr}/v1");
    for protocol in [ProtocolType::OpenAi, ProtocolType::Responses] {
        // 入站规范名 / 大小写变体都归一到同一规范模型，上游保留渠道前缀写法。
        for model in ["deepseek/DEEPSEEK-V4-PRO", "deepseek-v4-pro"] {
            let routes = vec![test_route(
                "direct",
                "deepseek-v4-pro",
                "vibetoken",
                "account",
                "deepseek/deepseek-v4-pro",
                protocol.clone(),
                0,
            )];
            let state = build_test_state(
                vec![channel.clone()],
                vec![test_account("account", "vibetoken", "project-key", 0)],
                routes,
            );
            let mut payload = serde_json::json!({"model":model,"metadata":{"keep":"unchanged"}});
            let path = if protocol == ProtocolType::Responses {
                payload["input"] = serde_json::json!("hello");
                payload["store"] = serde_json::json!(false);
                "/v1/responses"
            } else {
                payload["messages"] = serde_json::json!([{"role":"user","content":"hello"}]);
                "/v1/chat/completions"
            };
            let request = Request::builder()
                .method("POST")
                .uri(path)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(payload.to_string()))
                .unwrap();
            let response = forward_request(state, request, protocol.clone())
                .await
                .unwrap();
            let status = response.status();
            let body = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap();
            assert_eq!(
                status,
                StatusCode::OK,
                "{protocol:?} {model}: {}",
                String::from_utf8_lossy(&body)
            );
            assert!(std::str::from_utf8(&body)
                .unwrap()
                .contains("mock-response"));
        }
    }
    server.abort();
}

// ─── 入站模型名归一（别名 / 官方 API 名 / 大小写 / 厂商前缀）──────────────────
//
// 客户端可能用厂商官方 API 名或目录登记的别名请求对外模型（DSH 原生 DeepSeek Provider
// 固定发 deepseek-flash）。对外身份是规范 ID，因此代理在匹配前按 model-catalog.json
// 归一；日志仍分别保留客户端原始名（public_model）与规范 ID（virtual_model）。

/// 记录上游收到的请求体，供断言转发前的 model 改写。
async fn spawn_body_capturing_upstream() -> (String, Arc<Mutex<Vec<u8>>>) {
    let captured = Arc::new(Mutex::new(Vec::<u8>::new()));
    let captured_state = captured.clone();
    let upstream = Router::new()
        .route(
            "/v1/chat/completions",
            post({
                let captured = captured_state.clone();
                move |body: Bytes| {
                    let captured = captured.clone();
                    async move {
                        *captured.lock().unwrap() = body.to_vec();
                        (
                            StatusCode::OK,
                            [("content-type", "application/json")],
                            r#"{"choices":[]}"#,
                        )
                    }
                }
            }),
        )
        .route(
            "/v1/messages",
            post(move |body: Bytes| {
                let captured = captured_state.clone();
                async move {
                    *captured.lock().unwrap() = body.to_vec();
                    (
                        StatusCode::OK,
                        [("content-type", "application/json")],
                        r#"{"type":"message","content":[]}"#,
                    )
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, upstream).await.unwrap();
    });
    (format!("http://{addr}"), captured)
}

async fn wait_for_request_logs(storage: &Storage, expected: usize) -> Vec<RequestLogRow> {
    tokio::time::timeout(std::time::Duration::from_secs(1), async {
        loop {
            let final_rows = storage.list_request_logs().unwrap();
            if let Some(final_row) = final_rows.first() {
                let rows = storage
                    .list_request_logs_by_request_id(&final_row.request_id)
                    .unwrap();
                if rows.len() == expected {
                    break rows;
                }
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn vibetoken_models_list_respects_protocol_and_disabled_account() {
    let mut account = test_account("account", "vibetoken", "project-key", 0);
    let channel = ChannelPreset::vibetoken();
    let routes = vec![test_route(
        "direct",
        "deepseek-v4-pro",
        "vibetoken",
        "account",
        "deepseek/deepseek-v4-pro",
        ProtocolType::OpenAi,
        0,
    )];
    for (protocol, count) in [
        (ProtocolType::OpenAi, 1),
        (ProtocolType::Responses, 0),
        (ProtocolType::Anthropic, 0),
    ] {
        let response =
            build_model_list_response(&routes, &[account.clone()], &[channel.clone()], &protocol);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["data"].as_array().unwrap().len(), count);
    }
    account.enabled = false;
    let response =
        build_model_list_response(&routes, &[account], &[channel], &ProtocolType::OpenAi);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(value["data"].as_array().unwrap().is_empty());
}

// ─── Streaming compressed SSE (usage / TTFT observability) ──────────────────
//
// reqwest 未启用自动解压，上游 SSE 若带 content-encoding 则字节流是压缩体。这里验证：
// 观测链路（TTFT / usage / 终止标记）吃增量解压后的明文，而转发给客户端的原始字节、
// content-encoding 头与请求日志的响应体捕获都保持既有语义。

/// 带多字节 UTF-8 与 usage 的 OpenAI 兼容流式 SSE 原文。
const COMPRESSED_STREAM_SSE_PLAIN: &str = concat!(
    "data: {\"id\":\"chatcmpl-1\",\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\n",
    "data: {\"id\":\"chatcmpl-1\",\"choices\":[{\"delta\":{\"content\":\"你好，世界 🌍\"}}]}\n\n",
    "data: {\"id\":\"chatcmpl-1\",\"choices\":[{\"delta\":{\"content\":\" flowlet stream\"}}]}\n\n",
    "data: {\"id\":\"chatcmpl-1\",\"choices\":[],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":42,\"total_tokens\":52}}\n\n",
    "data: [DONE]\n\n",
);

fn compressed_stream_expected_usage() -> ResponseUsage {
    ResponseUsage {
        input_tokens: Some(10),
        input_cached_tokens: None,
        input_uncached_tokens: None,
        input_cache_write_tokens: None,
        output_tokens: Some(42),
        total_tokens: Some(52),
    }
}

fn gzip_encode_bytes(bytes: &[u8]) -> Vec<u8> {
    use flate2::{write::GzEncoder, Compression};
    use std::io::Write;
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(bytes).unwrap();
    encoder.finish().unwrap()
}

fn deflate_encode_bytes(bytes: &[u8]) -> Vec<u8> {
    use flate2::{write::DeflateEncoder, Compression};
    use std::io::Write;
    let mut encoder = DeflateEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(bytes).unwrap();
    encoder.finish().unwrap()
}

fn zstd_encode_bytes(bytes: &[u8]) -> Vec<u8> {
    zstd::stream::encode_all(bytes, 0).unwrap()
}

fn brotli_encode_bytes(bytes: &[u8]) -> Vec<u8> {
    use std::io::Write;
    let mut writer = brotli::CompressorWriter::new(Vec::new(), 4096, 5, 22);
    writer.write_all(bytes).unwrap();
    writer.into_inner()
}

fn compress_stream_sse(encoding: &str, plain: &[u8]) -> Vec<u8> {
    match encoding {
        "gzip" => gzip_encode_bytes(plain),
        "deflate" => deflate_encode_bytes(plain),
        "zstd" => zstd_encode_bytes(plain),
        "br" => brotli_encode_bytes(plain),
        other => panic!("unsupported test encoding: {other}"),
    }
}

/// 直接驱动流式观测解压器，按 `chunk_sizes` 循环切分压缩字节喂入，返回拼回的明文；
/// 同时断言每次喂入不会改写调用方持有的原始分块。
fn reassemble_with_stream_decoder(
    encoding: &str,
    compressed: &[u8],
    chunk_sizes: &[usize],
) -> Vec<u8> {
    use proxy_http::{StreamDecodedChunk, StreamUsageDecoder};

    let mut decoder = StreamUsageDecoder::for_content_encoding(Some(encoding));
    let mut assembled = Vec::new();
    let mut offset = 0;
    let mut index = 0;
    while offset < compressed.len() {
        let size = chunk_sizes[index % chunk_sizes.len()].max(1);
        let end = (offset + size).min(compressed.len());
        let original = compressed[offset..end].to_vec();
        let chunk = compressed[offset..end].to_vec();
        let mut decoded = Vec::new();
        let outcome = decoder.decode_chunk(&chunk, &mut decoded);
        match outcome {
            StreamDecodedChunk::Passthrough => assembled.extend_from_slice(&chunk),
            StreamDecodedChunk::Decoded => assembled.extend_from_slice(&decoded),
            StreamDecodedChunk::Disabled => panic!("{encoding}: 合法压缩流不应停用观测解压"),
        }
        assert_eq!(original, chunk, "{encoding}: 观测解压不得改写原始输入字节");
        offset = end;
        index += 1;
    }
    let mut tail = Vec::new();
    assert!(
        decoder.finish(&mut tail),
        "{encoding}: 完整压缩流 flush 应成功"
    );
    assembled.extend_from_slice(&tail);
    assembled
}

/// 通过真实的 `capture_timed_stream` 跑一段压缩 SSE，返回（转发出的原始字节，StreamDone）。
async fn run_compressed_stream_capture(
    compressed: &[u8],
    chunk_sizes: &[usize],
    content_encoding: &str,
) -> (Vec<u8>, StreamDone) {
    let mut chunks = Vec::new();
    let mut offset = 0;
    let mut index = 0;
    while offset < compressed.len() {
        let size = chunk_sizes[index % chunk_sizes.len()].max(1);
        let end = (offset + size).min(compressed.len());
        chunks.push(Ok::<Bytes, reqwest::Error>(Bytes::copy_from_slice(
            &compressed[offset..end],
        )));
        offset = end;
        index += 1;
    }
    let capture = LogCaptureConfig::default();
    let (tx_done, rx_done) = tokio::sync::oneshot::channel();
    let stream = capture_timed_stream(
        futures_util::stream::iter(chunks),
        tx_done,
        &capture,
        Instant::now(),
        Some(content_encoding.to_string()),
        std::time::Duration::from_secs(1),
        ActivityTracker::new().track(),
    );
    futures_util::pin_mut!(stream);
    let mut forwarded = Vec::new();
    while let Some(chunk) = stream.next().await {
        forwarded.extend_from_slice(&chunk.unwrap());
    }
    let done = rx_done.await.unwrap();
    (forwarded, done)
}

fn decode_captured_body_base64(encoded: &str) -> Vec<u8> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .unwrap()
}

#[test]
fn stream_usage_decoder_gzip_reassembles_plaintext_usage_and_ttft_across_chunks() {
    use proxy_http::{StreamDecodedChunk, StreamUsageDecoder};

    let plain = COMPRESSED_STREAM_SSE_PLAIN.as_bytes();
    let compressed = gzip_encode_bytes(plain);
    // 极碎的分块：解压后必然出现被切断的 data 行与多字节 UTF-8 字符。
    let chunk_sizes = [1usize, 2, 3, 5, 7, 11, 13, 17, 19, 23];
    let mut decoder = StreamUsageDecoder::for_content_encoding(Some("gzip"));
    let mut assembled = Vec::new();
    let mut accumulator = StreamUsageAccumulator::default();
    let mut ttft_probe = Vec::new();
    let mut ttft_ms = None;
    let started = Instant::now();
    let mut offset = 0;
    let mut index = 0;
    while offset < compressed.len() {
        let size = chunk_sizes[index % chunk_sizes.len()];
        let end = (offset + size).min(compressed.len());
        let original = compressed[offset..end].to_vec();
        let chunk = compressed[offset..end].to_vec();
        let mut decoded = Vec::new();
        let outcome = decoder.decode_chunk(&chunk, &mut decoded);
        assert_eq!(
            outcome,
            StreamDecodedChunk::Decoded,
            "gzip 流应逐块解压而不是直接透传"
        );
        assert_eq!(original, chunk, "解压观测不得改写原始输入字节");
        if !decoded.is_empty() {
            assembled.extend_from_slice(&decoded);
            accumulator.push(&decoded);
            if ttft_ms.is_none() {
                ttft_probe.extend_from_slice(&decoded);
                if contains_sse_output_token(&ttft_probe) {
                    ttft_ms = Some(started.elapsed().as_millis() as i64);
                }
            }
        }
        offset = end;
        index += 1;
    }
    let mut tail = Vec::new();
    assert!(decoder.finish(&mut tail), "完整 gzip 流 flush 应成功");
    assembled.extend_from_slice(&tail);
    accumulator.push(&tail);

    assert_eq!(assembled, plain, "分块增量解压拼回的字节必须与原文一致");
    let parsed = accumulator.finish_with_evidence();
    assert_eq!(parsed.usage, Some(compressed_stream_expected_usage()));
    assert!(parsed.has_completion_evidence, "应看到 [DONE] 终止证据");
    let ttft_ms = ttft_ms.expect("TTFT 探针应在解压后的明文里看到输出 token");
    assert!(ttft_ms >= 0);
}

#[test]
fn stream_usage_decoder_reassembles_deflate_zstd_and_brotli() {
    let plain = COMPRESSED_STREAM_SSE_PLAIN.as_bytes();
    for (encoding, chunk_sizes) in [
        ("deflate", &[1usize, 3, 6, 10, 15][..]),
        ("zstd", &[2usize, 5, 9, 14][..]),
        ("br", &[1usize, 4, 8, 12][..]),
    ] {
        let compressed = compress_stream_sse(encoding, plain);
        let assembled = reassemble_with_stream_decoder(encoding, &compressed, chunk_sizes);
        assert_eq!(assembled, plain, "{encoding}: 增量解压必须还原原文");
    }
}

#[test]
fn stream_usage_decoder_keeps_identity_and_unknown_encodings_as_passthrough() {
    use proxy_http::{StreamDecodedChunk, StreamUsageDecoder};

    let plain = COMPRESSED_STREAM_SSE_PLAIN.as_bytes();
    for encoding in [None, Some("identity"), Some("compress")] {
        let mut decoder = StreamUsageDecoder::for_content_encoding(encoding);
        let mut out = Vec::new();
        assert_eq!(
            decoder.decode_chunk(plain, &mut out),
            StreamDecodedChunk::Passthrough,
            "{encoding:?}: 未压缩/未知编码应保持原始字节直通"
        );
        assert!(out.is_empty());
        assert!(decoder.finish(&mut out));
    }
}

#[tokio::test]
async fn streaming_gzip_sse_produces_complete_usage_without_mutating_passthrough_bytes() {
    let plain = COMPRESSED_STREAM_SSE_PLAIN.as_bytes();
    let compressed = gzip_encode_bytes(plain);
    let (forwarded, done) =
        run_compressed_stream_capture(&compressed, &[3, 1, 7, 2, 11, 5], "gzip").await;

    // 原始压缩字节原样转发，观测解压只作用于副本。
    assert_eq!(forwarded, compressed);
    assert_eq!(done.error_message, None);
    assert_eq!(done.usage, Some(compressed_stream_expected_usage()));
    assert_eq!(done.usage_status.as_deref(), Some("complete"));
    assert_eq!(done.usage_source.as_deref(), Some("upstream_response"));
    assert!(done.ttft_ms.is_some(), "压缩 SSE 也必须能算出 TTFT");

    // 响应体捕获仍按 content-encoding 解压后落库（B64 明文）。
    let captured = decode_captured_body_base64(&done.res_body_b64.unwrap());
    assert_eq!(captured, plain);
}

#[tokio::test]
async fn streaming_deflate_sse_produces_complete_usage() {
    let plain = COMPRESSED_STREAM_SSE_PLAIN.as_bytes();
    let compressed = deflate_encode_bytes(plain);
    let (forwarded, done) =
        run_compressed_stream_capture(&compressed, &[5, 2, 9, 4], "deflate").await;

    assert_eq!(forwarded, compressed);
    assert_eq!(done.usage, Some(compressed_stream_expected_usage()));
    assert_eq!(done.usage_status.as_deref(), Some("complete"));
    assert!(done.ttft_ms.is_some());
}

#[tokio::test]
async fn streaming_zstd_sse_flushes_tail_usage_from_single_chunk() {
    let plain = COMPRESSED_STREAM_SSE_PLAIN.as_bytes();
    let compressed = zstd_encode_bytes(plain);
    // 单块喂入：zstd write decoder 会把最后一块的解压输出留在内部缓冲，
    // 必须依赖流结束时的 flush 才能拿到 usage 与 [DONE] 终止证据。
    let (forwarded, done) =
        run_compressed_stream_capture(&compressed, &[compressed.len()], "zstd").await;

    assert_eq!(forwarded, compressed);
    assert_eq!(done.usage, Some(compressed_stream_expected_usage()));
    assert_eq!(done.usage_status.as_deref(), Some("complete"));
    assert_eq!(done.usage_source.as_deref(), Some("upstream_response"));
    assert!(done.ttft_ms.is_some());
}

#[tokio::test]
async fn streaming_brotli_sse_produces_complete_usage() {
    let plain = COMPRESSED_STREAM_SSE_PLAIN.as_bytes();
    let compressed = brotli_encode_bytes(plain);
    let (forwarded, done) =
        run_compressed_stream_capture(&compressed, &[compressed.len()], "br").await;

    assert_eq!(forwarded, compressed);
    assert_eq!(done.usage, Some(compressed_stream_expected_usage()));
    assert_eq!(done.usage_status.as_deref(), Some("complete"));
    assert!(done.ttft_ms.is_some());
}

#[tokio::test]
async fn streaming_corrupt_compressed_body_never_fabricates_usage() {
    for encoding in ["gzip", "deflate", "zstd", "br"] {
        let garbage = vec![0xABu8; 128];
        let (forwarded, done) =
            run_compressed_stream_capture(&garbage, &[5, 7, 13], encoding).await;
        assert_eq!(forwarded, garbage, "{encoding}: 转发字节必须原样");
        assert_eq!(done.error_message, None, "{encoding}: 解压失败不得影响连接");
        assert!(done.usage.is_none(), "{encoding}: 损坏压缩流不得产出 usage");
        assert!(done.usage_status.is_none());
    }
}

#[tokio::test]
async fn streaming_truncated_compressed_body_stays_partial_without_panic() {
    let plain = COMPRESSED_STREAM_SSE_PLAIN.as_bytes();
    for encoding in ["gzip", "deflate", "zstd", "br"] {
        let compressed = compress_stream_sse(encoding, plain);
        let truncated = &compressed[..compressed.len() / 2];
        let (forwarded, done) =
            run_compressed_stream_capture(truncated, &[4, 9, 2, 6], encoding).await;
        assert_eq!(forwarded, truncated, "{encoding}: 转发字节必须原样");
        assert_eq!(done.error_message, None);
        // 截断后不可能拿到流尾的 output usage；若观测到前缀 usage，只能是部分值。
        if let Some(usage) = done.usage {
            assert_ne!(
                usage.output_tokens,
                Some(42),
                "{encoding}: 截断流不得伪造尾部 output usage"
            );
        }
    }
}

#[tokio::test]
async fn e2e_gzip_streaming_sse_records_usage_and_keeps_wire_bytes_raw() {
    let plain = COMPRESSED_STREAM_SSE_PLAIN.as_bytes();
    let compressed = gzip_encode_bytes(plain);
    let upstream_body = compressed.clone();
    let upstream = Router::new().route(
        "/v1/chat/completions",
        post(move || {
            let body = upstream_body.clone();
            async move {
                (
                    [
                        (header::CONTENT_TYPE, "text/event-stream"),
                        (header::CONTENT_ENCODING, "gzip"),
                    ],
                    body,
                )
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });

    let channel = dual_protocol_channel("custom", "Custom", &addr);
    let state = build_test_state(
        vec![channel],
        vec![test_account("a", "custom", "key", 0)],
        vec![test_route(
            "r",
            "deepseek-v4-pro",
            "custom",
            "a",
            "deepseek-v4-pro",
            ProtocolType::OpenAi,
            0,
        )],
    );
    state.capture.lock().unwrap().capture_res_body = true;
    let storage = state.storage.clone();
    let request = Request::builder()
        .method("POST")
        .uri("/v1/chat/completions")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            r#"{"model":"deepseek-v4-pro","stream":true,"messages":[]}"#,
        ))
        .unwrap();
    let response = forward_request(state, request, ProtocolType::OpenAi)
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response
            .headers()
            .get(header::CONTENT_ENCODING)
            .and_then(|value| value.to_str().ok()),
        Some("gzip"),
        "content-encoding 头必须原样转发"
    );
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    assert_eq!(
        body.as_ref(),
        compressed.as_slice(),
        "压缩 SSE 必须原样透传"
    );

    // 流结束后异步落库：轮询 usage_records（本机行 request_count >= 1）。
    let rows = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let rows = storage
                .usage_summary_range(None, None, "day", "test-device")
                .unwrap();
            if rows.iter().any(|row| row.request_count >= 1) {
                break rows;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let row = rows.iter().find(|row| row.request_count >= 1).unwrap();
    assert_eq!(row.input_tokens, 10, "压缩 SSE 的 usage 必须落库");
    assert_eq!(row.output_tokens, 42);
    assert_eq!(row.known_tokens, 52);

    // 请求日志的响应体捕获按 content-encoding 解压后落库，不回写线上字节。
    let logs = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let rows = storage.list_request_logs().unwrap();
            if rows.first().is_some_and(|log| log.res_body_b64.is_some()) {
                break rows;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        logs[0].res_body_b64,
        Some(encode_body_base64(plain)),
        "响应体捕获必须是解压后的明文"
    );

    server.abort();
}
