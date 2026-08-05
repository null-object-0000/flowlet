//! Agent 任务执行核心：驱动 Claude Code CLI 执行项目任务。
//!
//! 全局唯一执行槽：整个 Flowlet 同一时刻至多一个任务在执行，其余排队。
//! 第一版只支持 Claude Code，以非交互 `-p` + `--output-format stream-json`
//! 执行，权限走 bypassPermissions（`--dangerously-skip-permissions`）。
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
            message: "已有任务在执行中，请稍后重试".to_string(),
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

    // 3. 解析 Claude Code 可执行文件（复用安装探测，未安装返回明确错误）。
    let executable = resolve_claude_executable().await?;

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

/// 解析 Claude Code 可执行路径。未安装返回明确错误。
async fn resolve_claude_executable() -> Result<String, String> {
    let report = crate::core::agent_environment::detect_agent_environment("claude-code")
        .await
        .map_err(|error| format!("检测 Claude Code 失败：{error}"))?;
    if !report.installed {
        return Err("未检测到 Claude Code，请先在设置页完成接入后重试。".to_string());
    }
    report
        .primary
        .map(|installation| installation.executable_path)
        .ok_or_else(|| "未检测到 Claude Code 可执行文件".to_string())
}

/// 启动 Claude Code 并持续读取 stream-json 输出，直到进程退出。
async fn execute_agent(
    storage: &Storage,
    executable: &str,
    task: &ProjectTask,
    project_id: &str,
    job_id: &str,
    prompt: &str,
    resume_session: Option<&str>,
) -> Result<ExecutionOutcome, String> {
    let project = storage
        .get_project(project_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "项目不存在".to_string())?;
    // 只有绑定本机目录的项目能被调度器领取执行；兜底拦截未绑定项目。
    let project_dir = std::path::PathBuf::from(
        project
            .directory_path
            .as_deref()
            .ok_or_else(|| "项目未绑定本机目录，无法执行".to_string())?,
    );

    let mut command = build_claude_command(executable);
    command
        .arg("-p")
        .arg(prompt)
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose")
        .arg("--dangerously-skip-permissions");
    // 会话显示名：`-p` 非交互模式不会自动生成 ai-title，必须显式传 --name，
    // 否则会话在 Flowlet 列表 / resume 里没有名称。值用任务标题，便于识别。
    let session_name = build_session_name(task);
    command.arg("--name").arg(session_name);
    // 退回重跑复用上次会话：Agent 带着之前的上下文 + 本轮注入的退回原因继续修正。
    // --name 也会一并传入，覆盖旧名称（custom-title 语义为 last-wins）。
    if let Some(session) = resume_session {
        command.arg("--resume").arg(session);
    }
    command
        .current_dir(&project_dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    crate::core::agent_environment::configure_hidden_console(&mut command);

    let mut child = command
        .spawn()
        .map_err(|error| format!("无法启动 Claude Code（{executable}）：{error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "无法连接 Claude Code 标准输出".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "无法连接 Claude Code 标准错误".to_string())?;

    // stderr 单独读，收集到 channel，最后失败时并入完成信息。
    let (stderr_tx, mut stderr_rx) = tokio::sync::mpsc::channel(64);
    {
        let stderr_tx = stderr_tx;
        tauri::async_runtime::spawn(async move {
            use tokio::io::{AsyncBufReadExt, BufReader};
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if stderr_tx.send(line).await.is_err() {
                    break;
                }
            }
        });
    }

    use tokio::io::{AsyncBufReadExt, BufReader};
    let mut lines = BufReader::new(stdout).lines();
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
                    let _ = storage.set_task_status(&task.id, "draft");
                    let summary = serde_json::json!({
                        "cancelled": true,
                        "sessionId": session_id,
                    }).to_string();
                    return Ok(ExecutionOutcome {
                        job_status: "cancelled",
                        summary_json: summary,
                        done_message: "任务已取消，已回到草稿".to_string(),
                    });
                }
            }
            line = lines.next_line() => {
                match line {
                    Ok(Some(line)) => {
                        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) {
                            process_stream_event(storage, job_id, &value, &mut text_buffer, &mut session_id)?;
                        }
                    }
                    Ok(None) => break,
                    Err(error) => return Err(format!("读取 Claude Code 输出失败：{error}")),
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

    // 冲刷剩余的累积文本。
    flush_text(storage, job_id, &mut text_buffer)?;

    let status = child
        .wait()
        .await
        .map_err(|error| format!("等待 Claude Code 退出失败：{error}"))?;
    let success = status.success();
    let exit_code = status.code().unwrap_or(-1);

    // Agent 退出后自动回写待审核：无论成功或失败，都交由人类在待审核阶段判断。
    storage
        .set_task_status(&task.id, "review")
        .map_err(|error| format!("标记任务待审核失败：{error}"))?;

    let error_snippet = if success {
        String::new()
    } else {
        let joined = stderr_lines.join("\n");
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
        "sessionId": session_id,
        "outputLines": text_buffer_lines(&text_buffer),
    })
    .to_string();

    Ok(ExecutionOutcome {
        job_status: if success { "succeeded" } else { "failed" },
        summary_json: summary,
        done_message,
    })
}

/// 解析 stream-json 的单个事件行，把有用的文本累积并定时落 job event（供只读详情展示）。
fn process_stream_event(
    storage: &Storage,
    job_id: &str,
    value: &serde_json::Value,
    text_buffer: &mut String,
    session_id: &mut Option<String>,
) -> Result<(), String> {
    let event_type = value.get("type").and_then(serde_json::Value::as_str).unwrap_or("");
    match event_type {
        "system" => {
            if value.get("subtype").and_then(serde_json::Value::as_str) == Some("init") {
                if let Some(id) = value.get("session_id").and_then(serde_json::Value::as_str) {
                    *session_id = Some(id.to_string());
                    storage
                        .add_job_event(job_id, "info", "会话", &format!("Claude Code 会话已初始化：{id}"))
                        .map_err(|error| error.to_string())?;
                }
            }
        }
        "assistant" => {
            if let Some(content) = value.pointer("/message/content").and_then(serde_json::Value::as_array) {
                for block in content {
                    if block.get("type").and_then(serde_json::Value::as_str) == Some("text") {
                        if let Some(text) = block.get("text").and_then(serde_json::Value::as_str) {
                            text_buffer.push_str(text);
                            if text_buffer.len() >= TEXT_FLUSH_THRESHOLD {
                                flush_text(storage, job_id, text_buffer)?;
                            }
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

/// 构建启动 Claude Code 的命令。Windows 下 .cmd / .bat / .ps1 垫片需要
/// 通过宿主解释器启动（与 agent_environment 的版本探测一致）。
#[cfg(windows)]
fn build_claude_command(executable: &str) -> tokio::process::Command {
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
fn build_claude_command(executable: &str) -> tokio::process::Command {
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
}
