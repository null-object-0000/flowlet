use super::{Storage, StorageError};
use crate::core::config::DeviceUsageBreakdownRow;
use crate::core::device_identity::{
    resolve_device_display_name, DailyUsageTotal, DeviceUsageImportPreview,
    DeviceUsageImportResult, HourlyUsageTotal, KnownDevice, SharedAgentSession,
    SyncedAccountResource, SyncedAgentProfile, SyncedAgentSession,
};
use rusqlite::{params, OptionalExtension};

impl Storage {
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
                    native_event_count, native_input_tokens, native_cached_input_tokens,
                    native_cache_write_input_tokens, native_output_tokens,
                    native_reasoning_tokens, native_total_tokens,
                    estimated_cost,
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
                            native_event_count: row.get(8)?,
                            native_input_tokens: row.get(9)?,
                            native_cached_input_tokens: row.get(10)?,
                            native_cache_write_input_tokens: row.get(11)?,
                            native_output_tokens: row.get(12)?,
                            native_reasoning_tokens: row.get(13)?,
                            native_total_tokens: row.get(14)?,
                            estimated_cost: row.get(15)?,
                        },
                        row.get::<_, String>(16)?,
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
        agents: &[SyncedAgentProfile],
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
                    output_tokens, unknown_count,
                    native_event_count, native_input_tokens, native_cached_input_tokens,
                    native_cache_write_input_tokens, native_output_tokens,
                    native_reasoning_tokens, native_total_tokens,
                    estimated_cost,
                    snapshot_generated_at, imported_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, datetime('now'))
                 ON CONFLICT(device_id, usage_date) DO UPDATE SET
                    request_count = excluded.request_count,
                    known_tokens = excluded.known_tokens,
                    input_tokens = excluded.input_tokens,
                    input_cached_tokens = excluded.input_cached_tokens,
                    input_uncached_tokens = excluded.input_uncached_tokens,
                    cache_measured_input_tokens = excluded.cache_measured_input_tokens,
                    output_tokens = excluded.output_tokens,
                    unknown_count = excluded.unknown_count,
                    native_event_count = excluded.native_event_count,
                    native_input_tokens = excluded.native_input_tokens,
                    native_cached_input_tokens = excluded.native_cached_input_tokens,
                    native_cache_write_input_tokens = excluded.native_cache_write_input_tokens,
                    native_output_tokens = excluded.native_output_tokens,
                    native_reasoning_tokens = excluded.native_reasoning_tokens,
                    native_total_tokens = excluded.native_total_tokens,
                    estimated_cost = excluded.estimated_cost,
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
                    day.native_event_count,
                    day.native_input_tokens,
                    day.native_cached_input_tokens,
                    day.native_cache_write_input_tokens,
                    day.native_output_tokens,
                    day.native_reasoning_tokens,
                    day.native_total_tokens,
                    day.estimated_cost,
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
                        input_tokens, input_cached_tokens, cache_measured_input_tokens,
                        output_tokens, unknown_count, estimated_cost,
                        native_event_count, native_input_tokens, native_cached_input_tokens,
                        native_cache_write_input_tokens, native_output_tokens,
                        native_reasoning_tokens, native_total_tokens,
                        snapshot_generated_at, imported_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, datetime('now'))",
                    params![
                        device_id,
                        hour.hour,
                        hour.request_count,
                        hour.known_tokens,
                        hour.input_tokens,
                        hour.input_cached_tokens,
                        hour.cache_measured_input_tokens,
                        hour.output_tokens,
                        hour.unknown_count,
                        hour.estimated_cost,
                        hour.native_event_count,
                        hour.native_input_tokens,
                        hour.native_cached_input_tokens,
                        hour.native_cache_write_input_tokens,
                        hour.native_output_tokens,
                        hour.native_reasoning_tokens,
                        hour.native_total_tokens,
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
            transaction.execute(
                "DELETE FROM device_agent_profiles WHERE device_id = ?1",
                [device_id],
            )?;
            for agent in agents {
                let profile_json = serde_json::to_string(agent)
                    .map_err(|error| StorageError::InvalidImport(error.to_string()))?;
                transaction.execute(
                    "INSERT INTO device_agent_profiles (
                        device_id, agent_id, profile_json, snapshot_generated_at, imported_at
                     ) VALUES (?1, ?2, ?3, ?4, datetime('now'))",
                    params![device_id, agent.agent_id, profile_json, generated_at],
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

    /// 导入单个设备同步来的完整维度用量快照到 `device_usage_breakdowns`。
    ///
    /// 快照只包含发送端当前保留的历史窗口，因此必须先删除该设备的旧行再整体写入；
    /// 否则客户端归并键或模型归属修正后，旧维度行会永久残留并造成重复统计。
    pub fn import_device_usage_breakdowns(
        &self,
        device_id: &str,
        generated_at: &str,
        usage_breakdowns: &[DeviceUsageBreakdownRow],
    ) -> Result<usize, StorageError> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let transaction = connection.transaction()?;
        let newest_profile_at = transaction
            .query_row(
                "SELECT profile_generated_at FROM known_devices WHERE device_id = ?1",
                [device_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if newest_profile_at
            .as_deref()
            .is_some_and(|newest| newest > generated_at)
        {
            return Ok(0);
        }
        transaction.execute(
            "DELETE FROM device_usage_breakdowns WHERE device_id = ?1",
            [device_id],
        )?;
        let mut imported = 0;
        for breakdown in usage_breakdowns {
            // 历史兼容：旧版 Codex Desktop 原生用量快照可能以 flowlet-pro / flowlet-flash
            // 作为模型名落库；它们是聚合别名而非真实上游模型，导入时必须丢弃，否则跨设备
            // 汇总会重复统计。聚合能力移除后该过滤仍需保留（兼容未升级的发送端）。
            let is_stale_legacy_aggregate_alias = breakdown.request_count == 0
                && breakdown.native_event_count > 0
                && breakdown.upstream_model.as_deref().is_some_and(|model| {
                    matches!(
                        model.trim().to_ascii_lowercase().as_str(),
                        "flowlet-pro" | "flowlet-flash"
                    )
                });
            if is_stale_legacy_aggregate_alias {
                continue;
            }
            // 旧版本曾把 Codex Desktop 原生用量同步为 client_id = "codex"，
            // 而代理请求使用 "codex-desktop"。在接收边界规范化，兼容尚未升级的发送端。
            let client_id = match (
                breakdown.client_id.as_deref(),
                breakdown.client_name.as_deref(),
            ) {
                (Some("codex"), Some(name)) if name.eq_ignore_ascii_case("Codex Desktop") => {
                    Some("codex-desktop")
                }
                (value, _) => value,
            };
            let changes = transaction.execute(
                "INSERT INTO device_usage_breakdowns (
                    device_id, breakdown_date, client_id, client_name, channel_id, channel_name,
                    account_id, account_name, upstream_model, request_count, known_tokens,
                    input_tokens, input_cached_tokens, input_uncached_tokens,
                    cache_measured_input_tokens, output_tokens, unknown_count, estimated_cost,
                    estimated_cost_currency, native_event_count,
                    elapsed_total_ms, elapsed_measured_count, generation_total_ms,
                    generation_output_tokens, imported_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
                           ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, datetime('now'))
                 ON CONFLICT(device_id, breakdown_date, client_id, channel_id, account_id, upstream_model)
                 DO UPDATE SET
                    client_name = excluded.client_name,
                    channel_name = excluded.channel_name,
                    account_name = excluded.account_name,
                    request_count = excluded.request_count,
                    known_tokens = excluded.known_tokens,
                    input_tokens = excluded.input_tokens,
                    input_cached_tokens = excluded.input_cached_tokens,
                    input_uncached_tokens = excluded.input_uncached_tokens,
                    cache_measured_input_tokens = excluded.cache_measured_input_tokens,
                    output_tokens = excluded.output_tokens,
                    unknown_count = excluded.unknown_count,
                    estimated_cost = excluded.estimated_cost,
                    estimated_cost_currency = excluded.estimated_cost_currency,
                    native_event_count = excluded.native_event_count,
                    elapsed_total_ms = excluded.elapsed_total_ms,
                    elapsed_measured_count = excluded.elapsed_measured_count,
                    generation_total_ms = excluded.generation_total_ms,
                    generation_output_tokens = excluded.generation_output_tokens,
                    imported_at = datetime('now')",
                params![
                    device_id,
                    breakdown.date,
                    client_id,
                    breakdown.client_name,
                    breakdown.channel_id,
                    breakdown.channel_name,
                    breakdown.account_id,
                    breakdown.account_name,
                    breakdown.upstream_model,
                    breakdown.request_count,
                    breakdown.known_tokens,
                    breakdown.input_tokens,
                    breakdown.input_cached_tokens,
                    breakdown.input_uncached_tokens,
                    breakdown.cache_measured_input_tokens,
                    breakdown.output_tokens,
                    breakdown.unknown_count,
                    breakdown.estimated_cost,
                    breakdown.estimated_cost_currency,
                    breakdown.native_event_count,
                    breakdown.elapsed_total_ms,
                    breakdown.elapsed_measured_count,
                    breakdown.generation_total_ms,
                    breakdown.generation_output_tokens,
                ],
            )?;
            imported += changes;
        }
        transaction.commit()?;
        Ok(imported)
    }

    /// 整体替换单台设备发布的账号资源观测。旧快照不能覆盖新快照；空数组表示
    /// 发送端当前没有符合自动同步条件且已加入工作区的账号，需要清理该设备旧观测。
    pub fn import_device_account_resources(
        &self,
        device_id: &str,
        generated_at: &str,
        resources: &[SyncedAccountResource],
    ) -> Result<usize, StorageError> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let transaction = connection.transaction()?;
        let newest_profile_at = transaction
            .query_row(
                "SELECT profile_generated_at FROM known_devices WHERE device_id = ?1",
                [device_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if newest_profile_at
            .as_deref()
            .is_some_and(|newest| newest > generated_at)
        {
            return Ok(0);
        }
        transaction.execute(
            "DELETE FROM device_account_resources WHERE device_id = ?1",
            [device_id],
        )?;
        let mut imported = 0;
        for resource in resources {
            if resource.account_id.trim().is_empty() || resource.channel_id.trim().is_empty() {
                continue;
            }
            let resource_json = serde_json::to_string(resource)
                .map_err(|error| StorageError::InvalidImport(error.to_string()))?;
            imported += transaction.execute(
                "INSERT INTO device_account_resources (
                    device_id, account_id, resource_json, observed_at,
                    snapshot_generated_at, imported_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))",
                params![
                    device_id,
                    resource.account_id,
                    resource_json,
                    resource.observed_at,
                    generated_at
                ],
            )?;
        }
        transaction.commit()?;
        Ok(imported)
    }

    /// 工作区级移动视图：同一账号可能由多台桌面发布，只返回 observed_at 最新的
    /// 一条；时间相同时用较新的设备快照稳定决胜。
    pub fn imported_account_resources(&self) -> Result<Vec<SyncedAccountResource>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let mut statement = connection.prepare(
            "SELECT resource_json FROM (
                SELECT resource_json,
                       row_number() OVER (
                           PARTITION BY account_id
                           ORDER BY observed_at DESC, snapshot_generated_at DESC, device_id ASC
                       ) AS rank
                FROM device_account_resources
             ) WHERE rank = 1",
        )?;
        let rows = statement.query_map([], |row| {
            let json: String = row.get(0)?;
            serde_json::from_str::<SyncedAccountResource>(&json).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    0,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })
        })?;
        let mut resources = rows.collect::<Result<Vec<_>, _>>()?;
        // Codex 在不同桌面设备上可能从 OAuth / app-server 得到不同 account_id，
        // PC 端会继续按归一化邮箱识别为同一账号。同步契约已经携带去敏后的邮箱展示名，
        // 因此移动端查询也按相同口径二次聚合，并保留 observed_at 最新的观测。
        resources.sort_by(|left, right| {
            right
                .observed_at
                .cmp(&left.observed_at)
                .then_with(|| left.account_id.cmp(&right.account_id))
        });
        let mut seen = std::collections::HashSet::new();
        resources.retain(|resource| seen.insert(account_resource_identity(resource)));
        resources.sort_by(|left, right| {
            right
                .stale
                .cmp(&left.stale)
                .then_with(|| left.channel_name.cmp(&right.channel_name))
                .then_with(|| left.account_name.cmp(&right.account_name))
        });
        Ok(resources)
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
                    sum(cache_measured_input_tokens), sum(output_tokens), sum(unknown_count),
                    sum(native_event_count), sum(native_input_tokens),
                    sum(native_cached_input_tokens), sum(native_cache_write_input_tokens),
                    sum(native_output_tokens), sum(native_reasoning_tokens),
                    sum(native_total_tokens), sum(estimated_cost)
             FROM device_daily_usage WHERE device_id = ?1 GROUP BY usage_date ORDER BY usage_date"
        } else {
            "SELECT usage_date, sum(request_count), sum(known_tokens), sum(input_tokens),
                    sum(input_cached_tokens), sum(input_uncached_tokens),
                    sum(cache_measured_input_tokens), sum(output_tokens), sum(unknown_count),
                    sum(native_event_count), sum(native_input_tokens),
                    sum(native_cached_input_tokens), sum(native_cache_write_input_tokens),
                    sum(native_output_tokens), sum(native_reasoning_tokens),
                    sum(native_total_tokens), sum(estimated_cost)
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
                native_event_count: row.get(9)?,
                native_input_tokens: row.get(10)?,
                native_cached_input_tokens: row.get(11)?,
                native_cache_write_input_tokens: row.get(12)?,
                native_output_tokens: row.get(13)?,
                native_reasoning_tokens: row.get(14)?,
                native_total_tokens: row.get(15)?,
                estimated_cost: row.get(16)?,
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
            "SELECT usage_hour, sum(request_count), sum(known_tokens),
                    sum(input_tokens), sum(input_cached_tokens), sum(cache_measured_input_tokens),
                    sum(output_tokens), sum(unknown_count), sum(estimated_cost),
                    sum(native_event_count), sum(native_input_tokens), sum(native_cached_input_tokens),
                    sum(native_cache_write_input_tokens), sum(native_output_tokens),
                    sum(native_reasoning_tokens), sum(native_total_tokens)
             FROM device_hourly_usage
             WHERE device_id = ?1
             GROUP BY usage_hour
             ORDER BY usage_hour"
        } else {
            "SELECT usage_hour, sum(request_count), sum(known_tokens),
                    sum(input_tokens), sum(input_cached_tokens), sum(cache_measured_input_tokens),
                    sum(output_tokens), sum(unknown_count), sum(estimated_cost),
                    sum(native_event_count), sum(native_input_tokens), sum(native_cached_input_tokens),
                    sum(native_cache_write_input_tokens), sum(native_output_tokens),
                    sum(native_reasoning_tokens), sum(native_total_tokens)
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
                input_tokens: row.get(3)?,
                input_cached_tokens: row.get(4)?,
                cache_measured_input_tokens: row.get(5)?,
                output_tokens: row.get(6)?,
                unknown_count: row.get(7)?,
                estimated_cost: row.get(8)?,
                native_event_count: row.get(9)?,
                native_input_tokens: row.get(10)?,
                native_cached_input_tokens: row.get(11)?,
                native_cache_write_input_tokens: row.get(12)?,
                native_output_tokens: row.get(13)?,
                native_reasoning_tokens: row.get(14)?,
                native_total_tokens: row.get(15)?,
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

    /// 直连刷新单个会话时只覆盖该会话，不删除同设备的其他会话快照。
    pub fn upsert_imported_device_session(
        &self,
        device_id: &str,
        session: &SyncedAgentSession,
        generated_at: &str,
    ) -> Result<(), StorageError> {
        let session_json = serde_json::to_string(session)
            .map_err(|error| StorageError::InvalidImport(error.to_string()))?;
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        connection.execute(
            "INSERT INTO device_agent_sessions (
                device_id, agent_type, session_id, runtime_status, activity_at,
                session_json, snapshot_generated_at, imported_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now'))
             ON CONFLICT(device_id, agent_type, session_id) DO UPDATE SET
                runtime_status = excluded.runtime_status,
                activity_at = excluded.activity_at,
                session_json = excluded.session_json,
                snapshot_generated_at = excluded.snapshot_generated_at,
                imported_at = datetime('now')
             WHERE excluded.snapshot_generated_at >= device_agent_sessions.snapshot_generated_at",
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
        Ok(())
    }

    pub fn imported_device_agents(
        &self,
        device_id: &str,
    ) -> Result<Vec<SyncedAgentProfile>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let mut statement = connection.prepare(
            "SELECT profile_json FROM device_agent_profiles
             WHERE device_id = ?1 ORDER BY agent_id",
        )?;
        let rows = statement.query_map([device_id], |row| {
            let profile_json: String = row.get(0)?;
            serde_json::from_str::<SyncedAgentProfile>(&profile_json).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    0,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StorageError::from)
    }
}

fn account_resource_identity(resource: &SyncedAccountResource) -> String {
    if resource.channel_id == "chatgpt" {
        let email = resource.account_name.trim().to_ascii_lowercase();
        if email.contains('@') {
            return format!("chatgpt:email:{email}");
        }
    }
    format!("{}:id:{}", resource.channel_id, resource.account_id)
}
