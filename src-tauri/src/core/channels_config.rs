use serde::Deserialize;
use super::config::{AuthStrategy, ChannelPreset, ModelPrice, PriceSource, ProtocolType};

/// 编译时随应用固化的默认配置。
///
/// 外部 config.json 仍然优先；这个副本只用于配置缺失、旧版本配置不含
/// `channels_config` 或打包资源路径异常时，避免桌面进程在创建窗口和托盘前退出。
pub const DEFAULT_CONFIG_JSON: &str =
    include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../config.json"));

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
    /// 渠道级端点覆盖，key 例如 "models" / "model_detail" / "balance"。
    /// 优先于此处的配置，缺失时回退到 openai_base_url 拼接逻辑。
    #[serde(default)]
    pub endpoints: std::collections::HashMap<String, String>,
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
    /// 每个渠道的端点覆盖，key 为 channel_id → (endpoint_key → url)
    pub endpoints: std::collections::HashMap<String, std::collections::HashMap<String, String>>,
}

impl ChannelsConfig {
    /// 从 config.json 顶层对象的 `channels_config` 字段解析渠道配置。
    pub fn from_config_json(config_json: &serde_json::Value) -> Result<Self, String> {
        let channels_config = config_json
            .get("channels_config")
            .ok_or_else(|| "config.json 中缺少 channels_config 字段".to_string())?;

        let json: ChannelConfigJson = serde_json::from_value(channels_config.clone())
            .map_err(|e| format!("解析 config.json > channels_config 失败: {e}"))?;

        let now = chrono::Utc::now().to_rfc3339();

        // 必须先 borrow 出 endpoints（不能与下面的 into_iter 同周期 move）
        let endpoints: std::collections::HashMap<String, std::collections::HashMap<String, String>> = json
            .channels
            .iter()
            .map(|c| (c.id.clone(), c.endpoints.clone()))
            .collect();

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
            endpoints,
        })
    }

    /// 从指定渠道的 endpoints 覆盖中读取一个端点 URL，缺失时调用
    /// fallback 基于 openai_base_url 拼接，再缺失则返回 default。
    fn endpoint_or<F>(
        &self,
        channel_id: &str,
        key: &str,
        fallback: F,
    ) -> String
    where
        F: FnOnce(&ChannelPreset) -> String,
    {
        if let Some(overrides) = self.endpoints.get(channel_id) {
            if let Some(url) = overrides.get(key) {
                return url.clone();
            }
        }
        self.presets
            .iter()
            .find(|c| c.id == channel_id)
            .map(fallback)
            .filter(|s| !s.is_empty())
            .unwrap_or_default()
    }

    /// 获取 DeepSeek 余额端点
    pub fn balance_endpoint(&self) -> String {
        self.endpoint_or("deepseek", "balance", |c| {
            format!("{}/user/balance", c.openai_base_url)
        })
    }

    /// 获取 LongCat 模型列表端点
    pub fn longcat_models_endpoint(&self) -> String {
        self.endpoint_or("longcat", "models", |c| {
            format!("{}/v1/models", c.openai_base_url)
        })
    }

    /// 获取 LongCat 模型详情端点模板
    pub fn longcat_model_detail_endpoint(&self) -> String {
        self.endpoint_or("longcat", "model_detail", |c| {
            format!("{}/v1/models/{{id}}", c.openai_base_url)
        })
    }

    /// 获取 DeepSeek 模型列表端点
    pub fn deepseek_models_endpoint(&self) -> String {
        self.endpoint_or("deepseek", "models", |c| {
            format!("{}/models", c.openai_base_url)
        })
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

    /// 获取指定渠道的 models 端点 URL（用于测试连接）。
    /// 优先使用配置中 endpoints["models"] 覆盖，缺失时按渠道拼接。
    pub fn models_endpoint_url(&self, channel_id: &str) -> Option<String> {
        // 1. 配置的显式覆盖
        if let Some(overrides) = self.endpoints.get(channel_id) {
            if let Some(url) = overrides.get("models") {
                return Some(url.clone());
            }
        }
        // 2. 按老逻辑拼接
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
        let json = serde_json::json!({
            "channels_config": {
                "channels": [{
                    "id": "test",
                    "name": "Test",
                    "vendor": "test"
                }],
                "model_prices": [],
                "default_exposed_models": {},
                "flowlet_tiers": {}
            }
        });
        let config = ChannelsConfig::from_config_json(&json).unwrap();
        assert_eq!(config.presets.len(), 1);
        assert_eq!(config.presets[0].id, "test");
        assert_eq!(config.endpoints.len(), 1);
    }

    #[test]
    fn parse_full_config() {
        let json = serde_json::json!({
            "channels_config": {
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
                    "supports_balance_query": true,
                    "endpoints": {
                        "models": "https://api.deepseek.com/models",
                        "balance": "https://api.deepseek.com/user/balance"
                    }
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
            }
        });
        let config = ChannelsConfig::from_config_json(&json).unwrap();
        assert_eq!(config.presets.len(), 1);
        assert_eq!(config.prices.len(), 1);
        assert_eq!(config.default_exposed_models("deepseek"), vec!["deepseek-v4-flash".to_string()]);
        assert_eq!(config.flowlet_tier("deepseek", "deepseek-v4-flash"), "flash");
        // 覆盖端点生效
        assert_eq!(config.deepseek_models_endpoint(), "https://api.deepseek.com/models");
        assert_eq!(config.balance_endpoint(), "https://api.deepseek.com/user/balance");
        assert_eq!(config.models_endpoint_url("deepseek").as_deref(), Some("https://api.deepseek.com/models"));
    }
}
