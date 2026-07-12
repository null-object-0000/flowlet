use super::*;
use super::proxy_routing::rank_candidates_by_score;
use crate::core::config::{AuthStrategy, UaClientRule};
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
fn protocol_type_from_path_returns_none_for_health() {
    assert_eq!(ProtocolType::from_path("/health"), None);
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
fn checks_quota_body_only_for_quota_candidate_statuses() {
    assert!(should_check_quota_body_status(
        reqwest::StatusCode::PAYMENT_REQUIRED
    ));
    assert!(should_check_quota_body_status(
        reqwest::StatusCode::FORBIDDEN
    ));
    assert!(!should_check_quota_body_status(
        reqwest::StatusCode::BAD_REQUEST
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
fn identifies_client_from_bearer_token() {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::AUTHORIZATION,
        HeaderValue::from_static("Bearer token-a"),
    );
    let clients = vec![
        ClientConfig {
            id: "client-a".to_string(),
            name: "客户端 A".to_string(),
            token: "token-a".to_string(),
            app_type: "test".to_string(),
            enabled: true,
            created_at: String::new(),
            updated_at: String::new(),
        },
        ClientConfig {
            id: "client-b".to_string(),
            name: "客户端 B".to_string(),
            token: "token-b".to_string(),
            app_type: "test".to_string(),
            enabled: false,
            created_at: String::new(),
            updated_at: String::new(),
        },
    ];

    assert_eq!(
        identify_client(&headers, &clients),
        Some(("client-a".to_string(), "客户端 A".to_string()))
    );
}

#[test]
fn identifies_client_from_x_api_key() {
    let mut headers = HeaderMap::new();
    headers.insert("x-api-key", HeaderValue::from_static("token-x"));
    let clients = vec![ClientConfig {
        id: "client-x".to_string(),
        name: "客户端 X".to_string(),
        token: "token-x".to_string(),
        app_type: "claude-code".to_string(),
        enabled: true,
        created_at: String::new(),
        updated_at: String::new(),
    }];

    assert_eq!(
        identify_client(&headers, &clients),
        Some(("client-x".to_string(), "客户端 X".to_string()))
    );
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
fn extracts_openai_usage() {
    let usage = extract_response_usage(
        br#"{"id":"chatcmpl","usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}}"#,
    )
    .unwrap();

    assert_eq!(
        usage,
        ResponseUsage {
            input_tokens: Some(11),
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
fn enriches_final_upstream_error_metadata_without_body_rewrite() {
    let mut log = RequestLogInput {
        request_id: "req".to_string(),
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
        stream_summary: None,
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
    let state = ProxyAppState {
        shared: ProxySharedConfig {
            channels: Arc::new(Mutex::new(vec![ChannelPreset {
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
                supports_price_sync: false,
                supports_balance_query: false,
                supports_quota_query: false,
                supports_usage_query: false,
                created_at: String::new(),
                updated_at: String::new(),
            }])),
            accounts: Arc::new(Mutex::new(vec![ChannelAccount {
                id: "acc-1".to_string(),
                channel_id: "longcat".to_string(),
                name: "主账号".to_string(),
                api_key: "upstream-secret".to_string(),
                enabled: true,
                priority: 0,
                remark: None,
                base_url_override: None,
                last_used_at: None,
                last_error: None,
                created_at: String::new(),
                updated_at: String::new(),
            }])),
            clients: Arc::new(Mutex::new(vec![ClientConfig {
                id: "client-test".to_string(),
                name: "测试客户端".to_string(),
                token: "client-token".to_string(),
                app_type: "test".to_string(),
                enabled: true,
                created_at: String::new(),
                updated_at: String::new(),
            }])),
            routes: Arc::new(Mutex::new(vec![RouteCandidate {
                id: "route-1".to_string(),
                virtual_model_id: "auto".to_string(),
                channel_id: "longcat".to_string(),
                account_id: "acc-1".to_string(),
                upstream_model: "gpt-test".to_string(),
                client_protocol: ProtocolType::OpenAi,
                priority: 0,
                enabled: true,
                created_at: String::new(),
                updated_at: String::new(),
            }])),
            rules: Arc::new(Mutex::new(vec![])),
            scores: Arc::new(Mutex::new(vec![])),
                round_robin: Arc::new(Mutex::new(std::collections::HashMap::new())),
        },
        client: Client::new(),
        storage,
        upstream_timeout_seconds: 120,
        rate_limiter: RateLimiter::new(600),
        capture: LogCaptureConfig::default(),
        config_path: std::path::PathBuf::from("/tmp/flowlet_test_config.json"),
    };

    let request = Request::builder()
        .method("POST")
        .uri("/v1/chat/completions")
        .header(header::AUTHORIZATION, "Bearer client-token")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(r#"{"model":"auto","messages":[]}"#))
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
    assert_eq!(body, r#"{"model":"gpt-test","messages":[]}"#);
    assert_eq!(
        captured_auth.lock().unwrap().as_deref(),
        Some("Bearer upstream-secret")
    );
}

#[test]
fn small_model_routing_is_disabled_for_mvp() {
    let result = resolve_small_model("deepseek-v4-pro");
    assert_eq!(result, "deepseek-v4-pro");
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
                stream_summary: None,
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
            virtual_model_id: "flowlet-pro".to_string(),
            channel_id: "longcat".to_string(),
            account_id: "acc-enabled".to_string(),
            upstream_model: "gpt-test".to_string(),
            client_protocol: ProtocolType::OpenAi,
            priority: 0,
            enabled: true,
            created_at: String::new(),
            updated_at: String::new(),
        },
        RouteCandidate {
            id: "route-2".to_string(),
            virtual_model_id: "hidden".to_string(),
            channel_id: "longcat".to_string(),
            account_id: "acc-disabled".to_string(),
            upstream_model: "hidden-model".to_string(),
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
    assert_eq!(ids, vec!["flowlet-pro"]);

    // owned_by 应取 channel vendor（不暴露用户 account name）
    let first = &value["data"][0];
    assert_eq!(first["object"], "model");
    assert_eq!(first["owned_by"], "longcat");
}

#[tokio::test]
async fn model_list_response_anthropic_uses_anthropic_schema() {
    let routes = vec![
        RouteCandidate {
            id: "route-a".to_string(),
            virtual_model_id: "flowlet-pro".to_string(),
            channel_id: "anthropic".to_string(),
            account_id: "acc-anthropic".to_string(),
            upstream_model: "claude-sonnet-4-20250514".to_string(),
            client_protocol: ProtocolType::Anthropic,
            priority: 0,
            enabled: true,
            created_at: "2025-05-14T00:00:00Z".to_string(),
            updated_at: String::new(),
        },
        RouteCandidate {
            id: "route-b".to_string(),
            virtual_model_id: "flowlet-flash".to_string(),
            channel_id: "anthropic".to_string(),
            account_id: "acc-anthropic".to_string(),
            upstream_model: "claude-opus-4".to_string(),
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

    let response = build_model_list_response(&routes, &accounts, &channels, &ProtocolType::Anthropic);

    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let value: serde_json::Value = serde_json::from_slice(&body).unwrap();

    // Anthropic 风格：没有 object=list，而是 data + has_more + first_id + last_id
    assert!(value.get("object").is_none());
    assert_eq!(value["has_more"], false);
    // BTreeSet 按字典序排列：claude-opus-4 < claude-sonnet-4-20250514
    assert_eq!(value["first_id"], "flowlet-pro");
    assert_eq!(value["last_id"], "flowlet-flash");

    let data = value["data"].as_array().unwrap();
    assert_eq!(data.len(), 2);
    // 每个模型对象：type=model, id, display_name, created_at
    assert_eq!(data[0]["type"], "model");
    assert_eq!(data[0]["id"], "flowlet-pro");
    assert_eq!(data[0]["display_name"], "flowlet-pro");
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
    let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(value, serde_json::json!({"object": "list", "data": []}));
}

#[tokio::test]
async fn empty_anthropic_model_list_is_valid() {
    let response = build_model_list_response(&[], &[], &[], &ProtocolType::Anthropic);
    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
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
        channels: Arc::new(Mutex::new(vec![])),
        accounts: Arc::new(Mutex::new(vec![])),
        clients: Arc::new(Mutex::new(vec![])),
        routes: Arc::new(Mutex::new(vec![])),
        rules: Arc::new(Mutex::new(vec![])),
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
            channels: Arc::new(Mutex::new(vec![])),
            accounts: Arc::new(Mutex::new(vec![])),
            clients: Arc::new(Mutex::new(vec![])),
            routes: Arc::new(Mutex::new(vec![])),
            rules: Arc::new(Mutex::new(vec![])),
            scores: Arc::new(Mutex::new(vec![])),
                round_robin: Arc::new(Mutex::new(std::collections::HashMap::new())),
        },
        client: Client::new(),
        storage: storage.clone(),
        upstream_timeout_seconds: 30,
        rate_limiter: RateLimiter::new(600),
        capture: LogCaptureConfig::default(),
        config_path: db_path.with_extension("json"),
    };
    let request = Request::builder()
        .method("POST")
        .uri("/v1/chat/completions")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(r#"{"model":"missing","messages":[]}"#))
        .unwrap();
    let response = forward_request(state, request, ProtocolType::OpenAi).await.unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
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
    assert_eq!(logs[0].route_reason.as_deref(), Some("no_available_account"));
    let _ = std::fs::remove_file(db_path);
}
#[test]
fn flowlet_pool_round_robins_accounts_before_next_model() {
    let account = |id: &str, channel_id: &str, priority: i64, api_key: &str| ChannelAccount {
        id: id.to_string(), channel_id: channel_id.to_string(), name: id.to_string(),
        api_key: api_key.to_string(), enabled: true, priority,
        ..Default::default()
    };
    let route = |id: &str, public: &str, channel: &str, account: &str, upstream: &str, priority: i64| RouteCandidate {
        id: id.to_string(), virtual_model_id: public.to_string(), channel_id: channel.to_string(),
        account_id: account.to_string(), upstream_model: upstream.to_string(),
        client_protocol: ProtocolType::OpenAi, priority, enabled: true,
        ..Default::default()
    };
    let channels = vec![
        ChannelPreset { id: "deepseek".to_string(), supported_protocols: vec![ProtocolType::OpenAi, ProtocolType::Anthropic], ..Default::default() },
        ChannelPreset { id: "longcat".to_string(), supported_protocols: vec![ProtocolType::OpenAi, ProtocolType::Anthropic], ..Default::default() },
    ];
    let accounts = vec![
        account("a", "deepseek", 0, "key-a"),
        account("b", "deepseek", 1, "key-b"),
        account("c", "longcat", 0, "key-c"),
        account("empty", "deepseek", 2, ""),
    ];
    let routes = vec![
        route("1", "flowlet-pro", "deepseek", "a", "deepseek-v4-pro", 0),
        route("2", "flowlet-pro", "deepseek", "b", "deepseek-v4-pro", 0),
        route("3", "flowlet-pro", "deepseek", "empty", "deepseek-v4-pro", 0),
        route("4", "flowlet-pro", "longcat", "c", "LongCat-2.0", 10),
        route("5", "flowlet-flash", "deepseek", "a", "deepseek-v4-flash", 0),
    ];
    let mut round_robin = std::collections::HashMap::new();
    let first = match_candidates(&routes, &[], &[], Some("flowlet-pro"), &ProtocolType::OpenAi, None, &accounts, &channels, &mut round_robin);
    assert_eq!(first.iter().map(|route| route.account_id.as_str()).collect::<Vec<_>>(), vec!["a", "b", "c"]);
    let second = match_candidates(&routes, &[], &[], Some("flowlet-pro"), &ProtocolType::OpenAi, None, &accounts, &channels, &mut round_robin);
    assert_eq!(second.iter().map(|route| route.account_id.as_str()).collect::<Vec<_>>(), vec!["b", "a", "c"]);
    assert!(second.iter().all(|route| route.virtual_model_id == "flowlet-pro"));
}

#[test]
fn flowlet_pool_rejects_single_protocol_channels() {
    let channels = vec![ChannelPreset {
        id: "openai-only".to_string(),
        supported_protocols: vec![ProtocolType::OpenAi],
        ..Default::default()
    }];
    let accounts = vec![ChannelAccount {
        id: "account".to_string(), channel_id: "openai-only".to_string(), api_key: "key".to_string(), enabled: true,
        ..Default::default()
    }];
    let routes = vec![RouteCandidate {
        virtual_model_id: "flowlet-pro".to_string(), channel_id: "openai-only".to_string(), account_id: "account".to_string(),
        upstream_model: "model".to_string(), client_protocol: ProtocolType::OpenAi, enabled: true,
        ..Default::default()
    }];
    let mut round_robin = std::collections::HashMap::new();
    assert!(match_candidates(&routes, &[], &[], Some("flowlet-pro"), &ProtocolType::OpenAi, None, &accounts, &channels, &mut round_robin).is_empty());
}