//! 项目工作区同步：把项目与任务的共享字段加密同步到 S3 工作区对象。
//!
//! 复用账号工作区密钥（同一把工作区加密密钥），每个项目一个独立对象：
//! `<prefix>/flowlet/v1/workspace/projects/<workspace_project_id>.enc`
//!
//! 并发控制复用账号工作区模式：revision + ETag + If-Match 条件写入。
//! 本机目录绑定（`directory_path`）、领取归属（`claimed_by` / `claimed_at`）
//! 和最近执行 job（`last_job_id`）是设备本地字段，不进入工作区对象。
//!
//! 合并规则（last-writer-wins + 状态机守卫 + 软删除墓碑）：
//! - 新增任务：UUID 无冲突，双向合并都保留；
//! - 同一任务编辑：按 `updated_at` 新者胜（只有草稿可编辑，冲突窗口极小）；
//! - 状态迁移：保持既有状态机，非法迁移被命令层拦截；
//! - 删除任务：软删除墓碑，删除优先；
//! - 删除项目：写入 `deleted` 墓碑，其他设备收到后删除本地项目。

use crate::core::account_workspace_sync;
use crate::core::device_sync::{load_config, read_secret, S3Store};
use crate::core::storage::{Project, ProjectTask, Storage};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    ChaCha20Poly1305, Nonce,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

const PROJECT_WORKSPACE_JOB_TYPE: &str = "project-workspace-sync";
const PROJECT_ETAG_META_KEY: &str = "project_workspace_etags_v1";
const ENVELOPE_AAD: &[u8] = b"flowlet-project-workspace-v1";
const CATALOG_VERSION: u32 = 1;
static PROJECT_WORKSPACE_SYNC_GUARD: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceProject {
    pub id: String,
    pub name: String,
    pub archived: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTask {
    pub id: String,
    pub title: String,
    pub description: String,
    pub status: String,
    pub task_type: String,
    pub agent_profile: String,
    pub priority: String,
    pub base_task_id: Option<String>,
    pub rejection_reason: Option<String>,
    pub execution_history: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub deleted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectWorkspaceCatalog {
    pub version: u32,
    pub revision: u64,
    pub updated_at: String,
    pub project: WorkspaceProject,
    pub tasks: Vec<WorkspaceTask>,
    pub deleted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EncryptedCatalogEnvelope {
    format: String,
    version: u32,
    nonce: String,
    ciphertext: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectWorkspaceSyncResult {
    pub synced_projects: usize,
    pub created_local_projects: usize,
    pub archived_projects: usize,
    pub task_count: usize,
    pub uploaded_objects: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectWorkspaceStatus {
    pub enabled: bool,
    pub synced_projects: usize,
    pub local_only_projects: usize,
}

/// 工作区是否可用：S3 已配置且工作区密钥可读取（与账号工作区共用密钥）。
pub fn is_enabled(storage: &Storage) -> bool {
    account_workspace_sync::is_enabled(storage)
}

pub fn status(storage: &Storage) -> Result<ProjectWorkspaceStatus, String> {
    let projects = storage
        .list_projects_for_workspace()
        .map_err(|error| error.to_string())?;
    let synced = projects
        .iter()
        .filter(|project| project.workspace_project_id.is_some())
        .count();
    Ok(ProjectWorkspaceStatus {
        enabled: is_enabled(storage),
        synced_projects: synced,
        local_only_projects: projects.len() - synced,
    })
}

// ---------------------------------------------------------------------------
// 加密信封（与账号工作区一致，AAD 独立）
// ---------------------------------------------------------------------------

fn encrypt_catalog(catalog: &ProjectWorkspaceCatalog, key: &[u8; 32]) -> Result<Vec<u8>, String> {
    let cipher = ChaCha20Poly1305::new_from_slice(key)
        .map_err(|_| "初始化项目工作区加密失败".to_string())?;
    let nonce_uuid = uuid::Uuid::new_v4();
    let nonce_bytes = &nonce_uuid.as_bytes()[..12];
    let plaintext = serde_json::to_vec(catalog).map_err(|_| "序列化项目工作区失败".to_string())?;
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(nonce_bytes),
            Payload {
                msg: &plaintext,
                aad: ENVELOPE_AAD,
            },
        )
        .map_err(|_| "加密项目工作区失败".to_string())?;
    serde_json::to_vec(&EncryptedCatalogEnvelope {
        format: "flowlet-project-workspace".to_string(),
        version: CATALOG_VERSION,
        nonce: BASE64.encode(nonce_bytes),
        ciphertext: BASE64.encode(ciphertext),
    })
    .map_err(|_| "序列化项目工作区密文失败".to_string())
}

fn decrypt_catalog(bytes: &[u8], key: &[u8; 32]) -> Result<ProjectWorkspaceCatalog, String> {
    let envelope: EncryptedCatalogEnvelope =
        serde_json::from_slice(bytes).map_err(|_| "项目工作区密文格式无效".to_string())?;
    if envelope.format != "flowlet-project-workspace" || envelope.version != CATALOG_VERSION {
        return Err("项目工作区版本不受支持".to_string());
    }
    let nonce = BASE64
        .decode(envelope.nonce)
        .map_err(|_| "项目工作区 nonce 无效".to_string())?;
    if nonce.len() != 12 {
        return Err("项目工作区 nonce 长度无效".to_string());
    }
    let ciphertext = BASE64
        .decode(envelope.ciphertext)
        .map_err(|_| "项目工作区密文无效".to_string())?;
    let cipher = ChaCha20Poly1305::new_from_slice(key)
        .map_err(|_| "初始化项目工作区解密失败".to_string())?;
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad: ENVELOPE_AAD,
            },
        )
        .map_err(|_| "项目工作区解密失败，请确认工作区密钥一致".to_string())?;
    let catalog: ProjectWorkspaceCatalog =
        serde_json::from_slice(&plaintext).map_err(|_| "项目工作区内容格式无效".to_string())?;
    if catalog.version != CATALOG_VERSION {
        return Err("项目工作区内容版本不受支持".to_string());
    }
    Ok(catalog)
}

// ---------------------------------------------------------------------------
// ETag 元数据（app_meta 中以 JSON map 保存「工作区项目 id → ETag」）
// ---------------------------------------------------------------------------

fn read_etag_map(storage: &Storage) -> Result<HashMap<String, String>, String> {
    let Some(raw) = storage
        .get_app_meta(PROJECT_ETAG_META_KEY)
        .map_err(|error| error.to_string())?
    else {
        return Ok(HashMap::new());
    };
    Ok(serde_json::from_str(&raw).unwrap_or_default())
}

fn save_etag_map(storage: &Storage, map: &HashMap<String, String>) -> Result<(), String> {
    let raw = serde_json::to_string(map).map_err(|error| error.to_string())?;
    storage
        .set_app_meta(PROJECT_ETAG_META_KEY, &raw)
        .map_err(|error| error.to_string())
}

// ---------------------------------------------------------------------------
// 工作区对象键
// ---------------------------------------------------------------------------

fn workspace_project_key(config: &crate::core::device_sync::S3SyncConfig, ws_id: &str) -> String {
    format!("{}projects/{ws_id}.enc", config.workspace_prefix())
}

// ---------------------------------------------------------------------------
// 转换辅助
// ---------------------------------------------------------------------------

fn workspace_project_from_local(project: &Project, archived: bool) -> WorkspaceProject {
    WorkspaceProject {
        id: project
            .workspace_project_id
            .clone()
            .unwrap_or_else(|| project.id.clone()),
        name: project.name.clone(),
        archived,
        created_at: project.created_at.clone(),
        updated_at: project.updated_at.clone(),
    }
}

fn workspace_task_from_local(task: &ProjectTask) -> WorkspaceTask {
    WorkspaceTask {
        id: task.id.clone(),
        title: task.title.clone(),
        description: task.description.clone(),
        status: task.status.clone(),
        task_type: task.task_type.clone(),
        agent_profile: task.agent_profile.clone(),
        priority: task.priority.clone(),
        base_task_id: task.base_task_id.clone(),
        rejection_reason: task.rejection_reason.clone(),
        execution_history: task.execution_history.clone(),
        created_at: task.created_at.clone(),
        updated_at: task.updated_at.clone(),
        deleted: task.deleted,
    }
}

fn local_task_from_workspace(task: &WorkspaceTask, local_project_id: &str) -> ProjectTask {
    ProjectTask {
        id: task.id.clone(),
        project_id: local_project_id.to_string(),
        title: task.title.clone(),
        description: task.description.clone(),
        status: task.status.clone(),
        task_type: task.task_type.clone(),
        agent_profile: task.agent_profile.clone(),
        priority: task.priority.clone(),
        base_task_id: task.base_task_id.clone(),
        last_job_id: None,
        rejection_reason: task.rejection_reason.clone(),
        execution_history: task.execution_history.clone(),
        created_at: task.created_at.clone(),
        updated_at: task.updated_at.clone(),
        claimed_by: None,
        claimed_at: None,
        queue_boosted_at: None,
        deleted: task.deleted,
    }
}

// ---------------------------------------------------------------------------
// 合并
// ---------------------------------------------------------------------------

/// 合并结果：把 `catalog`（远端工作区对象）应用到本地，并把本地较新的状态
/// 回写进 `catalog`（决定是否需要上传）。
struct MergeOutcome {
    /// 远端标记删除/归档 → 本机已删除对应项目。
    archived: bool,
    /// 本机没有该项目，已从远端创建。
    created_project: bool,
    /// 新建任务数。
    created_tasks: usize,
    /// 本地有较新状态，需要上传到远端。
    catalog_changed: bool,
}

fn apply_catalog(
    storage: &Storage,
    catalog: &mut ProjectWorkspaceCatalog,
) -> Result<MergeOutcome, String> {
    let ws_id = catalog.project.id.clone();

    // 墓碑：远端已删除 → 删除本机项目（级联删除本地任务），不再上传。
    if catalog.deleted || catalog.project.archived {
        let _ = storage
            .delete_project_by_workspace_id(&ws_id)
            .map_err(|error| error.to_string())?;
        return Ok(MergeOutcome {
            archived: true,
            created_project: false,
            created_tasks: 0,
            catalog_changed: false,
        });
    }

    let mut outcome = MergeOutcome {
        archived: false,
        created_project: false,
        created_tasks: 0,
        catalog_changed: false,
    };

    let local_project = match storage
        .get_project_by_workspace_id(&ws_id)
        .map_err(|error| error.to_string())?
    {
        Some(project) => project,
        None => {
            // 远端项目第一次落到本机：创建本地项目（未绑定目录），再创建任务。
            let local_id = uuid::Uuid::new_v4().to_string();
            let project = Project {
                id: local_id.clone(),
                name: catalog.project.name.clone(),
                directory_path: None,
                workspace_project_id: Some(ws_id.clone()),
                workspace_archived: false,
                created_at: catalog.project.created_at.clone(),
                updated_at: catalog.project.updated_at.clone(),
            };
            storage
                .save_project(&project)
                .map_err(|error| error.to_string())?;
            outcome.created_project = true;
            for task in catalog.tasks.iter().filter(|task| !task.deleted) {
                storage
                    .save_project_task(&local_task_from_workspace(task, &local_id))
                    .map_err(|error| error.to_string())?;
                outcome.created_tasks += 1;
            }
            return Ok(outcome);
        }
    };

    // 项目名合并：按 updated_at 新者胜。
    if catalog.project.updated_at > local_project.updated_at {
        storage
            .save_project(&Project {
                name: catalog.project.name.clone(),
                ..local_project.clone()
            })
            .map_err(|error| error.to_string())?;
    } else if local_project.updated_at > catalog.project.updated_at {
        catalog.project.name = local_project.name.clone();
        catalog.project.updated_at = local_project.updated_at.clone();
        outcome.catalog_changed = true;
    }

    // 任务双向合并。
    let local_tasks = storage
        .list_project_tasks_including_deleted(&local_project.id)
        .map_err(|error| error.to_string())?;
    let mut local_by_id = local_tasks
        .into_iter()
        .map(|task| (task.id.clone(), task))
        .collect::<HashMap<_, _>>();

    for workspace_task in &mut catalog.tasks {
        match local_by_id.remove(&workspace_task.id) {
            Some(mut local_task) => {
                // 本地已删除、远端未删除 → 传播本地删除（删除优先）。
                if local_task.deleted && !workspace_task.deleted {
                    workspace_task.deleted = true;
                    workspace_task.updated_at = local_task.updated_at.clone();
                    outcome.catalog_changed = true;
                    continue;
                }
                // 远端已删除、本地未删除 → 标记本地删除。
                if workspace_task.deleted && !local_task.deleted {
                    local_task.deleted = true;
                    storage
                        .save_project_task(&local_task)
                        .map_err(|error| error.to_string())?;
                    continue;
                }
                // 内容合并：新者胜。
                if workspace_task.updated_at >= local_task.updated_at {
                    let mut merged = local_task_from_workspace(workspace_task, &local_project.id);
                    // 保留本机领取归属与最近执行 job、队列置顶（设备本地字段，不进入工作区对象）。
                    merged.claimed_by = local_task.claimed_by;
                    merged.claimed_at = local_task.claimed_at;
                    merged.last_job_id = local_task.last_job_id;
                    merged.queue_boosted_at = local_task.queue_boosted_at;
                    storage
                        .save_project_task(&merged)
                        .map_err(|error| error.to_string())?;
                } else {
                    *workspace_task = workspace_task_from_local(&local_task);
                    outcome.catalog_changed = true;
                }
            }
            None => {
                // 本地不存在该任务：非删除任务创建本地副本，删除任务忽略（已传播）。
                if !workspace_task.deleted {
                    storage
                        .save_project_task(&local_task_from_workspace(
                            workspace_task,
                            &local_project.id,
                        ))
                        .map_err(|error| error.to_string())?;
                    outcome.created_tasks += 1;
                }
            }
        }
    }

    // 本地有、远端没有的任务（含本地已删除的）→ 回填到 catalog 上传。
    for task in local_by_id.into_values() {
        catalog.tasks.push(workspace_task_from_local(&task));
        outcome.catalog_changed = true;
    }

    Ok(outcome)
}

// ---------------------------------------------------------------------------
// 单项目同步
// ---------------------------------------------------------------------------

/// 同步单个工作区项目：拉远端 → 合并到本地 → 本机有新状态则回写上传。
async fn sync_project_inner(storage: &Storage, ws_id: &str) -> Result<(bool, bool, usize), String> {
    let config = load_config(storage)?.ok_or_else(|| "尚未配置 S3 同步".to_string())?;
    let secret = read_secret(&config)?;
    let key = account_workspace_sync::read_workspace_key(&config)?;
    let store = S3Store::new(&config, &secret)?;
    let object_key = workspace_project_key(&config, ws_id);
    let remote_etag = store.head_etag(&object_key).await?;

    let mut catalog = if remote_etag.is_some() {
        let bytes = store.get(&object_key).await?;
        decrypt_catalog(&bytes, &key)?
    } else {
        // 远端对象缺失：从本机项目初始化。
        let local = storage
            .get_project_by_workspace_id(ws_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "本地项目不存在".to_string())?;
        let mut tasks = storage
            .list_project_tasks_including_deleted(&local.id)
            .map_err(|error| error.to_string())?
            .into_iter()
            .map(|task| workspace_task_from_local(&task))
            .collect::<Vec<_>>();
        tasks.sort_by(|left, right| left.created_at.cmp(&right.created_at));
        ProjectWorkspaceCatalog {
            version: CATALOG_VERSION,
            revision: 0,
            updated_at: chrono::Utc::now().to_rfc3339(),
            project: workspace_project_from_local(&local, false),
            tasks,
            deleted: false,
        }
    };

    let outcome = apply_catalog(storage, &mut catalog)?;
    if outcome.archived {
        return Ok((false, false, 0));
    }

    // 冲突检测：远端已被其他设备修改。
    let mut etag_map = read_etag_map(storage)?;
    if let Some(saved) = etag_map.get(ws_id) {
        if remote_etag.as_deref().is_some_and(|remote| saved != remote) {
            return Err("远端项目已被其他设备更新，请先同步".to_string());
        }
    }

    let uploaded = if outcome.catalog_changed {
        catalog.revision += 1;
        catalog.updated_at = chrono::Utc::now().to_rfc3339();
        let uploaded_etag = store
            .put(
                &object_key,
                encrypt_catalog(&catalog, &key)?,
                remote_etag.as_deref(),
            )
            .await?
            .or(store.head_etag(&object_key).await?);
        if let Some(etag) = uploaded_etag {
            etag_map.insert(ws_id.to_string(), etag);
            save_etag_map(storage, &etag_map)?;
        }
        true
    } else {
        if let Some(etag) = remote_etag {
            etag_map.insert(ws_id.to_string(), etag);
            save_etag_map(storage, &etag_map)?;
        }
        false
    };

    Ok((uploaded, outcome.created_project, outcome.created_tasks))
}

/// 全量同步：遍历本地所有未归档项目，逐个拉取合并或首次推送。
pub async fn sync_all(
    storage: Storage,
    trigger_source: &str,
) -> Result<ProjectWorkspaceSyncResult, String> {
    if !is_enabled(&storage) {
        return Err("尚未启用项目工作区同步，请先在设置页启用渠道账号工作区".to_string());
    }
    let _guard = PROJECT_WORKSPACE_SYNC_GUARD.lock().await;
    let job_id = uuid::Uuid::new_v4().to_string();
    let projects = storage
        .list_projects_for_workspace()
        .map_err(|error| error.to_string())?;
    storage
        .create_job(
            &job_id,
            PROJECT_WORKSPACE_JOB_TYPE,
            "项目工作区同步",
            "正在同步项目与任务",
            trigger_source,
            projects.len().max(1),
            &format!("开始同步项目工作区，共 {} 个项目", projects.len()),
        )
        .map_err(|error| error.to_string())?;

    let mut result = ProjectWorkspaceSyncResult {
        synced_projects: 0,
        created_local_projects: 0,
        archived_projects: 0,
        task_count: 0,
        uploaded_objects: 0,
    };
    let total_projects = projects.len();
    let mut progress = 0usize;
    for project in projects {
        let ws_id = match project.workspace_project_id.as_deref() {
            Some(ws_id) => ws_id.to_string(),
            None => {
                // 首次同步：分配工作区 id（复用本机项目 id），推送到远端。
                let assigned = project.id.clone();
                storage
                    .save_project(&Project {
                        workspace_project_id: Some(assigned.clone()),
                        ..project.clone()
                    })
                    .map_err(|error| error.to_string())?;
                assigned
            }
        };
        match sync_project_inner(&storage, &ws_id).await {
            Ok((uploaded, created_project, created_tasks)) => {
                result.synced_projects += 1;
                result.uploaded_objects += usize::from(uploaded);
                result.created_local_projects += usize::from(created_project);
                result.task_count += created_tasks;
                let _ = storage.add_job_event(
                    &job_id,
                    "info",
                    "项目",
                    &format!("同步项目「{}」完成", project.name),
                );
            }
            Err(error) => {
                let _ = storage.add_job_event(
                    &job_id,
                    "warning",
                    "项目",
                    &format!("同步项目「{}」失败：{error}", project.name),
                );
            }
        }
        progress += 1;
        let _ = storage.update_job_progress(&job_id, progress as i64, total_projects as i64);
    }
    let summary = serde_json::json!({
        "syncedProjects": result.synced_projects,
        "createdLocalProjects": result.created_local_projects,
        "taskCount": result.task_count,
        "uploadedObjects": result.uploaded_objects,
    })
    .to_string();
    let _ = storage.finish_job(
        &job_id,
        "succeeded",
        &summary,
        &format!(
            "项目工作区同步完成：{} 个项目，上传 {} 个，新建本机项目 {} 个",
            result.synced_projects, result.uploaded_objects, result.created_local_projects
        ),
    );
    Ok(result)
}

/// 推送单个本机项目的最新状态到工作区（任务提交 / 编辑 / 审核后即时调用）。
/// 与 `sync_project_inner` 方向相反：以本机为准合并后上传，冲突时拒绝并提示先同步。
pub async fn push_project(storage: Storage, project_id: &str) -> Result<bool, String> {
    let project = storage
        .get_project(project_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "项目不存在".to_string())?;
    let ws_id = match project.workspace_project_id.clone() {
        Some(ws_id) => ws_id,
        None => {
            // 首次推送：分配工作区 id。
            let assigned = project.id.clone();
            storage
                .save_project(&Project {
                    workspace_project_id: Some(assigned.clone()),
                    ..project.clone()
                })
                .map_err(|error| error.to_string())?;
            assigned
        }
    };

    let _guard = PROJECT_WORKSPACE_SYNC_GUARD.lock().await;
    let config = match load_config(&storage) {
        Ok(Some(config)) => config,
        _ => return Ok(false), // 未配置工作区：静默跳过。
    };
    let key = match account_workspace_sync::read_workspace_key(&config) {
        Ok(key) => key,
        Err(_) => return Ok(false), // 未启用工作区：静默跳过。
    };
    let secret = read_secret(&config)?;
    let store = S3Store::new(&config, &secret)?;
    let object_key = workspace_project_key(&config, &ws_id);
    let remote_etag = store.head_etag(&object_key).await?;

    let mut catalog = if remote_etag.is_some() {
        let bytes = store.get(&object_key).await?;
        decrypt_catalog(&bytes, &key)?
    } else {
        // 远端对象缺失：首次推送，从本机初始化。
        let mut tasks = storage
            .list_project_tasks_including_deleted(&project.id)
            .map_err(|error| error.to_string())?
            .into_iter()
            .map(|task| workspace_task_from_local(&task))
            .collect::<Vec<_>>();
        tasks.sort_by(|left, right| left.created_at.cmp(&right.created_at));
        ProjectWorkspaceCatalog {
            version: CATALOG_VERSION,
            revision: 0,
            updated_at: chrono::Utc::now().to_rfc3339(),
            project: workspace_project_from_local(&project, false),
            tasks,
            deleted: false,
        }
    };

    // 远端已是墓碑：本机项目被其他设备删除，回放墓碑到本地。
    if catalog.deleted || catalog.project.archived {
        let _ = storage
            .delete_project_by_workspace_id(&ws_id)
            .map_err(|error| error.to_string())?;
        return Ok(false);
    }

    // 冲突检测。
    let mut etag_map = read_etag_map(&storage)?;
    if let Some(saved) = etag_map.get(&ws_id) {
        if remote_etag.as_deref().is_some_and(|remote| saved != remote) {
            return Err("远端项目已被其他设备更新，请先同步后再保存".to_string());
        }
    }

    // 以本机为准合并（只会上传本机较新的任务 / 新增任务 / 项目名更新）。
    let mut catalog_changed = false;
    let local_tasks = storage
        .list_project_tasks_including_deleted(&project.id)
        .map_err(|error| error.to_string())?;
    let mut local_by_id = local_tasks
        .into_iter()
        .map(|task| (task.id.clone(), task))
        .collect::<HashMap<_, _>>();
    for workspace_task in &mut catalog.tasks {
        if let Some(local_task) = local_by_id.remove(&workspace_task.id) {
            if local_task.updated_at > workspace_task.updated_at {
                *workspace_task = workspace_task_from_local(&local_task);
                catalog_changed = true;
            }
        }
    }
    for task in local_by_id.into_values() {
        catalog.tasks.push(workspace_task_from_local(&task));
        catalog_changed = true;
    }
    if project.updated_at > catalog.project.updated_at {
        catalog.project.name = project.name.clone();
        catalog.project.updated_at = project.updated_at.clone();
        catalog_changed = true;
    }

    let uploaded = if catalog_changed {
        catalog.revision += 1;
        catalog.updated_at = chrono::Utc::now().to_rfc3339();
        let uploaded_etag = store
            .put(
                &object_key,
                encrypt_catalog(&catalog, &key)?,
                remote_etag.as_deref(),
            )
            .await?
            .or(store.head_etag(&object_key).await?);
        if let Some(etag) = uploaded_etag {
            etag_map.insert(ws_id.clone(), etag);
            save_etag_map(&storage, &etag_map)?;
        }
        true
    } else {
        if let Some(etag) = remote_etag {
            etag_map.insert(ws_id.clone(), etag);
            save_etag_map(&storage, &etag_map)?;
        }
        false
    };
    Ok(uploaded)
}

/// 项目发生变更后异步通知：立即推送该项目到工作区。
/// 命令层调用，不阻塞保存流程；工作区未启用时静默跳过。
pub fn notify_project_changed(
    storage: Storage,
    project_id: &str,
) -> tauri::async_runtime::JoinHandle<()> {
    let storage = storage.clone();
    let project_id = project_id.to_string();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = push_project(storage, &project_id).await {
            tracing::warn!(project_id = %project_id, %error, "推送项目工作区失败");
        }
    })
}

/// 项目删除时写入墓碑：把远端工作区对象标记为已删除，其他设备同步后删除本地项目。
/// 本机项目已删除后无法再读取工作区 id，因此调用方必须先取到 id 再删除本地。
pub async fn push_tombstone(storage: Storage, ws_id: &str) -> Result<bool, String> {
    let _guard = PROJECT_WORKSPACE_SYNC_GUARD.lock().await;
    let config = match load_config(&storage) {
        Ok(Some(config)) => config,
        _ => return Ok(false),
    };
    let key = match account_workspace_sync::read_workspace_key(&config) {
        Ok(key) => key,
        Err(_) => return Ok(false),
    };
    let secret = read_secret(&config)?;
    let store = S3Store::new(&config, &secret)?;
    let object_key = workspace_project_key(&config, ws_id);
    let remote_etag = store.head_etag(&object_key).await?;
    if remote_etag.is_none() {
        return Ok(false); // 远端不存在：无需墓碑。
    }
    let bytes = store.get(&object_key).await?;
    let mut catalog = decrypt_catalog(&bytes, &key)?;
    if catalog.deleted || catalog.project.archived {
        return Ok(false); // 已是墓碑。
    }
    catalog.deleted = true;
    catalog.revision += 1;
    catalog.updated_at = chrono::Utc::now().to_rfc3339();
    let uploaded_etag = store
        .put(
            &object_key,
            encrypt_catalog(&catalog, &key)?,
            remote_etag.as_deref(),
        )
        .await?
        .or(store.head_etag(&object_key).await?);
    let mut etag_map = read_etag_map(&storage)?;
    if let Some(etag) = uploaded_etag {
        etag_map.insert(ws_id.to_string(), etag);
        save_etag_map(&storage, &etag_map)?;
    }
    Ok(true)
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::storage::Storage;
    use rusqlite::Connection;

    fn test_storage() -> Storage {
        let storage = Storage::from_connection_for_test(Connection::open_in_memory().unwrap());
        storage.migrate().unwrap();
        storage
    }

    fn local_project(id: &str, ws_id: Option<&str>) -> Project {
        Project {
            id: id.to_string(),
            name: format!("项目-{id}"),
            directory_path: Some(format!("D:\\work\\{id}")),
            workspace_project_id: ws_id.map(str::to_string),
            workspace_archived: false,
            created_at: "2026-08-03T00:00:00Z".to_string(),
            updated_at: "2026-08-03T00:00:00Z".to_string(),
        }
    }

    fn local_task(project_id: &str, id: &str, status: &str) -> ProjectTask {
        ProjectTask {
            id: id.to_string(),
            project_id: project_id.to_string(),
            title: format!("任务-{id}"),
            description: String::new(),
            status: status.to_string(),
            task_type: "code".to_string(),
            agent_profile: "Claude Code".to_string(),
            priority: "p1".to_string(),
            base_task_id: None,
            last_job_id: None,
            rejection_reason: None,
            execution_history: None,
            created_at: "2026-08-03T00:00:00Z".to_string(),
            updated_at: "2026-08-03T00:00:00Z".to_string(),
            claimed_by: None,
            claimed_at: None,
            queue_boosted_at: None,
            deleted: false,
        }
    }

    #[test]
    fn encrypted_catalog_round_trips_and_rejects_wrong_key() {
        let key = [7_u8; 32];
        let catalog = ProjectWorkspaceCatalog {
            version: CATALOG_VERSION,
            revision: 3,
            updated_at: "2026-08-03T00:00:00Z".to_string(),
            project: WorkspaceProject {
                id: "ws-1".to_string(),
                name: "Flowlet".to_string(),
                archived: false,
                created_at: "2026-08-03T00:00:00Z".to_string(),
                updated_at: "2026-08-03T00:00:00Z".to_string(),
            },
            tasks: vec![WorkspaceTask {
                id: "task-1".to_string(),
                title: "修复登录".to_string(),
                description: String::new(),
                status: "submitted".to_string(),
                task_type: "code".to_string(),
                agent_profile: "Claude Code".to_string(),
                priority: "p1".to_string(),
                base_task_id: None,
                rejection_reason: None,
                execution_history: None,
                created_at: "2026-08-03T00:00:00Z".to_string(),
                updated_at: "2026-08-03T00:00:00Z".to_string(),
                deleted: false,
            }],
            deleted: false,
        };
        let encrypted = encrypt_catalog(&catalog, &key).unwrap();
        assert_eq!(decrypt_catalog(&encrypted, &key).unwrap(), catalog);
        assert!(decrypt_catalog(&encrypted, &[8_u8; 32]).is_err());
        assert!(!String::from_utf8_lossy(&encrypted).contains("修复登录"));
    }

    #[test]
    fn remote_project_is_created_locally_without_directory() {
        let storage = test_storage();
        let mut catalog = ProjectWorkspaceCatalog {
            version: CATALOG_VERSION,
            revision: 2,
            updated_at: "2026-08-04T00:00:00Z".to_string(),
            project: WorkspaceProject {
                id: "ws-remote".to_string(),
                name: "远端项目".to_string(),
                archived: false,
                created_at: "2026-08-03T00:00:00Z".to_string(),
                updated_at: "2026-08-04T00:00:00Z".to_string(),
            },
            tasks: vec![WorkspaceTask {
                id: "task-r".to_string(),
                title: "远程任务".to_string(),
                description: "desc".to_string(),
                status: "submitted".to_string(),
                task_type: "readonly".to_string(),
                agent_profile: "Claude Code".to_string(),
                priority: "p0".to_string(),
                base_task_id: None,
                rejection_reason: None,
                execution_history: None,
                created_at: "2026-08-03T00:00:00Z".to_string(),
                updated_at: "2026-08-03T00:00:00Z".to_string(),
                deleted: false,
            }],
            deleted: false,
        };
        let outcome = apply_catalog(&storage, &mut catalog).unwrap();
        assert!(outcome.created_project);
        assert_eq!(outcome.created_tasks, 1);
        let local = storage
            .get_project_by_workspace_id("ws-remote")
            .unwrap()
            .unwrap();
        assert_eq!(local.name, "远端项目");
        assert!(local.directory_path.is_none());
        let tasks = storage.list_project_tasks(&local.id).unwrap();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].title, "远程任务");
        // 只读分析任务跨设备同步后保留 submitted 排队。
        assert_eq!(tasks[0].status, "submitted");
        // 未发生回写（本机无更新），不应上传。
        assert!(!outcome.catalog_changed);
    }

    #[test]
    fn local_newer_task_wins_and_marks_catalog_changed() {
        let storage = test_storage();
        storage
            .save_project(&local_project("project-1", Some("ws-1")))
            .unwrap();
        // 本地任务比远端新。
        let mut task = local_task("project-1", "task-1", "draft");
        task.updated_at = "2026-08-05T00:00:00Z".to_string();
        task.title = "本机最新标题".to_string();
        storage.save_project_task(&task).unwrap();

        let mut catalog = ProjectWorkspaceCatalog {
            version: CATALOG_VERSION,
            revision: 1,
            updated_at: "2026-08-04T00:00:00Z".to_string(),
            project: WorkspaceProject {
                id: "ws-1".to_string(),
                name: "项目-project-1".to_string(),
                archived: false,
                created_at: "2026-08-03T00:00:00Z".to_string(),
                updated_at: "2026-08-03T00:00:00Z".to_string(),
            },
            tasks: vec![WorkspaceTask {
                id: "task-1".to_string(),
                title: "旧标题".to_string(),
                description: String::new(),
                status: "draft".to_string(),
                task_type: "code".to_string(),
                agent_profile: "Claude Code".to_string(),
                priority: "p1".to_string(),
                base_task_id: None,
                rejection_reason: None,
                execution_history: None,
                created_at: "2026-08-03T00:00:00Z".to_string(),
                updated_at: "2026-08-04T00:00:00Z".to_string(),
                deleted: false,
            }],
            deleted: false,
        };
        let outcome = apply_catalog(&storage, &mut catalog).unwrap();
        // 本地较新 → catalog 被回写，需要上传。
        assert!(outcome.catalog_changed);
        assert_eq!(catalog.tasks[0].title, "本机最新标题");
        // 本地任务未被覆盖。
        let tasks = storage.list_project_tasks("project-1").unwrap();
        assert_eq!(tasks[0].title, "本机最新标题");
    }

    #[test]
    fn remote_newer_task_overwrites_local_content_but_keeps_claim() {
        let storage = test_storage();
        storage
            .save_project(&local_project("project-1", Some("ws-1")))
            .unwrap();
        let mut task = local_task("project-1", "task-1", "draft");
        task.updated_at = "2026-08-03T00:00:00Z".to_string();
        task.claimed_by = Some("device-b".into());
        task.claimed_at = Some("2026-08-04T00:00:00Z".to_string());
        storage.save_project_task(&task).unwrap();

        let mut catalog = ProjectWorkspaceCatalog {
            version: CATALOG_VERSION,
            revision: 1,
            updated_at: "2026-08-04T00:00:00Z".to_string(),
            project: WorkspaceProject {
                id: "ws-1".to_string(),
                name: "项目-project-1".to_string(),
                archived: false,
                created_at: "2026-08-03T00:00:00Z".to_string(),
                updated_at: "2026-08-03T00:00:00Z".to_string(),
            },
            tasks: vec![WorkspaceTask {
                id: "task-1".to_string(),
                title: "远端新标题".to_string(),
                description: "远端描述".to_string(),
                status: "draft".to_string(),
                task_type: "code".to_string(),
                agent_profile: "Claude Code".to_string(),
                priority: "p1".to_string(),
                base_task_id: None,
                rejection_reason: None,
                execution_history: None,
                created_at: "2026-08-03T00:00:00Z".to_string(),
                updated_at: "2026-08-05T00:00:00Z".to_string(),
                deleted: false,
            }],
            deleted: false,
        };
        let outcome = apply_catalog(&storage, &mut catalog).unwrap();
        assert!(!outcome.catalog_changed);
        let tasks = storage.list_project_tasks("project-1").unwrap();
        assert_eq!(tasks[0].title, "远端新标题");
        // 领取归属是设备本地字段，不被远端覆盖。
        assert_eq!(tasks[0].claimed_by.as_deref(), Some("device-b"));
    }

    #[test]
    fn deleted_task_propagates_both_ways() {
        let storage = test_storage();
        storage
            .save_project(&local_project("project-1", Some("ws-1")))
            .unwrap();
        // 本地任务已软删除。
        let mut task = local_task("project-1", "task-1", "draft");
        task.deleted = true;
        task.updated_at = "2026-08-05T00:00:00Z".to_string();
        storage.save_project_task(&task).unwrap();

        // 远端 catalog 里该任务未被删除。
        let mut catalog = ProjectWorkspaceCatalog {
            version: CATALOG_VERSION,
            revision: 1,
            updated_at: "2026-08-04T00:00:00Z".to_string(),
            project: WorkspaceProject {
                id: "ws-1".to_string(),
                name: "项目-project-1".to_string(),
                archived: false,
                created_at: "2026-08-03T00:00:00Z".to_string(),
                updated_at: "2026-08-03T00:00:00Z".to_string(),
            },
            tasks: vec![WorkspaceTask {
                id: "task-1".to_string(),
                title: "任务".to_string(),
                description: String::new(),
                status: "draft".to_string(),
                task_type: "code".to_string(),
                agent_profile: "Claude Code".to_string(),
                priority: "p1".to_string(),
                base_task_id: None,
                rejection_reason: None,
                execution_history: None,
                created_at: "2026-08-03T00:00:00Z".to_string(),
                updated_at: "2026-08-04T00:00:00Z".to_string(),
                deleted: false,
            }],
            deleted: false,
        };
        let outcome = apply_catalog(&storage, &mut catalog).unwrap();
        // 删除优先：本地删除被传播为墓碑。
        assert!(outcome.catalog_changed);
        assert!(catalog.tasks[0].deleted);
        // 反向：远端标记删除 → 本地隐藏。
        let storage2 = test_storage();
        storage2
            .save_project(&local_project("project-1", Some("ws-1")))
            .unwrap();
        storage2
            .save_project_task(&local_task("project-1", "task-1", "draft"))
            .unwrap();
        let mut tombstone = ProjectWorkspaceCatalog {
            version: CATALOG_VERSION,
            revision: 2,
            updated_at: "2026-08-06T00:00:00Z".to_string(),
            project: WorkspaceProject {
                id: "ws-1".to_string(),
                name: "项目-project-1".to_string(),
                archived: false,
                created_at: "2026-08-03T00:00:00Z".to_string(),
                updated_at: "2026-08-03T00:00:00Z".to_string(),
            },
            tasks: vec![WorkspaceTask {
                id: "task-1".to_string(),
                title: "任务".to_string(),
                description: String::new(),
                status: "draft".to_string(),
                task_type: "code".to_string(),
                agent_profile: "Claude Code".to_string(),
                priority: "p1".to_string(),
                base_task_id: None,
                rejection_reason: None,
                execution_history: None,
                created_at: "2026-08-03T00:00:00Z".to_string(),
                updated_at: "2026-08-06T00:00:00Z".to_string(),
                deleted: true,
            }],
            deleted: false,
        };
        let outcome2 = apply_catalog(&storage2, &mut tombstone).unwrap();
        assert!(!outcome2.catalog_changed);
        assert!(storage2.list_project_tasks("project-1").unwrap().is_empty());
    }

    #[test]
    fn project_tombstone_deletes_local_project() {
        let storage = test_storage();
        storage
            .save_project(&local_project("project-1", Some("ws-1")))
            .unwrap();
        storage
            .save_project_task(&local_task("project-1", "task-1", "submitted"))
            .unwrap();

        let mut tombstone = ProjectWorkspaceCatalog {
            version: CATALOG_VERSION,
            revision: 3,
            updated_at: "2026-08-06T00:00:00Z".to_string(),
            project: WorkspaceProject {
                id: "ws-1".to_string(),
                name: "项目-project-1".to_string(),
                archived: true,
                created_at: "2026-08-03T00:00:00Z".to_string(),
                updated_at: "2026-08-06T00:00:00Z".to_string(),
            },
            tasks: Vec::new(),
            deleted: false,
        };
        let outcome = apply_catalog(&storage, &mut tombstone).unwrap();
        assert!(outcome.archived);
        assert!(storage.get_project("project-1").unwrap().is_none());
        assert!(storage.list_project_tasks("project-1").unwrap().is_empty());
    }
}
