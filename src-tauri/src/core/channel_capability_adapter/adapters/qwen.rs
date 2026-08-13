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
    scrape_response: Some(ScrapeResponseAdapter {
        classify: classify_scrape_response,
        merge: no_scrape_response_merge,
        satisfies: scrape_response_satisfies,
    }),
};

fn classify_scrape_response(url: &str) -> Option<&'static str> {
    let normalized = url.to_ascii_lowercase().replace("%2f", "/");
    if normalized.contains("/tokenplan/personal/api/v2/subscription") {
        Some("subscription")
    } else if normalized.contains("/tokenplan/personal/api/v2/quota-config") {
        Some("quota_config")
    } else if normalized.contains("/tokenplan/personal/api/v2/reset-card/list") {
        Some("reset_card_list")
    } else if normalized.contains("/tokenplan/personal/api/v2/usage") {
        Some("usage")
    } else {
        None
    }
}

fn no_scrape_response_merge(_kind: &str, _existing: &str, _incoming: &str) -> Option<String> {
    None
}

fn scrape_response_satisfies(kind: &str, body: &str) -> Option<bool> {
    matches!(
        kind,
        "subscription" | "quota_config" | "reset_card_list" | "usage"
    )
    .then(|| serde_json::from_str::<serde_json::Value>(body).is_ok())
}
