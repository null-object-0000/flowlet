use super::agent_session_metadata::NativeAgentSourceWatch;
use super::config::{AgentSessionRow, AgentSessionTimeline, AgentUsageEvent};
use std::path::PathBuf;

pub(crate) trait AgentSessionAdapter: Sync {
    fn id(&self) -> &'static str;
    fn agent_types(&self) -> &'static [&'static str];
    fn source_watches(&self) -> Vec<NativeAgentSourceWatch>;
    fn list_sessions(&self) -> Vec<AgentSessionRow>;
    fn timeline(&self, agent_type: &str, session_id: &str) -> Result<AgentSessionTimeline, String>;
    fn last_interaction(
        &self,
        agent_type: &str,
        session_id: &str,
    ) -> Result<Option<AgentSessionTimeline>, String>;
    fn incremental_source(&self, _agent_type: &str, _session_id: &str) -> Option<PathBuf> {
        None
    }
    fn timeline_with_usage_events(
        &self,
        agent_type: &str,
        session_id: &str,
        usage_events: &mut Vec<AgentUsageEvent>,
    ) -> Result<AgentSessionTimeline, String> {
        let _ = usage_events;
        self.timeline(agent_type, session_id)
    }
}

struct ClaudeCodeSessionAdapter;
struct OpenCodeSessionAdapter;
struct PiSessionAdapter;
struct CodexSessionAdapter;

static CLAUDE_CODE: ClaudeCodeSessionAdapter = ClaudeCodeSessionAdapter;
static OPENCODE: OpenCodeSessionAdapter = OpenCodeSessionAdapter;
static PI: PiSessionAdapter = PiSessionAdapter;
static CODEX: CodexSessionAdapter = CodexSessionAdapter;
static ADAPTERS: [&'static dyn AgentSessionAdapter; 4] = [&CLAUDE_CODE, &OPENCODE, &PI, &CODEX];

pub(crate) fn session_adapters() -> &'static [&'static dyn AgentSessionAdapter] {
    &ADAPTERS
}

pub(crate) fn adapter_for_agent_type(agent_type: &str) -> Option<&'static dyn AgentSessionAdapter> {
    ADAPTERS
        .iter()
        .copied()
        .find(|adapter| adapter.agent_types().contains(&agent_type))
}

pub(crate) fn has_session_adapter(adapter_id: &str) -> bool {
    ADAPTERS.iter().any(|adapter| adapter.id() == adapter_id)
}

impl AgentSessionAdapter for ClaudeCodeSessionAdapter {
    fn id(&self) -> &'static str {
        "claude-code"
    }
    fn agent_types(&self) -> &'static [&'static str] {
        &["claude-code"]
    }
    fn source_watches(&self) -> Vec<NativeAgentSourceWatch> {
        super::agent_session_metadata::claude_source_watches()
    }
    fn list_sessions(&self) -> Vec<AgentSessionRow> {
        super::agent_session_metadata::list_claude_native_sessions()
    }
    fn timeline(
        &self,
        _agent_type: &str,
        session_id: &str,
    ) -> Result<AgentSessionTimeline, String> {
        super::agent_session_timeline::read_claude_timeline(session_id)
    }
    fn last_interaction(
        &self,
        _agent_type: &str,
        session_id: &str,
    ) -> Result<Option<AgentSessionTimeline>, String> {
        super::agent_session_timeline::read_claude_last_interaction(session_id)
    }
    fn incremental_source(&self, _agent_type: &str, session_id: &str) -> Option<PathBuf> {
        super::agent_session_timeline::claude_session_file(session_id)
    }
}

impl AgentSessionAdapter for OpenCodeSessionAdapter {
    fn id(&self) -> &'static str {
        "opencode"
    }
    fn agent_types(&self) -> &'static [&'static str] {
        &["opencode"]
    }
    fn source_watches(&self) -> Vec<NativeAgentSourceWatch> {
        super::agent_session_metadata::opencode_source_watches()
    }
    fn list_sessions(&self) -> Vec<AgentSessionRow> {
        super::agent_session_metadata::list_opencode_native_sessions()
    }
    fn timeline(
        &self,
        _agent_type: &str,
        session_id: &str,
    ) -> Result<AgentSessionTimeline, String> {
        super::agent_session_timeline::read_opencode_timeline(session_id)
    }
    fn last_interaction(
        &self,
        _agent_type: &str,
        session_id: &str,
    ) -> Result<Option<AgentSessionTimeline>, String> {
        Ok(Some(
            super::agent_session_timeline::read_opencode_last_interaction(session_id)?,
        ))
    }
    fn timeline_with_usage_events(
        &self,
        _agent_type: &str,
        session_id: &str,
        usage_events: &mut Vec<AgentUsageEvent>,
    ) -> Result<AgentSessionTimeline, String> {
        super::agent_session_timeline::read_opencode_timeline_with_events(session_id, usage_events)
    }
}

impl AgentSessionAdapter for PiSessionAdapter {
    fn id(&self) -> &'static str {
        "pi"
    }
    fn agent_types(&self) -> &'static [&'static str] {
        &["pi"]
    }
    fn source_watches(&self) -> Vec<NativeAgentSourceWatch> {
        super::agent_session_metadata::pi_source_watches()
    }
    fn list_sessions(&self) -> Vec<AgentSessionRow> {
        super::agent_session_metadata::list_pi_native_sessions()
    }
    fn timeline(
        &self,
        _agent_type: &str,
        session_id: &str,
    ) -> Result<AgentSessionTimeline, String> {
        super::agent_session_timeline::read_pi_timeline(session_id)
    }
    fn last_interaction(
        &self,
        _agent_type: &str,
        session_id: &str,
    ) -> Result<Option<AgentSessionTimeline>, String> {
        super::agent_session_timeline::read_pi_last_interaction(session_id)
    }
    fn timeline_with_usage_events(
        &self,
        _agent_type: &str,
        session_id: &str,
        usage_events: &mut Vec<AgentUsageEvent>,
    ) -> Result<AgentSessionTimeline, String> {
        super::agent_session_timeline::read_pi_timeline_with_events(session_id, usage_events)
    }
}

impl AgentSessionAdapter for CodexSessionAdapter {
    fn id(&self) -> &'static str {
        "codex"
    }
    fn agent_types(&self) -> &'static [&'static str] {
        &["codex-desktop", "codex-cli"]
    }
    fn source_watches(&self) -> Vec<NativeAgentSourceWatch> {
        super::agent_session_metadata::codex_source_watches()
    }
    fn list_sessions(&self) -> Vec<AgentSessionRow> {
        super::agent_session_metadata::list_codex_native_sessions()
    }
    fn timeline(&self, agent_type: &str, session_id: &str) -> Result<AgentSessionTimeline, String> {
        super::agent_session_timeline::read_codex_timeline(agent_type, session_id)
    }
    fn last_interaction(
        &self,
        agent_type: &str,
        session_id: &str,
    ) -> Result<Option<AgentSessionTimeline>, String> {
        super::agent_session_timeline::read_codex_last_interaction(agent_type, session_id)
    }
    fn incremental_source(&self, agent_type: &str, session_id: &str) -> Option<PathBuf> {
        super::agent_session_timeline::codex_session_file(agent_type, session_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registers_stable_adapters_and_runtime_agent_types() {
        assert_eq!(
            ADAPTERS
                .iter()
                .map(|adapter| adapter.id())
                .collect::<Vec<_>>(),
            vec!["claude-code", "opencode", "pi", "codex"]
        );
        assert_eq!(
            adapter_for_agent_type("codex-cli").map(|adapter| adapter.id()),
            Some("codex")
        );
        assert_eq!(
            adapter_for_agent_type("codex-desktop").map(|adapter| adapter.id()),
            Some("codex")
        );
        assert!(adapter_for_agent_type("missing").is_none());
    }
}
