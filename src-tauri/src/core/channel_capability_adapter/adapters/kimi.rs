use super::super::*;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct BalanceResponse {
    #[serde(default)]
    code: i32,
    data: Option<BalanceData>,
}

#[derive(Debug, Deserialize)]
struct BalanceData {
    #[serde(default)]
    available_balance: f64,
}

fn sync<'a>(
    account: &'a ChannelAccount,
    _preset: &'a ChannelPreset,
    config: &'a ChannelsConfig,
) -> ModelSyncFuture<'a> {
    Box::pin(crate::core::sync::sync_kimi_models(account, config))
}

fn balance<'a>(account: &'a ChannelAccount, config: &'a ChannelsConfig) -> BalanceQueryFuture<'a> {
    Box::pin(query_balance(account, config))
}

async fn query_balance(account: &ChannelAccount, config: &ChannelsConfig) -> BalanceQueryResult {
    if account.api_key.trim().is_empty() {
        return balance_error("API Key 未配置");
    }
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
    {
        Ok(client) => client,
        Err(error) => return balance_error(format!("创建 HTTP 客户端失败: {error}")),
    };
    let response = match client
        .get(config.kimi_balance_endpoint())
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
        Ok(data) if data.code == 0 => BalanceQueryResult {
            balance: data.data.map(|data| data.available_balance),
            currency: Some("CNY".to_string()),
            is_available: true,
            error: None,
        },
        Ok(data) => balance_error(format!("余额查询失败，服务器返回 code={}", data.code)),
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
    id: "kimi",
    preset_factory: ChannelPreset::kimi,
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
        let data: BalanceResponse =
            serde_json::from_str(r#"{"code":0,"data":{"available_balance":49.58894}}"#).unwrap();
        assert_eq!(data.data.unwrap().available_balance, 49.58894);
    }
}
