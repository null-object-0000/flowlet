use super::Storage;
use crate::core::channels_config::{ChannelsConfig, DEFAULT_CONFIG_JSON};
use crate::core::config::{
    LogsFilter, ProtocolType, RequestLogInput, RouteCandidate, UsageRecordInput,
};
use base64::Engine;
use rusqlite::Connection;

fn request_log_for_repair(
    request_id: &str,
    attempt_seq: i64,
    is_last_attempt: bool,
) -> RequestLogInput {
    RequestLogInput {
        request_id: request_id.to_string(),
        agent_type: None,
        agent_session_id: None,
        parent_agent_session_id: None,
        client_id: Some("opencode".to_string()),
        client_name: Some("OpenCode".to_string()),
        channel_id: Some("longcat".to_string()),
        channel_name: Some("LongCat".to_string()),
        account_id: Some("account-1".to_string()),
        account_name: Some("Account".to_string()),
        client_protocol: "openai".to_string(),
        upstream_protocol: "openai".to_string(),
        virtual_model: Some("flowlet-pro".to_string()),
        public_model: Some("flowlet-pro".to_string()),
        upstream_model: Some("LongCat-2.0".to_string()),
        request_type: "chat".to_string(),
        method: "POST".to_string(),
        path: "/v1/chat/completions".to_string(),
        upstream_url: None,
        status: Some(200),
        latency_ms: Some(20),
        is_stream: false,
        error_message: None,
        fallback_count: attempt_seq,
        route_reason: Some("direct".to_string()),
        ttfb_ms: Some(10),
        duration_ms: Some(20),
        attempt_seq,
        req_headers_json: Some(r#"{"User-Agent":"opencode/local ai-sdk","X-Session-Id":"ses_history","X-Session-Affinity":"ses_history"}"#.to_string()),
        req_body_b64: None,
        res_headers_json: None,
        res_body_b64: None,
        is_last_attempt,
    }
}

#[test]
fn lists_paginated_request_logs_with_usage_join() {
    let connection = Connection::open_in_memory().expect("open in-memory sqlite");
    let storage = Storage::from_connection_for_test(connection);
    storage.migrate().expect("migrate request log schema");

    let page = storage
        .list_request_logs_page(LogsFilter {
            page: 1,
            page_size: 8,
            status: "all".to_string(),
            client_id: String::new(),
            channel_id: String::new(),
            search: String::new(),
            time_range: "1h".to_string(),
            model: String::new(),
            model_kind: String::new(),
        })
        .expect("query request logs with qualified joined columns");

    assert_eq!(page.total, 0);
    assert!(page.rows.is_empty());
    assert_eq!(page.summary.request_count, 0);
}

fn model_filter(model: &str, kind: &str) -> LogsFilter {
    LogsFilter {
        page: 1,
        page_size: 8,
        status: "all".to_string(),
        client_id: String::new(),
        channel_id: String::new(),
        search: String::new(),
        time_range: "all".to_string(),
        model: model.to_string(),
        model_kind: kind.to_string(),
    }
}

#[test]
fn model_filter_matches_only_the_selected_dimension() {
    let connection = Connection::open_in_memory().expect("open in-memory sqlite");
    let storage = Storage::from_connection_for_test(connection);
    storage.migrate().expect("migrate request log schema");

    // request_log_for_repair: public/virtual = flowlet-pro，upstream = LongCat-2.0。
    storage
        .insert_request_log(&request_log_for_repair("req-dim", 0, true))
        .expect("insert request log");

    // 选“对外模型 flowlet-pro”只命中对外维度。
    let public_hit = storage
        .list_request_logs_page(model_filter("flowlet-pro", "public"))
        .expect("filter by public model");
    assert_eq!(public_hit.total, 1);

    // 同名按“路由模型”筛选不命中（upstream 是 LongCat-2.0）。
    let public_as_upstream = storage
        .list_request_logs_page(model_filter("flowlet-pro", "upstream"))
        .expect("filter public name as upstream");
    assert_eq!(public_as_upstream.total, 0);

    // 选“路由模型 LongCat-2.0”只命中路由维度。
    let upstream_hit = storage
        .list_request_logs_page(model_filter("LongCat-2.0", "upstream"))
        .expect("filter by upstream model");
    assert_eq!(upstream_hit.total, 1);

    // 同名按“对外模型”筛选不命中。
    let upstream_as_public = storage
        .list_request_logs_page(model_filter("LongCat-2.0", "public"))
        .expect("filter upstream name as public");
    assert_eq!(upstream_as_public.total, 0);

    // 兼容旧调用方：不传来源时两个维度 OR 匹配。
    let legacy = storage
        .list_request_logs_page(model_filter("LongCat-2.0", ""))
        .expect("legacy OR filter");
    assert_eq!(legacy.total, 1);
}

#[test]
fn lists_only_main_opencode_sessions_and_loads_children_separately() {
    let connection = Connection::open_in_memory().expect("open in-memory sqlite");
    let storage = Storage::from_connection_for_test(connection);
    storage.migrate().expect("migrate request log schema");

    let mut log = RequestLogInput {
        request_id: "req-1".to_string(),
        agent_type: Some("opencode".to_string()),
        agent_session_id: Some("ses_test".to_string()),
        parent_agent_session_id: Some("ses_parent".to_string()),
        client_id: Some("opencode".to_string()),
        client_name: Some("OpenCode".to_string()),
        channel_id: Some("longcat".to_string()),
        channel_name: Some("LongCat".to_string()),
        account_id: Some("account-1".to_string()),
        account_name: Some("Account".to_string()),
        client_protocol: "openai".to_string(),
        upstream_protocol: "openai".to_string(),
        virtual_model: Some("flowlet-pro".to_string()),
        public_model: Some("flowlet-pro".to_string()),
        upstream_model: Some("LongCat-2.0".to_string()),
        request_type: "chat".to_string(),
        method: "POST".to_string(),
        path: "/v1/chat/completions".to_string(),
        upstream_url: Some("https://api.longcat.chat/openai/v1/chat/completions".to_string()),
        status: Some(200),
        latency_ms: Some(20),
        is_stream: true,
        error_message: None,
        fallback_count: 0,
        route_reason: Some("direct".to_string()),
        ttfb_ms: Some(10),
        duration_ms: Some(20),
        attempt_seq: 0,
        req_headers_json: None,
        req_body_b64: None,
        res_headers_json: None,
        res_body_b64: None,
        is_last_attempt: true,
    };
    log.request_id = "req-root".to_string();
    log.agent_session_id = Some("ses_parent".to_string());
    log.parent_agent_session_id = None;
    storage.insert_request_log(&log).unwrap();
    storage
        .upsert_usage_record(&UsageRecordInput {
            request_id: "req-root".to_string(),
            client_id: log.client_id.clone(),
            client_name: log.client_name.clone(),
            channel_id: log.channel_id.clone(),
            channel_name: log.channel_name.clone(),
            account_id: log.account_id.clone(),
            account_name: log.account_name.clone(),
            client_protocol: log.client_protocol.clone(),
            upstream_protocol: log.upstream_protocol.clone(),
            virtual_model: log.virtual_model.clone(),
            upstream_model: log.upstream_model.clone(),
            input_tokens: Some(100),
            input_cached_tokens: Some(40),
            input_uncached_tokens: Some(60),
            input_cache_write_tokens: None,
            output_tokens: Some(20),
            total_tokens: Some(120),
        })
        .unwrap();

    log.request_id = "req-1".to_string();
    log.agent_session_id = Some("ses_test".to_string());
    log.parent_agent_session_id = Some("ses_parent".to_string());
    storage.insert_request_log(&log).unwrap();
    storage
        .upsert_usage_record(&UsageRecordInput {
            request_id: "req-1".to_string(),
            client_id: log.client_id.clone(),
            client_name: log.client_name.clone(),
            channel_id: log.channel_id.clone(),
            channel_name: log.channel_name.clone(),
            account_id: log.account_id.clone(),
            account_name: log.account_name.clone(),
            client_protocol: log.client_protocol.clone(),
            upstream_protocol: log.upstream_protocol.clone(),
            virtual_model: log.virtual_model.clone(),
            upstream_model: log.upstream_model.clone(),
            input_tokens: Some(200),
            input_cached_tokens: Some(100),
            input_uncached_tokens: Some(100),
            input_cache_write_tokens: None,
            output_tokens: Some(50),
            total_tokens: Some(250),
        })
        .unwrap();
    log.request_id = "req-2".to_string();
    log.status = Some(500);
    log.error_message = Some("upstream error".to_string());
    storage.insert_request_log(&log).unwrap();

    let page = storage
        .list_agent_sessions(crate::core::config::AgentSessionsFilter {
            page: 1,
            page_size: 10,
            search: "ses_test".to_string(),
            agent_type: "opencode".to_string(),
            flowlet_status: "observed".to_string(),
        })
        .unwrap();
    assert_eq!(page.total, 1);
    assert_eq!(page.page_size, 8);
    assert_eq!(page.rows[0].session_id, "ses_parent");
    assert_eq!(page.rows[0].request_count, 1);
    assert_eq!(page.rows[0].success_count, 1);
    assert_eq!(page.rows[0].error_count, 0);
    assert_eq!(page.rows[0].parent_session_id, None);
    assert_eq!(page.rows[0].client_id.as_deref(), Some("opencode"));
    assert_eq!(page.rows[0].client_name.as_deref(), Some("OpenCode"));
    assert_eq!(page.rows[0].known_tokens, 120);
    assert_eq!(page.rows[0].input_tokens, 100);
    assert_eq!(page.rows[0].input_cached_tokens, 40);
    assert_eq!(page.rows[0].input_uncached_tokens, 60);
    assert_eq!(page.rows[0].cache_measured_input_tokens, 100);
    assert_eq!(page.rows[0].output_tokens, 20);
    assert_eq!(page.rows[0].unknown_usage_count, 0);

    let children = storage
        .list_agent_session_children("opencode", "ses_parent")
        .unwrap();
    assert_eq!(children.len(), 1);
    assert_eq!(children[0].session_id, "ses_test");
    assert_eq!(children[0].request_count, 2);
    assert_eq!(children[0].success_count, 1);
    assert_eq!(children[0].error_count, 1);
    assert_eq!(children[0].parent_session_id.as_deref(), Some("ses_parent"));
    assert_eq!(children[0].known_tokens, 250);
    assert_eq!(children[0].input_tokens, 200);
    assert_eq!(children[0].input_cached_tokens, 100);
    assert_eq!(children[0].input_uncached_tokens, 100);
    assert_eq!(children[0].cache_measured_input_tokens, 200);
    assert_eq!(children[0].output_tokens, 50);
    assert_eq!(children[0].unknown_usage_count, 1);
    let clients = storage.list_agent_session_clients().unwrap();
    assert_eq!(clients.len(), 1);
    assert_eq!(clients[0].id, "opencode");
    let filtered_out = storage
        .list_agent_sessions(crate::core::config::AgentSessionsFilter {
            page: 1,
            page_size: 10,
            search: String::new(),
            agent_type: "claude-code".to_string(),
            flowlet_status: String::new(),
        })
        .unwrap();
    assert_eq!(filtered_out.total, 0);

    let out_of_range = storage
        .list_agent_sessions(crate::core::config::AgentSessionsFilter {
            page: 2,
            page_size: 8,
            search: String::new(),
            agent_type: String::new(),
            flowlet_status: String::new(),
        })
        .unwrap();
    assert!(out_of_range.rows.is_empty());
    assert_eq!(out_of_range.total, 1);
}

#[test]
fn groups_claude_code_requests_by_official_session_header_attribution() {
    let connection = Connection::open_in_memory().expect("open in-memory sqlite");
    let storage = Storage::from_connection_for_test(connection);
    storage.migrate().expect("migrate request log schema");

    let mut log = request_log_for_repair("claude-request-1", 0, true);
    log.agent_type = Some("claude-code".to_string());
    log.agent_session_id = Some("09af5e1a-bc08-4ae8-bb34-7ed47dca196d".to_string());
    log.parent_agent_session_id = None;
    log.client_id = Some("claude-code".to_string());
    log.client_name = Some("Claude Code".to_string());
    storage.insert_request_log(&log).unwrap();

    let page = storage
        .list_agent_sessions(crate::core::config::AgentSessionsFilter {
            page: 1,
            page_size: 10,
            search: "09af5e1a".to_string(),
            agent_type: "claude-code".to_string(),
            flowlet_status: "observed".to_string(),
        })
        .unwrap();
    assert_eq!(page.total, 1);
    assert_eq!(page.rows[0].agent_type, "claude-code");
    assert_eq!(
        page.rows[0].session_id,
        "09af5e1a-bc08-4ae8-bb34-7ed47dca196d"
    );
    assert_eq!(page.rows[0].client_name.as_deref(), Some("Claude Code"));
}

#[test]
fn repairs_historical_claude_code_session_header() {
    let connection = Connection::open_in_memory().expect("open in-memory sqlite");
    let storage = Storage::from_connection_for_test(connection);
    storage.migrate().expect("migrate request log schema");
    let mut log = request_log_for_repair("claude-history", 0, true);
    log.client_id = Some("claude-code".to_string());
    log.client_name = Some("Claude Code".to_string());
    log.req_headers_json = Some(r#"{"user-agent":"claude-cli/2.1.207 (external, cli)","x-claude-code-session-id":"claude-history-session"}"#.to_string());
    storage.insert_request_log(&log).unwrap();

    let result = storage.repair_agent_sessions("all").unwrap();
    assert_eq!(result.repaired_requests, 1);
    let connection = storage.connection.lock().unwrap();
    let attribution: (String, String) = connection
        .query_row(
            "SELECT agent_type, agent_session_id FROM request_logs WHERE request_id = 'claude-history'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(attribution.0, "claude-code");
    assert_eq!(attribution.1, "claude-history-session");
}

#[test]
fn repairs_historical_opencode_sessions_for_all_attempts() {
    let connection = Connection::open_in_memory().expect("open in-memory sqlite");
    let storage = Storage::from_connection_for_test(connection);
    storage.migrate().expect("migrate request log schema");
    storage
        .insert_request_log(&request_log_for_repair("req-history", 0, false))
        .unwrap();
    storage
        .insert_request_log(&request_log_for_repair("req-history", 1, true))
        .unwrap();

    storage.connection.lock().unwrap()
        .execute("UPDATE request_logs SET created_at = datetime('now', '-10 days') WHERE request_id = 'req-history'", [])
        .unwrap();
    let recent_result = storage.repair_agent_sessions("7d").unwrap();
    assert_eq!(recent_result.scanned_requests, 0);

    let result = storage.repair_agent_sessions("all").unwrap();
    assert_eq!(result.scanned_requests, 1);
    assert_eq!(result.repaired_requests, 1);
    assert_eq!(result.repaired_logs, 2);
    assert_eq!(result.skipped_requests, 0);

    let connection = storage.connection.lock().unwrap();
    let repaired: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM request_logs WHERE request_id = 'req-history' AND agent_type = 'opencode' AND agent_session_id = 'ses_history'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(repaired, 2);
}

#[test]
fn fills_unknown_usage_once_for_the_final_attempt() {
    let connection = Connection::open_in_memory().expect("open in-memory sqlite");
    let storage = Storage::from_connection_for_test(connection);
    storage.migrate().expect("migrate request log schema");
    storage
        .insert_request_log(&request_log_for_repair("req-unknown", 0, false))
        .unwrap();
    storage
        .insert_request_log(&request_log_for_repair("req-unknown", 1, true))
        .unwrap();

    assert_eq!(storage.analyze_unknown_usage("all").unwrap(), 1);
    assert_eq!(storage.analyze_unknown_usage("all").unwrap(), 0);
    let connection = storage.connection.lock().unwrap();
    let usage_rows: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM usage_records WHERE request_id = 'req-unknown'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(usage_rows, 1);
}

#[test]
fn reanalyzes_longcat_stream_usage_from_captured_response() {
    let connection = Connection::open_in_memory().expect("open in-memory sqlite");
    let storage = Storage::from_connection_for_test(connection);
    storage.migrate().expect("migrate request log schema");
    let body = br#"data: {"choices":[],"usage":{"effectiveCachedTokens":90,"prompt_tokens":100,"completion_tokens":20,"total_tokens":120},"lastOne":true}

data: [DONE]

"#;
    let body_b64 = base64::engine::general_purpose::STANDARD.encode(body);

    storage
        .insert_request_log(&RequestLogInput {
            request_id: "longcat-stream-usage".to_string(),
            agent_type: None,
            agent_session_id: None,
            parent_agent_session_id: None,
            client_id: Some("test-client".to_string()),
            client_name: Some("Test Client".to_string()),
            channel_id: Some("longcat".to_string()),
            channel_name: Some("LongCat".to_string()),
            account_id: Some("account-1".to_string()),
            account_name: Some("LongCat Account".to_string()),
            client_protocol: "openai".to_string(),
            upstream_protocol: "openai".to_string(),
            virtual_model: Some("flowlet-pro".to_string()),
            public_model: Some("flowlet-pro".to_string()),
            upstream_model: Some("LongCat-2.0".to_string()),
            request_type: "chat.completions".to_string(),
            method: "POST".to_string(),
            path: "/v1/chat/completions".to_string(),
            upstream_url: Some("https://api.longcat.chat/openai/v1/chat/completions".to_string()),
            status: Some(200),
            latency_ms: Some(50),
            is_stream: true,
            error_message: None,
            fallback_count: 0,
            route_reason: Some("direct".to_string()),
            ttfb_ms: Some(10),
            duration_ms: Some(50),
            attempt_seq: 0,
            req_headers_json: None,
            req_body_b64: None,
            res_headers_json: None,
            res_body_b64: Some(body_b64.clone()),
            is_last_attempt: true,
        })
        .expect("insert captured stream log");
    storage
        .update_request_log_timing(
            "longcat-stream-usage",
            10,
            Some(20),
            50,
            None,
            Some(body_b64),
            None,
            None,
        )
        .expect("record stream timing");

    assert_eq!(storage.reanalyze_captured_usage("all").unwrap(), 1);
    let page = storage
        .list_request_logs_page(LogsFilter {
            page: 1,
            page_size: 8,
            status: "all".to_string(),
            client_id: String::new(),
            channel_id: String::new(),
            search: String::new(),
            time_range: "1h".to_string(),
            model: String::new(),
            model_kind: String::new(),
        })
        .expect("query reparsed stream usage");
    assert_eq!(page.rows[0].input_tokens, Some(100));
    assert_eq!(page.rows[0].input_cached_tokens, Some(90));
    assert_eq!(page.rows[0].input_uncached_tokens, Some(10));
    assert_eq!(page.rows[0].output_tokens, Some(20));
    assert_eq!(page.rows[0].total_tokens, Some(120));
    assert_eq!(page.rows[0].ttft_ms, Some(20));
    assert_eq!(
        page.rows[0].upstream_url.as_deref(),
        Some("https://api.longcat.chat/openai/v1/chat/completions")
    );
    assert_eq!(page.summary.cache_hit_rate, Some(0.9));
    storage.connection.lock().unwrap()
        .execute(
            "UPDATE usage_records SET input_tokens = 1, total_tokens = 1 WHERE request_id = 'longcat-stream-usage'",
            [],
        )
        .unwrap();
    assert_eq!(storage.reanalyze_captured_usage("all").unwrap(), 1);
    let reparsed_page = storage
        .list_request_logs_page(LogsFilter {
            page: 1,
            page_size: 8,
            status: "all".to_string(),
            client_id: String::new(),
            channel_id: String::new(),
            search: String::new(),
            time_range: "1h".to_string(),
            model: String::new(),
            model_kind: String::new(),
        })
        .unwrap();
    assert_eq!(reparsed_page.rows[0].input_tokens, Some(100));
    assert_eq!(reparsed_page.rows[0].total_tokens, Some(120));
    {
        let connection = storage.connection.lock().unwrap();
        connection.execute(
            "UPDATE request_logs SET created_at = datetime('now', '-10 days') WHERE request_id = 'longcat-stream-usage'",
            [],
        ).unwrap();
        connection.execute(
            "UPDATE usage_records SET input_tokens = 2, total_tokens = 2 WHERE request_id = 'longcat-stream-usage'",
            [],
        ).unwrap();
    }
    assert_eq!(storage.reanalyze_captured_usage("7d").unwrap(), 0);
    let filtered_tokens: i64 = storage
        .connection
        .lock()
        .unwrap()
        .query_row(
            "SELECT total_tokens FROM usage_records WHERE request_id = 'longcat-stream-usage'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(filtered_tokens, 2);
    let output_rate = page.summary.average_output_tokens_per_second.unwrap();
    assert!((output_rate - 20000.0 / 30.0).abs() < 0.001);
}

#[test]
fn migrates_legacy_route_table() {
    let connection = Connection::open_in_memory().expect("open in-memory sqlite");
    connection
        .execute_batch(
            r#"
            CREATE TABLE virtual_model_routes (
                id TEXT PRIMARY KEY,
                provider_name TEXT NOT NULL
            );
            "#,
        )
        .expect("create legacy table");
    let storage = Storage::from_connection_for_test(connection);

    storage.migrate().expect("migrate legacy schema");

    assert!(storage.list_route_candidates().is_ok());

    let now = chrono::Utc::now().to_rfc3339();
    storage
        .save_route_candidates(&[RouteCandidate {
            id: "route-test".to_string(),
            virtual_model_id: "LongCat-2.0".to_string(),
            channel_id: "longcat".to_string(),
            account_id: "account-test".to_string(),
            upstream_model: "LongCat-2.0".to_string(),
            client_protocol: ProtocolType::OpenAi,
            priority: 0,
            enabled: true,
            created_at: now.clone(),
            updated_at: now.clone(),
        }])
        .expect("save route candidates after migration");
}

#[test]
fn replaces_database_file_and_live_connection() {
    let current_path = std::env::temp_dir().join(format!(
        "flowlet-replace-current-{}.sqlite",
        uuid::Uuid::new_v4()
    ));
    let incoming_path = std::env::temp_dir().join(format!(
        "flowlet-replace-incoming-{}.sqlite",
        uuid::Uuid::new_v4()
    ));
    let current = Storage::open(&current_path).expect("open current database");
    current
        .set_app_meta("replace-marker", "old")
        .expect("write current marker");
    let incoming = Storage::open(&incoming_path).expect("open incoming database");
    incoming
        .set_app_meta("replace-marker", "new")
        .expect("write incoming marker");
    incoming
        .connection
        .lock()
        .unwrap()
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        .unwrap();
    drop(incoming);

    current
        .replace_database_from(&incoming_path)
        .expect("replace database");
    assert_eq!(
        current.get_app_meta("replace-marker").unwrap().as_deref(),
        Some("new")
    );
    drop(current);

    let reopened = Storage::open(&current_path).expect("reopen replaced database");
    assert_eq!(
        reopened.get_app_meta("replace-marker").unwrap().as_deref(),
        Some("new")
    );
    drop(reopened);
    for path in [&current_path, &incoming_path] {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{}", path.display(), suffix));
        }
    }
}

#[test]
fn invalid_replacement_preserves_current_database() {
    let current_path = std::env::temp_dir().join(format!(
        "flowlet-replace-preserve-{}.sqlite",
        uuid::Uuid::new_v4()
    ));
    let invalid_path = std::env::temp_dir().join(format!(
        "flowlet-replace-invalid-{}.sqlite",
        uuid::Uuid::new_v4()
    ));
    let current = Storage::open(&current_path).expect("open current database");
    current
        .set_app_meta("replace-marker", "old")
        .expect("write current marker");
    std::fs::write(&invalid_path, b"not a sqlite database").unwrap();

    assert!(current.replace_database_from(&invalid_path).is_err());
    assert_eq!(
        current.get_app_meta("replace-marker").unwrap().as_deref(),
        Some("old")
    );
    drop(current);
    for path in [&current_path, &invalid_path] {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{}", path.display(), suffix));
        }
    }
}
#[test]
fn fills_preset_platform_urls_after_migration_without_relocking() {
    let path = std::env::temp_dir().join(format!(
        "flowlet-platform-url-migration-{}.sqlite",
        uuid::Uuid::new_v4()
    ));
    let storage = Storage::open(&path).expect("open storage without migration deadlock");
    let json: serde_json::Value =
        serde_json::from_str(DEFAULT_CONFIG_JSON).expect("parse embedded config");
    let config = ChannelsConfig::from_config_json(&json).expect("load channel defaults");
    let mut stored_preset = config.presets[0].clone();
    stored_preset.platform_url = None;

    storage
        .save_channel_presets(&[stored_preset])
        .expect("save preset without platform URL");
    storage
        .ensure_preset_platform_urls(&config.presets)
        .expect("fill platform URL from config");

    let presets = storage.list_channel_presets().expect("read presets");
    assert_eq!(presets[0].platform_url, config.presets[0].platform_url,);

    drop(storage);
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{}", path.display(), suffix));
    }
}

#[test]
fn syncs_protocol_config_for_existing_channel_presets() {
    let path = std::env::temp_dir().join(format!(
        "flowlet-protocol-config-migration-{}.sqlite",
        uuid::Uuid::new_v4()
    ));
    let storage = Storage::open(&path).expect("open storage");
    let json: serde_json::Value =
        serde_json::from_str(DEFAULT_CONFIG_JSON).expect("parse embedded config");
    let config = ChannelsConfig::from_config_json(&json).expect("load channel defaults");
    let kimi = config
        .presets
        .iter()
        .find(|preset| preset.id == "kimi")
        .expect("embedded Kimi preset");
    let mut stored_kimi = kimi.clone();
    stored_kimi.supported_protocols = vec![ProtocolType::OpenAi];
    stored_kimi.anthropic_base_url.clear();

    storage
        .save_channel_presets(&[stored_kimi])
        .expect("save legacy Kimi preset");
    storage
        .sync_preset_protocol_config(&config.presets)
        .expect("sync protocol config");

    let migrated = storage
        .list_channel_presets()
        .expect("read presets")
        .into_iter()
        .find(|preset| preset.id == "kimi")
        .expect("migrated Kimi preset");
    assert_eq!(
        migrated.supported_protocols,
        vec![ProtocolType::OpenAi, ProtocolType::Anthropic]
    );
    assert_eq!(
        migrated.anthropic_base_url,
        "https://api.moonshot.cn/anthropic"
    );
    assert_eq!(migrated.openai_auth, kimi.openai_auth);
    assert_eq!(migrated.anthropic_auth, kimi.anthropic_auth);

    drop(storage);
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{}", path.display(), suffix));
    }
}

#[test]
fn adds_new_channel_preset_columns_to_legacy_schema() {
    let connection = Connection::open_in_memory().expect("open in-memory sqlite");
    connection
        .execute_batch(
            r#"
            CREATE TABLE channel_presets (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                vendor TEXT NOT NULL,
                supported_protocols TEXT NOT NULL,
                openai_base_url TEXT NOT NULL,
                anthropic_base_url TEXT NOT NULL,
                default_model TEXT NOT NULL,
                supports_model_list INTEGER NOT NULL DEFAULT 0,
                supports_model_detail INTEGER NOT NULL DEFAULT 0,
                supports_price_sync INTEGER NOT NULL DEFAULT 0,
                supports_balance_query INTEGER NOT NULL DEFAULT 0,
                supports_quota_query INTEGER NOT NULL DEFAULT 0,
                supports_usage_query INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            "#,
        )
        .expect("create legacy channel preset table");
    let storage = Storage::from_connection_for_test(connection);

    storage.migrate().expect("migrate channel preset schema");

    assert!(super::table_has_column(
        &storage.connection.lock().unwrap(),
        "channel_presets",
        "small_model",
    )
    .unwrap());
    assert!(super::table_has_column(
        &storage.connection.lock().unwrap(),
        "channel_presets",
        "timeout_seconds",
    )
    .unwrap());
}

#[test]
fn appends_qwen_preset_to_existing_database_without_touching_legacy_presets() {
    let path = std::env::temp_dir().join(format!(
        "flowlet-qwen-preset-migration-{}.sqlite",
        uuid::Uuid::new_v4()
    ));
    let storage = Storage::open(&path).expect("open storage");
    let json: serde_json::Value =
        serde_json::from_str(DEFAULT_CONFIG_JSON).expect("parse embedded config");
    let config = ChannelsConfig::from_config_json(&json).expect("load channel defaults");

    // 模拟旧版本数据库：只有 longcat / deepseek / kimi 三个预设
    let legacy_presets: Vec<_> = config
        .presets
        .iter()
        .filter(|preset| preset.id != "qwen")
        .cloned()
        .collect();
    assert!(!legacy_presets.is_empty());
    storage
        .save_channel_presets(&legacy_presets)
        .expect("save legacy presets");

    storage
        .ensure_missing_presets(&config.presets)
        .expect("append missing qwen preset");
    // 迁移幂等：再次执行结果一致
    storage
        .ensure_missing_presets(&config.presets)
        .expect("ensure_missing_presets is idempotent");

    let presets = storage.list_channel_presets().expect("read presets");
    assert_eq!(presets.len(), legacy_presets.len() + 1);
    let qwen = presets
        .iter()
        .find(|preset| preset.id == "qwen")
        .expect("qwen preset appended");
    assert_eq!(
        qwen.openai_base_url,
        "https://dashscope.aliyuncs.com/compatible-mode/v1"
    );
    assert_eq!(
        qwen.anthropic_base_url,
        "https://dashscope.aliyuncs.com/apps/anthropic"
    );
    assert!(qwen.supports_model_list);
    assert!(!qwen.supports_balance_query);
    // 已有预设不被修改
    let longcat = presets
        .iter()
        .find(|preset| preset.id == "longcat")
        .expect("longcat preset kept");
    assert_eq!(longcat.openai_base_url, "https://api.longcat.chat/openai");

    drop(storage);
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{}", path.display(), suffix));
    }
}

fn body_request_log(request_id: &str) -> RequestLogInput {
    RequestLogInput {
        request_id: request_id.to_string(),
        req_body_b64: Some("aGVsbG8=".to_string()),
        res_body_b64: Some("d29ybGQ=".to_string()),
        is_last_attempt: true,
        attempt_seq: 1,
        agent_type: None,
        agent_session_id: None,
        parent_agent_session_id: None,
        client_id: Some("opencode".to_string()),
        client_name: Some("OpenCode".to_string()),
        channel_id: Some("longcat".to_string()),
        channel_name: Some("LongCat".to_string()),
        account_id: Some("account-1".to_string()),
        account_name: Some("Account".to_string()),
        client_protocol: "openai".to_string(),
        upstream_protocol: "openai".to_string(),
        virtual_model: Some("flowlet-pro".to_string()),
        public_model: Some("flowlet-pro".to_string()),
        upstream_model: Some("LongCat-2.0".to_string()),
        request_type: "chat".to_string(),
        method: "POST".to_string(),
        path: "/v1/chat/completions".to_string(),
        upstream_url: None,
        status: Some(200),
        latency_ms: Some(20),
        is_stream: false,
        error_message: None,
        fallback_count: 0,
        route_reason: Some("direct".to_string()),
        ttfb_ms: Some(10),
        duration_ms: Some(20),
        req_headers_json: Some(r#"{"User-Agent":"opencode/local ai-sdk"}"# .to_string()),
        res_headers_json: None,
    }
}

#[test]
fn cleanup_expired_body_data_keeps_incomplete_usage_records() {
    let path = std::env::temp_dir().join(format!("flowlet_test_body_cleanup_{}.sqlite", uuid::Uuid::new_v4()));
    let storage = Storage::open(&path).expect("open storage");

    // 插入过期记录（先全部插入再统一修饰时间戳）
    storage
        .insert_request_log(&body_request_log("old-no-usage"))
        .expect("insert old no usage");
    storage
        .insert_request_log(&body_request_log("old-with-usage"))
        .expect("insert old with usage");

    // 把已插入的记录时间戳改为 10 天前
    storage.test_set_logs_created_at_days_ago(10).expect("set old timestamp");

    // 为 old-with-usage 插入完整 usage 统计
    storage
        .upsert_usage_record(&UsageRecordInput {
            request_id: "old-with-usage".to_string(),
            input_tokens: Some(100),
            output_tokens: Some(50),
            ..empty_usage_input("old-with-usage")
        })
        .expect("insert usage");

    // 插入一条近期请求（test_set_logs_created_at_days_ago 之后再插入，保持近期）
    storage
        .insert_request_log(&body_request_log("recent-with-usage"))
        .expect("insert recent");
    storage
        .upsert_usage_record(&UsageRecordInput {
            request_id: "recent-with-usage".to_string(),
            input_tokens: Some(200),
            output_tokens: Some(100),
            ..empty_usage_input("recent-with-usage")
        })
        .expect("insert recent usage");

    // 执行清理（保留 3 天）
    let cleared = storage.cleanup_expired_body_data(3).expect("cleanup");
    assert_eq!(cleared, 1, "应只清除 1 条有完整统计的过期记录");

    // 验证 old-no-usage 的 Body 仍保留
    let logs = storage.list_request_logs().expect("list logs");
    let old_no_usage_log = logs.iter().find(|l| l.request_id == "old-no-usage").unwrap();
    assert!(old_no_usage_log.req_body_b64.is_some(), "无统计的过期记录不应清除 Body");

    // 验证 old-with-usage 的 Body 已清除
    let old_with_usage_log = logs.iter().find(|l| l.request_id == "old-with-usage").unwrap();
    assert!(old_with_usage_log.req_body_b64.is_none(), "有完整统计的过期记录应清除 Body");
    assert!(old_with_usage_log.res_body_b64.is_none(), "有完整统计的过期记录应清除 Body");

    drop(storage);
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{}", path.display(), suffix));
    }
}

#[test]
fn cleanup_expired_body_data_never_retention() {
    let path = std::env::temp_dir().join(format!("flowlet_test_body_cleanup_never_{}.sqlite", uuid::Uuid::new_v4()));
    let storage = Storage::open(&path).expect("open storage");

    // 插入过期请求（有 Body + 完整统计）
    let old = RequestLogInput {
        request_id: "old-forever".to_string(),
        req_body_b64: Some("aGVsbG8=".to_string()),
        res_body_b64: Some("d29ybGQ=".to_string()),
        is_last_attempt: true,
        attempt_seq: 1,
        ..request_log_for_repair("old-forever", 1, true)
    };
    storage.insert_request_log(&old).expect("insert");
    storage.test_set_logs_created_at_days_ago(365).expect("set old timestamp");
    storage
        .upsert_usage_record(&UsageRecordInput {
            request_id: "old-forever".to_string(),
            input_tokens: Some(100),
            output_tokens: Some(50),
            ..empty_usage_input("old-forever")
        })
        .expect("insert usage");

    // retention_days = -1（永久保留）
    let cleared = storage.cleanup_expired_body_data(-1).expect("cleanup");
    assert_eq!(cleared, 0, "永久保留不应清除任何 Body");

    drop(storage);
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{}", path.display(), suffix));
    }
}

fn empty_usage_input(request_id: &str) -> UsageRecordInput {
    UsageRecordInput {
        request_id: request_id.to_string(),
        client_id: None,
        client_name: None,
        channel_id: None,
        channel_name: None,
        account_id: None,
        account_name: None,
        client_protocol: "openai".to_string(),
        upstream_protocol: "openai".to_string(),
        virtual_model: None,
        upstream_model: None,
        input_tokens: None,
        input_cached_tokens: None,
        input_uncached_tokens: None,
        input_cache_write_tokens: None,
        output_tokens: None,
        total_tokens: None,
    }
}

#[test]
fn get_total_body_size_bytes_counts_only_non_null() {
    let path = std::env::temp_dir().join(format!("flowlet_test_body_size_{}.sqlite", uuid::Uuid::new_v4()));
    let storage = Storage::open(&path).expect("open storage");

    // 无记录时返回 0
    let size = storage.get_total_body_size_bytes().expect("get size");
    assert_eq!(size, 0);

    // 插入一条有 Body 的记录（base64 "aGVsbG8=" = 8 chars）
    storage
        .insert_request_log(&body_request_log("with-body"))
        .expect("insert");
    let size = storage.get_total_body_size_bytes().expect("get size");
    assert!(size > 0, "body size should be > 0");

    // 插入一条无 Body 的记录
    let mut no_body = body_request_log("no-body");
    no_body.req_body_b64 = None;
    no_body.res_body_b64 = None;
    storage.insert_request_log(&no_body).expect("insert no body");

    let size2 = storage.get_total_body_size_bytes().expect("get size");
    assert_eq!(size, size2, "null body should not affect total size");

    drop(storage);
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{}", path.display(), suffix));
    }
}

#[test]
fn prune_oldest_body_data_removes_oldest_first() {
    let path = std::env::temp_dir().join(format!("flowlet_test_body_prune_{}.sqlite", uuid::Uuid::new_v4()));
    let storage = Storage::open(&path).expect("open storage");

    // 插入 5 条记录，每条都有 Body 和完整的 usage 统计
    for i in 0..5 {
        storage
            .insert_request_log(&body_request_log(&format!("req-{i}")))
            .expect("insert");
        storage
            .upsert_usage_record(&UsageRecordInput {
                request_id: format!("req-{i}"),
                input_tokens: Some(100),
                output_tokens: Some(50),
                ..empty_usage_input(&format!("req-{i}"))
            })
            .expect("insert usage");
    }

    // 将 req-0 和 req-1 的时间戳改为最老（12 天前和 11 天前，确保排序确定）
    storage.test_set_log_created_at_days_ago("req-0", 12).expect("set req-0");
    storage.test_set_log_created_at_days_ago("req-1", 11).expect("set req-1");

    // 再插入 5 条近期记录（(datetime('now')) 自动赋予）
    for i in 5..10 {
        storage
            .insert_request_log(&body_request_log(&format!("req-{i}")))
            .expect("insert");
        storage
            .upsert_usage_record(&UsageRecordInput {
                request_id: format!("req-{i}"),
                input_tokens: Some(100),
                output_tokens: Some(50),
                ..empty_usage_input(&format!("req-{i}"))
            })
            .expect("insert usage");
    }

    // 此时 10 条记录都有 Body，最老的是 req-0, req-1
    // 按 prune_ratio=0.2 清理（10 * 0.2 = 2 条）
    let pruned = storage
        .prune_oldest_body_data(0, 0.2)
        .expect("prune");
    assert_eq!(pruned, 2, "应清理最老的 2 条记录");

    // 验证最老的记录被清理
    let logs = storage.list_request_logs().expect("list");
    let req0 = logs.iter().find(|l| l.request_id == "req-0").unwrap();
    assert!(req0.req_body_b64.is_none(), "req-0 应被清理");
    let req1 = logs.iter().find(|l| l.request_id == "req-1").unwrap();
    assert!(req1.req_body_b64.is_none(), "req-1 应被清理");

    // 验证近期记录未被清理
    let req9 = logs.iter().find(|l| l.request_id == "req-9").unwrap();
    assert!(req9.req_body_b64.is_some(), "req-9 不应被清理");

    drop(storage);
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{}", path.display(), suffix));
    }
}
