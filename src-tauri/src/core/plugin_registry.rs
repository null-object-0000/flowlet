use serde::Deserialize;
use std::collections::HashSet;
use std::sync::OnceLock;

const PLUGIN_REGISTRY_JSON: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../plugin-registry.json"
));

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginRegistryJson {
    schema_version: u32,
    plugins: Vec<PluginDescriptor>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
enum PluginDescriptor {
    Channel {
        id: String,
        #[serde(rename = "channelId")]
        channel_id: String,
        #[serde(rename = "adapterId")]
        adapter_id: String,
    },
    ModelCatalog {
        id: String,
        source: String,
    },
    Agent {
        id: String,
        agent: AgentPluginDescriptor,
    },
}

impl PluginDescriptor {
    fn plugin_id(&self) -> &str {
        match self {
            Self::Channel { id, .. } | Self::ModelCatalog { id, .. } | Self::Agent { id, .. } => id,
        }
    }
    fn contribution_key(&self) -> String {
        match self {
            Self::Channel { channel_id, .. } => format!("channel:{channel_id}"),
            Self::ModelCatalog { source, .. } => format!("model-catalog:{source}"),
            Self::Agent { agent, .. } => format!("agent:{}", agent.id),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPluginDescriptor {
    pub id: String,
    pub name: String,
    pub environment_adapter_id: String,
    pub global_config_adapter_id: String,
    pub session_adapter_id: String,
    pub runner_adapter_id: String,
    pub endpoint_suffix: String,
    pub npm_package: String,
    pub surfaces: Vec<String>,
}

#[derive(Debug)]
pub struct PluginRegistry {
    channels: Vec<ChannelPluginDescriptor>,
    model_catalog_source: String,
    agents: Vec<AgentPluginDescriptor>,
}

#[derive(Debug)]
pub struct ChannelPluginDescriptor {
    pub id: String,
    pub adapter_id: String,
}

impl PluginRegistry {
    fn from_json(json: &str) -> Result<Self, String> {
        let parsed: PluginRegistryJson = serde_json::from_str(json)
            .map_err(|error| format!("解析 plugin-registry.json 失败：{error}"))?;
        if parsed.schema_version != 2 {
            return Err(format!(
                "不支持的 plugin-registry.json schemaVersion：{}",
                parsed.schema_version
            ));
        }
        let mut plugin_ids = HashSet::new();
        let mut contributions = HashSet::new();
        let mut channels = Vec::new();
        let mut agents = Vec::new();
        let mut model_catalogs = 0;
        let mut model_catalog_source = String::new();
        for plugin in parsed.plugins {
            if plugin.plugin_id().trim().is_empty()
                || !plugin_ids.insert(plugin.plugin_id().to_string())
            {
                return Err(format!(
                    "plugin-registry.json 存在空或重复插件 ID：{}",
                    plugin.plugin_id()
                ));
            }
            let contribution = plugin.contribution_key();
            if !contributions.insert(contribution.clone()) {
                return Err(format!("plugin-registry.json 存在重复贡献：{contribution}"));
            }
            match plugin {
                PluginDescriptor::Channel {
                    channel_id,
                    adapter_id,
                    ..
                } => {
                    if channel_id.trim().is_empty() || adapter_id.trim().is_empty() {
                        return Err(format!("渠道插件声明不完整：{channel_id}"));
                    }
                    if !crate::core::channel_capability_adapter::has_channel_capability_adapter(
                        &adapter_id,
                    ) {
                        return Err(format!(
                            "渠道插件 {channel_id} 引用了未知适配器：{adapter_id}"
                        ));
                    }
                    channels.push(ChannelPluginDescriptor {
                        id: channel_id,
                        adapter_id,
                    });
                }
                PluginDescriptor::ModelCatalog { source, .. } => {
                    if source != "model-catalog.json" {
                        return Err(format!("暂不支持的模型目录插件来源：{source}"));
                    }
                    model_catalogs += 1;
                    model_catalog_source = source;
                }
                PluginDescriptor::Agent { agent, .. } => {
                    if !matches!(agent.endpoint_suffix.as_str(), "/v1" | "/anthropic")
                        || agent.id.trim().is_empty()
                        || agent.name.trim().is_empty()
                        || agent.environment_adapter_id.trim().is_empty()
                        || agent.global_config_adapter_id.trim().is_empty()
                        || agent.session_adapter_id.trim().is_empty()
                        || agent.runner_adapter_id.trim().is_empty()
                        || agent.npm_package.trim().is_empty()
                        || agent.surfaces.is_empty()
                    {
                        return Err(format!("Agent 插件声明不完整：{}", agent.id));
                    }
                    if !crate::core::agent_environment::has_environment_adapter(
                        &agent.environment_adapter_id,
                    ) {
                        return Err(format!(
                            "Agent 插件 {} 引用了未知环境适配器：{}",
                            agent.id, agent.environment_adapter_id
                        ));
                    }
                    if !crate::core::agent_global_config::has_global_config_adapter(
                        &agent.global_config_adapter_id,
                    ) {
                        return Err(format!(
                            "Agent 插件 {} 引用了未知全局配置适配器：{}",
                            agent.id, agent.global_config_adapter_id
                        ));
                    }
                    if !crate::core::agent_session_adapter::has_session_adapter(
                        &agent.session_adapter_id,
                    ) {
                        return Err(format!(
                            "Agent 插件 {} 引用了未知会话适配器：{}",
                            agent.id, agent.session_adapter_id
                        ));
                    }
                    if !crate::core::agent_task_runner::has_runner_adapter(&agent.runner_adapter_id)
                    {
                        return Err(format!(
                            "Agent 插件 {} 引用了未知任务执行适配器：{}",
                            agent.id, agent.runner_adapter_id
                        ));
                    }
                    agents.push(agent);
                }
            }
        }
        if model_catalogs != 1 {
            return Err("plugin-registry.json 必须注册且只能注册一个内置模型目录".to_string());
        }
        Ok(Self {
            channels,
            model_catalog_source,
            agents,
        })
    }

    pub fn channel_ids(&self) -> impl Iterator<Item = &str> {
        self.channels.iter().map(|channel| channel.id.as_str())
    }
    pub fn channels(&self) -> &[ChannelPluginDescriptor] {
        &self.channels
    }
    pub fn channel(&self, channel_id: &str) -> Option<&ChannelPluginDescriptor> {
        self.channels
            .iter()
            .find(|channel| channel.id == channel_id)
    }
    pub fn model_catalog_source(&self) -> &str {
        &self.model_catalog_source
    }
    pub fn agents(&self) -> &[AgentPluginDescriptor] {
        &self.agents
    }
    pub fn agent(&self, agent_id: &str) -> Option<&AgentPluginDescriptor> {
        self.agents.iter().find(|agent| agent.id == agent_id)
    }
}

pub fn plugin_registry() -> &'static PluginRegistry {
    static REGISTRY: OnceLock<PluginRegistry> = OnceLock::new();
    REGISTRY.get_or_init(|| {
        PluginRegistry::from_json(PLUGIN_REGISTRY_JSON)
            .expect("内置 plugin-registry.json 必须通过结构和冲突校验")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_registry_has_stable_builtin_contributions() {
        let registry = plugin_registry();
        assert_eq!(
            registry.channel_ids().collect::<Vec<_>>(),
            vec![
                "longcat",
                "deepseek",
                "kimi",
                "qwen",
                "custom",
                "zhipu",
                "openrouter"
            ]
        );
        assert_eq!(
            registry
                .agents()
                .iter()
                .map(|agent| agent.id.as_str())
                .collect::<Vec<_>>(),
            vec!["claude-code", "opencode", "pi", "codex"]
        );
        assert_eq!(
            registry.agent("claude-code").unwrap().endpoint_suffix,
            "/anthropic"
        );
        assert_eq!(
            registry.agent("codex").unwrap().environment_adapter_id,
            "chatgpt-desktop"
        );
        assert_eq!(
            registry.agent("codex").unwrap().global_config_adapter_id,
            "codex"
        );
        assert_eq!(registry.agent("codex").unwrap().session_adapter_id, "codex");
        assert_eq!(registry.agent("codex").unwrap().runner_adapter_id, "codex");
    }

    #[test]
    fn duplicate_contributions_are_rejected() {
        let duplicate = r#"{"schemaVersion":2,"plugins":[{"id":"models","kind":"model-catalog","source":"model-catalog.json"},{"id":"a","kind":"channel","channelId":"same","adapterId":"longcat"},{"id":"b","kind":"channel","channelId":"same","adapterId":"deepseek"}]}"#;
        assert!(PluginRegistry::from_json(duplicate)
            .unwrap_err()
            .contains("重复贡献"));
    }

    #[test]
    fn unknown_compiled_adapters_are_rejected() {
        let unknown = r#"{"schemaVersion":2,"plugins":[{"id":"models","kind":"model-catalog","source":"model-catalog.json"},{"id":"a","kind":"channel","channelId":"demo","adapterId":"missing"}]}"#;
        assert!(PluginRegistry::from_json(unknown)
            .unwrap_err()
            .contains("未知适配器"));
    }

    #[test]
    fn unknown_agent_global_config_adapter_is_rejected() {
        let unknown = r#"{"schemaVersion":2,"plugins":[{"id":"models","kind":"model-catalog","source":"model-catalog.json"},{"id":"agent","kind":"agent","agent":{"id":"demo","name":"Demo","environmentAdapterId":"pi","globalConfigAdapterId":"missing","sessionAdapterId":"pi","runnerAdapterId":"pi","endpointSuffix":"/v1","npmPackage":"demo","surfaces":["cli"]}}]}"#;
        let error = PluginRegistry::from_json(unknown).unwrap_err();
        assert!(error.contains("未知全局配置适配器"));
        assert!(error.contains("missing"));
    }

    #[test]
    fn unknown_agent_environment_adapter_is_rejected() {
        let unknown = r#"{"schemaVersion":2,"plugins":[{"id":"models","kind":"model-catalog","source":"model-catalog.json"},{"id":"agent","kind":"agent","agent":{"id":"demo","name":"Demo","environmentAdapterId":"missing","globalConfigAdapterId":"pi","sessionAdapterId":"pi","runnerAdapterId":"pi","endpointSuffix":"/v1","npmPackage":"demo","surfaces":["cli"]}}]}"#;
        let error = PluginRegistry::from_json(unknown).unwrap_err();
        assert!(error.contains("未知环境适配器"));
        assert!(error.contains("missing"));
    }

    #[test]
    fn unknown_agent_session_adapter_is_rejected() {
        let unknown = r#"{"schemaVersion":2,"plugins":[{"id":"models","kind":"model-catalog","source":"model-catalog.json"},{"id":"agent","kind":"agent","agent":{"id":"demo","name":"Demo","environmentAdapterId":"pi","globalConfigAdapterId":"pi","sessionAdapterId":"missing","runnerAdapterId":"pi","endpointSuffix":"/v1","npmPackage":"demo","surfaces":["cli"]}}]}"#;
        let error = PluginRegistry::from_json(unknown).unwrap_err();
        assert!(error.contains("未知会话适配器"));
        assert!(error.contains("missing"));
    }

    #[test]
    fn unknown_agent_runner_adapter_is_rejected() {
        let unknown = r#"{"schemaVersion":2,"plugins":[{"id":"models","kind":"model-catalog","source":"model-catalog.json"},{"id":"agent","kind":"agent","agent":{"id":"demo","name":"Demo","environmentAdapterId":"pi","globalConfigAdapterId":"pi","sessionAdapterId":"pi","runnerAdapterId":"missing","endpointSuffix":"/v1","npmPackage":"demo","surfaces":["cli"]}}]}"#;
        let error = PluginRegistry::from_json(unknown).unwrap_err();
        assert!(error.contains("未知任务执行适配器"));
        assert!(error.contains("missing"));
    }
}
