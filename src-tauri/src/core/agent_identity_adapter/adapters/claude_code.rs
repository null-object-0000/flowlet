use super::super::{AgentIdentityAdapter, AgentUaRule, HeaderLookup};
use crate::core::agent_session_identity::AgentSessionIdentity;

pub(super) struct ClaudeCodeIdentityAdapter;

const UA_RULES: [AgentUaRule; 1] = [AgentUaRule {
    id: "claude-code",
    pattern: "claude-cli/",
    name: "Claude Code",
}];

impl AgentIdentityAdapter for ClaudeCodeIdentityAdapter {
    fn id(&self) -> &'static str {
        "claude-code"
    }
    fn ua_rules(&self) -> &'static [AgentUaRule] {
        &UA_RULES
    }
    fn extract_session(&self, header: &HeaderLookup<'_>) -> Option<AgentSessionIdentity> {
        Some(AgentSessionIdentity {
            agent_type: "claude-code".to_string(),
            session_id: header("x-claude-code-session-id")?,
            parent_session_id: None,
        })
    }
}
