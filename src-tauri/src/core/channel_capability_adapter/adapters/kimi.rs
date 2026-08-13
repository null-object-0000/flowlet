use super::super::*;
use serde::Deserialize;
use std::collections::{HashMap, HashSet};

#[derive(Debug, Deserialize)]
struct ModelsResponse {
    #[serde(default)]
    data: Vec<ModelEntry>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct ModelEntry {
    id: String,
    #[serde(default)]
    object: Option<String>,
    #[serde(default)]
    created: Option<u64>,
    #[serde(default)]
    owned_by: Option<String>,
    #[serde(default)]
    context_length: Option<i64>,
    #[serde(default)]
    supports_image_in: Option<bool>,
    #[serde(default)]
    supports_video_in: Option<bool>,
    #[serde(default)]
    supports_reasoning: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ModelReleaseDate {
    unix_seconds: i64,
    rfc3339: String,
}

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
    Box::pin(sync_models(account, config))
}

async fn sync_models(account: &ChannelAccount, config: &ChannelsConfig) -> ModelSyncResult {
    if account.api_key.trim().is_empty() {
        return sync_error("API Key 未配置");
    }
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
    {
        Ok(client) => client,
        Err(error) => return sync_error(format!("创建 HTTP 客户端失败: {error}")),
    };
    let Some(url) = crate::core::sync::account_models_url(account, config) else {
        return sync_error(format!("不支持同步模型的渠道: {}", account.channel_id));
    };
    let response = match client
        .get(&url)
        .header(
            "Authorization",
            format!("Bearer {}", account.api_key.trim()),
        )
        .header("Accept", "application/json")
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => return sync_error(format!("请求失败: {error}")),
    };
    let status = response.status();
    let body = match response.text().await {
        Ok(body) => body,
        Err(error) => return sync_error(format!("读取响应失败: {error}")),
    };
    if !status.is_success() {
        return sync_error(format!("HTTP {}: {body}", status.as_u16()));
    }
    match serde_json::from_str::<ModelsResponse>(&body) {
        Ok(data) => {
            let synced_at = chrono::Utc::now().to_rfc3339();
            let mut entries: Vec<ModelEntry> = data
                .data
                .into_iter()
                .filter(|model| !model.id.trim().is_empty())
                .collect();
            let release_dates = load_release_dates("moonshot-cn");
            let uses_upstream_created = sort_models(&mut entries, &release_dates);
            let models = entries
                .into_iter()
                .map(|entry| {
                    let release_date = if uses_upstream_created {
                        entry
                            .created
                            .and_then(|seconds| chrono::DateTime::from_timestamp(seconds as i64, 0))
                            .map(|date| date.to_rfc3339())
                    } else {
                        release_dates
                            .get(&entry.id)
                            .map(|date| date.rfc3339.clone())
                    };
                    channel_model(
                        entry.id,
                        entry.context_length,
                        release_date.as_deref(),
                        &synced_at,
                    )
                })
                .collect::<Vec<_>>();
            ModelSyncResult {
                models_synced: models.len(),
                models,
                errors: Vec::new(),
            }
        }
        Err(error) => sync_error(format!("解析响应失败: {error}")),
    }
}

fn sort_models(
    entries: &mut [ModelEntry],
    release_dates: &HashMap<String, ModelReleaseDate>,
) -> bool {
    let upstream_created_count = entries
        .iter()
        .filter_map(|entry| entry.created)
        .collect::<HashSet<_>>()
        .len();
    if upstream_created_count > 1 {
        crate::core::sync::sort_by_created_desc(entries, |entry| entry.created);
        return true;
    }
    entries.sort_by(|left, right| {
        let left_release = release_dates.get(&left.id).map(|date| date.unix_seconds);
        let right_release = release_dates.get(&right.id).map(|date| date.unix_seconds);
        right_release
            .cmp(&left_release)
            .then_with(|| left.id.cmp(&right.id))
    });
    false
}

fn load_release_dates(provider_id: &str) -> HashMap<String, ModelReleaseDate> {
    let Some(catalog) = crate::core::storage::storage_tasks::read_models_cn_file()
        .and_then(|json| serde_json::from_str::<serde_json::Value>(&json).ok())
    else {
        return HashMap::new();
    };
    release_dates_from_catalog(&catalog, provider_id)
}

fn release_dates_from_catalog(
    catalog: &serde_json::Value,
    provider_id: &str,
) -> HashMap<String, ModelReleaseDate> {
    let mut result = HashMap::new();
    if let Some(provider) = catalog
        .get("providers")
        .and_then(serde_json::Value::as_array)
        .and_then(|providers| {
            providers.iter().find(|provider| {
                provider.get("id").and_then(serde_json::Value::as_str) == Some(provider_id)
            })
        })
    {
        for model in provider
            .get("models")
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(model_id) = model.get("id").and_then(serde_json::Value::as_str) else {
                continue;
            };
            if let Some(release_date) = model
                .get("createdAt")
                .and_then(serde_json::Value::as_str)
                .and_then(parse_release_date)
            {
                result.insert(model_id.to_string(), release_date);
            }
        }
    }
    for model in catalog
        .pointer("/calibration/modelsDev/models")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter(|model| {
            model.get("provider").and_then(serde_json::Value::as_str) == Some(provider_id)
        })
    {
        let Some(model_id) = model.get("model").and_then(serde_json::Value::as_str) else {
            continue;
        };
        if result.contains_key(model_id) {
            continue;
        }
        let release_date = model
            .get("checks")
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
            .find(|check| {
                check.get("field").and_then(serde_json::Value::as_str) == Some("createdAt")
            })
            .and_then(|check| check.get("reference"))
            .and_then(serde_json::Value::as_str)
            .and_then(parse_release_date);
        if let Some(release_date) = release_date {
            result.insert(model_id.to_string(), release_date);
        }
    }
    result
}

fn parse_release_date(value: &str) -> Option<ModelReleaseDate> {
    let normalized = match value.len() {
        7 => format!("{value}-01"),
        10 => value.to_string(),
        _ => {
            let date = chrono::DateTime::parse_from_rfc3339(value).ok()?;
            return Some(ModelReleaseDate {
                unix_seconds: date.timestamp(),
                rfc3339: date.to_rfc3339(),
            });
        }
    };
    let date = chrono::NaiveDate::parse_from_str(&normalized, "%Y-%m-%d").ok()?;
    let datetime = date.and_hms_opt(0, 0, 0)?.and_utc();
    Some(ModelReleaseDate {
        unix_seconds: datetime.timestamp(),
        rfc3339: datetime.to_rfc3339(),
    })
}

fn channel_model(
    model: String,
    context_length: Option<i64>,
    release_date: Option<&str>,
    synced_at: &str,
) -> crate::core::config::ChannelModel {
    crate::core::config::ChannelModel {
        id: format!("kimi-{model}"),
        channel_id: "kimi".to_string(),
        display_name: Some(model.clone()),
        model,
        supported_protocols: vec![
            crate::core::config::ProtocolType::OpenAi,
            crate::core::config::ProtocolType::Anthropic,
        ],
        context_window: context_length,
        max_output_tokens: None,
        pricing: None,
        supports_stream: true,
        enabled: true,
        source: "synced".to_string(),
        synced_at: Some(synced_at.to_string()),
        created_at: release_date.unwrap_or(synced_at).to_string(),
        updated_at: synced_at.to_string(),
    }
}

fn sync_error(error: impl Into<String>) -> ModelSyncResult {
    ModelSyncResult {
        models_synced: 0,
        models: Vec::new(),
        errors: vec![error.into()],
    }
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

    fn model_entry(id: &str, created: Option<u64>) -> ModelEntry {
        ModelEntry {
            id: id.to_string(),
            object: None,
            created,
            owned_by: None,
            context_length: None,
            supports_image_in: None,
            supports_video_in: None,
            supports_reasoning: None,
        }
    }

    #[test]
    fn uses_catalog_dates_when_upstream_timestamps_are_equal() {
        let mut entries = vec![
            model_entry("moonshot-v1-8k", Some(200)),
            model_entry("kimi-k2.7-code", Some(200)),
            model_entry("kimi-k3", Some(200)),
        ];
        let dates = HashMap::from([
            (
                "kimi-k3".to_string(),
                parse_release_date("2026-07-16").unwrap(),
            ),
            (
                "kimi-k2.7-code".to_string(),
                parse_release_date("2026-06-12").unwrap(),
            ),
        ]);
        assert!(!sort_models(&mut entries, &dates));
        assert_eq!(
            entries
                .iter()
                .map(|entry| entry.id.as_str())
                .collect::<Vec<_>>(),
            vec!["kimi-k3", "kimi-k2.7-code", "moonshot-v1-8k"]
        );
    }

    #[test]
    fn uses_upstream_timestamps_when_they_are_meaningful() {
        let mut entries = vec![
            model_entry("older", Some(100)),
            model_entry("newer", Some(300)),
            model_entry("no-time", None),
        ];
        assert!(sort_models(&mut entries, &HashMap::new()));
        assert_eq!(
            entries
                .iter()
                .map(|entry| entry.id.as_str())
                .collect::<Vec<_>>(),
            vec!["newer", "older", "no-time"]
        );
    }

    #[test]
    fn parses_month_and_rfc3339_release_dates() {
        assert_eq!(
            parse_release_date("2026-07").unwrap().rfc3339,
            "2026-07-01T00:00:00+00:00"
        );
        assert_eq!(
            parse_release_date("2026-07-16T08:30:00+08:00")
                .unwrap()
                .unix_seconds,
            1_784_161_800
        );
    }

    #[test]
    fn preserves_context_and_catalog_priority() {
        let data: ModelsResponse =
            serde_json::from_str(r#"{"data":[{"id":"kimi-k3","context_length":1048576}]}"#)
                .unwrap();
        let entry = data.data.into_iter().next().unwrap();
        let model = channel_model(entry.id, entry.context_length, None, "now");
        assert_eq!(model.context_window, Some(1_048_576));

        let catalog = serde_json::json!({
            "providers": [{"id":"moonshot-cn","models":[{"id":"kimi-k3","createdAt":"2026-07-16"}]}],
            "calibration": {"modelsDev":{"models":[{"provider":"moonshot-cn","model":"kimi-k3","checks":[{"field":"createdAt","reference":"2026-07-01"}]}]}}
        });
        let dates = release_dates_from_catalog(&catalog, "moonshot-cn");
        assert_eq!(dates["kimi-k3"].rfc3339, "2026-07-16T00:00:00+00:00");
    }
}
