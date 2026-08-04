use crate::core::storage::{Project, ProjectTask};
use crate::AppState;

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
    if !matches!(task.priority.as_str(), "p0" | "p1" | "p2" | "p3") {
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
