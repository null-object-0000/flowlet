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
    pub environment_id: String,
    pub endpoint_suffix: String,
    pub npm_package: String,
    pub surfaces: Vec<String>,
}

#[derive(Debug)]
pub struct PluginRegistry {
    channel_ids: Vec<String>,
    model_catalog_source: String,
    agents: Vec<AgentPluginDescriptor>,
}

impl PluginRegistry {
    fn from_json(json: &str) -> Result<Self, String> {
        let parsed: PluginRegistryJson = serde_json::from_str(json)
            .map_err(|error| format!("解析 plugin-registry.json 失败：{error}"))?;
        if parsed.schema_version != 1 {
            return Err(format!(
                "不支持的 plugin-registry.json schemaVersion：{}",
                parsed.schema_version
            ));
        }
        let mut plugin_ids = HashSet::new();
        let mut contributions = HashSet::new();
        let mut channel_ids = Vec::new();
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
                PluginDescriptor::Channel { channel_id, .. } => channel_ids.push(channel_id),
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
                        || agent.environment_id.trim().is_empty()
                        || agent.npm_package.trim().is_empty()
                        || agent.surfaces.is_empty()
                    {
                        return Err(format!("Agent 插件声明不完整：{}", agent.id));
                    }
                    agents.push(agent);
                }
            }
        }
        if model_catalogs != 1 {
            return Err("plugin-registry.json 必须注册且只能注册一个内置模型目录".to_string());
        }
        Ok(Self {
            channel_ids,
            model_catalog_source,
            agents,
        })
    }

    pub fn channel_ids(&self) -> impl Iterator<Item = &str> {
        self.channel_ids.iter().map(String::as_str)
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
            registry.agent("codex").unwrap().environment_id,
            "chatgpt-desktop"
        );
    }

    #[test]
    fn duplicate_contributions_are_rejected() {
        let duplicate = r#"{"schemaVersion":1,"plugins":[{"id":"models","kind":"model-catalog","source":"model-catalog.json"},{"id":"a","kind":"channel","channelId":"same"},{"id":"b","kind":"channel","channelId":"same"}]}"#;
        assert!(PluginRegistry::from_json(duplicate)
            .unwrap_err()
            .contains("重复贡献"));
    }
}
