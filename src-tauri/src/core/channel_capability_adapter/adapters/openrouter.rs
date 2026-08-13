use super::super::*;

pub(super) const ADAPTER: ChannelCapabilityAdapter = ChannelCapabilityAdapter {
    id: "openrouter",
    preset_factory: ChannelPreset::openrouter,
    model_sync: ModelSyncAdapter::OpenAiCompatible {
        use_configured_models_endpoint: true,
    },
    balance_query: Some(BalanceQueryAdapter::OpenRouter),
    strips_openai_v1_path: false,
    console_scrape: ConsoleScrapeAdapter::None,
    login_page: LoginPageAdapter::None,
};
