use super::super::*;

fn sync<'a>(
    account: &'a ChannelAccount,
    preset: &'a ChannelPreset,
    config: &'a ChannelsConfig,
) -> ModelSyncFuture<'a> {
    let models_url = config.models_endpoint_url(&account.channel_id);
    Box::pin(crate::core::sync::sync_openai_compatible_models(
        account, preset, models_url,
    ))
}

pub(super) const ADAPTER: ChannelCapabilityAdapter = ChannelCapabilityAdapter {
    id: "zhipu",
    preset_factory: ChannelPreset::zhipu,
    model_sync: sync,
    balance_query: None,
    strips_openai_v1_path: true,
    console_scrape: ConsoleScrapeAdapter::None,
    login_page: LoginPageAdapter::None,
};
