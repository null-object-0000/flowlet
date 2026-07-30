use super::Storage;
use crate::core::channels_config::{ChannelsConfig, DEFAULT_CONFIG_JSON};
use crate::core::config::{
    ChannelAccount, LogsFilter, ProtocolType, RequestLogInput, RouteCandidate, UsageRecordInput,
};
use crate::core::device_identity::{
    DailyUsageTotal, HourlyUsageTotal, SyncedAgentInstallation, SyncedAgentInteraction,
    SyncedAgentInteractionEvent, SyncedAgentProfile, SyncedAgentSession,
};

#[test]
fn channel_account_resource_sync_mode_round_trips() {
    let connection = Connection::open_in_memory().expect("open in-memory sqlite");
    let storage = Storage::from_connection_for_test(connection);
    storage.migrate().expect("migrate account schema");
    let account = ChannelAccount {
        id: "account-auto-sync".to_string(),
        channel_id: "longcat".to_string(),
        name: "LongCat".to_string(),
        api_key: "sk-test".to_string(),
        resource_mode: Some("token_pack".to_string()),
        resource_sync_mode: "auto".to_string(),
        ..Default::default()
    };

    storage
        .save_channel_accounts(&[account])
        .expect("save account");
    let accounts = storage.list_channel_accounts().expect("list accounts");

    assert_eq!(accounts.len(), 1);
    assert_eq!(accounts[0].resource_sync_mode, "auto");
}

#[test]
fn migration_forces_qwen_token_plan_resource_sync_to_auto() {
    let connection = Connection::open_in_memory().expect("open in-memory sqlite");
    connection
        .execute_batch(
            r#"
            CREATE TABLE channel_accounts (
                id TEXT PRIMARY KEY,
                channel_id TEXT NOT NULL,
                name TEXT NOT NULL,
                api_key TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                priority INTEGER NOT NULL DEFAULT 0,
                remark TEXT,
                resource_mode TEXT,
                resource_sync_mode TEXT NOT NULL DEFAULT 'manual',
                base_url_override TEXT,
                anthropic_base_url_override TEXT,
                last_used_at TEXT,
                last_error TEXT,
                credential_status TEXT NOT NULL DEFAULT 'healthy',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            INSERT INTO channel_accounts (
                id, channel_id, name, api_key, resource_mode, resource_sync_mode, created_at, updated_at
            ) VALUES (
                'account-qwen-plan', 'qwen', 'Qwen Token Plan', 'sk-sp-test',
                'token_plan', 'manual', '2026-07-27T00:00:00Z', '2026-07-27T00:00:00Z'
            );
            "#,
        )
        .expect("seed legacy qwen account");
    let storage = Storage::from_connection_for_test(connection);

    storage.migrate().expect("migrate account schema");

    let accounts = storage.list_channel_accounts().expect("list accounts");
    assert_eq!(accounts[0].resource_sync_mode, "auto");
}

#[test]
fn channel_account_model_selection_round_trips() {
    let connection = Connection::open_in_memory().expect("open in-memory sqlite");
    let storage = Storage::from_connection_for_test(connection);
    storage.migrate().expect("migrate account schema");

    // 初始未拉取、未勾选。
    let account = ChannelAccount {
        id: "account-synced".to_string(),
        channel_id: "deepseek".to_string(),
        name: "DeepSeek".to_string(),
        api_key: "sk-test".to_string(),
        ..Default::default()
    };
    storage
        .save_channel_accounts(&[account])
        .expect("save account");
    let accounts = storage.list_channel_accounts().expect("list accounts");
    assert_eq!(accounts[0].synced_models, None);
    assert_eq!(accounts[0].models_synced_at, None);
    assert_eq!(accounts[0].exposed_models, None);

    // 保存携带候选池（synced_models）与用户勾选（exposed_models）的账号。
    let configured = ChannelAccount {
        id: "account-synced".to_string(),
        channel_id: "deepseek".to_string(),
        name: "DeepSeek".to_string(),
        api_key: "sk-test".to_string(),
        synced_models: Some(vec![
            "deepseek-v4-flash".to_string(),
            "deepseek-v4-pro".to_string(),
            "deepseek-chat".to_string(),
        ]),
        models_synced_at: Some("2026-07-27T10:00:00Z".to_string()),
        exposed_models: Some(vec!["deepseek-v4-flash".to_string()]),
        ..Default::default()
    };
    storage
        .save_channel_accounts(&[configured])
        .expect("save configured account");

    let accounts = storage.list_channel_accounts().expect("list accounts");
    assert_eq!(
        accounts[0].synced_models,
        Some(vec![
            "deepseek-v4-flash".to_string(),
            "deepseek-v4-pro".to_string(),
            "deepseek-chat".to_string()
        ])
    );
    assert_eq!(
        accounts[0].models_synced_at,
        Some("2026-07-27T10:00:00Z".to_string())
    );
    assert_eq!(
        accounts[0].exposed_models,
        Some(vec!["deepseek-v4-flash".to_string()])
    );

    // 空勾选列表（用户主动全部取消）也能往返，区别于 None（未配置）。
    let cleared = ChannelAccount {
        id: "account-synced".to_string(),
        channel_id: "deepseek".to_string(),
        name: "DeepSeek".to_string(),
        api_key: "sk-test".to_string(),
        exposed_models: Some(vec![]),
        ..Default::default()
    };
    storage
        .save_channel_accounts(&[cleared])
        .expect("save cleared account");
    let accounts = storage.list_channel_accounts().expect("list accounts");
    assert_eq!(accounts[0].exposed_models, Some(vec![]));
}
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

    let result = storage.repair_agent_sessions("all", &[]).unwrap();
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
    let recent_result = storage.repair_agent_sessions("7d", &[]).unwrap();
    assert_eq!(recent_result.scanned_requests, 0);

    let result = storage.repair_agent_sessions("all", &[]).unwrap();
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
fn repairs_client_identification_when_client_id_is_null() {
    use crate::core::config::UaClientRule;
    let connection = Connection::open_in_memory().expect("open in-memory sqlite");
    let storage = Storage::from_connection_for_test(connection);
    storage.migrate().expect("migrate request log schema");

    // 插入一条 client_id 为 NULL 的历史日志，但 headers 包含 opencode UA
    let mut log = request_log_for_repair("req-client-repair", 0, true);
    log.client_id = None;
    log.client_name = None;
    log.req_headers_json =
        Some(r#"{"user-agent":"opencode/1.2.3","x-session-id":"ses-123"}"#.to_string());
    storage.insert_request_log(&log).unwrap();

    let ua_rules = vec![UaClientRule {
        id: "opencode".to_string(),
        pattern: "opencode/".to_string(),
        name: "OpenCode".to_string(),
        enabled: true,
    }];

    let result = storage.repair_agent_sessions("all", &ua_rules).unwrap();
    assert_eq!(result.scanned_requests, 1);
    assert_eq!(result.repaired_requests, 1);
    assert_eq!(result.repaired_clients, 1);

    let connection = storage.connection.lock().unwrap();
    let client: (String, String) = connection
        .query_row(
            "SELECT client_id, client_name FROM request_logs WHERE request_id = 'req-client-repair'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(client.0, "opencode");
    assert_eq!(client.1, "OpenCode");
}

#[test]
fn does_not_overwrite_existing_client_identification() {
    use crate::core::config::UaClientRule;
    let connection = Connection::open_in_memory().expect("open in-memory sqlite");
    let storage = Storage::from_connection_for_test(connection);
    storage.migrate().expect("migrate request log schema");

    // 插入一条已有 client_id 的日志
    let mut log = request_log_for_repair("req-client-existing", 0, true);
    log.client_id = Some("claude-code".to_string());
    log.client_name = Some("Claude Code".to_string());
    log.req_headers_json =
        Some(r#"{"user-agent":"opencode/1.2.3","x-session-id":"ses-123"}"#.to_string());
    storage.insert_request_log(&log).unwrap();

    let ua_rules = vec![UaClientRule {
        id: "opencode".to_string(),
        pattern: "opencode/".to_string(),
        name: "OpenCode".to_string(),
        enabled: true,
    }];

    let result = storage.repair_agent_sessions("all", &ua_rules).unwrap();
    // 会话归因修复了，但客户端归属未修复（已有值）
    assert_eq!(result.repaired_requests, 1);
    assert_eq!(result.repaired_clients, 0);

    let connection = storage.connection.lock().unwrap();
    let client: (String, String) = connection
        .query_row(
            "SELECT client_id, client_name FROM request_logs WHERE request_id = 'req-client-existing'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    // 保持原有值，未被覆盖
    assert_eq!(client.0, "claude-code");
    assert_eq!(client.1, "Claude Code");
}

#[test]
fn identifies_client_with_case_insensitive_headers() {
    use crate::core::config::UaClientRule;
    let connection = Connection::open_in_memory().expect("open in-memory sqlite");
    let storage = Storage::from_connection_for_test(connection);
    storage.migrate().expect("migrate request log schema");

    // headers 键名大小写不固定，应该都能识别
    let mut log = request_log_for_repair("req-client-case", 0, true);
    log.client_id = None;
    log.client_name = None;
    log.req_headers_json = Some(r#"{"User-Agent":"opencode/1.2.3"}"#.to_string());
    storage.insert_request_log(&log).unwrap();

    let ua_rules = vec![UaClientRule {
        id: "opencode".to_string(),
        pattern: "opencode/".to_string(),
        name: "OpenCode".to_string(),
        enabled: true,
    }];

    let result = storage.repair_agent_sessions("all", &ua_rules).unwrap();
    assert_eq!(result.repaired_clients, 1);

    let connection = storage.connection.lock().unwrap();
    let client: (String, String) = connection
        .query_row(
            "SELECT client_id, client_name FROM request_logs WHERE request_id = 'req-client-case'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(client.0, "opencode");
    assert_eq!(client.1, "OpenCode");
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
fn syncs_maintained_config_for_existing_channel_presets() {
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
    stored_kimi.name = "旧 Kimi 名称".to_string();
    stored_kimi.supported_protocols = vec![ProtocolType::OpenAi];
    stored_kimi.anthropic_base_url.clear();

    storage
        .save_channel_presets(&[stored_kimi])
        .expect("save legacy Kimi preset");
    storage
        .sync_preset_maintained_config(&config.presets)
        .expect("sync maintained preset config");

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
    assert_eq!(migrated.name, "Kimi");
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
        req_headers_json: Some(r#"{"User-Agent":"opencode/local ai-sdk"}"#.to_string()),
        res_headers_json: None,
    }
}

#[test]
fn cleanup_expired_body_data_keeps_incomplete_usage_records() {
    let path = std::env::temp_dir().join(format!(
        "flowlet_test_body_cleanup_{}.sqlite",
        uuid::Uuid::new_v4()
    ));
    let storage = Storage::open(&path).expect("open storage");

    // 插入过期记录（先全部插入再统一修饰时间戳）
    storage
        .insert_request_log(&body_request_log("old-no-usage"))
        .expect("insert old no usage");
    storage
        .insert_request_log(&body_request_log("old-with-usage"))
        .expect("insert old with usage");

    // 把已插入的记录时间戳改为 10 天前
    storage
        .test_set_logs_created_at_days_ago(10)
        .expect("set old timestamp");

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
    let old_no_usage_log = logs
        .iter()
        .find(|l| l.request_id == "old-no-usage")
        .unwrap();
    assert!(
        old_no_usage_log.req_body_b64.is_some(),
        "无统计的过期记录不应清除 Body"
    );

    // 验证 old-with-usage 的 Body 已清除
    let old_with_usage_log = logs
        .iter()
        .find(|l| l.request_id == "old-with-usage")
        .unwrap();
    assert!(
        old_with_usage_log.req_body_b64.is_none(),
        "有完整统计的过期记录应清除 Body"
    );
    assert!(
        old_with_usage_log.res_body_b64.is_none(),
        "有完整统计的过期记录应清除 Body"
    );
    assert!(old_with_usage_log.req_body_cleared_at.is_some());
    assert_eq!(
        old_with_usage_log.req_body_cleanup_reason.as_deref(),
        Some("retention")
    );
    assert!(old_with_usage_log.res_body_cleared_at.is_some());
    assert_eq!(
        old_with_usage_log.res_body_cleanup_reason.as_deref(),
        Some("retention")
    );

    drop(storage);
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{}", path.display(), suffix));
    }
}

#[test]
fn cleanup_expired_body_data_never_retention() {
    let path = std::env::temp_dir().join(format!(
        "flowlet_test_body_cleanup_never_{}.sqlite",
        uuid::Uuid::new_v4()
    ));
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
    storage
        .test_set_logs_created_at_days_ago(365)
        .expect("set old timestamp");
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
    let path = std::env::temp_dir().join(format!(
        "flowlet_test_body_size_{}.sqlite",
        uuid::Uuid::new_v4()
    ));
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
    storage
        .insert_request_log(&no_body)
        .expect("insert no body");

    let size2 = storage.get_total_body_size_bytes().expect("get size");
    assert_eq!(size, size2, "null body should not affect total size");

    drop(storage);
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{}", path.display(), suffix));
    }
}

#[test]
fn request_bodies_live_in_capture_files_and_stream_updates_replace_the_reference() {
    let path = std::env::temp_dir().join(format!(
        "flowlet_test_capture_file_{}.sqlite",
        uuid::Uuid::new_v4()
    ));
    let storage = Storage::open(&path).expect("open storage");
    let capture_root = storage.capture_store.root_path().to_path_buf();
    let mut log = body_request_log("stream-capture");
    log.is_stream = true;
    log.duration_ms = None;
    log.res_body_b64 = None;
    let request_log_id = storage.insert_request_log(&log).expect("insert log");

    {
        let connection = storage.connection.lock().unwrap();
        let sqlite_bodies: (Option<String>, Option<String>) = connection
            .query_row(
                "SELECT req_body_b64, res_body_b64 FROM request_logs WHERE id = ?1",
                [&request_log_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(sqlite_bodies, (None, None));
        let state: String = connection
            .query_row(
                "SELECT state FROM request_capture_refs WHERE request_log_id = ?1",
                [&request_log_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(state, "ready");
    }

    storage
        .update_request_log_timing(
            "stream-capture",
            10,
            Some(20),
            30,
            Some(r#"{"content-type":"text/event-stream"}"#.to_string()),
            Some("c3RyZWFtLWRvbmU=".to_string()),
            None,
            None,
        )
        .expect("update stream capture");

    let rows = storage
        .list_request_logs_by_request_id("stream-capture")
        .expect("read detail");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].req_body_b64.as_deref(), Some("aGVsbG8="));
    assert_eq!(rows[0].res_body_b64.as_deref(), Some("c3RyZWFtLWRvbmU="));
    assert_eq!(rows[0].capture_state.as_deref(), Some("ready"));

    drop(storage);
    let _ = std::fs::remove_dir_all(capture_root);
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{}", path.display(), suffix));
    }
}

#[test]
fn migrates_legacy_sqlite_bodies_only_after_creating_a_ready_file_reference() {
    let path = std::env::temp_dir().join(format!(
        "flowlet_test_capture_migration_{}.sqlite",
        uuid::Uuid::new_v4()
    ));
    let storage = Storage::open(&path).expect("open storage");
    let capture_root = storage.capture_store.root_path().to_path_buf();
    let request_log_id = storage
        .insert_request_log(&body_request_log("legacy-capture"))
        .expect("insert seed");
    {
        let connection = storage.connection.lock().unwrap();
        connection
            .execute(
                "DELETE FROM request_capture_refs WHERE request_log_id = ?1",
                [&request_log_id],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE request_logs SET req_body_b64 = 'aGVsbG8=', res_body_b64 = 'd29ybGQ=' WHERE id = ?1",
                [&request_log_id],
            )
            .unwrap();
    }

    assert_eq!(storage.migrate_legacy_body_data(10).unwrap(), 1);
    {
        let connection = storage.connection.lock().unwrap();
        let values: (Option<String>, Option<String>, String) = connection
            .query_row(
                r#"SELECT rl.req_body_b64, rl.res_body_b64, refs.state
                   FROM request_logs rl
                   JOIN request_capture_refs refs ON refs.request_log_id = rl.id
                   WHERE rl.id = ?1"#,
                [&request_log_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(values, (None, None, "ready".to_string()));
    }
    let rows = storage
        .list_request_logs_by_request_id("legacy-capture")
        .unwrap();
    assert_eq!(rows[0].req_body_b64.as_deref(), Some("aGVsbG8="));
    assert_eq!(rows[0].res_body_b64.as_deref(), Some("d29ybGQ="));

    drop(storage);
    let _ = std::fs::remove_dir_all(capture_root);
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{}", path.display(), suffix));
    }
}

#[test]
fn prune_oldest_body_data_removes_oldest_first() {
    let path = std::env::temp_dir().join(format!(
        "flowlet_test_body_prune_{}.sqlite",
        uuid::Uuid::new_v4()
    ));
    let storage = Storage::open(&path).expect("open storage");

    // 构造一条大约 100 KB 的请求体（base64 编码后约 136 KB）
    let big_body = "a".repeat(100 * 1024);
    let big_body_b64 = base64(big_body.as_bytes());

    // 插入 10 条记录，每条都有大 Body 和完整的 usage 统计
    for i in 0..10 {
        storage
            .insert_request_log(&RequestLogInput {
                req_body_b64: Some(big_body_b64.clone()),
                res_body_b64: Some(big_body_b64.clone()),
                ..body_request_log(&format!("req-{i}"))
            })
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
    storage
        .test_set_log_created_at_days_ago("req-0", 12)
        .expect("set req-0");
    storage
        .test_set_log_created_at_days_ago("req-1", 11)
        .expect("set req-1");

    // 当前 10 条约 200 KB/条（req + res），总计 ~2000 KB。
    // 只有两条超过一小时，空间清理必须保留其余近期记录，即使因此暂时超过软上限。
    let target_bytes = 1000 * 1024;
    let pruned = storage
        .prune_oldest_body_data_to_goal(target_bytes, 0.5, 50)
        .expect("prune");
    assert_eq!(pruned, 2, "应只清理超过安全窗口的两条记录");

    // 验证最老的记录被清理
    let logs = storage.list_request_logs().expect("list");
    let req0 = logs.iter().find(|l| l.request_id == "req-0").unwrap();
    assert!(req0.req_body_b64.is_none(), "req-0 应被清理");
    let req1 = logs.iter().find(|l| l.request_id == "req-1").unwrap();
    assert!(req1.req_body_b64.is_none(), "req-1 应被清理");
    assert_eq!(req0.req_body_cleanup_reason.as_deref(), Some("size_limit"));
    assert_eq!(req1.res_body_cleanup_reason.as_deref(), Some("size_limit"));

    // 验证近期记录仍保留；软上限不能以牺牲最新请求的可排查性为代价。
    let recent = logs.iter().find(|l| l.request_id == "req-9").unwrap();
    assert!(
        recent.req_body_b64.is_some(),
        "最近一小时的请求 Body 必须保留"
    );
    assert!(
        recent.res_body_b64.is_some(),
        "最近一小时的响应 Body 必须保留"
    );
    let remaining_bytes = storage.get_total_body_size_bytes().expect("size");
    assert!(
        remaining_bytes > target_bytes,
        "近期数据超过软上限时应暂时保留，当前 {} KB，上限 {} KB",
        remaining_bytes / 1024,
        target_bytes / 1024
    );

    drop(storage);
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{}", path.display(), suffix));
    }
}

fn base64(input: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(input)
}

#[test]
fn request_log_queries_resolve_current_account_name_and_fall_back_to_snapshot() {
    let connection = Connection::open_in_memory().expect("open in-memory sqlite");
    let storage = Storage::from_connection_for_test(connection);
    storage.migrate().expect("migrate schema");

    let mut account = ChannelAccount {
        id: "account-1".to_string(),
        channel_id: "longcat".to_string(),
        name: "主账号-旧名".to_string(),
        api_key: "sk-test".to_string(),
        ..Default::default()
    };
    storage
        .save_channel_accounts(&[account.clone()])
        .expect("save account");

    // 请求日志与用量记录保存请求时刻的账号名快照；查询时连表 channel_accounts
    // 解析当前名，账号被删除后回退到该快照。
    let mut log = request_log_for_repair("req-rename", 0, true);
    log.account_id = Some("account-1".to_string());
    log.account_name = Some("主账号-旧名".to_string());
    storage
        .insert_request_log(&log)
        .expect("insert request log");
    storage
        .upsert_usage_record(&UsageRecordInput {
            request_id: "req-rename".to_string(),
            client_id: Some("opencode".to_string()),
            client_name: Some("OpenCode".to_string()),
            channel_id: Some("longcat".to_string()),
            channel_name: Some("LongCat".to_string()),
            account_id: Some("account-1".to_string()),
            account_name: Some("主账号-旧名".to_string()),
            client_protocol: "openai".to_string(),
            upstream_protocol: "openai".to_string(),
            virtual_model: Some("flowlet-pro".to_string()),
            upstream_model: Some("LongCat-2.0".to_string()),
            input_tokens: Some(10),
            input_cached_tokens: None,
            input_uncached_tokens: Some(10),
            input_cache_write_tokens: None,
            output_tokens: Some(5),
            total_tokens: Some(15),
        })
        .expect("upsert usage record");

    let search_by = |storage: &Storage, keyword: &str| {
        storage
            .list_request_logs_page(LogsFilter {
                search: keyword.to_string(),
                ..model_filter("", "")
            })
            .expect("search request logs")
    };
    assert_eq!(search_by(&storage, "主账号-旧名").total, 1);
    assert_eq!(search_by(&storage, "主账号-新名").total, 0);

    // 改名只是一次普通的小保存（不批量改写历史日志）；查询连表解析出当前名，
    // 因此展示与按新名搜索立即生效。
    account.name = "主账号-新名".to_string();
    storage
        .save_channel_accounts(&[account])
        .expect("rename account");

    let page = search_by(&storage, "主账号-新名");
    assert_eq!(page.total, 1, "按新账号名搜索应命中历史记录");
    assert_eq!(page.rows[0].account_name.as_deref(), Some("主账号-新名"));
    assert_eq!(
        search_by(&storage, "主账号-旧名").total,
        0,
        "账号仍在时旧名不应命中"
    );

    let usage = storage.usage_summary("all").expect("usage summary");
    let usage_row = usage
        .iter()
        .find(|row| row.account_id.as_deref() == Some("account-1"))
        .expect("usage row for account-1");
    assert_eq!(usage_row.account_name.as_deref(), Some("主账号-新名"));

    // 删除账号后连表取不到当前名，回退到请求时刻保存的快照名（仍是旧名，
    // 因为改名并不会批量改写历史快照）。
    storage.save_channel_accounts(&[]).expect("delete account");
    let after_delete = search_by(&storage, "主账号-旧名");
    assert_eq!(after_delete.total, 1, "删除账号后应按快照名回退命中");
    assert_eq!(
        after_delete.rows[0].account_name.as_deref(),
        Some("主账号-旧名"),
        "删除账号后展示请求时刻的快照名"
    );
}

#[test]
fn usage_summary_filters_at_the_database_boundary() {
    let connection = Connection::open_in_memory().expect("open in-memory sqlite");
    let storage = Storage::from_connection_for_test(connection);
    storage.migrate().expect("migrate schema");

    for request_id in ["usage-current", "usage-old"] {
        storage
            .insert_request_log(&request_log_for_repair(request_id, 0, true))
            .expect("insert request log");
        storage
            .upsert_usage_record(&UsageRecordInput {
                request_id: request_id.to_string(),
                input_tokens: Some(10),
                output_tokens: Some(5),
                total_tokens: Some(15),
                ..empty_usage_input(request_id)
            })
            .expect("insert usage");
    }
    storage
        .connection
        .lock()
        .unwrap()
        .execute(
            "UPDATE request_logs SET created_at = '2020-01-01T00:00:00Z'
             WHERE request_id = 'usage-old'",
            [],
        )
        .expect("age one request");

    let current_month = storage.usage_summary("month").expect("month summary");
    assert_eq!(
        current_month
            .iter()
            .map(|row| row.request_count)
            .sum::<i64>(),
        1
    );
    let all_time = storage.usage_summary("all").expect("all-time summary");
    assert_eq!(all_time.iter().map(|row| row.request_count).sum::<i64>(), 2);
}

#[test]
fn usage_summary_today_filters_to_today_and_groups_by_hour() {
    let connection = Connection::open_in_memory().expect("open in-memory sqlite");
    let storage = Storage::from_connection_for_test(connection);
    storage.migrate().expect("migrate schema");

    for request_id in ["usage-today-a", "usage-today-b", "usage-yesterday"] {
        storage
            .insert_request_log(&request_log_for_repair(request_id, 0, true))
            .expect("insert request log");
        storage
            .upsert_usage_record(&UsageRecordInput {
                request_id: request_id.to_string(),
                input_tokens: Some(10),
                output_tokens: Some(5),
                total_tokens: Some(15),
                ..empty_usage_input(request_id)
            })
            .expect("insert usage");
    }
    storage
        .connection
        .lock()
        .unwrap()
        .execute(
            "UPDATE request_logs SET created_at = datetime('now', '-1 day')
             WHERE request_id = 'usage-yesterday'",
            [],
        )
        .expect("age one request to yesterday");

    let today = storage.usage_summary("today").expect("today summary");
    assert_eq!(
        today.iter().map(|row| row.request_count).sum::<i64>(),
        2,
        "today 周期应只统计今日请求"
    );
    let local_today = chrono::Local::now().format("%Y-%m-%d").to_string();
    assert!(
        today.iter().all(|row| {
            row.date.starts_with(&local_today)
                && row.date.len() == "YYYY-MM-DDTHH:00:00".len()
                && row.date.ends_with(":00:00")
        }),
        "today 周期应按小时分组返回 2026-07-28T09:00:00 形式的日期，实际：{:?}",
        today
            .iter()
            .map(|row| row.date.as_str())
            .collect::<Vec<_>>()
    );

    // week 周期同样按小时分组，供前端 7×24 分时热力图使用。周一跑该测试时
    // "昨天"落在上周，所以只断言今日数据完整包含且全部为小时粒度。
    let week = storage.usage_summary("week").expect("week summary");
    assert_eq!(
        week.iter()
            .filter(|row| row.date.starts_with(&local_today))
            .map(|row| row.request_count)
            .sum::<i64>(),
        2
    );
    assert!(
        week.iter().all(|row| {
            row.date.len() == "YYYY-MM-DDTHH:00:00".len() && row.date.ends_with(":00:00")
        }),
        "week 周期应按小时分组返回日期，实际：{:?}",
        week.iter().map(|row| row.date.as_str()).collect::<Vec<_>>()
    );
}

#[test]
fn usage_today_summary_aggregates_only_today_with_cache_denominator() {
    let connection = Connection::open_in_memory().expect("open in-memory sqlite");
    let storage = Storage::from_connection_for_test(connection);
    storage.migrate().expect("migrate schema");

    // 两条今日记录：一条带缓存（计入缓存命中率分母），一条不带缓存（不计入分母）。
    for (request_id, input, cached, uncached, output) in [
        ("today-cached", 100, Some(80), 20, 30),
        ("today-uncached", 50, None, 50, 10),
    ] {
        storage
            .insert_request_log(&request_log_for_repair(request_id, 0, true))
            .expect("insert request log");
        storage
            .upsert_usage_record(&UsageRecordInput {
                request_id: request_id.to_string(),
                input_tokens: Some(input),
                input_cached_tokens: cached,
                input_uncached_tokens: Some(uncached),
                output_tokens: Some(output),
                total_tokens: Some(input + output),
                ..empty_usage_input(request_id)
            })
            .expect("insert usage");
    }
    // 一条昨日记录，应被排除。
    storage
        .insert_request_log(&request_log_for_repair("yesterday-x", 0, true))
        .expect("insert request log");
    storage
        .upsert_usage_record(&UsageRecordInput {
            request_id: "yesterday-x".to_string(),
            input_tokens: Some(999),
            output_tokens: Some(1),
            total_tokens: Some(1000),
            ..empty_usage_input("yesterday-x")
        })
        .expect("insert usage");

    for (request_id, expr) in [
        ("today-cached", "datetime('now', 'localtime')"),
        ("today-uncached", "datetime('now', 'localtime')"),
        ("yesterday-x", "datetime('now', 'localtime', '-1 day')"),
    ] {
        storage
            .connection
            .lock()
            .unwrap()
            .execute(
                &format!("UPDATE usage_records SET created_at = {expr} WHERE request_id = '{request_id}'"),
                [],
            )
            .expect("set created_at");
    }

    let summary = storage.usage_today_summary().expect("today summary");
    assert_eq!(summary.total_tokens, 190, "只统计今日两条记录的 total");
    assert_eq!(summary.input_tokens, 150);
    assert_eq!(summary.input_cached_tokens, 80);
    assert_eq!(summary.input_uncached_tokens, 70);
    assert_eq!(summary.output_tokens, 40);
    assert_eq!(
        summary.cache_measured_input_tokens, 100,
        "只有带缓存字段的记录（input=100）计入缓存命中率分母"
    );
}

#[test]
fn daily_usage_totals_keep_days_separate_and_sum_token_breakdowns() {
    let connection = Connection::open_in_memory().expect("open in-memory sqlite");
    let storage = Storage::from_connection_for_test(connection);
    storage.migrate().expect("migrate schema");

    for (request_id, created_at, input, cached, output) in [
        ("daily-a", "2026-07-27T01:00:00Z", 10, Some(4), 5),
        ("daily-b", "2026-07-27T02:00:00Z", 20, Some(5), 7),
        ("daily-c", "2026-07-28T03:00:00Z", 30, None, 9),
    ] {
        storage
            .insert_request_log(&request_log_for_repair(request_id, 0, true))
            .expect("insert request log");
        storage
            .connection
            .lock()
            .unwrap()
            .execute(
                "UPDATE request_logs SET created_at = ?1 WHERE request_id = ?2",
                rusqlite::params![created_at, request_id],
            )
            .expect("set deterministic request date");
        storage
            .upsert_usage_record(&UsageRecordInput {
                request_id: request_id.to_string(),
                input_tokens: Some(input),
                input_cached_tokens: cached,
                input_uncached_tokens: cached.map(|value| input - value),
                output_tokens: Some(output),
                total_tokens: Some(input + output),
                ..empty_usage_input(request_id)
            })
            .expect("insert usage");
    }

    let totals = storage.daily_usage_totals().expect("daily usage totals");

    assert_eq!(totals.len(), 2);
    assert_eq!(totals[0].request_count, 2);
    assert_eq!(totals[0].known_tokens, 42);
    assert_eq!(totals[0].input_tokens, 30);
    assert_eq!(totals[0].input_cached_tokens, 9);
    assert_eq!(totals[0].input_uncached_tokens, 21);
    assert_eq!(totals[0].cache_measured_input_tokens, 30);
    assert_eq!(totals[0].output_tokens, 12);
    assert_eq!(totals[1].request_count, 1);
    assert_eq!(totals[1].known_tokens, 39);
    assert_eq!(totals[1].cache_measured_input_tokens, 0);

    let hours = storage.hourly_usage_totals().expect("hourly usage totals");
    assert_eq!(hours.len(), 3);
    assert_eq!(hours[0].known_tokens, 15);
    assert_eq!(hours[1].known_tokens, 27);
    assert_eq!(hours[2].known_tokens, 39);
}

#[test]
fn imported_device_usage_is_idempotent_and_keeps_newer_snapshot() {
    let connection = Connection::open_in_memory().expect("open in-memory sqlite");
    let storage = Storage::from_connection_for_test(connection);
    storage.migrate().expect("migrate schema");
    let first = DailyUsageTotal {
        date: "2026-07-28".to_string(),
        request_count: 2,
        known_tokens: 30,
        input_tokens: 20,
        input_cached_tokens: 5,
        input_uncached_tokens: 15,
        cache_measured_input_tokens: 20,
        output_tokens: 10,
        unknown_count: 0,
    };
    let first_hour = HourlyUsageTotal {
        hour: "2026-07-28T18:00:00".to_string(),
        request_count: 2,
        known_tokens: 30,
    };

    let inserted = storage
        .import_device_usage(
            2,
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "2026-07-01T00:00:00Z",
            "Office PC",
            "windows",
            "0.1.0",
            "2026-07-28T10:00:00Z",
            480,
            std::slice::from_ref(&first),
            std::slice::from_ref(&first_hour),
            &[],
            &[],
        )
        .expect("import first snapshot");
    assert_eq!(inserted.imported_days, 1);

    let repeated = storage
        .import_device_usage(
            2,
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "2026-07-01T00:00:00Z",
            "Office PC",
            "windows",
            "0.1.0",
            "2026-07-28T10:00:00Z",
            480,
            std::slice::from_ref(&first),
            std::slice::from_ref(&first_hour),
            &[],
            &[],
        )
        .expect("repeat same snapshot");
    assert_eq!(repeated.imported_days, 0);
    assert_eq!(repeated.unchanged_days, 1);

    let mut older = first.clone();
    older.known_tokens = 1;
    storage
        .import_device_usage(
            2,
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "2026-07-01T00:00:00Z",
            "Old office name",
            "windows",
            "0.1.0",
            "2026-07-28T09:00:00Z",
            480,
            &[older],
            &[],
            &[],
            &[],
        )
        .expect("ignore older snapshot");

    let rows = storage
        .imported_daily_usage(Some("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))
        .expect("read imported snapshot");
    assert_eq!(rows, vec![first]);
    let hourly_rows = storage
        .imported_hourly_usage(Some("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))
        .expect("read imported hourly snapshot");
    assert_eq!(hourly_rows, vec![first_hour]);
    let devices = storage
        .imported_known_devices()
        .expect("read imported device metadata");
    assert_eq!(devices[0].display_name, "Office PC");
    assert_eq!(devices[0].platform, "windows");
    assert_eq!(devices[0].app_version, "0.1.0");
}

#[test]
fn imported_device_sessions_replace_the_previous_device_snapshot() {
    let connection = Connection::open_in_memory().expect("open in-memory sqlite");
    let storage = Storage::from_connection_for_test(connection);
    storage.migrate().expect("migrate schema");
    let session = |id: &str, status: &str, activity_at: &str| SyncedAgentSession {
        agent_type: "codex-cli".to_string(),
        session_id: id.to_string(),
        parent_session_id: None,
        runtime_status: status.to_string(),
        title: Some(id.to_string()),
        client_name: Some("Codex CLI".to_string()),
        activity_at: activity_at.to_string(),
        flowlet_observed: true,
        request_count: 3,
        error_count: 0,
        known_tokens: 120,
        last_interaction: None,
    };
    let device_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    let interaction = |content: &str| SyncedAgentInteraction {
        events: vec![SyncedAgentInteractionEvent {
            id: format!("user-{content}"),
            kind: "user-message".to_string(),
            timestamp: Some("2026-07-29T10:00:00Z".to_string()),
            title: None,
            content: Some(content.to_string()),
            model: None,
            status: None,
        }],
    };
    let mut running = session("running", "running", "2026-07-29T09:00:00Z");
    running.last_interaction = Some(interaction("old interaction"));
    storage
        .import_device_usage(
            2,
            device_id,
            "2026-07-01T00:00:00Z",
            "Work PC",
            "windows",
            "0.1.0",
            "2026-07-29T10:00:00Z",
            480,
            &[],
            &[],
            &[running, session("old", "idle", "2026-07-29T08:00:00Z")],
            &[],
        )
        .expect("import sessions");
    let mut latest = session("new", "waiting_user", "2026-07-29T10:30:00Z");
    latest.last_interaction = Some(interaction("new interaction"));
    storage
        .import_device_usage(
            2,
            device_id,
            "2026-07-01T00:00:00Z",
            "Work PC",
            "windows",
            "0.1.0",
            "2026-07-29T11:00:00Z",
            480,
            &[],
            &[],
            &[latest],
            &[],
        )
        .expect("replace sessions");

    let rows = storage
        .imported_device_sessions(Some(device_id))
        .expect("read sessions");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].session.session_id, "new");
    assert_eq!(rows[0].device_display_name, "Work PC");
    assert_eq!(
        rows[0].session.last_interaction.as_ref().unwrap().events[0]
            .content
            .as_deref(),
        Some("new interaction")
    );
}

#[test]
fn imported_device_agents_replace_the_previous_device_snapshot() {
    let connection = Connection::open_in_memory().expect("open in-memory sqlite");
    let storage = Storage::from_connection_for_test(connection);
    storage.migrate().expect("migrate schema");
    let profile = |agent_id: &str, state: Option<&str>| SyncedAgentProfile {
        agent_id: agent_id.to_string(),
        agent_name: agent_id.to_string(),
        installed: true,
        installations: vec![SyncedAgentInstallation {
            surface: "cli".to_string(),
            install_method: "npm".to_string(),
            version: Some("1.0.0".to_string()),
        }],
        flowlet_config_state: state.map(str::to_string),
        flowlet_observed: state == Some("flowlet"),
    };
    let device_id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

    storage
        .import_device_usage(
            3,
            device_id,
            "2026-07-01T00:00:00Z",
            "Agent PC",
            "windows",
            "0.1.0",
            "2026-07-29T10:00:00Z",
            480,
            &[],
            &[],
            &[],
            &[profile("claude-code", Some("flowlet")), profile("pi", None)],
        )
        .expect("import agent profiles");
    storage
        .import_device_usage(
            3,
            device_id,
            "2026-07-01T00:00:00Z",
            "Agent PC",
            "windows",
            "0.1.0",
            "2026-07-29T11:00:00Z",
            480,
            &[],
            &[],
            &[],
            &[profile("opencode", Some("other_gateway"))],
        )
        .expect("replace agent profiles");

    let profiles = storage
        .imported_device_agents(device_id)
        .expect("read agent profiles");
    assert_eq!(profiles.len(), 1);
    assert_eq!(profiles[0].agent_id, "opencode");
    assert_eq!(
        profiles[0].flowlet_config_state.as_deref(),
        Some("other_gateway")
    );
}
