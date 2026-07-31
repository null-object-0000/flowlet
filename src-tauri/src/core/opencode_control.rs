use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const BRIDGE_FRESHNESS_MILLIS: u64 = 5_000;
const LEGACY_CONTROL_URL: &str = "http://127.0.0.1:4096";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodePermissionTool {
    #[serde(rename(deserialize = "messageID", serialize = "messageId"))]
    pub message_id: String,
    #[serde(rename(deserialize = "callID", serialize = "callId"))]
    pub call_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodePermissionRequest {
    pub id: String,
    #[serde(rename(deserialize = "sessionID", serialize = "sessionId"))]
    pub session_id: String,
    pub permission: String,
    #[serde(default)]
    pub patterns: Vec<String>,
    #[serde(default)]
    pub metadata: Value,
    #[serde(default)]
    pub always: Vec<String>,
    pub tool: Option<OpenCodePermissionTool>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodePermissionReport {
    pub available: bool,
    pub server_url: String,
    pub permissions: Vec<OpenCodePermissionRequest>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenCodeBridgeState {
    server_url: String,
    updated_at: u64,
    #[serde(default)]
    permissions: Vec<OpenCodePermissionRequest>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OpenCodePermissionDecision {
    AllowOnce,
    Reject,
}

impl OpenCodePermissionDecision {
    fn api_reply(self) -> &'static str {
        match self {
            Self::AllowOnce => "once",
            Self::Reject => "reject",
        }
    }
}

#[derive(Serialize)]
struct PermissionReplyBody {
    reply: &'static str,
}

pub async fn list_session_permissions(session_id: &str) -> OpenCodePermissionReport {
    if let Some(report) = list_bridge_permissions(session_id) {
        return report;
    }
    let base_url = fallback_control_url();
    list_permissions_from(&base_url, Some(session_id)).await
}

pub async fn list_permissions() -> OpenCodePermissionReport {
    if let Some(report) = list_bridge_permissions_all() {
        return report;
    }
    let base_url = fallback_control_url();
    list_permissions_from(&base_url, None).await
}

/// 返回当前存在待确认权限的 OpenCode 会话 ID 集合。
/// PC 列表页与设备同步快照必须走同一入口，否则快照会把"等待确认"的会话
/// 固化为"自动运行中"。控制服务不可用时返回空集合，退化为 SQLite 推断状态。
pub async fn pending_session_ids() -> HashSet<String> {
    let report = list_permissions().await;
    if !report.available {
        return HashSet::new();
    }
    report
        .permissions
        .into_iter()
        .map(|permission| permission.session_id)
        .collect()
}

pub async fn reply_permission(
    permission_id: &str,
    decision: OpenCodePermissionDecision,
) -> Result<(), String> {
    validate_permission_id(permission_id)?;
    if bridge_server_for_permission(permission_id).is_some() {
        return write_bridge_reply(permission_id, decision);
    }
    let base_url = fallback_control_url();
    reply_permission_at(&base_url, permission_id, decision).await
}

fn fallback_control_url() -> String {
    LEGACY_CONTROL_URL.to_string()
}

fn bridge_root() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".flowlet").join("opencode-control"))
}

fn fresh_bridge_states() -> Vec<OpenCodeBridgeState> {
    let Some(root) = bridge_root() else {
        return Vec::new();
    };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|entry| {
            entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.starts_with("state-") && name.ends_with(".json"))
        })
        .filter_map(|entry| fs::read_to_string(entry.path()).ok())
        .filter_map(|content| serde_json::from_str::<OpenCodeBridgeState>(&content).ok())
        .filter(|state| now.saturating_sub(state.updated_at) <= BRIDGE_FRESHNESS_MILLIS)
        .collect()
}

fn list_bridge_permissions(session_id: &str) -> Option<OpenCodePermissionReport> {
    let states = fresh_bridge_states();
    if states.is_empty() {
        return None;
    }
    let server_url = states
        .first()
        .map(|state| state.server_url.clone())
        .unwrap_or_else(fallback_control_url);
    let mut seen = HashSet::new();
    let permissions = states
        .into_iter()
        .flat_map(|state| state.permissions)
        .filter(|permission| permission.session_id == session_id)
        .filter(|permission| seen.insert(permission.id.clone()))
        .collect();
    Some(OpenCodePermissionReport {
        available: true,
        server_url,
        permissions,
        error: None,
    })
}

fn list_bridge_permissions_all() -> Option<OpenCodePermissionReport> {
    let states = fresh_bridge_states();
    if states.is_empty() {
        return None;
    }
    let server_url = states
        .first()
        .map(|state| state.server_url.clone())
        .unwrap_or_else(fallback_control_url);
    let mut seen = HashSet::new();
    Some(OpenCodePermissionReport {
        available: true,
        server_url,
        permissions: states
            .into_iter()
            .flat_map(|state| state.permissions)
            .filter(|permission| seen.insert(permission.id.clone()))
            .collect(),
        error: None,
    })
}

fn bridge_server_for_permission(permission_id: &str) -> Option<String> {
    fresh_bridge_states().into_iter().find_map(|state| {
        state
            .permissions
            .iter()
            .any(|permission| permission.id == permission_id)
            .then_some(state.server_url)
    })
}

fn write_bridge_reply(
    permission_id: &str,
    decision: OpenCodePermissionDecision,
) -> Result<(), String> {
    let root = bridge_root().ok_or_else(|| "无法确定 OpenCode 权限桥接目录".to_string())?;
    fs::create_dir_all(&root)
        .map_err(|error| format!("创建 OpenCode 权限桥接目录失败：{error}"))?;
    let body = serde_json::json!({
        "permissionId": permission_id,
        "reply": decision.api_reply(),
    });
    fs::write(
        root.join(format!("reply-{permission_id}.json")),
        serde_json::to_vec(&body)
            .map_err(|error| format!("生成 OpenCode 权限回复失败：{error}"))?,
    )
    .map_err(|error| format!("提交 OpenCode 权限回复失败：{error}"))
}

pub fn merge_runtime_status(
    agent_type: &str,
    session_id: &str,
    inferred_status: &str,
    pending_sessions: &std::collections::HashSet<String>,
) -> String {
    if agent_type == "opencode" && pending_sessions.contains(session_id) {
        "waiting_user".to_string()
    } else {
        inferred_status.to_string()
    }
}

async fn list_permissions_from(
    base_url: &str,
    session_id: Option<&str>,
) -> OpenCodePermissionReport {
    let unavailable = |message: String| OpenCodePermissionReport {
        available: false,
        server_url: base_url.to_string(),
        permissions: Vec::new(),
        error: Some(message),
    };
    let client = match control_client() {
        Ok(client) => client,
        Err(error) => return unavailable(error),
    };
    let response = match client.get(format!("{base_url}/permission")).send().await {
        Ok(response) => response,
        Err(error) => return unavailable(format!("无法连接 OpenCode 控制服务：{error}")),
    };
    if !response.status().is_success() {
        return unavailable(format!("OpenCode 控制服务返回 HTTP {}", response.status()));
    }
    let permissions = match response.json::<Vec<OpenCodePermissionRequest>>().await {
        Ok(permissions) => permissions
            .into_iter()
            .filter(|request| session_id.is_none_or(|session_id| request.session_id == session_id))
            .collect(),
        Err(error) => return unavailable(format!("无法解析 OpenCode 权限请求：{error}")),
    };
    OpenCodePermissionReport {
        available: true,
        server_url: base_url.to_string(),
        permissions,
        error: None,
    }
}

async fn reply_permission_at(
    base_url: &str,
    permission_id: &str,
    decision: OpenCodePermissionDecision,
) -> Result<(), String> {
    validate_permission_id(permission_id)?;
    let client = control_client()?;
    let mut url =
        Url::parse(base_url).map_err(|error| format!("OpenCode 控制地址无效：{error}"))?;
    url.path_segments_mut()
        .map_err(|_| "OpenCode 控制地址无法追加路径".to_string())?
        .extend(["permission", permission_id, "reply"]);
    let response = client
        .post(url)
        .json(&PermissionReplyBody {
            reply: decision.api_reply(),
        })
        .send()
        .await
        .map_err(|error| format!("无法向 OpenCode 提交操作：{error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "OpenCode 拒绝了本次操作（HTTP {}）",
            response.status()
        ));
    }
    let accepted = response
        .json::<bool>()
        .await
        .map_err(|error| format!("无法解析 OpenCode 操作结果：{error}"))?;
    if !accepted {
        return Err("OpenCode 未接受本次操作，权限请求可能已经结束".to_string());
    }
    Ok(())
}

fn validate_permission_id(permission_id: &str) -> Result<(), String> {
    if permission_id.is_empty()
        || !permission_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
    {
        Err("OpenCode 权限请求 ID 无效".to_string())
    } else {
        Ok(())
    }
}

fn control_client() -> Result<Client, String> {
    Client::builder()
        .connect_timeout(Duration::from_millis(800))
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|error| format!("创建 OpenCode 控制客户端失败：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Json, Router,
        extract::Path,
        routing::{get, post},
    };
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    #[test]
    fn pending_permission_has_priority_and_disappearing_permission_falls_back() {
        let pending = std::collections::HashSet::from(["ses_waiting".to_string()]);
        assert_eq!(
            merge_runtime_status("opencode", "ses_waiting", "running", &pending),
            "waiting_user"
        );
        assert_eq!(
            merge_runtime_status(
                "opencode",
                "ses_waiting",
                "running",
                &std::collections::HashSet::new(),
            ),
            "running"
        );
        assert_eq!(
            merge_runtime_status("codex", "ses_waiting", "running", &pending),
            "running"
        );
    }

    async fn test_server() -> (String, Arc<Mutex<Vec<(String, Value)>>>) {
        let replies = Arc::new(Mutex::new(Vec::new()));
        let captured = replies.clone();
        let app = Router::new()
            .route(
                "/permission",
                get(|| async {
                    Json(json!([
                        {
                            "id": "per_target",
                            "sessionID": "ses_target",
                            "permission": "bash",
                            "patterns": ["cargo test"],
                            "metadata": {"command": "cargo test"},
                            "always": ["cargo test"],
                            "tool": {"messageID": "msg_1", "callID": "call_1"}
                        },
                        {
                            "id": "per_other",
                            "sessionID": "ses_other",
                            "permission": "edit",
                            "patterns": []
                        }
                    ]))
                }),
            )
            .route(
                "/permission/{id}/reply",
                post(move |Path(id): Path<String>, Json(body): Json<Value>| {
                    let captured = captured.clone();
                    async move {
                        captured.lock().unwrap().push((id, body));
                        Json(true)
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://{address}"), replies)
    }

    #[tokio::test]
    async fn filters_permissions_to_the_requested_session() {
        let (base_url, _) = test_server().await;
        let report = list_permissions_from(&base_url, Some("ses_target")).await;
        assert!(report.available);
        assert_eq!(report.permissions.len(), 1);
        assert_eq!(report.permissions[0].id, "per_target");
        assert_eq!(report.permissions[0].patterns, vec!["cargo test"]);
    }

    #[tokio::test]
    async fn sends_allow_once_reply() {
        let (base_url, replies) = test_server().await;
        reply_permission_at(
            &base_url,
            "per_target",
            OpenCodePermissionDecision::AllowOnce,
        )
        .await
        .unwrap();
        assert_eq!(
            replies.lock().unwrap().as_slice(),
            &[("per_target".to_string(), json!({"reply": "once"}))]
        );
    }
}
