use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SecretStorage {
    Plaintext,
}

impl Default for SecretStorage {
    fn default() -> Self {
        Self::Plaintext
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderConfig {
    pub name: String,
    pub base_url: String,
    pub api_key: String,
    #[serde(default)]
    pub api_key_storage: SecretStorage,
    pub default_model: String,
    #[serde(default = "default_upstream_timeout_seconds")]
    pub upstream_timeout_seconds: u64,
    pub enabled: bool,
}

impl Default for ProviderConfig {
    fn default() -> Self {
        Self {
            name: "LongCat 主账号".to_string(),
            base_url: "https://api.longcat.chat/openai".to_string(),
            api_key: String::new(),
            api_key_storage: SecretStorage::Plaintext,
            default_model: "LongCat-2.0".to_string(),
            upstream_timeout_seconds: default_upstream_timeout_seconds(),
            enabled: true,
        }
    }
}

pub fn default_upstream_timeout_seconds() -> u64 {
    120
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct ClientConfig {
    pub id: String,
    pub name: String,
    pub token: String,
    pub app_type: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct VirtualModel {
    pub name: String,
    pub protocol_type: String,
    pub routing_strategy: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct VirtualModelRoute {
    pub id: String,
    pub virtual_model: String,
    pub provider_name: String,
    pub upstream_model: String,
    pub priority: i64,
    pub enabled: bool,
}

impl VirtualModelRoute {
    pub fn default_auto(default_model: String) -> Self {
        Self {
            id: "auto-default".to_string(),
            virtual_model: "auto".to_string(),
            provider_name: "default".to_string(),
            upstream_model: default_model,
            priority: 0,
            enabled: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelPrice {
    pub id: String,
    pub provider_id: String,
    pub model: String,
    pub input_price: f64,
    pub output_price: f64,
    pub currency: String,
    pub unit: String,
}
