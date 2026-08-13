use super::super::*;

pub(super) struct CodexSessionAdapter;

impl AgentSessionAdapter for CodexSessionAdapter {
    fn id(&self) -> &'static str {
        "codex"
    }
    fn agent_types(&self) -> &'static [&'static str] {
        &["codex-desktop", "codex-cli"]
    }
    fn source_watches(&self) -> Vec<NativeAgentSourceWatch> {
        crate::core::agent_session_metadata::codex_source_watches()
    }
    fn list_sessions(&self) -> Vec<AgentSessionRow> {
        crate::core::agent_session_metadata::list_codex_native_sessions()
    }
    fn timeline(&self, agent_type: &str, session_id: &str) -> Result<AgentSessionTimeline, String> {
        crate::core::agent_session_timeline::read_codex_timeline(agent_type, session_id)
    }
    fn last_interaction(
        &self,
        agent_type: &str,
        session_id: &str,
    ) -> Result<Option<AgentSessionTimeline>, String> {
        crate::core::agent_session_timeline::read_codex_last_interaction(agent_type, session_id)
    }
    fn incremental_source(&self, agent_type: &str, session_id: &str) -> Option<PathBuf> {
        crate::core::agent_session_timeline::codex_session_file(agent_type, session_id)
    }
}
