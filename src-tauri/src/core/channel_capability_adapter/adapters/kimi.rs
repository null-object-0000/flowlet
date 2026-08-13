use super::super::*;

pub(super) const ADAPTER: ChannelCapabilityAdapter = ChannelCapabilityAdapter {
    id: "kimi",
    preset_factory: ChannelPreset::kimi,
    model_sync: ModelSyncAdapter::Kimi,
    balance_query: Some(BalanceQueryAdapter::Kimi),
    strips_openai_v1_path: false,
    console_scrape: ConsoleScrapeAdapter::None,
    login_page: LoginPageAdapter::None,
};
