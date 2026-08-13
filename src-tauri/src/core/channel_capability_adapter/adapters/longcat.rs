use super::super::*;

fn sync<'a>(
    account: &'a ChannelAccount,
    _preset: &'a ChannelPreset,
    config: &'a ChannelsConfig,
) -> ModelSyncFuture<'a> {
    Box::pin(crate::core::sync::sync_longcat_models(account, config))
}

pub(super) const ADAPTER: ChannelCapabilityAdapter = ChannelCapabilityAdapter {
    id: "longcat",
    preset_factory: ChannelPreset::longcat,
    model_sync: sync,
    balance_query: None,
    strips_openai_v1_path: false,
    console_scrape: ConsoleScrapeAdapter::Fixed("hybrid"),
    login_page: LoginPageAdapter::Generic,
};
