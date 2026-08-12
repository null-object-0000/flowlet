use super::AgentGlobalConfigAdapter;
use crate::core::agent_global_config::{
    apply_pi, inspect_pi, pi_auth_path, pi_extension_path, pi_models_path, pi_settings_path,
    restore_pi, AgentGlobalConfigOptions, AgentGlobalConfigReport,
};

pub(super) struct PiAdapter;

impl AgentGlobalConfigAdapter for PiAdapter {
    fn id(&self) -> &'static str {
        "pi"
    }

    fn inspect(&self, expected_base_url: &str) -> Result<AgentGlobalConfigReport, String> {
        inspect_pi(
            &pi_settings_path()?,
            &pi_models_path()?,
            &pi_auth_path()?,
            &pi_extension_path()?,
            expected_base_url,
        )
    }

    fn apply(
        &self,
        expected_base_url: &str,
        client_token: &str,
        options: Option<&AgentGlobalConfigOptions>,
    ) -> Result<AgentGlobalConfigReport, String> {
        apply_pi(
            &pi_settings_path()?,
            &pi_models_path()?,
            &pi_auth_path()?,
            &pi_extension_path()?,
            expected_base_url,
            client_token,
            options.map_or(true, |options| options.session_extension),
        )
    }

    fn restore(&self, expected_base_url: &str) -> Result<AgentGlobalConfigReport, String> {
        restore_pi(
            &pi_settings_path()?,
            &pi_models_path()?,
            &pi_auth_path()?,
            &pi_extension_path()?,
            expected_base_url,
        )
    }
}
