use super::super::*;

pub(super) const ADAPTER: ChannelCapabilityAdapter = ChannelCapabilityAdapter {
    id: "longcat",
    preset_factory: ChannelPreset::longcat,
    model_sync: ModelSyncAdapter::LongCat,
    balance_query: None,
    strips_openai_v1_path: false,
    console_scrape: ConsoleScrapeAdapter::Fixed("hybrid"),
    login_page: LoginPageAdapter::Generic,
};
