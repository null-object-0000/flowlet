use super::adapters::claude_code::process_claude_line;
use super::adapters::codex::{execute_codex, process_codex_line};
use super::adapters::opencode::{execute_opencode, process_opencode_line};
use super::adapters::pi::{
    execute_pi, execute_pi_session_id, pi_native_session_dir, validate_pi_session,
};
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
        queue_boosted_at: None,
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

#[test]
fn project_directory_error_identifies_stale_local_binding() {
    use crate::core::storage::Project;

    let storage = test_storage();
    let missing =
        std::env::temp_dir().join(format!("flowlet-missing-project-{}", uuid::Uuid::new_v4()));
    storage
        .save_project(&Project {
            id: "stale-project".to_string(),
            name: "旧路径项目".to_string(),
            directory_path: Some(missing.to_string_lossy().into_owned()),
            workspace_project_id: None,
            workspace_archived: false,
            created_at: "2026-08-08T00:00:00Z".to_string(),
            updated_at: "2026-08-08T00:00:00Z".to_string(),
        })
        .unwrap();

    let error = required_project_dir(&storage, "stale-project").unwrap_err();
    assert!(error.contains("项目绑定的本机目录不存在或不是文件夹"));
    assert!(error.contains(missing.to_string_lossy().as_ref()));
    assert!(error.contains("重新绑定目录"));
}

#[test]
fn queue_report_excludes_stale_directory_and_preserves_blocker() {
    use crate::core::storage::Project;

    let storage = test_storage();
    let missing =
        std::env::temp_dir().join(format!("flowlet-missing-project-{}", uuid::Uuid::new_v4()));
    storage
        .save_project(&Project {
            id: "stale-project".to_string(),
            name: "旧路径项目".to_string(),
            directory_path: Some(missing.to_string_lossy().into_owned()),
            workspace_project_id: None,
            workspace_archived: false,
            created_at: "2026-08-08T00:00:00Z".to_string(),
            updated_at: "2026-08-08T00:00:00Z".to_string(),
        })
        .unwrap();
    let mut queued_task = task("无法执行的任务");
    queued_task.id = "blocked-task".to_string();
    queued_task.project_id = "stale-project".to_string();

    let report = project_task_queue_report(&storage, vec![queued_task]);

    assert!(report.tasks.is_empty());
    assert_eq!(report.blockers.len(), 1);
    assert_eq!(report.blockers[0].task_id, "blocked-task");
    assert_eq!(report.blockers[0].code, "project_directory_unavailable");
    assert!(report.blockers[0].message.contains("重新绑定目录"));
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

fn unfinished_job_with_session_event(storage: &Storage, job_id: &str, session_id: &str) {
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
    storage
        .add_job_event(
            job_id,
            "info",
            "会话",
            &format!("Claude Code 会话已初始化：{session_id}"),
        )
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
fn prompt_tells_resumed_session_to_continue_from_interruption() {
    let mut interrupted = task("继续修复");
    interrupted.execution_history = Some(
        serde_json::json!([{
            "jobId": "job-before-restart",
            "interrupted": true
        }])
        .to_string(),
    );

    let prompt = build_task_prompt(&interrupted, None, None);

    assert!(prompt.contains("本次已恢复同一个 Agent 会话"));
    assert!(prompt.contains("从中断位置继续"));
    assert!(prompt.contains("不要重复已经完成的工作"));
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
fn resume_falls_back_to_session_event_when_job_was_interrupted() {
    let storage = test_storage();
    unfinished_job_with_session_event(&storage, "interrupted-job", "session-before-restart");
    let mut rerun = task("应用重启后继续");
    rerun.last_job_id = Some("interrupted-job".to_string());

    assert_eq!(
        resolve_resume_session(&storage, &rerun, None).unwrap(),
        Some("session-before-restart".to_string())
    );
}

#[test]
fn resume_does_not_restore_a_cancelled_job_event() {
    let storage = test_storage();
    unfinished_job_with_session_event(&storage, "cancelled-job", "cancelled-session");
    storage
        .finish_job(
            "cancelled-job",
            "cancelled",
            r#"{"cancelled":true,"sessionId":null}"#,
            "任务已取消",
        )
        .unwrap();
    let mut rerun = task("取消后重新提交");
    rerun.last_job_id = Some("cancelled-job".to_string());

    assert_eq!(
        resolve_resume_session(&storage, &rerun, None).unwrap(),
        None
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
    assert_eq!(
        resolve_resume_session(&storage, &fresh, None).unwrap(),
        None
    );
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
    // Codex 复用 chatgpt-desktop 的探测（含 Codex CLI 与 ChatGPT Desktop），
    // 执行时 resolve_agent_executable 会优先选 CLI 表面的安装。
    assert_eq!(
        agent_profile_meta("Codex"),
        Some(("chatgpt-desktop", "Codex"))
    );
    assert_eq!(
        agent_profile_meta("OpenCode"),
        Some(("opencode", "OpenCode"))
    );
    assert_eq!(agent_profile_meta("Pi"), Some(("pi", "Pi")));
    assert_eq!(agent_profile_meta("Unknown Agent"), None);
    // 空串是历史任务在 agent_profile 列引入前的默认值，视为 Claude Code。
    assert_eq!(agent_profile_meta(""), Some(("claude-code", "Claude Code")));
    assert_eq!(
        agent_profile_meta("   "),
        Some(("claude-code", "Claude Code"))
    );
    assert_eq!(
        adapters::for_profile("Codex").map(|adapter| adapter.id),
        Some("codex")
    );
    assert!(adapters::for_profile("Unknown Agent").is_none());
    assert!(adapters::has("pi"));
    assert!(!adapters::has("Unknown Agent"));
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
fn codex_line_captures_thread_id_and_agent_message() {
    let storage = test_storage();
    let mut buffer = String::new();
    let mut session_id = None;
    // thread.started：捕获 thread_id 作为会话 id（Codex resume 用），并记录会话事件。
    process_codex_line(
        &storage,
        "job-1",
        r#"{"type":"thread.started","thread_id":"019fd700-0000-4000-8000-000000000001"}"#,
        &mut buffer,
        &mut session_id,
    )
    .unwrap();
    assert_eq!(
        session_id.as_deref(),
        Some("019fd700-0000-4000-8000-000000000001")
    );
    // item.completed 的 agent_message：累积 item.text。
    process_codex_line(
        &storage,
        "job-1",
        r#"{"type":"item.completed","item":{"id":"1","type":"agent_message","text":"分析完成"}}"#,
        &mut buffer,
        &mut session_id,
    )
    .unwrap();
    assert_eq!(buffer, "分析完成");
    // 会话事件只记录一次：后续 thread.started 不再重复写事件。
    let mut buffer2 = String::new();
    let mut session_id2 = Some("019fd700-0000-4000-8000-000000000001".to_string());
    process_codex_line(
        &storage,
        "job-1",
        r#"{"type":"thread.started","thread_id":"019fd700-0000-4000-8000-000000000001"}"#,
        &mut buffer2,
        &mut session_id2,
    )
    .unwrap();
    assert!(buffer2.is_empty());
}

#[test]
fn codex_line_ignores_non_text_events_and_surfaces_errors() {
    let storage = test_storage();
    let mut buffer = String::new();
    let mut session_id = None;
    // turn.completed / 非 agent_message 的 item 不累积文本。
    process_codex_line(
        &storage,
        "job-1",
        r#"{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}"#,
        &mut buffer,
        &mut session_id,
    )
    .unwrap();
    process_codex_line(
            &storage,
            "job-1",
            r#"{"type":"item.completed","item":{"id":"1","type":"command_execution","command":"echo hi"}}"#,
            &mut buffer,
            &mut session_id,
        )
        .unwrap();
    assert!(buffer.is_empty());
    // 顶层 error 事件并入输出，供任务日志排查。
    process_codex_line(
        &storage,
        "job-1",
        r#"{"type":"error","message":"approval required"}"#,
        &mut buffer,
        &mut session_id,
    )
    .unwrap();
    assert!(buffer.contains("[Codex 错误] approval required"));
    // 非 JSON 行（日志噪音）直接忽略。
    process_codex_line(&storage, "job-1", "not json", &mut buffer, &mut session_id).unwrap();
}

#[test]
fn pi_session_dir_uses_pi_native_location() {
    let dir = pi_native_session_dir().unwrap();
    let tail: Vec<String> = dir
        .components()
        .rev()
        .take(3)
        .map(|component| component.as_os_str().to_string_lossy().into_owned())
        .collect();
    assert_eq!(
        tail,
        vec![
            "sessions".to_string(),
            "agent".to_string(),
            ".pi".to_string()
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

#[test]
fn pi_session_validation_requires_real_session_and_full_prompt() {
    let root = std::env::temp_dir().join(format!(
        "flowlet-pi-session-validation-{}",
        uuid::Uuid::new_v4()
    ));
    let project_dir = root.join("encoded-project");
    std::fs::create_dir_all(&project_dir).unwrap();
    let session_id = "550e8400-e29b-41d4-a716-446655440000";
    let prompt = "调度前缀\n\n任务标题：修复布局\n任务描述：完整正文";
    let path = project_dir.join(format!("2026-08-07T00-00-00-000Z_{session_id}.jsonl"));
    let user_message = serde_json::json!({
        "type": "message",
        "message": {
            "role": "user",
            "content": [{ "type": "text", "text": prompt }]
        }
    });
    std::fs::write(&path, format!("{}\n", user_message)).unwrap();

    assert_eq!(
        validate_pi_session(&root, session_id, prompt).unwrap(),
        path
    );
    let error = validate_pi_session(&root, session_id, "调度前缀")
        .expect_err("截断后的任务正文不能通过校验");
    assert!(error.contains("未收到完整任务正文"));
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn pi_session_validation_rejects_fabricated_session_id() {
    let root = std::env::temp_dir().join(format!(
        "flowlet-pi-session-validation-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let error = validate_pi_session(
        &root,
        "550e8400-e29b-41d4-a716-446655440000",
        "完整任务正文",
    )
    .expect_err("不存在的 Pi 会话不能通过校验");
    assert!(error.contains("未在原生会话目录创建会话"));
    let _ = std::fs::remove_dir_all(&root);
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
    let project_dir =
        std::env::temp_dir().join(format!("flowlet-pi-integration-{}", uuid::Uuid::new_v4()));
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
    task.task_type = "readonly".to_string();
    task.title = "验证 Pi stdin 任务传递".to_string();
    task.description =
        "不要调用任何工具，不要运行命令，不要修改文件。请只回复固定文本 FLOWLET_PI_STDIN_OK。"
            .to_string();
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
        true,
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
    let detail = storage
        .get_background_job_detail("job-integ")
        .unwrap()
        .unwrap();
    let collected: String = detail
        .events
        .iter()
        .map(|event| event.message.clone())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(collected.contains(session_id), "会话事件应记录会话 id");
    assert!(
        collected.contains("FLOWLET_PI_STDIN_OK"),
        "Pi 应收到完整任务正文并回复约定文本"
    );
    assert!(summary["outputLines"].as_u64().unwrap_or(0) > 0);
    // 任务应回写待审核。
    assert_eq!(
        storage.get_task_status("task-integ").unwrap().as_deref(),
        Some("review")
    );
    // 集成测试也走 Pi 原生目录，只删除本次测试精确创建的会话文件。
    let session_file =
        validate_pi_session(&pi_native_session_dir().unwrap(), session_id, &prompt).unwrap();
    let _ = std::fs::remove_file(session_file);
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
        true,
    )
    .await
    .expect("execute_opencode 应成功执行");
    assert_eq!(outcome.job_status, "succeeded");
    // OpenCode 的 text 事件带 sessionID，summary 应含非空会话 id。
    let summary: serde_json::Value = serde_json::from_str(&outcome.summary_json).unwrap();
    let session_id = summary["sessionId"].as_str().unwrap_or("");
    assert!(!session_id.is_empty(), "OpenCode 应能解析会话 id");
    assert_eq!(
        storage.get_task_status("task-opening").unwrap().as_deref(),
        Some("review")
    );
    let _ = std::fs::remove_dir_all(&project_dir);
}

/// 真实环境集成测试：用本机已安装的 Codex CLI 完整跑一遍 execute_codex，
/// 验证 Codex 进程能启动、`--json` 事件能累积、会话 id（`thread.started` 的
/// `thread_id`）能解析、任务能回写待审核。
/// 需要本机已安装 Codex CLI 且 Flowlet 代理在 18640 运行（Codex 默认模型走代理）；
/// 正常测试默认跳过。
#[tokio::test]
#[ignore]
async fn execute_codex_integration_runs_real_codex() {
    use crate::core::storage::Project;
    let storage = test_storage();
    let project_dir = std::env::temp_dir().join(format!(
        "flowlet-codex-integration-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&project_dir).unwrap();
    storage
        .save_project(&Project {
            id: "project-codex".to_string(),
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
            "job-codex",
            "project-task-run",
            "任务执行：集成",
            "正在启动",
            "manual",
            1,
            "开始执行",
        )
        .unwrap();

    let mut task = task("集成测试");
    task.agent_profile = "Codex".to_string();
    task.id = "task-codex".to_string();
    task.project_id = "project-codex".to_string();
    task.status = "submitted".to_string();
    storage.save_project_task(&task).unwrap();

    let executable = resolve_agent_executable("Codex")
        .await
        .expect("Codex 应已安装");
    let outcome = execute_codex(
        &storage,
        &executable,
        &task,
        "project-codex",
        "job-codex",
        "reply with exactly: CODEX_EXECUTED_OK",
        None,
        true,
    )
    .await
    .expect("execute_codex 应成功执行");
    assert_eq!(outcome.job_status, "succeeded");
    // Codex 的会话 id 即 --json 首条 thread.started 的 thread_id，summary 应含非空会话 id。
    let summary: serde_json::Value = serde_json::from_str(&outcome.summary_json).unwrap();
    let session_id = summary["sessionId"].as_str().unwrap_or("");
    assert!(!session_id.is_empty(), "Codex 应能解析会话 id");
    assert_eq!(
        storage.get_task_status("task-codex").unwrap().as_deref(),
        Some("review")
    );
    let _ = std::fs::remove_dir_all(&project_dir);
}
