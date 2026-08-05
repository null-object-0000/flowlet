use super::{Storage, StorageError};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub directory_path: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTask {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub description: String,
    pub status: String,
    pub task_type: String,
    pub agent_profile: String,
    pub priority: String,
    /// 基于某个已完成任务创建时记录其任务 id；执行时复用该任务的 Agent 会话继续推进。
    pub base_task_id: Option<String>,
    /// 最近一次执行的 background_job id（用于只读详情展示 Agent 执行情况）。
    pub last_job_id: Option<String>,
    /// 最近一次被退回的原因。执行开始时读取注入 prompt 后清空（不重复注入）。
    pub rejection_reason: Option<String>,
    /// 执行历史（JSON 数组，可空）。每次执行追加一条
    /// `{jobId, startedAt, rejected, rejectionReason, rejectedAt}`，供只读详情
    /// 展示全部历史执行与退回原因。
    pub execution_history: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl Storage {
    pub fn list_projects(&self) -> Result<Vec<Project>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let mut statement = connection.prepare(
            "SELECT id, name, directory_path, created_at, updated_at
             FROM projects ORDER BY updated_at DESC, name COLLATE NOCASE ASC",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(Project {
                id: row.get(0)?,
                name: row.get(1)?,
                directory_path: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StorageError::from)
    }

    pub fn get_project(&self, project_id: &str) -> Result<Option<Project>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let mut statement = connection.prepare(
            "SELECT id, name, directory_path, created_at, updated_at FROM projects WHERE id = ?1",
        )?;
        let mut rows = statement.query([project_id])?;
        let Some(row) = rows.next()? else {
            return Ok(None);
        };
        Ok(Some(Project {
            id: row.get(0)?,
            name: row.get(1)?,
            directory_path: row.get(2)?,
            created_at: row.get(3)?,
            updated_at: row.get(4)?,
        }))
    }

    pub fn save_project(&self, project: &Project) -> Result<(), StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        connection.execute(
            "INSERT INTO projects (id, name, directory_path, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET
               name = excluded.name,
               directory_path = excluded.directory_path,
               updated_at = excluded.updated_at",
            params![
                project.id,
                project.name,
                project.directory_path,
                project.created_at,
                project.updated_at
            ],
        )?;
        Ok(())
    }

    pub fn delete_project(&self, project_id: &str) -> Result<bool, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        Ok(connection.execute("DELETE FROM projects WHERE id = ?1", [project_id])? > 0)
    }

    pub fn list_project_tasks(&self, project_id: &str) -> Result<Vec<ProjectTask>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let mut statement = connection.prepare(
            "SELECT id, project_id, title, description, status, task_type, agent_profile, priority, base_task_id, last_job_id, rejection_reason, execution_history, created_at, updated_at
             FROM project_tasks WHERE project_id = ?1
             ORDER BY updated_at DESC, created_at DESC",
        )?;
        let rows = statement.query_map([project_id], map_project_task_row)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StorageError::from)
    }

    pub fn get_project_task(
        &self,
        project_id: &str,
        task_id: &str,
    ) -> Result<Option<ProjectTask>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let mut statement = connection.prepare(
            "SELECT id, project_id, title, description, status, task_type, agent_profile, priority, base_task_id, last_job_id, rejection_reason, execution_history, created_at, updated_at
             FROM project_tasks WHERE id = ?1 AND project_id = ?2",
        )?;
        let mut rows = statement.query(params![task_id, project_id])?;
        let Some(row) = rows.next()? else {
            return Ok(None);
        };
        Ok(Some(map_project_task_row(row)?))
    }

    /// 读取单个任务的当前状态（仅任务 id，供状态迁移校验）。
    pub fn get_task_status(&self, task_id: &str) -> Result<Option<String>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        connection
            .query_row(
                "SELECT status FROM project_tasks WHERE id = ?1",
                [task_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(StorageError::from)
    }

    /// 单字段更新任务状态（只改 status + updated_at，不整表覆盖）。
    pub fn set_task_status(&self, task_id: &str, status: &str) -> Result<bool, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let now = chrono::Utc::now().to_rfc3339();
        Ok(connection.execute(
            "UPDATE project_tasks SET status = ?2, updated_at = ?3 WHERE id = ?1",
            params![task_id, status, now],
        )? > 0)
    }

    /// 跨项目聚合「已提交、待执行」的任务，供调度器领取。
    /// 排序：优先级 p0 > p1 > p2，同优先级按创建时间先到先执行。
    pub fn list_queued_project_tasks(&self) -> Result<Vec<ProjectTask>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let mut statement = connection.prepare(
            "SELECT id, project_id, title, description, status, task_type, agent_profile, priority, base_task_id, last_job_id, rejection_reason, execution_history, created_at, updated_at
             FROM project_tasks WHERE status = 'submitted'
             ORDER BY CASE priority WHEN 'p0' THEN 0 WHEN 'p1' THEN 1 WHEN 'p2' THEN 2 ELSE 3 END,
                      created_at ASC",
        )?;
        let rows = statement.query_map([], |row| map_project_task_row(row))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StorageError::from)
    }

    pub fn save_project_task(&self, task: &ProjectTask) -> Result<(), StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        // last_job_id / rejection_reason / execution_history 只在任务执行或退回时
        // 由专用方法写入，编辑保存不覆盖它们。
        connection.execute(
            "INSERT INTO project_tasks (id, project_id, title, description, status, task_type, agent_profile, priority, base_task_id, last_job_id, rejection_reason, execution_history, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
             ON CONFLICT(id) DO UPDATE SET
               title = excluded.title,
               description = excluded.description,
               status = excluded.status,
               task_type = excluded.task_type,
               agent_profile = excluded.agent_profile,
               priority = excluded.priority,
               base_task_id = excluded.base_task_id,
               updated_at = excluded.updated_at
             WHERE project_tasks.project_id = excluded.project_id",
            params![task.id, task.project_id, task.title, task.description, task.status, task.task_type, task.agent_profile, task.priority, task.base_task_id, task.last_job_id, task.rejection_reason, task.execution_history, task.created_at, task.updated_at],
        )?;
        Ok(())
    }

    /// 记录任务最近一次执行的 job id（供只读详情展示 Agent 执行情况）。
    pub fn set_task_last_job(&self, task_id: &str, job_id: &str) -> Result<bool, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        Ok(connection.execute(
            "UPDATE project_tasks SET last_job_id = ?2 WHERE id = ?1",
            params![task_id, job_id],
        )? > 0)
    }

    /// 读取任务最近一次执行的 job id（供退回时把原因写进对应 job 的 timeline）。
    pub fn get_task_last_job(&self, task_id: &str) -> Result<Option<String>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        connection
            .query_row(
                "SELECT last_job_id FROM project_tasks WHERE id = ?1",
                [task_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map(|value| value.flatten())
            .map_err(StorageError::from)
    }

    /// 在执行开始时追加一条执行历史。
    /// `submitted_at` 是本轮进入待处理（提交 / 退回）的时刻，由调用方在任务被标记
    /// `in_progress` **之前**读取（即 `task.updated_at`），用于计算本轮等待耗时。
    /// 记录结构：`{jobId, startedAt, submittedAt, finishedAt, waitingMs, executionMs, ...}`。
    pub fn append_task_execution(
        &self,
        task_id: &str,
        job_id: &str,
        submitted_at: &str,
    ) -> Result<bool, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let current: Option<String> = connection
            .query_row(
                "SELECT execution_history FROM project_tasks WHERE id = ?1",
                [task_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten();
        let mut entries: Vec<Value> = current
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or_default();
        let now = chrono::Utc::now();
        let started_at = now.to_rfc3339();
        // 本轮等待时长 = 开始执行时刻 - 进入待处理时刻（解析失败按 0 处理）。
        let waiting_ms = parse_epoch_millis(submitted_at)
            .map(|submitted| (now.timestamp_millis() - submitted).max(0))
            .unwrap_or(0);
        entries.push(json!({
            "jobId": job_id,
            "startedAt": started_at,
            "submittedAt": submitted_at,
            "finishedAt": null,
            "waitingMs": waiting_ms,
            "executionMs": null,
            "rejected": false,
            "rejectionReason": null,
            "rejectedAt": null,
        }));
        let serialized = serde_json::to_string(&entries)
            .map_err(|error| StorageError::InvalidImport(error.to_string()))?;
        Ok(connection.execute(
            "UPDATE project_tasks SET execution_history = ?2 WHERE id = ?1",
            params![task_id, serialized],
        )? > 0)
    }

    /// 在执行结束时标记执行历史中对应 job 的结束时间与执行耗时。
    /// `finishedAt` 取真实结束时刻（Agent 退出时间），据此计算 `executionMs`；
    /// 不把退回 / 审核等待时间计入执行耗时。
    /// 幂等：记录已有 finishedAt 时不再覆盖；找不到对应 job 时静默成功。
    pub fn finish_task_execution(&self, task_id: &str, job_id: &str) -> Result<bool, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let current: Option<String> = connection
            .query_row(
                "SELECT execution_history FROM project_tasks WHERE id = ?1",
                [task_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten();
        let Some(current) = current else {
            return Ok(false);
        };
        let mut entries: Vec<Value> =
            serde_json::from_str(&current).unwrap_or_default();
        let mut found = false;
        let finished_at = chrono::Utc::now();
        let finished_at_str = finished_at.to_rfc3339();
        for entry in &mut entries {
            if entry.get("jobId").and_then(Value::as_str) == Some(job_id) {
                // 已记录过结束时间：幂等返回，不覆盖真实结束时刻。
                if entry.get("finishedAt").and_then(Value::as_str).is_some() {
                    return Ok(true);
                }
                // 执行耗时 = 结束时刻 - 本轮开始时刻（解析失败按 0 处理）。
                let execution_ms = entry
                    .get("startedAt")
                    .and_then(Value::as_str)
                    .and_then(parse_epoch_millis)
                    .map(|start| (finished_at.timestamp_millis() - start).max(0))
                    .unwrap_or(0);
                entry["finishedAt"] = json!(finished_at_str);
                entry["executionMs"] = json!(execution_ms);
                found = true;
            }
        }
        if !found {
            return Ok(false);
        }
        let serialized = serde_json::to_string(&entries)
            .map_err(|error| StorageError::InvalidImport(error.to_string()))?;
        Ok(connection.execute(
            "UPDATE project_tasks SET execution_history = ?2 WHERE id = ?1",
            params![task_id, serialized],
        )? > 0)
    }

    /// 退回时标记执行历史中对应 job 为已退回，并记录原因与时间。
    pub fn mark_task_execution_rejected(
        &self,
        task_id: &str,
        job_id: &str,
        reason: &str,
    ) -> Result<bool, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let current: Option<String> = connection
            .query_row(
                "SELECT execution_history FROM project_tasks WHERE id = ?1",
                [task_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten();
        let Some(current) = current else {
            return Ok(false);
        };
        let mut entries: Vec<Value> =
            serde_json::from_str(&current).unwrap_or_default();
        let mut found = false;
        for entry in &mut entries {
            if entry.get("jobId").and_then(Value::as_str) == Some(job_id) {
                entry["rejected"] = json!(true);
                entry["rejectionReason"] = json!(reason);
                entry["rejectedAt"] = json!(chrono::Utc::now().to_rfc3339());
                found = true;
            }
        }
        if !found {
            return Ok(false);
        }
        let serialized = serde_json::to_string(&entries)
            .map_err(|error| StorageError::InvalidImport(error.to_string()))?;
        Ok(connection.execute(
            "UPDATE project_tasks SET execution_history = ?2 WHERE id = ?1",
            params![task_id, serialized],
        )? > 0)
    }

    /// 写入 / 清空任务的退回原因。执行开始时读取并注入 prompt 后调用 None 清空，
    /// 避免下次执行重复注入同一个原因。
    pub fn set_task_rejection_reason(
        &self,
        task_id: &str,
        reason: Option<&str>,
    ) -> Result<bool, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        Ok(connection.execute(
            "UPDATE project_tasks SET rejection_reason = ?2 WHERE id = ?1",
            params![task_id, reason],
        )? > 0)
    }

    /// 读取任务的状态与类型（供审核通道校验迁移合法性）。
    pub fn get_task_state(&self, task_id: &str) -> Result<Option<(String, String)>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        connection
            .query_row(
                "SELECT status, task_type FROM project_tasks WHERE id = ?1",
                [task_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(StorageError::from)
    }

    /// 只读分析任务 → 代码修改任务（仅 review 状态由审核通道调用）。
    /// 一次更新 task_type / description / status / updated_at：新的代码修改要求写入
    /// description，状态回到 submitted 重新排队，以代码修改类型重新执行。
    /// WHERE 限定 readonly + review，并发下不会误改其它状态的任务。
    pub fn convert_task_to_code(
        &self,
        task_id: &str,
        description: &str,
    ) -> Result<bool, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let now = chrono::Utc::now().to_rfc3339();
        Ok(connection.execute(
            "UPDATE project_tasks
             SET task_type = 'code', description = ?2, status = 'submitted', updated_at = ?3
             WHERE id = ?1 AND task_type = 'readonly' AND status = 'review'",
            params![task_id, description, now],
        )? > 0)
    }

    pub fn delete_project_task(
        &self,
        project_id: &str,
        task_id: &str,
    ) -> Result<bool, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        Ok(connection.execute(
            "DELETE FROM project_tasks WHERE id = ?1 AND project_id = ?2",
            params![task_id, project_id],
        )? > 0)
    }
}

/// 解析时间戳为 Unix 毫秒。支持 ISO 8601（RFC3339，如 `2026-08-04T20:00:00Z`）
/// 与 SQLite `datetime('now')` 产出的 `YYYY-MM-DD HH:MM:SS`（UTC 无时区标记）。
fn parse_epoch_millis(value: &str) -> Option<i64> {
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(value) {
        return Some(dt.timestamp_millis());
    }
    chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S")
        .ok()
        .map(|dt| dt.and_utc().timestamp_millis())
}

fn map_project_task_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ProjectTask> {
    Ok(ProjectTask {
        id: row.get(0)?,
        project_id: row.get(1)?,
        title: row.get(2)?,
        description: row.get(3)?,
        status: row.get(4)?,
        task_type: row.get(5)?,
        agent_profile: row.get(6)?,
        priority: row.get(7)?,
        base_task_id: row.get(8)?,
        last_job_id: row.get(9)?,
        rejection_reason: row.get(10)?,
        execution_history: row.get(11)?,
        created_at: row.get(12)?,
        updated_at: row.get(13)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn project_delete_cascades_local_tasks() {
        let storage = Storage::from_connection_for_test(Connection::open_in_memory().unwrap());
        storage.migrate().unwrap();
        let project = Project {
            id: "project-1".into(),
            name: "Flowlet".into(),
            directory_path: "D:\\work\\flowlet".into(),
            created_at: "2026-08-03T00:00:00Z".into(),
            updated_at: "2026-08-03T00:00:00Z".into(),
        };
        storage.save_project(&project).unwrap();
        storage
            .save_project_task(&ProjectTask {
                id: "task-1".into(),
                project_id: project.id.clone(),
                title: "First task".into(),
                description: String::new(),
                status: "draft".into(),
                task_type: "code".into(),
                agent_profile: "Claude Code".into(),
                priority: "p1".into(),
                base_task_id: None,
                last_job_id: None,
                rejection_reason: None,
                execution_history: None,
                created_at: project.created_at.clone(),
                updated_at: project.updated_at.clone(),
            })
            .unwrap();
        assert_eq!(storage.list_project_tasks(&project.id).unwrap().len(), 1);
        assert!(storage.delete_project(&project.id).unwrap());
        assert!(storage.list_project_tasks(&project.id).unwrap().is_empty());
    }

    fn sample_task(id: &str, status: &str, priority: &str, created_at: &str) -> ProjectTask {
        ProjectTask {
            id: id.into(),
            project_id: "project-1".into(),
            title: format!("Task {id}"),
            description: String::new(),
            status: status.into(),
            task_type: "code".into(),
            agent_profile: "Claude Code".into(),
            priority: priority.into(),
            base_task_id: None,
            last_job_id: None,
            rejection_reason: None,
            execution_history: None,
            created_at: created_at.into(),
            updated_at: created_at.into(),
        }
    }

    #[test]
    fn set_task_status_updates_only_status_and_timestamp() {
        let storage = Storage::from_connection_for_test(Connection::open_in_memory().unwrap());
        storage.migrate().unwrap();
        let project = Project {
            id: "project-1".into(),
            name: "Flowlet".into(),
            directory_path: "D:\\work\\flowlet".into(),
            created_at: "2026-08-03T00:00:00Z".into(),
            updated_at: "2026-08-03T00:00:00Z".into(),
        };
        storage.save_project(&project).unwrap();
        storage.save_project_task(&sample_task("task-1", "submitted", "p1", "2026-08-03T00:00:00Z")).unwrap();

        assert!(storage.set_task_status("task-1", "in_progress").unwrap());
        let task = storage.get_project_task("project-1", "task-1").unwrap().unwrap();
        assert_eq!(task.status, "in_progress");
        assert!(task.updated_at.as_str() > "2026-08-03T00:00:00Z");

        // 不存在的任务返回 false，不报错。
        assert!(!storage.set_task_status("missing", "done").unwrap());
    }

    #[test]
    fn project_task_persists_base_task_id() {
        let storage = Storage::from_connection_for_test(Connection::open_in_memory().unwrap());
        storage.migrate().unwrap();
        let project = Project {
            id: "project-1".into(),
            name: "Flowlet".into(),
            directory_path: "D:\\work\\flowlet".into(),
            created_at: "2026-08-03T00:00:00Z".into(),
            updated_at: "2026-08-03T00:00:00Z".into(),
        };
        storage.save_project(&project).unwrap();
        let mut task = sample_task("task-1", "draft", "p1", "2026-08-03T00:00:00Z");
        task.base_task_id = Some("base-1".to_string());
        storage.save_project_task(&task).unwrap();

        // 基于已完成任务创建时记录的 base_task_id 持久化并可回读。
        let loaded = storage.get_project_task("project-1", "task-1").unwrap().unwrap();
        assert_eq!(loaded.base_task_id.as_deref(), Some("base-1"));
        // 编辑保存不丢 base_task_id（按值回写）。
        let mut edited = loaded.clone();
        edited.title = "改标题".to_string();
        storage.save_project_task(&edited).unwrap();
        let reloaded = storage.get_project_task("project-1", "task-1").unwrap().unwrap();
        assert_eq!(reloaded.title, "改标题");
        assert_eq!(reloaded.base_task_id.as_deref(), Some("base-1"));
    }

    #[test]
    fn list_queued_project_tasks_orders_by_priority_then_created_at() {
        let storage = Storage::from_connection_for_test(Connection::open_in_memory().unwrap());
        storage.migrate().unwrap();
        let project = Project {
            id: "project-1".into(),
            name: "Flowlet".into(),
            directory_path: "D:\\work\\flowlet".into(),
            created_at: "2026-08-03T00:00:00Z".into(),
            updated_at: "2026-08-03T00:00:00Z".into(),
        };
        storage.save_project(&project).unwrap();
        for task in [
            sample_task("p2-late", "submitted", "p2", "2026-08-03T03:00:00Z"),
            sample_task("p0-early", "submitted", "p0", "2026-08-03T00:00:00Z"),
            sample_task("p1-mid", "submitted", "p1", "2026-08-03T02:00:00Z"),
            sample_task("draft-skip", "draft", "p1", "2026-08-03T01:00:00Z"),
        ] {
            storage.save_project_task(&task).unwrap();
        }

        let queued = storage.list_queued_project_tasks().unwrap();
        let ids: Vec<&str> = queued.iter().map(|task| task.id.as_str()).collect();
        // 只含 submitted；p0 优先、再 p1、再 p2；草稿不参与调度。
        assert_eq!(ids, vec!["p0-early", "p1-mid", "p2-late"]);
    }

    #[test]
    fn append_task_execution_persists_on_null_history() {
        let storage = Storage::from_connection_for_test(Connection::open_in_memory().unwrap());
        storage.migrate().unwrap();
        let project = Project {
            id: "project-1".into(),
            name: "Flowlet".into(),
            directory_path: "D:\\work\\flowlet".into(),
            created_at: "2026-08-03T00:00:00Z".into(),
            updated_at: "2026-08-03T00:00:00Z".into(),
        };
        storage.save_project(&project).unwrap();
        storage.save_project_task(&sample_task("task-1", "submitted", "p1", "2026-08-03T00:00:00Z")).unwrap();

        // 修复回归：execution_history 为 NULL 时不能再因 InvalidColumnType 报错。
        assert!(storage.append_task_execution("task-1", "job-1", "2026-08-03T00:00:00Z").unwrap());
        assert!(storage.append_task_execution("task-1", "job-2", "2026-08-03T00:00:00Z").unwrap());

        let task = storage.get_project_task("project-1", "task-1").unwrap().unwrap();
        let history: Vec<Value> =
            serde_json::from_str(task.execution_history.as_deref().unwrap()).unwrap();
        assert_eq!(history.len(), 2);
        assert_eq!(history[0]["jobId"].as_str(), Some("job-1"));
        assert_eq!(history[1]["jobId"].as_str(), Some("job-2"));
        assert_eq!(history[0]["rejected"].as_bool(), Some(false));
        // 新一轮执行记录进入待处理时刻与等待耗时；执行结束前 executionMs 为空。
        assert_eq!(history[0]["submittedAt"].as_str(), Some("2026-08-03T00:00:00Z"));
        assert!(history[0]["waitingMs"].as_u64().is_some());
        assert_eq!(history[0]["executionMs"], Value::Null);
    }

    #[test]
    fn mark_task_execution_rejected_marks_the_latest_job() {
        let storage = Storage::from_connection_for_test(Connection::open_in_memory().unwrap());
        storage.migrate().unwrap();
        let project = Project {
            id: "project-1".into(),
            name: "Flowlet".into(),
            directory_path: "D:\\work\\flowlet".into(),
            created_at: "2026-08-03T00:00:00Z".into(),
            updated_at: "2026-08-03T00:00:00Z".into(),
        };
        storage.save_project(&project).unwrap();
        storage.save_project_task(&sample_task("task-1", "submitted", "p1", "2026-08-03T00:00:00Z")).unwrap();
        storage.append_task_execution("task-1", "job-1", "2026-08-03T00:00:00Z").unwrap();

        assert!(storage
            .mark_task_execution_rejected("task-1", "job-1", "不符合预期")
            .unwrap());
        let task = storage.get_project_task("project-1", "task-1").unwrap().unwrap();
        let history: Vec<Value> =
            serde_json::from_str(task.execution_history.as_deref().unwrap()).unwrap();
        assert_eq!(history[0]["rejected"].as_bool(), Some(true));
        assert_eq!(history[0]["rejectionReason"].as_str(), Some("不符合预期"));
    }

    #[test]
    fn finish_task_execution_records_ended_at_once() {
        let storage = Storage::from_connection_for_test(Connection::open_in_memory().unwrap());
        storage.migrate().unwrap();
        let project = Project {
            id: "project-1".into(),
            name: "Flowlet".into(),
            directory_path: "D:\\work\\flowlet".into(),
            created_at: "2026-08-03T00:00:00Z".into(),
            updated_at: "2026-08-03T00:00:00Z".into(),
        };
        storage.save_project(&project).unwrap();
        storage.save_project_task(&sample_task("task-1", "review", "p1", "2026-08-03T00:00:00Z")).unwrap();
        storage.append_task_execution("task-1", "job-1", "2026-08-03T00:00:00Z").unwrap();

        // 第一次写入结束时间：执行耗时为真实结束时刻 - 本轮开始时刻。
        assert!(storage.finish_task_execution("task-1", "job-1").unwrap());
        let task = storage.get_project_task("project-1", "task-1").unwrap().unwrap();
        let history: Vec<Value> =
            serde_json::from_str(task.execution_history.as_deref().unwrap()).unwrap();
        let finished = history[0]["finishedAt"].as_str().unwrap().to_string();
        assert!(history[0]["executionMs"].as_u64().is_some());

        // 幂等：再次调用不覆盖真实结束时刻。
        assert!(storage.finish_task_execution("task-1", "job-1").unwrap());
        let task = storage.get_project_task("project-1", "task-1").unwrap().unwrap();
        let history: Vec<Value> =
            serde_json::from_str(task.execution_history.as_deref().unwrap()).unwrap();
        assert_eq!(history[0]["finishedAt"].as_str().unwrap(), finished);

        // 未知 job / 未知任务返回 false，不报错。
        assert!(!storage.finish_task_execution("task-1", "missing-job").unwrap());
        assert!(!storage.finish_task_execution("missing-task", "job-1").unwrap());
    }

    #[test]
    fn convert_task_to_code_only_accepts_review_readonly_task() {
        let storage = Storage::from_connection_for_test(Connection::open_in_memory().unwrap());
        storage.migrate().unwrap();
        let project = Project {
            id: "project-1".into(),
            name: "Flowlet".into(),
            directory_path: "D:\\work\\flowlet".into(),
            created_at: "2026-08-03T00:00:00Z".into(),
            updated_at: "2026-08-03T00:00:00Z".into(),
        };
        storage.save_project(&project).unwrap();
        let mut task = sample_task("task-1", "review", "p1", "2026-08-03T00:00:00Z");
        task.task_type = "readonly".into();
        storage.save_project_task(&task).unwrap();

        // 待审核的只读任务可以转换：类型变 code、描述替换、状态回到 submitted 重新排队。
        assert!(storage.convert_task_to_code("task-1", "修复缓存过期问题").unwrap());
        let converted = storage.get_project_task("project-1", "task-1").unwrap().unwrap();
        assert_eq!(converted.task_type, "code");
        assert_eq!(converted.description, "修复缓存过期问题");
        assert_eq!(converted.status, "submitted");

        // 再次转换失败：此时类型已是 code，不再命中 readonly + review 的守卫条件。
        assert!(!storage.convert_task_to_code("task-1", "再次转换").unwrap());
    }

    #[test]
    fn convert_task_to_code_rejects_non_review_or_non_readonly() {
        let storage = Storage::from_connection_for_test(Connection::open_in_memory().unwrap());
        storage.migrate().unwrap();
        let project = Project {
            id: "project-1".into(),
            name: "Flowlet".into(),
            directory_path: "D:\\work\\flowlet".into(),
            created_at: "2026-08-03T00:00:00Z".into(),
            updated_at: "2026-08-03T00:00:00Z".into(),
        };
        storage.save_project(&project).unwrap();
        // 待审核但类型是 code（已是代码修改任务），不允许转换。
        storage.save_project_task(&sample_task("code-task", "review", "p1", "2026-08-03T00:00:00Z")).unwrap();
        assert!(!storage.convert_task_to_code("code-task", "说明").unwrap());
        // 只读分析但状态是 done（已完成），不允许转换。
        let mut done_task = sample_task("done-task", "done", "p1", "2026-08-03T00:00:00Z");
        done_task.task_type = "readonly".into();
        storage.save_project_task(&done_task).unwrap();
        assert!(!storage.convert_task_to_code("done-task", "说明").unwrap());
        // 不存在的任务返回 false。
        assert!(!storage.convert_task_to_code("missing", "说明").unwrap());
    }

    #[test]
    fn migrate_backfills_task_execution_history_from_jobs() {
        let storage = Storage::from_connection_for_test(Connection::open_in_memory().unwrap());
        storage.migrate().unwrap();
        let project = Project {
            id: "project-1".into(),
            name: "Flowlet".into(),
            directory_path: "D:\\work\\flowlet".into(),
            created_at: "2026-08-03T00:00:00Z".into(),
            updated_at: "2026-08-03T00:00:00Z".into(),
        };
        storage.save_project(&project).unwrap();
        // 模拟旧数据：任务有 last_job_id 但 execution_history 为 NULL。
        let mut task = sample_task("task-1", "review", "p1", "2026-08-03T00:00:00Z");
        task.last_job_id = Some("job-2".into());
        task.execution_history = None;
        storage.save_project_task(&task).unwrap();

        // 两条同名的 project-task-run 后台记录。
        storage
            .create_job(
                "job-1",
                "project-task-run",
                "任务执行：Task task-1",
                "完成",
                "manual",
                1,
                "开始执行",
            )
            .unwrap();
        storage
            .create_job(
                "job-2",
                "project-task-run",
                "任务执行：Task task-1",
                "完成",
                "manual",
                1,
                "开始执行",
            )
            .unwrap();

        // 重新 migrate 触发幂等 backfill。
        storage.migrate().unwrap();
        let task = storage.get_project_task("project-1", "task-1").unwrap().unwrap();
        let history: Vec<Value> =
            serde_json::from_str(task.execution_history.as_deref().unwrap()).unwrap();
        assert_eq!(history.len(), 2);
        assert_eq!(history[0]["jobId"].as_str(), Some("job-1"));
        assert_eq!(history[1]["jobId"].as_str(), Some("job-2"));
    }

    #[test]
    fn migrate_backfills_execution_duration_from_finished_jobs() {
        let storage = Storage::from_connection_for_test(Connection::open_in_memory().unwrap());
        storage.migrate().unwrap();
        let project = Project {
            id: "project-1".into(),
            name: "Flowlet".into(),
            directory_path: "D:\\work\\flowlet".into(),
            created_at: "2026-08-03T00:00:00Z".into(),
            updated_at: "2026-08-03T00:00:00Z".into(),
        };
        storage.save_project(&project).unwrap();
        // 模拟旧数据：已有执行历史但缺 finishedAt / executionMs（历史任务应能取到执行耗时）。
        let mut task = sample_task("task-1", "done", "p1", "2026-08-03T00:00:00Z");
        task.execution_history = Some(
            serde_json::json!([{
                "jobId": "job-1",
                "startedAt": "2026-08-03T00:00:00Z",
                "submittedAt": null,
                "finishedAt": null,
                "waitingMs": 0,
                "executionMs": null,
                "rejected": false,
                "rejectionReason": null,
                "rejectedAt": null,
            }])
            .to_string(),
        );
        storage.save_project_task(&task).unwrap();

        // background_jobs 中该 job 已结束（finish_job 写入真实 finished_at）。
        storage
            .create_job("job-1", "project-task-run", "任务执行：Task task-1", "完成", "manual", 1, "开始执行")
            .unwrap();
        storage
            .finish_job("job-1", "succeeded", "{}", "任务执行完成")
            .unwrap();

        // 重新 migrate 触发幂等 backfill：从 background_jobs 补 finishedAt 与 executionMs。
        storage.migrate().unwrap();
        let task = storage.get_project_task("project-1", "task-1").unwrap().unwrap();
        let history: Vec<Value> =
            serde_json::from_str(task.execution_history.as_deref().unwrap()).unwrap();
        assert!(history[0]["finishedAt"].as_str().is_some());
        assert!(history[0]["executionMs"].as_u64().unwrap() > 0);
    }
}
