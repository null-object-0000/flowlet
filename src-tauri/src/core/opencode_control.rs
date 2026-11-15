use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodePermissionTool {
    #[serde(rename = "messageId", alias = "messageID")]
    pub message_id: String,
    #[serde(rename = "callId", alias = "callID")]
    pub call_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodePermissionRequest {
    pub id: String,
    #[serde(rename = "sessionId", alias = "sessionID")]
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

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OpenCodePermissionDecision {
    AllowOnce,
    Reject,
}
