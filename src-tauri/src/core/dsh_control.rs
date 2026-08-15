use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// DSH 桥接新鲜度窗口：request 文件的 heartbeatAt 在此毫秒内才算活跃。
const BRIDGE_FRESHNESS_MILLIS: u64 = 5_000;

/// DSH 桥接控制目录：~/.flowlet/dsh-control/
fn bridge_root() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".flowlet").join("dsh-control"))
}

// ---------------------------------------------------------------------------
// 数据结构
// ---------------------------------------------------------------------------

/// DSH approval/request 插件写入的请求文件。
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DshApprovalRequest {
    pub approval_id: String,
    pub session_id: String,
    #[serde(default)]
    pub tool_name: String,
    #[serde(default)]
    pub call_id: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
    pub requested_at: u64,
    pub heartbeat_at: u64,
    pub bridge_version: u32,
}

/// 桌面端查询的待确认请求报告。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DshApprovalReport {
    pub available: bool,
    pub permissions: Vec<DshApprovalRequest>,
    pub error: Option<String>,
}

/// 确认决策枚举，序列化为 snake_case（allow_once / reject）。
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DshApprovalDecision {
    AllowOnce,
    Reject,
}

// ---------------------------------------------------------------------------
// 读取（内部函数携带 root 参数以便测试）
// ---------------------------------------------------------------------------

/// 读取 root 目录下所有活跃（心跳新鲜度内）的 approval 请求。
fn fresh_approval_requests_at(root: &Path) -> Vec<DshApprovalRequest> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut seen = HashSet::new();
    entries
        .flatten()
        .filter(|entry| {
            entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.starts_with("request-") && name.ends_with(".json"))
        })
        .filter_map(|entry| fs::read_to_string(entry.path()).ok())
        .filter_map(|content| serde_json::from_str::<DshApprovalRequest>(&content).ok())
        // 按心跳新鲜度过滤
        .filter(|req| now.saturating_sub(req.heartbeat_at) <= BRIDGE_FRESHNESS_MILLIS)
        // 防御性去重
        .filter(|req| seen.insert(req.approval_id.clone()))
        .collect()
}

fn list_bridge_approvals_at(root: &Path, session_id: &str) -> Option<DshApprovalReport> {
    let requests = fresh_approval_requests_at(root);
    if requests.is_empty() {
        return None;
    }
    Some(DshApprovalReport {
        available: true,
        permissions: requests
            .into_iter()
            .filter(|req| req.session_id == session_id)
            .collect(),
        error: None,
    })
}

fn list_bridge_approvals_all_at(root: &Path) -> Option<DshApprovalReport> {
    let requests = fresh_approval_requests_at(root);
    if requests.is_empty() {
        return None;
    }
    Some(DshApprovalReport {
        available: true,
        permissions: requests,
        error: None,
    })
}

// ---------------------------------------------------------------------------
// 回复（内部函数携带 root 参数以便测试）
// ---------------------------------------------------------------------------

fn write_bridge_reply_at(root: &Path, approval_id: &str, reply: &str) -> Result<(), String> {
    fs::create_dir_all(root)
        .map_err(|error| format!("创建 DSH 交互确认桥目录失败：{error}"))?;
    let body = serde_json::json!({
        "approvalId": approval_id,
        "reply": reply,
    });
    fs::write(
        root.join(format!("reply-{approval_id}.json")),
        serde_json::to_vec(&body)
            .map_err(|error| format!("生成 DSH 交互确认回复失败：{error}"))?,
    )
    .map_err(|error| format!("提交 DSH 交互确认回复失败：{error}"))
}

fn valid_approval_id(approval_id: &str) -> bool {
    !approval_id.is_empty()
        && approval_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
}

// ---------------------------------------------------------------------------
// 公共 API
// ---------------------------------------------------------------------------

/// 查询指定 DSH 会话的待确认请求。
pub async fn list_session_approvals(session_id: &str) -> DshApprovalReport {
    let Some(root) = bridge_root() else {
        return DshApprovalReport {
            available: false,
            permissions: Vec::new(),
            error: Some("无法确定 DSH 交互确认桥目录".to_string()),
        };
    };
    list_bridge_approvals_at(&root, session_id).unwrap_or(DshApprovalReport {
        available: false,
        permissions: Vec::new(),
        error: Some("DSH 交互确认桥没有待确认的请求".to_string()),
    })
}

/// 查询所有 DSH 会话的待确认请求。
pub async fn list_approvals() -> DshApprovalReport {
    let Some(root) = bridge_root() else {
        return DshApprovalReport {
            available: false,
            permissions: Vec::new(),
            error: Some("无法确定 DSH 交互确认桥目录".to_string()),
        };
    };
    list_bridge_approvals_all_at(&root).unwrap_or(DshApprovalReport {
        available: false,
        permissions: Vec::new(),
        error: Some("DSH 交互确认桥没有待确认的请求".to_string()),
    })
}

/// 回复一个 DSH 待确认请求：写入 reply-<approvalId>.json，DSH 侧插件轮询读回。
pub async fn reply_approval(
    approval_id: &str,
    decision: DshApprovalDecision,
) -> Result<(), String> {
    if !valid_approval_id(approval_id) {
        return Err("DSH 交互确认请求 ID 无效".to_string());
    }
    let root = bridge_root().ok_or_else(|| "无法确定 DSH 交互确认桥目录".to_string())?;
    let reply = match decision {
        DshApprovalDecision::AllowOnce => "allow-once",
        DshApprovalDecision::Reject => "reject",
    };
    write_bridge_reply_at(&root, approval_id, reply)
}

/// 返回当前存在待确认请求的 DSH 会话 ID 集合。
pub async fn pending_session_ids() -> HashSet<String> {
    let Some(root) = bridge_root() else {
        return HashSet::new();
    };
    let report = list_bridge_approvals_all_at(&root);
    match report {
        Some(report) => report
            .permissions
            .into_iter()
            .map(|req| req.session_id)
            .collect(),
        None => HashSet::new(),
    }
}

/// 合并运行状态：若 agent_type 为 deepseek-harness 且会话存在待确认请求，
/// 返回 "waiting_user"；否则返回 inferred_status。
pub fn merge_runtime_status(
    agent_type: &str,
    session_id: &str,
    inferred_status: &str,
    pending_sessions: &HashSet<String>,
) -> String {
    if agent_type == "deepseek-harness" && pending_sessions.contains(session_id) {
        "waiting_user".to_string()
    } else {
        inferred_status.to_string()
    }
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn test_root(name: &str) -> PathBuf {
        let mut path = std::env::temp_dir();
        path.push(format!("flowlet-dsh-control-{name}"));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn write_request(root: &Path, approval_id: &str, session_id: &str, heartbeat_at: u64) {
        let body = serde_json::json!({
            "approvalId": approval_id,
            "sessionId": session_id,
            "toolName": "bash",
            "callId": "call-1",
            "reason": "run cargo test",
            "requestedAt": heartbeat_at,
            "heartbeatAt": heartbeat_at,
            "bridgeVersion": 1,
        });
        fs::write(root.join(format!("request-{approval_id}.json")), body.to_string()).unwrap();
    }

    #[test]
    fn filters_requests_by_session_and_deduplicates() {
        let root = test_root("filters");
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        write_request(&root, "a1", "ses-1", now);
        write_request(&root, "a2", "ses-1", now);
        write_request(&root, "a3", "ses-2", now);
        // 复制文件模拟重复写入残留
        fs::copy(
            root.join("request-a1.json"),
            root.join("request-a1-copy.json"),
        )
        .unwrap();

        let report = list_bridge_approvals_at(&root, "ses-1").unwrap();
        assert_eq!(report.permissions.len(), 2);
        let ids: Vec<&str> = report
            .permissions
            .iter()
            .map(|req| req.approval_id.as_str())
            .collect();
        assert!(ids.contains(&"a1"));
        assert!(ids.contains(&"a2"));

        let all = list_bridge_approvals_all_at(&root).unwrap();
        assert_eq!(all.permissions.len(), 3);
    }

    #[test]
    fn drops_stale_requests_beyond_heartbeat_window() {
        let root = test_root("stale");
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        write_request(&root, "fresh", "ses-1", now);
        write_request(&root, "stale", "ses-2", now - 60_000);
        // 窗口内但接近边界（读时可能又流逝了几毫秒，留 500ms 余量）。
        write_request(&root, "edge", "ses-3", now - BRIDGE_FRESHNESS_MILLIS + 500);

        let all = list_bridge_approvals_all_at(&root).unwrap();
        let ids: Vec<&str> = all
            .permissions
            .iter()
            .map(|req| req.approval_id.as_str())
            .collect();
        assert!(ids.contains(&"fresh"));
        assert!(!ids.contains(&"stale"));
        assert!(ids.contains(&"edge"));
    }

    #[test]
    fn write_reply_uses_dsh_vocabulary() {
        let root = test_root("reply");
        let approval_id = "abc-123";
        write_bridge_reply_at(&root, approval_id, "allow-once").unwrap();
        let content = fs::read_to_string(root.join(format!("reply-{approval_id}.json"))).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&content).unwrap();
        assert_eq!(parsed["approvalId"], "abc-123");
        assert_eq!(parsed["reply"], "allow-once");

        let parsed_decision = serde_json::from_value::<DshApprovalDecision>(
            serde_json::json!("allow_once"),
        )
        .unwrap();
        match parsed_decision {
            DshApprovalDecision::AllowOnce => {}
            DshApprovalDecision::Reject => panic!("unexpected decision"),
        }
    }

    #[test]
    fn validates_approval_ids() {
        assert!(valid_approval_id("abc-123_def"));
        assert!(!valid_approval_id(""));
        assert!(!valid_approval_id("../evil"));
        assert!(!valid_approval_id("has space"));
    }

    #[test]
    fn pending_session_ids_collects_all_sessions() {
        let root = test_root("pending");
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        write_request(&root, "b1", "ses-x", now);
        write_request(&root, "b2", "ses-y", now);
        let sessions: HashSet<String> = list_bridge_approvals_all_at(&root)
            .unwrap()
            .permissions
            .into_iter()
            .map(|req| req.session_id)
            .collect();
        assert_eq!(sessions.len(), 2);
        assert!(sessions.contains("ses-x"));
        assert!(sessions.contains("ses-y"));
    }

    #[test]
    fn merge_status_marks_waiting_user_for_dsh_only() {
        let pending = HashSet::from(["ses_waiting".to_string()]);
        assert_eq!(
            merge_runtime_status("deepseek-harness", "ses_waiting", "running", &pending),
            "waiting_user"
        );
        assert_eq!(
            merge_runtime_status("deepseek-harness", "ses_other", "running", &pending),
            "running"
        );
        // 非 DSH Agent 不受 DSH pending 影响
        assert_eq!(
            merge_runtime_status("opencode", "ses_waiting", "running", &pending),
            "running"
        );
        assert_eq!(
            merge_runtime_status("claude-code", "ses_waiting", "running", &pending),
            "running"
        );
    }
}