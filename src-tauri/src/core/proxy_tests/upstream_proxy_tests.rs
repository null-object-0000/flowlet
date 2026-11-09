use super::*;
use crate::core::upstream_proxy::{with_test_config, UpstreamProxyConfig};
use axum::extract::State;

type Seen = Arc<Mutex<Vec<(String, String, serde_json::Value)>>>;
const SSE: &str = "data: {\"id\":\"proxy-test\",\"choices\":[]}\n\ndata: [DONE]\n\n";

async fn spy() -> (String, Seen, tokio::task::JoinHandle<()>) {
    let seen: Seen = Arc::new(Mutex::new(Vec::new()));
    let app = Router::new().fallback(|State(seen): State<Seen>, uri: Uri, headers: axum::http::HeaderMap, body: Bytes| async move {
        let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let stream = value["stream"] == true;
        seen.lock().unwrap().push((uri.to_string(), headers["authorization"].to_str().unwrap().to_string(), value));
        let mut response = Response::new(Body::from(if stream { SSE } else { r#"{"id":"proxy-test","output":[],"usage":{"input_tokens":1,"output_tokens":1}}"# }));
        response.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static(if stream { "text/event-stream" } else { "application/json" }));
        response
    }).with_state(seen.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (url, seen, task)
}

fn configured(url: &str) -> UpstreamProxyConfig {
    UpstreamProxyConfig {
        enabled: true,
        url: url.into(),
    }
}

fn state_for(channel_id: &str, base: &str) -> ProxyAppState {
    let channel = ChannelPreset {
        id: channel_id.into(),
        openai_base_url: format!("{base}/v1"),
        ..ChannelPreset::openai_api()
    };
    let mut state = build_test_state(
        vec![channel],
        vec![test_account("project", channel_id, "test-project-key", 0)],
        [ProtocolType::OpenAi, ProtocolType::Responses]
            .into_iter()
            .flat_map(|protocol| {
                ["gpt-6.1-sol", "deepseek-v4-pro"]
                    .into_iter()
                    .map(move |model| {
                        test_route(
                            &format!("{model}-{}", protocol.as_str()),
                            model,
                            channel_id,
                            "project",
                            model,
                            protocol.clone(),
                            0,
                        )
                    })
            })
            .collect(),
    );
    state.client = Client::builder().no_proxy().build().unwrap();
    state
}

fn request_for(protocol: &ProtocolType, model: &str, stream: bool) -> Request<Body> {
    let mut value =
        serde_json::json!({"model":model,"stream":stream,"metadata":{"keep":"unchanged"}});
    let path = if *protocol == ProtocolType::Responses {
        value["input"] = serde_json::json!("hello");
        value["store"] = serde_json::json!(false);
        "/v1/responses"
    } else {
        value["messages"] = serde_json::json!([{"role":"user","content":"hello"}]);
        "/v1/chat/completions"
    };
    Request::builder()
        .method("POST")
        .uri(path)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(value.to_string()))
        .unwrap()
}

async fn send(
    state: ProxyAppState,
    config: UpstreamProxyConfig,
    protocol: ProtocolType,
    model: &str,
    stream: bool,
) -> Vec<u8> {
    with_test_config(config, async {
        let response = forward_request(state, request_for(&protocol, model, stream), protocol)
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap()
            .to_vec()
    })
    .await
}

#[tokio::test]
async fn chatgpt_actual_requests_use_proxy_for_both_protocols_and_streaming() {
    let (url, seen, task) = spy().await;
    let state = state_for("openai-api", "http://api.openai.invalid");
    for protocol in [ProtocolType::OpenAi, ProtocolType::Responses] {
        for model in ["gpt-6.1-sol", "deepseek-v4-pro"] {
            for stream in [false, true] {
                let body = send(
                    state.clone(),
                    configured(&url),
                    protocol.clone(),
                    model,
                    stream,
                )
                .await;
                if stream {
                    assert_eq!(body, SSE.as_bytes());
                }
                let calls = seen.lock().unwrap();
                let (uri, auth, value) = calls.last().unwrap();
                let path = if protocol == ProtocolType::Responses {
                    "responses"
                } else {
                    "chat/completions"
                };
                assert_eq!(uri, &format!("http://api.openai.invalid/v1/{path}"));
                assert_eq!(auth, "Bearer test-project-key");
                assert_eq!(value["model"], model);
                assert_eq!(value["metadata"]["keep"], "unchanged");
            }
        }
    }
    assert_eq!(seen.lock().unwrap().len(), 8);
    let logs = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let rows = state.storage.list_request_logs().unwrap();
            if rows.len() == 8 {
                break rows;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(logs.iter().all(|row| row.upstream_proxy_used == Some(true)));
    assert!(logs.iter().all(|row| row
        .upstream_url
        .as_deref()
        .is_some_and(|url| url.starts_with("http://api.openai.invalid/v1/"))));
    task.abort();
}

#[tokio::test]
async fn chatgpt_proxy_address_switch_and_disable_apply_without_restart() {
    let (direct, seen_direct, direct_task) = spy().await;
    let (proxy_a, seen_a, task_a) = spy().await;
    let (proxy_b, seen_b, task_b) = spy().await;
    let state = state_for("openai-api", &direct);
    send(
        state.clone(),
        configured(&proxy_a),
        ProtocolType::Responses,
        "deepseek-v4-pro",
        false,
    )
    .await;
    send(
        state.clone(),
        configured(&proxy_b),
        ProtocolType::Responses,
        "deepseek-v4-pro",
        false,
    )
    .await;
    send(
        state,
        UpstreamProxyConfig::default(),
        ProtocolType::Responses,
        "deepseek-v4-pro",
        false,
    )
    .await;
    assert_eq!(seen_a.lock().unwrap().len(), 1);
    assert_eq!(seen_b.lock().unwrap().len(), 1);
    assert_eq!(seen_direct.lock().unwrap().len(), 1);
    for task in [direct_task, task_a, task_b] {
        task.abort();
    }
}

#[tokio::test]
async fn explicit_account_egress_overrides_the_legacy_policy() {
    let (direct, seen_direct, direct_task) = spy().await;
    let (proxy, seen_proxy, proxy_task) = spy().await;
    let original = Client::builder().no_proxy().build().unwrap();
    let mut config = configured(&proxy);
    config.enabled = false;
    let account = ChannelAccount {
        channel_id: "custom".into(),
        use_upstream_proxy: Some(true),
        ..Default::default()
    };
    with_test_config(config, async {
        let (client, used, _) =
            crate::core::upstream_proxy::model_forwarding_client(&account, &original, &direct)
                .unwrap();
        assert_eq!(used, Some(true));
        client
            .post(&direct)
            .bearer_auth("test")
            .body("{}")
            .send()
            .await
            .unwrap();

        let account = ChannelAccount {
            use_upstream_proxy: Some(false),
            ..account
        };
        let (client, used, _) =
            crate::core::upstream_proxy::model_forwarding_client(&account, &original, &direct)
                .unwrap();
        assert_eq!(used, Some(false));
        client
            .post(&direct)
            .bearer_auth("test")
            .body("{}")
            .send()
            .await
            .unwrap();
    })
    .await;
    assert_eq!(seen_proxy.lock().unwrap().len(), 1);
    assert_eq!(seen_direct.lock().unwrap().len(), 1);
    proxy_task.abort();
    direct_task.abort();
}

#[tokio::test]
async fn other_channels_do_not_use_the_configured_model_proxy() {
    let (direct, seen_direct, direct_task) = spy().await;
    let (proxy, seen_proxy, proxy_task) = spy().await;
    for channel in [
        "longcat",
        "deepseek",
        "kimi",
        "qwen",
        "zhipu",
        "openrouter",
        "custom",
    ] {
        send(
            state_for(channel, &direct),
            configured(&proxy),
            ProtocolType::Responses,
            "deepseek-v4-pro",
            false,
        )
        .await;
    }
    assert_eq!(seen_direct.lock().unwrap().len(), 7);
    assert!(seen_proxy.lock().unwrap().is_empty());
    direct_task.abort();
    proxy_task.abort();
}

#[tokio::test]
async fn chatgpt_proxy_connection_failure_does_not_retry_direct() {
    let (direct, seen_direct, direct_task) = spy().await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let unavailable = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    let state = state_for("openai-api", &direct);
    let result = with_test_config(
        configured(&unavailable),
        forward_request(
            state,
            request_for(&ProtocolType::Responses, "deepseek-v4-pro", false),
            ProtocolType::Responses,
        ),
    )
    .await;
    assert!(matches!(result, Err(ProxyForwardError::Network(_))));
    assert!(seen_direct.lock().unwrap().is_empty());
    direct_task.abort();
}

#[tokio::test]
async fn chatgpt_https_requests_use_connect_tunneling() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut data = Vec::new();
        loop {
            let mut byte = [0];
            socket.read_exact(&mut byte).await.unwrap();
            data.push(byte[0]);
            if data.ends_with(b"\r\n\r\n") {
                break;
            }
            assert!(data.len() < 8192);
        }
        socket
            .write_all(
                b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            )
            .await
            .unwrap();
        String::from_utf8(data).unwrap()
    });
    let state = state_for("openai-api", "https://api.openai.invalid");
    let result = with_test_config(
        configured(&proxy),
        forward_request(
            state,
            request_for(&ProtocolType::Responses, "deepseek-v4-pro", false),
            ProtocolType::Responses,
        ),
    )
    .await;
    assert!(result.is_err());
    let connect = tokio::time::timeout(Duration::from_secs(5), server)
        .await
        .unwrap()
        .unwrap();
    assert!(
        connect.starts_with("CONNECT api.openai.invalid:443 HTTP/1.1\r\n"),
        "{connect}"
    );
    assert!(!connect.contains("test-project-key"));
}

#[tokio::test]
async fn failed_chatgpt_proxy_candidate_can_fall_back_to_original_channel_transport() {
    let (direct, seen, task) = spy().await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let unavailable = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    let channels = ["openai-api", "custom"]
        .into_iter()
        .map(|id| ChannelPreset {
            id: id.into(),
            openai_base_url: format!("{direct}/v1"),
            ..ChannelPreset::openai_api()
        })
        .collect();
    let mut state = build_test_state(
        channels,
        vec![
            test_account("project", "openai-api", "test-project-key", 0),
            test_account("fallback", "custom", "fallback-key", 0),
        ],
        vec![
            test_route(
                "first",
                "deepseek-v4-pro",
                "openai-api",
                "project",
                "deepseek-v4-pro",
                ProtocolType::Responses,
                0,
            ),
            test_route(
                "second",
                "deepseek-v4-pro",
                "custom",
                "fallback",
                "deepseek-v4-pro",
                ProtocolType::Responses,
                1,
            ),
        ],
    );
    state.client = Client::builder().no_proxy().build().unwrap();
    send(
        state.clone(),
        configured(&unavailable),
        ProtocolType::Responses,
        "deepseek-v4-pro",
        false,
    )
    .await;
    let calls = seen.lock().unwrap().clone();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].1, "Bearer fallback-key");
    let logs = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(final_log) = state.storage.list_request_logs().unwrap().first() {
                let attempts = state
                    .storage
                    .list_request_logs_by_request_id(&final_log.request_id)
                    .unwrap();
                if attempts.len() == 2 {
                    break attempts;
                }
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(logs
        .iter()
        .any(|log| log.channel_id.as_deref() == Some("openai-api") && log.status.is_none()));
    assert!(logs
        .iter()
        .any(|log| log.channel_id.as_deref() == Some("custom") && log.status == Some(200)));
    task.abort();
}

// CONNECT failures happen before TLS/application HTTP data, so retrying cannot
// duplicate a billable POST. A sent POST or an HTTP response must never be replayed.
#[tokio::test]
async fn connect_failures_retry_once_only_for_proxy_enabled_chatgpt() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    for (channel, enabled, expected) in [
        ("openai-api", true, 2),
        ("openai-api", false, 1),
        ("custom", true, 1),
    ] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy = format!("http://{}", listener.local_addr().unwrap());
        let calls = Arc::new(AtomicUsize::new(0));
        let captured = calls.clone();
        let server = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut headers = Vec::new();
                loop {
                    let mut byte = [0];
                    socket.read_exact(&mut byte).await.unwrap();
                    headers.push(byte[0]);
                    if headers.ends_with(b"\r\n\r\n") {
                        break;
                    }
                }
                assert!(headers.starts_with(b"CONNECT api.openai.invalid:443 "));
                assert!(!String::from_utf8_lossy(&headers).contains("project-key"));
                captured.fetch_add(1, Ordering::SeqCst);
                socket.write_all(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
            }
        });
        let client = Client::builder()
            .no_proxy()
            .proxy(reqwest::Proxy::all(&proxy).unwrap())
            .build()
            .unwrap();
        let request = client
            .post("https://api.openai.invalid/v1/responses")
            .bearer_auth("project-key")
            .body("unique-model-request")
            .build()
            .unwrap();
        let mut config = configured(&proxy);
        config.enabled = enabled;
        let error = with_test_config(
            config,
            crate::core::upstream_proxy::execute_model_request(
                channel,
                &client,
                request,
                enabled && channel == "openai-api",
            ),
        )
        .await
        .unwrap_err();
        assert!(error.is_connect());
        assert_eq!(calls.load(Ordering::SeqCst), expected);
        let detail = crate::core::upstream_proxy::model_network_error(channel, &error);
        if channel == "custom" {
            assert_eq!(detail, error.to_string());
        } else {
            assert!(detail.contains("[connect]"));
            assert!(detail.contains("tunnel"), "{detail}");
        }
        server.abort();
    }
}

#[tokio::test]
async fn chatgpt_sent_post_and_http_errors_are_not_replayed() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    // Empty response simulates a reset after the server read the POST; 502 is an
    // actual HTTP response, not the local proxy CONNECT handshake used above.
    for response in [
        b"".as_slice(),
        b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".as_slice(),
        b"HTTP/1.1 200 OK\r\nContent-Length: 1000\r\nConnection: close\r\n\r\npartial".as_slice(),
    ] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy = format!("http://{}", listener.local_addr().unwrap());
        let calls = Arc::new(AtomicUsize::new(0));
        let captured = calls.clone();
        let response = response.to_vec();
        let server = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut data = Vec::new();
                loop {
                    let mut byte = [0];
                    socket.read_exact(&mut byte).await.unwrap();
                    data.push(byte[0]);
                    if data.ends_with(b"unique-model-request") {
                        break;
                    }
                }
                captured.fetch_add(1, Ordering::SeqCst);
                socket.write_all(&response).await.unwrap();
            }
        });
        let client = Client::builder()
            .no_proxy()
            .proxy(reqwest::Proxy::all(&proxy).unwrap())
            .build()
            .unwrap();
        let request = client
            .post("http://api.openai.invalid/v1/responses")
            .body("unique-model-request")
            .build()
            .unwrap();
        let result = with_test_config(
            configured(&proxy),
            crate::core::upstream_proxy::execute_model_request(
                "openai-api",
                &client,
                request,
                true,
            ),
        )
        .await;
        match result {
            Ok(response) => {
                let _ = response.bytes().await;
            }
            Err(error) => assert!(!error.is_connect()),
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        server.abort();
    }
}

#[tokio::test]
async fn chatgpt_connect_retry_respects_the_original_timeout_budget() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let unavailable = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    let client = Client::builder()
        .no_proxy()
        .proxy(reqwest::Proxy::all(&unavailable).unwrap())
        .build()
        .unwrap();
    let request = client
        .post("https://api.openai.invalid/v1/responses")
        .body("not-sent")
        .build()
        .unwrap();
    let result = with_test_config(
        configured(&unavailable),
        tokio::time::timeout(
            Duration::from_millis(50),
            crate::core::upstream_proxy::execute_model_request(
                "openai-api",
                &client,
                request,
                true,
            ),
        ),
    )
    .await;
    assert!(
        result.is_err(),
        "the existing timeout must cancel retry backoff too"
    );
}
