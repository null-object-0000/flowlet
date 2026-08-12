use super::{Storage, StorageError};
use chrono::{DateTime, NaiveTime, TimeZone, Utc};
use chrono_tz::Tz;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecurringTask {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub description: String,
    pub task_type: String,
    pub agent_profile: String,
    pub schedule_kind: String,
    pub daily_time: Option<String>,
    pub timezone: String,
    pub enabled: bool,
    pub session_policy: String,
    pub source_task_id: Option<String>,
    pub next_run_at: Option<String>,
    pub last_scheduled_for: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecurringTaskRun {
    pub id: String,
    pub recurring_task_id: String,
    pub project_id: String,
    pub trigger_source: String,
    pub status: String,
    pub scheduled_for: Option<String>,
    pub title_snapshot: String,
    pub description_snapshot: String,
    pub task_type_snapshot: String,
    pub agent_profile_snapshot: String,
    pub session_policy_snapshot: String,
    pub job_id: Option<String>,
    pub session_id: Option<String>,
    pub error_message: Option<String>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl Storage {
    pub fn list_recurring_tasks(
        &self,
        project_id: &str,
    ) -> Result<Vec<RecurringTask>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let mut stmt = connection.prepare("SELECT id, project_id, title, description, task_type, agent_profile, schedule_kind, daily_time, timezone, enabled, session_policy, source_task_id, next_run_at, last_scheduled_for, created_at, updated_at FROM recurring_tasks WHERE project_id=?1 ORDER BY updated_at DESC")?;
        let rows = stmt
            .query_map([project_id], map_task)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn get_recurring_task(&self, id: &str) -> Result<Option<RecurringTask>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        connection.query_row("SELECT id, project_id, title, description, task_type, agent_profile, schedule_kind, daily_time, timezone, enabled, session_policy, source_task_id, next_run_at, last_scheduled_for, created_at, updated_at FROM recurring_tasks WHERE id=?1", [id], map_task).optional().map_err(Into::into)
    }

    pub fn save_recurring_task(&self, task: &RecurringTask) -> Result<(), StorageError> {
        let next_run_at =
            compute_next_run(task, Utc::now()).map_err(StorageError::InvalidImport)?;
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        connection.execute("INSERT INTO recurring_tasks (id, project_id, title, description, task_type, agent_profile, schedule_kind, daily_time, timezone, enabled, session_policy, source_task_id, next_run_at, last_scheduled_for, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16) ON CONFLICT(id) DO UPDATE SET title=excluded.title, description=excluded.description, task_type=excluded.task_type, agent_profile=excluded.agent_profile, schedule_kind=excluded.schedule_kind, daily_time=excluded.daily_time, timezone=excluded.timezone, enabled=excluded.enabled, session_policy=excluded.session_policy, source_task_id=excluded.source_task_id, next_run_at=excluded.next_run_at, updated_at=excluded.updated_at WHERE recurring_tasks.project_id=excluded.project_id", params![task.id,task.project_id,task.title,task.description,task.task_type,task.agent_profile,task.schedule_kind,task.daily_time,task.timezone,task.enabled,task.session_policy,task.source_task_id,next_run_at,task.last_scheduled_for,task.created_at,task.updated_at])?;
        Ok(())
    }

    pub fn delete_recurring_task(&self, project_id: &str, id: &str) -> Result<bool, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        Ok(connection.execute("DELETE FROM recurring_tasks WHERE project_id=?1 AND id=?2 AND NOT EXISTS (SELECT 1 FROM recurring_task_runs WHERE recurring_task_id=?2 AND status IN ('queued','running'))", params![project_id,id])? > 0)
    }

    pub fn list_recurring_task_runs(
        &self,
        task_id: &str,
    ) -> Result<Vec<RecurringTaskRun>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let mut stmt = connection.prepare("SELECT id, recurring_task_id, project_id, trigger_source, status, scheduled_for, title_snapshot, description_snapshot, task_type_snapshot, agent_profile_snapshot, session_policy_snapshot, job_id, session_id, error_message, started_at, finished_at, created_at, updated_at FROM recurring_task_runs WHERE recurring_task_id=?1 ORDER BY created_at DESC")?;
        let rows = stmt
            .query_map([task_id], map_run)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn get_recurring_task_run(
        &self,
        id: &str,
    ) -> Result<Option<RecurringTaskRun>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        connection.query_row("SELECT id, recurring_task_id, project_id, trigger_source, status, scheduled_for, title_snapshot, description_snapshot, task_type_snapshot, agent_profile_snapshot, session_policy_snapshot, job_id, session_id, error_message, started_at, finished_at, created_at, updated_at FROM recurring_task_runs WHERE id=?1", [id], map_run).optional().map_err(Into::into)
    }

    pub fn latest_recurring_task_session(
        &self,
        task_id: &str,
        excluding_run_id: &str,
    ) -> Result<Option<String>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        connection.query_row("SELECT session_id FROM recurring_task_runs WHERE recurring_task_id=?1 AND id<>?2 AND status='succeeded' AND session_id IS NOT NULL ORDER BY finished_at DESC LIMIT 1", params![task_id,excluding_run_id], |row| row.get(0)).optional().map(|value| value.flatten()).map_err(Into::into)
    }

    pub fn create_recurring_task_run(
        &self,
        task: &RecurringTask,
        trigger: &str,
        scheduled_for: Option<&str>,
    ) -> Result<RecurringTaskRun, StorageError> {
        let now = Utc::now().to_rfc3339();
        let run = RecurringTaskRun {
            id: uuid::Uuid::new_v4().to_string(),
            recurring_task_id: task.id.clone(),
            project_id: task.project_id.clone(),
            trigger_source: trigger.to_string(),
            status: "queued".to_string(),
            scheduled_for: scheduled_for.map(str::to_string),
            title_snapshot: task.title.clone(),
            description_snapshot: task.description.clone(),
            task_type_snapshot: task.task_type.clone(),
            agent_profile_snapshot: task.agent_profile.clone(),
            session_policy_snapshot: task.session_policy.clone(),
            job_id: None,
            session_id: None,
            error_message: None,
            started_at: None,
            finished_at: None,
            created_at: now.clone(),
            updated_at: now,
        };
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        connection.execute("INSERT INTO recurring_task_runs (id, recurring_task_id, project_id, trigger_source, status, scheduled_for, title_snapshot, description_snapshot, task_type_snapshot, agent_profile_snapshot, session_policy_snapshot, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)", params![run.id,run.recurring_task_id,run.project_id,run.trigger_source,run.status,run.scheduled_for,run.title_snapshot,run.description_snapshot,run.task_type_snapshot,run.agent_profile_snapshot,run.session_policy_snapshot,run.created_at,run.updated_at])?;
        Ok(run)
    }

    pub fn claim_due_recurring_runs(&self) -> Result<Vec<RecurringTaskRun>, StorageError> {
        let now = Utc::now();
        let due: Vec<RecurringTask> = {
            let connection = self
                .connection
                .lock()
                .map_err(|_| StorageError::LockFailed)?;
            let mut stmt = connection.prepare("SELECT id, project_id, title, description, task_type, agent_profile, schedule_kind, daily_time, timezone, enabled, session_policy, source_task_id, next_run_at, last_scheduled_for, created_at, updated_at FROM recurring_tasks WHERE enabled=1 AND schedule_kind='daily' AND next_run_at IS NOT NULL AND next_run_at<=?1")?;
            let rows = stmt
                .query_map([now.to_rfc3339()], map_task)?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        let mut created = Vec::new();
        for mut task in due {
            let scheduled_for = task.next_run_at.clone().unwrap();
            match self.create_recurring_task_run(&task, "scheduled", Some(&scheduled_for)) {
                Ok(run) => created.push(run),
                Err(StorageError::Sqlite(rusqlite::Error::SqliteFailure(error, _)))
                    if error.code == rusqlite::ErrorCode::ConstraintViolation => {}
                Err(error) => return Err(error),
            }
            task.last_scheduled_for = Some(scheduled_for);
            task.next_run_at = compute_next_run(&task, now).map_err(StorageError::InvalidImport)?;
            let connection = self
                .connection
                .lock()
                .map_err(|_| StorageError::LockFailed)?;
            connection.execute("UPDATE recurring_tasks SET last_scheduled_for=?2, next_run_at=?3, updated_at=?4 WHERE id=?1", params![task.id,task.last_scheduled_for,task.next_run_at,now.to_rfc3339()])?;
        }
        Ok(created)
    }

    pub fn list_queued_recurring_runs(&self) -> Result<Vec<RecurringTaskRun>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let mut stmt = connection.prepare("SELECT id, recurring_task_id, project_id, trigger_source, status, scheduled_for, title_snapshot, description_snapshot, task_type_snapshot, agent_profile_snapshot, session_policy_snapshot, job_id, session_id, error_message, started_at, finished_at, created_at, updated_at FROM recurring_task_runs WHERE status IN ('queued','interrupted') ORDER BY created_at ASC")?;
        let rows = stmt
            .query_map([], map_run)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn start_recurring_run(&self, id: &str, job_id: &str) -> Result<bool, StorageError> {
        let c = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        Ok(c.execute("UPDATE recurring_task_runs SET status='running', job_id=?2, started_at=datetime('now'), updated_at=datetime('now') WHERE id=?1 AND status IN ('queued','interrupted')",params![id,job_id])?>0)
    }
    pub fn finish_recurring_run(
        &self,
        id: &str,
        status: &str,
        session_id: Option<&str>,
        error: Option<&str>,
    ) -> Result<bool, StorageError> {
        let c = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        Ok(c.execute("UPDATE recurring_task_runs SET status=?2, session_id=?3, error_message=?4, finished_at=datetime('now'), updated_at=datetime('now') WHERE id=?1",params![id,status,session_id,error])?>0)
    }
    pub fn recover_interrupted_recurring_runs(&self) -> Result<usize, StorageError> {
        let c = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        Ok(c.execute("UPDATE recurring_task_runs SET status='interrupted', finished_at=datetime('now'), updated_at=datetime('now') WHERE status='running'",[]) ?)
    }
}

fn compute_next_run(task: &RecurringTask, after: DateTime<Utc>) -> Result<Option<String>, String> {
    if !task.enabled || task.schedule_kind != "daily" {
        return Ok(None);
    }
    let tz: Tz = task.timezone.parse().map_err(|_| "无效时区".to_string())?;
    let time = NaiveTime::parse_from_str(
        task.daily_time.as_deref().ok_or("每日任务缺少运行时间")?,
        "%H:%M",
    )
    .map_err(|_| "每日运行时间必须为 HH:MM".to_string())?;
    let local = after.with_timezone(&tz);
    let mut date = local.date_naive();
    let mut candidate = tz
        .from_local_datetime(&date.and_time(time))
        .earliest()
        .ok_or("无法解析本地运行时间")?;
    if candidate <= local {
        date = date.succ_opt().ok_or("日期溢出")?;
        candidate = tz
            .from_local_datetime(&date.and_time(time))
            .earliest()
            .ok_or("无法解析本地运行时间")?;
    }
    Ok(Some(candidate.with_timezone(&Utc).to_rfc3339()))
}

fn map_task(row: &rusqlite::Row<'_>) -> rusqlite::Result<RecurringTask> {
    Ok(RecurringTask {
        id: row.get(0)?,
        project_id: row.get(1)?,
        title: row.get(2)?,
        description: row.get(3)?,
        task_type: row.get(4)?,
        agent_profile: row.get(5)?,
        schedule_kind: row.get(6)?,
        daily_time: row.get(7)?,
        timezone: row.get(8)?,
        enabled: row.get(9)?,
        session_policy: row.get(10)?,
        source_task_id: row.get(11)?,
        next_run_at: row.get(12)?,
        last_scheduled_for: row.get(13)?,
        created_at: row.get(14)?,
        updated_at: row.get(15)?,
    })
}
fn map_run(row: &rusqlite::Row<'_>) -> rusqlite::Result<RecurringTaskRun> {
    Ok(RecurringTaskRun {
        id: row.get(0)?,
        recurring_task_id: row.get(1)?,
        project_id: row.get(2)?,
        trigger_source: row.get(3)?,
        status: row.get(4)?,
        scheduled_for: row.get(5)?,
        title_snapshot: row.get(6)?,
        description_snapshot: row.get(7)?,
        task_type_snapshot: row.get(8)?,
        agent_profile_snapshot: row.get(9)?,
        session_policy_snapshot: row.get(10)?,
        job_id: row.get(11)?,
        session_id: row.get(12)?,
        error_message: row.get(13)?,
        started_at: row.get(14)?,
        finished_at: row.get(15)?,
        created_at: row.get(16)?,
        updated_at: row.get(17)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_task() -> RecurringTask {
        RecurringTask {
            id: "repeat-1".into(),
            project_id: "project-1".into(),
            title: "日报".into(),
            description: "生成最新数据报告".into(),
            task_type: "readonly".into(),
            agent_profile: "Codex".into(),
            schedule_kind: "daily".into(),
            daily_time: Some("09:00".into()),
            timezone: "Asia/Shanghai".into(),
            enabled: true,
            session_policy: "fresh".into(),
            source_task_id: None,
            next_run_at: None,
            last_scheduled_for: None,
            created_at: "2026-08-12T00:00:00Z".into(),
            updated_at: "2026-08-12T00:00:00Z".into(),
        }
    }

    #[test]
    fn daily_schedule_uses_named_timezone() {
        let before = DateTime::parse_from_rfc3339("2026-08-12T00:30:00Z")
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(
            compute_next_run(&sample_task(), before).unwrap().as_deref(),
            Some("2026-08-12T01:00:00+00:00")
        );
        let after = DateTime::parse_from_rfc3339("2026-08-12T01:30:00Z")
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(
            compute_next_run(&sample_task(), after).unwrap().as_deref(),
            Some("2026-08-13T01:00:00+00:00")
        );
    }

    #[test]
    fn manual_or_paused_task_has_no_next_run() {
        let mut task = sample_task();
        task.enabled = false;
        assert_eq!(compute_next_run(&task, Utc::now()).unwrap(), None);
        task.enabled = true;
        task.schedule_kind = "manual".into();
        assert_eq!(compute_next_run(&task, Utc::now()).unwrap(), None);
    }
}
