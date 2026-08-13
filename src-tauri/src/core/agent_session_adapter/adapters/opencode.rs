use super::super::*;

pub(super) struct OpenCodeSessionAdapter;

impl AgentSessionAdapter for OpenCodeSessionAdapter {
    fn id(&self) -> &'static str {
        "opencode"
    }
    fn agent_types(&self) -> &'static [&'static str] {
        &["opencode"]
    }
    fn source_watches(&self) -> Vec<NativeAgentSourceWatch> {
        crate::core::agent_session_metadata::opencode_source_watches()
    }
    fn list_sessions(&self) -> Vec<AgentSessionRow> {
        crate::core::agent_session_metadata::list_opencode_native_sessions()
    }
    fn timeline(
        &self,
        _agent_type: &str,
        session_id: &str,
    ) -> Result<AgentSessionTimeline, String> {
        crate::core::agent_session_timeline::read_opencode_timeline(session_id)
    }
    fn last_interaction(
        &self,
        _agent_type: &str,
        session_id: &str,
    ) -> Result<Option<AgentSessionTimeline>, String> {
        Ok(Some(
            crate::core::agent_session_timeline::read_opencode_last_interaction(session_id)?,
        ))
    }
    fn timeline_with_usage_events(
        &self,
        _agent_type: &str,
        session_id: &str,
        usage_events: &mut Vec<AgentUsageEvent>,
    ) -> Result<AgentSessionTimeline, String> {
        crate::core::agent_session_timeline::read_opencode_timeline_with_events(
            session_id,
            usage_events,
        )
    }
}
