use super::AgentIdentityAdapter;

mod claude_code;
mod codex;
mod deepseek_harness;
mod opencode;
mod pi;

static CLAUDE_CODE: claude_code::ClaudeCodeIdentityAdapter = claude_code::ClaudeCodeIdentityAdapter;
static OPENCODE: opencode::OpenCodeIdentityAdapter = opencode::OpenCodeIdentityAdapter;
static PI: pi::PiIdentityAdapter = pi::PiIdentityAdapter;
static CODEX: codex::CodexIdentityAdapter = codex::CodexIdentityAdapter;
static DEEPSEEK_HARNESS: deepseek_harness::DeepSeekHarnessIdentityAdapter =
    deepseek_harness::DeepSeekHarnessIdentityAdapter;

static ADAPTERS: [&'static dyn AgentIdentityAdapter; 5] =
    [&CLAUDE_CODE, &PI, &DEEPSEEK_HARNESS, &CODEX, &OPENCODE];

pub(super) fn all() -> &'static [&'static dyn AgentIdentityAdapter] {
    &ADAPTERS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registers_each_compiled_identity_adapter() {
        assert_eq!(
            ADAPTERS
                .iter()
                .map(|adapter| adapter.id())
                .collect::<Vec<_>>(),
            vec!["claude-code", "pi", "deepseek-harness", "codex", "opencode"]
        );
    }
}
