use super::channels_config::ChannelsConfig;
use super::config::{AuthStrategy, ChannelAccount, ChannelModel, ChannelPreset, ProtocolType};
use super::presets::ModelSyncResult;
use reqwest::Client;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub(crate) struct OpenAiModelsResponse {
    #[serde(default)]
    pub(crate) data: Vec<OpenAiModelEntry>,
}

#[derive(Debug, Deserialize, serde::Serialize, Clone)]
pub(crate) struct OpenAiModelEntry {
    pub id: String,
    #[serde(default)]
    pub(crate) object: String,
    #[serde(default)]
    pub(crate) owned_by: Option<String>,
    /// 上游模型创建时间（Unix 秒）。OpenAI 兼容 /models 的标准字段；
    /// 部分渠道列表不返回时为 None。
    #[serde(default)]
    pub(crate) created: Option<u64>,
}

#[derive(Debug, Deserialize, Default)]
struct OpenAiModelMetadataResponse {
    #[serde(default)]
    data: Vec<OpenAiModelMetadata>,
}

#[derive(Debug, Deserialize)]
struct OpenAiModelMetadata {
    id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    context_length: Option<i64>,
    #[serde(default)]
    pricing: Option<serde_json::Value>,
    #[serde(default)]
    top_provider: Option<OpenAiTopProviderMetadata>,
}

#[derive(Debug, Deserialize)]
struct OpenAiTopProviderMetadata {
    #[serde(default)]
    max_completion_tokens: Option<i64>,
}

fn model_metadata_by_id(body: &str) -> std::collections::HashMap<String, OpenAiModelMetadata> {
    serde_json::from_str::<OpenAiModelMetadataResponse>(body)
        .unwrap_or_default()
        .data
        .into_iter()
        .filter(|entry| !entry.id.trim().is_empty())
        .map(|entry| (entry.id.to_lowercase(), entry))
        .collect()
}

/// 按上游模型创建时间倒序排列（新模型在前）；缺失 created 的排在最后，
/// 稳定排序保证无时间戳的模型之间保持接口返回的原始顺序。
pub(crate) fn sort_by_created_desc<T>(entries: &mut [T], created: impl Fn(&T) -> Option<u64>) {
    entries.sort_by(|a, b| created(b).cmp(&created(a)));
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
pub(crate) fn account_models_url(
    account: &ChannelAccount,
    config: &ChannelsConfig,
) -> Option<String> {
    account
        .effective_openai_base_url()
        .map(openai_models_url)
        .or_else(|| config.models_endpoint_url(&account.channel_id))
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

    match serde_json::from_str::<OpenAiModelsResponse>(&body) {
        Ok(data) => {
            let mut models: Vec<OpenAiModelEntry> = data
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

    match serde_json::from_str::<OpenAiModelsResponse>(&body) {
        Ok(data) => {
            // OpenRouter 等兼容端点会在 /models 同时返回名称、规格和原始 pricing。
            // ChannelModel 已有对应持久化字段；缺失元数据的普通 OpenAI-compatible
            // 端点继续保持原有的空值降级语义。
            let metadata_by_id = model_metadata_by_id(&body);
            let mut entries: Vec<OpenAiModelEntry> = data
                .data
                .into_iter()
                .filter(|entry| !entry.id.trim().is_empty())
                .collect();
            sort_by_created_desc(&mut entries, |entry| entry.created);
            let synced_at = chrono::Utc::now().to_rfc3339();
            let protocols = preset.supported_protocols.clone();
            let models = entries
                .into_iter()
                .map(|entry| {
                    let metadata = metadata_by_id.get(&entry.id.to_lowercase());
                    ChannelModel {
                        id: format!("{}-{}", account.channel_id, entry.id),
                        channel_id: account.channel_id.clone(),
                        model: entry.id.clone(),
                        display_name: metadata
                            .and_then(|value| value.name.clone())
                            .or_else(|| Some(entry.id)),
                        supported_protocols: protocols.clone(),
                        context_window: metadata.and_then(|value| value.context_length),
                        max_output_tokens: metadata
                            .and_then(|value| value.top_provider.as_ref())
                            .and_then(|value| value.max_completion_tokens),
                        pricing: metadata.and_then(|value| value.pricing.clone()),
                        supports_stream: true,
                        enabled: true,
                        source: "synced".to_string(),
                        synced_at: Some(synced_at.clone()),
                        created_at: synced_at.clone(),
                        updated_at: synced_at.clone(),
                    }
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

    match serde_json::from_str::<OpenAiModelsResponse>(&body) {
        Ok(data) => {
            let synced_at = chrono::Utc::now().to_rfc3339();
            let mut entries: Vec<OpenAiModelEntry> = data
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

fn deepseek_channel_model(model: String, synced_at: &str) -> ChannelModel {
    ChannelModel {
        id: format!("deepseek-{model}"),
        channel_id: "deepseek".to_string(),
        display_name: Some(model.clone()),
        model,
        supported_protocols: vec![ProtocolType::OpenAi, ProtocolType::Anthropic],
        context_window: Some(1_000_000),
        max_output_tokens: Some(384_000),
        pricing: None,
        supports_stream: true,
        enabled: true,
        source: "synced".to_string(),
        synced_at: Some(synced_at.to_string()),
        created_at: synced_at.to_string(),
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
        pricing: None,
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
    fn parse_deepseek_models_response() {
        let json = r#"{
            "data": [
                {"id": "deepseek-v4-flash", "object": "model", "owned_by": "deepseek", "created": 1700000000},
                {"id": "deepseek-v4-pro", "object": "model", "owned_by": "deepseek"}
            ]
        }"#;
        let data: OpenAiModelsResponse = serde_json::from_str(json).unwrap();
        assert_eq!(data.data.len(), 2);
        assert_eq!(data.data[0].id, "deepseek-v4-flash");
        assert_eq!(data.data[0].created, Some(1700000000));
        // 上游不返回 created 时为 None，不报错。
        assert_eq!(data.data[1].created, None);
    }

    #[test]
    fn parses_openrouter_model_pricing_and_limits_metadata() {
        let json = r#"{
            "data": [{
                "id": "stealth/ox-alpha",
                "name": "Ox Alpha",
                "context_length": 1048576,
                "pricing": {
                    "prompt": "0",
                    "completion": "0",
                    "request": "0",
                    "image": "0"
                },
                "top_provider": { "max_completion_tokens": 131072 }
            }]
        }"#;

        let metadata = model_metadata_by_id(json);
        let ox = metadata.get("stealth/ox-alpha").unwrap();
        assert_eq!(ox.name.as_deref(), Some("Ox Alpha"));
        assert_eq!(ox.context_length, Some(1_048_576));
        assert_eq!(
            ox.top_provider
                .as_ref()
                .and_then(|provider| provider.max_completion_tokens),
            Some(131_072)
        );
        assert_eq!(ox.pricing.as_ref().unwrap()["prompt"], "0");
        assert_eq!(ox.pricing.as_ref().unwrap()["completion"], "0");
    }

    #[test]
    fn sort_models_by_created_desc_with_missing_last_and_stable() {
        let mut entries = vec![
            OpenAiModelEntry {
                id: "old".to_string(),
                object: String::new(),
                owned_by: None,
                created: Some(100),
            },
            OpenAiModelEntry {
                id: "no-time-1".to_string(),
                object: String::new(),
                owned_by: None,
                created: None,
            },
            OpenAiModelEntry {
                id: "newest".to_string(),
                object: String::new(),
                owned_by: None,
                created: Some(300),
            },
            OpenAiModelEntry {
                id: "no-time-2".to_string(),
                object: String::new(),
                owned_by: None,
                created: None,
            },
            OpenAiModelEntry {
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
        let data: OpenAiModelsResponse = serde_json::from_str(json).unwrap();
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
