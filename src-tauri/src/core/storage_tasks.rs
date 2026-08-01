use super::super::config::AgentSessionNativeSummary;
use super::{Storage, StorageError};
use crate::core::agent_session_timeline::{
    AgentSessionSummaryCheckpoint, AgentSessionSummaryParseResult,
};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
#[cfg(desktop)]
use sha2::Digest;
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
    #[serde(default)]
    pub trigger_source: String,
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
            let _ = self.add_job_event(
                &job_id,
                "info",
                "超限清理",
                "体积上限设为 0（不限制），跳过",
            );
        }
        self.update_job_progress(&job_id, 3, 4)?;

        // 第四步：新库或已执行过一次完整优化的旧库，按固定上限增量归还磁盘页。
        // 旧库 auto_vacuum=NONE 时安全跳过，由设置页提示用户先执行一次完整优化。
        let incremental_reclaimed = match self
            .incremental_vacuum(super::storage_maintenance::SCHEDULED_INCREMENTAL_VACUUM_BYTES)
        {
            Ok(bytes) => {
                let message = match self.database_maintenance_stats() {
                    Ok(stats) if stats.auto_vacuum_mode == 2 => format!(
                        "本轮归还 {:.1} MB，剩余可回收 {:.1} MB",
                        bytes as f64 / 1048576.0,
                        stats.reclaimable_bytes as f64 / 1048576.0
                    ),
                    Ok(_) => "当前数据库尚未启用增量回收，请在设置页执行一次“优化存储”".to_string(),
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
        let trigger_source = filter.trigger_source.trim();
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let total = connection.query_row("SELECT COUNT(*) FROM background_jobs WHERE (?1 = '' OR status = ?1) AND (?2 = '' OR job_type = ?2) AND (?3 = '' OR trigger_source = ?3)", params![status, job_type, trigger_source], |row| row.get(0))?;
        let mut stmt = connection.prepare("SELECT id, job_type, title, trigger_source, status, stage, progress_current, progress_total, summary_json, error_message, created_at, started_at, finished_at, updated_at, cancel_requested FROM background_jobs WHERE (?1 = '' OR status = ?1) AND (?2 = '' OR job_type = ?2) AND (?3 = '' OR trigger_source = ?3) ORDER BY created_at DESC LIMIT ?4 OFFSET ?5")?;
        let rows = stmt
            .query_map(
                params![status, job_type, trigger_source, page_size, offset],
                map_job,
            )?
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
        // 判定哪些会话的「原生账本」应被排除（其用量已由代理侧覆盖）：
        // 1) 自身 id 出现在 request_logs（整会话经过 Flowlet）；
        // 2) 是子会话且其父 id 出现在 request_logs——子代理的调用经过 Flowlet 时
        //    会以父会话的 x-*-session-id 落库，子 id 在 request_logs 里没有记录，
        //    仅靠自身 id 匹配会漏排除而重复计数。
        // 父未观测的子会话（纯原生）不在此集合，照常计入原生账本。
        let observed = self.observed_agent_session_keys()?;
        let is_observed = |agent_type: &str, session_id: &str| -> bool {
            observed
                .get(agent_type)
                .is_some_and(|ids| ids.contains(session_id))
        };
        let subsumed: std::collections::HashSet<(String, String)> = sessions
            .iter()
            .filter(|session| {
                is_observed(&session.agent_type, &session.session_id)
                    || session
                        .parent_session_id
                        .as_deref()
                        .is_some_and(|parent| is_observed(&session.agent_type, parent))
            })
            .map(|session| (session.agent_type.clone(), session.session_id.clone()))
            .collect();
        let changed_keys: std::collections::HashSet<(String, String)> = changed
            .iter()
            .map(|(session, _)| (session.agent_type.clone(), session.session_id.clone()))
            .collect();
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
                    // 被代理覆盖的会话（自身观测，或子会话且父被观测）不记原生账本，
                    // 并清掉可能残留的旧事件；其余会话（含父未观测的原生子会话）照常记账。
                    if subsumed.contains(&(session.agent_type.clone(), session.session_id.clone()))
                    {
                        self.delete_agent_usage_events(
                            &session.agent_type,
                            &session.session_id,
                        )?;
                    } else {
                        self.save_agent_usage_events(
                            &session.agent_type,
                            &session.session_id,
                            &parsed,
                        )?;
                    }
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
        // 清理「本轮未变化、但其父已被观测」的子会话残留事件：它们不会进入 changed，
        // 上面的循环轮不到，必须在这里主动清除，否则旧事件会一直重复计数。
        for session in sessions {
            let key = (session.agent_type.clone(), session.session_id.clone());
            if session.parent_session_id.is_some()
                && subsumed.contains(&key)
                && !changed_keys.contains(&key)
            {
                self.delete_agent_usage_events(&session.agent_type, &session.session_id)?;
            }
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

    /// 将解析产出的消息级用量事件写入 agent_usage_events 账本。
    /// 增量解析只 INSERT 新事件（主键幂等）；全量重解析先清旧行再写入，
    /// 保证账本与本次全量结果严格一致（含文件被改写/压缩的场景）。
    fn save_agent_usage_events(
        &self,
        agent_type: &str,
        session_id: &str,
        parsed: &AgentSessionSummaryParseResult,
    ) -> Result<(), StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        if !parsed.incremental {
            connection.execute(
                "DELETE FROM agent_usage_events WHERE agent_type=?1 AND session_id=?2",
                params![agent_type, session_id],
            )?;
        }
        let mut statement = connection.prepare(
            "INSERT OR IGNORE INTO agent_usage_events (
                agent_type, session_id, event_id, event_time, model,
                input_tokens, cached_input_tokens, cache_write_input_tokens,
                output_tokens, reasoning_tokens, total_tokens, synced_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, datetime('now'))",
        )?;
        for event in &parsed.usage_events {
            statement.execute(params![
                agent_type,
                session_id,
                event.event_id,
                event.event_time,
                event.model,
                event.input_tokens,
                event.cached_input_tokens,
                event.cache_write_input_tokens,
                event.output_tokens,
                event.reasoning_tokens,
                event.total_tokens,
            ])?;
        }
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
        connection.execute(
            "DELETE FROM agent_usage_events WHERE agent_type=?1 AND session_id=?2",
            params![agent_type, session_id],
        )?;
        Ok(())
    }

    fn delete_agent_usage_events(
        &self,
        agent_type: &str,
        session_id: &str,
    ) -> Result<(), StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        connection.execute(
            "DELETE FROM agent_usage_events WHERE agent_type=?1 AND session_id=?2",
            params![agent_type, session_id],
        )?;
        Ok(())
    }

    /// 返回被 Flowlet 代理观测到的 (agent_type -> session_id 集合)：即 request_logs 里
    /// 出现过会话归属标记的记录。用于判断一个原生会话（或其子会话）的用量是否已在
    /// 代理侧统计，从而避免原生账本重复计数。
    fn observed_agent_session_keys(
        &self,
    ) -> Result<std::collections::HashMap<String, std::collections::HashSet<String>>, StorageError>
    {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let mut statement = connection.prepare(
            "SELECT DISTINCT agent_type, agent_session_id FROM request_logs
             WHERE agent_type IS NOT NULL AND agent_session_id IS NOT NULL",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        let mut map = std::collections::HashMap::new();
        for row in rows {
            let (agent_type, session_id) = row?;
            map.entry(agent_type)
                .or_insert_with(std::collections::HashSet::new)
                .insert(session_id);
        }
        Ok(map)
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

// ─── 模型目录同步（models-cn / models.dev） ───────────────────────────────

/// 模型目录同步结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogSyncResult {
    /// 目录来源标识："models-cn" / "models.dev"。
    pub source: String,
    pub started: bool,
    pub job_id: Option<String>,
    pub skipped: bool,
    pub provider_count: usize,
    pub model_count: usize,
    pub message: String,
}

/// 一个模型目录的同步规格：本地文件名、后台任务身份与统计方式。
#[cfg(desktop)]
struct CatalogSpec {
    /// 来源标识，写入同步结果与任务日志。
    source: &'static str,
    job_type: &'static str,
    title: &'static str,
    /// exe 同级的本地文件名。
    file_name: &'static str,
    /// 从解析后的目录 JSON 统计 (provider 数, 模型数)。
    count: fn(&serde_json::Value) -> (usize, usize),
}

#[cfg(desktop)]
const MODELS_CN_SPEC: CatalogSpec = CatalogSpec {
    source: "models-cn",
    job_type: "models-cn-sync",
    title: "models-cn 目录同步",
    file_name: "models-cn.json",
    count: count_models_cn_catalog,
};

#[cfg(desktop)]
const MODELS_DEV_SPEC: CatalogSpec = CatalogSpec {
    source: "models.dev",
    job_type: "models-dev-sync",
    title: "models.dev 目录同步",
    file_name: "models-dev.json",
    count: count_models_dev_catalog,
};

/// 模型目录本地文件所在目录（exe 同级）。
fn catalog_dir() -> std::path::PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| std::path::PathBuf::from("."))
}

/// models-cn 本地文件路径（exe 同级目录）。
pub fn models_cn_file_path() -> std::path::PathBuf {
    catalog_dir().join("models-cn.json")
}

/// models.dev 本地文件路径（exe 同级目录）。
#[cfg(desktop)]
pub fn models_dev_file_path() -> std::path::PathBuf {
    catalog_dir().join(MODELS_DEV_SPEC.file_name)
}

/// 读取本地 models-cn 目录文件。返回 None 表示文件不存在。
pub fn read_models_cn_file() -> Option<String> {
    std::fs::read_to_string(models_cn_file_path()).ok()
}

/// 读取本地 models.dev 目录文件。返回 None 表示文件不存在。
#[cfg(desktop)]
pub fn read_models_dev_file() -> Option<String> {
    std::fs::read_to_string(models_dev_file_path()).ok()
}

/// models-cn 目录结构：{ "providers": [{ "models": [...] }] }。
#[cfg(desktop)]
fn count_models_cn_catalog(json: &serde_json::Value) -> (usize, usize) {
    let providers = json
        .get("providers")
        .and_then(|p| p.as_array())
        .map(|a| a.len())
        .unwrap_or(0);
    let mut models = 0;
    if let Some(providers) = json.get("providers").and_then(|p| p.as_array()) {
        for provider in providers {
            models += provider
                .get("models")
                .and_then(|m| m.as_array())
                .map(|a| a.len())
                .unwrap_or(0);
        }
    }
    (providers, models)
}

/// models.dev 目录结构：{ "<providerId>": { "models": { "<modelId>": {...} } } }。
#[cfg(desktop)]
fn count_models_dev_catalog(json: &serde_json::Value) -> (usize, usize) {
    let Some(providers) = json.as_object() else {
        return (0, 0);
    };
    let mut models = 0;
    for provider in providers.values() {
        models += provider
            .get("models")
            .and_then(|m| m.as_object())
            .map(|o| o.len())
            .unwrap_or(0);
    }
    (providers.len(), models)
}

/// 拉取 models-cn 目录并保存为本地 JSON 文件，成功后重建内存价格表。
/// 若内容与上次一致（content_hash 相同）则跳过保存，返回 skipped=true。
/// 所有运行信息写入后台任务日志。
#[cfg(desktop)]
pub async fn sync_models_cn_catalog(
    storage: &Storage,
    config_path: &std::path::Path,
    source_url: &str,
    trigger: &str,
) -> Result<CatalogSyncResult, String> {
    sync_catalog_file(storage, config_path, &MODELS_CN_SPEC, source_url, trigger).await
}

/// 拉取 models.dev 目录并保存为本地 JSON 文件，成功后重建内存价格表。
/// 语义与 models-cn 同步一致。
#[cfg(desktop)]
pub async fn sync_models_dev_catalog(
    storage: &Storage,
    config_path: &std::path::Path,
    source_url: &str,
    trigger: &str,
) -> Result<CatalogSyncResult, String> {
    sync_catalog_file(storage, config_path, &MODELS_DEV_SPEC, source_url, trigger).await
}

#[cfg(desktop)]
async fn sync_catalog_file(
    storage: &Storage,
    config_path: &std::path::Path,
    spec: &CatalogSpec,
    source_url: &str,
    trigger: &str,
) -> Result<CatalogSyncResult, String> {
    // 1. 拉取远程数据（async reqwest）
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败：{e}"))?;
    let response = client
        .get(source_url)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|e| format!("请求 {} 失败：{e}", spec.source))?;
    if !response.status().is_success() {
        return Err(format!("{} 返回 HTTP {}", spec.source, response.status()));
    }
    let body = response
        .text()
        .await
        .map_err(|e| format!("读取 {} 响应失败：{e}", spec.source))?;

    // 2. 计算内容 hash，与本地文件比较
    let file_path = catalog_dir().join(spec.file_name);
    let content_hash = format!(
        "sha256:{}",
        hex::encode(sha2::Sha256::digest(body.as_bytes()))
    );
    if let Ok(existing) = std::fs::read_to_string(&file_path) {
        let existing_hash = format!(
            "sha256:{}",
            hex::encode(sha2::Sha256::digest(existing.as_bytes()))
        );
        if existing_hash == content_hash {
            return Ok(CatalogSyncResult {
                source: spec.source.to_string(),
                started: false,
                job_id: None,
                skipped: true,
                provider_count: 0,
                model_count: 0,
                message: format!("{} 数据未变化，跳过保存", spec.source),
            });
        }
    }

    // 3. 解析 JSON 统计 provider/model 数量
    let json: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("解析 {} JSON 失败：{e}", spec.source))?;
    let (provider_count, model_count) = (spec.count)(&json);

    // 4. 创建后台任务并记录事件
    let job_id = uuid::Uuid::new_v4().to_string();
    storage
        .create_job(
            &job_id,
            spec.job_type,
            spec.title,
            "拉取官方价格与模型信息",
            trigger,
            1,
            &format!("开始拉取 {} 目录：{source_url}", spec.source),
        )
        .map_err(|e| e.to_string())?;

    // 5. 保存为本地 JSON 文件（原子写入：先写临时文件再 rename）
    let tmp_path = file_path.with_extension("json.tmp");
    if let Err(error) = std::fs::write(&tmp_path, &body) {
        let error_string = format!("写入临时文件失败：{error}");
        let _ = storage.fail_job(&job_id, &error_string);
        return Err(error_string);
    }
    if let Err(error) = std::fs::rename(&tmp_path, &file_path) {
        let error_string = format!("重命名文件失败：{error}");
        let _ = storage.fail_job(&job_id, &error_string);
        return Err(error_string);
    }

    storage
        .update_job_progress(&job_id, 1, 1)
        .map_err(|e| e.to_string())?;
    let summary = serde_json::json!({
        "providerCount": provider_count,
        "modelCount": model_count,
        "contentHash": content_hash,
        "sourceUrl": source_url,
    });
    storage
        .finish_job(
            &job_id,
            "succeeded",
            &summary.to_string(),
            &format!(
                "{} 同步完成：{provider_count} 个厂商、{model_count} 个模型",
                spec.source
            ),
        )
        .map_err(|e| e.to_string())?;

    // 6. 同步成功后，用两份本地目录 + config.json 重建内存价格表（用于成本估算）
    let price_count = rebuild_price_table(storage, config_path);
    let _ = storage.add_job_event(
        &job_id,
        "info",
        "价格表更新",
        &format!("已用最新目录重建价格表，共 {price_count} 条"),
    );

    Ok(CatalogSyncResult {
        source: spec.source.to_string(),
        started: true,
        job_id: Some(job_id),
        skipped: false,
        provider_count,
        model_count,
        message: format!("同步完成：{provider_count} 个厂商、{model_count} 个模型"),
    })
}

// ─── 价格表装配 ─────────────────────────────────────────────────────────────

/// 用本地目录文件（models-cn + models.dev）与 config.json 的 model_prices
/// 重建内存价格表。合并语义：目录派生优先，config.json 仅补充目录未覆盖的
/// (channel_id, upstream_model)（例如自定义渠道的显式价格）。
/// 各来源失败互不影响，仅记录日志；返回最终价格条数。
#[cfg(desktop)]
pub fn rebuild_price_table(storage: &Storage, config_path: &std::path::Path) -> usize {
    let mut catalog_prices = Vec::new();
    if let Some(catalog_json) = read_models_cn_file() {
        match build_prices_from_models_cn_catalog(&catalog_json) {
            Ok(built) => catalog_prices.extend(built),
            Err(error) => tracing::warn!(error = %error, "从 models-cn.json 生成价格表失败"),
        }
    }
    if let Some(catalog_json) = read_models_dev_file() {
        match build_prices_from_models_dev_catalog(&catalog_json) {
            Ok(built) => catalog_prices.extend(built),
            Err(error) => tracing::warn!(error = %error, "从 models-dev.json 生成价格表失败"),
        }
    }

    let config_prices = std::fs::read_to_string(config_path)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|value| {
            crate::core::channels_config::ChannelsConfig::from_config_json(&value).ok()
        })
        .map(|config| config.prices)
        .unwrap_or_default();

    let prices = merge_price_tables(catalog_prices, config_prices);
    let count = prices.len();
    if count == 0 {
        tracing::warn!("本地无模型目录且 config.json 无价格，成本估算将不可用");
    } else {
        tracing::info!(count, "价格表已重建（目录优先，config 补充）");
    }
    storage.set_prices(prices);
    count
}

/// 合并目录派生价格与 config.json 价格：目录优先，config 仅补充未覆盖的 key。
/// key 为 (channel_id, upstream_model)，大小写不敏感。
#[cfg(desktop)]
fn merge_price_tables(
    catalog_prices: Vec<crate::core::config::ModelPrice>,
    config_prices: Vec<crate::core::config::ModelPrice>,
) -> Vec<crate::core::config::ModelPrice> {
    let mut keys = std::collections::HashSet::new();
    let mut merged = Vec::new();
    for price in catalog_prices.into_iter().chain(config_prices) {
        let key = (
            price.channel_id.to_lowercase(),
            price.upstream_model.to_lowercase(),
        );
        if keys.insert(key) {
            merged.push(price);
        }
    }
    merged
}

// ─── models-cn → ModelPrice 转换 ──────────────────────────────────────────

/// models-cn providerId → Flowlet channel_id 映射（仅覆盖有官方价格的国内厂商）。
#[cfg(desktop)]
fn provider_id_to_channel_id(provider_id: &str) -> Option<&'static str> {
    match provider_id {
        "longcat" => Some("longcat"),
        "deepseek" => Some("deepseek"),
        "moonshot-cn" => Some("kimi"),
        "qwen-cn" => Some("qwen"),
        _ => None,
    }
}

/// 从 models-cn 目录 JSON 解析出 ModelPrice 列表，用于成本估算。
/// 仅提取中国大陆官方价（market=china, currency=CNY, rateType=standard）。
#[cfg(desktop)]
pub fn build_prices_from_models_cn_catalog(
    catalog_json: &str,
) -> Result<Vec<crate::core::config::ModelPrice>, String> {
    let catalog: serde_json::Value =
        serde_json::from_str(catalog_json).map_err(|e| format!("解析 models-cn JSON 失败：{e}"))?;
    let providers = catalog
        .get("providers")
        .and_then(|p| p.as_array())
        .ok_or("models-cn 缺少 providers 字段")?;
    let mut prices = Vec::new();
    let now = chrono::Utc::now().to_rfc3339();
    for provider in providers {
        let provider_id = provider.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let Some(channel_id) = provider_id_to_channel_id(provider_id) else {
            continue;
        };
        let Some(models) = provider.get("models").and_then(|m| m.as_array()) else {
            continue;
        };
        for model in models {
            let upstream_model = model.get("id").and_then(|v| v.as_str()).unwrap_or("");
            if upstream_model.is_empty() {
                continue;
            }
            // 选取最优价格：china + CNY + standard
            let best_price = select_best_model_cn_price(model);
            let Some(price) = best_price else {
                continue;
            };
            let tiers = build_price_tiers(model, &price);
            prices.push(crate::core::config::ModelPrice {
                id: format!("models-cn-{channel_id}-{upstream_model}"),
                channel_id: channel_id.to_string(),
                upstream_model: upstream_model.to_string(),
                input_uncached_price: price.input_standard,
                input_cached_price: price.input_cache_hit,
                input_cache_write_price: price.input_cache_write,
                output_price: price.output,
                tiers,
                currency: "CNY".to_string(),
                unit: "1M tokens".to_string(),
                source_url: price.source_url,
                price_version: Some(format!("models-cn {}", now)),
                created_at: now.clone(),
                updated_at: now.clone(),
            });
        }
    }
    Ok(prices)
}

/// 从本地 models-cn 目录提取 channel_id → currency 映射，用于用量页币种显示。
#[cfg(desktop)]
pub fn get_models_cn_currencies() -> Result<Vec<(String, String)>, String> {
    let Some(catalog_json) = read_models_cn_file() else {
        return Ok(Vec::new());
    };
    let catalog: serde_json::Value = serde_json::from_str(&catalog_json)
        .map_err(|e| format!("解析 models-cn JSON 失败：{e}"))?;
    let providers = catalog
        .get("providers")
        .and_then(|p| p.as_array())
        .ok_or("models-cn 缺少 providers 字段")?;
    let mut result = Vec::new();
    for provider in providers {
        let provider_id = provider.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let Some(channel_id) = provider_id_to_channel_id(provider_id) else {
            continue;
        };
        let Some(models) = provider.get("models").and_then(|m| m.as_array()) else {
            continue;
        };
        for model in models {
            let upstream_model = model.get("id").and_then(|v| v.as_str()).unwrap_or("");
            if upstream_model.is_empty() {
                continue;
            }
            // 提取币种：优先 CNY，否则取第一个价格的币种
            let currency = model
                .get("prices")
                .and_then(|p| p.as_array())
                .and_then(|prices| {
                    prices
                        .iter()
                        .find_map(|price| {
                            let market = price.get("market").and_then(|v| v.as_str()).unwrap_or("");
                            let currency =
                                price.get("currency").and_then(|v| v.as_str()).unwrap_or("");
                            if market == "china" && currency == "CNY" {
                                Some(currency.to_string())
                            } else {
                                None
                            }
                        })
                        .or_else(|| {
                            prices
                                .first()
                                .and_then(|p| p.get("currency").and_then(|v| v.as_str()))
                                .map(String::from)
                        })
                })
                .unwrap_or_else(|| "CNY".to_string());
            result.push((format!("{}:{}", channel_id, upstream_model), currency));
        }
    }
    Ok(result)
}

#[cfg(desktop)]
struct BestModelPrice {
    market: String,
    currency: String,
    rate_type: String,
    input_standard: f64,
    input_cache_hit: f64,
    input_cache_write: Option<f64>,
    output: f64,
    source_url: Option<String>,
}

/// 从模型的 prices[] 中选取最优官方价：china + CNY + promotional。
/// promotional 优先：厂商当前生效的是促销价，standard 仅作兜底参考
/// （与前端 domains/modelCatalog/pricing.ts 的 priceScore 语义一致）。
/// 缓存命中价仅在 input.cacheHit 存在时使用。
#[cfg(desktop)]
fn select_best_model_cn_price(model: &serde_json::Value) -> Option<BestModelPrice> {
    let prices = model.get("prices")?.as_array()?;
    // 优先级：china+CNY+promotional > china+CNY+standard > 其他
    let mut best: Option<&serde_json::Value> = None;
    let mut best_score = -1i32;
    for price in prices {
        let market = price.get("market").and_then(|v| v.as_str()).unwrap_or("");
        let currency = price.get("currency").and_then(|v| v.as_str()).unwrap_or("");
        let rate_type = price.get("rateType").and_then(|v| v.as_str()).unwrap_or("");
        let mut score = 0;
        if market == "china" {
            score += 4;
        }
        if currency == "CNY" {
            score += 2;
        }
        if rate_type == "promotional" {
            score += 1;
        }
        if score > best_score {
            best_score = score;
            best = Some(price);
        }
    }
    let price = best?;
    let input = price.get("input")?;
    let input_standard = input.get("standard").and_then(|v| v.as_f64())?;
    let output = price.get("output").and_then(|v| v.as_f64())?;
    // 缓存命中价仅在字段存在时使用
    let input_cache_hit = input
        .get("cacheHit")
        .and_then(|v| v.as_f64())
        .unwrap_or(input_standard);
    let input_cache_write = input.get("explicitCacheCreation").and_then(|v| v.as_f64());
    let source_url = price
        .get("sourceUrl")
        .and_then(|v| v.as_str())
        .map(String::from);
    Some(BestModelPrice {
        market: price
            .get("market")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        currency: price
            .get("currency")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        rate_type: price
            .get("rateType")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        input_standard,
        input_cache_hit,
        input_cache_write,
        output,
        source_url,
    })
}

/// 用与最优价同 (market, currency, rateType) 的 inputTokenRange 行构建分级价格。
/// 至少两行区间数据才视为分级；按区间下限升序，最后一档 up_to=None 兜底。
/// 无区间数据时返回空（使用扁平单价）。
#[cfg(desktop)]
fn build_price_tiers(
    model: &serde_json::Value,
    best: &BestModelPrice,
) -> Vec<crate::core::config::ModelPriceTier> {
    let Some(prices) = model.get("prices").and_then(|p| p.as_array()) else {
        return Vec::new();
    };
    let mut ranged: Vec<(i64, i64, f64, f64, Option<f64>, f64)> = Vec::new();
    for price in prices {
        let market = price.get("market").and_then(|v| v.as_str()).unwrap_or("");
        let currency = price.get("currency").and_then(|v| v.as_str()).unwrap_or("");
        let rate_type = price.get("rateType").and_then(|v| v.as_str()).unwrap_or("");
        if market != best.market || currency != best.currency || rate_type != best.rate_type {
            continue;
        }
        let Some(range) = price.get("inputTokenRange") else {
            continue;
        };
        let Some(max_inclusive) = range.get("maxInclusive").and_then(|v| v.as_i64()) else {
            continue;
        };
        let min_exclusive = range
            .get("minExclusive")
            .and_then(|v| v.as_i64())
            .unwrap_or(-1);
        let Some(input) = price.get("input") else {
            continue;
        };
        let Some(standard) = input.get("standard").and_then(|v| v.as_f64()) else {
            continue;
        };
        let Some(output) = price.get("output").and_then(|v| v.as_f64()) else {
            continue;
        };
        let cache_hit = input
            .get("cacheHit")
            .and_then(|v| v.as_f64())
            .unwrap_or(standard);
        let cache_write = input.get("explicitCacheCreation").and_then(|v| v.as_f64());
        ranged.push((
            min_exclusive,
            max_inclusive,
            standard,
            cache_hit,
            cache_write,
            output,
        ));
    }
    if ranged.len() < 2 {
        return Vec::new();
    }
    ranged.sort_by_key(|(min, max, _, _, _, _)| (*min, *max));
    let last = ranged.len() - 1;
    ranged
        .into_iter()
        .enumerate()
        .map(
            |(index, (_, max_inclusive, standard, cache_hit, cache_write, output))| {
                crate::core::config::ModelPriceTier {
                    up_to_input_tokens: if index == last {
                        None
                    } else {
                        Some(max_inclusive)
                    },
                    input_uncached_price: standard,
                    input_cached_price: cache_hit,
                    input_cache_write_price: cache_write,
                    output_price: output,
                }
            },
        )
        .collect()
}

// ─── models.dev → ModelPrice 转换 ─────────────────────────────────────────

/// Codex 套餐额度（CREDITS）与 OpenAI API 美元价的换算比例。
/// 与价格迁移前 config.json 内嵌的 codex-native 价格保持一致
/// （如 gpt-5.6-sol 输入 5 USD/1M ↔ 125 CREDITS/1M）。
#[cfg(desktop)]
const CODEX_CREDITS_PER_USD: f64 = 25.0;

/// models.dev providerId → Flowlet channel_id 映射。
/// 目前仅 OpenAI 官方 API 价用于 Codex 会话的 USD 等值估算。
#[cfg(desktop)]
fn models_dev_provider_to_channel_id(provider_id: &str) -> Option<&'static str> {
    match provider_id {
        "openai" => Some("openai-api"),
        _ => None,
    }
}

/// 从 models.dev 目录 JSON 解析出 ModelPrice 列表，用于成本估算。
/// 每个 openai 模型产出两条：openai-api（USD，官方 API 价）与
/// codex-native（CREDITS，按 CODEX_CREDITS_PER_USD 派生的套餐额度消耗）。
#[cfg(desktop)]
pub fn build_prices_from_models_dev_catalog(
    catalog_json: &str,
) -> Result<Vec<crate::core::config::ModelPrice>, String> {
    let catalog: serde_json::Value = serde_json::from_str(catalog_json)
        .map_err(|e| format!("解析 models.dev JSON 失败：{e}"))?;
    let providers = catalog
        .as_object()
        .ok_or("models.dev 顶层必须是 provider 对象")?;
    let mut prices = Vec::new();
    let now = chrono::Utc::now().to_rfc3339();
    for (provider_id, provider) in providers {
        let Some(channel_id) = models_dev_provider_to_channel_id(provider_id) else {
            continue;
        };
        let Some(models) = provider.get("models").and_then(|m| m.as_object()) else {
            continue;
        };
        let source_url = provider
            .get("doc")
            .and_then(|v| v.as_str())
            .map(String::from)
            .or_else(|| Some("https://models.dev/".to_string()));
        for (model_id, model) in models {
            if model_id.trim().is_empty() {
                continue;
            }
            let Some(cost) = model.get("cost") else {
                continue;
            };
            let Some(input) = cost.get("input").and_then(|v| v.as_f64()) else {
                continue;
            };
            let Some(output) = cost.get("output").and_then(|v| v.as_f64()) else {
                continue;
            };
            let cache_read = cost.get("cache_read").and_then(|v| v.as_f64());
            let cache_write = cost.get("cache_write").and_then(|v| v.as_f64());
            let tiers = build_models_dev_tiers(cost, input, cache_read, cache_write, output);
            let usd_price = crate::core::config::ModelPrice {
                id: format!("models-dev-{channel_id}-{model_id}"),
                channel_id: channel_id.to_string(),
                upstream_model: model_id.clone(),
                input_uncached_price: input,
                input_cached_price: cache_read.unwrap_or(input),
                input_cache_write_price: cache_write,
                output_price: output,
                tiers,
                currency: "USD".to_string(),
                unit: "1M tokens".to_string(),
                source_url: source_url.clone(),
                price_version: Some(format!("models.dev {now}")),
                created_at: now.clone(),
                updated_at: now.clone(),
            };
            prices.push(scale_model_price(
                &usd_price,
                CODEX_CREDITS_PER_USD,
                "codex-native",
                "CREDITS",
            ));
            prices.push(usd_price);
        }
    }
    Ok(prices)
}

/// models.dev cost.tiers 转 Flowlet 分级：base 价覆盖 ≤ 第一个 context size，
/// 每个 tier 条目覆盖 > 其 size 的区间，最后一档 up_to=None 兜底。
#[cfg(desktop)]
fn build_models_dev_tiers(
    cost: &serde_json::Value,
    base_input: f64,
    base_cache_read: Option<f64>,
    base_cache_write: Option<f64>,
    base_output: f64,
) -> Vec<crate::core::config::ModelPriceTier> {
    let mut context_tiers: Vec<(i64, &serde_json::Value)> = cost
        .get("tiers")
        .and_then(|t| t.as_array())
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| {
                    let tier = entry.get("tier")?;
                    if tier.get("type").and_then(|v| v.as_str()) != Some("context") {
                        return None;
                    }
                    let size = tier.get("size").and_then(|v| v.as_i64())?;
                    Some((size, entry))
                })
                .collect()
        })
        .unwrap_or_default();
    if context_tiers.is_empty() {
        return Vec::new();
    }
    context_tiers.sort_by_key(|(size, _)| *size);
    let mut tiers = Vec::with_capacity(context_tiers.len() + 1);
    tiers.push(crate::core::config::ModelPriceTier {
        up_to_input_tokens: Some(context_tiers[0].0),
        input_uncached_price: base_input,
        input_cached_price: base_cache_read.unwrap_or(base_input),
        input_cache_write_price: base_cache_write,
        output_price: base_output,
    });
    for (index, (_, entry)) in context_tiers.iter().enumerate() {
        let input = entry
            .get("input")
            .and_then(|v| v.as_f64())
            .unwrap_or(base_input);
        let output = entry
            .get("output")
            .and_then(|v| v.as_f64())
            .unwrap_or(base_output);
        let cache_read = entry.get("cache_read").and_then(|v| v.as_f64());
        let cache_write = entry.get("cache_write").and_then(|v| v.as_f64());
        tiers.push(crate::core::config::ModelPriceTier {
            up_to_input_tokens: context_tiers.get(index + 1).map(|(size, _)| *size),
            input_uncached_price: input,
            input_cached_price: cache_read.unwrap_or(input),
            input_cache_write_price: cache_write,
            output_price: output,
        });
    }
    tiers
}

/// 按比例缩放一条价格的全部金额字段，生成另一币种/命名空间的派生价格
/// （如 openai-api USD → codex-native CREDITS）。
#[cfg(desktop)]
fn scale_model_price(
    price: &crate::core::config::ModelPrice,
    factor: f64,
    channel_id: &str,
    currency: &str,
) -> crate::core::config::ModelPrice {
    let mut scaled = price.clone();
    scaled.id = format!("models-dev-{channel_id}-{}", price.upstream_model);
    scaled.channel_id = channel_id.to_string();
    scaled.currency = currency.to_string();
    scaled.input_uncached_price *= factor;
    scaled.input_cached_price *= factor;
    scaled.input_cache_write_price = scaled.input_cache_write_price.map(|v| v * factor);
    scaled.output_price *= factor;
    for tier in &mut scaled.tiers {
        tier.input_uncached_price *= factor;
        tier.input_cached_price *= factor;
        tier.input_cache_write_price = tier.input_cache_write_price.map(|v| v * factor);
        tier.output_price *= factor;
    }
    scaled
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
            runtime_status: "idle".into(),
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
            estimated_input_uncached_cost: 0.0,
            estimated_input_cached_cost: 0.0,
            estimated_input_cache_write_cost: 0.0,
            estimated_output_cost: 0.0,
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
            usage_events: Vec::new(),
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
    fn saves_agent_usage_events_incrementally_and_replaces_on_full_reparse() {
        let storage = Storage::from_connection_for_test(Connection::open_in_memory().unwrap());
        storage.migrate().unwrap();

        let make_event = |event_id: &str, event_time: &str, total: i64| {
            crate::core::config::AgentUsageEvent {
                event_id: event_id.to_string(),
                event_time: event_time.to_string(),
                model: Some("model-a".to_string()),
                input_tokens: total / 2,
                cached_input_tokens: 0,
                cache_write_input_tokens: 0,
                output_tokens: total / 2,
                reasoning_tokens: 0,
                total_tokens: total,
            }
        };
        let make_parsed = |incremental: bool, usage_events| AgentSessionSummaryParseResult {
            summary: AgentSessionNativeSummary {
                source_available: true,
                truncated: false,
                turn_count: 0,
                usage: None,
                models: Vec::new(),
            },
            source_offset: 0,
            parser_version: crate::core::agent_session_timeline::AGENT_SUMMARY_PARSER_VERSION,
            usage_ids: Vec::new(),
            cursor_guard: String::new(),
            complete: true,
            incremental,
            bytes_processed: 0,
            usage_events,
        };

        // 全量写入 2 条；事件时间选在正午附近，任何时区下分组都稳定。
        storage
            .save_agent_usage_events(
                "claude-code",
                "session-1",
                &make_parsed(
                    false,
                    vec![
                        make_event("e1", "2026-07-30T12:00:00+00:00", 100),
                        make_event("e2", "2026-07-30T13:00:00+00:00", 60),
                    ],
                ),
            )
            .unwrap();
        let days = storage.agent_native_daily_usage_totals().unwrap();
        assert_eq!(days.len(), 1);
        assert_eq!(days[0].native_event_count, 2);
        assert_eq!(days[0].native_total_tokens, 160);
        assert_eq!(days[0].native_input_tokens, 80);
        // 代理口径字段不受原生聚合影响。
        assert_eq!(days[0].known_tokens, 0);
        assert_eq!(days[0].request_count, 0);

        // 增量：重复 e2 + 新增 e3 → 主键幂等，只插入 e3。
        storage
            .save_agent_usage_events(
                "claude-code",
                "session-1",
                &make_parsed(
                    true,
                    vec![
                        make_event("e2", "2026-07-30T13:00:00+00:00", 60),
                        make_event("e3", "2026-07-31T12:00:00+00:00", 40),
                    ],
                ),
            )
            .unwrap();
        let days = storage.agent_native_daily_usage_totals().unwrap();
        assert_eq!(days.len(), 2);
        assert_eq!(days[0].native_total_tokens, 160);
        assert_eq!(days[1].native_event_count, 1);
        assert_eq!(days[1].native_total_tokens, 40);
        let hours = storage.agent_native_hourly_usage_totals().unwrap();
        assert_eq!(hours.len(), 3);
        assert_eq!(
            hours.iter().map(|hour| hour.native_total_tokens).sum::<i64>(),
            200
        );

        // 全量重解析：先清旧行再写入，账本与本次全量结果严格一致。
        storage
            .save_agent_usage_events(
                "claude-code",
                "session-1",
                &make_parsed(false, vec![make_event("e9", "2026-07-31T12:00:00+00:00", 5)]),
            )
            .unwrap();
        let days = storage.agent_native_daily_usage_totals().unwrap();
        assert_eq!(days.len(), 1);
        assert_eq!(days[0].native_event_count, 1);
        assert_eq!(days[0].native_total_tokens, 5);

        // 会话删除时事件随快照一并清理。
        storage
            .delete_agent_snapshot("claude-code", "session-1")
            .unwrap();
        assert!(storage.agent_native_daily_usage_totals().unwrap().is_empty());
        assert!(storage.agent_native_hourly_usage_totals().unwrap().is_empty());
    }

    #[test]
    fn excludes_subsumed_sessions_but_keeps_native_only_children() {
        let storage = Storage::from_connection_for_test(Connection::open_in_memory().unwrap());
        storage.migrate().unwrap();
        storage
            .create_job(
                "job-child",
                "agent-data-sync",
                "Agent 数据同步",
                "扫描并整理会话",
                "manual",
                3,
                "发现 3 个需要整理的会话",
            )
            .unwrap();

        // root_obs 经过 Flowlet（request_logs 有记录）→ 自身被覆盖；
        // child_of_obs 是其子会话 → 子会话的调用以父 id 落库，也应被覆盖；
        // root_native / child_of_native 完全未经过 Flowlet → 原生账本应保留。
        storage
            .connection
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO request_logs (id, request_id, agent_type, agent_session_id,
                    client_protocol, upstream_protocol, method, path, created_at)
                 VALUES ('rl-1','req-1','opencode','root-obs','openai','openai','POST','/v1/x',
                    '2026-07-30T12:00:00Z')",
                [],
            )
            .unwrap();

        let mut root_obs = native_session();
        root_obs.session_id = "root-obs".into();
        let mut root_native = native_session();
        root_native.session_id = "root-native".into();
        let mut child_of_obs = native_session();
        child_of_obs.session_id = "child-of-obs".into();
        child_of_obs.parent_session_id = Some("root-obs".into());
        let mut child_of_native = native_session();
        child_of_native.session_id = "child-of-native".into();
        child_of_native.parent_session_id = Some("root-native".into());

        // child_of_obs 本轮「未变化」，但预置一条陈旧事件，验证 after-loop 清理路径。
        storage
            .connection
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO agent_usage_events (
                    agent_type, session_id, event_id, event_time, model,
                    input_tokens, cached_input_tokens, cache_write_input_tokens,
                    output_tokens, reasoning_tokens, total_tokens, synced_at
                 ) VALUES ('opencode', 'child-of-obs', 'stale-1', '2026-07-30T12:00:00+00:00', NULL, 1, 0, 0, 1, 0, 2, datetime('now'))",
                [],
            )
            .unwrap();

        let sessions = vec![
            root_obs.clone(),
            root_native.clone(),
            child_of_obs.clone(),
            child_of_native.clone(),
        ];
        // child_of_obs 故意不放进 changed，以覆盖「未变化但需清理」的分支。
        let changed = vec![
            (root_obs, "fp-root-obs".to_string()),
            (root_native, "fp-root-native".to_string()),
            (child_of_native, "fp-child-native".to_string()),
        ];

        let parsed_template = AgentSessionSummaryParseResult {
            summary: AgentSessionNativeSummary {
                source_available: true,
                truncated: false,
                turn_count: 1,
                usage: None,
                models: Vec::new(),
            },
            source_offset: 0,
            parser_version: crate::core::agent_session_timeline::AGENT_SUMMARY_PARSER_VERSION,
            usage_ids: Vec::new(),
            cursor_guard: String::new(),
            complete: true,
            incremental: false,
            bytes_processed: 0,
            usage_events: vec![crate::core::config::AgentUsageEvent {
                event_id: "e1".into(),
                event_time: "2026-07-30T12:00:00+00:00".into(),
                model: Some("model-a".into()),
                input_tokens: 10,
                cached_input_tokens: 0,
                cache_write_input_tokens: 0,
                output_tokens: 10,
                reasoning_tokens: 0,
                total_tokens: 20,
            }],
        };
        storage
            .run_agent_sync_job_with_parser(
                "job-child",
                &sessions,
                &changed,
                &[],
                0,
                1,
                1,
                Instant::now(),
                move |_, _, _| Ok(parsed_template.clone()),
            )
            .unwrap();

        let count = |session_id: &str| -> i64 {
            storage
                .connection
                .lock()
                .unwrap()
                .query_row(
                    "SELECT count(*) FROM agent_usage_events WHERE agent_type='opencode' AND session_id=?1",
                    [session_id],
                    |row| row.get(0),
                )
                .unwrap()
        };
        // 自身被观测：不记原生账本。
        assert_eq!(count("root-obs"), 0);
        // 子会话且父被观测：陈旧事件被清理，也不记新事件。
        assert_eq!(count("child-of-obs"), 0);
        // 纯原生根会话与「父未观测的子会话」：照常记账，不反向漏计。
        assert_eq!(count("root-native"), 1);
        assert_eq!(count("child-of-native"), 1);
        // 被覆盖会话即便在 changed 里，快照仍正常保存（详情视图不受影响）。
        assert!(storage
            .load_agent_summary_checkpoint("opencode", "root-obs")
            .unwrap()
            .is_some());
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
                trigger_source: "".into(),
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
        assert!(
            storage
                .get_background_job_detail("finished")
                .unwrap()
                .is_none()
        );
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
                trigger_source: "".into(),
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
                trigger_source: "".into(),
            })
            .unwrap();
        assert_eq!(agent_jobs.total, 0);
        let detail = storage
            .get_background_job_detail("codex-job")
            .unwrap()
            .unwrap();
        assert_eq!(detail.job.status, "succeeded_with_warnings");
        assert!(
            detail
                .events
                .iter()
                .any(|event| event.stage.as_deref() == Some("账号刷新失败"))
        );
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
                        usage_events: Vec::new(),
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
                trigger_source: "".into(),
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

    // ─── 模型目录 → ModelPrice 构建 ───────────────────────────────────────

    fn price(
        channel_id: &str,
        upstream_model: &str,
        input: f64,
        currency: &str,
    ) -> crate::core::config::ModelPrice {
        crate::core::config::ModelPrice {
            channel_id: channel_id.to_string(),
            upstream_model: upstream_model.to_string(),
            input_uncached_price: input,
            currency: currency.to_string(),
            ..Default::default()
        }
    }

    fn find_price<'a>(
        prices: &'a [crate::core::config::ModelPrice],
        channel_id: &str,
        model: &str,
    ) -> &'a crate::core::config::ModelPrice {
        prices
            .iter()
            .find(|p| p.channel_id == channel_id && p.upstream_model == model)
            .unwrap_or_else(|| panic!("missing {channel_id} price for {model}"))
    }

    const MODELS_DEV_FIXTURE: &str = r#"{
        "openai": {
            "id": "openai",
            "name": "OpenAI",
            "doc": "https://platform.openai.com/docs/pricing",
            "models": {
                "gpt-5.6-sol": {
                    "id": "gpt-5.6-sol",
                    "cost": {"input": 5, "output": 30, "cache_read": 0.5, "cache_write": 6.25,
                             "tiers": [{"input": 10, "output": 45, "cache_read": 1, "cache_write": 12.5,
                                        "tier": {"type": "context", "size": 272000}}]},
                    "limit": {"context": 1050000, "output": 128000}
                },
                "gpt-5.5": {"id": "gpt-5.5", "cost": {"input": 5, "output": 30, "cache_read": 0.5}},
                "gpt-5-pro": {"id": "gpt-5-pro", "cost": {"input": 15, "output": 120}},
                "gpt-free-no-cost": {"id": "gpt-free-no-cost"}
            }
        },
        "anthropic": {
            "id": "anthropic",
            "models": {
                "claude-x": {"id": "claude-x", "cost": {"input": 3, "output": 15}}
            }
        }
    }"#;

    #[test]
    fn builds_openai_api_and_derived_codex_native_prices_from_models_dev() {
        let prices = build_prices_from_models_dev_catalog(MODELS_DEV_FIXTURE).unwrap();

        // openai → openai-api（USD），含缓存与分级映射。
        let sol = find_price(&prices, "openai-api", "gpt-5.6-sol");
        assert_eq!(sol.currency, "USD");
        assert_eq!(sol.input_uncached_price, 5.0);
        assert_eq!(sol.input_cached_price, 0.5);
        assert_eq!(sol.input_cache_write_price, Some(6.25));
        assert_eq!(sol.output_price, 30.0);
        assert_eq!(
            sol.source_url.as_deref(),
            Some("https://platform.openai.com/docs/pricing")
        );
        assert_eq!(sol.tiers.len(), 2);
        assert_eq!(sol.tiers[0].up_to_input_tokens, Some(272000));
        assert_eq!(sol.tiers[0].input_uncached_price, 5.0);
        assert_eq!(sol.tiers[1].up_to_input_tokens, None);
        assert_eq!(sol.tiers[1].input_uncached_price, 10.0);
        assert_eq!(sol.tiers[1].output_price, 45.0);

        // codex-native 派生：全部金额 ×25，币种 CREDITS，分级同步缩放。
        let sol_credits = find_price(&prices, "codex-native", "gpt-5.6-sol");
        assert_eq!(sol_credits.currency, "CREDITS");
        assert_eq!(sol_credits.input_uncached_price, 125.0);
        assert_eq!(sol_credits.input_cached_price, 12.5);
        assert_eq!(sol_credits.input_cache_write_price, Some(156.25));
        assert_eq!(sol_credits.output_price, 750.0);
        assert_eq!(sol_credits.tiers.len(), 2);
        assert_eq!(sol_credits.tiers[1].input_uncached_price, 250.0);
        assert_eq!(sol_credits.tiers[1].output_price, 1125.0);

        // 无 cache_read 时缓存命中价回退为未缓存价；无 cache_write 保持 None。
        let pro = find_price(&prices, "openai-api", "gpt-5-pro");
        assert_eq!(pro.input_cached_price, 15.0);
        assert_eq!(pro.input_cache_write_price, None);
        assert!(pro.tiers.is_empty());
        let mid = find_price(&prices, "openai-api", "gpt-5.5");
        assert_eq!(mid.input_cache_write_price, None);

        // 无 cost 的模型跳过；未映射的 provider 整体跳过。
        assert!(
            !prices
                .iter()
                .any(|p| p.upstream_model == "gpt-free-no-cost")
        );
        assert!(!prices.iter().any(|p| p.upstream_model == "claude-x"));
    }

    #[test]
    fn models_dev_prices_cover_current_codex_models_in_both_dimensions() {
        let fixture = r#"{
            "openai": {
                "id": "openai",
                "models": {
                    "gpt-5.6-sol": {"id": "gpt-5.6-sol", "cost": {"input": 5, "output": 30, "cache_read": 0.5, "cache_write": 6.25}},
                    "gpt-5.6-terra": {"id": "gpt-5.6-terra", "cost": {"input": 2.5, "output": 15, "cache_read": 0.25, "cache_write": 3.125}},
                    "gpt-5.6-luna": {"id": "gpt-5.6-luna", "cost": {"input": 1, "output": 6, "cache_read": 0.1, "cache_write": 1.25}},
                    "gpt-5.5": {"id": "gpt-5.5", "cost": {"input": 5, "output": 30, "cache_read": 0.5}}
                }
            }
        }"#;
        let prices = build_prices_from_models_dev_catalog(fixture).unwrap();
        for model in ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"] {
            let api_price = find_price(&prices, "openai-api", model);
            assert_eq!(api_price.currency, "USD");
            assert!(api_price.input_uncached_price > 0.0);
            assert!(api_price.output_price > 0.0);

            let plan_price = find_price(&prices, "codex-native", model);
            assert_eq!(plan_price.currency, "CREDITS");
            assert!(
                (plan_price.input_uncached_price - api_price.input_uncached_price * 25.0).abs()
                    < 1e-9
            );
            assert!((plan_price.output_price - api_price.output_price * 25.0).abs() < 1e-9);
        }
    }

    const MODELS_CN_QWEN_FIXTURE: &str = r#"{
        "providers": [{
            "id": "qwen-cn",
            "models": [
                {"id": "qwen3.7-plus", "prices": [
                    {"market": "china", "currency": "CNY", "unit": "1M_tokens", "rateType": "standard",
                     "inputTokenRange": {"label": "输入<=256k", "maxInclusive": 256000},
                     "input": {"standard": 2, "cacheHit": 0.4, "explicitCacheCreation": 2.5, "explicitCacheHit": 0.2},
                     "output": 8, "sourceUrl": "https://example.com/qwen3.7-plus"},
                    {"market": "china", "currency": "CNY", "unit": "1M_tokens", "rateType": "promotional",
                     "inputTokenRange": {"label": "输入<=256k", "maxInclusive": 256000},
                     "input": {"standard": 1.6, "cacheHit": 0.32, "explicitCacheCreation": 2, "explicitCacheHit": 0.16},
                     "output": 6.4, "sourceUrl": "https://example.com/qwen3.7-plus"},
                    {"market": "china", "currency": "CNY", "unit": "1M_tokens", "rateType": "standard",
                     "inputTokenRange": {"label": "256k<输入<=1m", "minExclusive": 256000, "maxInclusive": 1000000},
                     "input": {"standard": 6, "cacheHit": 1.2, "explicitCacheCreation": 7.5, "explicitCacheHit": 0.6},
                     "output": 24, "sourceUrl": "https://example.com/qwen3.7-plus"},
                    {"market": "china", "currency": "CNY", "unit": "1M_tokens", "rateType": "promotional",
                     "inputTokenRange": {"label": "256k<输入<=1m", "minExclusive": 256000, "maxInclusive": 1000000},
                     "input": {"standard": 4.8, "cacheHit": 0.96, "explicitCacheCreation": 6, "explicitCacheHit": 0.48},
                     "output": 19.2, "sourceUrl": "https://example.com/qwen3.7-plus"}
                ]},
                {"id": "qwen3.7-max", "prices": [
                    {"market": "china", "currency": "CNY", "unit": "1M_tokens", "rateType": "standard",
                     "input": {"standard": 12, "cacheHit": 2.4, "explicitCacheCreation": 15, "explicitCacheHit": 1.2},
                     "output": 36, "sourceUrl": "https://example.com/qwen3.7-max"},
                    {"market": "china", "currency": "CNY", "unit": "1M_tokens", "rateType": "promotional",
                     "input": {"standard": 6, "cacheHit": 1.2, "explicitCacheCreation": 7.5, "explicitCacheHit": 0.6},
                     "output": 18, "sourceUrl": "https://example.com/qwen3.7-max"}
                ]},
                {"id": "qwen3.8-max-preview", "prices": []}
            ]
        }]
    }"#;

    #[test]
    fn models_cn_builder_prefers_promotional_and_builds_input_range_tiers() {
        let prices = build_prices_from_models_cn_catalog(MODELS_CN_QWEN_FIXTURE).unwrap();

        // qwen3.7-max：promotional（厂商当前生效价）优先于 standard，扁平单价无分级。
        let max = find_price(&prices, "qwen", "qwen3.7-max");
        assert_eq!(max.currency, "CNY");
        assert!(max.tiers.is_empty());
        assert!((max.input_uncached_price - 6.0).abs() < 1e-9);
        assert!((max.input_cached_price - 1.2).abs() < 1e-9);
        assert!((max.input_cache_write_price.unwrap_or(0.0) - 7.5).abs() < 1e-9);
        assert!((max.output_price - 18.0).abs() < 1e-9);

        // qwen3.7-plus：按 inputTokenRange 生成 promotional 两档分级，长上下文档更贵。
        let plus = find_price(&prices, "qwen", "qwen3.7-plus");
        assert_eq!(plus.tiers.len(), 2);
        assert_eq!(plus.tiers[0].up_to_input_tokens, Some(256000));
        assert!((plus.tiers[0].input_uncached_price - 1.6).abs() < 1e-9);
        assert!((plus.tiers[0].input_cached_price - 0.32).abs() < 1e-9);
        assert!((plus.tiers[0].input_cache_write_price.unwrap_or(0.0) - 2.0).abs() < 1e-9);
        assert!((plus.tiers[0].output_price - 6.4).abs() < 1e-9);
        assert_eq!(plus.tiers[1].up_to_input_tokens, None);
        assert!((plus.tiers[1].input_uncached_price - 4.8).abs() < 1e-9);
        assert!((plus.tiers[1].output_price - 19.2).abs() < 1e-9);
        assert!(plus.tiers[1].input_uncached_price > plus.tiers[0].input_uncached_price);
        assert!(plus.tiers[1].output_price > plus.tiers[0].output_price);
        // 扁平字段取最优（首个 promotional 行），与第一档一致。
        assert!((plus.input_uncached_price - 1.6).abs() < 1e-9);
        assert!((plus.output_price - 6.4).abs() < 1e-9);

        // qwen3.8-max-preview：暂无公开单价，不生成价格条目。
        assert!(
            !prices
                .iter()
                .any(|p| p.channel_id == "qwen" && p.upstream_model == "qwen3.8-max-preview")
        );
    }

    #[test]
    fn merge_price_tables_prefers_catalogs_and_config_fills_gaps() {
        let catalog = vec![
            price("qwen", "qwen3.7-max", 6.0, "CNY"),
            price("openai-api", "gpt-5.5", 5.0, "USD"),
        ];
        let config = vec![
            // 与目录冲突：目录派生优先，config 陈旧值被覆盖。
            price("qwen", "qwen3.7-max", 999.0, "CNY"),
            // 目录未覆盖（如自定义渠道显式价格）：保留。
            price("custom", "my-relay-model", 1.0, "USD"),
        ];
        let merged = merge_price_tables(catalog, config);
        assert_eq!(merged.len(), 3);
        assert!(
            (find_price(&merged, "qwen", "qwen3.7-max").input_uncached_price - 6.0).abs() < 1e-9
        );
        assert_eq!(find_price(&merged, "openai-api", "gpt-5.5").currency, "USD");
        assert!(
            (find_price(&merged, "custom", "my-relay-model").input_uncached_price - 1.0).abs()
                < 1e-9
        );
    }
}
