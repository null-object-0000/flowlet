use crate::core::storage::{Project, ProjectTask};
use crate::AppState;
use tauri::{Emitter, Manager};

/// 项目详情独立窗口打开后，通知前端定位到某个任务（激活任务概览抽屉）。
/// 前端在 `#/project-window/:projectId` 页面监听该事件；新窗口首次挂载时
/// 也通过 URL 查询参数 `?task=` 兜底（事件可能在页面监听就绪前发出）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskDetailOpenPayload {
    pub project_id: String,
    pub task_id: String,
}

#[tauri::command]
pub(crate) fn list_projects(state: tauri::State<'_, AppState>) -> Result<Vec<Project>, String> {
    state
        .storage
        .list_projects()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn get_project(
    state: tauri::State<'_, AppState>,
    project_id: String,
) -> Result<Project, String> {
    state
        .storage
        .get_project(&project_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "项目不存在".to_string())
}

#[tauri::command]
pub(crate) fn save_project(
    state: tauri::State<'_, AppState>,
    project: Project,
) -> Result<(), String> {
    if project.id.trim().is_empty() || project.name.trim().is_empty() {
        return Err("项目 ID 和名称不能为空".to_string());
    }
    // 目录可空：远端项目未绑定目录时保持 None，绑定/修改时校验目录存在。
    // 工作区归属字段是服务端托管：编辑时保留数据库中已有值，前端传入值不采信。
    let existing = state
        .storage
        .get_project(&project.id)
        .map_err(|error| error.to_string())?;
    let workspace_project_id = existing
        .as_ref()
        .and_then(|existing| existing.workspace_project_id.clone());
    let workspace_archived = existing
        .as_ref()
        .map(|existing| existing.workspace_archived)
        .unwrap_or(false);
    let directory_path = match project.directory_path.as_deref() {
        Some(path) if !path.trim().is_empty() => {
            let directory = std::path::Path::new(path.trim());
            if !directory.is_dir() {
                return Err("项目目录不存在或不是文件夹".to_string());
            }
            // 目录唯一性约束：同一目录只能绑定一个项目，否则两个项目并行执行同一
            // 目录会互相冲突（Agent 会话、工作区文件被并发读写）。
            let directory = directory.to_string_lossy().into_owned();
            if let Some(other) = state
                .storage
                .get_project_by_directory(&directory)
                .map_err(|error| error.to_string())?
            {
                if other.id != project.id {
                    return Err(format!(
                        "项目目录已被项目「{}」占用，一个目录只能绑定一个项目，请选择其它目录",
                        other.name
                    ));
                }
            }
            Some(directory)
        }
        _ => None,
    };
    state
        .storage
        .save_project(&Project {
            id: project.id.trim().to_string(),
            name: project.name.trim().to_string(),
            directory_path,
            workspace_project_id,
            workspace_archived,
            created_at: project.created_at,
            updated_at: project.updated_at,
        })
        .map_err(|error| error.to_string())?;
    // 项目名 / 目录绑定变更后即时推送工作区（目录是本地字段，只同步名字）。
    crate::core::project_workspace_sync::notify_project_changed(state.storage.clone(), &project.id);
    Ok(())
}

#[tauri::command]
pub(crate) async fn delete_project(
    state: tauri::State<'_, AppState>,
    project_id: String,
) -> Result<bool, String> {
    // 先取工作区项目 id 并写入墓碑，再删除本机项目：远端墓碑落地后其他设备
    // 会删除各自副本，避免删除动作在下一轮同步中被重新拉回。
    let workspace_project_id = state
        .storage
        .get_project(&project_id)
        .map_err(|error| error.to_string())?
        .and_then(|project| project.workspace_project_id);
    if let Some(ws_id) = workspace_project_id {
        let _ = crate::core::project_workspace_sync::push_tombstone(state.storage.clone(), &ws_id)
            .await;
    }
    state
        .storage
        .delete_project(&project_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn list_project_tasks(
    state: tauri::State<'_, AppState>,
    project_id: String,
) -> Result<Vec<ProjectTask>, String> {
    state
        .storage
        .list_project_tasks(&project_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn list_recurring_tasks(
    state: tauri::State<'_, AppState>,
    project_id: String,
) -> Result<Vec<crate::core::storage::RecurringTask>, String> {
    state
        .storage
        .list_recurring_tasks(&project_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn save_recurring_task(
    state: tauri::State<'_, AppState>,
    task: crate::core::storage::RecurringTask,
) -> Result<(), String> {
    if task.id.trim().is_empty()
        || task.project_id.trim().is_empty()
        || task.title.trim().is_empty()
    {
        return Err("重复任务 ID、项目和名称不能为空".to_string());
    }
    if !matches!(task.task_type.as_str(), "code" | "readonly") {
        return Err("任务类型无效".to_string());
    }
    if !matches!(task.schedule_kind.as_str(), "manual" | "daily") {
        return Err("运行计划无效".to_string());
    }
    if !matches!(task.session_policy.as_str(), "fresh" | "continue") {
        return Err("会话策略无效".to_string());
    }
    if task.agent_profile.trim().is_empty() {
        return Err("Agent Profile 不能为空".to_string());
    }
    if state
        .storage
        .get_project(&task.project_id)
        .map_err(|error| error.to_string())?
        .is_none()
    {
        return Err("项目不存在".to_string());
    }
    state
        .storage
        .save_recurring_task(&task)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn delete_recurring_task(
    state: tauri::State<'_, AppState>,
    project_id: String,
    task_id: String,
) -> Result<bool, String> {
    state
        .storage
        .delete_recurring_task(&project_id, &task_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn list_recurring_task_runs(
    state: tauri::State<'_, AppState>,
    task_id: String,
) -> Result<Vec<crate::core::storage::RecurringTaskRun>, String> {
    state
        .storage
        .list_recurring_task_runs(&task_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) async fn run_recurring_task_now(
    state: tauri::State<'_, AppState>,
    task_id: String,
    test: bool,
) -> Result<crate::core::agent_task_runner::RunProjectTaskResult, String> {
    let task = state
        .storage
        .get_recurring_task(&task_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "重复任务不存在".to_string())?;
    let run = state
        .storage
        .create_recurring_task_run(&task, if test { "test" } else { "manual" }, None)
        .map_err(|error| error.to_string())?;
    crate::core::agent_task_runner::run_recurring_task_run(state.storage.clone(), run.id).await
}

#[tauri::command]
pub(crate) fn save_project_task(
    state: tauri::State<'_, AppState>,
    task: ProjectTask,
) -> Result<(), String> {
    if task.id.trim().is_empty()
        || task.project_id.trim().is_empty()
        || task.title.trim().is_empty()
    {
        return Err("任务 ID、项目和标题不能为空".to_string());
    }
    if !matches!(
        task.status.as_str(),
        "draft" | "submitted" | "in_progress" | "review" | "done"
    ) {
        return Err("任务状态无效".to_string());
    }
    if !matches!(task.task_type.as_str(), "code" | "readonly") {
        return Err("任务类型无效".to_string());
    }
    if task.agent_profile.trim().is_empty() {
        return Err("Agent Profile 不能为空".to_string());
    }
    // 优先级能力已从前端移除，后端继续保留字段但默认写死 P2（输入值不采信）。
    let priority = "p2".to_string();
    if state
        .storage
        .get_project(&task.project_id)
        .map_err(|error| error.to_string())?
        .is_none()
    {
        return Err("项目不存在".to_string());
    }
    // 跨设备权限：不能基于其他设备的任务在本机建立子任务（或继续编辑）。
    // 父任务不在本机 / 父任务已被其他设备执行 → 一律拒绝，本机只读。
    if let Some(base_id) = task.base_task_id.as_deref() {
        let current_device_id = state
            .device_identity
            .lock()
            .map_err(|_| "读取当前设备身份失败".to_string())?
            .device_id
            .clone();
        if state
            .storage
            .task_is_owned_by_other_device(base_id, &current_device_id)
            .map_err(|error| error.to_string())?
        {
            return Err("父任务由其他设备执行，本机不能基于它创建或编辑子任务".to_string());
        }
    }
    // 状态机：已存在的任务只有草稿可编辑。执行中 / 待审核 / 已完成都是只读，
    // 状态由执行器或审核通道管理，前端编辑通道一律拦截（防止把运行中任务改掉）。
    if let Some(status) = state
        .storage
        .get_task_status(&task.id)
        .map_err(|error| error.to_string())?
    {
        if status != "draft" {
            return Err("只有草稿状态的任务可以编辑".to_string());
        }
    }
    // 执行归属（claimed_by / claimed_at）与最近执行 job（last_job_id）是服务端托管字段：
    // 前端传入不采信，保存时保留数据库已有值——避免编辑草稿把本机已执行任务的
    // 执行归属清空，导致本机任务被误判为其他设备任务。
    let existing = state
        .storage
        .get_project_task_by_id(&task.id)
        .map_err(|error| error.to_string())?;
    // 队列置顶同样是服务端托管字段：编辑草稿不触碰，已有值保留（新任务为 None）。
    let (claimed_by, claimed_at, last_job_id, queue_boosted_at) = existing
        .map(|existing| {
            (
                existing.claimed_by,
                existing.claimed_at,
                existing.last_job_id,
                existing.queue_boosted_at,
            )
        })
        .unwrap_or((None, None, task.last_job_id, None));
    state
        .storage
        .save_project_task(&ProjectTask {
            id: task.id.trim().to_string(),
            project_id: task.project_id.trim().to_string(),
            title: task.title.trim().to_string(),
            description: task.description.trim().to_string(),
            status: task.status,
            task_type: task.task_type,
            agent_profile: task.agent_profile.trim().to_string(),
            priority: priority.clone(),
            base_task_id: task.base_task_id,
            last_job_id,
            rejection_reason: task.rejection_reason,
            execution_history: task.execution_history,
            created_at: task.created_at,
            updated_at: task.updated_at,
            // 领取归属是服务端托管，前端传入不采信；已有值保留。
            claimed_by,
            claimed_at,
            queue_boosted_at,
            deleted: false,
        })
        .map_err(|error| error.to_string())?;
    // 保存成功后把该项目的最新状态即时推送工作区，其他设备 / 移动端尽快看到。
    crate::core::project_workspace_sync::notify_project_changed(
        state.storage.clone(),
        &task.project_id,
    );
    Ok(())
}

#[tauri::command]
pub(crate) fn delete_project_task(
    state: tauri::State<'_, AppState>,
    project_id: String,
    task_id: String,
) -> Result<bool, String> {
    // 跨设备权限：其他设备执行过/执行中的任务，本机只读，不能删除。
    let current_device_id = state
        .device_identity
        .lock()
        .map_err(|_| "读取当前设备身份失败".to_string())?
        .device_id
        .clone();
    if state
        .storage
        .task_is_owned_by_other_device(&task_id, &current_device_id)
        .map_err(|error| error.to_string())?
    {
        return Err("该任务由其他设备执行，本机只读，不能删除".to_string());
    }
    state
        .storage
        .delete_project_task(&project_id, &task_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) async fn run_project_task(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    project_id: String,
    task_id: String,
) -> Result<crate::core::agent_task_runner::RunProjectTaskResult, String> {
    let storage = state.storage.clone();
    let current_device_id = state
        .device_identity
        .lock()
        .map_err(|_| "读取当前设备身份失败".to_string())?
        .device_id
        .clone();
    crate::core::agent_task_runner::run_project_task(
        app,
        storage,
        project_id,
        task_id,
        current_device_id,
    )
    .await
}

#[tauri::command]
pub(crate) fn get_project_task_runner_state(
) -> Result<crate::core::agent_task_runner::ProjectTaskRunnerState, String> {
    Ok(crate::core::agent_task_runner::task_runner_state())
}

/// 置顶任务：把已提交待执行任务提到队列最前。
/// 只允许操作本机可执行（非其他设备归属）的 submitted 任务。
#[tauri::command]
pub(crate) fn boost_project_task(
    state: tauri::State<'_, AppState>,
    task_id: String,
) -> Result<bool, String> {
    let current_device_id = state
        .device_identity
        .lock()
        .map_err(|_| "读取当前设备身份失败".to_string())?
        .device_id
        .clone();
    // 跨设备权限：其他设备执行过/执行中的任务，本机只读，不能置顶。
    if state
        .storage
        .task_is_owned_by_other_device(&task_id, &current_device_id)
        .map_err(|error| error.to_string())?
    {
        return Err("该任务由其他设备执行，本机只读，不能置顶".to_string());
    }
    let boosted = state
        .storage
        .boost_project_task(&task_id)
        .map_err(|error| error.to_string())?;
    if !boosted {
        return Err("只有已提交待执行的任务可以置顶".to_string());
    }
    // 置顶后刷新队列顺序，其他设备/移动端尽快看到。
    if let Some(project_id) = state
        .storage
        .get_task_project(&task_id)
        .map_err(|error| error.to_string())?
    {
        crate::core::project_workspace_sync::notify_project_changed(
            state.storage.clone(),
            &project_id,
        );
    }
    Ok(true)
}

#[tauri::command]
pub(crate) fn get_project_workspace_status(
    state: tauri::State<'_, AppState>,
) -> Result<crate::core::project_workspace_sync::ProjectWorkspaceStatus, String> {
    crate::core::project_workspace_sync::status(&state.storage)
}

#[tauri::command]
pub(crate) async fn sync_project_workspace(
    state: tauri::State<'_, AppState>,
) -> Result<crate::core::project_workspace_sync::ProjectWorkspaceSyncResult, String> {
    crate::core::project_workspace_sync::sync_all(state.storage.clone(), &state.jobs, "manual")
        .await
}

#[tauri::command]
pub(crate) fn list_queued_project_tasks(
    state: tauri::State<'_, AppState>,
) -> Result<crate::core::agent_task_runner::ProjectTaskQueueReport, String> {
    let current_device_id = state
        .device_identity
        .lock()
        .map_err(|_| "读取当前设备身份失败".to_string())?
        .device_id
        .clone();
    let queued = state
        .storage
        .list_queued_project_tasks(&current_device_id)
        .map_err(|error| error.to_string())?;
    Ok(crate::core::agent_task_runner::project_task_queue_report(
        &state.storage,
        queued,
    ))
}

#[tauri::command]
pub(crate) fn set_project_task_status(
    state: tauri::State<'_, AppState>,
    task_id: String,
    status: String,
    reason: Option<String>,
) -> Result<(), String> {
    // 状态机：前端审核通道允许「待审核 → 批准(done) / 退回(submitted)」，
    // 并允许「已提交 → 草稿」撤回（提交后悔窗口内用户撤回，回到草稿后可再次编辑/提交）。
    // 其余迁移（含把 in_progress 撤销）由执行器内部管理，这里一律拦截。
    let current = state
        .storage
        .get_task_status(&task_id)
        .map_err(|error| error.to_string())?;
    let allowed = matches!(
        (current.as_deref(), status.as_str()),
        (Some("review"), "done") | (Some("review"), "submitted") | (Some("submitted"), "draft")
    );
    if !allowed {
        return Err("当前任务状态不允许此操作".to_string());
    }
    // 跨设备权限：其他设备执行过/执行中的任务，本机只读，不能撤回/审核/退回。
    let current_device_id = state
        .device_identity
        .lock()
        .map_err(|_| "读取当前设备身份失败".to_string())?
        .device_id
        .clone();
    if state
        .storage
        .task_is_owned_by_other_device(&task_id, &current_device_id)
        .map_err(|error| error.to_string())?
    {
        return Err("该任务由其他设备执行，本机只读，请在执行设备上操作".to_string());
    }
    state
        .storage
        .set_task_status(&task_id, &status)
        .map_err(|error| error.to_string())?;
    // 退回时记录原因：供下次执行读取注入 prompt，也让审核留档。
    if status == "submitted" {
        let trimmed = reason.as_deref().map(str::trim).unwrap_or("").to_string();
        state
            .storage
            .set_task_rejection_reason(&task_id, Some(&trimmed))
            .map_err(|error| error.to_string())?;
        // 原因写进该次执行的 job timeline，并标记执行历史为已退回 → 只读详情长期可见。
        if let Some(job_id) = state
            .storage
            .get_task_last_job(&task_id)
            .map_err(|error| error.to_string())?
        {
            let message = if trimmed.is_empty() {
                "任务被退回".to_string()
            } else {
                format!("任务被退回：{trimmed}")
            };
            let _ = state
                .storage
                .add_job_event(&job_id, "warning", "退回", &message);
            let _ = state
                .storage
                .mark_task_execution_rejected(&task_id, &job_id, &trimmed);
        }
    }
    // 状态变更即时推送工作区，其他设备尽快看到审核结果 / 重新排队。
    if let Some(project_id) = state
        .storage
        .get_task_project(&task_id)
        .map_err(|error| error.to_string())?
    {
        crate::core::project_workspace_sync::notify_project_changed(
            state.storage.clone(),
            &project_id,
        );
    }
    Ok(())
}

/// 待审核的只读分析任务转为代码修改任务。
/// 与退回一样，转换必须填写描述信息（新的代码修改要求）；转换后任务回到已提交
/// 状态重新排队，以代码修改类型重新执行。转换动作写入最近一次执行的 job timeline
/// 留档，供只读详情追溯。
#[tauri::command]
pub(crate) fn convert_project_task_to_code(
    state: tauri::State<'_, AppState>,
    task_id: String,
    description: String,
) -> Result<(), String> {
    let trimmed = description.trim().to_string();
    if trimmed.is_empty() {
        return Err("转为代码修改任务需要填写代码修改要求".to_string());
    }
    // 跨设备权限：其他设备执行过的任务，本机只读，不能转为代码修改。
    let current_device_id = state
        .device_identity
        .lock()
        .map_err(|_| "读取当前设备身份失败".to_string())?
        .device_id
        .clone();
    if state
        .storage
        .task_is_owned_by_other_device(&task_id, &current_device_id)
        .map_err(|error| error.to_string())?
    {
        return Err("该任务由其他设备执行，本机只读，不能转为代码修改任务".to_string());
    }
    let converted = state
        .storage
        .convert_task_to_code(&task_id, &trimmed)
        .map_err(|error| error.to_string())?;
    if !converted {
        let (status, task_type) = state
            .storage
            .get_task_state(&task_id)
            .map_err(|error| error.to_string())?
            .unwrap_or_else(|| ("不存在".to_string(), "未知".to_string()));
        return Err(format!(
            "只有待审核的只读分析任务可以转为代码修改任务（当前状态：{status}，类型：{task_type}）"
        ));
    }
    // 转换动作写入该次执行的 job timeline，供审核详情长期可见。
    if let Some(job_id) = state
        .storage
        .get_task_last_job(&task_id)
        .map_err(|error| error.to_string())?
    {
        let _ = state.storage.add_job_event(
            &job_id,
            "warning",
            "类型转换",
            &format!("任务已由只读分析转为代码修改：{trimmed}"),
        );
    }
    // 转换后任务回到 submitted 重新排队，即时推送工作区。
    if let Some(project_id) = state
        .storage
        .get_task_project(&task_id)
        .map_err(|error| error.to_string())?
    {
        crate::core::project_workspace_sync::notify_project_changed(
            state.storage.clone(),
            &project_id,
        );
    }
    Ok(())
}

/// 在独立窗口中打开项目详情看板（无侧边栏、无边框窗口）。
/// 同一项目已打开过窗口时聚焦复用，避免重复创建。
/// 独立窗口复用主窗口的 WebView 数据目录，保证语言/主题等本地偏好一致。
/// 必须保持 async：WebView2 窗口创建会在主线程消息循环上同步等待初始化，
/// 若放在同步 command（主线程执行）里会造成整个事件循环死锁，所有 invoke 超时。
#[tauri::command]
pub(crate) async fn open_project_detail_window(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    project_id: String,
    task_id: Option<String>,
) -> Result<(), String> {
    open_detail_window(&app, state.inner(), &project_id, task_id.as_deref()).await
}

/// 真正的独立窗口创建逻辑。既被上述 command 调用，也被应用启动时用于
/// 恢复上次退出的独立窗口 —— 两者共用同一套「创建 + 记录 + 关闭清理」流程。
/// 传入 `task_id` 时，窗口打开后向前端发送 `task-detail-open` 事件，
/// 让任务看板激活对应任务的概览抽屉；新窗口首次挂载还通过 URL `?task=` 兜底。
pub(crate) async fn open_detail_window(
    app: &tauri::AppHandle,
    state: &AppState,
    project_id: &str,
    task_id: Option<&str>,
) -> Result<(), String> {
    let label = format!("project-detail-{project_id}");
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        if let Some(task_id) = task_id {
            let _ = app.emit_to(
                &label,
                "task-detail-open",
                TaskDetailOpenPayload {
                    project_id: project_id.to_string(),
                    task_id: task_id.to_string(),
                },
            );
        }
        return Ok(());
    }

    let project = state
        .storage
        .get_project(project_id)
        .map_err(|error| format!("读取项目失败：{error}"))?
        .ok_or_else(|| "项目不存在".to_string())?;

    let data_dir = crate::core::webview_profile::webview_data_root(app)?.join("main-webview");
    std::fs::create_dir_all(&data_dir).map_err(|error| format!("创建应用数据目录失败：{error}"))?;

    // 与主窗口同一份 index.html，通过 hash 路由进入独立窗口专属页面。
    // 携带 task 查询参数：新窗口首次挂载时前端据此直接激活任务概览抽屉，
    // 避免「事件在页面监听就绪前发出而丢失」的竞态。
    let route = match task_id {
        Some(task_id) => format!("index.html#/project-window/{project_id}?task={task_id}"),
        None => format!("index.html#/project-window/{project_id}"),
    };
    let url = tauri::WebviewUrl::App(route.into());
    let builder = tauri::WebviewWindowBuilder::new(app, label.clone(), url)
        .title(format!("Flowlet · {}", project.name))
        .inner_size(
            crate::core::window_size::MIN_CONTENT_WIDTH,
            crate::core::window_size::MIN_CONTENT_HEIGHT,
        )
        .min_inner_size(
            crate::core::window_size::MIN_CONTENT_WIDTH,
            crate::core::window_size::MIN_CONTENT_HEIGHT,
        )
        .decorations(false)
        .resizable(true)
        .maximizable(true)
        .visible(false)
        .data_directory(data_dir);
    #[cfg(windows)]
    let builder = builder
        .additional_browser_args(crate::core::webview_profile::WINDOWS_CACHE_LIMIT_BROWSER_ARGS);
    let window = builder
        .build()
        .map_err(|error| format!("创建项目详情独立窗口失败：{error}"))?;

    crate::core::window_size::enforce_minimum_content_size(&window)
        .map_err(|error| format!("设置项目详情窗口最小客户区失败：{error}"))?;

    // 启动时的恢复窗口也可能落在已变化/消失的屏幕外，先兜底拉回可见区域。
    crate::core::window_visibility::ensure_window_on_screen(&window);

    // 记录该窗口以支持重启恢复；用户主动关闭时从记录移除（应用退出时除外）。
    state.detail_windows.add(project_id);
    let registry = state.detail_windows.clone();
    let app_exiting = state.app_exiting.clone();
    let project_id_owned = project_id.to_string();
    let project_id_for_emit = project_id_owned.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { .. } = event {
            let exiting = app_exiting.lock().map(|g| *g).unwrap_or(false);
            if !exiting {
                registry.remove(&project_id_owned);
            }
        }
    });

    let _ = window.show();
    let _ = window.set_focus();

    // 新窗口同样发一次事件：页面若已就绪可立即响应；未就绪则由 URL 查询参数兜底。
    if let Some(task_id) = task_id {
        let _ = app.emit_to(
            &label,
            "task-detail-open",
            TaskDetailOpenPayload {
                project_id: project_id_for_emit,
                task_id: task_id.to_string(),
            },
        );
    }
    Ok(())
}
