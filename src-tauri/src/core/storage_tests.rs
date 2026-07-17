use super::Storage;
use crate::core::channels_config::{ChannelsConfig, DEFAULT_CONFIG_JSON};
use crate::core::config::{LogsFilter, ProtocolType, RequestLogInput, RouteCandidate};
use base64::Engine;
use rusqlite::Connection;
use std::sync::{Arc, Mutex};

fn request_log_for_repair(request_id: &str, attempt_seq: i64, is_last_attempt: bool) -> RequestLogInput {
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
    let storage = Storage {
        connection: Arc::new(Mutex::new(connection)),
        prices: Arc::new(Mutex::new(Vec::new())),
    };
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
        })
        .expect("query request logs with qualified joined columns");

    assert_eq!(page.total, 0);
    assert!(page.rows.is_empty());
    assert_eq!(page.summary.request_count, 0);
}

#[test]
fn groups_opencode_request_logs_into_sessions() {
    let connection = Connection::open_in_memory().expect("open in-memory sqlite");
    let storage = Storage {
        connection: Arc::new(Mutex::new(connection)),
        prices: Arc::new(Mutex::new(Vec::new())),
    };
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
    storage.insert_request_log(&log).unwrap();
    log.request_id = "req-2".to_string();
    log.status = Some(500);
    log.error_message = Some("upstream error".to_string());
    storage.insert_request_log(&log).unwrap();

    let page = storage
        .list_agent_sessions(crate::core::config::AgentSessionsFilter {
            page: 1,
            page_size: 10,
            search: "ses_test".to_string(),
            client_id: "opencode".to_string(),
        })
        .unwrap();
    assert_eq!(page.total, 1);
    assert_eq!(page.page_size, 8);
    assert_eq!(page.rows[0].request_count, 2);
    assert_eq!(page.rows[0].success_count, 1);
    assert_eq!(page.rows[0].error_count, 1);
    assert_eq!(page.rows[0].parent_session_id.as_deref(), Some("ses_parent"));
    assert_eq!(page.rows[0].client_id.as_deref(), Some("opencode"));
    assert_eq!(page.rows[0].client_name.as_deref(), Some("OpenCode"));
    let clients = storage.list_agent_session_clients().unwrap();
    assert_eq!(clients.len(), 1);
    assert_eq!(clients[0].id, "opencode");
    let filtered_out = storage
        .list_agent_sessions(crate::core::config::AgentSessionsFilter {
            page: 1,
            page_size: 10,
            search: String::new(),
            client_id: "other-client".to_string(),
        })
        .unwrap();
    assert_eq!(filtered_out.total, 0);
}

#[test]
fn groups_claude_code_requests_by_official_session_header_attribution() {
    let connection = Connection::open_in_memory().expect("open in-memory sqlite");
    let storage = Storage {
        connection: Arc::new(Mutex::new(connection)),
        prices: Arc::new(Mutex::new(Vec::new())),
    };
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
            client_id: "claude-code".to_string(),
        })
        .unwrap();
    assert_eq!(page.total, 1);
    assert_eq!(page.rows[0].agent_type, "claude-code");
    assert_eq!(page.rows[0].session_id, "09af5e1a-bc08-4ae8-bb34-7ed47dca196d");
    assert_eq!(page.rows[0].client_name.as_deref(), Some("Claude Code"));
}

#[test]
fn repairs_historical_claude_code_session_header() {
    let connection = Connection::open_in_memory().expect("open in-memory sqlite");
    let storage = Storage {
        connection: Arc::new(Mutex::new(connection)),
        prices: Arc::new(Mutex::new(Vec::new())),
    };
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
    let storage = Storage {
        connection: Arc::new(Mutex::new(connection)),
        prices: Arc::new(Mutex::new(Vec::new())),
    };
    storage.migrate().expect("migrate request log schema");
    storage.insert_request_log(&request_log_for_repair("req-history", 0, false)).unwrap();
    storage.insert_request_log(&request_log_for_repair("req-history", 1, true)).unwrap();

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
    let storage = Storage {
        connection: Arc::new(Mutex::new(connection)),
        prices: Arc::new(Mutex::new(Vec::new())),
    };
    storage.migrate().expect("migrate request log schema");
    storage.insert_request_log(&request_log_for_repair("req-unknown", 0, false)).unwrap();
    storage.insert_request_log(&request_log_for_repair("req-unknown", 1, true)).unwrap();

    assert_eq!(storage.analyze_unknown_usage("all").unwrap(), 1);
    assert_eq!(storage.analyze_unknown_usage("all").unwrap(), 0);
    let connection = storage.connection.lock().unwrap();
    let usage_rows: i64 = connection
        .query_row("SELECT COUNT(*) FROM usage_records WHERE request_id = 'req-unknown'", [], |row| row.get(0))
        .unwrap();
    assert_eq!(usage_rows, 1);
}

#[test]
fn reanalyzes_longcat_stream_usage_from_captured_response() {
    let connection = Connection::open_in_memory().expect("open in-memory sqlite");
    let storage = Storage {
        connection: Arc::new(Mutex::new(connection)),
        prices: Arc::new(Mutex::new(Vec::new())),
    };
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
    let filtered_tokens: i64 = storage.connection.lock().unwrap()
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
    let storage = Storage {
        connection: Arc::new(Mutex::new(connection)),
        prices: Arc::new(Mutex::new(Vec::new())),
    };

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
    assert_eq!(
        presets[0].platform_url,
        config.presets[0].platform_url,
    );

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
    let storage = Storage {
        connection: Arc::new(Mutex::new(connection)),
        prices: Arc::new(Mutex::new(Vec::new())),
    };

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
