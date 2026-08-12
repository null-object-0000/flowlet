use super::AgentGlobalConfigAdapter;
use crate::core::agent_global_config::{
    apply_codex, codex_auth_path, codex_config_path, codex_models_path, inspect_codex,
    restore_codex, AgentGlobalConfigOptions, AgentGlobalConfigReport,
};

pub(super) struct CodexAdapter;

impl AgentGlobalConfigAdapter for CodexAdapter {
    fn id(&self) -> &'static str {
        "codex"
    }

    fn inspect(&self, expected_base_url: &str) -> Result<AgentGlobalConfigReport, String> {
        inspect_codex(
            &codex_config_path(),
            &codex_auth_path(),
            &codex_models_path(),
            expected_base_url,
        )
    }

    fn apply(
        &self,
        expected_base_url: &str,
        client_token: &str,
        _options: Option<&AgentGlobalConfigOptions>,
    ) -> Result<AgentGlobalConfigReport, String> {
        apply_codex(
            &codex_config_path(),
            &codex_auth_path(),
            &codex_models_path(),
            expected_base_url,
            client_token,
        )
    }

    fn restore(&self, expected_base_url: &str) -> Result<AgentGlobalConfigReport, String> {
        restore_codex(
            &codex_config_path(),
            &codex_auth_path(),
            &codex_models_path(),
            expected_base_url,
        )
    }
}
