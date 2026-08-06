//! Agent 任务执行核心：按任务 `agent_profile` 驱动 Claude Code / OpenCode / Pi
//! CLI 在项目目录内执行项目任务。
//!
//! 全局唯一执行槽：整个 Flowlet 同一时刻至多一个任务在执行，其余排队。
//! 三种 Agent 都以非交互模式执行（Claude Code `-p --output-format stream-json`、
//! OpenCode `run --format json`、Pi `-p`），权限走各 CLI 的非交互放行参数
//! （`--dangerously-skip-permissions` / `--auto` / `--approve`）。
//! 执行过程中的模型请求会经过 Flowlet 本地代理，自动进入请求日志与用量账本。
//! Agent 退出后由 Rust 自动把任务状态回写 `review`（等待人工审核）。

use crate::core::storage::{ProjectTask, Storage};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
#[cfg(desktop)]
use tauri::AppHandle;

/// 任务执行完成进入待审核时是否发送系统通知的全局设置键（app_meta）。默认开启。
pub(crate) const TASK_REVIEW_NOTIFICATION_KEY: &str = "task_review_notification_enabled";

/// 全局唯一执行槽：`true` 表示已有任务在跑。
pub(crate) static AGENT_TASK_RUNNING: AtomicBool = AtomicBool::new(false);

/// 当前运行中的任务信息，供前端查询。
static AGENT_TASK_CURRENT: Mutex<Option<RunningTaskInfo>> = Mutex::new(None);

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
    pub running: bool,
    pub current: Option<RunningTaskInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunProjectTaskResult {
    pub started: bool,
    pub job_id: Option<String>,
    pub message: String,
}

/// 执行结束的汇总信息，用于 finish_job。
struct ExecutionOutcome {
    job_status: &'static str,
    summary_json: String,
    done_message: String,
}

struct AgentTaskRunningGuard;

impl Drop for AgentTaskRunningGuard {
    fn drop(&mut self) {
        AGENT_TASK_RUNNING.store(false, Ordering::Release);
        if let Ok(mut current) = AGENT_TASK_CURRENT.lock() {
            *current = None;
        }
    }
}

/// 查询执行槽状态（是否空闲、当前在跑的任务）。
pub(crate) fn task_runner_state() -> ProjectTaskRunnerState {
    ProjectTaskRunnerState {
        running: AGENT_TASK_RUNNING.load(Ordering::Acquire),
        current: AGENT_TASK_CURRENT
            .lock()
            .ok()
            .and_then(|guard| guard.clone()),
    }
}

/// 尝试领取并执行一个项目任务。
///
/// 返回 `started: true` 表示抢到全局执行槽并已开始执行；`started: false`
/// 表示槽被占用或任务状态不允许，调用方应下个周期重试。
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
    // 1. 抢全局唯一执行槽（并发安全下沉 Rust，参考 AGENT_DATA_SYNC_RUNNING 模式）。
    if AGENT_TASK_RUNNING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Ok(RunProjectTaskResult {
            started: false,
            job_id: None,
            message: "已有任务在执行中，任务已进入队列等待".to_string(),
        });
    }
    // 执行槽在准备阶段持有，随后台执行任务 move，Agent 结束后 drop 释放。
    let guard = AgentTaskRunningGuard;

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

    // 2.5. 跨设备领取：把任务归属标记为本机。被其他设备在租约窗口内领取时拒绝，
    //      防止多台绑定了同一目录的设备对同一任务重复执行。
    if !storage
        .claim_task(&task_id, &current_device_id)
        .map_err(|error| format!("标记任务领取失败：{error}"))?
    {
        return Ok(RunProjectTaskResult {
            started: false,
            job_id: None,
            message: "该任务正由其他设备执行中，请稍后重试".to_string(),
        });
    }

    // 3. 解析任务指定 Agent 的可执行文件（复用安装探测，未安装返回明确错误）。
    let executable = resolve_agent_executable(&task.agent_profile).await?;

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
    // 记录最近一次执行的 job + 追加执行历史，供只读详情展示 Agent 执行情况。
    storage
        .set_task_last_job(&task_id, &job_id)
        .map_err(|error| format!("记录任务执行日志失败：{error}"))?;
    let _ = storage.append_task_execution(&task_id, &job_id, &task.updated_at);

    // 6. 记录当前运行信息供前端查询。
    if let Ok(mut current) = AGENT_TASK_CURRENT.lock() {
        *current = Some(RunningTaskInfo {
            project_id: project_id.clone(),
            task_id: task_id.clone(),
            task_title: task.title.clone(),
            agent_profile: task.agent_profile.clone(),
            job_id: job_id.clone(),
            started_at: chrono::Utc::now().to_rfc3339(),
        });
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
    let task_title = task.title.clone();
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
        )
        .await;
        match result {
            Ok(outcome) => {
                let _ = storage
                    .finish_job(&spawned_job_id, outcome.job_status, &outcome.summary_json, &outcome.done_message);
                // Agent 执行结束（成功或失败）后任务进入待审核，此时发系统通知提醒审核；
                // 取消路径会回到草稿，不进入待审核，不通知。用户可在全局设置关闭该通知。
                if outcome.job_status != "cancelled" {
                    notify_task_review(&notify_app, &storage, &task_title);
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
        "readonly" => prompt.push_str("任务类型：只读分析。请不要修改任何文件，只读取与分析，并在结尾给出结论。\n"),
        _ => prompt.push_str("任务类型：代码修改。\n"),
    }
    prompt.push_str("\n完成后，请简要总结你做了什么、修改了哪些文件以及最终结论。");
    prompt
}

/// 会话显示名上限（字符数）。CLI 内部对名称清理控制字符后截断到 200 字符
/// （`efn` 处理），这里在发送前先清理并截短，避免超长任务标题撑大命令行参数。
const MAX_SESSION_NAME_CHARS: usize = 80;

/// 生成 Claude Code 会话显示名：`任务：<任务标题>`。
/// 清理控制字符（与 CLI 内部 `efn` 的 `[\x00-\x1f\x7f-\x9f]` 一致），
/// 并按字符截断，避免脏标题进入会话名。空标题回退为 `任务`。
fn build_session_name(task: &ProjectTask) -> String {
    let cleaned: String = task
        .title
        .chars()
        .filter(|ch| !ch.is_control())
        .collect();
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
fn session_from_job(
    storage: &Storage,
    job_id: Option<&str>,
) -> Result<Option<String>, String> {
    let Some(job_id) = job_id else {
        return Ok(None);
    };
    let Some(detail) = storage
        .get_background_job_detail(job_id)
        .map_err(|error| format!("读取上次执行记录失败：{error}"))?
    else {
        return Ok(None);
    };
    let Some(summary) = detail.job.summary_json else {
        return Ok(None);
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&summary) else {
        return Ok(None);
    };
    Ok(value
        .get("sessionId")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string))
}

/// 任务 Agent Profile 对应的 `agent_environment` agent_id 与展示名。
/// 与前端 `AGENT_PROFILES`（ProjectsPage.tsx）保持一致；空串视为 Claude Code
/// （历史任务在 `agent_profile` 列引入前的默认值），未知 Profile 返回 None，
/// 由调用方给出明确错误。
fn agent_profile_meta(agent_profile: &str) -> Option<(&'static str, &'static str)> {
    match agent_profile.trim() {
        "" | "Claude Code" => Some(("claude-code", "Claude Code")),
        "OpenCode" => Some(("opencode", "OpenCode")),
        "Pi" => Some(("pi", "Pi")),
        _ => None,
    }
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
    report
        .primary
        .map(|installation| installation.executable_path)
        .ok_or_else(|| format!("未检测到 {agent_name} 可执行文件"))
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
) -> Result<ExecutionOutcome, String> {
    match task.agent_profile.as_str() {
        "OpenCode" => {
            execute_opencode(storage, executable, task, project_id, job_id, prompt, resume_session)
                .await
        }
        "Pi" => {
            execute_pi(storage, executable, task, project_id, job_id, prompt, resume_session).await
        }
        _ => {
            execute_claude_code(
                storage, executable, task, project_id, job_id, prompt, resume_session,
            )
            .await
        }
    }
}

/// 读取项目并校验本机目录绑定，返回项目目录（所有执行器共用的前置校验）。
fn required_project_dir(storage: &Storage, project_id: &str) -> Result<std::path::PathBuf, String> {
    let project = storage
        .get_project(project_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "项目不存在".to_string())?;
    // 只有绑定本机目录的项目能被调度器领取执行；兜底拦截未绑定项目。
    Ok(std::path::PathBuf::from(
        project
            .directory_path
            .as_deref()
            .ok_or_else(|| "项目未绑定本机目录，无法执行".to_string())?,
    ))
}

/// 已启动的 Agent 子进程及其输出流。
struct SpawnedAgent {
    child: tokio::process::Child,
    stdout: tokio::process::ChildStdout,
    stderr: tokio::process::ChildStderr,
}

/// 启动一个 Agent 子进程。`build` 闭包负责追加 Agent 专属参数；
/// 当前目录、stdin/stdout/stderr 管道、kill_on_drop 与 Windows 隐藏控制台统一处理。
fn spawn_agent(
    executable: &str,
    project_dir: &std::path::Path,
    display_name: &str,
    build: impl FnOnce(&mut tokio::process::Command),
) -> Result<SpawnedAgent, String> {
    let mut command = build_agent_command(executable);
    build(&mut command);
    command
        .current_dir(project_dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    crate::core::agent_environment::configure_hidden_console(&mut command);
    let mut child = command
        .spawn()
        .map_err(|error| format!("无法启动 {display_name}（{executable}）：{error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| format!("无法连接 {display_name} 标准输出"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| format!("无法连接 {display_name} 标准错误"))?;
    Ok(SpawnedAgent {
        child,
        stdout,
        stderr,
    })
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
                    let _ = storage.set_task_status(task_id, "draft");
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
    let output_lines = text_buffer_lines(&text_buffer);
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
    storage
        .set_task_status(&task.id, "review")
        .map_err(|error| format!("标记任务待审核失败：{error}"))?;

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
        "任务执行完成，等待审核".to_string()
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
) -> Result<ExecutionOutcome, String> {
    let project_dir = required_project_dir(storage, project_id)?;
    // 会话显示名：`-p` 非交互模式不会自动生成 ai-title，必须显式传 --name，
    // 否则会话在 Flowlet 列表 / resume 里没有名称。值用任务标题，便于识别。
    let session_name = build_session_name(task);
    let agent = spawn_agent(executable, &project_dir, "Claude Code", |command| {
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

    let (outcome, mut child) =
        read_agent_output(storage, job_id, &task.id, agent, "Claude Code", process_claude_line)
            .await?;
    finish_agent_outcome(storage, task, "Claude Code", &mut child, outcome).await
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

/// 启动 OpenCode 并读取 `run --format json` 事件输出，直到进程退出。
async fn execute_opencode(
    storage: &Storage,
    executable: &str,
    task: &ProjectTask,
    project_id: &str,
    job_id: &str,
    prompt: &str,
    resume_session: Option<&str>,
) -> Result<ExecutionOutcome, String> {
    let project_dir = required_project_dir(storage, project_id)?;
    // 会话显示名：`run` 默认用截断后的 prompt 当标题，任务场景显式传 --title。
    let session_name = build_session_name(task);
    let agent = spawn_agent(executable, &project_dir, "OpenCode", |command| {
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

    let (outcome, mut child) = read_agent_output(
        storage,
        job_id,
        &task.id,
        agent,
        "OpenCode",
        |storage, job_id, line, text_buffer, session_id| {
            process_opencode_line(storage, job_id, line, text_buffer, session_id)
        },
    )
    .await?;
    finish_agent_outcome(storage, task, "OpenCode", &mut child, outcome).await
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
        if let Some(text) = value.pointer("/part/text").and_then(serde_json::Value::as_str) {
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

/// Pi 任务会话目录：`~/.flowlet/pi-task-sessions/<project_id>`。
/// 用 `--session-dir` 把 Flowlet 调度的会话与用户主 Pi 会话列表隔离。
fn pi_task_session_dir(project_id: &str) -> Result<std::path::PathBuf, String> {
    dirs::home_dir()
        .map(|home| {
            home.join(".flowlet")
                .join("pi-task-sessions")
                .join(project_id)
        })
        .ok_or_else(|| "无法确定 Pi 任务会话目录".to_string())
}

/// 解析 Pi 执行要用的会话 id：resume 时复用上次的，否则（首次/空值）生成新 UUID。
fn execute_pi_session_id(resume_session: Option<&str>) -> Option<String> {
    match resume_session {
        Some(session) if !session.trim().is_empty() => Some(session.trim().to_string()),
        _ => Some(uuid::Uuid::new_v4().to_string()),
    }
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
) -> Result<ExecutionOutcome, String> {
    let project_dir = required_project_dir(storage, project_id)?;
    let session_dir = pi_task_session_dir(project_id)?;
    std::fs::create_dir_all(&session_dir)
        .map_err(|error| format!("创建 Pi 任务会话目录失败：{error}"))?;
    // 会话 id 在执行前确定：首次用新 UUID，resume 用上次的。
    let session_uuid = execute_pi_session_id(resume_session)
        .ok_or_else(|| "无法生成 Pi 会话 id".to_string())?;
    let session_name = build_session_name(task);
    let agent = spawn_agent(executable, &project_dir, "Pi", |command| {
        command
            .arg("-p")
            .arg(prompt)
            // 信任项目本地文件（AGENTS.md / CLAUDE.md）：Pi headless 模式默认忽略它们。
            .arg("--approve")
            .arg("--name")
            .arg(session_name)
            // 指定精确会话 id：首次创建该 id 的会话，resume 继续同一会话。
            .arg("--session-id")
            .arg(&session_uuid)
            .arg("--session-dir")
            .arg(&session_dir);
    })?;
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
        Some(session_uuid)
    };
    if let Some(id) = &session_id {
        let _ = storage.add_job_event(job_id, "info", "会话", &format!("Pi 会话：{id}"));
    }
    let outcome = AgentProcessOutcome {
        session_id,
        cancelled: outcome.cancelled,
        stderr_lines: outcome.stderr_lines,
        output_lines: outcome.output_lines,
    };
    finish_agent_outcome(storage, task, "Pi", &mut child, outcome).await
}

/// 把累积文本写入一条 job event（供只读详情 / 任务日志页展示）。
fn flush_text(
    storage: &Storage,
    job_id: &str,
    text_buffer: &mut String,
) -> Result<(), String> {
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
        command
            .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", executable]);
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
/// 通知失败只记录日志，不影响任务执行流程。
#[cfg(desktop)]
fn notify_task_review(app: &AppHandle, storage: &Storage, task_title: &str) {
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
    use tauri_plugin_notification::NotificationExt;
    let result = app
        .notification()
        .builder()
        .title("任务执行完成")
        .body(format!("任务「{}」执行完成，等待审核", truncate(task_title, 50)))
        .show();
    match result {
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
        assert_eq!(resolve_resume_session(&storage, &fresh, None).unwrap(), None);
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
        assert_eq!(agent_profile_meta("OpenCode"), Some(("opencode", "OpenCode")));
        assert_eq!(agent_profile_meta("Pi"), Some(("pi", "Pi")));
        assert_eq!(agent_profile_meta("Unknown Agent"), None);
        // 空串是历史任务在 agent_profile 列引入前的默认值，视为 Claude Code。
        assert_eq!(agent_profile_meta(""), Some(("claude-code", "Claude Code")));
        assert_eq!(agent_profile_meta("   "), Some(("claude-code", "Claude Code")));
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
    fn pi_session_dir_is_scoped_to_project() {
        let dir = pi_task_session_dir("project-1").unwrap();
        let tail: Vec<String> = dir
            .components()
            .rev()
            .take(3)
            .map(|component| component.as_os_str().to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            tail,
            vec![
                "project-1".to_string(),
                "pi-task-sessions".to_string(),
                ".flowlet".to_string()
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

    /// 真实环境集成测试：用本机已安装的 Pi CLI 完整跑一遍 execute_pi，
    /// 验证 Pi 进程能启动、输出能累积、任务能回写待审核、会话 id 能发现。
    /// 需要本机已安装 Pi 且 Flowlet 代理在 18640 运行；正常测试默认跳过。
    #[tokio::test]
    #[ignore]
    async fn execute_pi_integration_runs_real_pi() {
        use crate::core::storage::Project;
        let storage = test_storage();
        // 用临时目录作为项目目录，避免污染真实项目。
        let project_dir = std::env::temp_dir().join(format!(
            "flowlet-pi-integration-{}",
            uuid::Uuid::new_v4()
        ));
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
        task.title = "任务支持委派给 OpenCode 和 Pi 去执行".to_string();
        task.description = "参考已有委派给 Claude Code 执行的所有能力".to_string();
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
        let detail = storage.get_background_job_detail("job-integ").unwrap().unwrap();
        let collected: String = detail
            .events
            .iter()
            .map(|event| event.message.clone())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(collected.contains(session_id), "会话事件应记录会话 id");
        assert!(summary["outputLines"].as_u64().unwrap_or(0) > 0);
        // 任务应回写待审核。
        assert_eq!(
            storage
                .get_task_status("task-integ")
                .unwrap()
                .as_deref(),
            Some("review")
        );
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
        )
        .await
        .expect("execute_opencode 应成功执行");
        assert_eq!(outcome.job_status, "succeeded");
        // OpenCode 的 text 事件带 sessionID，summary 应含非空会话 id。
        let summary: serde_json::Value = serde_json::from_str(&outcome.summary_json).unwrap();
        let session_id = summary["sessionId"].as_str().unwrap_or("");
        assert!(!session_id.is_empty(), "OpenCode 应能解析会话 id");
        assert_eq!(
            storage
                .get_task_status("task-opening")
                .unwrap()
                .as_deref(),
            Some("review")
        );
        let _ = std::fs::remove_dir_all(&project_dir);
    }
}
