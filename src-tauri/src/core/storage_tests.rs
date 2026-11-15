use super::*;
use crate::core::device_identity::DeviceUsageBundle;

const BUNDLE: &[u8] = include_bytes!("../../../tests/fixtures/mobile/device-usage-v13.json");

fn import(storage: &Storage) {
    let bundle = DeviceUsageBundle::from_bytes(BUNDLE).unwrap();
    let s = bundle.snapshot;
    storage
        .import_device_usage(
            s.schema_version,
            &s.device_id,
            &s.device_created_at,
            &s.display_name,
            &s.platform,
            &s.app_version,
            &s.generated_at,
            s.timezone_offset_minutes,
            &s.days,
            &s.hours,
            &s.sessions,
            &s.agents,
        )
        .unwrap();
}

#[test]
fn mobile_snapshot_reapply_and_database_reopen_preserve_tokens_and_sync_settings() {
    let dir = std::env::temp_dir().join(format!("flowlet-mobile-storage-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    let path = dir.join("flowlet-mobile.sqlite");
    {
        let storage = Storage::open(&path).unwrap();
        storage
            .set_app_meta("device_sync_s3_config_v1", r#"{"bucket":"mobile-test"}"#)
            .unwrap();
        import(&storage);
        import(&storage);
        assert_eq!(
            storage.imported_daily_usage(None).unwrap()[0].known_tokens,
            42
        );
    }
    {
        let storage = Storage::open(&path).unwrap();
        assert_eq!(storage.imported_known_devices().unwrap().len(), 1);
        let days = storage.imported_daily_usage(None).unwrap();
        assert_eq!(days.len(), 1);
        assert_eq!(days[0].request_count, 2);
        assert_eq!(days[0].native_total_tokens, 4);
        assert_eq!(
            storage
                .get_app_meta("device_sync_s3_config_v1")
                .unwrap()
                .unwrap(),
            r#"{"bucket":"mobile-test"}"#
        );
    }
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn old_mobile_database_gains_missing_columns_without_losing_imported_usage() {
    let storage = Storage::from_connection_for_test(Connection::open_in_memory().unwrap());
    storage.migrate().unwrap();
    import(&storage);
    {
        let connection = storage.connection.lock().unwrap();
        connection
            .execute_batch(
                "ALTER TABLE known_devices DROP COLUMN app_version;
            ALTER TABLE device_daily_usage DROP COLUMN native_reasoning_tokens;",
            )
            .unwrap();
    }
    storage.migrate().unwrap();
    storage.migrate().unwrap();
    assert_eq!(
        storage.imported_known_devices().unwrap()[0].app_version,
        "unknown"
    );
    let day = &storage.imported_daily_usage(None).unwrap()[0];
    assert_eq!(day.input_cached_tokens, 10);
    assert_eq!(day.known_tokens, 42);
    assert_eq!(day.native_reasoning_tokens, 0);
    let connection = storage.connection.lock().unwrap();
    for table in [
        "request_logs",
        "channel_accounts",
        "background_jobs",
        "device_agent_sessions",
    ] {
        assert_eq!(
            connection
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?1",
                    [table],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
    }
}
