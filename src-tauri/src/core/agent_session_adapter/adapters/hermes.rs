use super::super::*;

pub(super) struct HermesSessionAdapter;

impl AgentSessionAdapter for HermesSessionAdapter {
    fn id(&self) -> &'static str {
        "hermes"
    }
    fn agent_types(&self) -> &'static [&'static str] {
        &["hermes"]
    }
    fn source_watches(&self) -> Vec<NativeAgentSourceWatch> {
        crate::core::agent_session_metadata::hermes_source_watches()
    }
    fn list_sessions(&self) -> Vec<AgentSessionRow> {
        crate::core::agent_session_metadata::list_hermes_native_sessions()
    }
    fn timeline(&self, agent_type: &str, session_id: &str) -> Result<AgentSessionTimeline, String> {
        crate::core::agent_session_timeline::read_hermes_timeline(agent_type, session_id)
    }
    fn last_interaction(
        &self,
        agent_type: &str,
        session_id: &str,
    ) -> Result<Option<AgentSessionTimeline>, String> {
        crate::core::agent_session_timeline::read_hermes_last_interaction(agent_type, session_id)
    }
    fn incremental_source(&self, _agent_type: &str, _session_id: &str) -> Option<PathBuf> {
        // state.db 是 SQLite，非追加型文件，没有稳定字节游标；走全量重解析路径。
        None
    }
}
