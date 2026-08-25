use super::super::*;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct BalanceResponse {
    #[serde(default)]
    is_available: bool,
    #[serde(default)]
    balance_infos: Vec<BalanceInfo>,
}

#[derive(Debug, Deserialize)]
struct BalanceInfo {
    #[serde(default)]
    currency: String,
    #[serde(default)]
    total_balance: String,
}

fn sync<'a>(
    account: &'a ChannelAccount,
    _preset: &'a ChannelPreset,
    config: &'a ChannelsConfig,
) -> ModelSyncFuture<'a> {
    Box::pin(crate::core::sync::sync_deepseek_models(account, config))
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
    let response = match client
        .get(config.balance_endpoint())
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
        Ok(data) => {
            let primary = data
                .balance_infos
                .iter()
                .find(|balance| balance.currency == "CNY")
                .or_else(|| data.balance_infos.first());
            match primary {
                Some(info) => BalanceQueryResult {
                    balance: info.total_balance.parse::<f64>().ok(),
                    currency: Some(info.currency.clone()),
                    is_available: data.is_available,
                    error: None,
                },
                None => BalanceQueryResult {
                    balance: None,
                    currency: None,
                    is_available: data.is_available,
                    error: Some("未找到余额信息".to_string()),
                },
            }
        }
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
    id: "deepseek",
    preset_factory: ChannelPreset::deepseek,
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
    fn parses_balance_response() {
        let data: BalanceResponse = serde_json::from_str(
            r#"{"is_available":true,"balance_infos":[{"currency":"CNY","total_balance":"100.50"}]}"#,
        )
        .unwrap();
        assert!(data.is_available);
        assert_eq!(data.balance_infos[0].total_balance, "100.50");
    }
}
