use super::super::*;

pub(super) struct ClaudeCodeSessionAdapter;

impl AgentSessionAdapter for ClaudeCodeSessionAdapter {
    fn id(&self) -> &'static str {
        "claude-code"
    }
    fn agent_types(&self) -> &'static [&'static str] {
        &["claude-code"]
    }
    fn source_watches(&self) -> Vec<NativeAgentSourceWatch> {
        crate::core::agent_session_metadata::claude_source_watches()
    }
    fn list_sessions(&self) -> Vec<AgentSessionRow> {
        crate::core::agent_session_metadata::list_claude_native_sessions()
    }
    fn timeline(
        &self,
        _agent_type: &str,
        session_id: &str,
    ) -> Result<AgentSessionTimeline, String> {
        crate::core::agent_session_timeline::read_claude_timeline(session_id)
    }
    fn last_interaction(
        &self,
        _agent_type: &str,
        session_id: &str,
    ) -> Result<Option<AgentSessionTimeline>, String> {
        crate::core::agent_session_timeline::read_claude_last_interaction(session_id)
    }
    fn incremental_source(&self, _agent_type: &str, session_id: &str) -> Option<PathBuf> {
        crate::core::agent_session_timeline::claude_session_file(session_id)
    }
}
