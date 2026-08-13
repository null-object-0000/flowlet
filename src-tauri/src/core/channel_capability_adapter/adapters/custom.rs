use super::super::*;

pub(super) const ADAPTER: ChannelCapabilityAdapter = ChannelCapabilityAdapter {
    id: "custom",
    preset_factory: ChannelPreset::custom,
    model_sync: ModelSyncAdapter::OpenAiCompatible {
        use_configured_models_endpoint: false,
    },
    balance_query: None,
    strips_openai_v1_path: false,
    console_scrape: ConsoleScrapeAdapter::None,
    login_page: LoginPageAdapter::None,
};
