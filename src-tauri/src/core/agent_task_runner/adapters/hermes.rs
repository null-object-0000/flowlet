use super::super::*;

// Hermes Agent 以非交互一次性模式执行任务：`hermes chat --oneshot --yolo -q <prompt>`。
// `--oneshot` 让查询完成后退出；`--yolo` 跳过危险命令确认，等价于 Claude Code 的
// `--dangerously-skip-permissions` / Codex 的 `--dangerously-bypass-approvals-and-sandbox`；
// `-q` 以参数形式传入任务 prompt（不会被当作斜杠命令或 shell 转义）。进程在项目目录内
// 运行，模型请求经 Flowlet 本地代理进入日志与用量账本。
pub(in crate::core::agent_task_runner) async fn execute_hermes(
    storage: &Storage,
    executable: &str,
    task: &ProjectTask,
    project_id: &str,
    job_id: &str,
    prompt: &str,
    _resume_session: Option<&str>,
    manage_task_state: bool,
) -> Result<ExecutionOutcome, String> {
    let project_dir = required_project_dir(storage, project_id)?;
    let agent = spawn_agent(executable, &project_dir, "Hermes Agent", false, |command| {
        command.arg("chat").arg("--oneshot").arg("--yolo").arg("-q").arg(prompt);
    })?;
    record_started_execution(storage, task, job_id, manage_task_state)?;
    let _ = storage.add_job_event(
        job_id,
        "info",
        "启动",
        "Hermes Agent 已以一次性模式启动（hermes chat --oneshot --yolo）；当前版本仅支持 fresh 任务。",
    );
    let (outcome, mut child) = read_agent_output(
        storage,
        job_id,
        &task.id,
        agent,
        "Hermes Agent",
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
        "Hermes Agent",
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
