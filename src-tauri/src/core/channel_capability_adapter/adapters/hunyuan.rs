use super::super::*;

fn sync<'a>(
    account: &'a ChannelAccount,
    preset: &'a ChannelPreset,
    config: &'a ChannelsConfig,
) -> ModelSyncFuture<'a> {
    let models_url = account
        .effective_openai_base_url()
        .is_none()
        .then(|| config.models_endpoint_url(&account.channel_id))
        .flatten();
    Box::pin(crate::core::sync::sync_openai_compatible_models(
        account, preset, models_url,
    ))
}

pub(super) const ADAPTER: ChannelCapabilityAdapter = ChannelCapabilityAdapter {
    id: "hunyuan",
    preset_factory: ChannelPreset::hunyuan,
    model_sync: sync,
    balance_query: None,
    strips_openai_v1_path: false,
    uses_upstream_proxy_for_models: false,
    console_scrape: ConsoleScrapeAdapter::None,
    login_page: LoginPageAdapter::None,
    scrape_response: None,
};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::config::{AuthStrategy, ProtocolType};

    #[test]
    fn hunyuan_preserves_existing_hy4_and_adds_selected_flash_routes() {
        let config = ChannelsConfig::from_config_json(
            &serde_json::from_str(crate::core::channels_config::DEFAULT_CONFIG_JSON).unwrap(),
        )
        .unwrap();
        let preset = ChannelPreset::hunyuan();
        assert_eq!(preset.anthropic_auth, AuthStrategy::XApiKey);
        let account = ChannelAccount {
            id: "hy4-existing".into(),
            channel_id: "hunyuan".into(),
            api_key: "test-key".into(),
            enabled: true,
            synced_models: Some(vec!["hy4".into(), "hy4-flash".into(), "hy4-preview".into()]),
            exposed_models: Some(vec!["hy4".into(), "hy4-flash".into(), "hy4-preview".into()]),
            ..Default::default()
        };
        let mut routes = config.merge_default_routes(&[], &[account.clone()], &config.presets);
        assert_eq!(routes.len(), 6);
        assert_eq!(
            routes
                .iter()
                .filter(|r| r.virtual_model_id == "hy4")
                .count(),
            3
        );
        assert_eq!(
            routes
                .iter()
                .filter(|r| r.virtual_model_id == "hy4-flash")
                .count(),
            3
        );
        assert!(routes
            .iter()
            .any(|r| r.client_protocol == ProtocolType::Responses));
        routes[0].enabled = false;
        routes[0].priority = 37;
        let merged = config.merge_default_routes(&routes, &[account], &config.presets);
        assert_eq!(merged.len(), 6);
        assert!(!merged[0].enabled);
        assert_eq!(merged[0].priority, 37);
    }
}
