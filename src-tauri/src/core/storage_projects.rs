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
            "SELECT id, project_id, title, description, status, task_type, agent_profile, priority, last_job_id, rejection_reason, execution_history, created_at, updated_at
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
            "SELECT id, project_id, title, description, status, task_type, agent_profile, priority, last_job_id, rejection_reason, execution_history, created_at, updated_at
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
            "SELECT id, project_id, title, description, status, task_type, agent_profile, priority, last_job_id, rejection_reason, execution_history, created_at, updated_at
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
            "INSERT INTO project_tasks (id, project_id, title, description, status, task_type, agent_profile, priority, last_job_id, rejection_reason, execution_history, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
             ON CONFLICT(id) DO UPDATE SET
               title = excluded.title,
               description = excluded.description,
               status = excluded.status,
               task_type = excluded.task_type,
               agent_profile = excluded.agent_profile,
               priority = excluded.priority,
               updated_at = excluded.updated_at
             WHERE project_tasks.project_id = excluded.project_id",
            params![task.id, task.project_id, task.title, task.description, task.status, task.task_type, task.agent_profile, task.priority, task.last_job_id, task.rejection_reason, task.execution_history, task.created_at, task.updated_at],
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
                |row| row.get(0),
            )
            .optional()
            .map_err(StorageError::from)
    }

    /// 在执行开始时追加一条执行历史 `{jobId, startedAt, rejected:false}`。
    pub fn append_task_execution(&self, task_id: &str, job_id: &str) -> Result<bool, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let current: Option<String> = connection
            .query_row(
                "SELECT execution_history FROM project_tasks WHERE id = ?1",
                [task_id],
                |row| row.get(0),
            )
            .optional()?;
        let mut entries: Vec<Value> = current
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or_default();
        entries.push(json!({
            "jobId": job_id,
            "startedAt": chrono::Utc::now().to_rfc3339(),
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
                |row| row.get(0),
            )
            .optional()?;
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
        last_job_id: row.get(8)?,
        rejection_reason: row.get(9)?,
        execution_history: row.get(10)?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
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
}
