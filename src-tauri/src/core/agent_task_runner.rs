//! Agent 任务执行核心：按任务 `agent_profile` 驱动 Claude Code / Codex / OpenCode / Pi
//! CLI 在项目目录内执行项目任务。
//!
//! 按项目隔离的执行槽：每个项目同一时刻至多一个任务在执行，其余在该项目内排队；
//! 不同项目互不影响，可并行执行。并发安全下沉 Rust（参考 AGENT_DATA_SYNC_RUNNING 模式）。
//! 四种 Agent 都以非交互模式执行（Claude Code `-p --output-format stream-json`、
//! OpenCode `run --format json`、Pi `-p`、Codex `exec --json`），权限走各 CLI 的非交互
//! 放行参数（`--dangerously-skip-permissions` / `--auto` / `--approve` /
//! `--dangerously-bypass-approvals-and-sandbox`）。
//! 执行过程中的模型请求会经过 Flowlet 本地代理，自动进入请求日志与用量账本。
//! Agent 退出后由 Rust 自动把任务状态回写 `review`（等待人工审核）。

use crate::core::agent_environment::AgentSurface;
use crate::core::storage::{ProjectTask, Storage};
use serde::Serialize;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
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

type RunnerFuture<'a> = Pin<Box<dyn Future<Output = Result<ExecutionOutcome, String>> + Send + 'a>>;
type ExecuteRunner = for<'a> fn(
    &'a Storage,
    &'a str,
    &'a ProjectTask,
    &'a str,
    &'a str,
    &'a str,
    Option<&'a str>,
    bool,
) -> RunnerFuture<'a>;

struct AgentTaskRunnerAdapter {
    id: &'static str,
    profile: &'static str,
    environment_adapter_id: &'static str,
    display_name: &'static str,
    execute: ExecuteRunner,
}

static RUNNER_ADAPTERS: [AgentTaskRunnerAdapter; 4] = [
    AgentTaskRunnerAdapter {
        id: "claude-code",
        profile: "Claude Code",
        environment_adapter_id: "claude-code",
        display_name: "Claude Code",
        execute: execute_claude_code_boxed,
    },
    AgentTaskRunnerAdapter {
        id: "opencode",
        profile: "OpenCode",
        environment_adapter_id: "opencode",
        display_name: "OpenCode",
        execute: execute_opencode_boxed,
    },
    AgentTaskRunnerAdapter {
        id: "pi",
        profile: "Pi",
        environment_adapter_id: "pi",
        display_name: "Pi",
        execute: execute_pi_boxed,
    },
    AgentTaskRunnerAdapter {
        id: "codex",
        profile: "Codex",
        environment_adapter_id: "chatgpt-desktop",
        display_name: "Codex",
        execute: execute_codex_boxed,
    },
];

fn runner_adapter_for_profile(profile: &str) -> Option<&'static AgentTaskRunnerAdapter> {
    let normalized = profile.trim();
    if normalized.is_empty() {
        return RUNNER_ADAPTERS
            .iter()
            .find(|adapter| adapter.id == "claude-code");
    }
    RUNNER_ADAPTERS
        .iter()
        .find(|adapter| adapter.profile == normalized)
}

pub(crate) fn has_runner_adapter(adapter_id: &str) -> bool {
    RUNNER_ADAPTERS
        .iter()
        .any(|adapter| adapter.id == adapter_id)
}

macro_rules! boxed_runner {
    ($name:ident, $execute:ident) => {
        fn $name<'a>(
            storage: &'a Storage,
            executable: &'a str,
            task: &'a ProjectTask,
            project_id: &'a str,
            job_id: &'a str,
            prompt: &'a str,
            resume_session: Option<&'a str>,
            manage_task_state: bool,
        ) -> RunnerFuture<'a> {
            Box::pin($execute(
                storage,
                executable,
                task,
                project_id,
                job_id,
                prompt,
                resume_session,
                manage_task_state,
            ))
        }
    };
}

boxed_runner!(execute_claude_code_boxed, execute_claude_code);
boxed_runner!(execute_opencode_boxed, execute_opencode);
boxed_runner!(execute_pi_boxed, execute_pi);
boxed_runner!(execute_codex_boxed, execute_codex);

/// 按项目粒度的执行槽守卫：持有期间占用该项目的槽位，Drop 时释放。
/// 领取即占位（在运行集合中插入占位信息），执行失败提前返回时随函数结束释放。
struct AgentTaskRunningGuard {
    project_id: String,
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
    project_id: String,
    task_id: String,
    current_device_id: String,
) -> Result<RunProjectTaskResult, String> {
    // 1. 抢「按项目隔离」的执行槽（并发安全下沉 Rust，参考 AGENT_DATA_SYNC_RUNNING 模式）：
    //    同一项目至多一个任务在跑，不同项目互不影响。领取即占位，执行失败提前返回时
    //    随函数结束 drop 释放；成功则随后台执行任务 move，Agent 结束后释放。
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
            "project-task-run",
            &format!("任务执行：{}", task.title),
            "正在启动",
            "manual",
            1,
            &format!("开始执行任务「{}」", task.title),
        )
        .map_err(|error| format!("创建任务日志失败：{error}"))?;

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
            "recurring-task-run",
            &format!("重复任务：{}", task.title),
            "正在启动",
            &run.trigger_source,
            1,
            &format!("开始运行「{}」", task.title),
        )
        .map_err(|error| error.to_string())?;
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

/// 任务 Agent Profile 对应的 `agent_environment` agent_id 与展示名。
/// 与前端 `AGENT_PROFILES`（ProjectsPage.tsx）保持一致；空串视为 Claude Code
/// （历史任务在 `agent_profile` 列引入前的默认值），未知 Profile 返回 None，
/// 由调用方给出明确错误。
fn agent_profile_meta(agent_profile: &str) -> Option<(&'static str, &'static str)> {
    runner_adapter_for_profile(agent_profile)
        .map(|adapter| (adapter.environment_adapter_id, adapter.display_name))
}

/// 解析任务指定 Agent 的可执行路径。未安装或 Profile 未知返回明确错误。
async fn resolve_agent_executable(agent_profile: &str) -> Result<String, String> {
    let Some((agent_id, agent_name)) = agent_profile_meta(agent_profile) else {
        return Err(format!("不支持的 Agent Profile：{agent_profile}"));
    };
    let report = crate::core::agent_environment::detect_agent_environment(agent_id)
        .await
        .map_err(|error| format!("检测 {agent_name} 失败：{error}"))?;
    if !report.installed {
        // 区分「未安装 CLI」与「已接入但可执行文件不可用」：接入写的是全局配置文件，
        // 不安装 CLI 二进制；任务执行需要真正的 CLI 进程，缺失时给出明确指引。
        return Err(format!(
            "未检测到 {agent_name} CLI 可执行文件（接入配置不包含 CLI），请先安装 {agent_name} 后重试。"
        ));
    }
    // 任务执行需要 CLI 进程：OpenCode / Codex 的探测会同时返回桌面应用安装，而桌面
    // 应用没有 run / exec 接口，不能作为任务执行器。primary 已是 CLI 时直接使用
    // （保留探测的优先级逻辑：PATH + 有版本优先）；primary 是桌面应用时回退到
    // 列表里第一个 CLI 安装，仍无则给出明确错误。
    match report.primary {
        Some(primary) if primary.surface == AgentSurface::Cli => Ok(primary.executable_path),
        _ => report
            .installations
            .iter()
            .find(|installation| installation.surface == AgentSurface::Cli)
            .map(|installation| installation.executable_path.clone())
            .ok_or_else(|| format!("未检测到 {agent_name} CLI 可执行文件")),
    }
}

/// 任务执行分派：按任务的 agent_profile 选择执行器。
/// 历史任务默认 profile 为 Claude Code，未知 Profile 也回退 Claude Code，避免破坏存量任务。
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
    let adapter = runner_adapter_for_profile(&task.agent_profile)
        .ok_or_else(|| format!("不支持的 Agent Profile：{}", task.agent_profile))?;
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

/// 已启动的 Agent 子进程及其输出流。
struct SpawnedAgent {
    child: tokio::process::Child,
    stdin: Option<tokio::process::ChildStdin>,
    stdout: tokio::process::ChildStdout,
    stderr: tokio::process::ChildStderr,
}

/// 启动一个 Agent 子进程。`build` 闭包负责追加 Agent 专属参数；
/// 当前目录、stdin/stdout/stderr 管道、kill_on_drop 与 Windows 隐藏控制台统一处理。
fn spawn_agent(
    executable: &str,
    project_dir: &std::path::Path,
    display_name: &str,
    pipe_stdin: bool,
    build: impl FnOnce(&mut tokio::process::Command),
) -> Result<SpawnedAgent, String> {
    let mut command = build_agent_command(executable);
    build(&mut command);
    let stdin = if pipe_stdin {
        std::process::Stdio::piped()
    } else {
        std::process::Stdio::null()
    };
    command
        .current_dir(project_dir)
        .stdin(stdin)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    crate::core::agent_environment::configure_hidden_console(&mut command);
    let mut child = command.spawn().map_err(|error| {
        format!(
            "无法启动 {display_name}；可执行文件：{executable}；工作目录：{}；{error}",
            project_dir.display()
        )
    })?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| format!("无法连接 {display_name} 标准输出"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| format!("无法连接 {display_name} 标准错误"))?;
    Ok(SpawnedAgent {
        stdin: child.stdin.take(),
        child,
        stdout,
        stderr,
    })
}

/// 只有 Agent 子进程及其输出管道都成功创建后，才把本次 job 记为一个执行轮次。
/// 启动前校验或 CreateProcess 失败仍保留 background job 日志，但不占用轮次编号。
fn record_started_execution(
    storage: &Storage,
    task: &ProjectTask,
    job_id: &str,
    manage_task_state: bool,
) -> Result<(), String> {
    if !manage_task_state {
        return Ok(());
    }
    let recorded = storage
        .append_task_execution(&task.id, job_id, &task.updated_at)
        .map_err(|error| format!("记录任务执行轮次失败：{error}"))?;
    if !recorded {
        return Err("记录任务执行轮次失败：任务不存在".to_string());
    }
    Ok(())
}

/// Agent 进程输出读取结果。
struct AgentProcessOutcome {
    session_id: Option<String>,
    cancelled: bool,
    stderr_lines: Vec<String>,
    /// 最终累计输出行数（冲刷后统计）。
    output_lines: usize,
}

/// 通用执行循环：读取 stdout 行交给 `on_stdout_line` 解析、收集 stderr、
/// 轮询取消请求。取消时 kill 进程并把任务回写草稿（与具体 Agent 无关的公共行为）。
///
/// `on_stdout_line` 负责把一行输出中的有用文本累积进 `text_buffer`，
/// 并在能识别出会话 id 时写入 `session_id`；文本统一按 `TEXT_FLUSH_THRESHOLD`
/// 落 job event。返回读取结果与已结束（或待 wait）的进程。
async fn read_agent_output(
    storage: &Storage,
    job_id: &str,
    task_id: &str,
    agent: SpawnedAgent,
    display_name: &str,
    manage_task_state: bool,
    mut on_stdout_line: impl FnMut(
        &Storage,
        &str,
        &str,
        &mut String,
        &mut Option<String>,
    ) -> Result<(), String>,
) -> Result<(AgentProcessOutcome, tokio::process::Child), String> {
    let mut child = agent.child;
    // stderr 单独读，收集到 channel，最后失败时并入完成信息。
    let (stderr_tx, mut stderr_rx) = tokio::sync::mpsc::channel(64);
    {
        let stderr_tx = stderr_tx;
        tauri::async_runtime::spawn(async move {
            use tokio::io::{AsyncBufReadExt, BufReader};
            let mut lines = BufReader::new(agent.stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if stderr_tx.send(line).await.is_err() {
                    break;
                }
            }
        });
    }

    use tokio::io::{AsyncBufReadExt, BufReader};
    let mut lines = BufReader::new(agent.stdout).lines();
    let mut text_buffer = String::new();
    let mut session_id: Option<String> = None;
    let mut stderr_lines: Vec<String> = Vec::new();
    let mut output_lines = 0usize;

    let mut cancel_poll = tokio::time::interval(CANCEL_POLL_INTERVAL);
    cancel_poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            _ = cancel_poll.tick() => {
                if storage
                    .is_job_cancel_requested(job_id)
                    .map_err(|error| error.to_string())?
                {
                    let _ = child.kill().await;
                    let _ = child.wait().await;
                    // 取消后回到草稿：不会被调度器自动重新领取，用户确认后再手动提交。
                    if manage_task_state { let _ = storage.set_task_status(task_id, "draft"); }
                    return Ok((AgentProcessOutcome {
                        session_id,
                        cancelled: true,
                        stderr_lines,
                        output_lines: 0,
                    }, child));
                }
            }
            line = lines.next_line() => {
                match line {
                    Ok(Some(line)) => {
                        on_stdout_line(storage, job_id, &line, &mut text_buffer, &mut session_id)?;
                        if text_buffer.len() >= TEXT_FLUSH_THRESHOLD {
                            output_lines = output_lines.saturating_add(text_buffer_lines(&text_buffer));
                            flush_text(storage, job_id, &mut text_buffer)?;
                        }
                    }
                    Ok(None) => break,
                    Err(error) => return Err(format!("读取 {display_name} 输出失败：{error}")),
                }
            }
            maybe_stderr = stderr_rx.recv() => {
                match maybe_stderr {
                    Some(line) => { stderr_lines.push(line); }
                    None => {}
                }
            }
        }
    }

    // 冲刷剩余的累积文本，并统计总输出行数（供 summary 记录）。
    output_lines = output_lines.saturating_add(text_buffer_lines(&text_buffer));
    flush_text(storage, job_id, &mut text_buffer)?;
    Ok((
        AgentProcessOutcome {
            session_id,
            cancelled: false,
            stderr_lines,
            output_lines,
        },
        child,
    ))
}

/// Agent 进程结束后的统一收尾：取消路径已回写草稿；正常退出回写待审核，
/// 生成 exitCode / sessionId / outputLines 摘要。
async fn finish_agent_outcome(
    storage: &Storage,
    task: &ProjectTask,
    display_name: &str,
    child: &mut tokio::process::Child,
    outcome: AgentProcessOutcome,
    manage_task_state: bool,
) -> Result<ExecutionOutcome, String> {
    if outcome.cancelled {
        let summary = serde_json::json!({
            "cancelled": true,
            "sessionId": outcome.session_id,
        })
        .to_string();
        return Ok(ExecutionOutcome {
            job_status: "cancelled",
            summary_json: summary,
            done_message: "任务已取消，已回到草稿".to_string(),
        });
    }

    let status = child
        .wait()
        .await
        .map_err(|error| format!("等待 {display_name} 退出失败：{error}"))?;
    let success = status.success();
    let exit_code = status.code().unwrap_or(-1);

    // Agent 退出后自动回写待审核：无论成功或失败，都交由人类在待审核阶段判断。
    if manage_task_state {
        storage
            .set_task_status(&task.id, "review")
            .map_err(|error| format!("标记任务待审核失败：{error}"))?;
    }

    let error_snippet = if success {
        String::new()
    } else {
        let joined = outcome.stderr_lines.join("\n");
        if joined.is_empty() {
            String::new()
        } else {
            format!("；stderr：{}", truncate(&joined, 300))
        }
    };
    let done_message = if success {
        if manage_task_state {
            "任务执行完成，等待审核".to_string()
        } else {
            "重复任务运行完成".to_string()
        }
    } else {
        format!("任务执行结束（退出码 {exit_code}），等待审核{error_snippet}")
    };
    let summary = serde_json::json!({
        "exitCode": exit_code,
        "sessionId": outcome.session_id,
        "outputLines": outcome.output_lines,
    })
    .to_string();

    Ok(ExecutionOutcome {
        job_status: if success { "succeeded" } else { "failed" },
        summary_json: summary,
        done_message,
    })
}

/// 启动 Claude Code 并持续读取 stream-json 输出，直到进程退出。
async fn execute_claude_code(
    storage: &Storage,
    executable: &str,
    task: &ProjectTask,
    project_id: &str,
    job_id: &str,
    prompt: &str,
    resume_session: Option<&str>,
    manage_task_state: bool,
) -> Result<ExecutionOutcome, String> {
    let project_dir = required_project_dir(storage, project_id)?;
    // 会话显示名：`-p` 非交互模式不会自动生成 ai-title，必须显式传 --name，
    // 否则会话在 Flowlet 列表 / resume 里没有名称。值用任务标题，便于识别。
    let session_name = build_session_name(task);
    let agent = spawn_agent(executable, &project_dir, "Claude Code", false, |command| {
        command
            .arg("-p")
            .arg(prompt)
            .arg("--output-format")
            .arg("stream-json")
            .arg("--verbose")
            .arg("--dangerously-skip-permissions")
            .arg("--name")
            .arg(session_name);
        // 退回重跑复用上次会话：Agent 带着之前的上下文 + 本轮注入的退回原因继续修正。
        // --name 也会一并传入，覆盖旧名称（custom-title 语义为 last-wins）。
        if let Some(session) = resume_session {
            command.arg("--resume").arg(session);
        }
    })?;
    record_started_execution(storage, task, job_id, manage_task_state)?;
    let (outcome, mut child) = read_agent_output(
        storage,
        job_id,
        &task.id,
        agent,
        "Claude Code",
        manage_task_state,
        process_claude_line,
    )
    .await?;
    finish_agent_outcome(
        storage,
        task,
        "Claude Code",
        &mut child,
        outcome,
        manage_task_state,
    )
    .await
}

/// 解析 Claude Code stream-json 的单个事件行，把有用的文本累积并定时落 job event
/// （供只读详情展示），并捕获会话 id。
fn process_claude_line(
    storage: &Storage,
    job_id: &str,
    line: &str,
    text_buffer: &mut String,
    session_id: &mut Option<String>,
) -> Result<(), String> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
        return Ok(());
    };
    let event_type = value
        .get("type")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    match event_type {
        "system" => {
            if value.get("subtype").and_then(serde_json::Value::as_str) == Some("init") {
                if let Some(id) = value.get("session_id").and_then(serde_json::Value::as_str) {
                    *session_id = Some(id.to_string());
                    storage
                        .add_job_event(
                            job_id,
                            "info",
                            "会话",
                            &format!("Claude Code 会话已初始化：{id}"),
                        )
                        .map_err(|error| error.to_string())?;
                }
            }
        }
        "assistant" => {
            if let Some(content) = value
                .pointer("/message/content")
                .and_then(serde_json::Value::as_array)
            {
                for block in content {
                    if block.get("type").and_then(serde_json::Value::as_str) == Some("text") {
                        if let Some(text) = block.get("text").and_then(serde_json::Value::as_str) {
                            text_buffer.push_str(text);
                        }
                    }
                }
            }
        }
        "result" => {
            if let Some(result) = value.get("result").and_then(serde_json::Value::as_str) {
                text_buffer.push_str(result);
            }
        }
        _ => {}
    }
    Ok(())
}

/// 启动 Codex CLI 并读取 `exec --json` 事件输出，直到进程退出。
///
/// 新会话：`codex exec <prompt>`；退回重跑复用上次会话：`codex exec resume <session> <prompt>`
/// （Codex 不保留上次执行参数，resume 时必须重新传入放行与 JSON 输出参数）。
/// 会话 id 即 `--json` 首条 `thread.started` 事件的 `thread_id`，可用于后续 resume。
/// `--dangerously-bypass-approvals-and-sandbox` 非交互自动放行并关闭沙箱（等价于
/// Claude Code `--dangerously-skip-permissions` / OpenCode `--auto`）；`--skip-git-repo-check`
/// 允许在非 git 目录执行（项目目录不保证是 git 仓库）。
async fn execute_codex(
    storage: &Storage,
    executable: &str,
    task: &ProjectTask,
    project_id: &str,
    job_id: &str,
    prompt: &str,
    resume_session: Option<&str>,
    manage_task_state: bool,
) -> Result<ExecutionOutcome, String> {
    let project_dir = required_project_dir(storage, project_id)?;
    let agent = spawn_agent(executable, &project_dir, "Codex", false, |command| {
        // resume 是 exec 的子命令：`codex exec resume <session> <prompt>`。
        if let Some(session) = resume_session {
            command.arg("exec").arg("resume").arg(session);
        } else {
            command.arg("exec");
        }
        command
            .arg("--json")
            .arg("--dangerously-bypass-approvals-and-sandbox")
            .arg("--skip-git-repo-check")
            .arg(prompt);
    })?;
    record_started_execution(storage, task, job_id, manage_task_state)?;

    let (outcome, mut child) = read_agent_output(
        storage,
        job_id,
        &task.id,
        agent,
        "Codex",
        manage_task_state,
        |storage, job_id, line, text_buffer, session_id| {
            process_codex_line(storage, job_id, line, text_buffer, session_id)
        },
    )
    .await?;
    finish_agent_outcome(
        storage,
        task,
        "Codex",
        &mut child,
        outcome,
        manage_task_state,
    )
    .await
}

/// 解析 Codex `exec --json` 的单行事件：从 `thread.started` 捕获会话 id
/// （`thread_id` 即可用于 resume，首次发现时记录一条会话事件），累积
/// `item.completed` 中 `agent_message` 的文本，并把顶层 `error` 事件并入输出。
fn process_codex_line(
    storage: &Storage,
    job_id: &str,
    line: &str,
    text_buffer: &mut String,
    session_id: &mut Option<String>,
) -> Result<(), String> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
        return Ok(());
    };
    let event_type = value
        .get("type")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    match event_type {
        "thread.started" => {
            if session_id.is_none() {
                if let Some(id) = value.get("thread_id").and_then(serde_json::Value::as_str) {
                    *session_id = Some(id.to_string());
                    storage
                        .add_job_event(job_id, "info", "会话", &format!("Codex 会话：{id}"))
                        .map_err(|error| error.to_string())?;
                }
            }
        }
        "item.completed" => {
            if let Some(item) = value.get("item").and_then(serde_json::Value::as_object) {
                if item.get("type").and_then(serde_json::Value::as_str) == Some("agent_message") {
                    if let Some(text) = item.get("text").and_then(serde_json::Value::as_str) {
                        text_buffer.push_str(text);
                    }
                }
            }
        }
        "error" => {
            if let Some(message) = value.get("message").and_then(serde_json::Value::as_str) {
                text_buffer.push_str(&format!("\n[Codex 错误] {message}\n"));
            }
        }
        _ => {}
    }
    Ok(())
}

/// 启动 OpenCode 并读取 `run --format json` 事件输出，直到进程退出。
async fn execute_opencode(
    storage: &Storage,
    executable: &str,
    task: &ProjectTask,
    project_id: &str,
    job_id: &str,
    prompt: &str,
    resume_session: Option<&str>,
    manage_task_state: bool,
) -> Result<ExecutionOutcome, String> {
    let project_dir = required_project_dir(storage, project_id)?;
    // 会话显示名：`run` 默认用截断后的 prompt 当标题，任务场景显式传 --title。
    let session_name = build_session_name(task);
    let agent = spawn_agent(executable, &project_dir, "OpenCode", false, |command| {
        command
            .arg("run")
            .arg(prompt)
            // JSON 事件流：程序化消费 text 事件与 sessionID。
            .arg("--format")
            .arg("json")
            // 非交互自动批准未显式拒绝的权限（任务执行场景，等价于 Claude Code 跳过权限）。
            .arg("--auto")
            .arg("--title")
            .arg(session_name);
        // 退回重跑复用上次会话：OpenCode --session 继续指定会话。
        if let Some(session) = resume_session {
            command.arg("--session").arg(session);
        }
    })?;
    record_started_execution(storage, task, job_id, manage_task_state)?;

    let (outcome, mut child) = read_agent_output(
        storage,
        job_id,
        &task.id,
        agent,
        "OpenCode",
        manage_task_state,
        |storage, job_id, line, text_buffer, session_id| {
            process_opencode_line(storage, job_id, line, text_buffer, session_id)
        },
    )
    .await?;
    finish_agent_outcome(
        storage,
        task,
        "OpenCode",
        &mut child,
        outcome,
        manage_task_state,
    )
    .await
}

/// 解析 OpenCode `--format json` 的单行事件：累积 `text` 事件的文本，
/// 并从顶层 `sessionID` 捕获会话 id（首次发现时记录一条会话事件）。
fn process_opencode_line(
    storage: &Storage,
    job_id: &str,
    line: &str,
    text_buffer: &mut String,
    session_id: &mut Option<String>,
) -> Result<(), String> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
        return Ok(());
    };
    if value.get("type").and_then(serde_json::Value::as_str) == Some("text") {
        if let Some(text) = value
            .pointer("/part/text")
            .and_then(serde_json::Value::as_str)
        {
            text_buffer.push_str(text);
        }
    }
    if session_id.is_none() {
        if let Some(id) = value.get("sessionID").and_then(serde_json::Value::as_str) {
            *session_id = Some(id.to_string());
            storage
                .add_job_event(job_id, "info", "会话", &format!("OpenCode 会话：{id}"))
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

/// Pi 原生会话目录。Flowlet 调度的任务与用户直接运行 Pi 一样写入这里，确保
/// Pi 自身以及 Flowlet 既有的会话枚举、时间线和用量同步都能读取同一份会话。
fn pi_native_session_dir() -> Result<std::path::PathBuf, String> {
    dirs::home_dir()
        .map(|home| home.join(".pi").join("agent").join("sessions"))
        .ok_or_else(|| "无法确定 Pi 原生会话目录".to_string())
}

/// 解析 Pi 执行要用的会话 id：resume 时复用上次的，否则（首次/空值）生成新 UUID。
fn execute_pi_session_id(resume_session: Option<&str>) -> Option<String> {
    match resume_session {
        Some(session) if !session.trim().is_empty() => Some(session.trim().to_string()),
        _ => Some(uuid::Uuid::new_v4().to_string()),
    }
}

/// 校验 Pi 确实按指定 id 在原生目录创建 / 更新了会话，并收到完整任务正文。
///
/// Windows npm 安装通常解析为 `pi.cmd` / `pi.ps1`。多行 prompt 若经 cmd / PowerShell
/// shim 作为参数传递，会在首个换行处截断，后续 `--session-id` 也会丢失。
/// 因此执行器改用 stdin 传正文，并在进程结束前以真实 JSONL 做后置校验，防止仅凭退出码 0
/// 把“没有收到任务”的回复误判为执行成功。
fn validate_pi_session(
    session_dir: &std::path::Path,
    session_id: &str,
    expected_prompt: &str,
) -> Result<std::path::PathBuf, String> {
    let suffix = format!("_{session_id}.jsonl");
    let mut pending = vec![session_dir.to_path_buf()];
    let mut session_file = None;
    while let Some(dir) = pending.pop() {
        let entries = std::fs::read_dir(&dir)
            .map_err(|error| format!("读取 Pi 原生会话目录失败（{}）：{error}", dir.display()))?;
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if path.is_dir() {
                pending.push(path);
            } else if path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with(&suffix))
            {
                session_file = Some(path);
                break;
            }
        }
        if session_file.is_some() {
            break;
        }
    }
    let session_file =
        session_file.ok_or_else(|| format!("Pi 未在原生会话目录创建会话 {session_id}"))?;
    let contents = std::fs::read_to_string(&session_file)
        .map_err(|error| format!("读取 Pi 原生会话失败：{error}"))?;
    let received_full_prompt = contents.lines().any(|line| {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            return false;
        };
        if value
            .pointer("/message/role")
            .and_then(serde_json::Value::as_str)
            != Some("user")
        {
            return false;
        }
        value
            .pointer("/message/content")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|content| {
                content.iter().any(|block| {
                    block.get("type").and_then(serde_json::Value::as_str) == Some("text")
                        && block.get("text").and_then(serde_json::Value::as_str)
                            == Some(expected_prompt)
                })
            })
    });
    if !received_full_prompt {
        return Err(format!("Pi 会话 {session_id} 未收到完整任务正文"));
    }
    Ok(session_file)
}

/// 启动 Pi 并读取非交互 `-p` 输出，直到进程退出。
///
/// 会话 id 在执行前确定：首次执行生成新 UUID 并通过 `--session-id` 让 Pi 以此创建会话，
/// resume 时复用上次会话 id（Pi 追加写入同一会话文件，不新建）。这比执行后从会话文件
/// 反推可靠——即使 Pi 中途退出，会话 id 也已确定，任务始终能关联到会话。
async fn execute_pi(
    storage: &Storage,
    executable: &str,
    task: &ProjectTask,
    project_id: &str,
    job_id: &str,
    prompt: &str,
    resume_session: Option<&str>,
    manage_task_state: bool,
) -> Result<ExecutionOutcome, String> {
    let project_dir = required_project_dir(storage, project_id)?;
    let session_dir = pi_native_session_dir()?;
    // 会话 id 在执行前确定：首次用新 UUID，resume 用上次的。
    let session_uuid =
        execute_pi_session_id(resume_session).ok_or_else(|| "无法生成 Pi 会话 id".to_string())?;
    let session_name = build_session_name(task);
    let mut agent = spawn_agent(executable, &project_dir, "Pi", true, |command| {
        command
            .arg("-p")
            // 信任项目本地文件（AGENTS.md / CLAUDE.md）：Pi headless 模式默认忽略它们。
            .arg("--approve")
            .arg("--name")
            .arg(session_name)
            // 指定精确会话 id：首次创建该 id 的会话，resume 继续同一会话。
            .arg("--session-id")
            .arg(&session_uuid);
    })?;
    record_started_execution(storage, task, job_id, manage_task_state)?;
    // Pi 的 session id 在进程启动前就已确定，立即落事件。这样应用重启导致进程中断时，
    // 恢复调度仍能取回同一个 id，而不必等待正常收尾写 summary_json。
    storage
        .add_job_event(job_id, "info", "会话", &format!("Pi 会话：{session_uuid}"))
        .map_err(|error| error.to_string())?;
    // Pi 会把 stdin 与首个位置参数合并为初始消息。正文通过 stdin 传递，避免 Windows
    // Windows npm shim 对带换行命令行参数的截断，并规避超长任务的命令行长度上限。
    {
        use tokio::io::AsyncWriteExt;
        let mut stdin = agent
            .stdin
            .take()
            .ok_or_else(|| "无法连接 Pi 标准输入".to_string())?;
        stdin
            .write_all(prompt.as_bytes())
            .await
            .map_err(|error| format!("写入 Pi 任务正文失败：{error}"))?;
        stdin
            .shutdown()
            .await
            .map_err(|error| format!("关闭 Pi 标准输入失败：{error}"))?;
    }
    // 明确告知 Pi 已启动：headless 模式抑制中间输出，完成前任务日志无逐字进展，
    // 避免用户误以为「没执行 / 停止了」。执行靠模型多轮调用，可能耗时数分钟。
    let _ = storage.add_job_event(
        job_id,
        "info",
        "启动",
        &format!("Pi 已启动，正在执行任务（headless 模式完成前无中间输出，请耐心等待）"),
    );

    let (outcome, mut child) = read_agent_output(
        storage,
        job_id,
        &task.id,
        agent,
        "Pi",
        manage_task_state,
        |_storage, _job_id, line, text_buffer, _session_id| {
            // Pi -p 模式抑制中间输出，stdout 是最终结果文本，逐行累积。
            text_buffer.push_str(line);
            text_buffer.push('\n');
            Ok(())
        },
    )
    .await?;

    // 取消时回写草稿不保留会话；正常结束时会话 id 即执行前确定的 UUID。
    let session_id = if outcome.cancelled {
        None
    } else {
        validate_pi_session(&session_dir, &session_uuid, prompt)?;
        Some(session_uuid)
    };
    let outcome = AgentProcessOutcome {
        session_id,
        cancelled: outcome.cancelled,
        stderr_lines: outcome.stderr_lines,
        output_lines: outcome.output_lines,
    };
    finish_agent_outcome(storage, task, "Pi", &mut child, outcome, manage_task_state).await
}

/// 把累积文本写入一条 job event（供只读详情 / 任务日志页展示）。
fn flush_text(storage: &Storage, job_id: &str, text_buffer: &mut String) -> Result<(), String> {
    let text = std::mem::take(text_buffer);
    if text.trim().is_empty() {
        return Ok(());
    }
    storage
        .add_job_event(job_id, "info", "输出", &text)
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// 构建启动 Agent 的命令。Windows 下 .cmd / .bat / .ps1 垫片需要
/// 通过宿主解释器启动（与 agent_environment 的版本探测一致）。
#[cfg(windows)]
fn build_agent_command(executable: &str) -> tokio::process::Command {
    let path = std::path::Path::new(executable);
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if extension == "cmd" || extension == "bat" {
        let mut command = tokio::process::Command::new("cmd.exe");
        command.arg("/D").arg("/C").arg(executable);
        command
    } else if extension == "ps1" {
        let mut command = tokio::process::Command::new("powershell.exe");
        command.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            executable,
        ]);
        command
    } else {
        tokio::process::Command::new(executable)
    }
}

#[cfg(not(windows))]
fn build_agent_command(executable: &str) -> tokio::process::Command {
    tokio::process::Command::new(executable)
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
mod tests {
    use super::*;
    use crate::core::storage::Storage;
    use rusqlite::Connection;

    fn task(title: &str) -> ProjectTask {
        ProjectTask {
            id: "task-1".to_string(),
            project_id: "project-1".to_string(),
            title: title.to_string(),
            description: String::new(),
            status: "submitted".to_string(),
            task_type: "code".to_string(),
            agent_profile: String::new(),
            priority: "p2".to_string(),
            base_task_id: None,
            last_job_id: None,
            rejection_reason: None,
            execution_history: None,
            claimed_by: None,
            claimed_at: None,
            queue_boosted_at: None,
            deleted: false,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    #[test]
    fn session_name_prefixes_task_title() {
        assert_eq!(build_session_name(&task("修复登录页")), "任务：修复登录页");
    }

    #[test]
    fn session_name_cleans_control_characters() {
        // 与 CLI 内部 efn 的 [\x00-\x1f\x7f-\x9f] 处理一致：控制字符被剥离。
        assert_eq!(
            build_session_name(&task("修复\n登录\t页\x07")),
            "任务：修复登录页"
        );
    }

    #[test]
    fn session_name_truncates_oversized_title() {
        let long = "很".repeat(MAX_SESSION_NAME_CHARS + 50);
        let name = build_session_name(&task(&long));
        assert!(name.starts_with("任务："));
        assert_eq!(name.chars().count(), 3 + MAX_SESSION_NAME_CHARS);
    }

    #[test]
    fn session_name_falls_back_when_title_is_blank() {
        assert_eq!(build_session_name(&task("   ")), "任务");
        assert_eq!(build_session_name(&task("")), "任务");
    }

    fn test_storage() -> Storage {
        let storage = Storage::from_connection_for_test(Connection::open_in_memory().unwrap());
        storage.migrate().unwrap();
        storage
    }

    #[test]
    fn project_directory_error_identifies_stale_local_binding() {
        use crate::core::storage::Project;

        let storage = test_storage();
        let missing =
            std::env::temp_dir().join(format!("flowlet-missing-project-{}", uuid::Uuid::new_v4()));
        storage
            .save_project(&Project {
                id: "stale-project".to_string(),
                name: "旧路径项目".to_string(),
                directory_path: Some(missing.to_string_lossy().into_owned()),
                workspace_project_id: None,
                workspace_archived: false,
                created_at: "2026-08-08T00:00:00Z".to_string(),
                updated_at: "2026-08-08T00:00:00Z".to_string(),
            })
            .unwrap();

        let error = required_project_dir(&storage, "stale-project").unwrap_err();
        assert!(error.contains("项目绑定的本机目录不存在或不是文件夹"));
        assert!(error.contains(missing.to_string_lossy().as_ref()));
        assert!(error.contains("重新绑定目录"));
    }

    #[test]
    fn queue_report_excludes_stale_directory_and_preserves_blocker() {
        use crate::core::storage::Project;

        let storage = test_storage();
        let missing =
            std::env::temp_dir().join(format!("flowlet-missing-project-{}", uuid::Uuid::new_v4()));
        storage
            .save_project(&Project {
                id: "stale-project".to_string(),
                name: "旧路径项目".to_string(),
                directory_path: Some(missing.to_string_lossy().into_owned()),
                workspace_project_id: None,
                workspace_archived: false,
                created_at: "2026-08-08T00:00:00Z".to_string(),
                updated_at: "2026-08-08T00:00:00Z".to_string(),
            })
            .unwrap();
        let mut queued_task = task("无法执行的任务");
        queued_task.id = "blocked-task".to_string();
        queued_task.project_id = "stale-project".to_string();

        let report = project_task_queue_report(&storage, vec![queued_task]);

        assert!(report.tasks.is_empty());
        assert_eq!(report.blockers.len(), 1);
        assert_eq!(report.blockers[0].task_id, "blocked-task");
        assert_eq!(report.blockers[0].code, "project_directory_unavailable");
        assert!(report.blockers[0].message.contains("重新绑定目录"));
    }

    /// 在 storage 中造一条带 sessionId 摘要的 project-task-run job。
    fn job_with_session(storage: &Storage, job_id: &str, session_id: &str) {
        storage
            .create_job(
                job_id,
                "project-task-run",
                "任务执行：测试",
                "正在启动",
                "manual",
                1,
                "开始执行",
            )
            .unwrap();
        let summary = serde_json::json!({ "sessionId": session_id }).to_string();
        storage
            .finish_job(job_id, "succeeded", &summary, "任务执行完成")
            .unwrap();
    }

    fn unfinished_job_with_session_event(storage: &Storage, job_id: &str, session_id: &str) {
        storage
            .create_job(
                job_id,
                "project-task-run",
                "任务执行：测试",
                "正在启动",
                "manual",
                1,
                "开始执行",
            )
            .unwrap();
        storage
            .add_job_event(
                job_id,
                "info",
                "会话",
                &format!("Claude Code 会话已初始化：{session_id}"),
            )
            .unwrap();
    }

    #[test]
    fn prompt_injects_base_task_context_when_based_on_done_task() {
        let mut base = task("修复登录页");
        base.title = "修复登录页".to_string();
        let prompt = build_task_prompt(&task("补充缓存"), None, Some(&base));
        assert!(prompt.contains("基于已完成任务「修复登录页」"));
        assert!(prompt.contains("这是个新任务，但你仍然在该会话中进行"));
    }

    #[test]
    fn prompt_omits_base_context_when_no_base_task() {
        let prompt = build_task_prompt(&task("补充缓存"), None, None);
        assert!(!prompt.contains("基于已完成任务"));
        assert!(prompt.contains("任务标题：补充缓存"));
    }

    #[test]
    fn prompt_tells_resumed_session_to_continue_from_interruption() {
        let mut interrupted = task("继续修复");
        interrupted.execution_history = Some(
            serde_json::json!([{
                "jobId": "job-before-restart",
                "interrupted": true
            }])
            .to_string(),
        );

        let prompt = build_task_prompt(&interrupted, None, None);

        assert!(prompt.contains("本次已恢复同一个 Agent 会话"));
        assert!(prompt.contains("从中断位置继续"));
        assert!(prompt.contains("不要重复已经完成的工作"));
    }

    #[test]
    fn resume_prefers_own_job_session_over_base_task() {
        let storage = test_storage();
        job_with_session(&storage, "own-job", "own-session");
        job_with_session(&storage, "base-job", "base-session");
        let mut rerun = task("重跑");
        rerun.last_job_id = Some("own-job".to_string());
        let mut base = task("基础任务");
        base.last_job_id = Some("base-job".to_string());
        // 本任务已有会话（退回重跑）时优先复用本任务会话，而不是基础任务会话。
        assert_eq!(
            resolve_resume_session(&storage, &rerun, Some(&base)).unwrap(),
            Some("own-session".to_string())
        );
    }

    #[test]
    fn resume_falls_back_to_session_event_when_job_was_interrupted() {
        let storage = test_storage();
        unfinished_job_with_session_event(&storage, "interrupted-job", "session-before-restart");
        let mut rerun = task("应用重启后继续");
        rerun.last_job_id = Some("interrupted-job".to_string());

        assert_eq!(
            resolve_resume_session(&storage, &rerun, None).unwrap(),
            Some("session-before-restart".to_string())
        );
    }

    #[test]
    fn resume_does_not_restore_a_cancelled_job_event() {
        let storage = test_storage();
        unfinished_job_with_session_event(&storage, "cancelled-job", "cancelled-session");
        storage
            .finish_job(
                "cancelled-job",
                "cancelled",
                r#"{"cancelled":true,"sessionId":null}"#,
                "任务已取消",
            )
            .unwrap();
        let mut rerun = task("取消后重新提交");
        rerun.last_job_id = Some("cancelled-job".to_string());

        assert_eq!(
            resolve_resume_session(&storage, &rerun, None).unwrap(),
            None
        );
    }

    #[test]
    fn resume_falls_back_to_base_task_session_on_first_run() {
        let storage = test_storage();
        job_with_session(&storage, "base-job", "base-session");
        let fresh = task("新任务");
        let mut base = task("基础任务");
        base.last_job_id = Some("base-job".to_string());
        // 首次执行没有本任务会话，复用基础任务的会话继续推进。
        assert_eq!(
            resolve_resume_session(&storage, &fresh, Some(&base)).unwrap(),
            Some("base-session".to_string())
        );
    }

    #[test]
    fn resume_returns_none_without_sessions() {
        let storage = test_storage();
        let fresh = task("全新任务");
        assert_eq!(
            resolve_resume_session(&storage, &fresh, None).unwrap(),
            None
        );
        // base task 有 last_job_id 但 job 已清理时也返回 None（全新会话）。
        let mut base = task("基础任务");
        base.last_job_id = Some("missing-job".to_string());
        assert_eq!(
            resolve_resume_session(&storage, &fresh, Some(&base)).unwrap(),
            None
        );
    }

    #[test]
    fn agent_profile_meta_maps_supported_profiles() {
        assert_eq!(
            agent_profile_meta("Claude Code"),
            Some(("claude-code", "Claude Code"))
        );
        // Codex 复用 chatgpt-desktop 的探测（含 Codex CLI 与 ChatGPT Desktop），
        // 执行时 resolve_agent_executable 会优先选 CLI 表面的安装。
        assert_eq!(
            agent_profile_meta("Codex"),
            Some(("chatgpt-desktop", "Codex"))
        );
        assert_eq!(
            agent_profile_meta("OpenCode"),
            Some(("opencode", "OpenCode"))
        );
        assert_eq!(agent_profile_meta("Pi"), Some(("pi", "Pi")));
        assert_eq!(agent_profile_meta("Unknown Agent"), None);
        // 空串是历史任务在 agent_profile 列引入前的默认值，视为 Claude Code。
        assert_eq!(agent_profile_meta(""), Some(("claude-code", "Claude Code")));
        assert_eq!(
            agent_profile_meta("   "),
            Some(("claude-code", "Claude Code"))
        );
        assert_eq!(
            RUNNER_ADAPTERS
                .iter()
                .map(|adapter| adapter.id)
                .collect::<Vec<_>>(),
            vec!["claude-code", "opencode", "pi", "codex"]
        );
        assert_eq!(
            runner_adapter_for_profile("Codex").map(|adapter| adapter.id),
            Some("codex")
        );
        assert!(runner_adapter_for_profile("Unknown Agent").is_none());
    }

    #[test]
    fn opencode_line_captures_text_and_session() {
        let storage = test_storage();
        let mut buffer = String::new();
        let mut session_id = None;
        // text 事件：累积 part.text，并捕获 sessionID（首次发现时记录会话事件）。
        process_opencode_line(
            &storage,
            "job-1",
            r#"{"type":"text","sessionID":"ses_abc","part":{"type":"text","text":"Hello","sessionID":"ses_abc"}}"#,
            &mut buffer,
            &mut session_id,
        )
        .unwrap();
        assert_eq!(buffer, "Hello");
        assert_eq!(session_id.as_deref(), Some("ses_abc"));
        // 会话事件只记录一次：后续行携带相同 sessionID 不再重复写事件。
        let mut buffer2 = String::new();
        let mut session_id2 = Some("ses_abc".to_string());
        process_opencode_line(
            &storage,
            "job-1",
            r#"{"type":"step_finish","sessionID":"ses_abc","part":{"type":"step-finish"}}"#,
            &mut buffer2,
            &mut session_id2,
        )
        .unwrap();
        assert!(buffer2.is_empty());
    }

    #[test]
    fn opencode_line_ignores_non_text_events() {
        let storage = test_storage();
        let mut buffer = String::new();
        let mut session_id = None;
        process_opencode_line(
            &storage,
            "job-1",
            r#"{"type":"step_start","sessionID":"ses_abc","part":{"type":"step-start"}}"#,
            &mut buffer,
            &mut session_id,
        )
        .unwrap();
        assert!(buffer.is_empty());
        // 非 JSON 行（日志噪音）直接忽略。
        process_opencode_line(&storage, "job-1", "not json", &mut buffer, &mut session_id).unwrap();
        assert!(buffer.is_empty());
    }

    #[test]
    fn claude_line_captures_session_and_text() {
        let storage = test_storage();
        let mut buffer = String::new();
        let mut session_id = None;
        // system/init：捕获会话 id 并记录会话事件。
        process_claude_line(
            &storage,
            "job-1",
            r#"{"type":"system","subtype":"init","session_id":"session-uuid-1"}"#,
            &mut buffer,
            &mut session_id,
        )
        .unwrap();
        assert_eq!(session_id.as_deref(), Some("session-uuid-1"));
        // assistant 文本块累积。
        process_claude_line(
            &storage,
            "job-1",
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"分析结果"}]}}"#,
            &mut buffer,
            &mut session_id,
        )
        .unwrap();
        assert_eq!(buffer, "分析结果");
        // result 事件也累积。
        process_claude_line(
            &storage,
            "job-1",
            r#"{"type":"result","result":"总结"}"#,
            &mut buffer,
            &mut session_id,
        )
        .unwrap();
        assert_eq!(buffer, "分析结果总结");
    }

    #[test]
    fn codex_line_captures_thread_id_and_agent_message() {
        let storage = test_storage();
        let mut buffer = String::new();
        let mut session_id = None;
        // thread.started：捕获 thread_id 作为会话 id（Codex resume 用），并记录会话事件。
        process_codex_line(
            &storage,
            "job-1",
            r#"{"type":"thread.started","thread_id":"019fd700-0000-4000-8000-000000000001"}"#,
            &mut buffer,
            &mut session_id,
        )
        .unwrap();
        assert_eq!(
            session_id.as_deref(),
            Some("019fd700-0000-4000-8000-000000000001")
        );
        // item.completed 的 agent_message：累积 item.text。
        process_codex_line(
            &storage,
            "job-1",
            r#"{"type":"item.completed","item":{"id":"1","type":"agent_message","text":"分析完成"}}"#,
            &mut buffer,
            &mut session_id,
        )
        .unwrap();
        assert_eq!(buffer, "分析完成");
        // 会话事件只记录一次：后续 thread.started 不再重复写事件。
        let mut buffer2 = String::new();
        let mut session_id2 = Some("019fd700-0000-4000-8000-000000000001".to_string());
        process_codex_line(
            &storage,
            "job-1",
            r#"{"type":"thread.started","thread_id":"019fd700-0000-4000-8000-000000000001"}"#,
            &mut buffer2,
            &mut session_id2,
        )
        .unwrap();
        assert!(buffer2.is_empty());
    }

    #[test]
    fn codex_line_ignores_non_text_events_and_surfaces_errors() {
        let storage = test_storage();
        let mut buffer = String::new();
        let mut session_id = None;
        // turn.completed / 非 agent_message 的 item 不累积文本。
        process_codex_line(
            &storage,
            "job-1",
            r#"{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}"#,
            &mut buffer,
            &mut session_id,
        )
        .unwrap();
        process_codex_line(
            &storage,
            "job-1",
            r#"{"type":"item.completed","item":{"id":"1","type":"command_execution","command":"echo hi"}}"#,
            &mut buffer,
            &mut session_id,
        )
        .unwrap();
        assert!(buffer.is_empty());
        // 顶层 error 事件并入输出，供任务日志排查。
        process_codex_line(
            &storage,
            "job-1",
            r#"{"type":"error","message":"approval required"}"#,
            &mut buffer,
            &mut session_id,
        )
        .unwrap();
        assert!(buffer.contains("[Codex 错误] approval required"));
        // 非 JSON 行（日志噪音）直接忽略。
        process_codex_line(&storage, "job-1", "not json", &mut buffer, &mut session_id).unwrap();
    }

    #[test]
    fn pi_session_dir_uses_pi_native_location() {
        let dir = pi_native_session_dir().unwrap();
        let tail: Vec<String> = dir
            .components()
            .rev()
            .take(3)
            .map(|component| component.as_os_str().to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            tail,
            vec![
                "sessions".to_string(),
                "agent".to_string(),
                ".pi".to_string()
            ]
        );
    }

    #[test]
    fn execute_pi_resolves_session_id_ahead_of_run() {
        // 首次执行生成新 UUID，resume 复用上次的；空/非法值回退新 UUID。
        let fresh = execute_pi_session_id(None);
        assert!(fresh.is_some());
        let resumed = execute_pi_session_id(Some("019fd700-0000-4000-8000-000000000001"));
        assert_eq!(
            resumed.as_deref(),
            Some("019fd700-0000-4000-8000-000000000001")
        );
        // 空串视为首次执行。
        assert!(execute_pi_session_id(Some("   ")).is_some());
    }

    #[test]
    fn pi_session_validation_requires_real_session_and_full_prompt() {
        let root = std::env::temp_dir().join(format!(
            "flowlet-pi-session-validation-{}",
            uuid::Uuid::new_v4()
        ));
        let project_dir = root.join("encoded-project");
        std::fs::create_dir_all(&project_dir).unwrap();
        let session_id = "550e8400-e29b-41d4-a716-446655440000";
        let prompt = "调度前缀\n\n任务标题：修复布局\n任务描述：完整正文";
        let path = project_dir.join(format!("2026-08-07T00-00-00-000Z_{session_id}.jsonl"));
        let user_message = serde_json::json!({
            "type": "message",
            "message": {
                "role": "user",
                "content": [{ "type": "text", "text": prompt }]
            }
        });
        std::fs::write(&path, format!("{}\n", user_message)).unwrap();

        assert_eq!(
            validate_pi_session(&root, session_id, prompt).unwrap(),
            path
        );
        let error = validate_pi_session(&root, session_id, "调度前缀")
            .expect_err("截断后的任务正文不能通过校验");
        assert!(error.contains("未收到完整任务正文"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn pi_session_validation_rejects_fabricated_session_id() {
        let root = std::env::temp_dir().join(format!(
            "flowlet-pi-session-validation-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let error = validate_pi_session(
            &root,
            "550e8400-e29b-41d4-a716-446655440000",
            "完整任务正文",
        )
        .expect_err("不存在的 Pi 会话不能通过校验");
        assert!(error.contains("未在原生会话目录创建会话"));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 真实环境集成测试：用本机已安装的 Pi CLI 完整跑一遍 execute_pi，
    /// 验证 Pi 进程能启动、输出能累积、任务能回写待审核、会话 id 能发现。
    /// 需要本机已安装 Pi 且 Flowlet 代理在 18640 运行；正常测试默认跳过。
    #[tokio::test]
    #[ignore]
    async fn execute_pi_integration_runs_real_pi() {
        use crate::core::storage::Project;
        let storage = test_storage();
        // 用临时目录作为项目目录，避免污染真实项目。
        let project_dir =
            std::env::temp_dir().join(format!("flowlet-pi-integration-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&project_dir).unwrap();
        storage
            .save_project(&Project {
                id: "project-integ".to_string(),
                name: "集成测试".to_string(),
                directory_path: Some(project_dir.to_string_lossy().into_owned()),
                workspace_project_id: None,
                workspace_archived: false,
                created_at: "2026-08-06T00:00:00Z".to_string(),
                updated_at: "2026-08-06T00:00:00Z".to_string(),
            })
            .unwrap();
        storage
            .create_job(
                "job-integ",
                "project-task-run",
                "任务执行：集成",
                "正在启动",
                "manual",
                1,
                "开始执行",
            )
            .unwrap();

        let mut task = task("集成测试");
        task.agent_profile = "Pi".to_string();
        task.id = "task-integ".to_string();
        task.project_id = "project-integ".to_string();
        task.status = "submitted".to_string();
        task.task_type = "readonly".to_string();
        task.title = "验证 Pi stdin 任务传递".to_string();
        task.description =
            "不要调用任何工具，不要运行命令，不要修改文件。请只回复固定文本 FLOWLET_PI_STDIN_OK。"
                .to_string();
        storage.save_project_task(&task).unwrap();

        // 用真实 build_task_prompt 生成的中文长 prompt（含换行），贴近真实执行路径。
        let prompt = build_task_prompt(&task, None, None);
        // 用探测函数解析 Pi 可执行路径（与真实执行路径一致）。
        let executable = resolve_agent_executable("Pi").await.expect("Pi 应已安装");
        let outcome = execute_pi(
            &storage,
            &executable,
            &task,
            "project-integ",
            "job-integ",
            &prompt,
            None,
            true,
        )
        .await
        .expect("execute_pi 应成功执行");
        assert_eq!(outcome.job_status, "succeeded");
        // 用 --session-id 方案后，会话 id 在执行前确定，summary 必有非空 sessionId。
        let summary: serde_json::Value = serde_json::from_str(&outcome.summary_json).unwrap();
        let session_id = summary["sessionId"].as_str().unwrap_or("");
        assert!(
            !session_id.is_empty(),
            "Pi 执行后 summary 应包含确定的会话 id"
        );
        // 输出已累积为 job event（summary 只记录行数，文本在 events 里）。
        let detail = storage
            .get_background_job_detail("job-integ")
            .unwrap()
            .unwrap();
        let collected: String = detail
            .events
            .iter()
            .map(|event| event.message.clone())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(collected.contains(session_id), "会话事件应记录会话 id");
        assert!(
            collected.contains("FLOWLET_PI_STDIN_OK"),
            "Pi 应收到完整任务正文并回复约定文本"
        );
        assert!(summary["outputLines"].as_u64().unwrap_or(0) > 0);
        // 任务应回写待审核。
        assert_eq!(
            storage.get_task_status("task-integ").unwrap().as_deref(),
            Some("review")
        );
        // 集成测试也走 Pi 原生目录，只删除本次测试精确创建的会话文件。
        let session_file =
            validate_pi_session(&pi_native_session_dir().unwrap(), session_id, &prompt).unwrap();
        let _ = std::fs::remove_file(session_file);
        let _ = std::fs::remove_dir_all(&project_dir);
    }

    /// 真实环境集成测试：用本机已安装的 OpenCode CLI 完整跑一遍 execute_opencode，
    /// 验证 OpenCode 进程能启动、text 事件能累积、会话 id 能解析、任务能回写待审核。
    /// 需要本机已安装 OpenCode 且 Flowlet 代理在 18640 运行；正常测试默认跳过。
    #[tokio::test]
    #[ignore]
    async fn execute_opencode_integration_runs_real_opencode() {
        use crate::core::storage::Project;
        let storage = test_storage();
        let project_dir = std::env::temp_dir().join(format!(
            "flowlet-opencode-integration-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&project_dir).unwrap();
        storage
            .save_project(&Project {
                id: "project-opening".to_string(),
                name: "集成测试".to_string(),
                directory_path: Some(project_dir.to_string_lossy().into_owned()),
                workspace_project_id: None,
                workspace_archived: false,
                created_at: "2026-08-06T00:00:00Z".to_string(),
                updated_at: "2026-08-06T00:00:00Z".to_string(),
            })
            .unwrap();
        storage
            .create_job(
                "job-opening",
                "project-task-run",
                "任务执行：集成",
                "正在启动",
                "manual",
                1,
                "开始执行",
            )
            .unwrap();

        let mut task = task("集成测试");
        task.agent_profile = "OpenCode".to_string();
        task.id = "task-opening".to_string();
        task.project_id = "project-opening".to_string();
        task.status = "submitted".to_string();
        storage.save_project_task(&task).unwrap();

        let executable = resolve_agent_executable("OpenCode")
            .await
            .expect("OpenCode 应已安装");
        let outcome = execute_opencode(
            &storage,
            &executable,
            &task,
            "project-opening",
            "job-opening",
            "reply with exactly: OPENCODE_EXECUTED_OK",
            None,
            true,
        )
        .await
        .expect("execute_opencode 应成功执行");
        assert_eq!(outcome.job_status, "succeeded");
        // OpenCode 的 text 事件带 sessionID，summary 应含非空会话 id。
        let summary: serde_json::Value = serde_json::from_str(&outcome.summary_json).unwrap();
        let session_id = summary["sessionId"].as_str().unwrap_or("");
        assert!(!session_id.is_empty(), "OpenCode 应能解析会话 id");
        assert_eq!(
            storage.get_task_status("task-opening").unwrap().as_deref(),
            Some("review")
        );
        let _ = std::fs::remove_dir_all(&project_dir);
    }

    /// 真实环境集成测试：用本机已安装的 Codex CLI 完整跑一遍 execute_codex，
    /// 验证 Codex 进程能启动、`--json` 事件能累积、会话 id（`thread.started` 的
    /// `thread_id`）能解析、任务能回写待审核。
    /// 需要本机已安装 Codex CLI 且 Flowlet 代理在 18640 运行（Codex 默认模型走代理）；
    /// 正常测试默认跳过。
    #[tokio::test]
    #[ignore]
    async fn execute_codex_integration_runs_real_codex() {
        use crate::core::storage::Project;
        let storage = test_storage();
        let project_dir = std::env::temp_dir().join(format!(
            "flowlet-codex-integration-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&project_dir).unwrap();
        storage
            .save_project(&Project {
                id: "project-codex".to_string(),
                name: "集成测试".to_string(),
                directory_path: Some(project_dir.to_string_lossy().into_owned()),
                workspace_project_id: None,
                workspace_archived: false,
                created_at: "2026-08-06T00:00:00Z".to_string(),
                updated_at: "2026-08-06T00:00:00Z".to_string(),
            })
            .unwrap();
        storage
            .create_job(
                "job-codex",
                "project-task-run",
                "任务执行：集成",
                "正在启动",
                "manual",
                1,
                "开始执行",
            )
            .unwrap();

        let mut task = task("集成测试");
        task.agent_profile = "Codex".to_string();
        task.id = "task-codex".to_string();
        task.project_id = "project-codex".to_string();
        task.status = "submitted".to_string();
        storage.save_project_task(&task).unwrap();

        let executable = resolve_agent_executable("Codex")
            .await
            .expect("Codex 应已安装");
        let outcome = execute_codex(
            &storage,
            &executable,
            &task,
            "project-codex",
            "job-codex",
            "reply with exactly: CODEX_EXECUTED_OK",
            None,
            true,
        )
        .await
        .expect("execute_codex 应成功执行");
        assert_eq!(outcome.job_status, "succeeded");
        // Codex 的会话 id 即 --json 首条 thread.started 的 thread_id，summary 应含非空会话 id。
        let summary: serde_json::Value = serde_json::from_str(&outcome.summary_json).unwrap();
        let session_id = summary["sessionId"].as_str().unwrap_or("");
        assert!(!session_id.is_empty(), "Codex 应能解析会话 id");
        assert_eq!(
            storage.get_task_status("task-codex").unwrap().as_deref(),
            Some("review")
        );
        let _ = std::fs::remove_dir_all(&project_dir);
    }
}
