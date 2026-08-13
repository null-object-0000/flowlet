use super::super::*;

pub(super) const ADAPTER: ChannelCapabilityAdapter = ChannelCapabilityAdapter {
    id: "deepseek",
    preset_factory: ChannelPreset::deepseek,
    model_sync: ModelSyncAdapter::DeepSeek,
    balance_query: Some(BalanceQueryAdapter::DeepSeek),
    strips_openai_v1_path: false,
    console_scrape: ConsoleScrapeAdapter::None,
    login_page: LoginPageAdapter::None,
};
