//! Agent 任务执行核心：按任务 `agent_profile` 分派到注册的 Runner Adapter。
//! CLI 在项目目录内执行项目任务。
//!
//! 按项目隔离的执行槽：每个项目同一时刻至多一个任务在执行，其余在该项目内排队；
//! 不同项目互不影响，可并行执行。并发安全由 Rust 端按项目作用域保证。
//! 各 Runner Adapter 以非交互模式执行，并自行声明所需 Surface、resume 能力、
//! 缺少执行入口时的提示与具体执行函数。
//! 执行过程中的模型请求会经过 Flowlet 本地代理，自动进入请求日志与用量账本。
//! Agent 退出后由 Rust 自动把任务状态回写 `review`（等待人工审核）。

use crate::core::agent_environment::{AgentInstallation, AgentSurface};
use crate::core::job_runtime::{JobLease, JobRuntime, PROJECT_TASK_RUN, RECURRING_TASK_RUN};
use crate::core::storage::{ProjectTask, Storage};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

pub(crate) mod adapters;
mod process;

use process::{
    finish_agent_outcome, read_agent_output, record_started_execution, spawn_agent,
    AgentProcessOutcome,
};
#[cfg(desktop)]
use tauri::{AppHandle, Manager};

/// 任务执行完成进入待审核时是否发送系统通知的全局设置键（app_meta）。默认开启。
pub(crate) const TASK_REVIEW_NOTIFICATION_KEY: &str = "task_review_notification_enabled";

/// 按项目隔离的执行槽：key = project_id，value = 该项目正在执行的任务信息。
/// 每个项目同一时刻至多一个任务在执行，不同项目可并行执行。
pub(crate) static AGENT_TASK_RUNNING: OnceLock<Mutex<HashMap<String, RunningTaskInfo>>> =
    OnceLock::new();

/// 获取按项目隔离的执行槽（首次访问时初始化）。
fn agent_task_running() -> &'static Mutex<HashMap<String, RunningTaskInfo>> {
    AGENT_TASK_RUNNING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 取消请求轮询间隔。
const CANCEL_POLL_INTERVAL: Duration = Duration::from_millis(300);

/// 累积到多少文本就落一条任务日志事件（避免事件爆炸）。
const TEXT_FLUSH_THRESHOLD: usize = 400;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunningTaskInfo {
    pub project_id: String,
    pub task_id: String,
    pub task_title: String,
    pub agent_profile: String,
    pub job_id: String,
    pub started_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectTaskRunnerState {
    /// 是否有任意项目的任务在执行（调度器按项目粒度判断，不再依赖该字段阻塞全局）。
    pub running: bool,
    /// 当前正在执行的任务列表（按项目隔离：每个项目至多一个，不同项目可并行）。
    pub current: Vec<RunningTaskInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunProjectTaskResult {
    pub started: bool,
    pub job_id: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectTaskQueueBlocker {
    pub task_id: String,
    pub code: &'static str,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectTaskQueueReport {
    pub tasks: Vec<ProjectTask>,
    pub blockers: Vec<ProjectTaskQueueBlocker>,
}

/// 执行结束的汇总信息，用于 finish_job。
struct ExecutionOutcome {
    job_status: &'static str,
    summary_json: String,
    done_message: String,
}

/// 按项目粒度的执行槽守卫：持有期间占用该项目的槽位，Drop 时释放。
/// 领取即占位（在运行集合中插入占位信息），执行失败提前返回时随函数结束释放。
struct AgentTaskRunningGuard {
    project_id: String,
    _lease: JobLease,
}

impl Drop for AgentTaskRunningGuard {
    fn drop(&mut self) {
        if let Ok(mut running) = agent_task_running().lock() {
            running.remove(&self.project_id);
        }
    }
}

/// 查询执行槽状态：是否有任务在跑、每个项目当前在跑的任务列表。
pub(crate) fn task_runner_state() -> ProjectTaskRunnerState {
    let current = agent_task_running()
        .lock()
        .ok()
        .map(|running| running.values().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    ProjectTaskRunnerState {
        running: !current.is_empty(),
        current,
    }
}

/// 尝试领取并执行一个项目任务。
///
/// 返回 `started: true` 表示抢到该项目隔离的执行槽并已开始执行；`started: false`
/// 表示该项目槽被占用（同项目已有任务在跑）或任务状态不允许，调用方应下个周期重试。
/// 不同项目的任务互不阻塞，可并行执行。
///
/// 领取成功后**立即返回**，Agent 执行放到后台任务：只有这样才能让调用方
/// （提交后立即执行 / 前端调度器）第一时间拿到 `started` 结果并刷新看板，
/// 而不是等整个 Agent 执行过程结束才返回（那样前端一直拿不到结果）。
#[cfg(desktop)]
pub(crate) async fn run_project_task(
    app: AppHandle,
    storage: Storage,
    jobs: JobRuntime,
    project_id: String,
    task_id: String,
    current_device_id: String,
) -> Result<RunProjectTaskResult, String> {
    // 1. 抢「按项目隔离」的执行槽：
    //    同一项目至多一个任务在跑，不同项目互不影响。领取即占位，执行失败提前返回时
    //    随函数结束 drop 释放；成功则随后台执行任务 move，Agent 结束后释放。
    let scope_key = format!("{}:{project_id}", PROJECT_TASK_RUN.scope_key);
    let lease = match jobs.try_acquire_in_scope(&PROJECT_TASK_RUN, scope_key) {
        Ok(lease) => lease,
        Err(_) => {
            return Ok(RunProjectTaskResult {
                started: false,
                job_id: None,
                message: "该项目已有任务在执行中，任务已进入队列等待".to_string(),
            });
        }
    };
    {
        let mut running = agent_task_running()
            .lock()
            .map_err(|_| "读取执行槽状态失败".to_string())?;
        if running.contains_key(&project_id) {
            return Ok(RunProjectTaskResult {
                started: false,
                job_id: None,
                message: "该项目已有任务在执行中，任务已进入队列等待".to_string(),
            });
        }
        // 占位：完整运行信息在任务进入执行中（步骤 6）写入，防止同项目并发领取竞态。
        running.insert(
            project_id.clone(),
            RunningTaskInfo {
                project_id: project_id.clone(),
                task_id: String::new(),
                task_title: String::new(),
                agent_profile: String::new(),
                job_id: String::new(),
                started_at: String::new(),
            },
        );
    }
    let guard = AgentTaskRunningGuard {
        project_id: project_id.clone(),
        _lease: lease,
    };

    // 2. 读取任务并校验：调度器只领取「已提交」状态的任务。
    let task = storage
        .get_project_task(&project_id, &task_id)
        .map_err(|error| format!("读取任务失败：{error}"))?
        .ok_or_else(|| "任务不存在".to_string())?;
    if task.status != "submitted" {
        return Ok(RunProjectTaskResult {
            started: false,
            job_id: None,
            message: "任务不是已提交状态，无法执行".to_string(),
        });
    }

    // 在领取任务、更新状态和创建后台 job 之前完成确定性的本机环境校验。
    // 目录失效时直接向调用方返回可处理错误，避免任务在 submitted / in_progress
    // 之间反复切换并持续制造失败 job。
    required_project_dir(&storage, &project_id)?;

    // Agent 探测同样不应改变任务归属或状态。执行前仍会在真正创建子进程时再次校验 cwd。
    let executable = resolve_agent_executable(&task.agent_profile).await?;

    // 2.5. 跨设备领取：把任务归属标记为本机（永久归属）。任务被其他设备执行过或
    //      正在执行时拒绝，防止多台设备对同一任务重复执行。
    if !storage
        .claim_task(&task_id, &current_device_id)
        .map_err(|error| format!("标记任务领取失败：{error}"))?
    {
        return Ok(RunProjectTaskResult {
            started: false,
            job_id: None,
            message: "该任务已由其他设备执行，本机只读，请在执行设备上操作".to_string(),
        });
    }

    // 4. 创建后台任务日志，任务日志页可见（job_type=project-task-run）。
    let job_id = uuid::Uuid::new_v4().to_string();
    storage
        .create_job(
            &job_id,
            PROJECT_TASK_RUN.job_type,
            &format!("任务执行：{}", task.title),
            "正在启动",
            "manual",
            1,
            &format!("开始执行任务「{}」", task.title),
        )
        .map_err(|error| format!("创建任务日志失败：{error}"))?;
    guard._lease.attach_job_id(job_id.clone());

    // 5. 任务进入执行中（与执行同生命周期，避免前端重复标记的竞态）。
    storage
        .set_task_status(&task_id, "in_progress")
        .map_err(|error| format!("标记任务执行中失败：{error}"))?;
    // 6. 记录当前运行信息供前端查询（覆盖步骤 1 的占位；锁失败只跳过展示，不影响执行）。
    if let Ok(mut running) = agent_task_running().lock() {
        running.insert(
            project_id.clone(),
            RunningTaskInfo {
                project_id: project_id.clone(),
                task_id: task_id.clone(),
                task_title: task.title.clone(),
                agent_profile: task.agent_profile.clone(),
                job_id: job_id.clone(),
                started_at: chrono::Utc::now().to_rfc3339(),
            },
        );
    }

    // 7. 组装 prompt 并启动 Claude Code。
    //    退回重跑会复用上次会话（--resume）+ 注入退回原因，让 Agent 带着上下文修正；
    //    基于已完成任务创建时，首次执行复用基础任务的会话，让新任务延续上个任务的上下文。
    let base_task = match task.base_task_id.as_deref() {
        Some(base_id) => storage
            .get_project_task(&project_id, base_id)
            .map_err(|error| format!("读取基础任务失败：{error}"))?,
        None => None,
    };
    let resume_session = resolve_resume_session(&storage, &task, base_task.as_ref())?;
    let rejection_reason = task.rejection_reason.as_deref();
    let prompt = build_task_prompt(&task, rejection_reason, base_task.as_ref());
    // 原因已注入 prompt，清空避免下次执行重复注入（留档靠 job event）。
    if rejection_reason.is_some_and(|reason| !reason.trim().is_empty()) {
        let _ = storage.set_task_rejection_reason(&task.id, None);
    }

    // 8. 后台执行：Agent 执行放到后台任务，command 立即返回领取结果。
    //    执行槽由 guard 在后台任务中持有，Agent 结束后释放，调度器下个周期才能领取下一个。
    //    Agent 结果（成功/失败/取消）在后台任务内处理，不再向上层传播。
    //    job_id 需要在返回结果里使用，克隆一份给后台任务。
    let spawned_job_id = job_id.clone();
    let notify_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _guard = guard;
        let result = execute_agent(
            &storage,
            &executable,
            &task,
            &project_id,
            &spawned_job_id,
            &prompt,
            resume_session.as_deref(),
            true,
        )
        .await;
        match result {
            Ok(outcome) => {
                let _ = storage.finish_job(
                    &spawned_job_id,
                    outcome.job_status,
                    &outcome.summary_json,
                    &outcome.done_message,
                );
                // Agent 执行结束（成功或失败）后任务进入待审核，此时发系统通知提醒审核；
                // 取消路径会回到草稿，不进入待审核，不通知。用户可在全局设置关闭该通知。
                // 通知携带项目与任务上下文，点击通知会打开独立窗口并激活该任务概览抽屉。
                if outcome.job_status != "cancelled" {
                    notify_task_review(&notify_app, &storage, &task);
                }
            }
            Err(error) => {
                // 进程层异常：任务回退到已提交状态，下个周期重新排队。
                let _ = storage.set_task_status(&task_id, "submitted");
                let _ = storage.fail_job(&spawned_job_id, &error);
            }
        }
        // 无论成功 / 失败 / 取消 / 进程异常，本轮执行都已结束，
        // 统一写入结束时间供看板卡片累计执行时间。
        let _ = storage.finish_task_execution(&task_id, &spawned_job_id);
    });

    Ok(RunProjectTaskResult {
        started: true,
        job_id: Some(job_id),
        message: "任务已开始执行".to_string(),
    })
}

#[cfg(desktop)]
pub(crate) async fn run_recurring_task_run(
    storage: Storage,
    jobs: JobRuntime,
    run_id: String,
) -> Result<RunProjectTaskResult, String> {
    let run = storage
        .get_recurring_task_run(&run_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "重复任务运行不存在".to_string())?;
    if !matches!(run.status.as_str(), "queued" | "interrupted") {
        return Ok(RunProjectTaskResult {
            started: false,
            job_id: run.job_id,
            message: "该运行不是待执行状态".to_string(),
        });
    }
    let scope_key = format!("{}:{}", RECURRING_TASK_RUN.scope_key, run.project_id);
    let lease = match jobs.try_acquire_in_scope(&RECURRING_TASK_RUN, scope_key) {
        Ok(lease) => lease,
        Err(_) => {
            return Ok(RunProjectTaskResult {
                started: false,
                job_id: None,
                message: "该项目已有任务执行中，重复任务运行已排队".to_string(),
            });
        }
    };
    {
        let mut running = agent_task_running()
            .lock()
            .map_err(|_| "读取执行槽状态失败".to_string())?;
        if running.contains_key(&run.project_id) {
            return Ok(RunProjectTaskResult {
                started: false,
                job_id: None,
                message: "该项目已有任务执行中，重复任务运行已排队".to_string(),
            });
        }
        running.insert(
            run.project_id.clone(),
            RunningTaskInfo {
                project_id: run.project_id.clone(),
                task_id: run.id.clone(),
                task_title: run.title_snapshot.clone(),
                agent_profile: run.agent_profile_snapshot.clone(),
                job_id: String::new(),
                started_at: String::new(),
            },
        );
    }
    let guard = AgentTaskRunningGuard {
        project_id: run.project_id.clone(),
        _lease: lease,
    };
    required_project_dir(&storage, &run.project_id)?;
    let task = ProjectTask {
        id: run.id.clone(),
        project_id: run.project_id.clone(),
        title: run.title_snapshot.clone(),
        description: run.description_snapshot.clone(),
        status: "in_progress".to_string(),
        task_type: run.task_type_snapshot.clone(),
        agent_profile: run.agent_profile_snapshot.clone(),
        priority: "p2".to_string(),
        base_task_id: None,
        last_job_id: run.job_id.clone(),
        rejection_reason: None,
        execution_history: None,
        created_at: run.created_at.clone(),
        updated_at: run.updated_at.clone(),
        claimed_by: None,
        claimed_at: None,
        queue_boosted_at: None,
        deleted: false,
    };
    let executable = resolve_agent_executable(&task.agent_profile).await?;
    let job_id = uuid::Uuid::new_v4().to_string();
    storage
        .create_job(
            &job_id,
            RECURRING_TASK_RUN.job_type,
            &format!("重复任务：{}", task.title),
            "正在启动",
            &run.trigger_source,
            1,
            &format!("开始运行「{}」", task.title),
        )
        .map_err(|error| error.to_string())?;
    guard._lease.attach_job_id(job_id.clone());
    if !storage
        .start_recurring_run(&run.id, &job_id)
        .map_err(|error| error.to_string())?
    {
        return Err("重复任务运行已被其他调度器领取".to_string());
    }
    if let Ok(mut running) = agent_task_running().lock() {
        running.insert(
            run.project_id.clone(),
            RunningTaskInfo {
                project_id: run.project_id.clone(),
                task_id: run.id.clone(),
                task_title: task.title.clone(),
                agent_profile: task.agent_profile.clone(),
                job_id: job_id.clone(),
                started_at: chrono::Utc::now().to_rfc3339(),
            },
        );
    }
    let resume_session = if run.status == "interrupted" {
        session_from_job(&storage, run.job_id.as_deref())?
    } else if run.session_policy_snapshot == "continue" {
        storage
            .latest_recurring_task_session(&run.recurring_task_id, &run.id)
            .map_err(|error| error.to_string())?
    } else {
        None
    };
    let prompt = build_task_prompt(&task, None, None);
    let spawned_job_id = job_id.clone();
    tauri::async_runtime::spawn(async move {
        let _guard = guard;
        match execute_agent(
            &storage,
            &executable,
            &task,
            &task.project_id,
            &spawned_job_id,
            &prompt,
            resume_session.as_deref(),
            false,
        )
        .await
        {
            Ok(outcome) => {
                let session_id = serde_json::from_str::<serde_json::Value>(&outcome.summary_json)
                    .ok()
                    .and_then(|value| {
                        value
                            .get("sessionId")
                            .and_then(|value| value.as_str())
                            .map(str::to_string)
                    });
                let _ = storage.finish_job(
                    &spawned_job_id,
                    outcome.job_status,
                    &outcome.summary_json,
                    &outcome.done_message,
                );
                let run_status = match outcome.job_status {
                    "succeeded" => "succeeded",
                    "cancelled" => "cancelled",
                    _ => "failed",
                };
                let _ =
                    storage.finish_recurring_run(&run_id, run_status, session_id.as_deref(), None);
            }
            Err(error) => {
                let _ = storage.fail_job(&spawned_job_id, &error);
                let _ = storage.finish_recurring_run(&run_id, "failed", None, Some(&error));
            }
        }
    });
    Ok(RunProjectTaskResult {
        started: true,
        job_id: Some(job_id),
        message: "重复任务已开始运行".to_string(),
    })
}

/// 组装发给 Claude Code 的任务 prompt。
/// 若带了退回原因，则作为首段修正指令注入，让 Agent 先修正再完成原任务。
/// 若基于某个已完成任务创建，则注入会话延续说明，让 Agent 知道自己在复用上个任务的
/// 会话上下文（--resume），这是一个新任务但仍在原会话中推进。
fn build_task_prompt(
    task: &ProjectTask,
    rejection_reason: Option<&str>,
    base_task: Option<&ProjectTask>,
) -> String {
    let mut prompt = String::new();
    prompt.push_str("你是由 Flowlet 调度执行的编程 Agent，请在当前项目目录内完成以下任务。\n\n");
    if task_last_execution_interrupted(task) {
        prompt.push_str("注意：上一轮执行因 Flowlet 或系统重启而中断，本次已恢复同一个 Agent 会话。请先结合已有会话上下文检查工作区现状，从中断位置继续，不要重复已经完成的工作。\n\n");
    }
    if let Some(base) = base_task {
        let base_title = base.title.trim();
        if !base_title.is_empty() {
            prompt.push_str(&format!(
                "注意：本任务基于已完成任务「{}」继续推进。请复用上个任务的 Agent 会话上下文——这是个新任务，但你仍然在该会话中进行，可以延续此前的讨论与结论，在此基础上完成本任务。\n\n",
                truncate(base_title, 120)
            ));
        }
    }
    if let Some(reason) = rejection_reason {
        let trimmed = reason.trim();
        if !trimmed.is_empty() {
            prompt.push_str(&format!(
                "注意：本任务上一轮执行被退回，退回原因：{}\n",
                truncate(trimmed, 500)
            ));
            prompt.push_str("请先针对该退回原因修正上一轮的结果，再完成原任务。\n\n");
        }
    }
    prompt.push_str(&format!("任务标题：{}\n", task.title));
    if !task.description.trim().is_empty() {
        prompt.push_str(&format!("任务描述：{}\n", task.description.trim()));
    }
    match task.task_type.as_str() {
        "readonly" => prompt
            .push_str("任务类型：只读分析。请不要修改任何文件，只读取与分析，并在结尾给出结论。\n"),
        _ => prompt.push_str("任务类型：代码修改。\n"),
    }
    prompt.push_str("\n完成后，请简要总结你做了什么、修改了哪些文件以及最终结论。");
    prompt
}

fn task_last_execution_interrupted(task: &ProjectTask) -> bool {
    task.execution_history
        .as_deref()
        .and_then(|history| serde_json::from_str::<Vec<serde_json::Value>>(history).ok())
        .and_then(|history| history.last().cloned())
        .and_then(|entry| {
            entry
                .get("interrupted")
                .and_then(serde_json::Value::as_bool)
        })
        .unwrap_or(false)
}

/// 会话显示名上限（字符数）。CLI 内部对名称清理控制字符后截断到 200 字符
/// （`efn` 处理），这里在发送前先清理并截短，避免超长任务标题撑大命令行参数。
const MAX_SESSION_NAME_CHARS: usize = 80;

/// 生成 Claude Code 会话显示名：`任务：<任务标题>`。
/// 清理控制字符（与 CLI 内部 `efn` 的 `[\x00-\x1f\x7f-\x9f]` 一致），
/// 并按字符截断，避免脏标题进入会话名。空标题回退为 `任务`。
fn build_session_name(task: &ProjectTask) -> String {
    let cleaned: String = task.title.chars().filter(|ch| !ch.is_control()).collect();
    let title: String = cleaned
        .trim()
        .chars()
        .take(MAX_SESSION_NAME_CHARS)
        .collect();
    if title.is_empty() {
        "任务".to_string()
    } else {
        format!("任务：{title}")
    }
}

/// 解析执行时要复用的 session_id（--resume），优先级：
/// 1. 本任务最近一次执行的会话（退回重跑场景，带着上一轮的上下文继续修正）；
/// 2. 基于已完成任务创建且首次执行时，复用基础任务的会话，让新任务延续上个任务的上下文。
/// 都解析不到时返回 None（全新会话）。
fn resolve_resume_session(
    storage: &Storage,
    task: &ProjectTask,
    base_task: Option<&ProjectTask>,
) -> Result<Option<String>, String> {
    if let Some(session) = session_from_job(storage, task.last_job_id.as_deref())? {
        return Ok(Some(session));
    }
    if let Some(base) = base_task {
        if let Some(session) = session_from_job(storage, base.last_job_id.as_deref())? {
            return Ok(Some(session));
        }
    }
    Ok(None)
}

/// 从某个 job 的摘要里解析 session_id。
fn session_from_job(storage: &Storage, job_id: Option<&str>) -> Result<Option<String>, String> {
    let Some(job_id) = job_id else {
        return Ok(None);
    };
    let Some(detail) = storage
        .get_background_job_detail(job_id)
        .map_err(|error| format!("读取上次执行记录失败：{error}"))?
    else {
        return Ok(None);
    };
    // 用户主动取消表示放弃当前执行，不应在下次重新提交时偷偷恢复该会话。
    if detail.job.status == "cancelled" {
        return Ok(None);
    }
    // 正常收尾会把 sessionId 写进 summary；应用被关闭/重启时来不及执行收尾，
    // 但 Claude Code / OpenCode 已在启动事件中记录了原生会话 id，因此回退读取事件。
    if let Some(session) = detail
        .job
        .summary_json
        .as_deref()
        .and_then(|summary| serde_json::from_str::<serde_json::Value>(summary).ok())
        .and_then(|value| {
            value
                .get("sessionId")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
        })
        .filter(|session| !session.trim().is_empty())
    {
        return Ok(Some(session));
    }
    Ok(detail
        .events
        .iter()
        .rev()
        .find(|event| event.stage.as_deref() == Some("会话"))
        .and_then(|event| {
            event
                .message
                .rsplit_once('：')
                .map(|(_, value)| value.trim())
        })
        .filter(|session| !session.is_empty())
        .map(str::to_string))
}

/// 解析任务指定 Agent 的可执行路径。未安装或 Profile 未知返回明确错误。
async fn resolve_agent_executable(agent_profile: &str) -> Result<String, String> {
    let adapter = adapters::for_profile(agent_profile)
        .ok_or_else(|| format!("不支持的 Agent Profile：{agent_profile}"))?;
    let report =
        crate::core::agent_environment::detect_agent_environment(adapter.environment_adapter_id)
            .await
            .map_err(|error| format!("检测 {} 失败：{error}", adapter.display_name))?;
    if !report.installed {
        return Err(adapter.missing_executable_message.to_string());
    }
    // Runner Adapter 声明任务所需 Surface。探测可能同时返回多种 Surface；primary
    // 不满足合同时回退到安装列表中的匹配项，仍无可执行入口则使用 Adapter 的错误提示。
    // 可执行入口要求：surface 契约匹配、无安装错误，且位于 PATH（`available_on_path`）
    // 或携带不经 PATH 的直接入口（`runner_executable`，如 npx 缓存包的 bin JS）。
    let required_surface = &adapter.required_surface;
    match report.primary {
        Some(primary) if runner_usable(&primary, required_surface) => {
            Ok(effective_executable(&primary))
        }
        _ => report
            .installations
            .iter()
            .find(|installation| runner_usable(installation, required_surface))
            .map(effective_executable)
            .ok_or_else(|| adapter.missing_executable_message.to_string()),
    }
}

/// 安装项是否可作为指定 Surface 的任务执行入口。
fn runner_usable(installation: &AgentInstallation, required_surface: &AgentSurface) -> bool {
    &installation.surface == required_surface
        && installation.error.is_none()
        && (installation.available_on_path || installation.runner_executable.is_some())
}

/// 任务 Runner 实际使用的启动入口：优先 `runner_executable`（不经 PATH 的直接
/// 入口，如 node 可解释的 JS），否则回退 `executable_path`（PATH 命令/垫片）。
fn effective_executable(installation: &AgentInstallation) -> String {
    installation
        .runner_executable
        .clone()
        .unwrap_or_else(|| installation.executable_path.clone())
}

/// 任务执行分派：按任务的 agent_profile 选择执行器。
/// 历史任务的空 profile 由 Adapter 注册表兼容为 Claude Code；未知 Profile 明确报错。
async fn execute_agent(
    storage: &Storage,
    executable: &str,
    task: &ProjectTask,
    project_id: &str,
    job_id: &str,
    prompt: &str,
    resume_session: Option<&str>,
    manage_task_state: bool,
) -> Result<ExecutionOutcome, String> {
    let adapter = adapters::for_profile(&task.agent_profile)
        .ok_or_else(|| format!("不支持的 Agent Profile：{}", task.agent_profile))?;
    if !adapter.supports_resume && resume_session.is_some_and(|session| !session.trim().is_empty())
    {
        return Err(adapter.resume_unsupported_message.to_string());
    }
    (adapter.execute)(
        storage,
        executable,
        task,
        project_id,
        job_id,
        prompt,
        resume_session,
        manage_task_state,
    )
    .await
}

pub(crate) fn has_runner_adapter(adapter_id: &str) -> bool {
    adapters::has(adapter_id)
}

pub(crate) fn runner_contract(
    adapter_id: &str,
) -> Option<(&'static str, &'static AgentSurface, bool)> {
    adapters::by_id(adapter_id).map(|adapter| {
        (
            adapter.profile,
            &adapter.required_surface,
            adapter.supports_resume,
        )
    })
}

pub(crate) fn validate_session_policy(
    agent_profile: &str,
    session_policy: &str,
) -> Result<(), String> {
    let adapter = adapters::for_profile(agent_profile)
        .ok_or_else(|| format!("不支持的 Agent Profile：{agent_profile}"))?;
    if session_policy == "continue" && !adapter.supports_resume {
        return Err(adapter.resume_unsupported_message.to_string());
    }
    Ok(())
}

#[cfg(test)]
mod runner_contract_tests {
    use super::*;

    fn web_installation(runner_executable: Option<&str>) -> AgentInstallation {
        AgentInstallation {
            surface: AgentSurface::Web,
            executable_path: "http://127.0.0.1:3080".to_string(),
            install_dir: r"C:\Users\test\.dsh".to_string(),
            install_method: crate::core::agent_environment::AgentInstallMethod::Npm,
            version: Some("0.1.0-rc.6".to_string()),
            version_output: None,
            available_on_path: false,
            runner_executable: runner_executable.map(str::to_string),
            error: None,
        }
    }

    #[test]
    fn session_policy_validation_uses_the_selected_runner_contract() {
        assert!(validate_session_policy("Claude Code", "continue").is_ok());
        let error = validate_session_policy("DeepSeek Harness", "continue").unwrap_err();
        assert!(error.contains("resume"));
        assert!(validate_session_policy("DeepSeek Harness", "fresh").is_ok());
        assert!(validate_session_policy("missing", "fresh")
            .unwrap_err()
            .contains("不支持"));
    }

    #[test]
    fn runner_gate_accepts_direct_entry_without_path() {
        // 无 PATH、无直接入口：不可用于任务执行。
        let mut installation = web_installation(None);
        assert!(!runner_usable(&installation, &AgentSurface::Web));
        // 有报错时即使带直接入口也不可用。
        installation = web_installation(Some(r"C:\pkg\lib\bin.js"));
        installation.error = Some("无法解析入口".to_string());
        assert!(!runner_usable(&installation, &AgentSurface::Web));
        // 唯一版本的 npx 缓存包入口：不依赖 PATH 即可执行。
        installation.error = None;
        assert!(runner_usable(&installation, &AgentSurface::Web));
        assert_eq!(
            effective_executable(&installation),
            r"C:\pkg\lib\bin.js"
        );
        // Surface 契约不满足时仍拒绝。
        assert!(!runner_usable(&installation, &AgentSurface::Cli));
    }

    #[test]
    fn effective_executable_falls_back_to_path_executable() {
        let mut installation = web_installation(None);
        installation.available_on_path = true;
        installation.executable_path = r"C:\npm\dsh.cmd".to_string();
        assert!(runner_usable(&installation, &AgentSurface::Web));
        assert_eq!(effective_executable(&installation), r"C:\npm\dsh.cmd");
    }
}

/// 读取项目并校验本机目录绑定，返回项目目录（所有执行器共用的前置校验）。
fn required_project_dir(storage: &Storage, project_id: &str) -> Result<std::path::PathBuf, String> {
    let project = storage
        .get_project(project_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "项目不存在".to_string())?;
    // 只有绑定有效本机目录的项目能被调度器领取执行。便携目录迁移、系统重装或盘符变化后，
    // SQLite 中可能仍保留旧路径；必须在 CreateProcess 前单独校验，否则 Windows 会把无效 cwd
    // 和无效 executable 统一报告为 os error 267，误导用户排查 Agent 安装路径。
    let configured = project
        .directory_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .ok_or_else(|| "项目未绑定本机目录，无法执行；请先编辑项目并选择本机目录".to_string())?;
    let directory = std::path::PathBuf::from(configured);
    if !directory.is_dir() {
        return Err(format!(
            "项目绑定的本机目录不存在或不是文件夹：{}；请编辑项目并重新绑定目录",
            directory.display()
        ));
    }
    Ok(directory)
}

/// 把数据库中的 submitted 任务拆为可执行队列与本机环境阻塞项。
/// 阻塞项仍保留 submitted 状态，只是不交给调度器；目录重新绑定或恢复后，下一次轮询会自动入队。
pub(crate) fn project_task_queue_report(
    storage: &Storage,
    queued: Vec<ProjectTask>,
) -> ProjectTaskQueueReport {
    let mut tasks = Vec::with_capacity(queued.len());
    let mut blockers = Vec::new();
    for task in queued {
        match required_project_dir(storage, &task.project_id) {
            Ok(_) => tasks.push(task),
            Err(message) => blockers.push(ProjectTaskQueueBlocker {
                task_id: task.id,
                code: "project_directory_unavailable",
                message,
            }),
        }
    }
    ProjectTaskQueueReport { tasks, blockers }
}

/// 截断超长文本，保留首尾。
fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let head: String = text.chars().take(max).collect();
    format!("{head}…")
}

/// 任务执行完成进入待审核时发送系统通知。
/// 是否发送由全局设置 `TASK_REVIEW_NOTIFICATION_KEY` 控制，默认开启。
/// 通知携带项目与任务上下文：Windows 下点击通知会打开该项目的独立窗口
/// 并激活任务概览抽屉（其它桌面平台退化为插件的基础 toast，暂无点击跳转）。
/// 通知失败只记录日志，不影响任务执行流程。
#[cfg(desktop)]
fn notify_task_review(app: &AppHandle, storage: &Storage, task: &ProjectTask) {
    let enabled = storage
        .get_app_meta(TASK_REVIEW_NOTIFICATION_KEY)
        .ok()
        .flatten()
        .map(|value| value != "0")
        .unwrap_or(true);
    if !enabled {
        tracing::debug!("任务待审核通知已被用户关闭，跳过");
        return;
    }
    let body = format!("任务「{}」执行完成，等待审核", truncate(&task.title, 50));
    #[cfg(windows)]
    {
        show_windows_review_toast(app, task, &body);
    }
    #[cfg(not(windows))]
    {
        use tauri_plugin_notification::NotificationExt;
        let result = app
            .notification()
            .builder()
            .title("任务执行完成")
            .body(&body)
            .show();
        match result {
            Ok(()) => tracing::info!("已发送任务待审核系统通知"),
            Err(error) => tracing::warn!(%error, "发送任务待审核系统通知失败"),
        }
    }
}

/// Windows 专属：直接用 tauri-winrt-notification 构造带点击回调的 toast。
/// 插件桌面 `show()` 不透出点击事件，这里注册 `on_activated`：用户点击
/// 通知（正文或按钮）时在回调里打开项目独立窗口并定位到该任务。
/// 回调捕获 `project_id` / `task_id`，不依赖 toast 的 launch 参数。
#[cfg(all(desktop, windows))]
fn show_windows_review_toast(app: &AppHandle, task: &ProjectTask, body: &str) {
    use tauri_winrt_notification::{Duration, Toast};

    let aumid = app.config().identifier.clone();
    let project_id = task.project_id.clone();
    let task_id = task.id.clone();
    let activate_app = app.clone();

    let toast = Toast::new(&aumid)
        .title("任务执行完成")
        .text1(body)
        .duration(Duration::Short)
        .on_activated(move |_action| {
            let activate_app = activate_app.clone();
            let project_id = project_id.clone();
            let task_id = task_id.clone();
            // 点击回调运行在 WinRT 后台线程，把打开窗口的动作移到 Tauri 异步运行时。
            tauri::async_runtime::spawn(async move {
                if let Some(state) = activate_app.try_state::<crate::AppState>() {
                    if let Err(error) = crate::commands::open_detail_window(
                        &activate_app,
                        state.inner(),
                        &project_id,
                        Some(&task_id),
                    )
                    .await
                    {
                        tracing::warn!(%error, "点击通知打开任务看板失败");
                    }
                }
            });
            Ok(())
        })
        .on_dismissed(|_| Ok(()));

    match toast.show() {
        Ok(()) => tracing::info!("已发送任务待审核系统通知"),
        Err(error) => tracing::warn!(%error, "发送任务待审核系统通知失败"),
    }
}

/// 供 summary 记录输出行数（截断后的完整累积量）。
fn text_buffer_lines(text: &str) -> usize {
    text.lines().count()
}

#[cfg(test)]
#[path = "agent_task_runner/tests.rs"]
mod tests;
