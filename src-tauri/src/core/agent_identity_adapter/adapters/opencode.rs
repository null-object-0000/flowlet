use super::super::{AgentIdentityAdapter, AgentUaRule, HeaderLookup};
use crate::core::agent_session_identity::AgentSessionIdentity;

pub(super) struct OpenCodeIdentityAdapter;

const UA_RULES: [AgentUaRule; 1] = [AgentUaRule {
    id: "opencode",
    pattern: "opencode/",
    name: "OpenCode",
}];

impl AgentIdentityAdapter for OpenCodeIdentityAdapter {
    fn id(&self) -> &'static str {
        "opencode"
    }
    fn ua_rules(&self) -> &'static [AgentUaRule] {
        &UA_RULES
    }
    fn extract_session(&self, header: &HeaderLookup<'_>) -> Option<AgentSessionIdentity> {
        let native_session = header("x-opencode-session");
        let matches_ua = header("user-agent")
            .is_some_and(|value| value.to_ascii_lowercase().contains("opencode/"));
        if !matches_ua && native_session.is_none() {
            return None;
        }
        Some(AgentSessionIdentity {
            agent_type: "opencode".to_string(),
            session_id: native_session
                .or_else(|| header("x-session-id"))
                .or_else(|| header("x-session-affinity"))?,
            parent_session_id: header("x-parent-session-id"),
        })
    }
}
