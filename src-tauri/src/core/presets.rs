use super::config::{ChannelModel, ChannelPreset};

/// 返回所有内置渠道模板
pub fn builtin_channel_presets() -> Vec<ChannelPreset> {
    vec![ChannelPreset::longcat(), ChannelPreset::deepseek()]
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
