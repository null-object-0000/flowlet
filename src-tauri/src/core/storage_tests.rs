use super::Storage;
use crate::core::config::{ModelPrice, ProtocolType, RouteCandidate};
use rusqlite::Connection;
use std::sync::{Arc, Mutex};

#[test]
fn migrates_legacy_route_and_price_tables() {
    let connection = Connection::open_in_memory().expect("open in-memory sqlite");
    connection
        .execute_batch(
            r#"
            CREATE TABLE virtual_model_routes (
                id TEXT PRIMARY KEY,
                provider_name TEXT NOT NULL
            );
            CREATE TABLE model_prices (
                id TEXT PRIMARY KEY,
                provider_id TEXT NOT NULL
            );
            "#,
        )
        .expect("create legacy tables");
    let storage = Storage {
        connection: Arc::new(Mutex::new(connection)),
    };

    storage.migrate().expect("migrate legacy schema");

    assert!(storage.list_route_candidates().is_ok());
    assert!(storage.list_model_prices().is_ok());

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
    storage
        .save_model_prices(&[ModelPrice {
            id: "price-test".to_string(),
            channel_id: "longcat".to_string(),
            upstream_model: "LongCat-2.0".to_string(),
            input_uncached_price: 0.0,
            input_cached_price: 0.0,
            output_price: 0.0,
            currency: "CNY".to_string(),
            unit: "1M tokens".to_string(),
            source: crate::core::config::PriceSource::Preset,
            synced_at: None,
            created_at: now.clone(),
            updated_at: now,
        }])
        .expect("save model prices after migration");
}
