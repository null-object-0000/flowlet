use super::super::{AgentIdentityAdapter, AgentUaRule, HeaderLookup};
use crate::core::agent_session_identity::{
    AgentSessionIdentity, AGENT_CLIENT_HEADER, AGENT_SESSION_HEADER,
};

pub(super) struct PiIdentityAdapter;

impl AgentIdentityAdapter for PiIdentityAdapter {
    fn id(&self) -> &'static str {
        "pi"
    }
    fn ua_rules(&self) -> &'static [AgentUaRule] {
        &[]
    }
    fn extract_session(&self, header: &HeaderLookup<'_>) -> Option<AgentSessionIdentity> {
        if !header(AGENT_CLIENT_HEADER).is_some_and(|value| value.eq_ignore_ascii_case("pi")) {
            return None;
        }
        Some(AgentSessionIdentity {
            agent_type: "pi".to_string(),
            session_id: header(AGENT_SESSION_HEADER)?,
            parent_session_id: None,
        })
    }
}
