use super::Storage;
use crate::core::channels_config::{ChannelsConfig, DEFAULT_CONFIG_JSON};
use crate::core::config::{ProtocolType, RouteCandidate};
use rusqlite::Connection;
use std::sync::{Arc, Mutex};

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
