use super::super::*;

/// 启动 OpenCode 并读取 `run --format json` 事件输出，直到进程退出。
pub(in crate::core::agent_task_runner) async fn execute_opencode(
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
pub(in crate::core::agent_task_runner) fn process_opencode_line(
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
