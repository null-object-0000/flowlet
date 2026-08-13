use super::super::*;

fn sync<'a>(
    account: &'a ChannelAccount,
    _preset: &'a ChannelPreset,
    config: &'a ChannelsConfig,
) -> ModelSyncFuture<'a> {
    Box::pin(crate::core::sync::sync_qwen_models(account, config))
}

pub(super) const ADAPTER: ChannelCapabilityAdapter = ChannelCapabilityAdapter {
    id: "qwen",
    preset_factory: ChannelPreset::qwen,
    model_sync: sync,
    balance_query: None,
    strips_openai_v1_path: false,
    console_scrape: ConsoleScrapeAdapter::ResourceMode {
        resource_mode: "token_plan",
        mode_key: "token_plan",
    },
    login_page: LoginPageAdapter::GenericOrHost("account.aliyun.com"),
};
