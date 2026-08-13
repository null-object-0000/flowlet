use super::super::*;

pub(super) const ADAPTER: ChannelCapabilityAdapter = ChannelCapabilityAdapter {
    id: "zhipu",
    preset_factory: ChannelPreset::zhipu,
    model_sync: ModelSyncAdapter::OpenAiCompatible {
        use_configured_models_endpoint: true,
    },
    balance_query: None,
    strips_openai_v1_path: true,
    console_scrape: ConsoleScrapeAdapter::None,
    login_page: LoginPageAdapter::None,
};
