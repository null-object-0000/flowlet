use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

pub const OPENCODE_CONTROL_PORT: u16 = 4096;
const OPENCODE_CONTROL_URL: &str = "http://127.0.0.1:4096";

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

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodePermissionReport {
    pub available: bool,
    pub server_url: String,
    pub permissions: Vec<OpenCodePermissionRequest>,
    pub error: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize)]
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
    list_session_permissions_from(OPENCODE_CONTROL_URL, session_id).await
}

pub async fn reply_permission(
    permission_id: &str,
    decision: OpenCodePermissionDecision,
) -> Result<(), String> {
    reply_permission_at(OPENCODE_CONTROL_URL, permission_id, decision).await
}

async fn list_session_permissions_from(
    base_url: &str,
    session_id: &str,
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
            .filter(|request| request.session_id == session_id)
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
    if permission_id.is_empty()
        || !permission_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
    {
        return Err("OpenCode 权限请求 ID 无效".to_string());
    }
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
        extract::Path,
        routing::{get, post},
        Json, Router,
    };
    use serde_json::json;
    use std::sync::{Arc, Mutex};

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
        let report = list_session_permissions_from(&base_url, "ses_target").await;
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
