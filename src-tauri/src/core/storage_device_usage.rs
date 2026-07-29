use super::{Storage, StorageError};
use crate::core::device_identity::{
    resolve_device_display_name, DailyUsageTotal, DeviceUsageImportPreview,
    DeviceUsageImportResult, HourlyUsageTotal, KnownDevice, SharedAgentSession, SyncedAgentSession,
};
use rusqlite::{params, OptionalExtension};

impl Storage {
    /// 为本地导出和未来设备同步生成按设备本地自然日聚合的最小用量数据。
    /// 返回全部历史日汇总；即使历史 Token 被修复，下一次快照也会自然覆盖同一
    /// `(device_id, date)` 的远端汇总，无需维护逐行同步游标。
    pub fn daily_usage_totals(&self) -> Result<Vec<DailyUsageTotal>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let mut statement = connection.prepare(
            r#"
            SELECT
                strftime(
                    '%Y-%m-%d',
                    COALESCE(request_logs.created_at, usage_records.created_at),
                    'localtime'
                ) AS usage_date,
                count(*) AS request_count,
                coalesce(sum(usage_records.total_tokens), 0) AS known_tokens,
                coalesce(sum(usage_records.input_tokens), 0) AS input_tokens,
                coalesce(sum(usage_records.input_cached_tokens), 0) AS input_cached_tokens,
                coalesce(sum(usage_records.input_uncached_tokens), 0) AS input_uncached_tokens,
                coalesce(sum(
                    CASE
                        WHEN usage_records.input_cached_tokens IS NOT NULL
                        THEN usage_records.input_tokens
                        ELSE 0
                    END
                ), 0) AS cache_measured_input_tokens,
                coalesce(sum(usage_records.output_tokens), 0) AS output_tokens,
                sum(CASE WHEN usage_records.total_tokens IS NULL THEN 1 ELSE 0 END) AS unknown_count
            FROM usage_records
            LEFT JOIN request_logs
                   ON request_logs.request_id = usage_records.request_id
                  AND request_logs.is_last_attempt = 1
            GROUP BY usage_date
            ORDER BY usage_date ASC
            "#,
        )?;
        let rows = statement.query_map([], |row| {
            Ok(DailyUsageTotal {
                date: row
                    .get::<_, Option<String>>(0)?
                    .unwrap_or_else(|| "unknown".to_string()),
                request_count: row.get(1)?,
                known_tokens: row.get(2)?,
                input_tokens: row.get(3)?,
                input_cached_tokens: row.get(4)?,
                input_uncached_tokens: row.get(5)?,
                cache_measured_input_tokens: row.get(6)?,
                output_tokens: row.get(7)?,
                unknown_count: row.get(8)?,
            })
        })?;

        let mut totals = Vec::new();
        for row in rows {
            totals.push(row?);
        }
        Ok(totals)
    }

    /// 最近 180 天按设备本地自然小时聚合的最小 Token 数据。
    pub fn hourly_usage_totals(&self) -> Result<Vec<HourlyUsageTotal>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let mut statement = connection.prepare(
            r#"
            SELECT
                strftime(
                    '%Y-%m-%dT%H:00:00',
                    COALESCE(request_logs.created_at, usage_records.created_at),
                    'localtime'
                ) AS usage_hour,
                count(*) AS request_count,
                coalesce(sum(usage_records.total_tokens), 0) AS known_tokens
            FROM usage_records
            LEFT JOIN request_logs
                   ON request_logs.request_id = usage_records.request_id
                  AND request_logs.is_last_attempt = 1
            WHERE COALESCE(request_logs.created_at, usage_records.created_at)
                  >= datetime('now', 'localtime', 'start of day', '-180 days', 'utc')
            GROUP BY usage_hour
            ORDER BY usage_hour ASC
            "#,
        )?;
        let rows = statement.query_map([], |row| {
            Ok(HourlyUsageTotal {
                hour: row
                    .get::<_, Option<String>>(0)?
                    .unwrap_or_else(|| "unknown".to_string()),
                request_count: row.get(1)?,
                known_tokens: row.get(2)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StorageError::from)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn preview_device_usage_import(
        &self,
        current_device_id: &str,
        device_id: &str,
        device_created_at: &str,
        display_name: &str,
        platform: &str,
        app_version: &str,
        generated_at: &str,
        timezone_offset_minutes: i32,
        days: &[DailyUsageTotal],
    ) -> Result<DeviceUsageImportPreview, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let mut new_days = 0;
        let mut updated_days = 0;
        let mut unchanged_days = 0;
        let mut statement = connection.prepare(
            "SELECT request_count, known_tokens, input_tokens, input_cached_tokens,
                    input_uncached_tokens, cache_measured_input_tokens, output_tokens, unknown_count,
                    snapshot_generated_at
             FROM device_daily_usage WHERE device_id = ?1 AND usage_date = ?2",
        )?;
        for day in days {
            let existing = statement
                .query_row(params![device_id, day.date], |row| {
                    Ok((
                        DailyUsageTotal {
                            date: day.date.clone(),
                            request_count: row.get(0)?,
                            known_tokens: row.get(1)?,
                            input_tokens: row.get(2)?,
                            input_cached_tokens: row.get(3)?,
                            input_uncached_tokens: row.get(4)?,
                            cache_measured_input_tokens: row.get(5)?,
                            output_tokens: row.get(6)?,
                            unknown_count: row.get(7)?,
                        },
                        row.get::<_, String>(8)?,
                    ))
                })
                .optional()?;
            match existing {
                None => new_days += 1,
                Some((_, existing_generated_at))
                    if existing_generated_at.as_str() > generated_at =>
                {
                    unchanged_days += 1
                }
                Some((existing, _)) if existing == *day => unchanged_days += 1,
                Some(_) => updated_days += 1,
            }
        }
        Ok(DeviceUsageImportPreview {
            device_id: device_id.to_string(),
            device_created_at: device_created_at.to_string(),
            display_name: display_name.to_string(),
            platform: platform.to_string(),
            app_version: app_version.to_string(),
            generated_at: generated_at.to_string(),
            timezone_offset_minutes,
            first_date: days.first().map(|day| day.date.clone()),
            last_date: days.last().map(|day| day.date.clone()),
            day_count: days.len(),
            new_days,
            updated_days,
            unchanged_days,
            same_as_current_device: current_device_id == device_id,
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn import_device_usage(
        &self,
        snapshot_schema_version: u32,
        device_id: &str,
        device_created_at: &str,
        display_name: &str,
        platform: &str,
        app_version: &str,
        generated_at: &str,
        timezone_offset_minutes: i32,
        days: &[DailyUsageTotal],
        hours: &[HourlyUsageTotal],
        sessions: &[SyncedAgentSession],
    ) -> Result<DeviceUsageImportResult, StorageError> {
        let preview = self.preview_device_usage_import(
            "",
            device_id,
            device_created_at,
            display_name,
            platform,
            app_version,
            generated_at,
            timezone_offset_minutes,
            days,
        )?;
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let transaction = connection.transaction()?;
        transaction.execute(
            "INSERT INTO known_devices (
                device_id, device_created_at, display_name, platform, app_version,
                timezone_offset_minutes, profile_generated_at, first_seen_at, last_seen_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now'), ?7)
             ON CONFLICT(device_id) DO UPDATE SET
                device_created_at = excluded.device_created_at,
                display_name = excluded.display_name,
                platform = excluded.platform,
                app_version = excluded.app_version,
                timezone_offset_minutes = excluded.timezone_offset_minutes,
                profile_generated_at = excluded.profile_generated_at,
                last_seen_at = excluded.last_seen_at
             WHERE excluded.profile_generated_at >= known_devices.profile_generated_at",
            params![
                device_id,
                device_created_at,
                display_name,
                platform,
                app_version,
                timezone_offset_minutes,
                generated_at
            ],
        )?;
        let import_snapshot_details = transaction
            .query_row(
                "SELECT profile_generated_at FROM known_devices WHERE device_id = ?1",
                [device_id],
                |row| row.get::<_, String>(0),
            )?
            .as_str()
            <= generated_at;
        for day in days {
            transaction.execute(
                "INSERT INTO device_daily_usage (
                    device_id, usage_date, request_count, known_tokens, input_tokens,
                    input_cached_tokens, input_uncached_tokens, cache_measured_input_tokens,
                    output_tokens, unknown_count, snapshot_generated_at, imported_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, datetime('now'))
                 ON CONFLICT(device_id, usage_date) DO UPDATE SET
                    request_count = excluded.request_count,
                    known_tokens = excluded.known_tokens,
                    input_tokens = excluded.input_tokens,
                    input_cached_tokens = excluded.input_cached_tokens,
                    input_uncached_tokens = excluded.input_uncached_tokens,
                    cache_measured_input_tokens = excluded.cache_measured_input_tokens,
                    output_tokens = excluded.output_tokens,
                    unknown_count = excluded.unknown_count,
                    snapshot_generated_at = excluded.snapshot_generated_at,
                    imported_at = datetime('now')
                 WHERE excluded.snapshot_generated_at >= device_daily_usage.snapshot_generated_at",
                params![
                    device_id,
                    day.date,
                    day.request_count,
                    day.known_tokens,
                    day.input_tokens,
                    day.input_cached_tokens,
                    day.input_uncached_tokens,
                    day.cache_measured_input_tokens,
                    day.output_tokens,
                    day.unknown_count,
                    generated_at,
                ],
            )?;
        }
        if import_snapshot_details && snapshot_schema_version >= 2 {
            transaction.execute(
                "DELETE FROM device_hourly_usage WHERE device_id = ?1",
                [device_id],
            )?;
            for hour in hours {
                transaction.execute(
                    "INSERT INTO device_hourly_usage (
                        device_id, usage_hour, request_count, known_tokens,
                        snapshot_generated_at, imported_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))",
                    params![
                        device_id,
                        hour.hour,
                        hour.request_count,
                        hour.known_tokens,
                        generated_at,
                    ],
                )?;
            }
        }
        if import_snapshot_details {
            transaction.execute(
                "DELETE FROM device_agent_sessions WHERE device_id = ?1",
                [device_id],
            )?;
            for session in sessions {
                let session_json = serde_json::to_string(session)
                    .map_err(|error| StorageError::InvalidImport(error.to_string()))?;
                transaction.execute(
                    "INSERT INTO device_agent_sessions (
                        device_id, agent_type, session_id, runtime_status, activity_at,
                        session_json, snapshot_generated_at, imported_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now'))",
                    params![
                        device_id,
                        session.agent_type,
                        session.session_id,
                        session.runtime_status,
                        session.activity_at,
                        session_json,
                        generated_at,
                    ],
                )?;
            }
        }
        transaction.commit()?;
        Ok(DeviceUsageImportResult {
            device_id: device_id.to_string(),
            imported_days: preview.new_days + preview.updated_days,
            unchanged_days: preview.unchanged_days,
        })
    }

    pub fn imported_known_devices(&self) -> Result<Vec<KnownDevice>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let mut statement = connection.prepare(
            "SELECT d.device_id, d.device_created_at, d.display_name, d.platform, d.app_version,
                    d.timezone_offset_minutes,
                    min(u.usage_date), max(u.usage_date), count(u.usage_date),
                    coalesce(sum(u.request_count), 0), coalesce(sum(u.known_tokens), 0),
                    d.last_seen_at
             FROM known_devices d
             LEFT JOIN device_daily_usage u ON u.device_id = d.device_id
             GROUP BY d.device_id
             ORDER BY d.last_seen_at DESC",
        )?;
        let rows = statement.query_map([], |row| {
            let device_id: String = row.get(0)?;
            let display_name: String = row.get(2)?;
            let platform: String = row.get(3)?;
            Ok(KnownDevice {
                display_name: resolve_device_display_name(&display_name, &platform, &device_id),
                device_id,
                device_created_at: row.get(1)?,
                platform,
                app_version: row.get(4)?,
                is_current: false,
                timezone_offset_minutes: row.get(5)?,
                first_usage_date: row.get(6)?,
                last_usage_date: row.get(7)?,
                day_count: row.get(8)?,
                request_count: row.get(9)?,
                known_tokens: row.get(10)?,
                last_seen_at: row.get(11)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StorageError::from)
    }

    pub fn imported_daily_usage(
        &self,
        device_id: Option<&str>,
    ) -> Result<Vec<DailyUsageTotal>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let sql = if device_id.is_some() {
            "SELECT usage_date, sum(request_count), sum(known_tokens), sum(input_tokens),
                    sum(input_cached_tokens), sum(input_uncached_tokens),
                    sum(cache_measured_input_tokens), sum(output_tokens), sum(unknown_count)
             FROM device_daily_usage WHERE device_id = ?1 GROUP BY usage_date ORDER BY usage_date"
        } else {
            "SELECT usage_date, sum(request_count), sum(known_tokens), sum(input_tokens),
                    sum(input_cached_tokens), sum(input_uncached_tokens),
                    sum(cache_measured_input_tokens), sum(output_tokens), sum(unknown_count)
             FROM device_daily_usage GROUP BY usage_date ORDER BY usage_date"
        };
        let mut statement = connection.prepare(sql)?;
        let map_row = |row: &rusqlite::Row<'_>| {
            Ok(DailyUsageTotal {
                date: row.get(0)?,
                request_count: row.get(1)?,
                known_tokens: row.get(2)?,
                input_tokens: row.get(3)?,
                input_cached_tokens: row.get(4)?,
                input_uncached_tokens: row.get(5)?,
                cache_measured_input_tokens: row.get(6)?,
                output_tokens: row.get(7)?,
                unknown_count: row.get(8)?,
            })
        };
        let mut totals = Vec::new();
        if let Some(device_id) = device_id {
            for row in statement.query_map([device_id], map_row)? {
                totals.push(row?);
            }
        } else {
            for row in statement.query_map([], map_row)? {
                totals.push(row?);
            }
        }
        Ok(totals)
    }

    pub fn imported_hourly_usage(
        &self,
        device_id: Option<&str>,
    ) -> Result<Vec<HourlyUsageTotal>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let sql = if device_id.is_some() {
            "SELECT usage_hour, sum(request_count), sum(known_tokens)
             FROM device_hourly_usage
             WHERE device_id = ?1
             GROUP BY usage_hour
             ORDER BY usage_hour"
        } else {
            "SELECT usage_hour, sum(request_count), sum(known_tokens)
             FROM device_hourly_usage
             GROUP BY usage_hour
             ORDER BY usage_hour"
        };
        let mut statement = connection.prepare(sql)?;
        let map_row = |row: &rusqlite::Row<'_>| {
            Ok(HourlyUsageTotal {
                hour: row.get(0)?,
                request_count: row.get(1)?,
                known_tokens: row.get(2)?,
            })
        };
        let mut totals = Vec::new();
        if let Some(device_id) = device_id {
            for row in statement.query_map([device_id], map_row)? {
                totals.push(row?);
            }
        } else {
            for row in statement.query_map([], map_row)? {
                totals.push(row?);
            }
        }
        Ok(totals)
    }

    pub fn imported_device_sessions(
        &self,
        device_id: Option<&str>,
    ) -> Result<Vec<SharedAgentSession>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let sql = if device_id.is_some() {
            "SELECT s.device_id, d.display_name, d.platform, s.session_json
             FROM device_agent_sessions s
             JOIN known_devices d ON d.device_id = s.device_id
             WHERE s.device_id = ?1
             ORDER BY CASE s.runtime_status
                        WHEN 'running' THEN 0
                        WHEN 'waiting_user' THEN 1
                        ELSE 2
                      END,
                      s.activity_at DESC"
        } else {
            "SELECT s.device_id, d.display_name, d.platform, s.session_json
             FROM device_agent_sessions s
             JOIN known_devices d ON d.device_id = s.device_id
             ORDER BY CASE s.runtime_status
                        WHEN 'running' THEN 0
                        WHEN 'waiting_user' THEN 1
                        ELSE 2
                      END,
                      s.activity_at DESC"
        };
        let mut statement = connection.prepare(sql)?;
        let map_row = |row: &rusqlite::Row<'_>| {
            let device_id: String = row.get(0)?;
            let display_name: String = row.get(1)?;
            let platform: String = row.get(2)?;
            let session_json: String = row.get(3)?;
            let session =
                serde_json::from_str::<SyncedAgentSession>(&session_json).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        3,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })?;
            Ok(SharedAgentSession {
                device_display_name: resolve_device_display_name(
                    &display_name,
                    &platform,
                    &device_id,
                ),
                device_id,
                device_platform: platform,
                session,
            })
        };
        let mut sessions = Vec::new();
        if let Some(device_id) = device_id {
            for row in statement.query_map([device_id], map_row)? {
                sessions.push(row?);
            }
        } else {
            for row in statement.query_map([], map_row)? {
                sessions.push(row?);
            }
        }
        Ok(sessions)
    }
}
