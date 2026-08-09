use super::channels_config::ChannelsConfig;
use super::config::{AuthStrategy, ChannelAccount, ChannelModel, ChannelPreset, ProtocolType};
use super::presets::{BalanceQueryResult, ModelSyncResult};
use reqwest::Client;
use serde::Deserialize;
use std::collections::{HashMap, HashSet};

#[derive(Debug, Deserialize)]
struct DeepSeekBalanceResponse {
    #[serde(default)]
    is_available: bool,
    #[serde(default)]
    balance_infos: Vec<DeepSeekBalanceInfo>,
}

#[derive(Debug, Deserialize)]
struct DeepSeekBalanceInfo {
    #[serde(default)]
    currency: String,
    #[serde(default)]
    total_balance: String,
    #[serde(default)]
    #[allow(dead_code)]
    granted_balance: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    topped_up_balance: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DeepSeekModelsResponse {
    #[serde(default)]
    data: Vec<DeepSeekModelEntry>,
}

#[derive(Debug, Deserialize, serde::Serialize, Clone)]
pub struct DeepSeekModelEntry {
    pub id: String,
    #[serde(default)]
    object: String,
    #[serde(default)]
    owned_by: Option<String>,
    /// 上游模型创建时间（Unix 秒）。OpenAI 兼容 /models 的标准字段；
    /// 部分渠道列表不返回时为 None。
    #[serde(default)]
    created: Option<u64>,
}

/// 按上游模型创建时间倒序排列（新模型在前）；缺失 created 的排在最后，
/// 稳定排序保证无时间戳的模型之间保持接口返回的原始顺序。
fn sort_by_created_desc<T>(entries: &mut [T], created: impl Fn(&T) -> Option<u64>) {
    entries.sort_by(|a, b| created(b).cmp(&created(a)));
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ModelReleaseDate {
    unix_seconds: i64,
    rfc3339: String,
}

/// Kimi 当前的 `/models` 会给列表中的所有模型返回相同的 `created`，这个值不能代表
/// 各模型发布时间。仅当上游时间戳无法区分模型时，使用 models-cn 的 createdAt，
/// 或 calibration.modelsDev 中对 createdAt 的参考值进行补全。
fn sort_kimi_models_by_created_desc(
    entries: &mut [KimiModelEntry],
    release_dates: &HashMap<String, ModelReleaseDate>,
) -> bool {
    let upstream_created_count = entries
        .iter()
        .filter_map(|entry| entry.created)
        .collect::<HashSet<_>>()
        .len();
    if upstream_created_count > 1 {
        sort_by_created_desc(entries, |entry| entry.created);
        return true;
    }

    entries.sort_by(|a, b| {
        let a_release = release_dates.get(&a.id).map(|date| date.unix_seconds);
        let b_release = release_dates.get(&b.id).map(|date| date.unix_seconds);
        b_release.cmp(&a_release).then_with(|| a.id.cmp(&b.id))
    });
    false
}

fn load_models_cn_release_dates(provider_id: &str) -> HashMap<String, ModelReleaseDate> {
    let Some(catalog) = crate::core::storage::storage_tasks::read_models_cn_file()
        .and_then(|json| serde_json::from_str::<serde_json::Value>(&json).ok())
    else {
        return HashMap::new();
    };
    models_cn_release_dates_from_catalog(&catalog, provider_id)
}

fn models_cn_release_dates_from_catalog(
    catalog: &serde_json::Value,
    provider_id: &str,
) -> HashMap<String, ModelReleaseDate> {
    let mut result = HashMap::new();
    if let Some(provider) = catalog
        .get("providers")
        .and_then(|providers| providers.as_array())
        .and_then(|providers| {
            providers
                .iter()
                .find(|provider| provider.get("id").and_then(|id| id.as_str()) == Some(provider_id))
        })
    {
        for model in provider
            .get("models")
            .and_then(|models| models.as_array())
            .into_iter()
            .flatten()
        {
            let Some(model_id) = model.get("id").and_then(|id| id.as_str()) else {
                continue;
            };
            if let Some(release_date) = model
                .get("createdAt")
                .and_then(|value| value.as_str())
                .and_then(parse_model_release_date)
            {
                result.insert(model_id.to_string(), release_date);
            }
        }
    }

    for model in catalog
        .pointer("/calibration/modelsDev/models")
        .and_then(|models| models.as_array())
        .into_iter()
        .flatten()
        .filter(|model| model.get("provider").and_then(|value| value.as_str()) == Some(provider_id))
    {
        let Some(model_id) = model.get("model").and_then(|value| value.as_str()) else {
            continue;
        };
        if result.contains_key(model_id) {
            continue;
        }
        let release_date = model
            .get("checks")
            .and_then(|checks| checks.as_array())
            .into_iter()
            .flatten()
            .find(|check| check.get("field").and_then(|value| value.as_str()) == Some("createdAt"))
            .and_then(|check| check.get("reference"))
            .and_then(|value| value.as_str())
            .and_then(parse_model_release_date);
        if let Some(release_date) = release_date {
            result.insert(model_id.to_string(), release_date);
        }
    }

    result
}

fn parse_model_release_date(value: &str) -> Option<ModelReleaseDate> {
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

#[derive(Debug, Deserialize)]
struct KimiModelsResponse {
    #[serde(default)]
    data: Vec<KimiModelEntry>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct KimiModelEntry {
    pub id: String,
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

/// 测试渠道连接：仅验证 API Key 是否有效，不做余额读写。
/// 通过访问模型列表端点实现轻量级鉴权验证。
pub async fn test_channel_connection(
    account: &ChannelAccount,
    _config: &ChannelsConfig,
) -> Result<(), String> {
    if account.api_key.trim().is_empty() {
        return Err("API Key 未配置".to_string());
    }

    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|err| format!("创建 HTTP 客户端失败: {err}"))?;

    // 自定义 OpenAI Base URL 必须参与连接测试；未覆盖时才使用渠道配置端点。
    let effective_base_url = account.effective_openai_base_url();
    let url = effective_base_url
        .map(openai_models_url)
        .or_else(|| _config.models_endpoint_url(&account.channel_id))
        .ok_or_else(|| format!("不支持测试连接的渠道: {}", account.channel_id))?;
    let auth_header = format!("Bearer {}", account.api_key.trim());
    let started_at = std::time::Instant::now();

    tracing::info!(
        channel_id = %account.channel_id,
        method = "GET",
        url = %url,
        custom_base_url = effective_base_url.is_some(),
        "test_connection: 开始请求上游"
    );

    let response = match client
        .get(&url)
        .header("Authorization", auth_header)
        .header("Accept", "application/json")
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => {
            tracing::warn!(
                channel_id = %account.channel_id,
                method = "GET",
                url = %url,
                elapsed_ms = started_at.elapsed().as_millis() as u64,
                error = %error,
                "test_connection: 上游请求失败"
            );
            return Err(format!("GET {url} 请求失败: {error}"));
        }
    };

    let status = response.status();
    if status.is_success() {
        tracing::info!(
            channel_id = %account.channel_id,
            method = "GET",
            url = %url,
            http_status = status.as_u16(),
            elapsed_ms = started_at.elapsed().as_millis() as u64,
            "test_connection: 上游响应成功"
        );
        Ok(())
    } else if status.as_u16() == 401 {
        tracing::warn!(
            channel_id = %account.channel_id,
            method = "GET",
            url = %url,
            http_status = status.as_u16(),
            elapsed_ms = started_at.elapsed().as_millis() as u64,
            "test_connection: 上游鉴权失败"
        );
        Err(format!(
            "GET {url} → HTTP 401，API Key 无效或鉴权方式不匹配"
        ))
    } else {
        tracing::warn!(
            channel_id = %account.channel_id,
            method = "GET",
            url = %url,
            http_status = status.as_u16(),
            elapsed_ms = started_at.elapsed().as_millis() as u64,
            "test_connection: 上游返回异常状态"
        );
        Err(format!("GET {url} → HTTP {}", status.as_u16()))
    }
}

fn openai_models_url(base_url: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    if base.ends_with("/v1") {
        format!("{base}/models")
    } else {
        format!("{base}/v1/models")
    }
}

/// 解析账号的 /models 端点 URL：优先使用账号级 Base URL 覆盖（千问 Token Plan 等
/// 套餐专属端点），未覆盖时使用渠道配置的端点。与 test_channel_connection 保持一致。
fn account_models_url(account: &ChannelAccount, config: &ChannelsConfig) -> Option<String> {
    account
        .effective_openai_base_url()
        .map(openai_models_url)
        .or_else(|| config.models_endpoint_url(&account.channel_id))
}

/// 查询 DeepSeek 余额
pub async fn query_deepseek_balance(
    account: &ChannelAccount,
    config: &ChannelsConfig,
) -> BalanceQueryResult {
    if account.api_key.trim().is_empty() {
        return BalanceQueryResult {
            balance: None,
            currency: None,
            is_available: false,
            error: Some("API Key 未配置".to_string()),
        };
    }

    let client = match Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
    {
        Ok(c) => c,
        Err(err) => {
            return BalanceQueryResult {
                balance: None,
                currency: None,
                is_available: false,
                error: Some(format!("创建 HTTP 客户端失败: {err}")),
            };
        }
    };

    let response = client
        .get(&config.balance_endpoint())
        .header(
            "Authorization",
            format!("Bearer {}", account.api_key.trim()),
        )
        .header("Accept", "application/json")
        .send()
        .await;

    let response = match response {
        Ok(r) => r,
        Err(err) => {
            return BalanceQueryResult {
                balance: None,
                currency: None,
                is_available: false,
                error: Some(format!("请求失败: {err}")),
            };
        }
    };

    let status = response.status();
    let body = match response.text().await {
        Ok(b) => b,
        Err(err) => {
            return BalanceQueryResult {
                balance: None,
                currency: None,
                is_available: false,
                error: Some(format!("读取响应失败: {err}")),
            };
        }
    };

    if !status.is_success() {
        return BalanceQueryResult {
            balance: None,
            currency: None,
            is_available: false,
            error: Some(format!("HTTP {}: {}", status.as_u16(), body)),
        };
    }

    match serde_json::from_str::<DeepSeekBalanceResponse>(&body) {
        Ok(data) => {
            // 优先使用 CNY 余额，否则取第一个
            let primary = data
                .balance_infos
                .iter()
                .find(|b| b.currency == "CNY")
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
        Err(err) => BalanceQueryResult {
            balance: None,
            currency: None,
            is_available: false,
            error: Some(format!("解析响应失败: {err}")),
        },
    }
}

#[derive(Debug, Deserialize)]
struct KimiBalanceResponse {
    #[serde(default)]
    code: i32,
    data: Option<KimiBalanceData>,
}

#[derive(Debug, Deserialize)]
struct KimiBalanceData {
    #[serde(default)]
    available_balance: f64,
}

/// 查询 Kimi 余额
pub async fn query_kimi_balance(
    account: &ChannelAccount,
    config: &ChannelsConfig,
) -> BalanceQueryResult {
    if account.api_key.trim().is_empty() {
        return BalanceQueryResult {
            balance: None,
            currency: None,
            is_available: false,
            error: Some("API Key 未配置".to_string()),
        };
    }

    let client = match Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
    {
        Ok(c) => c,
        Err(err) => {
            return BalanceQueryResult {
                balance: None,
                currency: None,
                is_available: false,
                error: Some(format!("创建 HTTP 客户端失败: {err}")),
            };
        }
    };

    let response = client
        .get(&config.kimi_balance_endpoint())
        .header(
            "Authorization",
            format!("Bearer {}", account.api_key.trim()),
        )
        .header("Accept", "application/json")
        .send()
        .await;

    let response = match response {
        Ok(r) => r,
        Err(err) => {
            return BalanceQueryResult {
                balance: None,
                currency: None,
                is_available: false,
                error: Some(format!("请求失败: {err}")),
            };
        }
    };

    let status = response.status();
    let body = match response.text().await {
        Ok(b) => b,
        Err(err) => {
            return BalanceQueryResult {
                balance: None,
                currency: None,
                is_available: false,
                error: Some(format!("读取响应失败: {err}")),
            };
        }
    };

    if !status.is_success() {
        return BalanceQueryResult {
            balance: None,
            currency: None,
            is_available: false,
            error: Some(format!("HTTP {}: {}", status.as_u16(), body)),
        };
    }

    match serde_json::from_str::<KimiBalanceResponse>(&body) {
        Ok(data) => {
            if data.code != 0 {
                return BalanceQueryResult {
                    balance: None,
                    currency: None,
                    is_available: false,
                    error: Some(format!("余额查询失败，服务器返回 code={}", data.code)),
                };
            }
            let balance = data.data.map(|d| d.available_balance);
            BalanceQueryResult {
                balance,
                currency: Some("CNY".to_string()),
                is_available: data.code == 0,
                error: None,
            }
        }
        Err(err) => BalanceQueryResult {
            balance: None,
            currency: None,
            is_available: false,
            error: Some(format!("解析响应失败: {err}")),
        },
    }
}

/// 同步 DeepSeek 模型列表
pub async fn sync_deepseek_models(
    account: &ChannelAccount,
    config: &ChannelsConfig,
) -> ModelSyncResult {
    if account.api_key.trim().is_empty() {
        return ModelSyncResult {
            models_synced: 0,
            models: Vec::new(),
            errors: vec!["API Key 未配置".to_string()],
        };
    }

    let client = match Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
    {
        Ok(c) => c,
        Err(err) => {
            return ModelSyncResult {
                models_synced: 0,
                models: Vec::new(),
                errors: vec![format!("创建 HTTP 客户端失败: {err}")],
            };
        }
    };

    let url = match account_models_url(account, &config) {
        Some(url) => url,
        None => {
            return ModelSyncResult {
                models_synced: 0,
                models: Vec::new(),
                errors: vec![format!("不支持同步模型的渠道: {}", account.channel_id)],
            };
        }
    };

    let response = client
        .get(&url)
        .header(
            "Authorization",
            format!("Bearer {}", account.api_key.trim()),
        )
        .header("Accept", "application/json")
        .send()
        .await;

    let response = match response {
        Ok(r) => r,
        Err(err) => {
            return ModelSyncResult {
                models_synced: 0,
                models: Vec::new(),
                errors: vec![format!("请求失败: {err}")],
            };
        }
    };

    let status = response.status();
    let body = match response.text().await {
        Ok(b) => b,
        Err(err) => {
            return ModelSyncResult {
                models_synced: 0,
                models: Vec::new(),
                errors: vec![format!("读取响应失败: {err}")],
            };
        }
    };

    if !status.is_success() {
        return ModelSyncResult {
            models_synced: 0,
            models: Vec::new(),
            errors: vec![format!("HTTP {}: {}", status.as_u16(), body)],
        };
    }

    match serde_json::from_str::<DeepSeekModelsResponse>(&body) {
        Ok(data) => {
            let mut models: Vec<DeepSeekModelEntry> = data
                .data
                .into_iter()
                .filter(|m| !m.id.trim().is_empty())
                .collect();
            sort_by_created_desc(&mut models, |m| m.created);
            let synced_at = chrono::Utc::now().to_rfc3339();
            let channel_models = models
                .into_iter()
                .map(|model| deepseek_channel_model(model.id, &synced_at))
                .collect::<Vec<_>>();
            ModelSyncResult {
                models_synced: channel_models.len(),
                models: channel_models,
                errors: Vec::new(),
            }
        }
        Err(err) => ModelSyncResult {
            models_synced: 0,
            models: Vec::new(),
            errors: vec![format!("解析响应失败: {err}")],
        },
    }
}

/// 同步通用 OpenAI-compatible 渠道的 `/models`。
///
/// 自定义渠道没有渠道级默认地址，必须由账号提供 OpenAI Base URL 覆盖。
/// `models_url` 非 None 时优先使用该显式模型列表端点（如智谱 `/api/paas/v4/models`
/// 不以 `/v1` 结尾，`openai_models_url` 拼接会得到非标准变体，需显式传入）。
pub async fn sync_openai_compatible_models(
    account: &ChannelAccount,
    preset: &ChannelPreset,
    models_url: Option<String>,
) -> ModelSyncResult {
    if account.api_key.trim().is_empty() {
        return ModelSyncResult {
            models_synced: 0,
            models: Vec::new(),
            errors: vec!["API Key 未配置".to_string()],
        };
    }

    let Some(base_url) = account.effective_openai_base_url().or_else(|| {
        (!preset.openai_base_url.trim().is_empty()).then_some(preset.openai_base_url.as_str())
    }) else {
        return ModelSyncResult {
            models_synced: 0,
            models: Vec::new(),
            errors: vec!["请先填写 OpenAI Base URL".to_string()],
        };
    };
    let url = models_url.unwrap_or_else(|| openai_models_url(base_url));
    let client = match Client::builder()
        .timeout(std::time::Duration::from_secs(
            preset.timeout_seconds.unwrap_or(15),
        ))
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            return ModelSyncResult {
                models_synced: 0,
                models: Vec::new(),
                errors: vec![format!("创建 HTTP 客户端失败: {error}")],
            };
        }
    };

    let request = match preset.openai_auth {
        AuthStrategy::Bearer => client.get(&url).header(
            "Authorization",
            format!("Bearer {}", account.api_key.trim()),
        ),
        AuthStrategy::XApiKey => client.get(&url).header("x-api-key", account.api_key.trim()),
    }
    .header("Accept", "application/json");

    let response = match request.send().await {
        Ok(response) => response,
        Err(error) => {
            return ModelSyncResult {
                models_synced: 0,
                models: Vec::new(),
                errors: vec![format!("GET {url} 请求失败: {error}")],
            };
        }
    };
    let status = response.status();
    let body = match response.text().await {
        Ok(body) => body,
        Err(error) => {
            return ModelSyncResult {
                models_synced: 0,
                models: Vec::new(),
                errors: vec![format!("读取响应失败: {error}")],
            };
        }
    };
    if !status.is_success() {
        return ModelSyncResult {
            models_synced: 0,
            models: Vec::new(),
            errors: vec![format!("GET {url} → HTTP {}", status.as_u16())],
        };
    }

    match serde_json::from_str::<DeepSeekModelsResponse>(&body) {
        Ok(data) => {
            let mut entries: Vec<DeepSeekModelEntry> = data
                .data
                .into_iter()
                .filter(|entry| !entry.id.trim().is_empty())
                .collect();
            sort_by_created_desc(&mut entries, |entry| entry.created);
            let synced_at = chrono::Utc::now().to_rfc3339();
            let protocols = preset.supported_protocols.clone();
            let models = entries
                .into_iter()
                .map(|entry| ChannelModel {
                    id: format!("{}-{}", account.channel_id, entry.id),
                    channel_id: account.channel_id.clone(),
                    model: entry.id.clone(),
                    display_name: Some(entry.id),
                    supported_protocols: protocols.clone(),
                    context_window: None,
                    max_output_tokens: None,
                    supports_stream: true,
                    enabled: true,
                    source: "synced".to_string(),
                    synced_at: Some(synced_at.clone()),
                    created_at: synced_at.clone(),
                    updated_at: synced_at.clone(),
                })
                .collect::<Vec<_>>();
            ModelSyncResult {
                models_synced: models.len(),
                models,
                errors: Vec::new(),
            }
        }
        Err(error) => ModelSyncResult {
            models_synced: 0,
            models: Vec::new(),
            errors: vec![format!("解析 OpenAI-compatible 模型列表失败: {error}")],
        },
    }
}

/// 同步 Kimi 模型列表（兼容 OpenAI /v1/models 格式，含 context_length 等字段）
pub async fn sync_kimi_models(
    account: &ChannelAccount,
    config: &ChannelsConfig,
) -> ModelSyncResult {
    if account.api_key.trim().is_empty() {
        return ModelSyncResult {
            models_synced: 0,
            models: Vec::new(),
            errors: vec!["API Key 未配置".to_string()],
        };
    }

    let client = match Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
    {
        Ok(c) => c,
        Err(err) => {
            return ModelSyncResult {
                models_synced: 0,
                models: Vec::new(),
                errors: vec![format!("创建 HTTP 客户端失败: {err}")],
            };
        }
    };

    let url = match account_models_url(account, &config) {
        Some(url) => url,
        None => {
            return ModelSyncResult {
                models_synced: 0,
                models: Vec::new(),
                errors: vec![format!("不支持同步模型的渠道: {}", account.channel_id)],
            };
        }
    };

    let response = client
        .get(&url)
        .header(
            "Authorization",
            format!("Bearer {}", account.api_key.trim()),
        )
        .header("Accept", "application/json")
        .send()
        .await;

    let response = match response {
        Ok(r) => r,
        Err(err) => {
            return ModelSyncResult {
                models_synced: 0,
                models: Vec::new(),
                errors: vec![format!("请求失败: {err}")],
            };
        }
    };

    let status = response.status();
    let body = match response.text().await {
        Ok(b) => b,
        Err(err) => {
            return ModelSyncResult {
                models_synced: 0,
                models: Vec::new(),
                errors: vec![format!("读取响应失败: {err}")],
            };
        }
    };

    if !status.is_success() {
        return ModelSyncResult {
            models_synced: 0,
            models: Vec::new(),
            errors: vec![format!("HTTP {}: {}", status.as_u16(), body)],
        };
    }

    match serde_json::from_str::<KimiModelsResponse>(&body) {
        Ok(data) => {
            let synced_at = chrono::Utc::now().to_rfc3339();
            let mut entries: Vec<KimiModelEntry> = data
                .data
                .into_iter()
                .filter(|m| !m.id.trim().is_empty())
                .collect();
            let release_dates = load_models_cn_release_dates("moonshot-cn");
            let uses_upstream_created =
                sort_kimi_models_by_created_desc(&mut entries, &release_dates);
            let models: Vec<_> = entries
                .into_iter()
                .map(|m| {
                    let release_date = if uses_upstream_created {
                        m.created
                            .and_then(|seconds| chrono::DateTime::from_timestamp(seconds as i64, 0))
                            .map(|date| date.to_rfc3339())
                    } else {
                        release_dates.get(&m.id).map(|date| date.rfc3339.clone())
                    };
                    kimi_channel_model(m.id, m.context_length, release_date.as_deref(), &synced_at)
                })
                .collect();
            ModelSyncResult {
                models_synced: models.len(),
                models,
                errors: Vec::new(),
            }
        }
        Err(err) => ModelSyncResult {
            models_synced: 0,
            models: Vec::new(),
            errors: vec![format!("解析响应失败: {err}")],
        },
    }
}

/// 同步 Qwen 模型列表（DashScope 兼容模式，标准 OpenAI /models 格式）。
/// 官方列表不返回上下文窗口等详情，相关字段保持 None，不硬编码。
pub async fn sync_qwen_models(
    account: &ChannelAccount,
    config: &ChannelsConfig,
) -> ModelSyncResult {
    if account.api_key.trim().is_empty() {
        return ModelSyncResult {
            models_synced: 0,
            models: Vec::new(),
            errors: vec!["API Key 未配置".to_string()],
        };
    }

    let client = match Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
    {
        Ok(c) => c,
        Err(err) => {
            return ModelSyncResult {
                models_synced: 0,
                models: Vec::new(),
                errors: vec![format!("创建 HTTP 客户端失败: {err}")],
            };
        }
    };

    let url = match account_models_url(account, &config) {
        Some(url) => url,
        None => {
            return ModelSyncResult {
                models_synced: 0,
                models: Vec::new(),
                errors: vec![format!("不支持同步模型的渠道: {}", account.channel_id)],
            };
        }
    };

    let response = client
        .get(&url)
        .header(
            "Authorization",
            format!("Bearer {}", account.api_key.trim()),
        )
        .header("Accept", "application/json")
        .send()
        .await;

    let response = match response {
        Ok(r) => r,
        Err(err) => {
            return ModelSyncResult {
                models_synced: 0,
                models: Vec::new(),
                errors: vec![format!("请求失败: {err}")],
            };
        }
    };

    let status = response.status();
    let body = match response.text().await {
        Ok(b) => b,
        Err(err) => {
            return ModelSyncResult {
                models_synced: 0,
                models: Vec::new(),
                errors: vec![format!("读取响应失败: {err}")],
            };
        }
    };

    if !status.is_success() {
        return ModelSyncResult {
            models_synced: 0,
            models: Vec::new(),
            errors: vec![format!("HTTP {}: {}", status.as_u16(), body)],
        };
    }

    match serde_json::from_str::<DeepSeekModelsResponse>(&body) {
        Ok(data) => {
            let synced_at = chrono::Utc::now().to_rfc3339();
            let mut entries: Vec<DeepSeekModelEntry> = data
                .data
                .into_iter()
                .filter(|m| !m.id.trim().is_empty())
                .collect();
            sort_by_created_desc(&mut entries, |m| m.created);
            let models: Vec<_> = entries
                .into_iter()
                .map(|m| qwen_channel_model(m.id, &synced_at))
                .collect();
            ModelSyncResult {
                models_synced: models.len(),
                models,
                errors: Vec::new(),
            }
        }
        Err(err) => ModelSyncResult {
            models_synced: 0,
            models: Vec::new(),
            errors: vec![format!("解析响应失败: {err}")],
        },
    }
}

/// LongCat 单模型详情（GET /openai/v1/models/{id}）
#[derive(Debug, Deserialize)]
pub struct LongCatModelDetail {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    // LongCat 返回 Unix 时间戳（秒）
    #[serde(default)]
    pub created: Option<i64>,
    #[serde(default)]
    pub context_length: Option<i64>,
    #[serde(default)]
    pub architecture: Option<LongCatArchitecture>,
    #[serde(default)]
    pub supported_parameters: Option<Vec<String>>,
    #[serde(default)]
    pub pricing: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
pub struct LongCatArchitecture {
    #[serde(default)]
    pub input_modalities: Option<Vec<String>>,
    #[serde(default)]
    pub output_modalities: Option<Vec<String>>,
    #[serde(default)]
    pub modality: Option<String>,
}

/// 同步 LongCat 模型列表，并对每个模型拉取详情获取 context_length / pricing
pub async fn sync_longcat_models(
    account: &ChannelAccount,
    config: &ChannelsConfig,
) -> ModelSyncResult {
    if account.api_key.trim().is_empty() {
        return ModelSyncResult {
            models_synced: 0,
            models: Vec::new(),
            errors: vec!["API Key 未配置".to_string()],
        };
    }

    let client = match Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
    {
        Ok(c) => c,
        Err(err) => {
            return ModelSyncResult {
                models_synced: 0,
                models: Vec::new(),
                errors: vec![format!("创建 HTTP 客户端失败: {err}")],
            };
        }
    };

    // 1) 拉取列表
    let list_response = match fetch_longcat_list(&client, account, config).await {
        Ok(r) => r,
        Err(result) => return result,
    };

    // 2) 解析列表（按上游创建时间倒序，新模型在前）
    let mut entries: Vec<DeepSeekModelEntry> =
        match serde_json::from_str::<DeepSeekModelsResponse>(&list_response.body) {
            Ok(resp) => resp
                .data
                .into_iter()
                .filter(|m| !m.id.trim().is_empty())
                .collect(),
            Err(err) => {
                return ModelSyncResult {
                    models_synced: 0,
                    models: Vec::new(),
                    errors: vec![format!("解析列表响应失败: {err}")],
                };
            }
        };
    sort_by_created_desc(&mut entries, |m| m.created);

    // 3) 逐个拉取详情。账号级 Base URL 覆盖（如千问 Token Plan 专属端点）时，
    //    配置中的详情模板（{id}）与覆盖端点不匹配，退化为仅列表信息。
    let synced_at = chrono::Utc::now().to_rfc3339();
    let mut channel_models: Vec<ChannelModel> = Vec::new();
    let errors: Vec<String> = Vec::new();
    let uses_custom_endpoint = account.effective_openai_base_url().is_some();

    for entry in &entries {
        let detail = if uses_custom_endpoint {
            None
        } else {
            fetch_longcat_detail(&client, account, &entry.id, config).await
        };
        if let Some(detail) = detail {
            channel_models.push(longcat_channel_model(entry.id.clone(), detail, &synced_at));
        } else {
            // 详情拉取失败 / 使用自定义端点时退化为仅列表信息
            channel_models.push(longcat_channel_model_from_id(entry.id.clone(), &synced_at));
        }
    }

    if channel_models.is_empty() && !errors.is_empty() {
        return ModelSyncResult {
            models_synced: 0,
            models: Vec::new(),
            errors,
        };
    }

    ModelSyncResult {
        models_synced: channel_models.len(),
        models: channel_models,
        errors,
    }
}

struct LongCatListResponse {
    #[allow(dead_code)]
    status: reqwest::StatusCode,
    body: String,
}

async fn fetch_longcat_list(
    client: &Client,
    account: &ChannelAccount,
    config: &ChannelsConfig,
) -> Result<LongCatListResponse, ModelSyncResult> {
    let url = match account_models_url(account, config) {
        Some(url) => url,
        None => {
            return Err(ModelSyncResult {
                models_synced: 0,
                models: Vec::new(),
                errors: vec![format!("不支持同步模型的渠道: {}", account.channel_id)],
            });
        }
    };

    let response = client
        .get(&url)
        .header(
            "Authorization",
            format!("Bearer {}", account.api_key.trim()),
        )
        .header("Accept", "application/json")
        .send()
        .await;

    let response = match response {
        Ok(r) => r,
        Err(err) => {
            return Err(ModelSyncResult {
                models_synced: 0,
                models: Vec::new(),
                errors: vec![format!("请求失败: {err}")],
            });
        }
    };

    let status = response.status();
    let body = match response.text().await {
        Ok(b) => b,
        Err(err) => {
            return Err(ModelSyncResult {
                models_synced: 0,
                models: Vec::new(),
                errors: vec![format!("读取响应失败: {err}")],
            });
        }
    };

    if !status.is_success() {
        return Err(ModelSyncResult {
            models_synced: 0,
            models: Vec::new(),
            errors: vec![format!("HTTP {}: {}", status.as_u16(), body)],
        });
    }

    Ok(LongCatListResponse { status, body })
}

async fn fetch_longcat_detail(
    client: &Client,
    account: &ChannelAccount,
    model_id: &str,
    config: &ChannelsConfig,
) -> Option<LongCatModelDetail> {
    let template = config.longcat_model_detail_endpoint();
    let url = template.replace("{id}", model_id);
    let response = client
        .get(&url)
        .header(
            "Authorization",
            format!("Bearer {}", account.api_key.trim()),
        )
        .header("Accept", "application/json")
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body = response.text().await.ok()?;
    serde_json::from_str::<LongCatModelDetail>(&body).ok()
}

fn longcat_channel_model(
    model_id: String,
    detail: LongCatModelDetail,
    synced_at: &str,
) -> ChannelModel {
    ChannelModel {
        id: format!("longcat-{model_id}"),
        channel_id: "longcat".to_string(),
        display_name: detail.name.clone().or(Some(model_id.clone())),
        model: model_id,
        supported_protocols: vec![ProtocolType::OpenAi, ProtocolType::Anthropic],
        context_window: detail.context_length,
        max_output_tokens: None,
        supports_stream: detail
            .supported_parameters
            .as_ref()
            .map(|p| p.iter().any(|s| *s == "stream"))
            .unwrap_or(true),
        enabled: true,
        source: "synced".to_string(),
        synced_at: Some(synced_at.to_string()),
        created_at: synced_at.to_string(),
        updated_at: synced_at.to_string(),
    }
}

fn longcat_channel_model_from_id(model: String, synced_at: &str) -> ChannelModel {
    ChannelModel {
        id: format!("longcat-{model}"),
        channel_id: "longcat".to_string(),
        display_name: Some(model.clone()),
        model,
        supported_protocols: vec![ProtocolType::OpenAi, ProtocolType::Anthropic],
        context_window: None,
        max_output_tokens: None,
        supports_stream: true,
        enabled: true,
        source: "synced".to_string(),
        synced_at: Some(synced_at.to_string()),
        created_at: synced_at.to_string(),
        updated_at: synced_at.to_string(),
    }
}

fn deepseek_channel_model(model: String, synced_at: &str) -> ChannelModel {
    ChannelModel {
        id: format!("deepseek-{model}"),
        channel_id: "deepseek".to_string(),
        display_name: Some(model.clone()),
        model,
        supported_protocols: vec![ProtocolType::OpenAi, ProtocolType::Anthropic],
        context_window: Some(1_000_000),
        max_output_tokens: Some(384_000),
        supports_stream: true,
        enabled: true,
        source: "synced".to_string(),
        synced_at: Some(synced_at.to_string()),
        created_at: synced_at.to_string(),
        updated_at: synced_at.to_string(),
    }
}

fn kimi_channel_model(
    model: String,
    context_length: Option<i64>,
    release_date: Option<&str>,
    synced_at: &str,
) -> ChannelModel {
    ChannelModel {
        id: format!("kimi-{model}"),
        channel_id: "kimi".to_string(),
        display_name: Some(model.clone()),
        model,
        supported_protocols: vec![ProtocolType::OpenAi, ProtocolType::Anthropic],
        context_window: context_length,
        max_output_tokens: None,
        supports_stream: true,
        enabled: true,
        source: "synced".to_string(),
        synced_at: Some(synced_at.to_string()),
        created_at: release_date.unwrap_or(synced_at).to_string(),
        updated_at: synced_at.to_string(),
    }
}

fn qwen_channel_model(model: String, synced_at: &str) -> ChannelModel {
    ChannelModel {
        id: format!("qwen-{model}"),
        channel_id: "qwen".to_string(),
        display_name: Some(model.clone()),
        model,
        supported_protocols: vec![ProtocolType::OpenAi, ProtocolType::Anthropic],
        context_window: None,
        max_output_tokens: None,
        supports_stream: true,
        enabled: true,
        source: "synced".to_string(),
        synced_at: Some(synced_at.to_string()),
        created_at: synced_at.to_string(),
        updated_at: synced_at.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_deepseek_balance_response() {
        let json = r#"{
            "is_available": true,
            "balance_infos": [
                {"currency": "CNY", "total_balance": "100.50", "granted_balance": "0", "topped_up_balance": "100.50"},
                {"currency": "USD", "total_balance": "0.00"}
            ]
        }"#;
        let data: DeepSeekBalanceResponse = serde_json::from_str(json).unwrap();
        assert!(data.is_available);
        assert_eq!(data.balance_infos.len(), 2);
        assert_eq!(data.balance_infos[0].currency, "CNY");
        assert_eq!(data.balance_infos[0].total_balance, "100.50");
    }

    #[test]
    fn parse_deepseek_models_response() {
        let json = r#"{
            "data": [
                {"id": "deepseek-v4-flash", "object": "model", "owned_by": "deepseek", "created": 1700000000},
                {"id": "deepseek-v4-pro", "object": "model", "owned_by": "deepseek"}
            ]
        }"#;
        let data: DeepSeekModelsResponse = serde_json::from_str(json).unwrap();
        assert_eq!(data.data.len(), 2);
        assert_eq!(data.data[0].id, "deepseek-v4-flash");
        assert_eq!(data.data[0].created, Some(1700000000));
        // 上游不返回 created 时为 None，不报错。
        assert_eq!(data.data[1].created, None);
    }

    #[test]
    fn sort_models_by_created_desc_with_missing_last_and_stable() {
        let mut entries = vec![
            DeepSeekModelEntry {
                id: "old".to_string(),
                object: String::new(),
                owned_by: None,
                created: Some(100),
            },
            DeepSeekModelEntry {
                id: "no-time-1".to_string(),
                object: String::new(),
                owned_by: None,
                created: None,
            },
            DeepSeekModelEntry {
                id: "newest".to_string(),
                object: String::new(),
                owned_by: None,
                created: Some(300),
            },
            DeepSeekModelEntry {
                id: "no-time-2".to_string(),
                object: String::new(),
                owned_by: None,
                created: None,
            },
            DeepSeekModelEntry {
                id: "mid".to_string(),
                object: String::new(),
                owned_by: None,
                created: Some(200),
            },
        ];
        sort_by_created_desc(&mut entries, |m| m.created);
        let order: Vec<&str> = entries.iter().map(|m| m.id.as_str()).collect();
        // 有时间戳的按新到旧排列；缺失的排在最后且保持原始相对顺序。
        assert_eq!(
            order,
            vec!["newest", "mid", "old", "no-time-1", "no-time-2"]
        );
    }

    #[test]
    fn sort_kimi_models_uses_models_cn_dates_when_upstream_timestamps_are_equal() {
        let entry = |id: &str, created| KimiModelEntry {
            id: id.to_string(),
            object: None,
            created,
            owned_by: None,
            context_length: None,
            supports_image_in: None,
            supports_video_in: None,
            supports_reasoning: None,
        };
        let mut entries = vec![
            entry("moonshot-v1-8k", Some(200)),
            entry("kimi-k2.7-code", Some(200)),
            entry("kimi-k3", Some(200)),
            entry("kimi-k2.6", Some(200)),
        ];
        let release_dates = HashMap::from([
            (
                "kimi-k3".to_string(),
                parse_model_release_date("2026-07-16").unwrap(),
            ),
            (
                "kimi-k2.7-code".to_string(),
                parse_model_release_date("2026-06-12").unwrap(),
            ),
            (
                "kimi-k2.6".to_string(),
                parse_model_release_date("2026-04-21").unwrap(),
            ),
        ]);

        let used_upstream = sort_kimi_models_by_created_desc(&mut entries, &release_dates);

        let order: Vec<&str> = entries.iter().map(|entry| entry.id.as_str()).collect();
        assert_eq!(
            order,
            vec!["kimi-k3", "kimi-k2.7-code", "kimi-k2.6", "moonshot-v1-8k",]
        );
        assert!(!used_upstream);
    }

    #[test]
    fn sort_kimi_models_still_prioritizes_newer_timestamp() {
        let entry = |id: &str, created| KimiModelEntry {
            id: id.to_string(),
            object: None,
            created,
            owned_by: None,
            context_length: None,
            supports_image_in: None,
            supports_video_in: None,
            supports_reasoning: None,
        };
        let mut entries = vec![
            entry("kimi-k3", Some(100)),
            entry("moonshot-v1-8k", Some(200)),
        ];
        let release_dates = HashMap::from([(
            "kimi-k3".to_string(),
            parse_model_release_date("2026-07-16").unwrap(),
        )]);

        let used_upstream = sort_kimi_models_by_created_desc(&mut entries, &release_dates);

        assert_eq!(entries[0].id, "moonshot-v1-8k");
        assert_eq!(entries[1].id, "kimi-k3");
        assert!(used_upstream);
    }

    #[test]
    fn parses_models_cn_full_and_month_release_dates() {
        let full = parse_model_release_date("2026-07-16").unwrap();
        let month = parse_model_release_date("2026-01").unwrap();

        assert_eq!(full.rfc3339, "2026-07-16T00:00:00+00:00");
        assert_eq!(month.rfc3339, "2026-01-01T00:00:00+00:00");
        assert!(full.unix_seconds > month.unix_seconds);
    }

    #[test]
    fn reads_models_cn_release_dates_with_official_value_first() {
        let catalog = serde_json::json!({
            "providers": [{
                "id": "moonshot-cn",
                "models": [
                    {"id": "kimi-k3", "createdAt": "2026-07-16"},
                    {"id": "kimi-k2.7-code"}
                ]
            }],
            "calibration": {
                "modelsDev": {
                    "models": [
                        {
                            "provider": "moonshot-cn",
                            "model": "kimi-k3",
                            "checks": [{"field": "createdAt", "reference": "2026-07-01"}]
                        },
                        {
                            "provider": "moonshot-cn",
                            "model": "kimi-k2.7-code",
                            "checks": [{"field": "createdAt", "reference": "2026-06-12"}]
                        }
                    ]
                }
            }
        });

        let dates = models_cn_release_dates_from_catalog(&catalog, "moonshot-cn");

        assert_eq!(
            dates.get("kimi-k3").unwrap().rfc3339,
            "2026-07-16T00:00:00+00:00"
        );
        assert_eq!(
            dates.get("kimi-k2.7-code").unwrap().rfc3339,
            "2026-06-12T00:00:00+00:00"
        );
    }

    #[test]
    fn parse_kimi_balance_response() {
        let json = r#"{
            "code": 0,
            "data": {
                "available_balance": 49.58894,
                "voucher_balance": 46.58893,
                "cash_balance": 3.00001
            },
            "scode": "0x0",
            "status": true
        }"#;
        let data: KimiBalanceResponse = serde_json::from_str(json).unwrap();
        assert_eq!(data.code, 0);
        assert_eq!(data.data.unwrap().available_balance, 49.58894);
    }

    #[test]
    fn parse_kimi_models_response_and_preserve_context() {
        let json = r#"{
            "object": "list",
            "data": [{
                "id": "kimi-k3",
                "object": "model",
                "owned_by": "moonshot",
                "context_length": 1048576,
                "supports_reasoning": true
            }]
        }"#;
        let data: KimiModelsResponse = serde_json::from_str(json).unwrap();
        let entry = data.data.into_iter().next().unwrap();
        assert_eq!(entry.id, "kimi-k3");
        assert_eq!(entry.context_length, Some(1_048_576));
        let model = kimi_channel_model(entry.id, entry.context_length, None, "now");
        assert_eq!(
            model.supported_protocols,
            vec![ProtocolType::OpenAi, ProtocolType::Anthropic]
        );
    }
    #[test]
    fn parse_empty_balance_response() {
        let json = r#"{"is_available": false, "balance_infos": []}"#;
        let data: DeepSeekBalanceResponse = serde_json::from_str(json).unwrap();
        assert!(!data.is_available);
        assert!(data.balance_infos.is_empty());
    }

    #[test]
    fn parse_longcat_models_list_response() {
        // LongCat 返回 OpenAI 风格，与 DeepSeek 结构一致
        let json = r#"{
            "object": "list",
            "data": [
                {"id": "LongCat-2.0", "object": "model", "owned_by": "LongCat"}
            ]
        }"#;
        let data: DeepSeekModelsResponse = serde_json::from_str(json).unwrap();
        assert_eq!(data.data.len(), 1);
        assert_eq!(data.data[0].id, "LongCat-2.0");
    }

    #[test]
    fn parse_qwen_models_response_and_map_channel_model() {
        // 千问 DashScope 兼容模式返回标准 OpenAI /models 列表
        let json = r#"{
            "object": "list",
            "data": [
                {"id": "qwen3.7-max", "object": "model", "created": 1748736000, "owned_by": "qwen"},
                {"id": "qwen3.6-flash", "object": "model", "created": 1744848000, "owned_by": "qwen"},
                {"id": " ", "object": "model", "owned_by": "qwen"}
            ]
        }"#;
        let data: DeepSeekModelsResponse = serde_json::from_str(json).unwrap();
        let models: Vec<_> = data
            .data
            .into_iter()
            .filter(|m| !m.id.trim().is_empty())
            .map(|m| qwen_channel_model(m.id, "now"))
            .collect();
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "qwen-qwen3.7-max");
        assert_eq!(models[0].channel_id, "qwen");
        assert_eq!(models[0].model, "qwen3.7-max");
        // 官方列表不返回上下文与输出上限，保持 None 不硬编码
        assert_eq!(models[0].context_window, None);
        assert_eq!(models[0].max_output_tokens, None);
        assert_eq!(
            models[0].supported_protocols,
            vec![ProtocolType::OpenAi, ProtocolType::Anthropic]
        );
    }

    #[test]
    fn parse_longcat_model_detail_response() {
        let json = r#"{
            "id": "LongCat-2.0",
            "name": "LongCat-2.0",
            "created": 1773331200,
            "context_length": 1048576,
            "architecture": {
                "input_modalities": ["text"],
                "output_modalities": ["text"],
                "modality": "text->text",
                "tokenizer": "Other",
                "instruct_type": null
            },
            "supported_parameters": [
                "max_tokens", "temperature", "top_p", "stream", "tools", "tool_choice", "thinking"
            ],
            "pricing": {"prompt": "2", "completion": "8", "cached_tokens": "0.04"}
        }"#;
        let data: LongCatModelDetail = serde_json::from_str(json).unwrap();
        assert_eq!(data.id, "LongCat-2.0");
        assert_eq!(data.context_length, Some(1_048_576));
        assert_eq!(data.name, Some("LongCat-2.0".to_string()));
        let params = data.supported_parameters.unwrap();
        assert!(params.contains(&"stream".to_string()));
        assert!(params.contains(&"tools".to_string()));
    }

    #[test]
    fn account_models_url_uses_override_and_normalizes_v1() {
        let json = serde_json::json!({
            "channels_config": {
                "channels": [{
                    "id": "qwen",
                    "name": "Qwen",
                    "vendor": "qwen",
                    "supported_protocols": ["openai", "anthropic"],
                    "openai_base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
                    "anthropic_base_url": "https://dashscope.aliyuncs.com/apps/anthropic"
                }]
            }
        });
        let config = crate::core::channels_config::ChannelsConfig::from_config_json(&json).unwrap();

        // 无覆盖时使用渠道配置端点。
        let default_account = ChannelAccount {
            id: "a".to_string(),
            channel_id: "qwen".to_string(),
            api_key: "sk".to_string(),
            ..Default::default()
        };
        assert_eq!(
            account_models_url(&default_account, &config).as_deref(),
            Some("https://dashscope.aliyuncs.com/compatible-mode/v1/models")
        );

        // 千问 Token Plan 等账号级 Base URL 覆盖优先，且 /v1 结尾不重复拼接。
        let override_account = ChannelAccount {
            id: "a-plan".to_string(),
            channel_id: "qwen".to_string(),
            api_key: "sk-sp".to_string(),
            base_url_override: Some(
                "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1".to_string(),
            ),
            ..Default::default()
        };
        assert_eq!(
            account_models_url(&override_account, &config).as_deref(),
            Some("https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/models")
        );

        // 覆盖端点不以 /v1 结尾时自动补 /v1/models。
        let override_no_v1 = ChannelAccount {
            id: "a-custom".to_string(),
            channel_id: "qwen".to_string(),
            api_key: "sk".to_string(),
            base_url_override: Some("https://example.com/custom".to_string()),
            ..Default::default()
        };
        assert_eq!(
            account_models_url(&override_no_v1, &config).as_deref(),
            Some("https://example.com/custom/v1/models")
        );
    }
}
