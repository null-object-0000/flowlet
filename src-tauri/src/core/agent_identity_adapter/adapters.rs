use super::AgentIdentityAdapter;

mod claude_code;
mod codex;
mod deepseek_harness;
mod opencode;
mod pi;

static CLAUDE_CODE_VALUE: claude_code::ClaudeCodeIdentityAdapter =
    claude_code::ClaudeCodeIdentityAdapter;
static OPENCODE_VALUE: opencode::OpenCodeIdentityAdapter = opencode::OpenCodeIdentityAdapter;
static PI_VALUE: pi::PiIdentityAdapter = pi::PiIdentityAdapter;
static CODEX_VALUE: codex::CodexIdentityAdapter = codex::CodexIdentityAdapter;
static DEEPSEEK_HARNESS_VALUE: deepseek_harness::DeepSeekHarnessIdentityAdapter =
    deepseek_harness::DeepSeekHarnessIdentityAdapter;

pub(crate) static CLAUDE_CODE: &dyn AgentIdentityAdapter = &CLAUDE_CODE_VALUE;
pub(crate) static OPENCODE: &dyn AgentIdentityAdapter = &OPENCODE_VALUE;
pub(crate) static PI: &dyn AgentIdentityAdapter = &PI_VALUE;
pub(crate) static CODEX: &dyn AgentIdentityAdapter = &CODEX_VALUE;
pub(crate) static DEEPSEEK_HARNESS: &dyn AgentIdentityAdapter = &DEEPSEEK_HARNESS_VALUE;

#[cfg(test)]
mod tests {
    #[test]
    fn registers_each_compiled_identity_adapter() {
        assert_eq!(
            crate::core::agent_plugin_bundle::identity_adapters()
                .map(|adapter| adapter.id())
                .collect::<Vec<_>>(),
            vec!["claude-code", "pi", "deepseek-harness", "codex", "opencode"]
        );
    }
}
