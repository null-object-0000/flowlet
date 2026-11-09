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
    id: "openai-api",
    preset_factory: ChannelPreset::openai_api,
    model_sync: sync,
    balance_query: None,
    strips_openai_v1_path: false,
    uses_upstream_proxy_for_models: true,
    console_scrape: ConsoleScrapeAdapter::None,
    login_page: LoginPageAdapter::None,
    scrape_response: None,
};

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        http::{HeaderMap, StatusCode},
        routing::get,
        Router,
    };

    #[tokio::test]
    async fn openai_api_sync_uses_project_key_and_override_and_reports_errors() {
        let app = Router::new().route("/v1/models", get(|headers: HeaderMap| async move {
            match headers.get("authorization").and_then(|value| value.to_str().ok()) {
                Some("Bearer test-project-key") => (StatusCode::OK, r#"{"data":[{"id":"gpt-6.1-sol","created":2},{"id":"unsupported-model","created":1},{"id":""}]}"#),
                Some("Bearer empty") => (StatusCode::OK, r#"{"data":[]}"#),
                Some("Bearer malformed") => (StatusCode::OK, "invalid-json"),
                _ => (StatusCode::UNAUTHORIZED, "invalid API key"),
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let json = serde_json::from_str(crate::core::channels_config::DEFAULT_CONFIG_JSON).unwrap();
        let config = ChannelsConfig::from_config_json(&json).unwrap();
        let preset = ChannelPreset::openai_api();
        let mut account = ChannelAccount {
            channel_id: "openai-api".into(),
            api_key: "test-project-key".into(),
            base_url_override: Some(format!("http://{addr}/v1")),
            ..Default::default()
        };
        let result = sync(&account, &preset, &config).await;
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(result.models_synced, 2); // Unsupported IDs remain visible in the editor.
        assert_eq!(result.models[0].model, "gpt-6.1-sol");
        assert_eq!(
            result.models[0].supported_protocols,
            preset.supported_protocols
        );
        assert_eq!(result.models[0].context_window, None);
        account.api_key = "empty".into();
        let empty = sync(&account, &preset, &config).await;
        assert!(empty.models.is_empty() && empty.errors.is_empty());
        account.api_key = "bad-key".into();
        assert!(sync(&account, &preset, &config).await.errors[0].contains("401"));
        account.api_key = "malformed".into();
        assert!(!sync(&account, &preset, &config).await.errors.is_empty());
        server.abort();
    }
}
