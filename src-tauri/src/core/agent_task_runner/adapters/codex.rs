use super::super::*;

/// 启动 Codex CLI 并读取 `exec --json` 事件输出，直到进程退出。
///
/// 新会话：`codex exec <prompt>`；退回重跑复用上次会话：`codex exec resume <session> <prompt>`
/// （Codex 不保留上次执行参数，resume 时必须重新传入放行与 JSON 输出参数）。
/// 会话 id 即 `--json` 首条 `thread.started` 事件的 `thread_id`，可用于后续 resume。
/// `--dangerously-bypass-approvals-and-sandbox` 非交互自动放行并关闭沙箱（等价于
/// Claude Code `--dangerously-skip-permissions` / OpenCode `--auto`）；`--skip-git-repo-check`
/// 允许在非 git 目录执行（项目目录不保证是 git 仓库）。
pub(in crate::core::agent_task_runner) async fn execute_codex(
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
pub(in crate::core::agent_task_runner) fn process_codex_line(
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
