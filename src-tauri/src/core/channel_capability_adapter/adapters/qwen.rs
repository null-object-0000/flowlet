use super::super::*;

pub(super) const ADAPTER: ChannelCapabilityAdapter = ChannelCapabilityAdapter {
    id: "qwen",
    preset_factory: ChannelPreset::qwen,
    model_sync: ModelSyncAdapter::Qwen,
    balance_query: None,
    strips_openai_v1_path: false,
    console_scrape: ConsoleScrapeAdapter::ResourceMode {
        resource_mode: "token_plan",
        mode_key: "token_plan",
    },
    login_page: LoginPageAdapter::GenericOrHost("account.aliyun.com"),
};
