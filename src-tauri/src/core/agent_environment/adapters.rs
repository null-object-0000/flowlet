use super::AgentEnvironmentReport;
use std::future::Future;
use std::pin::Pin;

mod claude_code;
pub(in crate::core::agent_environment) mod codex;
mod deepseek_harness;
mod hermes;
mod opencode;
mod pi;

type DetectionFuture = Pin<Box<dyn Future<Output = AgentEnvironmentReport> + Send>>;
pub(crate) type DetectEnvironment = fn() -> DetectionFuture;

pub(crate) struct AgentEnvironmentAdapter {
    pub(crate) id: &'static str,
    pub(crate) detect: DetectEnvironment,
    pub(crate) runtime: Option<&'static crate::core::agent_runtime::AgentRuntimeAdapter>,
}

pub(crate) static CLAUDE_CODE: AgentEnvironmentAdapter = AgentEnvironmentAdapter {
    id: "claude-code",
    detect: claude_code::detect_boxed,
    runtime: None,
};
pub(crate) static OPENCODE: AgentEnvironmentAdapter = AgentEnvironmentAdapter {
    id: "opencode",
    detect: opencode::detect_boxed,
    runtime: None,
};
pub(crate) static PI: AgentEnvironmentAdapter = AgentEnvironmentAdapter {
    id: "pi",
    detect: pi::detect_boxed,
    runtime: None,
};
pub(crate) static CODEX: AgentEnvironmentAdapter = AgentEnvironmentAdapter {
    id: "chatgpt-desktop",
    detect: codex::detect_boxed,
    runtime: None,
};
pub(crate) static DEEPSEEK_HARNESS: AgentEnvironmentAdapter = AgentEnvironmentAdapter {
    id: "deepseek-harness",
    detect: deepseek_harness::detect_boxed,
    runtime: Some(&deepseek_harness::RUNTIME),
};
pub(crate) static HERMES: AgentEnvironmentAdapter = AgentEnvironmentAdapter {
    id: "hermes",
    detect: hermes::detect_boxed,
    runtime: None,
};

pub(super) fn get(adapter_id: &str) -> Option<&'static AgentEnvironmentAdapter> {
    crate::core::agent_plugin_bundle::bundles()
        .iter()
        .map(|bundle| bundle.environment)
        .find(|adapter| adapter.id == adapter_id)
}

pub(super) fn has(adapter_id: &str) -> bool {
    get(adapter_id).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_every_compiled_adapter_without_unknown_fallback() {
        assert_eq!(
            crate::core::agent_plugin_bundle::bundles()
                .iter()
                .map(|bundle| bundle.environment.id)
                .collect::<Vec<_>>(),
            vec![
                "claude-code",
                "opencode",
                "pi",
                "chatgpt-desktop",
                "deepseek-harness",
                "hermes"
            ]
        );
        assert!(has("claude-code"));
        assert!(has("chatgpt-desktop"));
        assert!(has("hermes"));
        assert!(!has("codex"));
        assert!(!has("unknown"));
    }
}
