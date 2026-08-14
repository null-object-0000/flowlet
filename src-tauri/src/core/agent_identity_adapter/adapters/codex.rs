use super::super::{AgentIdentityAdapter, AgentUaRule, HeaderLookup};
use crate::core::agent_session_identity::{valid_header_value, AgentSessionIdentity};

pub(super) struct CodexIdentityAdapter;

const UA_RULES: [AgentUaRule; 2] = [
    AgentUaRule {
        id: "codex",
        pattern: "codex_cli_rs/",
        name: "Codex",
    },
    AgentUaRule {
        id: "codex-desktop",
        pattern: "Codex Desktop/",
        name: "Codex Desktop",
    },
];

impl AgentIdentityAdapter for CodexIdentityAdapter {
    fn id(&self) -> &'static str {
        "codex"
    }
    fn ua_rules(&self) -> &'static [AgentUaRule] {
        &UA_RULES
    }
    fn extract_session(&self, header: &HeaderLookup<'_>) -> Option<AgentSessionIdentity> {
        if !header("user-agent")
            .is_some_and(|value| value.to_ascii_lowercase().contains("codex desktop/"))
        {
            return None;
        }
        let session_id = header("session-id")
            .or_else(|| header("x-session-id"))
            .or_else(|| turn_metadata_session_id(header))?;
        Some(AgentSessionIdentity {
            agent_type: "codex-desktop".to_string(),
            session_id,
            parent_session_id: None,
        })
    }
}

fn turn_metadata_session_id(header: &HeaderLookup<'_>) -> Option<String> {
    let metadata = header("x-codex-turn-metadata")?;
    let value = serde_json::from_str::<serde_json::Value>(&metadata).ok()?;
    valid_header_value(value.get("session_id")?.as_str()?)
}
