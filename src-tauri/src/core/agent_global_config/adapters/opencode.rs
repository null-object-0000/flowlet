use super::AgentGlobalConfigAdapter;
use crate::core::agent_global_config::{
    apply_opencode, inspect_opencode, opencode_auth_path, opencode_permission_plugin_path,
    opencode_settings_path, restore_opencode, AgentGlobalConfigOptions, AgentGlobalConfigReport,
};

pub(super) struct OpenCodeAdapter;

impl AgentGlobalConfigAdapter for OpenCodeAdapter {
    fn id(&self) -> &'static str {
        "opencode"
    }

    fn inspect(&self, expected_base_url: &str) -> Result<AgentGlobalConfigReport, String> {
        inspect_opencode(
            &opencode_settings_path()?,
            &opencode_auth_path()?,
            &opencode_permission_plugin_path()?,
            expected_base_url,
        )
    }

    fn apply(
        &self,
        expected_base_url: &str,
        client_token: &str,
        _options: Option<&AgentGlobalConfigOptions>,
    ) -> Result<AgentGlobalConfigReport, String> {
        apply_opencode(
            &opencode_settings_path()?,
            &opencode_auth_path()?,
            &opencode_permission_plugin_path()?,
            expected_base_url,
            client_token,
        )
    }

    fn restore(&self, expected_base_url: &str) -> Result<AgentGlobalConfigReport, String> {
        restore_opencode(
            &opencode_settings_path()?,
            &opencode_auth_path()?,
            &opencode_permission_plugin_path()?,
            expected_base_url,
        )
    }
}
