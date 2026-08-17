use super::super::{AgentIdentityAdapter, AgentUaRule, HeaderLookup};
use crate::core::agent_session_identity::{AgentSessionIdentity, AGENT_SESSION_HEADER};

pub(super) struct DeepSeekHarnessIdentityAdapter;

const UA_RULES: [AgentUaRule; 1] = [AgentUaRule {
    id: "deepseek-harness",
    pattern: "deepseek-harness/",
    name: "DeepSeek Harness",
}];

impl AgentIdentityAdapter for DeepSeekHarnessIdentityAdapter {
    fn id(&self) -> &'static str {
        "deepseek-harness"
    }
    fn ua_rules(&self) -> &'static [AgentUaRule] {
        &UA_RULES
    }
    fn extract_session(&self, header: &HeaderLookup<'_>) -> Option<AgentSessionIdentity> {
        if !header("user-agent")
            .is_some_and(|value| value.to_ascii_lowercase().contains("deepseek-harness/"))
        {
            return None;
        }
        Some(AgentSessionIdentity {
            agent_type: "deepseek-harness".to_string(),
            session_id: header(AGENT_SESSION_HEADER)?,
            parent_session_id: None,
        })
    }
}
