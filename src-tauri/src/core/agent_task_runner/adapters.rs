use super::{AgentSurface, ExecutionOutcome, ProjectTask, Storage};
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

pub(crate) struct AgentTaskRunnerAdapter {
    pub(crate) id: &'static str,
    pub(crate) profile: &'static str,
    pub(crate) environment_adapter_id: &'static str,
    pub(crate) display_name: &'static str,
    pub(crate) required_surface: AgentSurface,
    pub(crate) supports_resume: bool,
    pub(crate) missing_executable_message: &'static str,
    pub(crate) resume_unsupported_message: &'static str,
    pub(super) execute: ExecuteRunner,
}

pub(crate) static CLAUDE_CODE: AgentTaskRunnerAdapter = AgentTaskRunnerAdapter {
    id: "claude-code",
    profile: "Claude Code",
    environment_adapter_id: "claude-code",
    display_name: "Claude Code",
    required_surface: AgentSurface::Cli,
    supports_resume: true,
    missing_executable_message:
        "未检测到 Claude Code CLI 可执行文件（接入配置不包含 CLI），请先安装 Claude Code 后重试。",
    resume_unsupported_message: "Claude Code 当前不支持续跑",
    execute: execute_claude_code_boxed,
};
pub(crate) static OPENCODE: AgentTaskRunnerAdapter = AgentTaskRunnerAdapter {
    id: "opencode",
    profile: "OpenCode",
    environment_adapter_id: "opencode",
    display_name: "OpenCode",
    required_surface: AgentSurface::Cli,
    supports_resume: true,
    missing_executable_message:
        "未检测到 OpenCode CLI 可执行文件（接入配置不包含 CLI），请先安装 OpenCode 后重试。",
    resume_unsupported_message: "OpenCode 当前不支持续跑",
    execute: execute_opencode_boxed,
};
pub(crate) static PI: AgentTaskRunnerAdapter = AgentTaskRunnerAdapter {
    id: "pi",
    profile: "Pi",
    environment_adapter_id: "pi",
    display_name: "Pi",
    required_surface: AgentSurface::Cli,
    supports_resume: true,
    missing_executable_message:
        "未检测到 Pi CLI 可执行文件（接入配置不包含 CLI），请先安装 Pi 后重试。",
    resume_unsupported_message: "Pi 当前不支持续跑",
    execute: execute_pi_boxed,
};
pub(crate) static CODEX: AgentTaskRunnerAdapter = AgentTaskRunnerAdapter {
    id: "codex",
    profile: "Codex",
    environment_adapter_id: "chatgpt-desktop",
    display_name: "Codex",
    required_surface: AgentSurface::Cli,
    supports_resume: true,
    missing_executable_message:
        "未检测到 Codex CLI 可执行文件（接入配置不包含 CLI），请先安装 Codex 后重试。",
    resume_unsupported_message: "Codex 当前不支持续跑",
    execute: execute_codex_boxed,
};
pub(crate) static DEEPSEEK_HARNESS: AgentTaskRunnerAdapter = AgentTaskRunnerAdapter {
        id: "deepseek-harness",
        profile: "DeepSeek Harness",
        environment_adapter_id: "deepseek-harness",
        display_name: "DeepSeek Harness",
        required_surface: AgentSurface::Web,
        supports_resume: false,
        missing_executable_message: "检测到 DeepSeek Harness 数据目录或 Web，但 PATH 中没有稳定的 dsh 启动命令；请先全局安装 @deepseek-ai/dsh。Flowlet 不会使用 npx 临时缓存执行任务。",
        resume_unsupported_message: "DeepSeek Harness headless 当前不提供稳定的 resume 参数；Flowlet 不会把续跑伪装成新会话。请将任务会话策略改为 fresh。",
        execute: execute_deepseek_harness_boxed,
    };

pub(super) fn for_profile(profile: &str) -> Option<&'static AgentTaskRunnerAdapter> {
    let normalized = profile.trim();
    if normalized.is_empty() {
        return crate::core::agent_plugin_bundle::bundles()
            .iter()
            .map(|bundle| bundle.runner)
            .find(|adapter| adapter.id == "claude-code");
    }
    crate::core::agent_plugin_bundle::bundles()
        .iter()
        .map(|bundle| bundle.runner)
        .find(|adapter| adapter.profile == normalized)
}

pub(super) fn has(adapter_id: &str) -> bool {
    crate::core::agent_plugin_bundle::bundles()
        .iter()
        .map(|bundle| bundle.runner)
        .any(|adapter| adapter.id == adapter_id)
}

pub(super) fn by_id(adapter_id: &str) -> Option<&'static AgentTaskRunnerAdapter> {
    crate::core::agent_plugin_bundle::bundles()
        .iter()
        .map(|bundle| bundle.runner)
        .find(|adapter| adapter.id == adapter_id)
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
            crate::core::agent_plugin_bundle::bundles()
                .iter()
                .map(|bundle| bundle.runner.id)
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
