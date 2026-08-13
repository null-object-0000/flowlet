use super::{ExecutionOutcome, ProjectTask, Storage};
use std::future::Future;
use std::pin::Pin;

pub(super) mod claude_code;
pub(super) mod codex;
pub(super) mod deepseek_harness;
pub(super) mod opencode;
pub(super) mod pi;

type RunnerFuture<'a> = Pin<Box<dyn Future<Output = Result<ExecutionOutcome, String>> + Send + 'a>>;
type ExecuteRunner = for<'a> fn(
    &'a Storage,
    &'a str,
    &'a ProjectTask,
    &'a str,
    &'a str,
    &'a str,
    Option<&'a str>,
    bool,
) -> RunnerFuture<'a>;

pub(super) struct AgentTaskRunnerAdapter {
    pub(super) id: &'static str,
    pub(super) profile: &'static str,
    pub(super) environment_adapter_id: &'static str,
    pub(super) display_name: &'static str,
    pub(super) execute: ExecuteRunner,
}

static RUNNER_ADAPTERS: [AgentTaskRunnerAdapter; 5] = [
    AgentTaskRunnerAdapter {
        id: "claude-code",
        profile: "Claude Code",
        environment_adapter_id: "claude-code",
        display_name: "Claude Code",
        execute: execute_claude_code_boxed,
    },
    AgentTaskRunnerAdapter {
        id: "opencode",
        profile: "OpenCode",
        environment_adapter_id: "opencode",
        display_name: "OpenCode",
        execute: execute_opencode_boxed,
    },
    AgentTaskRunnerAdapter {
        id: "pi",
        profile: "Pi",
        environment_adapter_id: "pi",
        display_name: "Pi",
        execute: execute_pi_boxed,
    },
    AgentTaskRunnerAdapter {
        id: "codex",
        profile: "Codex",
        environment_adapter_id: "chatgpt-desktop",
        display_name: "Codex",
        execute: execute_codex_boxed,
    },
    AgentTaskRunnerAdapter {
        id: "deepseek-harness",
        profile: "DeepSeek Harness",
        environment_adapter_id: "deepseek-harness",
        display_name: "DeepSeek Harness",
        execute: execute_deepseek_harness_boxed,
    },
];

pub(super) fn for_profile(profile: &str) -> Option<&'static AgentTaskRunnerAdapter> {
    let normalized = profile.trim();
    if normalized.is_empty() {
        return RUNNER_ADAPTERS
            .iter()
            .find(|adapter| adapter.id == "claude-code");
    }
    RUNNER_ADAPTERS
        .iter()
        .find(|adapter| adapter.profile == normalized)
}

pub(super) fn has(adapter_id: &str) -> bool {
    RUNNER_ADAPTERS
        .iter()
        .any(|adapter| adapter.id == adapter_id)
}

macro_rules! boxed_runner {
    ($name:ident, $execute:path) => {
        fn $name<'a>(
            storage: &'a Storage,
            executable: &'a str,
            task: &'a ProjectTask,
            project_id: &'a str,
            job_id: &'a str,
            prompt: &'a str,
            resume_session: Option<&'a str>,
            manage_task_state: bool,
        ) -> RunnerFuture<'a> {
            Box::pin($execute(
                storage,
                executable,
                task,
                project_id,
                job_id,
                prompt,
                resume_session,
                manage_task_state,
            ))
        }
    };
}

boxed_runner!(execute_claude_code_boxed, claude_code::execute_claude_code);
boxed_runner!(execute_opencode_boxed, opencode::execute_opencode);
boxed_runner!(execute_pi_boxed, pi::execute_pi);
boxed_runner!(execute_codex_boxed, codex::execute_codex);
boxed_runner!(
    execute_deepseek_harness_boxed,
    deepseek_harness::execute_deepseek_harness
);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_every_compiled_runner_without_unknown_fallback() {
        assert_eq!(
            RUNNER_ADAPTERS
                .iter()
                .map(|adapter| adapter.id)
                .collect::<Vec<_>>(),
            vec!["claude-code", "opencode", "pi", "codex", "deepseek-harness"]
        );
        assert_eq!(
            for_profile("").map(|adapter| adapter.id),
            Some("claude-code")
        );
        assert!(for_profile("missing").is_none());
        assert!(!has("missing"));
    }
}
