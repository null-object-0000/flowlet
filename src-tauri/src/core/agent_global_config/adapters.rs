use super::{AgentGlobalConfigOptions, AgentGlobalConfigReport};

pub(super) mod claude_code;
pub(super) mod codex;
pub(super) mod deepseek_harness;
pub(super) mod opencode;
pub(super) mod pi;

pub(crate) trait AgentGlobalConfigAdapter: Sync {
    fn id(&self) -> &'static str;
    fn inspect(&self, expected_base_url: &str) -> Result<AgentGlobalConfigReport, String>;
    fn apply(
        &self,
        expected_base_url: &str,
        client_token: &str,
        options: Option<&AgentGlobalConfigOptions>,
    ) -> Result<AgentGlobalConfigReport, String>;
    fn restore(&self, expected_base_url: &str) -> Result<AgentGlobalConfigReport, String>;
}

static CLAUDE_CODE_VALUE: claude_code::ClaudeCodeAdapter = claude_code::ClaudeCodeAdapter;
static OPENCODE_VALUE: opencode::OpenCodeAdapter = opencode::OpenCodeAdapter;
static PI_VALUE: pi::PiAdapter = pi::PiAdapter;
static CODEX_VALUE: codex::CodexAdapter = codex::CodexAdapter;
static DEEPSEEK_HARNESS_VALUE: deepseek_harness::DeepSeekHarnessAdapter =
    deepseek_harness::DeepSeekHarnessAdapter;

pub(crate) static CLAUDE_CODE: &dyn AgentGlobalConfigAdapter = &CLAUDE_CODE_VALUE;
pub(crate) static OPENCODE: &dyn AgentGlobalConfigAdapter = &OPENCODE_VALUE;
pub(crate) static PI: &dyn AgentGlobalConfigAdapter = &PI_VALUE;
pub(crate) static CODEX: &dyn AgentGlobalConfigAdapter = &CODEX_VALUE;
pub(crate) static DEEPSEEK_HARNESS: &dyn AgentGlobalConfigAdapter = &DEEPSEEK_HARNESS_VALUE;

fn find(adapter_id: &str) -> Option<&'static dyn AgentGlobalConfigAdapter> {
    crate::core::agent_plugin_bundle::bundles()
        .iter()
        .map(|bundle| bundle.global_config)
        .find(|adapter| adapter.id() == adapter_id)
}

pub(super) fn adapter(adapter_id: &str) -> Result<&'static dyn AgentGlobalConfigAdapter, String> {
    find(adapter_id).ok_or_else(|| format!("暂不支持管理 Agent 全局配置：{adapter_id}"))
}

pub(super) fn has_adapter(adapter_id: &str) -> bool {
    find(adapter_id).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_every_compiled_adapter() {
        assert_eq!(
            crate::core::agent_plugin_bundle::bundles()
                .iter()
                .map(|bundle| bundle.global_config.id())
                .collect::<Vec<_>>(),
            vec!["claude-code", "opencode", "pi", "codex", "deepseek-harness"]
        );
        for adapter_id in ["claude-code", "opencode", "pi", "codex", "deepseek-harness"] {
            assert!(has_adapter(adapter_id), "missing adapter: {adapter_id}");
            assert!(adapter(adapter_id).is_ok());
        }
    }

    #[test]
    fn rejects_unknown_adapter_without_fallback() {
        assert!(!has_adapter("missing"));
        let error = match adapter("missing") {
            Ok(_) => panic!("unknown adapter must be rejected"),
            Err(error) => error,
        };
        assert_eq!(error, "暂不支持管理 Agent 全局配置：missing");
    }
}
