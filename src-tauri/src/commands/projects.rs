use crate::core::storage::{Project, ProjectTask};
use crate::AppState;
use tauri::Manager;

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
    let directory = std::path::Path::new(project.directory_path.trim());
    if !directory.is_dir() {
        return Err("项目目录不存在或不是文件夹".to_string());
    }
    state
        .storage
        .save_project(&Project {
            id: project.id.trim().to_string(),
            name: project.name.trim().to_string(),
            directory_path: directory.to_string_lossy().into_owned(),
            created_at: project.created_at,
            updated_at: project.updated_at,
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn delete_project(
    state: tauri::State<'_, AppState>,
    project_id: String,
) -> Result<bool, String> {
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
    if !matches!(task.status.as_str(), "draft" | "submitted" | "in_progress" | "review" | "done") {
        return Err("任务状态无效".to_string());
    }
    if !matches!(task.task_type.as_str(), "code" | "readonly") {
        return Err("任务类型无效".to_string());
    }
    if task.agent_profile.trim().is_empty() {
        return Err("Agent Profile 不能为空".to_string());
    }
    if !matches!(task.priority.as_str(), "p0" | "p1" | "p2") {
        return Err("任务优先级无效".to_string());
    }
    if state
        .storage
        .get_project(&task.project_id)
        .map_err(|error| error.to_string())?
        .is_none()
    {
        return Err("项目不存在".to_string());
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
            priority: task.priority,
            last_job_id: task.last_job_id,
            rejection_reason: task.rejection_reason,
            execution_history: task.execution_history,
            created_at: task.created_at,
            updated_at: task.updated_at,
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn delete_project_task(
    state: tauri::State<'_, AppState>,
    project_id: String,
    task_id: String,
) -> Result<bool, String> {
    state
        .storage
        .delete_project_task(&project_id, &task_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) async fn run_project_task(
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
    project_id: String,
    task_id: String,
) -> Result<crate::core::agent_task_runner::RunProjectTaskResult, String> {
    let storage = state.storage.clone();
    crate::core::agent_task_runner::run_project_task(storage, app_handle, project_id, task_id).await
}

#[tauri::command]
pub(crate) fn get_project_task_runner_state(
) -> Result<crate::core::agent_task_runner::ProjectTaskRunnerState, String> {
    Ok(crate::core::agent_task_runner::task_runner_state())
}

#[tauri::command]
pub(crate) fn list_queued_project_tasks(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<ProjectTask>, String> {
    state
        .storage
        .list_queued_project_tasks()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn set_project_task_status(
    state: tauri::State<'_, AppState>,
    task_id: String,
    status: String,
    reason: Option<String>,
) -> Result<(), String> {
    // 状态机：前端审核通道只允许「待审核 → 批准(done) / 退回(submitted)」。
    // 其余迁移（含把 in_progress 撤销）由执行器内部管理，这里一律拦截。
    let current = state
        .storage
        .get_task_status(&task_id)
        .map_err(|error| error.to_string())?;
    let allowed = matches!(
        (current.as_deref(), status.as_str()),
        (Some("review"), "done") | (Some("review"), "submitted")
    );
    if !allowed {
        return Err("当前任务状态不允许此操作".to_string());
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
            let _ = state.storage.add_job_event(&job_id, "warning", "退回", &message);
            let _ = state.storage.mark_task_execution_rejected(&task_id, &job_id, &trimmed);
        }
    }
    Ok(())
}

/// 在独立窗口中打开项目详情看板（无侧边栏、无边框窗口）。
/// 同一项目已打开过窗口时聚焦复用，避免重复创建。
/// 独立窗口复用主窗口的 WebView 数据目录，保证语言/主题等本地偏好一致。
#[tauri::command]
pub(crate) fn open_project_detail_window(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    project_id: String,
) -> Result<(), String> {
    let label = format!("project-detail-{project_id}");
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }

    let project = state
        .storage
        .get_project(&project_id)
        .map_err(|error| format!("读取项目失败：{error}"))?
        .ok_or_else(|| "项目不存在".to_string())?;

    let data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("解析应用数据目录失败：{error}"))?
        .join("main-webview");
    std::fs::create_dir_all(&data_dir)
        .map_err(|error| format!("创建应用数据目录失败：{error}"))?;

    // 与主窗口同一份 index.html，通过 hash 路由进入独立窗口专属页面。
    let url = tauri::WebviewUrl::App(format!("index.html#/project-window/{project_id}").into());
    let builder = tauri::WebviewWindowBuilder::new(&app, label, url)
        .title(format!("Flowlet · {}", project.name))
        .inner_size(960.0, 720.0)
        .min_inner_size(720.0, 480.0)
        .decorations(false)
        .resizable(true)
        .maximizable(true)
        .visible(false)
        .data_directory(data_dir);
    #[cfg(windows)]
    let builder = builder.additional_browser_args(
        crate::core::webview_profile::WINDOWS_CACHE_LIMIT_BROWSER_ARGS,
    );
    let window = builder
        .build()
        .map_err(|error| format!("创建项目详情独立窗口失败：{error}"))?;
    let _ = window.show();
    let _ = window.set_focus();
    Ok(())
}
