//! 桌面 Host 与 Web Host 共用的设备只读用量查询。
//!
//! 这里只做同步的存储读取与合并，不依赖 Tauri；各 Host 负责把调用放进阻塞任务
//! 并补上自己的错误包装，避免同一份设备口径出现两份实现。
use crate::core::device_identity::{
    merge_daily_usage_totals, merge_hourly_usage_totals, DailyUsageTotal, DeviceIdentity,
    HourlyUsageTotal, KnownDevice,
};
use crate::core::storage::Storage;

/// 设备目录：当前设备固定排首位并标记 `is_current`，其余来自已同步的设备快照。
pub fn known_devices(
    storage: &Storage,
    identity: &DeviceIdentity,
) -> Result<Vec<KnownDevice>, String> {
    let current_days = storage
        .daily_usage_totals()
        .map_err(|error| error.to_string())?;
    let mut devices = storage
        .imported_known_devices()
        .map_err(|error| error.to_string())?;
    devices.retain(|device| device.device_id != identity.device_id);
    devices.insert(
        0,
        KnownDevice {
            device_id: identity.device_id.clone(),
            device_created_at: identity.created_at.clone(),
            display_name: identity.display_name.clone(),
            platform: identity.platform.clone(),
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            is_current: true,
            timezone_offset_minutes: chrono::Local::now().offset().local_minus_utc() / 60,
            first_usage_date: current_days.first().map(|day| day.date.clone()),
            last_usage_date: current_days.last().map(|day| day.date.clone()),
            day_count: current_days.len() as i64,
            request_count: current_days.iter().map(|day| day.request_count).sum(),
            known_tokens: current_days.iter().map(|day| day.known_tokens).sum(),
            last_seen_at: chrono::Utc::now().to_rfc3339(),
        },
    );
    Ok(devices)
}

/// 设备日用量。`device_id` 为 `None` 时返回本机 + 已同步设备的合并口径。
pub fn daily_usage(
    storage: &Storage,
    current_device_id: &str,
    device_id: Option<&str>,
) -> Result<Vec<DailyUsageTotal>, String> {
    if device_id == Some(current_device_id) {
        // 本设备：代理 + Agent 原生合并口径。
        return storage
            .local_daily_usage_totals_with_native()
            .map_err(|error| error.to_string());
    }
    if let Some(device_id) = device_id {
        return storage
            .imported_daily_usage(Some(device_id))
            .map_err(|error| error.to_string());
    }
    let current = storage
        .local_daily_usage_totals_with_native()
        .map_err(|error| error.to_string())?;
    let imported = storage
        .imported_daily_usage(None)
        .map_err(|error| error.to_string())?;
    Ok(merge_daily_usage_totals(
        current.into_iter().chain(imported),
    ))
}

/// 设备小时用量。`device_id` 为 `None` 时返回本机 + 已同步设备的合并口径。
pub fn hourly_usage(
    storage: &Storage,
    current_device_id: &str,
    device_id: Option<&str>,
) -> Result<Vec<HourlyUsageTotal>, String> {
    if device_id == Some(current_device_id) {
        // 本设备：代理 + Agent 原生合并口径。
        return storage
            .local_hourly_usage_totals_with_native()
            .map_err(|error| error.to_string());
    }
    if let Some(device_id) = device_id {
        return storage
            .imported_hourly_usage(Some(device_id))
            .map_err(|error| error.to_string());
    }
    let current = storage
        .local_hourly_usage_totals_with_native()
        .map_err(|error| error.to_string())?;
    let imported = storage
        .imported_hourly_usage(None)
        .map_err(|error| error.to_string())?;
    Ok(merge_hourly_usage_totals(
        current.into_iter().chain(imported),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::config::{RequestLogInput, UsageRecordInput};
    use rusqlite::Connection;

    const CURRENT_DEVICE_ID: &str = "11111111-1111-4111-8111-111111111111";
    const OTHER_DEVICE_ID: &str = "22222222-2222-4222-8222-222222222222";

    fn storage() -> Storage {
        let connection = Connection::open_in_memory().expect("open in-memory sqlite");
        let storage = Storage::from_connection_for_test(connection);
        storage.migrate().expect("migrate schema");
        storage
    }

    fn identity() -> DeviceIdentity {
        DeviceIdentity {
            schema_version: 1,
            device_id: CURRENT_DEVICE_ID.to_string(),
            created_at: "2026-01-01T00:00:00+00:00".to_string(),
            display_name: "Test device".to_string(),
            platform: "linux".to_string(),
        }
    }

    fn seed_usage(storage: &Storage) {
        let request_id = "device-usage-unit";
        storage
            .insert_request_log(&RequestLogInput {
                request_id: request_id.to_string(),
                agent_type: None,
                agent_session_id: None,
                parent_agent_session_id: None,
                client_id: Some("opencode".to_string()),
                client_name: Some("OpenCode".to_string()),
                channel_id: Some("deepseek".to_string()),
                channel_name: Some("DeepSeek".to_string()),
                account_id: Some("account-unit".to_string()),
                account_name: Some("Unit".to_string()),
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
                req_headers_json: None,
                req_body_b64: None,
                res_headers_json: None,
                res_body_b64: None,
                is_last_attempt: true,
            })
            .expect("insert request log");
        storage
            .upsert_usage_record(&UsageRecordInput {
                request_id: request_id.to_string(),
                client_id: Some("opencode".to_string()),
                client_name: Some("OpenCode".to_string()),
                channel_id: Some("deepseek".to_string()),
                channel_name: Some("DeepSeek".to_string()),
                account_id: Some("account-unit".to_string()),
                account_name: Some("Unit".to_string()),
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
            })
            .expect("insert usage record");
    }

    #[test]
    fn known_devices_put_current_device_first_and_mark_it() {
        let storage = storage();
        let identity = identity();

        let devices = known_devices(&storage, &identity).expect("list known devices");
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].device_id, CURRENT_DEVICE_ID);
        assert!(devices[0].is_current);
        assert_eq!(devices[0].app_version, env!("CARGO_PKG_VERSION"));
        assert_eq!(devices[0].day_count, 0);
        assert!(devices[0].first_usage_date.is_none());

        seed_usage(&storage);
        let devices = known_devices(&storage, &identity).expect("list known devices");
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].day_count, 1);
        assert_eq!(devices[0].request_count, 1);
        assert_eq!(devices[0].known_tokens, 120);
        assert!(devices[0].first_usage_date.is_some());
        assert_eq!(devices[0].first_usage_date, devices[0].last_usage_date);
    }

    #[test]
    fn daily_and_hourly_usage_handle_current_other_and_all_devices() {
        let storage = storage();
        seed_usage(&storage);

        let current = daily_usage(&storage, CURRENT_DEVICE_ID, Some(CURRENT_DEVICE_ID))
            .expect("current device daily usage");
        assert_eq!(current.len(), 1);
        assert_eq!(current[0].request_count, 1);
        assert_eq!(current[0].known_tokens, 120);

        let all = daily_usage(&storage, CURRENT_DEVICE_ID, None).expect("all daily usage");
        assert_eq!(all, current, "无同步设备时全部设备口径等于本机口径");

        let other = daily_usage(&storage, CURRENT_DEVICE_ID, Some(OTHER_DEVICE_ID))
            .expect("other device daily usage");
        assert!(other.is_empty(), "只有当前设备有本机数据");

        let current_hourly = hourly_usage(&storage, CURRENT_DEVICE_ID, Some(CURRENT_DEVICE_ID))
            .expect("current device hourly usage");
        assert_eq!(current_hourly.len(), 1);
        assert_eq!(current_hourly[0].request_count, 1);
        let all_hourly = hourly_usage(&storage, CURRENT_DEVICE_ID, None).expect("all hourly usage");
        assert_eq!(all_hourly, current_hourly);
        let other_hourly = hourly_usage(&storage, CURRENT_DEVICE_ID, Some(OTHER_DEVICE_ID))
            .expect("other device hourly usage");
        assert!(other_hourly.is_empty());
    }
}
