use super::Storage;
use crate::core::channels_config::{ChannelsConfig, DEFAULT_CONFIG_JSON};
use crate::core::config::{LogsFilter, ProtocolType, RequestLogInput, RouteCandidate};
use base64::Engine;
use rusqlite::Connection;
use std::sync::{Arc, Mutex};

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

    storage
        .insert_request_log(&RequestLogInput {
            request_id: "longcat-stream-usage".to_string(),
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
            res_body_b64: Some(base64::engine::general_purpose::STANDARD.encode(body)),
            is_last_attempt: true,
        })
        .expect("insert captured stream log");

    assert_eq!(storage.reanalyze_captured_usage().unwrap(), 1);
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
    assert_eq!(page.rows[0].output_tokens, Some(20));
    assert_eq!(page.rows[0].total_tokens, Some(120));
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
