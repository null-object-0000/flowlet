use super::super::*;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct KeyResponse {
    data: Option<KeyData>,
}

#[derive(Debug, Deserialize)]
struct KeyData {
    #[serde(default)]
    limit_remaining: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct CreditsResponse {
    data: Option<CreditsData>,
}

#[derive(Debug, Deserialize)]
struct CreditsData {
    total_credits: f64,
    total_usage: f64,
}

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

fn balance<'a>(account: &'a ChannelAccount, config: &'a ChannelsConfig) -> BalanceQueryFuture<'a> {
    Box::pin(query_balance(account, config))
}

async fn query_balance(account: &ChannelAccount, config: &ChannelsConfig) -> BalanceQueryResult {
    if account.api_key.trim().is_empty() {
        return balance_error("API Key 未配置");
    }
    let client = match crate::core::upstream_proxy::apply_to(reqwest::Client::builder())
        .and_then(|builder| {
            builder
                .timeout(std::time::Duration::from_secs(15))
                .build()
                .map_err(|error| error.to_string())
        }) {
        Ok(client) => client,
        Err(error) => return balance_error(format!("创建 HTTP 客户端失败: {error}")),
    };
    let management_key = account
        .management_key
        .as_deref()
        .map(str::trim)
        .filter(|key| !key.is_empty());
    let (endpoint, credential, account_credits) = match management_key {
        Some(key) => (config.openrouter_credits_endpoint(), key, true),
        None => (
            config.openrouter_balance_endpoint(),
            account.api_key.trim(),
            false,
        ),
    };
    let response = match client
        .get(endpoint)
        .header("Authorization", format!("Bearer {credential}"))
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
        let credential_name = if account_credits {
            "Management Key"
        } else {
            "API Key"
        };
        return balance_error(format!(
            "{credential_name} 查询失败，HTTP {}: {body}",
            status.as_u16()
        ));
    }
    if account_credits {
        match serde_json::from_str::<CreditsResponse>(&body) {
            Ok(data) => match data.data {
                Some(info) => balance_success(Some(info.total_credits - info.total_usage)),
                None => balance_error("未找到 OpenRouter 账户 Credits 信息"),
            },
            Err(error) => balance_error(format!("解析账户 Credits 响应失败: {error}")),
        }
    } else {
        match serde_json::from_str::<KeyResponse>(&body) {
            Ok(data) => match data.data {
                Some(info) => balance_success(info.limit_remaining),
                None => balance_error("未找到 Key 状态信息"),
            },
            Err(error) => balance_error(format!("解析 Key 状态响应失败: {error}")),
        }
    }
}

fn balance_success(balance: Option<f64>) -> BalanceQueryResult {
    BalanceQueryResult {
        balance,
        currency: Some("USD".to_string()),
        is_available: true,
        error: None,
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
    id: "openrouter",
    preset_factory: ChannelPreset::openrouter,
    model_sync: sync,
    balance_query: Some(balance),
    strips_openai_v1_path: false,
    console_scrape: ConsoleScrapeAdapter::None,
    login_page: LoginPageAdapter::None,
    scrape_response: None,
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_key_and_credits_responses() {
        let key: KeyResponse =
            serde_json::from_str(r#"{"data":{"limit_remaining":87.5}}"#).unwrap();
        assert_eq!(key.data.unwrap().limit_remaining, Some(87.5));
        let credits: CreditsResponse =
            serde_json::from_str(r#"{"data":{"total_credits":100.5,"total_usage":25.75}}"#)
                .unwrap();
        let credits = credits.data.unwrap();
        assert_eq!(credits.total_credits - credits.total_usage, 74.75);
    }
}
