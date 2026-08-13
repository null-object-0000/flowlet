use super::super::*;

fn sync<'a>(
    account: &'a ChannelAccount,
    _preset: &'a ChannelPreset,
    config: &'a ChannelsConfig,
) -> ModelSyncFuture<'a> {
    Box::pin(crate::core::sync::sync_deepseek_models(account, config))
}

fn balance<'a>(account: &'a ChannelAccount, config: &'a ChannelsConfig) -> BalanceQueryFuture<'a> {
    Box::pin(crate::core::sync::query_deepseek_balance(account, config))
}

pub(super) const ADAPTER: ChannelCapabilityAdapter = ChannelCapabilityAdapter {
    id: "deepseek",
    preset_factory: ChannelPreset::deepseek,
    model_sync: sync,
    balance_query: Some(balance),
    strips_openai_v1_path: false,
    console_scrape: ConsoleScrapeAdapter::None,
    login_page: LoginPageAdapter::None,
};
