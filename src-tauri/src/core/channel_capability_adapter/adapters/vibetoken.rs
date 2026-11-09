use super::super::*;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct BalanceResponse {
    available: f64,
    currency: String,
}

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

fn balance<'a>(account: &'a ChannelAccount, config: &'a ChannelsConfig) -> BalanceQueryFuture<'a> {
    Box::pin(query_balance(account, config))
}

async fn query_balance(account: &ChannelAccount, config: &ChannelsConfig) -> BalanceQueryResult {
    if account.api_key.trim().is_empty() {
        return balance_error("API Key 未配置");
    }
    let client =
        match crate::core::upstream_proxy::apply_to_account(reqwest::Client::builder(), account)
            .and_then(|builder| {
                builder
                    .timeout(std::time::Duration::from_secs(15))
                    .build()
                    .map_err(|error| error.to_string())
            }) {
            Ok(client) => client,
            Err(error) => return balance_error(format!("创建 HTTP 客户端失败: {error}")),
        };
    let response = match client
        .get(config.vibetoken_balance_endpoint())
        .header(
            "Authorization",
            format!("Bearer {}", account.api_key.trim()),
        )
        .header("Accept", "application/json")
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => return balance_error(format!("请求失败: {error}")),
    };
    let status = response.status();
    let body = match response.text().await {
        Ok(body) => body,
        Err(error) => return balance_error(format!("读取响应失败: {error}")),
    };
    if !status.is_success() {
        return balance_error(format!("HTTP {}: {body}", status.as_u16()));
    }
    match serde_json::from_str::<BalanceResponse>(&body) {
        Ok(data) => BalanceQueryResult {
            balance: Some(data.available),
            currency: Some(data.currency),
            is_available: data.available > 0.0,
            error: None,
        },
        Err(error) => balance_error(format!("解析响应失败: {error}")),
    }
}

fn balance_error(error: impl Into<String>) -> BalanceQueryResult {
    BalanceQueryResult {
        balance: None,
        currency: None,
        is_available: false,
        error: Some(error.into()),
    }
}

pub(super) const ADAPTER: ChannelCapabilityAdapter = ChannelCapabilityAdapter {
    id: "vibetoken",
    preset_factory: ChannelPreset::vibetoken,
    model_sync: sync,
    balance_query: Some(balance),
    strips_openai_v1_path: false,
    uses_upstream_proxy_for_models: false,
    console_scrape: ConsoleScrapeAdapter::None,
    login_page: LoginPageAdapter::None,
    scrape_response: None,
};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::config::ProtocolType;
    use axum::{
        http::{HeaderMap, StatusCode},
        routing::get,
        Router,
    };

    #[test]
    fn vibetoken_routes_only_selected_synced_whitelist_models() {
        let config = ChannelsConfig::from_config_json(
            &serde_json::from_str(crate::core::channels_config::DEFAULT_CONFIG_JSON).unwrap(),
        )
        .unwrap();
        let raw_ids = vec![
            "deepseek/deepseek-v4-pro",
            "deepseek/deepseek-v4-pro-0813",
            "moonshotai/kimi-k3",
            "zai/glm-5.3",
            "qwen/qwen3.5-27b",
        ]
        .into_iter()
        .map(String::from)
        .collect::<Vec<_>>();
        let mut selected = raw_ids.clone();
        selected.push("deepseek/deepseek-v4-flash".into()); // Not in synced pool.
        let mut account = ChannelAccount {
            id: "vibe-account".into(),
            channel_id: "vibetoken".into(),
            api_key: "test".into(),
            enabled: true,
            synced_models: Some(raw_ids),
            exposed_models: Some(selected),
            ..Default::default()
        };
        let routes = config.merge_default_routes(&[], &[account.clone()], &config.presets);
        assert_eq!(routes.len(), 8);
        assert!(routes
            .iter()
            .all(|r| r.client_protocol != ProtocolType::Anthropic));
        assert_eq!(
            routes
                .iter()
                .filter(|r| r.virtual_model_id == "deepseek-v4-pro")
                .count(),
            4
        );
        assert!(routes
            .iter()
            .any(|r| r.virtual_model_id == "kimi-k3" && r.upstream_model == "moonshotai/kimi-k3"));
        assert!(routes
            .iter()
            .all(|r| r.upstream_model != "qwen/qwen3.5-27b"
                && r.virtual_model_id != "deepseek-v4-flash"));
        account.exposed_models = Some(vec![]);
        assert!(config
            .merge_default_routes(&[], &[account], &config.presets)
            .is_empty());
    }

    #[tokio::test]
    async fn vibetoken_sync_and_balance_use_bearer_and_configured_endpoints() {
        let app = Router::new()
            .route(
                "/v1/models",
                get(|headers: HeaderMap| async move {
                    assert_eq!(headers["authorization"], "Bearer test-key");
                    include_str!("../fixtures/vibetoken-models.json")
                }),
            )
            .route(
                "/api/v1/billing/balance",
                get(|headers: HeaderMap| async move {
                    match headers["authorization"].to_str().unwrap() {
                        "Bearer test-key" => (
                            StatusCode::OK,
                            r#"{"credits":42.5,"held":1.2,"available":41.3,"currency":"CNY"}"#,
                        ),
                        "Bearer zero" => (StatusCode::OK, r#"{"available":0,"currency":"CNY"}"#),
                        "Bearer malformed" => {
                            (StatusCode::OK, r#"{"credits":42.5,"currency":"CNY"}"#)
                        }
                        _ => (StatusCode::UNAUTHORIZED, "invalid key"),
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let mut json: serde_json::Value =
            serde_json::from_str(crate::core::channels_config::DEFAULT_CONFIG_JSON).unwrap();
        let channel = json["channels_config"]["channels"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|c| c["id"] == "vibetoken")
            .unwrap();
        channel["endpoints"]["models"] = format!("http://{addr}/v1/models").into();
        channel["endpoints"]["balance"] = format!("http://{addr}/api/v1/billing/balance").into();
        let config = ChannelsConfig::from_config_json(&json).unwrap();
        let preset = ChannelPreset::vibetoken();
        let mut account = ChannelAccount {
            channel_id: "vibetoken".into(),
            api_key: "test-key".into(),
            ..Default::default()
        };
        let result = sync(&account, &preset, &config).await;
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(result.models_synced, 5); // Includes unsupported models for the editor.
        let model = result
            .models
            .iter()
            .find(|m| m.model == "deepseek/deepseek-v4-flash")
            .unwrap();
        assert_eq!(model.supported_protocols, preset.supported_protocols);
        assert!(model.context_window.is_some());
        assert!(model.max_output_tokens.is_some());
        // Account-specific model endpoint overrides take precedence.
        account.base_url_override = Some(format!("http://{addr}/v1"));
        assert_eq!(sync(&account, &preset, &config).await.models_synced, 5);
        account.base_url_override = None;
        let result = balance(&account, &config).await;
        assert_eq!(result.balance, Some(41.3)); // available, not credits
        assert_eq!(result.currency.as_deref(), Some("CNY"));
        assert!(result.is_available && result.error.is_none());
        account.api_key = "zero".into();
        let result = balance(&account, &config).await;
        assert_eq!(result.balance, Some(0.0));
        assert!(!result.is_available && result.error.is_none());
        account.api_key = "malformed".into();
        assert!(balance(&account, &config).await.error.is_some());
        account.api_key = "invalid".into();
        assert!(balance(&account, &config)
            .await
            .error
            .unwrap()
            .contains("HTTP 401"));
        server.abort();
    }
}
