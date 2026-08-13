use super::super::*;

pub(in crate::core::agent_task_runner) async fn execute_deepseek_harness(
    storage: &Storage,
    executable: &str,
    task: &ProjectTask,
    project_id: &str,
    job_id: &str,
    prompt: &str,
    resume_session: Option<&str>,
    manage_task_state: bool,
) -> Result<ExecutionOutcome, String> {
    if resume_session.is_some_and(|value| !value.trim().is_empty()) {
        return Err("DeepSeek Harness headless 当前不提供稳定的 resume 参数；Flowlet 不会把续跑伪装成新会话。请将任务会话策略改为 fresh。".to_string());
    }
    let project_dir = required_project_dir(storage, project_id)?;
    let agent = spawn_agent(
        executable,
        &project_dir,
        "DeepSeek Harness",
        false,
        |command| {
            command.arg("--profile").arg("headless").arg(prompt);
        },
    )?;
    record_started_execution(storage, task, job_id, manage_task_state)?;
    let _ = storage.add_job_event(job_id, "info", "启动", "DeepSeek Harness 已以 headless profile 启动；当前版本仅支持 fresh task。Web UI 与 headless 共用 ~/.dsh 配置和会话存储。");
    let (outcome, mut child) = read_agent_output(
        storage,
        job_id,
        &task.id,
        agent,
        "DeepSeek Harness",
        manage_task_state,
        |_storage, _job_id, line, text_buffer, _session_id| {
            text_buffer.push_str(line);
            text_buffer.push('\n');
            Ok(())
        },
    )
    .await?;
    finish_agent_outcome(
        storage,
        task,
        "DeepSeek Harness",
        &mut child,
        AgentProcessOutcome {
            session_id: None,
            cancelled: outcome.cancelled,
            stderr_lines: outcome.stderr_lines,
            output_lines: outcome.output_lines,
        },
        manage_task_state,
    )
    .await
}
