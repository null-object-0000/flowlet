use super::{Storage, StorageError};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    /// 本机绑定目录。可空：远端项目同步到本机后未绑定目录时为空，
    /// 绑定目录后该设备才成为该项目的执行候选。
    #[serde(default)]
    pub directory_path: Option<String>,
    /// 项目在工作区（S3 加密对象）中的稳定标识。本机新建尚未同步时为 None。
    #[serde(default)]
    pub workspace_project_id: Option<String>,
    /// 远端归档标记（墓碑）。归档项目在列表中隐藏，删除动作传播到其它设备。
    #[serde(default)]
    pub workspace_archived: bool,
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
    /// 跨设备领取归属：最近一次执行该任务的设备 id。仅用于防止多台设备
    /// 对同一任务重复执行，不参与同步。
    #[serde(default)]
    pub claimed_by: Option<String>,
    /// 最近一次领取时间（RFC3339）。领取超过租约窗口后其他设备可重新领取。
    #[serde(default)]
    pub claimed_at: Option<String>,
    /// 队列置顶时间（RFC3339）：已提交待执行任务被用户「置顶」提到队列最前。
    /// 设备本地字段，不参与工作区同步；任务被领取执行时清空。
    #[serde(default)]
    pub queue_boosted_at: Option<String>,
    /// 软删除标记：删除任务跨设备传播时使用墓碑，列表中过滤 `deleted = 1`。
    #[serde(default)]
    pub deleted: bool,
}

impl Storage {
    pub fn list_projects(&self) -> Result<Vec<Project>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let mut statement = connection.prepare(
            "SELECT id, name, directory_path, workspace_project_id, workspace_archived, created_at, updated_at
             FROM projects
             WHERE workspace_archived = 0
             ORDER BY updated_at DESC, name COLLATE NOCASE ASC",
        )?;
        let rows = statement.query_map([], map_project_row)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StorageError::from)
    }

    /// 供项目工作区同步使用：返回全部未归档项目（含未绑定目录的远端项目），
    /// 不含 `workspace_archived` 过滤。同步方据此决定推送或合并。
    pub fn list_projects_for_workspace(&self) -> Result<Vec<Project>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let mut statement = connection.prepare(
            "SELECT id, name, directory_path, workspace_project_id, workspace_archived, created_at, updated_at
             FROM projects
             WHERE workspace_archived = 0
             ORDER BY updated_at ASC, name COLLATE NOCASE ASC",
        )?;
        let rows = statement.query_map([], map_project_row)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StorageError::from)
    }

    pub fn get_project(&self, project_id: &str) -> Result<Option<Project>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let mut statement = connection.prepare(
            "SELECT id, name, directory_path, workspace_project_id, workspace_archived, created_at, updated_at FROM projects WHERE id = ?1",
        )?;
        let mut rows = statement.query([project_id])?;
        let Some(row) = rows.next()? else {
            return Ok(None);
        };
        Ok(Some(map_project_row(row)?))
    }

    /// 按工作区项目 id 查找本机项目（远端项目同步到本机后的关联方式）。
    pub fn get_project_by_workspace_id(
        &self,
        workspace_project_id: &str,
    ) -> Result<Option<Project>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let mut statement = connection.prepare(
            "SELECT id, name, directory_path, workspace_project_id, workspace_archived, created_at, updated_at
             FROM projects WHERE workspace_project_id = ?1",
        )?;
        let mut rows = statement.query([workspace_project_id])?;
        let Some(row) = rows.next()? else {
            return Ok(None);
        };
        Ok(Some(map_project_row(row)?))
    }

    /// 按本机目录查找项目（目录唯一性约束用）。
    ///
    /// 目录比较用 `normalize_directory_path` 归一化（统一分隔符、尾部分隔符与大小写），
    /// 因此 `D:\work\flowlet`、`D:/work/flowlet/` 视为同一目录。未绑定目录
    /// （`directory_path IS NULL`）与已归档项目不参与比较。
    pub fn get_project_by_directory(
        &self,
        directory_path: &str,
    ) -> Result<Option<Project>, StorageError> {
        let normalized = normalize_directory_path(directory_path);
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let mut statement = connection.prepare(
            "SELECT id, name, directory_path, workspace_project_id, workspace_archived, created_at, updated_at
             FROM projects WHERE directory_path IS NOT NULL AND workspace_archived = 0",
        )?;
        let rows = statement.query_map([], map_project_row)?;
        for row in rows {
            let project = row?;
            let Some(stored) = project.directory_path.as_deref() else {
                continue;
            };
            if normalize_directory_path(stored) == normalized {
                return Ok(Some(project));
            }
        }
        Ok(None)
    }

    pub fn save_project(&self, project: &Project) -> Result<(), StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        connection.execute(
            "INSERT INTO projects (id, name, directory_path, workspace_project_id, workspace_archived, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(id) DO UPDATE SET
               name = excluded.name,
               directory_path = excluded.directory_path,
               workspace_project_id = excluded.workspace_project_id,
               workspace_archived = excluded.workspace_archived,
               updated_at = excluded.updated_at",
            params![
                project.id,
                project.name,
                project.directory_path,
                project.workspace_project_id,
                project.workspace_archived,
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

    /// 按工作区项目 id 删除本机项目（远端墓碑落地时使用），级联删除任务。
    pub fn delete_project_by_workspace_id(
        &self,
        workspace_project_id: &str,
    ) -> Result<bool, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        Ok(connection.execute(
            "DELETE FROM projects WHERE workspace_project_id = ?1",
            [workspace_project_id],
        )? > 0)
    }

    /// 标记本机项目归档（墓碑由远端工作区对象带到本机后调用）。
    pub fn archive_project_by_workspace_id(
        &self,
        workspace_project_id: &str,
    ) -> Result<bool, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        Ok(connection.execute(
            "UPDATE projects SET workspace_archived = 1, updated_at = datetime('now') WHERE workspace_project_id = ?1",
            [workspace_project_id],
        )? > 0)
    }

    pub fn list_project_tasks(&self, project_id: &str) -> Result<Vec<ProjectTask>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let mut statement = connection.prepare(
            "SELECT id, project_id, title, description, status, task_type, agent_profile, priority, base_task_id, last_job_id, rejection_reason, execution_history, created_at, updated_at, claimed_by, claimed_at, queue_boosted_at, deleted
             FROM project_tasks WHERE project_id = ?1 AND deleted = 0
             ORDER BY updated_at DESC, created_at DESC",
        )?;
        let rows = statement.query_map([project_id], map_project_task_row)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(StorageError::from)
    }

    /// 读取项目下全部任务（含软删除），供工作区合并使用。
    /// 普通列表使用 `list_project_tasks`（过滤 `deleted = 1`）。
    pub fn list_project_tasks_including_deleted(
        &self,
        project_id: &str,
    ) -> Result<Vec<ProjectTask>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let mut statement = connection.prepare(
            "SELECT id, project_id, title, description, status, task_type, agent_profile, priority, base_task_id, last_job_id, rejection_reason, execution_history, created_at, updated_at, claimed_by, claimed_at, queue_boosted_at, deleted
             FROM project_tasks WHERE project_id = ?1",
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
            "SELECT id, project_id, title, description, status, task_type, agent_profile, priority, base_task_id, last_job_id, rejection_reason, execution_history, created_at, updated_at, claimed_by, claimed_at, queue_boosted_at, deleted
             FROM project_tasks WHERE id = ?1 AND project_id = ?2 AND deleted = 0",
        )?;
        let mut rows = statement.query(params![task_id, project_id])?;
        let Some(row) = rows.next()? else {
            return Ok(None);
        };
        Ok(Some(map_project_task_row(row)?))
    }

    /// 跨项目读取任务完整信息（仅按任务 id），供 mutation command 做跨设备权限校验。
    pub fn get_project_task_by_id(
        &self,
        task_id: &str,
    ) -> Result<Option<ProjectTask>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        connection
            .query_row(
                "SELECT id, project_id, title, description, status, task_type, agent_profile, priority, base_task_id, last_job_id, rejection_reason, execution_history, created_at, updated_at, claimed_by, claimed_at, queue_boosted_at, deleted
                 FROM project_tasks WHERE id = ?1",
                [task_id],
                |row| map_project_task_row(row),
            )
            .optional()
            .map_err(StorageError::from)
    }

    /// 任务是否归属于其他设备（本机不可操作）：执行过 / 执行中 / 父任务归属其他设备。
    /// 任务不存在时返回 true（调用方应先用 `get_project_task_by_id` 确认存在并给出明确错误）。
    pub fn task_is_owned_by_other_device(
        &self,
        task_id: &str,
        current_device_id: &str,
    ) -> Result<bool, StorageError> {
        let Some(task) = self.get_project_task_by_id(task_id)? else {
            return Ok(true);
        };
        if task_owned_by_other_device(&task, current_device_id) {
            return Ok(true);
        }
        // 子任务归属：父任务属于其他设备（或本机查不到父任务）→ 不可操作。
        if let Some(base_id) = task.base_task_id.as_deref() {
            return match self.get_project_task_by_id(base_id)? {
                Some(parent) => Ok(task_owned_by_other_device(&parent, current_device_id)),
                None => Ok(true),
            };
        }
        Ok(false)
    }

    /// 读取任务所属项目 id（供状态变更后按项目推送工作区）。
    pub fn get_task_project(&self, task_id: &str) -> Result<Option<String>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        connection
            .query_row(
                "SELECT project_id FROM project_tasks WHERE id = ?1 AND deleted = 0",
                [task_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(StorageError::from)
    }

    /// 读取单个任务的当前状态（仅任务 id，供状态迁移校验）。
    pub fn get_task_status(&self, task_id: &str) -> Result<Option<String>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        connection
            .query_row(
                "SELECT status FROM project_tasks WHERE id = ?1 AND deleted = 0",
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
    /// 排序（2026-08）：
    /// 1. 用户「置顶」的任务（`queue_boosted_at` 非空）排最前，置顶任务之间
    ///    按置顶时间倒序（最新置顶的最前，再次置顶可把任务提到队列第一名）；
    /// 2. 未置顶任务按优先级 p0 > p1 > p2；
    /// 3. 同优先级按提交时间（`updated_at`，最近一次提交 / 退回时刻）先到先执行。
    ///
    /// 多设备约束（2026-08）：
    /// - 只返回「本机已绑定目录」（`directory_path IS NOT NULL`）的项目下的任务，
    ///   远端未绑定目录的项目不能在本机执行，避免调度器误领；
    /// - 任务一旦被某台设备执行（`execution_history` 非空）或正在执行（`claimed_by`
    ///   指向其他设备），就永久归属该设备：`claimed_by` 非空且非本机、或执行过且
    ///   未标记为本机领取的任务，本机一律不领取（只能查看）；
    /// - 基于其他设备任务的子任务（`base_task_id` 指向的父任务归属其他设备）同样不领取。
    pub fn list_queued_project_tasks(
        &self,
        current_device_id: &str,
    ) -> Result<Vec<ProjectTask>, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let mut statement = connection.prepare(
            "SELECT pt.id, pt.project_id, pt.title, pt.description, pt.status, pt.task_type, pt.agent_profile, pt.priority, pt.base_task_id, pt.last_job_id, pt.rejection_reason, pt.execution_history, pt.created_at, pt.updated_at, pt.claimed_by, pt.claimed_at, pt.queue_boosted_at, pt.deleted
             FROM project_tasks pt
             JOIN projects p ON p.id = pt.project_id
             WHERE pt.status = 'submitted'
               AND pt.deleted = 0
               AND p.directory_path IS NOT NULL
               AND p.workspace_archived = 0
             ORDER BY CASE WHEN pt.queue_boosted_at IS NOT NULL THEN 0 ELSE 1 END,
                      pt.queue_boosted_at DESC,
                      CASE pt.priority WHEN 'p0' THEN 0 WHEN 'p1' THEN 1 WHEN 'p2' THEN 2 ELSE 3 END,
                      pt.updated_at ASC",
        )?;
        let rows = statement.query_map([], |row| map_project_task_row(row))?;
        let mut tasks = rows.collect::<Result<Vec<_>, _>>()?;
        // 批量读取子任务的父任务，用于校验「基于其他设备任务的子任务」。
        let mut base_ids: Vec<String> = tasks
            .iter()
            .filter_map(|task| task.base_task_id.clone())
            .collect();
        base_ids.sort();
        base_ids.dedup();
        let mut parents: HashMap<String, ProjectTask> = HashMap::new();
        if !base_ids.is_empty() {
            let placeholders = base_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            let sql = format!(
                "SELECT id, project_id, title, description, status, task_type, agent_profile, priority, base_task_id, last_job_id, rejection_reason, execution_history, created_at, updated_at, claimed_by, claimed_at, queue_boosted_at, deleted
                 FROM project_tasks WHERE id IN ({placeholders})"
            );
            let mut parent_statement = connection.prepare(&sql)?;
            let parent_rows = parent_statement
                .query_map(rusqlite::params_from_iter(base_ids.iter()), |row| {
                    map_project_task_row(row)
                })?;
            for row in parent_rows {
                if let Ok(parent) = row {
                    parents.insert(parent.id.clone(), parent);
                }
            }
        }
        tasks.retain(|task| {
            // 任务自身归属：被其他设备执行过 / 正在执行 → 本机只读。
            if task_owned_by_other_device(task, current_device_id) {
                return false;
            }
            // 子任务归属：父任务属于其他设备（或本机查不到父任务）→ 本机只读。
            if let Some(base_id) = task.base_task_id.as_deref() {
                return match parents.get(base_id) {
                    Some(parent) => !task_owned_by_other_device(parent, current_device_id),
                    None => false,
                };
            }
            true
        });
        Ok(tasks)
    }

    /// 领取任务：把任务的执行归属标记为当前设备（永久归属）。
    ///
    /// 任务一旦被某台设备执行过或正在执行（`claimed_by` 指向其他设备），就永久归属
    /// 该设备，其他设备不可再领取——不再有租约过期重领的窗口。基于其他设备任务的
    /// 子任务同样不可领取。
    pub fn claim_task(&self, task_id: &str, current_device_id: &str) -> Result<bool, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let now = chrono::Utc::now().to_rfc3339();
        let task = connection
            .query_row(
                "SELECT id, project_id, title, description, status, task_type, agent_profile, priority, base_task_id, last_job_id, rejection_reason, execution_history, created_at, updated_at, claimed_by, claimed_at, queue_boosted_at, deleted
                 FROM project_tasks WHERE id = ?1",
                [task_id],
                |row| map_project_task_row(row),
            )
            .optional()?;
        let Some(task) = task else {
            return Ok(false);
        };
        // 任务自身归属：其他设备执行过 / 正在执行 → 本机不可领取。
        if task_owned_by_other_device(&task, current_device_id) {
            return Ok(false);
        }
        // 子任务归属：父任务属于其他设备（或本机查不到父任务）→ 本机不可领取。
        if let Some(base_id) = task.base_task_id.as_deref() {
            let parent = connection
                .query_row(
                    "SELECT id, project_id, title, description, status, task_type, agent_profile, priority, base_task_id, last_job_id, rejection_reason, execution_history, created_at, updated_at, claimed_by, claimed_at, queue_boosted_at, deleted
                     FROM project_tasks WHERE id = ?1",
                    [base_id],
                    |row| map_project_task_row(row),
                )
                .optional()?;
            match parent {
                Some(parent) if task_owned_by_other_device(&parent, current_device_id) => {
                    return Ok(false);
                }
                None => return Ok(false),
                _ => {}
            }
        }
        // 任务被领取执行：置顶只对「当前这一轮排队」有效，执行开始即清空，
        // 之后退回重跑 / 中断恢复按正常优先级 + 提交时间重新排队。
        Ok(connection.execute(
            "UPDATE project_tasks SET claimed_by = ?2, claimed_at = ?3, queue_boosted_at = NULL, updated_at = ?4 WHERE id = ?1",
            params![task_id, current_device_id, now, now],
        )? > 0)
    }

    /// 提高任务优先级：把已提交待执行任务置顶到队列最前。
    ///
    /// 置顶记录为当前时间（`queue_boosted_at`），队列排序时置顶任务排最前且
    /// 最新置顶的最前——再次置顶即可把任务提到队列第一名。只对 `submitted` 任务生效；
    /// 任务被领取执行时自动清空置顶。只更新置顶时间、不动 `updated_at`，避免重置
    /// 等待计时与干扰工作区 last-writer-wins。返回是否成功。
    pub fn boost_project_task(&self, task_id: &str) -> Result<bool, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let now = chrono::Utc::now().to_rfc3339();
        Ok(connection.execute(
            "UPDATE project_tasks SET queue_boosted_at = ?2 WHERE id = ?1 AND status = 'submitted' AND deleted = 0",
            params![task_id, now],
        )? > 0)
    }

    /// 应用重启后恢复被中断的执行中任务。
    ///
    /// Flowlet 在任务执行中（`status = 'in_progress'`）退出 / 重启时，按项目隔离的
    /// 执行槽（内存态 `AGENT_TASK_RUNNING`）随之丢失，任务状态会永久卡在 in_progress，
    /// 调度器（`list_queued_project_tasks` 只领取 submitted）不会再执行它。
    /// 应用启动时调用本方法把这些任务恢复为 submitted（待处理）：调度器下个周期
    /// 自动重新领取，`--resume` 复用上次会话继续推进。
    ///
    /// 只恢复「本机领取」或「未领取」的任务：其他设备领取的 in_progress 任务
    /// 永久归属对方，即使对方离线也不由本机接管，避免两台设备对同一任务重复执行。
    ///
    /// 恢复时在 `execution_history` 最近一次未结束记录上标记 `interrupted: true`
    /// 与中断时刻（finishedAt / executionMs），供前端看板与执行历史标注异常。
    /// 返回恢复的任务数量。
    pub fn recover_interrupted_project_tasks(
        &self,
        current_device_id: &str,
    ) -> Result<usize, StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        let mut statement = connection.prepare(
            "SELECT id, claimed_by, claimed_at, execution_history
             FROM project_tasks WHERE status = 'in_progress' AND deleted = 0",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })?;
        let mut targets: Vec<(String, Option<String>)> = Vec::new();
        for row in rows {
            let (task_id, claimed_by, _claimed_at, execution_history) = row?;
            let should_recover = match claimed_by.as_deref() {
                // 其他设备领取的任务永久归属对方：即使对方离线也不由本机恢复，
                // 避免两台设备对同一任务重复执行。
                Some(owner) if owner != current_device_id => false,
                _ => true,
            };
            if should_recover {
                targets.push((task_id, execution_history));
            }
        }
        let now = chrono::Utc::now();
        let now_str = now.to_rfc3339();
        let mut recovered = 0;
        for (task_id, execution_history) in targets {
            // 在最近一次未结束的执行记录上打中断标记：finishedAt 取当前时刻，
            // executionMs 为真实中断耗时，interrupted 供前端标注异常。
            if let Some(history) = execution_history.as_deref() {
                if let Ok(mut entries) = serde_json::from_str::<Vec<Value>>(history) {
                    for entry in entries.iter_mut().rev() {
                        if entry.get("finishedAt").and_then(Value::as_str).is_some() {
                            continue;
                        }
                        let execution_ms = entry
                            .get("startedAt")
                            .and_then(Value::as_str)
                            .and_then(parse_epoch_millis)
                            .map(|start| (now.timestamp_millis() - start).max(0))
                            .unwrap_or(0);
                        entry["finishedAt"] = json!(now_str);
                        entry["executionMs"] = json!(execution_ms);
                        entry["interrupted"] = json!(true);
                        if let Ok(serialized) = serde_json::to_string(&entries) {
                            let _ = connection.execute(
                                "UPDATE project_tasks SET execution_history = ?2 WHERE id = ?1",
                                params![task_id, serialized],
                            );
                        }
                        break;
                    }
                }
            }
            connection.execute(
                // 恢复重新排队时清空队列置顶：任务已开始执行过，置顶只对提交后的排队有效。
                "UPDATE project_tasks SET status = 'submitted', queue_boosted_at = NULL, updated_at = ?2 WHERE id = ?1",
                params![task_id, now_str],
            )?;
            recovered += 1;
        }
        Ok(recovered)
    }

    pub fn save_project_task(&self, task: &ProjectTask) -> Result<(), StorageError> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| StorageError::LockFailed)?;
        // last_job_id / rejection_reason / execution_history / claimed_by / claimed_at
        // 只在任务执行或退回时由专用方法写入，编辑保存不覆盖它们。
        connection.execute(
            "INSERT INTO project_tasks (id, project_id, title, description, status, task_type, agent_profile, priority, base_task_id, last_job_id, rejection_reason, execution_history, created_at, updated_at, claimed_by, claimed_at, deleted)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
             ON CONFLICT(id) DO UPDATE SET
               title = excluded.title,
               description = excluded.description,
               status = excluded.status,
               task_type = excluded.task_type,
               agent_profile = excluded.agent_profile,
               priority = excluded.priority,
               base_task_id = excluded.base_task_id,
               deleted = excluded.deleted,
               updated_at = excluded.updated_at
             WHERE project_tasks.project_id = excluded.project_id",
            params![
                task.id,
                task.project_id,
                task.title,
                task.description,
                task.status,
                task.task_type,
                task.agent_profile,
                task.priority,
                task.base_task_id,
                task.last_job_id,
                task.rejection_reason,
                task.execution_history,
                task.created_at,
                task.updated_at,
                task.claimed_by,
                task.claimed_at,
                task.deleted
            ],
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

    /// Agent 子进程成功创建后，原子记录最近一次 job 并追加一条执行历史。
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
            "UPDATE project_tasks SET execution_history = ?2, last_job_id = ?3 WHERE id = ?1",
            params![task_id, serialized, job_id],
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
        let mut entries: Vec<Value> = serde_json::from_str(&current).unwrap_or_default();
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
        let mut entries: Vec<Value> = serde_json::from_str(&current).unwrap_or_default();
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
        // 软删除：置 deleted = 1，跨设备同步时以墓碑形式传播删除。
        let now = chrono::Utc::now().to_rfc3339();
        Ok(connection.execute(
            "UPDATE project_tasks SET deleted = 1, updated_at = ?3 WHERE id = ?1 AND project_id = ?2",
            params![task_id, project_id, now],
        )? > 0)
    }
}

/// 目录路径归一化：用于项目目录唯一性比较。
///
/// 目录存在时用 `canonicalize`（统一真实路径与大小写，Windows 关键）；目录不存在
/// （如项目绑定后目录被删除）时回退字符串归一化——统一 `\`/`/` 分隔符、去掉尾部
/// 分隔符，Windows 下大小写不敏感，避免同目录换一种写法被误判为不同目录。
fn normalize_directory_path(path: &str) -> String {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if let Ok(canonical) = std::path::Path::new(trimmed).canonicalize() {
        return canonical.to_string_lossy().into_owned();
    }
    let unified = trimmed.replace('\\', "/");
    let stripped = unified.trim_end_matches('/');
    #[cfg(windows)]
    {
        stripped.to_lowercase()
    }
    #[cfg(not(windows))]
    {
        stripped.to_string()
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
        claimed_by: row.get(14)?,
        claimed_at: row.get(15)?,
        queue_boosted_at: row.get(16)?,
        deleted: row.get(17)?,
    })
}

fn map_project_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Project> {
    Ok(Project {
        id: row.get(0)?,
        name: row.get(1)?,
        directory_path: row.get(2)?,
        workspace_project_id: row.get(3)?,
        workspace_archived: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

/// 任务是否已执行过：`execution_history` 存在且含实际执行记录（`[]` / 空串视为未执行）。
fn task_has_execution(task: &ProjectTask) -> bool {
    match task.execution_history.as_deref() {
        Some(history) => {
            let trimmed = history.trim();
            !trimmed.is_empty() && trimmed != "[]"
        }
        None => false,
    }
}

/// 任务是否归属于其他设备（本机不可执行 / 不可操作）。
///
/// 跨设备归属规则（2026-08）：
/// - 任务被某设备领取（`claimed_by` 非空）即永久归属该设备，不再有租约过期重领；
/// - 任务执行过（`execution_history` 非空）但未标记为本机领取时，视为工作区同步来的
///   其他设备已执行任务，同样归属其他设备；
/// - `last_job_id` 是本机执行时写入的设备本地字段（工作区同步不携带、合并时保留本地值）：
///   只要非空就说明任务在本机执行过。即使 `claimed_by` 因设备身份变化 / 数据库迁移
///   与当前设备不一致，也不应把本机执行过的任务误判为其他设备。
fn task_owned_by_other_device(task: &ProjectTask, current_device_id: &str) -> bool {
    if task.claimed_by.as_deref() == Some(current_device_id) {
        return false;
    }
    if task.last_job_id.is_some() {
        return false;
    }
    task.claimed_by.is_some() || task_has_execution(task)
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
            directory_path: Some("D:\\work\\flowlet".into()),
            workspace_project_id: None,
            workspace_archived: false,
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
                claimed_by: None,
                claimed_at: None,
                queue_boosted_at: None,
                deleted: false,
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
            claimed_by: None,
            claimed_at: None,
            queue_boosted_at: None,
            deleted: false,
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
            directory_path: Some("D:\\work\\flowlet".into()),
            workspace_project_id: None,
            workspace_archived: false,
            created_at: "2026-08-03T00:00:00Z".into(),
            updated_at: "2026-08-03T00:00:00Z".into(),
        };
        storage.save_project(&project).unwrap();
        storage
            .save_project_task(&sample_task(
                "task-1",
                "submitted",
                "p1",
                "2026-08-03T00:00:00Z",
            ))
            .unwrap();

        assert!(storage.set_task_status("task-1", "in_progress").unwrap());
        let task = storage
            .get_project_task("project-1", "task-1")
            .unwrap()
            .unwrap();
        assert_eq!(task.status, "in_progress");
        assert!(task.updated_at.as_str() > "2026-08-03T00:00:00Z");

        // 不存在的任务返回 false，不报错。
        assert!(!storage.set_task_status("missing", "done").unwrap());
    }

    #[test]
    fn set_task_status_supports_withdraw_from_submitted_to_draft() {
        let storage = Storage::from_connection_for_test(Connection::open_in_memory().unwrap());
        storage.migrate().unwrap();
        let project = Project {
            id: "project-1".into(),
            name: "Flowlet".into(),
            directory_path: Some("D:\\work\\flowlet".into()),
            workspace_project_id: None,
            workspace_archived: false,
            created_at: "2026-08-03T00:00:00Z".into(),
            updated_at: "2026-08-03T00:00:00Z".into(),
        };
        storage.save_project(&project).unwrap();
        storage
            .save_project_task(&sample_task(
                "task-1",
                "submitted",
                "p1",
                "2026-08-03T00:00:00Z",
            ))
            .unwrap();

        // 撤回：已提交 → 草稿。撤回到草稿后任务不再出现在待执行队列（只查 submitted）。
        assert!(storage.set_task_status("task-1", "draft").unwrap());
        let task = storage
            .get_project_task("project-1", "task-1")
            .unwrap()
            .unwrap();
        assert_eq!(task.status, "draft");
        assert!(task.updated_at.as_str() > "2026-08-03T00:00:00Z");
        assert!(storage
            .list_queued_project_tasks("device-1")
            .unwrap()
            .iter()
            .all(|queued| queued.id != "task-1"));
    }

    #[test]
    fn project_task_persists_base_task_id() {
        let storage = Storage::from_connection_for_test(Connection::open_in_memory().unwrap());
        storage.migrate().unwrap();
        let project = Project {
            id: "project-1".into(),
            name: "Flowlet".into(),
            directory_path: Some("D:\\work\\flowlet".into()),
            workspace_project_id: None,
            workspace_archived: false,
            created_at: "2026-08-03T00:00:00Z".into(),
            updated_at: "2026-08-03T00:00:00Z".into(),
        };
        storage.save_project(&project).unwrap();
        let mut task = sample_task("task-1", "draft", "p1", "2026-08-03T00:00:00Z");
        task.base_task_id = Some("base-1".to_string());
        storage.save_project_task(&task).unwrap();

        // 基于已完成任务创建时记录的 base_task_id 持久化并可回读。
        let loaded = storage
            .get_project_task("project-1", "task-1")
            .unwrap()
            .unwrap();
        assert_eq!(loaded.base_task_id.as_deref(), Some("base-1"));
        // 编辑保存不丢 base_task_id（按值回写）。
        let mut edited = loaded.clone();
        edited.title = "改标题".to_string();
        storage.save_project_task(&edited).unwrap();
        let reloaded = storage
            .get_project_task("project-1", "task-1")
            .unwrap()
            .unwrap();
        assert_eq!(reloaded.title, "改标题");
        assert_eq!(reloaded.base_task_id.as_deref(), Some("base-1"));
    }

    #[test]
    fn list_queued_project_tasks_orders_by_priority_then_updated_at() {
        let storage = Storage::from_connection_for_test(Connection::open_in_memory().unwrap());
        storage.migrate().unwrap();
        let project = Project {
            id: "project-1".into(),
            name: "Flowlet".into(),
            directory_path: Some("D:\\work\\flowlet".into()),
            workspace_project_id: None,
            workspace_archived: false,
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

        let queued = storage.list_queued_project_tasks("device-a").unwrap();
        let ids: Vec<&str> = queued.iter().map(|task| task.id.as_str()).collect();
        // 只含 submitted；p0 优先、再 p1、再 p2；草稿不参与调度。
        assert_eq!(ids, vec!["p0-early", "p1-mid", "p2-late"]);
    }

    #[test]
    fn list_queued_project_tasks_orders_by_submit_time_not_created_time() {
        let storage = Storage::from_connection_for_test(Connection::open_in_memory().unwrap());
        storage.migrate().unwrap();
        let project = Project {
            id: "project-1".into(),
            name: "Flowlet".into(),
            directory_path: Some("D:\\work\\flowlet".into()),
            workspace_project_id: None,
            workspace_archived: false,
            created_at: "2026-08-03T00:00:00Z".into(),
            updated_at: "2026-08-03T00:00:00Z".into(),
        };
        storage.save_project(&project).unwrap();
        // created_at 早（先创建）但提交晚（updated_at 晚）的任务，应排在提交早的后面。
        let mut created_early =
            sample_task("created-early", "submitted", "p1", "2026-08-03T00:00:00Z");
        created_early.updated_at = "2026-08-03T05:00:00Z".to_string();
        let mut submitted_early =
            sample_task("submitted-early", "submitted", "p1", "2026-08-03T04:00:00Z");
        submitted_early.updated_at = "2026-08-03T01:00:00Z".to_string();
        storage.save_project_task(&created_early).unwrap();
        storage.save_project_task(&submitted_early).unwrap();

        let queued = storage.list_queued_project_tasks("device-a").unwrap();
        let ids: Vec<&str> = queued.iter().map(|task| task.id.as_str()).collect();
        // 同优先级按提交时间（updated_at）先到先执行，与创建时间无关。
        assert_eq!(ids, vec!["submitted-early", "created-early"]);
    }

    #[test]
    fn list_queued_project_tasks_puts_boosted_first_and_latest_boost_first() {
        let storage = Storage::from_connection_for_test(Connection::open_in_memory().unwrap());
        storage.migrate().unwrap();
        let project = Project {
            id: "project-1".into(),
            name: "Flowlet".into(),
            directory_path: Some("D:\\work\\flowlet".into()),
            workspace_project_id: None,
            workspace_archived: false,
            created_at: "2026-08-03T00:00:00Z".into(),
            updated_at: "2026-08-03T00:00:00Z".into(),
        };
        storage.save_project(&project).unwrap();
        // 未置顶任务：p0 优先级最高。
        let mut p0 = sample_task("p0", "submitted", "p0", "2026-08-03T00:00:00Z");
        p0.project_id = "project-1".into();
        // p2 任务先置顶。
        let mut boosted_p2 = sample_task("boosted-p2", "submitted", "p2", "2026-08-03T01:00:00Z");
        boosted_p2.project_id = "project-1".into();
        storage.save_project_task(&boosted_p2).unwrap();
        assert!(storage.boost_project_task("boosted-p2").unwrap());
        // p1 任务后置顶 → 最新置顶在最前（提到队列第一名）。
        let mut boosted_p1 = sample_task("boosted-p1", "submitted", "p1", "2026-08-03T02:00:00Z");
        boosted_p1.project_id = "project-1".into();
        storage.save_project_task(&boosted_p1).unwrap();
        assert!(storage.boost_project_task("boosted-p1").unwrap());
        storage.save_project_task(&p0).unwrap();

        let queued = storage.list_queued_project_tasks("device-a").unwrap();
        let ids: Vec<&str> = queued.iter().map(|task| task.id.as_str()).collect();
        // 置顶任务排最前（最新置顶最前），未置顶任务按优先级。
        assert_eq!(ids, vec!["boosted-p1", "boosted-p2", "p0"]);
    }

    #[test]
    fn boost_project_task_only_applies_to_submitted_and_clears_on_claim() {
        let storage = Storage::from_connection_for_test(Connection::open_in_memory().unwrap());
        storage.migrate().unwrap();
        let project = Project {
            id: "project-1".into(),
            name: "Flowlet".into(),
            directory_path: Some("D:\\work\\flowlet".into()),
            workspace_project_id: None,
            workspace_archived: false,
            created_at: "2026-08-03T00:00:00Z".into(),
            updated_at: "2026-08-03T00:00:00Z".into(),
        };
        storage.save_project(&project).unwrap();
        let mut draft = sample_task("draft", "draft", "p1", "2026-08-03T00:00:00Z");
        draft.project_id = "project-1".into();
        storage.save_project_task(&draft).unwrap();
        // 草稿不能置顶。
        assert!(!storage.boost_project_task("draft").unwrap());

        let mut submitted = sample_task("submitted", "submitted", "p1", "2026-08-03T00:00:00Z");
        submitted.project_id = "project-1".into();
        storage.save_project_task(&submitted).unwrap();
        assert!(storage.boost_project_task("submitted").unwrap());
        let boosted = storage
            .get_project_task("project-1", "submitted")
            .unwrap()
            .unwrap();
        assert!(boosted.queue_boosted_at.is_some());
        // 领取执行后置顶清空：执行开始后置顶只对「当前这一轮排队」有效。
        assert!(storage.claim_task("submitted", "device-a").unwrap());
        let claimed = storage
            .get_project_task("project-1", "submitted")
            .unwrap()
            .unwrap();
        assert!(claimed.queue_boosted_at.is_none());
        assert_eq!(claimed.claimed_by.as_deref(), Some("device-a"));
    }

    #[test]
    fn queued_tasks_exclude_unbound_and_foreign_claimed_projects() {
        let storage = Storage::from_connection_for_test(Connection::open_in_memory().unwrap());
        storage.migrate().unwrap();
        // 本机绑定目录的项目。
        storage
            .save_project(&Project {
                id: "project-1".into(),
                name: "Flowlet".into(),
                directory_path: Some("D:\\work\\flowlet".into()),
                workspace_project_id: Some("ws-1".into()),
                workspace_archived: false,
                created_at: "2026-08-03T00:00:00Z".into(),
                updated_at: "2026-08-03T00:00:00Z".into(),
            })
            .unwrap();
        // 远端同步、未绑定目录的项目：任务不可在本机执行。
        storage
            .save_project(&Project {
                id: "project-2".into(),
                name: "Remote".into(),
                directory_path: None,
                workspace_project_id: Some("ws-2".into()),
                workspace_archived: false,
                created_at: "2026-08-03T00:00:00Z".into(),
                updated_at: "2026-08-03T00:00:00Z".into(),
            })
            .unwrap();
        let mut bound = sample_task("bound", "submitted", "p1", "2026-08-03T00:00:00Z");
        bound.project_id = "project-1".into();
        let mut unbound = sample_task("unbound", "submitted", "p1", "2026-08-03T00:00:00Z");
        unbound.project_id = "project-2".into();
        // 被其他设备领取（永久归属）→ 本机不领取。
        let mut foreign_claimed = sample_task("claimed", "submitted", "p1", "2026-08-03T00:00:00Z");
        foreign_claimed.project_id = "project-1".into();
        foreign_claimed.claimed_by = Some("device-b".into());
        foreign_claimed.claimed_at = Some(chrono::Utc::now().to_rfc3339());
        for task in [bound, unbound, foreign_claimed] {
            storage.save_project_task(&task).unwrap();
        }

        let queued = storage.list_queued_project_tasks("device-a").unwrap();
        let ids: Vec<&str> = queued.iter().map(|task| task.id.as_str()).collect();
        // 未绑定目录项目与被其他设备归属的任务都不出现在本机队列。
        assert_eq!(ids, vec!["bound"]);
    }

    #[test]
    fn queued_tasks_exclude_executed_foreign_tasks() {
        let storage = Storage::from_connection_for_test(Connection::open_in_memory().unwrap());
        storage.migrate().unwrap();
        storage
            .save_project(&Project {
                id: "project-1".into(),
                name: "Flowlet".into(),
                directory_path: Some("D:\\work\\flowlet".into()),
                workspace_project_id: Some("ws-1".into()),
                workspace_archived: false,
                created_at: "2026-08-03T00:00:00Z".into(),
                updated_at: "2026-08-03T00:00:00Z".into(),
            })
            .unwrap();
        // 本机创建的从未执行任务：可被调度器领取。
        let mut fresh = sample_task("fresh", "submitted", "p1", "2026-08-03T00:00:00Z");
        fresh.project_id = "project-1".into();
        // 已执行但未标注领取：工作区同步来的其他设备已执行任务，本机只读。
        let mut executed = sample_task("executed", "submitted", "p1", "2026-08-03T01:00:00Z");
        executed.project_id = "project-1".into();
        executed.execution_history = Some(
            r#"[{"jobId":"job-1","startedAt":"2026-08-03T02:00:00Z","finishedAt":null}]"#.into(),
        );
        // 本机执行过（claimed_by = 本机）：可重新排队执行（退回重跑）。
        let mut own_executed =
            sample_task("own-executed", "submitted", "p1", "2026-08-03T02:00:00Z");
        own_executed.project_id = "project-1".into();
        own_executed.execution_history = Some(
            r#"[{"jobId":"job-2","startedAt":"2026-08-03T03:00:00Z","finishedAt":null}]"#.into(),
        );
        own_executed.claimed_by = Some("device-a".into());
        for task in [fresh, executed, own_executed] {
            storage.save_project_task(&task).unwrap();
        }

        let queued = storage.list_queued_project_tasks("device-a").unwrap();
        let ids: Vec<&str> = queued.iter().map(|task| task.id.as_str()).collect();
        // 从未执行 + 本机执行过 → 领取；其他设备执行过（执行历史非空且非本机领取）→ 排除。
        assert_eq!(ids, vec!["fresh", "own-executed"]);
    }

    #[test]
    fn queued_tasks_keep_own_executed_with_lost_claim() {
        let storage = Storage::from_connection_for_test(Connection::open_in_memory().unwrap());
        storage.migrate().unwrap();
        storage
            .save_project(&Project {
                id: "project-1".into(),
                name: "Flowlet".into(),
                directory_path: Some("D:\\work\\flowlet".into()),
                workspace_project_id: Some("ws-1".into()),
                workspace_archived: false,
                created_at: "2026-08-03T00:00:00Z".into(),
                updated_at: "2026-08-03T00:00:00Z".into(),
            })
            .unwrap();
        // 本机创建并执行过，但执行归属标记丢失（claimed_by 为空，设备身份变化 / 数据库迁移）：
        // 只要 last_job_id 非空（本机执行时写入的本地字段），就不应被误判为其他设备任务。
        let mut own_executed =
            sample_task("own-executed", "submitted", "p1", "2026-08-03T00:00:00Z");
        own_executed.project_id = "project-1".into();
        own_executed.last_job_id = Some("job-local".into());
        own_executed.execution_history = Some(
            r#"[{"jobId":"job-local","startedAt":"2026-08-03T02:00:00Z","finishedAt":null}]"#
                .into(),
        );
        storage.save_project_task(&own_executed).unwrap();

        let queued = storage.list_queued_project_tasks("device-a").unwrap();
        assert_eq!(queued.len(), 1);
        assert_eq!(queued[0].id, "own-executed");
    }

    #[test]
    fn queued_tasks_exclude_child_of_foreign_parent() {
        let storage = Storage::from_connection_for_test(Connection::open_in_memory().unwrap());
        storage.migrate().unwrap();
        storage
            .save_project(&Project {
                id: "project-1".into(),
                name: "Flowlet".into(),
                directory_path: Some("D:\\work\\flowlet".into()),
                workspace_project_id: Some("ws-1".into()),
                workspace_archived: false,
                created_at: "2026-08-03T00:00:00Z".into(),
                updated_at: "2026-08-03T00:00:00Z".into(),
            })
            .unwrap();
        // 父任务被其他设备执行过（执行历史非空，工作区同步到本机后 claimed_by 为空）。
        let mut parent = sample_task("parent", "done", "p1", "2026-08-03T00:00:00Z");
        parent.project_id = "project-1".into();
        parent.execution_history = Some(
            r#"[{"jobId":"job-1","startedAt":"2026-08-03T02:00:00Z","finishedAt":null}]"#.into(),
        );
        storage.save_project_task(&parent).unwrap();
        // 基于该父任务的子任务：归属父任务所在设备，本机不可执行。
        let mut child = sample_task("child", "submitted", "p1", "2026-08-03T03:00:00Z");
        child.project_id = "project-1".into();
        child.base_task_id = Some("parent".into());
        storage.save_project_task(&child).unwrap();
        // 父任务属于本机的子任务：可执行。
        let mut own_parent = sample_task("own-parent", "done", "p1", "2026-08-03T00:00:00Z");
        own_parent.project_id = "project-1".into();
        own_parent.execution_history = Some(
            r#"[{"jobId":"job-2","startedAt":"2026-08-03T02:00:00Z","finishedAt":null}]"#.into(),
        );
        own_parent.claimed_by = Some("device-a".into());
        storage.save_project_task(&own_parent).unwrap();
        let mut own_child = sample_task("own-child", "submitted", "p1", "2026-08-03T04:00:00Z");
        own_child.project_id = "project-1".into();
        own_child.base_task_id = Some("own-parent".into());
        storage.save_project_task(&own_child).unwrap();

        let queued = storage.list_queued_project_tasks("device-a").unwrap();
        let ids: Vec<&str> = queued.iter().map(|task| task.id.as_str()).collect();
        assert_eq!(ids, vec!["own-child"]);
    }

    #[test]
    fn append_task_execution_persists_on_null_history() {
        let storage = Storage::from_connection_for_test(Connection::open_in_memory().unwrap());
        storage.migrate().unwrap();
        let project = Project {
            id: "project-1".into(),
            name: "Flowlet".into(),
            directory_path: Some("D:\\work\\flowlet".into()),
            workspace_project_id: None,
            workspace_archived: false,
            created_at: "2026-08-03T00:00:00Z".into(),
            updated_at: "2026-08-03T00:00:00Z".into(),
        };
        storage.save_project(&project).unwrap();
        storage
            .save_project_task(&sample_task(
                "task-1",
                "submitted",
                "p1",
                "2026-08-03T00:00:00Z",
            ))
            .unwrap();

        // 修复回归：execution_history 为 NULL 时不能再因 InvalidColumnType 报错。
        assert!(storage
            .append_task_execution("task-1", "job-1", "2026-08-03T00:00:00Z")
            .unwrap());
        assert!(storage
            .append_task_execution("task-1", "job-2", "2026-08-03T00:00:00Z")
            .unwrap());

        let task = storage
            .get_project_task("project-1", "task-1")
            .unwrap()
            .unwrap();
        let history: Vec<Value> =
            serde_json::from_str(task.execution_history.as_deref().unwrap()).unwrap();
        assert_eq!(history.len(), 2);
        assert_eq!(history[0]["jobId"].as_str(), Some("job-1"));
        assert_eq!(history[1]["jobId"].as_str(), Some("job-2"));
        assert_eq!(history[0]["rejected"].as_bool(), Some(false));
        // 新一轮执行记录进入待处理时刻与等待耗时；执行结束前 executionMs 为空。
        assert_eq!(
            history[0]["submittedAt"].as_str(),
            Some("2026-08-03T00:00:00Z")
        );
        assert!(history[0]["waitingMs"].as_u64().is_some());
        assert_eq!(history[0]["executionMs"], Value::Null);
        // 最近执行指针与历史追加同一条 SQL 原子更新，不能指向未入历史的 job。
        assert_eq!(task.last_job_id.as_deref(), Some("job-2"));
    }

    #[test]
    fn mark_task_execution_rejected_marks_the_latest_job() {
        let storage = Storage::from_connection_for_test(Connection::open_in_memory().unwrap());
        storage.migrate().unwrap();
        let project = Project {
            id: "project-1".into(),
            name: "Flowlet".into(),
            directory_path: Some("D:\\work\\flowlet".into()),
            workspace_project_id: None,
            workspace_archived: false,
            created_at: "2026-08-03T00:00:00Z".into(),
            updated_at: "2026-08-03T00:00:00Z".into(),
        };
        storage.save_project(&project).unwrap();
        storage
            .save_project_task(&sample_task(
                "task-1",
                "submitted",
                "p1",
                "2026-08-03T00:00:00Z",
            ))
            .unwrap();
        storage
            .append_task_execution("task-1", "job-1", "2026-08-03T00:00:00Z")
            .unwrap();

        assert!(storage
            .mark_task_execution_rejected("task-1", "job-1", "不符合预期")
            .unwrap());
        let task = storage
            .get_project_task("project-1", "task-1")
            .unwrap()
            .unwrap();
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
            directory_path: Some("D:\\work\\flowlet".into()),
            workspace_project_id: None,
            workspace_archived: false,
            created_at: "2026-08-03T00:00:00Z".into(),
            updated_at: "2026-08-03T00:00:00Z".into(),
        };
        storage.save_project(&project).unwrap();
        storage
            .save_project_task(&sample_task(
                "task-1",
                "review",
                "p1",
                "2026-08-03T00:00:00Z",
            ))
            .unwrap();
        storage
            .append_task_execution("task-1", "job-1", "2026-08-03T00:00:00Z")
            .unwrap();

        // 第一次写入结束时间：执行耗时为真实结束时刻 - 本轮开始时刻。
        assert!(storage.finish_task_execution("task-1", "job-1").unwrap());
        let task = storage
            .get_project_task("project-1", "task-1")
            .unwrap()
            .unwrap();
        let history: Vec<Value> =
            serde_json::from_str(task.execution_history.as_deref().unwrap()).unwrap();
        let finished = history[0]["finishedAt"].as_str().unwrap().to_string();
        assert!(history[0]["executionMs"].as_u64().is_some());

        // 幂等：再次调用不覆盖真实结束时刻。
        assert!(storage.finish_task_execution("task-1", "job-1").unwrap());
        let task = storage
            .get_project_task("project-1", "task-1")
            .unwrap()
            .unwrap();
        let history: Vec<Value> =
            serde_json::from_str(task.execution_history.as_deref().unwrap()).unwrap();
        assert_eq!(history[0]["finishedAt"].as_str().unwrap(), finished);

        // 未知 job / 未知任务返回 false，不报错。
        assert!(!storage
            .finish_task_execution("task-1", "missing-job")
            .unwrap());
        assert!(!storage
            .finish_task_execution("missing-task", "job-1")
            .unwrap());
    }

    #[test]
    fn convert_task_to_code_only_accepts_review_readonly_task() {
        let storage = Storage::from_connection_for_test(Connection::open_in_memory().unwrap());
        storage.migrate().unwrap();
        let project = Project {
            id: "project-1".into(),
            name: "Flowlet".into(),
            directory_path: Some("D:\\work\\flowlet".into()),
            workspace_project_id: None,
            workspace_archived: false,
            created_at: "2026-08-03T00:00:00Z".into(),
            updated_at: "2026-08-03T00:00:00Z".into(),
        };
        storage.save_project(&project).unwrap();
        let mut task = sample_task("task-1", "review", "p1", "2026-08-03T00:00:00Z");
        task.task_type = "readonly".into();
        storage.save_project_task(&task).unwrap();

        // 待审核的只读任务可以转换：类型变 code、描述替换、状态回到 submitted 重新排队。
        assert!(storage
            .convert_task_to_code("task-1", "修复缓存过期问题")
            .unwrap());
        let converted = storage
            .get_project_task("project-1", "task-1")
            .unwrap()
            .unwrap();
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
            directory_path: Some("D:\\work\\flowlet".into()),
            workspace_project_id: None,
            workspace_archived: false,
            created_at: "2026-08-03T00:00:00Z".into(),
            updated_at: "2026-08-03T00:00:00Z".into(),
        };
        storage.save_project(&project).unwrap();
        // 待审核但类型是 code（已是代码修改任务），不允许转换。
        storage
            .save_project_task(&sample_task(
                "code-task",
                "review",
                "p1",
                "2026-08-03T00:00:00Z",
            ))
            .unwrap();
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
            directory_path: Some("D:\\work\\flowlet".into()),
            workspace_project_id: None,
            workspace_archived: false,
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
        let task = storage
            .get_project_task("project-1", "task-1")
            .unwrap()
            .unwrap();
        let history: Vec<Value> =
            serde_json::from_str(task.execution_history.as_deref().unwrap()).unwrap();
        assert_eq!(history.len(), 2);
        assert_eq!(history[0]["jobId"].as_str(), Some("job-1"));
        assert_eq!(history[1]["jobId"].as_str(), Some("job-2"));
    }

    #[test]
    fn migrate_prunes_pre_spawn_failures_without_deleting_job_logs() {
        let storage = Storage::from_connection_for_test(Connection::open_in_memory().unwrap());
        storage.migrate().unwrap();
        let project = Project {
            id: "project-1".into(),
            name: "Flowlet".into(),
            directory_path: Some("D:\\work\\flowlet".into()),
            workspace_project_id: None,
            workspace_archived: false,
            created_at: "2026-08-03T00:00:00Z".into(),
            updated_at: "2026-08-03T00:00:00Z".into(),
        };
        storage.save_project(&project).unwrap();
        storage
            .save_project_task(&sample_task(
                "task-1",
                "review",
                "p1",
                "2026-08-03T00:00:00Z",
            ))
            .unwrap();

        for job_id in ["failed-start-1", "failed-start-2", "started-1"] {
            storage
                .create_job(
                    job_id,
                    "project-task-run",
                    "任务执行：Task task-1",
                    "正在启动",
                    "manual",
                    1,
                    "开始执行",
                )
                .unwrap();
            storage
                .append_task_execution("task-1", job_id, "2026-08-03T00:00:00Z")
                .unwrap();
        }
        storage
            .fail_job(
                "failed-start-1",
                "无法启动 Claude Code (C:\\Users\\test\\claude.exe)：目录名称无效。(os error 267)",
            )
            .unwrap();
        storage
            .fail_job(
                "failed-start-2",
                "项目绑定的本机目录不存在或不是文件夹：D:\\old\\flowlet；请编辑项目并重新绑定目录",
            )
            .unwrap();
        storage
            .finish_job("started-1", "succeeded", "{}", "任务执行完成")
            .unwrap();

        storage.migrate().unwrap();

        let task = storage
            .get_project_task("project-1", "task-1")
            .unwrap()
            .unwrap();
        let history: Vec<Value> =
            serde_json::from_str(task.execution_history.as_deref().unwrap()).unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0]["jobId"].as_str(), Some("started-1"));
        assert_eq!(task.last_job_id.as_deref(), Some("started-1"));
        // 启动失败仍可在任务日志中查看诊断，不删除 background job。
        assert!(storage
            .get_background_job_detail("failed-start-1")
            .unwrap()
            .is_some());
    }

    #[test]
    fn migrate_does_not_backfill_a_pre_spawn_failure_as_the_first_round() {
        let storage = Storage::from_connection_for_test(Connection::open_in_memory().unwrap());
        storage.migrate().unwrap();
        let project = Project {
            id: "project-1".into(),
            name: "Flowlet".into(),
            directory_path: Some("D:\\work\\flowlet".into()),
            workspace_project_id: None,
            workspace_archived: false,
            created_at: "2026-08-03T00:00:00Z".into(),
            updated_at: "2026-08-03T00:00:00Z".into(),
        };
        storage.save_project(&project).unwrap();
        let mut task = sample_task("task-1", "submitted", "p1", "2026-08-03T00:00:00Z");
        task.last_job_id = Some("failed-start".into());
        task.execution_history = None;
        storage.save_project_task(&task).unwrap();
        storage
            .create_job(
                "failed-start",
                "project-task-run",
                "任务执行：Task task-1",
                "正在启动",
                "manual",
                1,
                "开始执行",
            )
            .unwrap();
        storage
            .fail_job(
                "failed-start",
                "无法启动 Claude Code；可执行文件：claude.exe；工作目录：D:\\old；目录名称无效。",
            )
            .unwrap();

        storage.migrate().unwrap();

        let task = storage
            .get_project_task("project-1", "task-1")
            .unwrap()
            .unwrap();
        assert!(task.execution_history.is_none());
        assert!(task.last_job_id.is_none());
        assert!(storage
            .get_background_job_detail("failed-start")
            .unwrap()
            .is_some());
    }

    #[test]
    fn migrate_backfills_execution_duration_from_finished_jobs() {
        let storage = Storage::from_connection_for_test(Connection::open_in_memory().unwrap());
        storage.migrate().unwrap();
        let project = Project {
            id: "project-1".into(),
            name: "Flowlet".into(),
            directory_path: Some("D:\\work\\flowlet".into()),
            workspace_project_id: None,
            workspace_archived: false,
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
            .finish_job("job-1", "succeeded", "{}", "任务执行完成")
            .unwrap();

        // 重新 migrate 触发幂等 backfill：从 background_jobs 补 finishedAt 与 executionMs。
        storage.migrate().unwrap();
        let task = storage
            .get_project_task("project-1", "task-1")
            .unwrap()
            .unwrap();
        let history: Vec<Value> =
            serde_json::from_str(task.execution_history.as_deref().unwrap()).unwrap();
        assert!(history[0]["finishedAt"].as_str().is_some());
        assert!(history[0]["executionMs"].as_u64().unwrap() > 0);
    }

    /// 造一个带执行历史（最近一轮未结束）的 in_progress 任务。
    fn in_progress_task_with_open_run(
        storage: &Storage,
        task_id: &str,
        claimed_by: Option<&str>,
        claimed_at: Option<&str>,
    ) {
        let mut task = sample_task(task_id, "in_progress", "p1", "2026-08-03T00:00:00Z");
        task.execution_history = Some(
            serde_json::json!([{
                "jobId": "job-1",
                "startedAt": "2026-08-03T00:10:00Z",
                "submittedAt": "2026-08-03T00:00:00Z",
                "finishedAt": null,
                "waitingMs": 0,
                "executionMs": null,
                "rejected": false,
                "rejectionReason": null,
                "rejectedAt": null,
            }])
            .to_string(),
        );
        task.claimed_by = claimed_by.map(str::to_string);
        task.claimed_at = claimed_at.map(str::to_string);
        storage.save_project_task(&task).unwrap();
    }

    #[test]
    fn recover_interrupted_tasks_returns_own_claimed_to_submitted() {
        let storage = Storage::from_connection_for_test(Connection::open_in_memory().unwrap());
        storage.migrate().unwrap();
        let project = Project {
            id: "project-1".into(),
            name: "Flowlet".into(),
            directory_path: Some("D:\\work\\flowlet".into()),
            workspace_project_id: None,
            workspace_archived: false,
            created_at: "2026-08-03T00:00:00Z".into(),
            updated_at: "2026-08-03T00:00:00Z".into(),
        };
        storage.save_project(&project).unwrap();
        in_progress_task_with_open_run(
            &storage,
            "task-1",
            Some("device-a"),
            Some("2026-08-03T00:10:00Z"),
        );

        // 本机领取的执行中任务：恢复为 submitted，并在执行历史打中断标记。
        assert_eq!(
            storage
                .recover_interrupted_project_tasks("device-a")
                .unwrap(),
            1
        );
        let task = storage
            .get_project_task("project-1", "task-1")
            .unwrap()
            .unwrap();
        assert_eq!(task.status, "submitted");
        let history: Vec<Value> =
            serde_json::from_str(task.execution_history.as_deref().unwrap()).unwrap();
        assert_eq!(history[0]["interrupted"].as_bool(), Some(true));
        assert!(history[0]["finishedAt"].as_str().is_some());
        assert!(history[0]["executionMs"].as_u64().is_some());
    }

    #[test]
    fn recover_interrupted_tasks_skips_foreign_claimed_within_lease() {
        let storage = Storage::from_connection_for_test(Connection::open_in_memory().unwrap());
        storage.migrate().unwrap();
        let project = Project {
            id: "project-1".into(),
            name: "Flowlet".into(),
            directory_path: Some("D:\\work\\flowlet".into()),
            workspace_project_id: None,
            workspace_archived: false,
            created_at: "2026-08-03T00:00:00Z".into(),
            updated_at: "2026-08-03T00:00:00Z".into(),
        };
        storage.save_project(&project).unwrap();
        // 其他设备领取的执行中任务：永久归属对方，本机不恢复。
        in_progress_task_with_open_run(
            &storage,
            "task-1",
            Some("device-b"),
            Some(&chrono::Utc::now().to_rfc3339()),
        );

        assert_eq!(
            storage
                .recover_interrupted_project_tasks("device-a")
                .unwrap(),
            0
        );
        let task = storage
            .get_project_task("project-1", "task-1")
            .unwrap()
            .unwrap();
        assert_eq!(task.status, "in_progress");
    }

    #[test]
    fn recover_interrupted_tasks_keeps_foreign_claimed_untouched() {
        let storage = Storage::from_connection_for_test(Connection::open_in_memory().unwrap());
        storage.migrate().unwrap();
        let project = Project {
            id: "project-1".into(),
            name: "Flowlet".into(),
            directory_path: Some("D:\\work\\flowlet".into()),
            workspace_project_id: None,
            workspace_archived: false,
            created_at: "2026-08-03T00:00:00Z".into(),
            updated_at: "2026-08-03T00:00:00Z".into(),
        };
        storage.save_project(&project).unwrap();
        // 其他设备领取的执行中任务：即使对方离线，也不由本机恢复（永久归属）。
        let expired = chrono::Utc::now() - chrono::Duration::minutes(11);
        in_progress_task_with_open_run(
            &storage,
            "task-1",
            Some("device-b"),
            Some(&expired.to_rfc3339()),
        );

        assert_eq!(
            storage
                .recover_interrupted_project_tasks("device-a")
                .unwrap(),
            0
        );
        let task = storage
            .get_project_task("project-1", "task-1")
            .unwrap()
            .unwrap();
        assert_eq!(task.status, "in_progress");
    }

    #[test]
    fn recover_interrupted_tasks_leaves_non_running_tasks_untouched() {
        let storage = Storage::from_connection_for_test(Connection::open_in_memory().unwrap());
        storage.migrate().unwrap();
        let project = Project {
            id: "project-1".into(),
            name: "Flowlet".into(),
            directory_path: Some("D:\\work\\flowlet".into()),
            workspace_project_id: None,
            workspace_archived: false,
            created_at: "2026-08-03T00:00:00Z".into(),
            updated_at: "2026-08-03T00:00:00Z".into(),
        };
        storage.save_project(&project).unwrap();
        storage
            .save_project_task(&sample_task("draft", "draft", "p1", "2026-08-03T00:00:00Z"))
            .unwrap();
        storage
            .save_project_task(&sample_task(
                "submitted",
                "submitted",
                "p1",
                "2026-08-03T00:00:00Z",
            ))
            .unwrap();

        // 草稿与已提交任务不参与恢复。
        assert_eq!(
            storage
                .recover_interrupted_project_tasks("device-a")
                .unwrap(),
            0
        );
        assert_eq!(
            storage.get_task_status("draft").unwrap().as_deref(),
            Some("draft")
        );
        assert_eq!(
            storage.get_task_status("submitted").unwrap().as_deref(),
            Some("submitted")
        );
    }

    #[test]
    fn get_project_by_directory_finds_same_directory() {
        let storage = Storage::from_connection_for_test(Connection::open_in_memory().unwrap());
        storage.migrate().unwrap();
        let dir = std::env::temp_dir().join(format!("flowlet-dir-unique-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        storage
            .save_project(&Project {
                id: "project-1".into(),
                name: "Flowlet".into(),
                directory_path: Some(dir.to_string_lossy().into_owned()),
                workspace_project_id: None,
                workspace_archived: false,
                created_at: "2026-08-03T00:00:00Z".into(),
                updated_at: "2026-08-03T00:00:00Z".into(),
            })
            .unwrap();

        // 相同目录（真实存在的目录，canonicalize 归一化）命中同一项目。
        let found = storage
            .get_project_by_directory(&dir.to_string_lossy())
            .unwrap();
        assert_eq!(found.as_ref().map(|p| p.id.as_str()), Some("project-1"));
        // 不存在的目录不命中。
        assert!(storage
            .get_project_by_directory("D:\\definitely\\not\\here")
            .unwrap()
            .is_none());
        // 未绑定目录的项目不参与比较：即使查询同路径也返回 None（项目无目录）。
        storage
            .save_project(&Project {
                id: "project-2".into(),
                name: "Remote".into(),
                directory_path: None,
                workspace_project_id: Some("ws-2".into()),
                workspace_archived: false,
                created_at: "2026-08-03T00:00:00Z".into(),
                updated_at: "2026-08-03T00:00:00Z".into(),
            })
            .unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn get_project_by_directory_excludes_archived_projects() {
        let storage = Storage::from_connection_for_test(Connection::open_in_memory().unwrap());
        storage.migrate().unwrap();
        storage
            .save_project(&Project {
                id: "project-1".into(),
                name: "Flowlet".into(),
                directory_path: Some("D:\\work\\flowlet".into()),
                workspace_project_id: None,
                workspace_archived: false,
                created_at: "2026-08-03T00:00:00Z".into(),
                updated_at: "2026-08-03T00:00:00Z".into(),
            })
            .unwrap();
        // 已归档项目不参与目录占用判断（其任务不会被调度器执行，可复用目录）。
        storage
            .save_project(&Project {
                id: "project-2".into(),
                name: "Archived".into(),
                directory_path: Some("D:\\work\\flowlet".into()),
                workspace_project_id: Some("ws-1".into()),
                workspace_archived: true,
                created_at: "2026-08-03T00:00:00Z".into(),
                updated_at: "2026-08-03T00:00:00Z".into(),
            })
            .unwrap();
        // 归档项目不命中；未归档项目仍命中。
        assert_eq!(
            storage
                .get_project_by_directory("D:\\work\\flowlet")
                .unwrap()
                .as_ref()
                .map(|p| p.id.as_str()),
            Some("project-1")
        );
    }

    #[test]
    fn normalize_directory_path_unifies_separators_and_case() {
        // 目录不存在的回退分支：统一 `\`/`/` 与尾部分隔符；Windows 下大小写不敏感。
        let base = normalize_directory_path("D:/Work/Flowlet");
        assert_eq!(normalize_directory_path("D:\\Work\\Flowlet\\"), base);
        #[cfg(windows)]
        assert_eq!(normalize_directory_path("d:/work/flowlet"), base);
        // 空路径 / 空白归一化为空串，不参与匹配。
        assert_eq!(normalize_directory_path("   "), "");
    }

    /// 旧库（2026-08-05 之前：projects.directory_path NOT NULL、任务表缺工作区/领取/
    /// 软删除列）升级到多设备工作区 schema：目录可空化、新列补齐、数据保留、
    /// 外键级联仍生效（重建 projects 不能破坏 project_tasks 的 ON DELETE CASCADE）。
    #[test]
    fn migrate_projects_workspace_schema_upgrades_legacy_database() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "PRAGMA foreign_keys = ON;
                 CREATE TABLE projects (
                     id             TEXT PRIMARY KEY,
                     name           TEXT NOT NULL,
                     directory_path TEXT NOT NULL,
                     created_at     TEXT NOT NULL,
                     updated_at     TEXT NOT NULL
                 );
                 CREATE TABLE project_tasks (
                     id            TEXT PRIMARY KEY,
                     project_id    TEXT NOT NULL,
                     title         TEXT NOT NULL,
                     description   TEXT NOT NULL DEFAULT '',
                     status        TEXT NOT NULL DEFAULT 'draft',
                     created_at    TEXT NOT NULL,
                     updated_at    TEXT NOT NULL,
                     FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
                 );
                 INSERT INTO projects (id, name, directory_path, created_at, updated_at)
                     VALUES ('legacy-p', '旧项目', 'D:\\old', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');
                 INSERT INTO project_tasks (id, project_id, title, description, status, created_at, updated_at)
                     VALUES ('legacy-t', 'legacy-p', '旧任务', '描述', 'submitted', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');",
            )
            .unwrap();
        let storage = Storage::from_connection_for_test(connection);
        storage.migrate().unwrap();

        // 目录可空化 + 工作区列补齐。
        let project = storage.get_project("legacy-p").unwrap().unwrap();
        assert_eq!(project.directory_path.as_deref(), Some("D:\\old"));
        assert!(project.workspace_project_id.is_none());
        assert!(!project.workspace_archived);
        // 新列可写。
        storage
            .save_project(&Project {
                directory_path: None,
                workspace_project_id: Some("ws-legacy".into()),
                workspace_archived: false,
                ..project.clone()
            })
            .unwrap();
        let rebound = storage.get_project("legacy-p").unwrap().unwrap();
        assert!(rebound.directory_path.is_none());
        assert_eq!(rebound.workspace_project_id.as_deref(), Some("ws-legacy"));

        // 任务数据保留，新列（claimed/deleted）存在并可写。
        let task = storage
            .get_project_task("legacy-p", "legacy-t")
            .unwrap()
            .unwrap();
        assert_eq!(task.title, "旧任务");
        assert!(storage.claim_task("legacy-t", "device-a").unwrap());
        let claimed = storage
            .get_project_task("legacy-p", "legacy-t")
            .unwrap()
            .unwrap();
        assert_eq!(claimed.claimed_by.as_deref(), Some("device-a"));

        // 外键级联仍生效：删除项目会级联删除任务。
        assert!(storage.delete_project("legacy-p").unwrap());
        assert!(storage.list_project_tasks("legacy-p").unwrap().is_empty());
    }
}
