use super::AgentEnvironmentReport;
use std::future::Future;
use std::pin::Pin;

mod claude_code;
pub(in crate::core::agent_environment) mod codex;
mod deepseek_harness;
mod opencode;
mod pi;

type DetectionFuture = Pin<Box<dyn Future<Output = AgentEnvironmentReport> + Send>>;
pub(crate) type DetectEnvironment = fn() -> DetectionFuture;

pub(crate) struct AgentEnvironmentAdapter {
    pub(crate) id: &'static str,
    pub(crate) detect: DetectEnvironment,
}

pub(crate) static CLAUDE_CODE: AgentEnvironmentAdapter = AgentEnvironmentAdapter {
    id: "claude-code",
    detect: claude_code::detect_boxed,
};
pub(crate) static OPENCODE: AgentEnvironmentAdapter = AgentEnvironmentAdapter {
    id: "opencode",
    detect: opencode::detect_boxed,
};
pub(crate) static PI: AgentEnvironmentAdapter = AgentEnvironmentAdapter {
    id: "pi",
    detect: pi::detect_boxed,
};
pub(crate) static CODEX: AgentEnvironmentAdapter = AgentEnvironmentAdapter {
    id: "chatgpt-desktop",
    detect: codex::detect_boxed,
};
pub(crate) static DEEPSEEK_HARNESS: AgentEnvironmentAdapter = AgentEnvironmentAdapter {
    id: "deepseek-harness",
    detect: deepseek_harness::detect_boxed,
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
                "deepseek-harness"
            ]
        );
        assert!(has("claude-code"));
        assert!(has("chatgpt-desktop"));
        assert!(!has("codex"));
        assert!(!has("unknown"));
    }
}
