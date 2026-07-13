use serde::Deserialize;
use std::path::PathBuf;

use super::config::{AuthStrategy, ChannelPreset, ModelPrice, PriceSource, ProtocolType};

/// 查找配置文件路径。
/// 搜索顺序：exe 目录 → 向上 1~4 级（dev 模式 target/debug/ → 项目根目录）→ CARGO_MANIFEST_DIR
pub fn find_config_file(name: &str) -> Option<PathBuf> {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))?;

    // 1. exe 所在目录（bundle.resources 复制后的位置）
    let path = exe_dir.join(name);
    if path.exists() {
        return Some(path);
    }

    // 2. 向上搜索 1~4 级目录（兼容 dev 模式 target/debug/ → 项目根目录）
    let mut current = exe_dir.as_path();
    for _ in 0..4 {
        if let Some(parent) = current.parent() {
            let path = parent.join(name);
            if path.exists() {
                return Some(path);
            }
            current = parent;
        } else {
            break;
        }
    }

    // 3. CARGO_MANIFEST_DIR（编译时源码根目录）
    if let Ok(manifest_dir) = std::env::var("CARGO_MANIFEST_DIR") {
        let path = PathBuf::from(manifest_dir).join(name);
        if path.exists() {
            return Some(path);
        }
    }

    None
}

// ─── JSON 反序列化结构 ─────────────────────────────────────────────────────

#[derive(Debug, Deserialize, Clone)]
pub struct ChannelConfigJson {
    pub channels: Vec<ChannelJson>,
    #[serde(default)]
    pub model_prices: Vec<ModelPriceJson>,
    #[serde(default)]
    pub default_exposed_models: std::collections::HashMap<String, Vec<String>>,
    #[serde(default)]
    pub flowlet_tiers: std::collections::HashMap<String, std::collections::HashMap<String, String>>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct ChannelJson {
    pub id: String,
    pub name: String,
    pub vendor: String,
    #[serde(default)]
    pub platform_url: Option<String>,
    #[serde(default)]
    pub supported_protocols: Vec<String>,
    #[serde(default)]
    pub openai_base_url: String,
    #[serde(default)]
    pub anthropic_base_url: String,
    #[serde(default)]
    pub openai_auth: String,
    #[serde(default)]
    pub anthropic_auth: String,
    #[serde(default)]
    pub default_model: String,
    #[serde(default)]
    pub small_model: Option<String>,
    #[serde(default)]
    pub supports_model_list: bool,
    #[serde(default)]
    pub supports_model_detail: bool,
    #[serde(default)]
    pub supports_price_sync: bool,
    #[serde(default)]
    pub supports_balance_query: bool,
    #[serde(default)]
    pub supports_quota_query: bool,
    #[serde(default)]
    pub supports_usage_query: bool,
}

#[derive(Debug, Deserialize, Clone)]
pub struct ModelPriceJson {
    pub channel_id: String,
    pub upstream_model: String,
    #[serde(default)]
    pub input_uncached_price: f64,
    #[serde(default)]
    pub input_cached_price: f64,
    #[serde(default)]
    pub output_price: f64,
    #[serde(default)]
    pub currency: String,
    #[serde(default)]
    pub unit: String,
}

// ─── 运行时渠道配置 ─────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct ChannelsConfig {
    pub presets: Vec<ChannelPreset>,
    pub prices: Vec<ModelPrice>,
    pub default_exposed_models: std::collections::HashMap<String, Vec<String>>,
    pub flowlet_tiers: std::collections::HashMap<String, std::collections::HashMap<String, String>>,
}

impl ChannelsConfig {
    /// 加载 channels.json。文件必须存在，不存在则报错。
    pub fn load() -> Result<Self, String> {
        let path = find_config_file("channels.json")
            .ok_or_else(|| "找不到 channels.json（已搜索: exe 目录, 项目根目录）".to_string())?;

        let content = std::fs::read_to_string(&path)
            .map_err(|e| format!("读取 channels.json 失败 ({}): {}", path.display(), e))?;

        Self::parse(&content)
    }

    /// 从字符串解析配置
    pub fn parse(content: &str) -> Result<Self, String> {
        let json: ChannelConfigJson = serde_json::from_str(content)
            .map_err(|e| format!("解析 channels.json 失败: {e}"))?;

        let now = chrono::Utc::now().to_rfc3339();

        let presets: Vec<ChannelPreset> = json.channels.into_iter().map(|c| {
            let protocols = parse_protocols(&c.supported_protocols);
            ChannelPreset {
                id: c.id,
                name: c.name,
                vendor: c.vendor,
                supported_protocols: protocols,
                openai_base_url: c.openai_base_url,
                anthropic_base_url: c.anthropic_base_url,
                openai_auth: parse_auth_strategy(&c.openai_auth),
                anthropic_auth: parse_auth_strategy(&c.anthropic_auth),
                default_model: c.default_model,
                small_model: c.small_model,
                timeout_seconds: None,
                supports_model_list: c.supports_model_list,
                supports_model_detail: c.supports_model_detail,
                supports_price_sync: c.supports_price_sync,
                supports_balance_query: c.supports_balance_query,
                supports_quota_query: c.supports_quota_query,
                supports_usage_query: c.supports_usage_query,
                platform_url: c.platform_url,
                created_at: now.clone(),
                updated_at: now.clone(),
            }
        }).collect();

        let prices: Vec<ModelPrice> = json.model_prices.into_iter().map(|p| {
            ModelPrice {
                id: format!("price-{}-{}", p.channel_id, p.upstream_model),
                channel_id: p.channel_id,
                upstream_model: p.upstream_model,
                input_uncached_price: p.input_uncached_price,
                input_cached_price: p.input_cached_price,
                output_price: p.output_price,
                currency: p.currency,
                unit: p.unit,
                source: PriceSource::Preset,
                synced_at: None,
                created_at: now.clone(),
                updated_at: now.clone(),
            }
        }).collect();

        Ok(Self {
            presets,
            prices,
            default_exposed_models: json.default_exposed_models,
            flowlet_tiers: json.flowlet_tiers,
        })
    }

    /// 获取 DeepSeek 余额端点
    pub fn balance_endpoint(&self) -> String {
        self.presets.iter()
            .find(|c| c.id == "deepseek")
            .map(|c| c.openai_base_url.clone() + "/user/balance")
            .unwrap_or_else(|| "https://api.deepseek.com/user/balance".to_string())
    }

    /// 获取 LongCat 模型列表端点
    pub fn longcat_models_endpoint(&self) -> String {
        self.presets.iter()
            .find(|c| c.id == "longcat")
            .map(|c| c.openai_base_url.clone() + "/v1/models")
            .unwrap_or_else(|| "https://api.longcat.chat/openai/v1/models".to_string())
    }

    /// 获取 LongCat 模型详情端点模板
    pub fn longcat_model_detail_endpoint(&self) -> String {
        self.presets.iter()
            .find(|c| c.id == "longcat")
            .map(|c| c.openai_base_url.clone() + "/v1/models/{id}")
            .unwrap_or_else(|| "https://api.longcat.chat/openai/v1/models/{id}".to_string())
    }

    /// 获取 DeepSeek 模型列表端点
    pub fn deepseek_models_endpoint(&self) -> String {
        self.presets.iter()
            .find(|c| c.id == "deepseek")
            .map(|c| c.openai_base_url.clone() + "/models")
            .unwrap_or_else(|| "https://api.deepseek.com/models".to_string())
    }

    /// 获取 Flowlet 档位
    pub fn flowlet_tier(&self, channel_id: &str, model: &str) -> String {
        let normalized = model.trim().to_lowercase();
        self.flowlet_tiers
            .get(channel_id)
            .and_then(|m| m.get(&normalized))
            .cloned()
            .unwrap_or_else(|| "none".to_string())
    }

    /// 获取默认开放模型列表
    pub fn default_exposed_models(&self, channel_id: &str) -> Vec<String> {
        self.default_exposed_models
            .get(channel_id)
            .cloned()
            .unwrap_or_default()
    }

    /// 获取指定渠道的 models 端点 URL（用于测试连接）
    pub fn models_endpoint_url(&self, channel_id: &str) -> Option<String> {
        self.presets.iter().find(|c| c.id == channel_id).map(|c| {
            if c.id == "deepseek" {
                format!("{}/models", c.openai_base_url)
            } else {
                format!("{}/v1/models", c.openai_base_url)
            }
        })
    }
}

fn parse_protocols(raw: &[String]) -> Vec<ProtocolType> {
    raw.iter()
        .map(|p| match p.as_str() {
            "anthropic" => ProtocolType::Anthropic,
            _ => ProtocolType::OpenAi,
        })
        .collect()
}

fn parse_auth_strategy(raw: &str) -> AuthStrategy {
    match raw {
        "x_api_key" => AuthStrategy::XApiKey,
        _ => AuthStrategy::Bearer,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_minimal_config() {
        let json = r#"{
            "channels": [{
                "id": "test",
                "name": "Test",
                "vendor": "test"
            }],
            "model_prices": [],
            "default_exposed_models": {},
            "flowlet_tiers": {}
        }"#;
        let config = ChannelsConfig::parse(json).unwrap();
        assert_eq!(config.presets.len(), 1);
        assert_eq!(config.presets[0].id, "test");
    }

    #[test]
    fn parse_full_config() {
        let json = r#"{
            "channels": [{
                "id": "deepseek",
                "name": "DeepSeek",
                "vendor": "deepseek",
                "supported_protocols": ["openai", "anthropic"],
                "openai_base_url": "https://api.deepseek.com",
                "anthropic_base_url": "https://api.deepseek.com/anthropic",
                "openai_auth": "bearer",
                "anthropic_auth": "x_api_key",
                "default_model": "deepseek-v4-pro",
                "supports_model_list": true,
                "supports_balance_query": true
            }],
            "model_prices": [{
                "channel_id": "deepseek",
                "upstream_model": "deepseek-v4-flash",
                "input_uncached_price": 1.0,
                "output_price": 2.0,
                "currency": "CNY",
                "unit": "1M tokens"
            }],
            "default_exposed_models": {
                "deepseek": ["deepseek-v4-flash"]
            },
            "flowlet_tiers": {
                "deepseek": {
                    "deepseek-v4-flash": "flash"
                }
            }
        }"#;
        let config = ChannelsConfig::parse(json).unwrap();
        assert_eq!(config.presets.len(), 1);
        assert_eq!(config.prices.len(), 1);
        assert_eq!(config.default_exposed_models("deepseek"), vec!["deepseek-v4-flash".to_string()]);
        assert_eq!(config.flowlet_tier("deepseek", "deepseek-v4-flash"), "flash");
    }
}
