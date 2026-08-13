use super::super::*;

/// 启动 Claude Code 并持续读取 stream-json 输出，直到进程退出。
pub(in crate::core::agent_task_runner) async fn execute_claude_code(
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
pub(in crate::core::agent_task_runner) fn process_claude_line(
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
