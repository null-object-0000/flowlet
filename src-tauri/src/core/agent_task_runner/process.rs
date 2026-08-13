use super::*;

/// 已启动的 Agent 子进程及其输出流。
pub(in crate::core::agent_task_runner) struct SpawnedAgent {
    child: tokio::process::Child,
    pub(in crate::core::agent_task_runner) stdin: Option<tokio::process::ChildStdin>,
    stdout: tokio::process::ChildStdout,
    stderr: tokio::process::ChildStderr,
}

/// 启动一个 Agent 子进程。`build` 闭包负责追加 Agent 专属参数；
/// 当前目录、stdin/stdout/stderr 管道、kill_on_drop 与 Windows 隐藏控制台统一处理。
pub(in crate::core::agent_task_runner) fn spawn_agent(
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
pub(in crate::core::agent_task_runner) fn record_started_execution(
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
pub(in crate::core::agent_task_runner) struct AgentProcessOutcome {
    pub(in crate::core::agent_task_runner) session_id: Option<String>,
    pub(in crate::core::agent_task_runner) cancelled: bool,
    pub(in crate::core::agent_task_runner) stderr_lines: Vec<String>,
    /// 最终累计输出行数（冲刷后统计）。
    pub(in crate::core::agent_task_runner) output_lines: usize,
}

/// 通用执行循环：读取 stdout 行交给 `on_stdout_line` 解析、收集 stderr、
/// 轮询取消请求。取消时 kill 进程并把任务回写草稿（与具体 Agent 无关的公共行为）。
///
/// `on_stdout_line` 负责把一行输出中的有用文本累积进 `text_buffer`，
/// 并在能识别出会话 id 时写入 `session_id`；文本统一按 `TEXT_FLUSH_THRESHOLD`
/// 落 job event。返回读取结果与已结束（或待 wait）的进程。
pub(in crate::core::agent_task_runner) async fn read_agent_output(
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
pub(in crate::core::agent_task_runner) async fn finish_agent_outcome(
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
