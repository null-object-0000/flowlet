//! 编译期 Agent 插件总注册表。
//!
//! `plugin-registry.json` 声明产品能力；本模块把每个 Agent 的 Environment、Global Config、
//! Session、Identity 与 Runner 实现组合成一个类型化 Bundle。新增 Agent 只在这里登记一次，
//! 各能力模块不再分别维护 Agent roster。

use super::agent_environment::adapters::AgentEnvironmentAdapter;
use super::agent_global_config::adapters::AgentGlobalConfigAdapter;
use super::agent_identity_adapter::AgentIdentityAdapter;
use super::agent_session_adapter::AgentSessionAdapter;
use super::agent_task_runner::adapters::AgentTaskRunnerAdapter;
use serde::Serialize;

pub(crate) struct AgentPluginBundle {
    pub(crate) id: &'static str,
    pub(crate) environment: &'static AgentEnvironmentAdapter,
    pub(crate) global_config: &'static dyn AgentGlobalConfigAdapter,
    pub(crate) session: &'static dyn AgentSessionAdapter,
    pub(crate) identity: &'static dyn AgentIdentityAdapter,
    pub(crate) runner: &'static AgentTaskRunnerAdapter,
}

static BUNDLES: [AgentPluginBundle; 6] = [
    AgentPluginBundle {
        id: "claude-code",
        environment: &super::agent_environment::adapters::CLAUDE_CODE,
        global_config: super::agent_global_config::adapters::CLAUDE_CODE,
        session: super::agent_session_adapter::adapters::CLAUDE_CODE,
        identity: super::agent_identity_adapter::adapters::CLAUDE_CODE,
        runner: &super::agent_task_runner::adapters::CLAUDE_CODE,
    },
    AgentPluginBundle {
        id: "opencode",
        environment: &super::agent_environment::adapters::OPENCODE,
        global_config: super::agent_global_config::adapters::OPENCODE,
        session: super::agent_session_adapter::adapters::OPENCODE,
        identity: super::agent_identity_adapter::adapters::OPENCODE,
        runner: &super::agent_task_runner::adapters::OPENCODE,
    },
    AgentPluginBundle {
        id: "pi",
        environment: &super::agent_environment::adapters::PI,
        global_config: super::agent_global_config::adapters::PI,
        session: super::agent_session_adapter::adapters::PI,
        identity: super::agent_identity_adapter::adapters::PI,
        runner: &super::agent_task_runner::adapters::PI,
    },
    AgentPluginBundle {
        id: "codex",
        environment: &super::agent_environment::adapters::CODEX,
        global_config: super::agent_global_config::adapters::CODEX,
        session: super::agent_session_adapter::adapters::CODEX,
        identity: super::agent_identity_adapter::adapters::CODEX,
        runner: &super::agent_task_runner::adapters::CODEX,
    },
    AgentPluginBundle {
        id: "deepseek-harness",
        environment: &super::agent_environment::adapters::DEEPSEEK_HARNESS,
        global_config: super::agent_global_config::adapters::DEEPSEEK_HARNESS,
        session: super::agent_session_adapter::adapters::DEEPSEEK_HARNESS,
        identity: super::agent_identity_adapter::adapters::DEEPSEEK_HARNESS,
        runner: &super::agent_task_runner::adapters::DEEPSEEK_HARNESS,
    },
    AgentPluginBundle {
        id: "hermes",
        environment: &super::agent_environment::adapters::HERMES,
        global_config: super::agent_global_config::adapters::HERMES,
        session: super::agent_session_adapter::adapters::HERMES,
        identity: super::agent_identity_adapter::adapters::HERMES,
        runner: &super::agent_task_runner::adapters::HERMES,
    },
];

pub(crate) fn bundles() -> &'static [AgentPluginBundle] {
    &BUNDLES
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentCapabilitiesReport {
    pub agents: Vec<AgentCapability>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentCapability {
    pub id: String,
    pub name: String,
    pub surfaces: Vec<String>,
    pub session_types: Vec<AgentSessionCapability>,
    pub task: AgentTaskCapability,
    pub config_capabilities: Vec<AgentConfigCapability>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentSessionCapability {
    pub id: String,
    pub name: String,
    pub client_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentTaskCapability {
    pub profile: String,
    pub session_type: String,
    pub required_surface: super::agent_environment::AgentSurface,
    pub supports_resume: bool,
    pub resume_unsupported_message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentConfigCapability {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub default_enabled: bool,
    pub requires_restart: bool,
}

/// 对外只暴露经过 JSON 声明与编译期 Bundle 双重校验后的能力。
pub(crate) fn capabilities() -> AgentCapabilitiesReport {
    let registry = super::plugin_registry::plugin_registry();
    let agents = registry
        .agents()
        .iter()
        .map(|descriptor| {
            let bundle = BUNDLES
                .iter()
                .find(|bundle| bundle.id == descriptor.id)
                .expect("plugin registry 已校验所有 Agent Adapter");
            AgentCapability {
                id: descriptor.id.clone(),
                name: descriptor.name.clone(),
                surfaces: descriptor.surfaces.clone(),
                session_types: descriptor
                    .session_types
                    .iter()
                    .map(|session| AgentSessionCapability {
                        id: session.id.clone(),
                        name: session.name.clone(),
                        client_id: session.client_id.clone(),
                    })
                    .collect(),
                task: AgentTaskCapability {
                    profile: bundle.runner.profile.to_string(),
                    session_type: descriptor.task_profile.session_type.clone(),
                    required_surface: bundle.runner.required_surface.clone(),
                    supports_resume: bundle.runner.supports_resume,
                    resume_unsupported_message: bundle
                        .runner
                        .resume_unsupported_message
                        .to_string(),
                },
                config_capabilities: descriptor
                    .config_capabilities
                    .iter()
                    .map(|capability| AgentConfigCapability {
                        id: capability.id.clone(),
                        name: capability.name.clone(),
                        kind: capability.kind.clone(),
                        default_enabled: capability.default_enabled,
                        requires_restart: capability.requires_restart,
                    })
                    .collect(),
            }
        })
        .collect();
    AgentCapabilitiesReport { agents }
}

/// 保留既有 Session Header 冲突时的识别优先级；产品展示顺序仍使用 Bundle/注册表顺序。
const IDENTITY_PRECEDENCE: [&str; 6] =
    ["claude-code", "pi", "deepseek-harness", "codex", "opencode", "hermes"];

pub(crate) fn identity_adapters() -> impl Iterator<Item = &'static dyn AgentIdentityAdapter> {
    IDENTITY_PRECEDENCE.iter().filter_map(|id| {
        BUNDLES
            .iter()
            .find(|bundle| bundle.id == *id)
            .map(|bundle| bundle.identity)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registers_each_agent_once_with_all_compiled_capabilities() {
        assert_eq!(
            bundles().iter().map(|bundle| bundle.id).collect::<Vec<_>>(),
            vec!["claude-code", "opencode", "pi", "codex", "deepseek-harness", "hermes"]
        );
        for bundle in bundles() {
            assert_eq!(bundle.id, bundle.global_config.id());
            assert_eq!(bundle.id, bundle.session.id());
            assert_eq!(bundle.id, bundle.identity.id());
            assert_eq!(bundle.id, bundle.runner.id);
        }
        assert_eq!(
            identity_adapters()
                .map(|adapter| adapter.id())
                .collect::<Vec<_>>(),
            vec!["claude-code", "pi", "deepseek-harness", "codex", "opencode", "hermes"]
        );
    }

    #[test]
    fn capability_report_joins_manifest_metadata_with_runner_contracts() {
        let report = capabilities();
        let dsh = report
            .agents
            .iter()
            .find(|agent| agent.id == "deepseek-harness")
            .unwrap();
        assert_eq!(dsh.surfaces, vec!["web"]);
        assert_eq!(dsh.task.profile, "DeepSeek Harness");
        assert_eq!(
            dsh.task.required_surface,
            super::super::agent_environment::AgentSurface::Web
        );
        assert!(!dsh.task.supports_resume);
        assert!(dsh.task.resume_unsupported_message.contains("resume"));
        assert_eq!(dsh.config_capabilities[0].id, "session-extension");
    }
}
