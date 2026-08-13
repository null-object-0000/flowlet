use super::{AgentGlobalConfigOptions, AgentGlobalConfigReport};

pub(super) mod claude_code;
pub(super) mod codex;
pub(super) mod opencode;
pub(super) mod pi;

pub(super) trait AgentGlobalConfigAdapter: Sync {
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

static CLAUDE_CODE: claude_code::ClaudeCodeAdapter = claude_code::ClaudeCodeAdapter;
static OPENCODE: opencode::OpenCodeAdapter = opencode::OpenCodeAdapter;
static PI: pi::PiAdapter = pi::PiAdapter;
static CODEX: codex::CodexAdapter = codex::CodexAdapter;
static ADAPTERS: [&'static dyn AgentGlobalConfigAdapter; 4] =
    [&CLAUDE_CODE, &OPENCODE, &PI, &CODEX];

fn find(adapter_id: &str) -> Option<&'static dyn AgentGlobalConfigAdapter> {
    ADAPTERS
        .iter()
        .copied()
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
            ADAPTERS
                .iter()
                .map(|adapter| adapter.id())
                .collect::<Vec<_>>(),
            vec!["claude-code", "opencode", "pi", "codex"]
        );
        for adapter_id in ["claude-code", "opencode", "pi", "codex"] {
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
