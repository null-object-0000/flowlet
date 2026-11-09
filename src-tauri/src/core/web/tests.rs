use super::*;
use crate::core::{
    channels_config::DEFAULT_CONFIG_JSON,
    config::{ChannelAccount, RequestLogInput, RouteCandidate, UsageRecordInput},
    device_identity::DeviceIdentity,
};
const ADMIN: &str = "test-admin-token-only-for-management";
struct Fixture {
    state: WebState,
    base: String,
    task: tokio::task::JoinHandle<()>,
}
impl Fixture {
    async fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("flowlet-web-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = dir.join("config.json");
        std::fs::write(&config, DEFAULT_CONFIG_JSON).unwrap();
        std::fs::write(dir.join("index.html"), "<html>Flowlet Web test</html>").unwrap();
        let device_identity = DeviceIdentity::load_or_create(&dir).unwrap();
        let state = WebState {
            services: FlowletServices::open(dir.join("test.sqlite"), config)
                .unwrap()
                .with_client_auth(),
            admin_token: ADMIN.into(),
            static_dir: dir,
            public_proxy_url: "http://localhost:18640".into(),
            device_identity: Arc::new(Mutex::new(device_identity)),
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let router = create_web_router(state.clone());
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        Self { state, base, task }
    }
    async fn command(&self, name: &str, args: Value) -> reqwest::Response {
        reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .post(format!("{}/api/commands/{name}", self.base))
            .bearer_auth(ADMIN)
            .json(&args)
            .send()
            .await
            .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
        let _ = std::fs::remove_dir_all(&self.state.static_dir);
    }
}
#[tokio::test]
async fn management_requires_admin_and_never_falls_back_to_html() {
    let f = Fixture::new().await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    assert_eq!(
        client
            .get(format!("{}/health", f.base))
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    assert!(client
        .get(&f.base)
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap()
        .contains("Flowlet Web test"));
    for token in ["", "flowlet-local-token", "incorrect-admin-token"] {
        assert_eq!(
            client
                .get(format!("{}/api/session", f.base))
                .bearer_auth(token)
                .send()
                .await
                .unwrap()
                .status(),
            401
        );
        assert_eq!(
            client
                .post(format!("{}/api/commands/list_channel_accounts", f.base))
                .bearer_auth(token)
                .json(&json!({}))
                .send()
                .await
                .unwrap()
                .status(),
            401
        );
    }
    let response = f.command("list_channel_accounts", json!({})).await;
    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    assert_eq!(
        f.command("execute_shell", json!({"command":"id"}))
            .await
            .status(),
        501
    );
    assert_eq!(
        f.command("save_channel_accounts", json!({"accounts":"invalid"}))
            .await
            .status(),
        400
    );
    assert_eq!(
        client
            .get(format!("{}/api/missing", f.base))
            .send()
            .await
            .unwrap()
            .status(),
        404
    );
}
#[tokio::test]
async fn management_saves_publish_runtime_and_survive_reopen() {
    let f = Fixture::new().await;
    let account = ChannelAccount {
        id: "account-test".into(),
        channel_id: "deepseek".into(),
        name: "Test account".into(),
        api_key: "mock-upstream-key".into(),
        ..Default::default()
    };
    assert_eq!(
        f.command("save_channel_accounts", json!({"accounts":[account]}))
            .await
            .status(),
        200
    );
    assert_eq!(
        f.state.services.runtime_config.snapshot().accounts[0].name,
        "Test account"
    );
    let route = RouteCandidate {
        id: "route-test".into(),
        virtual_model_id: "deepseek-v4-flash".into(),
        channel_id: "deepseek".into(),
        account_id: "account-test".into(),
        upstream_model: "deepseek-v4-flash".into(),
        priority: 7,
        ..Default::default()
    };
    assert_eq!(
        f.command("save_route_candidates", json!({"routes":[route]}))
            .await
            .status(),
        200
    );
    assert_eq!(
        f.state.services.runtime_config.snapshot().routes[0].priority,
        7
    );
    let mut route = f.state.services.runtime_config.snapshot().routes[0].clone();
    route.enabled = false;
    assert_eq!(
        f.command("save_route_candidates", json!({"routes":[route]}))
            .await
            .status(),
        200
    );
    assert!(!f.state.services.runtime_config.snapshot().routes[0].enabled);
    let reopened = FlowletServices::open(
        f.state.static_dir.join("test.sqlite"),
        f.state.static_dir.join("config.json"),
    )
    .unwrap();
    assert_eq!(
        reopened.runtime_config.snapshot().accounts[0].id,
        "account-test"
    );
    assert!(
        !reopened
            .runtime_config
            .snapshot()
            .routes
            .iter()
            .find(|r| r.id == "route-test")
            .unwrap()
            .enabled
    );
    assert_eq!(
        f.command(
            "write_app_meta",
            json!({"key":"proxy_bind_config","value":"{}"})
        )
        .await
        .status(),
        400
    );
    assert_eq!(
        f.command(
            "usage_summary",
            json!({"startAt":null,"endAt":null,"groupBy":"invalid"})
        )
        .await
        .status(),
        400
    );
}

#[tokio::test]
async fn saved_routes_forward_all_three_protocols_and_disable_immediately() {
    use crate::core::config::{ProtocolType, ProxyBindConfig};
    let f = Fixture::new().await;
    let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_url = format!("http://{}", upstream.local_addr().unwrap());
    let router=Router::new().fallback(post(|headers:HeaderMap,Json(body):Json<Value>|async move {
        assert!(headers.get(header::AUTHORIZATION).is_some() || headers.get("x-api-key").is_some());
        assert_eq!(body["model"],"deepseek-v4-flash");
        Json(json!({"id":"mock-response","object":"chat.completion","model":"deepseek-v4-flash","choices":[{"index":0,"message":{"role":"assistant","content":"mock-ok"},"finish_reason":"stop"}],"content":[{"type":"text","text":"mock-ok"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}))
    }));
    let upstream_task = tokio::spawn(async move {
        axum::serve(upstream, router).await.unwrap();
    });
    let account = ChannelAccount {
        id: "mock-account".into(),
        channel_id: "deepseek".into(),
        name: "Mock".into(),
        api_key: "mock-key".into(),
        base_url_override: Some(upstream_url.clone()),
        anthropic_base_url_override: Some(upstream_url),
        ..Default::default()
    };
    assert_eq!(
        f.command("save_channel_accounts", json!({"accounts":[account]}))
            .await
            .status(),
        200
    );
    let routes: Vec<_> = [
        ProtocolType::OpenAi,
        ProtocolType::Anthropic,
        ProtocolType::Responses,
    ]
    .into_iter()
    .enumerate()
    .map(|(i, protocol)| RouteCandidate {
        id: format!("route-{i}"),
        virtual_model_id: "deepseek-v4-flash".into(),
        channel_id: "deepseek".into(),
        account_id: "mock-account".into(),
        upstream_model: "deepseek-v4-flash".into(),
        client_protocol: protocol,
        ..Default::default()
    })
    .collect();
    assert_eq!(
        f.command("save_route_candidates", json!({"routes":routes}))
            .await
            .status(),
        200
    );
    let port_listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = port_listener.local_addr().unwrap().port();
    drop(port_listener);
    f.state
        .services
        .set_bind_config(ProxyBindConfig {
            port,
            default_client_token: "mock-client-token".into(),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(f.command("start_proxy", json!({})).await.status(), 200);
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let base = format!("http://127.0.0.1:{port}");
    for (path, body) in [
        (
            "/v1/chat/completions",
            json!({"model":"deepseek-v4-flash","messages":[{"role":"user","content":"ping"}]}),
        ),
        (
            "/anthropic/v1/messages",
            json!({"model":"deepseek-v4-flash","max_tokens":8,"messages":[{"role":"user","content":"ping"}]}),
        ),
        (
            "/v1/responses",
            json!({"model":"deepseek-v4-flash","input":"ping"}),
        ),
    ] {
        let response = client
            .post(format!("{base}{path}"))
            .bearer_auth("mock-client-token")
            .json(&body)
            .send()
            .await
            .unwrap();
        let status = response.status();
        let text = response.text().await.unwrap();
        assert_eq!(status, 200, "{path}: {text}");
        assert!(text.contains("mock-ok"));
    }
    assert_eq!(
        client
            .get(format!("{base}/v1/models"))
            .bearer_auth(ADMIN)
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    let disabled: Vec<_> = routes
        .into_iter()
        .map(|mut route| {
            route.enabled = false;
            route
        })
        .collect();
    assert_eq!(
        f.command("save_route_candidates", json!({"routes":disabled}))
            .await
            .status(),
        200
    );
    let response = client
        .post(format!("{base}/v1/chat/completions"))
        .bearer_auth("mock-client-token")
        .json(&json!({"model":"deepseek-v4-flash","messages":[]}))
        .send()
        .await
        .unwrap();
    assert!(!response.status().is_success());
    assert_eq!(f.command("stop_proxy", json!({})).await.status(), 200);
    upstream_task.abort();
}

fn device_usage_request_log(request_id: &str) -> RequestLogInput {
    RequestLogInput {
        request_id: request_id.to_string(),
        agent_type: None,
        agent_session_id: None,
        parent_agent_session_id: None,
        client_id: Some("opencode".to_string()),
        client_name: Some("OpenCode".to_string()),
        channel_id: Some("deepseek".to_string()),
        channel_name: Some("DeepSeek".to_string()),
        account_id: Some("account-device-usage".to_string()),
        account_name: Some("Device usage".to_string()),
        client_protocol: "openai".to_string(),
        upstream_protocol: "openai".to_string(),
        virtual_model: Some("deepseek-v4-flash".to_string()),
        public_model: Some("deepseek-v4-flash".to_string()),
        upstream_model: Some("deepseek-v4-flash".to_string()),
        request_type: "chat".to_string(),
        method: "POST".to_string(),
        path: "/v1/chat/completions".to_string(),
        upstream_url: None,
        upstream_proxy_used: None,
        status: Some(200),
        latency_ms: Some(20),
        is_stream: false,
        error_message: None,
        fallback_count: 0,
        route_reason: Some("direct".to_string()),
        ttfb_ms: Some(10),
        duration_ms: Some(20),
        attempt_seq: 0,
        req_headers_json: Some(r#"{"User-Agent":"opencode/local ai-sdk"}"#.to_string()),
        req_body_b64: None,
        res_headers_json: None,
        res_body_b64: None,
        is_last_attempt: true,
    }
}

fn device_usage_record(request_id: &str) -> UsageRecordInput {
    UsageRecordInput {
        request_id: request_id.to_string(),
        client_id: Some("opencode".to_string()),
        client_name: Some("OpenCode".to_string()),
        channel_id: Some("deepseek".to_string()),
        channel_name: Some("DeepSeek".to_string()),
        account_id: Some("account-device-usage".to_string()),
        account_name: Some("Device usage".to_string()),
        client_protocol: "openai".to_string(),
        upstream_protocol: "openai".to_string(),
        virtual_model: Some("deepseek-v4-flash".to_string()),
        upstream_model: Some("deepseek-v4-flash".to_string()),
        input_tokens: Some(100),
        input_cached_tokens: Some(40),
        input_uncached_tokens: Some(60),
        input_cache_write_tokens: None,
        output_tokens: Some(20),
        total_tokens: Some(120),
    }
}

#[tokio::test]
async fn device_readonly_commands_expose_current_identity_and_usage() {
    let f = Fixture::new().await;
    let current_id = f.state.device_identity.lock().unwrap().device_id.clone();
    assert_ne!(current_id, "local");

    let read = |response: reqwest::Response| async move {
        response
            .error_for_status()
            .unwrap()
            .json::<Value>()
            .await
            .unwrap()
    };

    // 尚未产生用量时，设备目录只有当前设备，且当前设备排首位。
    let devices = read(f.command("list_known_devices", json!({})).await).await;
    let devices = devices.as_array().unwrap();
    assert_eq!(devices.len(), 1, "{devices:?}");
    assert_eq!(devices[0]["deviceId"], current_id);
    assert_eq!(devices[0]["isCurrent"], true);
    assert_eq!(devices[0]["appVersion"], env!("CARGO_PKG_VERSION"));
    assert_eq!(devices[0]["dayCount"], 0);
    assert!(devices[0]["firstUsageDate"].is_null());

    // 造一条本机用量，用于校验 usage_summary 的设备归属与设备用量命令。
    f.state
        .services
        .storage
        .insert_request_log(&device_usage_request_log("web-device-usage"))
        .unwrap();
    f.state
        .services
        .storage
        .upsert_usage_record(&device_usage_record("web-device-usage"))
        .unwrap();

    let summary = read(
        f.command(
            "usage_summary",
            json!({"startAt":null,"endAt":null,"groupBy":"day"}),
        )
        .await,
    )
    .await;
    let rows = summary.as_array().unwrap();
    assert!(!rows.is_empty(), "{summary:?}");
    for row in rows {
        assert_eq!(row["device_id"], current_id);
        assert_ne!(row["device_id"], "local");
    }

    let all_daily = read(
        f.command("device_daily_usage", json!({"deviceId":null}))
            .await,
    )
    .await;
    let all_daily = all_daily.as_array().unwrap();
    assert!(!all_daily.is_empty(), "全部设备日用量应包含本机数据");
    assert!(all_daily.iter().any(|day| day["knownTokens"] == 120));

    let current_daily = read(
        f.command("device_daily_usage", json!({"deviceId": current_id}))
            .await,
    )
    .await;
    assert_eq!(current_daily.as_array().unwrap(), all_daily);

    let all_hourly = read(
        f.command("device_hourly_usage", json!({"deviceId":null}))
            .await,
    )
    .await;
    assert!(!all_hourly.as_array().unwrap().is_empty());

    let current_hourly = read(
        f.command("device_hourly_usage", json!({"deviceId": current_id}))
            .await,
    )
    .await;
    assert_eq!(
        current_hourly.as_array().unwrap(),
        all_hourly.as_array().unwrap()
    );

    // 当前设备的统计字段应反映刚写入的用量。
    let devices = read(f.command("list_known_devices", json!({})).await).await;
    let devices = devices.as_array().unwrap();
    assert_eq!(devices.len(), 1);
    assert_eq!(devices[0]["deviceId"], current_id);
    assert_eq!(devices[0]["dayCount"], 1);
    assert_eq!(devices[0]["requestCount"], 1);
    assert_eq!(devices[0]["knownTokens"], 120);
    assert!(devices[0]["firstUsageDate"].is_string());
    assert!(devices[0]["lastUsageDate"].is_string());
}

fn log_filter() -> crate::core::config::LogsFilter {
    crate::core::config::LogsFilter {
        page: 1,
        page_size: 10,
        status: "all".into(),
        client_id: String::new(),
        channel_id: String::new(),
        search: String::new(),
        time_range: "all".into(),
        model: String::new(),
        model_kind: String::new(),
        start_at: String::new(),
        end_at: String::new(),
        token_status: "all".into(),
    }
}

#[tokio::test]
async fn capture_settings_apply_to_next_request_without_restart() {
    use crate::core::config::{LogCaptureConfig, ProtocolType, ProxyBindConfig};

    let f = Fixture::new().await;
    let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_url = format!("http://{}", upstream.local_addr().unwrap());
    let router = Router::new().fallback(post(|Json(_body): Json<Value>| async move {
        Json(json!({
            "id":"mock-response",
            "object":"chat.completion",
            "model":"deepseek-v4-flash",
            "choices":[{"index":0,"message":{"role":"assistant","content":"mock-ok"},"finish_reason":"stop"}],
            "usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}
        }))
    }));
    let upstream_task = tokio::spawn(async move {
        axum::serve(upstream, router).await.unwrap();
    });

    let account = ChannelAccount {
        id: "capture-account".into(),
        channel_id: "deepseek".into(),
        name: "Capture".into(),
        api_key: "mock-key".into(),
        base_url_override: Some(upstream_url),
        ..Default::default()
    };
    assert_eq!(
        f.command("save_channel_accounts", json!({"accounts":[account]}))
            .await
            .status(),
        200
    );
    let routes = vec![RouteCandidate {
        id: "capture-route".into(),
        virtual_model_id: "deepseek-v4-flash".into(),
        channel_id: "deepseek".into(),
        account_id: "capture-account".into(),
        upstream_model: "deepseek-v4-flash".into(),
        client_protocol: ProtocolType::OpenAi,
        ..Default::default()
    }];
    assert_eq!(
        f.command("save_route_candidates", json!({"routes":routes}))
            .await
            .status(),
        200
    );
    let port_listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = port_listener.local_addr().unwrap().port();
    drop(port_listener);
    f.state
        .services
        .set_bind_config(ProxyBindConfig {
            port,
            default_client_token: "capture-client-token".into(),
            ..Default::default()
        })
        .unwrap();

    // 启动代理前关闭 Body 捕获：代理必须读取启动时的最新配置。
    let mut disabled = LogCaptureConfig::default();
    disabled.capture_req_body = false;
    disabled.capture_res_body = false;
    let set_capture =
        |capture: &LogCaptureConfig| json!({"config": serde_json::to_value(capture).unwrap()});
    assert_eq!(
        f.command("set_log_capture_config", set_capture(&disabled))
            .await
            .status(),
        200
    );
    assert_eq!(f.command("start_proxy", json!({})).await.status(), 200);

    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let url = format!("http://127.0.0.1:{port}/v1/chat/completions");
    let send = |content: &'static str| {
        let client = client.clone();
        let url = url.clone();
        async move {
            let response = client
                .post(url)
                .bearer_auth("capture-client-token")
                .json(&json!({"model":"deepseek-v4-flash","messages":[{"role":"user","content":content}]}))
                .send()
                .await
                .unwrap();
            let status = response.status();
            let text = response.text().await.unwrap();
            assert_eq!(status, 200, "{text}");
        }
    };
    send("first").await;

    let storage = f.state.services.storage.clone();
    let logs = storage.list_request_logs_page(log_filter()).unwrap();
    assert_eq!(logs.total, 1);
    let first = storage
        .list_request_logs_by_request_id(&logs.rows[0].request_id)
        .unwrap();
    assert!(
        first[0].req_body_b64.is_none(),
        "关闭捕获时不应保存 Request Body"
    );
    assert!(
        first[0].res_body_b64.is_none(),
        "关闭捕获时不应保存 Response Body"
    );

    // 运行中热更新捕获配置，下一次请求立即生效。
    let mut enabled = LogCaptureConfig::default();
    enabled.body_retention_days = 30;
    assert_eq!(
        f.command("set_log_capture_config", set_capture(&enabled))
            .await
            .status(),
        200
    );
    let current: Value = f
        .command("get_log_capture_config", json!({}))
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(current["body_retention_days"], 30);

    send("second").await;

    let logs = storage.list_request_logs_page(log_filter()).unwrap();
    assert_eq!(logs.total, 2);
    let mut captured = 0;
    for row in &logs.rows {
        let detail = storage
            .list_request_logs_by_request_id(&row.request_id)
            .unwrap();
        if detail[0].req_body_b64.is_some() {
            captured += 1;
        }
    }
    assert_eq!(captured, 1, "只有热更新后的请求保存 Request Body");

    assert_eq!(f.command("stop_proxy", json!({})).await.status(), 200);
    upstream_task.abort();
}

/// 构造一条带会话标识的请求日志，用于验证 Web Host 的会话目录。
fn session_request_log(
    request_id: &str,
    agent_type: &str,
    session_id: &str,
    parent_session_id: Option<&str>,
    client_name: &str,
    status: Option<i64>,
) -> RequestLogInput {
    let mut log = device_usage_request_log(request_id);
    log.agent_type = Some(agent_type.to_string());
    log.agent_session_id = Some(session_id.to_string());
    log.parent_agent_session_id = parent_session_id.map(str::to_string);
    log.client_id = Some(agent_type.to_string());
    log.client_name = Some(client_name.to_string());
    log.status = status;
    log
}

#[tokio::test]
async fn session_commands_only_expose_flowlet_observed_sessions() {
    let f = Fixture::new().await;
    let storage = &f.state.services.storage;
    // 根会话、直接子会话、另一客户端的根会话各一条；只有根会话进入主列表。
    storage
        .insert_request_log(&session_request_log(
            "web-session-req-root",
            "claude-code",
            "web-session-root",
            None,
            "Claude Code",
            Some(200),
        ))
        .unwrap();
    storage
        .upsert_usage_record(&device_usage_record("web-session-req-root"))
        .unwrap();
    storage
        .insert_request_log(&session_request_log(
            "web-session-req-child",
            "claude-code",
            "web-session-child",
            Some("web-session-root"),
            "Claude Code",
            Some(500),
        ))
        .unwrap();
    storage
        .insert_request_log(&session_request_log(
            "web-session-req-other",
            "opencode",
            "web-session-other",
            None,
            "OpenCode",
            Some(200),
        ))
        .unwrap();

    let read = |response: reqwest::Response| async move {
        response
            .error_for_status()
            .unwrap()
            .json::<Value>()
            .await
            .unwrap()
    };

    // Web 会话目录只聚合请求观测：主列表只返回根会话，且每行都标记 flowletObserved。
    let page = read(
        f.command(
            "list_agent_sessions",
            json!({"filter":{"page":1,"page_size":10}}),
        )
        .await,
    )
    .await;
    assert_eq!(page["total"], 2, "{page}");
    assert_eq!(page["page"], 1);
    assert_eq!(page["pageSize"], 10);
    let rows = page["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 2, "{page}");
    assert!(rows
        .iter()
        .all(|row| row["flowletObserved"].as_bool() == Some(true)));
    assert!(rows.iter().all(|row| row["parentSessionId"].is_null()));
    assert!(
        rows.iter().all(|row| row["nativeSessionDir"].is_null()),
        "Web 不读取服务器本机原生会话目录"
    );
    let root = rows
        .iter()
        .find(|row| row["sessionId"] == "web-session-root")
        .expect("root session");
    assert_eq!(root["agentType"], "claude-code");
    assert_eq!(root["clientName"], "Claude Code");
    assert_eq!(root["requestCount"], 1);
    assert_eq!(root["knownTokens"], 120);
    assert_eq!(root["errorCount"], 0);
    // 观测会话没有本机原生文件，运行状态保持 unknown，而不是猜测。
    assert_eq!(root["runtimeStatus"], "unknown");

    // 客户端筛选与搜索复用桌面端口径；搜索子会话 ID 时回到其根会话。
    let filtered = read(
        f.command(
            "list_agent_sessions",
            json!({"filter":{"page":1,"page_size":10,"agent_type":"opencode"}}),
        )
        .await,
    )
    .await;
    assert_eq!(filtered["total"], 1, "{filtered}");
    assert_eq!(
        filtered["rows"][0]["sessionId"], "web-session-other",
        "{filtered}"
    );
    let searched = read(
        f.command(
            "list_agent_sessions",
            json!({"filter":{"page":1,"page_size":10,"search":"web-session-child"}}),
        )
        .await,
    )
    .await;
    assert_eq!(searched["total"], 1, "{searched}");
    assert_eq!(
        searched["rows"][0]["sessionId"], "web-session-root",
        "{searched}"
    );

    // 分页参数生效。
    let second = read(
        f.command(
            "list_agent_sessions",
            json!({"filter":{"page":2,"page_size":1}}),
        )
        .await,
    )
    .await;
    assert_eq!(second["total"], 2);
    assert_eq!(second["rows"].as_array().unwrap().len(), 1);

    // 子会话：只返回同一观测树下的直接子会话。
    let children = read(
        f.command(
            "list_agent_session_children",
            json!({"agentType":"claude-code","parentSessionId":"web-session-root"}),
        )
        .await,
    )
    .await;
    let children = children.as_array().unwrap();
    assert_eq!(children.len(), 1, "{children:?}");
    assert_eq!(children[0]["sessionId"], "web-session-child");
    assert_eq!(children[0]["parentSessionId"], "web-session-root");
    assert_eq!(children[0]["errorCount"], 1);
    let no_children = read(
        f.command(
            "list_agent_session_children",
            json!({"agentType":"opencode","parentSessionId":"web-session-root"}),
        )
        .await,
    )
    .await;
    assert!(no_children.as_array().unwrap().is_empty());

    // 本机原生会话读取属于桌面专属能力，不在 Web 命令白名单内。
    assert_eq!(
        f.command("get_agent_session_native_summary", json!({}))
            .await
            .status(),
        501
    );
}
