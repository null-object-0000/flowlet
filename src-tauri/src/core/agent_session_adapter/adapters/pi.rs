use super::super::*;

pub(super) struct PiSessionAdapter;

impl AgentSessionAdapter for PiSessionAdapter {
    fn id(&self) -> &'static str {
        "pi"
    }
    fn agent_types(&self) -> &'static [&'static str] {
        &["pi"]
    }
    fn source_watches(&self) -> Vec<NativeAgentSourceWatch> {
        crate::core::agent_session_metadata::pi_source_watches()
    }
    fn list_sessions(&self) -> Vec<AgentSessionRow> {
        crate::core::agent_session_metadata::list_pi_native_sessions()
    }
    fn timeline(
        &self,
        _agent_type: &str,
        session_id: &str,
    ) -> Result<AgentSessionTimeline, String> {
        crate::core::agent_session_timeline::read_pi_timeline(session_id)
    }
    fn last_interaction(
        &self,
        _agent_type: &str,
        session_id: &str,
    ) -> Result<Option<AgentSessionTimeline>, String> {
        crate::core::agent_session_timeline::read_pi_last_interaction(session_id)
    }
    fn timeline_with_usage_events(
        &self,
        _agent_type: &str,
        session_id: &str,
        usage_events: &mut Vec<AgentUsageEvent>,
    ) -> Result<AgentSessionTimeline, String> {
        crate::core::agent_session_timeline::read_pi_timeline_with_events(session_id, usage_events)
    }
}
