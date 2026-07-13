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
                credential_status: "healthy".to_string(),
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

    // Flowlet Pro / Flash 为 Flowlet 统一虚拟模型，owned_by 固定为 flowlet
    let first = &value["data"][0];
    assert_eq!(first["object"], "model");
    assert_eq!(first["owned_by"], "flowlet");
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

// ─── End-to-end routing test helpers ─────────────────────────────────────────

// 测试用上游：根据 Authorization 中的 api_key 返回预先配置的状态码，并记录收到的 key 顺序。
struct SpyUpstream {
    status_by_key: std::collections::HashMap<String, StatusCode>,
    seen_keys: Arc<Mutex<Vec<String>>>,
}

async fn spawn_spy_upstream(
    status_by_key: std::collections::HashMap<String, StatusCode>,
) -> (String, Arc<Mutex<Vec<String>>>) {
    use axum::extract::State;
    let seen = Arc::new(Mutex::new(Vec::<String>::new()));
    let state = Arc::new(SpyUpstream { status_by_key, seen_keys: seen.clone() });
    // 代理会把 /anthropic/v1/messages 重写成上游 /v1/messages，因此需同时注册两条路径。
    use axum::handler::Handler;
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
        supported_protocols: vec![ProtocolType::OpenAi, ProtocolType::Anthropic],
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
            channels: Arc::new(Mutex::new(channels)),
            accounts: Arc::new(Mutex::new(accounts)),
            clients: Arc::new(Mutex::new(vec![])),
            routes: Arc::new(Mutex::new(routes)),
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
    }
}

fn chat_request(model: &str) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri("/v1/chat/completions")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(format!(r#"{{"model":"{model}","messages":[]}}"#)))
        .unwrap()
}

// 8 个端到端路由测试
//
// 核心思路：上游根据 api_key 返回预置状态码，并记录调用顺序。顺序与最终成功账号是 fallback 行为的直接证据；
// 请求日志的 fallback_count / route_reason 是辅助断言。

#[tokio::test]
async fn e2e_same_model_account_fallback() {
    // flowlet-pro / deepseek-v4-pro：账号 A(429) → 账号 B(200)
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
        test_route("1", "flowlet-pro", "deepseek", "a", "deepseek-v4-pro", ProtocolType::OpenAi, 0),
        test_route("2", "flowlet-pro", "deepseek", "b", "deepseek-v4-pro", ProtocolType::OpenAi, 0),
    ];
    let state = build_test_state(channels, accounts, routes);
    let response = forward_request(state, chat_request("flowlet-pro"), ProtocolType::OpenAi).await.unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(*seen.lock().unwrap(), vec!["key-a".to_string(), "key-b".to_string()]);
}

#[tokio::test]
async fn e2e_cross_model_fallback() {
    // flowlet-pro：账号 A(429) → 账号 B(500) → 账号 C(200，来自 LongCat-2.0)
    let (addr, seen) = spawn_spy_upstream(status_map(&[
        ("key-a", StatusCode::TOO_MANY_REQUESTS),
        ("key-b", StatusCode::INTERNAL_SERVER_ERROR),
        ("key-c", StatusCode::OK),
    ]))
    .await;
    let channels = vec![
        dual_protocol_channel("deepseek", "DeepSeek", &addr),
        dual_protocol_channel("longcat", "LongCat", &addr),
    ];
    let accounts = vec![
        test_account("a", "deepseek", "key-a", 0),
        test_account("b", "deepseek", "key-b", 1),
        test_account("c", "longcat", "key-c", 0),
    ];
    let routes = vec![
        test_route("1", "flowlet-pro", "deepseek", "a", "deepseek-v4-pro", ProtocolType::OpenAi, 0),
        test_route("2", "flowlet-pro", "deepseek", "b", "deepseek-v4-pro", ProtocolType::OpenAi, 0),
        test_route("3", "flowlet-pro", "longcat", "c", "LongCat-2.0", ProtocolType::OpenAi, 10),
    ];
    let state = build_test_state(channels, accounts, routes);
    let response = forward_request(state, chat_request("flowlet-pro"), ProtocolType::OpenAi).await.unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        *seen.lock().unwrap(),
        vec!["key-a".to_string(), "key-b".to_string(), "key-c".to_string()]
    );
}

#[tokio::test]
async fn e2e_pro_flash_strict_isolation() {
    // flowlet-pro 所有账号失败，不应进入 flowlet-flash
    let (addr, seen) = spawn_spy_upstream(status_map(&[
        ("pro-key", StatusCode::INTERNAL_SERVER_ERROR),
        ("flash-key", StatusCode::OK),
    ]))
    .await;
    let channels = vec![dual_protocol_channel("deepseek", "DeepSeek", &addr)];
    let accounts = vec![
        test_account("pro", "deepseek", "pro-key", 0),
        test_account("flash", "deepseek", "flash-key", 0),
    ];
    let routes = vec![
        test_route("1", "flowlet-pro", "deepseek", "pro", "deepseek-v4-pro", ProtocolType::OpenAi, 0),
        test_route("2", "flowlet-flash", "deepseek", "flash", "deepseek-v4-flash", ProtocolType::OpenAi, 0),
    ];
    let state = build_test_state(channels, accounts, routes);
    let response = forward_request(state, chat_request("flowlet-pro"), ProtocolType::OpenAi).await.unwrap();

    // 所有 pro 候选都失败 → 最终返回 500
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    // 绝不命中 flash 账号
    assert!(!seen.lock().unwrap().contains(&"flash-key".to_string()));
}

#[tokio::test]
async fn e2e_flash_does_not_escalate_to_pro() {
    // flowlet-flash 所有候选失败，不应进入 flowlet-pro
    let (addr, seen) = spawn_spy_upstream(status_map(&[
        ("flash-key", StatusCode::TOO_MANY_REQUESTS),
        ("pro-key", StatusCode::OK),
    ]))
    .await;
    let channels = vec![dual_protocol_channel("deepseek", "DeepSeek", &addr)];
    let accounts = vec![
        test_account("flash", "deepseek", "flash-key", 0),
        test_account("pro", "deepseek", "pro-key", 0),
    ];
    let routes = vec![
        test_route("1", "flowlet-flash", "deepseek", "flash", "deepseek-v4-flash", ProtocolType::OpenAi, 0),
        test_route("2", "flowlet-pro", "deepseek", "pro", "deepseek-v4-pro", ProtocolType::OpenAi, 0),
    ];
    let state = build_test_state(channels, accounts, routes);
    let response = forward_request(state, chat_request("flowlet-flash"), ProtocolType::OpenAi).await.unwrap();

    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    assert!(!seen.lock().unwrap().contains(&"pro-key".to_string()));
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
        test_route("1", "flowlet-pro", "deepseek", "a", "deepseek-v4-pro", ProtocolType::OpenAi, 0),
        test_route("2", "flowlet-pro", "deepseek", "b", "deepseek-v4-pro", ProtocolType::OpenAi, 0),
    ];
    let state = build_test_state(channels, accounts, routes);
    let storage = state.storage.clone();
    let response = forward_request(state, chat_request("flowlet-pro"), ProtocolType::OpenAi).await.unwrap();

    // 401 不 fallback：直接返回 401，且只命中过 A
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(*seen1.lock().unwrap(), vec!["key-a".to_string()]);

    // 存储中 A 应已被标记 invalid_key
    let stored = storage.list_channel_accounts().unwrap();
    assert_eq!(
        stored.iter().find(|a| a.id == "a").unwrap().credential_status,
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
        test_route("1", "flowlet-pro", "deepseek", "a", "deepseek-v4-pro", ProtocolType::OpenAi, 0),
        test_route("2", "flowlet-pro", "deepseek", "b", "deepseek-v4-pro", ProtocolType::OpenAi, 0),
    ];
    let state2 = build_test_state(channels2, persisted_accounts, routes2);
    let response2 = forward_request(state2, chat_request("flowlet-pro"), ProtocolType::OpenAi).await.unwrap();

    assert_eq!(response2.status(), StatusCode::OK);
    // 第二次请求只命中 B，A 因 invalid_key 被候选池排除
    assert_eq!(*seen2.lock().unwrap(), vec!["key-b".to_string()]);
}

#[tokio::test]
async fn e2e_model_sort_order_is_respected() {
    // 初始顺序 deepseek-v4-pro → LongCat-2.0；交换 priority 后 LongCat-2.0 优先
    let accounts = vec![
        test_account("ds", "deepseek", "key-ds", 0),
        test_account("lc", "longcat", "key-lc", 0),
    ];

    // 初始顺序：deepseek-v4-pro(priority 0) → LongCat-2.0(priority 10)
    let routes_order_a = vec![
        test_route("1", "flowlet-pro", "deepseek", "ds", "deepseek-v4-pro", ProtocolType::OpenAi, 0),
        test_route("2", "flowlet-pro", "longcat", "lc", "LongCat-2.0", ProtocolType::OpenAi, 10),
    ];
    // deepseek 可重试 429 从而回落 LongCat，验证 deepseek 先被尝试。
    let (addr, seen) = spawn_spy_upstream(status_map(&[
        ("key-ds", StatusCode::TOO_MANY_REQUESTS),
        ("key-lc", StatusCode::OK),
    ]))
    .await;
    let channels = vec![
        dual_protocol_channel("deepseek", "DeepSeek", &addr),
        dual_protocol_channel("longcat", "LongCat", &addr),
    ];
    let state = build_test_state(channels, accounts.clone(), routes_order_a);
    forward_request(state, chat_request("flowlet-pro"), ProtocolType::OpenAi).await.unwrap();
    assert_eq!(*seen.lock().unwrap(), vec!["key-ds".to_string(), "key-lc".to_string()]);

    // 用户交换顺序：LongCat-2.0(priority 0) → deepseek-v4-pro(priority 10)。OpenAI 与 Anthropic 请求均应遵循新顺序。
    let routes_order_b = vec![
        test_route("1", "flowlet-pro", "longcat", "lc", "LongCat-2.0", ProtocolType::OpenAi, 0),
        test_route("2", "flowlet-pro", "deepseek", "ds", "deepseek-v4-pro", ProtocolType::OpenAi, 10),
    ];
    let (addr, seen) = spawn_spy_upstream(status_map(&[
        ("key-lc", StatusCode::TOO_MANY_REQUESTS),
        ("key-ds", StatusCode::OK),
    ]))
    .await;
    let channels = vec![
        dual_protocol_channel("deepseek", "DeepSeek", &addr),
        dual_protocol_channel("longcat", "LongCat", &addr),
    ];
    let state = build_test_state(channels, accounts.clone(), routes_order_b);
    forward_request(state, chat_request("flowlet-pro"), ProtocolType::OpenAi).await.unwrap();
    assert_eq!(*seen.lock().unwrap(), vec!["key-lc".to_string(), "key-ds".to_string()]);

    let routes_order_b_anthropic = vec![
        test_route("1", "flowlet-pro", "longcat", "lc", "LongCat-2.0", ProtocolType::Anthropic, 0),
        test_route("2", "flowlet-pro", "deepseek", "ds", "deepseek-v4-pro", ProtocolType::Anthropic, 10),
    ];
    let (addr, seen) = spawn_spy_upstream(status_map(&[
        ("key-lc", StatusCode::TOO_MANY_REQUESTS),
        ("key-ds", StatusCode::OK),
    ]))
    .await;
    let channels = vec![
        dual_protocol_channel("deepseek", "DeepSeek", &addr),
        dual_protocol_channel("longcat", "LongCat", &addr),
    ];
    let state = build_test_state(channels, accounts, routes_order_b_anthropic);
    let anthropic_request = Request::builder()
        .method("POST")
        .uri("/anthropic/v1/messages")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(r#"{"model":"flowlet-pro","max_tokens":10,"messages":[]}"#))
        .unwrap();
    let response = forward_request(state, anthropic_request, ProtocolType::Anthropic).await.unwrap();
    assert_eq!(*seen.lock().unwrap(), vec!["key-lc".to_string(), "key-ds".to_string()]);
    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn e2e_model_enable_disable_sync() {
    // 关闭底层模型后，对应账号退出候选池，OpenAI 与 Anthropic 协议均不再使用该模型，另一档位不受影响
    let (addr, seen) = spawn_spy_upstream(status_map(&[
        ("key-ds", StatusCode::OK),
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
    // pro 使用 deepseek-v4-pro(prio 0) + LongCat-2.0(prio 10)；flash 使用 deepseek-v4-flash(prio 0)
    let all_routes = vec![
        test_route("1", "flowlet-pro", "deepseek", "ds", "deepseek-v4-pro", ProtocolType::OpenAi, 0),
        test_route("2", "flowlet-pro", "longcat", "lc", "LongCat-2.0", ProtocolType::OpenAi, 10),
        test_route("3", "flowlet-pro", "deepseek", "ds", "deepseek-v4-pro", ProtocolType::Anthropic, 0),
        test_route("4", "flowlet-pro", "longcat", "lc", "LongCat-2.0", ProtocolType::Anthropic, 10),
        test_route("5", "flowlet-flash", "deepseek", "ds", "deepseek-v4-flash", ProtocolType::OpenAi, 0),
        test_route("6", "flowlet-flash", "deepseek", "ds", "deepseek-v4-flash", ProtocolType::Anthropic, 0),
    ];

    // 首次请求前：deepseek 返回可重试 429，验证 pro 先尝试 deepseek 再回落 LongCat
    let (addr, seen) = spawn_spy_upstream(status_map(&[
        ("key-ds", StatusCode::TOO_MANY_REQUESTS),
        ("key-lc", StatusCode::OK),
    ]))
    .await;
    let channels = vec![
        dual_protocol_channel("deepseek", "DeepSeek", &addr),
        dual_protocol_channel("longcat", "LongCat", &addr),
    ];
    let state = build_test_state(channels, accounts.clone(), all_routes.clone());
    forward_request(state, chat_request("flowlet-pro"), ProtocolType::OpenAi).await.unwrap();
    assert_eq!(*seen.lock().unwrap(), vec!["key-ds".to_string(), "key-lc".to_string()]);

    // 关闭 deepseek-v4-pro 底层模型（channel=deepseek, upstream=deepseek-v4-pro 的所有路由 enabled=false）
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

    // 关闭后 pro 的 OpenAI 请求只能走 LongCat-2.0
    let (addr, seen) = spawn_spy_upstream(status_map(&[
        ("key-ds", StatusCode::OK),
        ("key-lc", StatusCode::OK),
    ]))
    .await;
    let channels = vec![
        dual_protocol_channel("deepseek", "DeepSeek", &addr),
        dual_protocol_channel("longcat", "LongCat", &addr),
    ];
    let state = build_test_state(channels, accounts.clone(), disabled_routes.clone());
    forward_request(state, chat_request("flowlet-pro"), ProtocolType::OpenAi).await.unwrap();
    assert_eq!(*seen.lock().unwrap(), vec!["key-lc".to_string()]);
    // 关闭后 pro 的 Anthropic 请求也只能走 LongCat-2.0（协议同步）
    let (addr, seen) = spawn_spy_upstream(status_map(&[
        ("key-ds", StatusCode::OK),
        ("key-lc", StatusCode::OK),
    ]))
    .await;
    let channels = vec![
        dual_protocol_channel("deepseek", "DeepSeek", &addr),
        dual_protocol_channel("longcat", "LongCat", &addr),
    ];
    let state = build_test_state(channels, accounts.clone(), disabled_routes.clone());
    let anthropic_request = Request::builder()
        .method("POST")
        .uri("/anthropic/v1/messages")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(r#"{"model":"flowlet-pro","max_tokens":10,"messages":[]}"#))
        .unwrap();
    forward_request(state, anthropic_request, ProtocolType::Anthropic).await.unwrap();
    assert_eq!(*seen.lock().unwrap(), vec!["key-lc".to_string()]);

    // flash 档位不受影响：仍使用 deepseek-v4-flash 账号（key-ds）
    let (addr, seen) = spawn_spy_upstream(status_map(&[
        ("key-ds", StatusCode::OK),
        ("key-lc", StatusCode::OK),
    ]))
    .await;
    let channels = vec![
        dual_protocol_channel("deepseek", "DeepSeek", &addr),
        dual_protocol_channel("longcat", "LongCat", &addr),
    ];
    let state = build_test_state(channels, accounts, disabled_routes);
    forward_request(state, chat_request("flowlet-flash"), ProtocolType::OpenAi).await.unwrap();
    assert_eq!(*seen.lock().unwrap(), vec!["key-ds".to_string()]);
}

#[tokio::test]
async fn e2e_dual_protocol_model_list_consistency() {
    // OpenAI /models 与 Anthropic /models 均只暴露 flowlet-pro / flowlet-flash，顺序一致
    let (addr, _) = spawn_spy_upstream(std::collections::HashMap::new()).await;
    let channels = vec![dual_protocol_channel("deepseek", "DeepSeek", &addr)];
    let accounts = vec![test_account("a", "deepseek", "key-a", 0)];
    let routes = vec![
        test_route("1", "flowlet-pro", "deepseek", "a", "deepseek-v4-pro", ProtocolType::OpenAi, 0),
        test_route("2", "flowlet-flash", "deepseek", "a", "deepseek-v4-flash", ProtocolType::OpenAi, 0),
        test_route("3", "flowlet-pro", "deepseek", "a", "deepseek-v4-pro", ProtocolType::Anthropic, 0),
        test_route("4", "flowlet-flash", "deepseek", "a", "deepseek-v4-flash", ProtocolType::Anthropic, 0),
    ];
    let state = build_test_state(channels, accounts, routes);

    let openai = forward_request(
        state.clone(),
        Request::builder().method("GET").uri("/v1/models").body(Body::empty()).unwrap(),
        ProtocolType::OpenAi,
    )
    .await
    .unwrap();
    let anthropic = forward_request(
        state,
        Request::builder().method("GET").uri("/anthropic/v1/models").body(Body::empty()).unwrap(),
        ProtocolType::Anthropic,
    )
    .await
    .unwrap();

    let openai_body = axum::body::to_bytes(openai.into_body(), usize::MAX).await.unwrap();
    let anthropic_body = axum::body::to_bytes(anthropic.into_body(), usize::MAX).await.unwrap();
    let openai_value: serde_json::Value = serde_json::from_slice(&openai_body).unwrap();
    let anthropic_value: serde_json::Value = serde_json::from_slice(&anthropic_body).unwrap();

    let openai_ids: Vec<&str> = openai_value["data"].as_array().unwrap().iter().map(|m| m["id"].as_str().unwrap()).collect();
    let anthropic_ids: Vec<&str> = anthropic_value["data"].as_array().unwrap().iter().map(|m| m["id"].as_str().unwrap()).collect();
    assert_eq!(openai_ids, vec!["flowlet-pro", "flowlet-flash"]);
    assert_eq!(anthropic_ids, vec!["flowlet-pro", "flowlet-flash"]);
}

// ─── 模型开放与直接模型路由测试（需求十六） ─────────────────────────────────

// test 1: 默认全部开放 — /models 同时返回聚合模型与直接底层模型
#[tokio::test]
async fn e2e_models_exposes_direct_models_by_default() {
    let (addr, _) = spawn_spy_upstream(std::collections::HashMap::new()).await;
    let channels = vec![dual_protocol_channel("deepseek", "DeepSeek", &addr)];
    let accounts = vec![test_account("a", "deepseek", "key-a", 0)];
    // 聚合路由 + 直接路由（virtual_model_id === upstream_model）
    let routes = vec![
        test_route("1", "flowlet-pro", "deepseek", "a", "deepseek-v4-pro", ProtocolType::OpenAi, 0),
        test_route("2", "flowlet-flash", "deepseek", "a", "deepseek-v4-flash", ProtocolType::OpenAi, 0),
        test_route("3", "flowlet-pro", "deepseek", "a", "deepseek-v4-pro", ProtocolType::Anthropic, 0),
        test_route("4", "flowlet-flash", "deepseek", "a", "deepseek-v4-flash", ProtocolType::Anthropic, 0),
        test_route("5", "deepseek-v4-pro", "deepseek", "a", "deepseek-v4-pro", ProtocolType::OpenAi, 0),
        test_route("6", "deepseek-v4-flash", "deepseek", "a", "deepseek-v4-flash", ProtocolType::OpenAi, 0),
        test_route("7", "deepseek-v4-pro", "deepseek", "a", "deepseek-v4-pro", ProtocolType::Anthropic, 0),
        test_route("8", "deepseek-v4-flash", "deepseek", "a", "deepseek-v4-flash", ProtocolType::Anthropic, 0),
    ];
    let state = build_test_state(channels, accounts, routes);

    let response = forward_request(
        state,
        Request::builder().method("GET").uri("/v1/models").body(Body::empty()).unwrap(),
        ProtocolType::OpenAi,
    )
    .await
    .unwrap();
    let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let ids: Vec<&str> = value["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec!["flowlet-pro", "flowlet-flash", "deepseek-v4-flash", "deepseek-v4-pro"]);

    // owned_by：聚合模型为 flowlet，直接模型为渠道 vendor
    let owned_by: Vec<&str> = value["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["owned_by"].as_str().unwrap())
        .collect();
    assert_eq!(owned_by, vec!["flowlet", "flowlet", "deepseek", "deepseek"]);
}

// test 2: 仅 Flowlet 模式 — 直接路由全部 disabled 后 /models 只返回聚合模型
#[tokio::test]
async fn e2e_models_flowlet_only_hides_direct_models() {
    let (addr, _) = spawn_spy_upstream(std::collections::HashMap::new()).await;
    let channels = vec![dual_protocol_channel("deepseek", "DeepSeek", &addr)];
    let accounts = vec![test_account("a", "deepseek", "key-a", 0)];
    let routes = vec![
        test_route("1", "flowlet-pro", "deepseek", "a", "deepseek-v4-pro", ProtocolType::OpenAi, 0),
        test_route("2", "flowlet-flash", "deepseek", "a", "deepseek-v4-flash", ProtocolType::OpenAi, 0),
        // 直接路由全部关闭（模拟 flowlet_only 模式）
        test_route("5", "deepseek-v4-pro", "deepseek", "a", "deepseek-v4-pro", ProtocolType::OpenAi, 0),
        test_route("6", "deepseek-v4-flash", "deepseek", "a", "deepseek-v4-flash", ProtocolType::OpenAi, 0),
    ];
    let disabled_routes: Vec<RouteCandidate> = routes
        .into_iter()
        .map(|mut r| {
            if r.virtual_model_id == "deepseek-v4-pro" || r.virtual_model_id == "deepseek-v4-flash" {
                r.enabled = false;
            }
            r
        })
        .collect();
    let state = build_test_state(channels, accounts, disabled_routes);

    let response = forward_request(
        state,
        Request::builder().method("GET").uri("/v1/models").body(Body::empty()).unwrap(),
        ProtocolType::OpenAi,
    )
    .await
    .unwrap();
    let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let ids: Vec<&str> = value["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec!["flowlet-pro", "flowlet-flash"]);
}

// test 3: 自定义模式 — 仅返回用户开启的直接模型
#[tokio::test]
async fn e2e_models_custom_mode_respects_per_model_toggle() {
    let (addr, _) = spawn_spy_upstream(std::collections::HashMap::new()).await;
    let channels = vec![dual_protocol_channel("deepseek", "DeepSeek", &addr)];
    let accounts = vec![test_account("a", "deepseek", "key-a", 0)];
    let routes = vec![
        test_route("1", "flowlet-pro", "deepseek", "a", "deepseek-v4-pro", ProtocolType::OpenAi, 0),
        test_route("2", "flowlet-flash", "deepseek", "a", "deepseek-v4-flash", ProtocolType::OpenAi, 0),
        // deepseek-v4-pro 开启，deepseek-v4-flash 关闭
        test_route("5", "deepseek-v4-pro", "deepseek", "a", "deepseek-v4-pro", ProtocolType::OpenAi, 0),
        test_route("6", "deepseek-v4-flash", "deepseek", "a", "deepseek-v4-flash", ProtocolType::OpenAi, 0),
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
        Request::builder().method("GET").uri("/v1/models").body(Body::empty()).unwrap(),
        ProtocolType::OpenAi,
    )
    .await
    .unwrap();
    let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let ids: Vec<&str> = value["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec!["flowlet-pro", "flowlet-flash", "deepseek-v4-pro"]);
}

// test 4: 直接模型账号轮询（A → B → A）
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
        test_route("1", "deepseek-v4-pro", "deepseek", "a", "deepseek-v4-pro", ProtocolType::OpenAi, 0),
        test_route("2", "deepseek-v4-pro", "deepseek", "b", "deepseek-v4-pro", ProtocolType::OpenAi, 0),
    ];
    let state = build_test_state(channels, accounts, routes);

    for _ in 0..3 {
        let s = state.clone();
        forward_request(s, chat_request("deepseek-v4-pro"), ProtocolType::OpenAi).await.unwrap();
    }
    // 轮询：A → B → A（spy 累积记录全部调用顺序）
    assert_eq!(*seen.lock().unwrap(), vec!["key-a".to_string(), "key-b".to_string(), "key-a".to_string()]);
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
        test_route("1", "deepseek-v4-pro", "deepseek", "a", "deepseek-v4-pro", ProtocolType::OpenAi, 0),
        test_route("2", "deepseek-v4-pro", "deepseek", "b", "deepseek-v4-pro", ProtocolType::OpenAi, 0),
    ];
    let state = build_test_state(channels, accounts, routes);
    let response = forward_request(state, chat_request("deepseek-v4-pro"), ProtocolType::OpenAi).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(*seen.lock().unwrap(), vec!["key-a".to_string(), "key-b".to_string()]);
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
        test_route("1", "deepseek-v4-pro", "deepseek", "ds", "deepseek-v4-pro", ProtocolType::OpenAi, 0),
        test_route("2", "LongCat-2.0", "longcat", "lc", "LongCat-2.0", ProtocolType::OpenAi, 0),
    ];
    let state = build_test_state(channels, accounts, routes);
    let response = forward_request(state, chat_request("deepseek-v4-pro"), ProtocolType::OpenAi).await.unwrap();
    // deepseek-v4-pro 唯一账号失败 → 500，不命中 LongCat
    assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(*seen.lock().unwrap(), vec!["key-ds".to_string()]);
    assert!(!seen.lock().unwrap().contains(&"key-lc".to_string()));
}

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
        test_route("1", "flowlet-pro", "deepseek", "ok", "deepseek-v4-pro", ProtocolType::OpenAi, 0),
        test_route("2", "flowlet-flash", "deepseek", "ok", "deepseek-v4-flash", ProtocolType::OpenAi, 0),
        // deepseek-v4-pro 同时有健康账号与 invalid 账号
        test_route("3", "deepseek-v4-pro", "deepseek", "ok", "deepseek-v4-pro", ProtocolType::OpenAi, 0),
        test_route("4", "deepseek-v4-pro", "deepseek", "bad", "deepseek-v4-pro", ProtocolType::OpenAi, 0),
        // deepseek-v4-flash 仅有 invalid 账号 → 不应出现
        test_route("5", "deepseek-v4-flash", "deepseek", "bad", "deepseek-v4-flash", ProtocolType::OpenAi, 0),
    ];
    let state = build_test_state(channels, accounts, routes);
    let response = forward_request(
        state,
        Request::builder().method("GET").uri("/v1/models").body(Body::empty()).unwrap(),
        ProtocolType::OpenAi,
    )
    .await
    .unwrap();
    let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let ids: Vec<&str> = value["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["id"].as_str().unwrap())
        .collect();
    // deepseek-v4-flash 仅有 invalid 账号，不出现；deepseek-v4-pro 有健康账号，出现
    assert!(ids.contains(&"flowlet-pro"));
    assert!(ids.contains(&"flowlet-flash"));
    assert!(ids.contains(&"deepseek-v4-pro"));
    assert!(!ids.contains(&"deepseek-v4-flash"));
}

// test 9: 修改 API Key 后立即恢复（不重启代理）
#[tokio::test]
async fn e2e_recovers_after_api_key_change() {
    // 第一轮：账号 A 401 → 标记 invalid_key
    let (addr, _seen1) = spawn_spy_upstream(status_map(&[
        ("old-key", StatusCode::UNAUTHORIZED),
    ]))
    .await;
    let channels = vec![dual_protocol_channel("deepseek", "DeepSeek", &addr)];
    let accounts = vec![test_account("a", "deepseek", "old-key", 0)];
    let routes = vec![
        test_route("1", "deepseek-v4-pro", "deepseek", "a", "deepseek-v4-pro", ProtocolType::OpenAi, 0),
    ];
    let state = build_test_state(channels, accounts, routes);
    let storage = state.storage.clone();
    let response = forward_request(state, chat_request("deepseek-v4-pro"), ProtocolType::OpenAi).await.unwrap();
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
    let (addr, seen2) = spawn_spy_upstream(status_map(&[
        ("new-key", StatusCode::OK),
    ]))
    .await;
    let persisted = storage.list_channel_accounts().unwrap();
    let channels2 = vec![dual_protocol_channel("deepseek", "DeepSeek", &addr)];
    let routes2 = vec![
        test_route("1", "deepseek-v4-pro", "deepseek", "a", "deepseek-v4-pro", ProtocolType::OpenAi, 0),
    ];
    let state2 = build_test_state(channels2, persisted, routes2);
    let response2 = forward_request(state2, chat_request("deepseek-v4-pro"), ProtocolType::OpenAi).await.unwrap();
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
        test_route("1", "deepseek-v4-pro", "deepseek", "a", "deepseek-v4-pro", ProtocolType::OpenAi, 0),
        test_route("2", "deepseek-v4-pro", "deepseek", "b", "deepseek-v4-pro", ProtocolType::OpenAi, 0),
    ];
    let state = build_test_state(channels, accounts, routes);

    // 第一次请求：A 401，不 fallback，A 被标记 invalid_key 并更新共享内存
    let response = forward_request(state.clone(), chat_request("deepseek-v4-pro"), ProtocolType::OpenAi).await.unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(*seen.lock().unwrap(), vec!["key-a".to_string()]);

    // 第二次请求（同一 state，共享内存已更新）：A 被排除，命中 B
    let response2 = forward_request(state, chat_request("deepseek-v4-pro"), ProtocolType::OpenAi).await.unwrap();
    assert_eq!(response2.status(), StatusCode::OK);
    assert_eq!(*seen.lock().unwrap(), vec!["key-a".to_string(), "key-b".to_string()]);
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

// test 12: 双协议 /models 一致（聚合 + 直接模型集合与顺序一致）
#[tokio::test]
async fn e2e_dual_protocol_models_list_consistent_with_direct() {
    let (addr, _) = spawn_spy_upstream(std::collections::HashMap::new()).await;
    let channels = vec![dual_protocol_channel("deepseek", "DeepSeek", &addr)];
    let accounts = vec![test_account("a", "deepseek", "key-a", 0)];
    let routes = vec![
        test_route("1", "flowlet-pro", "deepseek", "a", "deepseek-v4-pro", ProtocolType::OpenAi, 0),
        test_route("2", "flowlet-flash", "deepseek", "a", "deepseek-v4-flash", ProtocolType::OpenAi, 0),
        test_route("3", "flowlet-pro", "deepseek", "a", "deepseek-v4-pro", ProtocolType::Anthropic, 0),
        test_route("4", "flowlet-flash", "deepseek", "a", "deepseek-v4-flash", ProtocolType::Anthropic, 0),
        test_route("5", "deepseek-v4-pro", "deepseek", "a", "deepseek-v4-pro", ProtocolType::OpenAi, 0),
        test_route("6", "deepseek-v4-flash", "deepseek", "a", "deepseek-v4-flash", ProtocolType::OpenAi, 0),
        test_route("7", "deepseek-v4-pro", "deepseek", "a", "deepseek-v4-pro", ProtocolType::Anthropic, 0),
        test_route("8", "deepseek-v4-flash", "deepseek", "a", "deepseek-v4-flash", ProtocolType::Anthropic, 0),
    ];
    let state = build_test_state(channels, accounts, routes);

    let openai = forward_request(
        state.clone(),
        Request::builder().method("GET").uri("/v1/models").body(Body::empty()).unwrap(),
        ProtocolType::OpenAi,
    )
    .await
    .unwrap();
    let anthropic = forward_request(
        state,
        Request::builder().method("GET").uri("/anthropic/v1/models").body(Body::empty()).unwrap(),
        ProtocolType::Anthropic,
    )
    .await
    .unwrap();

    let openai_body = axum::body::to_bytes(openai.into_body(), usize::MAX).await.unwrap();
    let anthropic_body = axum::body::to_bytes(anthropic.into_body(), usize::MAX).await.unwrap();
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
    assert_eq!(openai_ids, vec!["flowlet-pro", "flowlet-flash", "deepseek-v4-flash", "deepseek-v4-pro"]);
    assert_eq!(anthropic_ids, vec!["flowlet-pro", "flowlet-flash", "deepseek-v4-flash", "deepseek-v4-pro"]);
    // 不暴露账号名称
    assert!(!openai_body.to_vec().windows(4).any(|w| w == b"acc-"));
}