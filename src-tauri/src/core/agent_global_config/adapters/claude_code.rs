use super::AgentGlobalConfigAdapter;
use crate::core::agent_global_config::{
    apply_claude_code, claude_settings_path, inspect_claude_code, restore_claude_code,
    AgentGlobalConfigOptions, AgentGlobalConfigReport,
};

pub(super) struct ClaudeCodeAdapter;

impl AgentGlobalConfigAdapter for ClaudeCodeAdapter {
    fn id(&self) -> &'static str {
        "claude-code"
    }

    fn inspect(&self, expected_base_url: &str) -> Result<AgentGlobalConfigReport, String> {
        inspect_claude_code(&claude_settings_path()?, expected_base_url)
    }

    fn apply(
        &self,
        expected_base_url: &str,
        client_token: &str,
        options: Option<&AgentGlobalConfigOptions>,
    ) -> Result<AgentGlobalConfigReport, String> {
        let (primary_long_context, fast_long_context) = options
            .map(AgentGlobalConfigOptions::claude_long_context)
            .unwrap_or((false, false));
        apply_claude_code(
            &claude_settings_path()?,
            expected_base_url,
            client_token,
            primary_long_context,
            fast_long_context,
        )
    }

    fn restore(&self, expected_base_url: &str) -> Result<AgentGlobalConfigReport, String> {
        restore_claude_code(&claude_settings_path()?, expected_base_url)
    }
}
