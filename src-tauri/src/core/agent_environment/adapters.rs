use super::AgentEnvironmentReport;
use std::future::Future;
use std::pin::Pin;

mod claude_code;
pub(in crate::core::agent_environment) mod codex;
mod opencode;
mod pi;

type DetectionFuture = Pin<Box<dyn Future<Output = AgentEnvironmentReport> + Send>>;
type DetectEnvironment = fn() -> DetectionFuture;

pub(super) struct AgentEnvironmentAdapter {
    pub(super) id: &'static str,
    pub(super) detect: DetectEnvironment,
}

static ADAPTERS: [AgentEnvironmentAdapter; 4] = [
    AgentEnvironmentAdapter {
        id: "claude-code",
        detect: claude_code::detect_boxed,
    },
    AgentEnvironmentAdapter {
        id: "opencode",
        detect: opencode::detect_boxed,
    },
    AgentEnvironmentAdapter {
        id: "pi",
        detect: pi::detect_boxed,
    },
    AgentEnvironmentAdapter {
        id: "chatgpt-desktop",
        detect: codex::detect_boxed,
    },
];

pub(super) fn get(adapter_id: &str) -> Option<&'static AgentEnvironmentAdapter> {
    ADAPTERS.iter().find(|adapter| adapter.id == adapter_id)
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
            ADAPTERS
                .iter()
                .map(|adapter| adapter.id)
                .collect::<Vec<_>>(),
            vec!["claude-code", "opencode", "pi", "chatgpt-desktop"]
        );
        assert!(has("claude-code"));
        assert!(has("chatgpt-desktop"));
        assert!(!has("codex"));
        assert!(!has("unknown"));
    }
}
