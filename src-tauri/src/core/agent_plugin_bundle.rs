//! 编译期 Agent 插件总注册表。
//!
//! `plugin-registry.json` 声明产品能力；本模块把每个 Agent 的 Environment、Global Config、
//! Session 与 Identity 实现组合成一个类型化 Bundle。新增 Agent 只在这里登记一次，
//! 各能力模块不再分别维护 Agent roster。

use super::agent_environment::adapters::AgentEnvironmentAdapter;
use super::agent_global_config::adapters::AgentGlobalConfigAdapter;
use super::agent_identity_adapter::AgentIdentityAdapter;
use super::agent_session_adapter::AgentSessionAdapter;
use serde::Serialize;

pub(crate) struct AgentPluginBundle {
    pub(crate) id: &'static str,
    pub(crate) environment: &'static AgentEnvironmentAdapter,
    pub(crate) global_config: &'static dyn AgentGlobalConfigAdapter,
    pub(crate) session: &'static dyn AgentSessionAdapter,
    pub(crate) identity: &'static dyn AgentIdentityAdapter,
}

static BUNDLES: [AgentPluginBundle; 6] = [
    AgentPluginBundle {
        id: "claude-code",
        environment: &super::agent_environment::adapters::CLAUDE_CODE,
        global_config: super::agent_global_config::adapters::CLAUDE_CODE,
        session: super::agent_session_adapter::adapters::CLAUDE_CODE,
        identity: super::agent_identity_adapter::adapters::CLAUDE_CODE,
    },
    AgentPluginBundle {
        id: "opencode",
        environment: &super::agent_environment::adapters::OPENCODE,
        global_config: super::agent_global_config::adapters::OPENCODE,
        session: super::agent_session_adapter::adapters::OPENCODE,
        identity: super::agent_identity_adapter::adapters::OPENCODE,
    },
    AgentPluginBundle {
        id: "pi",
        environment: &super::agent_environment::adapters::PI,
        global_config: super::agent_global_config::adapters::PI,
        session: super::agent_session_adapter::adapters::PI,
        identity: super::agent_identity_adapter::adapters::PI,
    },
    AgentPluginBundle {
        id: "codex",
        environment: &super::agent_environment::adapters::CODEX,
        global_config: super::agent_global_config::adapters::CODEX,
        session: super::agent_session_adapter::adapters::CODEX,
        identity: super::agent_identity_adapter::adapters::CODEX,
    },
    AgentPluginBundle {
        id: "deepseek-harness",
        environment: &super::agent_environment::adapters::DEEPSEEK_HARNESS,
        global_config: super::agent_global_config::adapters::DEEPSEEK_HARNESS,
        session: super::agent_session_adapter::adapters::DEEPSEEK_HARNESS,
        identity: super::agent_identity_adapter::adapters::DEEPSEEK_HARNESS,
    },
    AgentPluginBundle {
        id: "hermes",
        environment: &super::agent_environment::adapters::HERMES,
        global_config: super::agent_global_config::adapters::HERMES,
        session: super::agent_session_adapter::adapters::HERMES,
        identity: super::agent_identity_adapter::adapters::HERMES,
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
            BUNDLES
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
        }
        assert_eq!(
            identity_adapters()
                .map(|adapter| adapter.id())
                .collect::<Vec<_>>(),
            vec!["claude-code", "pi", "deepseek-harness", "codex", "opencode", "hermes"]
        );
    }

    #[test]
    fn capability_report_joins_manifest_metadata_with_compiled_adapters() {
        let report = capabilities();
        let dsh = report
            .agents
            .iter()
            .find(|agent| agent.id == "deepseek-harness")
            .unwrap();
        assert_eq!(dsh.name, "DeepSeek Harness");
        assert_eq!(dsh.surfaces, vec!["web"]);
        assert_eq!(
            dsh.session_types
                .iter()
                .map(|session| session.id.as_str())
                .collect::<Vec<_>>(),
            vec!["deepseek-harness"]
        );
        assert_eq!(
            dsh.config_capabilities
                .iter()
                .map(|capability| capability.id.as_str())
                .collect::<Vec<_>>(),
            vec!["session-extension", "model-specs", "mcp-servers"]
        );
    }
}
