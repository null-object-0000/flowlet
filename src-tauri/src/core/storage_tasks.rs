use super::super::config::AgentSessionNativeSummary;
use super::{Storage, StorageError};
use crate::core::agent_session_timeline::{
    AgentSessionSummaryCheckpoint, AgentSessionSummaryParseResult,
};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

const MAX_AUTO_SYNC_SESSIONS: usize = 12;
const MAX_MANUAL_SYNC_SESSIONS: usize = 20;
const SESSION_PARSE_TIMEOUT: Duration = Duration::from_secs(5);
const SLOW_SESSION_THRESHOLD: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundJobRow {
    pub id: String,
    pub job_type: String,
    pub title: String,
    pub trigger_source: String,
    pub status: String,
    pub stage: Option<String>,
    pub progress_current: i64,
    pub progress_total: i64,
    pub summary_json: Option<String>,
    pub error_message: Option<String>,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub updated_at: String,
    pub cancel_requested: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BackgroundJobsFilter {
    pub page: u32,
    pub page_size: u32,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub job_type: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundJobsPage {
    pub rows: Vec<BackgroundJobRow>,
    pub total: i64,
    pub page: u32,
    pub page_size: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupBackgroundJobsResult {
    pub deleted_jobs: usize,
    pub deleted_events: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundJobEvent {
    pub id: String,
    pub job_id: String,
    pub sequence: i64,
    pub level: String,
    pub stage: Option<String>,
    pub message: String,
    pub detail_json: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundJobDetail {
    pub job: BackgroundJobRow,
    pub events: Vec<BackgroundJobEvent>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDataSyncResult {
    pub started: bool,
    pub job_id: Option<String>,
    pub scanned: usize,
    pub changed: usize,
    pub failed: usize,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSourceSyncState {
    pub agent_type: String,
    pub last_checked_at: Option<String>,
    pub last_synced_at: Option<String>,
    pub status: String,
    pub last_error: Option<String>,
    pub scanned_count: i64,
    pub changed_count: i64,
    pub failed_count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSyncStatusReport {
    pub running: bool,
    pub sources: Vec<AgentSourceSyncState>,
}

impl Storage {
    pub fn enrich_native_agent_sessions(
        &self,
        mut sessions: Vec<super::super::config::AgentSessionRow>,
    ) -> Vec<super::super::config::AgentSessionRow> {
        let prices = self.prices();
        let Ok(connection) = self.connection.lock() else {
            return sessions;
        };
        let Ok(mut statement) = connection.prepare("SELECT summary_json, synced_at FROM agent_session_snapshots WHERE agent_type=?1 AND session_id=?2") else { return sessions };
        for session in &mut sessions {
            let snapshot = statement
                .query_row(params![session.agent_type, session.session_id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .optional();
            if let Ok(Some((json, synced_at))) = snapshot {
                if let Ok(mut summary) = serde_json::from_str::<AgentSessionNativeSummary>(&json) {
                    crate::core::agent_session_timeline::apply_native_cost_estimate_to_summary(
                        &session.agent_type,
                        &mut summary,
                        &prices,
                    );
                    session.native_summary = Some(summary);
                    session.native_synced_at = Some(synced_at);
                }
            }
        }
        sessions
    }

    pub fn list_agent_source_sync_states(&self) -> Result<Vec<AgentSourceSyncState>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let mut statement = connection.prepare("SELECT agent_type, last_checked_at, last_synced_at, status, last_error, scanned_count, changed_count, failed_count FROM agent_source_sync_state ORDER BY agent_type")?;
        let rows = statement.query_map([], |row| {
            Ok(AgentSourceSyncState {
                agent_type: row.get(0)?,
                last_checked_at: row.get(1)?,
                last_synced_at: row.get(2)?,
                status: row.get(3)?,
                last_error: row.get(4)?,
                scanned_count: row.get(5)?,
                changed_count: row.get(6)?,
                failed_count: row.get(7)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// 定时触发的 Body 清理任务：过期清理 + 超限清理，结果写入 background_jobs。
    /// 返回 (job_id, expired_cleared, pruned, before_bytes, after_bytes)。
    pub fn run_scheduled_body_cleanup_job(
        &self,
        config_path: &std::path::Path,
    ) -> Result<(String, usize, usize, i64, i64), StorageError> {
        use crate::core::proxy::extract_log_capture;
        use crate::core::proxy::read_config_raw;

        let capture = read_config_raw(config_path)
            .and_then(|json| serde_json::from_str::<serde_json::Value>(&json).ok())
            .map(|value| extract_log_capture(&value))
            .unwrap_or_default();

        let job_id = uuid::Uuid::new_v4().to_string();
        self.create_job(
            &job_id,
            "body-cleanup",
            "Body 清理",
            "按保留策略自动清理过期与超限的请求/响应 Body",
            "scheduled",
            4,
            "开始按保留策略自动清理请求与响应 Body",
        )?;

        let before_bytes = self.get_total_body_size_bytes().unwrap_or(0);

        // 第一步：每轮小批量搬迁旧 SQLite Body。新文件引用提交后才清空旧列，
        // 中断时未完成的记录会在下一轮继续，不阻塞代理启动。
        let migrated = match self.migrate_legacy_body_data(200) {
            Ok(count) => {
                let _ = self.add_job_event(
                    &job_id,
                    "info",
                    "旧数据迁移",
                    &format!("本轮已把 {count} 条旧 SQLite Body 搬迁到请求明细文件"),
                );
                count
            }
            Err(error) => {
                let _ = self.add_job_event(
                    &job_id,
                    "warning",
                    "旧数据迁移",
                    &format!("旧 Body 搬迁失败：{error}"),
                );
                0
            }
        };
        self.update_job_progress(&job_id, 1, 4)?;

        // 第二步：过期清理（超过保留天数的 Body 自动清除）
        let expired_cleared = match self.cleanup_expired_body_data(capture.body_retention_days) {
            Ok(n) => {
                let _ = self.add_job_event(
                    &job_id,
                    "info",
                    "过期清理",
                    &format!(
                        "保留策略 {} 天，已自动清理 {} 条过期 Body",
                        capture.body_retention_days, n
                    ),
                );
                n
            }
            Err(error) => {
                let _ = self.add_job_event(
                    &job_id,
                    "warning",
                    "过期清理",
                    &format!("过期清理失败：{error}"),
                );
                0
            }
        };
        self.update_job_progress(&job_id, 2, 4)?;

        // 第三步：超限清理（体积超过上限时，只清理至少一小时前的完整记录）。
        // 最近一小时是安全窗口；若近期数据自身超过上限，允许暂时超限。
        let mut pruned = 0usize;
        if capture.body_max_size_mb > 0 {
            let max_bytes = capture.body_max_size_mb * 1024 * 1024;
            let current = self.get_total_body_size_bytes().unwrap_or(0);
            if current >= max_bytes {
                // 安全兜底：最多循环 50 轮（远超正常需求，避免意外死循环）
                match self.prune_oldest_body_data_to_goal(max_bytes, capture.body_prune_ratio, 50) {
                    Ok(n) => {
                        pruned = n;
                        let after = self.get_total_body_size_bytes().unwrap_or(0);
                        let _ = self.add_job_event(
                            &job_id,
                            "info",
                            "超限清理",
                            &format!(
                                "体积 {} MB 超过上限 {} MB，保留最近 1 小时并按最老优先清理 {} 条后为 {} MB",
                                current / 1024 / 1024,
                                capture.body_max_size_mb,
                                n,
                                after / 1024 / 1024
                            ),
                        );
                    }
                    Err(error) => {
                        let _ = self.add_job_event(
                            &job_id,
                            "warning",
                            "超限清理",
                            &format!("超限清理失败：{error}"),
                        );
                    }
                }
            } else {
                let _ = self.add_job_event(
                    &job_id,
                    "info",
                    "超限清理",
                    &format!(
                        "当前体积 {} MB 未超上限 {} MB，无需清理",
                        current / 1024 / 1024,
                        capture.body_max_size_mb
                    ),
                );
            }
        } else {
            let _ = self.add_job_event(&job_id, "info", "超限清理", "体积上限设为 0（不限制），跳过");
        }
        self.update_job_progress(&job_id, 3, 4)?;

        // 第四步：新库或已执行过一次完整优化的旧库，按固定上限增量归还磁盘页。
        // 旧库 auto_vacuum=NONE 时安全跳过，由设置页提示用户先执行一次完整优化。
        let incremental_reclaimed = match self.incremental_vacuum(
            super::storage_maintenance::SCHEDULED_INCREMENTAL_VACUUM_BYTES,
        ) {
            Ok(bytes) => {
                let message = match self.database_maintenance_stats() {
                    Ok(stats) if stats.auto_vacuum_mode == 2 => format!(
                        "本轮归还 {:.1} MB，剩余可回收 {:.1} MB",
                        bytes as f64 / 1048576.0,
                        stats.reclaimable_bytes as f64 / 1048576.0
                    ),
                    Ok(_) => {
                        "当前数据库尚未启用增量回收，请在设置页执行一次“优化存储”"
                            .to_string()
                    }
                    Err(error) => format!(
                        "本轮归还 {:.1} MB；读取剩余空间失败：{error}",
                        bytes as f64 / 1048576.0
                    ),
                };
                let _ = self.add_job_event(&job_id, "info", "空间回收", &message);
                bytes
            }
            Err(error) => {
                let _ = self.add_job_event(
                    &job_id,
                    "warning",
                    "空间回收",
                    &format!("增量回收失败：{error}"),
                );
                0
            }
        };
        self.update_job_progress(&job_id, 4, 4)?;

        let after_bytes = self.get_total_body_size_bytes().unwrap_or(0);
        let summary = serde_json::json!({
            "expiredCleared": expired_cleared,
            "legacyMigrated": migrated,
            "pruned": pruned,
            "beforeBytes": before_bytes,
            "afterBytes": after_bytes,
            "clearedBytes": (before_bytes - after_bytes).max(0),
            "retentionDays": capture.body_retention_days,
            "maxSizeMb": capture.body_max_size_mb,
            "pruneRatio": capture.body_prune_ratio,
            "incrementalReclaimedBytes": incremental_reclaimed,
        })
        .to_string();
        self.finish_job(
            &job_id,
            "succeeded",
            &summary,
            &format!(
                "Body 清理完成：过期 {} 条，超限 {} 条，清理前 {:.1} MB → 清理后 {:.1} MB",
                expired_cleared,
                pruned,
                before_bytes as f64 / 1048576.0,
                after_bytes as f64 / 1048576.0
            ),
        )?;

        Ok((job_id, expired_cleared, pruned, before_bytes, after_bytes))
    }

    pub fn list_background_jobs(
        &self,
        filter: BackgroundJobsFilter,
    ) -> Result<BackgroundJobsPage, StorageError> {
        let page = filter.page.max(1);
        let page_size = filter.page_size.clamp(1, 50);
        let offset = (page - 1) * page_size;
        let status = filter.status.trim();
        let job_type = filter.job_type.trim();
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let total = connection.query_row("SELECT COUNT(*) FROM background_jobs WHERE (?1 = '' OR status = ?1) AND (?2 = '' OR job_type = ?2)", params![status, job_type], |row| row.get(0))?;
        let mut stmt = connection.prepare("SELECT id, job_type, title, trigger_source, status, stage, progress_current, progress_total, summary_json, error_message, created_at, started_at, finished_at, updated_at, cancel_requested FROM background_jobs WHERE (?1 = '' OR status = ?1) AND (?2 = '' OR job_type = ?2) ORDER BY created_at DESC LIMIT ?3 OFFSET ?4")?;
        let rows = stmt
            .query_map(params![status, job_type, page_size, offset], map_job)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(BackgroundJobsPage {
            rows,
            total,
            page,
            page_size,
        })
    }

    pub fn cleanup_background_jobs(
        &self,
        keep_days: u32,
    ) -> Result<CleanupBackgroundJobsResult, StorageError> {
        let keep_days = keep_days.clamp(1, 3650);
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let deleted_events = connection.execute("DELETE FROM background_job_events WHERE job_id IN (SELECT id FROM background_jobs WHERE status NOT IN ('queued', 'running') AND created_at < datetime('now', ?1))", [format!("-{keep_days} days")])?;
        let deleted_jobs = connection.execute("DELETE FROM background_jobs WHERE status NOT IN ('queued', 'running') AND created_at < datetime('now', ?1)", [format!("-{keep_days} days")])?;
        Ok(CleanupBackgroundJobsResult {
            deleted_jobs,
            deleted_events,
        })
    }

    pub fn request_background_job_cancel(&self, id: &str) -> Result<bool, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        Ok(connection.execute("UPDATE background_jobs SET cancel_requested=1, stage='正在取消', updated_at=datetime('now') WHERE id=?1 AND status IN ('queued', 'running')", [id])? > 0)
    }

    pub fn get_background_job_detail(
        &self,
        id: &str,
    ) -> Result<Option<BackgroundJobDetail>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let job = connection.query_row("SELECT id, job_type, title, trigger_source, status, stage, progress_current, progress_total, summary_json, error_message, created_at, started_at, finished_at, updated_at, cancel_requested FROM background_jobs WHERE id = ?1", [id], map_job).optional()?;
        let Some(job) = job else { return Ok(None) };
        let mut stmt = connection.prepare("SELECT id, job_id, sequence, level, stage, message, detail_json, created_at FROM background_job_events WHERE job_id = ?1 ORDER BY sequence")?;
        let events = stmt
            .query_map([id], |row| {
                Ok(BackgroundJobEvent {
                    id: row.get(0)?,
                    job_id: row.get(1)?,
                    sequence: row.get(2)?,
                    level: row.get(3)?,
                    stage: row.get(4)?,
                    message: row.get(5)?,
                    detail_json: row.get(6)?,
                    created_at: row.get(7)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Some(BackgroundJobDetail { job, events }))
    }

    pub fn sync_agent_data(
        &self,
        force: bool,
        trigger: &str,
    ) -> Result<AgentDataSyncResult, StorageError> {
        let total_started = Instant::now();
        let scan_started = Instant::now();
        let sessions = crate::core::agent_session_metadata::list_native_agent_sessions();
        let available_sources = crate::core::agent_session_metadata::available_native_agent_types();
        let scan_ms = scan_started.elapsed().as_millis() as u64;
        let compare_started = Instant::now();
        let (changed, deleted) = {
            let connection = self
                .connection
                .lock()
                .map_err(|_| StorageError::LockFailed)?;
            let mut changed = Vec::new();
            let current_keys = sessions
                .iter()
                .map(|session| (session.agent_type.clone(), session.session_id.clone()))
                .collect::<std::collections::HashSet<_>>();
            let stored_keys = {
                let mut statement = connection
                    .prepare("SELECT agent_type, session_id FROM agent_session_snapshots")?;
                let rows = statement
                    .query_map([], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                rows
            };
            let deleted = stored_keys
                .into_iter()
                .filter(|key| available_sources.contains(&key.0) && !current_keys.contains(key))
                .collect::<Vec<_>>();
            for session in &sessions {
                let fingerprint = format!(
                    "{}|{}|{}|{}",
                    session.native_updated_at.as_deref().unwrap_or(""),
                    session.activity_at,
                    session.title.as_deref().unwrap_or(""),
                    session.project_path.as_deref().unwrap_or("")
                );
                let existing: Option<(String, i64)> = connection.query_row("SELECT fingerprint, parser_version FROM agent_session_snapshots WHERE agent_type = ?1 AND session_id = ?2", params![session.agent_type, session.session_id], |row| Ok((row.get(0)?, row.get(1)?))).optional()?;
                if needs_agent_snapshot_refresh(force, &fingerprint, existing.as_ref()) {
                    changed.push((session.clone(), fingerprint));
                }
            }
            (changed, deleted)
        };
        let compare_ms = compare_started.elapsed().as_millis() as u64;
        self.update_source_states_checked(&sessions, &changed, &[])?;
        if changed.is_empty() && deleted.is_empty() {
            return Ok(AgentDataSyncResult {
                started: false,
                job_id: None,
                scanned: sessions.len(),
                changed: 0,
                failed: 0,
                message: "没有发现需要整理的会话变化".into(),
            });
        }
        let (changed, deferred) = limit_sync_batch(changed, force);
        let job_id = uuid::Uuid::new_v4().to_string();
        let total = changed.len() + deleted.len();
        self.create_job(
            &job_id,
            "agent-data-sync",
            "Agent 数据同步",
            "扫描并整理会话",
            trigger,
            total,
            &format!("发现 {total} 个需要整理的会话"),
        )?;
        let result = self.run_agent_sync_job(
            &job_id,
            &sessions,
            &changed,
            &deleted,
            deferred,
            scan_ms,
            compare_ms,
            total_started,
        );
        if let Err(error) = &result {
            let _ = self.fail_job(&job_id, &error.to_string());
        }
        result
    }

    #[allow(clippy::too_many_arguments)]
    fn run_agent_sync_job(
        &self,
        job_id: &str,
        sessions: &[super::super::config::AgentSessionRow],
        changed: &[(super::super::config::AgentSessionRow, String)],
        deleted: &[(String, String)],
        deferred: usize,
        scan_ms: u64,
        compare_ms: u64,
        total_started: Instant,
    ) -> Result<AgentDataSyncResult, StorageError> {
        self.run_agent_sync_job_with_parser(
            job_id,
            sessions,
            changed,
            deleted,
            deferred,
            scan_ms,
            compare_ms,
            total_started,
            parse_agent_session_with_timeout,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn run_agent_sync_job_with_parser<F>(
        &self,
        job_id: &str,
        sessions: &[super::super::config::AgentSessionRow],
        changed: &[(super::super::config::AgentSessionRow, String)],
        deleted: &[(String, String)],
        deferred: usize,
        scan_ms: u64,
        compare_ms: u64,
        total_started: Instant,
        parser: F,
    ) -> Result<AgentDataSyncResult, StorageError>
    where
        F: Fn(
            &str,
            &str,
            Option<AgentSessionSummaryCheckpoint>,
        ) -> Result<AgentSessionSummaryParseResult, String>,
    {
        let mut failed = 0usize;
        let mut failures = Vec::new();
        let mut parse_ms = 0u64;
        let mut write_ms = 0u64;
        let mut slow_sessions = Vec::new();
        let mut incremental_sessions = 0usize;
        let mut full_sessions = 0usize;
        let mut source_bytes_processed = 0u64;
        for (index, (session, fingerprint)) in changed.iter().enumerate() {
            if self.is_job_cancel_requested(job_id)? {
                let summary = serde_json::json!({ "scanned": sessions.len(), "processed": index, "deferred": deferred + changed.len() - index, "durationMs": total_started.elapsed().as_millis() }).to_string();
                self.finish_job(job_id, "cancelled", &summary, "Agent 数据同步已取消")?;
                return Ok(AgentDataSyncResult {
                    started: true,
                    job_id: Some(job_id.to_string()),
                    scanned: sessions.len(),
                    changed: index,
                    failed,
                    message: "Agent 数据同步已取消".into(),
                });
            }
            let parse_started = Instant::now();
            let checkpoint =
                self.load_agent_summary_checkpoint(&session.agent_type, &session.session_id)?;
            let parsed = parser(&session.agent_type, &session.session_id, checkpoint);
            let session_duration = parse_started.elapsed();
            parse_ms += session_duration.as_millis() as u64;
            if session_duration >= SLOW_SESSION_THRESHOLD {
                slow_sessions.push(serde_json::json!({ "agentType": session.agent_type, "sessionId": session.session_id, "durationMs": session_duration.as_millis() }));
                self.add_job_event(
                    job_id,
                    "warning",
                    "慢会话",
                    &format!(
                        "{} 解析耗时 {} ms",
                        session.session_id,
                        session_duration.as_millis()
                    ),
                )?;
            }
            if self.is_job_cancel_requested(job_id)? {
                let summary = serde_json::json!({ "scanned": sessions.len(), "processed": index, "deferred": deferred + changed.len() - index, "durationMs": total_started.elapsed().as_millis() }).to_string();
                self.finish_job(job_id, "cancelled", &summary, "Agent 数据同步已取消")?;
                return Ok(AgentDataSyncResult {
                    started: true,
                    job_id: Some(job_id.to_string()),
                    scanned: sessions.len(),
                    changed: index,
                    failed,
                    message: "Agent 数据同步已取消".into(),
                });
            }
            match parsed {
                Ok(parsed) => {
                    source_bytes_processed =
                        source_bytes_processed.saturating_add(parsed.bytes_processed);
                    if parsed.incremental {
                        incremental_sessions += 1;
                        self.add_job_event(
                            job_id,
                            "info",
                            "增量解析",
                            &format!(
                                "{} 仅读取新增的 {} 字节",
                                session.session_id, parsed.bytes_processed
                            ),
                        )?;
                    } else {
                        full_sessions += 1;
                    }
                    let write_started = Instant::now();
                    self.save_agent_snapshot(
                        &session.agent_type,
                        &session.session_id,
                        fingerprint,
                        &parsed,
                    )?;
                    write_ms += write_started.elapsed().as_millis() as u64;
                }
                Err(error) => {
                    failed += 1;
                    failures.push((session.agent_type.clone(), error.clone()));
                    self.add_job_event(
                        job_id,
                        "warning",
                        "解析会话",
                        &format!("{} 整理失败：{}", session.session_id, error),
                    )?;
                }
            }
            self.update_job_progress(
                job_id,
                (index + 1) as i64,
                (changed.len() + deleted.len()) as i64,
            )?;
        }
        for (offset, (agent_type, session_id)) in deleted.iter().enumerate() {
            if self.is_job_cancel_requested(job_id)? {
                let processed = changed.len() + offset;
                let summary = serde_json::json!({ "scanned": sessions.len(), "processed": processed, "deferred": deferred + deleted.len() - offset, "durationMs": total_started.elapsed().as_millis() }).to_string();
                self.finish_job(job_id, "cancelled", &summary, "Agent 数据同步已取消")?;
                return Ok(AgentDataSyncResult {
                    started: true,
                    job_id: Some(job_id.to_string()),
                    scanned: sessions.len(),
                    changed: changed.len(),
                    failed,
                    message: "Agent 数据同步已取消".into(),
                });
            }
            self.delete_agent_snapshot(agent_type, session_id)?;
            self.update_job_progress(
                job_id,
                (changed.len() + offset + 1) as i64,
                (changed.len() + deleted.len()) as i64,
            )?;
        }
        self.update_source_states_checked(&sessions, &changed, &failures)?;
        let status = if failed == 0 {
            "succeeded"
        } else {
            "succeeded_with_warnings"
        };
        let summary = serde_json::json!({
            "scanned": sessions.len(), "changed": changed.len(), "deleted": deleted.len(), "failed": failed,
            "deferred": deferred, "scanMs": scan_ms, "compareMs": compare_ms, "parseMs": parse_ms,
            "writeMs": write_ms, "durationMs": total_started.elapsed().as_millis() as u64, "slowSessions": slow_sessions,
            "incrementalSessions": incremental_sessions, "fullSessions": full_sessions,
            "sourceBytesProcessed": source_bytes_processed,
        }).to_string();
        self.finish_job(job_id, status, &summary, "Agent 数据同步完成")?;
        Ok(AgentDataSyncResult {
            started: true,
            job_id: Some(job_id.to_string()),
            scanned: sessions.len(),
            changed: changed.len(),
            failed,
            message: if failed == 0 {
                format!(
                    "已整理 {} 个会话，清理 {} 个失效快照",
                    changed.len(),
                    deleted.len()
                )
            } else {
                format!("已整理 {} 个会话，其中 {} 个失败", changed.len(), failed)
            },
        })
    }

    pub(crate) fn create_job(
        &self,
        id: &str,
        job_type: &str,
        title: &str,
        stage: &str,
        trigger: &str,
        total: usize,
        first_event_message: &str,
    ) -> Result<(), StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        connection.execute("INSERT INTO background_jobs (id, job_type, title, trigger_source, status, stage, progress_total, created_at, started_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'running', ?5, ?6, datetime('now'), datetime('now'), datetime('now'))", params![id, job_type, title, trigger, stage, total as i64])?;
        connection.execute("INSERT INTO background_job_events (id, job_id, sequence, level, stage, message, created_at) VALUES (?1, ?2, 1, 'info', ?3, ?4, datetime('now'))", params![uuid::Uuid::new_v4().to_string(), id, stage, first_event_message])?;
        Ok(())
    }
    fn save_agent_snapshot(
        &self,
        agent_type: &str,
        session_id: &str,
        fingerprint: &str,
        parsed: &AgentSessionSummaryParseResult,
    ) -> Result<(), StorageError> {
        let json = serde_json::to_string(&parsed.summary)
            .map_err(|e| StorageError::InvalidImport(e.to_string()))?;
        let usage_ids_json = serde_json::to_string(&parsed.usage_ids)
            .map_err(|e| StorageError::InvalidImport(e.to_string()))?;
        let stored_fingerprint = if parsed.complete {
            fingerprint.to_string()
        } else {
            format!("{fingerprint}|partial:{}", parsed.source_offset)
        };
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        connection.execute("INSERT INTO agent_session_snapshots (agent_type, session_id, fingerprint, summary_json, source_offset, parser_version, usage_ids_json, cursor_guard, synced_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, datetime('now')) ON CONFLICT(agent_type, session_id) DO UPDATE SET fingerprint=excluded.fingerprint, summary_json=excluded.summary_json, source_offset=excluded.source_offset, parser_version=excluded.parser_version, usage_ids_json=excluded.usage_ids_json, cursor_guard=excluded.cursor_guard, synced_at=excluded.synced_at", params![agent_type, session_id, stored_fingerprint, json, parsed.source_offset as i64, parsed.parser_version, usage_ids_json, parsed.cursor_guard])?;
        Ok(())
    }

    fn load_agent_summary_checkpoint(
        &self,
        agent_type: &str,
        session_id: &str,
    ) -> Result<Option<AgentSessionSummaryCheckpoint>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let stored = connection
            .query_row(
                "SELECT summary_json, source_offset, parser_version, usage_ids_json, cursor_guard FROM agent_session_snapshots WHERE agent_type=?1 AND session_id=?2",
                params![agent_type, session_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                    ))
                },
            )
            .optional()?;
        let Some((summary_json, source_offset, parser_version, usage_ids_json, cursor_guard)) =
            stored
        else {
            return Ok(None);
        };
        let Ok(summary) = serde_json::from_str(&summary_json) else {
            return Ok(None);
        };
        let Ok(usage_ids) = serde_json::from_str(&usage_ids_json) else {
            return Ok(None);
        };
        Ok(Some(AgentSessionSummaryCheckpoint {
            summary,
            source_offset: source_offset.max(0) as u64,
            parser_version,
            usage_ids,
            cursor_guard,
        }))
    }
    fn delete_agent_snapshot(
        &self,
        agent_type: &str,
        session_id: &str,
    ) -> Result<(), StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        connection.execute(
            "DELETE FROM agent_session_snapshots WHERE agent_type=?1 AND session_id=?2",
            params![agent_type, session_id],
        )?;
        Ok(())
    }
    fn update_source_states_checked(
        &self,
        sessions: &[super::super::config::AgentSessionRow],
        changed: &[(super::super::config::AgentSessionRow, String)],
        failures: &[(String, String)],
    ) -> Result<(), StorageError> {
        let mut agent_types = crate::core::agent_session_metadata::available_native_agent_types();
        agent_types.extend(sessions.iter().map(|session| session.agent_type.clone()));
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        for agent_type in agent_types {
            let scanned = sessions
                .iter()
                .filter(|session| session.agent_type == agent_type)
                .count() as i64;
            let changed_count = changed
                .iter()
                .filter(|(session, _)| session.agent_type == agent_type)
                .count() as i64;
            let errors = failures
                .iter()
                .filter(|(source, _)| source == &agent_type)
                .map(|(_, error)| error.clone())
                .collect::<Vec<_>>();
            let status = if errors.is_empty() {
                "succeeded"
            } else {
                "warning"
            };
            let last_error = if errors.is_empty() {
                None
            } else {
                Some(errors.join("；"))
            };
            connection.execute("INSERT INTO agent_source_sync_state (agent_type, last_checked_at, last_synced_at, status, last_error, scanned_count, changed_count, failed_count, updated_at) VALUES (?1, datetime('now'), CASE WHEN (?3 - ?6) > 0 THEN datetime('now') ELSE NULL END, ?2, ?4, ?5, ?3, ?6, datetime('now')) ON CONFLICT(agent_type) DO UPDATE SET last_checked_at=excluded.last_checked_at, last_synced_at=COALESCE(excluded.last_synced_at, agent_source_sync_state.last_synced_at), status=excluded.status, last_error=excluded.last_error, scanned_count=excluded.scanned_count, changed_count=excluded.changed_count, failed_count=excluded.failed_count, updated_at=excluded.updated_at", params![agent_type, status, changed_count, last_error, scanned, errors.len() as i64])?;
        }
        Ok(())
    }
    pub(crate) fn add_job_event(
        &self,
        job_id: &str,
        level: &str,
        stage: &str,
        message: &str,
    ) -> Result<(), StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let seq: i64 = connection.query_row(
            "SELECT COALESCE(MAX(sequence), 0) + 1 FROM background_job_events WHERE job_id=?1",
            [job_id],
            |row| row.get(0),
        )?;
        connection.execute("INSERT INTO background_job_events (id, job_id, sequence, level, stage, message, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now'))", params![uuid::Uuid::new_v4().to_string(), job_id, seq, level, stage, message])?;
        Ok(())
    }
    pub(crate) fn update_job_progress(
        &self,
        id: &str,
        current: i64,
        total: i64,
    ) -> Result<(), StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        connection.execute("UPDATE background_jobs SET progress_current=?2, progress_total=?3, updated_at=datetime('now') WHERE id=?1", params![id,current,total])?;
        Ok(())
    }
    fn is_job_cancel_requested(&self, id: &str) -> Result<bool, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        Ok(connection
            .query_row(
                "SELECT cancel_requested FROM background_jobs WHERE id=?1",
                [id],
                |row| row.get(0),
            )
            .optional()?
            .unwrap_or(false))
    }
    pub(crate) fn fail_job(&self, id: &str, error: &str) -> Result<(), StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        connection.execute("UPDATE background_jobs SET status='failed', stage='失败', error_message=?2, finished_at=datetime('now'), updated_at=datetime('now') WHERE id=?1", params![id, error])?;
        drop(connection);
        self.add_job_event(id, "error", "失败", error)
    }
    pub(crate) fn finish_job(
        &self,
        id: &str,
        status: &str,
        summary: &str,
        done_message: &str,
    ) -> Result<(), StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let stage = if status == "cancelled" {
            "已取消"
        } else {
            "完成"
        };
        connection.execute("UPDATE background_jobs SET status=?2, stage=?4, summary_json=?3, finished_at=datetime('now'), updated_at=datetime('now') WHERE id=?1", params![id,status,summary,stage])?;
        drop(connection);
        self.add_job_event(
            id,
            if status == "succeeded" {
                "success"
            } else if status == "cancelled" {
                "info"
            } else {
                "warning"
            },
            stage,
            done_message,
        )
    }
}

fn map_job(row: &rusqlite::Row<'_>) -> rusqlite::Result<BackgroundJobRow> {
    Ok(BackgroundJobRow {
        id: row.get(0)?,
        job_type: row.get(1)?,
        title: row.get(2)?,
        trigger_source: row.get(3)?,
        status: row.get(4)?,
        stage: row.get(5)?,
        progress_current: row.get(6)?,
        progress_total: row.get(7)?,
        summary_json: row.get(8)?,
        error_message: row.get(9)?,
        created_at: row.get(10)?,
        started_at: row.get(11)?,
        finished_at: row.get(12)?,
        updated_at: row.get(13)?,
        cancel_requested: row.get(14)?,
    })
}

fn parse_agent_session_with_timeout(
    agent_type: &str,
    session_id: &str,
    checkpoint: Option<AgentSessionSummaryCheckpoint>,
) -> Result<AgentSessionSummaryParseResult, String> {
    let agent_type = agent_type.to_string();
    let session_id = session_id.to_string();
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let result =
            crate::core::agent_session_timeline::get_native_agent_session_summary_incremental(
                &agent_type,
                &session_id,
                checkpoint,
            );
        let _ = sender.send(result);
    });
    receiver
        .recv_timeout(SESSION_PARSE_TIMEOUT)
        .map_err(|_| format!("会话解析超过 {} 秒", SESSION_PARSE_TIMEOUT.as_secs()))?
}

fn limit_sync_batch(
    mut changed: Vec<(super::super::config::AgentSessionRow, String)>,
    force: bool,
) -> (Vec<(super::super::config::AgentSessionRow, String)>, usize) {
    changed.sort_by(|(left, _), (right, _)| {
        crate::core::agent_session_metadata::session_time_millis(&right.activity_at).cmp(
            &crate::core::agent_session_metadata::session_time_millis(&left.activity_at),
        )
    });
    let batch_limit = if force {
        MAX_MANUAL_SYNC_SESSIONS
    } else {
        MAX_AUTO_SYNC_SESSIONS
    };
    let deferred = changed.len().saturating_sub(batch_limit);
    changed.truncate(batch_limit);
    (changed, deferred)
}

fn needs_agent_snapshot_refresh(
    force: bool,
    fingerprint: &str,
    existing: Option<&(String, i64)>,
) -> bool {
    force
        || existing.is_none()
        || existing.is_some_and(|(stored_fingerprint, parser_version)| {
            stored_fingerprint != fingerprint
                || *parser_version
                    != crate::core::agent_session_timeline::AGENT_SUMMARY_PARSER_VERSION
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::config::AgentSessionRow;
    use rusqlite::Connection;

    fn native_session() -> AgentSessionRow {
        AgentSessionRow {
            agent_type: "opencode".into(),
            session_id: "session-1".into(),
            title: Some("Task".into()),
            project_path: None,
            parent_session_id: None,
            client_id: None,
            client_name: None,
            native_started_at: None,
            native_updated_at: Some("2026-07-19T08:00:00Z".into()),
            activity_at: "2026-07-19T08:00:00Z".into(),
            flowlet_observed: false,
            started_at: "2026-07-19T08:00:00Z".into(),
            updated_at: "2026-07-19T08:00:00Z".into(),
            request_count: 0,
            success_count: 0,
            error_count: 0,
            known_tokens: 0,
            input_tokens: 0,
            input_cached_tokens: 0,
            input_uncached_tokens: 0,
            cache_measured_input_tokens: 0,
            output_tokens: 0,
            unknown_usage_count: 0,
            estimated_cost: 0.0,
            native_summary: None,
            native_synced_at: None,
        }
    }

    #[test]
    fn enriches_native_catalog_from_persisted_snapshot_and_accepts_legacy_json() {
        let storage = Storage::from_connection_for_test(Connection::open_in_memory().unwrap());
        storage.migrate().unwrap();
        storage.connection.lock().unwrap().execute(
            "INSERT INTO agent_session_snapshots (agent_type, session_id, fingerprint, summary_json, synced_at) VALUES ('opencode', 'session-1', 'fp', '{\"sourceAvailable\":true,\"truncated\":false,\"turnCount\":3,\"usage\":null}', '2026-07-19 08:01:00')", [],
        ).unwrap();
        let rows = storage.enrich_native_agent_sessions(vec![native_session()]);
        assert_eq!(rows[0].native_summary.as_ref().unwrap().turn_count, 3);
        assert!(rows[0].native_summary.as_ref().unwrap().models.is_empty());
        assert_eq!(
            rows[0].native_synced_at.as_deref(),
            Some("2026-07-19 08:01:00")
        );
        let checkpoint = storage
            .load_agent_summary_checkpoint("opencode", "session-1")
            .unwrap()
            .unwrap();
        assert_eq!(checkpoint.source_offset, 0);
        assert_eq!(checkpoint.parser_version, 0);
    }

    #[test]
    fn persists_incremental_summary_cursor_without_message_content() {
        let storage = Storage::from_connection_for_test(Connection::open_in_memory().unwrap());
        storage.migrate().unwrap();
        let parsed = AgentSessionSummaryParseResult {
            summary: AgentSessionNativeSummary {
                source_available: true,
                truncated: false,
                turn_count: 2,
                usage: None,
                models: vec!["gpt-test".into()],
            },
            source_offset: 2048,
            parser_version: crate::core::agent_session_timeline::AGENT_SUMMARY_PARSER_VERSION,
            usage_ids: vec!["usage-1".into()],
            cursor_guard: "guard-1".into(),
            complete: true,
            incremental: true,
            bytes_processed: 256,
        };
        storage
            .save_agent_snapshot("codex-desktop", "session-1", "fingerprint", &parsed)
            .unwrap();
        let checkpoint = storage
            .load_agent_summary_checkpoint("codex-desktop", "session-1")
            .unwrap()
            .unwrap();
        assert_eq!(checkpoint.source_offset, 2048);
        assert_eq!(checkpoint.parser_version, parsed.parser_version);
        assert_eq!(checkpoint.usage_ids, vec!["usage-1"]);
        assert_eq!(checkpoint.cursor_guard, "guard-1");
        let stored: (String, String) = storage
            .connection
            .lock()
            .unwrap()
            .query_row(
                "SELECT summary_json, usage_ids_json FROM agent_session_snapshots WHERE session_id='session-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert!(!stored.0.contains("message"));
        assert!(!stored.1.contains("message"));
    }

    #[test]
    fn persists_and_lists_task_progress_and_events() {
        let storage = Storage::from_connection_for_test(Connection::open_in_memory().unwrap());
        storage.migrate().unwrap();
        storage
            .create_job(
                "job-1",
                "agent-data-sync",
                "Agent 数据同步",
                "扫描并整理会话",
                "manual",
                2,
                "发现 2 个需要整理的会话",
            )
            .unwrap();
        storage.update_job_progress("job-1", 1, 2).unwrap();
        storage
            .finish_job("job-1", "succeeded", "{}", "Agent 数据同步完成")
            .unwrap();
        let detail = storage.get_background_job_detail("job-1").unwrap().unwrap();
        assert_eq!(detail.job.status, "succeeded");
        assert_eq!(detail.job.progress_current, 1);
        assert_eq!(detail.events.len(), 2);
    }

    #[test]
    fn paginates_filters_cancels_and_cleans_completed_tasks() {
        let storage = Storage::from_connection_for_test(Connection::open_in_memory().unwrap());
        storage.migrate().unwrap();
        storage
            .create_job(
                "running",
                "agent-data-sync",
                "Agent 数据同步",
                "扫描并整理会话",
                "manual",
                2,
                "发现 2 个需要整理的会话",
            )
            .unwrap();
        storage
            .create_job(
                "finished",
                "agent-data-sync",
                "Agent 数据同步",
                "扫描并整理会话",
                "foreground",
                1,
                "发现 1 个需要整理的会话",
            )
            .unwrap();
        storage
            .finish_job("finished", "succeeded", "{}", "Agent 数据同步完成")
            .unwrap();

        let running = storage
            .list_background_jobs(BackgroundJobsFilter {
                page: 1,
                page_size: 10,
                status: "running".into(),
                job_type: "agent-data-sync".into(),
            })
            .unwrap();
        assert_eq!(running.total, 1);
        assert_eq!(running.rows[0].id, "running");
        assert!(storage.request_background_job_cancel("running").unwrap());
        assert!(
            storage
                .get_background_job_detail("running")
                .unwrap()
                .unwrap()
                .job
                .cancel_requested
        );

        storage.connection.lock().unwrap().execute("UPDATE background_jobs SET created_at=datetime('now', '-100 days') WHERE id='finished'", []).unwrap();
        let cleaned = storage.cleanup_background_jobs(90).unwrap();
        assert_eq!(cleaned.deleted_jobs, 1);
        assert_eq!(cleaned.deleted_events, 2);
        assert!(storage
            .get_background_job_detail("finished")
            .unwrap()
            .is_none());
    }

    #[test]
    fn filters_and_completes_codex_account_sync_jobs_separately() {
        let storage = Storage::from_connection_for_test(Connection::open_in_memory().unwrap());
        storage.migrate().unwrap();
        storage
            .create_job(
                "codex-job",
                "codex-account-sync",
                "Codex 账号与用量同步",
                "查询账号与用量",
                "background",
                0,
                "开始查询 Codex 账号与用量",
            )
            .unwrap();
        storage.update_job_progress("codex-job", 2, 2).unwrap();
        storage
            .add_job_event(
                "codex-job",
                "warning",
                "账号刷新失败",
                "user@example.com：官方用量接口返回 HTTP 401",
            )
            .unwrap();
        storage
            .finish_job(
                "codex-job",
                "succeeded_with_warnings",
                "{\"accounts\":2,\"stale\":1,\"failed\":1}",
                "Codex 账号与用量同步完成",
            )
            .unwrap();

        let codex_jobs = storage
            .list_background_jobs(BackgroundJobsFilter {
                page: 1,
                page_size: 10,
                status: "".into(),
                job_type: "codex-account-sync".into(),
            })
            .unwrap();
        assert_eq!(codex_jobs.total, 1);
        assert_eq!(codex_jobs.rows[0].title, "Codex 账号与用量同步");
        assert_eq!(codex_jobs.rows[0].trigger_source, "background");
        let agent_jobs = storage
            .list_background_jobs(BackgroundJobsFilter {
                page: 1,
                page_size: 10,
                status: "".into(),
                job_type: "agent-data-sync".into(),
            })
            .unwrap();
        assert_eq!(agent_jobs.total, 0);
        let detail = storage
            .get_background_job_detail("codex-job")
            .unwrap()
            .unwrap();
        assert_eq!(detail.job.status, "succeeded_with_warnings");
        assert!(detail
            .events
            .iter()
            .any(|event| event.stage.as_deref() == Some("账号刷新失败")));
    }

    #[test]
    fn limits_automatic_batches_and_prioritizes_recent_sessions() {
        let changed = (0..25)
            .map(|index| {
                let mut session = native_session();
                session.session_id = format!("session-{index}");
                session.activity_at = format!("2026-07-19T08:{index:02}:00Z");
                (session, format!("fp-{index}"))
            })
            .collect();
        let (automatic, deferred) = limit_sync_batch(changed, false);
        assert_eq!(automatic.len(), MAX_AUTO_SYNC_SESSIONS);
        assert_eq!(deferred, 25 - MAX_AUTO_SYNC_SESSIONS);
        assert_eq!(automatic[0].0.session_id, "session-24");
    }

    #[test]
    fn refreshes_unchanged_snapshot_when_parser_version_changes() {
        let current = (
            "fingerprint".to_string(),
            crate::core::agent_session_timeline::AGENT_SUMMARY_PARSER_VERSION,
        );
        assert!(!needs_agent_snapshot_refresh(
            false,
            "fingerprint",
            Some(&current)
        ));
        let outdated = ("fingerprint".to_string(), current.1 - 1);
        assert!(needs_agent_snapshot_refresh(
            false,
            "fingerprint",
            Some(&outdated)
        ));
        assert!(needs_agent_snapshot_refresh(
            true,
            "fingerprint",
            Some(&current)
        ));
    }

    #[test]
    fn task_queries_and_cancel_remain_responsive_during_slow_parse() {
        let storage = Storage::from_connection_for_test(Connection::open_in_memory().unwrap());
        storage.migrate().unwrap();
        storage
            .create_job(
                "slow-job",
                "agent-data-sync",
                "Agent 数据同步",
                "扫描并整理会话",
                "manual",
                1,
                "发现 1 个需要整理的会话",
            )
            .unwrap();

        let session = native_session();
        let sessions = vec![session.clone()];
        let changed = vec![(session, "fingerprint".to_string())];
        let worker_storage = storage.clone();
        let (started_sender, started_receiver) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            worker_storage.run_agent_sync_job_with_parser(
                "slow-job",
                &sessions,
                &changed,
                &[],
                0,
                1,
                1,
                Instant::now(),
                move |_, _, _| {
                    started_sender.send(()).unwrap();
                    std::thread::sleep(Duration::from_millis(400));
                    Ok(AgentSessionSummaryParseResult {
                        summary: AgentSessionNativeSummary {
                            source_available: true,
                            truncated: false,
                            turn_count: 1,
                            usage: None,
                            models: Vec::new(),
                        },
                        source_offset: 10,
                        parser_version:
                            crate::core::agent_session_timeline::AGENT_SUMMARY_PARSER_VERSION,
                        usage_ids: Vec::new(),
                        cursor_guard: "guard".into(),
                        complete: true,
                        incremental: false,
                        bytes_processed: 10,
                    })
                },
            )
        });

        started_receiver
            .recv_timeout(Duration::from_secs(1))
            .unwrap();
        let query_started = Instant::now();
        let page = storage
            .list_background_jobs(BackgroundJobsFilter {
                page: 1,
                page_size: 10,
                status: "running".into(),
                job_type: "agent-data-sync".into(),
            })
            .unwrap();
        assert!(query_started.elapsed() < Duration::from_millis(250));
        assert_eq!(page.total, 1);
        assert!(storage.request_background_job_cancel("slow-job").unwrap());

        let result = worker.join().unwrap().unwrap();
        assert_eq!(result.message, "Agent 数据同步已取消");
        let detail = storage
            .get_background_job_detail("slow-job")
            .unwrap()
            .unwrap();
        assert_eq!(detail.job.status, "cancelled");
    }
}
