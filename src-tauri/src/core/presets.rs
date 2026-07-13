use super::config::{ChannelModel, ChannelPreset, ModelPrice, PriceSource};

/// 返回所有内置渠道模板
pub fn builtin_channel_presets() -> Vec<ChannelPreset> {
    vec![ChannelPreset::longcat(), ChannelPreset::deepseek()]
}

/// 返回指定渠道的预设模型价格
pub fn builtin_model_prices(channel_id: &str) -> Vec<ModelPrice> {
    match channel_id {
        "longcat" => longcat_prices(),
        "deepseek" => deepseek_prices(),
        _ => Vec::new(),
    }
}

fn longcat_prices() -> Vec<ModelPrice> {
    let now = chrono::Utc::now().to_rfc3339();
    vec![ModelPrice {
        id: "price-longcat-2.0-input".to_string(),
        channel_id: "longcat".to_string(),
        upstream_model: "LongCat-2.0".to_string(),
        input_uncached_price: 0.0,
        input_cached_price: 0.0,
        output_price: 0.0,
        currency: "CNY".to_string(),
        unit: "1M tokens".to_string(),
        source: PriceSource::Preset,
        synced_at: None,
        created_at: now.clone(),
        updated_at: now,
    }]
}

fn deepseek_prices() -> Vec<ModelPrice> {
    let now = chrono::Utc::now().to_rfc3339();
    vec![
        ModelPrice {
            id: "price-deepseek-v4-flash".to_string(),
            channel_id: "deepseek".to_string(),
            upstream_model: "deepseek-v4-flash".to_string(),
            input_uncached_price: 1.0,
            input_cached_price: 0.02,
            output_price: 2.0,
            currency: "CNY".to_string(),
            unit: "1M tokens".to_string(),
            source: PriceSource::Preset,
            synced_at: None,
            created_at: now.clone(),
            updated_at: now.clone(),
        },
        ModelPrice {
            id: "price-deepseek-v4-pro".to_string(),
            channel_id: "deepseek".to_string(),
            upstream_model: "deepseek-v4-pro".to_string(),
            input_uncached_price: 3.0,
            input_cached_price: 0.025,
            output_price: 6.0,
            currency: "CNY".to_string(),
            unit: "1M tokens".to_string(),
            source: PriceSource::Preset,
            synced_at: None,
            created_at: now.clone(),
            updated_at: now,
        },
    ]
}

/// 模型列表同步结果
#[derive(Debug, Clone, serde::Serialize)]
pub struct ModelSyncResult {
    pub models_synced: usize,
    pub models: Vec<ChannelModel>,
    pub errors: Vec<String>,
}

/// 余额查询结果
#[derive(Debug, Clone, serde::Serialize)]
pub struct BalanceQueryResult {
    pub balance: Option<f64>,
    pub currency: Option<String>,
    pub is_available: bool,
    pub error: Option<String>,
}
