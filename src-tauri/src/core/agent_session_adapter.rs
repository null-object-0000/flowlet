use super::agent_session_metadata::NativeAgentSourceWatch;
use super::config::{AgentSessionRow, AgentSessionTimeline, AgentUsageEvent};
use std::path::PathBuf;

pub(crate) mod adapters;

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

pub(crate) fn session_adapters() -> impl Iterator<Item = &'static dyn AgentSessionAdapter> {
    super::agent_plugin_bundle::bundles()
        .iter()
        .map(|bundle| bundle.session)
}

pub(crate) fn adapter_for_agent_type(agent_type: &str) -> Option<&'static dyn AgentSessionAdapter> {
    session_adapters().find(|adapter| adapter.agent_types().contains(&agent_type))
}

pub(crate) fn has_session_adapter(adapter_id: &str) -> bool {
    session_adapters().any(|adapter| adapter.id() == adapter_id)
}

pub(crate) fn session_types_for_adapter(adapter_id: &str) -> Option<&'static [&'static str]> {
    session_adapters()
        .find(|adapter| adapter.id() == adapter_id)
        .map(|adapter| adapter.agent_types())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registers_stable_adapters_and_runtime_agent_types() {
        assert_eq!(
            session_adapters()
                .map(|adapter| adapter.id())
                .collect::<Vec<_>>(),
            vec!["claude-code", "opencode", "pi", "codex", "deepseek-harness", "hermes"]
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
        assert_eq!(
            adapter_for_agent_type("deepseek-harness").map(|adapter| adapter.id()),
            Some("deepseek-harness")
        );
        assert_eq!(
            adapter_for_agent_type("hermes").map(|adapter| adapter.id()),
            Some("hermes")
        );
    }
}
