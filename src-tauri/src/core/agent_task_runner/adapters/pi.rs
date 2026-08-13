use super::super::*;

/// Pi 原生会话目录。Flowlet 调度的任务与用户直接运行 Pi 一样写入这里，确保
/// Pi 自身以及 Flowlet 既有的会话枚举、时间线和用量同步都能读取同一份会话。
pub(in crate::core::agent_task_runner) fn pi_native_session_dir(
) -> Result<std::path::PathBuf, String> {
    dirs::home_dir()
        .map(|home| home.join(".pi").join("agent").join("sessions"))
        .ok_or_else(|| "无法确定 Pi 原生会话目录".to_string())
}

/// 解析 Pi 执行要用的会话 id：resume 时复用上次的，否则（首次/空值）生成新 UUID。
pub(in crate::core::agent_task_runner) fn execute_pi_session_id(
    resume_session: Option<&str>,
) -> Option<String> {
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
pub(in crate::core::agent_task_runner) fn validate_pi_session(
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
pub(in crate::core::agent_task_runner) async fn execute_pi(
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
