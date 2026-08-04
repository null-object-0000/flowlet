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
use tauri::Emitter;

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
pub(crate) async fn run_project_task(
    storage: Storage,
    app_handle: tauri::AppHandle,
    project_id: String,
    task_id: String,
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
    // guard 在函数结束（含所有 await 点之后）drop 时释放槽。
    let _guard = AgentTaskRunningGuard;

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
    // 记录最近一次执行的 job，供只读详情展示 Agent 执行情况。
    storage
        .set_task_last_job(&task_id, &job_id)
        .map_err(|error| format!("记录任务执行日志失败：{error}"))?;

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
    let prompt = build_task_prompt(&task);
    let result = execute_agent(&storage, &app_handle, &executable, &task, &project_id, &job_id, &prompt).await;

    match result {
        Ok(outcome) => {
            storage
                .finish_job(&job_id, outcome.job_status, &outcome.summary_json, &outcome.done_message)
                .map_err(|error| format!("写入任务日志失败：{error}"))?;
        }
        Err(error) => {
            // 进程层异常：任务回退到已提交状态，下个周期重新排队。
            let _ = storage.set_task_status(&task_id, "submitted");
            let _ = storage.fail_job(&job_id, &error);
            return Err(error);
        }
    }

    Ok(RunProjectTaskResult {
        started: true,
        job_id: Some(job_id),
        message: "任务已开始执行".to_string(),
    })
}

/// 组装发给 Claude Code 的任务 prompt。
fn build_task_prompt(task: &ProjectTask) -> String {
    let mut prompt = String::new();
    prompt.push_str("你是由 Flowlet 调度执行的编程 Agent，请在当前项目目录内完成以下任务。\n\n");
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
    app_handle: &tauri::AppHandle,
    executable: &str,
    task: &ProjectTask,
    project_id: &str,
    job_id: &str,
    prompt: &str,
) -> Result<ExecutionOutcome, String> {
    let project = storage
        .get_project(project_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "项目不存在".to_string())?;
    let project_dir = std::path::PathBuf::from(&project.directory_path);

    let mut command = build_claude_command(executable);
    command
        .arg("-p")
        .arg(prompt)
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose")
        .arg("--dangerously-skip-permissions")
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
                            process_stream_event(storage, app_handle, job_id, task, &value, &mut text_buffer, &mut session_id)?;
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
    flush_text(storage, app_handle, job_id, task, &mut text_buffer)?;

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

/// 解析 stream-json 的单个事件行，把有用的文本累积并定时落日志 / 推送前端。
fn process_stream_event(
    storage: &Storage,
    app_handle: &tauri::AppHandle,
    job_id: &str,
    task: &ProjectTask,
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
                                flush_text(storage, app_handle, job_id, task, text_buffer)?;
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

/// 把累积文本写入一条 job event，并 emit 到前端（进行中卡片实时展示）。
fn flush_text(
    storage: &Storage,
    app_handle: &tauri::AppHandle,
    job_id: &str,
    task: &ProjectTask,
    text_buffer: &mut String,
) -> Result<(), String> {
    let text = std::mem::take(text_buffer);
    if text.trim().is_empty() {
        return Ok(());
    }
    storage
        .add_job_event(job_id, "info", "输出", &text)
        .map_err(|error| error.to_string())?;
    let _ = app_handle.emit(
        "project-task-log",
        serde_json::json!({
            "projectId": task.project_id,
            "taskId": task.id,
            "jobId": job_id,
            "text": text,
            "at": chrono::Utc::now().to_rfc3339(),
        }),
    );
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

/// 供 summary 记录输出行数（截断后的完整累积量）。
fn text_buffer_lines(text: &str) -> usize {
    text.lines().count()
}
